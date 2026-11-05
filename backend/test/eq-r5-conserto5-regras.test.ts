import { describe, it, expect, vi } from 'vitest';

// CONSERTO 5 (revisão 5) — regras PURAS (sem banco/Redis: os módulos com conexão são stubs, como em
// eq-r5-cobranca-regras):
//  • AUDFIN-02: sessionPaymentState ganha `open`; awaitsOwnPayment (com a marca) só espera cobrança marcada EM ABERTO;
//    isBookingPaid (aviso das 7h) cai nas regras 2/3 quando a marcada está só anulada/estornada.
//  • AUDFIN-01/ATU5-01/TELA5-01: ownSessionChargeState ('live' | 'voided' | 'none') — a base do 409 da reabertura.
//  • ATU5-02/TELA5-02: o teto do FIXO só exclui a marca fixoExtra (a sessionCharge sozinha ocupa a vaga).
//  • TELA5-04/AUDFIN-03/AUDFIN-04/ATU5-03: descrições do catálogo que o dono lê ao conceder dizem a verdade.
//  • AUDFIN-04: o texto do 403 da exclusão de cliente.
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

import {
    sessionPaymentState, awaitsOwnPayment, ownSessionChargeState, occupiesFixoCap, hasFixoExtraMark, fixoCapUsageWhere,
    FIXO_EXTRA_MARK_WHERE,
} from '../src/modules/bookings/sessionPayment';
import { FIXO_EXTRA_METADATA, SESSION_CHARGE_METADATA } from '../src/lib/sessionCharge';
import { isBookingPaid, type BookingForConfirm } from '../src/jobs/dailyConfirmationJob';
import { isContractFulfilled, type CompletionInput } from '../src/lib/contractCompletion';
import { STAFF_PRESETS, buildStaffCatalog } from '../src/config/staffPermissions';
import { deletionMissingPermissionsMessage, DELETION_SETTLE_KEYS } from '../src/lib/userDeletion';

const MARK = { sessionCharge: true };
const EXTRA_URL = JSON.stringify({ addonKeys: ['CORTES_IA'] });
const session = (status: string) => ({ status, metadata: MARK, paymentUrl: null });
const extra = (status: string) => ({ status, metadata: null, paymentUrl: EXTRA_URL });
const unmarked = (status: string) => ({ status, metadata: null, paymentUrl: null });

describe('AUDFIN-02 — a marcada só anulada/estornada não deixa nada a pagar', () => {
    it('awaitsOwnPayment: marcada CANCELLED ou REFUNDED → não espera (SERVIÇO, FIXO, FLEX, AVULSO)', () => {
        for (const t of ['SERVICO', 'FIXO', 'FLEX', 'AVULSO']) {
            expect(awaitsOwnPayment(sessionPaymentState([session('CANCELLED')]), { contractType: t }), `${t}/CANCELLED`).toBe(false);
            expect(awaitsOwnPayment(sessionPaymentState([session('REFUNDED')]), { contractType: t }), `${t}/REFUNDED`).toBe(false);
        }
    });
    it('awaitsOwnPayment: com alguma marcada em aberto continua esperando (e um extra pago não muda nada)', () => {
        expect(awaitsOwnPayment(sessionPaymentState([session('PENDING'), session('CANCELLED')]), { contractType: 'SERVICO' })).toBe(true);
        expect(awaitsOwnPayment(sessionPaymentState([session('FAILED'), extra('PAID')]), { contractType: 'AVULSO' })).toBe(true);
        expect(awaitsOwnPayment(sessionPaymentState([session('PAID')]), { contractType: 'AVULSO' })).toBe(false);
    });
    it('sem a marca a regra não muda: avulso/hold sem a gravação paga espera, mesmo com a cobrança anulada', () => {
        expect(awaitsOwnPayment(sessionPaymentState([unmarked('CANCELLED')]), { contractType: 'AVULSO' })).toBe(true);
        expect(awaitsOwnPayment(sessionPaymentState([]), { contractType: 'FIXO', holdExpiresAt: new Date() })).toBe(true);
        expect(awaitsOwnPayment(sessionPaymentState([extra('PENDING')]), { contractType: 'FIXO' })).toBe(false);
    });

    const now = new Date('2026-11-05T10:00:00Z');
    const inDay = (type: string) => ({ status: 'ACTIVE', type, payments: [{ status: 'PAID', dueDate: new Date('2026-11-01T00:00:00Z'), bookingId: null }] });
    const late = (type: string) => ({ status: 'ACTIVE', type, payments: [{ status: 'PENDING', dueDate: new Date('2026-10-01T00:00:00Z'), bookingId: null }] });
    const b = (over: Partial<BookingForConfirm>): BookingForConfirm => ({ status: 'RESERVED', payments: [], contract: null, ...over });

    it('isBookingPaid: SERVIÇO em dia com a marcada ANULADA → "confirmada" (regra 3); em atraso → não', () => {
        expect(isBookingPaid(b({ status: 'CONFIRMED', payments: [session('CANCELLED')], contract: inDay('SERVICO') }), now)).toBe(true);
        expect(isBookingPaid(b({ payments: [session('REFUNDED')], contract: inDay('SERVICO') }), now)).toBe(true);
        expect(isBookingPaid(b({ payments: [session('CANCELLED')], contract: late('SERVICO') }), now)).toBe(false);
    });
    it('isBookingPaid: avulso com a marcada ANULADA → Reservado e Confirmado "confirmada" (regra 2; TELA6-02: nada a pagar)', () => {
        const avulso = { status: 'ACTIVE', type: 'AVULSO', payments: [] };
        expect(isBookingPaid(b({ payments: [session('CANCELLED')], contract: avulso }), now)).toBe(true);
        expect(isBookingPaid(b({ status: 'CONFIRMED', payments: [session('CANCELLED')], contract: avulso }), now)).toBe(true);
    });
    it('isBookingPaid: marcada em aberto continua decidindo sozinha (contrato em dia não a substitui)', () => {
        expect(isBookingPaid(b({ payments: [session('PENDING'), session('CANCELLED')], contract: inDay('SERVICO') }), now)).toBe(false);
        expect(isBookingPaid(b({ payments: [session('PAID'), session('CANCELLED')], contract: late('SERVICO') }), now)).toBe(true);
    });
});

describe('AUDFIN-01/ATU5-01/TELA5-01 — ownSessionChargeState (base do 409 da reabertura)', () => {
    it('marcada: viva (PAID/PENDING/FAILED) → live; só CANCELLED → voided; só REFUNDED → none', () => {
        for (const s of ['PAID', 'PENDING', 'FAILED']) expect(ownSessionChargeState([session(s), session('CANCELLED')], 'SERVICO'), s).toBe('live');
        expect(ownSessionChargeState([session('CANCELLED')], 'SERVICO')).toBe('voided');
        expect(ownSessionChargeState([session('CANCELLED'), extra('PAID')], 'FIXO')).toBe('voided');
        expect(ownSessionChargeState([session('REFUNDED')], 'SERVICO')).toBe('none');
    });
    it('avulso sem a marca: a cobrança que não é extra; extras sozinhos e sessão de plano → none', () => {
        expect(ownSessionChargeState([unmarked('CANCELLED'), extra('PAID')], 'AVULSO')).toBe('voided');
        expect(ownSessionChargeState([unmarked('PAID')], 'AVULSO')).toBe('live');
        expect(ownSessionChargeState([extra('CANCELLED')], 'AVULSO')).toBe('none');
        expect(ownSessionChargeState([unmarked('CANCELLED')], 'FIXO')).toBe('none'); // plano: não é cobrança própria
        expect(ownSessionChargeState([], 'FIXO')).toBe('none');
    });
});

describe('ATU5-02/TELA5-02 — teto do FIXO: só a sessão EXTRA (fixoExtra) fica fora', () => {
    it('a marca do extra é metadata.fixoExtra === true; a sessionCharge sozinha NÃO tira a sessão do teto', () => {
        expect(FIXO_EXTRA_METADATA).toEqual({ fixoExtra: true });
        expect(hasFixoExtraMark({ metadata: { ...SESSION_CHARGE_METADATA, ...FIXO_EXTRA_METADATA } })).toBe(true);
        expect(hasFixoExtraMark({ metadata: { ...SESSION_CHARGE_METADATA } })).toBe(false);
        expect(hasFixoExtraMark({ metadata: { fixoExtra: 'true' } })).toBe(false);
        expect(FIXO_EXTRA_MARK_WHERE).toEqual({ metadata: { path: ['fixoExtra'], equals: true } });
        expect(fixoCapUsageWhere('c').payments).toEqual({ none: FIXO_EXTRA_MARK_WHERE });
        expect(occupiesFixoCap({ status: 'CONFIRMED' })).toBe(true);
        expect(occupiesFixoCap({ status: 'CONFIRMED', fixoExtra: true })).toBe(false);
    });
    it('conclusão: 3 do plano + a cobrada DENTRO do teto (sem fixoExtra) concluem um FIXO de 4; com a EXTRA não', () => {
        const mk = (bookings: CompletionInput['bookings']): CompletionInput => ({
            type: 'FIXO', durationMonths: 1, flexCreditsRemaining: null, customCreditsRemaining: null, bookings,
        });
        const plan = Array.from({ length: 3 }, () => ({ status: 'COMPLETED' }));
        expect(isContractFulfilled(mk([...plan, { status: 'COMPLETED' }]), 4)).toBe(true);
        expect(isContractFulfilled(mk([...plan, { status: 'COMPLETED', fixoExtra: true }]), 4)).toBe(false);
    });
});

describe('TELA5-04 (+ AUDFIN-03/AUDFIN-04/ATU5-03) — o catálogo diz quando a baixa (e outras chaves) também é exigida', () => {
    const actions = buildStaffCatalog().modules.flatMap(m => m.actions);
    const action = (key: string) => {
        const a = actions.find(x => x.key === key);
        if (!a) throw new Error(`ação ${key} fora do catálogo`);
        return a;
    };
    const BAIXA = action('cobrancas.baixa').label.replace(/\s*\(baixa manual\)$/, ''); // “Marcar como pago, anular ou estornar”

    it('cancelar e excluir sessão: com cobrança em aberto, só com a baixa (e por quê)', () => {
        for (const key of ['agendamentos.cancelar', 'agendamentos.excluir']) {
            const d = action(key).description;
            expect(d, key).toMatch(/cobrança em aberto/);
            expect(d, key).toContain(BAIXA);
            expect(d, key).toMatch(/anula a cobrança/);
        }
    });
    it('editar: reabrir sessão cancelada exige também a baixa; a baixa diz que é exigida ao anular e ao reabrir', () => {
        expect(action('agendamentos.editar').description).toMatch(/Reabrir sessão cancelada exige também “Marcar como pago, anular ou estornar”/);
        const baixa = action('cobrancas.baixa').description;
        // ATU6-02: "toda ação que anula cobrança em aberto" era falso (cancelar um plano anula as parcelas sem ela — D2).
        expect(baixa).toMatch(/Exigida também ao cancelar sessão com cobrança em aberto/);
        expect(baixa).not.toMatch(/toda ação/);
        expect(baixa).toMatch(/reabrir sessão cancelada/);
    });
    it('contratos: pausar o Fixo e cancelar o avulso com cobrança em aberto pedem a baixa; excluir cliente pede a chave de cada coisa', () => {
        expect(action('contratos.editar').description).toMatch(/Pausar um Fixo .*cobrança em aberto exige também “Marcar como pago, anular ou estornar”/);
        expect(action('contratos.cancelar').description).toMatch(/No avulso .*cobrança em aberto, exige também “Marcar como pago, anular ou estornar”/);
        expect(action('clientes.excluir').description).toMatch(/exige também a chave de cada um \(contrato, multa, baixa\)/);
    });
    it('perfil Recepção: avisa que não reabre sessão cancelada nem cancela sessão com cobrança em aberto (e segue "não renova")', () => {
        const d = STAFF_PRESETS.find(p => p.key === 'recepcao')!.description;
        expect(d).toMatch(/não renova/);
        expect(d).toMatch(/não reabre sessão cancelada/);
        expect(d).toMatch(/cobrança em aberto/);
    });
    it('todas as descrições continuam abaixo de 200 caracteres (limite da tela)', () => {
        for (const a of actions) expect(a.description.length, a.key).toBeLessThan(200);
    });
});

describe('AUDFIN-04 — o 403 da exclusão de cliente diz o que falta, na ordem das chaves', () => {
    it('ordem fixa e texto com o rótulo de cada chave', () => {
        expect(DELETION_SETTLE_KEYS).toEqual(['contratos.cancelar', 'contratos.multa', 'cobrancas.baixa']);
        expect(deletionMissingPermissionsMessage(['cobrancas.baixa'])).toBe(
            'Excluir este cliente anula o que ele tem em aberto, e isso exige também “Marcar como pago, anular ou estornar” (há cobrança em aberto de sessão, avulsa ou de contrato encerrado). Nada foi excluído: peça a quem tem essa permissão.',
        );
        const two = deletionMissingPermissionsMessage(['contratos.cancelar', 'contratos.multa']);
        expect(two).toMatch(/“Cancelar contrato” \(há contrato em andamento\); “Decidir pedido de cancelamento \(cobrar ou isentar multa\)”/);
        expect(two).toMatch(/essas permissões\.$/);
    });
    it('os rótulos citados são os do catálogo', () => {
        const labels = buildStaffCatalog().modules.flatMap(m => m.actions);
        const msg = deletionMissingPermissionsMessage([...DELETION_SETTLE_KEYS]);
        for (const key of DELETION_SETTLE_KEYS) {
            const label = labels.find(a => a.key === key)!.label.replace(/\s*\(baixa manual\)$/, '');
            expect(msg, key).toContain(`“${label}”`);
        }
    });
});
