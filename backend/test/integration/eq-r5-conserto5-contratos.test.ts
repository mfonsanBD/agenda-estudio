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
import { readUserSessionRevocation } from '../../src/middleware/auth';
import bookingRoutes from '../../src/modules/bookings/routes';
import contractRoutes from '../../src/modules/contracts/routes';
import userRoutes from '../../src/modules/users/routes';
import { mkUser, mkStaff, mkContract, mkBooking, mkPayment, mkCpf } from './factories';

// CONSERTO 5 (revisão 5) — "anular cobrança em aberto é da baixa" pelos caminhos do CONTRATO e do CLIENTE:
//  (F) AUDFIN-03: pausar o FIXO (contratos.editar) não cancela a sessão EXTRA (fixoExtra) e, sem cobrancas.baixa,
//      recusa (403) quando uma gravação que ela cancelaria tem cobrança em aberto; com a baixa, anula.
//  (G) ATU5-03: no AVULSO o contrato é a sessão — cancelá-lo (DELETE ou PATCH → CANCELLED) com cobrança em aberto
//      exige também a baixa. O contrato de PLANO segue como antes (contratos.cancelar anula as parcelas — D2).
//  (H) AUDFIN-04: excluir o cliente (clientes.excluir) exige também a chave de tudo que a exclusão anularia:
//      contratos.cancelar (contrato em andamento), contratos.multa (pedido em análise / multa em aberto),
//      cobrancas.baixa (cobrança de sessão, avulsa ou de contrato encerrado). Nada muda no 403.

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

const RECEPCAO = ['agendamentos.ver', 'agendamentos.criar', 'agendamentos.editar', 'agendamentos.faltas', 'agendamentos.cancelar', 'hoje.ver', 'hoje.presenca', 'clientes.ver', 'clientes.criar', 'clientes.editar', 'contratos.ver', 'contratos.criar', 'cobrancas.cobrar', 'cupons.ver'];
const EXTRA_URL = JSON.stringify({ addonKeys: ['CORTES_IA'] });

const PAUSE_403 = {
    error: 'Uma gravação que a pausa cancelaria tem cobrança em aberto: cancelar anula a cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa.',
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

// ─── (F) Pausa do FIXO ──────────────────────────────────────────────────────────────────────────

/** FIXO ativo com: sessão do plano + extra contratado em aberto; sessão do plano sem cobrança; EXTRA (fixoExtra) em aberto e EXTRA paga. */
async function fixoForPause(clientId: string) {
    const fixo = await mkContract(clientId, { type: 'FIXO', tier: 'COMERCIAL', durationMonths: 1, fixedDayOfWeek: 1, fixedTime: '10:00' });
    const planWithAddon = await mkBooking(clientId, fixo.id, { ...slot(weekdayN(0), '10:00'), status: 'RESERVED' });
    const addon = await mkPayment(clientId, { contractId: fixo.id, bookingId: planWithAddon.id, status: 'PENDING', amount: 10000, paymentUrl: EXTRA_URL });
    const planPlain = await mkBooking(clientId, fixo.id, { ...slot(weekdayN(1), '10:00'), status: 'CONFIRMED' });
    const extraOpen = await mkBooking(clientId, fixo.id, { ...slot(weekdayN(2), '10:00'), status: 'RESERVED' });
    const extraOpenPay = await mkPayment(clientId, { contractId: fixo.id, bookingId: extraOpen.id, status: 'PENDING', amount: 30000, metadata: { sessionCharge: true, fixoExtra: true } });
    const extraPaid = await mkBooking(clientId, fixo.id, { ...slot(weekdayN(3), '10:00'), status: 'CONFIRMED' });
    const extraPaidPay = await mkPayment(clientId, { contractId: fixo.id, bookingId: extraPaid.id, status: 'PAID', paidAt: new Date(), amount: 30000, metadata: { sessionCharge: true, fixoExtra: true } });
    return { fixo, planWithAddon, addon, planPlain, extraOpen, extraOpenPay, extraPaid, extraPaidPay };
}

describe('Conserto 5 (F) — AUDFIN-03: pausar o FIXO não anula cobrança sem a baixa e mantém a EXTRA', () => {
    it('sem a baixa (contratos.editar): 403 e NADA muda — contrato ativo, sessões e cobranças como estavam', async () => {
        const colab = await mkStaff({ permissions: ['contratos.ver', 'contratos.editar'] });
        const client = await newClient();
        const f = await fixoForPause(client.id);

        const r = await call('PATCH', `/api/contracts/${f.fixo.id}/pause`, colab, { reason: 'Férias' });
        expect(r.status, JSON.stringify(r.body)).toBe(403);
        expect(r.body).toEqual(PAUSE_403);
        expect(await contractStatus(f.fixo.id)).toBe('ACTIVE');
        expect(await statusOf(f.planWithAddon.id)).toBe('RESERVED');
        expect(await statusOf(f.planPlain.id)).toBe('CONFIRMED');
        expect(await payStatus(f.addon.id)).toBe('PENDING');
        expect(await payStatus(f.extraOpenPay.id)).toBe('PENDING');
    });

    it('ADMIN (e quem tem a baixa): pausa, cancela as sessões do plano e anula o extra delas; as EXTRAS seguem vivas (a em aberto continua pagável)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const baixa = await mkStaff({ permissions: ['contratos.ver', 'contratos.editar', 'cobrancas.baixa'] });
        for (const who of [admin, baixa]) {
            const client = await newClient();
            const f = await fixoForPause(client.id);
            const r = await call('PATCH', `/api/contracts/${f.fixo.id}/pause`, who, { reason: 'Férias' });
            expect(r.status, JSON.stringify(r.body)).toBe(200);
            expect(r.body.message).toBe('Contrato pausado. 1 cobrança em aberto das gravações canceladas foi anulada.');
            expect(await contractStatus(f.fixo.id)).toBe('PAUSED');
            expect(await statusOf(f.planWithAddon.id)).toBe('CANCELLED');
            expect(await statusOf(f.planPlain.id)).toBe('CANCELLED');
            expect(await payStatus(f.addon.id)).toBe('CANCELLED');
            expect(await statusOf(f.extraOpen.id)).toBe('RESERVED');
            expect(await payStatus(f.extraOpenPay.id)).toBe('PENDING');
            expect(await statusOf(f.extraPaid.id)).toBe('CONFIRMED');
            expect(await payStatus(f.extraPaidPay.id)).toBe('PAID');
        }
    });

    it('controle: sem cobrança em aberto nas sessões do PLANO, quem só tem contratos.editar pausa (200) e a EXTRA em aberto não é tocada', async () => {
        const colab = await mkStaff({ permissions: ['contratos.ver', 'contratos.editar'] });
        const client = await newClient();
        const f = await fixoForPause(client.id);
        await prisma.payment.delete({ where: { id: f.addon.id } });
        const r = await call('PATCH', `/api/contracts/${f.fixo.id}/pause`, colab, { reason: 'Férias' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.message).toBe('Contrato pausado.');
        expect(await statusOf(f.planWithAddon.id)).toBe('CANCELLED');
        expect(await statusOf(f.extraOpen.id)).toBe('RESERVED');
        expect(await payStatus(f.extraOpenPay.id)).toBe('PENDING');
    });
});

// ─── (G) Cancelar o contrato AVULSO ─────────────────────────────────────────────────────────────

describe('Conserto 5 (G) — ATU5-03: cancelar o contrato avulso com cobrança em aberto exige a baixa', () => {
    async function deskAvulso(clientId: string, n: number) {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const c = await call('POST', '/api/bookings/admin', recepcao, { userId: clientId, date: weekdayN(n), startTime: '10:00' });
        expect(c.status, JSON.stringify(c.body)).toBe(201);
        const contractId = (await prisma.booking.findUniqueOrThrow({ where: { id: c.body.booking.id } })).contractId!;
        return { contractId, bookingId: c.body.booking.id as string, paymentId: c.body.paymentId as string };
    }

    it('contratos.cancelar sem a baixa: DELETE e PATCH → CANCELLED dão 403 e nada muda; a lista traz openChargeCount', async () => {
        const colab = await mkStaff({ permissions: ['contratos.ver', 'contratos.cancelar'] });
        const client = await newClient();
        const a = await deskAvulso(client.id, 0);

        const list = await call('GET', '/api/contracts', colab);
        expect(list.status).toBe(200);
        expect(list.body.contracts.find((c: any) => c.id === a.contractId).openChargeCount).toBe(1);

        const del = await call('DELETE', `/api/contracts/${a.contractId}`, colab);
        expect(del.status, JSON.stringify(del.body)).toBe(403);
        expect(del.body).toEqual(AVULSO_CANCEL_403);
        const patch = await call('PATCH', `/api/contracts/${a.contractId}`, colab, { status: 'CANCELLED' });
        expect(patch.status, JSON.stringify(patch.body)).toBe(403);
        expect(patch.body).toEqual(AVULSO_CANCEL_403);
        expect(await contractStatus(a.contractId)).toBe('ACTIVE');
        expect(await statusOf(a.bookingId)).toBe('RESERVED');
        expect(await payStatus(a.paymentId)).toBe('PENDING');
    });

    it('avulso já GRAVADO (Concluído) com a cobrança em aberto: PATCH → CANCELLED também 403', async () => {
        const colab = await mkStaff({ permissions: ['contratos.ver', 'contratos.cancelar'] });
        const client = await newClient();
        const day = pastWeekdayN(0);
        const avulso = await mkContract(client.id, { type: 'AVULSO', status: 'COMPLETED', durationMonths: 1, discountPct: 0, paymentPlan: 'FULL', startDate: dbDate(day), endDate: dbDate(day), flexCreditsTotal: 1, flexCreditsRemaining: 0 });
        const b = await mkBooking(client.id, avulso.id, { ...slot(day, '10:00'), status: 'COMPLETED' });
        const p = await mkPayment(client.id, { contractId: avulso.id, bookingId: b.id, status: 'PENDING', amount: 30000, metadata: { sessionCharge: true } });
        const r = await call('PATCH', `/api/contracts/${avulso.id}`, colab, { status: 'CANCELLED' });
        expect(r.status, JSON.stringify(r.body)).toBe(403);
        expect(r.body).toEqual(AVULSO_CANCEL_403);
        expect(await contractStatus(avulso.id)).toBe('COMPLETED');
        expect(await payStatus(p.id)).toBe('PENDING');
    });

    it('com a baixa (e o ADMIN): cancela e anula; contrato de PLANO segue cancelável só com contratos.cancelar (D2)', async () => {
        const comBaixa = await mkStaff({ permissions: ['contratos.ver', 'contratos.cancelar', 'cobrancas.baixa'] });
        const admin = await mkUser({ role: 'ADMIN' });
        let n = 0;
        for (const who of [comBaixa, admin]) {
            const client = await newClient();
            const a = await deskAvulso(client.id, n++);
            const r = await call('DELETE', `/api/contracts/${a.contractId}`, who);
            expect(r.status, JSON.stringify(r.body)).toBe(200);
            expect(await contractStatus(a.contractId)).toBe('CANCELLED');
            expect(await payStatus(a.paymentId)).toBe('CANCELLED');
            expect(await statusOf(a.bookingId)).toBe('CANCELLED');
        }

        const colab = await mkStaff({ permissions: ['contratos.ver', 'contratos.cancelar'] });
        const client = await newClient();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL' });
        const b = await mkBooking(client.id, fixo.id, { ...slot(weekdayN(4), '10:00'), status: 'RESERVED' });
        const addon = await mkPayment(client.id, { contractId: fixo.id, bookingId: b.id, status: 'PENDING', amount: 10000, paymentUrl: EXTRA_URL });
        const plan = await call('DELETE', `/api/contracts/${fixo.id}`, colab);
        expect(plan.status, JSON.stringify(plan.body)).toBe(200);
        expect(await payStatus(addon.id)).toBe('CANCELLED');
    });
});

// ─── (H) Excluir o cliente ──────────────────────────────────────────────────────────────────────

describe('Conserto 5 (H) — AUDFIN-04: excluir o cliente não contorna cancelar contrato, multa nem a baixa', () => {
    const SO_EXCLUIR = ['clientes.ver', 'clientes.excluir'];

    async function clientWithPendingCancellation() {
        const client = await newClient();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL', durationMonths: 6, status: 'PENDING_CANCELLATION' });
        const p1 = await mkPayment(client.id, { contractId: fixo.id, status: 'PENDING', amount: 84000, dueDate: dbDate(weekdayN(5)) });
        const p2 = await mkPayment(client.id, { contractId: fixo.id, status: 'PENDING', amount: 84000, dueDate: dbDate(weekdayN(25)) });
        return { client, fixo, installments: [p1, p2] };
    }

    it('só clientes.excluir, cliente com FIXO em pedido de cancelamento e parcelas em aberto: prévia avisa; DELETE 403 e nada muda', async () => {
        const colab = await mkStaff({ permissions: SO_EXCLUIR });
        const { client, fixo, installments } = await clientWithPendingCancellation();

        const prev = await call('GET', `/api/users/${client.id}/deletion-preview`, colab);
        expect(prev.status, JSON.stringify(prev.body)).toBe(200);
        expect(prev.body.preview.missingPermissions).toEqual(['contratos.cancelar', 'contratos.multa']);
        expect(prev.body.preview.blockedMessage).toMatch(/^Excluir este cliente anula o que ele tem em aberto, e isso exige também “Cancelar contrato”/);

        const del = await call('DELETE', `/api/users/${client.id}`, colab);
        expect(del.status, JSON.stringify(del.body)).toBe(403);
        expect(del.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'contratos.cancelar', missingPermissions: ['contratos.cancelar', 'contratos.multa'] });
        expect(del.body.error).toBe(prev.body.preview.blockedMessage);
        expect(await contractStatus(fixo.id)).toBe('PENDING_CANCELLATION');
        for (const p of installments) expect(await payStatus(p.id)).toBe('PENDING');
        const u = await prisma.user.findUniqueOrThrow({ where: { id: client.id } });
        expect(u.deletedAt).toBeNull();
        expect(u.email).not.toBeNull();
        // A revogação provisória da exclusão foi desfeita: a sessão do cliente volta a valer.
        expect((await readUserSessionRevocation(client.id))?.value ?? null).toBeNull();
    });

    it('com contratos.cancelar e contratos.multa (sem a baixa): exclui — as parcelas do plano são da chave do contrato (D2)', async () => {
        const colab = await mkStaff({ permissions: [...SO_EXCLUIR, 'contratos.cancelar', 'contratos.multa'] });
        const { client, fixo, installments } = await clientWithPendingCancellation();
        const prev = await call('GET', `/api/users/${client.id}/deletion-preview`, colab);
        expect(prev.body.preview).toMatchObject({ missingPermissions: [], blockedMessage: null });
        const del = await call('DELETE', `/api/users/${client.id}`, colab);
        expect(del.status, JSON.stringify(del.body)).toBe(200);
        expect(await contractStatus(fixo.id)).toBe('CANCELLED');
        for (const p of installments) expect(await payStatus(p.id)).toBe('CANCELLED');
        expect((await prisma.user.findUniqueOrThrow({ where: { id: client.id } })).deletedAt).not.toBeNull();
    });

    it('cobrança de SESSÃO (avulso), avulsa sem contrato e multa em aberto pedem a chave delas (403 citando a que falta)', async () => {
        // Avulso da Recepção: contrato em andamento (contratos.cancelar) + cobrança da sessão (baixa).
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const c1 = await newClient();
        const desk = await call('POST', '/api/bookings/admin', recepcao, { userId: c1.id, date: weekdayN(0), startTime: '10:00' });
        expect(desk.status, JSON.stringify(desk.body)).toBe(201);
        const r1 = await call('DELETE', `/api/users/${c1.id}`, await mkStaff({ permissions: [...SO_EXCLUIR, 'contratos.cancelar'] }));
        expect(r1.status, JSON.stringify(r1.body)).toBe(403);
        expect(r1.body).toMatchObject({ permission: 'cobrancas.baixa', missingPermissions: ['cobrancas.baixa'] });
        expect(await payStatus(desk.body.paymentId)).toBe('PENDING');
        expect(await statusOf(desk.body.booking.id)).toBe('RESERVED');

        // Cobrança avulsa sem contrato.
        const c2 = await newClient();
        const loose = await mkPayment(c2.id, { status: 'PENDING', amount: 5000 });
        const r2 = await call('DELETE', `/api/users/${c2.id}`, await mkStaff({ permissions: SO_EXCLUIR }));
        expect(r2.status, JSON.stringify(r2.body)).toBe(403);
        expect(r2.body.permission).toBe('cobrancas.baixa');
        expect(await payStatus(loose.id)).toBe('PENDING');

        // Multa de cancelamento em aberto num contrato já cancelado.
        const c3 = await newClient();
        const gone = await mkContract(c3.id, { type: 'FIXO', status: 'CANCELLED' });
        const fine = await mkPayment(c3.id, { contractId: gone.id, status: 'PENDING', amount: 20000, metadata: { kind: 'CANCELLATION_FINE' } });
        const r3 = await call('DELETE', `/api/users/${c3.id}`, await mkStaff({ permissions: SO_EXCLUIR }));
        expect(r3.status, JSON.stringify(r3.body)).toBe(403);
        expect(r3.body).toMatchObject({ permission: 'contratos.multa', missingPermissions: ['contratos.multa'] });
        expect(await payStatus(fine.id)).toBe('PENDING');
    });

    it('sem nada em aberto (só histórico pago) basta clientes.excluir; o ADMIN exclui mesmo com tudo em aberto', async () => {
        const c1 = await newClient();
        const done = await mkContract(c1.id, { type: 'FIXO', status: 'COMPLETED' });
        await mkPayment(c1.id, { contractId: done.id, status: 'PAID', paidAt: new Date(), amount: 84000 });
        const r1 = await call('DELETE', `/api/users/${c1.id}`, await mkStaff({ permissions: SO_EXCLUIR }));
        expect(r1.status, JSON.stringify(r1.body)).toBe(200);

        const admin = await mkUser({ role: 'ADMIN' });
        const { client, fixo, installments } = await clientWithPendingCancellation();
        const prev = await call('GET', `/api/users/${client.id}/deletion-preview`, admin);
        expect(prev.body.preview.missingPermissions).toEqual([]);
        const r2 = await call('DELETE', `/api/users/${client.id}`, admin);
        expect(r2.status, JSON.stringify(r2.body)).toBe(200);
        expect(await contractStatus(fixo.id)).toBe('CANCELLED');
        for (const p of installments) expect(await payStatus(p.id)).toBe('CANCELLED');
    });
});
