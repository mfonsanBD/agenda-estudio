import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireStaff } from '../../middleware/permissions.js';
import { getConfig } from '../../lib/businessConfig.js';
import { resolveFeeAt, computeGatewayFee, type FeeRate } from '../../lib/gatewayFees.js';
import { paidChargedAmount } from '../../lib/pixGateway.js';

const router = Router();

// Router 100% administrativo (crítica E4): toda rota exige login de EQUIPE; a permissão fina vem por rota.
router.use(authenticate, requireStaff());

// GET /api/finance/closing/:year/:month (equipe: financeiro.ver)
router.get('/closing/:year/:month', requirePermission('financeiro.ver'), async (req, res) => {
    try {
        const year = parseInt(String(req.params.year), 10);
        const month = parseInt(String(req.params.month), 10);

        if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
            return res.status(400).json({ message: 'Ano ou Mês inválido' });
        }

        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0, 23, 59, 59, 999);

        // Fetch all payments mapped to this period
        // Either the dueDate falls in this month, or (if no dueDate) the createdAt falls in this month
        const payments = await prisma.payment.findMany({
            where: {
                OR: [
                    { dueDate: { gte: startDate, lte: endDate } },
                    { dueDate: null, createdAt: { gte: startDate, lte: endDate } }
                ]
            },
            include: {
                user: {
                    select: { id: true, name: true, email: true }
                },
                contract: {
                    select: { id: true, name: true, type: true, tier: true, paymentMethod: true }
                },
                booking: {
                    select: { id: true, date: true, startTime: true, tierApplied: true }
                }
            },
            orderBy: {
                dueDate: 'asc'
            }
        });

        let grossRevenue = 0;
        let pendingRevenue = 0;
        let totalFees = 0;

        let stripeCount = 0;
        let coraCount = 0;
        let sicoobCount = 0; // PIX via Sicoob (provedor de PIX atual pós-migração)
        let paidCount = 0;   // derivado do status real (não da soma por provider)
        let unpaidCount = 0;

        // Stripe (Brasil) cobra PERCENTUAL + TAXA FIXA por transação (ex.: 3,99% + R$0,39). O fixo
        // domina em valores pequenos (uma cobrança de R$0,52 fica líquida ~R$0,11). Sem somar o fixo,
        // o líquido do relatório ficava superestimado (divergia do extrato real do Stripe).
        //
        // A taxa aplicada é a VIGENTE na data em que cada pagamento foi pago (linha do tempo em
        // GatewayFeeHistory), não a taxa atual — assim mudar a taxa no painel não reescreve o líquido
        // de pagamentos passados. O fallback é a config atual (usado enquanto não houve mudança).
        const feeHistory = await prisma.gatewayFeeHistory.findMany({ orderBy: { effectiveFrom: 'asc' } });
        const stripeFallback: FeeRate = { pct: await getConfig('gateway_stripe_fee_pct'), fixedCents: await getConfig('gateway_stripe_fee_cents') };
        const coraFallback: FeeRate = { pct: 0, fixedCents: await getConfig('gateway_cora_fee_cents') };
        const fallbackFor = (provider: string): FeeRate =>
            provider === 'STRIPE' ? stripeFallback : provider === 'CORA' ? coraFallback : { pct: 0, fixedCents: 0 };

        // Load admin-configured payment method labels
        const paymentMethodConfigs = await prisma.paymentMethodConfig.findMany({ orderBy: { sortOrder: 'asc' } });

        const enrichedPayments = payments.map(p => {
            let fee = 0;
            // Bruto de um pagamento PAGO = o que foi efetivamente cobrado (cartão: chargedAmount — sem o
            // desconto PIX do à vista e com os juros do parcelamento; PIX/boleto: amount). Pendentes
            // continuam pelo amount (a base que o PIX/boleto cobra).
            const gross = p.status === 'PAID' ? paidChargedAmount(p) : p.amount;
            // Look up label from admin-configured PaymentMethodConfig
            const pmKey = p.contract?.paymentMethod;
            let methodLabel = 'PIX / Boleto';
            if (pmKey) {
                const pmConfig = paymentMethodConfigs.find((c: any) => c.key === pmKey);
                methodLabel = pmConfig?.label || pmKey;
            } else if (p.provider === 'STRIPE') {
                const cartaoConfig = paymentMethodConfigs.find((c: any) => c.key === 'CARTAO');
                methodLabel = cartaoConfig?.label || 'Cartão de Crédito';
            }

            if (p.status === 'PAID') {
                grossRevenue += gross;
                paidCount++;

                // Taxa vigente na data do pagamento (paidAt; senão vencimento; senão criação), sobre o
                // valor efetivamente cobrado (o gateway desconta a taxa do valor da transação).
                const feeAt = p.paidAt ?? p.dueDate ?? p.createdAt;
                const rate = resolveFeeAt(feeHistory, p.provider, feeAt, fallbackFor(p.provider));
                fee = computeGatewayFee(gross, p.provider, rate);
                if (p.provider === 'STRIPE') stripeCount++;
                else if (p.provider === 'CORA') coraCount++;
                else if (p.provider === 'SICOOB') sicoobCount++;
                totalFees += fee;
            } else if (p.status === 'PENDING' || p.status === 'FAILED') {
                pendingRevenue += p.amount;
                unpaidCount++;
            }

            // Resolve emoji from config
            const resolvedConfig = pmKey
                ? paymentMethodConfigs.find((c: any) => c.key === pmKey)
                : (p.provider === 'STRIPE' ? paymentMethodConfigs.find((c: any) => c.key === 'CARTAO') : null);

            return {
                ...p,
                // `amount` do relatório = bruto efetivamente cobrado (coluna "Bruto" e totais do painel);
                // a base gravada no Payment segue em `baseAmount`.
                amount: gross,
                baseAmount: p.amount,
                methodLabel,
                methodEmoji: resolvedConfig?.emoji || '💰',
                feeDeduced: fee,
                netAmount: gross - fee
            };
        });

        const netRevenue = grossRevenue - totalFees;

        res.json({
            period: { year, month },
            metrics: {
                grossRevenue, // Centavos recebidos
                netRevenue,   // Centavos pós taxas -> Repasse Estúdio
                totalFees,    // Centavos gastos do Gateway
                pendingRevenue, // Inadimplência ou a vencer no mês
                paidCount,
                unpaidCount,
                breakdown: {
                    stripe: stripeCount,
                    cora: coraCount,
                    sicoob: sicoobCount
                }
            },
            payments: enrichedPayments
        });

    } catch (error: any) {
        console.error('Error fetching closing info:', error);
        res.status(500).json({ message: error.message });
    }
});

export const financeRouter = router;
