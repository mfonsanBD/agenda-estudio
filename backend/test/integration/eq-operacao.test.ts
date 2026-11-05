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
import { getBasePriceDynamic } from '../../src/utils/pricing';
import { allPermissionKeys } from '../../src/config/staffPermissions';
import { cleanExpiredHolds } from '../../src/jobs/cleanExpiredHolds';
import bookingRoutes from '../../src/modules/bookings/routes';
import contractRoutes from '../../src/modules/contracts/routes';
import blockedSlotRoutes from '../../src/modules/blocked-slots/routes';
import { mkUser, mkStaff, mkContract, mkBooking, mkPayment, mkCoupon, mkBlockedSlot } from './factories';

// FRENTE B2 — permissões da EQUIPE nas rotas de operação (Agenda, Hoje, bloqueios e Contratos).
//  1. Tabela da verdade: rota exclusiva da equipe → CLIENTE 403, COLABORADOR sem a permissão 403
//     PERMISSION_DENIED, COLABORADOR só com a permissão ≠ 403 (sucesso real), ADMIN ≠ 403. Rota mista
//     (cliente + equipe) → a sonda do cliente usa um cliente que NÃO é o dono da fixture e exige o status
//     EXATO dele (`stranger`: 404 nas rotas com id; o ramo dele nas que ignoram o `userId` do corpo) e a
//     fixture intacta (R4e — QT-02). Autoatendimento → só CLIENTE (S5: ADMIN e COLABORADOR 403).
//  2. Casos F1, F2 e F3 da crítica (§8), "nasce aguardando pagamento" (D7), alvo sempre CLIENTE (S5) e
//     os avisos da equipe (getStaffRecipientIds).

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/bookings', bookingRoutes);
    app.use('/api/contracts', contractRoutes);
    app.use('/api/blocked-slots', blockedSlotRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
    // Formas de pagamento ativas (o /custom valida a forma escolhida).
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

const ALL = allPermissionKeys() as string[];
const allExcept = (...keys: string[]) => ALL.filter(k => !keys.includes(k));

// ─── Datas (relógio real, calendário de São Paulo) ──────
const todaySp = saoPauloParts(new Date()).dateStr;
const dbDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const dow = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
const isWeekday = (ymd: string) => dow(ymd) >= 1 && dow(ymd) <= 5;
/** n-ésimo dia útil (seg–sex, faixa COMERCIAL) a partir de hoje + 3 dias (n = 0, 1, 2…). */
function weekdayN(n: number): string {
    let found = -1;
    for (let d = addDaysYmd(todaySp, 3); ; d = addDaysYmd(d, 1)) {
        if (isWeekday(d) && ++found === n) return d;
    }
}
/** Próxima data (≥ hoje + minDays) no dia da semana `wd` (0..6). */
function nextDow(wd: number, minDays: number): string {
    let d = addDaysYmd(todaySp, minDays);
    while (dow(d) !== wd) d = addDaysYmd(d, 1);
    return d;
}
const SLOT_TIMES = ['10:00', '13:00', '15:30'];

// ─── Fixtures ───────────────────────────────────────────

/** Cliente + FLEX ativo + gravação CONFIRMED futura (dia útil `n`, horário `time`). */
async function seedFlexBooking(n = 0, time = '10:00', over: Record<string, unknown> = {}) {
    const client = await mkUser();
    const contract = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 12, flexCreditsRemaining: 5 });
    const date = weekdayN(n);
    const [h, m] = time.split(':').map(Number);
    const end = `${String(h! + 2).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const booking = await mkBooking(client.id, contract.id, {
        date: dbDate(date), startTime: time, endTime: end, status: 'CONFIRMED', price: 12345, ...over,
    });
    return { client, contract, booking, date };
}

/** Avulso ATIVO de ontem, pago, com a gravação no status pedido (NAO_REALIZADO → a equipe pode remarcar). */
async function seedAvulsoMissed(status: 'NAO_REALIZADO' | 'CONFIRMED' = 'NAO_REALIZADO') {
    const client = await mkUser();
    const yesterday = addDaysYmd(todaySp, -1);
    const contract = await mkContract(client.id, {
        type: 'AVULSO', durationMonths: 1, discountPct: 0, startDate: dbDate(yesterday), endDate: dbDate(yesterday),
        paymentPlan: 'FULL', flexCreditsTotal: 1, flexCreditsRemaining: status === 'NAO_REALIZADO' ? 1 : 0,
    });
    const booking = await mkBooking(client.id, contract.id, {
        date: dbDate(yesterday), startTime: '10:00', endTime: '12:00', tierApplied: 'COMERCIAL', status,
    });
    await mkPayment(client.id, { contractId: contract.id, bookingId: booking.id, status: 'PAID', amount: 30000, paidAt: new Date() });
    return { client, contract, booking };
}

// ─── 1. Tabela da verdade ───────────────────────────────

type Req = {
    method: string;
    path: string;
    body?: unknown;
    /** Estado das fixtures que o CLIENTE estranho (rota mista) NÃO pode mudar — lido antes e depois (QT-02). */
    state?: () => Promise<unknown>;
};
interface Row {
    name: string;
    /** 'staff' = só equipe; 'admin' = só ADMIN; 'mixed' = cliente + equipe. */
    kind: 'staff' | 'admin' | 'mixed';
    /** Conjunto MÍNIMO de permissões que libera a rota (o COLABORADOR "com permissão" recebe só isso). */
    grant: string[];
    /** Chaves retiradas do COLABORADOR "sem permissão" (ele recebe TODAS as outras do catálogo). */
    deny: string[];
    /** Status de sucesso esperado para a equipe autorizada. */
    ok: number;
    /**
     * Rota mista: status EXATO do CLIENTE da sonda — um cliente qualquer, NUNCA o dono da fixture (QT-02):
     * 404 nas rotas com id de recurso; nas que ignoram o `userId` do corpo, o ramo dele (cria/simula para si).
     */
    stranger?: number;
    /** Fixtures NOVAS a cada chamada (k = 0..3 — varia data/horário quando a rota cria algo). */
    build: (k: number) => Promise<Req>;
}

/** Sessão, saldo do contrato e cobranças da sessão (o que um cancelamento/remarcação alheio mudaria). */
async function bookingState(bookingId: string) {
    const booking = await prisma.booking.findUniqueOrThrow({
        where: { id: bookingId },
        select: { status: true, date: true, startTime: true, makeupStatus: true, contractId: true },
    });
    const contract = booking.contractId
        ? await prisma.contract.findUniqueOrThrow({ where: { id: booking.contractId }, select: { status: true, flexCreditsRemaining: true } })
        : null;
    const payments = await prisma.payment.findMany({ where: { bookingId }, orderBy: { id: 'asc' }, select: { id: true, status: true } });
    return { booking, contract, payments };
}
/** Contratos e sessões de um cliente (o estranho não cria nada em nome dele). */
const clientState = async (userId: string) => ({
    contracts: await prisma.contract.findMany({ where: { userId }, orderBy: { id: 'asc' }, select: { id: true, status: true } }),
    bookings: await prisma.booking.findMany({ where: { userId }, orderBy: { id: 'asc' }, select: { id: true, status: true } }),
});
/** Amanhã (SP): o único início que o personalizado do CLIENTE aceita (D7); a equipe também pode usá-lo. */
const tomorrowSp = addDaysYmd(todaySp, 1);

const ROWS: Row[] = [
    // ── Agendamentos / Agenda ──
    {
        name: 'GET /api/bookings', kind: 'staff', grant: ['hoje.ver'], deny: ['agendamentos.ver', 'hoje.ver'], ok: 200,
        build: async () => ({ method: 'GET', path: '/api/bookings' }),
    },
    {
        name: 'POST /api/bookings/admin', kind: 'staff', grant: ['agendamentos.criar'], deny: ['agendamentos.criar'], ok: 201,
        build: async (k) => {
            const client = await mkUser();
            return { method: 'POST', path: '/api/bookings/admin', body: { userId: client.id, date: weekdayN(k), startTime: '10:00', status: 'RESERVED' } };
        },
    },
    {
        name: 'PATCH /api/bookings/:id (cancelar)', kind: 'staff', grant: ['agendamentos.cancelar'], deny: ['agendamentos.cancelar'], ok: 200,
        build: async (k) => {
            const { booking } = await seedFlexBooking(k);
            return { method: 'PATCH', path: `/api/bookings/${booking.id}`, body: { status: 'CANCELLED' } };
        },
    },
    {
        name: 'DELETE /api/bookings/:id/hard-delete', kind: 'staff', grant: ['agendamentos.excluir'], deny: ['agendamentos.excluir'], ok: 200,
        build: async (k) => {
            const { booking } = await seedFlexBooking(k);
            return { method: 'DELETE', path: `/api/bookings/${booking.id}/hard-delete` };
        },
    },
    {
        name: 'POST /api/bookings/cleanup-orphan-addons', kind: 'admin', grant: [], deny: [], ok: 200,
        build: async () => ({ method: 'POST', path: '/api/bookings/cleanup-orphan-addons' }),
    },
    {
        name: 'DELETE /api/bookings/:id (misto)', kind: 'mixed', grant: ['agendamentos.cancelar'], deny: ['agendamentos.cancelar'], ok: 200, stranger: 404,
        build: async (k) => {
            const { booking } = await seedFlexBooking(k);
            return { method: 'DELETE', path: `/api/bookings/${booking.id}`, state: () => bookingState(booking.id) };
        },
    },
    {
        name: 'PATCH /api/bookings/:id/makeup (misto)', kind: 'mixed', grant: ['agendamentos.faltas'], deny: ['agendamentos.faltas'], ok: 200, stranger: 404,
        build: async (k) => {
            const { booking } = await seedAvulsoMissed();
            return { method: 'PATCH', path: `/api/bookings/${booking.id}/makeup`, body: { date: weekdayN(0), startTime: SLOT_TIMES[k % 3] }, state: () => bookingState(booking.id) };
        },
    },
    // ── Hoje ──
    {
        name: 'PUT /api/bookings/:id/check-in', kind: 'staff', grant: ['hoje.presenca'], deny: ['hoje.presenca'], ok: 200,
        build: async (k) => {
            const { booking } = await seedFlexBooking(k, '10:00', { status: 'RESERVED' });
            return { method: 'PUT', path: `/api/bookings/${booking.id}/check-in` };
        },
    },
    {
        name: 'PUT /api/bookings/:id/start-recording', kind: 'staff', grant: ['hoje.gravacao'], deny: ['hoje.gravacao'], ok: 200,
        build: async (k) => {
            const { booking } = await seedFlexBooking(k, '10:00', { date: dbDate(todaySp) });
            return { method: 'PUT', path: `/api/bookings/${booking.id}/start-recording` };
        },
    },
    {
        name: 'PUT /api/bookings/:id/undo-start-recording', kind: 'staff', grant: ['hoje.gravacao'], deny: ['hoje.gravacao'], ok: 200,
        build: async (k) => {
            const { booking } = await seedFlexBooking(k, '10:00', { date: dbDate(todaySp), recordingStartedAt: new Date(Date.now() - 10 * 60_000) });
            return { method: 'PUT', path: `/api/bookings/${booking.id}/undo-start-recording` };
        },
    },
    {
        name: 'PUT /api/bookings/:id/complete', kind: 'staff', grant: ['hoje.gravacao'], deny: ['hoje.gravacao'], ok: 200,
        build: async (k) => {
            const { booking } = await seedFlexBooking(k, '10:00', { date: dbDate(todaySp), recordingStartedAt: new Date(Date.now() - 30 * 60_000) });
            return { method: 'PUT', path: `/api/bookings/${booking.id}/complete`, body: {} };
        },
    },
    // ── Bloqueios de horário ──
    {
        name: 'POST /api/blocked-slots', kind: 'staff', grant: ['agendamentos.editar'], deny: ['agendamentos.editar'], ok: 201,
        build: async (k) => ({ method: 'POST', path: '/api/blocked-slots', body: { date: weekdayN(k), startTime: '10:00', endTime: '12:00', reason: 'Manutenção' } }),
    },
    {
        name: 'GET /api/blocked-slots', kind: 'staff', grant: ['agendamentos.ver'], deny: ['agendamentos.ver'], ok: 200,
        build: async () => ({ method: 'GET', path: '/api/blocked-slots' }),
    },
    {
        name: 'DELETE /api/blocked-slots/:id', kind: 'staff', grant: ['agendamentos.editar'], deny: ['agendamentos.editar'], ok: 200,
        build: async (k) => {
            const owner = await mkUser({ role: 'ADMIN' });
            const slot = await mkBlockedSlot(owner.id, { date: dbDate(weekdayN(k)) });
            return { method: 'DELETE', path: `/api/blocked-slots/${slot.id}` };
        },
    },
    // ── Contratos ──
    {
        name: 'POST /api/contracts', kind: 'staff', grant: ['contratos.criar'], deny: ['contratos.criar'], ok: 201,
        build: async (k) => {
            const client = await mkUser();
            return {
                method: 'POST', path: '/api/contracts',
                body: { userId: client.id, name: `Plano ${k}`, type: 'FLEX', tier: 'COMERCIAL', durationMonths: 3, startDate: weekdayN(k), paymentMethod: 'PIX' },
            };
        },
    },
    {
        name: 'GET /api/contracts', kind: 'staff', grant: ['agendamentos.criar'], deny: ['contratos.ver', 'agendamentos.criar'], ok: 200,
        build: async () => ({ method: 'GET', path: '/api/contracts' }),
    },
    {
        name: 'GET /api/contracts/:id (misto)', kind: 'mixed', grant: ['contratos.ver'], deny: ['contratos.ver'], ok: 200, stranger: 404,
        build: async () => {
            const owner = await mkUser();
            const c = await mkContract(owner.id);
            return { method: 'GET', path: `/api/contracts/${c.id}` };
        },
    },
    {
        name: 'PATCH /api/contracts/:id (link)', kind: 'staff', grant: ['contratos.editar'], deny: ['contratos.editar'], ok: 200,
        build: async () => {
            const owner = await mkUser();
            const c = await mkContract(owner.id);
            return { method: 'PATCH', path: `/api/contracts/${c.id}`, body: { contractUrl: 'https://exemplo.com/contrato.pdf' } };
        },
    },
    {
        name: 'DELETE /api/contracts/:id', kind: 'staff', grant: ['contratos.cancelar'], deny: ['contratos.cancelar'], ok: 200,
        build: async () => {
            const owner = await mkUser();
            const c = await mkContract(owner.id);
            return { method: 'DELETE', path: `/api/contracts/${c.id}` };
        },
    },
    {
        name: 'POST /api/contracts/:id/resolve-cancellation', kind: 'staff', grant: ['contratos.multa'], deny: ['contratos.multa'], ok: 200,
        build: async () => {
            const owner = await mkUser();
            const c = await mkContract(owner.id, { status: 'PENDING_CANCELLATION' });
            return { method: 'POST', path: `/api/contracts/${c.id}/resolve-cancellation`, body: { action: 'WAIVE_FEE' } };
        },
    },
    {
        // MAT-01 (X3): renovar exige contratos.criar E cobrancas.baixa (requireAllPermissions).
        name: 'POST /api/contracts/:id/renew', kind: 'staff', grant: ['contratos.criar', 'cobrancas.baixa'], deny: ['contratos.criar'], ok: 201,
        build: async () => {
            const owner = await mkUser();
            const c = await mkContract(owner.id);
            return { method: 'POST', path: `/api/contracts/${c.id}/renew`, body: {} };
        },
    },
    {
        name: 'PATCH /api/contracts/:id/pause', kind: 'staff', grant: ['contratos.editar'], deny: ['contratos.editar'], ok: 200,
        build: async () => {
            const owner = await mkUser();
            const c = await mkContract(owner.id);
            return { method: 'PATCH', path: `/api/contracts/${c.id}/pause`, body: { reason: 'Férias' } };
        },
    },
    {
        name: 'PATCH /api/contracts/:id/resume', kind: 'staff', grant: ['contratos.editar'], deny: ['contratos.editar'], ok: 200,
        build: async () => {
            const owner = await mkUser();
            const c = await mkContract(owner.id, { status: 'PAUSED', pausedAt: new Date(Date.now() - 3 * 86_400_000) });
            return { method: 'PATCH', path: `/api/contracts/${c.id}/resume` };
        },
    },
    {
        // Início amanhã (o do cliente — D7). O estranho manda o `userId` de outro cliente, mas o ramo do
        // cliente o ignora: cria o personalizado para SI (201) e o cliente do corpo continua sem nada.
        name: 'POST /api/contracts/custom (misto)', kind: 'mixed', grant: ['contratos.criar'], deny: ['contratos.criar'], ok: 201, stranger: 201,
        build: async (k) => {
            const client = await mkUser();
            const wd = 1 + k; // seg..qui: duas criações no mesmo teste nunca disputam o mesmo horário
            return {
                method: 'POST', path: '/api/contracts/custom',
                body: {
                    userId: client.id, name: 'Personalizado', tier: 'COMERCIAL', durationMonths: 1, paymentMethod: 'CARTAO',
                    paymentPlan: 'MONTHLY', schedule: [{ day: wd, time: '10:00' }], startDate: tomorrowSp,
                },
                state: () => clientState(client.id),
            };
        },
    },
    {
        name: 'POST /api/contracts/custom/check (misto)', kind: 'mixed', grant: ['contratos.criar'], deny: ['contratos.criar'], ok: 200, stranger: 200,
        build: async () => {
            const client = await mkUser();
            return {
                method: 'POST', path: '/api/contracts/custom/check',
                body: { userId: client.id, tier: 'COMERCIAL', durationMonths: 1, startDate: tomorrowSp, schedule: [{ day: 2, time: '10:00' }] },
                state: () => clientState(client.id),
            };
        },
    },
];

describe('Tabela da verdade — rotas da equipe em Agenda, Hoje, bloqueios e Contratos', () => {
    for (const row of ROWS) {
        it(row.name, async () => {
            // CLIENTE (um cliente qualquer, nunca dono da fixture)
            const client = await mkUser();
            const r0 = await row.build(0);
            const before = await r0.state?.();
            const asClient = await call(r0.method, r0.path, client, r0.body);
            if (row.kind === 'mixed') {
                // QT-02: status EXATO do estranho (um 200 num recurso alheio é IDOR) e nada muda na fixture.
                expect(row.stranger, `${row.name}: linha mista sem o status do cliente estranho`).toBeDefined();
                expect(asClient.status, `cliente estranho: ${JSON.stringify(asClient.body)}`).toBe(row.stranger);
                expect(await r0.state?.(), 'cliente estranho: estado da fixture intacto').toEqual(before);
            } else {
                expect(asClient.status, JSON.stringify(asClient.body)).toBe(403);
                expect(asClient.body.code).toBe('PERMISSION_DENIED');
            }

            // COLABORADOR sem a permissão (com TODAS as outras do catálogo)
            const without = await mkStaff({ permissions: row.kind === 'admin' ? ALL : allExcept(...row.deny) });
            const r1 = await row.build(1);
            const denied = await call(r1.method, r1.path, without, r1.body);
            expect(denied.status, JSON.stringify(denied.body)).toBe(403);
            expect(denied.body.code).toBe('PERMISSION_DENIED');
            if (row.kind === 'admin') expect(denied.body.permission).toBe('ADMIN');

            // COLABORADOR só com a permissão mínima
            if (row.kind !== 'admin') {
                const withPerm = await mkStaff({ permissions: row.grant });
                const r2 = await row.build(2);
                const allowed = await call(r2.method, r2.path, withPerm, r2.body);
                expect(allowed.status, JSON.stringify(allowed.body)).not.toBe(403);
                expect(allowed.status, JSON.stringify(allowed.body)).toBe(row.ok);
            }

            // ADMIN
            const admin = await mkUser({ role: 'ADMIN' });
            const r3 = await row.build(3);
            const asAdmin = await call(r3.method, r3.path, admin, r3.body);
            expect(asAdmin.status, JSON.stringify(asAdmin.body)).not.toBe(403);
            expect(asAdmin.status, JSON.stringify(asAdmin.body)).toBe(row.ok);
        });
    }
});

describe('Autoatendimento só do CLIENTE (S5)', () => {
    const SELF: Req[] = [
        { method: 'POST', path: '/api/bookings', body: {} },
        { method: 'POST', path: '/api/bookings/bulk', body: {} },
        { method: 'POST', path: '/api/contracts/self', body: {} },
        { method: 'POST', path: '/api/contracts/service', body: {} },
    ];
    for (const r of SELF) {
        it(`${r.method} ${r.path}: ADMIN e COLABORADOR (com tudo) → 403; CLIENTE passa da guarda`, async () => {
            const admin = await mkUser({ role: 'ADMIN' });
            const colab = await mkStaff({ permissions: ALL });
            const client = await mkUser();
            for (const who of [admin, colab]) {
                const res = await call(r.method, r.path, who, r.body);
                expect(res.status, JSON.stringify(res.body)).toBe(403);
                expect(res.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'CLIENTE' });
            }
            const asClient = await call(r.method, r.path, client, r.body);
            expect(asClient.status).not.toBe(403);
            expect(asClient.status).toBe(400); // corpo vazio → validação (passou da guarda)
        });
    }

    it('POST /contracts/custom pela equipe sem userId → 400 CLIENT_REQUIRED (nunca para a própria conta)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const r = await call('POST', '/api/contracts/custom', admin, {
            name: 'Meu plano', tier: 'COMERCIAL', durationMonths: 1, paymentMethod: 'CARTAO', paymentPlan: 'MONTHLY',
            schedule: [{ day: 2, time: '10:00' }], startDate: nextDow(2, 2),
        });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('CLIENT_REQUIRED');
        expect(await prisma.contract.count()).toBe(0);
    });

    it('alvo que não é CLIENTE (conta da equipe) → 404 em /bookings/admin, /contracts e /contracts/custom', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const colab = await mkStaff({ permissions: ['agendamentos.ver'] });
        for (const target of [admin, colab]) {
            const b = await call('POST', '/api/bookings/admin', admin, { userId: target.id, date: weekdayN(0), startTime: '10:00', status: 'RESERVED' });
            expect(b.status, JSON.stringify(b.body)).toBe(404);
            const c = await call('POST', '/api/contracts', admin, { userId: target.id, name: 'X', type: 'FLEX', tier: 'COMERCIAL', durationMonths: 3, startDate: weekdayN(0) });
            expect(c.status, JSON.stringify(c.body)).toBe(404);
            const cu = await call('POST', '/api/contracts/custom', admin, {
                userId: target.id, name: 'X', tier: 'COMERCIAL', durationMonths: 1, paymentMethod: 'CARTAO', paymentPlan: 'MONTHLY',
                schedule: [{ day: 2, time: '10:00' }], startDate: nextDow(2, 2),
            });
            expect(cu.status, JSON.stringify(cu.body)).toBe(404);
        }
        expect(await prisma.booking.count()).toBe(0);
        expect(await prisma.contract.count()).toBe(0);
    });

    it('POST /bookings/admin com o plano de OUTRO cliente → 404 (o desconto alheio não entra no preço)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const other = await mkUser();
        const otherPlan = await mkContract(other.id, { discountPct: 40 });
        const r = await call('POST', '/api/bookings/admin', admin, { userId: client.id, contractId: otherPlan.id, date: weekdayN(0), startTime: '10:00' });
        expect(r.status).toBe(404);
        expect(await prisma.booking.count()).toBe(0);
    });
});

// ─── 2. F1 — POST /bookings/admin nunca nasce PAGO sem cobrancas.baixa (D3/D7) ──

const RECEPCAO = ['agendamentos.ver', 'agendamentos.criar', 'agendamentos.editar', 'agendamentos.faltas', 'agendamentos.cancelar', 'hoje.ver', 'hoje.presenca', 'clientes.ver', 'clientes.criar', 'clientes.editar', 'contratos.ver', 'contratos.criar', 'cobrancas.cobrar', 'cupons.ver'];

describe('F1 — agendamento criado pela equipe sem a baixa manual', () => {
    it('"Confirmado" vira RESERVED com o pagamento PENDING (não 403) e a resposta informa', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const r = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(0), startTime: '10:00', status: 'CONFIRMED' });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.booking.status).toBe('RESERVED');
        expect(r.body.downgraded).toBe(true);
        expect(r.body.notice).toMatch(/aguardando pagamento/);
        const pay = await prisma.payment.findUniqueOrThrow({ where: { id: r.body.paymentId } });
        expect(pay.status).toBe('PENDING');
        expect(pay.paidAt).toBeNull();

        // Sem `status` no corpo (o schema assume CONFIRMED) → também rebaixa.
        const r2 = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(1), startTime: '10:00' });
        expect(r2.status).toBe(201);
        expect(r2.body.booking.status).toBe('RESERVED');
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: r2.body.paymentId } })).status).toBe('PENDING');

        // Pedindo RESERVED de propósito: nada a rebaixar.
        const r3 = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(2), startTime: '10:00', status: 'RESERVED' });
        expect(r3.status).toBe(201);
        expect(r3.body.downgraded).toBe(false);
    });

    it('com cobrancas.baixa (e o ADMIN) o "Confirmado" continua nascendo pago', async () => {
        const fin = await mkStaff({ permissions: ['agendamentos.criar', 'cobrancas.baixa'] });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        for (const [i, who] of [fin, admin].entries()) {
            const r = await call('POST', '/api/bookings/admin', who, { userId: client.id, date: weekdayN(i), startTime: '10:00', status: 'CONFIRMED' });
            expect(r.status, JSON.stringify(r.body)).toBe(201);
            expect(r.body.booking.status).toBe('CONFIRMED');
            expect(r.body.downgraded).toBe(false);
            expect((await prisma.payment.findUniqueOrThrow({ where: { id: r.body.paymentId } })).status).toBe('PAID');
        }
    });

    it('customPrice diferente do preço da faixa (inclusive 0) → 403 cobrancas.baixa, nada é criado; igual ao padrão → 201', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const standard = await getBasePriceDynamic('COMERCIAL');
        for (const customPrice of [0, standard + 1000, Math.max(1, standard - 1000)]) {
            const r = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(0), startTime: '10:00', status: 'RESERVED', customPrice });
            expect(r.status, `customPrice=${customPrice}: ${JSON.stringify(r.body)}`).toBe(403);
            expect(r.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa' });
        }
        expect(await prisma.booking.count()).toBe(0);
        expect(await prisma.payment.count()).toBe(0);
        expect(await prisma.contract.count()).toBe(0);

        const same = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(0), startTime: '10:00', status: 'RESERVED', customPrice: standard });
        expect(same.status, JSON.stringify(same.body)).toBe(201);
        expect(same.body.booking.price).toBe(standard);
    });

    it('cupom 100% (valor final zero, liquidado como PAGO) → 403 cobrancas.baixa sem a baixa; com ela, 201 pago', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const coupon = await mkCoupon(admin.id, { discountType: 'PERCENTUAL', discountValue: 100 });
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const denied = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(0), startTime: '10:00', status: 'RESERVED', couponCode: coupon.code });
        expect(denied.status, JSON.stringify(denied.body)).toBe(403);
        expect(denied.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa' });
        expect(await prisma.booking.count()).toBe(0);
        expect(await prisma.couponRedemption.count()).toBe(0);

        const fin = await mkStaff({ permissions: [...RECEPCAO, 'cobrancas.baixa'] });
        const ok = await call('POST', '/api/bookings/admin', fin, { userId: client.id, date: weekdayN(0), startTime: '10:00', status: 'RESERVED', couponCode: coupon.code });
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: ok.body.paymentId } })).status).toBe('PAID');
    });

    it('o RESERVED criado pela equipe NÃO expira como o hold de 10 min do cliente', async () => {
        const recepcao = await mkStaff({ permissions: RECEPCAO });
        const client = await mkUser();
        const r = await call('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(0), startTime: '10:00' });
        expect(r.status).toBe(201);
        const booking = await prisma.booking.findUniqueOrThrow({ where: { id: r.body.booking.id }, include: { contract: true } });
        expect(booking.status).toBe('RESERVED');
        expect(booking.holdExpiresAt).toBeNull();
        expect(booking.contract!.status).toBe('ACTIVE');
        expect(booking.contract!.paymentDeadline).toBeNull();

        await cleanExpiredHolds();
        const after = await prisma.booking.findUnique({ where: { id: booking.id }, include: { contract: true } });
        expect(after?.status).toBe('RESERVED');
        expect(after?.contract?.status).toBe('ACTIVE');
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: r.body.paymentId } })).status).toBe('PENDING');
    });
});

describe('F1 (contratos) — criação pela equipe com parcela zerada exige cobrancas.baixa', () => {
    it('POST /contracts com cupom 100% sem a baixa → 403 e NADA fica gravado; com a baixa → 201', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const coupon = await mkCoupon(admin.id, { discountType: 'PERCENTUAL', discountValue: 100 });
        const colab = await mkStaff({ permissions: ['contratos.ver', 'contratos.criar'] });
        const client = await mkUser();
        const body = { userId: client.id, name: 'Plano', type: 'FLEX', tier: 'COMERCIAL', durationMonths: 3, startDate: weekdayN(0), paymentMethod: 'PIX', couponCode: coupon.code };
        const denied = await call('POST', '/api/contracts', colab, body);
        expect(denied.status, JSON.stringify(denied.body)).toBe(403);
        expect(denied.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa' });
        expect(await prisma.contract.count()).toBe(0);
        expect(await prisma.payment.count()).toBe(0);

        const fin = await mkStaff({ permissions: ['contratos.ver', 'contratos.criar', 'cobrancas.baixa'] });
        const ok = await call('POST', '/api/contracts', fin, body);
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        expect(ok.body.contract.status).toBe('ACTIVE');
    });

    it('POST /contracts sem cupom: nasce ATIVO com as parcelas EM ABERTO (nunca AWAITING_PAYMENT)', async () => {
        const colab = await mkStaff({ permissions: ['contratos.ver', 'contratos.criar'] });
        const client = await mkUser();
        const r = await call('POST', '/api/contracts', colab, { userId: client.id, name: 'Plano', type: 'FLEX', tier: 'COMERCIAL', durationMonths: 3, startDate: weekdayN(0), paymentMethod: 'PIX' });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.contract.status).toBe('ACTIVE');
        expect(r.body.payments.length).toBeGreaterThan(0);
        expect(r.body.payments.every((p: any) => p.status === 'PENDING')).toBe(true);
    });

    it('POST /contracts/custom pela equipe com cupom 100% sem a baixa → 403 antes de gravar', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const coupon = await mkCoupon(admin.id, { discountType: 'PERCENTUAL', discountValue: 100, scope: 'ALL_INSTALLMENTS' });
        const colab = await mkStaff({ permissions: ['contratos.ver', 'contratos.criar'] });
        const client = await mkUser();
        const r = await call('POST', '/api/contracts/custom', colab, {
            userId: client.id, name: 'Personalizado', tier: 'COMERCIAL', durationMonths: 1, paymentMethod: 'CARTAO', paymentPlan: 'MONTHLY',
            schedule: [{ day: 2, time: '10:00' }], startDate: nextDow(2, 2), couponCode: coupon.code,
        });
        expect(r.status, JSON.stringify(r.body)).toBe(403);
        expect(r.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa' });
        expect(await prisma.contract.count()).toBe(0);
        expect(await prisma.booking.count()).toBe(0);
    });
});

// ─── 3. F2 — PATCH /bookings/:id por transição e por valor alterado ──

describe('F2 — PATCH /bookings/:id', () => {
    it('hoje.presenca confirma uma RESERVED, mas não reabre CANCELLED nem FALTA', async () => {
        const op = await mkStaff({ permissions: ['hoje.ver', 'hoje.presenca'] });
        const reserved = await seedFlexBooking(0, '10:00', { status: 'RESERVED' });
        const ok = await call('PATCH', `/api/bookings/${reserved.booking.id}`, op, { status: 'CONFIRMED' });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(ok.body.booking.status).toBe('CONFIRMED');

        for (const from of ['CANCELLED', 'FALTA'] as const) {
            const s = await seedFlexBooking(1, from === 'CANCELLED' ? '10:00' : '13:00', { status: from });
            const r = await call('PATCH', `/api/bookings/${s.booking.id}`, op, { status: 'CONFIRMED' });
            expect(r.status, JSON.stringify(r.body)).toBe(403);
            expect(r.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'agendamentos.editar' });
            expect((await prisma.booking.findUniqueOrThrow({ where: { id: s.booking.id } })).status).toBe(from);
        }
    });

    it('só agendamentos.cancelar salva pelo EditBookingModal (date/startTime iguais aos atuais) e o preço não muda', async () => {
        const colab = await mkStaff({ permissions: ['agendamentos.ver', 'agendamentos.cancelar'] });
        const { booking, date } = await seedFlexBooking(0, '10:00');
        const r = await call('PATCH', `/api/bookings/${booking.id}`, colab, { date, startTime: '10:00', status: 'CANCELLED' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
        expect(after.status).toBe('CANCELLED');
        expect(after.price).toBe(12345);

        // Mudar o horário de verdade continua exigindo agendamentos.editar.
        const other = await seedFlexBooking(1, '10:00');
        const moved = await call('PATCH', `/api/bookings/${other.booking.id}`, colab, { date: other.date, startTime: '13:00', status: 'CONFIRMED' });
        expect(moved.status).toBe(403);
        expect(moved.body.permission).toBe('agendamentos.editar');
    });

    it('só agendamentos.faltas registra a falta pelo modal completo sem mexer no preço (bug do recálculo com o mesmo horário)', async () => {
        const colab = await mkStaff({ permissions: ['agendamentos.ver', 'agendamentos.faltas'] });
        const { booking, date } = await seedFlexBooking(0, '10:00');
        const r = await call('PATCH', `/api/bookings/${booking.id}`, colab, { date, startTime: '10:00', status: 'FALTA', statusReason: 'Não compareceu' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
        expect(after.status).toBe('FALTA');
        expect(after.price).toBe(12345);
        expect(after.statusReason).toBe('Não compareceu');
    });

    it('sair de NAO_REALIZADO sem agendamentos.faltas → 403 e o crédito NÃO muda; com ela, desconta o crédito', async () => {
        const editor = await mkStaff({ permissions: ['agendamentos.ver', 'agendamentos.editar'] });
        const { booking, contract } = await seedFlexBooking(0, '10:00', { status: 'NAO_REALIZADO' });
        const before = (await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).flexCreditsRemaining;
        const r = await call('PATCH', `/api/bookings/${booking.id}`, editor, { status: 'CONFIRMED' });
        expect(r.status, JSON.stringify(r.body)).toBe(403);
        expect(r.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'agendamentos.faltas' });
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('NAO_REALIZADO');
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).flexCreditsRemaining).toBe(before);

        const full = await mkStaff({ permissions: ['agendamentos.ver', 'agendamentos.editar', 'agendamentos.faltas'] });
        const ok = await call('PATCH', `/api/bookings/${booking.id}`, full, { status: 'CONFIRMED' });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).flexCreditsRemaining).toBe(before! - 1);
    });

    it('COMPLETED: gravação iniciada → hoje.gravacao basta; sem início registrado exige agendamentos.editar', async () => {
        const op = await mkStaff({ permissions: ['hoje.ver', 'hoje.gravacao'] });
        const started = await seedFlexBooking(0, '10:00', { date: dbDate(todaySp), recordingStartedAt: new Date(Date.now() - 20 * 60_000) });
        const ok = await call('PATCH', `/api/bookings/${started.booking.id}`, op, { status: 'COMPLETED' });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);

        const notStarted = await seedFlexBooking(0, '13:00', { date: dbDate(todaySp) });
        const denied = await call('PATCH', `/api/bookings/${notStarted.booking.id}`, op, { status: 'COMPLETED' });
        expect(denied.status).toBe(403);
        expect(denied.body.permission).toBe('agendamentos.editar');

        // Notas e métricas: hoje.gravacao OU agendamentos.editar.
        const notes = await call('PATCH', `/api/bookings/${started.booking.id}`, op, { adminNotes: 'Áudio ok', durationMinutes: 95 });
        expect(notes.status, JSON.stringify(notes.body)).toBe(200);
    });

    it('a guarda da rota exige alguma ação de agendamento/Hoje (corpo vazio não serve para ler agendamento)', async () => {
        const viewer = await mkStaff({ permissions: ['agendamentos.ver', 'contratos.ver'] });
        const { booking } = await seedFlexBooking(0);
        const r = await call('PATCH', `/api/bookings/${booking.id}`, viewer, {});
        expect(r.status).toBe(403);
        expect(r.body.code).toBe('PERMISSION_DENIED');
    });
});

// ─── 4. F3 — contrato com pedido de cancelamento em análise ──

describe('F3 — PENDING_CANCELLATION exige contratos.multa; PATCH por valor alterado', () => {
    it('com contratos.cancelar/editar e SEM contratos.multa → 403 no DELETE e no PATCH (CANCELLED e ACTIVE); nada muda', async () => {
        const colab = await mkStaff({ permissions: ['contratos.ver', 'contratos.editar', 'contratos.cancelar'] });
        const owner = await mkUser();
        const c = await mkContract(owner.id, { status: 'PENDING_CANCELLATION' });
        const del = await call('DELETE', `/api/contracts/${c.id}`, colab);
        expect(del.status, JSON.stringify(del.body)).toBe(403);
        expect(del.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'contratos.multa' });
        for (const status of ['CANCELLED', 'ACTIVE']) {
            const p = await call('PATCH', `/api/contracts/${c.id}`, colab, { status });
            expect(p.status, `${status}: ${JSON.stringify(p.body)}`).toBe(403);
            expect(p.body.permission).toBe('contratos.multa');
        }
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('PENDING_CANCELLATION');

        const withFine = await mkStaff({ permissions: ['contratos.ver', 'contratos.cancelar', 'contratos.multa'] });
        const ok = await call('DELETE', `/api/contracts/${c.id}`, withFine);
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('CANCELLED');
    });

    it('com contratos.editar e SEM condicoes: reenviar endDate e os créditos ATUAIS → 200; mudar créditos ou boleto → 403', async () => {
        const colab = await mkStaff({ permissions: ['contratos.ver', 'contratos.editar'] });
        const owner = await mkUser();
        const c = await mkContract(owner.id, { type: 'FLEX', flexCreditsTotal: 12, flexCreditsRemaining: 7 });
        const endYmd = c.endDate.toISOString().slice(0, 10);
        const same = await call('PATCH', `/api/contracts/${c.id}`, colab, { endDate: endYmd, flexCreditsRemaining: 7, contractUrl: 'https://exemplo.com/c.pdf' });
        expect(same.status, JSON.stringify(same.body)).toBe(200);
        expect(same.body.contract.contractUrl).toBe('https://exemplo.com/c.pdf');

        const more = await call('PATCH', `/api/contracts/${c.id}`, colab, { endDate: endYmd, flexCreditsRemaining: 8 });
        expect(more.status).toBe(403);
        expect(more.body.permission).toBe('contratos.condicoes');
        const boleto = await call('PATCH', `/api/contracts/${c.id}`, colab, { boletoAllowed: true });
        expect(boleto.status).toBe(403);
        expect(boleto.body.permission).toBe('contratos.condicoes');
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).flexCreditsRemaining).toBe(7);

        // EXPIRED é edição (contratos.editar), não cancelamento.
        const expired = await call('PATCH', `/api/contracts/${c.id}`, colab, { status: 'EXPIRED' });
        expect(expired.status, JSON.stringify(expired.body)).toBe(200);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('EXPIRED');
    });

    it('cancelar pelo PATCH exige contratos.cancelar (editar não basta)', async () => {
        const colab = await mkStaff({ permissions: ['contratos.ver', 'contratos.editar', 'contratos.condicoes'] });
        const owner = await mkUser();
        const c = await mkContract(owner.id);
        const r = await call('PATCH', `/api/contracts/${c.id}`, colab, { status: 'CANCELLED' });
        expect(r.status).toBe(403);
        expect(r.body.permission).toBe('contratos.cancelar');
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('ACTIVE');
    });
});

// ─── 5. Avisos para a equipe (getStaffRecipientIds) ─────

async function waitFor(check: () => Promise<boolean>, ms = 3000): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (await check()) return;
        await new Promise(r => setTimeout(r, 50));
    }
}

describe('Avisos da equipe — só quem tem a permissão do evento, nunca desativado', () => {
    it('pedido de cancelamento: ADMIN + colaborador com contratos.multa; a decisão limpa o aviso de todos', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const withFine = await mkStaff({ permissions: ['contratos.ver', 'contratos.multa'] });
        const without = await mkStaff({ permissions: ['contratos.ver', 'contratos.cancelar'] });
        const blocked = await mkStaff({ permissions: ['contratos.ver', 'contratos.multa'], overrides: { clientStatus: 'BLOCKED' } });
        const client = await mkUser();
        const c = await mkContract(client.id);

        const req = await call('POST', `/api/contracts/${c.id}/request-cancellation`, client);
        expect(req.status, JSON.stringify(req.body)).toBe(200);
        const count = (userId: string) => prisma.notification.count({ where: { userId, type: 'CANCELLATION_PENDING', entityId: c.id } });
        expect(await count(admin.id)).toBe(1);
        expect(await count(withFine.id)).toBe(1);
        expect(await count(without.id)).toBe(0);
        expect(await count(blocked.id)).toBe(0);

        const resolved = await call('POST', `/api/contracts/${c.id}/resolve-cancellation`, withFine, { action: 'WAIVE_FEE' });
        expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
        expect(await count(admin.id)).toBe(0);
        expect(await count(withFine.id)).toBe(0);
    });

    it('cancelamento pelo cliente (> 24h): avisa quem tem hoje.ver; não avisa quem não tem nem o desativado', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const today = await mkStaff({ permissions: ['hoje.ver'] });
        const other = await mkStaff({ permissions: ['contratos.ver'] });
        const blocked = await mkStaff({ permissions: ['hoje.ver'], overrides: { clientStatus: 'BLOCKED' } });
        const { client, booking } = await seedFlexBooking(2, '10:00');
        const r = await call('PUT', `/api/bookings/${booking.id}/client-cancel`, client);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        const count = (userId: string) => prisma.notification.count({ where: { userId, type: 'BOOKING_CANCELLED', entityId: booking.id } });
        await waitFor(async () => (await count(admin.id)) > 0 && (await count(today.id)) > 0);
        expect(await count(admin.id)).toBe(1);
        expect(await count(today.id)).toBe(1);
        expect(await count(other.id)).toBe(0);
        expect(await count(blocked.id)).toBe(0);
    });

    it('remarcação do avulso pelo cliente: avisa a equipe com hoje.ver (menos quem remarcou)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const today = await mkStaff({ permissions: ['hoje.ver'] });
        const other = await mkStaff({ permissions: ['clientes.ver'] });
        const { client, booking } = await seedAvulsoMissed('CONFIRMED');
        // NÃO REALIZADO pelo estúdio abre a janela de remarcação (D5).
        const opened = await call('PATCH', `/api/bookings/${booking.id}`, admin, { status: 'NAO_REALIZADO', statusReason: 'Queda de energia' });
        expect(opened.status, JSON.stringify(opened.body)).toBe(200);
        const target = weekdayN(0);
        const m = await call('PATCH', `/api/bookings/${booking.id}/makeup`, client, { date: target, startTime: '13:00' });
        expect(m.status, JSON.stringify(m.body)).toBe(200);
        const count = (userId: string) => prisma.notification.count({ where: { userId, entityId: booking.id, title: 'Gravação remarcada' } });
        expect(await count(admin.id)).toBe(1);
        expect(await count(today.id)).toBe(1);
        expect(await count(other.id)).toBe(0);
    });
});

// ─── 6. Auditoria das ações irreversíveis / de agenda ───

describe('Auditoria', () => {
    it('exclusão definitiva e bloqueios de horário ficam na auditoria com quem fez', async () => {
        const colab = await mkStaff({ permissions: ['agendamentos.ver', 'agendamentos.editar', 'agendamentos.excluir'] });
        const { booking } = await seedFlexBooking(0);
        expect((await call('DELETE', `/api/bookings/${booking.id}/hard-delete`, colab)).status).toBe(200);
        const del = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'BOOKING', entityId: booking.id, action: 'HARD_DELETED' } });
        expect(del.performedBy).toBe(colab.id);

        const created = await call('POST', '/api/blocked-slots', colab, { date: weekdayN(1), startTime: '10:00', endTime: '12:00' });
        expect(created.status).toBe(201);
        const slotId = created.body.blockedSlot.id;
        expect((await call('DELETE', `/api/blocked-slots/${slotId}`, colab)).status).toBe(200);
        expect(await prisma.auditLog.count({ where: { entityType: 'BLOCKED_SLOT', entityId: slotId, performedBy: colab.id } })).toBe(2);
        expect((await call('DELETE', `/api/blocked-slots/${slotId}`, colab)).status).toBe(404);
    });
});
