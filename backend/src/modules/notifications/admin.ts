import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireStaff, actorOrReply, denyPermission } from '../../middleware/permissions.js';
import { logAudit } from '../../lib/audit.js';
import { createNotification } from './notificationService.js';
import { getAllEffectiveEvents, invalidateTemplateCache, renderTemplate } from './templateStore.js';
import { NOTIFICATION_EVENT_BY_KEY, extractPlaceholders } from '../../config/notificationEventCatalog.js';
import { templateUpdateSchema, broadcastSchema } from './validators.js';
import { randomUUID } from 'node:crypto';

const router = Router();
// Router 100% administrativo (crítica E4): login de EQUIPE em tudo + permissão por rota (módulo "Avisos e
// modelos de mensagem"): ler eventos e histórico → avisos.modelos OU avisos.enviar (a página abre com
// qualquer uma); editar/restaurar/testar modelos → avisos.modelos; enviar aviso → avisos.enviar.
// Avisos DA EQUIPE (eventos de audiência "admin": dinheiro, cancelamentos, operação do dia) só o ADMIN
// altera, restaura, testa e vê o modelo (MAT-02/NS-1): `avisos.modelos` é o texto que os CLIENTES recebem.
// Sem isso um colaborador desligava o alerta de cobrança em dobro para todos ou reescrevia um aviso que
// chega com push ao ADMIN (o mesmo vetor de phishing que a F5 fechou no broadcast).
router.use(authenticate, requireStaff());

/** Evento de aviso da equipe (audiência "admin"). Evento desconhecido → false (a rota decide o 404). */
function isTeamEvent(eventKey: string): boolean {
    return Object.prototype.hasOwnProperty.call(NOTIFICATION_EVENT_BY_KEY, eventKey)
        && NOTIFICATION_EVENT_BY_KEY[eventKey]!.audience === 'admin';
}

/**
 * Modelo de aviso da equipe: só o ADMIN mexe. Devolve false (e JÁ respondeu 401/503 ou 403 com
 * permission 'ADMIN') quando quem pede não é o administrador; true quando pode seguir.
 */
async function allowTemplateChange(req: Request, res: Response, eventKey: string): Promise<boolean> {
    if (!isTeamEvent(eventKey)) return true;
    const actor = await actorOrReply(req, res);
    if (!actor) return false;
    if (actor.isAdmin) return true;
    denyPermission(res, 'ADMIN');
    return false;
}

// ─── GET /api/notifications/admin/events ────────────────
// Full catalog merged with DB overrides — the admin UI's source. O colaborador só recebe os eventos dos
// CLIENTES: os avisos da equipe não aparecem para ele (só o ADMIN os edita), então a tela não oferece
// editar nem o liga/desliga deles.
router.get('/events', requirePermission('avisos.modelos', 'avisos.enviar'), async (req: Request, res: Response) => {
    try {
        const actor = await actorOrReply(req, res);
        if (!actor) return;
        const effective = await getAllEffectiveEvents();
        const visible = Array.from(effective.values()).filter(e => actor.isAdmin || e.def.audience !== 'admin');
        const events = visible.map(e => ({
            eventKey: e.def.eventKey,
            label: e.def.label,
            description: e.def.description,
            group: e.def.group,
            audience: e.def.audience,
            kind: e.def.kind,
            type: e.def.type,
            variables: e.def.variables,
            defaults: {
                title: e.def.defaultTitle,
                message: e.def.defaultMessage,
                severity: e.def.severity,
                pushDefault: e.def.pushDefault,
                actionUrl: e.def.actionUrl,
            },
            effective: {
                enabled: e.enabled,
                title: e.title,
                message: e.message,
                severity: e.severity,
                pushEnabled: e.pushEnabled,
            },
            overrides: e.overrides,
            isCustomized: e.isCustomized,
        }));
        res.json({ events });
    } catch (err) {
        console.error('[NOTIF-ADMIN] list events failed:', err);
        res.status(500).json({ error: 'Erro ao carregar eventos de notificação.' });
    }
});

/** Reject {placeholders} not declared for the event so a typo never ships literally. */
function validatePlaceholders(eventKey: string, ...texts: (string | null | undefined)[]): string | null {
    const allowed = new Set(NOTIFICATION_EVENT_BY_KEY[eventKey]!.variables.map(v => v.name));
    for (const t of texts) {
        if (!t) continue;
        for (const ph of extractPlaceholders(t)) {
            if (!allowed.has(ph)) return ph;
        }
    }
    return null;
}

// ─── PUT /api/notifications/admin/templates/:eventKey ───
router.put('/templates/:eventKey', requirePermission('avisos.modelos'), async (req: Request, res: Response) => {
    try {
        const eventKey = req.params.eventKey as string;
        if (!NOTIFICATION_EVENT_BY_KEY[eventKey]) {
            res.status(404).json({ error: 'Evento desconhecido.' });
            return;
        }
        if (!(await allowTemplateChange(req, res, eventKey))) return;
        const data = templateUpdateSchema.parse(req.body);

        const badPh = validatePlaceholders(eventKey, data.title, data.message);
        if (badPh) {
            res.status(400).json({ error: `Variável {${badPh}} não existe para este evento.` });
            return;
        }

        const saved = await prisma.notificationTemplate.upsert({
            where: { eventKey },
            create: { eventKey, ...data },
            update: data,
        });
        invalidateTemplateCache();
        await logAudit('NOTIFICATION_TEMPLATE', eventKey, 'UPDATED', req.user!.userId, data as Record<string, unknown>);
        res.json({ template: saved, message: 'Template atualizado.' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        console.error('[NOTIF-ADMIN] update template failed:', err);
        res.status(500).json({ error: 'Erro ao salvar o template.' });
    }
});

// ─── DELETE /api/notifications/admin/templates/:eventKey ─
// Restore the catalog default (drop the override row). Aviso da equipe: só o ADMIN restaura.
router.delete('/templates/:eventKey', requirePermission('avisos.modelos'), async (req: Request, res: Response) => {
    try {
        const eventKey = req.params.eventKey as string;
        if (!(await allowTemplateChange(req, res, eventKey))) return;
        await prisma.notificationTemplate.deleteMany({ where: { eventKey } });
        invalidateTemplateCache();
        await logAudit('NOTIFICATION_TEMPLATE', eventKey, 'RESET', req.user!.userId);
        res.json({ message: 'Template restaurado para o padrão.' });
    } catch (err) {
        console.error('[NOTIF-ADMIN] reset template failed:', err);
        res.status(500).json({ error: 'Erro ao restaurar o template.' });
    }
});

// ─── POST /api/notifications/admin/templates/:eventKey/test ─
// Send the notification to the requester itself (admin or staff member), rendered with example variables.
// Aviso da equipe (audiência "admin"): só o ADMIN testa, como só ele edita.
router.post('/templates/:eventKey/test', requirePermission('avisos.modelos'), async (req: Request, res: Response) => {
    try {
        const eventKey = req.params.eventKey as string;
        const def = NOTIFICATION_EVENT_BY_KEY[eventKey];
        if (!def) { res.status(404).json({ error: 'Evento desconhecido.' }); return; }
        if (!(await allowTemplateChange(req, res, eventKey))) return;

        const eff = (await getAllEffectiveEvents()).get(eventKey)!;
        const vars = Object.fromEntries(def.variables.map(v => [v.name, v.example]));
        const severity = eff.severity === 'dynamic' ? 'warning' : eff.severity;

        await createNotification({
            userId: req.user!.userId,
            type: def.type,
            severity,
            title: renderTemplate(eff.title, vars),
            message: renderTemplate(eff.message, vars),
            entityType: 'TEST',
            entityId: `test-${eventKey}`,
            actionUrl: def.actionUrl,
            sendPush: eff.pushEnabled,
            // Unique key so repeated tests always go through (never deduped).
            dedupKey: `test:${eventKey}:${req.user!.userId}:${req.body?.nonce ?? Math.random().toString(36).slice(2)}`,
            // An explicit self-test must land even if the admin has "essential only" on.
            bypassEssentialFilter: true,
        });
        res.json({ message: 'Notificação de teste enviada para você.' });
    } catch (err) {
        console.error('[NOTIF-ADMIN] test template failed:', err);
        res.status(500).json({ error: 'Erro ao enviar o teste.' });
    }
});

// ─── POST /api/notifications/admin/broadcast (avisos.enviar) ─
// Manual announcement to one client or all clients (bell + push).
// F5: uma lista de ids só aceita CLIENTES não excluídos — qualquer id da equipe (ADMIN/COLABORADOR),
// excluído ou inexistente → 400 INVALID_RECIPIENTS e NADA é enviado (vale para todos, inclusive o ADMIN:
// o aviso aparece como "do estúdio" e não pode virar canal de phishing para a equipe).
router.post('/broadcast', requirePermission('avisos.enviar'), async (req: Request, res: Response) => {
    try {
        const data = broadcastSchema.parse(req.body);
        const batchId = randomUUID();

        let recipients: string[];
        if (data.target === 'all') {
            recipients = [...new Set((await prisma.user.findMany({ where: { role: 'CLIENTE', deletedAt: null }, select: { id: true } })).map(u => u.id))];
        } else {
            const ids = [...new Set(data.target)];
            const clients = await prisma.user.findMany({
                where: { id: { in: ids }, role: 'CLIENTE', deletedAt: null },
                select: { id: true },
            });
            const valid = new Set(clients.map(u => u.id));
            const invalidIds = ids.filter(id => !valid.has(id));
            if (invalidIds.length > 0) {
                res.status(400).json({
                    error: 'Avisos só podem ser enviados para clientes ativos no app. Revise os destinatários.',
                    code: 'INVALID_RECIPIENTS',
                    invalidIds,
                });
                return;
            }
            recipients = ids;
        }
        if (recipients.length === 0) {
            res.status(400).json({ error: 'Nenhum destinatário.' });
            return;
        }

        let sent = 0, skipped = 0;
        for (const uid of recipients) {
            const id = await createNotification({
                userId: uid,
                type: 'SYSTEM',
                severity: data.severity,
                title: data.title,
                message: data.message,
                entityType: 'BROADCAST',
                entityId: batchId,
                actionUrl: '/notificacoes',
                sendPush: data.sendPush,
                dedupKey: `broadcast:${batchId}:${uid}`,
            });
            if (id) sent++; else skipped++; // skipped = essentialNotificationsOnly dropped non-critical
        }

        await logAudit('NOTIFICATION_BROADCAST', batchId, 'SENT', req.user!.userId, { target: data.target === 'all' ? 'all' : recipients.length, sent, skipped });
        res.json({ batchId, sent, skipped, message: `Aviso enviado para ${sent} destinatário(s).` });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        console.error('[NOTIF-ADMIN] broadcast failed:', err);
        res.status(500).json({ error: 'Erro ao enviar o aviso.' });
    }
});

// ─── GET /api/notifications/admin/broadcasts ────────────
// Recent broadcast batches. Aggregated at the DB level (groupBy) so counts stay
// correct at any scale — a raw findMany with a row cap undercounts recipients/
// readCount once a single 'all' broadcast exceeds the cap. History is ephemeral
// (the notification cleanup job purges it).
router.get('/broadcasts', requirePermission('avisos.enviar', 'avisos.modelos'), async (_req: Request, res: Response) => {
    try {
        const where = { type: 'SYSTEM' as const, entityType: 'BROADCAST' };
        // Most-recent 20 batches by their newest row.
        const batches = await prisma.notification.groupBy({
            by: ['entityId'],
            where,
            _count: { _all: true },
            _max: { createdAt: true },
            orderBy: { _max: { createdAt: 'desc' } },
            take: 20,
        });
        const ids = batches.map(b => b.entityId).filter((x): x is string => !!x);
        if (ids.length === 0) { res.json({ broadcasts: [] }); return; }

        // Read counts per batch and one representative row (title/message/severity).
        const [readRows, samples] = await Promise.all([
            prisma.notification.groupBy({
                by: ['entityId'],
                where: { ...where, entityId: { in: ids }, read: true },
                _count: { _all: true },
            }),
            prisma.notification.findMany({
                where: { ...where, entityId: { in: ids } },
                distinct: ['entityId'],
                orderBy: { createdAt: 'desc' },
                select: { entityId: true, title: true, message: true, severity: true, createdAt: true },
            }),
        ]);
        const readByBatch = new Map(readRows.map(r => [r.entityId, r._count._all]));
        const sampleByBatch = new Map(samples.map(s => [s.entityId, s]));

        const broadcasts = batches.map(b => {
            const s = sampleByBatch.get(b.entityId);
            return {
                batchId: b.entityId!,
                title: s?.title ?? '',
                message: s?.message ?? '',
                severity: s?.severity ?? 'info',
                createdAt: (b._max.createdAt ?? s?.createdAt ?? new Date()).toISOString(),
                recipients: b._count._all,
                readCount: readByBatch.get(b.entityId) ?? 0,
            };
        });
        res.json({ broadcasts });
    } catch (err) {
        console.error('[NOTIF-ADMIN] list broadcasts failed:', err);
        res.status(500).json({ error: 'Erro ao carregar o histórico.' });
    }
});

export default router;
