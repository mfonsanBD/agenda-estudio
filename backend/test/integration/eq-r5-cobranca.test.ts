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

// ─── Corrida (R5): simula uma cobrança criada no meio do cancelamento ────────────────────────────
// hasOpenCharge é a conferência do cancelamento sem a baixa. `before(n)` roda antes da n-ésima conferência (para
// gravar uma cobrança DEPOIS da transição) e `skip` faz a n-ésima "não ver" a cobrança (a conferência que perdeu a
// corrida). Fora dos testes de corrida, é a função real.
const race = vi.hoisted(() => ({
    calls: 0, skip: new Set<number>(), before: null as null | ((n: number) => Promise<void>),
    batches: [] as number[], // tamanho de cada lote do withOpenChargeCount (openChargeCount dos payloads da equipe)
}));
vi.mock('../../src/modules/bookings/booking.service', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/modules/bookings/booking.service')>();
    return {
        ...orig,
        hasOpenCharge: async (bookingId: string) => {
            const n = ++race.calls;
            if (race.before) await race.before(n);
            if (race.skip.has(n)) return false;
            return orig.hasOpenCharge(bookingId);
        },
        withOpenChargeCount: async <T extends { id: string }>(list: readonly T[]) => {
            race.batches.push(list.length);
            return orig.withOpenChargeCount(list);
        },
    };
});

// Corridas reproduzidas no PRÓPRIO banco de teste (um gatilho por caso, removido no fim): o efeito concorrente
// acontece dentro da escrita que o dispara, sem tocar no cliente Prisma.
async function withTrigger(name: string, table: 'payments' | 'bookings', when: 'INSERT' | 'UPDATE', body: string, run: () => Promise<void>) {
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $fn$ BEGIN ${body} RETURN NEW; END $fn$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${name} AFTER ${when} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
        await run();
    } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
    }
}

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
import { onPaymentConfirmed } from '../../src/lib/paymentEffects';
import { syncContractCompletion } from '../../src/lib/contractCompletion';
import { cleanExpiredHolds } from '../../src/jobs/cleanExpiredHolds';
import { runDailyConfirmationJob } from '../../src/jobs/dailyConfirmationJob';
import bookingRoutes from '../../src/modules/bookings/routes';
import { mkUser, mkStaff, mkContract, mkBooking, mkCpf } from './factories';

// FRENTE R5a — cobrança da sessão:
//  (1) PRINCÍPIO: anular cobrança em aberto é da baixa. A equipe sem cobrancas.baixa não cancela (DELETE, PATCH →
//      CANCELLED, hard-delete) uma sessão com Payment PENDING/FAILED — qualquer status/data/gravação. Fecha FIN-09 e
//      ATU4-01 (reabrir/remarcar e DEPOIS cancelar). ADMIN, quem tem a baixa e o cliente seguem como antes.
//  (2) avulso cancelado: o PENDING/FAILED dele é anulado (antes ficava preso, impagável e listado como devido).
//  (3) pagamento DA SESSÃO: um extra pago não confirma (/confirm, varredura dos holds), não libera a remarcação do
//      avulso (ATU4-04/UXT-07) e não dispara o "Gravação confirmada" das 7h (ATU4-02).
//  (4) teto do FIXO: a sessão EXTRA (cobrança própria marcada) não ocupa vaga do plano nem o conclui antes.
//  (5) 403 de reabrir sessão cancelada: o texto só fala em cobrança anulada quando houve.
//  (6) payloads da equipe com openChargeCount (lote, groupBy).

type Who = { id: string; email: string | null; role: string };

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/bookings', bookingRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
    race.calls = 0;
    race.skip = new Set();
    race.before = null;
    race.batches = [];
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
const COM_BAIXA = [...RECEPCAO, 'cobrancas.baixa'];

const OPEN_CHARGE_403 = {
    error: 'Esta sessão tem cobrança em aberto: cancelar anula a cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa ou, se o cliente faltou, use Falta (a cobrança continua devida).',
    code: 'PERMISSION_DENIED',
    permission: 'cobrancas.baixa',
};
// Conserto 5 (TELA5-05): o 403 da EXCLUSÃO tem texto próprio (mesmo code/permission), sem a sugestão de Falta.
const OPEN_CHARGE_DELETE_403 = {
    error: 'Esta sessão tem cobrança em aberto: excluir anula a cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa.',
    code: 'PERMISSION_DENIED',
    permission: 'cobrancas.baixa',
};
const REOPEN_OWN_CHARGE = 'Reabrir uma sessão cancelada exige a permissão “Marcar como pago, anular ou estornar”. Esta sessão já tem cobrança própria: peça a quem tem essa permissão para reabri-la. Não crie um novo agendamento — o cliente seria cobrado de novo.';
const REOPEN_CHARGE_VOIDED = 'Reabrir uma sessão cancelada exige a permissão “Marcar como pago, anular ou estornar”: a cobrança dela foi anulada no cancelamento. Para uma nova sessão, crie um novo agendamento.';
const REOPEN_NO_CHARGE = 'Reabrir uma sessão cancelada exige a permissão “Marcar como pago, anular ou estornar”. Para uma nova sessão, crie um novo agendamento.';
const MAKEUP_NOT_PAID = 'O pagamento desta gravação não está confirmado; a remarcação sem novo pagamento só vale para gravação paga.';

const booking = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } });
const statusOf = async (id: string) => (await booking(id)).status;
const payStatus = async (id: string) => (await prisma.payment.findUniqueOrThrow({ where: { id } })).status;
const newClient = () => mkUser({ cpfCnpj: mkCpf() });
const pay = async (paymentId: string) => {
    await prisma.payment.update({ where: { id: paymentId }, data: { status: 'PAID', paidAt: new Date() } });
    await onPaymentConfirmed(paymentId);
};

/** Sessão de SERVIÇO criada pela Recepção (RESERVED, cobrança da sessão PENDING com a marca). */
async function servicoSession(recepcao: Who, clientId: string, contractId: string, date: string, startTime = '10:00') {
    const c = await call('POST', '/api/bookings/admin', recepcao, { userId: clientId, contractId, date, startTime });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: c.body.paymentId } })).toMatchObject({ status: 'PENDING', metadata: { sessionCharge: true } });
    return { bookingId: c.body.booking.id as string, paymentId: c.body.paymentId as string, date };
}

/** O cliente contrata um extra na própria reserva (POST /:id/addons) → Payment do extra (sem a marca). */
async function buyExtra(client: Who, bookingId: string) {
    const r = await call('POST', `/api/bookings/${bookingId}/addons`, client, { addonKeys: ['CORTES_IA'] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return prisma.payment.findUniqueOrThrow({ where: { id: r.body.paymentId } });
}

// ─── (1) Critério estrutural: cancelar = anular ──────────────────────────────────────────────────

describe('R5 (1) — sem cobrancas.baixa, nenhuma sessão com cobrança em aberto é cancelada', () => {
    it('FIN-09 (ataque inteiro): Concluída com a gravação iniciada → Confirmada em outra data (200, o início é zerado) → DELETE e PATCH → CANCELLED dão 403; a cobrança segue PENDING', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        const s = await servicoSession(recepcao, client.id, servico.id, weekdayN(0));
        await prisma.booking.update({ where: { id: s.bookingId }, data: { status: 'COMPLETED', recordingStartedAt: new Date(), recordingStartedByName: 'Op' } });

        // Passo 1: reabrir com outra data (mesmo dia da semana e horário → mesma faixa). Continua permitido.
        const moved = await call('PATCH', `/api/bookings/${s.bookingId}`, recepcao, { status: 'CONFIRMED', date: addDaysYmd(s.date, 7), startTime: '10:00' });
        expect(moved.status, JSON.stringify(moved.body)).toBe(200);
        expect(moved.body.booking).toMatchObject({ status: 'CONFIRMED', recordingStartedAt: null, openChargeCount: 1 });

        // Passo 2: cancelar — o "já aconteceu" sumiu, mas a cobrança em aberto continua lá.
        const del = await call('DELETE', `/api/bookings/${s.bookingId}`, recepcao);
        expect(del.status, JSON.stringify(del.body)).toBe(403);
        expect(del.body).toEqual(OPEN_CHARGE_403);
        const patch = await call('PATCH', `/api/bookings/${s.bookingId}`, recepcao, { status: 'CANCELLED' });
        expect(patch.status, JSON.stringify(patch.body)).toBe(403);
        expect(patch.body).toEqual(OPEN_CHARGE_403);
        expect(await statusOf(s.bookingId)).toBe('CONFIRMED');
        expect(await payStatus(s.paymentId)).toBe('PENDING');
    });

    it('ATU4-01 (dois passos): Confirmada com a gravação iniciada, PATCH só de data (200) → DELETE 403; e Falta → Confirmada (200) → DELETE 403', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });

        const live = await servicoSession(recepcao, client.id, servico.id, weekdayN(0));
        await prisma.booking.update({ where: { id: live.bookingId }, data: { status: 'CONFIRMED', recordingStartedAt: new Date() } });
        const step1 = await call('PATCH', `/api/bookings/${live.bookingId}`, recepcao, { date: addDaysYmd(live.date, 7) });
        expect(step1.status, JSON.stringify(step1.body)).toBe(200);
        expect(step1.body.booking.recordingStartedAt).toBeNull();
        const step2 = await call('DELETE', `/api/bookings/${live.bookingId}`, recepcao);
        expect(step2.status, JSON.stringify(step2.body)).toBe(403);
        expect(step2.body).toEqual(OPEN_CHARGE_403);
        expect(await statusOf(live.bookingId)).toBe('CONFIRMED');
        expect(await payStatus(live.paymentId)).toBe('PENDING');

        const falta = await servicoSession(recepcao, client.id, servico.id, weekdayN(1));
        expect((await call('PATCH', `/api/bookings/${falta.bookingId}`, recepcao, { status: 'FALTA', statusReason: 'Não veio.' })).status).toBe(200);
        expect((await call('PATCH', `/api/bookings/${falta.bookingId}`, recepcao, { status: 'CONFIRMED' })).status).toBe(200);
        const del = await call('DELETE', `/api/bookings/${falta.bookingId}`, recepcao);
        expect(del.status, JSON.stringify(del.body)).toBe(403);
        expect(await statusOf(falta.bookingId)).toBe('CONFIRMED');
        expect(await payStatus(falta.paymentId)).toBe('PENDING');
    });

    it('resíduos do conserto 3 também fechados: Concluída sem início → Não realizado → Cancelado; Confirmada passada sem início (DELETE); "Desfazer início" → Cancelar', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const operador = await mkStaff({ permissions: ['agendamentos.ver', 'agendamentos.cancelar', 'hoje.ver', 'hoje.gravacao'] });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });

        const nr = await servicoSession(recepcao, client.id, servico.id, weekdayN(0));
        await prisma.booking.update({ where: { id: nr.bookingId }, data: { status: 'COMPLETED' } });
        expect((await call('PATCH', `/api/bookings/${nr.bookingId}`, recepcao, { status: 'NAO_REALIZADO', statusReason: 'Equipamento.' })).status).toBe(200);
        const r1 = await call('PATCH', `/api/bookings/${nr.bookingId}`, recepcao, { status: 'CANCELLED' });
        expect(r1.status, JSON.stringify(r1.body)).toBe(403);
        expect(r1.body).toEqual(OPEN_CHARGE_403);
        expect(await statusOf(nr.bookingId)).toBe('NAO_REALIZADO');
        expect(await payStatus(nr.paymentId)).toBe('PENDING');

        const past = await servicoSession(recepcao, client.id, servico.id, weekdayN(1));
        await prisma.booking.update({ where: { id: past.bookingId }, data: { status: 'CONFIRMED', ...slot(pastWeekdayN(0), '10:00') } });
        const r2 = await call('DELETE', `/api/bookings/${past.bookingId}`, recepcao);
        expect(r2.status, JSON.stringify(r2.body)).toBe(403);
        expect(await payStatus(past.paymentId)).toBe('PENDING');

        const undo = await servicoSession(recepcao, client.id, servico.id, weekdayN(2));
        await prisma.booking.update({ where: { id: undo.bookingId }, data: { status: 'CONFIRMED', recordingStartedAt: new Date() } });
        expect((await call('PUT', `/api/bookings/${undo.bookingId}/undo-start-recording`, operador)).status).toBe(200);
        const r3 = await call('DELETE', `/api/bookings/${undo.bookingId}`, operador);
        expect(r3.status, JSON.stringify(r3.body)).toBe(403);
        expect(r3.body).toEqual(OPEN_CHARGE_403);
        expect(await statusOf(undo.bookingId)).toBe('CONFIRMED');
        expect(await payStatus(undo.paymentId)).toBe('PENDING');
    });

    it('vale para sessão FUTURA, para cobrança FAILED e para extra em aberto de sessão de plano; hard-delete sem a baixa também', async () => {
        const recepcao = await mkStaff({ permissions: [...RECEPCAO, 'agendamentos.excluir'] });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL' });

        const fut = await servicoSession(recepcao, client.id, servico.id, weekdayN(0));
        expect(await call('DELETE', `/api/bookings/${fut.bookingId}`, recepcao)).toEqual({ status: 403, body: OPEN_CHARGE_403 });
        expect(await call('PATCH', `/api/bookings/${fut.bookingId}`, recepcao, { status: 'CANCELLED' })).toEqual({ status: 403, body: OPEN_CHARGE_403 });
        expect(await call('DELETE', `/api/bookings/${fut.bookingId}/hard-delete`, recepcao)).toEqual({ status: 403, body: OPEN_CHARGE_DELETE_403 });
        expect(await statusOf(fut.bookingId)).toBe('RESERVED');

        await prisma.payment.update({ where: { id: fut.paymentId }, data: { status: 'FAILED' } });
        expect((await call('DELETE', `/api/bookings/${fut.bookingId}`, recepcao)).status).toBe(403);
        expect(await payStatus(fut.paymentId)).toBe('FAILED');

        const plan = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: fixo.id, date: weekdayN(1), startTime: '10:00', addOns: ['CORTES_IA'] });
        expect(plan.status, JSON.stringify(plan.body)).toBe(201);
        expect(plan.body.coveredByPlan).toBe(true);
        expect(await call('DELETE', `/api/bookings/${plan.body.booking.id}`, recepcao)).toEqual({ status: 403, body: OPEN_CHARGE_403 });
        expect(await statusOf(plan.body.booking.id)).toBe('RESERVED');
        expect(await payStatus(plan.body.paymentId)).toBe('PENDING');
    });

    it('a regra da tabela vem primeiro: sem agendamentos.cancelar o 403 é o dele (DELETE e PATCH)', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const semCancelar = await mkStaff({ permissions: ['agendamentos.ver', 'agendamentos.editar', 'agendamentos.faltas'] });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        const s = await servicoSession(recepcao, client.id, servico.id, weekdayN(0));
        for (const r of [await call('DELETE', `/api/bookings/${s.bookingId}`, semCancelar), await call('PATCH', `/api/bookings/${s.bookingId}`, semCancelar, { status: 'CANCELLED' })]) {
            expect(r.status).toBe(403);
            expect(r.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'agendamentos.cancelar' });
        }
    });

    it('ADMIN e quem tem a baixa: DELETE, PATCH e hard-delete seguem (200) e anulam a cobrança em aberto, como antes', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const baixa = await mkStaff({ permissions: [...COM_BAIXA, 'agendamentos.excluir'] });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        let i = 0;
        for (const who of [baixa, admin]) {
            const a = await servicoSession(recepcao, client.id, servico.id, weekdayN(i++));
            const del = await call('DELETE', `/api/bookings/${a.bookingId}`, who);
            expect(del.status, JSON.stringify(del.body)).toBe(200);
            expect(del.body).toMatchObject({ voidedExtras: 1, message: 'Reserva cancelada com sucesso. 1 cobrança em aberto desta gravação foi cancelada.' });
            expect(await payStatus(a.paymentId)).toBe('CANCELLED');

            const b = await servicoSession(recepcao, client.id, servico.id, weekdayN(i++));
            await prisma.booking.update({ where: { id: b.bookingId }, data: { status: 'COMPLETED', recordingStartedAt: new Date() } });
            const patch = await call('PATCH', `/api/bookings/${b.bookingId}`, who, { status: 'CANCELLED' });
            expect(patch.status, JSON.stringify(patch.body)).toBe(200);
            expect(patch.body.voidedExtras).toBe(1);
            expect(await payStatus(b.paymentId)).toBe('CANCELLED');

            const c = await servicoSession(recepcao, client.id, servico.id, weekdayN(i++));
            const hd = await call('DELETE', `/api/bookings/${c.bookingId}/hard-delete`, who);
            expect(hd.status, JSON.stringify(hd.body)).toBe(200);
            expect(hd.body.voidedExtras).toBe(1);
            expect(await payStatus(c.paymentId)).toBe('CANCELLED');
        }
    });

    it('sem cobrança em aberto a Recepção cancela como antes: SERVIÇO pago (o PAID fica) e sessão de plano sem cobrança; hard-delete também', async () => {
        const recepcao = await mkStaff({ permissions: [...RECEPCAO, 'agendamentos.excluir'] });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        const paid = await servicoSession(recepcao, client.id, servico.id, weekdayN(0));
        await prisma.payment.update({ where: { id: paid.paymentId }, data: { status: 'PAID', paidAt: new Date() } });
        const r = await call('DELETE', `/api/bookings/${paid.bookingId}`, recepcao);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body).toEqual({ message: 'Reserva cancelada com sucesso.', voidedExtras: 0 });
        expect(await payStatus(paid.paymentId)).toBe('PAID');

        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL' });
        const plan = await mkBooking(client.id, fixo.id, { ...slot(pastWeekdayN(0), '10:00'), status: 'COMPLETED' });
        expect((await call('PATCH', `/api/bookings/${plan.id}`, recepcao, { status: 'CANCELLED' })).status).toBe(200);
        expect(await statusOf(plan.id)).toBe('CANCELLED');
        const other = await mkBooking(client.id, fixo.id, { ...slot(weekdayN(3), '10:00'), status: 'RESERVED' });
        expect((await call('DELETE', `/api/bookings/${other.id}/hard-delete`, recepcao)).status).toBe(200);
        expect(await prisma.booking.findUnique({ where: { id: other.id } })).toBeNull();
    });

    it('o cliente cancela a própria reserva como antes (sem a regra da baixa) — e o PENDING do avulso dele é anulado', async () => {
        const client = await newClient();
        const own = await call('POST', '/api/bookings', client, { date: weekdayN(0), startTime: '13:00', paymentMethod: 'PIX' });
        expect(own.status, JSON.stringify(own.body)).toBe(201);
        expect(await payStatus(own.body.paymentId)).toBe('PENDING');
        const r = await call('DELETE', `/api/bookings/${own.body.booking.id}`, client);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.message).toBe('Reserva cancelada com sucesso. 1 cobrança em aberto desta gravação foi cancelada.');
        expect(await statusOf(own.body.booking.id)).toBe('CANCELLED');
        expect(await payStatus(own.body.paymentId)).toBe('CANCELLED');
    });
});

describe('R5 (1) — corrida: uma cobrança criada no meio do cancelamento não é anulada por quem não tem a baixa', () => {
    it('DELETE: a conferência perdeu a corrida (não viu a cobrança) → a transição atômica não passa; a reserva e a cobrança ficam', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        const s = await servicoSession(recepcao, client.id, servico.id, weekdayN(0));
        race.skip = new Set([1, 2]); // a conferência de antes e a de depois "não veem" a cobrança: só a transição a barra
        await call('DELETE', `/api/bookings/${s.bookingId}`, recepcao);
        expect(await statusOf(s.bookingId)).toBe('RESERVED');
        expect(await payStatus(s.paymentId)).toBe('PENDING');
        race.skip = new Set([3]); // só a 1ª não vê: a transição barra e a reconferência responde o 403
        expect(await call('DELETE', `/api/bookings/${s.bookingId}`, recepcao)).toEqual({ status: 403, body: OPEN_CHARGE_403 });
        expect(await statusOf(s.bookingId)).toBe('RESERVED');
    });

    it('DELETE e PATCH: a cobrança surge DEPOIS da transição → desfeita (volta ao status anterior), 403, nada anulado', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL' });
        for (const [i, how] of (['DELETE', 'PATCH'] as const).entries()) {
            const b = await mkBooking(client.id, fixo.id, { ...slot(weekdayN(i), '10:00'), status: 'CONFIRMED' });
            let extraId = '';
            race.calls = 0;
            race.before = async (n) => {
                if (n !== 2) return; // a 2ª conferência é a de DEPOIS da transição
                extraId = (await prisma.payment.create({ data: { userId: client.id, contractId: fixo.id, bookingId: b.id, provider: 'STRIPE', amount: 10000, status: 'PENDING', paymentUrl: JSON.stringify({ addonKeys: ['CORTES_IA'] }) } })).id;
            };
            const r = how === 'DELETE'
                ? await call('DELETE', `/api/bookings/${b.id}`, recepcao)
                : await call('PATCH', `/api/bookings/${b.id}`, recepcao, { status: 'CANCELLED' });
            expect(r, how).toEqual({ status: 403, body: OPEN_CHARGE_403 });
            expect(await statusOf(b.id), how).toBe('CONFIRMED');
            expect(await payStatus(extraId), how).toBe('PENDING');
            race.before = null;
        }
    });

    it('PATCH: a conferência perdeu a corrida → a transição atômica não passa (a sessão não é cancelada nem a cobrança anulada)', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        const s = await servicoSession(recepcao, client.id, servico.id, weekdayN(0));
        race.skip = new Set([1, 2]);
        await call('PATCH', `/api/bookings/${s.bookingId}`, recepcao, { status: 'CANCELLED' });
        expect(await booking(s.bookingId)).toMatchObject({ status: 'RESERVED' });
        expect(await payStatus(s.paymentId)).toBe('PENDING');
    });

    it('POST /:id/addons: a reserva foi cancelada logo depois de a cobrança do extra ser gravada → 409 e essa cobrança é retirada (não fica presa)', async () => {
        const client = await newClient();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL' });
        const b = await mkBooking(client.id, fixo.id, { ...slot(weekdayN(0), '10:00'), status: 'CONFIRMED' });
        let r = { status: 0, body: {} as any };
        // O cancelamento "no meio": a gravação da cobrança do extra cancela a reserva na mesma escrita.
        await withTrigger('r5_test_cancel_on_addon', 'payments', 'INSERT',
            `IF NEW.payment_url LIKE '%addonKeys%' THEN UPDATE bookings SET status = 'CANCELLED' WHERE id = NEW.booking_id; END IF;`,
            async () => { r = await call('POST', `/api/bookings/${b.id}/addons`, client, { addonKeys: ['CORTES_IA'] }); });
        expect(await statusOf(b.id)).toBe('CANCELLED');
        expect(r.status, JSON.stringify(r.body)).toBe(409);
        expect(r.body.code).toBe('BOOKING_NOT_EDITABLE');
        const created = await prisma.payment.findFirstOrThrow({ where: { bookingId: b.id } });
        expect(created.status).toBe('CANCELLED');
        expect((await booking(b.id)).addOns).toEqual([]);
    });
});

// ─── (2) avulso cancelado ────────────────────────────────────────────────────────────────────────

describe('R5 (2) — o cancelamento de um avulso anula a cobrança em aberto dele (não fica presa nem listada como devida)', () => {
    it('avulso da Recepção: o ADMIN cancela (DELETE e Falta → Cancelado) → PENDING vira CANCELLED; o PAGO não é tocado', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();
        const a = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(0), startTime: '10:00' });
        expect(a.status, JSON.stringify(a.body)).toBe(201);
        const del = await call('DELETE', `/api/bookings/${a.body.booking.id}`, admin);
        expect(del.status, JSON.stringify(del.body)).toBe(200);
        expect(del.body).toMatchObject({ voidedExtras: 1, message: 'Reserva cancelada com sucesso. 1 cobrança em aberto desta gravação foi cancelada.' });
        expect(await payStatus(a.body.paymentId)).toBe('CANCELLED');

        const f = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(1), startTime: '10:00' });
        expect((await call('PATCH', `/api/bookings/${f.body.booking.id}`, recepcao, { status: 'FALTA', statusReason: 'Não veio.' })).status).toBe(200);
        expect(await call('PATCH', `/api/bookings/${f.body.booking.id}`, recepcao, { status: 'CANCELLED' })).toEqual({ status: 403, body: OPEN_CHARGE_403 });
        const ok = await call('PATCH', `/api/bookings/${f.body.booking.id}`, admin, { status: 'CANCELLED' });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(ok.body.message).toBe('Agendamento atualizado com sucesso. 1 cobrança em aberto desta gravação foi cancelada.');
        expect(await payStatus(f.body.paymentId)).toBe('CANCELLED');

        const p = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(2), startTime: '10:00' });
        await prisma.payment.update({ where: { id: p.body.paymentId }, data: { status: 'PAID', paidAt: new Date() } });
        const delPaid = await call('DELETE', `/api/bookings/${p.body.booking.id}`, recepcao);
        expect(delPaid.status, JSON.stringify(delPaid.body)).toBe(200);
        expect(delPaid.body.voidedExtras).toBe(0);
        expect(await payStatus(p.body.paymentId)).toBe('PAID');
    });

    it('a remarcação do avulso PAGO (Não realizado → janela aberta) e a expiração do hold do cliente seguem como antes', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const paid = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(0), startTime: '10:00' });
        await pay(paid.body.paymentId);
        expect(await statusOf(paid.body.booking.id)).toBe('CONFIRMED');
        const nr = await call('PATCH', `/api/bookings/${paid.body.booking.id}`, recepcao, { status: 'NAO_REALIZADO', statusReason: 'Equipamento.' });
        expect(nr.status, JSON.stringify(nr.body)).toBe(200);
        expect((await booking(paid.body.booking.id)).makeupStatus).toBe('OPEN');

        // Hold vencido do avulso do cliente: a varredura cancela a reserva e apaga a cobrança abandonada (como antes).
        const own = await call('POST', '/api/bookings', client, { date: weekdayN(1), startTime: '13:00', paymentMethod: 'PIX' });
        expect(own.status, JSON.stringify(own.body)).toBe(201);
        await prisma.booking.update({ where: { id: own.body.booking.id }, data: { holdExpiresAt: new Date(Date.now() - 60_000) } });
        await prisma.contract.update({ where: { id: own.body.booking.contractId }, data: { paymentDeadline: new Date(Date.now() - 60_000) } });
        await cleanExpiredHolds();
        expect(await prisma.booking.findUnique({ where: { id: own.body.booking.id } })).toBeNull();
        expect(await prisma.payment.findUnique({ where: { id: own.body.paymentId } })).toBeNull();
    });
});

// ─── (5) Texto do 403 de reabrir ─────────────────────────────────────────────────────────────────

describe('R5 (5) — o 403 de reabrir uma sessão cancelada só fala em cobrança anulada quando houve', () => {
    it('plano sem cobrança → texto neutro; cobrança anulada → "foi anulada"; avulso pago → cobrança própria', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await newClient();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL' });

        const plan = await mkBooking(client.id, fixo.id, { ...slot(weekdayN(0), '10:00'), status: 'CONFIRMED' });
        expect((await call('DELETE', `/api/bookings/${plan.id}`, recepcao)).status).toBe(200);
        const r1 = await call('PATCH', `/api/bookings/${plan.id}`, recepcao, { status: 'CONFIRMED' });
        expect(r1.status, JSON.stringify(r1.body)).toBe(403);
        expect(r1.body).toEqual({ error: REOPEN_NO_CHARGE, code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa' });
        expect(r1.body.error).not.toMatch(/anulada/);

        const withExtra = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: fixo.id, date: weekdayN(1), startTime: '10:00', addOns: ['CORTES_IA'] });
        expect((await call('DELETE', `/api/bookings/${withExtra.body.booking.id}`, admin)).status).toBe(200);
        expect(await payStatus(withExtra.body.paymentId)).toBe('CANCELLED');
        expect((await call('PATCH', `/api/bookings/${withExtra.body.booking.id}`, recepcao, { status: 'CONFIRMED' })).body.error).toBe(REOPEN_CHARGE_VOIDED);

        const avulsoOpen = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(2), startTime: '10:00' });
        expect((await call('DELETE', `/api/bookings/${avulsoOpen.body.booking.id}`, admin)).status).toBe(200);
        expect((await call('PATCH', `/api/bookings/${avulsoOpen.body.booking.id}`, recepcao, { status: 'CONFIRMED' })).body.error).toBe(REOPEN_CHARGE_VOIDED);

        const avulsoPaid = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(3), startTime: '10:00' });
        await prisma.payment.update({ where: { id: avulsoPaid.body.paymentId }, data: { status: 'PAID', paidAt: new Date() } });
        expect((await call('DELETE', `/api/bookings/${avulsoPaid.body.booking.id}`, recepcao)).status).toBe(200);
        expect((await call('PATCH', `/api/bookings/${avulsoPaid.body.booking.id}`, recepcao, { status: 'CONFIRMED' })).body.error).toBe(REOPEN_OWN_CHARGE);
    });
});

// ─── (3) Pagamento DA SESSÃO ─────────────────────────────────────────────────────────────────────

describe('R5 (3) — um extra pago nunca confirma nem libera a remarcação de uma sessão cuja cobrança está em aberto', () => {
    it('ATU4-04/UXT-07: avulso da Recepção + extra pago → Não realizado não abre a janela; Falta justificada 400; makeup do cliente 400; pagando a sessão, tudo libera', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const mk = async (n: number) => {
            const a = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(n), startTime: '10:00' });
            expect(a.status, JSON.stringify(a.body)).toBe(201);
            const extra = await buyExtra(client, a.body.booking.id);
            await pay(extra.id);
            expect(await statusOf(a.body.booking.id)).toBe('RESERVED');
            return { id: a.body.booking.id as string, paymentId: a.body.paymentId as string };
        };

        const a = await mk(0);
        const nr = await call('PATCH', `/api/bookings/${a.id}`, recepcao, { status: 'NAO_REALIZADO', statusReason: 'Equipamento.' });
        expect(nr.status, JSON.stringify(nr.body)).toBe(200);
        expect((await booking(a.id)).makeupStatus).toBeNull();
        expect(await prisma.notification.count({ where: { entityId: a.id, title: 'Você pode remarcar sua gravação' } })).toBe(0);

        const b = await mk(1);
        const falta = await call('PATCH', `/api/bookings/${b.id}`, recepcao, { status: 'FALTA', statusReason: 'Imprevisto.', noShowJustified: true });
        expect(falta.status, JSON.stringify(falta.body)).toBe(400);
        expect(falta.body.error).toBe(MAKEUP_NOT_PAID);
        expect(await statusOf(b.id)).toBe('RESERVED');

        await prisma.booking.update({ where: { id: a.id }, data: { makeupStatus: 'OPEN', makeupDeadline: new Date(Date.now() + 7 * 86_400_000), missedDate: (await booking(a.id)).date } });
        const mkp = await call('PATCH', `/api/bookings/${a.id}/makeup`, client, { date: weekdayN(4), startTime: '10:00' });
        expect(mkp.status, JSON.stringify(mkp.body)).toBe(400);
        expect(mkp.body.error).toBe(MAKEUP_NOT_PAID);
        expect(await statusOf(a.id)).toBe('NAO_REALIZADO');
        expect(await payStatus(a.paymentId)).toBe('PENDING');

        // Controle: a cobrança da sessão paga → a remarcação vale.
        await pay(a.paymentId);
        const ok = await call('PATCH', `/api/bookings/${a.id}/makeup`, client, { date: weekdayN(0), startTime: '13:00' });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(await statusOf(a.id)).toBe('CONFIRMED');
    });

    it('/confirm: avulso legado SEM a marca (cobrança da gravação PENDING) com só o extra PAGO → 402; pagando a gravação → 200', async () => {
        const client = await newClient();
        const avulso = await mkContract(client.id, { type: 'AVULSO', tier: 'COMERCIAL', durationMonths: 1, discountPct: 0, flexCreditsTotal: 1, flexCreditsRemaining: 0 });
        const b = await mkBooking(client.id, avulso.id, { ...slot(weekdayN(0), '10:00'), status: 'RESERVED' });
        const session = await prisma.payment.create({ data: { userId: client.id, contractId: avulso.id, bookingId: b.id, provider: 'SICOOB', amount: 30000, status: 'PENDING' } });
        await prisma.payment.create({ data: { userId: client.id, contractId: avulso.id, bookingId: b.id, provider: 'STRIPE', amount: 10000, status: 'PAID', paidAt: new Date(), paymentUrl: JSON.stringify({ addonKeys: ['CORTES_IA'] }) } });

        const denied = await call('PATCH', `/api/bookings/${b.id}/confirm`, client);
        expect(denied.status, JSON.stringify(denied.body)).toBe(402);
        expect(denied.body.error).toBe('Pagamento obrigatório para confirmar agendamento avulso.');
        expect(await statusOf(b.id)).toBe('RESERVED');

        await prisma.payment.update({ where: { id: session.id }, data: { status: 'PAID', paidAt: new Date() } });
        expect((await call('PATCH', `/api/bookings/${b.id}/confirm`, client)).status).toBe(200);
        expect(await statusOf(b.id)).toBe('CONFIRMED');
    });

    it('varredura dos holds (pendência do conserto 3, corrida paidAfter): o PAID que aparece depois do cancelamento é de um EXTRA → volta Reservada; é o da gravação → Confirmada', async () => {
        const client = await newClient();
        for (const which of ['extra', 'session'] as const) {
            const avulso = await mkContract(client.id, { type: 'AVULSO', tier: 'COMERCIAL', durationMonths: 1, discountPct: 0, flexCreditsTotal: 1, flexCreditsRemaining: 0 });
            const b = await mkBooking(client.id, avulso.id, { ...slot(weekdayN(which === 'extra' ? 0 : 1), '13:00'), status: 'RESERVED', holdExpiresAt: new Date(Date.now() - 60_000) });
            const session = await prisma.payment.create({ data: { userId: client.id, contractId: avulso.id, bookingId: b.id, provider: 'SICOOB', amount: 30000, status: 'PENDING' } });
            const extra = await prisma.payment.create({ data: { userId: client.id, contractId: avulso.id, bookingId: b.id, provider: 'STRIPE', amount: 10000, status: 'PENDING', paymentUrl: JSON.stringify({ addonKeys: ['CORTES_IA'] }) } });
            const target = which === 'extra' ? extra.id : session.id;

            // O pagamento chega junto com o cancelamento atômico da varredura (a mesma escrita o dispara).
            await withTrigger('r5_test_pay_after_cancel', 'bookings', 'UPDATE',
                `IF NEW.status = 'CANCELLED' AND OLD.status <> 'CANCELLED' THEN UPDATE payments SET status = 'PAID', paid_at = now() WHERE id = '${target}'; END IF;`,
                () => cleanExpiredHolds());
            expect(await payStatus(target)).toBe('PAID');

            expect(await booking(b.id), which).toMatchObject({ status: which === 'extra' ? 'RESERVED' : 'CONFIRMED', holdExpiresAt: null });
        }
    });

    it('ATU4-02: aviso das 7h — SERVIÇO em dia com a cobrança da sessão em aberto (e um extra pago) → "Pague para confirmar"; paga → "Gravação confirmada"; plano só com extra em aberto → "confirmada"', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        await prisma.payment.create({ data: { userId: client.id, contractId: servico.id, provider: 'SICOOB', amount: 50000, status: 'PAID', paidAt: new Date(), dueDate: dbDate(pastWeekdayN(3)) } });
        const day = weekdayN(0);
        const open = await servicoSession(recepcao, client.id, servico.id, day, '10:00');
        const extra = await buyExtra(client, open.bookingId);
        await pay(extra.id);
        const paid = await servicoSession(recepcao, client.id, servico.id, day, '13:00');
        await pay(paid.paymentId);
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL' });
        const planC = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: fixo.id, date: day, startTime: '15:30', addOns: ['CORTES_IA'] });
        expect(planC.status, JSON.stringify(planC.body)).toBe(201);

        await runDailyConfirmationJob({ force: true, forceDate: day });
        await Promise.allSettled([...background.pending]);
        const typeOf = async (id: string) => (await prisma.notification.findFirstOrThrow({ where: { entityId: id, userId: client.id } })).type;
        expect(await typeOf(open.bookingId)).toBe('BOOKING_UNCONFIRMED');
        expect(await typeOf(paid.bookingId)).toBe('BOOKING_CONFIRMED');
        expect(await typeOf(planC.body.booking.id)).toBe('BOOKING_CONFIRMED');
    });
});

// ─── (4) Teto do FIXO ────────────────────────────────────────────────────────────────────────────

describe('R5 (4) — a sessão EXTRA do FIXO (cobrança própria) não ocupa o teto do plano', () => {
    it('com uma extra no contrato, a sessão do plano sai de Não realizado (200) e uma nova sessão sai coberta pelo plano; o cliente também agenda', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL', durationMonths: 1 }); // teto 4
        const covered = [];
        for (let i = 0; i < 4; i++) covered.push(await mkBooking(client.id, fixo.id, { ...slot(weekdayN(5 + i), '15:30'), status: 'CONFIRMED' }));
        const extra = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: fixo.id, date: weekdayN(0), startTime: '10:00' });
        expect(extra.status, JSON.stringify(extra.body)).toBe(201);
        expect(extra.body.coveredByPlan).toBeUndefined();
        expect(await prisma.payment.findUniqueOrThrow({ where: { id: extra.body.paymentId } })).toMatchObject({ metadata: { sessionCharge: true, fixoExtra: true } });

        // Não realizado libera uma vaga do plano; a extra (RESERVED) não a ocupa → reabrir passa.
        expect((await call('PATCH', `/api/bookings/${covered[0]!.id}`, recepcao, { status: 'NAO_REALIZADO', statusReason: 'Equipamento.' })).status).toBe(200);
        const back = await call('PATCH', `/api/bookings/${covered[0]!.id}`, recepcao, { status: 'COMPLETED' });
        expect(back.status, JSON.stringify(back.body)).toBe(200);

        // Uma vaga do plano livre (outra sessão cancelada) com a extra no contrato: a criação sai COBERTA pelo plano.
        await prisma.booking.update({ where: { id: covered[1]!.id }, data: { status: 'CANCELLED' } });
        const created = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: fixo.id, date: weekdayN(1), startTime: '10:00' });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        expect(created.body.coveredByPlan).toBe(true);
        expect(created.body.paymentId).toBeNull();

        // E o cliente, pelo POST /, também (a mesma conta: fixoCapReached).
        await prisma.booking.update({ where: { id: covered[2]!.id }, data: { status: 'CANCELLED' } });
        const own = await call('POST', '/api/bookings', client, { date: weekdayN(2), startTime: '10:00', contractId: fixo.id });
        expect(own.status, JSON.stringify(own.body)).toBe(201);

        // Teto cheio de novo (4 do plano). Uma extra cuja cobrança foi ANULADA (quem tem a baixa) continua extra — a marca
        // vale em qualquer status: sai de Não realizado sem a conferência do teto (200), como a extra paga ou em aberto.
        // (Conserto 5 — ATU5-02: a marca do EXTRA é a fixoExtra; a sessionCharge sozinha ocupa a vaga.)
        expect(await prisma.booking.count({ where: { contractId: fixo.id, status: { in: ['COMPLETED', 'CONFIRMED', 'FALTA', 'RESERVED'] }, payments: { none: { metadata: { path: ['fixoExtra'], equals: true } } } } })).toBe(4);
        const voidedExtra = await mkBooking(client.id, fixo.id, { ...slot(weekdayN(3), '13:00'), status: 'NAO_REALIZADO' });
        await prisma.payment.create({ data: { userId: client.id, contractId: fixo.id, bookingId: voidedExtra.id, provider: 'SICOOB', amount: 30000, status: 'CANCELLED', metadata: { sessionCharge: true, fixoExtra: true } } });
        const reopened = await call('PATCH', `/api/bookings/${voidedExtra.id}`, recepcao, { status: 'COMPLETED' });
        expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    });

    it('contractCompletion: 3 sessões do plano + 1 extra concluídas não concluem o FIXO de 4; a 4ª do plano conclui', async () => {
        const client = await newClient();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL', durationMonths: 1 });
        for (let i = 0; i < 3; i++) await mkBooking(client.id, fixo.id, { ...slot(pastWeekdayN(i), '10:00'), status: 'COMPLETED' });
        const extra = await mkBooking(client.id, fixo.id, { ...slot(pastWeekdayN(3), '10:00'), status: 'COMPLETED' });
        await prisma.payment.create({ data: { userId: client.id, contractId: fixo.id, bookingId: extra.id, provider: 'SICOOB', amount: 30000, status: 'PAID', paidAt: new Date(), metadata: { sessionCharge: true, fixoExtra: true } } });
        await syncContractCompletion(fixo.id);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: fixo.id } })).status).toBe('ACTIVE');

        await mkBooking(client.id, fixo.id, { ...slot(pastWeekdayN(4), '10:00'), status: 'COMPLETED' });
        await syncContractCompletion(fixo.id);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: fixo.id } })).status).toBe('COMPLETED');
    });
});

// ─── (6) openChargeCount nos payloads da equipe ──────────────────────────────────────────────────

describe('R5 (6) — openChargeCount nos agendamentos da equipe (lote), nunca no do cliente', () => {
    it('GET /api/bookings (lista e Hoje), PATCH e check-in trazem a contagem de PENDING/FAILED; GET /my não', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL' });
        const day = weekdayN(0);
        const a = await mkBooking(client.id, fixo.id, { ...slot(day, '10:00'), status: 'RESERVED' });
        const b = await mkBooking(client.id, fixo.id, { ...slot(day, '13:00'), status: 'CONFIRMED' });
        const mkp = (bookingId: string, status: 'PENDING' | 'FAILED' | 'PAID' | 'CANCELLED') =>
            prisma.payment.create({ data: { userId: client.id, contractId: fixo.id, bookingId, provider: 'SICOOB', amount: 1000, status } });
        await mkp(a.id, 'PENDING'); await mkp(a.id, 'FAILED'); await mkp(a.id, 'PAID'); await mkp(a.id, 'CANCELLED');
        await mkp(b.id, 'PAID');

        const list = await call('GET', `/api/bookings?date=${day}`, recepcao);
        expect(list.status, JSON.stringify(list.body)).toBe(200);
        expect(race.batches).toEqual([2]); // UM lote com as 2 reservas (openChargeCounts: 1 groupBy), sem N+1
        const byId = new Map(list.body.bookings.map((x: any) => [x.id, x.openChargeCount]));
        expect(byId.get(a.id)).toBe(2);
        expect(byId.get(b.id)).toBe(0);

        const ci = await call('PUT', `/api/bookings/${a.id}/check-in`, recepcao);
        expect(ci.status, JSON.stringify(ci.body)).toBe(200);
        expect(ci.body.booking.openChargeCount).toBe(2);
        const pt = await call('PATCH', `/api/bookings/${b.id}`, recepcao, { adminNotes: 'nota' });
        expect(pt.status, JSON.stringify(pt.body)).toBe(200);
        expect(pt.body.booking.openChargeCount).toBe(0);

        const my = await call('GET', '/api/bookings/my', client);
        expect(my.status).toBe(200);
        expect(my.body.bookings.length).toBe(2);
        for (const x of my.body.bookings) expect(x).not.toHaveProperty('openChargeCount');
    });
});
