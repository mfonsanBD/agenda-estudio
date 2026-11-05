import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireStaff } from '../../middleware/permissions.js';
import { logAudit } from '../../lib/audit.js';
import { normalizeCouponCode } from '../../lib/couponService.js';
import { createCouponSchema, updateCouponSchema } from './validators.js';

const router = Router();

// CRUD da equipe — router 100% administrativo (crítica E4): login de EQUIPE em tudo que chega aqui
// (inclusive rota futura sem guarda própria) + a permissão por rota: ler → cupons.ver; criar, editar,
// ativar/desativar e excluir → cupons.editar.
router.use(authenticate, requireStaff());

/** "YYYY-MM-DD" → 00:00Z (repo convention: @db.Date columns hold the SP calendar date). */
const spDate = (s: string) => new Date(s + 'T00:00:00Z');

// ─── GET /api/coupons (cupons.ver) ──────────────────────
router.get('/', requirePermission('cupons.ver'), async (_req: Request, res: Response) => {
    const coupons = await prisma.coupon.findMany({
        orderBy: { createdAt: 'desc' },
        include: { eligibleUsers: { include: { user: { select: { id: true, name: true, email: true } } } } },
    });

    // Confirmed-use counts per coupon (usedCount already tracks RESERVED+CONFIRMED live).
    const grouped = await prisma.couponRedemption.groupBy({
        by: ['couponId', 'status'],
        _count: { _all: true },
    });
    const counts = new Map<string, { confirmed: number; reserved: number }>();
    for (const g of grouped) {
        const entry = counts.get(g.couponId) ?? { confirmed: 0, reserved: 0 };
        if (g.status === 'CONFIRMED') entry.confirmed = g._count._all;
        if (g.status === 'RESERVED') entry.reserved = g._count._all;
        counts.set(g.couponId, entry);
    }

    res.json({
        coupons: coupons.map(c => ({
            ...c,
            eligibleUsers: c.eligibleUsers.map(e => e.user),
            confirmedUses: counts.get(c.id)?.confirmed ?? 0,
            reservedUses: counts.get(c.id)?.reserved ?? 0,
        })),
    });
});

// ─── POST /api/coupons (cupons.editar) ──────────────────
router.post('/', requirePermission('cupons.editar'), async (req: Request, res: Response) => {
    try {
        const data = createCouponSchema.parse(req.body);
        const code = normalizeCouponCode(data.code);

        const existing = await prisma.coupon.findUnique({ where: { code } });
        if (existing) {
            res.status(409).json({ error: 'Já existe um cupom com este código.' });
            return;
        }

        const coupon = await prisma.coupon.create({
            data: {
                code,
                description: data.description || null,
                discountType: data.discountType,
                discountValue: data.discountValue,
                scope: data.scope,
                expiresAt: data.expiresAt ? spDate(data.expiresAt) : null,
                maxUses: data.maxUses ?? null,
                // FIX (O2): cupom "apenas novos clientes" é, por definição, 1 por usuário. Defaultar
                // maxUsesPerUser=1 garante o teto por-usuário ATÔMICO (advisory lock em reserveCouponUse),
                // fechando a corrida em que dois checkouts simultâneos do mesmo cliente usariam o cupom 2x
                // (a checagem onlyNewClients em validateCoupon é não-atômica).
                maxUsesPerUser: data.maxUsesPerUser ?? (data.onlyNewClients ? 1 : null),
                minAmount: data.minAmount ?? null,
                onlyNewClients: data.onlyNewClients,
                active: data.active,
                createdBy: req.user!.userId,
                eligibleUsers: data.eligibleUserIds.length > 0
                    ? { create: data.eligibleUserIds.map(userId => ({ userId })) }
                    : undefined,
            },
        });

        await logAudit('COUPON', coupon.id, 'CREATED', req.user!.userId, { code, type: data.discountType, value: data.discountValue });
        res.status(201).json({ coupon, message: 'Cupom criado!' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: err.errors[0]?.message || 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── GET /api/coupons/:id (cupons.ver) ──────────────────
router.get('/:id', requirePermission('cupons.ver'), async (req: Request, res: Response) => {
    const coupon = await prisma.coupon.findUnique({
        where: { id: req.params.id as string },
        include: {
            eligibleUsers: { include: { user: { select: { id: true, name: true, email: true } } } },
            redemptions: {
                orderBy: { createdAt: 'desc' },
                take: 100,
                include: {
                    user: { select: { id: true, name: true, email: true } },
                    payment: { select: { id: true, amount: true, status: true, createdAt: true } },
                },
            },
        },
    });
    if (!coupon) {
        res.status(404).json({ error: 'Cupom não encontrado.' });
        return;
    }
    res.json({ coupon: { ...coupon, eligibleUsers: coupon.eligibleUsers.map(e => e.user) } });
});

// ─── PATCH /api/coupons/:id (cupons.editar) ─────────────
router.patch('/:id', requirePermission('cupons.editar'), async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const data = updateCouponSchema.parse(req.body);

        const existing = await prisma.coupon.findUnique({ where: { id } });
        if (!existing) {
            res.status(404).json({ error: 'Cupom não encontrado.' });
            return;
        }

        // Never allow the cap to drop below what was already consumed.
        if (data.maxUses != null && data.maxUses < existing.usedCount) {
            res.status(400).json({ error: `Este cupom já tem ${existing.usedCount} uso(s) — o limite não pode ser menor que isso.` });
            return;
        }

        // Percent bounds when type/value change independently.
        const nextType = data.discountType ?? existing.discountType;
        const nextValue = data.discountValue ?? existing.discountValue;
        if (nextType === 'PERCENTUAL' && (nextValue < 1 || nextValue > 100)) {
            res.status(400).json({ error: 'Desconto percentual deve estar entre 1 e 100.' });
            return;
        }
        const nextOnlyNew = data.onlyNewClients ?? existing.onlyNewClients;
        // Final eligible-users count after this patch: the payload overrides the list,
        // otherwise the existing rows are kept. Checking only when eligibleUserIds is in
        // the body would let `PATCH {onlyNewClients:true}` slip past on a coupon that
        // already has a specific-clients list, leaving both flags set.
        const nextEligibleCount = data.eligibleUserIds !== undefined
            ? data.eligibleUserIds.length
            : await prisma.couponEligibleUser.count({ where: { couponId: id } });
        if (nextOnlyNew && nextEligibleCount > 0) {
            res.status(400).json({ error: 'Escolha OU clientes específicos OU apenas novos clientes — não ambos.' });
            return;
        }

        const coupon = await prisma.$transaction(async (tx) => {
            if (data.eligibleUserIds !== undefined) {
                await tx.couponEligibleUser.deleteMany({ where: { couponId: id } });
                if (data.eligibleUserIds.length > 0) {
                    await tx.couponEligibleUser.createMany({
                        data: data.eligibleUserIds.map(userId => ({ couponId: id, userId })),
                    });
                }
            }
            return tx.coupon.update({
                where: { id },
                data: {
                    ...(data.description !== undefined ? { description: data.description || null } : {}),
                    ...(data.discountType !== undefined ? { discountType: data.discountType } : {}),
                    ...(data.discountValue !== undefined ? { discountValue: data.discountValue } : {}),
                    ...(data.scope !== undefined ? { scope: data.scope } : {}),
                    ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt ? spDate(data.expiresAt) : null } : {}),
                    ...(data.maxUses !== undefined ? { maxUses: data.maxUses } : {}),
                    ...(data.maxUsesPerUser !== undefined ? { maxUsesPerUser: data.maxUsesPerUser } : {}),
                    ...(data.minAmount !== undefined ? { minAmount: data.minAmount } : {}),
                    ...(data.onlyNewClients !== undefined ? { onlyNewClients: data.onlyNewClients } : {}),
                    ...(data.active !== undefined ? { active: data.active } : {}),
                },
            });
        });

        await logAudit('COUPON', id, 'UPDATED', req.user!.userId, data as Record<string, unknown>);
        res.json({ coupon, message: 'Cupom atualizado.' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: err.errors[0]?.message || 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── DELETE /api/coupons/:id (cupons.editar — excluir está incluso, crítica C1) ─
router.delete('/:id', requirePermission('cupons.editar'), async (req: Request, res: Response) => {
    const id = req.params.id as string;
    // Block only when a use was actually consumed (RESERVED = in flight, CONFIRMED = paid).
    // RELEASED redemptions gave the use back and only exist as dead rows, so they must not
    // veto deletion — but the FK from coupon_redemptions is RESTRICT, so purge them first.
    const liveUses = await prisma.couponRedemption.count({ where: { couponId: id, status: { not: 'RELEASED' } } });
    if (liveUses > 0) {
        res.status(409).json({ error: 'Este cupom já foi utilizado — desative-o em vez de excluir (o histórico é preservado).' });
        return;
    }
    try {
        await prisma.$transaction(async (tx) => {
            await tx.couponRedemption.deleteMany({ where: { couponId: id } }); // only RELEASED rows remain
            await tx.coupon.delete({ where: { id } });
        });
    } catch {
        res.status(404).json({ error: 'Cupom não encontrado.' });
        return;
    }
    await logAudit('COUPON', id, 'DELETED', req.user!.userId);
    res.json({ message: 'Cupom excluído.' });
});

export default router;
