// ─── Payment Confirmation Effects (shared) ──────────────────────────────
// Single source of truth for everything that must happen when a payment
// transitions to PAID. Used by the Stripe webhook, the Cora webhook AND the
// reconciliation paths so the three can never diverge again.
//
// Historical bug this fixes: the Cora/PIX webhook marked the payment PAID but
// (unlike the Stripe webhook) never confirmed the avulso booking nor activated
// the avulso contract, so the cleanup cron deleted the *paid* booking ~10min
// later. Centralizing the effects guarantees parity across providers.

import { prisma } from './prisma.js';
import { notifyEvent } from '../modules/notifications/notificationService.js';
import { fulfillContractFromPayment } from './contractFulfillment.js';
import { confirmCouponRedemption, releaseCouponForPayments } from './couponService.js';
import { isCancellationFine } from './cancellationFine.js';
import { openSessionChargeWhere } from './sessionCharge.js';

/** audit_logs.action (entityType PAYMENT) que marca o aviso "pago depois de cancelado" — 1 aviso por cobrança. */
export const AUDIT_PAID_AFTER_CANCELLED = 'PAID_AFTER_CANCELLED';

/** R$ formatter for notification variables. */
const fmtBRL = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

type PaymentLike = {
    id: string;
    userId: string;
    amount: number;
    bookingId: string | null;
    contractId: string | null;
    paymentUrl?: string | null;
};

/**
 * Activate addon(s) on a booking after the addon payment is confirmed.
 * (Add-on metadata is currently stored as JSON in the legacy `paymentUrl` field.)
 */
export async function activateAddonIfNeeded(paymentId: string): Promise<void> {
    try {
        const payment = await prisma.payment.findUnique({
            where: { id: paymentId },
            select: { bookingId: true, paymentUrl: true },
        });
        if (!payment?.bookingId || !payment.paymentUrl) return;

        const meta = JSON.parse(payment.paymentUrl);
        // Support both single key (legacy) and array of keys
        const keys: string[] = meta.addonKeys || (meta.addonKey ? [meta.addonKey] : []);
        if (keys.length === 0) return;

        const booking = await prisma.booking.findUnique({ where: { id: payment.bookingId } });
        if (!booking) return;

        const toActivate = keys.filter(k => !booking.addOns.includes(k));
        if (toActivate.length > 0) {
            await prisma.booking.update({
                where: { id: payment.bookingId },
                data: { addOns: { push: toActivate } },
            });
            console.log(`[PaymentEffects] Activated addon(s) ${toActivate.join(', ')} on booking ${payment.bookingId}`);
        }
    } catch { /* paymentUrl is not addon metadata, ignore */ }
}

/** Resultado da ativação de um contrato que aguardava pagamento. */
export interface ContractActivation {
    /** Este chamada virou o contrato AWAITING_PAYMENT → ACTIVE. */
    activated: boolean;
    /** Sessões promovidas a CONFIRMED na ativação. */
    promoted: number;
    /** Ativação PROGRESSIVE já liberou o 1º ciclo (o desbloqueio "próximo ciclo" deste mesmo
     *  pagamento deve ser pulado, senão liberaria 2 ciclos com 1 parcela). */
    unlockedCycle: boolean;
}

// ─── Liberação PROGRESSIVE por parcela paga (pagamentos-8/13) ─────
// Regra: a parcela k libera o ciclo k — uma parcela NUNCA libera dois ciclos, seja qual for o caminho
// (ativação pelo webhook, pela varredura, admin que já nasce com o 1º ciclo liberado, renovação) e a
// ordem em que rodam. Em vez de "liberar mais um ciclo a cada chamada", a liberação é derivada do
// ESTADO: sessões liberadas (não RESERVED/HELD) × sessões que as parcelas PAID cobrem, sob trava de
// linha no contrato (SELECT … FOR UPDATE) — idempotente e sem corrida entre webhook e varredura.

const CYCLE_MS = 28 * 24 * 60 * 60 * 1000;

/** Agrupa datas ordenadas em ciclos: cada ciclo começa na 1ª data e cobre 28 dias (mesma regra de sempre). */
function chunkIntoCycles<T extends { date: Date }>(sorted: T[]): T[][] {
    const cycles: T[][] = [];
    let i = 0;
    while (i < sorted.length) {
        const end = sorted[i]!.date.getTime() + CYCLE_MS;
        const cycle: T[] = [];
        while (i < sorted.length && sorted[i]!.date.getTime() < end) cycle.push(sorted[i++]!);
        cycles.push(cycle);
    }
    return cycles;
}

/**
 * Sincroniza a liberação dos ciclos de um contrato PROGRESSIVE com as parcelas PAGAS e devolve
 * quantas sessões foram liberadas agora:
 *  • contrato quitado (todas as parcelas não canceladas/estornadas pagas, e ao menos as que o plano
 *    prevê: FULL 1, mensal durationMonths) → libera tudo o que resta;
 *  • senão, as sessões cobertas = os `pagas` primeiros ciclos (agrupamento de 28 dias sobre todas
 *    as sessões não canceladas); libera o próximo ciclo RESERVED/HELD enquanto as liberadas forem
 *    menos que as cobertas. Nunca trava de volta (ex.: o 1º ciclo do personalizado do ADMIN nasce
 *    liberado antes de qualquer pagamento — D9 — e a 1ª parcela paga NÃO libera o 2º).
 * Sem efeito fora de PROGRESSIVE. Idempotente.
 */
export async function syncProgressiveCycles(contractId: string, opts: { clearHolds?: boolean } = {}): Promise<number> {
    return prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ access_mode: string | null; payment_plan: string | null; duration_months: number | null }[]>`
            SELECT access_mode, payment_plan, duration_months FROM contracts WHERE id = ${contractId} FOR UPDATE`;
        const c = locked[0];
        if (!c || c.access_mode !== 'PROGRESSIVE') return 0;

        // Ativação: ciclos seguintes ficam RESERVED (travados até a parcela), sem o timer de espera —
        // senão a varredura de reservas vencidas os trataria como reserva avulsa abandonada. Dentro da
        // MESMA trava do contrato: toda escrita nas sessões PROGRESSIVE é serializada (sem deadlock
        // entre dois UPDATEs de várias linhas concorrentes — webhook × varredura).
        if (opts.clearHolds) {
            await tx.booking.updateMany({ where: { contractId, status: 'HELD' }, data: { status: 'RESERVED', holdExpiresAt: null } });
            await tx.booking.updateMany({ where: { contractId, status: 'RESERVED', holdExpiresAt: { not: null } }, data: { holdExpiresAt: null } });
        }

        // Só as parcelas do PLANO (sem bookingId): pagar os extras de uma gravação não libera um ciclo.
        const [paid, total] = await Promise.all([
            tx.payment.count({ where: { contractId, bookingId: null, status: 'PAID' } }),
            tx.payment.count({ where: { contractId, bookingId: null, status: { notIn: ['CANCELLED', 'REFUNDED'] } } }),
        ]);
        if (paid === 0) return 0;
        // Quitado = todas as parcelas existentes pagas E ao menos as esperadas pelo plano (FULL: 1;
        // mensal: durationMonths) — uma renovação cujas parcelas 2..N ainda não foram geradas não conta.
        const expected = c.payment_plan === 'FULL' ? 1 : Math.max(1, c.duration_months ?? 1);
        const fullyPaid = paid >= Math.max(total, expected);

        const sessions = await tx.booking.findMany({
            where: { contractId, status: { not: 'CANCELLED' } },
            select: { id: true, date: true, status: true },
            orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
        });
        const isLocked = (st: string) => st === 'RESERVED' || st === 'HELD';
        const lockedSessions = sessions.filter(b => isLocked(b.status));
        if (lockedSessions.length === 0) return 0;

        let toRelease: string[];
        if (fullyPaid) {
            toRelease = lockedSessions.map(b => b.id); // contrato quitado: nada fica travado
        } else {
            const covered = chunkIntoCycles(sessions).slice(0, paid).reduce((n, c) => n + c.length, 0);
            let released = sessions.length - lockedSessions.length;
            toRelease = [];
            let rest = lockedSessions;
            while (released < covered && rest.length > 0) {
                const [next] = chunkIntoCycles(rest);
                toRelease.push(...next!.map(b => b.id));
                released += next!.length;
                rest = rest.slice(next!.length);
            }
        }
        if (toRelease.length === 0) return 0;
        const upd = await tx.booking.updateMany({
            where: { id: { in: toRelease }, status: { in: ['RESERVED', 'HELD'] } },
            data: { status: 'CONFIRMED', holdExpiresAt: null },
        });
        return upd.count;
    });
}

/**
 * D9: ao ativar um contrato que nasceu AWAITING_PAYMENT com sessões já reservadas (personalizado
 * do cliente), promove as sessões RESERVED/HELD a CONFIRMED — accessMode FULL: todas;
 * PROGRESSIVE: só o(s) ciclo(s) coberto(s) pelas parcelas pagas (na ativação: o 1º; as demais seguem
 * RESERVED, sem timer de espera, e são liberadas ciclo a ciclo a cada parcela paga). Idempotente; sem
 * efeito para contratos sem sessões reservadas (serviço, renovação antes de gerar as sessões).
 */
export async function promoteContractSessionsOnActivation(contractId: string): Promise<{ promoted: number; progressive: boolean }> {
    const contract = await prisma.contract.findUnique({ where: { id: contractId }, select: { accessMode: true } });
    if (!contract) return { promoted: 0, progressive: false };
    const progressive = contract.accessMode === 'PROGRESSIVE';

    let promoted: number;
    if (progressive) {
        // Liberação amarrada às parcelas pagas (idempotente e serializada por contrato — pagamentos-13);
        // os ciclos seguintes perdem o timer de espera na mesma transação.
        promoted = await syncProgressiveCycles(contractId, { clearHolds: true });
    } else {
        const upd = await prisma.booking.updateMany({
            where: { contractId, status: { in: ['RESERVED', 'HELD'] } },
            data: { status: 'CONFIRMED', holdExpiresAt: null },
        });
        promoted = upd.count;
    }
    if (promoted > 0) {
        console.log(`[PaymentEffects] Contract ${contractId} activated — ${promoted} session(s) promoted to CONFIRMED (${progressive ? 'PROGRESSIVE: 1º ciclo' : 'FULL'})`);
    }
    return { promoted, progressive };
}

/**
 * AWAITING_PAYMENT → ACTIVE (atômico) + promoção das sessões reservadas (D9). No-op se o contrato
 * não estava aguardando pagamento. Usado na confirmação do pagamento E pela varredura quando ela
 * encontra um PAID num contrato ainda aguardando.
 */
export async function activateAwaitingContract(contractId: string): Promise<ContractActivation> {
    const upd = await prisma.contract.updateMany({
        where: { id: contractId, status: 'AWAITING_PAYMENT' },
        data: { status: 'ACTIVE', paymentDeadline: null },
    });
    if (upd.count === 0) return { activated: false, promoted: 0, unlockedCycle: false };
    const { promoted, progressive } = await promoteContractSessionsOnActivation(contractId);
    return { activated: true, promoted, unlockedCycle: progressive && promoted > 0 };
}

/**
 * Confirm a booking and activate its (awaiting-payment) contract once paid.
 * Idempotent: only flips RESERVED/HELD→CONFIRMED and AWAITING_PAYMENT→ACTIVE.
 * This is the block the Stripe webhook already had and the Cora webhook lacked.
 * Covers avulso micro-contracts, renewals AND the client's custom contract (D9: its reserved
 * sessions are promoted on activation — FULL: all; PROGRESSIVE: 1st cycle).
 */
export async function confirmBookingAndActivateContract(payment: PaymentLike): Promise<ContractActivation> {
    if (payment.bookingId) {
        // ATU-02/FIN-08: pagar OUTRA cobrança da reserva (um serviço extra) não confirma a sessão enquanto a
        // cobrança da PRÓPRIA sessão (marca sessionCharge — SERVIÇO, FIXO extra, avulso da equipe) estiver em
        // aberto: é a mesma regra do /confirm do cliente (402). A sessão de plano só com extras continua
        // confirmando ao pagá-los. O Payment pago já é PAID, então nunca conta como "em aberto".
        const openSessionCharge = await prisma.payment.count({ where: openSessionChargeWhere(payment.bookingId, payment.id) });
        if (openSessionCharge > 0) {
            console.log(`[PaymentEffects] Booking ${payment.bookingId} segue RESERVED: cobrança da sessão em aberto`);
        } else {
            const bookingUpdated = await prisma.booking.updateMany({
                where: { id: payment.bookingId, status: { in: ['RESERVED', 'HELD'] } },
                data: { status: 'CONFIRMED', holdExpiresAt: null },
            });
            if (bookingUpdated.count > 0) {
                console.log(`[PaymentEffects] Confirmed booking ${payment.bookingId} (cleared hold timer)`);
            }
        }
    }

    if (payment.contractId) {
        // Activate the linked contract (no-op for plan contracts already ACTIVE)
        return activateAwaitingContract(payment.contractId);
    }
    return { activated: false, promoted: 0, unlockedCycle: false };
}

/**
 * Unlock PROGRESSIVE-access bookings when a payment lands — the cycles covered by the PAID
 * installments (installment k unlocks cycle k; see syncProgressiveCycles). Idempotent.
 */
export async function unlockNextCycleBookings(contractId: string): Promise<void> {
    try {
        const unlocked = await syncProgressiveCycles(contractId);
        if (unlocked > 0) {
            console.log(`[PaymentEffects] Unlocked ${unlocked} bookings for contract ${contractId}`);
        }
    } catch (err) {
        console.error('[PaymentEffects] Error unlocking bookings:', err);
    }
}

/**
 * Generate the bookings for a renewed contract once its renewal payment is
 * confirmed (the contract already exists with status flipping to ACTIVE).
 * Idempotent: skips if the contract already has non-cancelled bookings (re-checked under a row lock
 * right before writing, so two concurrent confirmations never both generate).
 * Only FIXO and CUSTOM (recurring) pre-generate bookings; FLEX/AVULSO consume credits. Contrato
 * CANCELLED / PENDING_CANCELLATION / PAUSED / EXPIRED nunca gera (ex.: multa paga de um contrato
 * cancelado antes da 1ª sessão — todas as sessões canceladas não podem "renascer").
 *
 * Anti-overbooking (como POST /custom, /renew e /resume): cada ocorrência é TRANCADA no Redis
 * (createSlotClaimer — a mesma trava do avulso/admin) e só então conferida no banco; horário ocupado é
 * PULADO (a renovação paga não tem etapa interativa de conflito). Com o Redis fora, cai para a
 * conferência só no banco (a renovação já está paga — melhor gerar do que perder as sessões).
 *  • FIXO: a sessão pulada continua disponível pelo teto do plano (meses × sessões/mês).
 *  • CUSTOM: ocorrências de planCustomOccurrences (semana a semana, mesmo volume que a parcela cobra:
 *    sessionsPerCycle × meses); cada sessão pulada vira CRÉDITO (customCreditsRemaining) para o cliente
 *    agendar — sessões geradas + créditos = volume pago. Se TODAS caírem em horário ocupado nada é
 *    gravado (sem marca de idempotência) e o erro fica no log para o estúdio resolver.
 */
export async function generateBookingsForRenewedContract(contractId: string): Promise<void> {
    // Serializa as gerações do MESMO contrato (webhook + verify + confirm concorrentes): a 2ª espera a 1ª
    // e então encontra as sessões já criadas — assim a vencedora nunca é uma geração parcial que perdeu
    // horários para a outra. Sem Redis / tempo esgotado → segue: a trava de linha + recontagem no banco
    // continuam impedindo gerar em dobro.
    const key = `mutex:renewal-bookings:${contractId}`;
    let held = false;
    try {
        const { acquireMutexBlocking } = await import('./redis.js');
        held = await acquireMutexBlocking(key, 120, 150, 100);
    } catch { /* Redis fora: segue sem a trava */ }
    try {
        await generateRenewalBookingsUnlocked(contractId);
    } finally {
        if (held) {
            try {
                const { releaseMutex } = await import('./redis.js');
                await releaseMutex(key);
            } catch { /* expira pelo TTL */ }
        }
    }
}

const NO_RENEWAL_GENERATION_STATUSES = new Set<string>(['CANCELLED', 'PENDING_CANCELLATION', 'PAUSED', 'EXPIRED']);

async function generateRenewalBookingsUnlocked(contractId: string): Promise<void> {
    try {
        const contract = await prisma.contract.findUnique({ where: { id: contractId } });
        if (!contract) return;
        // FIXO e CUSTOM (recorrente) pré-geram bookings; FLEX/AVULSO consomem créditos.
        if (contract.type !== 'FIXO' && contract.type !== 'CUSTOM') return;
        // Roda a cada pagamento confirmado com contractId (multa, parcela, extras…): contrato cancelado,
        // em cancelamento, pausado ou expirado — cujas sessões foram todas canceladas — nunca ganha
        // sessões de volta aqui (a retomada tem o seu próprio gerador).
        if (NO_RENEWAL_GENERATION_STATUSES.has(contract.status)) return;

        // Idempotency guard: only generate if there are no bookings yet
        const existing = await prisma.booking.count({
            where: { contractId, status: { not: 'CANCELLED' } },
        });
        if (existing > 0) return;

        const { getBasePriceDynamic, applyDiscount, calculateEndTime, getPackageSlots, getSlotDuration, planCustomOccurrences } = await import('../utils/pricing.js');
        // Bookings carry only per-episode services; monthly services never ride on a recording.
        const { filterPerEpisodeAddons } = await import('./contractPricing.js');

        const basePrice = await getBasePriceDynamic(contract.tier);
        const discountedPrice = applyDiscount(basePrice, contract.discountPct);
        const perEpisodeAddOns = await filterPerEpisodeAddons(contract.addOns);
        const slotDuration = await getSlotDuration();
        // startDate/endDate são datas do contrato → dia pelo ISO (UTC), como generateFixoSessions.
        const ymd = (d: Date) => new Date(d).toISOString().slice(0, 10);
        const addDays = (ds: string, n: number) => {
            const d = new Date(ds + 'T00:00:00Z');
            d.setUTCDate(d.getUTCDate() + n);
            return ymd(d);
        };

        // Ocorrências planejadas (data, horário, status).
        const planned: { date: string; time: string; status: 'CONFIRMED' | 'RESERVED' }[] = [];
        if (contract.type === 'FIXO') {
            if (contract.fixedDayOfWeek == null || !contract.fixedTime) return;
            const { getConfig } = await import('./businessConfig.js');
            const totalWeeks = contract.durationMonths * (await getConfig('sessions_per_month'));
            const untilStr = ymd(contract.endDate);
            let ds = ymd(contract.startDate);
            const dow = ((contract.fixedDayOfWeek % 7) + 7) % 7;
            while (new Date(ds + 'T00:00:00Z').getUTCDay() !== dow) ds = addDays(ds, 1);
            for (let week = 0; week < totalWeeks && ds <= untilStr; week++, ds = addDays(ds, 7)) {
                planned.push({ date: ds, time: contract.fixedTime, status: 'CONFIRMED' });
            }
        } else {
            // B22: CUSTOM — regenera a partir do customSchedule copiado na renovação, com as MESMAS
            // ocorrências da criação (planCustomOccurrences). Datas explícitas ("Datas Livres") NÃO são
            // re-ancoráveis a um novo período automaticamente → não geramos aqui (ficam para o estúdio).
            if (!contract.customSchedule) return;
            let sched: { frequency?: string; schedule?: Array<{ day: number; time: string }>; weekPattern?: number[] };
            try { sched = JSON.parse(contract.customSchedule); } catch { return; }
            const frequency = sched?.frequency;
            const schedule = sched?.schedule || [];
            if (frequency !== 'WEEKLY' && frequency !== 'BIWEEKLY' && frequency !== 'MONTHLY') return;
            if (schedule.length === 0) return;
            const occurrences = planCustomOccurrences({
                frequency,
                durationMonths: contract.durationMonths,
                schedule,
                weekPattern: sched.weekPattern,
                startDate: ymd(contract.startDate),
            });
            for (const occ of occurrences) {
                planned.push({
                    date: occ.date,
                    time: occ.time,
                    status: contract.accessMode === 'PROGRESSIVE' && Math.floor(occ.weekIndex / 4) > 0 ? 'RESERVED' : 'CONFIRMED',
                });
            }
        }
        if (planned.length === 0) return;

        const { createSlotClaimer } = await import('../modules/contracts/contract.creation.js');
        const { buildOccupiedSet } = await import('../modules/bookings/availability.service.js');
        const { randomUUID } = await import('node:crypto');
        const claimer = createSlotClaimer(`renewal:${contract.id}:${randomUUID()}`);
        // Horários já planejados NESTA geração (vale também no modo sem Redis).
        const mine = new Map<string, Set<string>>();
        let redisDown = false;
        const claim = async (ds: string, pkg: string[]): Promise<boolean> => {
            const own = mine.get(ds);
            if (own && pkg.some(x => own.has(x))) return false;
            let free = false;
            if (!redisDown) {
                try {
                    free = await claimer.claim(ds, pkg);
                } catch (err) {
                    redisDown = true;
                    console.warn(`[PaymentEffects] Renovação ${contract.id}: trava de horário indisponível (${err instanceof Error ? err.message : err}) — conferindo só no banco.`);
                }
            }
            if (redisDown) {
                const occupied = await buildOccupiedSet(new Date(ds + 'T00:00:00Z'));
                free = !pkg.some(x => occupied.has(x));
            }
            if (!free) return false;
            const set = own ?? new Set<string>();
            pkg.forEach(x => set.add(x));
            mine.set(ds, set);
            return true;
        };

        const bookings: Array<Record<string, unknown>> = [];
        const skipped: string[] = [];
        try {
            for (const occ of planned) {
                if (!(await claim(occ.date, getPackageSlots(occ.time, slotDuration)))) {
                    skipped.push(`${occ.date} ${occ.time}`);
                    continue;
                }
                bookings.push({
                    userId: contract.userId, contractId: contract.id, date: new Date(occ.date + 'T00:00:00Z'),
                    startTime: occ.time, endTime: calculateEndTime(occ.time, slotDuration),
                    status: occ.status, tierApplied: contract.tier, price: discountedPrice, addOns: perEpisodeAddOns,
                });
            }

            if (bookings.length === 0) {
                console.error(`[PaymentEffects] Renovação ${contract.id} (${contract.type}): TODAS as ${planned.length} ocorrência(s) caíram em horário ocupado — nenhuma sessão gerada; o estúdio precisa agendar com o cliente.`);
                return;
            }

            const credited = await prisma.$transaction(async (tx) => {
                // Serializa por contrato e reconfere: outra confirmação concorrente pode ter gerado.
                await tx.$queryRaw`SELECT id FROM contracts WHERE id = ${contract.id} FOR UPDATE`;
                const again = await tx.booking.count({ where: { contractId, status: { not: 'CANCELLED' } } });
                if (again > 0) return -1;
                await tx.booking.createMany({ data: bookings as never });
                if (contract.type !== 'CUSTOM') return 0;
                // Volume pago = ocorrências planejadas (sessionsPerCycle × meses): o totalSessions copiado da
                // original pode divergir numa renovação com outra duração. Sessões puladas viram crédito.
                const cur = await tx.contract.findUnique({ where: { id: contract.id }, select: { customCreditsRemaining: true } });
                await tx.contract.update({
                    where: { id: contract.id },
                    data: {
                        totalSessions: planned.length,
                        ...(skipped.length > 0 ? { customCreditsRemaining: (cur?.customCreditsRemaining ?? 0) + skipped.length } : {}),
                    },
                });
                return skipped.length;
            });
            if (credited < 0) return;
            console.log(`[PaymentEffects] Generated ${bookings.length} bookings for renewed contract ${contractId}`);
            if (skipped.length > 0) {
                console.warn(`[PaymentEffects] Renovação ${contract.id} (${contract.type}): ${skipped.length} ocorrência(s) em horário ocupado pulada(s) (${skipped.slice(0, 6).join(', ')}${skipped.length > 6 ? '…' : ''})${credited > 0 ? ` — ${credited} crédito(s) para o cliente agendar` : ''}.`);
            }
        } finally {
            await claimer.releaseAll();
        }
    } catch (err) {
        console.error('[PaymentEffects] Error generating renewal bookings:', err);
    }
}

/**
 * Send the "payment confirmed" notification WITH push (severity 'info' would
 * otherwise never push — this is the single most important event for the user).
 */
export async function notifyPaymentConfirmed(payment: PaymentLike): Promise<void> {
    notifyEvent('payment_confirmed', {
        userId: payment.userId,
        vars: { valor: fmtBRL(payment.amount) },
        entityType: 'PAYMENT',
        entityId: payment.id,
    }).catch(() => {});
}

/**
 * Send the "PIX/boleto expired or was cancelled" notification. Distinct from a
 * card decline (payment_failed) — different copy, own eventKey.
 */
export async function notifyPaymentExpired(payment: PaymentLike): Promise<void> {
    notifyEvent('payment_expired', {
        userId: payment.userId,
        entityType: 'PAYMENT',
        entityId: payment.id,
    }).catch(() => {});
}

/** Resultado detalhado da anulação das cobranças de um contrato cancelado. */
export interface VoidContractPaymentsResult {
    /** Cobranças anuladas (→ CANCELLED). */
    voided: number;
    /** Cobranças que o provedor confirmou como PAGAS durante a anulação: viraram PAID (com os efeitos), não CANCELLED. */
    paidAtProvider: string[];
    /**
     * Cobranças anuladas cuja cobrança no provedor NÃO pôde ser cancelada agora (QR PIX ainda pagável,
     * PaymentIntent em processamento). Se o dinheiro entrar depois, a conciliação/webhook avisa o admin
     * (alertPaymentOnCancelledCharge) — nunca fica só no log.
     */
    liveAtProvider: string[];
}

type VoidablePayment = {
    id: string;
    status: string;
    provider: string;
    providerRef: string | null;
    pixString: string | null;
    amount: number;
    chargedAmount: number | null;
};

/**
 * 'paid' = virou PAID (efeitos rodaram) · 'retired' = nada pagável no provedor · 'live' = continua pagável ·
 * 'captured' = o provedor JÁ recebeu o dinheiro mas a linha não pode virar PAID (não está PENDING ou o
 * valor diverge) → é anulada e o admin é avisado na hora (nunca só um log).
 */
type ProviderRetire = 'paid' | 'retired' | 'live' | 'captured';

/**
 * PaymentIntent de cartão de uma cobrança que vai ser anulada: aprovado → marca PAID (mesmas checagens
 * do webhook: PI desta cobrança e valor igual) + efeitos; pagável → cancela (uma aba de checkout aberta
 * não conclui depois); em processamento / não consultável → 'live'.
 */
async function retireCardIntentForVoid(p: VoidablePayment): Promise<ProviderRetire> {
    const ref = p.providerRef;
    if (!ref || !ref.startsWith('pi_') || ref.startsWith('pi_mock')) return 'retired';
    const { isStripeEnabled, stripeGetPaymentIntent, stripeCancelPaymentIntent } = await import('./stripeService.js');
    if (!(await isStripeEnabled().catch(() => false))) return 'retired';
    const missing = (err: unknown) => {
        const e = err as { code?: string; statusCode?: number; raw?: { code?: string } } | null;
        return e?.code === 'resource_missing' || e?.raw?.code === 'resource_missing' || e?.statusCode === 404;
    };
    let pi: Awaited<ReturnType<typeof stripeGetPaymentIntent>>;
    try {
        pi = await stripeGetPaymentIntent(ref);
    } catch (err) {
        if (missing(err)) return 'retired';
        console.warn(`[PaymentEffects] PI ${ref} (payment ${p.id}) não pôde ser consultado antes da anulação:`, err instanceof Error ? err.message : err);
        return 'live';
    }
    if (!pi || pi.status === 'canceled') return 'retired';
    if (pi.status !== 'succeeded' && pi.status !== 'processing' && pi.status !== 'requires_capture') {
        const r = await stripeCancelPaymentIntent(ref);
        if (r.canceled) return 'retired';
        if (r.status !== 'succeeded') return 'live';
        pi = await stripeGetPaymentIntent(ref); // aprovou no meio do caminho
    }
    if (pi.status !== 'succeeded') return 'live'; // processing / requires_capture: o dinheiro pode entrar

    if (pi.metadata?.paymentId && pi.metadata.paymentId !== p.id) {
        console.error(`[PaymentEffects][SECURITY] PI ${pi.id} pertence a outro pagamento (${pi.metadata.paymentId}) — payment ${p.id} anulado sem confirmar.`);
        return 'retired';
    }
    const expected = p.chargedAmount ?? p.amount;
    if (pi.amount !== expected) {
        console.error(`[PaymentEffects][SECURITY] PI ${pi.id} aprovado com valor divergente (PI=${pi.amount}, DB=${expected}) — payment ${p.id}: conferir manualmente.`);
        return 'captured';
    }
    const upd = await prisma.payment.updateMany({
        where: { id: p.id, status: 'PENDING' },
        data: { status: 'PAID', paidAt: new Date(), providerRef: pi.id, paymentType: pi.payment_method_types?.includes('card') ? 'CREDIT' : null },
    });
    if (upd.count > 0) {
        console.log(`[PaymentEffects] PI ${pi.id} já estava aprovado — payment ${p.id} confirmado PAID (não anulado).`);
        await onPaymentConfirmed(p.id);
        return 'paid';
    }
    // Aprovado no Stripe, mas a linha não estava PENDING (ex.: FAILED por uma recusa anterior do mesmo PI).
    const fresh = await prisma.payment.findUnique({ where: { id: p.id }, select: { status: true } });
    return fresh?.status === 'PAID' ? 'paid' : 'captured';
}

/**
 * Aposenta no provedor a cobrança viva de uma parcela que vai ser anulada (E13): um QR PIX/boleto/PI
 * emitido antes do cancelamento não pode continuar pagável sem registro.
 *  • PIX (Sicoob/Cora): retirePixCharge — concilia (já pago → PAID com os efeitos) e cancela a cobrança;
 *  • boleto puro da Cora: concilia e cancela a fatura;
 *  • cartão (Stripe): retireCardIntentForVoid.
 * Linha FAILED (não conciliável): só cancela a cobrança que ficou para trás, best-effort.
 */
async function retireProviderChargeForVoid(p: VoidablePayment): Promise<ProviderRetire> {
    if (!p.providerRef) return 'retired';
    const { isPixProvider, retirePixCharge, cancelStalePixCharge } = await import('./pixGateway.js');

    if (p.status !== 'PENDING') {
        if (p.provider === 'STRIPE') return retireCardIntentForVoid(p);
        if (isPixProvider(p.provider)) await cancelStalePixCharge(p.provider, p.providerRef, p.pixString);
        return 'retired';
    }

    if (p.provider === 'STRIPE') return retireCardIntentForVoid(p);

    if (p.provider === 'CORA' && !p.pixString) {
        // Boleto puro (sem QR): retirePixCharge não o cancela — concilia e cancela a fatura aqui.
        const { reconcileCoraPayment, isCoraInvoiceCancelled } = await import('./coraReconciliation.js');
        if (await reconcileCoraPayment(p.id)) return 'paid';
        const { coraCancelBoleto, coraGetBoleto, isCoraEnabled } = await import('./coraService.js');
        try {
            await coraCancelBoleto(p.providerRef);
        } catch (err) {
            console.warn(`[PaymentEffects] cancelar boleto Cora ${p.providerRef} falhou:`, err instanceof Error ? err.message : err);
            if (await reconcileCoraPayment(p.id)) return 'paid';
            // Integração desligada: não há como cancelar nem consultar — segue (mesmo critério do PIX).
            if (await isCoraEnabled().catch(() => false)) {
                try {
                    if (!isCoraInvoiceCancelled(await coraGetBoleto(p.providerRef))) return 'live';
                } catch {
                    return 'live';
                }
            }
        }
        return 'retired';
    }

    if (isPixProvider(p.provider)) {
        const r = await retirePixCharge(p.id);
        return r === 'paid' ? 'paid' : r === 'live' ? 'live' : 'retired';
    }
    return 'retired';
}

/** Escopo da anulação (padrão: tudo que está em aberto no contrato, MENOS a multa de cancelamento). */
export interface VoidContractPaymentsOpts {
    /** Também anula a multa de cancelamento (default false). Usado pela exclusão de cliente. */
    includeFines?: boolean;
    /** SÓ as multas de cancelamento em aberto (a decisão que gera uma multa nova aposenta as anteriores). */
    onlyFines?: boolean;
    /** Restringe às cobranças de EXTRAS destas gravações (bookingId na lista) — pedido de cancelamento. */
    bookingIds?: string[];
    /** Restringe a estas cobranças (id na lista) — combinado com os filtros acima. */
    paymentIds?: string[];
}

/**
 * Void every still-unpaid installment of a contract when it is cancelled.
 *
 * Without this, a cancelled contract leaves its future parcelas as PENDING — they
 * keep showing as "faturas abertas", can be auto-charged (Stripe subscription), and
 * a late Cora/Stripe webhook (or the reconciliation cron) could still flip one to
 * PAID. We move them to CANCELLED (a terminal, non-collectible state distinct from a
 * FAILED charge) and cancel any Stripe subscription so it stops billing.
 *
 * E13 (30/09/2026):
 *  • ANTES de anular, a cobrança viva de cada parcela é aposentada no provedor (QR PIX, boleto,
 *    PaymentIntent). Se o provedor disser que já foi paga, a parcela vira PAID com todos os efeitos —
 *    não CANCELLED. Falha do provedor não bloqueia o cancelamento (best-effort): a parcela é anulada
 *    e, se o dinheiro entrar depois, o admin é avisado (alertPaymentOnCancelledCharge).
 *  • Parcelas FAILED (cobrança recusada/expirada, ainda devida) também são anuladas: num contrato
 *    cancelado nada continua pagável além da multa de cancelamento.
 *  • A MULTA de cancelamento (metadata.kind) NUNCA é anulada por padrão: uma segunda requisição de
 *    cancelamento (duas decisões, DELETE/PATCH concorrentes, ou o contrato reaberto e cancelado de novo)
 *    não pode apagar a multa que outra acabou de criar. Só `includeFines` (exclusão de cliente) ou
 *    `onlyFines` (decisão que SUBSTITUI a multa anterior por uma nova) a alcançam.
 *
 * Idempotent: only PENDING/FAILED rows are touched; PAID/REFUNDED are left intact.
 * Returns the number of installments voided (detalhes: voidContractPendingPaymentsDetailed).
 */
export async function voidContractPendingPayments(contractId: string, opts: VoidContractPaymentsOpts = {}): Promise<number> {
    return (await voidContractPendingPaymentsDetailed(contractId, opts)).voided;
}

export async function voidContractPendingPaymentsDetailed(contractId: string, opts: VoidContractPaymentsOpts = {}): Promise<VoidContractPaymentsResult> {
    const result: VoidContractPaymentsResult = { voided: 0, paidAtProvider: [], liveAtProvider: [] };
    // Filtro em JS (metadata selecionado): um filtro JSON `NOT` do Prisma descartaria as linhas com
    // metadata nulo — que são a maioria das parcelas.
    const inScope = (p: { id: string; bookingId: string | null; metadata: unknown }): boolean => {
        if (opts.paymentIds && !opts.paymentIds.includes(p.id)) return false;
        const fine = isCancellationFine(p);
        if (opts.onlyFines) return fine;
        if (fine && !opts.includeFines) return false;
        if (opts.bookingIds) return !!p.bookingId && opts.bookingIds.includes(p.bookingId);
        return true;
    };

    // 1) Provedor primeiro (chamadas de rede fora de qualquer transação): cobranças emitidas das
    //    parcelas ainda em aberto. Best-effort por linha — uma falha aqui nunca impede o cancelamento.
    const issued = (await prisma.payment.findMany({
        where: { contractId, status: { in: ['PENDING', 'FAILED'] }, providerRef: { not: null } },
        select: { id: true, status: true, provider: true, providerRef: true, pixString: true, amount: true, chargedAmount: true, bookingId: true, metadata: true },
    })).filter(inScope);
    const captured: VoidablePayment[] = [];
    for (const p of issued) {
        let r: ProviderRetire;
        try {
            r = await retireProviderChargeForVoid(p);
        } catch (err) {
            console.warn(`[PaymentEffects] Falha ao aposentar a cobrança ${p.providerRef} do payment ${p.id} (best-effort):`, err instanceof Error ? err.message : err);
            r = 'live';
        }
        if (r === 'paid') result.paidAtProvider.push(p.id);
        else if (r === 'live') result.liveAtProvider.push(p.id);
        else if (r === 'captured') { result.liveAtProvider.push(p.id); captured.push(p); }
    }
    if (result.liveAtProvider.length > 0) {
        console.warn(`[PaymentEffects] Contrato ${contractId}: ${result.liveAtProvider.length} cobrança(s) anulada(s) com a cobrança ainda viva no provedor (${result.liveAtProvider.join(', ')}) — um pagamento nela gera alerta ao admin.`);
    }

    // 2) Snapshot the open rows (DEPOIS do provedor: uma confirmação acima pode ter gerado parcelas
    //    novas — ex.: 1ª parcela de uma renovação — que também precisam ser anuladas) so we can cancel
    //    any linked Stripe subscription AFTER they are voided (see ordering note below).
    const open = (await prisma.payment.findMany({
        where: { contractId, status: { in: ['PENDING', 'FAILED'] } },
        select: { id: true, stripeSubscriptionId: true, bookingId: true, metadata: true },
    })).filter(inScope);
    // Dinheiro já confirmado no provedor numa linha que não pôde virar PAID: depois de anulada, o admin é
    // avisado imediatamente (mesmo alerta do webhook/conciliação — 1 por cobrança).
    const alertCaptured = async () => {
        for (const p of captured) {
            await alertPaymentOnCancelledCharge(p.id, { provider: 'Stripe (cartão)', providerRef: p.providerRef, amountCents: p.chargedAmount ?? p.amount });
        }
    };
    if (open.length === 0) { await alertCaptured(); return result; }
    const openIds = open.map(p => p.id);

    // Void the installments FIRST, then cancel the subscription. Ordering matters:
    // cancelling the Stripe subscription emits a `customer.subscription.deleted` webhook that
    // marks this subscription's still-PENDING payments as FAILED. If we cancelled the sub
    // before voiding, that webhook could win the race and leave the parcelas FAILED ("Falhou")
    // instead of CANCELLED ("Cancelado"). Voiding to CANCELLED first means the webhook's
    // PENDING-only updateMany no longer matches them.
    //
    // Race note: between the snapshot above and this updateMany a concurrent confirmation may
    // flip a row PENDING→PAID. That is safe and correct — the atomic `where status` only voids
    // rows still unpaid, so a legitimately-paid installment is never voided, and a voided
    // installment can never be (re)confirmed (onPaymentConfirmed re-checks status==='PAID').
    const voided = await prisma.payment.updateMany({
        where: { id: { in: openIds }, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'CANCELLED' },
    });
    result.voided = voided.count;
    if (voided.count > 0) {
        console.log(`[PaymentEffects] Voided ${voided.count} unpaid installment(s) for cancelled contract ${contractId}`);
        // Give back any coupon uses still reserved on the voided installments (só RESERVED é devolvido:
        // uma parcela confirmada no meio do caminho mantém o uso).
        await releaseCouponForPayments(openIds);
    }
    await alertCaptured();

    // Cancel any Stripe subscription tied to these installments so it stops billing. Best-effort:
    // a transient Stripe failure is logged but does not abort the cancellation (the parcelas are
    // already voided locally; the downstream guards reject any late confirmation).
    const subscriptionIds = [...new Set(
        open.map(p => p.stripeSubscriptionId).filter((s): s is string => !!s)
    )];
    if (subscriptionIds.length > 0) {
        try {
            const { isStripeEnabled, stripeCancelSubscription } = await import('./stripeService.js');
            if (await isStripeEnabled()) {
                for (const subId of subscriptionIds) {
                    try {
                        await stripeCancelSubscription(subId);
                        console.log(`[PaymentEffects] Cancelled Stripe subscription ${subId} for contract ${contractId}`);
                    } catch (subErr) {
                        console.error(`[PaymentEffects] Failed to cancel subscription ${subId} (sub may keep billing — needs manual check):`, subErr instanceof Error ? subErr.message : subErr);
                    }
                }
            }
        } catch (err) {
            console.error('[PaymentEffects] Stripe subscription cancellation skipped:', err instanceof Error ? err.message : err);
        }
    }

    return result;
}

/**
 * Pagamento confirmado no provedor para uma cobrança que já estava CANCELLED (parcela anulada de um
 * contrato cancelado cujo QR/PI continuou pagável): o dinheiro entrou e a linha não pode virar PAID
 * sozinha. Em vez de só logar, avisa TODOS os admins (persistida + push) e grava a marca na auditoria
 * — que também garante UM aviso por cobrança (webhook reentregue / varredura a cada 2 min).
 * Nunca lança. Devolve true se o aviso foi emitido agora.
 */
export async function alertPaymentOnCancelledCharge(
    paymentId: string,
    info: { provider: string; providerRef?: string | null; amountCents?: number | null },
): Promise<boolean> {
    try {
        const payment = await prisma.payment.findUnique({
            where: { id: paymentId },
            select: {
                id: true, status: true, amount: true, userId: true,
                user: { select: { name: true } },
                contract: { select: { name: true } },
            },
        });
        if (!payment || payment.status !== 'CANCELLED') return false;
        const already = await prisma.auditLog.count({
            where: { entityType: 'PAYMENT', entityId: paymentId, action: AUDIT_PAID_AFTER_CANCELLED },
        });
        if (already > 0) return false;

        const amount = info.amountCents && info.amountCents > 0 ? info.amountCents : payment.amount;
        console.error(`[PaymentEffects][ALERTA] Pagamento de ${fmtBRL(amount)} confirmado no ${info.provider} (${info.providerRef ?? 's/ ref'}) para a cobrança CANCELADA ${paymentId} — avisando o admin (estornar ou dar baixa manual).`);
        await prisma.auditLog.create({
            data: {
                entityType: 'PAYMENT', entityId: paymentId, action: AUDIT_PAID_AFTER_CANCELLED, performedBy: 'SYSTEM',
                changes: JSON.stringify({ provider: info.provider, providerRef: info.providerRef ?? null, amount }),
            },
        });
        // Equipe: ADMIN + COLABORADOR com a permissão do evento (financeiro.ver); nunca desativado/excluído.
        const { getStaffRecipientIds } = await import('./staffRecipients.js');
        for (const staffId of await getStaffRecipientIds('admin_payment_on_cancelled_charge')) {
            await notifyEvent('admin_payment_on_cancelled_charge', {
                userId: staffId,
                vars: { cliente: payment.user?.name ?? 'Cliente', valor: fmtBRL(amount), contrato: payment.contract?.name ?? 'sem contrato' },
                entityType: 'PAYMENT',
                entityId: paymentId,
                dedupKey: `paid-on-cancelled:${paymentId}:${staffId}`,
            }).catch(() => '');
        }
        return true;
    } catch (err) {
        console.error(`[PaymentEffects] Falha ao avisar o admin do pagamento na cobrança cancelada ${paymentId}:`, err);
        return false;
    }
}

/**
 * Create the remaining monthly installments (months 2..N) once a contract's first payment is
 * confirmed, for the "create-then-pay" contracts that create the contract upfront with only the
 * first installment: RENEWALS and the self-serve/SERVICO hire flows (contract born AWAITING_PAYMENT).
 * Without it such a MONTHLY contract would only ever charge month 1.
 *
 * Idempotent & safe for EVERY flow: skips FULL plans and AVULSO, and bails when the contract already
 * has >= durationMonths non-cancelled payments — which is exactly the case for admin/self/custom
 * contracts that materialize all installments at fulfillment, so this is a no-op for them. Uses the
 * first PAID payment's amount as the per-month figure so every installment matches exactly.
 */
export async function generateRemainingInstallments(contractId: string): Promise<void> {
    try {
        const contract = await prisma.contract.findUnique({ where: { id: contractId } });
        if (!contract) return;
        if (contract.paymentPlan === 'FULL') return;             // FULL = single upfront payment
        if (contract.type === 'AVULSO') return;                  // avulso has no installments
        // Contrato cancelado / em cancelamento nunca ganha parcelas novas. Sem isto, a MULTA paga de um
        // contrato cancelado antes de qualquer parcela paga (E13: multa sobre o que FALTA pagar) seria
        // "a única cobrança paga, sem pendentes" e regeraria as parcelas 2..N com o valor da multa.
        if (contract.status === 'CANCELLED' || contract.status === 'PENDING_CANCELLATION') return;

        // Serialize per contract: two concurrent confirmations (e.g. two admin PATCHes marking the
        // same payment PAID, which lacks an atomic guard) must not both pass the count check and
        // double-generate installments. Best-effort Redis lock; if not acquired, another call owns it.
        const { redis } = await import('./redis.js');
        const lockKey = `cron:renewal-installments:${contractId}`;
        if ((await redis.set(lockKey, '1', 'EX', 30, 'NX')) !== 'OK') return;
        try {
            // Materialize months 2..N ONLY at the moment the single first charge is confirmed:
            // exactly one PAID payment and zero PENDING. This makes it a no-op once installments
            // exist (admin/self/custom/legacy-service already create all N at fulfillment; a
            // renewal/create-then-pay contract has just its first PAID). Crucially, it does NOT
            // count "missing" installments — so a deliberately-CANCELLED installment is never
            // resurrected (which a `>= durationMonths` non-cancelled count would wrongly refill on
            // the next sibling confirmation), and a FAILED first attempt (excluded) doesn't block.
            const [paidCount, pendingCount] = await Promise.all([
                prisma.payment.count({ where: { contractId, status: 'PAID' } }),
                prisma.payment.count({ where: { contractId, status: 'PENDING' } }),
            ]);
            if (paidCount !== 1 || pendingCount !== 0) return;

            const firstPaid = await prisma.payment.findFirst({
                where: { contractId, status: 'PAID' },
                orderBy: { createdAt: 'asc' },
                include: { coupon: { select: { scope: true } } },
            });
            if (!firstPaid) return;

            // Coupon parity: a FIRST_PAYMENT coupon discounts ONLY the confirmed first
            // charge — months 2..N must revert to the pre-coupon amount, otherwise the
            // discount would silently leak into every installment. ALL_INSTALLMENTS
            // coupons keep the discounted figure (and stamp the audit fields).
            const couponOnAll = firstPaid.couponId && firstPaid.coupon?.scope === 'ALL_INSTALLMENTS';
            const perMonthAmount = couponOnAll
                ? firstPaid.amount
                : firstPaid.amount + (firstPaid.discountAmount ?? 0);

            const start = new Date(contract.startDate);
            const remaining = [];
            // Installments 2..N are anchored to contract.startDate. FIXO/FLEX/CUSTOM advance
            // on the fixed 28-day billing cadence; standalone monthly SERVICO services advance
            // by calendar month (~30 days). The first payment is due on-demand (today, via /pay).
            const { addBillingCycles, addMonths } = await import('../utils/pricing.js');
            const advance = contract.type === 'SERVICO'
                ? (i: number) => addMonths(start, i)
                : (i: number) => addBillingCycles(start, i);
            // Month 1 is the just-confirmed first charge (index 0); generate months 2..N.
            for (let i = 1; i < contract.durationMonths; i++) {
                const dueDate = advance(i);
                remaining.push({
                    userId: contract.userId,
                    contractId,
                    provider: firstPaid.provider,
                    amount: perMonthAmount,   // parity with the first payment (pre-coupon unless scope=ALL)
                    status: 'PENDING' as const,
                    dueDate,
                    // B1: propagar a assinatura Stripe para as parcelas 2..N. Sem isto, o webhook
                    // invoice.payment_succeeded (que casa por {stripeSubscriptionId, status:PENDING})
                    // nunca as concilia — ficam PENDING para sempre e o auto-charge as cobra DE NOVO
                    // (cobrança dupla), pois o Stripe já debita o cartão pela assinatura.
                    ...(firstPaid.stripeSubscriptionId ? { stripeSubscriptionId: firstPaid.stripeSubscriptionId } : {}),
                    ...(couponOnAll ? {
                        couponId: firstPaid.couponId,
                        couponCode: firstPaid.couponCode,
                        discountAmount: firstPaid.discountAmount,
                    } : {}),
                });
            }
            if (remaining.length > 0) {
                await prisma.payment.createMany({ data: remaining });
                // A 100% ALL_INSTALLMENTS coupon makes later installments R$0 — the gateway
                // can't process a zero charge, so settle them as PAID instead of leaving them
                // stuck PENDING (mirrors the fulfillment path).
                await prisma.payment.updateMany({
                    where: { contractId, status: 'PENDING', amount: 0 },
                    data: { status: 'PAID', paidAt: new Date() },
                }).catch(() => {});
                console.log(`[PaymentEffects] Generated ${remaining.length} remaining installment(s) for contract ${contractId}`);
            }
        } finally {
            await redis.del(lockKey);
        }
    } catch (err) {
        console.error('[PaymentEffects] Error generating renewal installments:', err);
    }
}

/**
 * Apply a change to a contract's recurring services (Contract.addOns), affecting ONLY THE FUTURE:
 *  - recomputes the amount of still-PENDING installments (MONTHLY) / the single PENDING payment (FULL) —
 *    only the PLAN charges (bookingId null): a pending extras charge of a recording keeps its own value,
 *    and so does a pending cancellation fine (metadata.kind — E13);
 *    FULL (any payment method) also rewrites the bidirectional metadata.pixDiscount { pct, cardAmount,
 *    pixAmount } with both prices of the NEW total (E2), so PIX keeps its discount and card its price
 *  - updates the addOns of FUTURE bookings (date >= today, not CANCELLED/COMPLETED) by delta —
 *    drops removed services, adds newly-added per-episode services, and PRESERVES any per-booking
 *    extras the client added individually. booking.price is left untouched (recurring services are
 *    billed in the monthly installment, not per recording).
 *  - persists the new Contract.addOns
 * Scope: FIXO/FLEX ACTIVE only (CUSTOM uses addonConfig; AVULSO has no recurring services).
 * Past/paid installments and past/completed recordings are never touched.
 * PIX: a cobrança já emitida carrega o valor ANTIGO (o reuso entregaria um QR que a conciliação
 * recusa por valor divergente). Por isso, nas parcelas PENDING cujo valor muda, a cobrança PIX viva
 * é conciliada (se já paga, fica PAID e não é repreçada) e cancelada no provedor (best-effort), e
 * pixString/providerRef/pixExpiresAt são zerados — o próximo "Pagar" emite um QR com o valor novo.
 * Cartão: o PaymentIntent JÁ emitido (checkout aberto numa aba) carrega o valor antigo e o webhook o
 * aceitaria (`chargedAmount ?? amount`). Nas parcelas cujo valor muda, o PI é resolvido ANTES da transação
 * (settleExistingCardIntent): pagável → cancelado, e providerRef/chargedAmount são zerados (o próximo
 * "Pagar" cria um PI com o valor novo); aprovado/em processamento ou não consultável → a parcela fica no
 * valor antigo (mesmo critério do QR 'live'). Nunca se zera o chargedAmount com o PI ainda vivo.
 * Known limitation: a PENDING pure boleto whose external invoice was already issued is not re-issued.
 */
export async function applyContractServiceChange(contractId: string, newAddOns: string[]): Promise<void> {
    const contract = await prisma.contract.findUnique({ where: { id: contractId } });
    if (!contract) throw new Error('Contrato não encontrado.');
    if (contract.status !== 'ACTIVE') throw new Error('Só é possível editar serviços de um contrato ativo.');
    if (contract.type !== 'FIXO' && contract.type !== 'FLEX') {
        throw new Error('Edição de serviços disponível apenas para contratos Fixo/Flex.');
    }

    const { getBasePriceDynamic, applyDiscount } = await import('../utils/pricing.js');
    const { getConfig } = await import('./businessConfig.js');
    const { computeAddonsCost, computeFullContractTotals } = await import('./contractPricing.js');

    const sessions = await getConfig('sessions_per_month');
    const basePrice = await getBasePriceDynamic(contract.tier);
    const discountedPrice = applyDiscount(basePrice, contract.discountPct);
    const newMonthly = (sessions * discountedPrice) + await computeAddonsCost(newAddOns, contract.discountPct, sessions);
    // À vista: os DOIS preços do total novo (cartão e PIX). `total` segue a forma do contrato, como na
    // criação: PIX grava o preço PIX; cartão/boleto gravam o preço de cartão.
    const fullTotals = contract.paymentPlan === 'FULL'
        ? await computeFullContractTotals(newMonthly, contract.durationMonths, contract.paymentMethod)
        : null;
    const newFull = fullTotals ? fullTotals.total : null;

    // Per-episode (monthly:false) services accompany every recording; monthly add-ons never land on bookings.
    const newConfigs = await prisma.addOnConfig.findMany({ where: { key: { in: newAddOns } } });
    const newPerEpisode = newConfigs.filter(c => !c.monthly).map(c => c.key);
    const oldSet = new Set(contract.addOns || []);
    const removed = [...oldSet].filter(k => !newAddOns.includes(k));
    const addedPerEpisode = newPerEpisode.filter(k => !oldSet.has(k));

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const newAmount = newFull ?? newMonthly;

    // 0. PIX charges already issued for the OLD amount: reconcile + cancel them at the provider
    //    BEFORE repricing (network calls stay outside the transaction). Best-effort per row.
    const { retirePixCharge, isPixProvider, pixMetadataAfterDiscard } = await import('./pixGateway.js');
    // Multa de cancelamento (E13) também é PENDING sem bookingId, mas NÃO é parcela do plano: num contrato
    // reaberto pelo admin com a multa ainda em aberto, ela mantém o próprio valor (nunca vira o valor do plano).
    const fineIds = (await prisma.payment.findMany({
        where: { contractId, bookingId: null, status: 'PENDING' },
        select: { id: true, metadata: true },
    })).filter(isCancellationFine).map(p => p.id);
    // Só as parcelas do PLANO (sem bookingId): cobranças de extras de uma gravação têm valor próprio e
    // nunca são repreçadas pela troca de serviços recorrentes.
    const stalePix = await prisma.payment.findMany({
        where: {
            contractId, bookingId: null, status: 'PENDING', amount: { not: newAmount },
            ...(fineIds.length > 0 ? { id: { notIn: fineIds } } : {}),
            OR: [{ pixString: { not: null } }, { pixExpiresAt: { not: null } }],
        },
        select: { id: true, provider: true, providerRef: true, metadata: true, pixString: true },
    });
    // Parcelas cujo QR antigo continua PAGÁVEL e não pôde ser cancelado agora ('live' — pagamentos-4):
    // ficam no valor antigo, com a cobrança intacta (um pagamento nela precisa casar com o Payment).
    const liveIds: string[] = [];
    for (const p of stalePix) {
        if (!isPixProvider(p.provider) || !p.providerRef) continue;
        try {
            // 'paid' → a linha virou PAID e sai do updateMany abaixo
            if ((await retirePixCharge(p.id)) === 'live') liveIds.push(p.id);
        } catch (err) {
            console.warn(`[PaymentEffects] Falha ao aposentar o PIX da parcela ${p.id} (best-effort):`, err instanceof Error ? err.message : err);
        }
    }
    if (liveIds.length > 0) {
        console.warn(`[PaymentEffects] Contrato ${contractId}: ${liveIds.length} parcela(s) com QR PIX vivo não cancelável mantida(s) no valor antigo (${liveIds.join(', ')}) — conferir com o cliente.`);
    }

    // 0b. PaymentIntent de cartão já emitido pelo valor ANTIGO (checkout aberto): resolvido antes do
    //     repreço, como o QR PIX. Pagável → cancelado (a linha perde providerRef/chargedAmount na
    //     transação); aprovado/em processamento ou não consultável → a parcela fica no valor antigo, com o
    //     PI intacto (o pagamento nele precisa casar com o Payment); PI que já cobra o valor novo → fica.
    const { settleExistingCardIntent } = await import('./pixGateway.js');
    const newCardAmount = fullTotals?.cardTotal ?? newAmount;
    const staleCard = await prisma.payment.findMany({
        where: {
            contractId, bookingId: null, status: 'PENDING', amount: { not: newAmount },
            ...(fineIds.length > 0 ? { id: { notIn: fineIds } } : {}),
            providerRef: { startsWith: 'pi_' },
        },
        select: { id: true, providerRef: true },
    });
    const cardReset: { id: string; providerRef: string | null }[] = [];
    const cardLiveIds: string[] = [];
    for (const p of staleCard) {
        let state: string;
        try {
            state = (await settleExistingCardIntent(p.providerRef, newCardAmount)).state;
        } catch (err) {
            console.warn(`[PaymentEffects] Falha ao resolver o PaymentIntent ${p.providerRef} da parcela ${p.id}:`, err instanceof Error ? err.message : err);
            state = 'unknown';
        }
        if (state === 'cancelled' || state === 'none') cardReset.push({ id: p.id, providerRef: p.providerRef });
        else if (state === 'in_flight' || state === 'unknown') cardLiveIds.push(p.id);
    }
    if (cardLiveIds.length > 0) {
        console.warn(`[PaymentEffects] Contrato ${contractId}: ${cardLiveIds.length} parcela(s) com pagamento no cartão em andamento (ou não consultável) mantida(s) no valor antigo (${cardLiveIds.join(', ')}) — conferir com o cliente.`);
    }

    // E2 (marca bidirecional): TODA cobrança à vista repreçada regrava `pixDiscount { pct, cardAmount,
    // pixAmount }` com os dois preços do total NOVO — seja qual for a forma do contrato. Criada no PIX, o
    // amount novo é o preço PIX (o cartão cobra cardAmount); criada no cartão/boleto, o amount novo é o
    // preço de cartão e o PIX continua saindo com o desconto (issuePixCharge baixa para pixAmount). Sem
    // isso a marca antiga caducava e o PIX de um à vista + cartão saía pelo valor cheio depois da troca.
    // Mensal (newFull null) não tem diferença de preço: uma marca que exista é removida.
    const { pixDiscountMetaForFullCharge, mergePaymentMetadata } = await import('./pixGateway.js');
    const newPixDiscount = fullTotals
        ? pixDiscountMetaForFullCharge({ cardTotal: fullTotals.cardTotal, pixTotal: fullTotals.pixTotal, pct: fullTotals.pixPct })
        : undefined;

    await prisma.$transaction(async (tx) => {
        // O cliente pode ter aberto um checkout de cartão NOVO entre o cancelamento do PI antigo (acima,
        // fora da transação) e aqui: a linha já aponta para outro PI, criado pelo valor antigo. Essa linha
        // não é repreçada nem perde a referência — o pagamento nesse PI precisa casar com `chargedAmount`.
        const resetNow = cardReset.length === 0 ? [] : await tx.payment.findMany({
            where: { id: { in: cardReset.map(p => p.id) } },
            select: { id: true, providerRef: true },
        });
        const cardMovedIds = cardReset
            .filter(p => resetNow.find(r => r.id === p.id)?.providerRef !== p.providerRef)
            .map(p => p.id);
        const skipIds = [...liveIds, ...cardLiveIds, ...cardMovedIds, ...fineIds];
        const repriceWhere = { contractId, bookingId: null, status: 'PENDING' as const, ...(skipIds.length > 0 ? { id: { notIn: skipIds } } : {}) };
        // 1. Recompute still-PENDING installments (PAID/past ones are never matched).
        await tx.payment.updateMany({
            where: repriceWhere,
            data: { amount: newAmount },
        });
        // 1a. PaymentIntent antigo cancelado acima: a linha deixa de apontar para ele e de guardar o valor
        //     antigo do cartão (senão o webhook aceitaria o valor antigo por `chargedAmount ?? amount`).
        for (const p of cardReset) {
            if (cardMovedIds.includes(p.id)) continue;
            await tx.payment.updateMany({
                where: { id: p.id, status: 'PENDING', providerRef: p.providerRef },
                data: { chargedAmount: null, providerRef: null },
            });
        }
        // 1b. Drop the stale PIX artifacts (old value) so the next "Pagar" issues a fresh QR.
        for (const p of stalePix) {
            if (liveIds.includes(p.id)) continue;
            const discardMeta = pixMetadataAfterDiscard(p);
            await tx.payment.updateMany({
                where: { id: p.id, status: 'PENDING' },
                data: {
                    pixString: null,
                    pixExpiresAt: null,
                    ...(isPixProvider(p.provider) ? { providerRef: null } : {}),
                    // Cora PIX é uma fatura (boleto + QR) cancelada acima → o boleto dela também caducou.
                    ...(p.provider === 'CORA' && p.pixString ? { boletoUrl: null } : {}),
                    ...(discardMeta !== undefined ? { metadata: discardMeta } : {}),
                },
            });
        }
        // 1c. Marca do desconto PIX das parcelas repreçadas (relida DEPOIS do 1b, que regrava o metadata).
        const marked = await tx.payment.findMany({ where: repriceWhere, select: { id: true, metadata: true } });
        for (const p of marked) {
            const meta = (p.metadata && typeof p.metadata === 'object' && !Array.isArray(p.metadata)) ? p.metadata as Record<string, unknown> : {};
            if (!newPixDiscount && !('pixDiscount' in meta)) continue;
            const next = newPixDiscount
                ? mergePaymentMetadata(p.metadata, { pixDiscount: newPixDiscount })
                : Object.fromEntries(Object.entries(meta).filter(([k]) => k !== 'pixDiscount'));
            await tx.payment.update({ where: { id: p.id }, data: { metadata: next as never } });
        }
        // 2. Future bookings: delta-merge so client-added extras survive (price untouched).
        const futureBookings = await tx.booking.findMany({
            where: { contractId, date: { gte: today }, status: { notIn: ['CANCELLED', 'COMPLETED'] } },
            select: { id: true, addOns: true },
        });
        for (const b of futureBookings) {
            const merged = new Set((b.addOns || []).filter(k => !removed.includes(k)));
            addedPerEpisode.forEach(k => merged.add(k));
            await tx.booking.update({ where: { id: b.id }, data: { addOns: [...merged] } });
        }
        // 3. Persist the contract's new recurring services.
        await tx.contract.update({ where: { id: contractId }, data: { addOns: newAddOns } });
    });

    console.log(`[PaymentEffects] Contract ${contractId} services updated → [${newAddOns.join(', ') || 'none'}]; future installment=${newAmount}${stalePix.length ? `; ${stalePix.length} PIX charge(s) invalidated` : ''}`);
}

/**
 * Full orchestration of side-effects after a payment becomes PAID.
 * Caller is responsible for the atomic PENDING→PAID transition first; this
 * function is idempotent so it is safe even if called more than once.
 */
export async function onPaymentConfirmed(paymentId: string): Promise<void> {
    const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        select: { id: true, userId: true, amount: true, bookingId: true, contractId: true, paymentUrl: true, status: true, metadata: true },
    });
    if (!payment) return;
    // Defense-in-depth: callers must flip the row to PAID atomically first. Never run
    // confirmation effects (confirm booking, activate contract, notify) for a payment that
    // isn't actually PAID — e.g. a CANCELLED installment of a cancelled contract.
    if (payment.status !== 'PAID') {
        console.warn(`[PaymentEffects] onPaymentConfirmed skipped: payment ${paymentId} status=${payment.status} (expected PAID)`);
        return;
    }

    // 0. Coupon bookkeeping: RESERVED → CONFIRMED (idempotent; no-op without coupon)
    await confirmCouponRedemption(payment.id);

    // Multa de cancelamento (E13): é só uma cobrança — o contrato já está CANCELLED e nada é entregue.
    // Pula os efeitos de contratação (ativar contrato, gerar sessões/parcelas, liberar ciclo): a multa
    // não é parcela do plano e não pode contar como tal. Só avisa o cliente.
    if (isCancellationFine(payment)) {
        await notifyPaymentConfirmed(payment);
        return;
    }

    // 1. Activate purchased add-on(s)
    await activateAddonIfNeeded(payment.id);

    // 2. Confirm booking + activate its contract (fixes the PIX-deleted bug; covers renewals and
    //    promotes the reserved sessions of a client custom contract — D9)
    await confirmBookingAndActivateContract(payment);

    // 3. Materialize a self-service contract whose data lives in payment.metadata (no-op otherwise)
    await fulfillContractFromPayment(payment.id);

    // 4. Generate bookings + remaining installments for create-then-pay contracts
    // (renewals + self/SERVICO hire born AWAITING_PAYMENT). No-op when installments already exist.
    if (payment.contractId) {
        await generateBookingsForRenewedContract(payment.contractId);
        await generateRemainingInstallments(payment.contractId);
    }

    // 5. Notify the user (with push)
    await notifyPaymentConfirmed(payment);

    // 6. PROGRESSIVE: libera os ciclos cobertos pelas parcelas pagas. Derivado do estado (parcelas
    //    PAID × sessões liberadas) e serializado por contrato → uma parcela nunca libera dois ciclos,
    //    mesmo que a ativação (aqui ou na varredura) já tenha liberado o 1º (pagamentos-8/13).
    if (payment.contractId) {
        await unlockNextCycleBookings(payment.contractId);
    }
}
