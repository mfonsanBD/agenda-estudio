import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { authenticate } from '../../middleware/auth.js';
import { saoPauloParts } from '../../lib/spTime.js';
import {
    markAsRead,
    markAllAsRead,
    deleteNotification,
    getUserNotifications,
} from './notificationService.js';
import { getAllEffectiveEvents, renderTemplate, EffectiveEvent } from './templateStore.js';
import { planPaymentBlockedByPendingCancellation } from '../../lib/cancellationPending.js';
import { actorOrReply, canAny, type Actor } from '../../middleware/permissions.js';
import { staffEventPermissions, type PermissionKey } from '../../config/staffPermissions.js';
import adminRouter from './admin.js';

const router = Router();

// Admin sub-router (templates + broadcast). Mounted before the /:id param routes
// so /admin/* is never captured by them.
router.use('/admin', adminRouter);

const fmtBRL = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

/** Effective severity for a computed rule: a pinned admin override wins over the dynamic value. */
function computedSeverity(eff: EffectiveEvent, dynamic: 'critical' | 'warning' | 'info'): 'critical' | 'warning' | 'info' {
    return eff.severity !== 'dynamic' ? eff.severity : dynamic;
}

interface ComputedNotification {
    id: string;
    type: string;
    severity: 'critical' | 'warning' | 'info';
    title: string;
    message: string;
    entityType: string;
    entityId: string;
    actionUrl?: string;
    createdAt: string;
    read: boolean;
    source: 'computed' | 'persisted';
}

// ─── Computed-notification read state ────────────────────
// Computed notifications are re-generated on every GET (they mirror live data:
// pending cancellation, overdue payment, …), so a plain DB markAllAsRead never
// touches them and they resurrect unread on the next poll. We remember which
// computed IDs the user has read in a per-user Redis set. The IDs are stable
// (`cancellation-pending-<contractId>` etc.), and once the underlying condition
// resolves the entry simply expires.
const COMPUTED_READ_TTL = 30 * 24 * 3600; // 30 days, refreshed on every write
const computedReadKey = (userId: string) => `notif:computed-read:${userId}`;
const COMPUTED_ID_RE = /^(contract-expiring|payment-overdue|payment-failed|booking-unconfirmed|cancellation-pending|contract-awaiting)-/;

const COMPUTED_READ_MAX = 500; // hard cap so a client can't grow the per-user set unbounded

async function markComputedRead(userId: string, ids: string[]): Promise<void> {
    // Length cap rejects forged long ids; real computed ids are `<prefix>-<uuid>` (~50 chars).
    const valid = ids.filter(id => id.length <= 80 && COMPUTED_ID_RE.test(id));
    if (valid.length === 0) return;
    const key = computedReadKey(userId);
    try { if ((await redis.scard(key)) >= COMPUTED_READ_MAX) return; } catch { /* best-effort */ }
    await redis.sadd(key, ...valid);
    await redis.expire(key, COMPUTED_READ_TTL);
}

// ─── Equipe: quem vê cada alerta ────────────────────────
// Os alertas de audiência "admin" vão para a EQUIPE: ADMIN vê todos; COLABORADOR só os do evento cuja
// permissão tem (STAFF_EVENT_PERMISSIONS em config/staffPermissions.ts — cada uma abre a tela do link,
// crítica I3). Sem a permissão o bloco nem consulta o banco; a equipe nunca cai no ramo do cliente (não
// tem contrato/pagamento próprio — autoatendimento é só de CLIENTE).

/** A equipe vê o alerta `eventKey`? ADMIN: sempre; COLABORADOR: com QUALQUER permissão do evento; CLIENTE: nunca. */
function staffSeesEvent(actor: Actor, eventKey: string): boolean {
    if (!actor.isStaff) return false;
    return actor.isAdmin || canAny(actor, ...staffEventPermissions(eventKey));
}

/**
 * Telas da área administrativa → permissões que as abrem (as mesmas guardas de rota do front). Usado para
 * não mostrar ao COLABORADOR um aviso GUARDADO cujo link ele não abre mais (a permissão foi retirada depois
 * do aviso): o texto traz nome de cliente e valores. Link fora desta lista (ou de cliente) não é filtrado.
 */
const STAFF_SCREEN_PERMISSIONS: ReadonlyArray<readonly [prefix: string, anyOf: readonly PermissionKey[]]> = [
    ['/admin/today', ['hoje.ver']],
    ['/admin/bookings', ['agendamentos.ver']],
    ['/admin/clients', ['clientes.ver']],
    ['/admin/contracts', ['contratos.ver']],
    ['/admin/finance', ['financeiro.ver']],
];

/** O ator abre a tela do link? ADMIN e cliente: sempre (o filtro é só para COLABORADOR). */
function staffCanOpenLink(actor: Actor, actionUrl: string | null | undefined): boolean {
    if (!actionUrl || actor.role !== 'COLABORADOR') return true;
    const path = actionUrl.split(/[?#]/)[0]!;
    const screen = STAFF_SCREEN_PERMISSIONS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
    return !screen || canAny(actor, ...screen[1]);
}

/**
 * Builds the real-time (computed) notifications for the actor. Shared by GET and read-all.
 * Cliente: os próprios alertas. Equipe: os alertas "admin" que a permissão libera (ver staffSeesEvent).
 */
async function buildComputedNotifications(actor: Actor): Promise<ComputedNotification[]> {
    const notifications: ComputedNotification[] = [];
    const now = new Date();
    // São Paulo calendar day as 00:00Z — matches Booking.date (@db.Date) and keeps
    // day-based windows/labels correct after 21:00 SP (when the UTC date already flipped).
    const sp = saoPauloParts(now);
    const today = new Date(Date.UTC(sp.y, sp.m - 1, sp.day));
    const userId = actor.userId;
    // `staff` = visão da equipe (todos os clientes). Antes era `role === 'ADMIN'`; agora vale para o
    // COLABORADOR também, mas cada bloco só roda com a permissão do evento (`allowed`).
    const staff = actor.isStaff;
    const allowed = (eventKey: string) => !staff || staffSeesEvent(actor, eventKey);
    const iso = now.toISOString();

    // Text/enabled/severity come from the template store (admin-editable); IDs and
    // actionUrls stay in code (IDs drive the Redis read-state; must not change).
    const events = await getAllEffectiveEvents();
    const ev = (key: string) => events.get(key)!; // every catalog key is present

    // 1. Contracts expiring within threshold
    const expiringKey = staff ? 'computed_contract_expiring_admin' : 'computed_contract_expiring';
    const expiringEff = ev(expiringKey);
    if (allowed(expiringKey) && expiringEff.enabled) {
        const thresholdDays = staff ? 7 : 15;
        const targetDateFromNow = new Date(today);
        targetDateFromNow.setDate(targetDateFromNow.getDate() + thresholdDays);
        // D6: avulso é sessão única (vigência = dia da gravação) — nunca "expira". Planos concluídos
        // (COMPLETED antes do fim da vigência) seguem recebendo o aviso: é o gatilho da renovação.
        const expiringContracts = await prisma.contract.findMany({
            where: {
                status: { in: ['ACTIVE', 'COMPLETED'] },
                type: { not: 'AVULSO' },
                endDate: { gte: today, lte: targetDateFromNow },
                ...(staff ? {} : { userId }),
            },
            include: { user: { select: { name: true } } },
        });
        for (const c of expiringContracts) {
            const dias = Math.ceil((new Date(c.endDate).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
            const vars: Record<string, string | number> = staff ? { cliente: c.user.name, contrato: c.name, dias } : { contrato: c.name, dias };
            notifications.push({
                id: `contract-expiring-${c.id}`, type: 'CONTRACT_EXPIRING',
                severity: computedSeverity(expiringEff, dias <= 2 ? 'critical' : 'warning'),
                title: renderTemplate(expiringEff.title, vars),
                message: renderTemplate(expiringEff.message, vars),
                entityType: 'CONTRACT', entityId: c.id,
                // Equipe: o detalhe do contrato (abre com contratos.ver, a permissão do alerta — I3).
                actionUrl: staff ? `/admin/contracts/${c.id}` : '/meus-contratos',
                createdAt: iso, read: false, source: 'computed',
            });
        }
    }

    // 2. Overdue payments — AGGREGATED (B1): one per user (client) / per client (admin),
    // instead of one identical row per invoice.
    // Cancelamento em análise (E13): o CLIENTE não paga parcela do plano de um contrato
    // PENDING_CANCELLATION (as rotas de pagamento devolvem 409 CANCELLATION_PENDING) — então também não é
    // lembrado dela. Mesma regra das rotas (planPaymentBlockedByPendingCancellation): extras de gravação e
    // a multa continuam avisando; a equipe (que pode cobrar) continua vendo tudo.
    // Cobrança de uma gravação CANCELADA (extra que ficou em aberto — dado legado) não pode mais ser paga
    // (create-payment → 400 BOOKING_CANCELLED): fica fora de "vencidas" e de "pagamento falhou", para o
    // cliente e para a equipe.
    const overdueKey = staff ? 'computed_payment_overdue_admin' : 'computed_payment_overdue';
    const overdueEff = ev(overdueKey);
    if (allowed(overdueKey) && overdueEff.enabled) {
        const overduePayments = (await prisma.payment.findMany({
            where: { status: 'PENDING', dueDate: { lt: today }, ...(staff ? {} : { userId }) },
            include: { user: { select: { name: true } }, contract: { select: { status: true } }, booking: { select: { status: true } } },
        })).filter(p => p.booking?.status !== 'CANCELLED' && !planPaymentBlockedByPendingCancellation(p, staff));
        const daysOverdue = (p: { dueDate: Date | null }) => Math.ceil((today.getTime() - new Date(p.dueDate!).getTime()) / (1000 * 60 * 60 * 24));
        if (staff) {
            const byClient = new Map<string, { name: string; count: number; total: number; maxDays: number }>();
            for (const p of overduePayments) {
                const g = byClient.get(p.userId) ?? { name: p.user.name, count: 0, total: 0, maxDays: 0 };
                g.count++; g.total += p.amount; g.maxDays = Math.max(g.maxDays, daysOverdue(p));
                byClient.set(p.userId, g);
            }
            for (const [clientId, g] of byClient) {
                const vars = { cliente: g.name, quantidade: g.count, total: fmtBRL(g.total), diasMax: g.maxDays };
                notifications.push({
                    id: `payment-overdue-${clientId}`, type: 'PAYMENT_OVERDUE',
                    severity: computedSeverity(overdueEff, g.maxDays > 7 ? 'critical' : 'warning'),
                    title: renderTemplate(overdueEff.title, vars),
                    message: renderTemplate(overdueEff.message, vars),
                    entityType: 'PAYMENT', entityId: clientId, actionUrl: '/admin/finance',
                    createdAt: iso, read: false, source: 'computed',
                });
            }
        } else if (overduePayments.length > 0) {
            let total = 0, maxDays = 0;
            for (const p of overduePayments) { total += p.amount; maxDays = Math.max(maxDays, daysOverdue(p)); }
            const vars = { quantidade: overduePayments.length, total: fmtBRL(total), diasMax: maxDays };
            notifications.push({
                // Stable id (mirrors the admin `payment-overdue-<clientId>`): the text
                // reflects the live count, but paying an invoice down no longer mints a
                // fresh unread id that resurrects a read alert. Matches COMPUTED_ID_RE.
                id: 'payment-overdue-agg', type: 'PAYMENT_OVERDUE',
                severity: computedSeverity(overdueEff, maxDays > 7 ? 'critical' : 'warning'),
                title: renderTemplate(overdueEff.title, vars),
                message: renderTemplate(overdueEff.message, vars),
                entityType: 'PAYMENT', entityId: 'agg', actionUrl: '/meus-pagamentos',
                createdAt: iso, read: false, source: 'computed',
            });
        }
    }

    // 2b. Failed payments
    const failedKey = staff ? 'computed_payment_failed_admin' : 'computed_payment_failed';
    const failedEff = ev(failedKey);
    if (allowed(failedKey) && failedEff.enabled) {
        // L12: este alerta é "Pagamento com CARTÃO falhou" — restringir a provider STRIPE. Falhas de
        // PIX/boleto (Sicoob/Cora) têm seu próprio evento "Cobrança expirada"; antes elas disparavam a
        // cópia de cartão ("Atualize o cartão"), confundindo clientes que só usam PIX.
        // Mesma regra do "vencido": com o cancelamento em análise o cliente não consegue repagar a parcela.
        const failedPayments = (await prisma.payment.findMany({
            where: { status: 'FAILED', provider: 'STRIPE', ...(staff ? {} : { userId }) },
            include: { user: { select: { name: true } }, contract: { select: { status: true } }, booking: { select: { status: true } } },
        })).filter(p => p.booking?.status !== 'CANCELLED' && !planPaymentBlockedByPendingCancellation(p, staff));
        for (const p of failedPayments) {
            const vars: Record<string, string | number> = staff ? { cliente: p.user.name, valor: fmtBRL(p.amount) } : {};
            notifications.push({
                id: `payment-failed-${p.id}`, type: 'PAYMENT_OVERDUE',
                severity: computedSeverity(failedEff, 'critical'),
                title: renderTemplate(failedEff.title, vars),
                message: renderTemplate(failedEff.message, vars),
                entityType: 'PAYMENT', entityId: p.id,
                actionUrl: staff ? '/admin/finance' : '/meus-pagamentos',
                createdAt: iso, read: false, source: 'computed',
            });
        }
    }

    // 3. Unconfirmed bookings — TODAY only, STAFF-only (the 7am dailyConfirmationJob owns
    // the client signal; a computed one here would shadow it via same type+entityId).
    const unconfEff = ev('computed_booking_unconfirmed_admin');
    if (staffSeesEvent(actor, 'computed_booking_unconfirmed_admin') && unconfEff.enabled) {
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const unconfirmedBookings = await prisma.booking.findMany({
            where: { status: 'RESERVED', date: { gte: today, lt: tomorrow } },
            include: { user: { select: { name: true } } },
        });
        for (const b of unconfirmedBookings) {
            const vars = { cliente: b.user.name, hora: b.startTime, diaLabel: 'hoje' };
            notifications.push({
                id: `booking-unconfirmed-${b.id}`, type: 'BOOKING_UNCONFIRMED',
                severity: computedSeverity(unconfEff, 'critical'),
                title: renderTemplate(unconfEff.title, vars),
                message: renderTemplate(unconfEff.message, vars),
                entityType: 'BOOKING', entityId: b.id, actionUrl: '/admin/today',
                createdAt: iso, read: false, source: 'computed',
            });
        }
    }

    // 4. Contracts pending cancellation
    const cancelKey = staff ? 'computed_cancellation_pending_admin' : 'computed_cancellation_pending';
    const cancelEff = ev(cancelKey);
    if (allowed(cancelKey) && cancelEff.enabled) {
        const pendingCancellations = await prisma.contract.findMany({
            where: { status: 'PENDING_CANCELLATION', ...(staff ? {} : { userId }) },
            include: { user: { select: { name: true } } },
        });
        for (const c of pendingCancellations) {
            const vars: Record<string, string | number> = staff ? { cliente: c.user.name, contrato: c.name } : { contrato: c.name };
            notifications.push({
                id: `cancellation-pending-${c.id}`, type: 'CANCELLATION_PENDING',
                severity: computedSeverity(cancelEff, 'warning'),
                title: renderTemplate(cancelEff.title, vars),
                message: renderTemplate(cancelEff.message, vars),
                entityType: 'CONTRACT', entityId: c.id,
                // Lista de Contratos: é lá que ficam "Cobrar multa" e "Isentar" (contratos.multa ⊃ contratos.ver).
                actionUrl: staff ? '/admin/contracts' : '/meus-contratos',
                createdAt: iso, read: false, source: 'computed',
            });
        }
    }

    // 4b. Contracts awaiting payment
    const awaitKey = staff ? 'computed_contract_awaiting_admin' : 'computed_contract_awaiting';
    const awaitEff = ev(awaitKey);
    if (allowed(awaitKey) && awaitEff.enabled) {
        const awaitingPayment = await prisma.contract.findMany({
            where: { status: 'AWAITING_PAYMENT', ...(staff ? {} : { userId }) },
            include: { user: { select: { name: true } } },
        });
        for (const c of awaitingPayment) {
            const deadline = c.paymentDeadline ? new Date(c.paymentDeadline) : null;
            const isUrgent = !!deadline && (deadline.getTime() - now.getTime()) < 30 * 60 * 1000;
            const vars: Record<string, string | number> = staff ? { cliente: c.user.name, contrato: c.name } : { contrato: c.name };
            notifications.push({
                id: `contract-awaiting-${c.id}`, type: 'CONTRACT_AWAITING_PAYMENT',
                severity: computedSeverity(awaitEff, isUrgent ? 'critical' : 'warning'),
                title: renderTemplate(awaitEff.title, vars),
                message: renderTemplate(awaitEff.message, vars),
                entityType: 'CONTRACT', entityId: c.id,
                // Equipe: o detalhe do contrato (abre com contratos.ver, a permissão do alerta — I3).
                actionUrl: staff ? `/admin/contracts/${c.id}` : '/meus-contratos',
                createdAt: iso, read: false, source: 'computed',
            });
        }
    }

    return notifications;
}

// ─── GET /api/notifications ─────────────────────────────
// Returns a mix of computed (real-time) and persisted (DB) notifications.
// Equipe: papel e permissões lidos do BANCO (getActor) — conta desativada/excluída → 401 ACCOUNT_DISABLED;
// cliente: só o JWT (sem consulta extra).

router.get('/', authenticate, async (req: Request, res: Response) => {
    try {
        const actor = await actorOrReply(req, res);
        if (!actor) return;
        const userId = actor.userId;

        const notifications = await buildComputedNotifications(actor);

        // Apply the computed-read state: read items stay visible (grey) but leave the counters.
        try {
            const readIds = new Set(await redis.smembers(computedReadKey(userId)));
            if (readIds.size > 0) {
                for (const n of notifications) {
                    if (readIds.has(n.id)) n.read = true;
                }
            }
        } catch { /* redis best-effort — worst case they show unread */ }

        // ── Persisted Notifications (from DB) ──
        const persistedNotifs = await getUserNotifications(userId, 30);
        const persistedIds = new Set<string>();

        for (const n of persistedNotifs) {
            // COLABORADOR: aviso antigo de uma tela que ele não abre mais (permissão retirada) sai do sino.
            if (!staffCanOpenLink(actor, n.actionUrl)) continue;
            // Avoid duplicates with computed (same entity)
            const alreadyInComputed = notifications.some(cn =>
                cn.entityId === n.entityId && cn.type === n.type,
            );
            if (alreadyInComputed) continue;

            persistedIds.add(n.id);
            notifications.push({
                id: n.id,
                type: n.type,
                severity: n.severity as 'critical' | 'warning' | 'info',
                title: n.title,
                message: n.message,
                entityType: n.entityType || '',
                entityId: n.entityId || '',
                actionUrl: n.actionUrl || undefined,
                createdAt: n.createdAt.toISOString(),
                read: n.read,
                source: 'persisted',
            });
        }

        // Sort: critical first, then warning, then info; unread first
        const severityOrder = { critical: 0, warning: 1, info: 2 };
        notifications.sort((a, b) => {
            if (a.read !== b.read) return a.read ? 1 : -1;
            return severityOrder[a.severity] - severityOrder[b.severity];
        });

        const unreadCount = notifications.filter(n => !n.read).length;

        res.json({
            notifications,
            summary: {
                total: notifications.length,
                unread: unreadCount,
                critical: notifications.filter(n => n.severity === 'critical' && !n.read).length,
                warning: notifications.filter(n => n.severity === 'warning' && !n.read).length,
                info: notifications.filter(n => n.severity === 'info' && !n.read).length,
            },
        });
    } catch (err) {
        console.error('Erro ao gerar notificações:', err);
        res.status(500).json({ error: 'Erro ao gerar notificações.' });
    }
});

// ─── PATCH /api/notifications/read-all ──────────────────
// MUST be registered BEFORE /:id routes to avoid being intercepted by :id param
router.patch('/read-all', authenticate, async (req: Request, res: Response) => {
    try {
        const actor = await actorOrReply(req, res);
        if (!actor) return;
        const count = await markAllAsRead(actor.userId);
        // Also remember the CURRENT computed notifications as read — otherwise they
        // resurrect unread on the next poll (e.g. "Cancelamento Pendente"). Só os que o ator vê.
        try {
            const computed = await buildComputedNotifications(actor);
            await markComputedRead(actor.userId, computed.map(n => n.id));
        } catch (err) { console.error('[NOTIF] computed read-all falhou (best-effort):', err); }
        res.json({ message: `${count} notificação(ões) marcada(s) como lida(s).`, count });
    } catch (err) {
        console.error('Erro ao marcar notificações:', err);
        res.status(500).json({ error: 'Erro ao marcar notificações.' });
    }
});

// ─── PATCH /api/notifications/:id/read ──────────────────
router.patch('/:id/read', authenticate, async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        // Computed notifications don't live in the DB — record the read in Redis.
        if (COMPUTED_ID_RE.test(id)) {
            await markComputedRead(req.user!.userId, [id]);
            res.json({ message: 'Marcada como lida.' });
            return;
        }
        const success = await markAsRead(req.user!.userId, id);
        if (!success) return res.status(404).json({ error: 'Notificação não encontrada.' });
        res.json({ message: 'Marcada como lida.' });
    } catch (err) {
        console.error('Erro ao marcar notificação:', err);
        res.status(500).json({ error: 'Erro ao marcar notificação.' });
    }
});

// ─── DELETE /api/notifications/:id ──────────────────────
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
    try {
        const success = await deleteNotification(req.user!.userId, req.params.id as string);
        if (!success) return res.status(404).json({ error: 'Notificação não encontrada.' });
        res.json({ message: 'Notificação removida.' });
    } catch (err) {
        console.error('Erro ao deletar notificação:', err);
        res.status(500).json({ error: 'Erro ao deletar notificação.' });
    }
});

export default router;
