import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { config } from '../../src/config/index';
import { saoPauloParts } from '../../src/lib/spTime';
import { addDaysYmd } from '../../src/lib/avulsoMakeup';
import { getConfig } from '../../src/lib/businessConfig';
import { applyDiscount, getBasePriceDynamic } from '../../src/utils/pricing';
import { runFlexCreditExpiryJob } from '../../src/jobs/flexCreditExpiryJob';
import bookingRoutes from '../../src/modules/bookings/routes';
import { mkUser, mkStaff, mkContract, mkBooking } from './factories';

// FRENTE R2b — agendamentos (pendências da revisão da X2):
//  • REG-1 (escopo): "sessão de plano coberta" no POST /bookings/admin só para FIXO/FLEX/Personalizado ATIVO ou
//    CONCLUÍDO (e, no FIXO, dentro do teto meses × sessões/mês). Contrato de SERVIÇO, avulso e FIXO com o teto
//    usado → a sessão é cobrada como antes. Contrato fora de ACTIVE/COMPLETED → 400 CONTRACT_NOT_ACTIVE para
//    todos. Nenhum caminho cria gravação sem cobrança fora de plano.
//  • DIN-01 (trava ampla): a trava total de saída de CANCELLED fica só no Personalizado. No FLEX, Cancelado →
//    Concluído é permitido (saldo reconciliado na hora com a conta do cron); Cancelado → Reservado/Confirmado/
//    Não realizado segue 409.

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
/** n-ésimo dia útil (seg–sex, faixa COMERCIAL) a partir de hoje + 3 dias. */
function weekdayN(n: number): string {
    let found = -1;
    for (let d = addDaysYmd(todaySp, 3); ; d = addDaysYmd(d, 1)) {
        if (dow(d) >= 1 && dow(d) <= 5 && ++found === n) return d;
    }
}
/** i-ésimo horário livre COMERCIAL (10:00, 13:00 e 15:30 de cada dia útil). */
const COMERCIAL_TIMES = ['10:00', '13:00', '15:30'];
const slotN = (i: number) => ({ date: weekdayN(Math.floor(i / COMERCIAL_TIMES.length)), startTime: COMERCIAL_TIMES[i % COMERCIAL_TIMES.length]! });

/** Perfil modelo Recepção (D2): cria, edita, cancela e cobra — sem a baixa manual. */
const RECEPCAO = ['agendamentos.ver', 'agendamentos.criar', 'agendamentos.editar', 'agendamentos.faltas', 'agendamentos.cancelar', 'hoje.ver', 'hoje.presenca', 'clientes.ver', 'clientes.criar', 'clientes.editar', 'contratos.ver', 'contratos.criar', 'cobrancas.cobrar', 'cupons.ver'];

const PLAN_TYPES = ['FIXO', 'FLEX', 'CUSTOM'] as const;
const ALL_TYPES = ['FIXO', 'FLEX', 'CUSTOM', 'SERVICO', 'AVULSO'] as const;
const NOT_LINKABLE = ['CANCELLED', 'EXPIRED', 'PENDING_CANCELLATION', 'PAUSED', 'AWAITING_PAYMENT'] as const;

const flexLeft = async (contractId: string) => (await prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).flexCreditsRemaining;

/** Contrato de teste com crédito para FLEX (3) e Personalizado (3); FIXO de 3 meses (teto 12). */
function contractFor(clientId: string, type: string, status: string, discountPct = 20) {
    return mkContract(clientId, {
        type: type as any, status: status as any, discountPct,
        flexCreditsTotal: type === 'FLEX' ? 12 : (type === 'AVULSO' ? 1 : null),
        flexCreditsRemaining: type === 'FLEX' ? 3 : 0,
        customCreditsRemaining: type === 'CUSTOM' ? 3 : 0,
        ...(type === 'AVULSO' ? { paymentPlan: 'FULL', durationMonths: 1 } : {}),
    });
}

// ─── REG-1 — escopo da "sessão de plano" ────────────────

describe('REG-1 (escopo) — POST /bookings/admin só deixa sem cobrança a sessão que um plano vivo cobre', () => {
    it('Recepção + contrato SERVIÇO: nunca 201 sem cobrança — a sessão é cobrada como antes (PENDING com o desconto do contrato)', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const servico = await mkContract(client.id, { type: 'SERVICO', discountPct: 10, flexCreditsTotal: 0, flexCreditsRemaining: 0 });
        const session = applyDiscount(await getBasePriceDynamic('COMERCIAL'), 10);

        // "Confirmado" (o padrão do schema): rebaixado para Reservado, com a cobrança da sessão.
        const r = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: servico.id, ...slotN(0), status: 'CONFIRMED' });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.booking.status).toBe('RESERVED');
        expect(r.body.coveredByPlan).toBeUndefined();
        expect(r.body.downgraded).toBe(true);
        expect(r.body.paymentId).toBeTruthy();
        const pay = await prisma.payment.findUniqueOrThrow({ where: { id: r.body.paymentId } });
        expect(pay).toMatchObject({ status: 'PENDING', amount: session, bookingId: r.body.booking.id, contractId: servico.id, paidAt: null });
        // O modal da equipe mostra `notice`: diz que a sessão é cobrada (nada de "coberta pelo plano").
        for (const text of [r.body.notice, r.body.message]) {
            expect(text).toMatch(/contrato de serviço não inclui gravação/);
            expect(text).toMatch(/aguardando pagamento/);
            expect(text).not.toMatch(/coberta pelo plano/);
        }

        // "Reservado" com extras: UMA cobrança, sessão + extras (com o desconto do contrato).
        await prisma.addOnConfig.create({ data: { key: 'PAUTAS', name: 'Pautas', price: 5000 } });
        const r2 = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: servico.id, ...slotN(1), status: 'RESERVED', addOns: ['PAUTAS'] });
        expect(r2.status, JSON.stringify(r2.body)).toBe(201);
        expect(r2.body.downgraded).toBe(false);
        expect(r2.body.notice).toMatch(/contrato de serviço/);
        const pays = await prisma.payment.findMany({ where: { bookingId: r2.body.booking.id } });
        expect(pays).toHaveLength(1);
        expect(pays[0]).toMatchObject({ status: 'PENDING', amount: session + applyDiscount(5000, 10) });

        // Invariante: toda gravação desse contrato tem cobrança.
        const bookings = await prisma.booking.findMany({ where: { contractId: servico.id } });
        expect(bookings).toHaveLength(2);
        for (const b of bookings) expect(await prisma.payment.count({ where: { bookingId: b.id } })).toBe(1);
    });

    it('ADMIN + contrato SERVIÇO: comportamento antigo ("Confirmado" grava a cobrança PAGA, sem aviso)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const servico = await mkContract(client.id, { type: 'SERVICO', discountPct: 10 });
        const r = await call('POST', '/api/bookings/admin', admin, { userId: client.id, contractId: servico.id, ...slotN(0), status: 'CONFIRMED' });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.booking.status).toBe('CONFIRMED');
        expect(r.body.notice).toBeUndefined();
        expect(r.body.message).toBe('Agendamento criado pela equipe.');
        const pay = await prisma.payment.findUniqueOrThrow({ where: { id: r.body.paymentId } });
        expect(pay).toMatchObject({ status: 'PAID', amount: applyDiscount(await getBasePriceDynamic('COMERCIAL'), 10) });
    });

    it('contrato fora de ACTIVE/COMPLETED → 400 CONTRACT_NOT_ACTIVE para Recepção e ADMIN, sem gravar nada nem mexer no crédito', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        let i = 0;
        for (const type of ALL_TYPES) {
            for (const status of NOT_LINKABLE) {
                const c = await contractFor(client.id, type, status);
                for (const who of [recepcao, admin]) {
                    const r = await call('POST', '/api/bookings/admin', who, { userId: client.id, contractId: c.id, ...slotN(i++ % 6), status: 'RESERVED' });
                    expect(r.status, `${who.role} ${type}/${status}: ${JSON.stringify(r.body)}`).toBe(400);
                    expect(r.body.code).toBe('CONTRACT_NOT_ACTIVE');
                    expect(r.body.error).toMatch(/^Não é possível agendar neste contrato: ele está .+\. Escolha um contrato ativo ou agende como avulso\.$/);
                }
                const after = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
                expect({ status: after.status, flex: after.flexCreditsRemaining, custom: after.customCreditsRemaining })
                    .toEqual({ status, flex: c.flexCreditsRemaining, custom: c.customCreditsRemaining });
            }
        }
        expect(await prisma.booking.count()).toBe(0);
        expect(await prisma.payment.count()).toBe(0);

        const cancelled = await contractFor(client.id, 'FLEX', 'CANCELLED');
        const msg = await call('POST', '/api/bookings/admin', admin, { userId: client.id, contractId: cancelled.id, ...slotN(0) });
        expect(msg.body.error).toBe('Não é possível agendar neste contrato: ele está cancelado. Escolha um contrato ativo ou agende como avulso.');
        // O contrato de outro cliente continua 404 (a checagem de dono vem antes).
        const other = await mkUser();
        const notMine = await call('POST', '/api/bookings/admin', admin, { userId: other.id, contractId: cancelled.id, ...slotN(0) });
        expect(notMine.status).toBe(404);
    });

    it('FIXO CONCLUÍDO (teto usado): a Recepção agenda, mas a sessão extra é cobrada; o contrato é reaberto', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const perMonth = Number(await getConfig('sessions_per_month'));
        const plan = await mkContract(client.id, { type: 'FIXO', durationMonths: 1, discountPct: 30, status: 'COMPLETED' });
        for (let k = 1; k <= perMonth; k++) {
            await mkBooking(client.id, plan.id, { date: dbDate(addDaysYmd(todaySp, -7 * k)), startTime: '10:00', endTime: '12:00', status: 'COMPLETED' });
        }
        const r = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: plan.id, ...slotN(0), status: 'RESERVED' });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.coveredByPlan).toBeUndefined();
        expect(r.body.notice).toMatch(/plano fixo já usou todas as sessões/);
        expect(r.body.message).toMatch(/aguardando pagamento/);
        const pay = await prisma.payment.findUniqueOrThrow({ where: { id: r.body.paymentId } });
        expect(pay).toMatchObject({ status: 'PENDING', amount: applyDiscount(await getBasePriceDynamic('COMERCIAL'), 30), contractId: plan.id });
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe('ACTIVE');
    });

    it('FIXO ATIVO com 1 vaga no teto: a 1ª sessão é coberta (sem cobrança), a 2ª é extra (cobrada); cancelada não ocupa o teto', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const perMonth = Number(await getConfig('sessions_per_month'));
        const plan = await mkContract(client.id, { type: 'FIXO', durationMonths: 1, discountPct: 30 });
        for (let k = 1; k < perMonth; k++) {
            await mkBooking(client.id, plan.id, { date: dbDate(addDaysYmd(todaySp, -7 * k)), startTime: '10:00', endTime: '12:00', status: 'COMPLETED' });
        }
        await mkBooking(client.id, plan.id, { date: dbDate(addDaysYmd(todaySp, -2)), startTime: '13:00', endTime: '15:00', status: 'CANCELLED' });

        const first = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: plan.id, ...slotN(0) });
        expect(first.status, JSON.stringify(first.body)).toBe(201);
        expect(first.body.coveredByPlan).toBe(true);
        expect(first.body.paymentId).toBeNull();

        const second = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: plan.id, ...slotN(1) });
        expect(second.status, JSON.stringify(second.body)).toBe(201);
        expect(second.body.coveredByPlan).toBeUndefined();
        expect(second.body.notice).toMatch(/sessão extra é cobrada/);
        expect(await prisma.payment.findUniqueOrThrow({ where: { id: second.body.paymentId } }))
            .toMatchObject({ status: 'PENDING', amount: applyDiscount(await getBasePriceDynamic('COMERCIAL'), 30) });
    });

    it('FIXO no último lugar, duas criações concorrentes da equipe: no máximo UMA sai coberta pelo plano', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const perMonth = Number(await getConfig('sessions_per_month'));
        const plan = await mkContract(client.id, { type: 'FIXO', durationMonths: 1, discountPct: 30 });
        for (let k = 1; k < perMonth; k++) {
            await mkBooking(client.id, plan.id, { date: dbDate(addDaysYmd(todaySp, -7 * k)), startTime: '10:00', endTime: '12:00', status: 'COMPLETED' });
        }
        const [a, b] = await Promise.all([
            call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: plan.id, ...slotN(0) }),
            call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: plan.id, ...slotN(3) }),
        ]);
        const results = [a, b];
        expect(results.filter(r => r.status === 201 && r.body.coveredByPlan === true)).toHaveLength(1);
        for (const r of results.filter(x => x.body.coveredByPlan !== true)) {
            // A outra: ou recusada pela reconferência sob a trava (409), ou criada já como extra cobrada.
            if (r.status === 409) expect(r.body.code).toBe('FIXO_LIMIT_REACHED');
            else {
                expect(r.status, JSON.stringify(r.body)).toBe(201);
                expect((await prisma.payment.findUniqueOrThrow({ where: { id: r.body.paymentId } })).status).toBe('PENDING');
            }
        }
        // Teto: sessões sem cobrança no contrato = as do plano (perMonth), nunca mais.
        const live = await prisma.booking.findMany({ where: { contractId: plan.id, status: { not: 'CANCELLED' } }, select: { id: true } });
        let uncharged = 0;
        for (const s of live) if (await prisma.payment.count({ where: { bookingId: s.id } }) === 0) uncharged++;
        expect(uncharged).toBe(perMonth);
    });

    it('invariante: a Recepção nunca cria gravação sem cobrança fora de plano vivo (todos os tipos × status)', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const session = applyDiscount(await getBasePriceDynamic('COMERCIAL'), 20);
        let i = 0;
        let created = 0;
        for (const type of ALL_TYPES) {
            for (const status of ['ACTIVE', 'COMPLETED', ...NOT_LINKABLE]) {
                const c = await contractFor(client.id, type, status);
                const slot = slotN(i++);
                const r = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: c.id, ...slot });
                const label = `${type}/${status}: ${JSON.stringify(r.body)}`;
                if (r.status !== 201) {
                    expect(await prisma.booking.count({ where: { contractId: c.id } }), label).toBe(0);
                    continue;
                }
                created++;
                const livePlan = (PLAN_TYPES as readonly string[]).includes(type) && (status === 'ACTIVE' || status === 'COMPLETED');
                if (r.body.coveredByPlan === true) {
                    expect(livePlan, label).toBe(true);
                    expect(await prisma.payment.count({ where: { bookingId: r.body.booking.id } }), label).toBe(0);
                } else {
                    const pays = await prisma.payment.findMany({ where: { bookingId: r.body.booking.id } });
                    expect(pays, label).toHaveLength(1);
                    expect(pays[0]!.status, label).toBe('PENDING');
                    expect(pays[0]!.amount, label).toBe(session); // valor da sessão com o desconto do contrato, como antes
                }
            }
        }
        // Criados: FIXO/FLEX/Personalizado/SERVIÇO/avulso × (ACTIVE, COMPLETED). Os 5 status mortos → 400.
        expect(created).toBe(ALL_TYPES.length * 2);
        // Os planos vivos (3 tipos × 2 status) saíram cobertos; SERVIÇO e avulso, cobrados.
        expect(await prisma.payment.count()).toBe(4);
    });
});

// ─── DIN-01 — trava de saída de CANCELLED ───────────────

describe('DIN-01 (trava ampla) — FLEX: Cancelado → Concluído volta; Personalizado segue travado', () => {
    it('FLEX COMPLETED → CANCELLED → COMPLETED pelo ADMIN: 200 e o cron mantém o saldo (com e sem o cron rodar no meio)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const yesterday = addDaysYmd(todaySp, -1);
        const plan = await mkContract(client.id, {
            type: 'FLEX', flexCreditsTotal: 5, flexCreditsRemaining: 4, flexForfeitFloor: 0, flexCreditsForfeited: 0, flexCycleStart: dbDate(yesterday),
        });
        const b = await mkBooking(client.id, plan.id, { date: dbDate(yesterday), startTime: '10:00', endTime: '12:00', status: 'COMPLETED' });
        await runFlexCreditExpiryJob(new Date());
        expect(await flexLeft(plan.id)).toBe(4); // saldo canônico: 5 − 1 sessão

        // 1ª volta: o "Cancelar" por engano e o desfazer, sem o cron no meio.
        const cancel = await call('PATCH', `/api/bookings/${b.id}`, admin, { status: 'CANCELLED' });
        expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
        expect(await flexLeft(plan.id)).toBe(4); // o PATCH → CANCELLED não mexe no crédito
        const back = await call('PATCH', `/api/bookings/${b.id}`, admin, { status: 'COMPLETED' });
        expect(back.status, JSON.stringify(back.body)).toBe(200);
        expect(back.body.booking.status).toBe('COMPLETED');
        expect(await flexLeft(plan.id)).toBe(4);
        await runFlexCreditExpiryJob(new Date());
        expect(await flexLeft(plan.id)).toBe(4);

        // 2ª volta: o cron roda enquanto a sessão está cancelada (devolve o crédito: 5). Ao voltar a
        // Concluída, o saldo é reconciliado na hora (4) — não fica um crédito a mais até a próxima rodada.
        expect((await call('PATCH', `/api/bookings/${b.id}`, admin, { status: 'CANCELLED' })).status).toBe(200);
        await runFlexCreditExpiryJob(new Date());
        expect(await flexLeft(plan.id)).toBe(5);
        expect((await call('PATCH', `/api/bookings/${b.id}`, admin, { status: 'COMPLETED' })).status).toBe(200);
        expect(await flexLeft(plan.id)).toBe(4);
        await runFlexCreditExpiryJob(new Date());
        const after = await prisma.contract.findUniqueOrThrow({ where: { id: plan.id } });
        expect({ left: after.flexCreditsRemaining, forfeited: after.flexCreditsForfeited, status: after.status })
            .toEqual({ left: 4, forfeited: 0, status: 'ACTIVE' });
    });

    it('FLEX: sessão aberta cancelada pelo DELETE (devolve o crédito) que volta a Concluída (quem tem a baixa) → o crédito volta a ser consumido', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        // R4 (ATK-02/FIN-01): sair de Cancelado exige também cobrancas.baixa — a Recepção recebe 403 (coberto em
        // eq-r4-agendamentos.test.ts); o desfazer é de quem tem a baixa.
        const baixa = await mkStaff({ permissions: [...RECEPCAO, 'cobrancas.baixa'] });
        const client = await mkUser();
        const plan = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 5, flexCreditsRemaining: 5, flexForfeitFloor: 0, flexCreditsForfeited: 0 });
        const r = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: plan.id, ...slotN(0) });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(await flexLeft(plan.id)).toBe(4);
        expect((await call('DELETE', `/api/bookings/${r.body.booking.id}`, recepcao)).status).toBe(200);
        expect(await flexLeft(plan.id)).toBe(5);

        const denied = await call('PATCH', `/api/bookings/${r.body.booking.id}`, recepcao, { status: 'COMPLETED' });
        expect(denied.status, JSON.stringify(denied.body)).toBe(403);
        expect(denied.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa' });
        expect(await flexLeft(plan.id)).toBe(5);

        const back = await call('PATCH', `/api/bookings/${r.body.booking.id}`, baixa, { status: 'COMPLETED' });
        expect(back.status, JSON.stringify(back.body)).toBe(200);
        expect(await flexLeft(plan.id)).toBe(4); // sem o acerto, ficaria 5 até o cron
        await runFlexCreditExpiryJob(new Date());
        expect(await flexLeft(plan.id)).toBe(4);
    });

    it('FLEX: Cancelado → Confirmado/Reservado/Não realizado continua 409 (ADMIN e quem tem a baixa); → Falta é 400 (regra de todo tipo); a Recepção esbarra antes na baixa (403)', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        // R4: sair de Cancelado exige cobrancas.baixa; a trava DIN-01 vale para quem passa da permissão.
        const baixa = await mkStaff({ permissions: [...RECEPCAO, 'cobrancas.baixa'] });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const plan = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 12, flexCreditsRemaining: 5 });
        const b = await mkBooking(client.id, plan.id, { date: dbDate(weekdayN(0)), startTime: '10:00', endTime: '12:00', status: 'CANCELLED' });

        for (const status of ['CONFIRMED', 'RESERVED', 'NAO_REALIZADO', 'FALTA']) {
            const p = await call('PATCH', `/api/bookings/${b.id}`, recepcao, { status, statusReason: 'Motivo.' });
            expect(p.status, `Recepção → ${status}: ${JSON.stringify(p.body)}`).toBe(403);
            expect(p.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa' });
        }

        for (const who of [admin, baixa]) {
            for (const status of ['CONFIRMED', 'RESERVED', 'NAO_REALIZADO']) {
                const p = await call('PATCH', `/api/bookings/${b.id}`, who, { status, ...(status === 'NAO_REALIZADO' ? { statusReason: 'Equipamento.' } : {}) });
                expect(p.status, `${who.role} → ${status}: ${JSON.stringify(p.body)}`).toBe(409);
                expect(p.body.code).toBe('PLAN_SESSION_CANCELLED');
                expect(p.body.error).toMatch(/plano Flex/);
                expect(p.body.error).toMatch(/Crie um novo agendamento/);
                expect(p.body.error).toMatch(/marque como Concluído/);
            }
            const falta = await call('PATCH', `/api/bookings/${b.id}`, who, { status: 'FALTA', statusReason: 'Não veio.' });
            expect(falta.status, JSON.stringify(falta.body)).toBe(400);
            expect(falta.body.code).toBeUndefined();
        }
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('CANCELLED');
        expect(await flexLeft(plan.id)).toBe(5);
    });

    it('Personalizado: nenhuma saída de Cancelado, nem para Concluído (sem reconciliador do saldo)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const custom = await mkContract(client.id, { type: 'CUSTOM', customCreditsRemaining: 2 });
        const b = await mkBooking(client.id, custom.id, { date: dbDate(addDaysYmd(todaySp, -1)), startTime: '10:00', endTime: '12:00', status: 'CANCELLED' });
        for (const status of ['COMPLETED', 'CONFIRMED', 'NAO_REALIZADO']) {
            const p = await call('PATCH', `/api/bookings/${b.id}`, admin, { status, ...(status === 'NAO_REALIZADO' ? { statusReason: 'Equipamento.' } : {}) });
            expect(p.status, `→ ${status}: ${JSON.stringify(p.body)}`).toBe(409);
            expect(p.body.code).toBe('PLAN_SESSION_CANCELLED');
            expect(p.body.error).toMatch(/plano Personalizado não pode ser reaberta/);
        }
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('CANCELLED');
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: custom.id } })).customCreditsRemaining).toBe(2);
    });

    it('FIXO e avulso: a saída de Cancelado não muda (sem trava de plano)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const fixo = await mkContract(client.id, { type: 'FIXO' });
        const b = await mkBooking(client.id, fixo.id, { date: dbDate(weekdayN(0)), startTime: '10:00', endTime: '12:00', status: 'CANCELLED' });
        const p = await call('PATCH', `/api/bookings/${b.id}`, admin, { status: 'COMPLETED' });
        expect(p.status, JSON.stringify(p.body)).toBe(200);
        expect(p.body.booking.status).toBe('COMPLETED');
    });
});
