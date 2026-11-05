import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireStaff } from '../../middleware/permissions.js';
import { logAudit } from '../../lib/audit.js';

const router = Router();
// Router 100% administrativo (crítica E4): login de EQUIPE em tudo + permissão fina por rota (módulo
// "Agenda e Agendamentos"): ver bloqueios → agendamentos.ver; bloquear/desbloquear → agendamentos.editar.
router.use(authenticate, requireStaff());

// ─── Validation Schema ──────────────────────────────────

const blockSlotSchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startTime: z.string().regex(/^\d{2}:\d{2}$/),
    endTime: z.string().regex(/^\d{2}:\d{2}$/),
    reason: z.string().optional(),
});

// ─── POST /api/blocked-slots (equipe — agendamentos.editar) ────────────────────

router.post('/', requirePermission('agendamentos.editar'), async (req: Request, res: Response) => {
    try {
        const data = blockSlotSchema.parse(req.body);

        const slot = await prisma.blockedSlot.create({
            data: {
                date: new Date(data.date + 'T00:00:00'),
                startTime: data.startTime,
                endTime: data.endTime,
                reason: data.reason,
                createdBy: req.user!.userId,
            },
        });

        await logAudit('BLOCKED_SLOT', slot.id, 'CREATED', req.user!.userId, {
            date: data.date, startTime: data.startTime, endTime: data.endTime, reason: data.reason ?? null,
        });

        res.status(201).json({
            blockedSlot: slot,
            message: 'Horário bloqueado com sucesso.',
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── GET /api/blocked-slots?date=YYYY-MM-DD (equipe — agendamentos.ver) ─────────────

router.get('/', requirePermission('agendamentos.ver'), async (req: Request, res: Response) => {
    const { date } = req.query;

    const where: any = {};
    if (date && typeof date === 'string') {
        where.date = new Date(date + 'T00:00:00');
    }

    const slots = await prisma.blockedSlot.findMany({
        where,
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
        include: {
            creator: { select: { name: true } },
        },
    });

    res.json({ blockedSlots: slots });
});

// ─── DELETE /api/blocked-slots/:id (equipe — agendamentos.editar) ──────────────

router.delete('/:id', requirePermission('agendamentos.editar'), async (req: Request, res: Response) => {
    const id = req.params.id as string;

    // Id inexistente → 404 (antes o delete lançava dentro do handler async, sem resposta clara).
    const existing = await prisma.blockedSlot.findUnique({ where: { id } });
    if (!existing) {
        res.status(404).json({ error: 'Bloqueio não encontrado.' });
        return;
    }
    const removed = await prisma.blockedSlot.deleteMany({ where: { id } });
    if (removed.count > 0) {
        await logAudit('BLOCKED_SLOT', id, 'DELETED', req.user!.userId, {
            date: existing.date.toISOString().slice(0, 10), startTime: existing.startTime, endTime: existing.endTime,
            reason: existing.reason ?? null, createdBy: existing.createdBy,
        });
    }
    res.json({ message: 'Bloqueio removido.' });
});

export default router;
