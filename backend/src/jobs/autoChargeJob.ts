import { prisma } from '../lib/prisma.js';
import { notifyEvent } from '../modules/notifications/notificationService.js';
import { stripeChargeOffSession, stripeCancelPaymentIntent } from '../lib/stripeService.js';
import { onPaymentConfirmed } from '../lib/paymentEffects.js';
import { isPixProvider, retirePixCharge, pixMetadataAfterDiscard, cardIntentInFlight, cardIntentAwaitingCustomer, cardChargeBaseAmount } from '../lib/pixGateway.js';
import { autoChargeCardFor } from '../lib/savedCards.js';
import { isCancellationFine } from '../lib/cancellationFine.js';
import { getStaffRecipientIds } from '../lib/staffRecipients.js';

/** Marca de auditoria (entidade PAYMENT) do aviso de cobrança em dobro — 1 por PaymentIntent excedente. */
export const AUDIT_DOUBLE_CARD_CHARGE = 'DOUBLE_CARD_CHARGE';

const fmtBRL = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

/**
 * Z1-c — cobrança em DOBRO no cartão: a cobrança `paymentId` está PAID por um PaymentIntent (`paidByPi`) e
 * OUTRO PaymentIntent dela (`extraPi`) também foi aprovado — o cliente foi debitado duas vezes e só há uma
 * baixa. Em vez de só logar, avisa TODOS os admins (persistida + push: cliente, valor, os dois PIs e a
 * orientação de estornar o excedente no painel do Stripe) e grava a marca na auditoria, que garante UM
 * aviso por PaymentIntent excedente (webhook reentregue; job + webhook do mesmo PI). Mesmo desenho de
 * `alertPaymentOnCancelledCharge` (lib/paymentEffects). Chamado pelo webhook `payment_intent.succeeded`
 * (linha já PAID por outro PI) e pelo cancelamento do PI anterior abaixo. Nunca lança; true = avisou agora.
 */
export async function alertDoubleCardCharge(
    paymentId: string,
    info: { extraPi: string; paidByPi?: string | null; amountCents?: number | null },
): Promise<boolean> {
    try {
        const payment = await prisma.payment.findUnique({
            where: { id: paymentId },
            select: {
                id: true, status: true, amount: true, chargedAmount: true, providerRef: true,
                user: { select: { name: true } },
                contract: { select: { name: true } },
            },
        });
        if (!payment || payment.status !== 'PAID') return false;
        const paidByPi = info.paidByPi ?? payment.providerRef;
        if (!paidByPi || paidByPi === info.extraPi) return false;
        const already = await prisma.auditLog.count({
            where: { entityType: 'PAYMENT', entityId: paymentId, action: AUDIT_DOUBLE_CARD_CHARGE, changes: { contains: `"extraPaymentIntentId":${JSON.stringify(info.extraPi)}` } },
        });
        if (already > 0) return false;

        const amount = info.amountCents && info.amountCents > 0 ? info.amountCents : (payment.chargedAmount ?? payment.amount);
        console.error(`[AUTO-CHARGE][SECURITY] Payment ${paymentId}: cobrança em DOBRO no cartão — já pago por ${paidByPi} e o PaymentIntent ${info.extraPi} (${fmtBRL(amount)}) também foi aprovado. Avisando o admin: estorne ${info.extraPi} no painel do Stripe.`);
        await prisma.auditLog.create({
            data: {
                entityType: 'PAYMENT', entityId: paymentId, action: AUDIT_DOUBLE_CARD_CHARGE, performedBy: 'SYSTEM',
                changes: JSON.stringify({ extraPaymentIntentId: info.extraPi, paidByPaymentIntentId: paidByPi, amount }),
            },
        });
        // Equipe: ADMIN + COLABORADOR com a permissão do evento (financeiro.ver); nunca desativado/excluído.
        for (const staffId of await getStaffRecipientIds('admin_card_double_charge')) {
            await notifyEvent('admin_card_double_charge', {
                userId: staffId,
                vars: {
                    cliente: payment.user?.name ?? 'Cliente', valor: fmtBRL(amount),
                    contrato: payment.contract?.name ?? 'sem contrato', piPago: paidByPi, piExtra: info.extraPi,
                },
                entityType: 'PAYMENT',
                entityId: paymentId,
                dedupKey: `double-card-charge:${info.extraPi}:${staffId}`,
            }).catch(() => '');
        }
        return true;
    } catch (err) {
        console.error(`[AUTO-CHARGE] Falha ao avisar o admin da cobrança em dobro do payment ${paymentId} (PI ${info.extraPi}):`, err);
        return false;
    }
}

/**
 * AC-2: a parcela acabou de ser quitada pela cobrança automática; o PaymentIntent ANTERIOR dela (checkout
 * de cartão aberto e não concluído) é cancelado em best-effort, para uma aba de checkout esquecida não
 * debitar o cliente de novo. Cancelar DEPOIS de PAID não esbarra na chave de idempotência do checkout (o
 * create-payment recusa cobrança já paga). Se o Stripe responder que esse PI já tinha APROVADO, o cliente
 * foi debitado DUAS vezes: o admin é avisado para estornar (Z1-c: alertDoubleCardCharge). Ainda
 * processando → fica em erro no log; se aprovar, o webhook `payment_intent.succeeded` dá o mesmo aviso.
 * Nunca lança.
 */
async function cancelSupersededCardIntent(paymentId: string, previousPi: string, paidByPi: string): Promise<void> {
    try {
        const r = await stripeCancelPaymentIntent(previousPi);
        if (r.canceled) return;
        if (r.status === 'succeeded') {
            await alertDoubleCardCharge(paymentId, { extraPi: previousPi, paidByPi });
        } else if (r.status === 'processing' || r.status === 'requires_capture') {
            console.error(`[AUTO-CHARGE][SECURITY] Payment ${paymentId}: possível cobrança em DOBRO — quitado pela cobrança automática (${paidByPi}) e o PaymentIntent anterior ${previousPi} está "${r.status}". Se ele for aprovado, o admin será avisado para estornar.`);
        }
    } catch (err) {
        console.warn(`[AUTO-CHARGE] Payment ${paymentId}: não foi possível cancelar o PaymentIntent anterior ${previousPi} (best-effort):`, err instanceof Error ? err.message : err);
    }
}

/**
 * Auto-Charge Job — runs daily.
 *
 * For every PENDING installment of an ACTIVE/COMPLETED/EXPIRED contract — and of a client-started
 * RENEWAL still AWAITING_PAYMENT (3-day deadline; regressoes-2) — whose dueDate has arrived, if the
 * client opted into auto-charge (User.autoChargeEnabled) AND has a saved card, charge their default
 * card OFF-SESSION via Stripe. On synchronous success the payment is confirmed atomically
 * (PENDING→PAID → onPaymentConfirmed, exactly once even if the webhook also fires); on a
 * decline / authentication-required the client is notified to pay manually.
 *
 * Never charged: the short-lived hires still AWAITING_PAYMENT (serviço, personalizado do cliente,
 * avulso — 10-min deadline, D2: their first payment is made by the client in the checkout).
 *
 * Never charged either (AC-1): charges tied to a RECORDING (`Payment.bookingId` set — extras de gravação,
 * cobrança de uma reserva). Only PLAN installments (bookingId null) are taken from the saved card; a
 * booking charge always starts from the client (an abandoned extras checkout must never be debited).
 *
 * Never charged either (E13): the CANCELLATION FINE (`Payment.metadata.kind === 'CANCELLATION_FINE'`) —
 * it stays pending for the client to pay (Meus Pagamentos) or for the admin's "Cobrar agora"; the job
 * never takes it from the saved card, whatever the contract status.
 *
 * E9: this job IS the automatic charging ("Ativar cobrança automática" → POST /contracts/:id/subscribe
 * only turns on User.autoChargeEnabled + the default card). There is no Stripe subscription anymore;
 * legacy rows that still carry a stripeSubscriptionId are skipped (never double-charged).
 *
 * Before charging the card (pagamentos-5): an installment with a LIVE PIX QR (the client may be paying
 * it right now) is skipped this round; an older PIX charge is reconciled + cancelled at the provider
 * first (already paid → no card charge; could not be cancelled → skipped). A card PaymentIntent of the
 * same installment still in flight (processing / 3DS) is also skipped.
 *
 * AC-2: a card checkout of the same installment still OPEN (PaymentIntent awaiting the customer, created
 * less than 30 min ago — new-card form on screen) is skipped this round too, like the live PIX QR. After
 * a successful charge, the previous PaymentIntent of the installment is cancelled (best-effort) so an
 * open checkout tab cannot debit the client a second time. The cancellation never sits between PAID and
 * the confirmation effects (Z1-b); a previous PaymentIntent found already approved alerts the admins
 * (Z1-c: alertDoubleCardCharge — double charge, refund in the Stripe dashboard).
 *
 * Idempotency: Stripe's Idempotency-Key embeds paymentId+amount (see stripeCreatePaymentIntent),
 * so re-running across days never double-charges — a repeat returns the same PaymentIntent.
 */
export async function runAutoChargeJob(): Promise<void> {
    const now = new Date();
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);

    const duePayments = await prisma.payment.findMany({
        where: {
            status: 'PENDING',
            dueDate: { lte: endOfToday },
            contractId: { not: null },
            // AC-1: só parcelas do PLANO. Cobranças de uma gravação (extras / reserva — têm bookingId)
            // partem sempre do cliente: um checkout de extra abandonado nunca é debitado off-session.
            bookingId: null,
            // B1: parcelas de assinatura Stripe (têm stripeSubscriptionId) são cobradas pelo próprio
            // Stripe via invoice recorrente — o auto-charge NÃO deve tocá-las, senão cobra em dobro.
            stripeSubscriptionId: null,
            // Nunca cobrar parcelas de contratos pausados / em cancelamento / cancelados. AGUARDANDO
            // PAGAMENTO: só a RENOVAÇÃO iniciada pelo cliente (prazo de 3 dias) segue cobrável, como antes
            // do D2; as contratações de prazo curto (serviço, personalizado do cliente, avulso — 10 min)
            // nunca são cobradas off-session: o 1º pagamento parte do cliente e a varredura as apaga.
            // ACTIVE, COMPLETED (D6) e EXPIRED seguem cobráveis (parcelas pendentes continuam).
            contract: {
                status: { notIn: ['PAUSED', 'PENDING_CANCELLATION', 'CANCELLED'] },
                NOT: { status: 'AWAITING_PAYMENT', renewedFromId: null },
            },
            user: { autoChargeEnabled: true, stripeCustomerId: { not: null } },
        },
        include: {
            user: { select: { id: true, name: true, stripeCustomerId: true } },
            contract: { select: { type: true, paymentPlan: true, paymentMethod: true } },
        },
        orderBy: { dueDate: 'asc' },
        take: 200,
    });

    let charged = 0, failed = 0, skipped = 0;

    for (const p of duePayments) {
        // E13: a multa de cancelamento NUNCA é cobrada sozinha (fica pendente + aviso + "Cobrar agora").
        if (isCancellationFine(p)) { skipped++; continue; }

        const customerId = p.user.stripeCustomerId;
        if (!customerId) { skipped++; continue; }

        // Prefer the default saved card; fall back to the most recent one.
        const card = await autoChargeCardFor(p.userId);
        if (!card) { skipped++; continue; } // no saved card → client pays manually

        // AC-2: o snapshot do findMany pode ter minutos (lote de até 200, com chamadas de rede por
        // parcela): relê a situação e a cobrança ATUAL da parcela antes de decidir.
        const cur = await prisma.payment.findUnique({
            where: { id: p.id },
            select: { status: true, provider: true, providerRef: true, pixExpiresAt: true },
        });
        if (!cur || cur.status !== 'PENDING') { skipped++; continue; }

        // pagamentos-5: cobrança PIX desta parcela. QR vivo → o cliente pode estar pagando agora: não
        // cobra o cartão nesta rodada. Cobrança anterior → concilia (paga → os efeitos já confirmaram) e
        // cancela no provedor antes do cartão; se não der para cancelar, tenta na próxima rodada.
        if (isPixProvider(cur.provider) && cur.providerRef) {
            if (cur.pixExpiresAt && cur.pixExpiresAt.getTime() > Date.now()) { skipped++; continue; }
            try {
                const retired = await retirePixCharge(p.id);
                if (retired === 'paid' || retired === 'live') { skipped++; continue; }
            } catch (err) {
                console.warn(`[AUTO-CHARGE] Payment ${p.id}: não foi possível conciliar o PIX — tenta na próxima rodada:`, err instanceof Error ? err.message : err);
                skipped++;
                continue;
            }
        }
        // Cartão desta parcela ainda em andamento (processando / 3DS do cliente) → não cobra outro.
        // AC-2: idem com o checkout de cartão ABERTO (PaymentIntent aguardando o cliente, criado há menos
        // de 30 min): ele pode confirmar o cartão novo a qualquer momento — tenta na próxima rodada.
        if (cur.provider === 'STRIPE'
            && (await cardIntentInFlight(cur.providerRef) || await cardIntentAwaitingCustomer(cur.providerRef))) { skipped++; continue; }
        // PaymentIntent anterior desta parcela (checkout antigo, não concluído): cancelado depois que a
        // cobrança automática quitar — nunca antes (a chave de idempotência do checkout devolveria o PI
        // cancelado se o off-session for recusado e o cliente voltar ao cartão).
        const previousPi = cur.providerRef && cur.providerRef.startsWith('pi_') && !cur.providerRef.startsWith('pi_mock')
            ? cur.providerRef
            : null;

        // D1: "à vista" criado com desconto PIX é cobrado no cartão SEM o desconto (pagamentos-3).
        const chargeAmount = await cardChargeBaseAmount(p);
        // Valor zero (cupom 100%) não é cobrança: nunca vai ao cartão nem gera aviso de falha.
        if (chargeAmount <= 0) { skipped++; continue; }
        const pixDiscardMeta = pixMetadataAfterDiscard(p);
        // Cartão não tem QR: descarta o PIX aposentado (o próximo QR sai com txid novo).
        const cardFields = {
            provider: 'STRIPE' as const,
            chargedAmount: chargeAmount,
            pixString: null,
            pixExpiresAt: null,
            ...(pixDiscardMeta !== undefined ? { metadata: pixDiscardMeta } : {}),
        };

        try {
            const result = await stripeChargeOffSession(customerId, card.stripePaymentMethodId, chargeAmount, {
                paymentId: p.id,
                userId: p.userId,
                contractId: p.contractId ?? '',
                description: 'Cobrança automática de parcela',
            });

            if (result.status === 'succeeded') {
                // Atomic PENDING→PAID guard so the off-session charge and a late webhook
                // can't both run the confirmation effects.
                const upd = await prisma.payment.updateMany({
                    where: { id: p.id, status: 'PENDING' },
                    data: { ...cardFields, status: 'PAID', paidAt: new Date(), providerRef: result.paymentIntentId },
                });
                if (upd.count > 0) {
                    // Z1-b: o cancelamento do PI anterior (chamadas de rede ao Stripe) NÃO fica entre o PAID
                    // e os efeitos da confirmação — se o processo caísse nesse intervalo, a parcela ficava
                    // PAID sem efeitos (nada os repete depois). Dispara já (nunca lança: a janela da cobrança
                    // em dobro segue curta), roda os efeitos e só então aguarda o cancelamento.
                    const cancel = previousPi && previousPi !== result.paymentIntentId
                        ? cancelSupersededCardIntent(p.id, previousPi, result.paymentIntentId)
                        : null;
                    try {
                        await onPaymentConfirmed(p.id);
                    } finally {
                        await cancel;
                    }
                    charged++;
                }
            } else {
                // 'processing' — record the ref and let the webhook finish it.
                // (3DS off-session NÃO chega aqui: o Stripe LANÇA authentication_required
                //  em confirm+off_session; esse caso é tratado no catch abaixo.)
                await prisma.payment.updateMany({
                    where: { id: p.id, status: 'PENDING' },
                    data: { ...cardFields, providerRef: result.paymentIntentId },
                });
            }
        } catch (err) {
            // O Stripe LANÇA na recusa/3DS off-session (o PI vem em err.raw.payment_intent). Grava o PI
            // como a cobrança atual da parcela: o webhook payment_intent.payment_failed só falha a linha
            // cujo providerRef é o PI recusado (pagamentos-6).
            const se = err as { code?: string; raw?: { payment_intent?: { id?: string } }; payment_intent?: { id?: string } };
            const piId = se?.raw?.payment_intent?.id ?? se?.payment_intent?.id;
            if (piId) {
                await prisma.payment.updateMany({
                    where: { id: p.id, status: 'PENDING' },
                    data: { ...cardFields, providerRef: piId },
                }).catch(() => {});
            }
            // 3DS off-session: avisa o cliente para autenticar/pagar manualmente, em vez da mensagem
            // genérica de "cartão recusado".
            if (se?.code === 'authentication_required') {
                await notifyEvent('auto_charge_authentication', {
                    userId: p.userId,
                    entityType: 'payment',
                    entityId: p.id,
                }).catch(() => {});
                continue; // não conta como falha genérica
            }

            failed++;
            const msg = err instanceof Error ? err.message : 'Falha na cobrança automática.';
            console.error(`[AUTO-CHARGE] Payment ${p.id} failed:`, msg);
            await notifyEvent('auto_charge_failed', {
                userId: p.userId,
                entityType: 'payment',
                entityId: p.id,
            }).catch(() => {});
        }
    }

    if (charged || failed || skipped) {
        console.log(`[AUTO-CHARGE] charged=${charged} failed=${failed} skipped=${skipped} of ${duePayments.length} due`);
    }
}
