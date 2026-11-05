import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { getPackageSlots } from '../utils/pricing.js';
import { redis, releaseMultiSlotLock } from '../lib/redis.js';
import { releaseCouponForPayments } from '../lib/couponService.js';
import { activateAwaitingContract, onPaymentConfirmed } from '../lib/paymentEffects.js';
import { sessionAwaitsOwnPayment } from '../modules/bookings/booking.service.js';

/**
 * Devolve os usos de cupom RESERVED e remove as linhas de resgate (FK RESTRICT) dos pagamentos que
 * vão ser apagados — de forma IDEMPOTENTE (jobs-tempo-migrations-3): o DELETE … RETURNING decrementa
 * o usedCount só pelo que ESTA chamada apagou. Duas purgas simultâneas do mesmo contrato (cron ×
 * /custom/check × troca de serviço) não devolvem o mesmo uso duas vezes (no READ COMMITTED o DELETE
 * concorrente espera, relê e não acha mais a linha). CONFIRMED nunca é tocado.
 */
export async function releaseAndPurgeRedemptionsOnce(paymentIds: string[]): Promise<void> {
    if (paymentIds.length === 0) return;
    await prisma.$transaction(async (tx) => {
        const deleted = await tx.$queryRaw<{ coupon_id: string; status: string }[]>`
            DELETE FROM coupon_redemptions
            WHERE payment_id = ANY(${paymentIds}::text[]) AND status <> 'CONFIRMED'
            RETURNING coupon_id, status::text AS status`;
        const byCoupon = new Map<string, number>();
        for (const r of deleted) {
            if (r.status === 'RESERVED') byCoupon.set(r.coupon_id, (byCoupon.get(r.coupon_id) ?? 0) + 1);
        }
        for (const [couponId, n] of byCoupon) {
            await tx.coupon.update({ where: { id: couponId }, data: { usedCount: { decrement: n } } });
        }
        if (deleted.length > 0) console.log(`[HOLD-CLEANUP] Purged ${deleted.length} coupon redemption(s) ahead of payment deletion`);
    });
}

/** Coupon uses must be given back (and redemption rows removed — FK RESTRICT)
 *  before the payments they anchor are hard-deleted. */
async function purgeCouponsForContract(contractId: string): Promise<void> {
    const doomed = await prisma.payment.findMany({
        where: { contractId, status: { not: 'PAID' } },
        select: { id: true },
    });
    await releaseAndPurgeRedemptionsOnce(doomed.map(p => p.id));
}

// ─── Trava por contrato (Redis, com dono) ────────────────
// Serializa a purga de um mesmo contrato entre processos/rotas (cron, /custom/check, troca de
// serviço): a 2ª chamada simultânea não repete as chamadas ao provedor nem o hard-delete.
const COMPARE_AND_DEL = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

async function acquireOwnedLock(key: string, ttlSeconds: number): Promise<string | null> {
    const token = randomUUID();
    try {
        return (await redis.set(key, token, 'EX', ttlSeconds, 'NX')) === 'OK' ? token : null;
    } catch (err) {
        console.warn(`[HOLD-CLEANUP] Redis indisponível para a trava ${key}:`, err instanceof Error ? err.message : err);
        return null;
    }
}

async function releaseOwnedLock(key: string, token: string): Promise<void> {
    try {
        await redis.eval(COMPARE_AND_DEL, 1, key, token);
    } catch { /* expira sozinha pelo TTL */ }
}

// ─── Conciliação no provedor ANTES de apagar (D2) ─────────
// Um Payment PENDING de uma contratação abandonada pode ter uma cobrança VIVA no provedor (QR PIX
// ainda pagável, PaymentIntent de cartão em 3DS). Apagar o Payment sem olhar o provedor deixava
// dinheiro recebido sem registro (o webhook não acha mais o txid/PI). Antes de qualquer hard-delete:
//  • PIX (Sicoob/Cora) com providerRef → concilia (pago → promove, NÃO apaga); não pago → cancela a cob.
//  • Cartão (Stripe) com providerRef → consulta o PI: succeeded → marca PAID (atômico) + efeitos;
//    processing / requires_action recente → pula esta rodada; demais → cancela o PI e segue.

/** 'paid' = confirmado agora (efeitos rodaram) · 'inflight' = não apagar nesta rodada · 'clear' = pode apagar. */
export type ChargeSettlement = 'paid' | 'inflight' | 'clear';

/** requires_action (3DS) só segura a varredura por este tempo desde a criação do PI. */
const STRIPE_ACTION_GRACE_MS = 30 * 60 * 1000;

type SettlePayment = {
    id: string;
    provider: string;
    providerRef: string | null;
    pixString: string | null;
    amount: number;
    chargedAmount: number | null;
};

const isSicoobTxid = (ref: string | null): ref is string => !!ref && /^[a-zA-Z0-9]{26,35}$/.test(ref);

async function settleSicoobCharge(p: SettlePayment): Promise<ChargeSettlement> {
    const ref = p.providerRef;
    if (!isSicoobTxid(ref)) return 'clear'; // mock de dev ("mock-xxxx") — nada no provedor
    const { getSicoobEnvironment, sicoobGetCob, sicoobRemoveCob } = await import('../lib/sicoobService.js');
    const env = await getSicoobEnvironment();
    if (!env) return 'clear'; // integração desligada: nada a conciliar/cancelar
    if (env === 'sandbox') {
        // O GET /cob do sandbox é um mock aleatório (não serve como fonte de verdade); em sandbox a
        // confirmação é pelo "Simular pagamento" (já refletida no banco). Só cancela, best-effort.
        await sicoobRemoveCob(ref);
        return 'clear';
    }
    const { isSicoobCobPaid, isSicoobCobCancelled, isSicoobCobExpired, reconcileSicoobPayment } = await import('../lib/sicoobReconciliation.js');
    let cob: any;
    try {
        cob = await sicoobGetCob(ref);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/\b404\b/.test(msg)) return 'clear'; // cobrança inexistente no provedor
        console.warn(`[HOLD-CLEANUP] Sicoob indisponível ao conciliar ${p.id} — tenta na próxima rodada:`, msg);
        return 'inflight';
    }
    if (isSicoobCobPaid(cob)) {
        if (await reconcileSicoobPayment(p.id)) return 'paid';
        const fresh = await prisma.payment.findUnique({ where: { id: p.id }, select: { status: true } });
        if (fresh?.status === 'PAID') return 'paid';
        // Pago no provedor mas recusado pela conciliação (valor divergente) → NÃO apagar: exige análise.
        console.error(`[HOLD-CLEANUP][SECURITY] Cobrança ${ref} consta paga no Sicoob mas não conciliou (payment ${p.id}) — mantida para análise manual.`);
        return 'inflight';
    }
    if (isSicoobCobCancelled(cob)) return 'clear';
    if (await sicoobRemoveCob(ref)) return 'clear';
    if (isSicoobCobExpired(cob)) return 'clear';
    return 'inflight'; // cobrança viva que não conseguimos cancelar → não apagar ainda
}

async function settleCoraCharge(p: SettlePayment): Promise<ChargeSettlement> {
    if (!p.providerRef) return 'clear';
    const { reconcileCoraPayment, isCoraInvoiceCancelled } = await import('../lib/coraReconciliation.js');
    if (await reconcileCoraPayment(p.id)) return 'paid';
    const { coraCancelBoleto, coraGetBoleto, isCoraEnabled } = await import('../lib/coraService.js');
    try {
        await coraCancelBoleto(p.providerRef);
    } catch (err) {
        console.warn(`[HOLD-CLEANUP] cancelar fatura Cora ${p.providerRef} falhou:`, err instanceof Error ? err.message : err);
        if (await reconcileCoraPayment(p.id)) return 'paid';
        // Igual ao Sicoob: fatura que continua pagável não pode ser apagada do nosso lado (o pagamento
        // ficaria sem registro). Integração desligada: não há o que cancelar/consultar → segue.
        if (await isCoraEnabled().catch(() => false)) {
            try {
                if (!isCoraInvoiceCancelled(await coraGetBoleto(p.providerRef))) return 'inflight';
            } catch {
                return 'inflight';
            }
        }
    }
    return 'clear';
}

/** PI de cartão confirmado: marca PAID atômico (com as mesmas checagens do webhook) + efeitos. */
async function confirmSucceededIntent(p: SettlePayment, pi: { id: string; amount: number; metadata?: Record<string, string> | null; payment_method_types?: string[] }): Promise<ChargeSettlement> {
    if (pi.metadata?.paymentId && pi.metadata.paymentId !== p.id) {
        console.error(`[HOLD-CLEANUP][SECURITY] PI ${pi.id} pertence a outro pagamento (${pi.metadata.paymentId}) — payment ${p.id} mantido.`);
        return 'inflight';
    }
    const expected = p.chargedAmount ?? p.amount;
    if (pi.amount !== expected) {
        console.error(`[HOLD-CLEANUP][SECURITY] PI ${pi.id} pago com valor divergente (PI=${pi.amount}, DB=${expected}) — payment ${p.id} mantido para análise.`);
        return 'inflight';
    }
    const upd = await prisma.payment.updateMany({
        where: { id: p.id, status: 'PENDING' },
        data: {
            status: 'PAID',
            paidAt: new Date(),
            providerRef: pi.id,
            paymentType: pi.payment_method_types?.includes('card') ? 'CREDIT' : null,
        },
    });
    if (upd.count > 0) {
        console.log(`[HOLD-CLEANUP] PI ${pi.id} já estava pago — payment ${p.id} confirmado pela varredura (não apagado).`);
        await onPaymentConfirmed(p.id);
    }
    return 'paid';
}

async function settleStripeCharge(p: SettlePayment): Promise<ChargeSettlement> {
    const ref = p.providerRef;
    if (!ref || !ref.startsWith('pi_') || ref.startsWith('pi_mock')) return 'clear';
    const { isStripeEnabled, stripeGetPaymentIntent, stripeCancelPaymentIntent } = await import('../lib/stripeService.js');
    if (!(await isStripeEnabled())) return 'clear';
    let pi;
    try {
        pi = await stripeGetPaymentIntent(ref);
    } catch (err) {
        const e = err as { code?: string; raw?: { code?: string } };
        if (e?.code === 'resource_missing' || e?.raw?.code === 'resource_missing') return 'clear';
        console.warn(`[HOLD-CLEANUP] Stripe indisponível ao conciliar ${p.id} — tenta na próxima rodada:`, err instanceof Error ? err.message : err);
        return 'inflight';
    }
    if (pi.status === 'succeeded') return confirmSucceededIntent(p, pi);
    if (pi.status === 'canceled') return 'clear';
    if (pi.status === 'processing') return 'inflight';
    if (pi.status === 'requires_action' && Date.now() - pi.created * 1000 < STRIPE_ACTION_GRACE_MS) return 'inflight';
    try {
        const r = await stripeCancelPaymentIntent(ref);
        if (r.canceled) return 'clear';
        if (r.status === 'succeeded') return confirmSucceededIntent(p, await stripeGetPaymentIntent(ref));
        return 'inflight';
    } catch (err) {
        console.warn(`[HOLD-CLEANUP] cancelar PI ${ref} falhou — tenta na próxima rodada:`, err instanceof Error ? err.message : err);
        return 'inflight';
    }
}

/**
 * Concilia/cancela no provedor TODAS as cobranças PENDING com providerRef de um contrato, antes do
 * hard-delete. 'paid' assim que qualquer uma estiver paga (os efeitos de confirmação já rodaram).
 */
export async function settleContractCharges(contractId: string): Promise<ChargeSettlement> {
    const pending = await prisma.payment.findMany({
        where: { contractId, status: 'PENDING', providerRef: { not: null } },
        select: { id: true, provider: true, providerRef: true, pixString: true, amount: true, chargedAmount: true },
    });
    let result: ChargeSettlement = 'clear';
    for (const p of pending) {
        let r: ChargeSettlement;
        try {
            r = p.provider === 'SICOOB' ? await settleSicoobCharge(p)
                : p.provider === 'CORA' ? await settleCoraCharge(p)
                : p.provider === 'STRIPE' ? await settleStripeCharge(p)
                : 'clear';
        } catch (err) {
            console.error(`[HOLD-CLEANUP] Falha ao conciliar o payment ${p.id} — mantido nesta rodada:`, err);
            r = 'inflight';
        }
        if (r === 'paid') return 'paid';
        if (r === 'inflight') result = 'inflight';
    }
    return result;
}

export type AwaitingPurgeResult = 'purged' | 'paid' | 'inflight' | 'skipped';

/**
 * Rotina SEGURA de descarte de um contrato AWAITING_PAYMENT não pago (varredura de órfãos e a
 * troca de contratação de serviço, D2): re-verifica o status, promove se houver PAID (no banco ou
 * descoberto no provedor), segura se houver cobrança em andamento e só então faz o hard-delete
 * (cupons → pagamentos não pagos → sessões → contrato), sempre guardado pelo status.
 */
export async function purgeAwaitingContract(contractId: string): Promise<AwaitingPurgeResult> {
    // Serializa por contrato (jobs-tempo-migrations-3): outra purga do MESMO contrato em andamento →
    // 'inflight' (quem chama trata como "em andamento"; nada é apagado nem conciliado em dobro).
    // TTL folgado (chamadas ao provedor têm timeout de 30s cada) e liberação só pelo dono.
    const lockKey = `mutex:purge-awaiting:${contractId}`;
    const token = await acquireOwnedLock(lockKey, 300);
    if (!token) return 'inflight';
    try {
        return await purgeAwaitingContractLocked(contractId);
    } finally {
        await releaseOwnedLock(lockKey, token);
    }
}

async function purgeAwaitingContractLocked(contractId: string): Promise<AwaitingPurgeResult> {
    const fresh = await prisma.contract.findUnique({ where: { id: contractId }, select: { status: true } });
    if (!fresh || fresh.status !== 'AWAITING_PAYMENT') return 'skipped';

    // Never delete a contract that has a PAID payment — promote it instead (D9: FULL → todas as
    // sessões; PROGRESSIVE → só o 1º ciclo).
    const paid = await prisma.payment.findFirst({ where: { contractId, status: 'PAID' }, select: { id: true } });
    if (paid) {
        await activateAwaitingContract(contractId);
        return 'paid';
    }

    const settled = await settleContractCharges(contractId);
    if (settled === 'paid') {
        await activateAwaitingContract(contractId); // no-op se os efeitos já ativaram
        return 'paid';
    }
    if (settled === 'inflight') return 'inflight';

    await purgeCouponsForContract(contractId);
    await prisma.payment.deleteMany({ where: { contractId, status: { not: 'PAID' } } });
    // Corrida: um pagamento pode ter confirmado entre a conciliação e o delete → promove em vez de apagar.
    const paidLate = await prisma.payment.findFirst({ where: { contractId, status: 'PAID' }, select: { id: true } });
    if (paidLate) {
        await activateAwaitingContract(contractId);
        return 'paid';
    }
    await prisma.booking.deleteMany({ where: { contractId } });
    const del = await prisma.contract.deleteMany({ where: { id: contractId, status: 'AWAITING_PAYMENT' } });
    return del.count > 0 ? 'purged' : 'skipped';
}

/**
 * Cron job: clean expired HELD/RESERVED bookings and AWAITING_PAYMENT contracts.
 * Runs every 60 seconds.
 *
 * Safety invariants (added to stop deleting just-paid bookings):
 *  - Never cancel/delete anything that has a PAID payment — promote it instead.
 *  - Guard every cancel/delete by current status (atomic updateMany / deleteMany
 *    conditions) so a webhook confirming between the snapshot and the write wins.
 *  - Before deleting an unpaid Payment that carries a provider charge, reconcile it at the
 *    provider (paid → promote) and cancel the abandoned charge (D2).
 */
/** Concessão do hold de uma reserva avulsa cujo pagamento está em andamento no provedor (regressoes-1). */
const INFLIGHT_HOLD_EXTENSION_MS = 2 * 60 * 1000;

export async function cleanExpiredHolds() {
    const now = new Date();

    // 1. Expire HELD or RESERVED bookings past their holdExpiresAt (avulso unpaid)
    const expiredBookings = await prisma.booking.findMany({
        where: {
            status: { in: ['HELD', 'RESERVED'] },
            holdExpiresAt: { not: null, lt: now },
        },
        include: { contract: true },
    });

    for (const booking of expiredBookings) {
        try {
            const bc = booking.contract;
            // Sessões de um contrato de VÁRIAS sessões aguardando pagamento (ex.: personalizado do
            // cliente, D9) são tratadas como um todo pela varredura de órfãos (seção 2), pelo prazo do
            // contrato — nunca uma a uma aqui (isso devolveria créditos e cancelaria sessão a sessão).
            if (bc && bc.type !== 'AVULSO' && bc.status === 'AWAITING_PAYMENT' && bc.paymentDeadline) {
                continue;
            }

            // ── Guard: did a payment confirm this booking/contract since the snapshot? ──
            const paidExists = await prisma.payment.findFirst({
                where: {
                    status: 'PAID',
                    OR: [
                        { bookingId: booking.id },
                        ...(booking.contractId ? [{ contractId: booking.contractId }] : []),
                    ],
                },
                select: { id: true },
            });

            if (paidExists) {
                if (bc && bc.type !== 'AVULSO' && bc.accessMode === 'PROGRESSIVE') {
                    // PROGRESSIVE: ativa (libera só o 1º ciclo) e tira o timer desta sessão sem
                    // confirmá-la fora de ciclo — as demais são liberadas parcela a parcela.
                    await activateAwaitingContract(bc.id);
                    await prisma.booking.updateMany({
                        where: { id: booking.id, status: { in: ['RESERVED', 'HELD'] } },
                        data: { status: 'RESERVED', holdExpiresAt: null },
                    });
                    console.log(`[HOLD-CLEANUP] Booking ${booking.id} (PROGRESSIVE) has a PAID payment — hold cleared, cycle rules kept`);
                    continue;
                }
                // A payment landed — promote rather than delete (repairs a webhook/cron race).
                // ATU-02/R5: a reserva só vira Confirmada com a cobrança da GRAVAÇÃO paga (a mesma regra do /confirm:
                // booking.service.sessionAwaitsOwnPayment). Se o PAID achado é de outra cobrança (extra, parcela do
                // contrato) e a da sessão segue sem pagar, só tira o timer e mantém Reservada.
                const sessionChargeOpen = await sessionAwaitsOwnPayment(booking);
                await prisma.booking.updateMany({
                    where: { id: booking.id, status: { in: ['RESERVED', 'HELD'] } },
                    data: { status: sessionChargeOpen ? 'RESERVED' : 'CONFIRMED', holdExpiresAt: null },
                });
                if (booking.contractId) {
                    await activateAwaitingContract(booking.contractId);
                }
                console.log(sessionChargeOpen
                    ? `[HOLD-CLEANUP] Booking ${booking.id} has a PAID payment but the session charge is open — hold cleared, kept RESERVED`
                    : `[HOLD-CLEANUP] Booking ${booking.id} has a PAID payment — promoted to CONFIRMED (not cancelled)`);
                continue;
            }

            // D2/D15: avulso abandonado — antes de cancelar/apagar, concilia a cobrança no provedor
            // (um PIX pago no fim da janela ou um cartão em 3DS não podem virar dinheiro sem registro)
            // e cancela a cobrança viva. Pago → os efeitos já confirmaram a reserva; em andamento →
            // tenta na próxima rodada.
            if (bc && bc.type === 'AVULSO' && bc.status === 'AWAITING_PAYMENT') {
                const settled = await settleContractCharges(bc.id);
                if (settled === 'paid') {
                    console.log(`[HOLD-CLEANUP] Booking ${booking.id}: cobrança paga no provedor — reserva promovida (não cancelada)`);
                    continue;
                }
                if (settled === 'inflight') {
                    // regressoes-1: enquanto o pagamento está em andamento no provedor (3DS, PIX vivo que
                    // não pôde ser removido, provedor indisponível) a reserva continua SEGURANDO o horário
                    // — hold vencido é tratado como livre pela agenda e pelo conflito do POST /bookings, e
                    // um pagamento confirmado depois promoveria esta reserva por cima de outra. Renova uma
                    // concessão curta a cada rodada; quando o provedor resolver, o hold vence e a próxima
                    // varredura cancela normalmente (teto: a carência de 30 min do 3DS).
                    await prisma.booking.updateMany({
                        where: { id: booking.id, status: { in: ['RESERVED', 'HELD'] } },
                        data: { holdExpiresAt: new Date(Date.now() + INFLIGHT_HOLD_EXTENSION_MS) },
                    });
                    console.log(`[HOLD-CLEANUP] Booking ${booking.id}: pagamento em andamento no provedor — mantido (horário segurado) nesta rodada`);
                    continue;
                }
            }

            // Atomic cancel guarded by status: if the webhook confirmed it between the
            // findMany snapshot and now, count===0 and we skip this booking entirely.
            const cancelled = await prisma.booking.updateMany({
                where: { id: booking.id, status: { in: ['HELD', 'RESERVED'] }, holdExpiresAt: { lt: now } },
                data: { status: 'CANCELLED' },
            });
            if (cancelled.count === 0) continue;

            // B10: um pagamento PIX pode ter confirmado ENTRE o paidExists (acima) e o cancel atômico.
            // Re-consulta: se apareceu um PAID, a reserva que acabamos de cancelar está de fato paga →
            // promove de volta a CONFIRMED (repara a corrida), em vez de deixar um órfão pago-mas-cancelado
            // que o confirmBooking posterior (que casa RESERVED/HELD) nunca conserta.
            const paidAfter = await prisma.payment.findFirst({
                where: {
                    status: 'PAID',
                    OR: [
                        { bookingId: booking.id },
                        ...(booking.contractId ? [{ contractId: booking.contractId }] : []),
                    ],
                },
                select: { id: true },
            });
            if (paidAfter) {
                // ATU-02/R5: mesma regra da promoção acima (sessionAwaitsOwnPayment) — sem a cobrança da gravação
                // paga, volta Reservada (sem o timer), nunca Confirmada.
                const sessionChargeOpen = await sessionAwaitsOwnPayment(booking);
                await prisma.booking.updateMany({
                    where: { id: booking.id, status: 'CANCELLED' },
                    data: { status: sessionChargeOpen ? 'RESERVED' : 'CONFIRMED', holdExpiresAt: null },
                });
                if (booking.contractId) {
                    await activateAwaitingContract(booking.contractId);
                }
                console.log(`[HOLD-CLEANUP] Booking ${booking.id} foi pago na janela do cancel — restaurado para ${sessionChargeOpen ? 'RESERVED (cobrança da sessão em aberto)' : 'CONFIRMED'} (mantém o slot).`);
                continue;
            }

            // Release Redis lock
            const dateStr = booking.date.toISOString().split('T')[0];
            const packageSlots = getPackageSlots(booking.startTime);
            await releaseMultiSlotLock(dateStr, packageSlots, booking.userId);

            // Restore contract credits if applicable, or delete abandoned Avulso
            if (booking.contract) {
                const c = booking.contract;

                if (c.type === 'AVULSO') {
                    // Re-verify the contract is still AWAITING_PAYMENT and has NO paid
                    // payment before any destructive delete.
                    const fresh = await prisma.contract.findUnique({ where: { id: c.id }, select: { status: true } });
                    const paid = await prisma.payment.findFirst({ where: { contractId: c.id, status: 'PAID' }, select: { id: true } });

                    if (fresh?.status === 'AWAITING_PAYMENT' && !paid) {
                        await purgeCouponsForContract(c.id);
                        await prisma.payment.deleteMany({ where: { contractId: c.id, status: { not: 'PAID' } } });
                        await prisma.booking.deleteMany({ where: { contractId: c.id } });
                        await prisma.contract.deleteMany({ where: { id: c.id, status: 'AWAITING_PAYMENT' } });
                        console.log(`[HOLD-CLEANUP] Deleted abandoned Avulso contract ${c.id}`);
                    } else {
                        console.log(`[HOLD-CLEANUP] Skipped Avulso ${c.id} cleanup (status=${fresh?.status}, hasPaid=${!!paid})`);
                    }
                } else if ((c.type === 'FLEX') && (c.flexCreditsRemaining ?? 0) >= 0) {
                    await prisma.contract.update({
                        where: { id: c.id },
                        data: { flexCreditsRemaining: (c.flexCreditsRemaining ?? 0) + 1 },
                    });
                } else if (c.type === 'CUSTOM' && (c.customCreditsRemaining ?? 0) >= 0) {
                    await prisma.contract.update({
                        where: { id: c.id },
                        data: { customCreditsRemaining: (c.customCreditsRemaining ?? 0) + 1 },
                    });
                }
            }

            console.log(`[HOLD-CLEANUP] Booking ${booking.id} expired and cancelled/deleted`);
        } catch (err) {
            console.error(`[HOLD-CLEANUP] Failed to clean booking ${booking.id}:`, err);
        }
    }

    const totalCleaned = expiredBookings.length;
    if (totalCleaned > 0) {
        console.log(`[HOLD-CLEANUP] Processed ${totalCleaned} expired bookings.`);
    }

    // 2. Secondary sweep for orphaned AWAITING_PAYMENT contracts (serviço 10 min, personalizado do
    //    cliente 10 min, renovação 3 dias, avulso sem reserva). Rotina segura: promove se pago,
    //    segura se em andamento no provedor, senão cancela as cobranças e faz o hard-delete.
    const orphanedContracts = await prisma.contract.findMany({
        where: {
            status: 'AWAITING_PAYMENT',
            paymentDeadline: { lt: now },
            // Avulso cuja reserva ainda tem hold (renovado pela retentativa do cliente ou segurado
            // enquanto o pagamento está em andamento) é da seção 1 — pelo hold, não pelo prazo antigo
            // do contrato (evita apagar a reserva viva e conciliar o mesmo avulso duas vezes).
            NOT: {
                type: 'AVULSO',
                bookings: { some: { status: { in: ['RESERVED', 'HELD'] }, holdExpiresAt: { not: null } } },
            },
        },
        select: { id: true },
    });

    for (const c of orphanedContracts) {
        try {
            const result = await purgeAwaitingContract(c.id);
            if (result === 'purged') console.log(`[HOLD-CLEANUP] Swept orphaned expired contract ${c.id}`);
            else if (result === 'paid') console.log(`[HOLD-CLEANUP] Orphan contract ${c.id} has a PAID payment — promoted to ACTIVE (not deleted)`);
            else if (result === 'inflight') console.log(`[HOLD-CLEANUP] Orphan contract ${c.id}: payment in progress at the provider — kept this round`);
        } catch (err) {
            console.error(`[HOLD-CLEANUP] Failed to sweep orphaned contract ${c.id}:`, err);
        }
    }

    // 3. Abandoned PRE-CONTRACT checkout drafts holding a coupon reservation.
    //    /self and /service create the first payment with the contract only in
    //    metadata (no contractId, no bookingId). If the client never pays, nothing
    //    else ever transitions that payment, so a reserved coupon use would leak
    //    forever. After 24h we fail the draft (atomic PENDING guard) and give the
    //    use back. Contract installments and avulso payments are excluded — their
    //    own lifecycle (webhooks/void/sweeps above) handles their releases.
    const staleDraftCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const staleDrafts = await prisma.payment.findMany({
        where: {
            status: 'PENDING',
            couponId: { not: null },
            contractId: null,
            bookingId: null,
            createdAt: { lt: staleDraftCutoff },
        },
        select: { id: true },
    });
    for (const draft of staleDrafts) {
        try {
            const failed = await prisma.payment.updateMany({
                where: { id: draft.id, status: 'PENDING' },
                data: { status: 'FAILED' },
            });
            if (failed.count > 0) {
                await releaseCouponForPayments([draft.id]);
                console.log(`[HOLD-CLEANUP] Failed stale coupon-reserved draft payment ${draft.id} (>24h) and released the coupon use`);
            }
        } catch (err) {
            console.error(`[HOLD-CLEANUP] Failed to release stale draft ${draft.id}:`, err);
        }
    }
}
