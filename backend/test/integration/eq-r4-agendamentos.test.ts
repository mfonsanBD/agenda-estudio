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
import { getBasePriceDynamic } from '../../src/utils/pricing';
import bookingRoutes from '../../src/modules/bookings/routes';
import { mkUser, mkStaff, mkContract, mkBooking } from './factories';

// FRENTE R4a — agendamentos (2ª revisão adversarial):
//  1) ATK-01/FIN-02: POST /api/bookings do cliente com contrato AVULSO → 400 (o crédito que o cancelamento
//     devolve ao micro-contrato não vira gravação de graça); /bulk já só aceita FLEX.
//  2) ATK-02/FIN-01: reabrir pelo PATCH /api/bookings/:id
//     a) sair de CANCELLED exige também cobrancas.baixa (403 com o motivo) — a cobrança foi anulada no cancelamento;
//     b) Não realizado → volta a valer, sem a baixa: o crédito é descontado de verdade antes (409 NO_CREDITS) e o
//        teto do FIXO é conferido sob a trava do contrato (409 FIXO_LIMIT_REACHED). ADMIN/baixa: como antes.
//  4) FIN-03: troca de faixa pelo PATCH sem a baixa — a sessão de PLANO (FIXO/FLEX/Personalizado sem cobrança da
//     sessão marcada) muda dentro da faixa do plano; acima dela → 403 TIER_NOT_ALLOWED; o resto exige a baixa.
// (Item 3 — cobrança da sessão no /confirm — em eq-r4-agendamentos-cobranca.test.ts.)

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
/** n-ésimo dia útil no PASSADO (sessão que já aconteceu). */
function pastWeekdayN(n: number): string {
    let found = -1;
    for (let d = addDaysYmd(todaySp, -1); ; d = addDaysYmd(d, -1)) {
        if (dow(d) >= 1 && dow(d) <= 5 && ++found === n) return d;
    }
}

/** Perfil modelo Recepção (D2): cria, edita, marca faltas, cancela e cobra — sem a baixa manual. */
const RECEPCAO = ['agendamentos.ver', 'agendamentos.criar', 'agendamentos.editar', 'agendamentos.faltas', 'agendamentos.cancelar', 'hoje.ver', 'hoje.presenca', 'clientes.ver', 'clientes.criar', 'clientes.editar', 'contratos.ver', 'contratos.criar', 'cobrancas.cobrar', 'cupons.ver'];
/** Recepção + a baixa manual (o "Financeiro" que também opera a agenda). */
const COM_BAIXA = [...RECEPCAO, 'cobrancas.baixa'];

const AVULSO_VIA_CONTRACT = 'Gravação avulsa não se agenda pelo contrato. Para remarcar, use a remarcação da própria reserva.';
const REOPEN_CANCELLED = 'Reabrir uma sessão cancelada exige a permissão “Marcar como pago, anular ou estornar”: a cobrança dela foi anulada no cancelamento. Para uma nova sessão, crie um novo agendamento.';
// R5 (pendência do conserto 3): sessão de plano cancelada SEM cobrança nenhuma — o 403 não fala em cobrança anulada.
const REOPEN_CANCELLED_NO_CHARGE = 'Reabrir uma sessão cancelada exige a permissão “Marcar como pago, anular ou estornar”. Para uma nova sessão, crie um novo agendamento.';
// UXT-04 (R4-conserto3): o crédito devolvido pode ter sido usado OU vencido no confisco semanal do FLEX.
const REOPEN_NO_CREDITS = 'O plano não tem crédito disponível para reabrir esta sessão: o crédito devolvido no “Não realizado” já foi usado ou venceu. Crie um novo agendamento ou peça a quem pode dar baixa.';
const REOPEN_FIXO_LIMIT = 'O plano fixo já usou todas as sessões: reabrir esta sessão passaria do limite. Crie um novo agendamento (cobrado) ou peça a quem pode dar baixa.';
const TIER_CHANGE_NEEDS_BAIXA = 'Mudar a sessão para outra faixa de preço muda o valor cobrado — isso exige a permissão “Marcar como pago, anular ou estornar”.';

const credits = async (contractId: string) => {
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
    return { flex: c.flexCreditsRemaining, custom: c.customCreditsRemaining };
};
const statusOf = async (bookingId: string) => (await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status;
const slot = (date: string, startTime: string) => ({ date: dbDate(date), startTime, endTime: `${String(Number(startTime.slice(0, 2)) + 2).padStart(2, '0')}${startTime.slice(2)}` });

// ─── 1) POST /api/bookings do cliente: contrato AVULSO ──

describe('R4a-1 (ATK-01/FIN-02) — o crédito devolvido ao avulso não vira gravação pelo POST /api/bookings', () => {
    it('Recepção cria o avulso; o CLIENTE cancela (+1 no avulso) e tenta agendar com o avulso → 400, nada gravado', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const created = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(0), startTime: '10:00' });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        expect(created.body.booking.status).toBe('RESERVED');
        const avulso = await prisma.contract.findFirstOrThrow({ where: { userId: client.id, type: 'AVULSO' } });
        expect({ status: avulso.status, left: avulso.flexCreditsRemaining }).toEqual({ status: 'ACTIVE', left: 0 });
        expect(await prisma.payment.findUniqueOrThrow({ where: { id: created.body.paymentId } })).toMatchObject({ status: 'PENDING' });

        const del = await call('DELETE', `/api/bookings/${created.body.booking.id}`, client);
        expect(del.status, JSON.stringify(del.body)).toBe(200);
        expect((await credits(avulso.id)).flex).toBe(1);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: avulso.id } })).status).toBe('ACTIVE');

        const bookingsBefore = await prisma.booking.count({ where: { userId: client.id } });
        const paymentsBefore = await prisma.payment.count({ where: { userId: client.id } });
        for (const body of [
            { contractId: avulso.id, date: weekdayN(1), startTime: '10:00' },
            { contractId: avulso.id, date: weekdayN(0), startTime: '10:00' }, // o mesmo horário liberado
            { contractId: avulso.id, date: weekdayN(1), startTime: '13:00', paymentMethod: 'PIX' },
        ]) {
            const r = await call('POST', '/api/bookings', client, body);
            expect(r.status, JSON.stringify(r.body)).toBe(400);
            expect(r.body).toEqual({ error: AVULSO_VIA_CONTRACT });
        }
        expect(await prisma.booking.count({ where: { userId: client.id } })).toBe(bookingsBefore);
        expect(await prisma.payment.count({ where: { userId: client.id } })).toBe(paymentsBefore);
        expect((await credits(avulso.id)).flex).toBe(1);
        expect(await redis.keys('booking:lock:*')).toEqual([]);
    });

    it('o mesmo quando quem cancela é a equipe (DELETE da equipe); /bulk com o avulso → 400 (só FLEX)', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const baixa = await mkStaff({ permissions: COM_BAIXA });
        const client = await mkUser();
        const created = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(0), startTime: '13:00' });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const avulso = await prisma.contract.findFirstOrThrow({ where: { userId: client.id, type: 'AVULSO' } });
        // R5: o avulso tem a cobrança em aberto → só quem tem a baixa cancela (e a anula).
        expect((await call('DELETE', `/api/bookings/${created.body.booking.id}`, recepcao)).status).toBe(403);
        expect((await call('DELETE', `/api/bookings/${created.body.booking.id}`, baixa)).status).toBe(200);
        expect((await credits(avulso.id)).flex).toBe(1);

        const r = await call('POST', '/api/bookings', client, { contractId: avulso.id, date: weekdayN(2), startTime: '10:00' });
        expect(r.status, JSON.stringify(r.body)).toBe(400);
        expect(r.body).toEqual({ error: AVULSO_VIA_CONTRACT });

        const bulk = await call('POST', '/api/bookings/bulk', client, { contractId: avulso.id, slots: [{ date: weekdayN(2), startTime: '10:00' }] });
        expect(bulk.status, JSON.stringify(bulk.body)).toBe(400);
        expect(bulk.body.error).toBe('Apenas contratos Flex suportam marcação em lote.');

        expect(await prisma.booking.count({ where: { userId: client.id } })).toBe(1);
        expect((await credits(avulso.id)).flex).toBe(1);
    });

    it('regressão: FLEX com crédito → 201 (−1); avulso sem contrato → 201 com hold e cobrança PENDING; remarcar a própria reserva segue', async () => {
        const client = await mkUser();
        const flex = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 12, flexCreditsRemaining: 2 });
        const a = await call('POST', '/api/bookings', client, { contractId: flex.id, date: weekdayN(0), startTime: '10:00' });
        expect(a.status, JSON.stringify(a.body)).toBe(201);
        expect((await credits(flex.id)).flex).toBe(1);

        const b = await call('POST', '/api/bookings', client, { date: weekdayN(1), startTime: '10:00', paymentMethod: 'PIX' });
        expect(b.status, JSON.stringify(b.body)).toBe(201);
        expect(b.body.booking.holdExpiresAt).toBeTruthy();
        expect(await prisma.payment.findUniqueOrThrow({ where: { id: b.body.paymentId } })).toMatchObject({ status: 'PENDING', bookingId: b.body.booking.id });

        // A remarcação do avulso é pela própria reserva (mesma faixa) — não pelo contrato.
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const own = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(2), startTime: '10:00' });
        expect(own.status, JSON.stringify(own.body)).toBe(201);
        const moved = await call('PATCH', `/api/bookings/${own.body.booking.id}/reschedule`, client, { date: weekdayN(3), startTime: '13:00' });
        expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    });
});

// ─── 2a) Sair de CANCELLED exige cobrancas.baixa ────────

describe('R4a-2a (ATK-02/FIN-01) — reabrir uma sessão CANCELADA pelo PATCH exige cobrancas.baixa', () => {
    it('SERVIÇO: a Recepção cria (cobrança da sessão), quem tem a baixa cancela (cobrança anulada) e a Recepção NÃO reabre (403); ADMIN e quem tem a baixa reabrem', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const baixa = await mkStaff({ permissions: COM_BAIXA });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'COMERCIAL', discountPct: 10 });

        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
            const c = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: servico.id, date: weekdayN(i), startTime: '10:00' });
            expect(c.status, JSON.stringify(c.body)).toBe(201);
            expect(await prisma.payment.findUniqueOrThrow({ where: { id: c.body.paymentId } })).toMatchObject({ status: 'PENDING' });
            // R5: cancelar anula a cobrança em aberto → só quem tem a baixa (a Recepção recebe 403).
            expect((await call('DELETE', `/api/bookings/${c.body.booking.id}`, recepcao)).status).toBe(403);
            const del = await call('DELETE', `/api/bookings/${c.body.booking.id}`, baixa);
            expect(del.status, JSON.stringify(del.body)).toBe(200);
            expect(await prisma.payment.findUniqueOrThrow({ where: { id: c.body.paymentId } })).toMatchObject({ status: 'CANCELLED' });
            ids.push(c.body.booking.id);
        }

        // O ataque: cancelar e reabrir pela Edição = "anular a cobrança" sem a chave.
        for (const status of ['CONFIRMED', 'RESERVED', 'COMPLETED', 'NAO_REALIZADO']) {
            const r = await call('PATCH', `/api/bookings/${ids[0]}`, recepcao, { status, ...(status === 'NAO_REALIZADO' ? { statusReason: 'Equipamento.' } : {}) });
            expect(r.status, `→ ${status}: ${JSON.stringify(r.body)}`).toBe(403);
            expect(r.body, status).toEqual({ error: REOPEN_CANCELLED, code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa' });
        }
        expect(await statusOf(ids[0]!)).toBe('CANCELLED');

        // Quem tem a baixa (e o ADMIN) passa da permissão, mas (conserto 5 — AUDFIN-01) a cobrança da sessão foi anulada
        // no cancelamento e não volta: Confirmado → 409 SESSION_CHARGE_VOIDED; Concluído passa, avisando que fica sem cobrança.
        const a = await call('PATCH', `/api/bookings/${ids[1]}`, admin, { status: 'CONFIRMED' });
        expect(a.status, JSON.stringify(a.body)).toBe(409);
        expect(a.body.code).toBe('SESSION_CHARGE_VOIDED');
        expect(await statusOf(ids[1]!)).toBe('CANCELLED');
        const b = await call('PATCH', `/api/bookings/${ids[2]}`, baixa, { status: 'COMPLETED' });
        expect(b.status, JSON.stringify(b.body)).toBe(200);
        expect(b.body).toMatchObject({ booking: { status: 'COMPLETED' }, reopenedWithoutCharge: true });
    });

    it('FLEX com extras: cancelar anula os extras; a Recepção não volta a Concluído (403) — o ADMIN volta (200, saldo reconciliado)', async () => {
        await prisma.addOnConfig.create({ data: { key: 'CORTES_IA', name: 'Cortes', price: 10000 } });
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const flex = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 5, flexCreditsRemaining: 5, flexForfeitFloor: 0, flexCreditsForfeited: 0 });
        const c = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: flex.id, date: weekdayN(0), startTime: '10:00', addOns: ['CORTES_IA'] });
        expect(c.status, JSON.stringify(c.body)).toBe(201);
        expect(c.body.coveredByPlan).toBe(true);
        // R5: o extra em aberto faz do cancelamento uma anulação → só com a baixa (aqui, o ADMIN).
        expect((await call('DELETE', `/api/bookings/${c.body.booking.id}`, recepcao)).status).toBe(403);
        expect((await call('DELETE', `/api/bookings/${c.body.booking.id}`, admin)).status).toBe(200);
        expect(await prisma.payment.findUniqueOrThrow({ where: { id: c.body.paymentId } })).toMatchObject({ status: 'CANCELLED' });
        expect((await credits(flex.id)).flex).toBe(5);

        const r = await call('PATCH', `/api/bookings/${c.body.booking.id}`, recepcao, { status: 'COMPLETED' });
        expect(r.status, JSON.stringify(r.body)).toBe(403);
        expect(r.body).toEqual({ error: REOPEN_CANCELLED, code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa' });
        expect(await statusOf(c.body.booking.id)).toBe('CANCELLED');
        expect((await credits(flex.id)).flex).toBe(5);

        const ok = await call('PATCH', `/api/bookings/${c.body.booking.id}`, admin, { status: 'COMPLETED' });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect((await credits(flex.id)).flex).toBe(4);
        // DIN-01 continua valendo até para o ADMIN: FLEX cancelado não volta a ficar em aberto.
        const other = await mkBooking(client.id, flex.id, { ...slot(weekdayN(1), '10:00'), status: 'CANCELLED' });
        const blocked = await call('PATCH', `/api/bookings/${other.id}`, admin, { status: 'CONFIRMED' });
        expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
        expect(blocked.body.code).toBe('PLAN_SESSION_CANCELLED');
    });

    it('FIXO cheio (FIN-01 B): cancelar libera a vaga, a Recepção cria uma coberta e NÃO reabre a cancelada (403); o ADMIN reabre como antes', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL', durationMonths: 1 }); // teto 4
        const seeded = [];
        for (let i = 0; i < 4; i++) seeded.push(await mkBooking(client.id, fixo.id, { ...slot(weekdayN(5 + i), '10:00'), status: 'CONFIRMED' }));

        expect((await call('DELETE', `/api/bookings/${seeded[0]!.id}`, recepcao)).status).toBe(200);
        const covered = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: fixo.id, date: weekdayN(0), startTime: '10:00' });
        expect(covered.status, JSON.stringify(covered.body)).toBe(201);
        expect(covered.body.coveredByPlan).toBe(true);

        const r = await call('PATCH', `/api/bookings/${seeded[0]!.id}`, recepcao, { status: 'RESERVED' });
        expect(r.status, JSON.stringify(r.body)).toBe(403);
        expect(r.body).toEqual({ error: REOPEN_CANCELLED_NO_CHARGE, code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa' });
        expect(await statusOf(seeded[0]!.id)).toBe('CANCELLED');
        expect(await prisma.booking.count({ where: { contractId: fixo.id, status: { not: 'CANCELLED' } } })).toBe(4);

        const a = await call('PATCH', `/api/bookings/${seeded[0]!.id}`, admin, { status: 'RESERVED' });
        expect(a.status, JSON.stringify(a.body)).toBe(200);
    });

    it('sem agendamentos.editar o 403 continua sendo o do editar (a ordem dos requisitos não mudou)', async () => {
        const op = await mkStaff({ permissions: ['hoje.ver', 'hoje.presenca', 'cobrancas.baixa'] });
        const client = await mkUser();
        const fixo = await mkContract(client.id, { type: 'FIXO' });
        const b = await mkBooking(client.id, fixo.id, { ...slot(weekdayN(0), '10:00'), status: 'CANCELLED' });
        const r = await call('PATCH', `/api/bookings/${b.id}`, op, { status: 'CONFIRMED' });
        expect(r.status).toBe(403);
        expect(r.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'agendamentos.editar' });
        expect(await statusOf(b.id)).toBe('CANCELLED');
    });
});

// ─── 2b) Não realizado → volta a valer ──────────────────

describe('R4a-2b (ATK-02) — Não realizado → volta a valer só se o plano ainda comporta a sessão (sem a baixa)', () => {
    for (const type of ['FLEX', 'CUSTOM'] as const) {
        it(`${type} sem saldo: Não realizado (+1), sessão nova pelo /admin (−1) e reabrir a 1ª → 409 NO_CREDITS, nada escrito`, async () => {
            const recepcao = await mkStaff({ permissions: RECEPCAO });
            const client = await mkUser();
            const plan = await mkContract(client.id, type === 'FLEX'
                ? { type: 'FLEX', flexCreditsTotal: 5, flexCreditsRemaining: 0, flexForfeitFloor: 0, flexCreditsForfeited: 0 }
                : { type: 'CUSTOM', customCreditsRemaining: 0 });
            const left = async () => { const c = await credits(plan.id); return type === 'FLEX' ? c.flex : c.custom; };
            const s1 = await mkBooking(client.id, plan.id, { ...slot(pastWeekdayN(0), '10:00'), status: 'COMPLETED' });

            const nr = await call('PATCH', `/api/bookings/${s1.id}`, recepcao, { status: 'NAO_REALIZADO', statusReason: 'Equipamento.' });
            expect(nr.status, JSON.stringify(nr.body)).toBe(200);
            expect(await left()).toBe(1);
            const s2 = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: plan.id, date: weekdayN(0), startTime: '10:00' });
            expect(s2.status, JSON.stringify(s2.body)).toBe(201);
            expect(s2.body.coveredByPlan).toBe(true);
            expect(await left()).toBe(0);

            for (const status of ['COMPLETED', 'RESERVED', 'CONFIRMED', 'FALTA']) {
                const r = await call('PATCH', `/api/bookings/${s1.id}`, recepcao, { status });
                expect(r.status, `→ ${status}: ${JSON.stringify(r.body)}`).toBe(409);
                expect(r.body, status).toEqual({ code: 'NO_CREDITS', error: REOPEN_NO_CREDITS });
            }
            expect(await statusOf(s1.id)).toBe('NAO_REALIZADO');
            expect(await left()).toBe(0);
            // Sessões vivas = as que o plano pagou.
            expect(await prisma.booking.count({ where: { contractId: plan.id, status: { notIn: ['CANCELLED', 'NAO_REALIZADO'] } } })).toBe(1);
        });
    }

    it('controle: com crédito a Recepção reabre (200, −1); ADMIN e quem tem a baixa seguem como antes (200 sem crédito, saldo 0)', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const baixa = await mkStaff({ permissions: COM_BAIXA });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();

        const rich = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 5, flexCreditsRemaining: 2 });
        const a = await mkBooking(client.id, rich.id, { ...slot(pastWeekdayN(0), '10:00'), status: 'NAO_REALIZADO' });
        const ok = await call('PATCH', `/api/bookings/${a.id}`, recepcao, { status: 'COMPLETED' });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(ok.body.booking.status).toBe('COMPLETED');
        expect((await credits(rich.id)).flex).toBe(1);

        const custom = await mkContract(client.id, { type: 'CUSTOM', customCreditsRemaining: 1 });
        const c = await mkBooking(client.id, custom.id, { ...slot(pastWeekdayN(1), '10:00'), status: 'NAO_REALIZADO' });
        expect((await call('PATCH', `/api/bookings/${c.id}`, recepcao, { status: 'RESERVED' })).status).toBe(200);
        expect((await credits(custom.id)).custom).toBe(0);

        for (const who of [admin, baixa]) {
            const empty = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 5, flexCreditsRemaining: 0 });
            const b = await mkBooking(client.id, empty.id, { ...slot(pastWeekdayN(who === admin ? 2 : 3), '10:00'), status: 'NAO_REALIZADO' });
            const r = await call('PATCH', `/api/bookings/${b.id}`, who, { status: 'COMPLETED' });
            expect(r.status, `${who.role}: ${JSON.stringify(r.body)}`).toBe(200);
            expect(r.body.booking.status).toBe('COMPLETED');
            expect((await credits(empty.id)).flex).toBe(0);
        }

        // Não realizado → Cancelado não consome nada (não passa pela conferência).
        const zero = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 5, flexCreditsRemaining: 0 });
        const z = await mkBooking(client.id, zero.id, { ...slot(pastWeekdayN(4), '10:00'), status: 'NAO_REALIZADO' });
        expect((await call('PATCH', `/api/bookings/${z.id}`, recepcao, { status: 'CANCELLED' })).status).toBe(200);
        expect((await credits(zero.id)).flex).toBe(0);
    });

    it('avulso: Não realizado → Concluído devolve e retoma o crédito (200); sem o crédito → 409 NO_CREDITS', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const avulso = await mkContract(client.id, { type: 'AVULSO', paymentPlan: 'FULL', durationMonths: 1, flexCreditsTotal: 1, flexCreditsRemaining: 0 });
        const b = await mkBooking(client.id, avulso.id, { ...slot(pastWeekdayN(0), '10:00'), status: 'CONFIRMED' });
        expect((await call('PATCH', `/api/bookings/${b.id}`, recepcao, { status: 'NAO_REALIZADO', statusReason: 'Queda de energia.' })).status).toBe(200);
        expect((await credits(avulso.id)).flex).toBe(1);
        const back = await call('PATCH', `/api/bookings/${b.id}`, recepcao, { status: 'COMPLETED' });
        expect(back.status, JSON.stringify(back.body)).toBe(200);
        expect((await credits(avulso.id)).flex).toBe(0);

        const other = await mkContract(client.id, { type: 'AVULSO', paymentPlan: 'FULL', durationMonths: 1, flexCreditsTotal: 1, flexCreditsRemaining: 0 });
        const nr = await mkBooking(client.id, other.id, { ...slot(pastWeekdayN(1), '10:00'), status: 'NAO_REALIZADO' });
        const r = await call('PATCH', `/api/bookings/${nr.id}`, recepcao, { status: 'COMPLETED' });
        expect(r.status, JSON.stringify(r.body)).toBe(409);
        expect(r.body).toEqual({ code: 'NO_CREDITS', error: REOPEN_NO_CREDITS });
        expect(await statusOf(nr.id)).toBe('NAO_REALIZADO');
    });

    it('FIXO no teto: Não realizado libera a vaga, a Recepção cria uma coberta e reabrir a 1ª → 409 FIXO_LIMIT_REACHED; o ADMIN reabre', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL', durationMonths: 1 }); // teto 4
        const s1 = await mkBooking(client.id, fixo.id, { ...slot(pastWeekdayN(0), '10:00'), status: 'COMPLETED' });
        for (let i = 0; i < 3; i++) await mkBooking(client.id, fixo.id, { ...slot(weekdayN(5 + i), '10:00'), status: 'CONFIRMED' });

        expect((await call('PATCH', `/api/bookings/${s1.id}`, recepcao, { status: 'NAO_REALIZADO', statusReason: 'Equipamento.' })).status).toBe(200);
        const covered = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: fixo.id, date: weekdayN(0), startTime: '10:00' });
        expect(covered.status, JSON.stringify(covered.body)).toBe(201);
        expect(covered.body.coveredByPlan).toBe(true);

        for (const status of ['COMPLETED', 'CONFIRMED', 'RESERVED', 'FALTA']) {
            const r = await call('PATCH', `/api/bookings/${s1.id}`, recepcao, { status });
            expect(r.status, `→ ${status}: ${JSON.stringify(r.body)}`).toBe(409);
            expect(r.body, status).toEqual({ code: 'FIXO_LIMIT_REACHED', error: REOPEN_FIXO_LIMIT });
        }
        expect(await statusOf(s1.id)).toBe('NAO_REALIZADO');
        expect(await prisma.booking.count({ where: { contractId: fixo.id, status: { in: ['COMPLETED', 'CONFIRMED', 'FALTA', 'RESERVED'] } } })).toBe(4);
        expect(await redis.keys('booking:fixo-cap:*')).toEqual([]);

        // ADMIN: como antes (sem conferir o teto).
        const a = await call('PATCH', `/api/bookings/${s1.id}`, admin, { status: 'COMPLETED' });
        expect(a.status, JSON.stringify(a.body)).toBe(200);
        expect(await redis.keys('booking:fixo-cap:*')).toEqual([]);
    });

    it('controle FIXO: com vaga no teto a Recepção reabre (200) e a trava do contrato é solta', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'COMERCIAL', durationMonths: 1 });
        const s1 = await mkBooking(client.id, fixo.id, { ...slot(pastWeekdayN(0), '10:00'), status: 'NAO_REALIZADO' });
        await mkBooking(client.id, fixo.id, { ...slot(weekdayN(5), '10:00'), status: 'CONFIRMED' });
        const r = await call('PATCH', `/api/bookings/${s1.id}`, recepcao, { status: 'COMPLETED' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.booking.status).toBe('COMPLETED');
        expect(await redis.keys('booking:fixo-cap:*')).toEqual([]);
    });

    it('concorrência: vários "Concluído" ao mesmo tempo descontam UM crédito só (quem perde a corrida devolve)', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        // Saldo ≥ número de requisições: nenhuma esbarra no NO_CREDITS, só na corrida do status.
        const flex = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 10, flexCreditsRemaining: 6 });
        const b = await mkBooking(client.id, flex.id, { ...slot(pastWeekdayN(0), '10:00'), status: 'NAO_REALIZADO' });
        const rs = await Promise.all(Array.from({ length: 6 }, () => call('PATCH', `/api/bookings/${b.id}`, recepcao, { status: 'COMPLETED' })));
        for (const r of rs) expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(await statusOf(b.id)).toBe('COMPLETED');
        expect((await credits(flex.id)).flex).toBe(5);
    });
});

// ─── 4) Troca de faixa pelo PATCH sem a baixa ───────────

describe('R4a-4 (FIN-03) — troca de faixa sem a baixa: sessão de plano dentro da faixa do plano', () => {
    it('FLEX Audiência: sessão Comercial (coberta) vai para 18:00 → 200, faixa atualizada, nenhuma cobrança', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const flex = await mkContract(client.id, { type: 'FLEX', tier: 'AUDIENCIA', flexCreditsTotal: 12, flexCreditsRemaining: 3 });
        const c = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: flex.id, date: weekdayN(0), startTime: '10:00' });
        expect(c.status, JSON.stringify(c.body)).toBe(201);
        expect(c.body.coveredByPlan).toBe(true);

        const r = await call('PATCH', `/api/bookings/${c.body.booking.id}`, recepcao, { date: weekdayN(0), startTime: '18:00' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.booking.tierApplied).toBe('AUDIENCIA');
        expect(r.body.booking.startTime).toBe('18:00');
        expect(await prisma.payment.count({ where: { userId: client.id } })).toBe(0);
        expect((await credits(flex.id)).flex).toBe(2);
    });

    it('FIXO Audiência: sessão gerada pelo contrato (faixa do contrato) às 10:00 vai para outra terça 10:00 → 200', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'AUDIENCIA' });
        const b = await mkBooking(client.id, fixo.id, { ...slot(weekdayN(0), '10:00'), status: 'CONFIRMED', tierApplied: 'AUDIENCIA' });
        const r = await call('PATCH', `/api/bookings/${b.id}`, recepcao, { date: weekdayN(5), startTime: '10:00' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.booking.tierApplied).toBe('COMERCIAL');
    });

    it('acima da faixa do plano → 403 TIER_NOT_ALLOWED (mensagem em pt-BR), nada alterado', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const cases: Array<{ type: 'FLEX' | 'FIXO' | 'CUSTOM'; tier: 'COMERCIAL' | 'AUDIENCIA'; to: { date: string; startTime: string }; msg: string }> = [
            { type: 'FLEX', tier: 'COMERCIAL', to: { date: weekdayN(1), startTime: '18:00' }, msg: 'O plano Comercial não permite agendar horários Audiência.' },
            { type: 'FIXO', tier: 'COMERCIAL', to: { date: saturdayN(0), startTime: '10:00' }, msg: 'O plano Comercial não permite agendar horários Sábado.' },
            { type: 'CUSTOM', tier: 'AUDIENCIA', to: { date: saturdayN(1), startTime: '13:00' }, msg: 'O plano Audiência não permite agendar horários Sábado.' },
        ];
        for (const [i, c] of cases.entries()) {
            const plan = await mkContract(client.id, { type: c.type, tier: c.tier, flexCreditsTotal: 12, flexCreditsRemaining: 3, customCreditsRemaining: 3 });
            const b = await mkBooking(client.id, plan.id, { ...slot(weekdayN(i), '10:00'), status: 'CONFIRMED', tierApplied: 'COMERCIAL', price: 12345 });
            const r = await call('PATCH', `/api/bookings/${b.id}`, recepcao, c.to);
            expect(r.status, `${c.type}: ${JSON.stringify(r.body)}`).toBe(403);
            expect(r.body, c.type).toEqual({ code: 'TIER_NOT_ALLOWED', error: c.msg });
            const still = await prisma.booking.findUniqueOrThrow({ where: { id: b.id } });
            expect({ date: still.date, startTime: still.startTime, tier: still.tierApplied, price: still.price })
                .toEqual({ date: b.date, startTime: b.startTime, tier: b.tierApplied, price: 12345 });
        }
    });

    it('sessão com cobrança da própria sessão (avulso pago ou não, SERVIÇO, FIXO extra, plano criado cobrado pelo ADMIN) → 403 da baixa', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const expectBaixa = async (bookingId: string, to: { date: string; startTime: string }, label: string) => {
            const before = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
            const r = await call('PATCH', `/api/bookings/${bookingId}`, recepcao, to);
            expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBe(403);
            expect(r.body, label).toEqual({ error: TIER_CHANGE_NEEDS_BAIXA, code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa' });
            const after = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
            expect({ t: after.tierApplied, s: after.startTime, d: after.date }, label).toEqual({ t: before.tierApplied, s: before.startTime, d: before.date });
        };

        // Avulso PAGO (Comercial) → sábado: a diferença de preço não seria cobrada.
        const av = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(0), startTime: '10:00' });
        expect(av.status, JSON.stringify(av.body)).toBe(201);
        await prisma.payment.update({ where: { id: av.body.paymentId }, data: { status: 'PAID', paidAt: new Date() } });
        await expectBaixa(av.body.booking.id, { date: saturdayN(0), startTime: '10:00' }, 'avulso pago');

        // SERVIÇO (cobrado pela faixa do horário).
        const servico = await mkContract(client.id, { type: 'SERVICO', tier: 'SABADO' });
        const sv = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: servico.id, date: weekdayN(0), startTime: '13:00' });
        expect(sv.status, JSON.stringify(sv.body)).toBe(201);
        await expectBaixa(sv.body.booking.id, { date: weekdayN(0), startTime: '18:00' }, 'serviço');

        // FIXO Audiência cheio: a sessão extra é cobrada (com a marca) — mudar de faixa, mesmo dentro do plano, exige a baixa.
        const fixo = await mkContract(client.id, { type: 'FIXO', tier: 'AUDIENCIA', durationMonths: 1 });
        for (let i = 0; i < 4; i++) await mkBooking(client.id, fixo.id, { ...slot(weekdayN(6 + i), '15:30'), status: 'CONFIRMED', tierApplied: 'AUDIENCIA' });
        const extra = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, contractId: fixo.id, date: weekdayN(1), startTime: '18:00' });
        expect(extra.status, JSON.stringify(extra.body)).toBe(201);
        expect(extra.body.notice).toMatch(/plano fixo já usou todas as sessões/);
        await expectBaixa(extra.body.booking.id, { date: weekdayN(1), startTime: '10:00' }, 'FIXO extra');

        // Sessão de plano FLEX criada COBRADA pelo ADMIN ("Reservado", cobrança da sessão PENDING com a marca).
        const flex = await mkContract(client.id, { type: 'FLEX', tier: 'AUDIENCIA', flexCreditsTotal: 12, flexCreditsRemaining: 3 });
        const charged = await call('POST', '/api/bookings/admin', admin, { userId: client.id, contractId: flex.id, date: weekdayN(2), startTime: '10:00', status: 'RESERVED' });
        expect(charged.status, JSON.stringify(charged.body)).toBe(201);
        expect(charged.body.paymentId).toBeTruthy();
        await expectBaixa(charged.body.booking.id, { date: weekdayN(2), startTime: '18:00' }, 'FLEX cobrada pelo ADMIN');

        // Avulso ainda PENDENTE (o caso do DIN-03).
        const pend = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(3), startTime: '10:00' });
        expect(pend.status, JSON.stringify(pend.body)).toBe(201);
        await expectBaixa(pend.body.booking.id, { date: weekdayN(3), startTime: '18:00' }, 'avulso pendente');
    });

    it('ADMIN e quem tem a baixa trocam de faixa como antes (inclusive acima do plano)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const baixa = await mkStaff({ permissions: COM_BAIXA });
        const client = await mkUser();
        const flex = await mkContract(client.id, { type: 'FLEX', tier: 'COMERCIAL', flexCreditsTotal: 12, flexCreditsRemaining: 3 });
        const a = await mkBooking(client.id, flex.id, { ...slot(weekdayN(0), '10:00'), status: 'CONFIRMED', tierApplied: 'COMERCIAL' });
        const ra = await call('PATCH', `/api/bookings/${a.id}`, admin, { date: saturdayN(0), startTime: '10:00' });
        expect(ra.status, JSON.stringify(ra.body)).toBe(200);
        expect(ra.body.booking.tierApplied).toBe('SABADO');
        expect(ra.body.booking.price).toBe(await getBasePriceDynamic('SABADO'));
        const b = await mkBooking(client.id, flex.id, { ...slot(weekdayN(1), '10:00'), status: 'CONFIRMED', tierApplied: 'COMERCIAL' });
        const rb = await call('PATCH', `/api/bookings/${b.id}`, baixa, { date: weekdayN(1), startTime: '18:00' });
        expect(rb.status, JSON.stringify(rb.body)).toBe(200);
        expect(rb.body.booking.tierApplied).toBe('AUDIENCIA');
    });
});
