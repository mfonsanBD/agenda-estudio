import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ─── Provedores e e-mail: nenhuma chamada de rede real ──
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
        isStripeEnabled: vi.fn(async () => false),
        stripeCardInstallmentsSupported: vi.fn(async () => false),
        stripeGetPaymentIntent: vi.fn(),
        stripeCancelPaymentIntent: vi.fn(async () => ({ status: 'canceled', canceled: true })),
        stripeCreatePaymentIntent: vi.fn(),
        stripeGetOrCreateCustomer: vi.fn(async () => 'cus_test'),
        stripeListPaymentMethods: vi.fn(async () => []),
    };
});
vi.mock('../../src/lib/email', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/email')>();
    return { ...orig, sendEmail: vi.fn(async () => undefined), deliverOtpEmail: vi.fn(async () => undefined) };
});
vi.mock('../../src/modules/push/pushService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/modules/push/pushService')>();
    return { ...orig, sendPushToUser: vi.fn(async () => 1) };
});

import { prisma } from '../../src/lib/prisma';
import * as sicoob from '../../src/lib/sicoobService';
import * as stripe from '../../src/lib/stripeService';
import { buildStaticBrCode } from '../../src/lib/brcode';
import { addDaysYmd } from '../../src/lib/avulsoMakeup';
import { mkUser, mkStaff, mkContract, mkPayment, mkCoupon, mkCpf } from './factories';
import {
    bookingState, call, clientState, dbDate, enablePixSandbox, paymentState, seedAvulsoMissed, seedFlexBooking,
    startServer, todaySp, weekdayN, type Who,
} from './eq-authHelpers';

// FRENTE R4e — rotas MISTAS (cliente + equipe), achados QT-01 e QT-02 da 2ª revisão:
//  • QT-01: o COLABORADOR com a chave (e só ela) chega ao SUCESSO REAL na cobrança de um cliente — o
//    polling do PIX (GET /payments/:id/status), a confirmação do cartão (POST /stripe/verify-payment com o
//    PI aprovado), as parcelas (installment-plans), a emissão do PIX/cartão (create-payment) e o "Simular"
//    em sandbox. Um filtro "só o ADMIN vê qualquer cobrança" devolvia 404 à equipe e passava na matriz.
//  • QT-02: um CLIENTE que NÃO é o dono recebe 404 (ou o ramo dele, nas rotas que ignoram o `userId` do
//    corpo) e NADA muda: sessão, saldo, cobrança, PIX/PI emitido, tentativa de personalizado. Cada caso
//    termina com o DONO fazendo a mesma chamada (controle positivo: o estado que o teste confere muda de
//    verdade quando a chamada é legítima).
// A tabela da verdade (eq-authHelpers.MATRIX) também exige `ok` e `stranger` em toda linha mista.

const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

let base = '';
let close: () => Promise<void> = async () => {};

beforeAll(async () => {
    ({ base, close } = await startServer());
});

afterAll(async () => {
    await close();
});

beforeEach(async () => {
    vi.clearAllMocks();
    m(sicoob.getSicoobEnvironment).mockResolvedValue('sandbox');
    m(sicoob.sicoobRemoveCob).mockResolvedValue(true);
    m(sicoob.sicoobCreatePix).mockImplementation(async (p: { amount: number; txid: string; expiresSeconds?: number }) => ({
        id: p.txid,
        pixString: buildStaticBrCode({ key: 'k', amountCents: p.amount, txid: p.txid }),
        status: 'ATIVA',
        expiresAt: new Date(Date.now() + (p.expiresSeconds ?? 3600) * 1000),
    }));
    m(stripe.isStripeEnabled).mockResolvedValue(false);
    m(stripe.stripeCardInstallmentsSupported).mockResolvedValue(false);
    m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: 'pi_x', status: 'requires_payment_method', amount: 0, metadata: {} });
    m(stripe.stripeGetOrCreateCustomer).mockResolvedValue('cus_test');
    m(stripe.stripeCreatePaymentIntent).mockImplementation(async (o: { paymentId: string }) => ({
        clientSecret: `cs_${o.paymentId}`, paymentIntentId: `pi_new_${o.paymentId.slice(0, 8)}`, status: 'requires_payment_method',
    }));
    for (const [i, key] of ['PIX', 'CARTAO', 'BOLETO'].entries()) {
        await prisma.paymentMethodConfig.create({
            data: { key, label: key, shortLabel: key, emoji: '-', description: key, color: '#000000', active: true, sortOrder: i },
        });
    }
});

const go = (method: string, path: string, who?: Who, body?: unknown) => call(base, method, path, who, body);
const staff = (permissions: string[]) => mkStaff({ permissions });

/** Cliente com CPF + cobrança PIX em aberto (Sicoob, ainda sem emissão). */
async function clientWithCharge(over: Parameters<typeof mkPayment>[1] = {}) {
    const client = await mkUser({ cpfCnpj: mkCpf() });
    const payment = await mkPayment(client.id, { provider: 'SICOOB', amount: 84000, dueDate: dbDate(addDaysYmd(todaySp, 5)), ...over });
    return { client, payment };
}

/** PI de cartão APROVADO para a cobrança (o cliente pagou no balcão / no app). */
function approvedIntent(paymentId: string, piId: string, amount = 84000) {
    m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: piId, status: 'succeeded', amount, metadata: { paymentId }, payment_method_types: ['card'] });
}

/** Provedores habilitados: Sicoob (PIX, sandbox) e Stripe (cartão) — com integração cadastrada, cada forma exige o seu. */
async function enableProviders() {
    await enablePixSandbox();
    await prisma.integrationConfig.create({ data: { provider: 'STRIPE', enabled: true, environment: 'sandbox', config: '{}' } });
}

// ═══ QT-01 ══════════════════════════════════════════════

describe('QT-01 — COLABORADOR só com a chave chega ao sucesso REAL na cobrança de um cliente', () => {
    it('GET /payments/:id/status (polling do PIX do balcão): 200 com o PIX do cliente para cada chave aceita', async () => {
        const { payment } = await clientWithCharge({ pixString: 'PIX-DO-CLIENTE' });
        for (const key of ['cobrancas.cobrar', 'financeiro.ver', 'cobrancas.baixa']) {
            const r = await go('GET', `/api/payments/${payment.id}/status`, await staff([key]));
            expect(r.status, `${key}: ${JSON.stringify(r.body)}`).toBe(200);
            expect(r.body).toEqual({ status: 'PENDING', provider: 'SICOOB', pixString: 'PIX-DO-CLIENTE', boletoUrl: null });
        }
    });

    it('POST /stripe/verify-payment com o PI aprovado: 200 PAID e a cobrança do cliente baixada', async () => {
        const { payment } = await clientWithCharge({ provider: 'STRIPE', providerRef: 'pi_balcao' });
        approvedIntent(payment.id, 'pi_balcao');
        const r = await go('POST', '/api/stripe/verify-payment', await staff(['cobrancas.cobrar']), { paymentId: payment.id, paymentIntentId: 'pi_balcao' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body).toEqual({ status: 'PAID', message: 'Pagamento sincronizado.' });
        const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect([after.status, after.providerRef, after.paidAt !== null]).toEqual(['PAID', 'pi_balcao', true]);
    });

    it('POST /stripe/installment-plans com paymentId: 200 com os planos sobre o valor da cobrança do cliente', async () => {
        const { payment } = await clientWithCharge();
        const r = await go('POST', '/api/stripe/installment-plans', await staff(['cobrancas.cobrar']), { paymentId: payment.id });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.cardAmount).toBe(84000);
        expect(r.body.pixAmount).toBe(84000);
        expect(r.body.plans.length).toBeGreaterThan(0);
    });

    it('POST /stripe/create-payment: PIX emitido com o CPF do CLIENTE e PI de cartão no Customer do cliente (200)', async () => {
        await enableProviders();
        const { client, payment } = await clientWithCharge();
        const balcao = await staff(['cobrancas.cobrar']);

        const pix = await go('POST', '/api/stripe/create-payment', balcao, { paymentId: payment.id, paymentMethod: 'pix' });
        expect(pix.status, JSON.stringify(pix.body)).toBe(200);
        expect(pix.body).toMatchObject({ provider: 'SICOOB', paymentId: payment.id, alreadyPaid: false });
        expect(pix.body.pixString).toMatch(/^000201/);
        expect(sicoob.sicoobCreatePix).toHaveBeenCalledTimes(1);
        expect(m(sicoob.sicoobCreatePix).mock.calls[0]![0].customer.document.identity).toBe(client.cpfCnpj);
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).pixString).toBe(pix.body.pixString);

        const { client: other, payment: card } = await clientWithCharge();
        const cartao = await go('POST', '/api/stripe/create-payment', balcao, { paymentId: card.id, paymentMethod: 'cartao' });
        expect(cartao.status, JSON.stringify(cartao.body)).toBe(200);
        expect(cartao.body).toMatchObject({ provider: 'STRIPE', clientSecret: `cs_${card.id}`, amount: 84000 });
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0]).toMatchObject({ paymentId: card.id, userId: other.id });
        expect(m(stripe.stripeGetOrCreateCustomer).mock.calls[0]![0]).toBe(other.id);
        const log = await prisma.auditLog.findMany({ where: { entityType: 'PAYMENT', entityId: card.id } });
        expect(log.map(l => [l.action, l.performedBy])).toEqual([['ADMIN_CHARGE_STARTED', balcao.id]]);
    });

    it('POST /payments/:id/simulate em sandbox: 200 PAID na cobrança do cliente', async () => {
        await enablePixSandbox();
        const { payment } = await clientWithCharge();
        const r = await go('POST', `/api/payments/${payment.id}/simulate`, await staff(['cobrancas.cobrar']));
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.status).toBe('PAID');
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('PAID');
    });
});

// ═══ QT-02 ══════════════════════════════════════════════

describe('QT-02 — CLIENTE que NÃO é o dono: 404 (ou o ramo dele) e nenhum efeito; o dono, na sequência, consegue', () => {
    it('DELETE /bookings/:id de outro cliente → 404; sessão, crédito e cobrança dos extras intactos', async () => {
        const owner = await mkUser();
        const { booking, contract } = await seedFlexBooking(owner, 0);
        const extras = await mkPayment(owner.id, { contractId: contract.id, bookingId: booking.id, amount: 5000 });
        const before = await bookingState(booking.id);

        const r = await go('DELETE', `/api/bookings/${booking.id}`, await mkUser());
        expect(r.status, JSON.stringify(r.body)).toBe(404);
        expect(await bookingState(booking.id)).toEqual(before);
        expect(before.booking.status).toBe('CONFIRMED');
        expect(before.contract?.flexCreditsRemaining).toBe(5);

        // Controle: o dono cancela (> 24 h) — a sessão cai, o crédito volta e os extras são anulados.
        const own = await go('DELETE', `/api/bookings/${booking.id}`, owner);
        expect(own.status, JSON.stringify(own.body)).toBe(200);
        const after = await bookingState(booking.id);
        expect(after.booking.status).toBe('CANCELLED');
        expect(after.contract?.flexCreditsRemaining).toBe(6);
        expect(after.payments.find(p => p.id === extras.id)?.status).toBe('CANCELLED');
    });

    it('PATCH /bookings/:id/makeup de outro cliente → 404; a gravação perdida e a janela continuam iguais', async () => {
        const owner = await mkUser();
        const { booking } = await seedAvulsoMissed(owner);
        const before = await bookingState(booking.id);

        const r = await go('PATCH', `/api/bookings/${booking.id}/makeup`, await mkUser(), { date: weekdayN(0), startTime: '13:00' });
        expect(r.status, JSON.stringify(r.body)).toBe(404);
        expect(await bookingState(booking.id)).toEqual(before);

        const own = await go('PATCH', `/api/bookings/${booking.id}/makeup`, owner, { date: weekdayN(0), startTime: '13:00' });
        expect(own.status, JSON.stringify(own.body)).toBe(200);
        expect(await bookingState(booking.id)).not.toEqual(before);
    });

    it('GET /contracts/:id de outro cliente → 404 sem dado nenhum do contrato', async () => {
        const owner = await mkUser({ cpfCnpj: mkCpf() });
        const c = await mkContract(owner.id);
        const r = await go('GET', `/api/contracts/${c.id}`, await mkUser());
        expect(r.status).toBe(404);
        expect(r.body).not.toHaveProperty('contract');
        expect(JSON.stringify(r.body)).not.toContain(owner.id);

        const own = await go('GET', `/api/contracts/${c.id}`, owner);
        expect(own.status).toBe(200);
        expect(own.body.contract.id).toBe(c.id);
    });

    it('GET /payments/:id/status de outro cliente → 404 sem o PIX nem o boleto alheio', async () => {
        const { client, payment } = await clientWithCharge({ pixString: 'PIX-ALHEIO', boletoUrl: 'https://boleto.test/alheio' });
        const r = await go('GET', `/api/payments/${payment.id}/status`, await mkUser());
        expect(r.status).toBe(404);
        expect(r.body).toEqual({ status: 'NOT_FOUND' });

        const own = await go('GET', `/api/payments/${payment.id}/status`, client);
        expect(own.status).toBe(200);
        expect(own.body.pixString).toBe('PIX-ALHEIO');
    });

    it('POST /payments/:id/simulate (sandbox) de outro cliente → 404 e a cobrança segue em aberto', async () => {
        await enablePixSandbox();
        const { client, payment } = await clientWithCharge();
        const before = await paymentState(payment.id);
        const r = await go('POST', `/api/payments/${payment.id}/simulate`, await mkUser());
        expect(r.status).toBe(404);
        expect(await paymentState(payment.id)).toEqual(before);

        const own = await go('POST', `/api/payments/${payment.id}/simulate`, client);
        expect(own.status, JSON.stringify(own.body)).toBe(200);
        expect((await paymentState(payment.id)).status).toBe('PAID');
    });

    it('POST /stripe/create-payment (PIX e cartão) na cobrança de outro cliente → 404; nada emitido no provedor', async () => {
        await enableProviders();
        const { client, payment } = await clientWithCharge();
        const before = await paymentState(payment.id);
        const stranger = await mkUser({ cpfCnpj: mkCpf() });
        for (const paymentMethod of ['pix', 'cartao']) {
            const r = await go('POST', '/api/stripe/create-payment', stranger, { paymentId: payment.id, paymentMethod });
            expect(r.status, `${paymentMethod}: ${JSON.stringify(r.body)}`).toBe(404);
            expect(r.body).not.toHaveProperty('pixString');
            expect(r.body).not.toHaveProperty('clientSecret');
        }
        expect(sicoob.sicoobCreatePix).not.toHaveBeenCalled();
        expect(stripe.stripeCreatePaymentIntent).not.toHaveBeenCalled();
        expect(stripe.stripeGetOrCreateCustomer).not.toHaveBeenCalled();
        expect(await paymentState(payment.id)).toEqual(before);

        const own = await go('POST', '/api/stripe/create-payment', client, { paymentId: payment.id, paymentMethod: 'pix' });
        expect(own.status, JSON.stringify(own.body)).toBe(200);
        expect((await paymentState(payment.id)).pixString).toBe(own.body.pixString);
    });

    it('POST /stripe/installment-plans com a cobrança de outro cliente → 404 sem o valor dela', async () => {
        const { client, payment } = await clientWithCharge();
        const r = await go('POST', '/api/stripe/installment-plans', await mkUser(), { paymentId: payment.id });
        expect(r.status).toBe(404);
        expect(r.body).not.toHaveProperty('cardAmount');
        expect(r.body).not.toHaveProperty('plans');

        const own = await go('POST', '/api/stripe/installment-plans', client, { paymentId: payment.id });
        expect(own.status).toBe(200);
        expect(own.body.cardAmount).toBe(84000);
    });

    it('POST /stripe/verify-payment com o PI APROVADO da cobrança de outro cliente → 404 e a cobrança NÃO é baixada', async () => {
        const { client, payment } = await clientWithCharge({ provider: 'STRIPE', providerRef: 'pi_alheio' });
        approvedIntent(payment.id, 'pi_alheio');
        const before = await paymentState(payment.id);
        const r = await go('POST', '/api/stripe/verify-payment', await mkUser(), { paymentId: payment.id, paymentIntentId: 'pi_alheio' });
        expect(r.status, JSON.stringify(r.body)).toBe(404);
        expect(stripe.stripeGetPaymentIntent).not.toHaveBeenCalled();
        expect(await paymentState(payment.id)).toEqual(before);

        const own = await go('POST', '/api/stripe/verify-payment', client, { paymentId: payment.id, paymentIntentId: 'pi_alheio' });
        expect(own.status, JSON.stringify(own.body)).toBe(200);
        expect((await paymentState(payment.id)).status).toBe('PAID');
    });

    it('POST /contracts/custom/check e /custom com o userId de outro cliente: o estranho simula e cria para SI; a tentativa do outro fica intacta', async () => {
        const tomorrow = addDaysYmd(todaySp, 1);
        const custom = (day: number, time: string, userId?: string) => ({
            ...(userId ? { userId } : {}), name: 'Personalizado', tier: 'COMERCIAL', durationMonths: 1, paymentMethod: 'CARTAO',
            paymentPlan: 'MONTHLY', schedule: [{ day, time }], startDate: tomorrow,
        });
        const owner = await mkUser();
        // O dono tem uma tentativa VIVA (aguardando pagamento) — o ramo do cliente descarta só as do PRÓPRIO cliente.
        const attempt = await go('POST', '/api/contracts/custom', owner, custom(1, '10:00'));
        expect(attempt.status, JSON.stringify(attempt.body)).toBe(201);
        const before = await clientState(owner.id);
        expect(before.contracts.map(c => c.status)).toEqual(['AWAITING_PAYMENT']);

        const stranger = await mkUser();
        const check = await go('POST', '/api/contracts/custom/check', stranger, {
            userId: owner.id, tier: 'COMERCIAL', durationMonths: 1, startDate: tomorrow, schedule: [{ day: 2, time: '13:00' }],
        });
        expect(check.status, JSON.stringify(check.body)).toBe(200);
        expect(await clientState(owner.id)).toEqual(before);

        const created = await go('POST', '/api/contracts/custom', stranger, custom(3, '15:30', owner.id));
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const mine = await prisma.contract.findMany({ where: { userId: stranger.id }, select: { id: true } });
        expect(mine).toHaveLength(1);
        expect(await clientState(owner.id)).toEqual(before);
    });

    it('POST /coupons/validate com o userId de outro cliente: o estranho é avaliado como ELE MESMO (a equipe, como o alvo)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const owner = await mkUser();
        await mkPayment(owner.id, { status: 'PAID', paidAt: new Date(), amount: 1000 }); // o dono já é cliente antigo
        const novos = await mkCoupon(admin.id, { active: true, onlyNewClients: true });
        const exclusivo = await mkCoupon(admin.id, { active: true, eligibleUsers: { create: [{ userId: owner.id }] } });
        const stranger = await mkUser();
        const body = (code: string) => ({ code, amount: 10000, userId: owner.id });

        // "Só clientes novos": o estranho (novo) passa; o dono e a equipe com o dono como alvo, não.
        const asStranger = await go('POST', '/api/coupons/validate', stranger, body(novos.code));
        expect(asStranger.status, JSON.stringify(asStranger.body)).toBe(200);
        expect(asStranger.body.valid).toBe(true);
        for (const who of [owner, await staff(['cobrancas.cobrar'])]) {
            const r = await go('POST', '/api/coupons/validate', who, body(novos.code));
            expect(r.status, JSON.stringify(r.body)).toBe(403);
            expect(r.body.code).toBe('NOT_NEW_CLIENT');
        }

        // Exclusivo do dono: o estranho não "empresta" a elegibilidade dele; o dono e a equipe, sim.
        const notEligible = await go('POST', '/api/coupons/validate', stranger, body(exclusivo.code));
        expect(notEligible.status).toBe(403);
        expect(notEligible.body.code).toBe('NOT_ELIGIBLE');
        for (const who of [owner, await staff(['agendamentos.criar'])]) {
            expect((await go('POST', '/api/coupons/validate', who, body(exclusivo.code))).status).toBe(200);
        }
        expect(await prisma.couponRedemption.count()).toBe(0);
    });
});
