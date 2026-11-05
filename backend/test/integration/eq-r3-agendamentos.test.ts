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
import { applyDiscount, getBasePriceDynamic } from '../../src/utils/pricing';
import bookingRoutes from '../../src/modules/bookings/routes';
import { mkUser, mkStaff, mkContract, mkBooking, mkPayment } from './factories';

// FRENTE R3b — agendamentos:
//  1) POST /bookings/admin: a sessão de plano coberta (FIXO/FLEX/Personalizado, criada sem cobrancas.baixa) só
//     vale na faixa que o plano paga — horário de faixa acima (canAccessTier false) → 403 TIER_NOT_ALLOWED antes
//     de crédito, trava ou escrita. ADMIN e quem tem a baixa seguem como hoje (sessão cobrada pela faixa do
//     horário); o que já é cobrado (SERVIÇO, avulso, FIXO com o teto usado) não muda.
//  2) Autoatendimento do cliente (POST /api/bookings): contrato de SERVIÇO → 400 "Contrato de serviço não inclui
//     gravação."; Personalizado sem crédito → 400 "Créditos esgotados neste plano."; o desconto do crédito é
//     guardado (concorrência no último crédito nunca gera sessão sem desconto). O lote (só FLEX) e o
//     reagendamento (move a mesma sessão, sem crédito) já seguiam o critério — testes de regressão.

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

// O POST / do cliente mantém a trava do horário por 10 min depois do 201 (é o hold): limpa entre os casos.
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
/** n-ésimo dia útil (seg–sex) a partir de hoje + 3 dias. */
function weekdayN(n: number): string {
    let found = -1;
    for (let d = addDaysYmd(todaySp, 3); ; d = addDaysYmd(d, 1)) {
        if (dow(d) >= 1 && dow(d) <= 5 && ++found === n) return d;
    }
}
/** n-ésimo sábado (faixa SABADO) a partir de hoje + 3 dias. */
function saturdayN(n: number): string {
    let found = -1;
    for (let d = addDaysYmd(todaySp, 3); ; d = addDaysYmd(d, 1)) {
        if (dow(d) === 6 && ++found === n) return d;
    }
}
/** Horários por faixa (config padrão: comercial 10:00/13:00/15:30, audiência 18:00/20:30, sábado = SABADO). */
const comercial = (i: number) => ({ date: weekdayN(Math.floor(i / 3)), startTime: ['10:00', '13:00', '15:30'][i % 3]! });
const audiencia = (i: number) => ({ date: weekdayN(Math.floor(i / 2)), startTime: ['18:00', '20:30'][i % 2]! });
const sabado = (i: number) => ({ date: saturdayN(Math.floor(i / 3)), startTime: ['10:00', '13:00', '15:30'][i % 3]! });

/** Perfil modelo Recepção (D2): cria, edita, cancela e cobra — sem a baixa manual. */
const RECEPCAO = ['agendamentos.ver', 'agendamentos.criar', 'agendamentos.editar', 'agendamentos.faltas', 'agendamentos.cancelar', 'hoje.ver', 'hoje.presenca', 'clientes.ver', 'clientes.criar', 'clientes.editar', 'contratos.ver', 'contratos.criar', 'cobrancas.cobrar', 'cupons.ver'];

const PLAN_TYPES = ['FIXO', 'FLEX', 'CUSTOM'] as const;

/** Plano de teste: FLEX e Personalizado com 3 créditos; FIXO de 3 meses (teto 12). */
function planFor(clientId: string, type: string, tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO', extra: Record<string, unknown> = {}) {
    return mkContract(clientId, {
        type: type as any, tier, discountPct: 20,
        flexCreditsTotal: type === 'FLEX' ? 12 : null,
        flexCreditsRemaining: type === 'FLEX' ? 3 : 0,
        customCreditsRemaining: type === 'CUSTOM' ? 3 : 0,
        ...extra,
    });
}

const credits = async (contractId: string) => {
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
    return { flex: c.flexCreditsRemaining, custom: c.customCreditsRemaining };
};

/** Nada foi gravado para o cliente: nem gravação, nem cobrança, nem micro-contrato avulso; nenhuma trava ficou. */
async function expectNothingWritten(clientId: string, contracts = 1) {
    expect(await prisma.booking.count({ where: { userId: clientId } })).toBe(0);
    expect(await prisma.payment.count({ where: { userId: clientId } })).toBe(0);
    expect(await prisma.contract.count({ where: { userId: clientId } })).toBe(contracts);
    expect(await redis.keys('booking:lock:*')).toEqual([]);
    expect(await redis.keys('booking:fixo-cap:*')).toEqual([]);
}

// ─── 1) POST /bookings/admin — faixa do plano ───────────

describe('R3b-1 — POST /bookings/admin: sessão de plano sem a baixa só na faixa que o plano cobre', () => {
    it('Recepção + FIXO/FLEX/Personalizado em horário de faixa acima → 403 TIER_NOT_ALLOWED, nada gravado, crédito intacto', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const cases: Array<{ tier: 'COMERCIAL' | 'AUDIENCIA'; slot: { date: string; startTime: string }; msg: string }> = [
            { tier: 'COMERCIAL', slot: audiencia(0), msg: 'O plano Comercial não permite agendar horários Audiência.' },
            { tier: 'COMERCIAL', slot: sabado(0), msg: 'O plano Comercial não permite agendar horários Sábado.' },
            { tier: 'AUDIENCIA', slot: sabado(1), msg: 'O plano Audiência não permite agendar horários Sábado.' },
        ];
        for (const type of PLAN_TYPES) {
            for (const c of cases) {
                for (const status of ['RESERVED', 'CONFIRMED'] as const) {
                    const client = await mkUser();
                    const plan = await planFor(client.id, type, c.tier);
                    const before = await credits(plan.id);
                    const r = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: plan.id, ...c.slot, status });
                    const label = `${type} ${c.tier} → ${c.slot.date} ${c.slot.startTime} (${status})`;
                    expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBe(403);
                    expect(r.body, label).toEqual({ code: 'TIER_NOT_ALLOWED', error: c.msg });
                    expect(await credits(plan.id), label).toEqual(before);
                    await expectNothingWritten(client.id);
                }
            }
        }
    });

    it('vale também para o plano CONCLUÍDO (a sessão o reabriria) e vem antes do crédito (FLEX sem crédito → TIER_NOT_ALLOWED, não NO_CREDITS)', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const done = await planFor(client.id, 'FLEX', 'COMERCIAL', { status: 'COMPLETED' });
        const r = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: done.id, ...audiencia(0), status: 'RESERVED' });
        expect(r.status, JSON.stringify(r.body)).toBe(403);
        expect(r.body.code).toBe('TIER_NOT_ALLOWED');
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: done.id } })).status).toBe('COMPLETED');

        const empty = await planFor(client.id, 'FLEX', 'COMERCIAL', { flexCreditsRemaining: 0 });
        const r2 = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: empty.id, ...audiencia(0), status: 'RESERVED' });
        expect(r2.status, JSON.stringify(r2.body)).toBe(403);
        expect(r2.body.code).toBe('TIER_NOT_ALLOWED');
        // Controle: na faixa do plano, o mesmo FLEX sem crédito continua NO_CREDITS (400).
        const r3 = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: empty.id, ...comercial(0), status: 'RESERVED' });
        expect(r3.status, JSON.stringify(r3.body)).toBe(400);
        expect(r3.body.code).toBe('NO_CREDITS');
        await expectNothingWritten(client.id, 2);
    });

    it('Recepção na faixa do plano ou abaixo dela: segue coberta pelo plano, como hoje', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const combos: Array<{ type: string; tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO'; slot: { date: string; startTime: string } }> = [
            { type: 'FIXO', tier: 'COMERCIAL', slot: comercial(0) },
            { type: 'FLEX', tier: 'AUDIENCIA', slot: comercial(1) },
            { type: 'FLEX', tier: 'AUDIENCIA', slot: audiencia(0) },
            { type: 'CUSTOM', tier: 'SABADO', slot: audiencia(1) },
            { type: 'CUSTOM', tier: 'SABADO', slot: sabado(0) },
        ];
        for (const c of combos) {
            const plan = await planFor(client.id, c.type, c.tier);
            const label = `${c.type} ${c.tier} → ${c.slot.date} ${c.slot.startTime}`;
            const r = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: plan.id, ...c.slot, status: 'RESERVED' });
            expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBe(201);
            expect(r.body.coveredByPlan, label).toBe(true);
            expect(r.body.paymentId, label).toBeNull();
            expect(r.body.booking.status, label).toBe('RESERVED');
            const left = await credits(plan.id);
            if (c.type === 'FLEX') expect(left.flex, label).toBe(2);
            if (c.type === 'CUSTOM') expect(left.custom, label).toBe(2);
        }
        expect(await prisma.payment.count({ where: { userId: client.id } })).toBe(0);
    });

    it('ADMIN e colaborador com a baixa: faixa acima segue como hoje (sessão cobrada pela faixa do horário, crédito descontado)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const baixa = await mkStaff({ permissions: ['agendamentos.ver', 'agendamentos.criar', 'cobrancas.baixa'] });
        const client = await mkUser();

        const flex = await planFor(client.id, 'FLEX', 'COMERCIAL');
        const a = await call('POST', '/api/bookings/admin', admin, { userId: client.id, contractId: flex.id, ...audiencia(0), status: 'CONFIRMED' });
        expect(a.status, JSON.stringify(a.body)).toBe(201);
        expect(a.body.booking.status).toBe('CONFIRMED');
        expect(a.body.coveredByPlan).toBeUndefined();
        expect(a.body.booking.tier).toBe('AUDIENCIA');
        const audPrice = applyDiscount(await getBasePriceDynamic('AUDIENCIA'), 20);
        expect(await prisma.payment.findUniqueOrThrow({ where: { id: a.body.paymentId } })).toMatchObject({ status: 'PAID', amount: audPrice });
        expect((await credits(flex.id)).flex).toBe(2);

        const custom = await planFor(client.id, 'CUSTOM', 'COMERCIAL');
        const b = await call('POST', '/api/bookings/admin', baixa, { userId: client.id, contractId: custom.id, ...sabado(0), status: 'RESERVED' });
        expect(b.status, JSON.stringify(b.body)).toBe(201);
        expect(b.body.booking.status).toBe('RESERVED');
        expect(b.body.coveredByPlan).toBeUndefined();
        const satPrice = applyDiscount(await getBasePriceDynamic('SABADO'), 20);
        expect(await prisma.payment.findUniqueOrThrow({ where: { id: b.body.paymentId } })).toMatchObject({ status: 'PENDING', amount: satPrice });
        expect((await credits(custom.id)).custom).toBe(2);

        const fixo = await planFor(client.id, 'FIXO', 'COMERCIAL');
        const c = await call('POST', '/api/bookings/admin', baixa, { userId: client.id, contractId: fixo.id, ...audiencia(1), status: 'CONFIRMED' });
        expect(c.status, JSON.stringify(c.body)).toBe(201);
        expect(c.body.booking.status).toBe('CONFIRMED');
        expect(await prisma.payment.findUniqueOrThrow({ where: { id: c.body.paymentId } })).toMatchObject({ status: 'PAID', amount: audPrice });
    });

    it('Recepção: o que já é cobrado pela faixa do horário não muda (SERVIÇO, avulso e FIXO com o teto usado)', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const aud = await getBasePriceDynamic('AUDIENCIA');

        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL', discountPct: 10 });
        const s = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: servico.id, ...audiencia(0), status: 'RESERVED' });
        expect(s.status, JSON.stringify(s.body)).toBe(201);
        expect(s.body.notice).toMatch(/contrato de serviço não inclui gravação/);
        expect(await prisma.payment.findUniqueOrThrow({ where: { id: s.body.paymentId } })).toMatchObject({ status: 'PENDING', amount: applyDiscount(aud, 10) });

        const avulso = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, ...audiencia(1), status: 'RESERVED' });
        expect(avulso.status, JSON.stringify(avulso.body)).toBe(201);
        expect(await prisma.payment.findUniqueOrThrow({ where: { id: avulso.body.paymentId } })).toMatchObject({ status: 'PENDING', amount: aud });

        // FIXO de 1 mês (teto 4) já cheio: a sessão a mais é extra cobrada — não é "sessão de plano".
        const fixo = await planFor(client.id, 'FIXO', 'COMERCIAL', { durationMonths: 1 });
        for (let i = 0; i < 4; i++) {
            await mkBooking(client.id, fixo.id, { date: dbDate(`2026-09-${String(14 + i).padStart(2, '0')}`), startTime: '10:00', endTime: '12:00', status: 'COMPLETED' });
        }
        const f = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: fixo.id, ...audiencia(2), status: 'RESERVED' });
        expect(f.status, JSON.stringify(f.body)).toBe(201);
        expect(f.body.coveredByPlan).toBeUndefined();
        expect(f.body.notice).toMatch(/plano fixo já usou todas as sessões/);
        expect(await prisma.payment.findUniqueOrThrow({ where: { id: f.body.paymentId } })).toMatchObject({ status: 'PENDING', amount: applyDiscount(aud, 20) });
    });
});

// ─── 2) Autoatendimento do cliente ──────────────────────

describe('R3b-2 — POST /api/bookings do cliente: SERVIÇO e Personalizado sem crédito não geram gravação', () => {
    it('contrato de SERVIÇO próprio e ativo → 400 "Contrato de serviço não inclui gravação.", nada gravado', async () => {
        const client = await mkUser();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'SABADO', flexCreditsRemaining: 5, customCreditsRemaining: 5 });
        for (const body of [
            { contractId: servico.id, ...comercial(0) },
            { contractId: servico.id, ...comercial(1), addOns: ['PAUTAS'], paymentMethod: 'PIX' },
            { contractId: servico.id, ...audiencia(0) },
        ]) {
            const r = await call('POST', '/api/bookings', client, body);
            expect(r.status, JSON.stringify(r.body)).toBe(400);
            expect(r.body).toEqual({ error: 'Contrato de serviço não inclui gravação.' });
        }
        expect(await credits(servico.id)).toEqual({ flex: 5, custom: 5 });
        await expectNothingWritten(client.id);
    });

    it('Personalizado sem crédito → 400 "Créditos esgotados neste plano.", nada gravado', async () => {
        const client = await mkUser();
        const custom = await mkContract(client.id, { type: 'CUSTOM', customCreditsRemaining: 0 });
        const r = await call('POST', '/api/bookings', client, { contractId: custom.id, ...comercial(0) });
        expect(r.status, JSON.stringify(r.body)).toBe(400);
        expect(r.body).toEqual({ error: 'Créditos esgotados neste plano.' });
        expect((await credits(custom.id)).custom).toBe(0);
        await expectNothingWritten(client.id);
    });

    it('Personalizado com crédito: caminho feliz igual (Reservado, −1 crédito, sem cobrança); sem crédito, o próximo é recusado', async () => {
        const client = await mkUser();
        const custom = await mkContract(client.id, { type: 'CUSTOM', customCreditsRemaining: 1 });
        const ok = await call('POST', '/api/bookings', client, { contractId: custom.id, ...comercial(0) });
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        expect(ok.body.booking).toMatchObject({ status: 'RESERVED', contractId: custom.id, holdExpiresAt: null });
        expect(ok.body.paymentId).toBeNull();
        expect(ok.body.message).toBe('Horário reservado com sucesso!');
        expect((await credits(custom.id)).custom).toBe(0);

        const no = await call('POST', '/api/bookings', client, { contractId: custom.id, ...comercial(1) });
        expect(no.status, JSON.stringify(no.body)).toBe(400);
        expect(no.body.error).toBe('Créditos esgotados neste plano.');
        expect(await prisma.booking.count({ where: { userId: client.id } })).toBe(1);
        expect(await prisma.payment.count({ where: { userId: client.id } })).toBe(0);
    });

    it('FLEX com crédito: caminho feliz igual (Reservado, −1 crédito, sem cobrança)', async () => {
        const client = await mkUser();
        const flex = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 12, flexCreditsRemaining: 2 });
        const ok = await call('POST', '/api/bookings', client, { contractId: flex.id, ...comercial(0) });
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        expect(ok.body.booking).toMatchObject({ status: 'RESERVED', contractId: flex.id, holdExpiresAt: null });
        expect(ok.body.paymentId).toBeNull();
        expect((await credits(flex.id)).flex).toBe(1);
    });

    // Corrida DETERMINÍSTICA no último crédito: a reserva passa pela checagem de crédito (saldo 1) e fica parada no
    // hasBlockedConflict (o teste tranca a tabela blocked_slots); enquanto isso "outra reserva" zera o crédito.
    // Antes, a releitura do contrato via saldo 0 e PULAVA o desconto → gravação sem consumir crédito.
    async function waitForLockWaiter() {
        for (let i = 0; i < 200; i++) {
            const [row] = await prisma.$queryRawUnsafe<{ n: number }[]>(
                `SELECT count(*)::int AS n FROM pg_stat_activity
                  WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%blocked_slots%'`,
            );
            if ((row?.n ?? 0) > 0) return;
            await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error('a reserva não chegou a esperar pela trava de blocked_slots');
    }

    for (const type of ['CUSTOM', 'FLEX'] as const) {
        it(`${type}: crédito zerado entre a checagem e o desconto → 400 (concorrência), nenhuma gravação sem desconto`, async () => {
            const client = await mkUser();
            const plan = await mkContract(client.id, type === 'FLEX'
                ? { type: 'FLEX', flexCreditsTotal: 12, flexCreditsRemaining: 1 }
                : { type: 'CUSTOM', customCreditsRemaining: 1 });
            let pending!: Promise<{ status: number; body: any }>;
            await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe('LOCK TABLE "blocked_slots" IN ACCESS EXCLUSIVE MODE');
                pending = call('POST', '/api/bookings', client, { contractId: plan.id, ...comercial(0) });
                await waitForLockWaiter();
                await tx.contract.update({
                    where: { id: plan.id },
                    data: type === 'FLEX' ? { flexCreditsRemaining: 0 } : { customCreditsRemaining: 0 },
                });
            }, { timeout: 15000, maxWait: 5000 });
            const r = await pending;
            expect(r.status, JSON.stringify(r.body)).toBe(400);
            expect(r.body.error).toBe('Créditos esgotados (concorrência). Tente novamente.');
            expect(await prisma.booking.count({ where: { contractId: plan.id } })).toBe(0);
            const left = await credits(plan.id);
            expect(type === 'FLEX' ? left.flex : left.custom).toBe(0);
            await expectNothingWritten(client.id);
        });
    }

    it('lote (POST /bulk): só FLEX — SERVIÇO e Personalizado → 400, nada gravado, crédito intacto', async () => {
        const client = await mkUser();
        const servico = await mkContract(client.id, { type: 'SERVICO', flexCreditsRemaining: 5 });
        const custom = await mkContract(client.id, { type: 'CUSTOM', customCreditsRemaining: 0, flexCreditsRemaining: 5 });
        for (const c of [servico, custom]) {
            const r = await call('POST', '/api/bookings/bulk', client, { contractId: c.id, slots: [comercial(0), comercial(1)] });
            expect(r.status, JSON.stringify(r.body)).toBe(400);
            expect(r.body.error).toBe('Apenas contratos Flex suportam marcação em lote.');
            expect((await credits(c.id)).flex).toBe(5);
        }
        await expectNothingWritten(client.id, 2);
    });

    it('reagendamento do cliente move a MESMA sessão (sem crédito nem cobrança nova): SERVIÇO e Personalizado sem crédito remarcam como antes', async () => {
        const client = await mkUser();
        const custom = await mkContract(client.id, { type: 'CUSTOM', customCreditsRemaining: 0 });
        const servico = await mkContract(client.id, { type: 'SERVICO' });
        const bCustom = await mkBooking(client.id, custom.id, { date: dbDate(weekdayN(0)), startTime: '10:00', endTime: '12:00', status: 'CONFIRMED' });
        const bServico = await mkBooking(client.id, servico.id, { date: dbDate(weekdayN(0)), startTime: '13:00', endTime: '15:00', status: 'RESERVED' });
        await mkPayment(client.id, { contractId: servico.id, bookingId: bServico.id, amount: 27000, status: 'PENDING' });

        const r1 = await call('PATCH', `/api/bookings/${bCustom.id}/reschedule`, client, { date: weekdayN(1), startTime: '10:00' });
        expect(r1.status, JSON.stringify(r1.body)).toBe(200);
        const r2 = await call('PATCH', `/api/bookings/${bServico.id}/reschedule`, client, { date: weekdayN(1), startTime: '13:00' });
        expect(r2.status, JSON.stringify(r2.body)).toBe(200);

        expect(await prisma.booking.count({ where: { userId: client.id } })).toBe(2);
        expect(await prisma.payment.count({ where: { userId: client.id } })).toBe(1);
        expect((await credits(custom.id)).custom).toBe(0);
        const moved = await prisma.booking.findUniqueOrThrow({ where: { id: bCustom.id } });
        expect(moved.date.toISOString().slice(0, 10)).toBe(weekdayN(1));
    });
});
