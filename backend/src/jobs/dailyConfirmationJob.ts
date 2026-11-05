import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { saoPauloParts } from '../lib/spTime.js';
import { notifyEvent } from '../modules/notifications/notificationService.js';
import { sessionPaymentState, SESSION_PAYMENT_SELECT, type SessionPaymentLike } from '../modules/bookings/sessionPayment.js';

/**
 * Daily Confirmation Job — fires once per day at 07:00 (America/Sao_Paulo).
 *
 * On the MORNING of each recording day, notifies the CLIENT about that day's session:
 *  - paid    → "✅ Gravação confirmada"
 *  - not paid → "💳 Pague para confirmar"
 *
 * This job is the single owner of the client's "today's session" signal — the computed
 * BOOKING_UNCONFIRMED for TODAY is admin-only (routes.ts + pushNotificationJob), so the
 * 7am push isn't pre-empted by the 5-min push job's dedup window.
 *
 * "Paid" rules (per business decision; R5 — o pagamento é o DA SESSÃO, modules/bookings/sessionPayment):
 *  - Session with its OWN charge (Payment marked metadata.sessionCharge: SERVIÇO, FIXO extra, avulso/session
 *    charged by the team) that is still OPEN or PAID → confirmed only if that charge is paid (no marked charge
 *    PENDING/FAILED and one marked PAID). Nothing below overrides it: a paid extra or a contract in good standing
 *    does not (ATU4-02). AUDFIN-02: a marked charge only VOIDED/REFUNDED leaves nothing to pay → the rules below
 *    decide (as before the mark existed), instead of a "Pague para confirmar" that leads to an empty page.
 *  - Unmarked: the RECORDING payment PAID (not an add-on purchase) → confirmed (covers the client's avulso).
 *  - Avulso with no paid recording payment → confirmed only if the booking status is CONFIRMED
 *    (system lifecycle) or its marked charge was only voided/refunded (nothing to pay — TELA6-02), otherwise
 *    not confirmed.
 *  - Recurring/contract session → confirmed if the contract is ACTIVE and not in arrears
 *    (no overdue PENDING installment); i.e. paid in full OR the current cycle isn't overdue.
 *
 * Runs every 30 min; the body only executes when the São Paulo hour is 7, guarded by a daily
 * Redis marker (optimization) plus per-booking dedup so each session gets exactly one message
 * per day even across restarts / multiple instances. Pass { force, forceDate } to test.
 */

const TARGET_HOUR_SP = 7;

type PaymentLite = { status: string; dueDate: Date | null; bookingId: string | null };
export type BookingForConfirm = {
    status: string;
    /** Payments da reserva (status + metadata + paymentUrl: a marca da sessão e a compra de extras). */
    payments: SessionPaymentLike[];
    contract: { status: string; type: string; payments: PaymentLite[] } | null;
};

export function isBookingPaid(b: BookingForConfirm, now: Date): boolean {
    const own = sessionPaymentState(b.payments ?? []);
    // 0. ATU4-02: a sessão com cobrança PRÓPRIA marcada só está paga quando ESSA cobrança está paga — a mesma regra
    //    do /confirm (402). Nem um extra pago (regra 1) nem o contrato em dia (regra 3) a substituem.
    //    AUDFIN-02: só quando há marcada em aberto ou paga. Marcada só anulada/estornada (por quem tem a baixa) não
    //    deixa nada a pagar — "Pague para confirmar" levaria a uma tela vazia; caem as regras 2/3 (avulso → "confirmada",
    //    TELA6-02; contrato em dia → "confirmada").
    if (own.marked && (own.open || own.paid)) return own.paid;

    // 1. The RECORDING payment tied to this session is PAID (covers avulso paid up-front) — never an add-on purchase.
    if (own.paid) return true;

    const c = b.contract;
    // 2. Avulso (or unknown contract): a CONFIRMED status means the session was confirmed
    // through the system lifecycle (e.g. by an admin), so treat it as confirmed even if the
    // payment row was later voided — avoids a contradictory "ainda não está paga" nudge.
    // TELA6-02: o mesmo para o avulso RESERVADO cuja cobrança marcada foi só anulada/estornada (por quem tem a baixa):
    // não há nada a pagar e o /confirm aceita (awaitsOwnPayment) — "Pague para confirmar" levaria a um Meus pagamentos
    // vazio. Aqui own.paid é false, então a condição só pega a marcada sem nada em aberto. Sem a marca (avulso do
    // próprio cliente) a regra não muda: o /confirm ainda espera o pagamento da gravação.
    if (!c || c.type === 'AVULSO') return b.status === 'CONFIRMED' || (own.marked && !own.open);

    // 3. Recurring/contract session: confirmed only if the contract is active and not in arrears.
    if (c.status !== 'ACTIVE') return false;
    const installments = (c.payments || []).filter(p => p.bookingId == null && p.status !== 'CANCELLED');
    const hasOverdue = installments.some(p => p.status === 'PENDING' && p.dueDate != null && new Date(p.dueDate) < now);
    return !hasOverdue;
}

export async function runDailyConfirmationJob(opts?: { force?: boolean; forceDate?: string }): Promise<void> {
    const now = new Date();
    const sp = saoPauloParts(now);

    // Only fire at 07:00 São Paulo (unless forced for testing).
    if (!opts?.force && sp.hour !== TARGET_HOUR_SP) return;

    const dateStr = opts?.forceDate || sp.dateStr; // YYYY-MM-DD in São Paulo calendar

    // Once-per-day optimization: skip re-scanning if we already finished today's run.
    // (Per-booking dedup below still guarantees no double-sends even if this check races.)
    const doneKey = `cron:daily-confirm:done:${dateStr}`;
    if (!opts?.force) {
        try { if (await redis.get(doneKey)) return; } catch { /* redis best-effort */ }
    }

    // Bookings stored as @db.Date at 00:00Z — match the SP calendar date via a UTC range.
    const [y, m, d] = dateStr.split('-').map(Number);
    const dayStart = new Date(Date.UTC(y, m - 1, d));
    const dayEnd = new Date(Date.UTC(y, m - 1, d + 1));

    const bookings = await prisma.booking.findMany({
        where: {
            date: { gte: dayStart, lt: dayEnd },
            status: { in: ['RESERVED', 'CONFIRMED'] },
        },
        include: {
            payments: { select: SESSION_PAYMENT_SELECT },
            contract: {
                select: {
                    status: true,
                    type: true,
                    payments: { select: { status: true, dueDate: true, bookingId: true } },
                },
            },
        },
    });

    let sent = 0;
    for (const b of bookings) {
        const paid = isBookingPaid(b as unknown as BookingForConfirm, now);
        // Date-scoped dedup identity, independent of the 5-min push job's BOOKING_* keys.
        const dedupId = `daily-confirm:${b.userId}:${b.id}:${dateStr}`;
        try {
            await notifyEvent(
                paid ? 'daily_confirmation_paid' : 'daily_confirmation_unpaid',
                {
                    userId: b.userId,
                    vars: { hora: b.startTime },
                    entityType: 'BOOKING',
                    entityId: b.id,
                    dedupKey: dedupId,
                },
            );
            sent++;
        } catch (err) {
            console.error(`[DAILY-CONFIRM] Failed for booking ${b.id}:`, err);
        }
    }

    // Mark the day done only AFTER the loop, so a mid-loop crash lets the next tick retry.
    if (!opts?.force) {
        try { await redis.set(doneKey, '1', 'EX', 23 * 3600); } catch { /* best-effort */ }
    }

    if (sent > 0) console.log(`[DAILY-CONFIRM] Sent ${sent} confirmation notifications for ${dateStr}.`);
}
