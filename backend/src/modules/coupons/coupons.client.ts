import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { actorOrReply, canAny, denyPermission } from '../../middleware/permissions.js';
import { CouponError, validateCoupon } from '../../lib/couponService.js';
import { validateCouponSchema } from './validators.js';

const router = Router();

// ─── POST /api/coupons/validate ─────────────────────────
// Advisory preview for checkout UX: computes the discount WITHOUT consuming a
// use. The authoritative validation + atomic reservation happens again inside
// the payment-creation transaction. Rate-limited in index.ts (couponLimiter)
// against code brute-forcing.
router.post('/validate', authenticate, async (req: Request, res: Response) => {
    try {
        const data = validateCouponSchema.parse(req.body);

        // Eligibility is evaluated for the CLIENT the charge is for: staff may pass the target
        // client's id (their own modals) only with agendamentos.criar, contratos.criar or
        // cobrancas.cobrar — staff without any of them get an explicit 403 (rota mista). Clients
        // always get their own token identity — a client cannot probe other users (userId ignored).
        let targetUserId = req.user!.userId;
        if (data.userId) {
            const actor = await actorOrReply(req, res);
            if (!actor) return;
            if (actor.isStaff) {
                if (!canAny(actor, 'agendamentos.criar', 'contratos.criar', 'cobrancas.cobrar')) {
                    denyPermission(res, 'agendamentos.criar');
                    return;
                }
                targetUserId = data.userId;
            }
        }

        const quote = await validateCoupon({ code: data.code, userId: targetUserId, baseAmount: data.amount });
        res.json({
            valid: true,
            code: quote.coupon.code,
            discountType: quote.coupon.discountType,
            discountValue: quote.coupon.discountValue,
            scope: quote.coupon.scope,
            discountAmount: quote.discountAmount,
            finalAmount: quote.finalAmount,
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
        throw err;
    }
});

export default router;
