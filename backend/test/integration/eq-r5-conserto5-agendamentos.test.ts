import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// ─── Notificações em segundo plano ───────────────────────────────────────────────────────────────
// Os efeitos do pagamento avisam sem await em alguns caminhos: o INSERT em `notifications` não pode cruzar com o
// TRUNCATE do caso seguinte. O mock só embrulha as funções reais para o afterEach aguardar.
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
import { addDaysYmd } from '../../src/lib/avulsoMakeup';
import { syncContractCompletion } from '../../src/lib/contractCompletion';
import { runDailyConfirmationJob } from '../../src/jobs/dailyConfirmationJob';
import bookingRoutes from '../../src/modules/bookings/routes';
import contractRoutes from '../../src/modules/contracts/routes';
import paymentRoutes from '../../src/modules/payments/routes';
import { mkUser, mkStaff, mkContract, mkBooking, mkCpf } from './factories';

// CONSERTO 5 (revisão 5) — agendamentos e cobrança da sessão:
//  (A) AUDFIN-01/ATU5-01/TELA5-01: a sessão cancelada cuja cobrança PRÓPRIA foi anulada não volta a ficar em aberto
//      (Reservado/Confirmado) — 409 SESSION_CHARGE_VOIDED para todos, inclusive o ADMIN; Concluído/Não realizado
//      passam e a resposta avisa (reopenedWithoutCharge). O avulso pago e a sessão de plano reabrem como antes.
//  (B) AUDFIN-02: a marcada só ANULADA/ESTORNADA não deixa nada a pagar — /confirm 200 e o aviso das 7h cai nas regras
//      2/3 (avulso Confirmado / contrato em dia), em vez de "Pague para confirmar" sem cobrança.
//  (C) ATU5-02/TELA5-02: só a sessão criada com o teto do FIXO já cheio é EXTRA (marca fixoExtra). A sessão que o ADMIN
//      cria DENTRO do teto (cobrada, "Confirmado" grava PAID) ocupa a vaga: o cliente não agenda uma a mais e o plano
//      conclui ao fim das sessões dele.
//  (D) TELA5-05: o 403 da exclusão definitiva tem texto próprio (sem "cancelar…/use Falta").
//  (E) AUDFIN-05: GET /contracts/my traz planSessionsUsed (a conta do servidor) no FIXO.

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
    await prisma.addOnConfig.create({ data: { key: 'CORTES_IA', name: 'Cortes', price: 10000 } });
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

// ─── Datas (relógio real, calendário de São Paulo) ──────
const todaySp = saoPauloParts(new Date()).dateStr;
const dbDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const dow = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
function weekdayN(n: number): string {
    let found = -1;
    for (let d = addDaysYmd(todaySp, 3); ; d = addDaysYmd(d, 1)) {
        if (dow(d) >= 1 && dow(d) <= 5 && ++found === n) return d;
    }
}
function pastWeekdayN(n: number): string {
    let found = -1;
    for (let d = addDaysYmd(todaySp, -1); ; d = addDaysYmd(d, -1)) {
        if (dow(d) >= 1 && dow(d) <= 5 && ++found === n) return d;
    }
}
const slot = (date: string, startTime: string) => ({ date: dbDate(date), startTime, endTime: `${String(Number(startTime.slice(0, 2)) + 2).padStart(2, '0')}${startTime.slice(2)}` });

const RECEPCAO = ['agendamentos.ver', 'agendamentos.criar', 'agendamentos.editar', 'agendamentos.faltas', 'agendamentos.cancelar', 'hoje.ver', 'hoje.presenca', 'clientes.ver', 'clientes.criar', 'clientes.editar', 'contratos.ver', 'contratos.criar', 'cobrancas.cobrar', 'cupons.ver'];

const SESSION_CHARGE_VOIDED = {
    error: 'A cobrança desta sessão foi anulada e não volta com a reabertura, então ela não pode voltar a ficar em aberto (Reservado, Em espera ou Confirmado) sem cobrança. Para gravar, crie um novo agendamento: ele gera a cobrança de novo.',
    code: 'SESSION_CHARGE_VOIDED',
};
const WITHOUT_CHARGE_NOTE = ' A cobrança desta sessão foi anulada e não volta com a reabertura: a sessão fica sem cobrança.';
const REOPEN_CHARGE_VOIDED = 'Reabrir uma sessão cancelada exige a permissão “Marcar como pago, anular ou estornar”: a cobrança dela foi anulada no cancelamento. Para uma nova sessão, crie um novo agendamento.';
const OPEN_CHARGE_DELETE_403 = {
    error: 'Esta sessão tem cobrança em aberto: excluir anula a cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa.',
    code: 'PERMISSION_DENIED',
    permission: 'cobrancas.baixa',
};
const FIXO_LIMIT = 'Limite de agendamentos do plano fixo atingido.';

const booking = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } });
const statusOf = async (id: string) => (await booking(id)).status;
const payment = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
const payStatus = async (id: string) => (await payment(id)).status;
const newClient = () => mkUser({ cpfCnpj: mkCpf() });
const openCharges = (bookingId: string) => prisma.payment.count({ where: { bookingId, status: { in: ['PENDING', 'FAILED'] } } });

/** Avulso criado pela Recepção no balcão (POST /bookings/admin sem contrato): RESERVED + cobrança marcada PENDING. */
async function avulsoFromDesk(recepcao: Who, clientId: string, date: string, startTime = '10:00') {
    const c = await call('POST', '/api/bookings/admin', recepcao, { userId: clientId, date, startTime });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(await payment(c.body.paymentId)).toMatchObject({ status: 'PENDING', metadata: { sessionCharge: true } });
    return { bookingId: c.body.booking.id as string, paymentId: c.body.paymentId as string };
}

// ─── (A) Reabrir sessão cancelada cuja cobrança foi anulada ───────────────────────────────────────

describe('Conserto 5 (A) — AUDFIN-01/ATU5-01/TELA5-01: reabrir não devolve a sessão em aberto sem cobrança', () => {
    it('ADMIN cancela o avulso da Recepção (cobrança anulada) e tenta reabrir como Confirmado/Reservado → 409 para todos; nada muda', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const financeiro = await mkStaff({ permissions: [...RECEPCAO, 'cobrancas.baixa'] });
        const client = await newClient();
        const a = await avulsoFromDesk(recepcao, client.id, weekdayN(0));

        const del = await call('DELETE', `/api/bookings/${a.bookingId}`, admin);
        expect(del.status, JSON.stringify(del.body)).toBe(200);
        expect(await payStatus(a.paymentId)).toBe('CANCELLED');

        for (const who of [admin, financeiro]) {
            for (const status of ['CONFIRMED', 'RESERVED']) {
                const r = await call('PATCH', `/api/bookings/${a.bookingId}`, who, { status });
                expect(r.status, `${who.role}/${status}: ${JSON.stringify(r.body)}`).toBe(409);
                expect(r.body).toEqual(SESSION_CHARGE_VOIDED);
            }
        }
        expect(await statusOf(a.bookingId)).toBe('CANCELLED');
        expect(await payStatus(a.paymentId)).toBe('CANCELLED');
        expect(await prisma.payment.count({ where: { bookingId: a.bookingId } })).toBe(1);

        // Sem a baixa, a Recepção continua recebendo o 403 dela (o texto da cobrança anulada), como antes.
        const rec = await call('PATCH', `/api/bookings/${a.bookingId}`, recepcao, { status: 'CONFIRMED' });
        expect(rec.status).toBe(403);
        expect(rec.body).toEqual({ error: REOPEN_CHARGE_VOIDED, code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa' });
    });

    it('o mesmo quando o PRÓPRIO cliente cancelou o avulso (DELETE do cliente anula) e o ADMIN tenta reabrir', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();
        const a = await avulsoFromDesk(recepcao, client.id, weekdayN(1));
        const del = await call('DELETE', `/api/bookings/${a.bookingId}`, client);
        expect(del.status, JSON.stringify(del.body)).toBe(200);
        expect(await payStatus(a.paymentId)).toBe('CANCELLED');

        const r = await call('PATCH', `/api/bookings/${a.bookingId}`, admin, { status: 'CONFIRMED' });
        expect(r.status, JSON.stringify(r.body)).toBe(409);
        expect(r.body).toEqual(SESSION_CHARGE_VOIDED);
        expect(await statusOf(a.bookingId)).toBe('CANCELLED');
    });

    it('SERVIÇO com a cobrança da sessão anulada no cancelamento também: Confirmado → 409', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        const c = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: servico.id, date: weekdayN(2), startTime: '10:00' });
        expect(c.status, JSON.stringify(c.body)).toBe(201);
        expect((await call('DELETE', `/api/bookings/${c.body.booking.id}`, admin)).status).toBe(200);
        const r = await call('PATCH', `/api/bookings/${c.body.booking.id}`, admin, { status: 'CONFIRMED' });
        expect(r.status, JSON.stringify(r.body)).toBe(409);
        expect(r.body.code).toBe('SESSION_CHARGE_VOIDED');
    });

    it('Concluído (a sessão aconteceu) passa para quem tem a baixa — 200, com o aviso de que fica sem cobrança', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();
        const a = await avulsoFromDesk(recepcao, client.id, weekdayN(3));
        expect((await call('DELETE', `/api/bookings/${a.bookingId}`, admin)).status).toBe(200);

        const r = await call('PATCH', `/api/bookings/${a.bookingId}`, admin, { status: 'COMPLETED' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.reopenedWithoutCharge).toBe(true);
        expect(r.body.message).toBe(`Agendamento atualizado com sucesso.${WITHOUT_CHARGE_NOTE}`);
        expect(r.body.booking).toMatchObject({ status: 'COMPLETED', openChargeCount: 0 });
        expect(await payStatus(a.paymentId)).toBe('CANCELLED');
    });

    it('controles: avulso PAGO cancelado e sessão de plano (sem cobrança própria) reabrem como Confirmado (200), sem o aviso', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();

        const paid = await avulsoFromDesk(recepcao, client.id, weekdayN(4));
        await prisma.payment.update({ where: { id: paid.paymentId }, data: { status: 'PAID', paidAt: new Date() } });
        expect((await call('DELETE', `/api/bookings/${paid.bookingId}`, admin)).status).toBe(200);
        const r1 = await call('PATCH', `/api/bookings/${paid.bookingId}`, admin, { status: 'CONFIRMED' });
        expect(r1.status, JSON.stringify(r1.body)).toBe(200);
        expect(r1.body.reopenedWithoutCharge).toBeUndefined();
        expect(r1.body.message).toBe('Agendamento atualizado com sucesso.');
        expect(await payStatus(paid.paymentId)).toBe('PAID');

        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL' });
        const plan = await mkBooking(client.id, fixo.id, { ...slot(weekdayN(5), '10:00'), status: 'CONFIRMED' });
        expect((await call('DELETE', `/api/bookings/${plan.id}`, admin)).status).toBe(200);
        const r2 = await call('PATCH', `/api/bookings/${plan.id}`, admin, { status: 'CONFIRMED' });
        expect(r2.status, JSON.stringify(r2.body)).toBe(200);
        expect(r2.body.reopenedWithoutCharge).toBeUndefined();
    });
});

// ─── (B) Cobrança própria só anulada/estornada ───────────────────────────────────────────────────

describe('Conserto 5 (B) — AUDFIN-02: a marcada só anulada ou estornada não deixa nada a pagar', () => {
    it('/confirm: SERVIÇO da Recepção com a cobrança anulada pelo ADMIN (PATCH /payments) → 200; em aberto → 402', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        const mk = async (n: number) => {
            const c = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: servico.id, date: weekdayN(n), startTime: '10:00' });
            expect(c.status, JSON.stringify(c.body)).toBe(201);
            return { bookingId: c.body.booking.id as string, paymentId: c.body.paymentId as string };
        };

        const open = await mk(0);
        const denied = await call('PATCH', `/api/bookings/${open.bookingId}/confirm`, client);
        expect(denied.status, JSON.stringify(denied.body)).toBe(402);

        const voided = await mk(1);
        const annul = await call('PATCH', `/api/payments/${voided.paymentId}`, admin, { status: 'CANCELLED' });
        expect(annul.status, JSON.stringify(annul.body)).toBe(200);
        const ok = await call('PATCH', `/api/bookings/${voided.bookingId}/confirm`, client);
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(await statusOf(voided.bookingId)).toBe('CONFIRMED');
    });

    it('aviso das 7h: SERVIÇO em dia com a marcada ANULADA ou ESTORNADA → "confirmada"; com a marcada em aberto → "Pague para confirmar"', async () => {
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        await prisma.payment.create({ data: { userId: client.id, contractId: servico.id, provider: 'SICOOB', amount: 50000, status: 'PAID', paidAt: new Date(), dueDate: dbDate(pastWeekdayN(3)) } });
        const day = weekdayN(0);
        const mk = async (time: string, status: 'CANCELLED' | 'REFUNDED' | 'PENDING') => {
            const b = await mkBooking(client.id, servico.id, { ...slot(day, time), status: 'RESERVED' });
            await prisma.payment.create({ data: { userId: client.id, contractId: servico.id, bookingId: b.id, provider: 'SICOOB', amount: 30000, status, metadata: { sessionCharge: true } } });
            return b.id;
        };
        const voided = await mk('08:00', 'CANCELLED');
        const refunded = await mk('10:30', 'REFUNDED');
        const open = await mk('13:00', 'PENDING');

        await runDailyConfirmationJob({ force: true, forceDate: day });
        await Promise.allSettled([...background.pending]);
        const typeOf = async (id: string) => (await prisma.notification.findFirstOrThrow({ where: { entityId: id, userId: client.id } })).type;
        expect(await typeOf(voided)).toBe('BOOKING_CONFIRMED');
        expect(await typeOf(refunded)).toBe('BOOKING_CONFIRMED');
        expect(await typeOf(open)).toBe('BOOKING_UNCONFIRMED');
    });
});

// ─── (C) Teto do FIXO: só a EXTRA (teto cheio) fica fora ─────────────────────────────────────────

describe('Conserto 5 (C) — ATU5-02/TELA5-02: a sessão FIXO do ADMIN dentro do teto ocupa a vaga', () => {
    it('FIXO de 4 com uma sessão em Não realizado: o ADMIN repõe como "Confirmado" (PAID, sem fixoExtra) → o cliente não agenda uma a mais (400)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL', durationMonths: 1 }); // teto 4
        const sessions = [];
        for (let i = 0; i < 4; i++) sessions.push(await mkBooking(client.id, fixo.id, { ...slot(weekdayN(5 + i), '15:30'), status: 'CONFIRMED' }));
        await prisma.booking.update({ where: { id: sessions[0]!.id }, data: { status: 'NAO_REALIZADO' } });

        const repo = await call('POST', '/api/bookings/admin', admin, { userId: client.id, contractId: fixo.id, date: weekdayN(0), startTime: '10:00', status: 'CONFIRMED' });
        expect(repo.status, JSON.stringify(repo.body)).toBe(201);
        const p = await payment(repo.body.paymentId);
        expect(p).toMatchObject({ status: 'PAID', metadata: { sessionCharge: true } });
        expect((p.metadata as Record<string, unknown>).fixoExtra).toBeUndefined();

        const own = await call('POST', '/api/bookings', client, { date: weekdayN(1), startTime: '10:00', contractId: fixo.id });
        expect(own.status, JSON.stringify(own.body)).toBe(400);
        expect(own.body.error).toBe(FIXO_LIMIT);
    });

    it('com o teto CHEIO o ADMIN cria a EXTRA (fixoExtra): ela não ocupa vaga — liberada uma vaga do plano, o cliente agenda (201)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL', durationMonths: 1 });
        const sessions = [];
        for (let i = 0; i < 4; i++) sessions.push(await mkBooking(client.id, fixo.id, { ...slot(weekdayN(5 + i), '15:30'), status: 'CONFIRMED' }));

        const extra = await call('POST', '/api/bookings/admin', admin, { userId: client.id, contractId: fixo.id, date: weekdayN(0), startTime: '10:00', status: 'RESERVED' });
        expect(extra.status, JSON.stringify(extra.body)).toBe(201);
        expect(await payment(extra.body.paymentId)).toMatchObject({ status: 'PENDING', metadata: { sessionCharge: true, fixoExtra: true } });

        await prisma.booking.update({ where: { id: sessions[1]!.id }, data: { status: 'CANCELLED' } });
        const own = await call('POST', '/api/bookings', client, { date: weekdayN(1), startTime: '10:00', contractId: fixo.id });
        expect(own.status, JSON.stringify(own.body)).toBe(201);
    });

    it('conclusão: 3 sessões do plano + a reposição do ADMIN dentro do teto, todas Concluídas → o FIXO conclui', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL', durationMonths: 1 });
        for (let i = 0; i < 3; i++) await mkBooking(client.id, fixo.id, { ...slot(pastWeekdayN(i), '10:00'), status: 'COMPLETED' });
        const repo = await call('POST', '/api/bookings/admin', admin, { userId: client.id, contractId: fixo.id, date: weekdayN(0), startTime: '10:00', status: 'CONFIRMED' });
        expect(repo.status, JSON.stringify(repo.body)).toBe(201);
        await prisma.booking.update({ where: { id: repo.body.booking.id }, data: { status: 'COMPLETED' } });
        await syncContractCompletion(fixo.id);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: fixo.id } })).status).toBe('COMPLETED');
    });

    it('Não realizado → Concluído pela Recepção: a sessão do ADMIN dentro do teto confere o teto (409 cheio); a EXTRA não (200)', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL', durationMonths: 1 });
        for (let i = 0; i < 4; i++) await mkBooking(client.id, fixo.id, { ...slot(weekdayN(5 + i), '15:30'), status: 'CONFIRMED' });
        const mkNr = async (time: string, metadata: Record<string, boolean>) => {
            const b = await mkBooking(client.id, fixo.id, { ...slot(weekdayN(0), time), status: 'NAO_REALIZADO' });
            await prisma.payment.create({ data: { userId: client.id, contractId: fixo.id, bookingId: b.id, provider: 'SICOOB', amount: 30000, status: 'PAID', paidAt: new Date(), metadata } });
            return b.id;
        };
        const inCap = await mkNr('10:00', { sessionCharge: true });
        const extra = await mkNr('13:00', { sessionCharge: true, fixoExtra: true });

        const r1 = await call('PATCH', `/api/bookings/${inCap}`, recepcao, { status: 'COMPLETED' });
        expect(r1.status, JSON.stringify(r1.body)).toBe(409);
        expect(r1.body.code).toBe('FIXO_LIMIT_REACHED');
        const r2 = await call('PATCH', `/api/bookings/${extra}`, recepcao, { status: 'COMPLETED' });
        expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    });
});

// ─── (D) Exclusão definitiva: texto próprio ─────────────────────────────────────────────────────

describe('Conserto 5 (D) — TELA5-05: o 403 da exclusão fala em excluir (sem "use Falta")', () => {
    it('sem a baixa: 403 com o texto da exclusão e nada muda; com a baixa: exclui e anula', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const excluir = await mkStaff({ permissions: [...RECEPCAO, 'agendamentos.excluir'] });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();
        const a = await avulsoFromDesk(recepcao, client.id, weekdayN(0));
        const r = await call('DELETE', `/api/bookings/${a.bookingId}/hard-delete`, excluir);
        expect(r).toEqual({ status: 403, body: OPEN_CHARGE_DELETE_403 });
        expect(r.body.error).not.toMatch(/Falta|cancelar anula/);
        expect(await statusOf(a.bookingId)).toBe('RESERVED');
        expect(await payStatus(a.paymentId)).toBe('PENDING');

        const ok = await call('DELETE', `/api/bookings/${a.bookingId}/hard-delete`, admin);
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(await prisma.booking.findUnique({ where: { id: a.bookingId } })).toBeNull();
        expect(await payStatus(a.paymentId)).toBe('CANCELLED');
    });
});

// ─── (E) GET /contracts/my: vagas do FIXO pela conta do servidor ─────────────────────────────────

describe('Conserto 5 (E) — AUDFIN-05: GET /contracts/my traz planSessionsUsed no FIXO', () => {
    it('3 sessões do plano + 1 cancelada + 1 EXTRA paga: planSessionsUsed 3 (completedBookings segue 4) e o cliente agenda pelo plano', async () => {
        const client = await newClient();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL', durationMonths: 1 });
        for (let i = 0; i < 3; i++) await mkBooking(client.id, fixo.id, { ...slot(weekdayN(5 + i), '15:30'), status: 'CONFIRMED' });
        await mkBooking(client.id, fixo.id, { ...slot(weekdayN(8), '15:30'), status: 'CANCELLED' });
        const extra = await mkBooking(client.id, fixo.id, { ...slot(weekdayN(9), '15:30'), status: 'CONFIRMED' });
        await prisma.payment.create({ data: { userId: client.id, contractId: fixo.id, bookingId: extra.id, provider: 'SICOOB', amount: 30000, status: 'PAID', paidAt: new Date(), metadata: { sessionCharge: true, fixoExtra: true } } });
        const flex = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 12, flexCreditsRemaining: 5 });

        const my = await call('GET', '/api/contracts/my', client);
        expect(my.status, JSON.stringify(my.body)).toBe(200);
        const f = my.body.contracts.find((c: any) => c.id === fixo.id);
        expect(f).toMatchObject({ planSessionsUsed: 3, completedBookings: 4, totalBookings: 4 });
        expect(my.body.contracts.find((c: any) => c.id === flex.id)).not.toHaveProperty('planSessionsUsed');

        // RESERVED também ocupa (a mesma conta do POST /): a sessão nova do cliente sobe para 4 — o servidor bate.
        const own = await call('POST', '/api/bookings', client, { date: weekdayN(0), startTime: '10:00', contractId: fixo.id });
        expect(own.status, JSON.stringify(own.body)).toBe(201);
        const again = await call('GET', '/api/contracts/my', client);
        expect(again.body.contracts.find((c: any) => c.id === fixo.id).planSessionsUsed).toBe(4);
        const full = await call('POST', '/api/bookings', client, { date: weekdayN(1), startTime: '10:00', contractId: fixo.id });
        expect(full.status).toBe(400);
        expect(full.body.error).toBe(FIXO_LIMIT);
    });
});

// ─── openChargeCount sem efeito colateral (sanidade) ──
describe('Conserto 5 — sanidade', () => {
    it('a sessão reaberta como Concluído fica sem cobrança em aberto (openCharges 0)', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();
        const a = await avulsoFromDesk(recepcao, client.id, weekdayN(2));
        expect((await call('DELETE', `/api/bookings/${a.bookingId}`, admin)).status).toBe(200);
        expect((await call('PATCH', `/api/bookings/${a.bookingId}`, admin, { status: 'NAO_REALIZADO', statusReason: 'Equipamento.' })).status).toBe(200);
        expect(await openCharges(a.bookingId)).toBe(0);
    });
});
