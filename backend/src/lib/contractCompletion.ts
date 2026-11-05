// ─── Conclusão automática de contratos (D6) ─────────────────────────────────
// O contrato vira COMPLETED ("Concluído") quando não resta NADA a fazer nele, e volta para ACTIVE
// sozinho quando isso deixa de valer (reabriu/reverteu uma gravação, devolveu crédito, etc.).
// Chamado depois de TODA transição de status de booking (complete, cancelamentos, PATCH admin,
// remarcação de falta, job de expiração da janela). Nunca derruba a requisição que o chamou.
//
// Só mexe em ACTIVE ↔ COMPLETED. PAUSED, PENDING_CANCELLATION, CANCELLED, AWAITING_PAYMENT e
// EXPIRED são decisões de outro fluxo (admin/pagamento) e ficam intocados. SERVICO não entra.

import { prisma } from './prisma.js';
import { getConfig } from './businessConfig.js';
import { logAudit } from './audit.js';
import { occupiesFixoCap, FIXO_EXTRA_MARK_WHERE } from '../modules/bookings/sessionPayment.js';

/** Sessões ainda por acontecer (ocupam agenda / aguardam gravação). */
const PENDING_STATUSES = ['HELD', 'RESERVED', 'CONFIRMED'];
/** Status do contrato que este sync pode alternar. */
const SYNCABLE_STATUSES = ['ACTIVE', 'COMPLETED'];

export interface CompletionBooking {
    status: string;
    makeupStatus?: string | null;
    /** Sessão EXTRA do FIXO (Payment com a marca fixoExtra — criada com o teto já cheio): não ocupa o teto. */
    fixoExtra?: boolean;
}

export interface CompletionInput {
    type: string;
    durationMonths: number;
    flexCreditsRemaining: number | null;
    customCreditsRemaining: number | null;
    bookings: CompletionBooking[];
}

/**
 * Regra PURA (testável) de "não resta nada a fazer" no contrato.
 * - AVULSO: a sessão foi gravada (COMPLETED) ou perdida (FALTA sem janela de remarcação aberta —
 *   sem justificativa, prazo EXPIRED ou 2ª falta após remarcar). NÃO conclui com janela OPEN nem em
 *   NAO_REALIZADO (D5: culpa do estúdio — o valor continua garantido e o admin resolve).
 * - FIXO/FLEX/CUSTOM: sem sessão pendente, houve consumo (COMPLETED/FALTA) e não resta crédito/sessão:
 *   FLEX → flexCreditsRemaining; CUSTOM → customCreditsRemaining; FIXO → teto (meses × sessões/mês)
 *   menos as sessões que OCUPAM o teto (occupiesFixoCap — a mesma regra de booking.service.fixoCapReached:
 *   a sessão EXTRA, criada com o teto já cheio, não conta, então ela não conclui o plano antes da hora; a
 *   sessão cobrada por quem tem a baixa DENTRO do teto conta — ATU5-02).
 * - SERVICO (e qualquer outro tipo): nunca.
 */
export function isContractFulfilled(c: CompletionInput, sessionsPerMonth: number): boolean {
    const live = c.bookings.filter(b => b.status !== 'CANCELLED');
    if (live.some(b => PENDING_STATUSES.includes(b.status))) return false;
    // Janela de remarcação aberta = ainda há uma gravação a fazer (vale para qualquer tipo).
    if (live.some(b => b.makeupStatus === 'OPEN' && (b.status === 'FALTA' || b.status === 'NAO_REALIZADO'))) return false;

    if (c.type === 'AVULSO') {
        if (live.some(b => b.status === 'NAO_REALIZADO')) return false;
        return live.some(b => b.status === 'COMPLETED' || b.status === 'FALTA');
    }

    if (c.type !== 'FIXO' && c.type !== 'FLEX' && c.type !== 'CUSTOM') return false;

    const consumed = live.filter(b => b.status === 'COMPLETED' || b.status === 'FALTA').length;
    if (consumed === 0) return false;

    let remaining: number;
    if (c.type === 'FLEX') {
        remaining = c.flexCreditsRemaining ?? 0;
    } else if (c.type === 'CUSTOM') {
        remaining = c.customCreditsRemaining ?? 0;
    } else {
        const used = live.filter(occupiesFixoCap).length;
        remaining = Math.max(0, c.durationMonths * sessionsPerMonth - used);
    }
    return remaining <= 0;
}

export type CompletionChange = 'COMPLETED' | 'REOPENED';

/**
 * Sincroniza o status do contrato com o estado das suas sessões (idempotente).
 * ACTIVE → COMPLETED quando `isContractFulfilled`; COMPLETED → ACTIVE quando deixa de valer.
 * Serializado por contrato (SELECT … FOR UPDATE) para que duas transições concorrentes não gravem
 * uma decisão baseada em leitura velha; a escrita ainda é guardada pelo status de origem.
 * Erros vão só para o log (retorna null) — nunca derrubam a requisição que chamou.
 */
export async function syncContractCompletion(
    contractId: string | null | undefined,
    performedBy = 'SYSTEM',
): Promise<CompletionChange | null> {
    if (!contractId) return null;
    try {
        const head = await prisma.contract.findUnique({
            where: { id: contractId },
            select: { type: true, status: true },
        });
        if (!head || head.type === 'SERVICO' || !SYNCABLE_STATUSES.includes(head.status)) return null;
        const sessionsPerMonth = head.type === 'FIXO' ? await getConfig('sessions_per_month') : 0;

        const change = await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "contracts" WHERE "id" = ${contractId} FOR UPDATE`;
            const c = await tx.contract.findUnique({
                where: { id: contractId },
                select: {
                    type: true, status: true, durationMonths: true,
                    flexCreditsRemaining: true, customCreditsRemaining: true,
                    bookings: {
                        where: { status: { not: 'CANCELLED' } },
                        select: {
                            status: true, makeupStatus: true,
                            // Sessão EXTRA do FIXO (marca fixoExtra): não ocupa o teto (occupiesFixoCap).
                            payments: { where: FIXO_EXTRA_MARK_WHERE, select: { id: true }, take: 1 },
                        },
                    },
                },
            });
            if (!c || c.type === 'SERVICO') return null;
            const done = isContractFulfilled({
                ...c,
                bookings: c.bookings.map(b => ({ status: b.status, makeupStatus: b.makeupStatus, fixoExtra: b.payments.length > 0 })),
            }, sessionsPerMonth);
            if (done && c.status === 'ACTIVE') {
                const r = await tx.contract.updateMany({ where: { id: contractId, status: 'ACTIVE' }, data: { status: 'COMPLETED' } });
                return r.count > 0 ? ('COMPLETED' as const) : null;
            }
            if (!done && c.status === 'COMPLETED') {
                const r = await tx.contract.updateMany({ where: { id: contractId, status: 'COMPLETED' }, data: { status: 'ACTIVE' } });
                return r.count > 0 ? ('REOPENED' as const) : null;
            }
            return null;
        });

        if (change) {
            await logAudit('CONTRACT', contractId, change, performedBy, { type: head.type, auto: true });
        }
        return change;
    } catch (err) {
        console.error(`[CONTRACT-COMPLETION] Falha ao sincronizar o contrato ${contractId}:`, err);
        return null;
    }
}
