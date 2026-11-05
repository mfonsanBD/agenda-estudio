import { describe, it, expect, vi } from 'vitest';

// FRENTE R5a — regras PURAS do pagamento DA SESSÃO e do teto do FIXO (sem banco/Redis: os módulos com conexão são
// trocados por stubs, como em avulso-makeup.test.ts).
//  • sessionPaymentState (ATU4-02/ATU4-04/UXT-07): com a marca sessionCharge, paga só com nenhuma marcada em aberto
//    e uma marcada PAID; sem a marca, um PAID que não seja a compra de um extra (paymentUrl { addonKeys }).
//  • isBookingPaid (aviso das 7h), makeupBlockReason (remarcação do avulso) e isContractFulfilled (FIXO com extra)
//    usam essa MESMA regra.
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/lib/redis.js', () => ({ redis: {}, acquireMultiSlotLock: vi.fn(), releaseMultiSlotLock: vi.fn() }));
vi.mock('../src/modules/notifications/notificationService.js', () => ({ notifyEvent: vi.fn(async () => '') }));
vi.mock('../src/lib/businessConfig.js', () => ({
    getConfig: async (k: string) => (k === 'avulso_makeup_days' ? 7 : 4),
    getConfigString: async () => '',
    getAllConfigs: async () => ({}),
    invalidateConfigCache: () => {},
}));

import {
    isAddonPurchase, hasSessionChargeMark, sessionPaymentState, awaitsOwnPayment, occupiesFixoCap, fixoCapUsageWhere,
    FIXO_CAP_STATUSES,
} from '../src/modules/bookings/sessionPayment';
import { isBookingPaid, type BookingForConfirm } from '../src/jobs/dailyConfirmationJob';
import { makeupBlockReason, makeupBlockReasonOf } from '../src/lib/avulsoMakeup';
import { isContractFulfilled, type CompletionInput } from '../src/lib/contractCompletion';

const MARK = { sessionCharge: true };
const EXTRA_URL = JSON.stringify({ addonKeys: ['CORTES_IA'] });
const session = (status: string) => ({ status, metadata: MARK, paymentUrl: null });
const extra = (status: string) => ({ status, metadata: null, paymentUrl: EXTRA_URL });
const unmarked = (status: string) => ({ status, metadata: null, paymentUrl: null });

describe('isAddonPurchase — a compra de um extra é a cobrança com as chaves no paymentUrl (formato do POST /:id/addons)', () => {
    it('addonKeys / addonKey (legado) → extra; URL de checkout, vazio, JSON sem chaves ou quebrado → não', () => {
        expect(isAddonPurchase({ paymentUrl: EXTRA_URL })).toBe(true);
        expect(isAddonPurchase({ paymentUrl: JSON.stringify({ addonKey: 'CAPA' }) })).toBe(true);
        expect(isAddonPurchase({ paymentUrl: JSON.stringify({ addonKeys: [] }) })).toBe(false);
        expect(isAddonPurchase({ paymentUrl: JSON.stringify({ other: 1 }) })).toBe(false);
        expect(isAddonPurchase({ paymentUrl: 'https://checkout.stripe.com/c/pay/cs_test' })).toBe(false);
        expect(isAddonPurchase({ paymentUrl: '{quebrado' })).toBe(false);
        expect(isAddonPurchase({ paymentUrl: null })).toBe(false);
        expect(isAddonPurchase({})).toBe(false);
    });
    it('a marca é metadata.sessionCharge === true (objeto), nada mais', () => {
        expect(hasSessionChargeMark({ metadata: MARK })).toBe(true);
        expect(hasSessionChargeMark({ metadata: { sessionCharge: 'true' } })).toBe(false);
        expect(hasSessionChargeMark({ metadata: [true] })).toBe(false);
        expect(hasSessionChargeMark({ metadata: null })).toBe(false);
    });
});

describe('sessionPaymentState — a cobrança da GRAVAÇÃO está paga?', () => {
    it('com a marca: um extra pago nunca a substitui; qualquer marcada em aberto → não paga', () => {
        // `open` (conserto 5 — AUDFIN-02): há marcada PENDING/FAILED, ou seja, algo a pagar.
        expect(sessionPaymentState([session('PENDING'), extra('PAID')])).toEqual({ marked: true, paid: false, open: true });
        expect(sessionPaymentState([session('FAILED'), extra('PAID')])).toEqual({ marked: true, paid: false, open: true });
        expect(sessionPaymentState([session('PAID'), extra('PENDING')])).toEqual({ marked: true, paid: true, open: false });
        expect(sessionPaymentState([session('PAID'), session('FAILED')])).toEqual({ marked: true, paid: false, open: true });
        expect(sessionPaymentState([session('CANCELLED')])).toEqual({ marked: true, paid: false, open: false });
        expect(sessionPaymentState([session('REFUNDED')])).toEqual({ marked: true, paid: false, open: false });
        // A marca decide: um PAID sem a marca (ex.: parcela gravada com bookingId por engano) não conta.
        expect(sessionPaymentState([session('PENDING'), unmarked('PAID')])).toEqual({ marked: true, paid: false, open: true });
    });
    it('sem a marca (legado / avulso do cliente): exige um PAID que não seja a compra de um extra', () => {
        expect(sessionPaymentState([unmarked('PAID')])).toEqual({ marked: false, paid: true, open: false });
        expect(sessionPaymentState([unmarked('PENDING'), extra('PAID')])).toEqual({ marked: false, paid: false, open: false });
        expect(sessionPaymentState([extra('PAID')])).toEqual({ marked: false, paid: false, open: false });
        expect(sessionPaymentState([])).toEqual({ marked: false, paid: false, open: false });
    });
    it('awaitsOwnPayment: só espera quem PRECISA de cobrança própria (marca, avulso ou hold) e não a pagou', () => {
        const none = sessionPaymentState([extra('PENDING')]);
        expect(awaitsOwnPayment(none, { contractType: 'FIXO' })).toBe(false); // sessão de plano: extras não seguram
        expect(awaitsOwnPayment(none, { contractType: 'AVULSO' })).toBe(true);
        expect(awaitsOwnPayment(none, { contractType: 'FIXO', holdExpiresAt: new Date() })).toBe(true);
        expect(awaitsOwnPayment(sessionPaymentState([session('PENDING'), extra('PAID')]), { contractType: 'SERVICO' })).toBe(true);
        expect(awaitsOwnPayment(sessionPaymentState([session('PAID')]), { contractType: 'SERVICO' })).toBe(false);
        expect(awaitsOwnPayment(sessionPaymentState([unmarked('PAID')]), { contractType: 'AVULSO', holdExpiresAt: new Date() })).toBe(false);
    });
});

describe('ATU4-02 — isBookingPaid (aviso das 7h "Gravação confirmada")', () => {
    const now = new Date('2026-11-05T10:00:00Z');
    const activeInDay = (type: string) => ({
        status: 'ACTIVE', type,
        payments: [{ status: 'PAID', dueDate: new Date('2026-11-01T00:00:00Z'), bookingId: null }],
    });
    const b = (over: Partial<BookingForConfirm>): BookingForConfirm => ({ status: 'RESERVED', payments: [], contract: null, ...over });

    it('SERVIÇO em dia com a cobrança da sessão PENDING e nenhum PAID → não paga (era "confirmada" pela regra 3)', () => {
        expect(isBookingPaid(b({ payments: [session('PENDING')], contract: activeInDay('SERVICO') }), now)).toBe(false);
    });
    it('SERVIÇO em dia com a cobrança da sessão PAGA → paga', () => {
        expect(isBookingPaid(b({ payments: [session('PAID')], contract: activeInDay('SERVICO') }), now)).toBe(true);
    });
    it('FIXO extra com a sessão PENDING e um extra PAGO → não paga (era "confirmada" pela regra 1)', () => {
        expect(isBookingPaid(b({ payments: [session('PENDING'), extra('PAID')], contract: activeInDay('FIXO') }), now)).toBe(false);
    });
    it('regressão: FIXO em dia só com um extra PENDING (sem a marca) → paga, como antes', () => {
        expect(isBookingPaid(b({ payments: [extra('PENDING')], contract: activeInDay('FIXO') }), now)).toBe(true);
    });
    it('avulso RESERVED com a cobrança da sessão PENDING → não paga; avulso do cliente pago (sem a marca) → paga', () => {
        expect(isBookingPaid(b({ payments: [session('PENDING')], contract: { status: 'ACTIVE', type: 'AVULSO', payments: [] } }), now)).toBe(false);
        expect(isBookingPaid(b({ status: 'CONFIRMED', payments: [unmarked('PAID')], contract: { status: 'ACTIVE', type: 'AVULSO', payments: [] } }), now)).toBe(true);
    });
    it('avulso sem a marca só com o EXTRA pago e a gravação em aberto → não paga (o extra não conta)', () => {
        expect(isBookingPaid(b({ payments: [unmarked('PENDING'), extra('PAID')], contract: { status: 'ACTIVE', type: 'AVULSO', payments: [] } }), now)).toBe(false);
    });
});

describe('ATU4-04/UXT-07 — makeupBlockReason: a remarcação "sem novo pagamento" exige a GRAVAÇÃO paga', () => {
    const NOT_PAID = 'O pagamento desta gravação não está confirmado; a remarcação sem novo pagamento só vale para gravação paga.';
    it('avulso da equipe (marca) com a sessão PENDING e um extra PAGO → bloqueia', () => {
        expect(makeupBlockReason({ contractStatus: 'ACTIVE', payments: [session('PENDING'), extra('PAID')] })).toBe(NOT_PAID);
        expect(makeupBlockReasonOf({
            contract: { status: 'ACTIVE', payments: [session('PENDING'), extra('PAID')] },
            payments: [session('PENDING'), extra('PAID')],
        })).toBe(NOT_PAID);
    });
    it('controle: a sessão paga (com ou sem a marca) → libera; estorno e contrato encerrado seguem bloqueando', () => {
        expect(makeupBlockReason({ contractStatus: 'ACTIVE', payments: [session('PAID'), extra('PENDING')] })).toBeNull();
        expect(makeupBlockReason({ contractStatus: 'COMPLETED', payments: [unmarked('PAID')] })).toBeNull();
        expect(makeupBlockReason({ contractStatus: 'ACTIVE', payments: [unmarked('PENDING'), extra('PAID')] })).toBe(NOT_PAID);
        expect(makeupBlockReason({ contractStatus: 'ACTIVE', payments: [unmarked('REFUNDED')] })).toMatch(/estornado/);
        expect(makeupBlockReason({ contractStatus: 'CANCELLED', payments: [unmarked('PAID')] })).toMatch(/cancelado ou encerrado/);
    });
});

describe('Teto do FIXO — a sessão EXTRA (marca fixoExtra: criada com o teto cheio) não ocupa vaga do plano', () => {
    it('occupiesFixoCap e fixoCapUsageWhere (mesma regra, memória × banco)', () => {
        expect(FIXO_CAP_STATUSES).toEqual(['COMPLETED', 'CONFIRMED', 'FALTA', 'RESERVED']);
        for (const s of FIXO_CAP_STATUSES) {
            expect(occupiesFixoCap({ status: s })).toBe(true);
            expect(occupiesFixoCap({ status: s, fixoExtra: true })).toBe(false);
        }
        expect(occupiesFixoCap({ status: 'NAO_REALIZADO' })).toBe(false);
        expect(occupiesFixoCap({ status: 'CANCELLED' })).toBe(false);
        expect(fixoCapUsageWhere('c1')).toEqual({
            contractId: 'c1',
            status: { in: FIXO_CAP_STATUSES },
            payments: { none: { metadata: { path: ['fixoExtra'], equals: true } } },
        });
    });
    it('isContractFulfilled: 3 sessões do plano + 1 extra concluídas NÃO concluem um FIXO de 4; 4 do plano + 1 extra concluem', () => {
        const mk = (bookings: CompletionInput['bookings']): CompletionInput => ({
            type: 'FIXO', durationMonths: 1, flexCreditsRemaining: null, customCreditsRemaining: null, bookings,
        });
        const plan = (n: number) => Array.from({ length: n }, () => ({ status: 'COMPLETED' }));
        const extraDone = { status: 'COMPLETED', fixoExtra: true };
        expect(isContractFulfilled(mk([...plan(3), extraDone]), 4)).toBe(false);
        expect(isContractFulfilled(mk([...plan(3), extraDone, extraDone]), 4)).toBe(false);
        expect(isContractFulfilled(mk([...plan(4), extraDone]), 4)).toBe(true);
        // Uma extra ainda por acontecer segura a conclusão (sessão pendente), como qualquer sessão.
        expect(isContractFulfilled(mk([...plan(4), { status: 'RESERVED', fixoExtra: true }]), 4)).toBe(false);
    });
});
