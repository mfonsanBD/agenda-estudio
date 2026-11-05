import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// ─── Notificações em segundo plano ───────────────────────────────────────────────────────────────
// Os efeitos do pagamento avisam o cliente/equipe sem await em alguns caminhos: o INSERT em `notifications` não pode
// cruzar com o TRUNCATE do caso seguinte. O mock só embrulha as funções reais para o afterEach aguardar.
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
import { onPaymentConfirmed } from '../../src/lib/paymentEffects';
import { cleanExpiredHolds } from '../../src/jobs/cleanExpiredHolds';
import bookingRoutes from '../../src/modules/bookings/routes';
import { mkUser, mkStaff, mkContract, mkBooking, mkCpf } from './factories';

// FRENTE R4-CONSERTO3 (revisão 3) — ATU-02/FIN-08: a sessão cobrada que a Recepção cria (SERVIÇO, FIXO extra, avulso;
// cobrança da sessão com a marca sessionCharge) só vira Confirmada quando ESSA cobrança é paga:
//  (1) pagar um serviço extra da reserva (onPaymentConfirmed → confirmBookingAndActivateContract) não a confirma;
//  (2) o POST /:id/complete-payment com o PaymentIntent do extra registra o pagamento, mas não a confirma;
//  (3) a varredura dos holds não a promove por uma parcela paga do contrato — só tira o timer;
//  (4) o POST /api/bookings do cliente no horário dela não lhe dá um hold de 10 min (409, nada escrito);
//  (FIN-08) a reserva avulsa do próprio cliente ainda no prazo de pagamento não contrata extra à parte (409).
// A sessão de plano só com extras continua confirmando ao pagá-los.

type Who = { id: string; email: string | null; role: string };
const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

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

const booking = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } });
const paymentOf = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
const newClient = () => mkUser({ cpfCnpj: mkCpf() });
const pay = async (paymentId: string) => {
    await prisma.payment.update({ where: { id: paymentId }, data: { status: 'PAID', paidAt: new Date() } });
    await onPaymentConfirmed(paymentId);
};

async function fullFixo(clientId: string) {
    const fixo = await mkContract(clientId, { type: 'FIXO', tier: 'COMERCIAL', durationMonths: 1 });
    for (let i = 0; i < 4; i++) {
        await mkBooking(clientId, fixo.id, { date: dbDate(weekdayN(8 + i)), startTime: '15:30', endTime: '17:30', status: 'CONFIRMED' });
    }
    return fixo;
}

/** O cliente contrata um extra na própria reserva (POST /:id/addons) → id do Payment do extra (sem a marca). */
async function buyExtra(client: Who, bookingId: string) {
    const r = await call('POST', `/api/bookings/${bookingId}/addons`, client, { addonKeys: ['CORTES_IA'] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.pendingKeys).toEqual(['CORTES_IA']);
    const p = await paymentOf(r.body.paymentId);
    expect(p.metadata).toBeNull();
    return p;
}

describe('ATU-02/FIN-08 (1) — pagar um extra não confirma a sessão com a cobrança dela em aberto', () => {
    it('SERVIÇO, FIXO extra e avulso da Recepção: extra pago → ativo, sessão RESERVED e /confirm 402; pagar a sessão → CONFIRMED', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        const full = await fullFixo(client.id);
        const bodies = [
            { userId: client.id, contractId: servico.id, date: weekdayN(0), startTime: '10:00' },
            { userId: client.id, contractId: full.id, date: weekdayN(1), startTime: '10:00' },
            { userId: client.id, date: weekdayN(2), startTime: '10:00' }, // avulso
        ];
        for (const body of bodies) {
            const c = await call('POST', '/api/bookings/admin', recepcao, body);
            expect(c.status, JSON.stringify(c.body)).toBe(201);
            const id = c.body.booking.id as string;
            expect(await paymentOf(c.body.paymentId)).toMatchObject({ status: 'PENDING', metadata: { sessionCharge: true } });

            const extra = await buyExtra(client, id);
            await pay(extra.id);
            const after = await booking(id);
            expect(after.addOns, JSON.stringify(body)).toContain('CORTES_IA');
            expect(after.status, JSON.stringify(body)).toBe('RESERVED');
            expect((await paymentOf(c.body.paymentId)).status).toBe('PENDING');
            const denied = await call('PATCH', `/api/bookings/${id}/confirm`, client);
            expect(denied.status, JSON.stringify(denied.body)).toBe(402);

            await pay(c.body.paymentId);
            expect((await booking(id)).status, JSON.stringify(body)).toBe('CONFIRMED');
        }
    });

    it('controle: sessão de plano (FIXO dentro do teto) só com extras em aberto — pagar os extras confirma, como antes', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL' });
        const c = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: fixo.id, date: weekdayN(0), startTime: '10:00', addOns: ['CORTES_IA'] });
        expect(c.status, JSON.stringify(c.body)).toBe(201);
        expect(c.body.coveredByPlan).toBe(true);
        expect((await paymentOf(c.body.paymentId)).metadata).toBeNull();
        await pay(c.body.paymentId);
        expect((await booking(c.body.booking.id)).status).toBe('CONFIRMED');

        // O mesmo para o extra comprado depois pelo cliente.
        const plain = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: fixo.id, date: weekdayN(1), startTime: '10:00' });
        expect(plain.status, JSON.stringify(plain.body)).toBe(201);
        const extra = await buyExtra(client, plain.body.booking.id);
        await pay(extra.id);
        expect((await booking(plain.body.booking.id)).status).toBe('CONFIRMED');
    });
});

describe('ATU-02 (2) — POST /:id/complete-payment com o PaymentIntent de um extra', () => {
    it('registra o extra (PAID) mas a sessão segue RESERVED; com o PaymentIntent da cobrança da sessão → CONFIRMED', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        const c = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: servico.id, date: weekdayN(0), startTime: '10:00' });
        expect(c.status, JSON.stringify(c.body)).toBe(201);
        const id = c.body.booking.id as string;
        const extra = await buyExtra(client, id);
        await prisma.payment.update({ where: { id: extra.id }, data: { provider: 'STRIPE', providerRef: 'pi_extra' } });
        m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: 'pi_extra', status: 'succeeded', amount: extra.amount, metadata: { paymentId: extra.id } });

        const r = await call('POST', `/api/bookings/${id}/complete-payment`, client, { paymentIntentId: 'pi_extra' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.booking.status).toBe('RESERVED');
        expect(r.body.message).toMatch(/continua aguardando o pagamento da cobrança dela/);
        expect((await paymentOf(extra.id)).status).toBe('PAID');
        expect((await booking(id)).status).toBe('RESERVED');
        expect((await booking(id)).addOns).toContain('CORTES_IA');
        expect((await paymentOf(c.body.paymentId)).status).toBe('PENDING');

        const session = await paymentOf(c.body.paymentId);
        await prisma.payment.update({ where: { id: session.id }, data: { provider: 'STRIPE', providerRef: 'pi_session' } });
        m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: 'pi_session', status: 'succeeded', amount: session.chargedAmount ?? session.amount, metadata: { paymentId: session.id } });
        const ok = await call('POST', `/api/bookings/${id}/complete-payment`, client, { paymentIntentId: 'pi_session' });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(ok.body.booking.status).toBe('CONFIRMED');
        expect(ok.body.message).toBe('✅ Pagamento confirmado! Seu horário está reservado.');
        expect((await booking(id)).status).toBe('CONFIRMED');
    });
});

describe('ATU-02 (3) — a varredura dos holds não promove a sessão com a cobrança dela em aberto', () => {
    it('SERVIÇO com hold vencido, cobrança da sessão PENDING e parcela do contrato PAGA → só tira o timer (RESERVED); controle: sessão paga → CONFIRMED', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL', accessMode: 'FULL' });
        await prisma.payment.create({ data: { userId: client.id, contractId: servico.id, provider: 'SICOOB', amount: 50000, status: 'PAID', paidAt: new Date() } });

        const open = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: servico.id, date: weekdayN(0), startTime: '10:00' });
        const paid = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: servico.id, date: weekdayN(1), startTime: '10:00' });
        expect(open.status, JSON.stringify(open.body)).toBe(201);
        expect(paid.status, JSON.stringify(paid.body)).toBe(201);
        await prisma.payment.update({ where: { id: paid.body.paymentId }, data: { status: 'PAID', paidAt: new Date() } });
        const expired = new Date(Date.now() - 60_000);
        await prisma.booking.updateMany({ where: { id: { in: [open.body.booking.id, paid.body.booking.id] } }, data: { holdExpiresAt: expired } });

        await cleanExpiredHolds();

        expect(await booking(open.body.booking.id)).toMatchObject({ status: 'RESERVED', holdExpiresAt: null });
        expect((await paymentOf(open.body.paymentId)).status).toBe('PENDING');
        expect(await booking(paid.body.booking.id)).toMatchObject({ status: 'CONFIRMED', holdExpiresAt: null });
    });
});

describe('ATU-02 (4) — POST /api/bookings no horário de uma reserva da equipe não cria hold', () => {
    it('reserva da Recepção (sem prazo) → 409, holdExpiresAt continua null e nenhuma cobrança nova; o hold do avulso do cliente segue retomável', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await newClient();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL' });
        const c = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: servico.id, date: weekdayN(0), startTime: '10:00' });
        expect(c.status, JSON.stringify(c.body)).toBe(201);
        const paymentsBefore = await prisma.payment.count();

        for (const body of [
            { date: weekdayN(0), startTime: '10:00', paymentMethod: 'PIX' },
            { date: weekdayN(0), startTime: '10:00', paymentMethod: 'CARTAO', installments: 1, paymentType: 'CREDIT' },
        ]) {
            const r = await call('POST', '/api/bookings', client, body);
            expect(r.status, JSON.stringify(r.body)).toBe(409);
            expect(r.body.code).toBe('BOOKING_ALREADY_RESERVED');
        }
        expect(await booking(c.body.booking.id)).toMatchObject({ status: 'RESERVED', holdExpiresAt: null });
        expect(await prisma.payment.count()).toBe(paymentsBefore);
        expect(await redis.keys('booking:lock:*')).toEqual([]);

        // Controle: o avulso do PRÓPRIO cliente (com hold) é retomado como antes (PIX → nova tentativa).
        const own = await call('POST', '/api/bookings', client, { date: weekdayN(1), startTime: '10:00', paymentMethod: 'PIX' });
        expect(own.status, JSON.stringify(own.body)).toBe(201);
        expect(own.body.booking.holdExpiresAt).toBeTruthy();
        await redis.del(...await redis.keys('booking:lock:*'));
        const again = await call('POST', '/api/bookings', client, { date: weekdayN(1), startTime: '10:00', paymentMethod: 'PIX' });
        expect(again.status, JSON.stringify(again.body)).toBe(200);
        expect(again.body.booking.id).toBe(own.body.booking.id);
    });
});

describe('FIN-08 — reserva avulsa do cliente ainda no prazo de pagamento não contrata extra à parte', () => {
    it('hold ativo → 409 BOOKING_AWAITING_PAYMENT, nada criado; a mesma reserva paga (CONFIRMED) → 200', async () => {
        const client = await newClient();
        const own = await call('POST', '/api/bookings', client, { date: weekdayN(0), startTime: '13:00', paymentMethod: 'PIX' });
        expect(own.status, JSON.stringify(own.body)).toBe(201);
        const id = own.body.booking.id as string;
        const before = await prisma.payment.count({ where: { bookingId: id } });

        const r = await call('POST', `/api/bookings/${id}/addons`, client, { addonKeys: ['CORTES_IA'] });
        expect(r.status, JSON.stringify(r.body)).toBe(409);
        expect(r.body).toEqual({ error: 'Conclua o pagamento da reserva antes de contratar serviços extras.', code: 'BOOKING_AWAITING_PAYMENT' });
        expect(await prisma.payment.count({ where: { bookingId: id } })).toBe(before);
        expect((await booking(id)).status).toBe('RESERVED');

        await pay(own.body.paymentId);
        expect(await booking(id)).toMatchObject({ status: 'CONFIRMED', holdExpiresAt: null });
        const ok = await call('POST', `/api/bookings/${id}/addons`, client, { addonKeys: ['CORTES_IA'] });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    });
});
