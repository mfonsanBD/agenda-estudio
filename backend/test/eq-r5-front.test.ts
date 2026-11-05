import { describe, it, expect, vi, beforeEach } from 'vitest';

// FRENTE R5b — decisões de TELA da rodada 5, testadas como funções puras do front (mesmo molde do
// eq-r4-conserto3-front: React e usePermission trocados por stubs; `perms` mutável escolhe o acesso).
//  - R5 (espelho do critério estrutural do servidor): sem cobrancas.baixa, a equipe não cancela sessão com cobrança
//    em aberto (`openChargeCount` > 0, em qualquer status) — o Cancelar some/fica indisponível com a explicação;
//    contagem ausente = desconhecida (não trava; o diálogo avisa e o 403 do servidor aparece).
//  - FIN-10 / UXT-05 / ATU4-03: textos do diálogo de cancelar (avulso sem "1 crédito volta"; Flex sem promessa).
//  - Pendências do r4-conserto3: Falta a partir de Concluído/Cancelado não é oferecida (400 para todos); a dica de
//    reabrir sessão cancelada não fala em "cobrança anulada".
//  - UXT-08: decisões que estavam inline nos componentes viraram funções puras — FIN-03 (tierChangeBlockedFor),
//    TELA-1 (canSetPasswordFor, memberCredentialsLocked) e o cancelar (cancelBlockedByOpenCharge). A LIGAÇÃO dos
//    componentes a elas é conferida no eq-r5-front-ligacao.

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
    cancelBlockedByOpenCharge,
    knownOpenChargeCount,
    isFaltaRefused,
    cancelledReopenNeedsBaixaHint,
    cancelledPlanReopenHint,
    CANCEL_OPEN_CHARGE_NEEDS_BAIXA,
    CANCELLED_REOPEN_NEEDS_BAIXA,
    CANCELLED_AVULSO_REOPEN_NEEDS_BAIXA,
} from '../../frontend/src/components/admin/bookings/bookingPermissions';
import {
    cancelBookingConsequences,
    hardDeleteConsequences,
    flexSessionWeekSurelyOpen,
    CANCEL_UNKNOWN_CHARGE_NEEDS_BAIXA,
} from '../../frontend/src/components/admin/bookings/bookingDanger';
import { tierChangeBlockedFor, planContractOf } from '../../frontend/src/components/admin/bookings/tierAccess';
import { canSetPasswordFor, memberCredentialsLocked } from '../../frontend/src/components/admin/team/teamPermissions';
import { computeFlexState, targetForfeit } from '../src/lib/flexCredits';

const RECEPCAO = ['agendamentos.ver', 'agendamentos.criar', 'agendamentos.editar', 'agendamentos.faltas', 'agendamentos.cancelar', 'hoje.ver', 'hoje.presenca', 'clientes.ver', 'clientes.criar', 'clientes.editar', 'contratos.ver', 'contratos.criar', 'cobrancas.cobrar', 'cupons.ver'];
const OPERADOR = ['agendamentos.ver', 'agendamentos.faltas', 'hoje.ver', 'hoje.presenca', 'hoje.gravacao', 'clientes.ver', 'relatorios.ver', 'config.gravacoes'];
const ALL = ['RESERVED', 'CONFIRMED', 'COMPLETED', 'FALTA', 'NAO_REALIZADO', 'CANCELLED'];
const OPEN_OR_DONE = ['RESERVED', 'HELD', 'CONFIRMED', 'COMPLETED', 'FALTA', 'NAO_REALIZADO'];
const CONTRACT_TYPES = ['FIXO', 'FLEX', 'SERVICO', 'AVULSO', 'CUSTOM', null] as const;

function as(keys: readonly string[], isAdmin = false) {
    perms.isAdmin = isAdmin;
    perms.keys = new Set(keys);
    return useBookingPermissions();
}
const sess = (status: string, openChargeCount?: number | null, type: string | null = 'SERVICO', recordingStartedAt: string | null = null) =>
    ({ status, openChargeCount, recordingStartedAt, contract: type ? { type } : null });

beforeEach(() => { perms.isAdmin = false; perms.keys = new Set(); });

describe('R5 — cancelar sessão com cobrança em aberto exige a baixa (decisão pura)', () => {
    it('cancelBlockedByOpenCharge: trava só com contagem CONHECIDA > 0 e sem a baixa; nunca numa sessão já cancelada', () => {
        for (const status of OPEN_OR_DONE) {
            expect(cancelBlockedByOpenCharge({ status, openChargeCount: 1 }, false), status).toBe(true);
            expect(cancelBlockedByOpenCharge({ status, openChargeCount: 3 }, false), status).toBe(true);
            expect(cancelBlockedByOpenCharge({ status, openChargeCount: 1 }, true), status).toBe(false);
            expect(cancelBlockedByOpenCharge({ status, openChargeCount: 0 }, false), status).toBe(false);
            // Ausente = desconhecido: não trava (o servidor decide e a mensagem dele aparece).
            expect(cancelBlockedByOpenCharge({ status }, false), status).toBe(false);
            expect(cancelBlockedByOpenCharge({ status, openChargeCount: null }, false), status).toBe(false);
        }
        expect(cancelBlockedByOpenCharge({ status: 'CANCELLED', openChargeCount: 2 }, false)).toBe(false);
    });

    it('knownOpenChargeCount: só número finito conta; o resto é desconhecido', () => {
        expect(knownOpenChargeCount({ openChargeCount: 0 })).toBe(0);
        expect(knownOpenChargeCount({ openChargeCount: 2 })).toBe(2);
        expect(knownOpenChargeCount({})).toBeNull();
        expect(knownOpenChargeCount({ openChargeCount: null })).toBeNull();
        expect(knownOpenChargeCount({ openChargeCount: Number.NaN })).toBeNull();
        expect(knownOpenChargeCount({ openChargeCount: '1' as unknown as number })).toBeNull();
    });

    it('o texto da explicação é o combinado com a frente R5a', () => {
        expect(CANCEL_OPEN_CHARGE_NEEDS_BAIXA).toBe('Esta sessão tem cobrança em aberto: cancelar anula a cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa ou, se o cliente faltou, use Falta (a cobrança continua devida).');
    });
});

describe('R5 — o hook useBookingPermissions aplica a decisão (Agendamentos, Editar, Hoje)', () => {
    it('Recepção (sem a baixa): com cobrança em aberto o Cancelado some do seletor e vira a dica; a Falta continua', () => {
        const rec = as(RECEPCAO);
        for (const status of ['RESERVED', 'CONFIRMED', 'COMPLETED', 'FALTA']) {
            const b = sess(status, 1);
            expect(rec.canChangeStatus(b, 'CANCELLED'), status).toBe(false);
            expect(rec.statusOptions(b, ALL), status).not.toContain('CANCELLED');
            expect(rec.cancelNeedsBaixa(b), status).toBe(true);
            // Não é "o seu acesso não permite": a explicação é a da cobrança em aberto.
            expect(rec.hiddenByAccess(b, 'CANCELLED'), status).toBe(false);
        }
        // "use Falta": da sessão aberta a Falta segue oferecida.
        expect(rec.statusOptions(sess('CONFIRMED', 1), ALL)).toContain('FALTA');
        // Com a gravação iniciada também (o critério não é mais o "já aconteceu").
        expect(rec.cancelNeedsBaixa(sess('CONFIRMED', 2, 'FIXO', '2026-11-05T13:00:00.000Z'))).toBe(true);
    });

    it('Recepção sem cobrança em aberto (0) ou com a contagem desconhecida: o Cancelado segue oferecido', () => {
        const rec = as(RECEPCAO);
        for (const status of ['RESERVED', 'CONFIRMED', 'COMPLETED', 'FALTA']) {
            for (const n of [0, undefined]) {
                const b = sess(status, n);
                expect(rec.canChangeStatus(b, 'CANCELLED'), `${status}/${n}`).toBe(true);
                expect(rec.cancelNeedsBaixa(b), `${status}/${n}`).toBe(false);
            }
        }
    });

    it('com a baixa (Recepção + baixa) e o ADMIN: cancelam a sessão com cobrança em aberto, sem dica', () => {
        for (const p of [as([...RECEPCAO, 'cobrancas.baixa']), as([], true)]) {
            const b = sess('COMPLETED', 2);
            expect(p.canChangeStatus(b, 'CANCELLED')).toBe(true);
            expect(p.statusOptions(b, ALL)).toContain('CANCELLED');
            expect(p.cancelNeedsBaixa(b)).toBe(false);
            expect(p.canSettleCharges).toBe(true);
        }
    });

    it('sem agendamentos.cancelar (Operador): nada de dica da cobrança — o que esconde o Cancelado é o acesso', () => {
        const op = as(OPERADOR);
        const b = sess('CONFIRMED', 1);
        expect(op.cancelNeedsBaixa(b)).toBe(false);
        expect(op.canChangeStatus(b, 'CANCELLED')).toBe(false);
        expect(op.hiddenByAccess(b, 'CANCELLED')).toBe(true);
    });

    it('sessão já cancelada: sem dica de cancelar (a reabertura tem a regra própria)', () => {
        expect(as(RECEPCAO).cancelNeedsBaixa(sess('CANCELLED', 1))).toBe(false);
    });
});

describe('Pendência do r4-conserto3 — Falta a partir de Concluído/Cancelado não é oferecida (400 para todos)', () => {
    it('isFaltaRefused: só Concluído e Cancelado → Falta', () => {
        for (const from of ['COMPLETED', 'CANCELLED']) expect(isFaltaRefused({ status: from }, 'FALTA'), from).toBe(true);
        for (const from of ['RESERVED', 'HELD', 'CONFIRMED', 'NAO_REALIZADO', 'FALTA']) expect(isFaltaRefused({ status: from }, 'FALTA'), from).toBe(false);
        for (const to of ['CONFIRMED', 'COMPLETED', 'NAO_REALIZADO', 'CANCELLED']) expect(isFaltaRefused({ status: 'CANCELLED' }, to), to).toBe(false);
    });

    it('nenhum acesso (ADMIN, Recepção + baixa) vê Falta a partir de Concluído/Cancelado, em nenhum tipo de contrato', () => {
        const admin = as([], true);
        const recBaixa = as([...RECEPCAO, 'cobrancas.baixa']);
        for (const t of CONTRACT_TYPES) {
            for (const from of ['COMPLETED', 'CANCELLED']) {
                const b = sess(from, 0, t);
                expect(admin.statusOptions(b, ALL), `${t}/${from}`).not.toContain('FALTA');
                expect(recBaixa.statusOptions(b, ALL), `${t}/${from}`).not.toContain('FALTA');
                // Regra de negócio, não de acesso: não entra no aviso "o seu acesso não permite".
                expect(recBaixa.hiddenByAccess(b, 'FALTA'), `${t}/${from}`).toBe(false);
            }
        }
        // O FIXO cancelado continua reabrindo para quem tem a baixa (só a Falta saiu).
        expect(recBaixa.statusOptions(sess('CANCELLED', 0, 'FIXO'), ALL)).toEqual(['RESERVED', 'CONFIRMED', 'COMPLETED', 'NAO_REALIZADO', 'CANCELLED']);
        // Das sessões abertas e do Não realizado, a Falta segue oferecida.
        for (const from of ['RESERVED', 'CONFIRMED', 'NAO_REALIZADO']) expect(admin.statusOptions(sess(from, 0), ALL), from).toContain('FALTA');
    });

    it('dicas de reabrir sessão cancelada não afirmam que a cobrança foi anulada', () => {
        const hints = [
            CANCELLED_REOPEN_NEEDS_BAIXA, CANCELLED_AVULSO_REOPEN_NEEDS_BAIXA,
            ...CONTRACT_TYPES.map(t => cancelledReopenNeedsBaixaHint(sess('CANCELLED', 0, t))),
            cancelledPlanReopenHint('FLEX'), cancelledPlanReopenHint('CUSTOM'),
        ];
        for (const h of hints) {
            expect(h).not.toMatch(/anulad/);
            expect(h).toMatch(/^(Reabrir uma sessão (avulsa )?cancelada exige a permissão “Marcar como pago, anular ou estornar”|Sessão cancelada de plano)/);
        }
    });
});

describe('FIN-10 / UXT-05 / ATU4-03 — textos do diálogo de cancelar e excluir', () => {
    const NOW = new Date('2026-11-05T15:00:00.000Z');
    const base = { startTime: '10:00', endTime: '12:00', makeupStatus: null, makeupDeadline: null, user: { name: 'Ana' } };
    const FUT = '2026-11-20T00:00:00.000Z';
    const PAST = '2026-10-01T00:00:00.000Z';
    const flex = { id: 'f', name: 'Flex Ana', type: 'FLEX' as const, tier: 'COMERCIAL' as const };
    const avulso = { id: 'a', name: 'Avulso Ana', type: 'AVULSO' as const, tier: 'COMERCIAL' as const };
    const custom = { id: 'c', name: 'Pers Ana', type: 'CUSTOM' as unknown as 'FIXO', tier: 'COMERCIAL' as const };
    const fixo = { id: 'x', name: 'Fixo Ana', type: 'FIXO' as const, tier: 'COMERCIAL' as const };
    const ok = { canSettleCharges: true, now: NOW };
    const CREDIT_PROMISE = /1 crédito volta|volta para o contrato .* na próxima conferência/;

    it('avulso: nenhuma linha "1 crédito volta" (cancelar e excluir); a cobrança em aberto deixa de ser devida', () => {
        for (const status of ['RESERVED', 'CONFIRMED', 'COMPLETED', 'FALTA', 'NAO_REALIZADO'] as const) {
            const b = { ...base, date: FUT, status, contract: avulso };
            const lines = cancelBookingConsequences(b, ok);
            expect(lines.some(l => /crédito volta/.test(l)), status).toBe(false);
            expect(lines, status).toContain('Nenhum pagamento já feito é estornado nem vira crédito para outro agendamento. A cobrança em aberto desta gravação deixa de ser devida.');
            expect(lines.some(l => /continua como está/.test(l)), status).toBe(false);
            expect(hardDeleteConsequences(b, ok).some(l => /crédito volta/.test(l)), status).toBe(false);
        }
    });

    it('Flex: sessão futura não realizada → "1 crédito volta" com a ressalva do vencimento; passada → sem promessa', () => {
        const future = cancelBookingConsequences({ ...base, date: FUT, status: 'RESERVED', contract: flex }, ok);
        expect(future).toContain('1 crédito volta para o contrato "Flex Ana" (no Flex, ele pode vencer se a semana desta sessão fechar sem outra gravação).');
        expect(hardDeleteConsequences({ ...base, date: FUT, status: 'CONFIRMED', contract: flex }, ok))
            .toContain('1 crédito volta para o contrato "Flex Ana" (no Flex, ele pode vencer se a semana desta sessão fechar sem outra gravação).');
        const RECALC = 'No Flex, o saldo do contrato "Flex Ana" é recalculado pela conferência automática: o crédito desta sessão só volta se a semana dela ainda não fechou ou se o cliente está adiantado no ritmo semanal; senão, ele é perdido.';
        // Confirmada passada (sem gravação) e as já realizadas: a tela não sabe se a semana fechou → condicional.
        for (const status of ['CONFIRMED', 'COMPLETED', 'FALTA'] as const) {
            const lines = cancelBookingConsequences({ ...base, date: PAST, status, contract: flex }, ok);
            expect(lines, status).toContain(RECALC);
            expect(lines.some(l => CREDIT_PROMISE.test(l)), status).toBe(false);
        }
        // Concluída de hoje também (o PATCH não devolve na hora; quem refaz é a conferência).
        expect(cancelBookingConsequences({ ...base, date: '2026-11-05T00:00:00.000Z', status: 'COMPLETED', contract: flex }, ok)).toContain(RECALC);
        // Remarcada: conta a data-âncora (originalDate), como o cron.
        const moved = { ...base, date: FUT, originalDate: PAST, status: 'CONFIRMED' as const, contract: flex };
        expect(cancelBookingConsequences(moved, ok)).toContain(RECALC);
        // Não realizado: o crédito já voltou; cancelar tira a âncora do ritmo (pode haver confisco).
        const nr = cancelBookingConsequences({ ...base, date: PAST, status: 'NAO_REALIZADO', contract: flex }, ok);
        expect(nr).toContain('No Flex, esta sessão deixa de contar no ritmo semanal: se a semana dela já fechou, a conferência automática pode confiscar 1 crédito do contrato "Flex Ana".');
        expect(nr.some(l => CREDIT_PROMISE.test(l))).toBe(false);
    });

    it('Personalizado e Fixo: textos de sempre (o Personalizado não tem conferência do saldo)', () => {
        expect(cancelBookingConsequences({ ...base, date: FUT, status: 'RESERVED', contract: custom }, ok)).toContain('Se o contrato "Pers Ana" controla créditos, 1 crédito volta para ele.');
        expect(cancelBookingConsequences({ ...base, date: PAST, status: 'COMPLETED', contract: custom }, ok)).toContain('O crédito já usado por esta sessão não volta para o contrato "Pers Ana".');
        const fx = cancelBookingConsequences({ ...base, date: FUT, status: 'RESERVED', contract: fixo }, ok);
        expect(fx.some(l => /crédito/.test(l))).toBe(false);
        expect(fx).toContain('Nenhum pagamento já feito é estornado. A cobrança ainda em aberto desta gravação (a da própria sessão, quando ela é cobrada à parte, e a dos serviços extras) é anulada.');
    });

    it('sem a baixa: contagem desconhecida → aviso condicional; > 0 → a explicação do R5; 0 → nada. Com a baixa → nada', () => {
        const b = { ...base, date: FUT, status: 'RESERVED' as const, contract: fixo };
        expect(cancelBookingConsequences(b, { canSettleCharges: false, now: NOW })).toContain(CANCEL_UNKNOWN_CHARGE_NEEDS_BAIXA);
        expect(cancelBookingConsequences({ ...b, openChargeCount: 1 }, { canSettleCharges: false, now: NOW })).toContain(CANCEL_OPEN_CHARGE_NEEDS_BAIXA);
        const none = cancelBookingConsequences({ ...b, openChargeCount: 0 }, { canSettleCharges: false, now: NOW });
        expect(none).not.toContain(CANCEL_UNKNOWN_CHARGE_NEEDS_BAIXA);
        expect(none).not.toContain(CANCEL_OPEN_CHARGE_NEEDS_BAIXA);
        const withBaixa = cancelBookingConsequences({ ...b, openChargeCount: 3 }, { canSettleCharges: true, now: NOW });
        expect(withBaixa).not.toContain(CANCEL_UNKNOWN_CHARGE_NEEDS_BAIXA);
        expect(withBaixa).not.toContain(CANCEL_OPEN_CHARGE_NEEDS_BAIXA);
    });
});

describe('Flex — a regra real em que o texto do diálogo se apoia (computeFlexState/targetForfeit do servidor)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const WEEK = 7 * DAY;
    const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

    it('flexSessionWeekSurelyOpen ⇒ a janela da sessão ainda NÃO fechou, para qualquer início de ciclo', () => {
        const anchor = d('2026-11-05');
        let checked = 0;
        for (let startOffset = -60; startOffset <= 0; startOffset++) {
            const cycleStart = new Date(+anchor + startOffset * DAY);
            for (let h = -48; h <= 72; h += 1) {
                const now = new Date(+anchor + h * 60 * 60 * 1000);
                if (!flexSessionWeekSurelyOpen({ date: anchor.toISOString() }, now)) continue;
                checked++;
                const s = computeFlexState({ total: 12, cycleStart, bookingDates: [anchor], now });
                expect(s.recordingsWithinElapsed, `${startOffset}d/${h}h`).toBe(0);
            }
        }
        expect(checked).toBeGreaterThan(0);
        // Limite: até o fim do dia (UTC) da data-âncora.
        expect(flexSessionWeekSurelyOpen({ date: '2026-11-05T00:00:00.000Z' }, new Date(+anchor + DAY - 1))).toBe(true);
        expect(flexSessionWeekSurelyOpen({ date: '2026-11-05T00:00:00.000Z' }, new Date(+anchor + DAY))).toBe(false);
        expect(flexSessionWeekSurelyOpen({ date: '2026-11-20T00:00:00.000Z', originalDate: '2026-10-01T00:00:00.000Z' }, anchor)).toBe(false);
    });

    /** Saldo canônico do flexCreditExpiryJob (mesma conta: consumo, alvo do confisco monotônico). */
    function canonical(dates: Date[], now: Date, forfeitedBefore = 0) {
        const total = 12;
        const cycleStart = new Date(Math.min(...dates.map(x => +x)));
        const s = computeFlexState({ total, cycleStart, bookingDates: dates, now });
        const forfeited = Math.max(forfeitedBefore, targetForfeit(s.shortfall, 0, total, dates.length));
        return { remaining: Math.max(0, total - dates.length - forfeited), forfeited };
    }

    it('cliente em dia: cancelar a sessão de uma semana FECHADA não devolve o crédito (é confiscado); da semana aberta, devolve', () => {
        const start = d('2026-09-01');
        const weekly = [0, 1, 2, 3, 4].map(k => new Date(+start + k * WEEK)); // 1 por semana, semanas 0..4
        const now = new Date(+start + 4 * WEEK + 2 * DAY); // na semana 4
        const before = canonical(weekly, now);
        // Semana 2 (fechada): o saldo não muda e o confisco sobe 1.
        const closed = canonical(weekly.filter((_, k) => k !== 2), now, before.forfeited);
        expect(closed.remaining).toBe(before.remaining);
        expect(closed.forfeited).toBe(before.forfeited + 1);
        // Semana 4 (aberta): o crédito volta.
        const open = canonical(weekly.filter((_, k) => k !== 4), now, before.forfeited);
        expect(open.remaining).toBe(before.remaining + 1);
    });

    it('cliente adiantado no ritmo: cancelar a sessão de uma semana fechada devolve o crédito', () => {
        const start = d('2026-09-01');
        // Duas gravações por semana nas semanas 0..2.
        const ahead = [0, 0, 1, 1, 2, 2].map((k, i) => new Date(+start + k * WEEK + (i % 2) * DAY));
        const now = new Date(+start + 3 * WEEK + DAY);
        const before = canonical(ahead, now);
        const after = canonical(ahead.filter((_, i) => i !== 2), now, before.forfeited);
        expect(after.remaining).toBe(before.remaining + 1);
    });
});

describe('UXT-08 — FIN-03: tierChangeBlockedFor (espelho do PATCH sem a baixa)', () => {
    const plan = (type: string, tier: string) => ({ type, tier });
    const base = { canMarkPaid: false, slotChanged: true, tierApplied: 'COMERCIAL' };

    it('sessão de plano dentro das faixas do plano → não trava; acima → trava', () => {
        for (const type of ['FIXO', 'FLEX', 'CUSTOM']) {
            expect(tierChangeBlockedFor({ ...base, targetTier: 'AUDIENCIA', contract: plan(type, 'AUDIENCIA') }), type).toBe(false);
            expect(tierChangeBlockedFor({ ...base, targetTier: 'AUDIENCIA', contract: plan(type, 'SABADO') }), type).toBe(false);
            expect(tierChangeBlockedFor({ ...base, targetTier: 'SABADO', contract: plan(type, 'AUDIENCIA') }), type).toBe(true);
            expect(tierChangeBlockedFor({ ...base, targetTier: 'AUDIENCIA', contract: plan(type, 'COMERCIAL') }), type).toBe(true);
        }
    });

    it('avulso, serviço e sem contrato: qualquer outra faixa trava (muda o valor cobrado)', () => {
        for (const contract of [plan('AVULSO', 'SABADO'), plan('SERVICO', 'SABADO'), null]) {
            expect(tierChangeBlockedFor({ ...base, targetTier: 'AUDIENCIA', contract }), String(contract?.type)).toBe(true);
            expect(tierChangeBlockedFor({ ...base, tierApplied: 'SABADO', targetTier: 'COMERCIAL', contract }), String(contract?.type)).toBe(true);
        }
    });

    it('não trava: com a baixa, sem mudança de horário, mesma faixa ou faixa nova desconhecida', () => {
        const avulso = plan('AVULSO', 'COMERCIAL');
        expect(tierChangeBlockedFor({ ...base, canMarkPaid: true, targetTier: 'SABADO', contract: avulso })).toBe(false);
        expect(tierChangeBlockedFor({ ...base, slotChanged: false, targetTier: 'SABADO', contract: avulso })).toBe(false);
        expect(tierChangeBlockedFor({ ...base, targetTier: 'COMERCIAL', contract: avulso })).toBe(false);
        expect(tierChangeBlockedFor({ ...base, targetTier: null, contract: avulso })).toBe(false);
    });

    it('planContractOf: só Fixo, Flex e Personalizado contam como plano', () => {
        expect(planContractOf({ type: 'FIXO' })).toEqual({ type: 'FIXO' });
        expect(planContractOf({ type: 'SERVICO' })).toBeNull();
        expect(planContractOf({ type: 'AVULSO' })).toBeNull();
        expect(planContractOf(null)).toBeNull();
        expect(planContractOf(undefined)).toBeNull();
    });
});

describe('UXT-08 — TELA-1: credenciais na tela Equipe (sem mudar comportamento)', () => {
    const m = (o: { isSelf?: boolean; role: 'ADMIN' | 'COLABORADOR'; credentialsLocked?: boolean }) => ({ isSelf: false, ...o });

    it('canSetPasswordFor: só colaborador que nunca foi ADMIN, e nunca na própria linha', () => {
        expect(canSetPasswordFor(m({ role: 'COLABORADOR' }))).toBe(true);
        expect(canSetPasswordFor(m({ role: 'COLABORADOR', credentialsLocked: false }))).toBe(true);
        expect(canSetPasswordFor(m({ role: 'COLABORADOR', credentialsLocked: true }))).toBe(false); // ex-ADMIN
        expect(canSetPasswordFor(m({ role: 'ADMIN' }))).toBe(false);
        expect(canSetPasswordFor(m({ role: 'COLABORADOR', isSelf: true }))).toBe(false);
    });

    it('memberCredentialsLocked: cadastro novo livre; edição trava ADMIN, ex-ADMIN e o recusado pelo servidor', () => {
        expect(memberCredentialsLocked(null, { serverLocked: false })).toBe(false);
        expect(memberCredentialsLocked(undefined, { serverLocked: true })).toBe(false);
        expect(memberCredentialsLocked({ role: 'COLABORADOR' }, { serverLocked: false })).toBe(false);
        expect(memberCredentialsLocked({ role: 'COLABORADOR', credentialsLocked: true }, { serverLocked: false })).toBe(true);
        expect(memberCredentialsLocked({ role: 'ADMIN' }, { serverLocked: false })).toBe(true);
        expect(memberCredentialsLocked({ role: 'COLABORADOR', credentialsLocked: false }, { serverLocked: true })).toBe(true);
    });
});
