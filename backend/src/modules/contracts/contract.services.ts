import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/permissions.js';
import { getConfig } from '../../lib/businessConfig.js';
import { createPayment as gatewayCreatePayment, updatePaymentWithGatewayResult, validatePaymentMethod, getProviderForMethod, PaymentMethodDisabledError } from '../../lib/paymentGateway.js';
import { resolvePlanAmounts, type BillingCadence } from '../../lib/paymentPolicy.js';
import { addMonths } from '../../utils/pricing.js';
import { serviceContractSchema } from './validators.js';
import { CouponError, validateCoupon, reserveCouponUse, releaseAndPurgeCouponsForPayments, type CouponQuote } from '../../lib/couponService.js';
import { config } from '../../config/index.js';
import { purgeAwaitingContract } from '../../jobs/cleanExpiredHolds.js';
import { acquireMutex, releaseMutex } from '../../lib/redis.js';
import { pixDiscountMetaForFullCharge, type PixDiscountMeta } from '../../lib/pixGateway.js';
import { computeFullContractTotals } from '../../lib/contractPricing.js';

export function registerServiceRoutes(router: Router) {

// ─── POST /api/contracts/service (Standalone monthly services) ──
// Self-serve, inline-paid SERVICO contracts (e.g. Gestão de Redes Sociais). Mirrors the
// self-hire flow: create ONLY the first payment carrying the contract draft in metadata;
// the Stripe/Cora webhook (onPaymentConfirmed → fulfillContractFromPayment SERVICE branch)
// materializes the ACTIVE contract + installments 2..N once the first payment confirms.

// Autoatendimento: só CLIENTE (crítica S5).
router.post('/service', authenticate, requireRole('CLIENTE'), async (req: Request, res: Response) => {
    // pagamentos-9: trava por usuário+serviço envolvendo "substituir a tentativa anterior" + criar —
    // duas criações simultâneas (duas abas, reenvio) não geram duas contratações aguardando pagamento.
    // Liberada no finally assim que ESTA criação termina (o TTL só cobre um processo que caiu).
    let hireLock: string | null = null;
    try {
        const data = serviceContractSchema.parse(req.body);
        const userId = req.user!.userId;

        // E3: a contratação do serviço tem prazo de 10 minutos para pagar — boleto (compensa em dias)
        // nunca entra aqui, mesmo com a chave do boleto ligada.
        if (data.paymentMethod === 'BOLETO') {
            res.status(400).json({ error: 'A contratação de serviços é paga por PIX ou cartão.', code: 'BOLETO_NOT_ALLOWED_HERE' });
            return;
        }

        // Global guard: reject disabled payment methods
        try {
            await validatePaymentMethod(data.paymentMethod);
        } catch (err) {
            if (err instanceof PaymentMethodDisabledError) {
                res.status(400).json({ error: err.message });
                return;
            }
            throw err;
        }

        const addon = await prisma.addOnConfig.findUnique({ where: { key: data.serviceKey } });
        if (!addon || !addon.active) {
            res.status(404).json({ error: 'Serviço não encontrado.' });
            return;
        }
        if (!addon.monthly) {
            res.status(400).json({ error: 'Este item não é um serviço mensal contratável.' });
            return;
        }

        // Duration must be one of the addon's offered fidelities (default = first offered).
        const offered = (addon.durationsOffered || '3,6')
            .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        const duration = data.durationMonths && offered.includes(data.durationMonths)
            ? data.durationMonths
            : (offered[0] || 3);

        // Payment plan must be allowed by the addon (default = first allowed, fallback FULL).
        const allowedPlans = (addon.plansAllowed || 'FULL')
            .split(',').map(s => s.trim().toUpperCase())
            .filter(p => p === 'FULL' || p === 'MONTHLY') as ('FULL' | 'MONTHLY')[];
        const requestedPlan = (data.paymentPlan || allowedPlans[0] || 'FULL') as 'FULL' | 'MONTHLY';
        const plan: 'FULL' | 'MONTHLY' = allowedPlans.includes(requestedPlan)
            ? requestedPlan
            : (allowedPlans[0] || 'FULL');

        // D1 — forma de cobrança do serviço:
        //  • Mensal + PIX (ou cartão sem cardSplit) → 1ª mensalidade agora, demais mês a mês (como antes).
        //  • Mensal + Cartão com cardSplit → o TOTAL agora, parcelado em até N× SEM juros
        //    (N = meses da fidelidade): grava paymentPlan 'FULL' (cobrança única, sem desconto PIX —
        //    é cartão) + Payment.metadata.installmentCap = N (lido pela paymentPolicy).
        //  • À vista (FULL) → pagamento ÚNICO: PIX com desconto PIX ou cartão 1× (installmentCap = 1,
        //    sem 2x–12x).
        if (data.cardSplit && !(plan === 'MONTHLY' && data.paymentMethod === 'CARTAO')) {
            res.status(400).json({ error: 'O parcelamento do total no cartão só vale para o plano mensal pago com cartão.' });
            return;
        }
        const cardSplit = !!data.cardSplit;
        const storedPlan: 'FULL' | 'MONTHLY' = cardSplit ? 'FULL' : plan;
        const installmentCap: number | undefined = cardSplit ? duration : (plan === 'FULL' ? 1 : undefined);

        const cadence: BillingCadence = addon.billingCadence === 'CALENDAR_MONTH'
            ? 'CALENDAR_MONTH'
            : 'BILLING_CYCLE_28';

        // Loyalty discount by fidelity (same config keys the wizard previews use).
        const d6 = await getConfig('service_discount_6months');
        const d3 = await getConfig('service_discount_3months');
        const discountPct = duration === 6 ? d6 : (duration === 3 ? d3 : 0);

        const startDate = new Date();
        const monthlyDiscounted = Math.round(addon.price * (1 - discountPct / 100));

        // Centralized plan rules: monthly = base (no card surcharge); FULL = à-vista total
        // with PIX discount. Monthly service installments advance by calendar month.
        const servicePlan = await resolvePlanAmounts({
            baseMonthly: monthlyDiscounted,
            durationMonths: duration,
            plan: storedPlan,
            paymentMethod: data.paymentMethod,
            startDate,
            billingCadence: cadence,
        });
        const firstAmount = servicePlan.firstAmount;

        const lockKey = `mutex:service-hire:${userId}:${addon.key}`;
        if (!(await acquireMutex(lockKey, 90))) {
            res.status(409).json({ error: `Já há uma contratação de ${addon.name} sendo criada. Aguarde alguns instantes e confira em Meus Contratos.` });
            return;
        }
        hireLock = lockKey;

        // D2: cada nova tentativa SUBSTITUI a contratação anterior ainda não paga deste mesmo serviço
        // (ex.: "Voltar" no wizard + outra forma de pagamento) — mesma rotina segura da varredura:
        // concilia no provedor (se pagou, promove e NÃO cria outra), cancela a cobrança viva e apaga.
        // Feito ANTES do cupom, para liberar um uso reservado pela tentativa abandonada.
        const previous = await prisma.contract.findMany({
            where: { userId, type: 'SERVICO', status: 'AWAITING_PAYMENT', addOns: { has: addon.key } },
            select: { id: true },
        });
        for (const prev of previous) {
            const r = await purgeAwaitingContract(prev.id);
            if (r === 'paid') {
                res.status(409).json({ error: `O pagamento da contratação anterior de ${addon.name} foi confirmado — o serviço já está ativo em Meus Contratos.` });
                return;
            }
            if (r === 'inflight') {
                res.status(409).json({ error: `Há um pagamento em processamento para a contratação anterior de ${addon.name}. Aguarde alguns instantes e confira em Meus Contratos.` });
                return;
            }
        }

        // Coupon: discounts the first charge; ALL_INSTALLMENTS scope propagates to
        // months 2..N via couponForInstallments (applied at fulfillment).
        let couponQuote: CouponQuote | null = null;
        if (data.couponCode) {
            couponQuote = await validateCoupon({ code: data.couponCode, userId, baseAmount: firstAmount });
        }
        const chargeAmount = couponQuote ? couponQuote.finalAmount : firstAmount;

        // E2: TODA cobrança única do serviço (plano gravado FULL — "À vista" e o "mensal parcelado no
        // cartão") leva a marca `pixDiscount` com os DOIS preços (cartão e PIX, mesmo cupom em R$): criada
        // no PIX o amount já é o preço PIX; criada no cartão o amount é o de cartão e, se o cliente trocar
        // para o PIX no checkout, o QR sai com o desconto (issuePixCharge). O cartão nunca cobra a mais.
        let pixDiscountMeta: PixDiscountMeta | undefined;
        if (storedPlan === 'FULL') {
            const totals = await computeFullContractTotals(monthlyDiscounted, duration, data.paymentMethod);
            pixDiscountMeta = pixDiscountMetaForFullCharge({
                cardTotal: totals.cardTotal,
                pixTotal: totals.pixTotal,
                couponDiscount: couponQuote?.discountAmount,
                pct: totals.pixPct,
            });
        }
        const paymentMetadata = {
            ...(installmentCap !== undefined ? { installmentCap } : {}),
            ...(pixDiscountMeta ? { pixDiscount: pixDiscountMeta } : {}),
        };

        // Create-then-pay: materialize the SERVICO contract already in AWAITING_PAYMENT plus its
        // first payment, so it is payable/retryable from Meus Contratos even if the client closes
        // the checkout. On confirmation, onPaymentConfirmed activates the contract and generates
        // installments 2..N (derived from the first paid amount). Coupon reserved atomically.
        const endDate = addMonths(startDate, duration);
        // D2: 10 minutos para pagar (config.studio.lockTtlSeconds); depois a varredura concilia no
        // provedor e apaga a contratação não paga.
        const pDeadline = new Date(Date.now() + config.studio.lockTtlSeconds * 1000);

        const { contract, firstPayment } = await prisma.$transaction(async (tx) => {
            const c = await tx.contract.create({
                data: {
                    userId,
                    name: addon.name,
                    type: 'SERVICO',
                    tier: 'COMERCIAL',
                    durationMonths: duration,
                    discountPct,
                    startDate,
                    endDate,
                    status: 'AWAITING_PAYMENT',
                    paymentDeadline: pDeadline,
                    paymentMethod: data.paymentMethod as any,
                    paymentPlan: storedPlan,
                    addOns: [addon.key],
                    flexCreditsTotal: 0,
                    flexCreditsRemaining: 0,
                },
            });
            const p = await tx.payment.create({
                data: {
                    userId,
                    contractId: c.id,
                    provider: getProviderForMethod(data.paymentMethod),
                    amount: chargeAmount,
                    status: 'PENDING',
                    dueDate: startDate,
                    ...(Object.keys(paymentMetadata).length > 0 ? { metadata: paymentMetadata } : {}),
                    ...(couponQuote ? {
                        couponId: couponQuote.coupon.id,
                        couponCode: couponQuote.coupon.code,
                        discountAmount: couponQuote.discountAmount,
                    } : {}),
                },
            });
            if (couponQuote) {
                await reserveCouponUse(tx, {
                    couponId: couponQuote.coupon.id,
                    userId,
                    paymentId: p.id,
                    originalAmount: firstAmount,
                    discountAmount: couponQuote.discountAmount,
                    maxUsesPerUser: couponQuote.coupon.maxUsesPerUser,
                });
            }
            return { contract: c, firstPayment: p };
        });

        // 100% coupon → zero charge: skip the gateway and confirm immediately (activates the
        // contract + generates installments exactly like a webhook confirmation).
        if (chargeAmount === 0) {
            await prisma.payment.updateMany({
                where: { id: firstPayment.id, status: 'PENDING' },
                data: { status: 'PAID', paidAt: new Date() },
            });
            const { onPaymentConfirmed } = await import('../../lib/paymentEffects.js');
            await onPaymentConfirmed(firstPayment.id);
            res.status(201).json({
                contractId: contract.id,
                firstPaymentId: firstPayment.id,
                amount: 0,
                alreadyPaid: true,
                couponDiscount: couponQuote?.discountAmount,
                message: `Cupom aplicado — serviço ${addon.name} ativado sem cobrança!`,
            });
            return;
        }

        // PIX/BOLETO generate the QR/boleto up-front so the client can pay immediately.
        // CARTÃO does NOT pre-create the PaymentIntent — the inline checkout creates it with
        // the chosen installments (matching the self-hire flow; avoids a colliding 2nd PI).
        const userInfo = await prisma.user.findUnique({
            where: { id: userId },
            select: { name: true, email: true, cpfCnpj: true },
        });
        let clientSecret: string | undefined;
        let pixString: string | undefined;
        let pixExpiresAt: Date | null = null;

        if (data.paymentMethod !== 'CARTAO') {
            try {
                const result = await gatewayCreatePayment({
                    paymentMethod: data.paymentMethod as 'PIX' | 'BOLETO' | 'CARTAO',
                    amount: chargeAmount,
                    description: storedPlan === 'FULL' ? `Serviço ${addon.name}` : `Serviço ${addon.name} - 1ª Parcela`,
                    customer: {
                        name: userInfo?.name || 'Cliente',
                        email: userInfo?.email || '',
                        cpf: userInfo?.cpfCnpj?.replace(/\D/g, '') || undefined,
                    },
                    dueDate: startDate,
                    paymentId: firstPayment.id,
                    userId,
                    // QR vale só enquanto a contratação existe (10 min) — nunca pagável após a varredura.
                    expiresSeconds: config.studio.lockTtlSeconds,
                });
                await updatePaymentWithGatewayResult(firstPayment.id, result);
                if (result.clientSecret) clientSecret = result.clientSecret;
                if (result.pixString) pixString = result.pixString;
                if (result.pixString && result.expiresAt) pixExpiresAt = result.expiresAt;
            } catch (err) {
                // Gateway failed BEFORE any charge was generated (invalid CPF, Cora down, etc.).
                // Nothing to pay yet, so roll back cleanly: release the coupon, drop the payment AND
                // the just-created contract, and surface a clear error. (A charge that DID generate
                // leaves the contract AWAITING for the client to pay later from Meus Contratos.)
                console.error(`[Contract:Service] Gateway payment failed:`, err);
                await releaseAndPurgeCouponsForPayments([firstPayment.id]);
                await prisma.payment.delete({ where: { id: firstPayment.id } }).catch(() => {});
                await prisma.contract.delete({ where: { id: contract.id } }).catch(() => {});
                const msg = err instanceof Error ? err.message : 'Erro ao gerar o pagamento. Tente novamente ou use outro método.';
                res.status(502).json({ error: msg });
                return;
            }
        }

        res.status(201).json({
            contractId: contract.id,
            firstPaymentId: firstPayment.id,
            amount: chargeAmount,
            // D2: prazo para concluir o pagamento (ISO) — o front mostra a contagem de 10 min.
            paymentDeadline: pDeadline.toISOString(),
            // D1: plano efetivamente gravado ('FULL' também no mensal parcelado no cartão) e o teto
            // de parcelas sem juros no cartão (undefined = mensalidade 1×/mês).
            paymentPlan: storedPlan,
            ...(installmentCap !== undefined && { installmentCap }),
            ...(couponQuote && { couponDiscount: couponQuote.discountAmount }),
            ...(clientSecret && { clientSecret }),
            ...(pixString && { pixString }),
            ...(pixExpiresAt && { expiresAt: pixExpiresAt.toISOString() }),
            message: storedPlan === 'FULL'
                ? `Pagamento gerado. Conclua para ativar o serviço ${addon.name}.`
                : `1ª parcela gerada. Conclua para ativar o serviço ${addon.name}.`,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        if (err instanceof CouponError) {
            res.status(err.httpStatus).json({ error: err.message, code: err.code });
            return;
        }
        console.error('[Contract:Service]', err);
        res.status(500).json({ error: 'Erro interno ao processar serviço.' });
    } finally {
        if (hireLock) await releaseMutex(hireLock).catch(() => {});
    }
});

} // end registerServiceRoutes
