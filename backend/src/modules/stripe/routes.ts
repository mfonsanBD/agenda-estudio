// ─── Stripe Payment Routes ──────────────────────────────
// Client-facing routes for card management, payment intents and automatic charging
// All routes require authentication

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { actorOrReply, can, denyPermission, requirePermission, requireRole } from '../../middleware/permissions.js';
import {
    stripeGetPublishableKey,
    stripeGetOrCreateCustomer,
    stripeCreateSetupIntent,
    stripeGetSetupIntent,
    stripeListPaymentMethods,
    stripeDetachPaymentMethod,
    stripeSetDefaultPaymentMethod,
    stripeCreatePaymentIntent,
    stripeGetInstallmentPlans,
    stripeGetPaymentIntent,
    stripeCardInstallmentsSupported,
    cardInstallmentsBlockReason,
    isStripeEnabled,
} from '../../lib/stripeService.js';
import { onPaymentConfirmed } from '../../lib/paymentEffects.js';
import { getInstallmentPolicy, policyInputsFromPayment } from '../../lib/paymentPolicy.js';
import { issuePixCharge, retirePixCharge, isPixProvider, pixMetadataAfterDiscard, cardChargeBaseAmount, pixChargeAmount, cancelStalePixCharge, PIX_LIVE_CHARGE_MESSAGE, settleExistingCardIntent, cardIntentInFlightMessage } from '../../lib/pixGateway.js';
import { resolveUserCard, autoChargeCardFor, setDefaultSavedCard, isNonCreditFunding, checkAutoChargeCard, pinAutoChargeCard, DEFAULT_CARD_NOT_CREDIT_MESSAGE } from '../../lib/savedCards.js';
import { logAudit } from '../../lib/audit.js';
import { isValidCpfCnpj } from '../../utils/document.js';
import { planPaymentBlockedByPendingCancellation, cancellationPendingBody } from '../../lib/cancellationPending.js';

const router = Router();

// Permissões (equipe — config/staffPermissions.ts):
//   • autoatendimento do cliente (POST /setup-intent, PUT /auto-charge): só CLIENTE (requireRole);
//   • GET /payment-methods/for-payment/:id: cobrancas.cobrar; os cartões salvos só com
//     cobrancas.cartao_salvo (sem ela, `paymentMethods: []`);
//   • rotas MISTAS (create-payment, installment-plans com paymentId, verify-payment): o cliente segue só
//     as próprias cobranças; a equipe cobra qualquer uma com cobrancas.cobrar (sem ela → 403 explícito,
//     nunca o ramo do cliente) e debita o cartão salvo (savedPaymentMethodId) só com cobrancas.cartao_salvo.

/** PaymentIntent cujo dinheiro já entrou / está a caminho (o mesmo conjunto 'in_flight' de settleExistingCardIntent). */
const CARD_INTENT_MONEY_IN_FLIGHT = new Set(['succeeded', 'processing', 'requires_capture']);

// ─── GET /api/stripe/publishable-key ────────────────────
// Returns the Stripe publishable key for frontend initialization
router.get('/publishable-key', authenticate, async (_req: Request, res: Response) => {
    try {
        const key = await stripeGetPublishableKey();
        // Only ever return a real publishable key — never leak a secret (sk_)
        // to the browser if it was mistakenly entered in the publishable field.
        if (!key || !key.startsWith('pk_')) {
            res.status(503).json({ error: 'Chave publicável do Stripe ausente ou inválida. No painel Admin → Integrações, cole a Publishable Key (pk_test_… ou pk_live_…).' });
            return;
        }
        res.json({ publishableKey: key });
    } catch (err: any) {
        console.error('[Stripe] Error getting publishable key:', err);
        res.status(500).json({ error: 'Erro ao obter configuração Stripe.' });
    }
});

// ─── POST /api/stripe/setup-intent ──────────────────────
// Creates a SetupIntent for saving a card without charging
// Autoatendimento: só CLIENTE (a equipe não tem cartão próprio no app — crítica S5).
router.post('/setup-intent', authenticate, requireRole('CLIENTE'), async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId;
        const customerId = await stripeGetOrCreateCustomer(userId);
        const result = await stripeCreateSetupIntent(customerId);

        res.json({
            clientSecret: result.clientSecret,
            setupIntentId: result.setupIntentId,
        });
    } catch (err: any) {
        console.error('[Stripe] Error creating SetupIntent:', err);
        res.status(500).json({ error: err.message || 'Erro ao criar SetupIntent.' });
    }
});

// ─── GET /api/stripe/payment-methods ────────────────────
// Lists saved cards for the authenticated user
router.get('/payment-methods', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId;
        const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

        if (!user.stripeCustomerId) {
            res.json({ paymentMethods: [], autoChargeEnabled: user.autoChargeEnabled });
            return;
        }

        // Use stripeGetOrCreateCustomer to verify the customer and recreate if it was deleted
        const verifiedCustomerId = await stripeGetOrCreateCustomer(userId);

        // Get cards from Stripe
        const stripeCards = await stripeListPaymentMethods(verifiedCustomerId);

        // Get saved methods from our DB for default status
        const savedMethods = await prisma.savedPaymentMethod.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
        });

        // Merge: enrich with isDefault from our DB
        const paymentMethods = stripeCards.map(card => {
            const saved = savedMethods.find(s => s.stripePaymentMethodId === card.paymentMethodId);
            return {
                id: saved?.id || card.paymentMethodId,
                stripePaymentMethodId: card.paymentMethodId,
                brand: card.brand,
                last4: card.last4,
                expMonth: card.expMonth,
                expYear: card.expYear,
                funding: card.funding,
                isDefault: saved?.isDefault || false,
            };
        });

        res.json({ paymentMethods, autoChargeEnabled: user.autoChargeEnabled });
    } catch (err: any) {
        console.error('[Stripe] Error listing payment methods:', err);
        res.status(500).json({ error: err.message || 'Erro ao listar cartões.' });
    }
});

// ─── POST /api/stripe/setup-intent/confirm ──────────────
// E9: persiste o cartão logo depois de o SetupIntent ser confirmado no navegador (Stripe Elements), sem
// depender do webhook setup_intent.succeeded — o cartão já pode ser usado em seguida (pagar, virar o
// padrão, ativar a cobrança automática). Idempotente. `makeDefault: true` também o torna o padrão.
const confirmSetupSchema = z.object({
    setupIntentId: z.string().min(1).max(255),
    makeDefault: z.boolean().optional(),
});

router.post('/setup-intent/confirm', authenticate, async (req: Request, res: Response) => {
    try {
        const data = confirmSetupSchema.parse(req.body);
        const userId = req.user!.userId;
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true, autoChargeEnabled: true } });
        if (!user?.stripeCustomerId) {
            res.status(400).json({ error: 'Nenhum cadastro de cartão em andamento.', code: 'SETUP_INTENT_NOT_FOUND' });
            return;
        }

        let si: Awaited<ReturnType<typeof stripeGetSetupIntent>>;
        try {
            si = await stripeGetSetupIntent(data.setupIntentId);
        } catch (err) {
            console.warn('[Stripe] setup-intent/confirm: SetupIntent não pôde ser lido:', err instanceof Error ? err.message : err);
            res.status(400).json({ error: 'Cadastro de cartão não encontrado.', code: 'SETUP_INTENT_NOT_FOUND' });
            return;
        }
        // Posse: o SetupIntent é do Customer DESTE usuário (nunca salva o cartão de outro cliente).
        if (si.customerId !== user.stripeCustomerId) {
            res.status(404).json({ error: 'Cadastro de cartão não encontrado.', code: 'SETUP_INTENT_NOT_FOUND' });
            return;
        }
        if (si.status !== 'succeeded' || !si.paymentMethodId) {
            res.status(409).json({
                error: 'O cartão ainda não foi confirmado. Conclua o cadastro e tente novamente.',
                code: 'SETUP_INTENT_NOT_CONFIRMED',
                status: si.status,
            });
            return;
        }

        const card = await resolveUserCard(userId, si.paymentMethodId, { verify: true, sync: true });
        if (!card || !card.id) {
            res.status(404).json({ error: 'Cartão não encontrado.', code: 'CARD_NOT_FOUND' });
            return;
        }

        let isDefault = card.isDefault;
        // E9 "só crédito": com a cobrança automática LIGADA, um cartão de débito/pré-pago é salvo mas NÃO
        // vira o padrão (o padrão é o cartão que o autoChargeJob cobra) — mesma regra do PUT …/default.
        const defaultRefused = !!data.makeDefault && !isDefault && !!user.autoChargeEnabled && isNonCreditFunding(card.funding);
        if (data.makeDefault && !isDefault && !defaultRefused) {
            await stripeSetDefaultPaymentMethod(user.stripeCustomerId, card.stripePaymentMethodId);
            await setDefaultSavedCard(userId, card.id);
            isDefault = true;
        }

        res.json({
            ...(defaultRefused ? { defaultNotApplied: { code: 'CARD_NOT_CREDIT', error: DEFAULT_CARD_NOT_CREDIT_MESSAGE } } : {}),
            card: {
                id: card.id,
                stripePaymentMethodId: card.stripePaymentMethodId,
                brand: card.brand,
                last4: card.last4,
                expMonth: card.expMonth,
                expYear: card.expYear,
                funding: card.funding ?? 'unknown',
                isDefault,
            },
            message: 'Cartão salvo com sucesso.',
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        console.error('[Stripe] Error confirming SetupIntent:', err);
        res.status(502).json({ error: 'Não foi possível salvar o cartão agora. Tente novamente em instantes.' });
    }
});

// ─── GET /api/stripe/payment-methods/for-payment/:paymentId (equipe: cobrancas.cobrar) ──
// E1: cartões salvos do CLIENTE dono do pagamento — o admin cobra o cartão do cliente, nunca o próprio.
// Traz também o pagador (nome e CPF/CNPJ): o CPF exigido no PIX é o do dono do pagamento.
// Os cartões só vêm para quem tem cobrancas.cartao_salvo (sem ela: `paymentMethods: []`, sem consultar o
// Stripe, e `canUseSavedCards: false`) — o CPF/CNPJ do pagador continua (cobrar no PIX exige o dele).
router.get('/payment-methods/for-payment/:paymentId', authenticate, requirePermission('cobrancas.cobrar'), async (req: Request, res: Response) => {
    try {
        const actor = await actorOrReply(req, res);
        if (!actor) return;
        const canUseSavedCards = can(actor, 'cobrancas.cartao_salvo');
        const paymentId = req.params.paymentId as string;
        if (!z.string().uuid().safeParse(paymentId).success) {
            res.status(400).json({ error: 'Pagamento inválido.' });
            return;
        }
        const payment = await prisma.payment.findUnique({
            where: { id: paymentId },
            select: {
                id: true,
                user: { select: { id: true, name: true, cpfCnpj: true, stripeCustomerId: true, autoChargeEnabled: true, deletedAt: true } },
            },
        });
        if (!payment) {
            res.status(404).json({ error: 'Pagamento não encontrado.' });
            return;
        }
        const owner = payment.user;
        const saved = canUseSavedCards
            ? await prisma.savedPaymentMethod.findMany({
                where: { userId: owner.id },
                orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
            })
            : [];

        // Fonte = o Stripe (traz `funding` e os cartões ainda não sincronizados); sem Stripe ou numa
        // falha de consulta, cai para os cartões do banco (funding desconhecido). NUNCA cria Customer aqui.
        let stripeCards: Awaited<ReturnType<typeof stripeListPaymentMethods>> | null = null;
        if (canUseSavedCards && owner.stripeCustomerId && (await isStripeEnabled().catch(() => false))) {
            try {
                stripeCards = await stripeListPaymentMethods(owner.stripeCustomerId);
            } catch (err) {
                console.warn(`[Stripe] cartões do cliente ${owner.id} não puderam ser listados no Stripe:`, err instanceof Error ? err.message : err);
            }
        }

        const paymentMethods = stripeCards
            ? stripeCards.map(card => {
                const row = saved.find(sv => sv.stripePaymentMethodId === card.paymentMethodId);
                return {
                    id: row?.id || card.paymentMethodId,
                    stripePaymentMethodId: card.paymentMethodId,
                    brand: card.brand,
                    last4: card.last4,
                    expMonth: card.expMonth,
                    expYear: card.expYear,
                    funding: card.funding,
                    isDefault: row?.isDefault || false,
                };
            })
            : saved.map(row => ({
                id: row.id,
                stripePaymentMethodId: row.stripePaymentMethodId,
                brand: row.brand,
                last4: row.last4,
                expMonth: row.expMonth,
                expYear: row.expYear,
                funding: 'unknown',
                isDefault: row.isDefault,
            }));

        res.json({
            paymentMethods,
            canUseSavedCards,
            autoChargeEnabled: owner.autoChargeEnabled,
            payer: {
                id: owner.id,
                name: owner.name,
                cpfCnpj: owner.cpfCnpj,
                hasValidCpfCnpj: isValidCpfCnpj(owner.cpfCnpj),
                deleted: !!owner.deletedAt,
            },
        });
    } catch (err: any) {
        console.error('[Stripe] Error listing client payment methods:', err);
        res.status(500).json({ error: 'Erro ao listar os cartões do cliente.' });
    }
});

// ─── DELETE /api/stripe/payment-methods/:pmId ───────────
// Detaches a card from the customer
router.delete('/payment-methods/:pmId', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId;
        const pmId = req.params.pmId as string;

        // Find the saved method to get the Stripe PM ID
        const saved = await prisma.savedPaymentMethod.findFirst({
            where: { userId, OR: [{ id: pmId }, { stripePaymentMethodId: pmId }] },
        });

        // STRIPE-M2 FIX: Block detach if card not found in our DB (prevents IDOR)
        if (!saved) {
            res.status(404).json({ error: 'Cartão não encontrado.' });
            return;
        }

        const stripePmId = saved.stripePaymentMethodId;

        // E9 "só crédito": este é o cartão que a cobrança automática cobra hoje (o padrão ou, sem padrão,
        // o mais recente)? Lido ANTES de remover.
        const owner = await prisma.user.findUnique({ where: { id: userId }, select: { autoChargeEnabled: true } });
        const wasAutoChargeCard = !!owner?.autoChargeEnabled && (await autoChargeCardFor(userId))?.id === saved.id;

        // Detach from Stripe
        await stripeDetachPaymentMethod(stripePmId);

        // Remove from our DB
        if (saved) {
            await prisma.savedPaymentMethod.delete({ where: { id: saved.id } });
        }

        // Removido o cartão da cobrança automática: o SUBSTITUTO (o salvo mais recente) passa pela mesma
        // conferência de quem liga (existe, é do cliente, é de crédito). Aprovado → vira o PADRÃO (Z1-a: o
        // cartão cobrado é o conferido; um cartão salvo depois não assume a cobrança sem conferência). Sem
        // substituto ou reprovado (débito/pré-pago, não conferido) → a cobrança automática é DESLIGADA e a
        // resposta avisa; o cliente religa quando tiver um cartão de crédito.
        if (wasAutoChargeCard) {
            const check = await checkAutoChargeCard(userId, { logTag: '[AUTO-CHARGE-CARD-REMOVED]' });
            if (!check.ok) {
                await prisma.user.update({ where: { id: userId }, data: { autoChargeEnabled: false } });
                const reason = check.body.code ?? (check.status === 400 ? 'NO_CARD' : 'CARD_NOT_VERIFIED');
                await logAudit('USER', userId, 'AUTO_CHARGE_DISABLED', userId, { reason, removedCardLast4: saved.last4 });
                res.json({
                    message: reason === 'NO_CARD'
                        ? 'Cartão removido. A cobrança automática foi desligada porque não há outro cartão salvo.'
                        : reason === 'CARD_NOT_CREDIT'
                            ? 'Cartão removido. A cobrança automática foi desligada porque o outro cartão salvo não é de crédito.'
                            : 'Cartão removido. A cobrança automática foi desligada porque o outro cartão salvo não pôde ser conferido. Ative-a novamente quando quiser.',
                    autoChargeEnabled: false,
                    autoChargeDisabled: true,
                    autoChargeDisabledReason: reason,
                });
                return;
            }
            await pinAutoChargeCard(userId, check.card);
        }

        res.json({ message: 'Cartão removido com sucesso.' });
    } catch (err: any) {
        console.error('[Stripe] Error removing payment method:', err);
        res.status(500).json({ error: err.message || 'Erro ao remover cartão.' });
    }
});

// ─── PUT /api/stripe/payment-methods/:pmId/default ──────
// Sets a card as the default payment method
router.put('/payment-methods/:pmId/default', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId;
        const pmId = req.params.pmId as string;

        const customerId = await stripeGetOrCreateCustomer(userId);

        // Find the Stripe PM ID
        let saved = await prisma.savedPaymentMethod.findFirst({
            where: { userId, OR: [{ id: pmId }, { stripePaymentMethodId: pmId }] },
        });
        const stripePmId = saved?.stripePaymentMethodId || pmId;

        // E9 "só crédito": com a cobrança automática LIGADA, o padrão é o cartão que o autoChargeJob cobra —
        // trocar o padrão para débito/pré-pago furava a conferência feita ao ligar. Mesma conferência
        // (checkAutoChargeCard), ANTES de qualquer efeito. Desligada: a troca segue livre, como antes.
        const owner = await prisma.user.findUnique({ where: { id: userId }, select: { autoChargeEnabled: true } });
        if (owner?.autoChargeEnabled) {
            const check = await checkAutoChargeCard(userId, { cardRef: stripePmId, logTag: '[AUTO-CHARGE-DEFAULT-CARD]' });
            if (!check.ok) {
                res.status(check.status).json(check.body.code === 'CARD_NOT_CREDIT'
                    ? { ...check.body, error: DEFAULT_CARD_NOT_CREDIT_MESSAGE }
                    : check.body);
                return;
            }
        }

        // Set as default in Stripe
        await stripeSetDefaultPaymentMethod(customerId, stripePmId);

        // Update our DB: unset all defaults, then set this one
        await prisma.savedPaymentMethod.updateMany({
            where: { userId },
            data: { isDefault: false },
        });

        if (saved) {
            await prisma.savedPaymentMethod.update({
                where: { id: saved.id },
                data: { isDefault: true },
            });
        } else {
            // Card exists in Stripe but not in our DB — sync it now
            const cards = await stripeListPaymentMethods(customerId);
            const card = cards.find(c => c.paymentMethodId === stripePmId);
            if (card) {
                saved = await prisma.savedPaymentMethod.create({
                    data: {
                        userId,
                        stripePaymentMethodId: stripePmId,
                        brand: card.brand,
                        last4: card.last4,
                        expMonth: card.expMonth,
                        expYear: card.expYear,
                        isDefault: true,
                    },
                });
                console.log(`[Stripe] Synced + set default: ${card.brand} ****${card.last4}`);
            }
        }

        // Also sync any other Stripe cards that are missing from our DB
        const allStripeCards = await stripeListPaymentMethods(customerId);
        const existingPmIds = (await prisma.savedPaymentMethod.findMany({
            where: { userId },
            select: { stripePaymentMethodId: true },
        })).map(s => s.stripePaymentMethodId);

        for (const sc of allStripeCards) {
            if (!existingPmIds.includes(sc.paymentMethodId)) {
                await prisma.savedPaymentMethod.create({
                    data: {
                        userId,
                        stripePaymentMethodId: sc.paymentMethodId,
                        brand: sc.brand,
                        last4: sc.last4,
                        expMonth: sc.expMonth,
                        expYear: sc.expYear,
                        isDefault: false,
                    },
                });
                console.log(`[Stripe] Synced missing card: ${sc.brand} ****${sc.last4}`);
            }
        }

        res.json({ message: 'Cartão padrão definido.' });
    } catch (err: any) {
        console.error('[Stripe] Error setting default:', err);
        res.status(500).json({ error: err.message || 'Erro ao definir cartão padrão.' });
    }
});

// ─── POST /api/stripe/create-payment ────────────────────
// Creates a PaymentIntent for paying a specific internal Payment
const createPaymentSchema = z.object({
    paymentId: z.string().uuid(),
    installments: z.number().min(1).max(12).optional(),
    savedPaymentMethodId: z.string().optional(),
    savePaymentMethod: z.boolean().optional(),
    paymentMethod: z.enum(['cartao', 'pix', 'boleto']).optional().default('cartao'),
});

router.post('/create-payment', authenticate, async (req: Request, res: Response) => {
    try {
        // Rota MISTA: a equipe cobra pelo cliente só com cobrancas.cobrar (403 explícito sem ela — nunca o
        // ramo do cliente); debitar o cartão SALVO exige também cobrancas.cartao_salvo. ANTES de qualquer efeito.
        const actor = await actorOrReply(req, res);
        if (!actor) return;
        const staffOk = actor.isStaff;
        if (staffOk && !can(actor, 'cobrancas.cobrar')) {
            denyPermission(res, 'cobrancas.cobrar');
            return;
        }
        const data = createPaymentSchema.parse(req.body);
        if (staffOk && data.savedPaymentMethodId && !can(actor, 'cobrancas.cartao_salvo')) {
            denyPermission(res, 'cobrancas.cartao_salvo');
            return;
        }
        const userId = req.user!.userId;

        // Global guard: reject if the payment method is disabled by admin.
        // E3: o boleto segue a MESMA fonte única (chave-mestra "Aceitar pagamento por boleto" + Cora
        // habilitada) — `Contract.boletoAllowed` não é mais autoridade.
        const { validatePaymentMethod, PaymentMethodDisabledError, getBoletoStatus, boletoBlockedForPayment } = await import('../../lib/paymentGateway.js');
        if (data.paymentMethod === 'boleto') {
            const boleto = await getBoletoStatus();
            if (!boleto.available) {
                res.status(400).json({
                    error: boleto.reason === 'PROVIDER_DISABLED'
                        ? 'Boleto indisponível no momento. Use PIX ou cartão.'
                        : 'O pagamento por boleto não está disponível. Use PIX ou cartão.',
                    code: 'BOLETO_UNAVAILABLE',
                    reason: boleto.reason,
                });
                return;
            }
        } else {
            try {
                await validatePaymentMethod(data.paymentMethod);
            } catch (err) {
                if (err instanceof PaymentMethodDisabledError) {
                    res.status(400).json({ error: err.message });
                    return;
                }
                throw err;
            }
        }

        // Get our internal payment. Staff with cobrancas.cobrar may act on ANY payment (charge on
        // behalf of the client, e.g. card-present); clients only on their own.
        const payment = await prisma.payment.findFirst({
            where: { id: data.paymentId, ...(staffOk ? {} : { userId }) },
            include: { contract: true, booking: { select: { status: true, holdExpiresAt: true } } },
        });

        if (!payment) {
            res.status(404).json({ error: 'Pagamento não encontrado.' });
            return;
        }

        // The PAYER is the payment's owner (the client). Resolve the Stripe customer / Cora
        // CPF from payment.userId so an admin charges with the CLIENT's card/CPF, not their own.
        const payerUserId = payment.userId;

        if (payment.status === 'PAID') {
            res.status(400).json({ error: 'Este pagamento já foi realizado.' });
            return;
        }

        if (payment.status === 'CANCELLED') {
            res.status(400).json({ error: 'Este pagamento foi cancelado (contrato encerrado) e não pode mais ser pago.' });
            return;
        }

        // CLI-2: cobrança de uma GRAVAÇÃO (extra/serviço/reserva) cuja gravação foi CANCELADA — não há o que
        // cobrar (pagar só "ativaria" o extra numa sessão que não vai acontecer). Vale para cliente e admin,
        // ANTES de qualquer efeito (reabrir FAILED, emitir QR/PI).
        if (payment.bookingId && payment.booking?.status === 'CANCELLED') {
            res.status(400).json({ error: 'A gravação desta cobrança foi cancelada. Esta cobrança não pode mais ser paga.', code: 'BOOKING_CANCELLED' });
            return;
        }

        // E13: cancelamento em análise (PENDING_CANCELLATION) → o CLIENTE não paga parcelas do plano até o
        // estúdio decidir (a base da multa está congelada). A equipe (com cobrancas.cobrar) continua podendo
        // cobrar; extras de uma gravação e a multa seguem pagáveis. Recusa ANTES de qualquer efeito.
        if (planPaymentBlockedByPendingCancellation(payment, staffOk)) {
            res.status(409).json(cancellationPendingBody());
            return;
        }

        // E3: disponibilidade do boleto (chave + Cora) já conferida acima. O boleto compensa em dias → nunca
        // numa contratação com prazo de pagamento (reserva de 10 min do avulso, /self, serviço,
        // personalizado do cliente, renovação aguardando pagamento): só cobranças do admin e
        // parcelas/faturas de contrato já ativado. Recusa ANTES de qualquer efeito (reabrir FAILED etc.).
        if (data.paymentMethod === 'boleto') {
            const blocked = boletoBlockedForPayment(payment);
            if (blocked) {
                res.status(400).json({ error: blocked, code: 'BOLETO_NOT_ALLOWED_HERE' });
                return;
            }
        }

        // E1: o cartão salvo informado tem de ser do DONO do pagamento (o cliente) — aceita o id do
        // SavedPaymentMethod ou o pm_… do Stripe. O admin cobra o cartão salvo do CLIENTE; um cartão de
        // outra pessoa (inclusive o do próprio admin) é recusado ANTES de qualquer efeito.
        let savedCardPmId: string | undefined;
        if (data.paymentMethod === 'cartao' && data.savedPaymentMethodId) {
            const card = await resolveUserCard(payerUserId, data.savedPaymentMethodId);
            if (!card) {
                res.status(400).json({
                    error: staffOk && payerUserId !== userId
                        ? 'Este cartão não pertence ao cliente desta cobrança. Escolha um cartão salvo do cliente ou cadastre um novo.'
                        : 'Cartão salvo não encontrado. Escolha outro cartão ou cadastre um novo.',
                    code: 'CARD_NOT_FOUND',
                });
                return;
            }
            savedCardPmId = card.stripePaymentMethodId;
        }

        // pagamentos-1 / cobertura-1 (D1): cartão em N× (N > 1) só quando o SERVIDOR fixa o plano (cartão salvo,
        // conta com parcelamento). Recusa ANTES de qualquer efeito (reabrir FAILED, aposentar PIX, criar PI):
        // numa conta sem parcelamento (Stripe BR) o total sairia em 1× com os juros do app; com cartão novo, o
        // seletor do Payment Element escolheria qualquer plano do emissor, fora do teto da política.
        if (data.paymentMethod === 'cartao') {
            const requested = Math.min(data.installments || 1, getInstallmentPolicy(policyInputsFromPayment(payment)).maxInstallments);
            if (requested > 1) {
                const blocked = cardInstallmentsBlockReason({
                    installments: requested,
                    savedCard: !!savedCardPmId,
                    gatewaySupported: await stripeCardInstallmentsSupported(),
                });
                if (blocked) {
                    res.status(400).json({ error: blocked, code: 'INSTALLMENTS_UNAVAILABLE' });
                    return;
                }
            }
        }

        // Re-pay of a FAILED/expired charge (e.g. an expired PIX the reconciliation marked
        // FAILED, shown as payable in "Meus Pagamentos"). Reset to PENDING and DROP the dead
        // gateway artifacts so we mint a FRESH charge — never reuse the stale, unpayable QR/PI
        // (the P2 reuse guard below keys off pixString) — and so the webhook/reconciliation,
        // which only act on PENDING, can confirm the new charge.
        // PaymentIntent de cartão já emitido para esta cobrança (a reabertura de FAILED abaixo zera o
        // providerRef): o ramo cartão o resolve antes de criar outro (settleExistingCardIntent).
        const previousCardIntent = payment.providerRef?.startsWith('pi_') ? payment.providerRef : null;

        if (payment.status === 'FAILED') {
            // Z1-e (PAY-6, passo 3): ANTES de reabrir, confere o PaymentIntent desta linha. Uma recusa
            // atrasada pode ter marcado FAILED uma cobrança cujo PI foi APROVADO (ou está processando) logo
            // depois; reabrir zerava o providerRef — a linha ficava PENDING sem referência ao PI aprovado e um
            // PIX/boleto/novo PI emitido nesse intervalo cobrava em dobro. Nesse caso NÃO reabre (a linha segue
            // FAILED apontando para o PI: o webhook/verify a baixam — PAY-6) e responde como o cartão em
            // andamento, seja qual for a forma pedida. Só leitura (nada é cancelado aqui). Stripe desligado,
            // PI inexistente ou consulta que falhou → reabre como antes (o ramo cartão confere de novo abaixo).
            if (previousCardIntent && !previousCardIntent.startsWith('pi_mock')) {
                let inFlightStatus: string | null = null;
                try {
                    if (await isStripeEnabled()) {
                        const pi = await stripeGetPaymentIntent(previousCardIntent);
                        if (pi && CARD_INTENT_MONEY_IN_FLIGHT.has(pi.status)) inFlightStatus = pi.status;
                    }
                } catch (err) {
                    console.warn(`[Stripe] create-payment: PI ${previousCardIntent} da cobrança FAILED ${payment.id} não pôde ser consultado antes de reabrir:`, err instanceof Error ? err.message : err);
                }
                if (inFlightStatus) {
                    if (inFlightStatus === 'succeeded') {
                        console.error(`[Stripe] create-payment: PI ${previousCardIntent} já aprovado para o payment FAILED ${payment.id} — não reaberto (aguardando webhook/verify).`);
                    }
                    res.status(409).json({ error: cardIntentInFlightMessage(inFlightStatus), code: 'CARD_PAYMENT_IN_FLIGHT' });
                    return;
                }
            }

            // pagamentos-6: uma linha FAILED com cobrança PIX pode ter o QR ainda VIVO (ex.: falhada por um
            // evento de cartão atrasado). Zerar o providerRef aqui descartava o txid sem cancelar a cob —
            // um pagamento nela nunca casaria. Por isso a linha PIX é reaberta COM a cobrança: a emissão
            // (issuePixCharge) reaproveita a viva de mesmo valor ou a concilia/cancela antes de emitir
            // outra; o ramo cartão a aposenta antes do PaymentIntent. Demais provedores: descarta como antes.
            const keepPix = isPixProvider(payment.provider) && !!payment.providerRef;
            const discardMeta = keepPix ? undefined : pixMetadataAfterDiscard(payment);
            const reopened = await prisma.payment.updateMany({
                where: { id: payment.id, status: 'FAILED' },
                data: {
                    status: 'PENDING', boletoUrl: keepPix ? payment.boletoUrl : null, chargedAmount: null,
                    ...(keepPix ? {} : { providerRef: null, pixString: null, pixExpiresAt: null }),
                    ...(discardMeta !== undefined ? { metadata: discardMeta } : {}),
                },
            });
            if (reopened.count === 0) {
                res.status(409).json({ error: 'Esta cobrança mudou de situação. Atualize a página e tente novamente.' });
                return;
            }
            payment.status = 'PENDING';
            payment.chargedAmount = null;
            if (!keepPix) {
                payment.providerRef = null;
                payment.pixString = null;
                payment.pixExpiresAt = null;
                payment.boletoUrl = null;
            }
            if (discardMeta !== undefined) payment.metadata = discardMeta as typeof payment.metadata;
        }

        // NOTA: o Stripe customer é criado apenas no fluxo de CARTÃO (abaixo). PIX/boleto não
        // precisam dele — criá-lo aqui quebrava o PIX quando o Stripe não está configurado.

        if (data.paymentMethod === 'pix') {
            // D15: fonte única (issuePixCharge). Reusa a cobrança SÓ se viva (pixExpiresAt), com BR Code
            // válido e o MESMO valor; senão concilia a anterior (paga → alreadyPaid), cancela-a e emite
            // nova com txid de tentativa. A validade acompanha a reserva/prazo (avulso = 10 min).
            try {
                const pix = await issuePixCharge(payment.id, {
                    description: `Pagamento PIX - ${payment.contract?.name || 'Avulso'}`,
                });
                if (pix.alreadyPaid) {
                    res.json({
                        provider: pix.provider,
                        status: 'PAID',
                        alreadyPaid: true,
                        amount: pix.amount,
                        paymentId: payment.id,
                    });
                    return;
                }
                res.json({
                    provider: pix.provider,
                    pixString: pix.pixString,
                    qrCodeDataUrl: pix.qrCodeDataUrl,
                    // Compat: o base64 cru (sem o prefixo data:) para quem ainda lê qrCodeBase64.
                    qrCodeBase64: pix.qrCodeDataUrl ? pix.qrCodeDataUrl.replace(/^data:image\/png;base64,/, '') : null,
                    expiresAt: pix.expiresAt,
                    amount: pix.amount,
                    reused: pix.reused,
                    alreadyPaid: false,
                    paymentId: payment.id,
                });
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : 'Erro ao gerar PIX.';
                // E1: o CPF/CNPJ exigido no PIX é o do DONO do pagamento (o cliente), nunca o do admin.
                if (/^CPF\/CNPJ/.test(msg)) {
                    res.status(400).json({
                        error: staffOk && payerUserId !== userId
                            ? 'O cliente não tem CPF/CNPJ válido no cadastro. Informe o CPF/CNPJ do cliente para gerar o PIX.'
                            : msg,
                        code: 'CPF_CNPJ_REQUIRED',
                        payerUserId,
                    });
                    return;
                }
                res.status(400).json({ error: msg });
            }
            return;
        }

        if (data.paymentMethod === 'boleto') {
            // E3: disponibilidade (chave + Cora) e o tipo de cobrança já foram conferidos acima.
            // E2: boleto cobra o preço de CARTÃO (o desconto à vista é só do PIX). Uma cobrança que está
            // no preço PIX da marca volta ao preço de cartão antes de emitir (update condicional atômico).
            const boletoAmount = await cardChargeBaseAmount(payment);
            if (!Number.isInteger(boletoAmount) || boletoAmount <= 0) {
                res.status(400).json({ error: 'Valor do pagamento inválido.' });
                return;
            }
            // Troca PIX → boleto: a cobrança PIX viva é aposentada ANTES de sobrescrever o providerRef
            // (senão o QR continua pagável e o webhook não acha mais o Payment pelo txid).
            if (isPixProvider(payment.provider) && payment.providerRef && payment.pixString) {
                const retired = await retirePixCharge(payment.id);
                if (retired === 'paid') {
                    res.status(400).json({ error: 'Este pagamento já foi confirmado via PIX.', status: 'PAID', alreadyPaid: true });
                    return;
                }
                if (retired === 'live') {
                    res.status(409).json({ error: PIX_LIVE_CHARGE_MESSAGE });
                    return;
                }
                const boletoDiscardMeta = pixMetadataAfterDiscard(payment);
                await prisma.payment.updateMany({
                    where: { id: payment.id, status: 'PENDING' },
                    data: { pixString: null, pixExpiresAt: null, ...(boletoDiscardMeta !== undefined ? { metadata: boletoDiscardMeta } : {}) },
                });
            }
            if (boletoAmount !== payment.amount) {
                const repriced = await prisma.payment.updateMany({
                    where: { id: payment.id, status: 'PENDING', amount: payment.amount },
                    data: { amount: boletoAmount },
                });
                if (repriced.count === 0) {
                    res.status(409).json({ error: 'Esta cobrança mudou de situação. Atualize a página e tente novamente.' });
                    return;
                }
                payment.amount = boletoAmount;
            }
            const { createCoraPayment } = await import('../../lib/coraPaymentHelper.js');
            try {
                const coraRes = await createCoraPayment({
                    userId: payerUserId,
                    amount: boletoAmount,
                    description: `Boleto - ${payment.contract?.name || 'Contrato'}`,
                    withPixQrCode: false,
                    idempotencyKey: payment.id,
                });

                await prisma.payment.update({
                    where: { id: payment.id },
                    data: {
                        providerRef: coraRes.result.id,
                        provider: 'CORA',
                        installments: 1,
                        boletoUrl: coraRes.boletoUrl,
                    },
                });

                res.json({
                    provider: 'CORA',
                    boletoUrl: coraRes.boletoUrl,
                    barcode: coraRes.barcode,
                    amount: boletoAmount,
                    paymentId: payment.id,
                });
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : 'Erro ao gerar boleto.';
                if (/^CPF\/CNPJ/.test(msg)) {
                    res.status(400).json({
                        error: staffOk && payerUserId !== userId
                            ? 'O cliente não tem CPF/CNPJ válido no cadastro. Informe o CPF/CNPJ do cliente para gerar o boleto.'
                            : msg,
                        code: 'CPF_CNPJ_REQUIRED',
                        payerUserId,
                    });
                    return;
                }
                res.status(400).json({ error: msg });
            }
            return;
        }

        // Determine amount + installments via the SINGLE installment policy.
        //  - Monthly installment  → 1x only (no surcharge).
        //  - À-vista (FULL) on a contract → 1–12x, free up to durationMonths, juros above.
        //  - Avulso ("paid now")  → 1–12x, free in 1x, juros 2–12x.
        // Amounts here are pre-surcharge bases (the surcharge is no longer baked at creation),
        // so applying the juros once is correct and parity (persisted==charged) is preserved.
        // D1 (pagamentos-3): o desconto PIX do "à vista" nunca vale no cartão — um Payment criado com
        // PIX é cobrado aqui pelo valor SEM o desconto PIX (a base marcada em metadata.pixDiscount na
        // criação; sem marca, o próprio amount — nunca recalculado pelo % atual).
        let amount = await cardChargeBaseAmount(payment);
        // Valor zero (cupom 100%) nunca vai ao gateway (o Stripe recusa abaixo do mínimo).
        if (amount <= 0) {
            res.status(400).json({ error: 'Valor do pagamento inválido.' });
            return;
        }
        // D1: a política lê também metadata.installmentCap (serviço parcelado / à vista = 1x).
        const policy = getInstallmentPolicy(policyInputsFromPayment(payment));
        let installments = Math.min(data.installments || 1, policy.maxInstallments);

        if (data.paymentMethod === 'cartao' && installments > policy.freeUpTo) {
            const plans = await stripeGetInstallmentPlans(amount, policy.freeUpTo);
            const plan = plans.find(p => p.count === installments);
            if (plan) amount = plan.total;
        }

        // PI anterior desta cobrança: aprovado/processando → não cria outro; pagável com OUTRO valor →
        // cancelado antes (senão, pago numa aba aberta, vira dinheiro sem registro — o webhook recusa o
        // valor divergente); não deu para conferir → não cria agora (fail-closed).
        const previousPi = await settleExistingCardIntent(previousCardIntent, amount);
        if (previousPi.state === 'in_flight') {
            if (previousPi.status === 'succeeded') {
                console.error(`[Stripe] create-payment: PI ${previousCardIntent} já aprovado para o payment ${payment.id} — nenhum PI novo (aguardando webhook/verify).`);
            }
            res.status(409).json({ error: cardIntentInFlightMessage(previousPi.status), code: 'CARD_PAYMENT_IN_FLIGHT' });
            return;
        }
        if (previousPi.state === 'unknown') {
            res.status(503).json({ error: 'Não foi possível conferir a tentativa anterior no cartão agora. Tente novamente em instantes.' });
            return;
        }

        // Troca PIX → cartão: aposenta a cobrança PIX viva ANTES de sobrescrever o providerRef (senão
        // o QR antigo continua pagável e o webhook do Sicoob não acha mais o Payment pelo txid).
        // Se a conciliação mostrar que o PIX já foi pago, não cobra o cartão.
        const pixDiscardMeta = pixMetadataAfterDiscard(payment);
        if (isPixProvider(payment.provider) && payment.providerRef) {
            const retired = await retirePixCharge(payment.id);
            if (retired === 'paid') {
                res.status(400).json({ error: 'Este pagamento já foi confirmado via PIX.', status: 'PAID', alreadyPaid: true });
                return;
            }
            if (retired === 'live') {
                // pagamentos-4: o QR anterior continua pagável e não pôde ser cancelado — cobrar o cartão
                // agora arriscaria cobrança dupla (e o PIX pago ficaria sem registro).
                res.status(409).json({ error: 'Há um QR PIX desta cobrança que ainda pode ser pago e não pôde ser cancelado agora. Pague pelo PIX ou tente o cartão novamente em instantes.' });
                return;
            }
            // Aposentado: a linha deixa de ser PIX JÁ (se o PaymentIntent falhar abaixo, o QR cancelado
            // não pode ser reaproveitado como vivo; a recusa do cartão casa com provider STRIPE sem ref).
            await prisma.payment.updateMany({
                where: { id: payment.id, status: 'PENDING' },
                data: {
                    provider: 'STRIPE', providerRef: null, pixString: null, pixExpiresAt: null,
                    ...(pixDiscardMeta !== undefined ? { metadata: pixDiscardMeta } : {}),
                },
            });
        }

        // Get or create Stripe Customer for the PAYER (client), not the requester. Só no cartão.
        const customerId = await stripeGetOrCreateCustomer(payerUserId);

        // Create PaymentIntent (CARDS ONLY now).
        // N > 1 aqui só chega com cartão SALVO numa conta com parcelamento (recusado acima nos demais casos):
        // o nº escolhido vai ao Stripe na confirmação (installmentPlanCount), conferido em available_plans.
        // Cartão novo sai sempre em 1× e sem parcelamento no PI (o Payment Element não mostra seletor).
        const result = await stripeCreatePaymentIntent({
            amount,
            customerId,
            description: `Pagamento - ${payment.contract?.name || 'Avulso'}`,
            paymentId: payment.id,
            userId: payerUserId,
            contractId: payment.contractId || undefined,
            installmentsEnabled: installments > 1,
            installmentPlanCount: savedCardPmId ? installments : undefined,
            savedPaymentMethodId: savedCardPmId,
            savePaymentMethod: data.savePaymentMethod,
        });

        // Update our payment with the Stripe reference AND the fee-adjusted total in
        // `chargedAmount` — NOT in `amount`. Keeping `amount` as the immutable base means a
        // retry recomputes the surcharge from the base (never compounding) and PIX/boleto keep
        // charging the base. The card amount-parity check (verify/webhook) compares pi.amount
        // against COALESCE(chargedAmount, amount), so it still accepts the fee-adjusted charge.
        await prisma.payment.update({
            where: { id: payment.id },
            data: {
                providerRef: result.paymentIntentId,
                provider: 'STRIPE',
                chargedAmount: amount,
                installments,
                // Cartão não tem QR: limpa o PIX anterior (o reuso do PIX exige cobrança viva).
                pixString: null,
                pixExpiresAt: null,
                ...(pixDiscardMeta !== undefined ? { metadata: pixDiscardMeta } : {}),
            },
        });

        // SEC-4: trilha de QUEM cobrou — o admin cobrando o cartão do cliente (salvo: debitado na hora, sem
        // o cliente presente; novo: PaymentIntent aberto no Customer do cliente). Marca o INÍCIO da cobrança
        // (a aprovação segue vindo do webhook/verify). logAudit engole erros: nunca quebra a cobrança.
        // Vale para toda a equipe (ADMIN ou COLABORADOR com a permissão): performedBy = quem cobrou.
        if (staffOk && payerUserId !== userId) {
            await logAudit('PAYMENT', payment.id, savedCardPmId ? 'ADMIN_CHARGED_SAVED_CARD' : 'ADMIN_CHARGE_STARTED', userId, {
                payerUserId, paymentIntentId: result.paymentIntentId, amount, installments, method: 'cartao',
            });
        }

        res.json({
            provider: 'STRIPE',
            clientSecret: result.clientSecret,
            paymentIntentId: result.paymentIntentId,
            // Valor EFETIVAMENTE cobrado no cartão (= chargedAmount: sem o desconto PIX do à vista, com os
            // juros do parcelamento quando houver) — o checkout exibe este valor no formulário do cartão.
            amount,
            installments,
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        console.error('[Stripe] Error creating payment:', err);
        res.status(500).json({ error: err.message || 'Erro ao criar pagamento.' });
    }
});

// ─── POST /api/stripe/installment-plans ─────────────────
// Returns available installment plans for a given payment
const installmentSchema = z.object({
    paymentId: z.string().uuid().optional(),
    amount: z.number().min(100).optional(),
    contractDurationMonths: z.number().min(1).max(12).optional(),
    // Prévia sem Payment (wizard de serviço, D1): teto de parcelas SEM juros (1 = só à vista).
    installmentCap: z.number().int().min(1).max(12).optional(),
});

// E2: devolve também `cardAmount` (o que o CARTÃO cobra em 1x, antes de juros) e `pixAmount` (o que o PIX
// cobra — com o desconto do à vista quando a cobrança tem a marca), para o checkout mostrar o preço certo
// em cada aba ANTES de gerar. Na prévia sem paymentId os dois são o `amount` informado.
router.post('/installment-plans', authenticate, async (req: Request, res: Response) => {
    try {
        const data = installmentSchema.parse(req.body);
        let amount = data.amount || 0;
        let pixAmount = amount;
        let policy: { maxInstallments: number; freeUpTo: number };

        // Derive the installment policy: from the payment's contract (plan/type/duration)
        // when a paymentId is given; otherwise treat it as an à-vista (FULL) preview over the
        // given duration (used by the wizards before a payment exists).
        if (data.paymentId) {
            // Rota MISTA (com paymentId): equipe lê qualquer cobrança só com cobrancas.cobrar; cliente, só a dele.
            const actor = await actorOrReply(req, res);
            if (!actor) return;
            const staffOk = actor.isStaff;
            if (staffOk && !can(actor, 'cobrancas.cobrar')) {
                denyPermission(res, 'cobrancas.cobrar');
                return;
            }
            const payment = await prisma.payment.findFirst({
                where: { id: data.paymentId, ...(staffOk ? {} : { userId: req.user!.userId }) },
                include: { contract: true },
            });
            if (!payment) {
                res.status(404).json({ error: 'Pagamento não encontrado.' });
                return;
            }
            // Parcelas do CARTÃO: sobre o valor cobrado no cartão (sem o desconto PIX do à vista — D1).
            amount = await cardChargeBaseAmount(payment);
            // PIX: o preço PIX da marca quando a cobrança está no preço de cartão (E2); senão o amount.
            pixAmount = pixChargeAmount(payment);
            policy = getInstallmentPolicy(policyInputsFromPayment(payment));
        } else if (data.installmentCap) {
            policy = getInstallmentPolicy({ plan: 'FULL', contractType: 'SERVICO', durationMonths: data.contractDurationMonths || 1, installmentCap: data.installmentCap });
        } else {
            policy = getInstallmentPolicy({ plan: 'FULL', durationMonths: data.contractDurationMonths || 1 });
        }

        if (amount <= 0) {
            res.status(400).json({ error: 'Valor inválido.' });
            return;
        }

        // pagamentos-1 / cobertura-1: sem parcelamento no gateway (conta Stripe BR), só 1x — nunca oferecer
        // N× que seria cobrado em 1× (o create-payment recusa N > 1 nesse caso).
        const maxCount = (await stripeCardInstallmentsSupported()) ? policy.maxInstallments : 1;
        const plans = (await stripeGetInstallmentPlans(amount, policy.freeUpTo))
            .filter(p => p.count <= maxCount);
        res.json({ plans, cardAmount: amount, pixAmount });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Erro ao calcular parcelas.' });
    }
});

// ─── GET /api/stripe/auto-charge ────────────────────────
// E9: estado da cobrança automática do cliente (por USUÁRIO — vale para todos os contratos dele) e o
// cartão que será cobrado: o padrão ou, sem padrão, o mais recente (a mesma escolha do autoChargeJob).
router.get('/auto-charge', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId;
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { autoChargeEnabled: true } });
        if (!user) {
            res.status(404).json({ error: 'Usuário não encontrado.' });
            return;
        }
        const [card, savedCards] = await Promise.all([
            autoChargeCardFor(userId),
            prisma.savedPaymentMethod.count({ where: { userId } }),
        ]);
        res.json({
            autoChargeEnabled: user.autoChargeEnabled,
            scope: 'USER',
            hasSavedCard: savedCards > 0,
            savedCards,
            defaultCard: card ? {
                id: card.id,
                stripePaymentMethodId: card.stripePaymentMethodId,
                brand: card.brand,
                last4: card.last4,
                expMonth: card.expMonth,
                expYear: card.expYear,
                isDefault: card.isDefault,
            } : null,
        });
    } catch (err: any) {
        console.error('[Stripe] Error reading auto-charge state:', err);
        res.status(500).json({ error: 'Erro ao consultar a cobrança automática.' });
    }
});

// ─── PUT /api/stripe/auto-charge ────────────────────────
// Toggle automatic off-session charging (opt-in by client).
// E9 "só crédito": LIGAR exige que o cartão que o autoChargeJob vai cobrar (o padrão ou, sem padrão, o
// mais recente) seja de CRÉDITO — a mesma conferência no Stripe (resolveUserCard + isNonCreditFunding),
// com os mesmos códigos/mensagens, do POST /contracts/:id/subscribe. Antes, este caminho ligava a cobrança
// automática com um cartão de débito. DESLIGAR é sempre permitido e nunca consulta o Stripe.
const autoChargeSchema = z.object({
    enabled: z.boolean(),
});

// Autoatendimento: só CLIENTE (crítica S5). A equipe liga/desliga a do cliente por
// PATCH /api/users/:id/auto-charge (cobrancas.automatica).
router.put('/auto-charge', authenticate, requireRole('CLIENTE'), async (req: Request, res: Response) => {
    try {
        const { enabled } = autoChargeSchema.parse(req.body);
        const userId = req.user!.userId;

        if (enabled) {
            // Conferência única (lib/savedCards.checkAutoChargeCard): sem cartão → 400 (sem código); Stripe
            // desligado → 503; não conferido → 502; 404 CARD_NOT_FOUND; débito/pré-pago → 400 CARD_NOT_CREDIT.
            const check = await checkAutoChargeCard(userId, { logTag: '[AUTO-CHARGE-TOGGLE]' });
            if (!check.ok) {
                res.status(check.status).json(check.body);
                return;
            }
            // Z1-a: o cartão conferido passa a ser o PADRÃO (sem padrão, o job cobraria "o mais recente" — que
            // muda no próximo cartão salvo, sem conferência). Mesmo mecanismo do /subscribe.
            await pinAutoChargeCard(userId, check.card);
        }

        await prisma.user.update({
            where: { id: userId },
            data: { autoChargeEnabled: enabled },
        });

        res.json({
            message: enabled
                ? 'Cobrança automática ativada. Seu cartão padrão será cobrado no vencimento.'
                : 'Cobrança automática desativada.',
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.' });
            return;
        }
        res.status(500).json({ error: 'Erro ao atualizar preferência.' });
    }
});

// ─── POST /api/stripe/verify-payment ────────────────────
// Manually verifies a payment intent with Stripe and forces DB update
// if the webhook hasn't arrived yet.
const verifyPaymentSchema = z.object({
    paymentId: z.string().uuid(),
    paymentIntentId: z.string(),
});

router.post('/verify-payment', authenticate, async (req: Request, res: Response) => {
    try {
        // Rota MISTA: a equipe confere qualquer cobrança só com cobrancas.cobrar (403 explícito sem ela);
        // o cliente, só as dele.
        const actor = await actorOrReply(req, res);
        if (!actor) return;
        const staffOk = actor.isStaff;
        if (staffOk && !can(actor, 'cobrancas.cobrar')) {
            denyPermission(res, 'cobrancas.cobrar');
            return;
        }
        const data = verifyPaymentSchema.parse(req.body);
        const userId = req.user!.userId;

        // Staff (cobrancas.cobrar) may verify any payment (charged on behalf of a client); clients only their own.
        const payment = await prisma.payment.findFirst({
            where: { id: data.paymentId, ...(staffOk ? {} : { userId }) },
        });
        if (!payment) {
            res.status(404).json({ error: 'Pagamento não encontrado.' });
            return;
        }

        if (payment.status === 'PAID') {
            res.json({ status: 'PAID', message: 'Já pago.' });
            return;
        }

        if (payment.status === 'CANCELLED') {
            res.status(400).json({ error: 'Este pagamento foi cancelado (contrato encerrado) e não pode ser confirmado.' });
            return;
        }

        const pi = await stripeGetPaymentIntent(data.paymentIntentId);
        
        if (pi.status === 'succeeded') {
            // SEC FIX (S2): posse ESTRITA — rejeitar também quando metadata.paymentId está AUSENTE.
            // Todo PI de cartão criado para um Payment grava metadata.paymentId incondicionalmente
            // (stripeService.stripeCreatePaymentIntent). PIs sem esse metadata são PIs de FATURA de
            // assinatura (metadata fica na subscription) — que NÃO devem ser confirmados por aqui
            // (a assinatura confirma via webhook). Antes, metadata ausente pulava a checagem e um PI
            // de assinatura de mesmo valor podia quitar um Payment PENDING sem cobrança correspondente.
            if (pi.metadata?.paymentId !== data.paymentId) {
                console.error(`[Stripe:Verify] PI ownership mismatch: PI.meta=${pi.metadata?.paymentId}, requested=${data.paymentId}`);
                res.status(400).json({ error: 'PaymentIntent não pertence a este pagamento.' });
                return;
            }

            // VULN-07 FIX: Verify amount matches before accepting. Card charges may carry an
            // installment surcharge stored in chargedAmount; PIX/boleto have none (→ amount).
            const expectedAmount = payment.chargedAmount ?? payment.amount;
            if (pi.amount !== expectedAmount) {
                console.error(`[Stripe:Verify] Amount mismatch: PI=${pi.amount}, DB=${expectedAmount} for payment ${payment.id}`);
                res.status(400).json({ error: 'Valor do PaymentIntent não confere com o pagamento.' });
                return;
            }

            // Atomic update: only update if still PENDING to prevent race with webhooks.
            // PAY-6: também a linha que uma recusa ATRASADA marcou FAILED, quando ESTE PaymentIntent é
            // exatamente a cobrança dela (mesmo providerRef) — o cliente trocou o cartão no mesmo PI e ele
            // foi aprovado. FAILED de outro PI / de PIX e CANCELLED continuam de fora.
            const updated = await prisma.payment.updateMany({
                where: {
                    id: payment.id,
                    OR: [{ status: 'PENDING' }, { status: 'FAILED', provider: 'STRIPE', providerRef: pi.id }],
                },
                data: {
                    status: 'PAID',
                    paidAt: new Date(),
                    providerRef: pi.id,
                    paymentType: pi.payment_method_types?.includes('card') ? 'CREDIT' : null,
                },
            });

            // Run the SINGLE source of confirmation effects (addon activation, booking confirm,
            // contract activate/fulfill, renewal-booking generation, push notification, progressive
            // unlock) — only if THIS call won the atomic PENDING→PAID race (otherwise the webhook
            // already ran them). Centralizing here keeps verify/webhook/reconcile in lockstep and
            // restores the two effects the old inline copy was missing (push + renewal bookings).
            if (updated.count > 0) {
                // A linha tinha um QR PIX (cartão aprovado depois da troca para PIX): cancela o QR.
                if (payment.provider !== 'STRIPE' && payment.providerRef) {
                    await cancelStalePixCharge(payment.provider, payment.providerRef, payment.pixString);
                }
                await onPaymentConfirmed(payment.id);
                console.log(`[Stripe:Verify] Manually verified payment ${payment.id} as PAID`);
                res.json({ status: 'PAID', message: 'Pagamento sincronizado.' });
                return;
            }

            // PAY-6: nada foi atualizado — NUNCA responder PAID sem a linha estar PAID. Relê o estado real:
            // PAID (o webhook chegou antes) → PAID; qualquer outro → 409 (cartão aprovado sem baixa: o
            // estúdio precisa conferir — nunca mostrar "sucesso" com a cobrança ainda em aberto/falhada).
            const fresh = await prisma.payment.findUnique({ where: { id: payment.id }, select: { status: true } });
            if (fresh?.status === 'PAID') {
                res.json({ status: 'PAID', message: 'Já pago.' });
                return;
            }
            console.error(`[Stripe:Verify][ALERTA] PI ${pi.id} aprovado (valor ${pi.amount}) mas o payment ${payment.id} está ${fresh?.status ?? 'ausente'} (providerRef=${payment.providerRef}) — sem baixa automática, conferir manualmente.`);
            res.status(409).json({
                error: 'O pagamento foi aprovado no cartão, mas esta cobrança mudou de situação e não pôde ser baixada automaticamente. Fale com o estúdio para confirmar o pagamento.',
                code: 'PAYMENT_NOT_SETTLED',
                paymentStatus: fresh?.status ?? payment.status,
            });
            return;
        }
        
        res.json({ status: payment.status, message: 'Ainda não confirmado no Stripe.' });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.' });
            return;
        }
        console.error('[Stripe] Verify Error:', err);
        res.status(500).json({ error: 'Erro ao verificar sincronicidade do Stripe.' });
    }
});

export default router;