import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';

export function registerTiersRoutes(router: Router) {
    // ─── GET /api/pricing ───────────────────────────────────

    router.get('/', async (_req: Request, res: Response) => {
        const configs = await prisma.pricingConfig.findMany({
            orderBy: { tier: 'asc' },
        });

        // If no configs exist, return defaults
        if (configs.length === 0) {
            res.json({
                pricing: [
                    { tier: 'COMERCIAL', price: 30000, label: 'Comercial', description: '' },
                    { tier: 'AUDIENCIA', price: 40000, label: 'Audiência', description: '' },
                    { tier: 'SABADO', price: 50000, label: 'Sábado', description: '' },
                ],
            });
            return;
        }

        res.json({ pricing: configs });
    });

    // ─── PUT /api/pricing (equipe: config.precos) ───────────

    const updatePricingSchema = z.object({
        pricing: z.array(
            z.object({
                tier: z.enum(['COMERCIAL', 'AUDIENCIA', 'SABADO']),
                price: z.number().int().min(0),
                label: z.string().min(1).max(50),
                description: z.string().max(500).optional().default(''),
            })
        ),
    });

    router.put('/', authenticate, requirePermission('config.precos'), async (req: Request, res: Response) => {
        try {
            const { pricing } = updatePricingSchema.parse(req.body);

            const results = [];
            for (const item of pricing) {
                const config = await prisma.pricingConfig.upsert({
                    where: { tier: item.tier },
                    create: { tier: item.tier, price: item.price, label: item.label, description: item.description },
                    update: { price: item.price, label: item.label, description: item.description },
                });
                results.push(config);
            }

            res.json({
                pricing: results,
                message: 'Preços atualizados com sucesso!',
            });
        } catch (err) {
            if (err instanceof z.ZodError) {
                res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
                return;
            }
            throw err;
        }
    });
}
