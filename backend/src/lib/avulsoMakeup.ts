// ─── Remarcação do avulso: FALTA justificada (D4) e NÃO REALIZADO (D5) ──────
// Janela ÚNICA de remarcação sem novo pagamento: vai até o fim do dia D+N no fuso de São Paulo,
// D = data da gravação perdida, N = config `avulso_makeup_days` (7). A nova gravação precisa ser
// em data ≤ D+N. A remarcação REABRE A MESMA reserva (mesmo Payment, que fica ligado ao booking).
//  • FALTA justificada: só o admin concede (PATCH /bookings/:id com noShowJustified=true). Expirou
//    sem remarcar → perde o valor e o contrato avulso vira COMPLETED (job avulsoMakeupExpiryJob).
//  • NAO_REALIZADO (culpa do estúdio): a janela abre sozinha. Expirou sem remarcar → NÃO perde o
//    valor: makeup EXPIRED, contrato continua ACTIVE e os admins são avisados; o admin pode remarcar
//    mesmo depois do prazo.
// Booking.makeupStatus != null ⇔ janela concedida (OPEN → USED | EXPIRED). null = sem janela.

import { prisma } from './prisma.js';
import { getConfig } from './businessConfig.js';
import { saoPauloParts } from './spTime.js';
import { logAudit } from './audit.js';
import { syncContractCompletion } from './contractCompletion.js';
import { studioDateTime } from '../utils/pricing.js';
import { notifyEvent } from '../modules/notifications/notificationService.js';
import { getStaffRecipientIds } from './staffRecipients.js';
import {
    checkMoveSlotTier,
    withMovableSlot,
    SlotUnavailableError,
    deductCredit,
    syncAvulsoContractSchedule,
} from '../modules/bookings/booking.service.js';
import { sessionPaymentState, SESSION_PAYMENT_SELECT, type SessionPaymentLike } from '../modules/bookings/sessionPayment.js';
import type { BookingStatus, MakeupStatus } from '../generated/prisma/client.js';

export const AVULSO_MAKEUP_DAYS_KEY = 'avulso_makeup_days';
const DEFAULT_MAKEUP_DAYS = 7;

/**
 * Status do contrato em que a remarcação sem novo pagamento (e os avisos da janela) valem. Contrato
 * cancelado/encerrado (CANCELLED, EXPIRED, PENDING_CANCELLATION…) não dá gravação grátis nem recebe
 * lembrete de "remarque" / "valor não reembolsável".
 */
export const MAKEUP_CONTRACT_STATUSES = ['ACTIVE', 'COMPLETED'] as const;

export function isMakeupContractStatus(status: string | null | undefined): boolean {
    return (MAKEUP_CONTRACT_STATUSES as readonly string[]).includes(status ?? '');
}

/**
 * "Sem novo pagamento" pressupõe o pagamento original de pé. Motivo pelo qual a reserva NÃO pode usar a
 * remarcação (contrato cancelado/encerrado, valor estornado, gravação não paga) — ou null se pode.
 * `payments` = os Payments da reserva e do contrato avulso (status, metadata e paymentUrl).
 * R5 (ATU4-04/UXT-07): "paga" é a cobrança da GRAVAÇÃO (modules/bookings/sessionPayment.sessionPaymentState) —
 * com a marca sessionCharge, nenhuma marcada em aberto e uma marcada PAID; sem a marca, um PAID que não seja a
 * compra de um extra. Um serviço extra pago nunca libera a remarcação de uma sessão cuja cobrança está em aberto.
 */
export function makeupBlockReason(p: { contractStatus: string | null | undefined; payments: readonly SessionPaymentLike[] }): string | null {
    if (!isMakeupContractStatus(p.contractStatus)) {
        return 'O contrato desta gravação foi cancelado ou encerrado; a remarcação sem novo pagamento não está disponível.';
    }
    if (p.payments.some(x => x.status === 'REFUNDED')) {
        return 'O pagamento desta gravação foi estornado; a remarcação sem novo pagamento não está disponível.';
    }
    if (!sessionPaymentState(p.payments).paid) {
        return 'O pagamento desta gravação não está confirmado; a remarcação sem novo pagamento só vale para gravação paga.';
    }
    return null;
}

/** Select Prisma com o que makeupBlockReason precisa (status do contrato + Payments da reserva e do contrato). */
export const MAKEUP_ELIGIBILITY_SELECT = {
    contract: { select: { status: true, payments: { select: SESSION_PAYMENT_SELECT } } },
    payments: { select: SESSION_PAYMENT_SELECT },
} as const;

/** makeupBlockReason a partir de uma reserva carregada com MAKEUP_ELIGIBILITY_SELECT. */
export function makeupBlockReasonOf(b: {
    contract: { status: string; payments: SessionPaymentLike[] } | null;
    payments: SessionPaymentLike[];
}): string | null {
    return makeupBlockReason({
        contractStatus: b.contract?.status,
        payments: [...b.payments, ...(b.contract?.payments ?? [])],
    });
}

/** D3: remarcação sem novo pagamento nunca vale para cliente excluído (soft delete/anonimizado). */
export const MAKEUP_DELETED_CLIENT_ERROR = 'Este cliente foi excluído. A remarcação sem novo pagamento não está disponível.';

/** Sem janela de remarcação (e sem outro motivo conhecido) — também o 400 do Remarcar nesse caso. */
export const NO_MAKEUP_WINDOW_ERROR = 'Não há janela de remarcação aberta para esta gravação.';

async function loadMakeupBlockReason(bookingId: string): Promise<string | null> {
    const b = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: { ...MAKEUP_ELIGIBILITY_SELECT, user: { select: { deletedAt: true } } },
    });
    if (!b) return 'Agendamento não encontrado.';
    if (b.user?.deletedAt) return MAKEUP_DELETED_CLIENT_ERROR;
    return makeupBlockReasonOf(b);
}

/** Auditorias que indicam que a remarcação única desta reserva JÁ foi consumida. */
const MAKEUP_USED_AUDIT_ACTIONS = ['MAKEUP_RESCHEDULED', 'MAKEUP_USED_BY_ADMIN_EDIT'];

/** Erro de regra da remarcação, com o status HTTP que a rota deve devolver. */
export class MakeupError extends Error {
    constructor(readonly httpStatus: number, message: string) {
        super(message);
        this.name = 'MakeupError';
    }
}

// ─── Datas (puras) ──────────────────────────────────────

/** "YYYY-MM-DD" de uma data-calendário armazenada (@db.Date à 00:00Z). */
export function ymdOfDbDate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

/** Soma dias a um "YYYY-MM-DD" (aritmética de calendário, sem fuso). */
export function addDaysYmd(ymd: string, days: number): string {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** "DD/MM" de um "YYYY-MM-DD". */
export function ddmmOfYmd(ymd: string): string {
    return `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
}

/** Último dia (calendário SP) em que a nova gravação pode acontecer: D + days. */
export function lastMakeupYmd(bookingDate: Date, days: number): string {
    return addDaysYmd(ymdOfDbDate(bookingDate), days);
}

/**
 * Prazo da janela: fim do dia D+days em São Paulo (23:59:59.999 -03:00), como instante UTC.
 * `bookingDate` é a data-calendário do booking (@db.Date, 00:00Z) — NÃO o instante da gravação
 * (uma gravação às 22:00 SP já é o dia seguinte em UTC, mas D continua sendo a data SP).
 */
export function computeMakeupDeadline(bookingDate: Date, days: number): Date {
    return new Date(studioDateTime(lastMakeupYmd(bookingDate, days), '23:59').getTime() + 59_999);
}

/** "YYYY-MM-DD" (calendário SP) do prazo gravado — o último dia permitido para a nova gravação. */
export function deadlineYmd(deadline: Date): string {
    return saoPauloParts(deadline).dateStr;
}

/** Dias de calendário SP que restam na janela, CONTANDO hoje (último dia = 1). ≤ 0 = já passou. */
export function makeupDaysLeft(deadline: Date, now: Date = new Date()): number {
    const today = saoPauloParts(now).dateStr;
    const last = deadlineYmd(deadline);
    return Math.round((Date.parse(last + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000) + 1;
}

/** Janela aberta e dentro do prazo (FALTA justificada ou NÃO REALIZADO). */
export function isMakeupOpen(
    b: { status?: string | null; makeupStatus?: string | null; makeupDeadline?: Date | string | null },
    now: Date = new Date(),
): boolean {
    if (b.makeupStatus !== 'OPEN' || !b.makeupDeadline) return false;
    if (b.status && b.status !== 'FALTA' && b.status !== 'NAO_REALIZADO') return false;
    return new Date(b.makeupDeadline).getTime() > now.getTime();
}

export async function getMakeupDays(): Promise<number> {
    const n = await getConfig(AVULSO_MAKEUP_DAYS_KEY);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAKEUP_DAYS;
}

// ─── Janela (abrir / limpar / consumir) ─────────────────

/**
 * Pré-validação (ANTES de qualquer escrita) do `noShowJustified: true` do PATCH admin.
 * Retorna a mensagem do 400 ou null.
 */
export async function validateNoShowJustification(p: {
    finalStatus: string;
    contractType: string | null | undefined;
    makeupStatus: MakeupStatus | null;
    bookingDate: Date;
    /** Quando informado, confere também contrato e pagamento (makeupBlockReason). */
    bookingId?: string;
    now?: Date;
}): Promise<string | null> {
    if (p.finalStatus !== 'FALTA') return 'A falta justificada só pode ser marcada junto com o status Falta.';
    if (p.contractType !== 'AVULSO') return 'Falta justificada (remarcação sem novo pagamento) só vale para gravação avulsa.';
    if (p.makeupStatus === 'OPEN') return null; // já justificada — idempotente
    if (p.makeupStatus === 'USED') return 'Esta gravação já usou a remarcação (ela é única); a nova falta não pode ser justificada.';
    if (p.makeupStatus === 'EXPIRED') return 'O prazo de remarcação desta gravação já terminou.';
    if (p.bookingId) {
        const block = await loadMakeupBlockReason(p.bookingId);
        if (block) return block;
    }
    const days = await getMakeupDays();
    const deadline = computeMakeupDeadline(p.bookingDate, days);
    if (deadline.getTime() <= (p.now ?? new Date()).getTime()) {
        return `O prazo para justificar esta falta terminou em ${ddmmOfYmd(lastMakeupYmd(p.bookingDate, days))} (${days} dias após a gravação).`;
    }
    return null;
}

/**
 * Concede a janela a uma reserva AVULSA já em FALTA/NAO_REALIZADO (chamado DEPOIS da transição de
 * status). Atômico: updateMany guardado pelo status e pelo makeupStatus lidos.
 *  - FALTA: só a partir de "sem janela" (remarcação única) e com prazo no futuro.
 *  - NAO_REALIZADO: sempre concede (inclusive sobre USED — nova falha do estúdio); se o prazo já
 *    passou grava EXPIRED direto, sem avisar (o admin ainda pode remarcar — D5).
 *  - Nunca concede quando a remarcação não poderia ser usada (makeupBlockReason: contrato
 *    cancelado/encerrado, pagamento estornado ou não pago) — não promete ao cliente o que a API recusa.
 * Retorna o makeupStatus gravado, ou null se nada mudou (janela já aberta, regra não permite…).
 */
export async function openMakeupWindow(
    bookingId: string,
    kind: 'FALTA' | 'NAO_REALIZADO',
    opts: { actorId: string; now?: Date },
): Promise<'OPEN' | 'EXPIRED' | null> {
    const now = opts.now ?? new Date();
    const b = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: {
            id: true, userId: true, date: true, status: true, makeupStatus: true,
            contract: { select: { type: true, status: true, payments: { select: SESSION_PAYMENT_SELECT } } },
            payments: { select: SESSION_PAYMENT_SELECT },
            user: { select: { deletedAt: true } },
        },
    });
    if (!b || b.contract?.type !== 'AVULSO' || b.status !== kind) return null;
    // D3: cliente excluído — não há quem remarque (nem a quem avisar).
    if (b.user?.deletedAt) return null;
    if (b.makeupStatus === 'OPEN') return null;
    if (kind === 'FALTA' && b.makeupStatus !== null) return null;
    if (makeupBlockReasonOf(b)) return null;

    const days = await getMakeupDays();
    const deadline = computeMakeupDeadline(b.date, days);
    const next: 'OPEN' | 'EXPIRED' | null = deadline.getTime() > now.getTime()
        ? 'OPEN'
        : (kind === 'NAO_REALIZADO' ? 'EXPIRED' : null);
    if (!next) return null;

    const r = await prisma.booking.updateMany({
        where: { id: bookingId, status: kind, makeupStatus: b.makeupStatus },
        data: { makeupStatus: next, makeupDeadline: deadline, missedDate: b.date },
    });
    if (r.count === 0) return null;

    if (next === 'OPEN') {
        const lastYmd = lastMakeupYmd(b.date, days);
        await notifyEvent('avulso_makeup_opened', {
            userId: b.userId,
            vars: { data: ddmmOfYmd(ymdOfDbDate(b.date)), prazo: ddmmOfYmd(lastYmd) },
            entityType: 'BOOKING',
            entityId: b.id,
            dedupKey: `makeup:opened:${b.id}:${deadline.getTime()}`,
        }).catch(err => console.error('[MAKEUP] notify opened:', err));
    }
    await logAudit('BOOKING', b.id, kind === 'FALTA' ? 'NO_SHOW_JUSTIFIED' : 'MAKEUP_WINDOW_OPENED', opts.actorId, {
        makeupStatus: next,
        makeupDeadline: deadline.toISOString(),
        missedDate: ymdOfDbDate(b.date),
    });
    return next;
}

/** Retira a janela (volta a "sem janela"). Guardado pelo makeupStatus esperado. */
async function clearMakeupWindow(bookingId: string, from: MakeupStatus, actorId: string, reason: string): Promise<boolean> {
    const r = await prisma.booking.updateMany({
        where: { id: bookingId, makeupStatus: from },
        data: { makeupStatus: null, makeupDeadline: null, missedDate: null },
    });
    if (r.count > 0) await logAudit('BOOKING', bookingId, 'MAKEUP_WINDOW_CLEARED', actorId, { from, reason });
    return r.count > 0;
}

/**
 * Regras da janela quando o ADMIN muda o status pelo PATCH /bookings/:id (inclui o EditBookingModal
 * e o select inline). Chamado DEPOIS da transição atômica de status. Retorna true se mexeu na janela.
 *  - → NAO_REALIZADO (avulso): abre a janela automaticamente.
 *  - → FALTA + noShowJustified=true: abre; noShowJustified=false: retira a janela aberta;
 *    NAO_REALIZADO → FALTA sem justificar: retira (virou falta do cliente, sem direito).
 *  - FALTA/NAO_REALIZADO → CONFIRMED/RESERVED/COMPLETED com janela OPEN/EXPIRED:
 *      · data/horário MUDOU (nesta edição, ou a reserva já está noutra data que a perdida): USED — o
 *        admin remarcou "à mão";
 *      · MESMA data/horário: é correção do operador (o cliente chegou atrasado, marcou errado…), não
 *        remarcação → desfaz a janela (volta a "sem janela", originalDate intocado) e NÃO gasta a
 *        remarcação única. Exceção: NAO_REALIZADO reaberto por cima de uma remarcação já feita volta
 *        a USED (a remarcação única já tinha sido usada).
 *  - → CANCELLED com janela OPEN: retira.
 * `slotChanged` = esta edição mudou a data ou o horário (comparar VALORES — o modal sempre manda os dois).
 */
export async function applyMakeupOnStatusChange(p: {
    booking: {
        id: string;
        date: Date;
        originalDate: Date | null;
        missedDate: Date | null;
        makeupStatus: MakeupStatus | null;
        contractType: string | null | undefined;
    };
    from: BookingStatus | string;
    to: BookingStatus | string;
    statusChanged: boolean;
    noShowJustified?: boolean;
    slotChanged?: boolean;
    actorId: string;
    now?: Date;
}): Promise<boolean> {
    const { booking: b, from, to, statusChanged } = p;
    if (b.contractType !== 'AVULSO') return false;
    const missed = from === 'FALTA' || from === 'NAO_REALIZADO';

    if (to === 'NAO_REALIZADO') {
        if (!statusChanged) return false;
        return (await openMakeupWindow(b.id, 'NAO_REALIZADO', { actorId: p.actorId, now: p.now })) !== null;
    }

    if (to === 'FALTA') {
        if (p.noShowJustified === true) {
            return (await openMakeupWindow(b.id, 'FALTA', { actorId: p.actorId, now: p.now })) !== null;
        }
        if (p.noShowJustified === false && b.makeupStatus === 'OPEN') {
            return clearMakeupWindow(b.id, 'OPEN', p.actorId, 'noShowJustified=false');
        }
        if (statusChanged && from === 'NAO_REALIZADO' && (b.makeupStatus === 'OPEN' || b.makeupStatus === 'EXPIRED')) {
            return clearMakeupWindow(b.id, b.makeupStatus, p.actorId, 'NAO_REALIZADO→FALTA sem justificativa');
        }
        return false;
    }

    if (!statusChanged || !missed) return false;

    if ((to === 'CONFIRMED' || to === 'RESERVED' || to === 'COMPLETED')
        && (b.makeupStatus === 'OPEN' || b.makeupStatus === 'EXPIRED')) {
        // Mesmo slot = a reserva continua no dia perdido e esta edição não mudou data/horário.
        const sameSlot = !p.slotChanged && ymdOfDbDate(b.date) === ymdOfDbDate(b.missedDate ?? b.date);
        if (sameSlot) {
            const usedBefore = from === 'NAO_REALIZADO' && (await prisma.auditLog.count({
                where: { entityType: 'BOOKING', entityId: b.id, action: { in: MAKEUP_USED_AUDIT_ACTIONS } },
            })) > 0;
            if (!usedBefore) {
                return clearMakeupWindow(b.id, b.makeupStatus, p.actorId, `${from}→${to} no mesmo dia/horário (correção, não remarcação)`);
            }
        }
        const r = await prisma.booking.updateMany({
            where: { id: b.id, makeupStatus: b.makeupStatus },
            data: { makeupStatus: 'USED', originalDate: b.originalDate ?? b.missedDate ?? b.date },
        });
        if (r.count > 0) await logAudit('BOOKING', b.id, 'MAKEUP_USED_BY_ADMIN_EDIT', p.actorId, { from, to });
        return r.count > 0;
    }
    if (to === 'CANCELLED' && b.makeupStatus === 'OPEN') {
        return clearMakeupWindow(b.id, 'OPEN', p.actorId, 'reserva cancelada');
    }
    return false;
}

// ─── O que a marcação de Não realizado fez com a janela (resposta do PATCH) ─────

/**
 * AUDFIN6-03/TELA6-01: resultado da janela depois do PATCH → NAO_REALIZADO de um AVULSO, para a tela dizer o que o
 * servidor fez em vez de prever pela data:
 *  • makeupOpened — a janela está ABERTA e no prazo (o cliente remarca sem novo pagamento até makeupDeadline);
 *  • makeupDeadline — o prazo gravado (janela aberta ou já vencida), ISO; null sem janela;
 *  • makeupBlockReason — por que não está aberta (null quando está): prazo vencido (a equipe ainda remarca — D5) ou o
 *    motivo de makeupBlockReason (contrato cancelado/encerrado, estornada, não paga — inclusive a cobrança anulada) /
 *    cliente excluído.
 */
export interface MakeupOutcome {
    makeupOpened: boolean;
    makeupDeadline: string | null;
    makeupBlockReason: string | null;
}

/** Motivo quando a janela ficou VENCIDA (Não realizado com o prazo já passado — D5: a equipe ainda remarca). */
export function makeupExpiredReason(deadline: Date | null | undefined): string {
    const last = deadline ? ` em ${ddmmOfYmd(deadlineYmd(deadline))}` : '';
    return `O prazo da remarcação sem novo pagamento terminou${last}: o cliente não remarca pelo app, mas a equipe ainda pode remarcar (Remarcar).`;
}

/** Regra pura: o estado gravado da janela (+ o motivo de bloqueio já carregado) → MakeupOutcome. */
export function makeupOutcome(
    b: { status?: string | null; makeupStatus: string | null; makeupDeadline: Date | null },
    blockReason: string | null,
    now: Date = new Date(),
): MakeupOutcome {
    const deadline = b.makeupDeadline ? b.makeupDeadline.toISOString() : null;
    if (isMakeupOpen(b, now)) return { makeupOpened: true, makeupDeadline: deadline, makeupBlockReason: null };
    if (b.makeupStatus === 'OPEN' || b.makeupStatus === 'EXPIRED') {
        return { makeupOpened: false, makeupDeadline: deadline, makeupBlockReason: makeupExpiredReason(b.makeupDeadline) };
    }
    return { makeupOpened: false, makeupDeadline: null, makeupBlockReason: blockReason ?? NO_MAKEUP_WINDOW_ERROR };
}

/** makeupOutcome da reserva já atualizada (carrega o motivo do bloqueio só quando não há janela). */
export async function loadMakeupOutcome(
    b: { id: string; status: string; makeupStatus: string | null; makeupDeadline: Date | null },
    now: Date = new Date(),
): Promise<MakeupOutcome> {
    const hasWindow = b.makeupStatus === 'OPEN' || b.makeupStatus === 'EXPIRED';
    return makeupOutcome(b, hasWindow ? null : await loadMakeupBlockReason(b.id), now);
}

// ─── Remarcação (PATCH /bookings/:id/makeup) ────────────

const MAKEUP_BOOKING_SELECT = {
    id: true, date: true, startTime: true, endTime: true, status: true,
    tierApplied: true, price: true, contractId: true, originalDate: true,
    statusReason: true, makeupStatus: true, makeupDeadline: true, missedDate: true,
    holdExpiresAt: true,
    contract: { select: { id: true, name: true, type: true, tier: true } },
} as const;

/**
 * Quem remarca: o cliente dono, ou a EQUIPE autorizada (ADMIN ou COLABORADOR com `agendamentos.faltas`
 * — a rota confere a permissão ANTES de chamar). `isStaff` é o campo atual; `isAdmin` é o nome antigo
 * (mesmo significado: "equipe autorizada"), aceito para não quebrar quem já chama assim.
 */
export interface MakeupActor {
    userId: string;
    isStaff?: boolean;
    /** @deprecated use `isStaff` (mesmo significado: equipe autorizada). */
    isAdmin?: boolean;
}

/**
 * Remarca a gravação perdida para `date`/`startTime` reabrindo a MESMA reserva (mesmo Payment).
 * Cliente dono ou equipe autorizada. Regras:
 *  - contrato AVULSO, status FALTA/NAO_REALIZADO, janela OPEN e prazo não vencido. Exceção (D5): a
 *    equipe pode remarcar um NAO_REALIZADO mesmo sem janela aberta/depois do prazo (e sem o teto D+N);
 *  - nova data ≤ último dia da janela; antecedência mínima (booking_min_advance_hours) para o cliente,
 *    só "não no passado" para a equipe; dia de funcionamento, horário da grade e mesma faixa;
 *  - trava Redis + conflito + bloqueio (withMovableSlot, o mesmo do /reschedule);
 *  - updateMany atômico → CONFIRMED + USED (2 cliques/2 abas: só um vence, o outro recebe 409).
 * A partir de NAO_REALIZADO faz deductCredit (o NAO_REALIZADO devolveu 1 crédito ao ser marcado).
 */
export async function rescheduleAvulsoMakeup(p: {
    bookingId: string;
    actor: MakeupActor;
    date: string;
    startTime: string;
    now?: Date;
}) {
    const now = p.now ?? new Date();
    const isStaff = p.actor.isStaff ?? p.actor.isAdmin ?? false;
    const b = await prisma.booking.findUnique({
        where: { id: p.bookingId },
        select: {
            id: true, userId: true, contractId: true, date: true, startTime: true, status: true,
            tierApplied: true, originalDate: true, missedDate: true,
            makeupStatus: true, makeupDeadline: true,
            contract: { select: { type: true, status: true, payments: { select: SESSION_PAYMENT_SELECT } } },
            payments: { select: SESSION_PAYMENT_SELECT },
            user: { select: { name: true, deletedAt: true } },
        },
    });
    if (!b || (!isStaff && b.userId !== p.actor.userId)) {
        throw new MakeupError(404, 'Agendamento não encontrado.');
    }
    // D3: cliente excluído não ganha gravação nova — nem pelo override do admin (D5).
    if (b.user?.deletedAt) throw new MakeupError(409, MAKEUP_DELETED_CLIENT_ERROR);
    if (b.contract?.type !== 'AVULSO') {
        throw new MakeupError(400, 'A remarcação sem novo pagamento só vale para gravação avulsa.');
    }
    // "Sem novo pagamento" pressupõe o pagamento original de pé: contrato cancelado/encerrado, valor
    // estornado ou reserva nunca paga não dão gravação grátis — vale também para o admin (o override da
    // D5 não fura).
    const block = makeupBlockReasonOf(b);
    if (block) throw new MakeupError(400, block);
    if (b.status !== 'FALTA' && b.status !== 'NAO_REALIZADO') {
        throw new MakeupError(400, b.makeupStatus === 'USED'
            ? 'Esta gravação já foi remarcada (a remarcação é única).'
            : 'Esta gravação não está disponível para remarcação.');
    }

    const adminOverride = isStaff && b.status === 'NAO_REALIZADO';
    const windowOpen = isMakeupOpen(b, now);
    if (!windowOpen && !adminOverride) {
        if (b.makeupStatus === 'USED') throw new MakeupError(400, 'Esta gravação já foi remarcada (a remarcação é única).');
        if (b.makeupStatus === 'OPEN' || b.makeupStatus === 'EXPIRED') {
            const last = b.makeupDeadline ? ddmmOfYmd(deadlineYmd(b.makeupDeadline)) : '';
            throw new MakeupError(400, `O prazo para remarcar esta gravação terminou${last ? ` em ${last}` : ''}.`);
        }
        throw new MakeupError(400, b.status === 'FALTA'
            ? 'Esta falta não foi justificada pelo estúdio, então não há remarcação sem novo pagamento.'
            : NO_MAKEUP_WINDOW_ERROR);
    }

    // Data/horário de destino.
    if (!adminOverride && b.makeupDeadline) {
        const lastYmd = deadlineYmd(b.makeupDeadline);
        if (p.date > lastYmd) {
            throw new MakeupError(400, `A nova data deve ser até ${ddmmOfYmd(lastYmd)}/${lastYmd.slice(0, 4)} (prazo da remarcação).`);
        }
    }
    const slotStart = studioDateTime(p.date, p.startTime);
    if (Number.isNaN(slotStart.getTime())) throw new MakeupError(400, 'Data ou horário inválido.');
    if (isStaff) {
        if (slotStart.getTime() <= now.getTime()) {
            throw new MakeupError(400, 'Não é possível remarcar para uma data ou horário que já passou.');
        }
    } else {
        const minAdvanceHours = await getConfig('booking_min_advance_hours');
        if ((slotStart.getTime() - now.getTime()) / 3_600_000 < minAdvanceHours) {
            throw new MakeupError(400, `Escolha um horário com pelo menos ${minAdvanceHours} horas de antecedência.`);
        }
    }
    const tierError = await checkMoveSlotTier(p.date, p.startTime, b.tierApplied);
    if (tierError) throw new MakeupError(400, tierError);

    const fromStatus = b.status;
    let won = false;
    try {
        won = await withMovableSlot(
            { date: p.date, startTime: p.startTime, lockOwner: p.actor.userId, excludeBookingId: b.id },
            async ({ dateObj, endTime }) => {
                const r = await prisma.booking.updateMany({
                    // Guarda também o status do contrato: um cancelamento concorrente não deixa passar.
                    where: {
                        id: b.id, status: fromStatus, makeupStatus: b.makeupStatus,
                        contract: { status: { in: [...MAKEUP_CONTRACT_STATUSES] } },
                    },
                    data: {
                        status: 'CONFIRMED',
                        date: dateObj,
                        startTime: p.startTime,
                        endTime,
                        makeupStatus: 'USED',
                        missedDate: b.missedDate ?? b.date,
                        // Âncora da remarcação comum seguinte continua sendo a data original.
                        originalDate: b.originalDate ?? b.missedDate ?? b.date,
                        holdExpiresAt: null,
                        // Nova sessão: o operador precisa "Iniciar Gravação" de novo.
                        recordingStartedAt: null,
                        recordingStartedById: null,
                        recordingStartedByName: null,
                    },
                });
                return r.count > 0;
            },
        );
    } catch (err) {
        if (err instanceof SlotUnavailableError) throw new MakeupError(409, err.message);
        throw err;
    }
    if (!won) {
        throw new MakeupError(409, 'Esta gravação acabou de ser remarcada ou o prazo mudou. Atualize a tela.');
    }

    // D5: o NAO_REALIZADO devolveu 1 crédito ao contrato ao ser marcado; a sessão voltou → consome de volta.
    if (fromStatus === 'NAO_REALIZADO' && b.contractId) {
        await deductCredit(b.contractId);
    }
    // A vigência e o nome do contrato avulso passam a ser os da nova gravação.
    await syncAvulsoContractSchedule(b.contractId, { date: p.date, startTime: p.startTime });

    const oldYmd = ymdOfDbDate(b.date);
    const slotKey = `${p.date}:${p.startTime}`;
    // Remarcado pelo ESTÚDIO: o cliente precisa saber a nova data (quando ele mesmo remarca, já sabe).
    if (isStaff) {
        await notifyEvent('avulso_makeup_rescheduled', {
            userId: b.userId,
            vars: { data: ddmmOfYmd(oldYmd), novaData: ddmmOfYmd(p.date), hora: p.startTime },
            entityType: 'BOOKING',
            entityId: b.id,
            dedupKey: `makeup:rescheduled:client:${b.id}:${slotKey}`,
        }).catch(err => console.error('[MAKEUP] notify client rescheduled:', err));
    }
    // Equipe avisada (ADMIN ativo + COLABORADOR ativo com a permissão do evento — STAFF_EVENT_PERMISSIONS),
    // menos quem acabou de remarcar. Nunca BLOCKED nem excluído. A remarcação já foi gravada: falha aqui
    // só perde o aviso.
    let staffIds: string[] = [];
    try {
        staffIds = await getStaffRecipientIds('admin_makeup_rescheduled', { excludeUserId: p.actor.userId });
    } catch (err) {
        console.error('[MAKEUP] Falha ao buscar a equipe para o aviso de remarcação:', err);
    }
    for (const staffId of staffIds) {
        await notifyEvent('admin_makeup_rescheduled', {
            userId: staffId,
            vars: { cliente: b.user?.name || 'Cliente', data: ddmmOfYmd(oldYmd), novaData: ddmmOfYmd(p.date), hora: p.startTime },
            entityType: 'BOOKING',
            entityId: b.id,
            dedupKey: `makeup:rescheduled:${b.id}:${staffId}:${slotKey}`,
        }).catch(err => console.error('[MAKEUP] notify staff rescheduled:', err));
    }
    await logAudit('BOOKING', b.id, 'MAKEUP_RESCHEDULED', p.actor.userId, {
        from: { date: oldYmd, startTime: b.startTime, status: fromStatus, makeupStatus: b.makeupStatus },
        to: { date: p.date, startTime: p.startTime },
        byStaff: isStaff,
        afterDeadline: !windowOpen,
    });
    await syncContractCompletion(b.contractId, p.actor.userId);

    const booking = await prisma.booking.findUnique({ where: { id: b.id }, select: MAKEUP_BOOKING_SELECT });
    return {
        booking,
        message: `Gravação remarcada para ${ddmmOfYmd(p.date)} às ${p.startTime}, sem novo pagamento.`,
    };
}
