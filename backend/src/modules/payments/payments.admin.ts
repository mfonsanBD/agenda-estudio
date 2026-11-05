import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, enforceRuleResult } from '../../middleware/permissions.js';
import { requiredForPaymentPatch } from '../../lib/permissionRules.js';
import { PaymentStatus, PaymentMethod } from '../../generated/prisma/client.js';
import { paidChargedAmount } from '../../lib/pixGateway.js';

// Permissões (equipe — config/staffPermissions.ts):
//   GET /payments e /summary → financeiro.ver (receita consolidada);
//   PATCH /payments/:id      → cobrancas.baixa (toda transição manual é baixa: marcar pago, anular,
//                              estornar) + requiredForPaymentPatch (campo sem regra → só ADMIN).

// ─── PATCH /api/payments/:id (equipe: cobrancas.baixa) ──
// Update payment status (mark as paid, refunded, etc.)

const updatePaymentSchema = z.object({
    status: z.nativeEnum(PaymentStatus).optional(),
    paymentMethod: z.nativeEnum(PaymentMethod).optional(),
    providerRef: z.string().optional(),
    notes: z.string().optional(),
});

// VULN-M3 FIX: Payment state machine — prevents arbitrary status transitions
const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
    PENDING:  ['PAID', 'FAILED', 'CANCELLED', 'REFUNDED'],
    FAILED:   ['PENDING', 'PAID'],
    PAID:     ['REFUNDED'],
    CANCELLED: [], // terminal: a voided installment (contract cancelled) must not be re-opened/paid
    REFUNDED: [], // terminal state
};

export function registerPaymentAdminRoutes(router: Router) {
    // ─── GET /api/payments (equipe: financeiro.ver) ─────────
    // Lists all payments with filters and includes user + contract

    router.get('/', authenticate, requirePermission('financeiro.ver'), async (req: Request, res: Response) => {
        try {
            const { status, userId, contractId, from, to, search } = req.query;

            const where: any = {};

            if (status) where.status = status as string;
            if (userId) where.userId = userId as string;
            if (contractId) where.contractId = contractId as string;

            // Date range filter on dueDate
            if (from || to) {
                where.dueDate = {};
                if (from) where.dueDate.gte = new Date(from as string);
                if (to) {
                    const toDate = new Date(to as string);
                    toDate.setDate(toDate.getDate() + 1); // inclusive
                    where.dueDate.lt = toDate;
                }
            }

            // Search by user name or email
            if (search) {
                where.user = {
                    OR: [
                        { name: { contains: search as string, mode: 'insensitive' } },
                        { email: { contains: search as string, mode: 'insensitive' } },
                    ],
                };
            }

            // Bounded by default (no full-table scan); optional ?page/?limit keep the { payments }
            // shape and add an optional pagination block.
            const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? ''), 10) || 200));
            const page = Math.max(1, parseInt(String(req.query.page ?? ''), 10) || 1);
            const [payments, total] = await Promise.all([
                prisma.payment.findMany({
                    where,
                    include: {
                        user: { select: { id: true, name: true, email: true } },
                        contract: { select: { id: true, name: true, type: true, tier: true, durationMonths: true } },
                        booking: { select: { id: true, date: true, startTime: true } },
                    },
                    orderBy: { dueDate: 'asc' },
                    skip: (page - 1) * limit,
                    take: limit,
                }),
                prisma.payment.count({ where }),
            ]);

            res.json({ payments, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
        } catch (err) {
            console.error('Erro ao listar pagamentos:', err);
            res.status(500).json({ error: 'Erro ao listar pagamentos.' });
        }
    });

    // ─── GET /api/payments/summary (equipe: financeiro.ver) ─
    // Financial KPIs for the current period

    router.get('/summary', authenticate, requirePermission('financeiro.ver'), async (req: Request, res: Response) => {
        try {
            const { from, to } = req.query;

            // Default: current month
            const now = new Date();
            const monthStart = from ? new Date(from as string) : new Date(now.getFullYear(), now.getMonth(), 1);
            const monthEnd = to ? new Date(to as string) : new Date(now.getFullYear(), now.getMonth() + 1, 0);
            monthEnd.setDate(monthEnd.getDate() + 1); // inclusive

            const payments = await prisma.payment.findMany({
                where: {
                    dueDate: { gte: monthStart, lt: monthEnd },
                },
            });

            // Receita de um pagamento PAGO = o valor efetivamente cobrado (cartão: chargedAmount — sem o
            // desconto PIX do à vista, com juros de parcelamento; PIX/boleto: amount). Demais: amount.
            const revenueOf = (p: { status: string; amount: number; chargedAmount?: number | null; provider?: string | null; providerRef?: string | null }) =>
                p.status === 'PAID' ? paidChargedAmount(p) : p.amount;
            const totalRevenue = payments.reduce((s, p) => s + revenueOf(p), 0);
            const paidRevenue = payments.filter(p => p.status === 'PAID').reduce((s, p) => s + revenueOf(p), 0);
            const pendingRevenue = payments.filter(p => p.status === 'PENDING').reduce((s, p) => s + p.amount, 0);
            const failedCount = payments.filter(p => p.status === 'FAILED').length;
            const refundedAmount = payments.filter(p => p.status === 'REFUNDED').reduce((s, p) => s + p.amount, 0);

            // Overdue: PENDING with dueDate < today
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const overduePayments = payments.filter(p => p.status === 'PENDING' && p.dueDate && new Date(p.dueDate) < today);
            const overdueCount = overduePayments.length;
            const overdueAmount = overduePayments.reduce((s, p) => s + p.amount, 0);

            // Monthly breakdown for chart (last 6 months) — ONE query for the whole window,
            // grouped in-memory (was 6 separate findMany calls = 6 round-trips per dashboard load).
            const sixMonthStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);
            const sixMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
            const windowPayments = await prisma.payment.findMany({
                where: { dueDate: { gte: sixMonthStart, lt: sixMonthEnd } },
                select: { amount: true, chargedAmount: true, provider: true, providerRef: true, status: true, dueDate: true },
            });

            const monthlyBreakdown = [];
            for (let i = 5; i >= 0; i--) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                const dEnd = new Date(d.getFullYear(), d.getMonth() + 1, 1);
                const monthPayments = windowPayments.filter(p => p.dueDate && p.dueDate >= d && p.dueDate < dEnd);

                monthlyBreakdown.push({
                    month: d.toISOString().slice(0, 7), // YYYY-MM
                    label: d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }),
                    total: monthPayments.reduce((s, p) => s + revenueOf(p), 0),
                    paid: monthPayments.filter(p => p.status === 'PAID').reduce((s, p) => s + revenueOf(p), 0),
                    pending: monthPayments.filter(p => p.status === 'PENDING').reduce((s, p) => s + p.amount, 0),
                });
            }

            res.json({
                summary: {
                    totalRevenue,
                    paidRevenue,
                    pendingRevenue,
                    overdueCount,
                    overdueAmount,
                    failedCount,
                    refundedAmount,
                    totalCount: payments.length,
                    paidCount: payments.filter(p => p.status === 'PAID').length,
                    pendingCount: payments.filter(p => p.status === 'PENDING').length,
                },
                monthlyBreakdown,
            });
        } catch (err) {
            console.error('Erro ao gerar resumo financeiro:', err);
            res.status(500).json({ error: 'Erro ao gerar resumo financeiro.' });
        }
    });

    router.patch('/:id', authenticate, requirePermission('cobrancas.baixa'), async (req: Request<{ id: string }>, res: Response) => {
        try {
            const { id } = req.params;
            const data = updatePaymentSchema.parse(req.body);
            // Nega por padrão: campo do schema sem regra em lib/permissionRules.ts exige o ADMIN.
            if (!(await enforceRuleResult(req, res, requiredForPaymentPatch(data)))) return;

            const existing = await prisma.payment.findUnique({ where: { id } });
            if (!existing) {
                res.status(404).json({ error: 'Pagamento não encontrado.' });
                return;
            }

            // Validate status transition if changing status
            if (data.status && data.status !== existing.status) {
                const allowed = VALID_STATUS_TRANSITIONS[existing.status] || [];
                if (!allowed.includes(data.status)) {
                    res.status(400).json({
                        error: `Transição inválida: ${existing.status} → ${data.status}. Transições permitidas: ${allowed.join(', ') || 'nenhuma (estado terminal)'}.`
                    });
                    return;
                }
            }

            // Atomic guard: when changing status, only flip if the row is STILL in the state we
            // validated against. This makes a concurrent double-PATCH (or a PATCH racing a webhook)
            // a no-op for the loser, so the confirmation effects below can never run twice and
            // double-fulfill (e.g. materialize two contracts). Non-status edits guard by id only.
            const isStatusChange = !!data.status && data.status !== existing.status;
            const guardWhere = isStatusChange ? { id, status: existing.status } : { id };
            const flip = await prisma.payment.updateMany({
                where: guardWhere,
                data: {
                    ...(data.status && { status: data.status }),
                    ...(data.status === 'PAID' && !existing.paidAt && { paidAt: new Date() }),
                    ...(data.providerRef !== undefined && { providerRef: data.providerRef }),
                },
            });
            if (flip.count === 0) {
                const current = await prisma.payment.findUnique({
                    where: { id },
                    include: {
                        user: { select: { id: true, name: true, email: true } },
                        contract: { select: { id: true, name: true, type: true, tier: true } },
                    },
                });
                res.status(409).json({ error: 'O pagamento já foi atualizado por outra ação.', payment: current });
                return;
            }

            const updated = await prisma.payment.findUnique({
                where: { id },
                include: {
                    user: { select: { id: true, name: true, email: true } },
                    contract: { select: { id: true, name: true, type: true, tier: true } },
                },
            });

            // When an admin marks a payment PAID (e.g. recording an offline payment), run the same
            // confirmation effects as the webhook/verify paths so the client still gets booking
            // confirmation, contract fulfillment and the "payment confirmed" push. We won the atomic
            // flip above (flip.count>0), so this runs exactly once. Best-effort: never fail the
            // status update if a downstream effect errors.
            if (data.status === 'PAID' && existing.status !== 'PAID') {
                try {
                    const { onPaymentConfirmed } = await import('../../lib/paymentEffects.js');
                    await onPaymentConfirmed(id);
                } catch (e) {
                    console.error('[PAYMENT-ADMIN] onPaymentConfirmed failed:', e instanceof Error ? e.message : e);
                }
            }

            // Admin killed a pending charge → give back any reserved coupon use.
            // (REFUNDED keeps the redemption CONFIRMED — the use is not returned.)
            if ((data.status === 'FAILED' || data.status === 'CANCELLED') && existing.status === 'PENDING') {
                try {
                    const { releaseCouponForPayment } = await import('../../lib/couponService.js');
                    await releaseCouponForPayment(id);
                } catch (e) {
                    console.error('[PAYMENT-ADMIN] coupon release failed:', e instanceof Error ? e.message : e);
                }
            }

            // Audit log for financial state changes — persisted (compliance), not just console.
            if (data.status && data.status !== existing.status) {
                console.log(`[PAYMENT-ADMIN] ${req.user!.userId} changed payment ${id}: ${existing.status} → ${data.status}`);
                try {
                    const { logAudit } = await import('../../lib/audit.js');
                    await logAudit('PAYMENT', id, `STATUS_${data.status}`, req.user!.userId, {
                        oldStatus: existing.status,
                        newStatus: data.status,
                        notes: data.notes,
                    });
                } catch (e) {
                    console.error('[PAYMENT-ADMIN] audit log failed:', e instanceof Error ? e.message : e);
                }
            }

            res.json({ payment: updated, message: 'Pagamento atualizado com sucesso.' });
        } catch (err) {
            if (err instanceof z.ZodError) {
                res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
                return;
            }
            console.error('Erro ao atualizar pagamento:', err);
            res.status(500).json({ error: 'Erro ao atualizar pagamento.' });
        }
    });
}
