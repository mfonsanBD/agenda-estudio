import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ─── Mocks dos provedores (Sicoob / Stripe) e do push: nenhuma chamada de rede real ─────────────
vi.mock('../../src/lib/sicoobService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/sicoobService')>();
    return {
        ...orig,
        getSicoobEnvironment: vi.fn(async () => 'production'),
        sicoobGetCob: vi.fn(),
        sicoobRemoveCob: vi.fn(async () => true),
        sicoobCreatePix: vi.fn(),
    };
});
vi.mock('../../src/lib/stripeService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/stripeService')>();
    return {
        ...orig,
        isStripeEnabled: vi.fn(async () => true),
        stripeGetPaymentIntent: vi.fn(),
        stripeCancelPaymentIntent: vi.fn(async () => ({ status: 'canceled', canceled: true })),
        stripeCancelSubscription: vi.fn(async () => {}),
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
import type { Prisma } from '../../src/generated/prisma/client';
import { config } from '../../src/config/index';
import { saoPauloParts } from '../../src/lib/spTime';
import * as push from '../../src/modules/push/pushService';
import { invalidateConfigCache } from '../../src/lib/businessConfig';
import { invalidateTemplateCache } from '../../src/modules/notifications/templateStore';
import { notifyEvent } from '../../src/modules/notifications/notificationService';
import notificationRoutes from '../../src/modules/notifications/routes';
import { runPushNotificationJob } from '../../src/jobs/pushNotificationJob';
import { runAvulsoMakeupExpiryJob } from '../../src/jobs/avulsoMakeupExpiryJob';
import { alertDoubleCardCharge } from '../../src/jobs/autoChargeJob';
import { alertPaymentOnCancelledCharge } from '../../src/lib/paymentEffects';
import { getStaffRecipientIds } from '../../src/lib/staffRecipients';
import { normalizePermissions } from '../../src/config/staffPermissions';
import { NOTIFICATION_EVENT_BY_KEY } from '../../src/config/notificationEventCatalog';
import { mkUser, mkStaff, mkContract, mkPayment, mkBooking } from './factories';

// Frente B4 (equipe, 04/11/2026) — notificações e jobs para a equipe (proposta §4.9, crítica S1/I3, D4):
//  • todo aviso de audiência "admin" vai para ADMIN + COLABORADOR com a permissão do evento
//    (STAFF_EVENT_PERMISSIONS), nunca para conta desativada (BLOCKED) ou excluída;
//  • os alertas calculados do sino (GET /api/notifications) seguem as permissões, e o link de cada um
//    abre uma tela que a permissão libera (contrato → /admin/contracts/:id);
//  • o push job ignora desativados/excluídos e aplica as mesmas permissões;
//  • aviso guardado cujo link o colaborador não abre mais (permissão retirada) sai do sino dele.

type Who = { id: string; email: string | null; role: string };

const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const sendPush = m(push.sendPushToUser);

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/notifications', notificationRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    vi.clearAllMocks();
    sendPush.mockResolvedValue(1);
    invalidateConfigCache();
    invalidateTemplateCache();
});

function cookie(u: Who) {
    return `accessToken=${jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' })}`;
}

async function call(baseUrl: string, method: string, path: string, who?: Who, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            ...(who ? { Cookie: cookie(who) } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

/** Data-calendário de SP (hoje + n dias) como meia-noite UTC — o formato de Booking.date / dueDate. */
function spDay(n: number): Date {
    const d = new Date(`${saoPauloParts(new Date()).dateStr}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
}

/** Colaborador com as permissões já normalizadas (dependências marcadas, como a tela Equipe grava). */
const colab = (permissions: string[], overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) =>
    mkStaff({ permissions: normalizePermissions(permissions).permissions, overrides });
const blocked = { clientStatus: 'BLOCKED' as const };
const deleted = () => ({ deletedAt: new Date() });

/** Tela da área administrativa → permissão que a abre (as guardas de rota do front, proposta §4.8). */
const SCREEN: ReadonlyArray<[string, string]> = [
    ['/admin/today', 'hoje.ver'], ['/admin/bookings', 'agendamentos.ver'], ['/admin/clients', 'clientes.ver'],
    ['/admin/contracts', 'contratos.ver'], ['/admin/finance', 'financeiro.ver'],
];
function opensFor(permissions: readonly string[], url: string | null | undefined): boolean {
    if (!url) return false;
    const screen = SCREEN.find(([prefix]) => url === prefix || url.startsWith(`${prefix}/`));
    return !!screen && permissions.includes(screen[1]);
}

const notesOf = (userId: string, where: Record<string, unknown> = {}) =>
    prisma.notification.findMany({ where: { userId, ...where }, orderBy: { createdAt: 'asc' } });
const pushedTo = () => sendPush.mock.calls.map(c => c[0] as string);

// ═══ 1) Destinatários dos avisos persistidos ═════════════════════════════════════════════════════
describe('getStaffRecipientIds: ADMIN + COLABORADOR com a permissão do evento, nunca desativado/excluído', () => {
    it('admin_cancellation_requested → admin e quem tem contratos.multa; não o colaborador sem ela, o desativado, o excluído nem o cliente', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const adminBlocked = await mkUser({ role: 'ADMIN', ...blocked });
        const comMulta = await colab(['contratos.multa']);
        const semMulta = await colab(['contratos.ver', 'contratos.editar', 'contratos.cancelar']);
        const desativado = await colab(['contratos.multa'], blocked);
        const excluido = await colab(['contratos.multa'], deleted());
        await mkUser(); // cliente

        const ids = await getStaffRecipientIds('admin_cancellation_requested');
        expect(ids.sort()).toEqual([admin.id, comMulta.id].sort());
        expect(ids).not.toContain(adminBlocked.id);
        expect(ids).not.toContain(semMulta.id);
        expect(ids).not.toContain(desativado.id);
        expect(ids).not.toContain(excluido.id);
    });
});

describe('admin_cancellation_requested (pedido de cancelamento do cliente) chega a quem decide a multa', () => {
    it('colaborador com contratos.multa recebe (persistida + push); sem ela, desativado e excluído não', async () => {
        // O router de contratos é de outra frente: importado aqui para uma falha nele não derrubar o arquivo inteiro.
        const { default: contractRoutes } = await import('../../src/modules/contracts/routes');
        const app = express();
        app.use(express.json());
        app.use(cookieParser());
        app.use('/api/contracts', contractRoutes);
        let contractsServer!: Server;
        await new Promise<void>((resolve) => { contractsServer = app.listen(0, () => resolve()); });
        const contractsBase = `http://127.0.0.1:${(contractsServer.address() as AddressInfo).port}`;
        try {
            const admin = await mkUser({ role: 'ADMIN' });
            const comMulta = await colab(['contratos.multa']);
            const semMulta = await colab(['contratos.ver', 'contratos.editar', 'contratos.cancelar']);
            const desativado = await colab(['contratos.multa'], blocked);
            const excluido = await colab(['contratos.multa'], deleted());
            const client = await mkUser({ name: 'Cliente Cancelamento' });
            const contract = await mkContract(client.id, { type: 'FIXO', paymentMethod: 'PIX', startDate: spDay(-20), endDate: spDay(64) });
            await mkPayment(client.id, { contractId: contract.id, amount: 84000, status: 'PAID', paidAt: new Date(), dueDate: spDay(-20) });
            await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(8) });
            await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(36) });

            const r = await call(contractsBase, 'POST', `/api/contracts/${contract.id}/request-cancellation`, client);
            expect(r.status).toBe(200);

            const kind = { type: 'CANCELLATION_PENDING' as const, entityId: contract.id };
            for (const who of [admin, comMulta]) {
                const notes = await notesOf(who.id, kind);
                expect(notes, who.id === admin.id ? 'admin' : 'colaborador com contratos.multa').toHaveLength(1);
                expect(notes[0]).toMatchObject({ entityType: 'CONTRACT', actionUrl: '/admin/contracts', pushSent: true });
                expect(notes[0].message).toContain('Cliente Cancelamento');
            }
            for (const who of [semMulta, desativado, excluido]) {
                expect(await notesOf(who.id, kind)).toHaveLength(0);
            }
            expect(pushedTo().sort()).toEqual([admin.id, comMulta.id].sort());
        } finally {
            await new Promise<void>((resolve) => contractsServer.close(() => resolve()));
        }
    });
});

describe('avisos de dinheiro (persistidos + push) vão para quem vê o financeiro', () => {
    async function staffSet() {
        const admin = await mkUser({ role: 'ADMIN' });
        const fin = await colab(['financeiro.ver']);
        const finDesativado = await colab(['financeiro.ver'], blocked);
        const finExcluido = await colab(['financeiro.ver'], deleted());
        const soCobra = await colab(['cobrancas.cobrar', 'cobrancas.baixa', 'contratos.ver']);
        const client = await mkUser({ name: 'Cliente Dinheiro' });
        const contract = await mkContract(client.id, { type: 'FIXO', name: 'Plano X' });
        return { admin, fin, finDesativado, finExcluido, soCobra, client, contract };
    }

    it('admin_payment_on_cancelled_charge: admin + financeiro.ver; desativado, excluído e quem só cobra ficam de fora', async () => {
        const s = await staffSet();
        const cancelled = await mkPayment(s.client.id, { contractId: s.contract.id, status: 'CANCELLED', amount: 42000 });

        expect(await alertPaymentOnCancelledCharge(cancelled.id, { provider: 'SICOOB', providerRef: 'tx-1' })).toBe(true);

        for (const who of [s.admin, s.fin]) {
            const notes = await notesOf(who.id, { entityId: cancelled.id });
            expect(notes).toHaveLength(1);
            expect(notes[0]).toMatchObject({ type: 'SYSTEM', severity: 'critical', actionUrl: '/admin/finance', pushSent: true });
            expect(notes[0].message).toContain('R$ 420,00');
        }
        for (const who of [s.finDesativado, s.finExcluido, s.soCobra]) {
            expect(await notesOf(who.id)).toHaveLength(0);
        }
        expect(pushedTo().sort()).toEqual([s.admin.id, s.fin.id].sort());
    });

    it('admin_card_double_charge: admin + financeiro.ver; desativado não recebe push', async () => {
        const s = await staffSet();
        const paid = await mkPayment(s.client.id, {
            contractId: s.contract.id, provider: 'STRIPE', providerRef: 'pi_pago', status: 'PAID', paidAt: new Date(), amount: 84000,
        });

        expect(await alertDoubleCardCharge(paid.id, { extraPi: 'pi_extra' })).toBe(true);

        for (const who of [s.admin, s.fin]) {
            const notes = await notesOf(who.id, { entityId: paid.id });
            expect(notes).toHaveLength(1);
            expect(notes[0]).toMatchObject({ title: 'Cobrança em dobro no cartão', actionUrl: '/admin/finance', pushSent: true });
        }
        for (const who of [s.finDesativado, s.finExcluido, s.soCobra]) {
            expect(await notesOf(who.id)).toHaveLength(0);
        }
        expect(pushedTo()).not.toContain(s.finDesativado.id);
        expect(pushedTo().sort()).toEqual([s.admin.id, s.fin.id].sort());
    });
});

// ═══ 2) Sino: alertas calculados por permissão + links que a permissão abre ═══════════════════════
describe('GET /api/notifications — alertas calculados da equipe seguem as permissões', () => {
    async function seedBell() {
        const client = await mkUser({ name: 'Cliente Sino' });
        const expiring = await mkContract(client.id, { type: 'FIXO', name: 'Plano Expirando', startDate: spDay(-60), endDate: spDay(3) });
        const pendingCancel = await mkContract(client.id, { type: 'FIXO', name: 'Plano em Análise', status: 'PENDING_CANCELLATION', startDate: spDay(-30), endDate: spDay(60) });
        const awaiting = await mkContract(client.id, {
            type: 'FIXO', name: 'Plano Aguardando', status: 'AWAITING_PAYMENT', startDate: spDay(1), endDate: spDay(90),
            paymentDeadline: new Date(Date.now() + 3 * 3600_000),
        });
        await mkPayment(client.id, { contractId: expiring.id, amount: 50000, dueDate: spDay(-5) });
        const failed = await mkPayment(client.id, { contractId: expiring.id, provider: 'STRIPE', status: 'FAILED', amount: 30000, dueDate: spDay(10) });
        const reserved = await mkBooking(client.id, expiring.id, { date: spDay(0), startTime: '22:00', endTime: '23:59', status: 'RESERVED' });
        return {
            client,
            ids: {
                expiring: `contract-expiring-${expiring.id}`,
                pendingCancel: `cancellation-pending-${pendingCancel.id}`,
                awaiting: `contract-awaiting-${awaiting.id}`,
                overdue: `payment-overdue-${client.id}`,
                failed: `payment-failed-${failed.id}`,
                unconfirmed: `booking-unconfirmed-${reserved.id}`,
            },
            links: {
                expiring: `/admin/contracts/${expiring.id}`,
                pendingCancel: '/admin/contracts',
                awaiting: `/admin/contracts/${awaiting.id}`,
                overdue: '/admin/finance',
                failed: '/admin/finance',
                unconfirmed: '/admin/today',
            },
        };
    }

    const computedOf = async (who: Who) => {
        const r = await call(base, 'GET', '/api/notifications', who);
        expect(r.status).toBe(200);
        return (r.body.notifications as any[]).filter(n => n.source === 'computed');
    };

    it('ADMIN vê todos os alertas da equipe, com o contrato apontando para /admin/contracts/:id', async () => {
        const { ids, links } = await seedBell();
        const admin = await mkUser({ role: 'ADMIN' });

        const list = await computedOf(admin);
        const byId = new Map(list.map(n => [n.id, n]));
        expect([...byId.keys()].sort()).toEqual(Object.values(ids).sort());
        for (const k of Object.keys(ids) as (keyof typeof ids)[]) {
            expect(byId.get(ids[k])!.actionUrl, k).toBe(links[k]);
        }
        expect(byId.get(ids.expiring)!.message).toContain('Cliente Sino');
    });

    it('COLABORADOR vê só os alertas da sua permissão, e todo link abre com ela', async () => {
        const { ids } = await seedBell();
        const cases: Array<{ perms: string[]; expected: (keyof typeof ids)[] }> = [
            { perms: ['contratos.ver'], expected: ['expiring', 'awaiting'] },
            { perms: ['contratos.multa'], expected: ['expiring', 'awaiting', 'pendingCancel'] },
            { perms: ['financeiro.ver'], expected: ['overdue', 'failed'] },
            { perms: ['cobrancas.cobrar', 'cobrancas.baixa'], expected: [] },
            { perms: ['hoje.ver'], expected: [] },
            { perms: ['hoje.presenca'], expected: ['unconfirmed'] },
            { perms: ['agendamentos.ver', 'agendamentos.editar', 'clientes.ver'], expected: [] },
            { perms: [], expected: [] },
        ];
        for (const c of cases) {
            const who = await colab(c.perms);
            const effective = who.staffProfile!.permissions;
            const list = await computedOf(who);
            expect(list.map(n => n.id).sort(), c.perms.join(',') || '(nenhuma)').toEqual(c.expected.map(k => ids[k]).sort());
            for (const n of list) expect(opensFor(effective, n.actionUrl), `${c.perms.join(',')}: ${n.id} → ${n.actionUrl}`).toBe(true);
        }
    });

    it('cliente continua vendo os próprios alertas com os links da área do cliente', async () => {
        const { client } = await seedBell();
        const list = await computedOf(client);
        const urls = Object.fromEntries(list.map(n => [n.id.replace(/-[0-9a-f-]{36}$|-agg$/, ''), n.actionUrl]));
        expect(urls).toEqual({
            'contract-expiring': '/meus-contratos',
            'cancellation-pending': '/meus-contratos',
            'contract-awaiting': '/meus-contratos',
            'payment-overdue': '/meus-pagamentos',
            'payment-failed': '/meus-pagamentos',
        });
    });

    it('colaborador desativado ou excluído leva 401 ACCOUNT_DISABLED no sino', async () => {
        await seedBell();
        for (const who of [await colab(['financeiro.ver'], blocked), await colab(['financeiro.ver'], deleted())]) {
            const r = await call(base, 'GET', '/api/notifications', who);
            expect(r.status).toBe(401);
            expect(r.body.code).toBe('ACCOUNT_DISABLED');
        }
    });

    it('permissão retirada vale na hora: alerta calculado e aviso guardado do financeiro somem do sino', async () => {
        const { ids } = await seedBell();
        const who = await colab(['financeiro.ver']);
        const guardado = await notifyEvent('admin_payment_on_cancelled_charge', {
            userId: who.id, vars: { cliente: 'Cliente Sino', valor: 'R$ 10,00', contrato: 'Plano X' },
            entityType: 'PAYMENT', entityId: 'pay-x', dedupKey: `eq-b4:guardado:${who.id}`,
        });
        expect(guardado).not.toBe('');
        // Aviso pessoal (ex.: teste de modelo de mensagem de cliente) não é filtrado.
        const pessoal = await notifyEvent('payment_confirmed', {
            userId: who.id, vars: { valor: 'R$ 1,00' }, entityType: 'PAYMENT', entityId: 'pay-y', dedupKey: `eq-b4:pessoal:${who.id}`,
        });

        let all = (await call(base, 'GET', '/api/notifications', who)).body.notifications as any[];
        expect(all.map(n => n.id)).toEqual(expect.arrayContaining([ids.overdue, ids.failed, guardado, pessoal]));

        await prisma.staffProfile.update({ where: { userId: who.id }, data: { permissions: ['contratos.ver'] } });
        all = (await call(base, 'GET', '/api/notifications', who)).body.notifications as any[];
        const got = all.map(n => n.id);
        expect(got).not.toContain(ids.overdue);
        expect(got).not.toContain(ids.failed);
        expect(got).not.toContain(guardado);
        expect(got).toContain(pessoal);
        expect(got).toEqual(expect.arrayContaining([ids.expiring, ids.awaiting]));
    });

    it('read-all do colaborador marca só os alertas que ele vê', async () => {
        const { ids } = await seedBell();
        const who = await colab(['financeiro.ver']);
        expect((await call(base, 'PATCH', '/api/notifications/read-all', who)).status).toBe(200);
        const list = await computedOf(who);
        expect(list.map(n => [n.id, n.read]).sort()).toEqual([[ids.failed, true], [ids.overdue, true]].sort());
        // O admin não herda a leitura do colaborador.
        const admin = await mkUser({ role: 'ADMIN' });
        expect((await computedOf(admin)).every(n => n.read === false)).toBe(true);
    });
});

// ═══ 3) Push job ═════════════════════════════════════════════════════════════════════════════════
describe('pushNotificationJob — ignora desativados/excluídos e aplica as permissões', () => {
    const subscribe = (userId: string) => prisma.pushSubscription.create({
        data: { userId, endpoint: `https://push.test/${userId}`, p256dh: 'p256dh-test', auth: 'auth-test' },
    });

    it('cada membro recebe só o que a permissão libera; desativado e excluído não recebem nada (nem push)', async () => {
        // Push ligado nos alertas calculados da equipe (por padrão eles só vão para o sino).
        for (const eventKey of ['computed_payment_overdue_admin', 'computed_contract_expiring_admin', 'computed_booking_unconfirmed_admin']) {
            await prisma.notificationTemplate.create({ data: { eventKey, pushEnabled: true } });
        }
        invalidateTemplateCache();

        const client = await mkUser({ name: 'Cliente Push' });
        const contract = await mkContract(client.id, { type: 'FIXO', name: 'Plano Push', startDate: spDay(-60), endDate: spDay(3) });
        await mkPayment(client.id, { contractId: contract.id, amount: 50000, dueDate: spDay(-5) });
        const reserved = await mkBooking(client.id, contract.id, { date: spDay(0), startTime: '22:00', endTime: '23:59', status: 'RESERVED' });

        const admin = await mkUser({ role: 'ADMIN' });
        const fin = await colab(['financeiro.ver']);
        const contratos = await colab(['contratos.ver']);
        const presenca = await colab(['hoje.presenca']);
        const nenhuma = await colab([]);
        const finDesativado = await colab(['financeiro.ver', 'contratos.ver', 'hoje.presenca'], blocked);
        const finExcluido = await colab(['financeiro.ver', 'contratos.ver', 'hoje.presenca'], deleted());
        const adminDesativado = await mkUser({ role: 'ADMIN', ...blocked });
        const clienteBloqueado = await mkUser({ ...blocked });
        await mkPayment(clienteBloqueado.id, { amount: 1000, dueDate: spDay(-3) });
        for (const u of [client, admin, fin, contratos, presenca, nenhuma, finDesativado, finExcluido, adminDesativado, clienteBloqueado]) {
            await subscribe(u.id);
        }

        await runPushNotificationJob();

        const typesOf = async (userId: string) => (await notesOf(userId)).map(n => `${n.type}:${n.entityId}:${n.actionUrl}`).sort();
        expect(await typesOf(admin.id)).toEqual([
            `BOOKING_UNCONFIRMED:${reserved.id}:/admin/today`,
            `CONTRACT_EXPIRING:${contract.id}:/admin/contracts/${contract.id}`,
            `PAYMENT_OVERDUE:${client.id}:/admin/finance`,
            `PAYMENT_OVERDUE:${clienteBloqueado.id}:/admin/finance`,
        ].sort());
        expect(await typesOf(fin.id)).toEqual([
            `PAYMENT_OVERDUE:${client.id}:/admin/finance`,
            `PAYMENT_OVERDUE:${clienteBloqueado.id}:/admin/finance`,
        ].sort());
        expect(await typesOf(contratos.id)).toEqual([`CONTRACT_EXPIRING:${contract.id}:/admin/contracts/${contract.id}`]);
        expect(await typesOf(presenca.id)).toEqual([`BOOKING_UNCONFIRMED:${reserved.id}:/admin/today`]);
        expect(await typesOf(client.id)).toEqual([
            `CONTRACT_EXPIRING:${contract.id}:/meus-contratos`,
            'PAYMENT_OVERDUE:agg:/meus-pagamentos',
        ].sort());
        for (const who of [nenhuma, finDesativado, finExcluido, adminDesativado, clienteBloqueado]) {
            expect(await notesOf(who.id)).toHaveLength(0);
        }

        const pushed = new Set(pushedTo());
        for (const who of [admin, fin, contratos, presenca, client]) expect(pushed.has(who.id)).toBe(true);
        for (const who of [nenhuma, finDesativado, finExcluido, adminDesativado, clienteBloqueado]) expect(pushed.has(who.id)).toBe(false);
    });
});

// ═══ 4) Job da remarcação do avulso: "não realizada sem remarcação" ═══════════════════════════════
describe('avulsoMakeupExpiryJob — admin_makeup_expired_studio vai para quem registra faltas, com link que abre', () => {
    const D = '2026-09-14';
    const dbDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
    const sp = (ymd: string, hhmm: string) => new Date(`${ymd}T${hhmm}:00-03:00`);

    it('ADMIN e quem vê contratos → detalhe do contrato; só faltas → Agendamentos; sem faltas/desativado → nada', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const faltas = await colab(['agendamentos.faltas']);
        const faltasContratos = await colab(['agendamentos.faltas', 'contratos.ver']);
        const soVer = await colab(['agendamentos.ver', 'contratos.ver']);
        const desativado = await colab(['agendamentos.faltas'], blocked);
        const client = await mkUser({ name: 'Cliente Avulso' });
        const contract = await mkContract(client.id, {
            type: 'AVULSO', durationMonths: 1, discountPct: 0, startDate: dbDate(D), endDate: dbDate(D), paymentPlan: 'FULL',
            flexCreditsTotal: 1, flexCreditsRemaining: 1, status: 'ACTIVE',
        });
        const booking = await mkBooking(client.id, contract.id, {
            date: dbDate(D), startTime: '10:00', endTime: '12:00', status: 'NAO_REALIZADO',
            makeupStatus: 'OPEN', makeupDeadline: new Date('2026-09-22T02:59:59.999Z'), missedDate: dbDate(D),
        });
        await mkPayment(client.id, { contractId: contract.id, bookingId: booking.id, status: 'PAID', amount: 30000, paidAt: sp(D, '09:00') });

        const r = await runAvulsoMakeupExpiryJob(sp('2026-09-22', '10:00'));
        expect(r).toMatchObject({ expired: 1, notified: 1 });

        const alertOf = (userId: string) => notesOf(userId, { title: 'Gravação não realizada sem remarcação', entityId: booking.id });
        const expectLink = async (userId: string, url: string) => {
            const notes = await alertOf(userId);
            expect(notes).toHaveLength(1);
            expect(notes[0].actionUrl).toBe(url);
        };
        await expectLink(admin.id, `/admin/contracts/${contract.id}`);
        await expectLink(faltasContratos.id, `/admin/contracts/${contract.id}`);
        await expectLink(faltas.id, '/admin/bookings');
        expect(opensFor(faltas.staffProfile!.permissions, '/admin/bookings')).toBe(true);
        expect(await alertOf(soVer.id)).toHaveLength(0);
        expect(await alertOf(desativado.id)).toHaveLength(0);
        expect(pushedTo()).not.toContain(desativado.id);
    });

    it('catálogo: o link padrão do evento abre com a permissão dele (agendamentos.faltas → /admin/bookings)', () => {
        expect(NOTIFICATION_EVENT_BY_KEY.admin_makeup_expired_studio!.actionUrl).toBe('/admin/bookings');
        expect(opensFor(normalizePermissions(['agendamentos.faltas']).permissions, '/admin/bookings')).toBe(true);
    });
});
