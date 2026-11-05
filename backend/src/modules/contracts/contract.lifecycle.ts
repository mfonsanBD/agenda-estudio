import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireAllPermissions, enforceRuleResult, can, denyPermission } from '../../middleware/permissions.js';
import { requiredForContractPatch, requiredForContractCancel } from '../../lib/permissionRules.js';
import { getStaffRecipientIds } from '../../lib/staffRecipients.js';
import { requirePermissionIfStaff, routeActor } from '../bookings/permissionGuards.js';
import { BookingStatus, Prisma } from '../../generated/prisma/client.js';
import { getBasePriceDynamic, applyDiscount, calculateEndTime, getPackageSlots, getSlotDuration, studioDateTime } from '../../utils/pricing.js';
import { getConfig } from '../../lib/businessConfig.js';
import { getProviderForMethod, getBoletoStatus } from '../../lib/paymentGateway.js';
import { saoPauloParts } from '../../lib/spTime.js';
import { updateContractSchema, resolveCancellationSchema, renewContractSchema } from './validators.js';
import { createSlotClaimer, DELETED_CLIENT_ERROR } from './contract.creation.js';
import { notifyEvent } from '../notifications/notificationService.js';
import {
    CANCELLATION_FINE_KIND, freezeCancellationFine, resolveCancellationBasis, loadCancellationInfo,
    markContractCancelled, paymentKind, AUDIT_CONTRACT_CANCELLED,
    effectiveCancellationBasis, loadFineBasisPayments, isUnpaidPlanInstallment, isCancellationFine,
} from '../../lib/cancellationFine.js';
import { acquireMutexBlocking, releaseMutex } from '../../lib/redis.js';
import {
    fixoCapUsageWhere, FIXO_EXTRA_MARK_WHERE, OPEN_CHARGE_STATUSES, NO_OPEN_CHARGE_BOOKING_WHERE, SESSION_CHARGE_MARK_WHERE,
} from '../bookings/booking.service.js';
import type { Actor } from '../../middleware/permissions.js';

/** 'YYYY-MM-DD' + n dias (UTC). */
const addDaysYmd = (ds: string, n: number): string => {
    const d = new Date(ds + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};

/**
 * 'YYYY-MM-DD' de uma data SEM hora (startDate/endDate do contrato: meia-noite UTC em produção,
 * TZ=UTC; 03:00Z quando gravada por um processo no fuso de SP). NÃO usar saoPauloParts aqui: à
 * meia-noite UTC ele devolve o DIA ANTERIOR (21:00 em SP) — a renovação começava 1 dia antes.
 * saoPauloParts só para INSTANTES (ex.: `now` na retomada).
 */
const dateOnlyYmd = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Sessões semanais de um FIXO (renovação/retomada pelo admin) COM anti-overbooking: do dia `fromStr`
 * (inclusive) até `untilStr` (exclusivo), no dia/horário fixo, até `cap` sessões. Datas em UTC a partir
 * do calendário de SP (nada de getDay()/toISOString() local, que trocava o dia depois das 21h). Cada
 * ocorrência é trancada (Redis) e conferida no banco (createSlotClaimer): horário ocupado é PULADO e
 * contado — nunca grava por cima (antes estes dois caminhos faziam createMany direto). Não valida a
 * grade: contrato legado fora da grade (ex.: 14:00) continua renovável/retomável.
 * `skipPastToday`: hoje só entra se o horário ainda não passou (retomada no meio do dia).
 */
async function generateFixoSessions(opts: {
    lockOwner: string;
    userId: string;
    contractId: string;
    tier: string;
    fixedDayOfWeek: number;
    fixedTime: string;
    fromStr: string;
    untilStr: string;
    cap: number;
    price: number;
    status: BookingStatus;
    skipPastToday?: boolean;
}): Promise<{ created: number; skipped: string[] }> {
    const slotDuration = await getSlotDuration();
    const pkg = getPackageSlots(opts.fixedTime, slotDuration);
    const endTime = calculateEndTime(opts.fixedTime, slotDuration);
    const dow = ((opts.fixedDayOfWeek % 7) + 7) % 7;
    let ds = opts.fromStr;
    while (new Date(ds + 'T00:00:00Z').getUTCDay() !== dow) ds = addDaysYmd(ds, 1);
    const bookings: any[] = [];
    const skipped: string[] = [];
    const claimer = createSlotClaimer(opts.lockOwner);
    try {
        for (; ds < opts.untilStr && bookings.length < opts.cap; ds = addDaysYmd(ds, 7)) {
            if (opts.skipPastToday && studioDateTime(ds, opts.fixedTime).getTime() <= Date.now()) continue;
            if (!(await claimer.claim(ds, pkg))) {
                skipped.push(ds);
                console.warn(`[FIXO] slot ocupado — ocorrência pulada (contrato ${opts.contractId}): ${ds} ${opts.fixedTime}`);
                continue;
            }
            bookings.push({
                userId: opts.userId,
                contractId: opts.contractId,
                date: new Date(ds + 'T00:00:00Z'),
                startTime: opts.fixedTime,
                endTime,
                tierApplied: opts.tier,
                price: opts.price,
                status: opts.status,
            });
        }
        if (bookings.length) await prisma.booking.createMany({ data: bookings });
    } finally {
        await claimer.releaseAll();
    }
    return { created: bookings.length, skipped };
}

/** Sufixo da mensagem quando a geração pulou datas ocupadas. */
function skippedNote(skipped: string[], fixedTime: string, missing: number): string {
    if (skipped.length === 0) return '';
    const list = skipped.slice(0, 5).map(ds => `${ds.slice(8, 10)}/${ds.slice(5, 7)}`).join(', ') + (skipped.length > 5 ? '…' : '');
    const head = skipped.length === 1
        ? ` 1 data com o horário ${fixedTime} já ocupado foi pulada (${list}).`
        : ` ${skipped.length} datas com o horário ${fixedTime} já ocupado foram puladas (${list}).`;
    return missing > 0
        ? `${head} ${missing === 1 ? '1 gravação ficou' : `${missing} gravações ficaram`} sem data — agende manualmente.`
        : head;
}

// ─── Cancelamento / multa / renovação: apoio (E13, E4) ──────────────────────

/** "R$ 1.680,00" (com separador de milhar; sem o espaço não separável do Intl). */
const formatBRL = (cents: number): string =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100).replace(/\u00a0/g, ' ');

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const SP_HHMM = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * Gravações que o cancelamento de um contrato libera (E13): só as que ainda NÃO aconteceram —
 * RESERVED/CONFIRMED/HELD, sem "Iniciar gravação", com INÍCIO (data + hora, relógio de São Paulo) no
 * futuro. Nunca COMPLETED / FALTA / NAO_REALIZADO (o histórico da sessão feita — e o contador de
 * gravações realizadas — não é reescrito), nem a sessão de hoje que já começou (fica para o operador
 * finalizar ou marcar falta). `startTime` é sempre 'HH:MM' com zero à esquerda → comparação de texto vale.
 * Mesmo critério da exclusão de cliente (lib/userDeletion.futureBookingsWhere).
 */
function upcomingContractBookingsWhere(contractId: string, now: Date = new Date()): Prisma.BookingWhereInput {
    const today = new Date(`${saoPauloParts(now).dateStr}T00:00:00.000Z`);
    return {
        contractId,
        status: { in: ['RESERVED', 'CONFIRMED', 'HELD'] },
        recordingStartedAt: null,
        OR: [
            { date: { gt: today } },
            { date: today, startTime: { gt: SP_HHMM.format(now) } },
        ],
    };
}

/** Janela (dias até o fim da vigência) em que o admin vê o botão "Renovar" (E4). */
export const ADMIN_RENEW_WINDOW_DAYS = 30;

/** Dias do calendário de SP até o fim da vigência (endDate é data SEM hora). Negativo = já encerrou. */
function daysToContractEnd(endDate: Date, now: Date = new Date()): number {
    const sp = saoPauloParts(now);
    const [y, m, d] = dateOnlyYmd(endDate).split('-').map(Number);
    return Math.round((Date.UTC(y!, m! - 1, d!) - Date.UTC(sp.y, sp.m - 1, sp.day)) / 86_400_000);
}

/**
 * E4 — quando o botão "Renovar contrato" do admin aparece: contrato de plano (nunca AVULSO nem SERVIÇO,
 * que não têm renovação por este caminho), cliente não excluído, AINDA NÃO renovado (1 renovação por
 * contrato) e (a) ACTIVE/COMPLETED a ≤ 30 dias do fim da vigência (inclui vigência já encerrada) ou
 * (b) EXPIRED. Fonte única para a lista e o detalhe.
 */
function renewalState(
    c: { type: string; status: string; endDate: Date; user?: { deletedAt?: Date | null } | null },
    alreadyRenewed: boolean,
    now: Date = new Date(),
): { daysToEnd: number; canRenew: boolean } {
    const daysToEnd = daysToContractEnd(c.endDate, now);
    const supported = c.type !== 'AVULSO' && c.type !== 'SERVICO';
    const inWindow = c.status === 'EXPIRED'
        || ((c.status === 'ACTIVE' || c.status === 'COMPLETED') && daysToEnd <= ADMIN_RENEW_WINDOW_DAYS);
    return { daysToEnd, canRenew: supported && !c.user?.deletedAt && !alreadyRenewed && inWindow };
}

/** Renovações NÃO canceladas de cada contrato (contrato original → id da renovação mais recente). */
async function loadRenewals(contractIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (contractIds.length === 0) return map;
    const rows = await prisma.contract.findMany({
        where: { renewedFromId: { in: contractIds }, status: { not: 'CANCELLED' } },
        select: { id: true, renewedFromId: true },
        orderBy: { createdAt: 'asc' },
    });
    for (const r of rows) if (r.renewedFromId) map.set(r.renewedFromId, r.id);
    return map;
}

/**
 * Avisa a equipe (persistida + push) de um pedido de cancelamento recém-feito: ADMIN ativo + COLABORADOR
 * ativo com a permissão do evento (`contratos.multa` — STAFF_EVENT_PERMISSIONS); nunca BLOCKED nem
 * excluído. A dedup é POR PEDIDO (`requestedAt`): um contrato reaberto e pedido de novo no mesmo dia
 * avisa outra vez. Nunca lança.
 */
async function notifyAdminsCancellationRequested(
    contract: { id: string; name: string },
    clientName: string,
    fine: { fineAmount: number; requestedAt: Date },
): Promise<void> {
    try {
        const staffIds = await getStaffRecipientIds('admin_cancellation_requested');
        for (const staffId of staffIds) {
            await notifyEvent('admin_cancellation_requested', {
                userId: staffId,
                vars: { cliente: clientName, contrato: contract.name, valor: formatBRL(fine.fineAmount) },
                entityType: 'CONTRACT',
                entityId: contract.id,
                dedupKey: `cancel-request:${contract.id}:${fine.requestedAt.getTime()}:${staffId}`,
            }).catch(() => '');
        }
    } catch (err) {
        console.error('[cancellation] Falha ao avisar a equipe do pedido de cancelamento:', err);
    }
}

/**
 * Remove o aviso persistido "pedido de cancelamento" da EQUIPE (ADMIN e COLABORADOR — inclusive de quem
 * perdeu a permissão depois de receber) quando o pedido deixa de estar em análise (resolvido, cancelado
 * ou contrato reaberto): sem isto ele reapareceria no sino assim que o alerta computado "Cancelamento
 * pendente" some. Nunca lança.
 */
async function clearAdminCancellationRequestNotices(contractId: string): Promise<void> {
    try {
        await prisma.notification.deleteMany({
            where: {
                type: 'CANCELLATION_PENDING', entityType: 'CONTRACT', entityId: contractId,
                user: { role: { in: ['ADMIN', 'COLABORADOR'] } },
            },
        });
    } catch (err) {
        console.error('[cancellation] Falha ao limpar o aviso do pedido de cancelamento:', err);
    }
}

/**
 * Fecha o ciclo de avisos quando o contrato vira CANCELLED: limpa o aviso do pedido dos admins e avisa
 * o CLIENTE (persistida + push): multa gerada (com o valor) ou cancelamento sem multa. Nunca lança.
 */
async function notifyClientContractCancelled(
    contract: { id: string; name: string; userId: string },
    fine: { id: string; amount: number; finePct: number; baseAmount: number } | null,
): Promise<void> {
    await clearAdminCancellationRequestNotices(contract.id);
    try {
        if (fine) {
            await notifyEvent('contract_cancellation_fine', {
                userId: contract.userId,
                vars: { contrato: contract.name, valor: formatBRL(fine.amount), percentual: fine.finePct, base: formatBRL(fine.baseAmount) },
                entityType: 'PAYMENT',
                entityId: fine.id,
            });
        } else {
            await notifyEvent('contract_cancelled_no_fine', {
                userId: contract.userId,
                vars: { contrato: contract.name },
                entityType: 'CONTRACT',
                entityId: contract.id,
            });
        }
    } catch (err) {
        console.error('[cancellation] Falha ao avisar o cliente do cancelamento:', err);
    }
}

/** Frase para o admin sobre o que a anulação encontrou no provedor (vazia quando nada a dizer). */
function providerSettlementNote(v: { paidAtProvider: string[]; liveAtProvider: string[] }): string {
    let note = '';
    if (v.paidAtProvider.length > 0) {
        note += ` ${plural(v.paidAtProvider.length, 'cobrança já estava paga', 'cobranças já estavam pagas')} no banco/cartão e ${v.paidAtProvider.length === 1 ? 'ficou registrada como paga' : 'ficaram registradas como pagas'} (não ${v.paidAtProvider.length === 1 ? 'foi anulada' : 'foram anuladas'}).`;
    }
    if (v.liveAtProvider.length > 0) {
        note += ` Atenção: ${plural(v.liveAtProvider.length, 'cobrança emitida não pôde', 'cobranças emitidas não puderam')} ser ${v.liveAtProvider.length === 1 ? 'cancelada' : 'canceladas'} no banco/cartão agora — se o cliente pagar, você será avisado.`;
    }
    return note;
}

/** Mensagem do cancelamento feito pelo admin (DELETE e PATCH status=CANCELLED): o que foi cancelado + a nota do provedor. */
function adminCancelMessage(voidResult: { voided: number; paidAtProvider: string[]; liveAtProvider: string[] }): string {
    return (voidResult.voided > 0
        ? `Contrato cancelado. Agendamentos futuros e ${voidResult.voided} parcela(s) pendente(s) foram cancelados.`
        : 'Contrato cancelado. Agendamentos futuros foram cancelados.') + providerSettlementNote(voidResult);
}

/**
 * Trava por contrato que serializa TODO cancelamento (decisão do pedido, DELETE e PATCH status=CANCELLED):
 * reler o status → anular as parcelas → mudar o status acontecem com exclusividade. Sem ela, duas
 * requisições passavam juntas pela checagem de status e a segunda anulava (ou avisava por cima de) o que
 * a primeira acabara de gravar. Espera até ~15 s pela outra requisição (a anulação fala com o provedor).
 * Devolve a chave (para liberar no `finally`), `null` se continua ocupada, ou `''` com o Redis fora do ar —
 * aí segue sem a trava: o claim atômico do banco e o filtro da multa na anulação continuam valendo.
 */
async function acquireContractCancelLock(contractId: string): Promise<string | null> {
    const key = `mutex:contract-cancel:${contractId}`;
    try {
        return (await acquireMutexBlocking(key, 120, 150, 100)) ? key : null;
    } catch (err) {
        console.warn(`[cancellation] Redis indisponível — cancelamento do contrato ${contractId} segue sem a trava:`, err instanceof Error ? err.message : err);
        return '';
    }
}

/** 409 quando outra requisição ainda está cancelando o mesmo contrato. */
const CANCELLATION_IN_PROGRESS_BODY = {
    error: 'O cancelamento deste contrato já está sendo processado. Aguarde alguns instantes e atualize a lista.',
    code: 'CANCELLATION_IN_PROGRESS',
} as const;

/** 409 da decisão quando o contrato não está (mais) em PENDING_CANCELLATION — lista defasada, duplo clique, outro admin. */
const cancellationNotPendingBody = (status: string | null | undefined) => ({
    error: status === 'CANCELLED'
        ? 'Este pedido de cancelamento já foi resolvido.'
        : 'O contrato não está mais aguardando cancelamento.',
    code: 'CANCELLATION_NOT_PENDING' as const,
});

// ─── Anular cobrança em aberto é da baixa (R5) — caminhos do CONTRATO (conserto 5) ─────

/**
 * Cobranças EM ABERTO (PENDING/FAILED) por contrato — um groupBy só (lista da equipe). A tela usa no AVULSO, em que o
 * contrato é a própria sessão: sem a baixa, "Cancelar contrato" não aparece com cobrança em aberto (ATU5-03).
 */
async function openChargeCountsByContract(contractIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (contractIds.length === 0) return out;
    const rows = await prisma.payment.groupBy({
        by: ['contractId'],
        where: { contractId: { in: [...contractIds] }, status: { in: OPEN_CHARGE_STATUSES } },
        _count: { _all: true },
    });
    for (const r of rows) if (r.contractId) out.set(r.contractId, r._count._all);
    return out;
}

/**
 * Cancelar o contrato — DELETE, PATCH status=CANCELLED e a DECISÃO do pedido de cancelamento (resolve-cancellation) —
 * anula as cobranças em aberto dele. A parte que é cobrança de SESSÃO segue o princípio "anular cobrança em aberto é da
 * baixa" (o mesmo do DELETE /bookings/:id): sem cobrancas.baixa → 403 antes de qualquer escrita. Qual parte é essa:
 *  • AVULSO (ATU5-03): o contrato É a sessão → toda cobrança em aberto dele (a da sessão e a dos extras dela);
 *  • qualquer outro tipo — SERVIÇO, FIXO, FLEX, Personalizado (AUDFIN6-01/ATU6-02): a cobrança PRÓPRIA de uma gravação
 *    (Payment com bookingId e a marca sessionCharge — gravação vinculada a um SERVIÇO, sessão EXTRA do FIXO, sessão
 *    cobrada à parte dentro do plano) em aberto (PENDING/FAILED), inclusive a de uma gravação já feita (a anulação do
 *    contrato não olha o status da sessão).
 * As PARCELAS do contrato (sem bookingId) e os serviços extras de sessão de plano continuam anulados só com
 * contratos.cancelar / contratos.multa (decisão do dono, D2). ADMIN e quem tem a baixa seguem como antes.
 */
export function contractCancelBaixaChargeWhere(contract: { id: string; type: string }): Prisma.PaymentWhereInput {
    const open: Prisma.PaymentWhereInput = { contractId: contract.id, status: { in: OPEN_CHARGE_STATUSES } };
    return contract.type === 'AVULSO' ? open : { ...open, bookingId: { not: null }, ...SESSION_CHARGE_MARK_WHERE };
}

export const AVULSO_CANCEL_OPEN_CHARGE_NEEDS_BAIXA = {
    error: 'Este avulso tem cobrança em aberto: cancelar o contrato anula a cobrança da sessão, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa.',
    code: 'PERMISSION_DENIED',
    permission: 'cobrancas.baixa',
} as const;

/** AUDFIN6-01/ATU6-02: o mesmo 403 (code/permission) fora do avulso, com o texto do caso — a cobrança própria de uma gravação. */
export const SESSION_CHARGE_CANCEL_NEEDS_BAIXA = {
    error: 'Uma gravação deste contrato tem cobrança própria em aberto (a da sessão, cobrada à parte): cancelar o contrato anula essa cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa.',
    code: 'PERMISSION_DENIED',
    permission: 'cobrancas.baixa',
} as const;

/** O corpo do 403 quando o ator não pode cancelar este contrato sem a baixa, ou null quando pode. */
async function contractCancelNeedsBaixa(
    contract: { id: string; type: string },
    actor: Actor,
): Promise<typeof AVULSO_CANCEL_OPEN_CHARGE_NEEDS_BAIXA | typeof SESSION_CHARGE_CANCEL_NEEDS_BAIXA | null> {
    if (can(actor, 'cobrancas.baixa')) return null;
    if ((await prisma.payment.count({ where: contractCancelBaixaChargeWhere(contract) })) === 0) return null;
    return contract.type === 'AVULSO' ? AVULSO_CANCEL_OPEN_CHARGE_NEEDS_BAIXA : SESSION_CHARGE_CANCEL_NEEDS_BAIXA;
}

/**
 * Por contrato, quantas cobranças em aberto o cancelamento só anula COM a baixa (contractCancelBaixaChargeWhere): no
 * avulso, todas as em aberto (= openChargeCount); nos outros tipos, a cobrança própria marcada de uma gravação. Dois
 * groupBy (lista da equipe) — a tela sabe, sem outra chamada, que "Cancelar contrato" / a decisão do pedido pedem a baixa.
 */
async function sessionChargeCountsByContract(contractIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (contractIds.length === 0) return out;
    const rows = await prisma.payment.groupBy({
        by: ['contractId'],
        where: { contractId: { in: [...contractIds] }, status: { in: OPEN_CHARGE_STATUSES }, bookingId: { not: null }, ...SESSION_CHARGE_MARK_WHERE },
        _count: { _all: true },
    });
    for (const r of rows) if (r.contractId) out.set(r.contractId, r._count._all);
    return out;
}

/**
 * AUDFIN-03: pausar o FIXO cancela as gravações futuras do plano (a retomada as recria) — cancelar uma sessão com
 * cobrança em aberto (extra contratado nela) a anula, e anular é da baixa. Sem cobrancas.baixa → 403 antes de
 * qualquer escrita. A sessão EXTRA (fixoExtra, cobrada à parte) não é cancelada pela pausa.
 */
const PAUSE_OPEN_CHARGE_NEEDS_BAIXA = {
    error: 'Uma gravação que a pausa cancelaria tem cobrança em aberto: cancelar anula a cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa.',
    code: 'PERMISSION_DENIED',
    permission: 'cobrancas.baixa',
} as const;

/** `kind` (ex.: 'CANCELLATION_FINE') exposto ao lado de cada cobrança — as telas não leem o metadata. */
const withPaymentKind = <T extends { metadata?: unknown }>(p: T): T & { kind: string | null } => ({ ...p, kind: paymentKind(p.metadata) });

export function registerLifecycleRoutes(router: Router) {

// ─── GET /api/contracts (equipe) ─────────────────────────
// Tela Contratos (`contratos.ver`) e o seletor de plano do "Novo agendamento" (`agendamentos.criar` —
// CreateBookingModal lista os planos do cliente; proposta §2.5).

router.get('/', authenticate, requirePermission('contratos.ver', 'agendamentos.criar'), async (req: Request, res: Response) => {
    // Bounded by default (no full-table scan); accepts optional ?page/?limit/?status without
    // breaking the existing `{ contracts }` response shape (adds an optional `pagination` block).
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? ''), 10) || 200));
    const page = Math.max(1, parseInt(String(req.query.page ?? ''), 10) || 1);
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    const where = statusRaw ? { status: statusRaw as any } : {};

    const [contracts, total] = await Promise.all([
        prisma.contract.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
            include: {
                // deletedAt: a lista do admin marca "Cliente excluído" e esconde Renovar/ações que
                // criariam obrigação nova para um cliente anonimizado (D3).
                user: { select: { id: true, name: true, email: true, deletedAt: true } },
                _count: { select: { bookings: true, payments: true } },
            },
        }),
        prisma.contract.count({ where }),
    ]);

    // E13/E4: o admin decide com os números na mão — pago, saldo do plano, multa (congelada no pedido),
    // data do pedido/cancelamento, multa gerada — e o botão "Renovar" sabe se o contrato já foi renovado.
    // Consultas em lote (nº fixo, seja qual for o tamanho da página).
    const ids = contracts.map(c => c.id);
    const [cancellation, renewals, openCharges, sessionCharges] = await Promise.all([
        loadCancellationInfo(contracts), loadRenewals(ids), openChargeCountsByContract(ids), sessionChargeCountsByContract(ids),
    ]);
    const now = new Date();
    const enriched = contracts.map(c => {
        const renewedToId = renewals.get(c.id) ?? null;
        const openChargeCount = openCharges.get(c.id) ?? 0;
        return {
            ...c,
            ...cancellation.get(c.id),
            alreadyRenewed: !!renewedToId,
            renewedToId,
            ...renewalState(c, !!renewedToId, now),
            // ATU5-03: cobranças em aberto do contrato (PENDING/FAILED) — no avulso, as da própria sessão.
            openChargeCount,
            // AUDFIN6-01/ATU6-02: as que cancelar o contrato (ou decidir o pedido) só anula com a baixa — a conta do 403.
            openSessionChargeCount: c.type === 'AVULSO' ? openChargeCount : (sessionCharges.get(c.id) ?? 0),
        };
    });

    res.json({ contracts: enriched, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

// ─── GET /api/contracts/my ──────────────────────────────

router.get('/my', authenticate, async (req: Request, res: Response) => {
    const contracts = await prisma.contract.findMany({
        where: { userId: req.user!.userId },
        orderBy: { createdAt: 'desc' },
        include: {
            _count: { select: { bookings: true } },
            bookings: {
                select: {
                    id: true, status: true, date: true, originalDate: true,
                    startTime: true, endTime: true, tierApplied: true, price: true,
                    // E11: a nota INTERNA do admin (adminNotes) NUNCA vai para o cliente — só o recado do
                    // estúdio (clientNotes). recordingStartedAt → "AO VIVO" só enquanto a gravação acontece.
                    clientNotes: true, platforms: true, platformLinks: true, addOns: true,
                    recordingStartedAt: true,
                    // Episódio + métricas da gravação (modal de métricas do cliente).
                    episodeTitle: true, coverImageUrl: true,
                    durationMinutes: true, peakViewers: true, chatMessages: true, audienceOrigin: true,
                    isLivestream: true, streamMetrics: true,
                    // Motivo da falta + janela de remarcação do avulso (D4/D5).
                    statusReason: true, makeupStatus: true, makeupDeadline: true, missedDate: true,
                },
                orderBy: { date: 'asc' },
                where: { status: { not: 'CANCELLED' } },
            },
            payments: {
                // installments/provider: o ContractCard mostra "Parcelado no cartão (Nx)" e o método real (D1/D15).
                // chargedAmount/providerRef: "total pago" pelo valor efetivamente cobrado (cartão = valor do PI).
                // bookingId/metadata: distinguem parcela do plano, extra de gravação e multa (E13) — o
                // metadata NÃO sai na resposta, só o `kind` derivado dele.
                select: { id: true, amount: true, status: true, dueDate: true, paidAt: true, pixString: true, pixExpiresAt: true, boletoUrl: true, paymentUrl: true, installments: true, provider: true, chargedAmount: true, providerRef: true, bookingId: true, metadata: true },
                orderBy: { dueDate: 'asc' },
            },
        },
    });

    // E13: saldo do plano, prévia da multa (a congelada enquanto o pedido está em análise), datas do
    // pedido/cancelamento e a multa gerada — o CancelContractModal e o card cancelado leem daqui.
    const [cancellation, renewals] = await Promise.all([
        loadCancellationInfo(contracts),
        loadRenewals(contracts.map(c => c.id)),
    ]);

    // AUDFIN-05: vagas do plano FIXO usadas pela MESMA regra do servidor (fixoCapUsageWhere — a do POST / do cliente):
    // RESERVED também ocupa e a sessão EXTRA (fixoExtra) não. `completedBookings` segue como estava (outros leitores).
    const fixoUsed = new Map(await Promise.all(contracts.filter(c => c.type === 'FIXO').map(async c =>
        [c.id, await prisma.booking.count({ where: fixoCapUsageWhere(c.id) })] as const)));

    // Enrich with completed bookings count and addon usage
    const sessionsPerMonthMy = await getConfig('sessions_per_month');
    const enriched = contracts.map(c => {
        const completedBookings = c.bookings.filter(b =>
            b.status === 'COMPLETED' || b.status === 'CONFIRMED' || b.status === 'FALTA'
        ).length;
        const totalBookings = c.type === 'FIXO'
            ? c.durationMonths * sessionsPerMonthMy
            : (c.flexCreditsTotal || 0);

        let addonUsage: Record<string, { limit: number, used: number }> | undefined = undefined;

        if (c.type === 'CUSTOM' && c.addonCredits) {
            try {
                const config = JSON.parse(c.addonCredits) as Record<string, { mode: string, perCycle?: number }>;
                addonUsage = {};
                
                // Determine current cycle
                const now = new Date();
                const msPerCycle = 1000 * 60 * 60 * 24 * 28; // 4 weeks
                let diffMs = now.getTime() - c.startDate.getTime();
                let cycleIndex = Math.floor(diffMs / msPerCycle);
                if (cycleIndex < 0) cycleIndex = 0;
                
                const cycleStart = new Date(c.startDate.getTime() + cycleIndex * msPerCycle);
                const cycleEnd = new Date(cycleStart.getTime() + msPerCycle);

                // Initialize limits
                for (const [key, val] of Object.entries(config)) {
                    if (val.mode === 'credits' && val.perCycle) {
                        addonUsage[key] = { limit: val.perCycle, used: 0 };
                    }
                }

                // Count usage in current cycle
                for (const b of c.bookings) {
                    if (b.date >= cycleStart && b.date < cycleEnd && (b.status === 'CONFIRMED' || b.status === 'COMPLETED' || b.status === 'FALTA')) {
                        if (b.addOns && Array.isArray(b.addOns)) {
                            for (const addOn of b.addOns) {
                                if (addonUsage[addOn]) {
                                    addonUsage[addOn].used += 1;
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                console.error("Error parsing addonCredits for contract", c.id, e);
            }
        }

        const result = {
            ...c,
            payments: c.payments.map(({ metadata, ...p }) => ({ ...p, kind: paymentKind(metadata) })),
            ...cancellation.get(c.id),
            alreadyRenewed: renewals.has(c.id),
            completedBookings,
            totalBookings,
            ...(c.type === 'FIXO' ? { planSessionsUsed: fixoUsed.get(c.id) ?? 0 } : {}),
            ...(addonUsage ? { addonUsage } : {})
        };
        return result;
    });

    res.json({ contracts: enriched });
});

// ─── GET /api/contracts/:id ─────────────────────────────
// Rota MISTA: o cliente lê o próprio contrato; a equipe lê qualquer um com `contratos.ver` (sem ela,
// 403 — nunca o ramo do cliente).

router.get('/:id', authenticate, requirePermissionIfStaff('contratos.ver'), async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const actor = await routeActor(req, res);
    if (!actor) return;
    const isStaff = actor.isStaff; // equipe já conferida pela guarda (contratos.ver)

    const contract = await prisma.contract.findFirst({
        where: {
            id,
            ...(isStaff ? {} : { userId: req.user!.userId }),
        },
        include: {
            // deletedAt: selo "Cliente excluído" (D3). cpfCnpj SÓ para a equipe (E1): o "Cobrar" do detalhe
            // usa o CPF do CLIENTE no PIX — nunca o de quem está logado.
            user: { select: { id: true, name: true, email: true, deletedAt: true, cpfCnpj: isStaff } },
            bookings: {
                orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
                select: {
                    id: true,
                    date: true,
                    startTime: true,
                    endTime: true,
                    status: true,
                    tierApplied: true,
                    price: true,
                    clientNotes: true,
                    // E11: nota interna e nome do operador só para a equipe (a rota também atende o dono do contrato).
                    adminNotes: isStaff,
                    platforms: true,
                    platformLinks: true,
                    addOns: true,
                    durationMinutes: true,
                    peakViewers: true,
                    chatMessages: true,
                    audienceOrigin: true,
                    isLivestream: true,
                    streamMetrics: true,
                    recordingStartedAt: true,
                    recordingStartedByName: isStaff,
                    statusReason: true,
                    originalDate: true,
                    makeupStatus: true,
                    makeupDeadline: true,
                    missedDate: true,
                },
            },
            payments: {
                orderBy: { dueDate: 'asc' },
            },
        },
    });

    if (!contract) {
        res.status(404).json({ error: 'Contrato não encontrado.' });
        return;
    }

    // E13/E4: mesmos campos da lista (multa, datas, renovação) + `kind` em cada cobrança.
    const [cancellation, renewals] = await Promise.all([loadCancellationInfo([contract]), loadRenewals([contract.id])]);
    const renewedToId = renewals.get(contract.id) ?? null;

    res.json({
        contract: {
            ...contract,
            payments: contract.payments.map(withPaymentKind),
            ...cancellation.get(contract.id),
            alreadyRenewed: !!renewedToId,
            renewedToId,
            ...renewalState(contract, !!renewedToId),
        },
    });
});

// ─── PATCH /api/contracts/:id (equipe) ────────────
// Rota multiuso: permissão por VALOR alterado (DECISÕES D3 / crítica F3-F4 — o "Editar" reenvia endDate e
// os créditos atuais do FLEX): status CANCELLED → contratos.cancelar; ACTIVE/COMPLETED/EXPIRED, endDate,
// contractUrl, paymentMethod → contratos.editar; flexCreditsRemaining, addOns, boletoAllowed →
// contratos.condicoes; contrato em PENDING_CANCELLATION com mudança de status (cancelar = isentar a
// multa; reabrir = recusar o pedido) → também contratos.multa. Regras em lib/permissionRules.

router.patch('/:id', authenticate, requirePermission('contratos.editar', 'contratos.cancelar', 'contratos.condicoes'), async (req: Request, res: Response) => {
    let cancelLock: string | null = null;
    try {
        const id = req.params.id as string;
        const data = updateContractSchema.parse(req.body);

        const contract = await prisma.contract.findUnique({ where: { id }, include: { user: { select: { deletedAt: true } } } });
        if (!contract) {
            res.status(404).json({ error: 'Contrato não encontrado.' });
            return;
        }
        // Permissão por valor alterado, ANTES de qualquer efeito (a linha completa do Prisma é o registro atual).
        if (!(await enforceRuleResult(req, res, requiredForContractPatch(data, contract)))) return;
        const actor = await routeActor(req, res);
        if (!actor) return;
        // D3: contrato de cliente excluído não volta a valer (reativar recriaria obrigação para uma
        // conta anonimizada). Encerrar/ajustar link, forma e datas continua permitido (o "Editar" da
        // lista reenvia os créditos atuais do FLEX — só uma MUDANÇA conta).
        const reopensForDeleted = (data.status === 'ACTIVE' && contract.status !== 'ACTIVE')
            || (data.flexCreditsRemaining !== undefined && data.flexCreditsRemaining !== contract.flexCreditsRemaining)
            || data.addOns !== undefined;
        if (contract.user?.deletedAt && reopensForDeleted) {
            res.status(409).json({ error: `${DELETED_CLIENT_ERROR} Não é possível reativar o contrato nem mudar créditos ou serviços.`, code: 'CLIENT_DELETED' });
            return;
        }

        // E3: trocar a forma do contrato para BOLETO só com o boleto EFETIVO (chave-mestra ligada E Cora
        // habilitada — fonte única getBoletoStatus), como na criação. Recusa ANTES de qualquer efeito.
        // Reenviar o BOLETO que o contrato já tinha (legado) não é troca e não bloqueia as outras edições.
        if (data.paymentMethod === 'BOLETO' && contract.paymentMethod !== 'BOLETO') {
            const boleto = await getBoletoStatus();
            if (!boleto.available) {
                res.status(400).json({
                    error: boleto.message ?? 'O pagamento por boleto não está disponível.',
                    code: 'BOLETO_UNAVAILABLE',
                    reason: boleto.reason,
                });
                return;
            }
        }

        const updateData: any = {};
        // Só uma MUDANÇA de status é gravada: reenviar o status lido não pode sobrescrever um status novo
        // gravado por outra tela no meio do caminho (ex.: PENDING_CANCELLATION do pedido do cliente).
        if (data.status && data.status !== contract.status) updateData.status = data.status;
        if (data.endDate) updateData.endDate = new Date(data.endDate + 'T00:00:00');
        if (data.flexCreditsRemaining !== undefined) updateData.flexCreditsRemaining = data.flexCreditsRemaining;
        if (data.contractUrl !== undefined) updateData.contractUrl = data.contractUrl || null;
        if (data.paymentMethod) updateData.paymentMethod = data.paymentMethod;
        // E3: `boletoAllowed` no corpo é IGNORADO — a liberação por contrato não é mais autoridade (a coluna
        // fica sem uso; quem decide é a chave-mestra + Cora).
        // addOns is NOT applied via updateData — it goes through applyContractServiceChange,
        // which also recomputes the future PENDING installments and future bookings' services.

        // Recurring services edit (FIXO/FLEX ACTIVE only) — validado ANTES de qualquer escrita.
        if (data.addOns !== undefined && (contract.status !== 'ACTIVE' || (contract.type !== 'FIXO' && contract.type !== 'FLEX'))) {
            res.status(400).json({ error: 'Serviços só podem ser editados em contratos Fixo/Flex ativos.' });
            return;
        }

        // Mudança de status (fora do cancelamento, que tem trava e releitura próprias): gravada SÓ se o
        // contrato ainda está no status LIDO — a permissão foi decidida sobre ele (se o cliente pediu o
        // cancelamento entre a leitura e a escrita, reabrir passaria a exigir contratos.multa). Corrida →
        // 409 sem efeito nenhum; o front recarrega.
        if (updateData.status && updateData.status !== 'CANCELLED') {
            const moved = await prisma.contract.updateMany({ where: { id, status: contract.status }, data: { status: updateData.status } });
            if (moved.count === 0) {
                res.status(409).json({
                    error: 'O contrato mudou em outra tela (por exemplo, o cliente pediu o cancelamento). Atualize a lista e tente de novo.',
                    code: 'CONTRACT_STATUS_CHANGED',
                });
                return;
            }
            delete updateData.status; // já gravado acima
        }

        // Recurring services edit (FIXO/FLEX ACTIVE only) — affects the FUTURE only.
        if (data.addOns !== undefined) {
            const { applyContractServiceChange } = await import('../../lib/paymentEffects.js');
            await applyContractServiceChange(id, data.addOns);
        }

        // FIX (C2): cancelar via PATCH deve limpar como o DELETE — anular parcelas PENDING e
        // cancelar bookings futuros. Sem isto o contrato ficava CANCELLED com parcelas cobráveis
        // (auto-charge / webhook tardio) e a agenda futura ativa. Só na transição real p/ CANCELLED;
        // void-before-update (idempotente) para retries permanecerem seguros.
        // Serializado com a decisão do pedido e o DELETE (acquireContractCancelLock): o status é RELIDO com
        // a trava — se outra requisição já cancelou, este PATCH não anula nem avisa o cliente de novo.
        // A anulação nunca toca na multa de cancelamento (criada pela decisão do pedido).
        let cancelingViaPatch = data.status === 'CANCELLED' && contract.status !== 'CANCELLED';
        let voidResult: { voided: number; paidAtProvider: string[]; liveAtProvider: string[] } | null = null;
        if (cancelingViaPatch) {
            cancelLock = await acquireContractCancelLock(id);
            if (cancelLock === null) {
                res.status(409).json(CANCELLATION_IN_PROGRESS_BODY);
                return;
            }
            const fresh = await prisma.contract.findUnique({ where: { id }, select: { status: true } });
            cancelingViaPatch = !!fresh && fresh.status !== 'CANCELLED';
            // F3 relido com a trava: o cliente pediu o cancelamento depois da leitura → cancelar agora
            // isentaria a multa, decisão de contratos.multa (a trava é liberada no finally).
            if (cancelingViaPatch && fresh!.status === 'PENDING_CANCELLATION' && !can(actor, 'contratos.multa')) {
                denyPermission(res, 'contratos.multa');
                return;
            }
            // ATU5-03/AUDFIN6-01: cancelar o contrato anula a cobrança de sessão em aberto (o avulso inteiro; nos outros
            // tipos, a cobrança própria de uma gravação) — só com a baixa.
            const needsBaixa = cancelingViaPatch ? await contractCancelNeedsBaixa(contract, actor) : null;
            if (needsBaixa) {
                res.status(403).json(needsBaixa);
                return;
            }
        }
        if (cancelingViaPatch) {
            // Versão detalhada: o que o provedor respondeu (cobrança já paga / não cancelável) volta ao
            // admin na resposta, como no DELETE.
            const { voidContractPendingPaymentsDetailed } = await import('../../lib/paymentEffects.js');
            voidResult = await voidContractPendingPaymentsDetailed(id);
        }

        // D1 (pagamentos-3) — troca da forma de pagamento: os valores das cobranças NÃO mudam. O cartão
        // cobra a base marcada na criação (metadata.pixDiscount) ou o próprio amount; a forma do contrato
        // nunca decide se o desconto PIX é revertido (ver cardChargeBaseAmount), então a troca nunca infla.

        const updated = await prisma.contract.update({
            where: { id },
            data: updateData,
            include: {
                user: { select: { id: true, name: true, email: true } },
            },
        });

        // D6: ajuste manual de créditos FLEX pode reabrir (ou concluir) o contrato. Um status escolhido
        // explicitamente pelo admin no mesmo PATCH prevalece (não é recalculado aqui).
        if (data.flexCreditsRemaining !== undefined && !data.status && !contract.user?.deletedAt) {
            const { syncContractCompletion } = await import('../../lib/contractCompletion.js');
            await syncContractCompletion(id, req.user!.userId);
        }

        if (cancelingViaPatch && voidResult) {
            // E13: só as gravações que ainda NÃO aconteceram (início futuro no relógio de SP). Inclui a de
            // hoje que ainda não começou (B6) e nunca reescreve COMPLETED/FALTA/NAO_REALIZADO.
            const cancelledBookings = await prisma.booking.updateMany({
                where: upcomingContractBookingsWhere(id),
                data: { status: 'CANCELLED' },
            });
            await markContractCancelled(id, req.user!.userId, { via: 'ADMIN_PATCH', from: contract.status, voidedCount: voidResult.voided });
            await notifyClientContractCancelled(updated, null);
            // Mesma resposta do DELETE: contagens + a nota do provedor (o front mostra o alerta persistente
            // quando uma cobrança já estava paga ou não pôde ser cancelada no banco/cartão).
            res.json({
                contract: updated,
                message: adminCancelMessage(voidResult),
                voidedCount: voidResult.voided,
                cancelledBookings: cancelledBookings.count,
                paidAtProvider: voidResult.paidAtProvider.length,
                liveAtProvider: voidResult.liveAtProvider.length,
            });
            return;
        } else if (contract.status === 'PENDING_CANCELLATION' && updated.status !== 'PENDING_CANCELLATION') {
            // Pedido de cancelamento desfeito pelo admin (contrato reaberto): o aviso do pedido sai do sino.
            await clearAdminCancellationRequestNotices(id);
        }

        res.json({ contract: updated, message: 'Contrato atualizado com sucesso.' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    } finally {
        if (cancelLock) await releaseMutex(cancelLock).catch(() => {});
    }
});

// ─── DELETE /api/contracts/:id (equipe — cancelar) ───────────
// contratos.cancelar; com pedido de cancelamento em análise (PENDING_CANCELLATION) cancelar por aqui
// equivale a ISENTAR a multa → também contratos.multa (crítica F3).

router.delete('/:id', authenticate, requirePermission('contratos.cancelar'), async (req: Request, res: Response) => {
    const id = req.params.id as string;

    const contract = await prisma.contract.findUnique({ where: { id } });
    if (!contract) {
        res.status(404).json({ error: 'Contrato não encontrado.' });
        return;
    }

    if (contract.status === 'CANCELLED') {
        res.status(400).json({ error: 'Contrato já está cancelado.' });
        return;
    }
    if (!(await enforceRuleResult(req, res, requiredForContractCancel(contract)))) return;
    const actor = await routeActor(req, res);
    if (!actor) return;

    // Serializado com a decisão do pedido e o PATCH status=CANCELLED: o status é RELIDO com a trava. Se
    // outra requisição cancelou no meio do caminho (ex.: a decisão que gerou a multa), este DELETE não
    // anula nada nem manda ao cliente um segundo aviso "cancelado sem multa".
    const cancelLock = await acquireContractCancelLock(id);
    if (cancelLock === null) {
        res.status(409).json(CANCELLATION_IN_PROGRESS_BODY);
        return;
    }
    try {
        const fresh = await prisma.contract.findUnique({ where: { id }, select: { status: true } });
        if (!fresh || fresh.status === 'CANCELLED') {
            res.status(400).json({ error: 'Contrato já está cancelado.' });
            return;
        }
        // F3 relido com a trava: o pedido de cancelamento chegou depois da leitura → também contratos.multa.
        if (fresh.status === 'PENDING_CANCELLATION' && !can(actor, 'contratos.multa')) {
            denyPermission(res, 'contratos.multa');
            return;
        }
        // ATU5-03/AUDFIN6-01: cancelar o contrato anula a cobrança de sessão em aberto (o avulso inteiro; nos outros tipos,
        // a cobrança própria de uma gravação) — só com a baixa.
        const needsBaixa = await contractCancelNeedsBaixa(contract, actor);
        if (needsBaixa) {
            res.status(403).json(needsBaixa);
            return;
        }

        // Void still-pending installments FIRST (idempotent), so they stop being open invoices /
        // auto-charged / reconcilable, and cancel any Stripe subscription. Doing this before the
        // status change keeps retries safe: if a later step fails, the contract is still ACTIVE and
        // a retry re-runs the (idempotent) void — never a "CANCELLED contract with PENDING parcelas".
        // E13: antes de anular, a cobrança viva de cada parcela é aposentada no provedor (PIX já pago → PAID).
        // A multa de cancelamento (de um cancelamento anterior, contrato reaberto) nunca é anulada aqui.
        const { voidContractPendingPaymentsDetailed } = await import('../../lib/paymentEffects.js');
        const voidResult = await voidContractPendingPaymentsDetailed(id);
        const voidedCount = voidResult.voided;

        // Cancel contract
        await prisma.contract.update({
            where: { id },
            data: { status: 'CANCELLED' },
        });
        await markContractCancelled(id, req.user!.userId, { via: 'ADMIN_DELETE', from: fresh.status, voidedCount });

        // Cancel the recordings that have NOT happened yet (E13): RESERVED/CONFIRMED/HELD com início futuro
        // no relógio de SP — inclui a de hoje que ainda não começou (B6); a sessão de hoje já feita
        // (COMPLETED/FALTA/NAO_REALIZADO) ou em andamento fica como está.
        const cancelledBookings = await prisma.booking.updateMany({
            where: upcomingContractBookingsWhere(id),
            data: { status: 'CANCELLED' },
        });

        // O cliente é avisado (persistida + push) — sem multa neste caminho.
        await notifyClientContractCancelled(contract, null);

        res.json({
            message: adminCancelMessage(voidResult),
            voidedCount,
            cancelledBookings: cancelledBookings.count,
            paidAtProvider: voidResult.paidAtProvider.length,
            liveAtProvider: voidResult.liveAtProvider.length,
        });
    } finally {
        if (cancelLock) await releaseMutex(cancelLock).catch(() => {});
    }
});

// ─── POST /api/contracts/:id/request-cancellation (CLIENT)
router.post('/:id/request-cancellation', authenticate, async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const userId = req.user!.userId;

    const contract = await prisma.contract.findFirst({
        where: { id, userId },
        include: { user: { select: { name: true } } },
    });

    if (!contract) {
        res.status(404).json({ error: 'Contrato não encontrado.' });
        return;
    }

    if (contract.status !== 'ACTIVE') {
        res.status(400).json({ error: 'Apenas contratos ativos podem solicitar cancelamento.' });
        return;
    }

    // E13: o pedido e a multa CONGELADA nascem juntos (mesma transação). Base = o que falta pagar do
    // plano AGORA (parcelas não pagas, sem extras de gravação) × cancellation_fine_pct vigente. Mudar o %
    // depois do pedido não altera a multa, e a base nunca aumenta; uma parcela da base paga durante a
    // análise SAI dela (base efetiva = mínimo entre a congelada e o que ainda falta — ver a decisão).
    // Claim atômico (só um pedido vence dois cliques simultâneos).
    const snapshot = await prisma.$transaction(async (tx) => {
        const claim = await tx.contract.updateMany({
            where: { id, userId, status: 'ACTIVE' },
            data: { status: 'PENDING_CANCELLATION' },
        });
        if (claim.count === 0) return null;
        return freezeCancellationFine(tx, id, userId);
    });
    if (!snapshot) {
        res.status(400).json({ error: 'Apenas contratos ativos podem solicitar cancelamento.' });
        return;
    }
    const updated = await prisma.contract.findUniqueOrThrow({ where: { id } });

    // Só as gravações que ainda NÃO aconteceram (início futuro no relógio de SP): a sessão de hoje já
    // feita (COMPLETED/FALTA/NAO_REALIZADO) ou em andamento não é cancelada. Os ids são lidos ANTES, para
    // saber depois quais gravações ESTE pedido cancelou.
    const upcomingIds = (await prisma.booking.findMany({
        where: upcomingContractBookingsWhere(id),
        select: { id: true },
    })).map(b => b.id);
    const cancelledBookings = await prisma.booking.updateMany({
        where: upcomingContractBookingsWhere(id),
        data: { status: 'CANCELLED' },
    });

    // A gravação que o próprio pedido cancelou não vai acontecer: a cobrança em aberto dos EXTRAS dela
    // (bookingId) deixa de ser pagável já — antes ela seguia com "Pagar" e avisando como vencida durante a
    // análise. Mesma sequência da anulação: a cobrança viva é aposentada no provedor antes (PIX/cartão já
    // pago → fica PAID, não é anulado). Extras de gravações já REALIZADAS continuam pagáveis e as parcelas
    // do plano ficam como estão (suspensas para o cliente até a decisão). Best-effort: uma falha aqui não
    // desfaz o pedido — a decisão do estúdio anula o que sobrar.
    let voidedExtras = 0;
    if (upcomingIds.length > 0) {
        try {
            const cancelledIds = (await prisma.booking.findMany({
                where: { id: { in: upcomingIds }, status: 'CANCELLED' },
                select: { id: true },
            })).map(b => b.id);
            if (cancelledIds.length > 0) {
                const { voidContractPendingPaymentsDetailed } = await import('../../lib/paymentEffects.js');
                voidedExtras = (await voidContractPendingPaymentsDetailed(id, { bookingIds: cancelledIds })).voided;
            }
        } catch (err) {
            console.error(`[cancellation] Falha ao anular os extras das gravações canceladas pelo pedido (contrato ${id}):`, err);
        }
    }

    // Admin avisado na hora (persistida + push); no sino, o alerta computado "Cancelamento pendente"
    // continua sendo a única linha enquanto o pedido está em análise.
    await notifyAdminsCancellationRequested(updated, contract.user?.name ?? 'Cliente', snapshot);

    // Multa zero tem dois motivos diferentes — a mensagem diz o verdadeiro: nada em aberto (base 0) ou
    // percentual de multa zerado (há parcelas em aberto, mas o cancelamento não tem multa).
    let fineNote: string;
    if (snapshot.fineAmount > 0) {
        fineNote = ` Multa prevista: ${formatBRL(snapshot.fineAmount)} (${snapshot.finePct}% de ${formatBRL(snapshot.baseAmount)} que faltam pagar) — o estúdio decide entre cobrar ou isentar.`;
    } else if (snapshot.baseAmount > 0) {
        fineNote = ' O cancelamento não tem multa.';
    } else {
        fineNote = ' Não há parcelas do plano em aberto: o cancelamento não tem multa.';
    }
    const extrasNote = voidedExtras > 0
        ? ` ${plural(voidedExtras, 'cobrança de serviços extras dessas gravações foi cancelada', 'cobranças de serviços extras dessas gravações foram canceladas')}.`
        : '';
    res.json({
        contract: {
            ...updated,
            cancellationRequestedAt: snapshot.requestedAt.toISOString(),
            finePct: snapshot.finePct,
            fineBaseAmount: snapshot.baseAmount,
            fineAmountPreview: snapshot.fineAmount,
        },
        cancelledBookings: cancelledBookings.count,
        voidedExtras,
        fine: { finePct: snapshot.finePct, baseAmount: snapshot.baseAmount, amount: snapshot.fineAmount },
        message: `Solicitação de cancelamento enviada. ${cancelledBookings.count} agendamentos futuros foram liberados.${extrasNote}${fineNote}`
    });
});

// ─── POST /api/contracts/:id/resolve-cancellation (equipe — contratos.multa)
router.post('/:id/resolve-cancellation', authenticate, requirePermission('contratos.multa'), async (req: Request, res: Response) => {
    let cancelLock: string | null = null;
    try {
        const id = req.params.id as string;
        const data = resolveCancellationSchema.parse(req.body);

        const contract = await prisma.contract.findUnique({ where: { id } });

        if (!contract) {
            res.status(404).json({ error: 'Contrato não encontrado.' });
            return;
        }

        // Pedido que não está (mais) em análise — lista defasada, outro admin, duplo clique: 409 com código
        // (o front recarrega a lista e fecha o diálogo), nunca um 400 preso no diálogo.
        if (contract.status !== 'PENDING_CANCELLATION') {
            res.status(409).json(cancellationNotPendingBody(contract.status));
            return;
        }

        // Exclusividade ANTES de qualquer efeito: a decisão é serializada por contrato e o status é RELIDO
        // com a trava. Quem chega depois recebe 409 sem anular nada nem tocar no provedor — antes, a segunda
        // requisição passava junto pela checagem acima e anulava a multa que a primeira acabara de criar.
        cancelLock = await acquireContractCancelLock(id);
        if (cancelLock === null) {
            res.status(409).json(CANCELLATION_IN_PROGRESS_BODY);
            return;
        }
        const fresh = await prisma.contract.findUnique({ where: { id }, select: { status: true } });
        if (fresh?.status !== 'PENDING_CANCELLATION') {
            res.status(409).json(cancellationNotPendingBody(fresh?.status));
            return;
        }
        // ATU6-02/AUDFIN6-01: decidir o pedido (cobrar ou isentar a multa) cancela o contrato e anula o que ele tem em
        // aberto — a cobrança de sessão (o avulso inteiro; nos outros tipos, a cobrança própria de uma gravação já feita
        // ou em andamento, que o pedido não cancelou) só com a baixa. 403 antes de qualquer escrita (a base da multa de um
        // pedido antigo é gravada logo abaixo); o contrato continua em análise.
        const actor = await routeActor(req, res);
        if (!actor) return;
        const needsBaixa = await contractCancelNeedsBaixa(contract, actor);
        if (needsBaixa) {
            res.status(403).json(needsBaixa);
            return;
        }

        // E13 — base da multa = o que FALTAVA pagar do plano no PEDIDO (congelada em request-cancellation;
        // parcelas não pagas, sem extras de gravação). Lida ANTES de anular as parcelas: num pedido
        // anterior a esta regra (sem a marca) ela é calculada agora e gravada, para uma nova tentativa
        // chegar ao mesmo valor. À vista quitado / nada a pagar → base 0 → sem multa.
        const frozenBasis = await resolveCancellationBasis(id, req.user!.userId);
        // Marca antiga (sem a lista de parcelas): guarda quais estavam em aberto ANTES de anular.
        const openBeforeVoid = frozenBasis.installments
            ? undefined
            : new Set((await loadFineBasisPayments(id)).filter(isUnpaidPlanInstallment).map(p => p.id));

        // Void the unpaid installments BEFORE the fine is created (the fine, created below, must stay
        // PENDING). A cobrança viva de cada parcela é aposentada no provedor antes (PIX já pago → PAID);
        // também cancela a assinatura Stripe vinculada. A anulação nunca toca numa multa de cancelamento.
        const { voidContractPendingPaymentsDetailed } = await import('../../lib/paymentEffects.js');
        const voidResult = await voidContractPendingPaymentsDetailed(id);
        const voidedCount = voidResult.voided;

        // Base EFETIVA = mínimo entre a congelada no pedido e o que ainda falta pagar: congelar impede a
        // base de AUMENTAR, nunca cobra multa sobre parcela já quitada. Uma parcela que compunha a base e
        // foi paga durante a análise (QR PIX / PaymentIntent emitido antes do pedido, cobrança do admin,
        // ou confirmada no provedor agora, ao anular) sai dela — por isso a leitura é DEPOIS de anular.
        // Base efetiva 0 → sem multa (mesmo caminho do à vista quitado). O % continua o do pedido.
        const paymentsAfterVoid = await loadFineBasisPayments(id);
        const basis = effectiveCancellationBasis(frozenBasis, paymentsAfterVoid, openBeforeVoid);
        const fineAmount = data.action === 'CHARGE_FEE' ? basis.fineAmount : 0;

        // Contrato reaberto pelo admin e cancelado de novo: a multa em aberto (PENDING/FAILED) de um
        // cancelamento ANTERIOR não pode conviver com a nova — nunca duas multas em aberto. Quem decide
        // (com a trava) aposenta a cobrança viva dela no provedor e a anula ANTES de criar a nova; se o
        // provedor disser que ela já foi paga, fica PAID. Sem multa nova, a anterior continua devida.
        // SÓ multas criadas ANTES deste pedido: uma multa posterior ao pedido é de uma decisão concorrente
        // do MESMO pedido (a trava não serializou — Redis fora do ar ou trava expirada) e nunca pode ser
        // anulada por quem ainda vai disputar o claim. A anulação fica restrita a esses ids.
        const openFineCandidates = paymentsAfterVoid.filter(p => isCancellationFine(p) && (p.status === 'PENDING' || p.status === 'FAILED'));
        const priorFineIds = openFineCandidates.length === 0 ? new Set<string>() : new Set((await prisma.payment.findMany({
            where: { id: { in: openFineCandidates.map(p => p.id) }, createdAt: { lt: frozenBasis.requestedAt } },
            select: { id: true },
        })).map(p => p.id));
        const priorOpenFines = openFineCandidates.filter(p => priorFineIds.has(p.id));
        let replacedFines = 0;
        if (fineAmount > 0 && priorOpenFines.length > 0) {
            const prior = await voidContractPendingPaymentsDetailed(id, { onlyFines: true, paymentIds: priorOpenFines.map(p => p.id) });
            replacedFines = prior.voided;
            voidResult.paidAtProvider.push(...prior.paidAtProvider);
            voidResult.liveAtProvider.push(...prior.liveAtProvider);
        }

        // Decisão ATÔMICA: o contrato sai de PENDING_CANCELLATION uma única vez (dois admins / duplo
        // clique não geram duas multas) e a multa nasce na mesma transação. A multa é uma cobrança
        // identificada (metadata.kind), PENDENTE: o cliente paga em Meus Pagamentos ou o admin cobra
        // agora; o auto-charge nunca a cobra (contrato CANCELLED).
        const decided = await prisma.$transaction(async (tx) => {
            const claim = await tx.contract.updateMany({
                where: { id, status: 'PENDING_CANCELLATION' },
                data: { status: 'CANCELLED' },
            });
            if (claim.count === 0) return null;
            const fine = fineAmount > 0
                ? await tx.payment.create({
                    data: {
                        userId: contract.userId,
                        contractId: id,
                        provider: getProviderForMethod(contract.paymentMethod || 'CARTAO'),
                        amount: fineAmount,
                        status: 'PENDING',
                        dueDate: new Date(),
                        metadata: { kind: CANCELLATION_FINE_KIND, finePct: basis.finePct, baseAmount: basis.baseAmount },
                    },
                })
                : null;
            await tx.auditLog.create({
                data: {
                    entityType: 'CONTRACT', entityId: id, action: AUDIT_CONTRACT_CANCELLED, performedBy: req.user!.userId,
                    changes: JSON.stringify({
                        via: 'RESOLVE_CANCELLATION', action: data.action, finePct: basis.finePct, baseAmount: basis.baseAmount,
                        frozenBaseAmount: basis.frozenBaseAmount,
                        fineAmount, finePaymentId: fine?.id ?? null, voidedCount,
                        ...(replacedFines > 0 ? { replacedFines } : {}),
                    }),
                },
            });
            return { fine };
        });
        if (!decided) {
            // Só chega aqui se o status mudou por fora da trava (ex.: contrato reaberto por um PATCH).
            const now = await prisma.contract.findUnique({ where: { id }, select: { status: true } });
            res.status(409).json(cancellationNotPendingBody(now?.status ?? 'CANCELLED'));
            return;
        }
        const fine = decided.fine;
        const updated = await prisma.contract.findUniqueOrThrow({ where: { id } });

        // Cliente avisado na decisão (persistida + push): multa gerada (valor) ou cancelamento sem multa.
        await notifyClientContractCancelled(
            updated,
            fine ? { id: fine.id, amount: fine.amount, finePct: basis.finePct, baseAmount: basis.baseAmount } : null,
        );

        let message: string;
        if (data.action === 'CHARGE_FEE') {
            if (fine) {
                message = `Contrato cancelado com multa de ${basis.finePct}% (${formatBRL(fine.amount)}) sobre ${formatBRL(basis.baseAmount)} que faltavam pagar. A multa fica pendente: o cliente foi avisado e paga em Meus Pagamentos, ou você cobra agora pelo painel (ela não é cobrada automaticamente).`;
            } else if (basis.baseAmount > 0) {
                // Há parcelas em aberto, mas a multa do pedido é zero (percentual configurado em 0%).
                message = `Contrato cancelado. Nenhuma multa aplicada: o cancelamento não tem multa (percentual de ${basis.finePct}% neste pedido).`;
            } else {
                message = 'Contrato cancelado. Nenhuma multa aplicada: não há parcelas do plano em aberto.';
            }
        } else {
            message = 'Cancelamento isento efetuado pelo estúdio. Contrato cancelado e cliente avisado.';
        }
        if (voidedCount > 0) {
            message += ` ${voidedCount} parcela(s) pendente(s) foram canceladas.`;
        }
        if (replacedFines > 0) {
            message += ' A multa em aberto de um cancelamento anterior deste contrato foi anulada e substituída por esta.';
        } else if (!fine && priorOpenFines.length > 0) {
            message += ` Atenção: a multa de um cancelamento anterior deste contrato (${formatBRL(priorOpenFines.reduce((s, p) => s + p.amount, 0))}) continua pendente.`;
        }
        message += providerSettlementNote(voidResult);

        res.json({
            contract: updated,
            message,
            fine: fine
                ? { id: fine.id, amount: fine.amount, status: fine.status, dueDate: fine.dueDate, finePct: basis.finePct, baseAmount: basis.baseAmount }
                : null,
            voidedCount,
            paidAtProvider: voidResult.paidAtProvider.length,
            liveAtProvider: voidResult.liveAtProvider.length,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    } finally {
        if (cancelLock) await releaseMutex(cancelLock).catch(() => {});
    }
});

// ─── POST /api/contracts/:id/renew (equipe — contratos.criar E cobrancas.baixa) ─────────────────────────
// A renovação cria o contrato novo ATIVO com as sessões (FIXO) ou os créditos (FLEX) e NENHUMA parcela:
// na prática, um plano entregue sem cobrança. Pelo DECISOES D3/resposta 2 ("nada criado sem a baixa nasce
// pago"), além de "Criar e renovar contratos" ela exige "Marcar como pago, anular ou estornar" — como a
// parcela de valor zero no POST /contracts. O ADMIN passa sempre (comportamento dele não muda). Gerar as
// parcelas PENDING na renovação (e voltar a bastar contratos.criar) depende de decisão do dono.
router.post('/:id/renew', authenticate, requireAllPermissions('contratos.criar', 'cobrancas.baixa'), async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        // Corpo validado ANTES de qualquer leitura: duração 3 ou 6, tipo FIXO/FLEX, faixa do enum.
        const { durationMonths, tier, type, startDate: startStr } = renewContractSchema.parse(req.body ?? {});

        const original = await prisma.contract.findUnique({ where: { id }, include: { user: { select: { deletedAt: true } } } });
        if (!original) { res.status(404).json({ error: 'Contrato não encontrado.' }); return; }
        // D3: cliente excluído (soft delete / anonimizado) não ganha contrato nem gravações novas.
        if (original.user?.deletedAt) {
            res.status(409).json({ error: `${DELETED_CLIENT_ERROR} Não é possível renovar o contrato.`, code: 'CLIENT_DELETED' });
            return;
        }
        // D6: um plano "Concluído" (todas as sessões feitas antes do fim da vigência) continua renovável;
        // o avulso concluído não (é sessão única).
        const renewable = ['ACTIVE', 'EXPIRED'].includes(original.status)
            || (original.status === 'COMPLETED' && original.type !== 'AVULSO');
        if (!renewable) { res.status(400).json({ error: 'Só é possível renovar contratos ativos, concluídos ou expirados.' }); return; }
        // E4: avulso (sessão única) e serviço (contratação própria, com outra lógica de cobrança) não têm
        // renovação por este caminho — o botão nem aparece; a rota recusa por garantia.
        if (original.type === 'AVULSO' || original.type === 'SERVICO') {
            res.status(400).json({ error: 'Este tipo de contrato não é renovável por aqui. Faça uma nova contratação.' });
            return;
        }

        // Renovação 1× por contrato (mesma regra do client-renew; admin não tem a janela de 7 dias).
        const existingRenewal = await prisma.contract.findFirst({
            where: { renewedFromId: id, status: { notIn: ['CANCELLED'] } },
            select: { id: true },
        });
        if (existingRenewal) {
            res.status(400).json({ error: 'Este contrato já foi renovado. A renovação só pode acontecer uma única vez.' });
            return;
        }

        const newTier = tier || original.tier;
        const newType = type || original.type;
        const discount3 = await getConfig('discount_3months');
        const discount6 = await getConfig('discount_6months');
        const discountPct = durationMonths === 6 ? discount6 : discount3;

        if (startStr !== undefined && startStr !== null && startStr !== ''
            && (typeof startStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startStr) || Number.isNaN(new Date(startStr + 'T00:00:00Z').getTime()))) {
            res.status(400).json({ error: 'Data de início inválida (use AAAA-MM-DD).' });
            return;
        }
        const start = startStr ? new Date(startStr + 'T00:00:00') : new Date(original.endDate);
        if (start <= new Date(original.startDate)) start.setTime(new Date(original.endDate).getTime());
        // Datas sem hora: aritmética em UTC (independe do fuso do processo; em SP, setMonth local
        // sobre a meia-noite UTC — 21:00 do dia anterior — errava o dia na virada de mês).
        const end = new Date(start);
        end.setUTCMonth(end.getUTCMonth() + durationMonths);

        // FIX (C7): créditos FLEX da config episodes_Nmonths (igual à criação), não durationMonths*4.
        const flexCreditsTotal = newType === 'FLEX'
            ? await getConfig(durationMonths === 6 ? 'episodes_6months' : 'episodes_3months')
            : undefined;

        const renewed = await prisma.contract.create({
            data: {
                name: original.name,
                userId: original.userId,
                type: newType,
                tier: newTier,
                durationMonths,
                discountPct,
                startDate: start,
                endDate: end,
                fixedDayOfWeek: newType === 'FIXO' ? original.fixedDayOfWeek : null,
                fixedTime: newType === 'FIXO' ? original.fixedTime : null,
                contractUrl: original.contractUrl,
                addOns: original.addOns,
                paymentMethod: original.paymentMethod,
                flexCreditsTotal: flexCreditsTotal ?? null,
                flexCreditsRemaining: flexCreditsTotal ?? null,
                flexCycleStart: null, // FLEX clock starts on the 1st recording
                flexForfeitFloor: newType === 'FLEX' ? 0 : null, // not grandfathered
                renewedFromId: original.id,
            },
        });

        // Generate bookings for FIXO
        let renewNote = '';
        if (newType === 'FIXO' && original.fixedDayOfWeek && original.fixedTime) {
            // A6: limitar por totalWeeks = durationMonths × sessions_per_month (o teto que todo outro
            // caminho FIXO aplica). Sem isso o laço por span de calendário (mês ≈ 4,33 semanas)
            // sobre-entrega ~1 sessão em 3m / ~2 em 6m.
            // Anti-overbooking (antes gravava por cima): data ocupada é pulada; a folga do período
            // (mês ≈ 4,33 semanas) repõe a sessão numa semana seguinte, sem passar do teto nem do fim.
            const sessionsPerMonth = await getConfig('sessions_per_month');
            const maxBookings = durationMonths * sessionsPerMonth;
            const price = applyDiscount(await getBasePriceDynamic(newTier as any), discountPct);
            const { created, skipped } = await generateFixoSessions({
                lockOwner: `renew:${renewed.id}`,
                userId: original.userId,
                contractId: renewed.id,
                tier: newTier,
                fixedDayOfWeek: original.fixedDayOfWeek,
                fixedTime: original.fixedTime,
                // start/end são datas SEM hora → dia pelo ISO (não saoPauloParts: dava o dia anterior).
                fromStr: dateOnlyYmd(start),
                untilStr: dateOnlyYmd(end),
                cap: maxBookings,
                price,
                status: 'CONFIRMED' as BookingStatus,
            });
            renewNote = skippedNote(skipped, original.fixedTime, maxBookings - created);
        }

        // Audit
        const { logAudit } = await import('../../lib/audit.js');
        await logAudit('CONTRACT', renewed.id, 'RENEWED', req.user!.userId, { fromContractId: original.id, durationMonths, tier: newTier, type: newType });

        res.status(201).json({ contract: renewed, message: `Contrato renovado com sucesso!${renewNote}` });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        console.error('[renew]', err);
        res.status(500).json({ error: err.message || 'Erro ao renovar contrato.' });
    }
});

// ─── PATCH /api/contracts/:id/pause (equipe — contratos.editar: "Editar, pausar e retomar") ─────────────
router.patch('/:id/pause', authenticate, requirePermission('contratos.editar'), async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const { reason, resumeDate } = req.body;

        const contract = await prisma.contract.findUnique({ where: { id } });
        if (!contract) { res.status(404).json({ error: 'Contrato não encontrado.' }); return; }
        if (contract.status !== 'ACTIVE') { res.status(400).json({ error: 'Só é possível pausar contratos ativos.' }); return; }

        const now = new Date();
        let resume: Date | null = null;
        if (resumeDate) {
            resume = new Date(resumeDate + 'T00:00:00');
            const diffDays = Math.floor((resume.getTime() - now.getTime()) / 86400000);
            if (diffDays > 30) { res.status(400).json({ error: 'Pausa máxima de 30 dias.' }); return; }
        }

        // FIX (C4): cancelar bookings futuros SÓ para FIXO (que o /resume regenera). Antes,
        // pausar CUSTOM cancelava as sessões pré-geradas e o resume (só FIXO) não recriava nada
        // → o cliente perdia as gravações pagas. Para CUSTOM/FLEX preservamos as sessões agendadas
        // (e nenhum crédito é perdido). A extensão do endDate na retomada continua valendo p/ todos.
        // AUDFIN-03 (conserto 5):
        //  • a sessão EXTRA (marca fixoExtra — cobrada à parte, criada com o teto cheio) NÃO é cancelada: ela não é do
        //    plano e a retomada não a recria (paga, sumiria sem estorno). Sessão viva de contrato pausado já é estado
        //    suportado (FLEX/CUSTOM mantêm as deles);
        //  • cancelar uma gravação com cobrança em aberto (extra contratado nela) a anula — sem cobrancas.baixa, 403
        //    antes de qualquer escrita; com a baixa (e o ADMIN), as cobranças em aberto das gravações canceladas são
        //    anuladas (aposentadas no provedor antes), como no pedido de cancelamento — nada fica preso e impagável.
        let pauseCancelledIds: string[] = [];
        let pauseWithBaixa = false;
        if (contract.type === 'FIXO') {
            const actor = await routeActor(req, res);
            if (!actor) return;
            pauseWithBaixa = can(actor, 'cobrancas.baixa');
            const toCancelWhere: Prisma.BookingWhereInput = {
                contractId: id, status: { in: ['RESERVED', 'CONFIRMED'] }, date: { gte: now },
                payments: { none: FIXO_EXTRA_MARK_WHERE },
            };
            const toCancel = (await prisma.booking.findMany({ where: toCancelWhere, select: { id: true } })).map(b => b.id);
            if (!pauseWithBaixa && toCancel.length > 0
                && (await prisma.payment.count({ where: { bookingId: { in: toCancel }, status: { in: OPEN_CHARGE_STATUSES } } })) > 0) {
                res.status(403).json(PAUSE_OPEN_CHARGE_NEEDS_BAIXA);
                return;
            }
            if (toCancel.length > 0) {
                // Sem a baixa: só as que continuam sem cobrança em aberto (uma criada no meio não é anulada por quem
                // não pode — a gravação fica viva no contrato pausado).
                await prisma.booking.updateMany({
                    where: { ...toCancelWhere, id: { in: toCancel }, ...(pauseWithBaixa ? {} : NO_OPEN_CHARGE_BOOKING_WHERE) },
                    data: { status: 'CANCELLED' },
                });
                pauseCancelledIds = (await prisma.booking.findMany({
                    where: { id: { in: toCancel }, status: 'CANCELLED' },
                    select: { id: true },
                })).map(b => b.id);
            }
        }

        const updated = await prisma.contract.update({
            where: { id },
            data: { status: 'PAUSED', pausedAt: now, pauseReason: reason || null, resumeDate: resume },
        });

        // AUDFIN-03: com a baixa, a cobrança em aberto das gravações que a pausa cancelou deixa de ser devida (best-effort).
        let pauseVoided = 0;
        if (pauseWithBaixa && pauseCancelledIds.length > 0) {
            try {
                const { voidContractPendingPaymentsDetailed } = await import('../../lib/paymentEffects.js');
                pauseVoided = (await voidContractPendingPaymentsDetailed(id, { bookingIds: pauseCancelledIds })).voided;
            } catch (err) {
                console.error(`[pause] Falha ao anular as cobranças das gravações canceladas pela pausa (contrato ${id}):`, err);
            }
        }

        const { logAudit } = await import('../../lib/audit.js');
        await logAudit('CONTRACT', id, 'PAUSED', req.user!.userId, { reason, resumeDate });

        const pauseNote = pauseVoided > 0
            ? ` ${plural(pauseVoided, 'cobrança em aberto das gravações canceladas foi anulada', 'cobranças em aberto das gravações canceladas foram anuladas')}.`
            : '';
        res.json({ contract: updated, message: `Contrato pausado.${pauseNote}`, ...(pauseVoided > 0 && { voidedCount: pauseVoided }) });
    } catch (err: any) {
        console.error('[pause]', err);
        res.status(500).json({ error: err.message || 'Erro ao pausar contrato.' });
    }
});

// ─── PATCH /api/contracts/:id/resume (equipe — contratos.editar) ────────────
router.patch('/:id/resume', authenticate, requirePermission('contratos.editar'), async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;

        const contract = await prisma.contract.findUnique({ where: { id }, include: { user: { select: { deletedAt: true } } } });
        if (!contract) { res.status(404).json({ error: 'Contrato não encontrado.' }); return; }
        if (contract.status !== 'PAUSED') { res.status(400).json({ error: 'Contrato não está pausado.' }); return; }
        // D3: retomar recria gravações — nunca para cliente excluído (o soft delete já cancela os pausados).
        if (contract.user?.deletedAt) {
            res.status(409).json({ error: `${DELETED_CLIENT_ERROR} Não é possível retomar o contrato.`, code: 'CLIENT_DELETED' });
            return;
        }

        const now = new Date();
        const pausedAt = contract.pausedAt || now;
        const daysPaused = Math.floor((now.getTime() - new Date(pausedAt).getTime()) / 86400000);

        // Extend endDate by days paused
        const newEndDate = new Date(contract.endDate);
        newEndDate.setUTCDate(newEndDate.getUTCDate() + daysPaused); // data sem hora: soma em UTC

        // A3: FLEX — congelar o relógio de forfeiture durante a pausa deslocando flexCycleStart
        // pelos mesmos dias de pausa. Sem isso, computeFlexState mede semanas por wall-clock e o
        // flexCreditExpiryJob confisca créditos pré-pagos das semanas em que o contrato ficou pausado.
        let newFlexCycleStart: Date | null = contract.flexCycleStart;
        if (contract.type === 'FLEX' && contract.flexCycleStart) {
            newFlexCycleStart = new Date(contract.flexCycleStart);
            newFlexCycleStart.setDate(newFlexCycleStart.getDate() + daysPaused);
        }

        const updated = await prisma.contract.update({
            where: { id },
            data: {
                status: 'ACTIVE', endDate: newEndDate, pausedAt: null, pauseReason: null, resumeDate: null,
                ...(contract.type === 'FLEX' && contract.flexCycleStart ? { flexCycleStart: newFlexCycleStart } : {}),
            },
        });

        // Re-generate future bookings for FIXO
        let resumeNote = '';
        if (contract.type === 'FIXO' && contract.fixedDayOfWeek && contract.fixedTime) {
            // B4 (gêmeo de A6): limitar por durationMonths × sessions_per_month, DESCONTANDO as sessões
            // já entregues antes da pausa. Sem o teto, o laço por span de calendário (mês ≈ 4,33 semanas)
            // regenerava sessões que o cap da criação excluíra → sobre-entrega de gravações pagas.
            // Anti-overbooking: o que foi agendado por outros durante a pausa é respeitado (data pulada).
            const sessionsPerMonth = await getConfig('sessions_per_month');
            const maxBookings = contract.durationMonths * sessionsPerMonth;
            const alreadyDelivered = await prisma.booking.count({
                where: { contractId: id, status: { not: 'CANCELLED' }, date: { lt: now } },
            });
            const remainingCap = Math.max(0, maxBookings - alreadyDelivered);
            const price = applyDiscount(await getBasePriceDynamic(contract.tier as any), contract.discountPct);
            const { created, skipped } = await generateFixoSessions({
                lockOwner: `resume:${id}`,
                userId: contract.userId,
                contractId: id,
                tier: contract.tier,
                fixedDayOfWeek: contract.fixedDayOfWeek,
                fixedTime: contract.fixedTime,
                fromStr: saoPauloParts(now).dateStr, // `now` é um INSTANTE → dia de hoje em SP
                untilStr: dateOnlyYmd(newEndDate),   // data sem hora → dia pelo ISO
                cap: remainingCap,
                price,
                status: 'RESERVED' as BookingStatus,
                skipPastToday: true,
            });
            resumeNote = skippedNote(skipped, contract.fixedTime, remainingCap - created);
        }

        const { logAudit } = await import('../../lib/audit.js');
        await logAudit('CONTRACT', id, 'RESUMED', req.user!.userId, { daysPaused, newEndDate: newEndDate.toISOString() });

        res.json({ contract: updated, message: `Contrato retomado. Vigência estendida em ${daysPaused} dias.${resumeNote}` });
    } catch (err: any) {
        console.error('[resume]', err);
        res.status(500).json({ error: err.message || 'Erro ao retomar contrato.' });
    }
});

} // end registerLifecycleRoutes
