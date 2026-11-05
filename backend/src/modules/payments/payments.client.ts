import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { actorOrReply, can, canAny, denyPermission } from '../../middleware/permissions.js';
import { resolvePixProvider, isPixProvider, type PixProvider } from '../../lib/pixGateway.js';
import { sicoobAllowedEnvironment } from '../../lib/sicoobService.js';

// ─── GET /api/payments/:id/status (CLIENT) ──────────────
// Lightweight polling endpoint for PIX/Boleto status checks.
// For pending Cora payments it actively reconciles against the Cora API
// (throttled) so confirmation never depends solely on the webhook.

const _coraCheckTimes = new Map<string, number>();
const CORA_CHECK_THROTTLE_MS = 8000;

// ─── Sandbox EFETIVO (SEC-1) ────────────────────────────
// Fonte ÚNICA de GET /sandbox-mode (o botão "Simular" do checkout) e POST /:id/simulate: um provedor só
// conta como sandbox quando a integração está HABILITADA e no ambiente 'sandbox' — e, no Sicoob, quando
// esse é o ambiente que ESTE deploy pode operar (sicoobAllowedEnvironment: num deploy de produção o
// Sicoob em sandbox não é selecionável). Uma linha de integração desligada (ex.: a Cora que sobrou em
// 'sandbox' depois da migração para o Sicoob) NUNCA habilita a simulação.

type SimulableProvider = 'STRIPE' | PixProvider;

async function isProviderSandbox(provider: SimulableProvider): Promise<boolean> {
    const integration = await prisma.integrationConfig.findUnique({
        where: { provider },
        select: { enabled: true, environment: true },
    });
    if (!integration || !integration.enabled || integration.environment !== 'sandbox') return false;
    if (provider === 'SICOOB' && sicoobAllowedEnvironment() !== 'sandbox') return false;
    return true;
}

/**
 * Provedor EFETIVO de uma cobrança: cartão → Stripe; PIX/boleto → quem EMITIU a cobrança (linha com
 * providerRef) ou, se a linha ainda é só um placeholder (nada emitido — ex.: 'CORA' gravado na criação do
 * avulso), o provedor de PIX ATIVO (resolvePixProvider, que já aplica a trava de deploy do Sicoob).
 */
async function effectiveProviderFor(payment: { provider: string; providerRef: string | null }): Promise<SimulableProvider | null> {
    if (payment.provider === 'STRIPE') return 'STRIPE';
    if (isPixProvider(payment.provider) && payment.providerRef) return payment.provider;
    return resolvePixProvider();
}

export function registerPaymentClientRoutes(router: Router) {
    // ─── GET /api/payments/sandbox-mode (autenticado) ───────
    // Tells the checkout UI whether PIX/card are running in sandbox, so it can show
    // a "simulate payment" affordance for testing (never shown in production).
    // SEC-1: MESMO critério do POST /:id/simulate (isProviderSandbox) — PIX = o provedor de PIX ATIVO
    // (resolvePixProvider: Sicoob preferido, respeitando a trava de deploy; senão Cora) em sandbox.
    router.get('/sandbox-mode', authenticate, async (_req: Request, res: Response) => {
        try {
            const pixProvider = await resolvePixProvider();
            const [pix, card] = await Promise.all([
                pixProvider ? isProviderSandbox(pixProvider) : false,
                isProviderSandbox('STRIPE'),
            ]);
            res.json({ pix, card });
        } catch {
            res.json({ pix: false, card: false });
        }
    });

    // Rota MISTA: o cliente consulta só as próprias cobranças; a equipe consulta qualquer uma com
    // cobrancas.cobrar, financeiro.ver ou cobrancas.baixa (o checkout do balcão faz polling aqui). Equipe
    // sem nenhuma delas → 403 explícito (nunca cai no ramo do cliente).
    router.get('/:id/status', authenticate, async (req: Request, res: Response) => {
        try {
            const id = req.params.id as string;
            const userId = req.user!.userId;
            const actor = await actorOrReply(req, res);
            if (!actor) return;
            const staffOk = actor.isStaff;
            if (staffOk && !canAny(actor, 'cobrancas.cobrar', 'financeiro.ver', 'cobrancas.baixa')) {
                denyPermission(res, 'cobrancas.cobrar');
                return;
            }

            const payment = await prisma.payment.findFirst({
                where: staffOk ? { id } : { id, userId },
                select: { id: true, status: true, provider: true, providerRef: true, pixString: true, boletoUrl: true },
            });

            if (!payment) {
                res.status(404).json({ status: 'NOT_FOUND' });
                return;
            }

            let status: string = payment.status;

            // Active reconciliation for pending Cora payments (webhook-independent fallback)
            if (status === 'PENDING' && payment.provider === 'CORA' && payment.providerRef) {
                const last = _coraCheckTimes.get(payment.id) || 0;
                if (Date.now() - last > CORA_CHECK_THROTTLE_MS) {
                    _coraCheckTimes.set(payment.id, Date.now());
                    try {
                        const { reconcileCoraPayment } = await import('../../lib/coraReconciliation.js');
                        if (await reconcileCoraPayment(payment.id)) status = 'PAID';
                    } catch (e) {
                        console.error('[Payment-Status] Cora reconciliation failed:', e instanceof Error ? e.message : e);
                    }
                }
            }

            // Reconciliação ativa para pagamentos Sicoob pendentes (independente de webhook)
            if (status === 'PENDING' && payment.provider === 'SICOOB' && payment.providerRef) {
                const last = _coraCheckTimes.get(payment.id) || 0;
                if (Date.now() - last > CORA_CHECK_THROTTLE_MS) {
                    _coraCheckTimes.set(payment.id, Date.now());
                    try {
                        const { reconcileSicoobPayment } = await import('../../lib/sicoobReconciliation.js');
                        if (await reconcileSicoobPayment(payment.id)) status = 'PAID';
                    } catch (e) {
                        console.error('[Payment-Status] Sicoob reconciliation failed:', e instanceof Error ? e.message : e);
                    }
                }
            }

            res.json({
                status,
                provider: payment.provider,
                pixString: payment.pixString,
                boletoUrl: payment.boletoUrl,
            });
        } catch (err) {
            console.error('Erro ao consultar status do pagamento:', err);
            res.status(500).json({ error: 'Erro ao consultar status.' });
        }
    });

    // ─── POST /api/payments/:id/simulate (SANDBOX ONLY) ─────
    // Simulates a confirmed payment for end-to-end testing. STRICTLY refuses unless
    // the payment's EFFECTIVE provider is ENABLED and in 'sandbox' (SEC-1) — it can never confirm a
    // real production payment. Runs the exact same effects as a real confirmation.
    // O `provider` gravado na linha pode ser só um placeholder (ex.: 'CORA' na criação do avulso, com a
    // Cora desligada): quem decide é o provedor efetivo (effectiveProviderFor) + isProviderSandbox.
    // Rota MISTA: cliente só as próprias; equipe qualquer cobrança com cobrancas.cobrar (sem ela → 403).
    router.post('/:id/simulate', authenticate, async (req: Request, res: Response) => {
        try {
            const id = req.params.id as string;
            const userId = req.user!.userId;
            const actor = await actorOrReply(req, res);
            if (!actor) return;
            const staffOk = actor.isStaff;
            if (staffOk && !can(actor, 'cobrancas.cobrar')) {
                denyPermission(res, 'cobrancas.cobrar');
                return;
            }

            const payment = await prisma.payment.findFirst({
                where: staffOk ? { id } : { id, userId },
            });
            if (!payment) {
                res.status(404).json({ error: 'Pagamento não encontrado.' });
                return;
            }

            // Hard gate: only ever allowed when the EFFECTIVE provider is enabled AND in sandbox.
            const effective = await effectiveProviderFor(payment);
            if (!effective || !(await isProviderSandbox(effective))) {
                res.status(403).json({ error: 'Simulação disponível apenas em ambiente de teste (sandbox).' });
                return;
            }

            if (payment.status === 'PAID') {
                res.json({ status: 'PAID', message: 'Pagamento já estava confirmado.' });
                return;
            }

            const updated = await prisma.payment.updateMany({
                where: { id, status: 'PENDING' },
                data: { status: 'PAID', paidAt: new Date() },
            });
            if (updated.count === 0) {
                res.json({ status: payment.status, message: 'Pagamento não estava pendente.' });
                return;
            }

            const { onPaymentConfirmed } = await import('../../lib/paymentEffects.js');
            await onPaymentConfirmed(id);

            console.log(`[Payment-Simulate] Payment ${id} confirmed via sandbox simulation by user ${userId}`);
            res.json({ status: 'PAID', message: '🧪 Pagamento simulado e confirmado (sandbox).' });
        } catch (err) {
            console.error('[Payment-Simulate]', err);
            res.status(500).json({ error: 'Erro ao simular pagamento.' });
        }
    });
}
