import { describe, it, expect, vi } from 'vitest';

// RODADA 7 — frente R7a (backend), regras PURAS (sem banco/Redis: os módulos com conexão são stubs, como em
// eq-r5-conserto5-regras):
//  • TELA6-02: o aviso das 7h do avulso RESERVADO cuja cobrança marcada foi só anulada/estornada diz "confirmada" (nada
//    a pagar; o /confirm aceita) — sem a marca a regra não muda.
//  • AUDFIN6-03/TELA6-01: makeupOutcome — o que o PATCH → Não realizado devolve sobre a janela de remarcação.
//  • AUDFIN6-01/ATU6-02: o catálogo diz que cancelar o contrato e decidir o pedido pedem a baixa com cobrança de sessão
//    em aberto; a baixa não diz mais "toda ação que anula cobrança".
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/lib/redis.js', () => ({
    redis: {}, acquireMultiSlotLock: vi.fn(), releaseMultiSlotLock: vi.fn(), acquireMutex: vi.fn(), releaseMutex: vi.fn(),
}));
vi.mock('../src/modules/notifications/notificationService.js', () => ({ notifyEvent: vi.fn(async () => '') }));
vi.mock('../src/lib/businessConfig.js', () => ({
    getConfig: async (k: string) => (k === 'avulso_makeup_days' ? 7 : 4),
    getConfigString: async () => '',
    getAllConfigs: async () => ({}),
    invalidateConfigCache: () => {},
}));

import { isBookingPaid, type BookingForConfirm } from '../src/jobs/dailyConfirmationJob';
import {
    makeupOutcome, makeupExpiredReason, NO_MAKEUP_WINDOW_ERROR, computeMakeupDeadline, makeupBlockReason,
} from '../src/lib/avulsoMakeup';
import { buildStaffCatalog } from '../src/config/staffPermissions';

const MARK = { sessionCharge: true };
const session = (status: string) => ({ status, metadata: MARK, paymentUrl: null });
const unmarked = (status: string) => ({ status, metadata: null, paymentUrl: null });

describe('TELA6-02 — aviso das 7h do avulso Reservado com a cobrança marcada só anulada/estornada', () => {
    const now = new Date('2026-11-05T10:00:00Z');
    const avulso = { status: 'ACTIVE', type: 'AVULSO', payments: [] };
    const b = (over: Partial<BookingForConfirm>): BookingForConfirm => ({ status: 'RESERVED', payments: [], contract: avulso, ...over });

    it('marcada CANCELLED ou REFUNDED, Reservado → "confirmada" (nada a pagar — coerente com o /confirm)', () => {
        expect(isBookingPaid(b({ payments: [session('CANCELLED')] }), now)).toBe(true);
        expect(isBookingPaid(b({ payments: [session('REFUNDED')] }), now)).toBe(true);
        // Avulso sem contrato carregado (regra 2 vale para "contrato desconhecido" também).
        expect(isBookingPaid(b({ payments: [session('CANCELLED')], contract: null }), now)).toBe(true);
    });
    it('controles: marcada em aberto continua "Pague para confirmar" (mesmo com outra anulada); sem a marca a regra não muda', () => {
        expect(isBookingPaid(b({ payments: [session('PENDING')] }), now)).toBe(false);
        expect(isBookingPaid(b({ payments: [session('FAILED'), session('CANCELLED')] }), now)).toBe(false);
        // Avulso do próprio cliente (sem a marca) com a cobrança anulada: o /confirm ainda espera — o aviso também.
        expect(isBookingPaid(b({ payments: [unmarked('CANCELLED')] }), now)).toBe(false);
        expect(isBookingPaid(b({ payments: [] }), now)).toBe(false);
        expect(isBookingPaid(b({ status: 'CONFIRMED', payments: [] }), now)).toBe(true);
    });
});

describe('AUDFIN6-03/TELA6-01 — makeupOutcome: a resposta do PATCH → Não realizado diz o que o servidor fez', () => {
    const now = new Date('2026-11-05T13:00:00Z');
    const missed = new Date('2026-11-04T00:00:00Z');
    const deadline = computeMakeupDeadline(missed, 7); // fim do dia 11/11 em SP

    it('janela ABERTA e no prazo → makeupOpened, com o prazo gravado e sem motivo', () => {
        expect(makeupOutcome({ status: 'NAO_REALIZADO', makeupStatus: 'OPEN', makeupDeadline: deadline }, null, now)).toEqual({
            makeupOpened: true, makeupDeadline: deadline.toISOString(), makeupBlockReason: null,
        });
    });
    it('janela VENCIDA (EXPIRED, ou OPEN com o prazo já passado) → não aberta, com o prazo e o motivo do prazo (a equipe remarca)', () => {
        const past = computeMakeupDeadline(new Date('2026-10-01T00:00:00Z'), 7);
        for (const ms of ['EXPIRED', 'OPEN']) {
            const r = makeupOutcome({ status: 'NAO_REALIZADO', makeupStatus: ms, makeupDeadline: past }, null, now);
            expect(r, ms).toEqual({ makeupOpened: false, makeupDeadline: past.toISOString(), makeupBlockReason: makeupExpiredReason(past) });
        }
        expect(makeupExpiredReason(past)).toBe('O prazo da remarcação sem novo pagamento terminou em 08/10: o cliente não remarca pelo app, mas a equipe ainda pode remarcar (Remarcar).');
    });
    it('sem janela → não aberta, sem prazo, com o motivo do servidor (não paga / anulada / contrato cancelado) ou o texto genérico', () => {
        const unpaid = makeupBlockReason({ contractStatus: 'ACTIVE', payments: [session('PENDING')] });
        const voided = makeupBlockReason({ contractStatus: 'ACTIVE', payments: [session('CANCELLED')] });
        expect(unpaid).toMatch(/não está confirmado/);
        expect(voided).toBe(unpaid); // cobrança anulada: também "não paga"
        expect(makeupOutcome({ status: 'NAO_REALIZADO', makeupStatus: null, makeupDeadline: null }, unpaid, now)).toEqual({
            makeupOpened: false, makeupDeadline: null, makeupBlockReason: unpaid,
        });
        // USED (remarcação já feita) e nova falha sem poder abrir: o prazo antigo não é devolvido.
        expect(makeupOutcome({ status: 'NAO_REALIZADO', makeupStatus: 'USED', makeupDeadline: deadline }, null, now)).toEqual({
            makeupOpened: false, makeupDeadline: null, makeupBlockReason: NO_MAKEUP_WINDOW_ERROR,
        });
    });
});

describe('AUDFIN6-01/ATU6-02 — catálogo: cancelar o contrato e decidir o pedido com cobrança de sessão em aberto pedem a baixa', () => {
    const actions = buildStaffCatalog().modules.flatMap(m => m.actions);
    const action = (key: string) => actions.find(x => x.key === key)!;
    const BAIXA = `“${action('cobrancas.baixa').label.replace(/\s*\(baixa manual\)$/, '')}”`;

    it('contratos.cancelar e contratos.multa citam o avulso E a gravação cobrada à parte (SERVIÇO, extra do Fixo…)', () => {
        for (const key of ['contratos.cancelar', 'contratos.multa']) {
            const d = action(key).description;
            expect(d, key).toMatch(/No avulso ou em gravação cobrada à parte, com cobrança em aberto, exige também/);
            expect(d, key).toContain(BAIXA);
            expect(d.length, key).toBeLessThan(200);
        }
    });
    it('cobrancas.baixa: sem a afirmação falsa "toda ação que anula cobrança" (D2: cancelar um plano anula as parcelas sem ela)', () => {
        const d = action('cobrancas.baixa').description;
        expect(d).not.toMatch(/toda ação/);
        expect(d).toMatch(/cancelar sessão com cobrança em aberto/);
        expect(d).toMatch(/reabrir sessão cancelada/);
        expect(d.length).toBeLessThan(200);
    });
});
