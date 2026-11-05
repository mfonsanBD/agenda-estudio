import { describe, it, expect } from 'vitest';
import {
    ADMIN_BOOKING_DOWNGRADE_MESSAGE,
    adminPlanBookingReservedMessage,
    requiredForAdminBookingCreate,
    requiredForContractPatch,
    type RuleResult,
} from '../src/lib/permissionRules';

// FRENTE X2 — regras puras corrigidas na revisão adversarial (lib/permissionRules.ts):
//  • DIN-06 / MAT-04 / EQ-REQ-04: POST /bookings/admin com paymentMethod BOLETO (o servidor emite o boleto
//    no banco na hora) exige cobrancas.cobrar; PIX/CARTAO não.
//  • MAT-03 / DIN-04: reabrir contrato CANCELADO pelo PATCH exige, além da chave do destino, contratos.cancelar
//    (desfaz a decisão de cancelar) e contratos.condicoes (devolve créditos/sessões sem parcela em aberto).
//  • REG-1: a mensagem da sessão de plano criada sem a baixa não diz "aguardando pagamento".

const keysOf = (r: RuleResult) => r.requirements.map(q => [...q.anyOf]);

describe('requiredForAdminBookingCreate — boleto exige cobrancas.cobrar (DIN-06 / MAT-04 / EQ-REQ-04)', () => {
    const base = { userId: 'u', date: '2030-01-02', startTime: '10:00', status: 'RESERVED' };

    it('BOLETO → agendamentos.criar + cobrancas.cobrar (com ou sem a baixa)', () => {
        for (const canMarkPaid of [false, true]) {
            const p = requiredForAdminBookingCreate({ ...base, paymentMethod: 'BOLETO' }, { standardPrice: 30000, canMarkPaid });
            expect(keysOf(p)).toEqual([['agendamentos.criar'], ['cobrancas.cobrar']]);
        }
    });
    it('PIX, CARTAO e sem paymentMethod (default CARTAO do schema) → só agendamentos.criar', () => {
        for (const paymentMethod of ['PIX', 'CARTAO', undefined]) {
            const p = requiredForAdminBookingCreate({ ...base, paymentMethod }, { standardPrice: 30000, canMarkPaid: false });
            expect(keysOf(p), String(paymentMethod)).toEqual([['agendamentos.criar']]);
        }
    });
    it('BOLETO com "Confirmado" sem a baixa: rebaixa como antes e ainda exige cobrancas.cobrar', () => {
        const p = requiredForAdminBookingCreate({ ...base, status: 'CONFIRMED', paymentMethod: 'BOLETO' }, { standardPrice: 30000, canMarkPaid: false });
        expect(p).toMatchObject({ status: 'RESERVED', downgraded: true });
        expect(keysOf(p)).toEqual([['agendamentos.criar'], ['cobrancas.cobrar']]);
    });
    it('BOLETO + preço personalizado: exige as duas chaves (cobrar e baixa)', () => {
        const p = requiredForAdminBookingCreate({ ...base, paymentMethod: 'BOLETO', customPrice: 100 }, { standardPrice: 30000, canMarkPaid: false });
        expect(keysOf(p)).toEqual([['agendamentos.criar'], ['cobrancas.cobrar'], ['cobrancas.baixa']]);
    });
});

const CONTRACT = {
    status: 'ACTIVE', endDate: new Date('2026-12-15T00:00:00Z'), flexCreditsRemaining: 8,
    contractUrl: null, paymentMethod: 'PIX', boletoAllowed: false,
};

describe('requiredForContractPatch — reabrir contrato CANCELADO (MAT-03 / DIN-04)', () => {
    const cancelled = { ...CONTRACT, status: 'CANCELLED' };

    it('CANCELLED → ACTIVE, COMPLETED ou EXPIRED: editar + cancelar + condições', () => {
        for (const status of ['ACTIVE', 'COMPLETED', 'EXPIRED']) {
            expect(keysOf(requiredForContractPatch({ status }, cancelled)), status)
                .toEqual([['contratos.editar'], ['contratos.cancelar'], ['contratos.condicoes']]);
        }
    });
    it('CANCELLED → CANCELLED (mesmo status, o "Editar" reenviando) não exige nada', () => {
        expect(keysOf(requiredForContractPatch({ status: 'CANCELLED' }, cancelled))).toEqual([]);
    });
    it('contrato cancelado: mudar só o link segue contratos.editar (a trava é da mudança de status)', () => {
        expect(keysOf(requiredForContractPatch({ contractUrl: 'https://x.y/z' }, cancelled))).toEqual([['contratos.editar']]);
    });
    it('outras origens não mudam: ACTIVE/PAUSED → editar; PENDING_CANCELLATION → editar + multa', () => {
        expect(keysOf(requiredForContractPatch({ status: 'COMPLETED' }, CONTRACT))).toEqual([['contratos.editar']]);
        expect(keysOf(requiredForContractPatch({ status: 'ACTIVE' }, { ...CONTRACT, status: 'PAUSED' }))).toEqual([['contratos.editar']]);
        expect(keysOf(requiredForContractPatch({ status: 'ACTIVE' }, { ...CONTRACT, status: 'PENDING_CANCELLATION' })))
            .toEqual([['contratos.editar'], ['contratos.multa']]);
        expect(keysOf(requiredForContractPatch({ status: 'ACTIVE' }, { ...CONTRACT, status: 'AWAITING_PAYMENT' }))).toEqual([['contratos.editar']]);
    });
});

describe('mensagem da sessão de plano criada sem a baixa (REG-1)', () => {
    it('nunca diz "aguardando pagamento" da sessão; com extras, só os extras aguardam', () => {
        const none = adminPlanBookingReservedMessage(false);
        const extras = adminPlanBookingReservedMessage(true);
        expect(none).toMatch(/presença a confirmar/);
        expect(none).toMatch(/nenhuma cobrança/);
        expect(none).not.toMatch(/aguardando pagamento/);
        expect(extras).toMatch(/só os serviços extras ficam aguardando pagamento/);
        expect(ADMIN_BOOKING_DOWNGRADE_MESSAGE).toMatch(/aguardando pagamento/); // o avulso continua igual
    });
});
