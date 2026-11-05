// ─── Booking Business Logic Service ─────────────────────
// Extracted from routes.ts — handles credit management,
// conflict detection, and booking lifecycle operations.

import { prisma } from '../../lib/prisma.js';
import { acquireMultiSlotLock, releaseMultiSlotLock } from '../../lib/redis.js';
import { BookingStatus, Tier } from '../../generated/prisma/client.js';
import { getPackageSlots, getSlotDuration, getSlotTier, isOperatingDay, calculateEndTime } from '../../utils/pricing.js';
import { getConfig } from '../../lib/businessConfig.js';
import {
    fixoCapUsageWhere, sessionPaymentState, awaitsOwnPayment, ownSessionChargeState, OPEN_CHARGE_STATUSES,
    SESSION_PAYMENT_SELECT,
    type SessionPaymentState, type OwnChargeState,
} from './sessionPayment.js';

// Planos que cobrem a sessão e a marca da cobrança da PRÓPRIA sessão (metadata.sessionCharge): módulo puro
// lib/sessionCharge (também usado por lib/paymentEffects, pela varredura dos holds e pelo teste de paridade
// com o front). Re-exportados aqui para as rotas de agendamento.
export {
    SESSION_PLAN_TYPES, SESSION_CHARGE_METADATA, FIXO_EXTRA_METADATA, sessionChargeWhere, openSessionChargeWhere,
} from '../../lib/sessionCharge.js';
// Regras PURAS do pagamento da sessão e do teto do FIXO (sessionPayment.ts) — re-exportadas para as rotas.
export {
    FIXO_CAP_STATUSES, OPEN_CHARGE_STATUSES, SESSION_PAYMENT_SELECT, SESSION_CHARGE_MARK_WHERE, FIXO_EXTRA_MARK_WHERE,
    occupiesFixoCap, fixoCapUsageWhere, hasSessionChargeMark, hasFixoExtraMark, isAddonPurchase, sessionPaymentState,
    awaitsOwnPayment, ownSessionChargeState,
    type SessionPaymentLike, type SessionPaymentState, type OwnChargeState,
} from './sessionPayment.js';

// ─── Teto do FIXO ──────────────────────────────────────

/**
 * O FIXO já usou todas as sessões do plano (meses × sessões/mês). Conta só as que OCUPAM o teto
 * (sessionPayment.fixoCapUsageWhere): CANCELLED, NAO_REALIZADO e a sessão EXTRA (marca fixoExtra — criada com o
 * teto já cheio) não ocupam; a sessão cobrada por quem tem a baixa DENTRO do teto ocupa (ATU5-02). A mesma regra do
 * POST / do cliente, do POST /admin, da reabertura do PATCH, do GET /contracts/my (planSessionsUsed) e de
 * lib/contractCompletion (occupiesFixoCap).
 */
export async function fixoCapReached(contract: { id: string; durationMonths: number }): Promise<boolean> {
    const used = await prisma.booking.count({ where: fixoCapUsageWhere(contract.id) });
    return used >= contract.durationMonths * (await getConfig('sessions_per_month'));
}

/** Trava (mutex Redis) por contrato FIXO: serializa quem ocupa uma vaga do teto (criação e reabertura). */
export const fixoCapLockKey = (contractId: string) => `booking:fixo-cap:${contractId}`;

// ─── Pagamento DA SESSÃO (R5: ATU4-02, ATU4-04, UXT-07) ─────

/**
 * Estado da cobrança da GRAVAÇÃO de uma reserva (regra pura: sessionPayment.sessionPaymentState).
 * `assumePaidId`: conta esse Payment como PAID — para quem decide ANTES de gravar o PAID (complete-payment).
 */
export async function sessionChargeState(bookingId: string, opts: { assumePaidId?: string } = {}): Promise<SessionPaymentState> {
    const rows = await prisma.payment.findMany({ where: { bookingId }, select: { id: true, ...SESSION_PAYMENT_SELECT } });
    return sessionPaymentState(rows.map(p => (p.id === opts.assumePaidId ? { ...p, status: 'PAID' } : p)));
}

/** A cobrança da GRAVAÇÃO desta reserva está paga? (um extra pago nunca conta — sessionPaymentState). */
export async function isSessionPaid(bookingId: string, opts: { assumePaidId?: string } = {}): Promise<boolean> {
    return (await sessionChargeState(bookingId, opts)).paid;
}

/**
 * A reserva PRECISA da cobrança própria paga para valer como Confirmada, e ela não está paga? Precisa quando tem
 * cobrança marcada (SERVIÇO, FIXO extra, avulso/sessão cobrada pela equipe), é avulso, ou ainda está no prazo de
 * pagamento (hold do avulso do cliente). A sessão de PLANO sem cobrança própria nunca espera (só extras em aberto
 * não a seguram). Usado pelo /confirm (402), pelo complete-payment e pela varredura dos holds.
 */
export async function sessionAwaitsOwnPayment(
    booking: { id: string; holdExpiresAt?: Date | null; contract?: { type: string } | null },
    opts: { assumePaidId?: string } = {},
): Promise<boolean> {
    const state = await sessionChargeState(booking.id, opts);
    return awaitsOwnPayment(state, { holdExpiresAt: booking.holdExpiresAt, contractType: booking.contract?.type });
}

// ─── Cobrança em aberto de uma reserva (R5: cancelar = anular) ─────

/** Filtro das cobranças EM ABERTO (PENDING/FAILED) ligadas à reserva — qualquer uma: da sessão, de extras… */
export function openChargeWhere(bookingId: string) {
    return { bookingId, status: { in: OPEN_CHARGE_STATUSES } };
}

/** A reserva tem cobrança em aberto (PENDING/FAILED)? */
export async function hasOpenCharge(bookingId: string): Promise<boolean> {
    return (await prisma.payment.count({ where: openChargeWhere(bookingId) })) > 0;
}

/** Filtro de reserva "sem cobrança em aberto" — para a transição atômica do cancelamento sem a baixa. */
export const NO_OPEN_CHARGE_BOOKING_WHERE = { payments: { none: { status: { in: OPEN_CHARGE_STATUSES } } } };

/**
 * R5 — PRINCÍPIO: anular cobrança em aberto é da baixa (cobrancas.baixa, "Marcar como pago, anular ou
 * estornar"). Cancelar (ou excluir) uma sessão anula as cobranças em aberto dela (voidExtrasOfCancelledBooking),
 * então a EQUIPE sem a baixa não cancela uma sessão com Payment PENDING/FAILED — seja qual for o status, a data ou a
 * gravação (substitui a heurística "a sessão já aconteceu" do conserto 3, que reabrir ou remarcar antes de cancelar
 * furava). Resposta 403 com este corpo, antes de qualquer escrita e depois da regra da tabela (quem não tem
 * agendamentos.cancelar recebe o 403 dele primeiro). ADMIN, quem tem a baixa, o cliente na própria reserva e os jobs
 * seguem como antes. Os outros caminhos que anulariam a cobrança de uma sessão pedem a baixa do mesmo jeito (conserto
 * 5): excluir a sessão (OPEN_CHARGE_DELETE_NEEDS_BAIXA), cancelar o contrato AVULSO (o contrato é a própria sessão —
 * contract.lifecycle, ATU5-03), pausar o FIXO (AUDFIN-03) e excluir o cliente (lib/userDeletion, AUDFIN-04). Rodada 7
 * (AUDFIN6-01/ATU6-02): cancelar QUALQUER contrato (DELETE, PATCH → CANCELLED) e decidir o pedido de cancelamento
 * com a cobrança PRÓPRIA de uma gravação em aberto (marca sessionCharge — SERVIÇO, FIXO extra, sessão cobrada à parte)
 * também pedem a baixa (contract.lifecycle.contractCancelBaixaChargeWhere). Exceção registrada para o dono: cancelar
 * um contrato de PLANO anula as PARCELAS dele (e os serviços extras das sessões de plano) só com contratos.cancelar /
 * contratos.multa (desenho D2).
 */
export const OPEN_CHARGE_CANCEL_NEEDS_BAIXA = {
    error: 'Esta sessão tem cobrança em aberto: cancelar anula a cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa ou, se o cliente faltou, use Falta (a cobrança continua devida).',
    code: 'PERMISSION_DENIED',
    permission: 'cobrancas.baixa',
} as const;

/**
 * TELA5-05: o mesmo princípio na EXCLUSÃO definitiva (DELETE /:id/hard-delete) — mesmo code/permission, texto da
 * exclusão (sem a sugestão de Falta, que é outra ação).
 */
export const OPEN_CHARGE_DELETE_NEEDS_BAIXA = {
    error: 'Esta sessão tem cobrança em aberto: excluir anula a cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa.',
    code: 'PERMISSION_DENIED',
    permission: 'cobrancas.baixa',
} as const;

/**
 * Quantas cobranças EM ABERTO (PENDING/FAILED) cada reserva tem — numa consulta só (groupBy), sem N+1. Para os
 * payloads da EQUIPE (lista/agenda, Hoje, PATCH): a tela sabe, sem outra chamada, que cancelar pede a baixa.
 */
export async function openChargeCounts(bookingIds: readonly string[]): Promise<Map<string, number>> {
    const ids = [...new Set(bookingIds)];
    const out = new Map<string, number>();
    if (ids.length === 0) return out;
    const rows = await prisma.payment.groupBy({
        by: ['bookingId'],
        where: { bookingId: { in: ids }, status: { in: OPEN_CHARGE_STATUSES } },
        _count: { _all: true },
    });
    for (const r of rows) if (r.bookingId) out.set(r.bookingId, r._count._all);
    return out;
}

/** Acrescenta `openChargeCount` (cobranças em aberto da reserva) a cada agendamento — payload da EQUIPE. */
export async function withOpenChargeCount<T extends { id: string }>(bookings: readonly T[]): Promise<(T & { openChargeCount: number })[]> {
    const counts = await openChargeCounts(bookings.map(b => b.id));
    return bookings.map(b => ({ ...b, openChargeCount: counts.get(b.id) ?? 0 }));
}

/** withOpenChargeCount para UM agendamento (respostas do PATCH e das rotas do Hoje). */
export async function withOpenChargeCountOne<T extends { id: string }>(booking: T): Promise<T & { openChargeCount: number }> {
    return (await withOpenChargeCount([booking]))[0]!;
}

// ─── Reabrir uma sessão cancelada sem a baixa (403) — textos VERDADEIROS por caso ─────

/**
 * FIN-07/R5: o 403 de quem não tem a baixa ao reabrir uma sessão CANCELADA, conforme o que a sessão tem:
 *  • cobrança PRÓPRIA viva (a cobrança da gravação PAGA ou ainda em aberto — marcada, ou a do avulso sem a marca):
 *    criar outro agendamento cobraria a mesma gravação de novo → peça a quem tem a baixa;
 *  • alguma cobrança dela ANULADA (CANCELLED — o cancelamento anula as em aberto): o texto diz isso;
 *  • nenhuma cobrança (sessão de plano sem extras): o texto não fala em cobrança.
 */
export const REOPEN_CANCELLED_OWN_CHARGE = 'Reabrir uma sessão cancelada exige a permissão “Marcar como pago, anular ou estornar”. Esta sessão já tem cobrança própria: peça a quem tem essa permissão para reabri-la. Não crie um novo agendamento — o cliente seria cobrado de novo.';
export const REOPEN_CANCELLED_CHARGE_VOIDED = 'Reabrir uma sessão cancelada exige a permissão “Marcar como pago, anular ou estornar”: a cobrança dela foi anulada no cancelamento. Para uma nova sessão, crie um novo agendamento.';
export const REOPEN_CANCELLED_NEEDS_BAIXA = 'Reabrir uma sessão cancelada exige a permissão “Marcar como pago, anular ou estornar”. Para uma nova sessão, crie um novo agendamento.';

export async function reopenCancelledNeedsBaixaText(booking: { id: string; contract?: { type: string } | null }): Promise<string> {
    const rows = await prisma.payment.findMany({ where: { bookingId: booking.id }, select: SESSION_PAYMENT_SELECT });
    // Cobrança da GRAVAÇÃO: a marcada; no avulso sem a marca (cliente/legado), a que não é compra de extra.
    if (ownSessionChargeState(rows, booking.contract?.type) === 'live') return REOPEN_CANCELLED_OWN_CHARGE;
    if (rows.some(p => p.status === 'CANCELLED')) return REOPEN_CANCELLED_CHARGE_VOIDED;
    return REOPEN_CANCELLED_NEEDS_BAIXA;
}

/** Estado da cobrança PRÓPRIA da reserva no banco (sessionPayment.ownSessionChargeState). */
export async function ownChargeState(booking: { id: string; contract?: { type: string } | null }): Promise<OwnChargeState> {
    const rows = await prisma.payment.findMany({ where: { bookingId: booking.id }, select: SESSION_PAYMENT_SELECT });
    return ownSessionChargeState(rows, booking.contract?.type);
}

// ─── Reabrir uma sessão cancelada cuja cobrança própria foi anulada (todos, inclusive o ADMIN) ─────

/**
 * AUDFIN-01/ATU5-01/TELA5-01 (conserto 5): desde a R5 o cancelamento anula a cobrança em aberto da sessão — também a
 * do avulso. CANCELLED é terminal (o create-payment recusa; nenhuma rota reemite a cobrança de uma sessão), então
 * reabrir não a traz de volta. Destinos que deixam a sessão EM ABERTO (Reservado, Em espera, Confirmado) ficariam
 * "aguardando" uma cobrança que não existe — 409 para todos (inclusive o ADMIN), antes de qualquer escrita: para
 * gravar, um novo agendamento gera a cobrança de novo. Concluído e Não realizado (registrar o que aconteceu) seguem
 * permitidos a quem tem a baixa, e a resposta avisa que a sessão fica sem cobrança (REOPENED_WITHOUT_CHARGE_NOTE).
 * AUDFIN6-02: o 409 vale para a volta a "em aberto" de QUALQUER status fechado (Cancelado, Concluído, Falta, Não
 * realizado) com a cobrança própria anulada — senão Cancelado → Concluído → Confirmado contornava a regra.
 */
export const REOPEN_OPEN_STATUSES: readonly string[] = ['RESERVED', 'HELD', 'CONFIRMED'];
export const SESSION_CHARGE_VOIDED_REOPEN = {
    error: 'A cobrança desta sessão foi anulada e não volta com a reabertura, então ela não pode voltar a ficar em aberto (Reservado, Em espera ou Confirmado) sem cobrança. Para gravar, crie um novo agendamento: ele gera a cobrança de novo.',
    code: 'SESSION_CHARGE_VOIDED',
} as const;
export const REOPENED_WITHOUT_CHARGE_NOTE = ' A cobrança desta sessão foi anulada e não volta com a reabertura: a sessão fica sem cobrança.';

// ─── Faixa nas mensagens da equipe ─────────────────────

/** Nome da faixa nas mensagens da equipe (R3b/R4 — TIER_NOT_ALLOWED). */
const TIER_LABEL_PT: Record<string, string> = { COMERCIAL: 'Comercial', AUDIENCIA: 'Audiência', SABADO: 'Sábado' };
export const tierLabel = (tier: string) => TIER_LABEL_PT[tier] ?? tier;

/** 403 TIER_NOT_ALLOWED: a sessão de plano (sem a baixa) só vale na faixa do plano ou abaixo dela. */
export function tierNotAllowedBody(planTier: string, slotTier: string) {
    return {
        error: `O plano ${tierLabel(planTier)} não permite agendar horários ${tierLabel(slotTier)}.`,
        code: 'TIER_NOT_ALLOWED',
    } as const;
}

// ─── Blocked Slots ─────────────────────────────────────

/**
 * Retorna true se algum dos `packageSlots` (["HH:mm", ...]) cai dentro de um intervalo
 * bloqueado (BlockedSlot) na data. Usado para revalidar bloqueios no MOMENTO da reserva —
 * a disponibilidade só os esconde na UI; sem esta checagem era possível reservar por cima
 * de um horário bloqueado (manutenção/double-booking).
 */
export async function hasBlockedConflict(dateObj: Date, packageSlots: string[]): Promise<boolean> {
    const blocked = await prisma.blockedSlot.findMany({
        where: { date: dateObj },
        select: { startTime: true, endTime: true },
    });
    if (blocked.length === 0) return false;
    const blockedSet = new Set<string>();
    for (const b of blocked) {
        const [sH, sM] = b.startTime.split(':').map(Number);
        const [eH, eM] = b.endTime.split(':').map(Number);
        let m = sH * 60 + sM;
        const end = eH * 60 + eM;
        while (m < end) {
            blockedSet.add(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
            m += 30;
        }
    }
    return packageSlots.some(s => blockedSet.has(s));
}

// ─── Credit Management ─────────────────────────────────

/** Restore a single credit to a Flex or Custom contract (atomic). */
export async function restoreCredit(contractId: string): Promise<boolean> {
    const contract = await prisma.contract.findUnique({
        where: { id: contractId },
        select: { type: true, customCreditsRemaining: true },
    });
    if (!contract) return false;

    if (contract.type === 'FLEX' || contract.type === 'AVULSO') {
        // Atomic increment avoids lost updates under concurrent cancellations.
        await prisma.contract.update({
            where: { id: contractId },
            data: { flexCreditsRemaining: { increment: 1 } },
        });
        return true;
    }

    if (contract.type === 'CUSTOM' && contract.customCreditsRemaining != null) {
        await prisma.contract.update({
            where: { id: contractId },
            data: { customCreditsRemaining: { increment: 1 } },
        });
        return true;
    }

    return false;
}

/** Deduct a single credit from a Flex or Custom contract (atomic, guarded > 0). */
export async function deductCredit(contractId: string): Promise<boolean> {
    const contract = await prisma.contract.findUnique({
        where: { id: contractId },
        select: { type: true },
    });
    if (!contract) return false;

    if (contract.type === 'FLEX' || contract.type === 'AVULSO') {
        const r = await prisma.contract.updateMany({
            where: { id: contractId, flexCreditsRemaining: { gt: 0 } },
            data: { flexCreditsRemaining: { decrement: 1 } },
        });
        return r.count > 0;
    }

    if (contract.type === 'CUSTOM') {
        const r = await prisma.contract.updateMany({
            where: { id: contractId, customCreditsRemaining: { gt: 0 } },
            data: { customCreditsRemaining: { decrement: 1 } },
        });
        return r.count > 0;
    }

    return false;
}

/**
 * FLEX: acerta NA HORA o saldo canônico do contrato — a mesma conta do flexCreditExpiryJob (total − sessões
 * que consomem − confiscados; CANCELLED e NAO_REALIZADO não consomem), sem decidir confisco novo (isso é só
 * do cron). Para a transição em que o ajuste incremental (+1/−1) não sabe o que o cancelamento já fez com o
 * crédito: sessão CANCELADA que volta a Concluída (DIN-01) — o DELETE da sessão aberta devolveu o crédito, o
 * PATCH → CANCELLED não mexeu, e o cron pode ou não ter rodado no meio. Só ACTIVE/COMPLETED, como o cron.
 * A escrita é guardada pelo saldo lido: se outra reserva mexeu nele no meio, fica como está (o cron acerta
 * na próxima rodada). Nunca devolve erro de negócio.
 */
export async function reconcileFlexCredits(contractId: string): Promise<void> {
    const c = await prisma.contract.findUnique({
        where: { id: contractId },
        select: { type: true, status: true, flexCreditsTotal: true, flexCreditsRemaining: true, flexCreditsForfeited: true },
    });
    if (!c || c.type !== 'FLEX' || !c.flexCreditsTotal || (c.status !== 'ACTIVE' && c.status !== 'COMPLETED')) return;
    const consumed = await prisma.booking.count({
        where: { contractId, status: { notIn: [BookingStatus.CANCELLED, BookingStatus.NAO_REALIZADO] } },
    });
    const canonical = Math.max(0, c.flexCreditsTotal - consumed - c.flexCreditsForfeited);
    if (canonical === c.flexCreditsRemaining) return;
    await prisma.contract.updateMany({
        where: { id: contractId, flexCreditsRemaining: c.flexCreditsRemaining },
        data: { flexCreditsRemaining: canonical },
    });
}

// ─── Extras de uma gravação cancelada ──────────────────

/**
 * A gravação foi cancelada ou excluída: as cobranças em aberto (PENDING/FAILED) dela (Payment com contractId +
 * bookingId) deixam de ser devidas — a dos EXTRAS e a da PRÓPRIA sessão (SERVIÇO, FIXO extra, avulso). Por isso a
 * EQUIPE só cancela uma sessão com cobrança em aberto com cobrancas.baixa (R5, OPEN_CHARGE_CANCEL_NEEDS_BAIXA) e,
 * sem ela, nem chama esta função. Mesma sequência do cancelamento do contrato (voidContractPendingPaymentsDetailed
 * com `bookingIds`): a cobrança viva é aposentada no provedor antes — PIX/cartão já pago vira PAID, não é anulado —
 * e o resto vira CANCELLED (o cupom reservado nela é devolvido).
 *  - AVULSO (R5, FIN-10): entra também. O PENDING/FAILED de um avulso cancelado ficava preso a uma gravação
 *    cancelada — impagável (create-payment → 400 BOOKING_CANCELLED) e ainda listado como devido em "Meus
 *    pagamentos" e no "a receber" do Financeiro. O PAGO não é tocado (estorno é outra ação); a remarcação
 *    sem novo pagamento só vale para gravação paga (lib/avulsoMakeup) e o hold vencido do avulso do cliente
 *    segue na varredura (jobs/cleanExpiredHolds), que não passa por aqui.
 *  - Remarcação NÃO é cancelamento: nunca chamar ao remarcar.
 *  - Best-effort: nunca lança (a gravação já foi cancelada). Retorna quantas cobranças foram anuladas.
 */
export async function voidExtrasOfCancelledBooking(bookingId: string, contractId: string | null | undefined): Promise<number> {
    if (!contractId) return 0;
    try {
        const contract = await prisma.contract.findUnique({ where: { id: contractId }, select: { type: true } });
        if (!contract) return 0;
        const { voidContractPendingPaymentsDetailed } = await import('../../lib/paymentEffects.js');
        return (await voidContractPendingPaymentsDetailed(contractId, { bookingIds: [bookingId] })).voided;
    } catch (err) {
        console.error(`[BOOKING] Falha ao anular as cobranças de extras da gravação cancelada ${bookingId} (contrato ${contractId}):`, err);
        return 0;
    }
}

/**
 * Frase da resposta quando o cancelamento anulou cobranças em aberto da gravação ('' se nenhuma). Neutra: a
 * contagem inclui a cobrança da própria sessão (SERVIÇO, FIXO extra, avulso), não só a dos serviços extras.
 */
export function voidedExtrasNote(count: number): string {
    if (count <= 0) return '';
    return count === 1
        ? ' 1 cobrança em aberto desta gravação foi cancelada.'
        : ` ${count} cobranças em aberto desta gravação foram canceladas.`;
}

// ─── Conflict Detection ─────────────────────────────────

/** Check if a time slot conflicts with existing bookings on a date. */
export async function hasConflict(
    dateObj: Date,
    startTime: string,
    excludeBookingId?: string
): Promise<boolean> {
    const packageSlots = getPackageSlots(startTime);
    const where: any = {
        date: dateObj,
        status: { not: BookingStatus.CANCELLED },
        OR: packageSlots.map(slot => ({
            startTime: { lte: slot },
            endTime: { gt: slot },
        })),
    };

    if (excludeBookingId) {
        where.id = { not: excludeBookingId };
    }

    const conflicting = await prisma.booking.findFirst({ where });
    return !!conflicting;
}

// ─── Moving a booking (reschedule / makeup) ─────────────
// Shared by PATCH /:id/reschedule (cliente) and PATCH /:id/makeup (remarcação da falta do avulso,
// lib/avulsoMakeup.ts) so both apply the SAME slot rules, lock and conflict checks.

/** 409 ao mover uma reserva: trava do slot ocupada, conflito com outra reserva ou horário bloqueado. */
export class SlotUnavailableError extends Error {
    readonly httpStatus = 409;
    constructor(message: string) {
        super(message);
        this.name = 'SlotUnavailableError';
    }
}

/**
 * Valida o destino de uma movimentação de reserva: dia de funcionamento, horário da grade e MESMA
 * faixa da reserva original (o valor pago é o da faixa). Retorna a mensagem de erro (400) ou null.
 */
export async function checkMoveSlotTier(date: string, startTime: string, expectedTier: Tier): Promise<string | null> {
    const dayOfWeek = new Date(date + 'T00:00:00Z').getUTCDay();
    if (!(await isOperatingDay(dayOfWeek))) return 'O estúdio não funciona neste dia da semana.';
    const newTier = await getSlotTier(dayOfWeek, startTime);
    if (!newTier) return 'Horário fora da grade de operação.';
    if (newTier !== expectedTier) {
        return `O reagendamento deve manter a mesma faixa (${expectedTier}). O horário selecionado é ${newTier}.`;
    }
    return null;
}

/**
 * Tranca o slot de DESTINO (Redis, mesmo acquireMultiSlotLock do POST /), confere conflito com outras
 * reservas (excluindo a própria) e horário bloqueado, e só então executa `write`, liberando a trava
 * no fim. Fecha a janela TOCTOU entre a checagem e a gravação (B3). Lança SlotUnavailableError (409).
 */
export async function withMovableSlot<T>(
    opts: { date: string; startTime: string; lockOwner: string; excludeBookingId: string },
    write: (ctx: { dateObj: Date; endTime: string; packageSlots: string[] }) => Promise<T>,
): Promise<T> {
    const slotDur = await getSlotDuration();
    const packageSlots = getPackageSlots(opts.startTime, slotDur);
    const locked = await acquireMultiSlotLock(opts.date, packageSlots, opts.lockOwner);
    if (!locked) {
        throw new SlotUnavailableError('Este horário está sendo reservado por outra pessoa. Tente novamente em instantes.');
    }
    try {
        const dateObj = new Date(opts.date + 'T00:00:00Z');
        const conflicting = await prisma.booking.findFirst({
            where: {
                id: { not: opts.excludeBookingId },
                date: dateObj,
                status: { not: BookingStatus.CANCELLED },
                OR: packageSlots.map(slot => ({
                    startTime: { lte: slot },
                    endTime: { gt: slot },
                })),
            },
            select: { id: true },
        });
        if (conflicting) throw new SlotUnavailableError('O horário selecionado já está ocupado.');
        // Não mover para dentro de um horário bloqueado (manutenção).
        if (await hasBlockedConflict(dateObj, packageSlots)) {
            throw new SlotUnavailableError('Este horário está bloqueado (indisponível). Escolha outro.');
        }
        return await write({ dateObj, endTime: calculateEndTime(opts.startTime, slotDur), packageSlots });
    } finally {
        await releaseMultiSlotLock(opts.date, packageSlots, opts.lockOwner);
    }
}

// ─── Avulso: nome e vigência acompanham a gravação ──────

/** Nome do micro-contrato avulso: "Avulso DD/MM/AAAA às HH:MM" (`dateYmd` = "YYYY-MM-DD"). */
export function avulsoContractName(dateYmd: string, startTime: string, connector: 'às' | 'as' = 'às'): string {
    const [y, m, d] = dateYmd.slice(0, 10).split('-');
    return `Avulso ${d}/${m}/${y} ${connector} ${startTime}`;
}

/** Nome gerado automaticamente na criação do avulso (conector com ou sem acento). */
const AUTO_AVULSO_NAME = /^Avulso \d{2}\/\d{2}\/\d{4} (às|as) \d{2}:\d{2}$/;

/**
 * Avulso: quando a gravação muda de data/horário (PATCH admin com date/startTime, /reschedule e
 * /makeup), a vigência do micro-contrato (startDate = endDate = dia da gravação) e o nome gerado
 * ("Avulso DD/MM/AAAA às HH:MM") passam a refletir a gravação — a lista e o detalhe acompanham.
 *  - Só contrato AVULSO: qualquer outro tipo (inclusive o FLEX-1 legado) é no-op.
 *  - Nome fora do padrão gerado é mantido; o conector do nome atual ("às"/"as") é preservado, para
 *    não misturar formatos na lista.
 *  - Idempotente e best-effort: nunca lança (a gravação já foi movida). Retorna true se gravou algo.
 * `slot.date`: a data da gravação (@db.Date à 00:00Z) ou "YYYY-MM-DD".
 */
export async function syncAvulsoContractSchedule(
    contractId: string | null | undefined,
    slot: { date: Date | string; startTime: string },
): Promise<boolean> {
    if (!contractId) return false;
    try {
        const c = await prisma.contract.findUnique({
            where: { id: contractId },
            select: { type: true, name: true, startDate: true, endDate: true },
        });
        if (!c || c.type !== 'AVULSO') return false;

        const ymd = typeof slot.date === 'string' ? slot.date.slice(0, 10) : slot.date.toISOString().slice(0, 10);
        const day = new Date(ymd + 'T00:00:00Z');
        if (Number.isNaN(day.getTime())) return false;

        const data: { startDate?: Date; endDate?: Date; name?: string } = {};
        if (c.startDate.getTime() !== day.getTime()) data.startDate = day;
        if (c.endDate.getTime() !== day.getTime()) data.endDate = day;
        const auto = AUTO_AVULSO_NAME.exec(c.name);
        if (auto) {
            const name = avulsoContractName(ymd, slot.startTime, auto[1] as 'às' | 'as');
            if (name !== c.name) data.name = name;
        }
        if (Object.keys(data).length === 0) return false;

        const r = await prisma.contract.updateMany({ where: { id: contractId, type: 'AVULSO' }, data });
        return r.count > 0;
    } catch (err) {
        console.error(`[AVULSO] Falha ao sincronizar data/nome do contrato ${contractId}:`, err);
        return false;
    }
}
