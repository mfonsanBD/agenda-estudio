import { prisma } from '../lib/prisma.js';
import { saoPauloParts } from '../lib/spTime.js';
import { notifyEvent } from '../modules/notifications/notificationService.js';
import { planPaymentBlockedByPendingCancellation } from '../lib/cancellationPending.js';
import { canAny, type Actor, type ActorRole } from '../middleware/permissions.js';
import { permissionsForRole, staffEventPermissions } from '../config/staffPermissions.js';

/**
 * Push Notification Job — runs every 5 minutes.
 * Delivers (push + persist) the SAME computed rule set that GET /notifications
 * shows, using the shared event catalog/templates (single source of truth). It
 * emits the deliverable subset: overdue (aggregated), today's unconfirmed
 * sessions (equipe), and expiring contracts.
 *
 * Equipe (ADMIN + COLABORADOR): papel, situação e permissões lidos do BANCO a cada rodada. Conta
 * desativada (BLOCKED) ou excluída não recebe nada (crítica S1); o COLABORADOR só recebe os alertas
 * cuja permissão tem (STAFF_EVENT_PERMISSIONS), com o mesmo link do sino.
 *
 * De-noised vs the pre-rodada-5 version:
 *  - the "≤2 FLEX credits" info push was removed (it fired every poll and the
 *    jun/2026 prune already dropped that signal from the bell);
 *  - the client/admin "tomorrow unconfirmed" push was dropped — tomorrow is
 *    already covered by the 24h bookingReminderJob, and the GET computed rule
 *    is today-only. Push and bell now show exactly the same set.
 */
const fmtBRL = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

interface PendingEvent {
    eventKey: string;
    vars: Record<string, string | number>;
    entityType: string;
    entityId: string;
    severityOverride?: 'critical' | 'warning' | 'info';
    dedupKey?: string;
    actionUrl?: string;
}

export async function runPushNotificationJob(): Promise<void> {
    const now = new Date();
    // São Paulo calendar day as 00:00Z (matches @db.Date + keeps day windows/labels correct
    // after 21:00 SP, when the UTC date has already rolled over to tomorrow).
    const sp = saoPauloParts(now);
    const today = new Date(Date.UTC(sp.y, sp.m - 1, sp.day));

    // Desativado (BLOCKED) ou excluído fica de fora já na consulta (S1); loadRecipient confere de novo.
    const usersWithSubs = await prisma.pushSubscription.findMany({
        where: { user: { deletedAt: null, clientStatus: { not: 'BLOCKED' } } },
        select: { userId: true },
        distinct: ['userId'],
    });
    if (usersWithSubs.length === 0) return;

    let totalSent = 0;
    for (const { userId } of usersWithSubs) {
        try {
            const events = await computeUserEvents(userId, today);
            for (const e of events) {
                try {
                    // notifyEvent resolves the (admin-editable) template, respects enabled,
                    // dedups and pushes. entityId matches the GET computed id so the two
                    // never show as duplicates.
                    const id = await notifyEvent(e.eventKey, {
                        userId,
                        vars: e.vars,
                        entityType: e.entityType,
                        entityId: e.entityId,
                        severityOverride: e.severityOverride,
                        dedupKey: e.dedupKey,
                        actionUrl: e.actionUrl,
                    });
                    if (id) totalSent++;
                } catch { /* dedup or other error — skip silently */ }
            }
        } catch (err) {
            console.error(`[PUSH-JOB] Error processing user ${userId}:`, err);
        }
    }

    if (totalSent > 0) {
        console.log(`[PUSH-JOB] Processed ${totalSent} push notifications.`);
    }
}

function recipientActor(userId: string, role: ActorRole, storedPermissions: readonly unknown[] | null): Actor {
    return {
        userId,
        role,
        isAdmin: role === 'ADMIN',
        isStaff: role === 'ADMIN' || role === 'COLABORADOR',
        permissions: new Set(permissionsForRole(role, storedPermissions)),
    };
}

/**
 * Quem recebe, lido do BANCO nesta rodada (mesma regra do getActor): conta inexistente, excluída ou
 * desativada (BLOCKED) → null (sem push). Só o COLABORADOR lê staff_profiles (crítica M1: ADMIN e cliente
 * nunca dependem da tabela); se essa leitura falhar, o erro sobe e o usuário fica sem push nesta rodada
 * (falha fechada — nunca entrega com permissão desconhecida).
 */
async function loadRecipient(userId: string): Promise<Actor | null> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true, clientStatus: true, deletedAt: true },
    });
    if (!user || user.deletedAt || user.clientStatus === 'BLOCKED') return null;
    if (user.role === 'COLABORADOR') {
        const profile = await prisma.staffProfile.findUnique({ where: { userId }, select: { permissions: true } });
        return recipientActor(userId, 'COLABORADOR', profile?.permissions ?? []);
    }
    return recipientActor(userId, user.role === 'ADMIN' ? 'ADMIN' : 'CLIENTE', null);
}

/** A equipe recebe o alerta `eventKey`? ADMIN: sempre; COLABORADOR: com QUALQUER permissão do evento. (= sino) */
function staffSeesEvent(actor: Actor, eventKey: string): boolean {
    if (!actor.isStaff) return false;
    return actor.isAdmin || canAny(actor, ...staffEventPermissions(eventKey));
}

/** Compute the events to deliver for a specific user (mirrors GET computed rules). */
async function computeUserEvents(userId: string, today: Date): Promise<PendingEvent[]> {
    const events: PendingEvent[] = [];
    const actor = await loadRecipient(userId);
    if (!actor) return events;

    // `staff` = visão da equipe (todos os clientes); cada bloco só roda com a permissão do evento.
    const staff = actor.isStaff;
    const allowed = (eventKey: string) => !staff || staffSeesEvent(actor, eventKey);
    const thresholdDays = staff ? 7 : 15;
    const targetDate = new Date(today);
    targetDate.setDate(targetDate.getDate() + thresholdDays);
    const daysOverdue = (p: { dueDate: Date | null }) => Math.ceil((today.getTime() - new Date(p.dueDate!).getTime()) / (1000 * 60 * 60 * 24));

    // ── Overdue payments — AGGREGATED (B1) ──
    // Mesmo filtro do sino (GET /notifications): com o cancelamento em análise (E13) o CLIENTE não paga
    // parcela do plano (409 CANCELLATION_PENDING) — então também não recebe o push de "faturas vencidas"
    // dela. Extras de gravação, a multa e parcelas de outros contratos continuam avisando; a equipe vê tudo.
    // Cobrança de uma gravação CANCELADA (extra que ficou em aberto — dado legado) não é pagável
    // (BOOKING_CANCELLED) e fica fora do aviso, para o cliente e para a equipe.
    const overdueKey = staff ? 'computed_payment_overdue_admin' : 'computed_payment_overdue';
    const overduePayments = !allowed(overdueKey) ? [] : (await prisma.payment.findMany({
        where: { status: 'PENDING', dueDate: { lt: today }, ...(staff ? {} : { userId }) },
        include: { user: { select: { name: true } }, contract: { select: { status: true } }, booking: { select: { status: true } } },
    })).filter(p => p.booking?.status !== 'CANCELLED' && !planPaymentBlockedByPendingCancellation(p, staff));
    if (staff) {
        const byClient = new Map<string, { name: string; count: number; total: number; maxDays: number }>();
        for (const p of overduePayments) {
            const g = byClient.get(p.userId) ?? { name: p.user.name, count: 0, total: 0, maxDays: 0 };
            g.count++; g.total += p.amount; g.maxDays = Math.max(g.maxDays, daysOverdue(p));
            byClient.set(p.userId, g);
        }
        for (const [clientId, g] of byClient) {
            events.push({
                eventKey: overdueKey,
                vars: { cliente: g.name, quantidade: g.count, total: fmtBRL(g.total), diasMax: g.maxDays },
                entityType: 'PAYMENT', entityId: clientId,
                severityOverride: g.maxDays > 7 ? 'critical' : 'warning',
            });
        }
    } else if (overduePayments.length > 0) {
        let total = 0, maxDays = 0;
        for (const p of overduePayments) { total += p.amount; maxDays = Math.max(maxDays, daysOverdue(p)); }
        events.push({
            eventKey: 'computed_payment_overdue',
            vars: { quantidade: overduePayments.length, total: fmtBRL(total), diasMax: maxDays },
            entityType: 'PAYMENT', entityId: 'agg',
            severityOverride: maxDays > 7 ? 'critical' : 'warning',
            // Stable key: recurs on the per-severity dedup TTL, but paying an invoice
            // down no longer mints a fresh key that re-pushes immediately.
            dedupKey: `overdue-agg:${userId}`,
        });
    }

    // ── Unconfirmed sessions — TODAY, STAFF only (mirrors GET computed) ──
    if (staffSeesEvent(actor, 'computed_booking_unconfirmed_admin')) {
        const tomorrow = new Date(today.getTime() + 86_400_000);
        const unconfirmed = await prisma.booking.findMany({
            where: { status: 'RESERVED', date: { gte: today, lt: tomorrow } },
            include: { user: { select: { name: true } } },
            take: 10,
        });
        for (const b of unconfirmed) {
            events.push({
                eventKey: 'computed_booking_unconfirmed_admin',
                vars: { cliente: b.user.name, hora: b.startTime, diaLabel: 'hoje' },
                entityType: 'BOOKING', entityId: b.id,
                severityOverride: 'critical',
            });
        }
    }

    // ── Expiring contracts ── (paridade com GET /notifications: sem AVULSO; plano COMPLETED ainda
    // recebe o lembrete de renovação — D6)
    const expiringKey = staff ? 'computed_contract_expiring_admin' : 'computed_contract_expiring';
    const expiringContracts = !allowed(expiringKey) ? [] : await prisma.contract.findMany({
        where: {
            status: { in: ['ACTIVE', 'COMPLETED'] },
            type: { not: 'AVULSO' },
            endDate: { gte: today, lte: targetDate },
            ...(staff ? {} : { userId }),
        },
        include: { user: { select: { name: true } } },
        take: 3,
    });
    for (const c of expiringContracts) {
        const dias = Math.ceil((new Date(c.endDate).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        const vars: Record<string, string | number> = staff ? { cliente: c.user.name, contrato: c.name, dias } : { contrato: c.name, dias };
        events.push({
            eventKey: expiringKey,
            vars, entityType: 'CONTRACT', entityId: c.id,
            severityOverride: dias <= 2 ? 'critical' : 'warning',
            // Equipe: o detalhe do contrato, como no sino (abre com contratos.ver — I3).
            ...(staff ? { actionUrl: `/admin/contracts/${c.id}` } : {}),
        });
    }

    return events;
}
