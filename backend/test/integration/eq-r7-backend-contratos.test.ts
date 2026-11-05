import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// ─── Notificações em segundo plano (o cancelamento do contrato avisa o cliente) ──────────────────
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
// ATU6-03: espiões (repassam para as funções reais) — a exclusão recusada não pode revogar a sessão nem pegar o mutex.
const spies = vi.hoisted(() => ({ revoke: [] as string[], mutex: [] as string[] }));
vi.mock('../../src/middleware/auth', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/middleware/auth')>();
    return {
        ...orig,
        revokeUserSessions: async (...a: Parameters<typeof orig.revokeUserSessions>) => {
            spies.revoke.push(a[0]);
            return orig.revokeUserSessions(...a);
        },
    };
});
vi.mock('../../src/lib/redis', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/redis')>();
    return {
        ...orig,
        acquireMutex: async (...a: Parameters<typeof orig.acquireMutex>) => {
            spies.mutex.push(a[0]);
            return orig.acquireMutex(...a);
        },
    };
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
import { readUserSessionRevocation, userDeletionLockKey } from '../../src/middleware/auth';
import bookingRoutes from '../../src/modules/bookings/routes';
import contractRoutes from '../../src/modules/contracts/routes';
import userRoutes from '../../src/modules/users/routes';
import { mkUser, mkStaff, mkContract, mkBooking, mkPayment, mkCpf } from './factories';

// RODADA 7 — frente R7a (backend), caminhos do CONTRATO e do CLIENTE:
//  (A) AUDFIN6-01: cancelar um contrato de QUALQUER tipo (DELETE, PATCH → CANCELLED) com a cobrança PRÓPRIA de uma
//      gravação em aberto (Payment com bookingId e a marca sessionCharge — SERVIÇO, extra do FIXO…) exige também
//      cobrancas.baixa — inclusive a de gravação JÁ FEITA. As parcelas seguem só com contratos.cancelar (D2). A lista
//      traz openSessionChargeCount (a conta do 403).
//  (B) ATU6-02 + AUDFIN6-01: DECIDIR o pedido de cancelamento (resolve-cancellation, contratos.multa) que anularia essa
//      cobrança (ou a do avulso) também pede a baixa — 403 antes de qualquer escrita, o pedido continua em análise.
//  (C) "Cancelar o contrato e depois excluir o cliente" não contorna mais a baixa: as duas portas recusam.
//  (D) ATU6-03: a exclusão recusada (403 das chaves, 400 do alvo) sai ANTES de qualquer efeito — sem revogar a sessão
//      do cliente e sem o mutex que trava o login dele.

type Who = { id: string; email: string | null; role: string };

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/bookings', bookingRoutes);
    app.use('/api/contracts', contractRoutes);
    app.use('/api/users', userRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
    const keys = [...await redis.keys('booking:lock:*'), ...await redis.keys('booking:fixo-cap:*'), ...await redis.keys('mutex:*')];
    if (keys.length) await redis.del(...keys);
    spies.revoke.length = 0;
    spies.mutex.length = 0;
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
function pastWeekdayN(n: number): string {
    let found = -1;
    for (let d = addDaysYmd(todaySp, -1); ; d = addDaysYmd(d, -1)) {
        if (dow(d) >= 1 && dow(d) <= 5 && ++found === n) return d;
    }
}
const slot = (date: string, startTime: string) => ({ date: dbDate(date), startTime, endTime: `${String(Number(startTime.slice(0, 2)) + 2).padStart(2, '0')}${startTime.slice(2)}` });

const MARK = { sessionCharge: true };
const EXTRA_URL = JSON.stringify({ addonKeys: ['CORTES_IA'] });

const SESSION_CANCEL_403 = {
    error: 'Uma gravação deste contrato tem cobrança própria em aberto (a da sessão, cobrada à parte): cancelar o contrato anula essa cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa.',
    code: 'PERMISSION_DENIED',
    permission: 'cobrancas.baixa',
};
const AVULSO_CANCEL_403 = {
    error: 'Este avulso tem cobrança em aberto: cancelar o contrato anula a cobrança da sessão, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa.',
    code: 'PERMISSION_DENIED',
    permission: 'cobrancas.baixa',
};

const statusOf = async (id: string) => (await prisma.booking.findUniqueOrThrow({ where: { id } })).status;
const payStatus = async (id: string) => (await prisma.payment.findUniqueOrThrow({ where: { id } })).status;
const contractStatus = async (id: string) => (await prisma.contract.findUniqueOrThrow({ where: { id } })).status;
const newClient = () => mkUser({ cpfCnpj: mkCpf() });

/**
 * SERVIÇO ativo com: gravação JÁ FEITA (Concluída) e uma futura (Reservada), cada uma com a cobrança própria marcada
 * em aberto — o que o POST /bookings/admin grava ao vincular a gravação ao SERVIÇO —, e uma parcela do serviço em aberto.
 */
async function servicoWithSessionCharges(clientId: string) {
    const servico = await mkContract(clientId, { type: 'SERVICO', tier: 'COMERCIAL' });
    const done = await mkBooking(clientId, servico.id, { ...slot(pastWeekdayN(0), '10:00'), status: 'COMPLETED' });
    const donePay = await mkPayment(clientId, { contractId: servico.id, bookingId: done.id, status: 'PENDING', amount: 30000, metadata: MARK });
    const next = await mkBooking(clientId, servico.id, { ...slot(weekdayN(0), '10:00'), status: 'RESERVED' });
    const nextPay = await mkPayment(clientId, { contractId: servico.id, bookingId: next.id, status: 'PENDING', amount: 30000, metadata: MARK });
    const installment = await mkPayment(clientId, { contractId: servico.id, status: 'PENDING', amount: 50000, dueDate: dbDate(weekdayN(10)) });
    return { servico, done, donePay, next, nextPay, installment };
}

// ─── (A) Cancelar o contrato com a cobrança própria de uma gravação em aberto ─────────────────────

describe('R7a (A) — AUDFIN6-01: cancelar contrato de qualquer tipo com cobrança própria de gravação em aberto exige a baixa', () => {
    it('SERVIÇO, só contratos.cancelar: lista conta 2; DELETE e PATCH → CANCELLED dão 403 e NADA muda (nem a gravação já feita)', async () => {
        const colab = await mkStaff({ permissions: ['contratos.ver', 'contratos.cancelar'] });
        const client = await newClient();
        const s = await servicoWithSessionCharges(client.id);

        const list = await call('GET', '/api/contracts', colab);
        expect(list.status).toBe(200);
        expect(list.body.contracts.find((c: any) => c.id === s.servico.id)).toMatchObject({ openChargeCount: 3, openSessionChargeCount: 2 });

        const del = await call('DELETE', `/api/contracts/${s.servico.id}`, colab);
        expect(del.status, JSON.stringify(del.body)).toBe(403);
        expect(del.body).toEqual(SESSION_CANCEL_403);
        const patch = await call('PATCH', `/api/contracts/${s.servico.id}`, colab, { status: 'CANCELLED' });
        expect(patch.status, JSON.stringify(patch.body)).toBe(403);
        expect(patch.body).toEqual(SESSION_CANCEL_403);

        expect(await contractStatus(s.servico.id)).toBe('ACTIVE');
        expect(await statusOf(s.done.id)).toBe('COMPLETED');
        expect(await statusOf(s.next.id)).toBe('RESERVED');
        for (const p of [s.donePay, s.nextPay, s.installment]) expect(await payStatus(p.id)).toBe('PENDING');
    });

    it('SERVIÇO só com parcelas (e a cobrança da gravação já paga): o mesmo colaborador cancela (200) e as parcelas são anuladas — D2', async () => {
        const colab = await mkStaff({ permissions: ['contratos.ver', 'contratos.cancelar'] });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        const done = await mkBooking(client.id, servico.id, { ...slot(pastWeekdayN(1), '10:00'), status: 'COMPLETED' });
        const paidPay = await mkPayment(client.id, { contractId: servico.id, bookingId: done.id, status: 'PAID', paidAt: new Date(), amount: 30000, metadata: MARK });
        const installment = await mkPayment(client.id, { contractId: servico.id, status: 'PENDING', amount: 50000 });

        const list = await call('GET', '/api/contracts', colab);
        expect(list.body.contracts.find((c: any) => c.id === servico.id)).toMatchObject({ openChargeCount: 1, openSessionChargeCount: 0 });
        const r = await call('DELETE', `/api/contracts/${servico.id}`, colab);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(await contractStatus(servico.id)).toBe('CANCELLED');
        expect(await payStatus(installment.id)).toBe('CANCELLED');
        expect(await payStatus(paidPay.id)).toBe('PAID');
    });

    it('com a baixa e o ADMIN: cancela (DELETE e PATCH) e anula as cobranças das gravações e as parcelas; a futura é cancelada, a feita fica', async () => {
        const comBaixa = await mkStaff({ permissions: ['contratos.ver', 'contratos.cancelar', 'cobrancas.baixa'] });
        const admin = await mkUser({ role: 'ADMIN' });
        for (const [who, how] of [[comBaixa, 'DELETE'], [admin, 'PATCH']] as const) {
            const client = await newClient();
            const s = await servicoWithSessionCharges(client.id);
            const r = how === 'DELETE'
                ? await call('DELETE', `/api/contracts/${s.servico.id}`, who)
                : await call('PATCH', `/api/contracts/${s.servico.id}`, who, { status: 'CANCELLED' });
            expect(r.status, `${how}: ${JSON.stringify(r.body)}`).toBe(200);
            expect(await contractStatus(s.servico.id)).toBe('CANCELLED');
            for (const p of [s.donePay, s.nextPay, s.installment]) expect(await payStatus(p.id)).toBe('CANCELLED');
            expect(await statusOf(s.next.id)).toBe('CANCELLED');
            expect(await statusOf(s.done.id)).toBe('COMPLETED');
        }
    });

    it('FIXO também: a sessão EXTRA (fixoExtra) e a cobrada à parte dentro do plano com cobrança em aberto → 403; só o serviço extra de sessão de plano → 200 (D2)', async () => {
        const colab = await mkStaff({ permissions: ['contratos.ver', 'contratos.cancelar'] });
        for (const metadata of [{ sessionCharge: true, fixoExtra: true }, { sessionCharge: true }]) {
            const client = await newClient();
            const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL' });
            const b = await mkBooking(client.id, fixo.id, { ...slot(weekdayN(1), '10:00'), status: 'RESERVED' });
            const p = await mkPayment(client.id, { contractId: fixo.id, bookingId: b.id, status: 'FAILED', amount: 30000, metadata });
            const r = await call('DELETE', `/api/contracts/${fixo.id}`, colab);
            expect(r.status, `${JSON.stringify(metadata)}: ${JSON.stringify(r.body)}`).toBe(403);
            expect(r.body).toEqual(SESSION_CANCEL_403);
            expect(await contractStatus(fixo.id)).toBe('ACTIVE');
            expect(await payStatus(p.id)).toBe('FAILED');
        }

        const client = await newClient();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL' });
        const b = await mkBooking(client.id, fixo.id, { ...slot(weekdayN(2), '10:00'), status: 'RESERVED' });
        const addon = await mkPayment(client.id, { contractId: fixo.id, bookingId: b.id, status: 'PENDING', amount: 10000, paymentUrl: EXTRA_URL });
        const ok = await call('DELETE', `/api/contracts/${fixo.id}`, colab);
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(await payStatus(addon.id)).toBe('CANCELLED');
    });
});

// ─── (B) Decidir o pedido de cancelamento ────────────────────────────────────────────────────────

describe('R7a (B) — ATU6-02/AUDFIN6-01: decidir o pedido que anularia cobrança de sessão em aberto exige a baixa', () => {
    it('AVULSO com a gravação já iniciada: o cliente pede (a cobrança fica); só contratos.multa → 403 nas duas decisões e nada muda', async () => {
        const multa = await mkStaff({ permissions: ['contratos.ver', 'contratos.multa'] });
        const comBaixa = await mkStaff({ permissions: ['contratos.ver', 'contratos.multa', 'cobrancas.baixa'] });
        const client = await newClient();
        const day = weekdayN(0);
        const avulso = await mkContract(client.id, { type: 'AVULSO', durationMonths: 1, discountPct: 0, paymentPlan: 'FULL', startDate: dbDate(day), endDate: dbDate(day), flexCreditsTotal: 1, flexCreditsRemaining: 0 });
        const b = await mkBooking(client.id, avulso.id, { ...slot(day, '10:00'), status: 'CONFIRMED', recordingStartedAt: new Date() });
        const p = await mkPayment(client.id, { contractId: avulso.id, bookingId: b.id, status: 'PENDING', amount: 30000, metadata: MARK });

        const req = await call('POST', `/api/contracts/${avulso.id}/request-cancellation`, client);
        expect(req.status, JSON.stringify(req.body)).toBe(200);
        expect(await payStatus(p.id)).toBe('PENDING');
        expect(await contractStatus(avulso.id)).toBe('PENDING_CANCELLATION');

        for (const action of ['WAIVE_FEE', 'CHARGE_FEE']) {
            const r = await call('POST', `/api/contracts/${avulso.id}/resolve-cancellation`, multa, { action });
            expect(r.status, `${action}: ${JSON.stringify(r.body)}`).toBe(403);
            expect(r.body).toEqual(AVULSO_CANCEL_403);
        }
        expect(await contractStatus(avulso.id)).toBe('PENDING_CANCELLATION');
        expect(await payStatus(p.id)).toBe('PENDING');
        expect(await prisma.payment.count({ where: { contractId: avulso.id } })).toBe(1); // nenhuma multa criada

        const ok = await call('POST', `/api/contracts/${avulso.id}/resolve-cancellation`, comBaixa, { action: 'WAIVE_FEE' });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(await contractStatus(avulso.id)).toBe('CANCELLED');
        expect(await payStatus(p.id)).toBe('CANCELLED');
    });

    it('SERVIÇO com a gravação já feita em aberto: só contratos.multa → 403 (texto da gravação); com a baixa → 200 e anula', async () => {
        const multa = await mkStaff({ permissions: ['contratos.ver', 'contratos.multa'] });
        const comBaixa = await mkStaff({ permissions: ['contratos.ver', 'contratos.multa', 'cobrancas.baixa'] });
        const client = await newClient();
        const s = await servicoWithSessionCharges(client.id);
        const req = await call('POST', `/api/contracts/${s.servico.id}/request-cancellation`, client);
        expect(req.status, JSON.stringify(req.body)).toBe(200);
        // O pedido cancelou a futura e anulou a cobrança dela; a da gravação já feita ficou.
        expect(await statusOf(s.next.id)).toBe('CANCELLED');
        expect(await payStatus(s.nextPay.id)).toBe('CANCELLED');
        expect(await payStatus(s.donePay.id)).toBe('PENDING');

        const r = await call('POST', `/api/contracts/${s.servico.id}/resolve-cancellation`, multa, { action: 'CHARGE_FEE' });
        expect(r.status, JSON.stringify(r.body)).toBe(403);
        expect(r.body).toEqual(SESSION_CANCEL_403);
        expect(await contractStatus(s.servico.id)).toBe('PENDING_CANCELLATION');
        expect(await payStatus(s.donePay.id)).toBe('PENDING');
        expect(await payStatus(s.installment.id)).toBe('PENDING');

        const ok = await call('POST', `/api/contracts/${s.servico.id}/resolve-cancellation`, comBaixa, { action: 'WAIVE_FEE' });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(await payStatus(s.donePay.id)).toBe('CANCELLED');
        expect(await payStatus(s.installment.id)).toBe('CANCELLED');
    });

    it('controle (D2): FIXO em análise só com parcelas — quem só tem contratos.multa decide (200) e anula as parcelas', async () => {
        const multa = await mkStaff({ permissions: ['contratos.ver', 'contratos.multa'] });
        const client = await newClient();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL', status: 'PENDING_CANCELLATION' });
        const parcela = await mkPayment(client.id, { contractId: fixo.id, status: 'PENDING', amount: 84000, dueDate: dbDate(weekdayN(5)) });
        const r = await call('POST', `/api/contracts/${fixo.id}/resolve-cancellation`, multa, { action: 'WAIVE_FEE' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(await contractStatus(fixo.id)).toBe('CANCELLED');
        expect(await payStatus(parcela.id)).toBe('CANCELLED');
    });
});

// ─── (C) Cancelar o contrato e depois excluir o cliente ──────────────────────────────────────────

describe('R7a (C) — "cancelar o contrato e depois excluir o cliente" não contorna a baixa', () => {
    it('SERVIÇO com a cobrança da gravação feita em aberto: sem a baixa, as duas portas recusam e nada muda; com a baixa, passam', async () => {
        const semBaixa = await mkStaff({ permissions: ['clientes.ver', 'clientes.excluir', 'contratos.ver', 'contratos.cancelar'] });
        const client = await newClient();
        const s = await servicoWithSessionCharges(client.id);

        const cancel = await call('DELETE', `/api/contracts/${s.servico.id}`, semBaixa);
        expect(cancel.status, JSON.stringify(cancel.body)).toBe(403);
        expect(cancel.body).toEqual(SESSION_CANCEL_403);
        const prev = await call('GET', `/api/users/${client.id}/deletion-preview`, semBaixa);
        expect(prev.body.preview.missingPermissions).toEqual(['cobrancas.baixa']);
        const del = await call('DELETE', `/api/users/${client.id}`, semBaixa);
        expect(del.status, JSON.stringify(del.body)).toBe(403);
        expect(del.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa', missingPermissions: ['cobrancas.baixa'] });
        expect(await contractStatus(s.servico.id)).toBe('ACTIVE');
        expect(await payStatus(s.donePay.id)).toBe('PENDING');
        expect((await prisma.user.findUniqueOrThrow({ where: { id: client.id } })).deletedAt).toBeNull();

        const comBaixa = await mkStaff({ permissions: ['clientes.ver', 'clientes.excluir', 'contratos.ver', 'contratos.cancelar', 'cobrancas.baixa'] });
        const ok = await call('DELETE', `/api/contracts/${s.servico.id}`, comBaixa);
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(await payStatus(s.donePay.id)).toBe('CANCELLED');
        const gone = await call('DELETE', `/api/users/${client.id}`, comBaixa);
        expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    });
});

// ─── (D) A exclusão recusada não mexe na sessão nem no login do cliente ──────────────────────────

describe('R7a (D) — ATU6-03: o 403 da exclusão sai antes de revogar a sessão e de travar o login do cliente', () => {
    const SO_EXCLUIR = ['clientes.ver', 'clientes.excluir'];

    async function clientWithPendingCancellation() {
        const client = await newClient();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL', durationMonths: 6, status: 'PENDING_CANCELLATION' });
        const p1 = await mkPayment(client.id, { contractId: fixo.id, status: 'PENDING', amount: 84000, dueDate: dbDate(weekdayN(5)) });
        return { client, fixo, p1 };
    }

    it('colaborador sem as chaves: 403 com missingPermissions, sem revogar a sessão nem pegar o mutex — o cliente continua logado', async () => {
        const colab = await mkStaff({ permissions: SO_EXCLUIR });
        const { client, fixo, p1 } = await clientWithPendingCancellation();
        expect((await call('GET', '/api/contracts/my', client)).status).toBe(200);

        for (let i = 0; i < 3; i++) {
            const del = await call('DELETE', `/api/users/${client.id}`, colab);
            expect(del.status, JSON.stringify(del.body)).toBe(403);
            expect(del.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'contratos.cancelar', missingPermissions: ['contratos.cancelar', 'contratos.multa'] });
        }
        expect(spies.revoke).not.toContain(client.id);
        expect(spies.mutex).not.toContain(userDeletionLockKey(client.id));
        expect(await redis.exists(userDeletionLockKey(client.id))).toBe(0);
        expect((await readUserSessionRevocation(client.id))?.value ?? null).toBeNull();
        // A sessão do cliente segue valendo (o token emitido antes continua aceito).
        expect((await call('GET', '/api/contracts/my', client)).status).toBe(200);
        expect(await contractStatus(fixo.id)).toBe('PENDING_CANCELLATION');
        expect(await payStatus(p1.id)).toBe('PENDING');
    });

    it('alvo inválido (conta da equipe): 400 também sem mutex nem revogação', async () => {
        const colab = await mkStaff({ permissions: SO_EXCLUIR });
        const other = await mkStaff({ permissions: ['hoje.ver'] });
        const r = await call('DELETE', `/api/users/${other.id}`, colab);
        expect(r.status, JSON.stringify(r.body)).toBe(400);
        expect(spies.revoke).not.toContain(other.id);
        expect(spies.mutex).not.toContain(userDeletionLockKey(other.id));
    });

    it('controle: com as chaves a exclusão segue o caminho de antes (mutex, revogação provisória e final) e exclui', async () => {
        const colab = await mkStaff({ permissions: [...SO_EXCLUIR, 'contratos.cancelar', 'contratos.multa'] });
        const { client, fixo, p1 } = await clientWithPendingCancellation();
        const del = await call('DELETE', `/api/users/${client.id}`, colab);
        expect(del.status, JSON.stringify(del.body)).toBe(200);
        expect(spies.mutex).toContain(userDeletionLockKey(client.id));
        expect(spies.revoke).toContain(client.id);
        expect(await contractStatus(fixo.id)).toBe('CANCELLED');
        expect(await payStatus(p1.id)).toBe('CANCELLED');
        expect((await prisma.user.findUniqueOrThrow({ where: { id: client.id } })).deletedAt).not.toBeNull();
    });
});
