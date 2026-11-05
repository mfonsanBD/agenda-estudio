import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// ─── Notificações em segundo plano ───────────────────────────────────────────────────────────────
// O /confirm avisa a equipe DEPOIS de responder (sem await): o INSERT em `notifications` não pode cruzar com o
// TRUNCATE do caso seguinte. O mock só embrulha as funções reais para o afterEach aguardar o que ficou pendente.
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

// ─── Mocks dos provedores (Stripe / Sicoob) e do push: nenhuma chamada de rede real ─────────────
vi.mock('../../src/lib/sicoobService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/sicoobService')>();
    return {
        ...orig,
        sicoobGetCob: vi.fn(),
        sicoobRemoveCob: vi.fn(async () => true),
        sicoobCreatePix: vi.fn(),
        getSicoobEnvironment: vi.fn(async () => 'sandbox'),
    };
});
vi.mock('../../src/lib/stripeService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/stripeService')>();
    return {
        ...orig,
        isStripeEnabled: vi.fn(async () => true),
        stripeCardInstallmentsSupported: vi.fn(async () => false),
        stripeGetPaymentIntent: vi.fn(),
        stripeCancelPaymentIntent: vi.fn(async () => ({ status: 'canceled', canceled: true })),
        stripeChargeOffSession: vi.fn(),
        stripeCreatePaymentIntent: vi.fn(),
        stripeGetOrCreateCustomer: vi.fn(async () => 'cus_test'),
    };
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
import * as sicoob from '../../src/lib/sicoobService';
import * as stripe from '../../src/lib/stripeService';
import { buildStaticBrCode } from '../../src/lib/brcode';
import bookingRoutes from '../../src/modules/bookings/routes';
import stripeRoutes from '../../src/modules/stripe/routes';
import { mkUser, mkStaff, mkContract, mkBooking, mkCpf } from './factories';

// FRENTE R4a — item 3 (ATK-03/FIN-05): a cobrança da PRÓPRIA sessão criada pelo POST /bookings/admin (avulso,
// SERVIÇO, FIXO acima do teto, sessão vinculada criada cobrada por quem tem a baixa) leva metadata.sessionCharge;
// o PATCH /bookings/:id/confirm do cliente responde 402 enquanto ela estiver PENDING/FAILED. A cobrança só dos
// extras de uma sessão coberta pelo plano não leva a marca (a sessão continua confirmável). As reemissões pelo
// POST /stripe/create-payment (PIX, cartão, reabertura de FAILED) mantêm a marca.

type Who = { id: string; email: string | null; role: string };
const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/bookings', bookingRoutes);
    app.use('/api/stripe', stripeRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
    vi.clearAllMocks();
    const keys = [...await redis.keys('booking:lock:*'), ...await redis.keys('booking:fixo-cap:*')];
    if (keys.length) await redis.del(...keys);
    m(sicoob.getSicoobEnvironment).mockResolvedValue('sandbox');
    m(sicoob.sicoobRemoveCob).mockResolvedValue(true);
    m(sicoob.sicoobCreatePix).mockImplementation(async (p: { amount: number; txid: string; expiresSeconds?: number }) => ({
        id: p.txid,
        pixString: buildStaticBrCode({ key: 'k', amountCents: p.amount, txid: p.txid }),
        status: 'ATIVA',
        expiresAt: new Date(Date.now() + (p.expiresSeconds ?? 3600) * 1000),
    }));
    m(stripe.isStripeEnabled).mockResolvedValue(true);
    m(stripe.stripeCardInstallmentsSupported).mockResolvedValue(false);
    m(stripe.stripeCancelPaymentIntent).mockResolvedValue({ status: 'canceled', canceled: true });
    m(stripe.stripeGetPaymentIntent).mockResolvedValue(undefined);
    m(stripe.stripeCreatePaymentIntent).mockImplementation(async (o: { paymentId: string; amount: number }) => ({
        clientSecret: `cs_${o.paymentId}`, paymentIntentId: `pi_new_${o.paymentId.slice(0, 8)}_${o.amount}`, status: 'requires_payment_method',
    }));
    m(stripe.stripeGetOrCreateCustomer).mockResolvedValue('cus_test');
    for (const [i, key] of ['PIX', 'CARTAO'].entries()) {
        await prisma.paymentMethodConfig.create({
            data: { key, label: key, shortLabel: key, emoji: '-', description: key, color: '#000000', active: true, sortOrder: i },
        });
    }
    await prisma.integrationConfig.create({ data: { provider: 'SICOOB', enabled: true, environment: 'sandbox', config: '{}' } });
    await prisma.integrationConfig.create({ data: { provider: 'STRIPE', enabled: true, environment: 'sandbox', config: '{}' } });
});

afterEach(async () => {
    // O aviso à equipe do /confirm começa DEPOIS da resposta (lê os destinatários e só então chama notifyEvent):
    // espera o conjunto ficar vazio por alguns ciclos seguidos, não só no instante em que o caso termina.
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

const RECEPCAO = ['agendamentos.ver', 'agendamentos.criar', 'agendamentos.editar', 'agendamentos.faltas', 'agendamentos.cancelar', 'hoje.ver', 'hoje.presenca', 'clientes.ver', 'clientes.criar', 'clientes.editar', 'contratos.ver', 'contratos.criar', 'cobrancas.cobrar', 'cupons.ver'];
const SESSION_402 = { error: 'Pagamento obrigatório para confirmar esta sessão.' };

const paymentOf = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
const statusOf = async (bookingId: string) => (await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status;
const newClient = () => mkUser({ cpfCnpj: mkCpf() });

/** FIXO de 1 mês (teto 4) já cheio — a próxima sessão da Recepção é extra, cobrada. */
async function fullFixo(clientId: string) {
    const fixo = await mkContract(clientId, { type: 'FIXO', tier: 'COMERCIAL', durationMonths: 1 });
    for (let i = 0; i < 4; i++) {
        await mkBooking(clientId, fixo.id, { date: dbDate(weekdayN(8 + i)), startTime: '15:30', endTime: '17:30', status: 'CONFIRMED' });
    }
    return fixo;
}

describe('R4a-3 (ATK-03/FIN-05) — /confirm do cliente exige pagar a cobrança da própria sessão', () => {
    it('SERVIÇO pela Recepção: cobrança marcada; /confirm → 402 (PENDING e FAILED), a sessão segue Reservada; paga → 200', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL', discountPct: 10 });
        const c = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: servico.id, date: weekdayN(0), startTime: '10:00' });
        expect(c.status, JSON.stringify(c.body)).toBe(201);
        expect(c.body.booking.status).toBe('RESERVED');
        expect(await paymentOf(c.body.paymentId)).toMatchObject({ status: 'PENDING', bookingId: c.body.booking.id, metadata: { sessionCharge: true } });

        const denied = await call('PATCH', `/api/bookings/${c.body.booking.id}/confirm`, client);
        expect(denied.status, JSON.stringify(denied.body)).toBe(402);
        expect(denied.body).toEqual(SESSION_402);
        expect(await statusOf(c.body.booking.id)).toBe('RESERVED');

        await prisma.payment.update({ where: { id: c.body.paymentId }, data: { status: 'FAILED' } });
        const failed = await call('PATCH', `/api/bookings/${c.body.booking.id}/confirm`, client);
        expect(failed.status, JSON.stringify(failed.body)).toBe(402);
        expect(await statusOf(c.body.booking.id)).toBe('RESERVED');

        await prisma.payment.update({ where: { id: c.body.paymentId }, data: { status: 'PAID', paidAt: new Date() } });
        const ok = await call('PATCH', `/api/bookings/${c.body.booking.id}/confirm`, client);
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(ok.body.booking.status).toBe('CONFIRMED');
    });

    it('FIXO no teto (sessão extra cobrada) → 402; FIXO dentro do teto: com extras em aberto (sem a marca) e sem cobrança → 200', async () => {
        await prisma.addOnConfig.create({ data: { key: 'CORTES_IA', name: 'Cortes', price: 10000 } });
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();

        const full = await fullFixo(client.id);
        const extra = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: full.id, date: weekdayN(0), startTime: '10:00' });
        expect(extra.status, JSON.stringify(extra.body)).toBe(201);
        expect(extra.body.notice).toMatch(/plano fixo já usou todas as sessões/);
        // Conserto 5 (ATU5-02): a sessão criada com o teto cheio leva também a marca da EXTRA (fora do teto).
        expect((await paymentOf(extra.body.paymentId)).metadata).toEqual({ sessionCharge: true, fixoExtra: true });
        const denied = await call('PATCH', `/api/bookings/${extra.body.booking.id}/confirm`, client);
        expect(denied.status, JSON.stringify(denied.body)).toBe(402);
        expect(denied.body).toEqual(SESSION_402);

        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL' }); // teto 12, vazio
        const withExtras = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: fixo.id, date: weekdayN(1), startTime: '10:00', addOns: ['CORTES_IA'] });
        expect(withExtras.status, JSON.stringify(withExtras.body)).toBe(201);
        expect(withExtras.body.coveredByPlan).toBe(true);
        const extrasPay = await paymentOf(withExtras.body.paymentId);
        expect(extrasPay.status).toBe('PENDING');
        expect(extrasPay.metadata).toBeNull();
        const ok = await call('PATCH', `/api/bookings/${withExtras.body.booking.id}/confirm`, client);
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(ok.body.booking.status).toBe('CONFIRMED');

        const plain = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: fixo.id, date: weekdayN(2), startTime: '10:00' });
        expect(plain.status, JSON.stringify(plain.body)).toBe(201);
        expect(plain.body.paymentId).toBeNull();
        expect((await call('PATCH', `/api/bookings/${plain.body.booking.id}/confirm`, client)).status).toBe(200);
    });

    it('ADMIN: "Reservado" num plano (cobra a sessão) → marca e 402; "Confirmado" → PAGA com a marca; avulso da equipe → marca (402 como antes)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const flex = await mkContract(client.id, { type: 'FLEX', tier: 'COMERCIAL', flexCreditsTotal: 12, flexCreditsRemaining: 3 });

        const reserved = await call('POST', '/api/bookings/admin', admin, { userId: client.id, contractId: flex.id, date: weekdayN(0), startTime: '10:00', status: 'RESERVED' });
        expect(reserved.status, JSON.stringify(reserved.body)).toBe(201);
        expect(await paymentOf(reserved.body.paymentId)).toMatchObject({ status: 'PENDING', metadata: { sessionCharge: true } });
        expect((await call('PATCH', `/api/bookings/${reserved.body.booking.id}/confirm`, client)).status).toBe(402);

        const confirmed = await call('POST', '/api/bookings/admin', admin, { userId: client.id, contractId: flex.id, date: weekdayN(1), startTime: '10:00', status: 'CONFIRMED' });
        expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
        expect(await paymentOf(confirmed.body.paymentId)).toMatchObject({ status: 'PAID', metadata: { sessionCharge: true } });

        const avulso = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(2), startTime: '10:00' });
        expect(avulso.status, JSON.stringify(avulso.body)).toBe(201);
        expect((await paymentOf(avulso.body.paymentId)).metadata).toEqual({ sessionCharge: true });
        const denied = await call('PATCH', `/api/bookings/${avulso.body.booking.id}/confirm`, client);
        expect(denied.status).toBe(402);
        expect(denied.body.error).toBe('Pagamento obrigatório para confirmar agendamento avulso.');
    });

    it('a marca sobrevive às reemissões pelo create-payment (PIX, cartão, reabertura de FAILED; cliente e Recepção) e o /confirm segue 402', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        const c = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: servico.id, date: weekdayN(0), startTime: '10:00', paymentMethod: 'PIX' });
        expect(c.status, JSON.stringify(c.body)).toBe(201);
        const pid = c.body.paymentId as string;
        const meta = async () => (await paymentOf(pid)).metadata as Record<string, unknown> | null;

        const pix = await call('POST', '/api/stripe/create-payment', client, { paymentId: pid, paymentMethod: 'pix' });
        expect(pix.status, JSON.stringify(pix.body)).toBe(200);
        expect(sicoob.sicoobCreatePix).toHaveBeenCalledTimes(1);
        expect(await meta()).toMatchObject({ sessionCharge: true });

        const card = await call('POST', '/api/stripe/create-payment', client, { paymentId: pid, paymentMethod: 'cartao', installments: 1 });
        expect(card.status, JSON.stringify(card.body)).toBe(200);
        expect(stripe.stripeCreatePaymentIntent).toHaveBeenCalledTimes(1);
        expect(await meta()).toMatchObject({ sessionCharge: true });

        // A Recepção (cobrancas.cobrar) gera o PIX de novo para o cliente.
        const again = await call('POST', '/api/stripe/create-payment', recepcao, { paymentId: pid, paymentMethod: 'pix' });
        expect(again.status, JSON.stringify(again.body)).toBe(200);
        expect(await meta()).toMatchObject({ sessionCharge: true });

        // Cobrança que falhou e é reaberta pelo próximo "Pagar".
        await prisma.payment.update({ where: { id: pid }, data: { status: 'FAILED' } });
        const reopened = await call('POST', '/api/stripe/create-payment', client, { paymentId: pid, paymentMethod: 'cartao', installments: 1 });
        expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
        expect((await paymentOf(pid)).status).toBe('PENDING');
        expect(await meta()).toMatchObject({ sessionCharge: true });

        // Uma linha só (nenhuma cobrança nova sem a marca) e o /confirm continua exigindo o pagamento.
        expect(await prisma.payment.count({ where: { bookingId: c.body.booking.id } })).toBe(1);
        const denied = await call('PATCH', `/api/bookings/${c.body.booking.id}/confirm`, client);
        expect(denied.status, JSON.stringify(denied.body)).toBe(402);
        expect(denied.body).toEqual(SESSION_402);
    });
});
