import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// ─── Notificações em segundo plano ───────────────────────────────────────────────────────────────
const background = vi.hoisted(() => ({ pending: new Set<Promise<unknown>>() }));
vi.mock('../../src/modules/notifications/notificationService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/modules/notifications/notificationService')>();
    const tracked = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => (...a: A): Promise<R> => {
        const p = fn(...a);
        background.pending.add(p);
        const done = () => { background.pending.delete(p); };
        p.then(done, done);
        return p;
    };
    return { ...orig, notifyEvent: tracked(orig.notifyEvent), createNotification: tracked(orig.createNotification) };
});
vi.mock('../../src/modules/push/pushService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/modules/push/pushService')>();
    return { ...orig, sendPushToUser: vi.fn(async () => 1) };
});

import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { config } from '../../src/config/index';
import { saoPauloParts } from '../../src/lib/spTime';
import { addDaysYmd, computeMakeupDeadline, makeupExpiredReason } from '../../src/lib/avulsoMakeup';
import { runDailyConfirmationJob } from '../../src/jobs/dailyConfirmationJob';
import bookingRoutes from '../../src/modules/bookings/routes';
import contractRoutes from '../../src/modules/contracts/routes';
import paymentRoutes from '../../src/modules/payments/routes';
import { mkUser, mkStaff, mkContract, mkBooking, mkPayment, mkCpf } from './factories';

// RODADA 7 — frente R7a (backend), agendamentos:
//  (A) AUDFIN6-02: a sessão cuja cobrança própria foi anulada não volta a ficar em aberto (Reservado/Em espera/
//      Confirmado) a partir de QUALQUER status fechado — Concluído, Falta, Não realizado, não só Cancelado: 409
//      SESSION_CHARGE_VOIDED para todos, antes de qualquer escrita (sem descontar crédito). Entre status em aberto
//      (Reservado → Confirmado) e com a cobrança viva nada muda.
//  (B) AUDFIN6-03/TELA6-01: o PATCH → Não realizado de um avulso diz se a janela de remarcação abriu (makeupOpened,
//      makeupDeadline) e, se não, por quê (makeupBlockReason).
//  (C) TELA6-02: o aviso das 7h do avulso Reservado da Recepção com a cobrança anulada pelo PATCH /payments diz
//      "confirmada" (nada a pagar), como o /confirm.

type Who = { id: string; email: string | null; role: string };

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/bookings', bookingRoutes);
    app.use('/api/contracts', contractRoutes);
    app.use('/api/payments', paymentRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
    const keys = [...await redis.keys('booking:lock:*'), ...await redis.keys('booking:fixo-cap:*')];
    if (keys.length) await redis.del(...keys);
});

afterEach(async () => {
    for (let idle = 0; idle < 3;) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (background.pending.size === 0) idle++;
        else { idle = 0; await Promise.allSettled([...background.pending]); }
    }
});

function cookie(u: Who) {
    return `accessToken=${jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' })}`;
}

async function call(method: string, path: string, who: Who, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: { Cookie: cookie(who), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

const todaySp = saoPauloParts(new Date()).dateStr;
const dbDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const dow = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
function weekdayN(n: number): string {
    let found = -1;
    for (let d = addDaysYmd(todaySp, 3); ; d = addDaysYmd(d, 1)) {
        if (dow(d) >= 1 && dow(d) <= 5 && ++found === n) return d;
    }
}
const slot = (date: string, startTime: string) => ({ date: dbDate(date), startTime, endTime: `${String(Number(startTime.slice(0, 2)) + 2).padStart(2, '0')}${startTime.slice(2)}` });

const RECEPCAO = ['agendamentos.ver', 'agendamentos.criar', 'agendamentos.editar', 'agendamentos.faltas', 'agendamentos.cancelar', 'hoje.ver', 'hoje.presenca', 'clientes.ver', 'clientes.criar', 'clientes.editar', 'contratos.ver', 'contratos.criar', 'cobrancas.cobrar', 'cupons.ver'];

const SESSION_CHARGE_VOIDED = {
    error: 'A cobrança desta sessão foi anulada e não volta com a reabertura, então ela não pode voltar a ficar em aberto (Reservado, Em espera ou Confirmado) sem cobrança. Para gravar, crie um novo agendamento: ele gera a cobrança de novo.',
    code: 'SESSION_CHARGE_VOIDED',
};
const NOT_PAID_REASON = 'O pagamento desta gravação não está confirmado; a remarcação sem novo pagamento só vale para gravação paga.';

const booking = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } });
const statusOf = async (id: string) => (await booking(id)).status;
const payStatus = async (id: string) => (await prisma.payment.findUniqueOrThrow({ where: { id } })).status;
const newClient = () => mkUser({ cpfCnpj: mkCpf() });
const creditsOf = async (bookingId: string) => {
    const b = await booking(bookingId);
    return (await prisma.contract.findUniqueOrThrow({ where: { id: b.contractId! } })).flexCreditsRemaining;
};

/** Avulso criado pela Recepção no balcão (POST /bookings/admin sem contrato): RESERVED + cobrança marcada PENDING. */
async function avulsoFromDesk(recepcao: Who, clientId: string, date: string, startTime = '10:00') {
    const c = await call('POST', '/api/bookings/admin', recepcao, { userId: clientId, date, startTime });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: c.body.paymentId } })).toMatchObject({ status: 'PENDING', metadata: { sessionCharge: true } });
    return { bookingId: c.body.booking.id as string, paymentId: c.body.paymentId as string };
}

// ─── (A) A cobrança anulada não volta "em aberto" a partir de nenhum status fechado ──────────────

describe('R7a (A) — AUDFIN6-02: 409 SESSION_CHARGE_VOIDED também saindo de Concluído, Falta e Não realizado', () => {
    it('Cancelado → Concluído (ADMIN, com o aviso) e depois a Recepção → Confirmado/Reservado: 409 e nada muda; o ADMIN também recebe 409', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();
        const a = await avulsoFromDesk(recepcao, client.id, weekdayN(0));
        expect((await call('DELETE', `/api/bookings/${a.bookingId}`, admin)).status).toBe(200);
        const done = await call('PATCH', `/api/bookings/${a.bookingId}`, admin, { status: 'COMPLETED' });
        expect(done.status, JSON.stringify(done.body)).toBe(200);
        expect(done.body.reopenedWithoutCharge).toBe(true);

        for (const who of [recepcao, admin]) {
            for (const status of ['CONFIRMED', 'RESERVED']) {
                const r = await call('PATCH', `/api/bookings/${a.bookingId}`, who, { status });
                expect(r.status, `${who.role}/${status}: ${JSON.stringify(r.body)}`).toBe(409);
                expect(r.body).toEqual(SESSION_CHARGE_VOIDED);
            }
        }
        expect(await statusOf(a.bookingId)).toBe('COMPLETED');
        expect(await payStatus(a.paymentId)).toBe('CANCELLED');
    });

    it('Cancelado → Não realizado (ADMIN) e depois a Recepção → Confirmado: 409 ANTES de descontar o crédito', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();
        const a = await avulsoFromDesk(recepcao, client.id, weekdayN(1));
        expect((await call('DELETE', `/api/bookings/${a.bookingId}`, admin)).status).toBe(200);
        const nr = await call('PATCH', `/api/bookings/${a.bookingId}`, admin, { status: 'NAO_REALIZADO', statusReason: 'Equipamento.' });
        expect(nr.status, JSON.stringify(nr.body)).toBe(200);
        const credits = await creditsOf(a.bookingId);

        const r = await call('PATCH', `/api/bookings/${a.bookingId}`, recepcao, { status: 'CONFIRMED' });
        expect(r.status, JSON.stringify(r.body)).toBe(409);
        expect(r.body).toEqual(SESSION_CHARGE_VOIDED);
        expect(await statusOf(a.bookingId)).toBe('NAO_REALIZADO');
        expect(await creditsOf(a.bookingId)).toBe(credits);
    });

    it('perdoada em aberto (PATCH /payments) e marcada como Falta: Falta → Confirmado também 409', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();
        const a = await avulsoFromDesk(recepcao, client.id, weekdayN(2));
        expect((await call('PATCH', `/api/payments/${a.paymentId}`, admin, { status: 'CANCELLED' })).status).toBe(200);
        const falta = await call('PATCH', `/api/bookings/${a.bookingId}`, recepcao, { status: 'FALTA', statusReason: 'Não veio.' });
        expect(falta.status, JSON.stringify(falta.body)).toBe(200);
        const r = await call('PATCH', `/api/bookings/${a.bookingId}`, recepcao, { status: 'CONFIRMED' });
        expect(r.status, JSON.stringify(r.body)).toBe(409);
        expect(r.body).toEqual(SESSION_CHARGE_VOIDED);
        expect(await statusOf(a.bookingId)).toBe('FALTA');
    });

    it('controles: perdoada AINDA em aberto (Reservado → Confirmado), avulso Concluído PAGO e sessão de plano Concluída → Confirmado: 200', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();

        const forgiven = await avulsoFromDesk(recepcao, client.id, weekdayN(3));
        expect((await call('PATCH', `/api/payments/${forgiven.paymentId}`, admin, { status: 'CANCELLED' })).status).toBe(200);
        const r1 = await call('PATCH', `/api/bookings/${forgiven.bookingId}`, recepcao, { status: 'CONFIRMED' });
        expect(r1.status, JSON.stringify(r1.body)).toBe(200);

        const paid = await avulsoFromDesk(recepcao, client.id, weekdayN(4));
        await prisma.payment.update({ where: { id: paid.paymentId }, data: { status: 'PAID', paidAt: new Date() } });
        await prisma.booking.update({ where: { id: paid.bookingId }, data: { status: 'COMPLETED' } });
        const r2 = await call('PATCH', `/api/bookings/${paid.bookingId}`, recepcao, { status: 'CONFIRMED' });
        expect(r2.status, JSON.stringify(r2.body)).toBe(200);

        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL' });
        const plan = await mkBooking(client.id, fixo.id, { ...slot(weekdayN(5), '10:00'), status: 'COMPLETED' });
        const r3 = await call('PATCH', `/api/bookings/${plan.id}`, recepcao, { status: 'CONFIRMED' });
        expect(r3.status, JSON.stringify(r3.body)).toBe(200);
    });
});

// ─── (B) A resposta do → Não realizado diz o que aconteceu com a janela ──────────────────────────

describe('R7a (B) — AUDFIN6-03/TELA6-01: PATCH → Não realizado devolve makeupOpened / makeupDeadline / makeupBlockReason', () => {
    it('avulso NÃO PAGO (o caso comum da Recepção): sem janela, com o motivo do servidor', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const a = await avulsoFromDesk(recepcao, client.id, weekdayN(0));
        const r = await call('PATCH', `/api/bookings/${a.bookingId}`, recepcao, { status: 'NAO_REALIZADO', statusReason: 'Equipamento.' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body).toMatchObject({ makeupOpened: false, makeupDeadline: null, makeupBlockReason: NOT_PAID_REASON });
        expect(r.body.booking.makeupStatus).toBeNull();
    });

    it('avulso PAGO: janela aberta, com o prazo gravado e sem motivo', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const day = weekdayN(1);
        const a = await avulsoFromDesk(recepcao, client.id, day);
        await prisma.payment.update({ where: { id: a.paymentId }, data: { status: 'PAID', paidAt: new Date() } });
        const r = await call('PATCH', `/api/bookings/${a.bookingId}`, recepcao, { status: 'NAO_REALIZADO', statusReason: 'Equipamento.' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        const deadline = computeMakeupDeadline(dbDate(day), 7);
        expect(r.body).toMatchObject({ makeupOpened: true, makeupDeadline: deadline.toISOString(), makeupBlockReason: null });
        expect(r.body.booking.makeupStatus).toBe('OPEN');
    });

    it('avulso PAGO com o prazo já vencido: janela gravada como EXPIRED, makeupOpened false e o motivo do prazo', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();
        const day = addDaysYmd(todaySp, -20);
        const avulso = await mkContract(client.id, { type: 'AVULSO', durationMonths: 1, discountPct: 0, paymentPlan: 'FULL', startDate: dbDate(day), endDate: dbDate(day), flexCreditsTotal: 1, flexCreditsRemaining: 0 });
        const b = await mkBooking(client.id, avulso.id, { ...slot(day, '10:00'), status: 'CONFIRMED' });
        await mkPayment(client.id, { contractId: avulso.id, bookingId: b.id, status: 'PAID', paidAt: new Date(), amount: 30000, metadata: { sessionCharge: true } });
        const r = await call('PATCH', `/api/bookings/${b.id}`, admin, { status: 'NAO_REALIZADO', statusReason: 'Equipamento.' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        const deadline = computeMakeupDeadline(dbDate(day), 7);
        expect(r.body).toMatchObject({ makeupOpened: false, makeupDeadline: deadline.toISOString(), makeupBlockReason: makeupExpiredReason(deadline) });
        expect(r.body.booking.makeupStatus).toBe('EXPIRED');
    });

    it('Cancelado (cobrança anulada) → Não realizado: o aviso "sem cobrança" E a janela não aberta, com o motivo', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();
        const a = await avulsoFromDesk(recepcao, client.id, weekdayN(2));
        expect((await call('DELETE', `/api/bookings/${a.bookingId}`, admin)).status).toBe(200);
        const r = await call('PATCH', `/api/bookings/${a.bookingId}`, admin, { status: 'NAO_REALIZADO', statusReason: 'Equipamento.' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body).toMatchObject({ reopenedWithoutCharge: true, makeupOpened: false, makeupDeadline: null, makeupBlockReason: NOT_PAID_REASON });
        expect(r.body.booking.makeupStatus).toBeNull();
    });

    it('fora do avulso (FIXO) a resposta não traz os campos da janela', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL' });
        const b = await mkBooking(client.id, fixo.id, { ...slot(weekdayN(3), '10:00'), status: 'CONFIRMED' });
        const r = await call('PATCH', `/api/bookings/${b.id}`, recepcao, { status: 'NAO_REALIZADO', statusReason: 'Equipamento.' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body).not.toHaveProperty('makeupOpened');
        expect(r.body).not.toHaveProperty('makeupBlockReason');
    });
});

// ─── (C) Aviso das 7h coerente com o /confirm ────────────────────────────────────────────────────

describe('R7a (C) — TELA6-02: avulso Reservado da Recepção com a cobrança anulada recebe "confirmada", não "Pague para confirmar"', () => {
    it('anulada pelo PATCH /payments → BOOKING_CONFIRMED (e o /confirm aceita); controle sem anular → BOOKING_UNCONFIRMED', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();
        const day = weekdayN(4);
        const voided = await avulsoFromDesk(recepcao, client.id, day, '10:00');
        const open = await avulsoFromDesk(recepcao, client.id, day, '15:30');
        expect((await call('PATCH', `/api/payments/${voided.paymentId}`, admin, { status: 'CANCELLED' })).status).toBe(200);
        expect(await statusOf(voided.bookingId)).toBe('RESERVED');

        await runDailyConfirmationJob({ force: true, forceDate: day });
        await Promise.allSettled([...background.pending]);
        const typeOf = async (id: string) => (await prisma.notification.findFirstOrThrow({ where: { entityId: id, userId: client.id } })).type;
        expect(await typeOf(voided.bookingId)).toBe('BOOKING_CONFIRMED');
        expect(await typeOf(open.bookingId)).toBe('BOOKING_UNCONFIRMED');

        // A mesma resposta do /confirm do cliente: nada a pagar → 200; com a cobrança em aberto → 402.
        expect((await call('PATCH', `/api/bookings/${voided.bookingId}/confirm`, client)).status).toBe(200);
        expect((await call('PATCH', `/api/bookings/${open.bookingId}/confirm`, client)).status).toBe(402);
    });
});
