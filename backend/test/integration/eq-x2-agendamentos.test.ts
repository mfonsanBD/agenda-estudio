import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { config } from '../../src/config/index';
import { saoPauloParts } from '../../src/lib/spTime';
import { addDaysYmd } from '../../src/lib/avulsoMakeup';
import { applyDiscount, getBasePriceDynamic } from '../../src/utils/pricing';
import { runFlexCreditExpiryJob } from '../../src/jobs/flexCreditExpiryJob';
import bookingRoutes from '../../src/modules/bookings/routes';
import contractRoutes from '../../src/modules/contracts/routes';
import { mkUser, mkStaff, mkContract, mkBooking, mkPayment } from './factories';

// FRENTE X2 — correções da revisão adversarial em Agendamentos (e na regra pura de contrato):
//  • REG-1  sessão de PLANO criada pela equipe sem cobrancas.baixa não cobra o valor da sessão (só os extras);
//  • DIN-01 FLEX/Personalizado: o POST /bookings/admin consome 1 crédito (o cancelamento devolve) e uma
//           sessão CANCELADA desses planos não é reaberta pelo PATCH (409) — nenhum crédito criado do nada,
//           nenhum desconto em dobro (o cron FLEX concorda com o saldo);
//  • DIN-03 remarcar para OUTRA faixa de preço pelo PATCH exige cobrancas.baixa;
//  • DIN-05 o cliente não confirma sozinho o avulso RESERVED criado pela equipe sem pagar (402);
//  • DIN-06 / MAT-04 / EQ-REQ-04 boleto no POST /bookings/admin exige cobrancas.cobrar;
//  • MAT-03 / DIN-04 reabrir contrato CANCELADO exige contratos.cancelar e contratos.condicoes.

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/bookings', bookingRoutes);
    app.use('/api/contracts', contractRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
    for (const [i, key] of ['PIX', 'CARTAO', 'BOLETO'].entries()) {
        await prisma.paymentMethodConfig.create({
            data: { key, label: key, shortLabel: key, emoji: '-', description: key, color: '#000000', active: true, sortOrder: i },
        });
    }
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
/** n-ésimo dia útil (seg–sex, faixa COMERCIAL às 10:00/13:00/15:30) a partir de hoje + 3 dias. */
function weekdayN(n: number): string {
    let found = -1;
    for (let d = addDaysYmd(todaySp, 3); ; d = addDaysYmd(d, 1)) {
        if (dow(d) >= 1 && dow(d) <= 5 && ++found === n) return d;
    }
}
/** Próximo sábado (faixa SABADO) a pelo menos 3 dias de hoje. */
function nextSaturday(): string {
    let d = addDaysYmd(todaySp, 3);
    while (dow(d) !== 6) d = addDaysYmd(d, 1);
    return d;
}

/** Perfil modelo Recepção (D2): cria, edita, cancela e cobra — sem a baixa manual. */
const RECEPCAO = ['agendamentos.ver', 'agendamentos.criar', 'agendamentos.editar', 'agendamentos.faltas', 'agendamentos.cancelar', 'hoje.ver', 'hoje.presenca', 'clientes.ver', 'clientes.criar', 'clientes.editar', 'contratos.ver', 'contratos.criar', 'cobrancas.cobrar', 'cupons.ver'];

const credits = async (contractId: string) => {
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
    return { flex: c.flexCreditsRemaining, custom: c.customCreditsRemaining };
};

async function seedAddons() {
    await prisma.addOnConfig.create({ data: { key: 'CORTES_IA', name: 'Cortes', price: 10000 } });
    await prisma.addOnConfig.create({ data: { key: 'PAUTAS', name: 'Pautas', price: 5000 } });
    return 15000;
}

// ─── REG-1 ──────────────────────────────────────────────

describe('REG-1 — sessão de plano criada pela equipe sem a baixa não gera cobrança da sessão', () => {
    it('FIXO, "Confirmado" pela Recepção: 201 RESERVED, nenhum Payment, mensagem sem "aguardando pagamento"', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const plan = await mkContract(client.id, { type: 'FIXO', discountPct: 30 });
        const r = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: plan.id, date: weekdayN(0), startTime: '10:00', status: 'CONFIRMED' });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.booking.status).toBe('RESERVED');
        expect(r.body.paymentId).toBeNull();
        expect(r.body.coveredByPlan).toBe(true);
        expect(r.body.downgraded).toBe(true);
        for (const text of [r.body.message, r.body.notice]) {
            expect(text).toMatch(/presença a confirmar/);
            expect(text).not.toMatch(/aguardando pagamento/);
        }
        expect(await prisma.payment.count({ where: { bookingId: r.body.booking.id } })).toBe(0);
        expect(await prisma.payment.count()).toBe(0);

        // Pedindo "Reservado" (o que a tela da Recepção manda): também nenhuma cobrança.
        const r2 = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: plan.id, date: weekdayN(1), startTime: '10:00', status: 'RESERVED' });
        expect(r2.status, JSON.stringify(r2.body)).toBe(201);
        expect(r2.body.paymentId).toBeNull();
        expect(r2.body.downgraded).toBe(false);
        expect(r2.body.message).toMatch(/nenhuma cobrança/);
        expect(await prisma.payment.count()).toBe(0);
    });

    it('com serviços extras: exatamente UMA cobrança PENDING só dos extras (com o desconto do plano)', async () => {
        const addonsTotal = await seedAddons();
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const plan = await mkContract(client.id, { type: 'FIXO', discountPct: 30 });
        const r = await call('POST', '/api/bookings/admin', recepcao, {
            userId: client.id, contractId: plan.id, date: weekdayN(0), startTime: '10:00', status: 'CONFIRMED', addOns: ['CORTES_IA', 'PAUTAS'],
        });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        const expected = applyDiscount(addonsTotal, 30);
        const pays = await prisma.payment.findMany({ where: { bookingId: r.body.booking.id } });
        expect(pays).toHaveLength(1);
        expect(pays[0]).toMatchObject({ status: 'PENDING', amount: expected, contractId: plan.id, paidAt: null });
        expect(r.body.paymentId).toBe(pays[0]!.id);
        expect(r.body.paymentAmount).toBe(expected);
        expect(r.body.message).toMatch(/só os serviços extras ficam aguardando pagamento/);
        // A sessão continua com o preço do plano (+ extras) para relatórios — só a COBRANÇA mudou.
        const sessionPrice = applyDiscount(await getBasePriceDynamic('COMERCIAL'), 30) + expected;
        expect(r.body.booking.price).toBe(sessionPrice);
    });

    it('ADMIN e quem tem cobrancas.baixa: comportamento antigo ("Confirmado" grava a cobrança PAGA da sessão)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const fin = await mkStaff({ permissions: ['agendamentos.criar', 'cobrancas.baixa'] });
        const client = await mkUser();
        const plan = await mkContract(client.id, { type: 'FIXO', discountPct: 30 });
        for (const [i, who] of [admin, fin].entries()) {
            const r = await call('POST', '/api/bookings/admin', who, { userId: client.id, contractId: plan.id, date: weekdayN(i), startTime: '10:00', status: 'CONFIRMED' });
            expect(r.status, JSON.stringify(r.body)).toBe(201);
            expect(r.body.booking.status).toBe('CONFIRMED');
            expect(r.body.coveredByPlan).toBeUndefined();
            const pay = await prisma.payment.findUniqueOrThrow({ where: { id: r.body.paymentId } });
            expect(pay.status).toBe('PAID');
            expect(pay.amount).toBe(applyDiscount(await getBasePriceDynamic('COMERCIAL'), 30));
        }
    });

    it('avulso continua cobrando a sessão (também ao vincular a um contrato AVULSO existente — avulso não é plano)', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const full = await getBasePriceDynamic('COMERCIAL');
        const avulso = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(0), startTime: '10:00' });
        expect(avulso.status, JSON.stringify(avulso.body)).toBe(201);
        expect(avulso.body.message).toMatch(/aguardando pagamento/);
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: avulso.body.paymentId } })).amount).toBe(full);

        const oldAvulso = await mkContract(client.id, { type: 'AVULSO', discountPct: 0, paymentPlan: 'FULL', flexCreditsTotal: 1, flexCreditsRemaining: 0 });
        const linked = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: oldAvulso.id, date: weekdayN(1), startTime: '10:00' });
        expect(linked.status, JSON.stringify(linked.body)).toBe(201);
        expect(linked.body.coveredByPlan).toBeUndefined();
        const pay = await prisma.payment.findUniqueOrThrow({ where: { id: linked.body.paymentId } });
        expect(pay).toMatchObject({ status: 'PENDING', amount: full });
    });
});

// ─── DIN-01 ─────────────────────────────────────────────

describe('DIN-01 — crédito FLEX/Personalizado: criar pela equipe consome, cancelar devolve, nada do nada', () => {
    it('FLEX saldo 5: criar → 4; o cron FLEX concorda (sem desconto em dobro); cancelar → 5; o cron concorda', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        // Piso já gravado (sem o "grandfather" da 1ª passada): o cron reconcilia o saldo canônico na hora.
        const plan = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 5, flexCreditsRemaining: 5, flexForfeitFloor: 0, flexCreditsForfeited: 0 });
        const r = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: plan.id, date: weekdayN(0), startTime: '10:00' });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect((await credits(plan.id)).flex).toBe(4);
        expect(await prisma.payment.count()).toBe(0); // REG-1: plano sem extras → nenhuma cobrança

        // O cron é a fonte canônica (total − sessões vivas − confiscados) e já contava esta sessão:
        // o desconto na criação só antecipa o mesmo número.
        await runFlexCreditExpiryJob(new Date());
        expect((await credits(plan.id)).flex).toBe(4);

        const del = await call('DELETE', `/api/bookings/${r.body.booking.id}`, recepcao);
        expect(del.status, JSON.stringify(del.body)).toBe(200);
        expect((await credits(plan.id)).flex).toBe(5); // devolve o que consumiu — não 6
        await runFlexCreditExpiryJob(new Date());
        expect((await credits(plan.id)).flex).toBe(5);
    });

    it('FLEX com extras: cancelar devolve o crédito e anula a cobrança PENDING dos extras', async () => {
        await seedAddons();
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const plan = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 12, flexCreditsRemaining: 5 });
        const r = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: plan.id, date: weekdayN(0), startTime: '10:00', addOns: ['PAUTAS'] });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect((await credits(plan.id)).flex).toBe(4);
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: r.body.paymentId } })).status).toBe('PENDING');

        // R5: com o extra em aberto, cancelar anula a cobrança → a Recepção (sem a baixa) recebe 403; o ADMIN cancela.
        expect((await call('DELETE', `/api/bookings/${r.body.booking.id}`, recepcao)).status).toBe(403);
        expect((await credits(plan.id)).flex).toBe(4);
        const del = await call('DELETE', `/api/bookings/${r.body.booking.id}`, await mkUser({ role: 'ADMIN' }));
        expect(del.status, JSON.stringify(del.body)).toBe(200);
        expect((await credits(plan.id)).flex).toBe(5);
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: r.body.paymentId } })).status).toBe('CANCELLED');
    });

    it('FLEX sem saldo → 400 NO_CREDITS, nada gravado e o horário continua livre', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const plan = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 12, flexCreditsRemaining: 0 });
        const r = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: plan.id, date: weekdayN(0), startTime: '10:00' });
        expect(r.status, JSON.stringify(r.body)).toBe(400);
        expect(r.body.code).toBe('NO_CREDITS');
        expect(await prisma.booking.count()).toBe(0);
        expect(await prisma.payment.count()).toBe(0);
        expect((await credits(plan.id)).flex).toBe(0);

        // A trava do horário foi solta: o mesmo horário é agendável em seguida.
        const avulso = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(0), startTime: '10:00' });
        expect(avulso.status, JSON.stringify(avulso.body)).toBe(201);
    });

    it('Personalizado com 1 reagendamento livre: criar → 0 (o 2º → 400); cancelar → 1', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const plan = await mkContract(client.id, { type: 'CUSTOM', customCreditsRemaining: 1 });
        const r = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: plan.id, date: weekdayN(0), startTime: '10:00' });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect((await credits(plan.id)).custom).toBe(0);
        const second = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: plan.id, date: weekdayN(0), startTime: '13:00' });
        expect(second.status).toBe(400);
        expect(second.body.code).toBe('NO_CREDITS');

        const del = await call('DELETE', `/api/bookings/${r.body.booking.id}`, recepcao);
        expect(del.status, JSON.stringify(del.body)).toBe(200);
        expect((await credits(plan.id)).custom).toBe(1);
    });

    it('variante: cliente marca (−1), a equipe cancela (+1) e NÃO reabre pelo PATCH (409) — o saldo fica certo', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const plan = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 12, flexCreditsRemaining: 5 });
        const booked = await call('POST', '/api/bookings', client, { contractId: plan.id, date: weekdayN(0), startTime: '10:00', paymentMethod: 'PIX' });
        expect(booked.status, JSON.stringify(booked.body)).toBe(201);
        expect((await credits(plan.id)).flex).toBe(4);

        const del = await call('DELETE', `/api/bookings/${booked.body.booking.id}`, recepcao);
        expect(del.status, JSON.stringify(del.body)).toBe(200);
        expect((await credits(plan.id)).flex).toBe(5);

        // (R2b: no FLEX, Cancelado → Concluído passou a ser permitido, com o saldo reconciliado na hora —
        // coberto em eq-r2-agendamentos.test.ts. Os destinos abaixo continuam recusados.)
        // R4 (ATK-02/FIN-01): sair de Cancelado exige também cobrancas.baixa — a Recepção esbarra antes na permissão
        // (403); a trava DIN-01 (409) vale para quem tem a baixa, inclusive o ADMIN.
        for (const status of ['CONFIRMED', 'RESERVED', 'NAO_REALIZADO']) {
            const p = await call('PATCH', `/api/bookings/${booked.body.booking.id}`, recepcao, { status });
            expect(p.status, `Recepção → ${status}: ${JSON.stringify(p.body)}`).toBe(403);
            expect(p.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa' });
        }
        const baixa = await mkStaff({ permissions: [...RECEPCAO, 'cobrancas.baixa'] });
        for (const [who, status] of [[baixa, 'CONFIRMED'], [baixa, 'RESERVED'], [baixa, 'NAO_REALIZADO'], [admin, 'CONFIRMED']] as const) {
            const p = await call('PATCH', `/api/bookings/${booked.body.booking.id}`, who, { status });
            expect(p.status, `${who.role} → ${status}: ${JSON.stringify(p.body)}`).toBe(409);
            expect(p.body.code).toBe('PLAN_SESSION_CANCELLED');
            expect(p.body.error).toMatch(/Crie um novo agendamento/);
        }
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: booked.body.booking.id } })).status).toBe('CANCELLED');
        expect((await credits(plan.id)).flex).toBe(5);

        // Personalizado: mesma trava (não há cron que corrija o saldo depois).
        const custom = await mkContract(client.id, { type: 'CUSTOM', customCreditsRemaining: 2 });
        const cancelled = await mkBooking(client.id, custom.id, { date: dbDate(weekdayN(1)), startTime: '10:00', endTime: '12:00', status: 'CANCELLED' });
        const p = await call('PATCH', `/api/bookings/${cancelled.id}`, admin, { status: 'CONFIRMED' });
        expect(p.status).toBe(409);
        expect((await credits(custom.id)).custom).toBe(2);
    });

    it('a permissão vem antes da trava: sem agendamentos.editar continua 403 (não 409)', async () => {
        const op = await mkStaff({ permissions: ['hoje.ver', 'hoje.presenca'] });
        const client = await mkUser();
        const plan = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 12, flexCreditsRemaining: 5 });
        const b = await mkBooking(client.id, plan.id, { date: dbDate(weekdayN(0)), startTime: '10:00', endTime: '12:00', status: 'CANCELLED' });
        const r = await call('PATCH', `/api/bookings/${b.id}`, op, { status: 'CONFIRMED' });
        expect(r.status).toBe(403);
        expect(r.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'agendamentos.editar' });
    });

    it('FIXO não tem crédito: criar pela equipe não mexe em saldo e a sessão cancelada continua reabrível (por quem tem a baixa)', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const plan = await mkContract(client.id, { type: 'FIXO', flexCreditsRemaining: 3, customCreditsRemaining: 0 });
        const r = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: plan.id, date: weekdayN(0), startTime: '10:00' });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(await credits(plan.id)).toEqual({ flex: 3, custom: 0 });

        const cancelled = await mkBooking(client.id, plan.id, { date: dbDate(weekdayN(1)), startTime: '10:00', endTime: '12:00', status: 'CANCELLED' });
        // R4 (ATK-02/FIN-01): reabrir uma sessão cancelada exige cobrancas.baixa — a Recepção recebe 403.
        const denied = await call('PATCH', `/api/bookings/${cancelled.id}`, recepcao, { status: 'CONFIRMED' });
        expect(denied.status, JSON.stringify(denied.body)).toBe(403);
        expect(denied.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa' });
        const baixa = await mkStaff({ permissions: [...RECEPCAO, 'cobrancas.baixa'] });
        const reopen = await call('PATCH', `/api/bookings/${cancelled.id}`, baixa, { status: 'CONFIRMED' });
        expect(reopen.status, JSON.stringify(reopen.body)).toBe(200);
        expect(reopen.body.booking.status).toBe('CONFIRMED');
    });
});

// ─── DIN-03 ─────────────────────────────────────────────

describe('DIN-03 — remarcar para outra faixa de preço pelo PATCH exige cobrancas.baixa', () => {
    it('sem a baixa: outra faixa → 403 (preço, faixa e cobrança intactos); mesma faixa → 200; ADMIN muda de faixa', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const day = weekdayN(0);
        const created = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: day, startTime: '10:00' });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const id = created.body.booking.id;
        const before = await prisma.booking.findUniqueOrThrow({ where: { id } });
        const payBefore = await prisma.payment.findUniqueOrThrow({ where: { id: created.body.paymentId } });
        expect(before.tierApplied).toBe('COMERCIAL');

        const sat = nextSaturday();
        // Pelo modal (data + horário), só pela data (mesmo horário num sábado) e para a faixa AUDIÊNCIA.
        for (const body of [{ date: sat, startTime: '10:00' }, { date: sat }, { date: day, startTime: '18:00' }]) {
            const r = await call('PATCH', `/api/bookings/${id}`, recepcao, body);
            expect(r.status, `${JSON.stringify(body)}: ${JSON.stringify(r.body)}`).toBe(403);
            expect(r.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa' });
        }
        const still = await prisma.booking.findUniqueOrThrow({ where: { id } });
        expect({ date: still.date, startTime: still.startTime, tier: still.tierApplied, price: still.price })
            .toEqual({ date: before.date, startTime: before.startTime, tier: before.tierApplied, price: before.price });
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: payBefore.id } })).amount).toBe(payBefore.amount);

        // Mesma faixa (COMERCIAL 10:00 → 13:00, outro dia útil): segue só com agendamentos.editar.
        const same = await call('PATCH', `/api/bookings/${id}`, recepcao, { date: weekdayN(1), startTime: '13:00' });
        expect(same.status, JSON.stringify(same.body)).toBe(200);
        expect(same.body.booking.tierApplied).toBe('COMERCIAL');

        // ADMIN (tem a baixa): troca de faixa como antes.
        const moved = await call('PATCH', `/api/bookings/${id}`, admin, { date: sat, startTime: '10:00' });
        expect(moved.status, JSON.stringify(moved.body)).toBe(200);
        expect(moved.body.booking.tierApplied).toBe('SABADO');
        expect(moved.body.booking.price).toBe(await getBasePriceDynamic('SABADO'));
    });

    it('com cobrancas.baixa (colaborador) a troca de faixa passa', async () => {
        const fin = await mkStaff({ permissions: ['agendamentos.ver', 'agendamentos.editar', 'cobrancas.baixa'] });
        const client = await mkUser();
        const plan = await mkContract(client.id, { type: 'FIXO' });
        const b = await mkBooking(client.id, plan.id, { date: dbDate(weekdayN(0)), startTime: '10:00', endTime: '12:00', status: 'CONFIRMED', tierApplied: 'COMERCIAL' });
        const r = await call('PATCH', `/api/bookings/${b.id}`, fin, { date: nextSaturday(), startTime: '10:00' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.booking.tierApplied).toBe('SABADO');
    });
});

// ─── DIN-05 ─────────────────────────────────────────────

describe('DIN-05 — PATCH /bookings/:id/confirm do cliente exige pagamento no avulso criado pela equipe', () => {
    it('avulso RESERVED da equipe: 402 sem pagamento (continua RESERVED); com o pagamento PAID → 200', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const created = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(0), startTime: '10:00' });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const id = created.body.booking.id;

        const denied = await call('PATCH', `/api/bookings/${id}/confirm`, client);
        expect(denied.status, JSON.stringify(denied.body)).toBe(402);
        expect((await prisma.booking.findUniqueOrThrow({ where: { id } })).status).toBe('RESERVED');

        await prisma.payment.update({ where: { id: created.body.paymentId }, data: { status: 'PAID', paidAt: new Date() } });
        const ok = await call('PATCH', `/api/bookings/${id}/confirm`, client);
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(ok.body.booking.status).toBe('CONFIRMED');
    });

    it('sessão de plano RESERVED (mesmo com extras em aberto) continua confirmável pelo cliente', async () => {
        const client = await mkUser();
        const plan = await mkContract(client.id, { type: 'FIXO' });
        const b = await mkBooking(client.id, plan.id, { date: dbDate(weekdayN(0)), startTime: '10:00', endTime: '12:00', status: 'RESERVED' });
        await mkPayment(client.id, { contractId: plan.id, bookingId: b.id, status: 'PENDING', amount: 5000 });
        const r = await call('PATCH', `/api/bookings/${b.id}/confirm`, client);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.booking.status).toBe('CONFIRMED');
    });
});

// ─── DIN-06 / MAT-04 / EQ-REQ-04 ────────────────────────

describe('DIN-06 / MAT-04 / EQ-REQ-04 — boleto no POST /bookings/admin exige cobrancas.cobrar', () => {
    it('sem cobrancas.cobrar → 403 antes de tudo (nem o estado do boleto vaza) e nada é gravado', async () => {
        const colab = await mkStaff({ permissions: ['agendamentos.ver', 'agendamentos.criar'] });
        const client = await mkUser();
        const r = await call('POST', '/api/bookings/admin', colab, { userId: client.id, date: weekdayN(0), startTime: '10:00', status: 'RESERVED', paymentMethod: 'BOLETO' });
        expect(r.status, JSON.stringify(r.body)).toBe(403);
        expect(r.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'cobrancas.cobrar' });
        expect(await prisma.booking.count()).toBe(0);
        expect(await prisma.payment.count()).toBe(0);
        expect(await prisma.contract.count()).toBe(0);

        // PIX e cartão continuam só com agendamentos.criar (a cobrança PENDING; o checkout é que cobra).
        const pix = await call('POST', '/api/bookings/admin', colab, { userId: client.id, date: weekdayN(0), startTime: '10:00', status: 'RESERVED', paymentMethod: 'PIX' });
        expect(pix.status, JSON.stringify(pix.body)).toBe(201);
    });

    it('com cobrancas.cobrar passa da permissão e segue a regra do boleto (aqui desligado → 400 BOLETO_UNAVAILABLE)', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const r = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(0), startTime: '10:00', status: 'RESERVED', paymentMethod: 'BOLETO' });
        expect(r.status, JSON.stringify(r.body)).toBe(400);
        expect(r.body.code).toBe('BOLETO_UNAVAILABLE');
        expect(await prisma.booking.count()).toBe(0);
    });
});

// ─── MAT-03 / DIN-04 ────────────────────────────────────

describe('MAT-03 / DIN-04 — reabrir contrato CANCELADO exige contratos.cancelar e contratos.condicoes', () => {
    it('só editar → 403 cancelar; editar+cancelar → 403 condições; as três → 200; nada muda nos 403', async () => {
        const owner = await mkUser();
        const c = await mkContract(owner.id, { type: 'FLEX', status: 'CANCELLED', flexCreditsTotal: 12, flexCreditsRemaining: 7 });

        const steps: Array<[string[], number, string | null]> = [
            [['contratos.ver', 'contratos.editar'], 403, 'contratos.cancelar'],
            [['contratos.ver', 'contratos.editar', 'contratos.cancelar'], 403, 'contratos.condicoes'],
            [['contratos.ver', 'contratos.editar', 'contratos.condicoes'], 403, 'contratos.cancelar'],
        ];
        for (const [perms, status, permission] of steps) {
            const colab = await mkStaff({ permissions: perms });
            for (const target of ['ACTIVE', 'COMPLETED', 'EXPIRED']) {
                const r = await call('PATCH', `/api/contracts/${c.id}`, colab, { status: target });
                expect(r.status, `${perms.join(',')} → ${target}: ${JSON.stringify(r.body)}`).toBe(status);
                expect(r.body.permission).toBe(permission);
            }
            expect((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('CANCELLED');
        }

        const full = await mkStaff({ permissions: ['contratos.ver', 'contratos.editar', 'contratos.cancelar', 'contratos.condicoes'] });
        const ok = await call('PATCH', `/api/contracts/${c.id}`, full, { status: 'ACTIVE' });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('ACTIVE');
    });

    it('ADMIN reabre como antes; o link de um contrato cancelado segue só com contratos.editar', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const owner = await mkUser();
        const c = await mkContract(owner.id, { status: 'CANCELLED' });
        const editor = await mkStaff({ permissions: ['contratos.ver', 'contratos.editar'] });
        const link = await call('PATCH', `/api/contracts/${c.id}`, editor, { contractUrl: 'https://exemplo.com/c.pdf' });
        expect(link.status, JSON.stringify(link.body)).toBe(200);
        const r = await call('PATCH', `/api/contracts/${c.id}`, admin, { status: 'ACTIVE' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('ACTIVE');
    });
});
