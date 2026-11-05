import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

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
    };
});
vi.mock('../../src/modules/push/pushService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/modules/push/pushService')>();
    return { ...orig, sendPushToUser: vi.fn(async () => 1) };
});
// A anulação real, embrulhada num vi.fn só para (a) contar as chamadas e (b) simular uma falha.
vi.mock('../../src/lib/paymentEffects', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/paymentEffects')>();
    return { ...orig, voidContractPendingPaymentsDetailed: vi.fn(orig.voidContractPendingPaymentsDetailed) };
});

import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { config } from '../../src/config/index';
import { saoPauloParts } from '../../src/lib/spTime';
import { addDaysYmd } from '../../src/lib/avulsoMakeup';
import * as sicoob from '../../src/lib/sicoobService';
import * as stripe from '../../src/lib/stripeService';
import * as push from '../../src/modules/push/pushService';
import * as paymentEffects from '../../src/lib/paymentEffects';
import { buildStaticBrCode } from '../../src/lib/brcode';
import { invalidateConfigCache } from '../../src/lib/businessConfig';
import { runPushNotificationJob } from '../../src/jobs/pushNotificationJob';
import bookingRoutes from '../../src/modules/bookings/routes';
import notificationRoutes from '../../src/modules/notifications/routes';
import { mkUser, mkContract, mkPayment, mkBooking } from './factories';

// Lote 2, rodada fx3 — frente z2-bookings, pelas ROTAS reais:
//  Z2-a  gravação de PLANO cancelada pelos caminhos comuns (PUT /:id/client-cancel, DELETE /:id,
//        PATCH /:id status=CANCELLED) ou excluída (DELETE /:id/hard-delete) → as cobranças PENDING/FAILED
//        dos EXTRAS dela são anuladas pela sequência do contrato (aposenta no provedor → anula; PIX já
//        pago vira PAID). Extra já PAGO fica intocado; remarcar e "aviso < 24 h" (FALTA) não anulam nada;
//        falha na anulação não desfaz o cancelamento. R5 (FIN-10): a gravação AVULSA também — a cobrança em
//        aberto da reserva é aposentada no provedor e anulada (antes ficava presa, impagável e listada como devida).
//  Z2-b  o sino (GET /api/notifications) e o push de "faturas vencidas" / "pagamento falhou" não contam
//        a cobrança de uma gravação CANCELADA (dado legado).

type Who = { id: string; email: string | null; role: string };

const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const getCob = m(sicoob.sicoobGetCob);
const removeCob = m(sicoob.sicoobRemoveCob);
const getPI = m(stripe.stripeGetPaymentIntent);
const cancelPI = m(stripe.stripeCancelPaymentIntent);
const sendPush = m(push.sendPushToUser);
const voidDetailed = m(paymentEffects.voidContractPendingPaymentsDetailed);

// txids no formato Sicoob (26–35 alfanuméricos).
const TX_LIVE = 'TXFX3Z2EXTRAVIVA000000000001';
const TX_PAID = 'TXFX3Z2EXTRAPAGA000000000001';
const TX_AVULSO = 'TXFX3Z2AVULSO000000000000001';
const PI_EXTRA = 'pi_fx3z2extra';

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/bookings', bookingRoutes);
    app.use('/api/notifications', notificationRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
    vi.clearAllMocks();
    invalidateConfigCache();
    m(sicoob.getSicoobEnvironment).mockResolvedValue('production');
    removeCob.mockReset();
    removeCob.mockResolvedValue(true);
    getCob.mockReset();
    m(stripe.isStripeEnabled).mockResolvedValue(true);
    cancelPI.mockReset();
    cancelPI.mockResolvedValue({ status: 'canceled', canceled: true });
    getPI.mockReset();
    sendPush.mockResolvedValue(1);
    await prisma.integrationConfig.create({ data: { provider: 'SICOOB', enabled: true, environment: 'sandbox', config: '{}' } });
    await prisma.integrationConfig.create({ data: { provider: 'STRIPE', enabled: true, environment: 'sandbox', config: '{}' } });
});

// O client-cancel avisa os admins em segundo plano (fire-and-forget): espera as notificações assentarem
// antes do TRUNCATE do próximo caso, para a escrita tardia não bater numa tabela já esvaziada.
afterEach(async () => {
    let last = -1;
    for (let i = 0; i < 15; i++) {
        const n = await prisma.notification.count();
        if (n === last) break;
        last = n;
        await new Promise(r => setTimeout(r, 80));
    }
});

function cookie(u: Who) {
    return `accessToken=${jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' })}`;
}

async function call(method: string, path: string, who?: Who, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: {
            ...(who ? { Cookie: cookie(who) } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* corpo não-JSON */ }
    return { status: res.status, body: json, text };
}

// Datas relativas a HOJE no calendário de São Paulo (meia-noite UTC = formato de Booking.date).
const todaySp = saoPauloParts(new Date()).dateStr;
const dbDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const spDay = (n: number) => dbDate(addDaysYmd(todaySp, n));
const dow = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
/** 1º dia útil (seg–sex, faixa COMERCIAL nos horários 10:00/13:00) a partir de `from`. */
function nextWeekday(from: string): string {
    for (let d = from; ; d = addDaysYmd(d, 1)) if (dow(d) >= 1 && dow(d) <= 5) return d;
}

const pixFields = (txid: string, amountCents: number) => ({
    provider: 'SICOOB' as const, providerRef: txid,
    pixString: buildStaticBrCode({ key: 'k', amountCents, txid }), pixExpiresAt: new Date(Date.now() + 1800_000),
});
const cobAtiva = (valor: string) => ({ status: 'ATIVA', valor: { original: valor }, calendario: { criacao: new Date().toISOString(), expiracao: 3600 } });
const cobPaga = (valor: string) => ({ status: 'CONCLUIDA', valor: { original: valor }, pix: [{ valor }] });

const pay = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
const payStatus = async (id: string) => (await pay(id)).status;
const bookingStatus = async (id: string) => (await prisma.booking.findUniqueOrThrow({ where: { id } })).status;
const credits = async (id: string) => (await prisma.contract.findUniqueOrThrow({ where: { id } })).flexCreditsRemaining;

/** Plano FLEX mensal: 1ª parcela paga, 2ª pendente, 8 créditos restantes. */
async function planScene() {
    const admin = await mkUser({ role: 'ADMIN' });
    const client = await mkUser();
    const contract = await mkContract(client.id, {
        type: 'FLEX', startDate: spDay(-20), endDate: spDay(64), flexCreditsTotal: 12, flexCreditsRemaining: 8,
    });
    const p1 = await mkPayment(client.id, { contractId: contract.id, amount: 84000, status: 'PAID', paidAt: new Date(), dueDate: spDay(-20) });
    const p2 = await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(8) });
    return { admin, client, contract, p1, p2 };
}

/** Cobrança de EXTRAS de uma gravação de plano (contractId + bookingId), no formato de POST /:id/addons. */
const mkExtra = (userId: string, contractId: string, bookingId: string, over: Record<string, unknown> = {}) =>
    mkPayment(userId, { contractId, bookingId, amount: 5000, dueDate: spDay(3), paymentUrl: JSON.stringify({ addonKeys: ['CORTES'] }), ...over } as any);

/** Avulso de 1 gravação com a cobrança da própria reserva (contractId + bookingId) em aberto, com QR vivo. */
async function avulsoScene(status: 'RESERVED' | 'CONFIRMED') {
    const admin = await mkUser({ role: 'ADMIN' });
    const client = await mkUser();
    const contract = await mkContract(client.id, {
        type: 'AVULSO', durationMonths: 1, discountPct: 0, paymentPlan: 'FULL', flexCreditsTotal: 1, flexCreditsRemaining: 0,
        startDate: spDay(3), endDate: spDay(3),
    });
    const booking = await mkBooking(client.id, contract.id, { date: spDay(3), status });
    const charge = await mkPayment(client.id, { contractId: contract.id, bookingId: booking.id, amount: 30000, dueDate: spDay(3), ...pixFields(TX_AVULSO, 30000) });
    return { admin, client, contract, booking, charge };
}

// ═══ Z2-a — extras da gravação de plano cancelada ═════════════════════════════════════════════════
describe('Z2-a — cancelar a gravação de um plano anula as cobranças em aberto dos extras dela', () => {
    it('cliente cancela (PUT /:id/client-cancel, ≥ 24 h): extra com QR vivo é aposentado no banco e anulado; o resto fica como está', async () => {
        const { client, contract, p2 } = await planScene();
        const target = await mkBooking(client.id, contract.id, { date: spDay(3), status: 'CONFIRMED' });
        const other = await mkBooking(client.id, contract.id, { date: spDay(5), status: 'CONFIRMED' });
        const done = await mkBooking(client.id, contract.id, { date: spDay(-5), status: 'COMPLETED' });
        const extra = await mkExtra(client.id, contract.id, target.id, pixFields(TX_LIVE, 5000));
        const extraOther = await mkExtra(client.id, contract.id, other.id, { dueDate: spDay(5) });
        const extraDone = await mkExtra(client.id, contract.id, done.id, { dueDate: spDay(-5) });
        getCob.mockResolvedValue(cobAtiva('50.00'));

        const r = await call('PUT', `/api/bookings/${target.id}/client-cancel`, client);
        expect(r.status, r.text).toBe(200);
        expect(r.body.voidedExtras).toBe(1);
        expect(r.body.message).toBe('Agendamento cancelado com sucesso. O crédito retornou ao seu plano. 1 cobrança em aberto desta gravação foi cancelada.');

        expect(await bookingStatus(target.id)).toBe('CANCELLED');
        expect(await credits(contract.id)).toBe(9);
        expect(removeCob).toHaveBeenCalledWith(TX_LIVE);
        expect(await payStatus(extra.id)).toBe('CANCELLED');
        expect(voidDetailed).toHaveBeenCalledTimes(1);
        expect(voidDetailed).toHaveBeenCalledWith(contract.id, { bookingIds: [target.id] });
        // Extras de OUTRAS gravações (futura e realizada) e a parcela do plano: intocados.
        expect(await payStatus(extraOther.id)).toBe('PENDING');
        expect(await payStatus(extraDone.id)).toBe('PENDING');
        expect(await payStatus(p2.id)).toBe('PENDING');
        expect(await bookingStatus(other.id)).toBe('CONFIRMED');

        // Segundo clique: a gravação já está cancelada → 404, nada mais é anulado.
        const again = await call('PUT', `/api/bookings/${target.id}/client-cancel`, client);
        expect(again.status).toBe(404);
        expect(voidDetailed).toHaveBeenCalledTimes(1);
        expect(await credits(contract.id)).toBe(9);
    });

    it('extra já PAGO fica intocado; extra cujo PIX já foi pago no banco vira PAID (não é anulado)', async () => {
        const { client, contract } = await planScene();
        const a = await mkBooking(client.id, contract.id, { date: spDay(3), status: 'CONFIRMED' });
        const paidAt = new Date(Date.now() - 3600_000);
        const paidExtra = await mkExtra(client.id, contract.id, a.id, { status: 'PAID', paidAt, ...pixFields(TX_LIVE, 5000) });

        const r1 = await call('PUT', `/api/bookings/${a.id}/client-cancel`, client);
        expect(r1.status, r1.text).toBe(200);
        expect(r1.body.voidedExtras).toBe(0);
        expect(r1.body.message).toBe('Agendamento cancelado com sucesso. O crédito retornou ao seu plano.');
        const after = await pay(paidExtra.id);
        expect(after).toMatchObject({ status: 'PAID', bookingId: a.id, providerRef: TX_LIVE });
        expect(after.paidAt?.getTime()).toBe(paidAt.getTime());
        expect(getCob).not.toHaveBeenCalled();
        expect(removeCob).not.toHaveBeenCalled();

        const b = await mkBooking(client.id, contract.id, { date: spDay(4), status: 'CONFIRMED' });
        const pixPaid = await mkExtra(client.id, contract.id, b.id, { dueDate: spDay(4), ...pixFields(TX_PAID, 5000) });
        getCob.mockResolvedValue(cobPaga('50.00'));
        const r2 = await call('PUT', `/api/bookings/${b.id}/client-cancel`, client);
        expect(r2.status, r2.text).toBe(200);
        expect(r2.body.voidedExtras).toBe(0);
        expect(await bookingStatus(b.id)).toBe('CANCELLED');
        expect(await payStatus(pixPaid.id)).toBe('PAID');
        expect(removeCob).not.toHaveBeenCalled();
    });

    it('DELETE /:id — pelo cliente (extra FAILED) e pelo admin (extra de cartão com PaymentIntent aberto): ambos anulados', async () => {
        const { admin, client, contract, p2 } = await planScene();
        const byClient = await mkBooking(client.id, contract.id, { date: spDay(3), status: 'RESERVED' });
        const failed = await mkExtra(client.id, contract.id, byClient.id, { provider: 'STRIPE', status: 'FAILED' });
        const r1 = await call('DELETE', `/api/bookings/${byClient.id}`, client);
        expect(r1.status, r1.text).toBe(200);
        expect(r1.body).toEqual({ message: 'Reserva cancelada com sucesso. 1 cobrança em aberto desta gravação foi cancelada.', voidedExtras: 1 });
        expect(await bookingStatus(byClient.id)).toBe('CANCELLED');
        expect(await payStatus(failed.id)).toBe('CANCELLED');

        // Admin cancela uma sessão de amanhã (a janela de 24 h é só do cliente), com 2 extras em aberto.
        const byAdmin = await mkBooking(client.id, contract.id, { date: spDay(1), startTime: '10:00', endTime: '12:00', status: 'CONFIRMED' });
        const card = await mkExtra(client.id, contract.id, byAdmin.id, { provider: 'STRIPE', providerRef: PI_EXTRA, dueDate: spDay(1) });
        const plain = await mkExtra(client.id, contract.id, byAdmin.id, { amount: 3000, dueDate: spDay(1) });
        getPI.mockResolvedValue({ id: PI_EXTRA, status: 'requires_payment_method', amount: 5000, metadata: { paymentId: card.id } });
        const r2 = await call('DELETE', `/api/bookings/${byAdmin.id}`, admin);
        expect(r2.status, r2.text).toBe(200);
        expect(r2.body).toEqual({ message: 'Reserva cancelada com sucesso. 2 cobranças em aberto desta gravação foram canceladas.', voidedExtras: 2 });
        expect(cancelPI).toHaveBeenCalledWith(PI_EXTRA);
        expect(await payStatus(card.id)).toBe('CANCELLED');
        expect(await payStatus(plain.id)).toBe('CANCELLED');
        expect(await payStatus(p2.id)).toBe('PENDING');

        // Repetir o DELETE de uma reserva já cancelada: 404, sem nova anulação.
        const calls = voidDetailed.mock.calls.length;
        expect((await call('DELETE', `/api/bookings/${byAdmin.id}`, admin)).status).toBe(404);
        expect(voidDetailed).toHaveBeenCalledTimes(calls);
    });

    it('PATCH /:id (admin) com status CANCELLED anula os extras; remarcar (admin ou cliente) não anula nada', async () => {
        const { admin, client, contract } = await planScene();
        const from = nextWeekday(addDaysYmd(todaySp, 3));
        const to = nextWeekday(addDaysYmd(from, 1));
        const moved = await mkBooking(client.id, contract.id, { date: dbDate(from), startTime: '10:00', endTime: '12:00', status: 'CONFIRMED' });
        const resched = await mkBooking(client.id, contract.id, { date: dbDate(from), startTime: '13:00', endTime: '15:00', status: 'CONFIRMED' });
        const extraMoved = await mkExtra(client.id, contract.id, moved.id, pixFields(TX_LIVE, 5000));
        const extraResched = await mkExtra(client.id, contract.id, resched.id);

        // Admin remarca (só data/horário) → nada é anulado.
        const mv = await call('PATCH', `/api/bookings/${moved.id}`, admin, { date: to, startTime: '10:00' });
        expect(mv.status, mv.text).toBe(200);
        expect(mv.body.message).toBe('Agendamento atualizado com sucesso.');
        expect(mv.body.voidedExtras).toBeUndefined();
        // Cliente reagenda → nada é anulado.
        const rs = await call('PATCH', `/api/bookings/${resched.id}/reschedule`, client, { date: to, startTime: '13:00' });
        expect(rs.status, rs.text).toBe(200);
        expect(voidDetailed).not.toHaveBeenCalled();
        expect(getCob).not.toHaveBeenCalled();
        expect(removeCob).not.toHaveBeenCalled();
        expect(await pay(extraMoved.id)).toMatchObject({ status: 'PENDING', providerRef: TX_LIVE });
        expect(await payStatus(extraResched.id)).toBe('PENDING');

        // Admin troca o status para Cancelado → o extra é aposentado no banco e anulado.
        getCob.mockResolvedValue(cobAtiva('50.00'));
        const cancel = await call('PATCH', `/api/bookings/${moved.id}`, admin, { status: 'CANCELLED' });
        expect(cancel.status, cancel.text).toBe(200);
        expect(cancel.body.voidedExtras).toBe(1);
        expect(cancel.body.message).toBe('Agendamento atualizado com sucesso. 1 cobrança em aberto desta gravação foi cancelada.');
        expect(cancel.body.booking.status).toBe('CANCELLED');
        expect(removeCob).toHaveBeenCalledWith(TX_LIVE);
        expect(await payStatus(extraMoved.id)).toBe('CANCELLED');
        expect(await payStatus(extraResched.id)).toBe('PENDING');

        // Salvar de novo como Cancelado (sem transição) e outras trocas de status não chamam a anulação.
        expect((await call('PATCH', `/api/bookings/${moved.id}`, admin, { status: 'CANCELLED', adminNotes: 'ok' })).status).toBe(200);
        expect((await call('PATCH', `/api/bookings/${resched.id}`, admin, { status: 'NAO_REALIZADO', statusReason: 'Queda de energia' })).status).toBe(200);
        expect(voidDetailed).toHaveBeenCalledTimes(1);
        expect(await payStatus(extraResched.id)).toBe('PENDING');
    });

    it('gravação já REALIZADA cancelada pelo admin (PATCH) também tem o extra em aberto anulado', async () => {
        const { admin, client, contract } = await planScene();
        const done = await mkBooking(client.id, contract.id, { date: spDay(-5), status: 'COMPLETED' });
        const extra = await mkExtra(client.id, contract.id, done.id, { dueDate: spDay(-5) });
        const r = await call('PATCH', `/api/bookings/${done.id}`, admin, { status: 'CANCELLED' });
        expect(r.status, r.text).toBe(200);
        expect(r.body.voidedExtras).toBe(1);
        expect(await payStatus(extra.id)).toBe('CANCELLED');
    });

    it('aviso com menos de 24 h vira FALTA (não é cancelamento): o extra continua em aberto', async () => {
        const { client, contract } = await planScene();
        const a = await mkBooking(client.id, contract.id, { date: spDay(0), startTime: '10:00', endTime: '12:00', status: 'CONFIRMED' });
        const b = await mkBooking(client.id, contract.id, { date: spDay(0), startTime: '13:00', endTime: '15:00', status: 'CONFIRMED' });
        const extraA = await mkExtra(client.id, contract.id, a.id, { dueDate: spDay(0) });
        const extraB = await mkExtra(client.id, contract.id, b.id, { dueDate: spDay(0) });

        expect((await call('PUT', `/api/bookings/${a.id}/client-cancel`, client)).status).toBe(200);
        expect((await call('DELETE', `/api/bookings/${b.id}`, client)).status).toBe(200);
        expect(await bookingStatus(a.id)).toBe('FALTA');
        expect(await bookingStatus(b.id)).toBe('FALTA');
        expect(voidDetailed).not.toHaveBeenCalled();
        expect(await payStatus(extraA.id)).toBe('PENDING');
        expect(await payStatus(extraB.id)).toBe('PENDING');
    });

    it('exclusão permanente (DELETE /:id/hard-delete): o extra em aberto é anulado ANTES de perder o vínculo; o pago fica pago', async () => {
        const { admin, client, contract, p2 } = await planScene();
        const booking = await mkBooking(client.id, contract.id, { date: spDay(3), status: 'CONFIRMED' });
        const open = await mkExtra(client.id, contract.id, booking.id);
        const paid = await mkExtra(client.id, contract.id, booking.id, { status: 'PAID', paidAt: new Date(), amount: 3000 });

        const r = await call('DELETE', `/api/bookings/${booking.id}/hard-delete`, admin);
        expect(r.status, r.text).toBe(200);
        expect(r.body).toEqual({
            message: 'Agendamento removido permanentemente. Crédito devolvido ao contrato. 1 cobrança em aberto desta gravação foi cancelada.',
            creditRestored: true,
            voidedExtras: 1,
        });
        expect(await prisma.booking.findUnique({ where: { id: booking.id } })).toBeNull();
        // Sem a anulação, este extra ficaria PENDING com contractId e sem bookingId — igual a uma parcela do plano.
        expect(await pay(open.id)).toMatchObject({ status: 'CANCELLED', bookingId: null, contractId: contract.id });
        expect(await pay(paid.id)).toMatchObject({ status: 'PAID', bookingId: null });
        expect(await payStatus(p2.id)).toBe('PENDING');
        expect(await prisma.payment.count({ where: { contractId: contract.id, bookingId: null, status: 'PENDING' } })).toBe(1);
    });

    it('falha na anulação não desfaz o cancelamento (best-effort): a gravação fica cancelada e o crédito volta', async () => {
        const { client, contract } = await planScene();
        const booking = await mkBooking(client.id, contract.id, { date: spDay(3), status: 'CONFIRMED' });
        const extra = await mkExtra(client.id, contract.id, booking.id);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        voidDetailed.mockRejectedValueOnce(new Error('provedor fora do ar'));

        const r = await call('PUT', `/api/bookings/${booking.id}/client-cancel`, client);
        expect(r.status, r.text).toBe(200);
        expect(r.body).toEqual({ message: 'Agendamento cancelado com sucesso. O crédito retornou ao seu plano.', voidedExtras: 0 });
        expect(await bookingStatus(booking.id)).toBe('CANCELLED');
        expect(await credits(contract.id)).toBe(9);
        expect(await payStatus(extra.id)).toBe('PENDING');
        expect(errSpy.mock.calls.some(c => String(c[0]).includes('Falha ao anular as cobranças de extras'))).toBe(true);
        errSpy.mockRestore();
    });
});

// ═══ Z2-a — gravação AVULSA: comportamento inalterado ═════════════════════════════════════════════
describe('Z2-a — gravação avulsa cancelada: a cobrança em aberto da reserva é aposentada no provedor e anulada (R5)', () => {
    const voided = async (contractId: string, chargeId: string, bookingId: string | null) => {
        expect(await pay(chargeId)).toMatchObject({ status: 'CANCELLED', providerRef: TX_AVULSO, bookingId, amount: 30000 });
        expect(voidDetailed).toHaveBeenCalledTimes(1);
        expect(voidDetailed.mock.calls[0]![0]).toBe(contractId);
        expect(removeCob).toHaveBeenCalledWith(TX_AVULSO);
    };

    it('DELETE /:id pelo cliente (reserva em espera)', async () => {
        const { client, contract, booking, charge } = await avulsoScene('RESERVED');
        getCob.mockResolvedValue(cobAtiva('300.00'));
        const r = await call('DELETE', `/api/bookings/${booking.id}`, client);
        expect(r.status, r.text).toBe(200);
        expect(r.body).toEqual({ message: 'Reserva cancelada com sucesso. 1 cobrança em aberto desta gravação foi cancelada.', voidedExtras: 1 });
        expect(await bookingStatus(booking.id)).toBe('CANCELLED');
        await voided(contract.id, charge.id, booking.id);
    });

    it('PUT /:id/client-cancel (≥ 24 h)', async () => {
        const { client, contract, booking, charge } = await avulsoScene('CONFIRMED');
        getCob.mockResolvedValue(cobAtiva('300.00'));
        const r = await call('PUT', `/api/bookings/${booking.id}/client-cancel`, client);
        expect(r.status, r.text).toBe(200);
        expect(r.body).toEqual({ message: 'Agendamento cancelado com sucesso. O crédito retornou ao seu plano. 1 cobrança em aberto desta gravação foi cancelada.', voidedExtras: 1 });
        expect(await bookingStatus(booking.id)).toBe('CANCELLED');
        await voided(contract.id, charge.id, booking.id);
    });

    it('PATCH /:id do admin com status CANCELLED', async () => {
        const { admin, contract, booking, charge } = await avulsoScene('CONFIRMED');
        getCob.mockResolvedValue(cobAtiva('300.00'));
        const r = await call('PATCH', `/api/bookings/${booking.id}`, admin, { status: 'CANCELLED' });
        expect(r.status, r.text).toBe(200);
        expect(r.body.message).toBe('Agendamento atualizado com sucesso. 1 cobrança em aberto desta gravação foi cancelada.');
        expect(r.body.voidedExtras).toBe(1);
        expect(await bookingStatus(booking.id)).toBe('CANCELLED');
        await voided(contract.id, charge.id, booking.id);
    });

    it('DELETE /:id/hard-delete do admin', async () => {
        const { admin, contract, booking, charge } = await avulsoScene('CONFIRMED');
        getCob.mockResolvedValue(cobAtiva('300.00'));
        const r = await call('DELETE', `/api/bookings/${booking.id}/hard-delete`, admin);
        expect(r.status, r.text).toBe(200);
        expect(r.body).toEqual({ message: 'Agendamento removido permanentemente. Crédito devolvido ao contrato. 1 cobrança em aberto desta gravação foi cancelada.', creditRestored: true, voidedExtras: 1 });
        expect(await prisma.booking.findUnique({ where: { id: booking.id } })).toBeNull();
        await voided(contract.id, charge.id, null); // anulada ANTES de apagar; a FK zera o vínculo com a gravação
    });

    it('a cobrança JÁ PAGA no banco vira PAID (não é anulada) e a reserva fica cancelada', async () => {
        const { admin, booking, charge } = await avulsoScene('CONFIRMED');
        getCob.mockResolvedValue(cobPaga('300.00'));
        const r = await call('PATCH', `/api/bookings/${booking.id}`, admin, { status: 'CANCELLED' });
        expect(r.status, r.text).toBe(200);
        expect(r.body.voidedExtras).toBeUndefined();
        expect(await bookingStatus(booking.id)).toBe('CANCELLED');
        expect(await payStatus(charge.id)).toBe('PAID');
    });
});

// ═══ Z2-b — sino e push ignoram a cobrança de gravação cancelada ══════════════════════════════════
describe('Z2-b — "faturas vencidas" e "pagamento falhou" não contam cobrança de gravação CANCELADA', () => {
    /** Cliente com plano ativo e uma gravação CANCELADA com 2 cobranças legadas: extra vencido (R$ 50) e extra de cartão FAILED (R$ 70). */
    async function legacyClient() {
        const client = await mkUser();
        const contract = await mkContract(client.id, { type: 'FLEX', startDate: spDay(-40), endDate: spDay(44), flexCreditsTotal: 12, flexCreditsRemaining: 8 });
        const cancelled = await mkBooking(client.id, contract.id, { date: spDay(-3), status: 'CANCELLED' });
        const overdue = await mkExtra(client.id, contract.id, cancelled.id, { dueDate: spDay(-3) });
        const failed = await mkExtra(client.id, contract.id, cancelled.id, { provider: 'STRIPE', status: 'FAILED', amount: 7000, dueDate: spDay(-3) });
        return { client, contract, cancelled, overdue, failed };
    }
    const alerts = async (who: Who) => {
        const r = await call('GET', '/api/notifications', who);
        expect(r.status, r.text).toBe(200);
        return (r.body.notifications as { id: string; type: string; message: string }[]).filter(n => n.type === 'PAYMENT_OVERDUE');
    };

    it('sino do cliente e do admin: só entram as cobranças de gravações não canceladas e as parcelas do plano', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const onlyLegacy = await legacyClient();
        const mixed = await legacyClient();
        const done = await mkBooking(mixed.client.id, mixed.contract.id, { date: spDay(-6), status: 'COMPLETED' });
        await mkExtra(mixed.client.id, mixed.contract.id, done.id, { amount: 3000, dueDate: spDay(-6) });
        const failedLive = await mkExtra(mixed.client.id, mixed.contract.id, done.id, { provider: 'STRIPE', status: 'FAILED', amount: 4000, dueDate: spDay(-6) });
        await mkPayment(mixed.client.id, { contractId: mixed.contract.id, amount: 84000, dueDate: spDay(-5) });

        // Só dado legado de gravação cancelada: nenhum alerta de pagamento.
        expect(await alerts(onlyLegacy.client)).toEqual([]);

        // Misto: a parcela do plano (R$ 840) + o extra da gravação realizada (R$ 30); o FAILED só da realizada.
        const mine = await alerts(mixed.client);
        expect(mine.map(n => n.id).sort()).toEqual(['payment-overdue-agg', `payment-failed-${failedLive.id}`].sort());
        const agg = mine.find(n => n.id === 'payment-overdue-agg')!;
        expect(agg.message).toContain('2 fatura(s)');
        expect(agg.message).toContain('R$ 870,00');

        // Admin: o mesmo recorte; o cliente que só tem dado legado não aparece.
        const forAdmin = await alerts(admin);
        expect(forAdmin.map(n => n.id).sort()).toEqual([`payment-overdue-${mixed.client.id}`, `payment-failed-${failedLive.id}`].sort());
        const adminAgg = forAdmin.find(n => n.id === `payment-overdue-${mixed.client.id}`)!;
        expect(adminAgg.message).toContain('2 fatura(s)');
        expect(adminAgg.message).toContain('R$ 870,00');
    });

    it('push de faturas vencidas: o cliente (e o admin) não é avisado da cobrança de gravação cancelada', async () => {
        const subscribe = (userId: string) => prisma.pushSubscription.create({
            data: { userId, endpoint: `https://push.example/${userId}`, p256dh: 'k', auth: 'a' },
        });
        const overdueNotes = (userId: string) => prisma.notification.findMany({ where: { userId, type: 'PAYMENT_OVERDUE' } });
        const admin = await mkUser({ role: 'ADMIN' });
        const onlyLegacy = await legacyClient();
        const mixed = await legacyClient();
        const done = await mkBooking(mixed.client.id, mixed.contract.id, { date: spDay(-6), status: 'COMPLETED' });
        await mkExtra(mixed.client.id, mixed.contract.id, done.id, { amount: 3000, dueDate: spDay(-6) });
        await subscribe(onlyLegacy.client.id);
        await subscribe(mixed.client.id);
        await subscribe(admin.id);

        await runPushNotificationJob();

        expect(await overdueNotes(onlyLegacy.client.id)).toHaveLength(0);
        const note = await overdueNotes(mixed.client.id);
        expect(note).toHaveLength(1);
        expect(note[0]!.message).toContain('1 fatura(s)');
        expect(note[0]!.message).toContain('R$ 30,00');
        const forAdmin = await overdueNotes(admin.id);
        expect(forAdmin.map(n => n.entityId)).toEqual([mixed.client.id]);
        expect(forAdmin[0]!.message).toContain('R$ 30,00');
        expect(sendPush.mock.calls.map(c => c[0])).not.toContain(onlyLegacy.client.id);
    });
});
