import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
import { runFlexCreditExpiryJob } from '../../src/jobs/flexCreditExpiryJob';
import bookingRoutes from '../../src/modules/bookings/routes';
import { mkUser, mkStaff, mkContract, mkBooking } from './factories';

// FRENTE R4-CONSERTO3 (revisão 3) — agendamentos:
//  FIN-06/ATU-01: cancelar uma sessão que JÁ ACONTECEU (Concluída, Falta ou com a gravação iniciada) com cobrança
//    em aberto anula essa cobrança → sem cobrancas.baixa, 403 antes de qualquer escrita (PATCH e DELETE da equipe).
//    Sem cobrança em aberto, ou numa sessão futura, cancelar segue só com agendamentos.cancelar.
//  FIN-07: (1) o 403 da reabertura de uma sessão cancelada com cobrança PRÓPRIA viva (avulso; cobrança da sessão
//    paga) não manda criar outro agendamento; (2) a sessão FIXO extra (cobrança própria) sai de Não realizado sem
//    conferir o teto do plano.
//  UXT-04: o 409 NO_CREDITS diz "já foi usado ou venceu" — o confisco semanal do FLEX também zera o crédito devolvido.

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
    const keys = [...await redis.keys('booking:lock:*'), ...await redis.keys('booking:fixo-cap:*')];
    if (keys.length) await redis.del(...keys);
});

type Who = { id: string; email: string | null; role: string };

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

// R5: a heurística "a sessão já aconteceu" virou o critério estrutural "cobrança em aberto" (eq-r5-cobranca.test.ts);
// o 403 é o mesmo para qualquer status/data/gravação.
const CANCEL_DONE_NEEDS_BAIXA = {
    error: 'Esta sessão tem cobrança em aberto: cancelar anula a cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa ou, se o cliente faltou, use Falta (a cobrança continua devida).',
    code: 'PERMISSION_DENIED',
    permission: 'cobrancas.baixa',
};
const REOPEN_CANCELLED = 'Reabrir uma sessão cancelada exige a permissão “Marcar como pago, anular ou estornar”: a cobrança dela foi anulada no cancelamento. Para uma nova sessão, crie um novo agendamento.';
const REOPEN_CANCELLED_OWN_CHARGE = 'Reabrir uma sessão cancelada exige a permissão “Marcar como pago, anular ou estornar”. Esta sessão já tem cobrança própria: peça a quem tem essa permissão para reabri-la. Não crie um novo agendamento — o cliente seria cobrado de novo.';
const REOPEN_NO_CREDITS = 'O plano não tem crédito disponível para reabrir esta sessão: o crédito devolvido no “Não realizado” já foi usado ou venceu. Crie um novo agendamento ou peça a quem pode dar baixa.';
const REOPEN_FIXO_LIMIT = 'O plano fixo já usou todas as sessões: reabrir esta sessão passaria do limite. Crie um novo agendamento (cobrado) ou peça a quem pode dar baixa.';

const statusOf = async (bookingId: string) => (await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status;
const payStatus = async (paymentId: string) => (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status;
const credits = async (contractId: string) => (await prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).flexCreditsRemaining;

/** Sessão de SERVIÇO criada pela Recepção (cobrança da sessão PENDING com a marca). */
async function servicoSession(recepcao: Who, clientId: string, contractId: string, date: string, startTime = '10:00') {
    const c = await call('POST', '/api/bookings/admin', recepcao, { userId: clientId, contractId, date, startTime });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: c.body.paymentId } })).toMatchObject({ status: 'PENDING', metadata: { sessionCharge: true } });
    return { bookingId: c.body.booking.id as string, paymentId: c.body.paymentId as string };
}

// ─── FIN-06 / ATU-01 ────────────────────────────────────

describe('FIN-06/ATU-01 — cancelar uma sessão que já aconteceu com cobrança em aberto exige cobrancas.baixa', () => {
    it('SERVIÇO: Recepção leva a Concluído e tenta cancelar pelo PATCH → 403; a sessão segue Concluída e a cobrança PENDING', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL', discountPct: 10 });
        const s = await servicoSession(recepcao, client.id, servico.id, weekdayN(0));

        expect((await call('PATCH', `/api/bookings/${s.bookingId}`, recepcao, { status: 'CONFIRMED' })).status).toBe(200);
        expect((await call('PATCH', `/api/bookings/${s.bookingId}`, recepcao, { status: 'COMPLETED' })).status).toBe(200);

        const r = await call('PATCH', `/api/bookings/${s.bookingId}`, recepcao, { status: 'CANCELLED' });
        expect(r.status, JSON.stringify(r.body)).toBe(403);
        expect(r.body).toEqual(CANCEL_DONE_NEEDS_BAIXA);
        expect(await statusOf(s.bookingId)).toBe('COMPLETED');
        expect(await payStatus(s.paymentId)).toBe('PENDING');

        // FALTA também (no-show de sessão cobrada: a cobrança continua devida).
        const f = await servicoSession(recepcao, client.id, servico.id, weekdayN(1));
        expect((await call('PATCH', `/api/bookings/${f.bookingId}`, recepcao, { status: 'FALTA', statusReason: 'Não veio.' })).status).toBe(200);
        const rf = await call('PATCH', `/api/bookings/${f.bookingId}`, recepcao, { status: 'CANCELLED' });
        expect(rf.status, JSON.stringify(rf.body)).toBe(403);
        expect(rf.body).toEqual(CANCEL_DONE_NEEDS_BAIXA);
        expect(await statusOf(f.bookingId)).toBe('FALTA');
        expect(await payStatus(f.paymentId)).toBe('PENDING');
    });

    it('avulso da Recepção em Falta → Cancelado: 403 e a cobrança PENDING segue cobrável (a reserva não vira CANCELLED)', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const c = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(0), startTime: '13:00' });
        expect(c.status, JSON.stringify(c.body)).toBe(201);
        expect((await call('PATCH', `/api/bookings/${c.body.booking.id}`, recepcao, { status: 'FALTA', statusReason: 'Não veio.' })).status).toBe(200);
        const r = await call('PATCH', `/api/bookings/${c.body.booking.id}`, recepcao, { status: 'CANCELLED' });
        expect(r.status, JSON.stringify(r.body)).toBe(403);
        expect(r.body).toEqual(CANCEL_DONE_NEEDS_BAIXA);
        expect(await statusOf(c.body.booking.id)).toBe('FALTA');
        expect(await payStatus(c.body.paymentId)).toBe('PENDING');
    });

    it('gravação iniciada: DELETE e PATCH da Recepção numa Confirmada com o "Iniciar Gravação" → 403; Não realizado com a gravação iniciada também', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        const s = await servicoSession(recepcao, client.id, servico.id, weekdayN(0));
        await prisma.booking.update({ where: { id: s.bookingId }, data: { status: 'CONFIRMED', recordingStartedAt: new Date() } });

        const del = await call('DELETE', `/api/bookings/${s.bookingId}`, recepcao);
        expect(del.status, JSON.stringify(del.body)).toBe(403);
        expect(del.body).toEqual(CANCEL_DONE_NEEDS_BAIXA);
        const patch = await call('PATCH', `/api/bookings/${s.bookingId}`, recepcao, { status: 'CANCELLED' });
        expect(patch.status, JSON.stringify(patch.body)).toBe(403);
        expect(patch.body).toEqual(CANCEL_DONE_NEEDS_BAIXA);
        expect(await statusOf(s.bookingId)).toBe('CONFIRMED');
        expect(await payStatus(s.paymentId)).toBe('PENDING');

        await prisma.booking.update({ where: { id: s.bookingId }, data: { status: 'NAO_REALIZADO' } });
        const nr = await call('PATCH', `/api/bookings/${s.bookingId}`, recepcao, { status: 'CANCELLED' });
        expect(nr.status, JSON.stringify(nr.body)).toBe(403);
        expect(await statusOf(s.bookingId)).toBe('NAO_REALIZADO');
        expect(await payStatus(s.paymentId)).toBe('PENDING');
    });

    it('FLEX concluído com extras em aberto → 403 para a Recepção; com a baixa e o ADMIN → 200 e a cobrança é anulada como antes', async () => {
        await prisma.addOnConfig.create({ data: { key: 'CORTES_IA', name: 'Cortes', price: 10000 } });
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const baixa = await mkStaff({ permissions: COM_BAIXA });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const flex = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 10, flexCreditsRemaining: 10, flexForfeitFloor: 0, flexCreditsForfeited: 0 });

        const ids: { bookingId: string; paymentId: string }[] = [];
        for (let i = 0; i < 3; i++) {
            const c = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: flex.id, date: weekdayN(i), startTime: '10:00', addOns: ['CORTES_IA'] });
            expect(c.status, JSON.stringify(c.body)).toBe(201);
            expect(c.body.coveredByPlan).toBe(true);
            expect((await call('PATCH', `/api/bookings/${c.body.booking.id}`, recepcao, { status: 'COMPLETED' })).status).toBe(200);
            ids.push({ bookingId: c.body.booking.id, paymentId: c.body.paymentId });
        }

        const denied = await call('PATCH', `/api/bookings/${ids[0]!.bookingId}`, recepcao, { status: 'CANCELLED' });
        expect(denied.status, JSON.stringify(denied.body)).toBe(403);
        expect(denied.body).toEqual(CANCEL_DONE_NEEDS_BAIXA);
        expect(await statusOf(ids[0]!.bookingId)).toBe('COMPLETED');
        expect(await payStatus(ids[0]!.paymentId)).toBe('PENDING');

        for (const [who, s] of [[baixa, ids[1]!], [admin, ids[2]!]] as const) {
            const ok = await call('PATCH', `/api/bookings/${s.bookingId}`, who, { status: 'CANCELLED' });
            expect(ok.status, JSON.stringify(ok.body)).toBe(200);
            expect(ok.body.voidedExtras).toBe(1);
            expect(ok.body.message).toBe('Agendamento atualizado com sucesso. 1 cobrança em aberto desta gravação foi cancelada.');
            expect(await statusOf(s.bookingId)).toBe('CANCELLED');
            expect(await payStatus(s.paymentId)).toBe('CANCELLED');
        }
    });

    it('com a baixa o DELETE de uma Confirmada com a gravação iniciada segue (200, anula); o ADMIN também', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const baixa = await mkStaff({ permissions: COM_BAIXA });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        for (const [i, who] of [baixa, admin].entries()) {
            const s = await servicoSession(recepcao, client.id, servico.id, weekdayN(i));
            await prisma.booking.update({ where: { id: s.bookingId }, data: { status: 'CONFIRMED', recordingStartedAt: new Date() } });
            const del = await call('DELETE', `/api/bookings/${s.bookingId}`, who);
            expect(del.status, JSON.stringify(del.body)).toBe(200);
            expect(await statusOf(s.bookingId)).toBe('CANCELLED');
            expect(await payStatus(s.paymentId)).toBe('CANCELLED');
        }
    });

    it('R5: sessão futura (DELETE/PATCH) e Não realizado sem gravação, com cobrança em aberto, também dão 403; sessão SEM cobrança em aberto segue 200', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });

        // SERVIÇO futuro Reservado: cancelar anularia a cobrança em aberto → 403 (R5: qualquer status/data/gravação).
        const fut = await servicoSession(recepcao, client.id, servico.id, weekdayN(0));
        const del = await call('DELETE', `/api/bookings/${fut.bookingId}`, recepcao);
        expect(del.status, JSON.stringify(del.body)).toBe(403);
        expect(del.body).toEqual(CANCEL_DONE_NEEDS_BAIXA);
        expect(await payStatus(fut.paymentId)).toBe('PENDING');
        // Confirmada (check-in) sem gravação iniciada: idem.
        const conf = await servicoSession(recepcao, client.id, servico.id, weekdayN(1));
        expect((await call('PATCH', `/api/bookings/${conf.bookingId}`, recepcao, { status: 'CONFIRMED' })).status).toBe(200);
        expect((await call('DELETE', `/api/bookings/${conf.bookingId}`, recepcao)).status).toBe(403);
        expect(await payStatus(conf.paymentId)).toBe('PENDING');

        // SERVIÇO concluído com a cobrança PAGA (nada em aberto): cancela (o pago não é anulado).
        const paid = await servicoSession(recepcao, client.id, servico.id, weekdayN(2));
        await prisma.payment.update({ where: { id: paid.paymentId }, data: { status: 'PAID', paidAt: new Date() } });
        expect((await call('PATCH', `/api/bookings/${paid.bookingId}`, recepcao, { status: 'COMPLETED' })).status).toBe(200);
        const rp = await call('PATCH', `/api/bookings/${paid.bookingId}`, recepcao, { status: 'CANCELLED' });
        expect(rp.status, JSON.stringify(rp.body)).toBe(200);
        expect(await payStatus(paid.paymentId)).toBe('PAID');

        // Sessão de plano concluída sem cobrança nenhuma: cancela.
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL' });
        const plan = await mkBooking(client.id, fixo.id, { ...slot(pastWeekdayN(0), '10:00'), status: 'COMPLETED' });
        expect((await call('PATCH', `/api/bookings/${plan.id}`, recepcao, { status: 'CANCELLED' })).status).toBe(200);
        expect(await statusOf(plan.id)).toBe('CANCELLED');

        // Não realizado SEM a gravação iniciada: era o resíduo (d) do conserto 3 — agora também 403 (R5).
        const nr = await servicoSession(recepcao, client.id, servico.id, weekdayN(3));
        expect((await call('PATCH', `/api/bookings/${nr.bookingId}`, recepcao, { status: 'NAO_REALIZADO', statusReason: 'Equipamento.' })).status).toBe(200);
        const rnr = await call('PATCH', `/api/bookings/${nr.bookingId}`, recepcao, { status: 'CANCELLED' });
        expect(rnr.status, JSON.stringify(rnr.body)).toBe(403);
        expect(await payStatus(nr.paymentId)).toBe('PENDING');
    });

    it('quem não tem agendamentos.cancelar recebe o 403 do cancelar primeiro (a nova trava vem depois da regra)', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const op = await mkStaff({ permissions: ['agendamentos.ver', 'agendamentos.editar', 'agendamentos.faltas'] });
        const client = await mkUser();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        const s = await servicoSession(recepcao, client.id, servico.id, weekdayN(0));
        expect((await call('PATCH', `/api/bookings/${s.bookingId}`, recepcao, { status: 'COMPLETED' })).status).toBe(200);
        const r = await call('PATCH', `/api/bookings/${s.bookingId}`, op, { status: 'CANCELLED' });
        expect(r.status).toBe(403);
        expect(r.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'agendamentos.cancelar' });
    });
});

// ─── FIN-07 ─────────────────────────────────────────────

describe('FIN-07 — sessão com cobrança própria: a reabertura não orienta cobrar de novo, e a extra do FIXO não usa o teto', () => {
    it('avulso pago cancelado pela Recepção: 403 com o texto da cobrança própria; avulso em aberto (R5: só quem tem a baixa cancela, e a cobrança é anulada) → texto da cobrança anulada; o ADMIN reabre', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();

        const paid = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(0), startTime: '10:00' });
        expect(paid.status, JSON.stringify(paid.body)).toBe(201);
        await prisma.payment.update({ where: { id: paid.body.paymentId }, data: { status: 'PAID', paidAt: new Date() } });
        expect((await call('DELETE', `/api/bookings/${paid.body.booking.id}`, recepcao)).status).toBe(200);
        expect(await payStatus(paid.body.paymentId)).toBe('PAID');

        const open = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(1), startTime: '10:00' });
        expect(open.status, JSON.stringify(open.body)).toBe(201);
        expect((await call('DELETE', `/api/bookings/${open.body.booking.id}`, recepcao)).status).toBe(403);
        expect((await call('DELETE', `/api/bookings/${open.body.booking.id}`, admin)).status).toBe(200);
        expect(await payStatus(open.body.paymentId)).toBe('CANCELLED');

        const rp = await call('PATCH', `/api/bookings/${paid.body.booking.id}`, recepcao, { status: 'CONFIRMED' });
        expect(rp.status, JSON.stringify(rp.body)).toBe(403);
        expect(rp.body).toEqual({ error: REOPEN_CANCELLED_OWN_CHARGE, code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa' });
        expect(rp.body.error).not.toMatch(/anulada|Para uma nova sessão, crie/);
        const ro = await call('PATCH', `/api/bookings/${open.body.booking.id}`, recepcao, { status: 'CONFIRMED' });
        expect(ro.status, JSON.stringify(ro.body)).toBe(403);
        expect(ro.body).toEqual({ error: REOPEN_CANCELLED, code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa' });
        for (const id of [paid.body.booking.id, open.body.booking.id]) expect(await statusOf(id)).toBe('CANCELLED');
        const ok = await call('PATCH', `/api/bookings/${paid.body.booking.id}`, admin, { status: 'CONFIRMED' });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(ok.body.booking.status).toBe('CONFIRMED');
    });

    it('avulso do PRÓPRIO cliente (cobrança do hold, sem a marca): em aberto e cancelado (R5: a cobrança é anulada) → texto da cobrança anulada; pago → texto da cobrança própria', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const own = await call('POST', '/api/bookings', client, { date: weekdayN(2), startTime: '13:00', paymentMethod: 'PIX' });
        expect(own.status, JSON.stringify(own.body)).toBe(201);
        const pay = await prisma.payment.findUniqueOrThrow({ where: { id: own.body.paymentId } });
        expect(pay.metadata).toBeNull();
        expect((await call('DELETE', `/api/bookings/${own.body.booking.id}`, client)).status).toBe(200);
        expect(await statusOf(own.body.booking.id)).toBe('CANCELLED');
        expect(await payStatus(own.body.paymentId)).toBe('CANCELLED');
        const r = await call('PATCH', `/api/bookings/${own.body.booking.id}`, recepcao, { status: 'CONFIRMED' });
        expect(r.status, JSON.stringify(r.body)).toBe(403);
        expect(r.body.error).toBe(REOPEN_CANCELLED);

        // O avulso PAGO do cliente (sem a marca): a cobrança própria sobrevive ao cancelamento.
        await prisma.payment.update({ where: { id: own.body.paymentId }, data: { status: 'PAID', paidAt: new Date() } });
        const r2 = await call('PATCH', `/api/bookings/${own.body.booking.id}`, recepcao, { status: 'CONFIRMED' });
        expect(r2.body.error).toBe(REOPEN_CANCELLED_OWN_CHARGE);
    });

    it('SERVIÇO pago e cancelado → texto da cobrança própria; SERVIÇO não pago e cancelado (cobrança anulada) → o texto de antes', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });

        const paid = await servicoSession(recepcao, client.id, servico.id, weekdayN(0));
        await prisma.payment.update({ where: { id: paid.paymentId }, data: { status: 'PAID', paidAt: new Date() } });
        expect((await call('DELETE', `/api/bookings/${paid.bookingId}`, recepcao)).status).toBe(200);
        expect(await payStatus(paid.paymentId)).toBe('PAID');
        const r1 = await call('PATCH', `/api/bookings/${paid.bookingId}`, recepcao, { status: 'COMPLETED' });
        expect(r1.status, JSON.stringify(r1.body)).toBe(403);
        expect(r1.body.error).toBe(REOPEN_CANCELLED_OWN_CHARGE);

        const voided = await servicoSession(recepcao, client.id, servico.id, weekdayN(1));
        // R5: com a cobrança em aberto, só quem tem a baixa cancela (e anula).
        expect((await call('DELETE', `/api/bookings/${voided.bookingId}`, recepcao)).status).toBe(403);
        expect((await call('DELETE', `/api/bookings/${voided.bookingId}`, await mkUser({ role: 'ADMIN' }))).status).toBe(200);
        expect(await payStatus(voided.paymentId)).toBe('CANCELLED');
        const r2 = await call('PATCH', `/api/bookings/${voided.bookingId}`, recepcao, { status: 'COMPLETED' });
        expect(r2.status, JSON.stringify(r2.body)).toBe(403);
        expect(r2.body.error).toBe(REOPEN_CANCELLED);
    });

    it('FIXO no teto + sessão extra paga pela Recepção: Não realizado → Concluído dá 200; a sessão do plano coberta com o teto cheio continua 409', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL', durationMonths: 1 }); // teto 4
        const covered = [];
        for (let i = 0; i < 4; i++) covered.push(await mkBooking(client.id, fixo.id, { ...slot(weekdayN(5 + i), '15:30'), status: 'CONFIRMED' }));

        const extra = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: fixo.id, date: weekdayN(0), startTime: '10:00' });
        expect(extra.status, JSON.stringify(extra.body)).toBe(201);
        expect(await prisma.payment.findUniqueOrThrow({ where: { id: extra.body.paymentId } })).toMatchObject({ status: 'PENDING', metadata: { sessionCharge: true } });
        await prisma.payment.update({ where: { id: extra.body.paymentId }, data: { status: 'PAID', paidAt: new Date() } });

        const id = extra.body.booking.id as string;
        expect((await call('PATCH', `/api/bookings/${id}`, recepcao, { status: 'COMPLETED' })).status).toBe(200);
        expect((await call('PATCH', `/api/bookings/${id}`, recepcao, { status: 'NAO_REALIZADO', statusReason: 'Por engano.' })).status).toBe(200);
        const back = await call('PATCH', `/api/bookings/${id}`, recepcao, { status: 'COMPLETED' });
        expect(back.status, JSON.stringify(back.body)).toBe(200);
        expect(back.body.booking.status).toBe('COMPLETED');
        expect(await redis.keys('booking:fixo-cap:*')).toEqual([]);

        // Também com a cobrança da extra ainda em aberto (a marca vale em qualquer status vivo). Conserto 5 (ATU5-02): a
        // marca do EXTRA é a fixoExtra (a que o POST /admin grava com o teto cheio); a sessionCharge sozinha ocupa a vaga.
        const extra2 = await mkBooking(client.id, fixo.id, { ...slot(weekdayN(1), '10:00'), status: 'NAO_REALIZADO' });
        await prisma.payment.create({ data: { userId: client.id, contractId: fixo.id, bookingId: extra2.id, provider: 'SICOOB', amount: 30000, status: 'PENDING', metadata: { sessionCharge: true, fixoExtra: true } } });
        expect((await call('PATCH', `/api/bookings/${extra2.id}`, recepcao, { status: 'COMPLETED' })).status).toBe(200);

        // Controle: a sessão do PLANO (sem a marca) em Não realizado, com o teto ocupado → 409 como antes.
        expect((await call('PATCH', `/api/bookings/${covered[0]!.id}`, recepcao, { status: 'NAO_REALIZADO', statusReason: 'Equipamento.' })).status).toBe(200);
        const filler = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: fixo.id, date: weekdayN(2), startTime: '10:00' });
        expect(filler.status, JSON.stringify(filler.body)).toBe(201);
        const r = await call('PATCH', `/api/bookings/${covered[0]!.id}`, recepcao, { status: 'COMPLETED' });
        expect(r.status, JSON.stringify(r.body)).toBe(409);
        expect(r.body).toEqual({ code: 'FIXO_LIMIT_REACHED', error: REOPEN_FIXO_LIMIT });
        expect(await statusOf(covered[0]!.id)).toBe('NAO_REALIZADO');
    });
});

// ─── UXT-04 ─────────────────────────────────────────────

describe('UXT-04 — o 409 NO_CREDITS cobre o crédito devolvido que VENCEU (confisco semanal do FLEX)', () => {
    it('FLEX: sessão marcada depois do fim do ciclo vira Não realizado (+1), o cron confisca o crédito e a reabertura dá 409 com "já foi usado ou venceu"', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const DAY = 24 * 60 * 60 * 1000;
        const firstRecording = dbDate(saoPauloParts(new Date(Date.now() - (13 * 7 + 2) * DAY)).dateStr); // ciclo de 12 semanas já acabou
        const flex = await mkContract(client.id, {
            type: 'FLEX', flexCreditsTotal: 12, flexCreditsRemaining: 0, flexCreditsForfeited: 10, flexForfeitFloor: 0, flexCycleStart: firstRecording,
        });
        await mkBooking(client.id, flex.id, { date: firstRecording, startTime: '10:00', endTime: '12:00', status: 'COMPLETED' });
        const late = await mkBooking(client.id, flex.id, { ...slot(weekdayN(0), '10:00'), status: 'RESERVED' });

        expect((await call('PATCH', `/api/bookings/${late.id}`, recepcao, { status: 'NAO_REALIZADO', statusReason: 'Equipamento.' })).status).toBe(200);
        expect(await credits(flex.id)).toBe(1);
        await runFlexCreditExpiryJob();
        expect(await credits(flex.id)).toBe(0); // venceu: nenhum outro agendamento usou o crédito
        expect(await prisma.booking.count({ where: { contractId: flex.id, status: { notIn: ['CANCELLED', 'NAO_REALIZADO'] } } })).toBe(1);

        const r = await call('PATCH', `/api/bookings/${late.id}`, recepcao, { status: 'COMPLETED' });
        expect(r.status, JSON.stringify(r.body)).toBe(409);
        expect(r.body).toEqual({ code: 'NO_CREDITS', error: REOPEN_NO_CREDITS });
        expect(r.body.error).toMatch(/já foi usado ou venceu/);
        expect(await statusOf(late.id)).toBe('NAO_REALIZADO');
    });
});
