import { describe, it, expect, vi, beforeEach } from 'vitest';

// FRENTE R4-CONSERTO3 (revisão 3) — as correções de TELA ganham teste no repositório (UXT-03). O front não tem
// runner próprio, mas o vitest do backend importa os espelhos dele (como o eq-integracao-sync) com React e o hook
// usePermission trocados por stubs: o `perms` abaixo é mutável, então cada caso escolhe o acesso.
//  - UXT-01: a dica "falta a baixa" da sessão cancelada só aparece quando a baixa é o ÚNICO requisito que falta;
//  - FIN-07: a dica não afirma "a cobrança foi anulada" nem manda criar outro agendamento sem ressalva; avulso tem a sua;
//  - FIN-06/ATU-01: o diálogo de cancelar avisa a anulação da cobrança em aberto e a trava de quem não tem a baixa
//    (R5: a trava passou a ser por cobrança em aberto em QUALQUER status — o detalhe está no eq-r5-front);
//  - UXT-03: TELA-5 (chargesWithoutScreen), TELA-1 (credentialsLocked) e as paridades canAccessTier e
//    SESSION_PLAN_TYPES (front × servidor).

const perms = vi.hoisted(() => ({ isAdmin: false, keys: new Set<string>() }));
vi.mock('react', () => ({ useMemo: (f: () => unknown) => f() }));
vi.mock('../../frontend/src/hooks/usePermission', () => ({
    usePermission: () => ({
        isAdmin: perms.isAdmin,
        can: (k: string) => perms.isAdmin || perms.keys.has(k),
        canAny: (...ks: string[]) => perms.isAdmin || ks.some(k => perms.keys.has(k)),
    }),
}));

import {
    useBookingPermissions,
    cancelledReopenNeedsBaixaHint,
    CANCELLED_REOPEN_NEEDS_BAIXA,
    CANCELLED_AVULSO_REOPEN_NEEDS_BAIXA,
} from '../../frontend/src/components/admin/bookings/bookingPermissions';
import { cancelBookingConsequences } from '../../frontend/src/components/admin/bookings/bookingDanger';
import {
    canAccessTier as frontCanAccessTier,
    accessibleTierLabels,
    SESSION_PLAN_TYPES as FRONT_PLAN_TYPES,
} from '../../frontend/src/components/admin/bookings/tierAccess';
import { chargesWithoutScreen, credentialsLocked, COUNTER_CHARGE_KEYS } from '../../frontend/src/components/admin/team/teamPermissions';
import { canAccessTier as backCanAccessTier } from '../src/utils/pricing';
import { SESSION_PLAN_TYPES as BACK_PLAN_TYPES } from '../src/lib/sessionCharge';
import { STAFF_PRESETS } from '../src/config/staffPermissions';

const RECEPCAO = ['agendamentos.ver', 'agendamentos.criar', 'agendamentos.editar', 'agendamentos.faltas', 'agendamentos.cancelar', 'hoje.ver', 'hoje.presenca', 'clientes.ver', 'clientes.criar', 'clientes.editar', 'contratos.ver', 'contratos.criar', 'cobrancas.cobrar', 'cupons.ver'];
const OPERADOR = ['agendamentos.ver', 'agendamentos.faltas', 'hoje.ver', 'hoje.presenca', 'hoje.gravacao', 'clientes.ver', 'relatorios.ver', 'config.gravacoes'];
const ALL = ['RESERVED', 'CONFIRMED', 'COMPLETED', 'FALTA', 'NAO_REALIZADO', 'CANCELLED'];
const CONTRACT_TYPES = ['FIXO', 'FLEX', 'SERVICO', 'AVULSO', null] as const;
const cancelled = (type: string | null) => ({ status: 'CANCELLED', contract: type ? { type } : null });

function as(keys: readonly string[], isAdmin = false) {
    perms.isAdmin = isAdmin;
    perms.keys = new Set(keys);
    return useBookingPermissions();
}

beforeEach(() => { perms.isAdmin = false; perms.keys = new Set(); });

describe('UXT-01 — a dica "falta a baixa" só quando a baixa é o único requisito que falta', () => {
    it('Operador de estúdio (sem agendamentos.editar): sem dica — e, mesmo com a baixa, continua sem reabrir', () => {
        const op = as(OPERADOR);
        for (const t of CONTRACT_TYPES) {
            expect(op.cancelledReopenNeedsBaixa(cancelled(t)), String(t)).toBe(false);
            expect(op.statusOptions(cancelled(t), ALL), String(t)).toEqual(['CANCELLED']);
        }
        const opBaixa = as([...OPERADOR, 'cobrancas.baixa']);
        expect(opBaixa.statusOptions(cancelled('FIXO'), ALL)).toEqual(['CANCELLED']);
    });

    it('Recepção (tem editar, não tem a baixa): dica em toda sessão cancelada que o plano deixaria reabrir', () => {
        const rec = as(RECEPCAO);
        for (const t of CONTRACT_TYPES) {
            expect(rec.cancelledReopenNeedsBaixa(cancelled(t)), String(t)).toBe(true);
            expect(rec.statusOptions(cancelled(t), ALL), String(t)).toEqual(['CANCELLED']);
        }
        // Personalizado não sai de Cancelado nem com a baixa: vale a dica do plano, não a da baixa.
        expect(rec.cancelledReopenNeedsBaixa(cancelled('CUSTOM'))).toBe(false);
        // Sessão que não está cancelada nunca mostra a dica.
        expect(rec.cancelledReopenNeedsBaixa({ status: 'COMPLETED', contract: { type: 'FIXO' } })).toBe(false);
    });

    it('com a baixa (Recepção + baixa) ou ADMIN: sem dica; o FIXO reabre tudo e o FLEX só Concluído', () => {
        const withBaixa = as([...RECEPCAO, 'cobrancas.baixa']);
        expect(withBaixa.cancelledReopenNeedsBaixa(cancelled('FIXO'))).toBe(false);
        expect(withBaixa.statusOptions(cancelled('FIXO'), ALL)).toEqual(expect.arrayContaining(['RESERVED', 'CONFIRMED', 'COMPLETED', 'NAO_REALIZADO', 'CANCELLED']));
        expect(withBaixa.statusOptions(cancelled('FLEX'), ALL)).toEqual(['COMPLETED', 'CANCELLED']);
        const admin = as([], true);
        for (const t of CONTRACT_TYPES) expect(admin.cancelledReopenNeedsBaixa(cancelled(t)), String(t)).toBe(false);
        expect(withBaixa.canSettleCharges).toBe(true);
        expect(admin.canSettleCharges).toBe(true);
        expect(as(RECEPCAO).canSettleCharges).toBe(false);
    });

    it('invariante: sempre que a dica aparece, somar só a baixa libera ao menos uma opção (todos os modelos de perfil)', () => {
        const sets: (readonly string[])[] = [OPERADOR, RECEPCAO, ...STAFF_PRESETS.map(p => p.permissions)];
        const checked: string[] = [];
        for (const keys of sets) {
            for (const t of [...CONTRACT_TYPES, 'CUSTOM']) {
                const b = cancelled(t);
                if (!as(keys).cancelledReopenNeedsBaixa(b)) continue;
                checked.push(`${keys.length}:${t}`);
                expect(as([...keys, 'cobrancas.baixa']).statusOptions(b, ALL).length, `${keys.join(',')} / ${t}`).toBeGreaterThan(1);
            }
        }
        expect(checked.length).toBeGreaterThan(0); // a Recepção (e os modelos com editar) passam por aqui
    });
});

describe('FIN-07 — a dica da sessão cancelada não manda cobrar de novo', () => {
    it('texto geral: sem "foi anulada" e sem um "crie um novo agendamento" incondicional', () => {
        expect(CANCELLED_REOPEN_NEEDS_BAIXA).not.toMatch(/anulada/);
        expect(CANCELLED_REOPEN_NEEDS_BAIXA).toMatch(/Crie um novo agendamento só se esta sessão não foi paga/);
        expect(CANCELLED_REOPEN_NEEDS_BAIXA).toMatch(/“Marcar como pago, anular ou estornar”/);
    });

    it('avulso: texto próprio (a cobrança continua valendo; não criar outro agendamento) SÓ com cobrança em aberto conhecida (TELA5-03); demais: o geral', () => {
        // Desde a R5 o cancelamento ANULA a cobrança em aberto do avulso: o texto do avulso só vale para o legado ainda
        // em aberto (openChargeCount > 0). Contagem 0 (paga ou anulada) ou ausente → o texto geral.
        expect(cancelledReopenNeedsBaixaHint({ ...cancelled('AVULSO'), openChargeCount: 1 })).toBe(CANCELLED_AVULSO_REOPEN_NEEDS_BAIXA);
        expect(cancelledReopenNeedsBaixaHint({ ...cancelled('AVULSO'), openChargeCount: 0 })).toBe(CANCELLED_REOPEN_NEEDS_BAIXA);
        expect(cancelledReopenNeedsBaixaHint(cancelled('AVULSO'))).toBe(CANCELLED_REOPEN_NEEDS_BAIXA);
        expect(CANCELLED_AVULSO_REOPEN_NEEDS_BAIXA).toMatch(/Não crie um novo agendamento/);
        expect(CANCELLED_AVULSO_REOPEN_NEEDS_BAIXA).not.toMatch(/anulada/);
        for (const t of ['FIXO', 'FLEX', 'SERVICO', null]) {
            expect(cancelledReopenNeedsBaixaHint(cancelled(t)), String(t)).toBe(CANCELLED_REOPEN_NEEDS_BAIXA);
        }
    });
});

describe('FIN-06/ATU-01 — o diálogo de cancelar diz o que acontece com a cobrança (textos da R5)', () => {
    const base = { date: '2026-11-20T00:00:00.000Z', startTime: '10:00', endTime: '12:00', makeupStatus: null, makeupDeadline: null, user: { name: 'Ana' } };
    const servico = { id: 's', name: 'Serviço Ana', type: 'SERVICO' as const, tier: 'COMERCIAL' as const };
    const flex = { id: 'f', name: 'Flex Ana', type: 'FLEX' as const, tier: 'COMERCIAL' as const };
    const avulso = { id: 'a', name: 'Avulso Ana', type: 'AVULSO' as const, tier: 'COMERCIAL' as const };
    const NEEDS_BAIXA = /cancelar exige a permissão “Marcar como pago, anular ou estornar”/;

    it('R5: sem a baixa, o aviso vem da cobrança em aberto (qualquer status), não mais de "a sessão já aconteceu"', () => {
        const done = { ...base, status: 'COMPLETED' as const, contract: servico };
        expect(cancelBookingConsequences(done, { canSettleCharges: false }).some(l => NEEDS_BAIXA.test(l))).toBe(true);
        expect(cancelBookingConsequences(done, { canSettleCharges: true }).some(l => NEEDS_BAIXA.test(l))).toBe(false);
        // Sessão futura também: o critério do servidor (R5) é a cobrança em aberto, não o "já aconteceu".
        const future = { ...base, status: 'RESERVED' as const, contract: servico };
        expect(cancelBookingConsequences(future, { canSettleCharges: false }).some(l => NEEDS_BAIXA.test(l))).toBe(true);
        // Sem cobrança em aberto (contagem do servidor = 0): nenhum aviso.
        expect(cancelBookingConsequences({ ...done, openChargeCount: 0 }, { canSettleCharges: false }).some(l => NEEDS_BAIXA.test(l))).toBe(false);
        expect(cancelBookingConsequences({ ...future, openChargeCount: 0 }, { canSettleCharges: false }).some(l => NEEDS_BAIXA.test(l))).toBe(false);
    });

    it('a cobrança em aberto é anulada (o avulso tem texto próprio, sem "continua como está"); o FLEX não promete crédito', () => {
        const done = cancelBookingConsequences({ ...base, status: 'COMPLETED', contract: servico }, { canSettleCharges: true });
        expect(done).toContain('Nenhum pagamento já feito é estornado. A cobrança ainda em aberto desta gravação (a da própria sessão, quando ela é cobrada à parte, e a dos serviços extras) é anulada.');
        expect(done).not.toContain('Nenhum pagamento é estornado automaticamente.');
        // FIN-10: o texto antigo do avulso ("continua como está") era falso — a cobrança fica sem como ser paga.
        const av = cancelBookingConsequences({ ...base, status: 'FALTA', contract: avulso }, { canSettleCharges: true });
        expect(av).toContain('Nenhum pagamento já feito é estornado nem vira crédito para outro agendamento. A cobrança em aberto desta gravação deixa de ser devida.');
        expect(av.some(l => /continua como está/.test(l))).toBe(false);
        // ATU4-03/UXT-05: no FLEX concluído o crédito NÃO volta sem condição (numa semana fechada ele é confiscado).
        const fx = cancelBookingConsequences({ ...base, status: 'COMPLETED', contract: flex }, { canSettleCharges: true });
        expect(fx).toContain('No Flex, o saldo do contrato "Flex Ana" é recalculado pela conferência automática: o crédito desta sessão só volta se a semana dela ainda não fechou ou se o cliente está adiantado no ritmo semanal; senão, ele é perdido.');
        expect(fx.some(l => /volta para o contrato .* na próxima conferência/.test(l))).toBe(false);
    });
});

describe('UXT-03 — correções de tela da R4 com teste no repositório', () => {
    it('TELA-5 chargesWithoutScreen: só a cobrança automática não avisa; cobrança de balcão sem tela avisa', () => {
        expect(chargesWithoutScreen(new Set(['clientes.ver', 'cobrancas.automatica']))).toBe(false);
        expect(chargesWithoutScreen(new Set(['cobrancas.cobrar']))).toBe(true);
        expect(chargesWithoutScreen(new Set(['clientes.ver', 'cobrancas.automatica', 'cobrancas.baixa']))).toBe(true);
        expect(chargesWithoutScreen(new Set(['cobrancas.cobrar', 'agendamentos.criar']))).toBe(false);
        expect(chargesWithoutScreen(new Set(['cobrancas.cartao_salvo', 'contratos.ver']))).toBe(false);
        expect([...COUNTER_CHARGE_KEYS].sort()).toEqual(['cobrancas.baixa', 'cobrancas.cartao_salvo', 'cobrancas.cobrar']);
    });

    it('TELA-1 credentialsLocked: ADMIN e ex-ADMIN travados; colaborador que nunca foi ADMIN, livre', () => {
        expect(credentialsLocked({ role: 'ADMIN' })).toBe(true);
        expect(credentialsLocked({ role: 'COLABORADOR' })).toBe(false);
        expect(credentialsLocked({ role: 'COLABORADOR', credentialsLocked: true })).toBe(true);
        expect(credentialsLocked({ role: 'COLABORADOR', credentialsLocked: false })).toBe(false);
        expect(credentialsLocked({ role: 'ADMIN', credentialsLocked: true })).toBe(true);
    });

    it('paridade canAccessTier: front (tierAccess) × servidor (utils/pricing) em todos os pares; faixa desconhecida → não', () => {
        const TIERS = ['COMERCIAL', 'AUDIENCIA', 'SABADO'] as const;
        for (const plan of TIERS) for (const slot of TIERS) {
            expect(frontCanAccessTier(plan, slot), `${plan} × ${slot}`).toBe(backCanAccessTier(plan, slot));
        }
        expect(frontCanAccessTier('COMERCIAL', 'NOTURNO')).toBe(false);
        expect(frontCanAccessTier('NOTURNO', 'COMERCIAL')).toBe(false);
        expect(accessibleTierLabels('AUDIENCIA')).toBe('Comercial e Audiência');
        expect(accessibleTierLabels('SABADO')).toBe('Comercial, Audiência e Sábado');
    });

    it('paridade SESSION_PLAN_TYPES: o EditBookingModal usa a mesma lista de planos que cobrem a sessão do servidor', () => {
        expect([...FRONT_PLAN_TYPES].sort()).toEqual([...BACK_PLAN_TYPES].sort());
    });
});
