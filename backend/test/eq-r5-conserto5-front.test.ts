import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CONSERTO 5 (revisão 5) — decisões de TELA, como funções puras do front (mesmo molde do eq-r5-front: React e
// usePermission viram stubs; `perms` escolhe o acesso) e a LIGAÇÃO das telas a elas (lendo o código-fonte, como o
// eq-r5-front-ligacao — o front não tem runner de componente):
//  • TELA5-03: a dica do avulso cancelado ("a cobrança continua valendo") só com cobrança em aberto conhecida.
//  • TELA5-05: a Lixeira trava com cobrança em aberto sem a baixa (qualquer status); o diálogo de quem tem a baixa diz
//    que a cobrança em aberto é anulada; o texto da tela é o do 403 do servidor.
//  • AUDFIN-01: a tela mostra o aviso "Sessão reaberta sem cobrança" que o servidor manda.
//  • AUDFIN-05: o BookingModal decide o saldo do FIXO pelo planSessionsUsed.
//  • ATU5-03 / AUDFIN-03: Contratos esconde "Cancelar contrato" do avulso com cobrança em aberto sem a baixa e o
//    diálogo da pausa diz o que acontece com a cobrança e com as extras.
//  • AUDFIN-04: a exclusão de cliente não abre o diálogo de perigo quando a prévia diz que falta permissão.

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
    hardDeleteBlockedByOpenCharge,
    CANCELLED_REOPEN_NEEDS_BAIXA,
    CANCELLED_AVULSO_REOPEN_NEEDS_BAIXA,
    HARD_DELETE_OPEN_CHARGE_NEEDS_BAIXA,
} from '../../frontend/src/components/admin/bookings/bookingPermissions';
import {
    hardDeleteConsequences,
    HARD_DELETE_VOIDS_OPEN_CHARGE,
    HARD_DELETE_UNKNOWN_CHARGE_NEEDS_BAIXA,
} from '../../frontend/src/components/admin/bookings/bookingDanger';

const RECEPCAO = ['agendamentos.ver', 'agendamentos.criar', 'agendamentos.editar', 'agendamentos.faltas', 'agendamentos.cancelar', 'hoje.ver', 'hoje.presenca', 'clientes.ver', 'clientes.criar', 'clientes.editar', 'contratos.ver', 'contratos.criar', 'cobrancas.cobrar', 'cupons.ver'];
function as(keys: readonly string[], isAdmin = false) {
    perms.isAdmin = isAdmin;
    perms.keys = new Set(keys);
    return useBookingPermissions();
}
const sess = (status: string, openChargeCount?: number | null, type: string | null = 'AVULSO') =>
    ({ status, openChargeCount, recordingStartedAt: null, contract: type ? { type } : null });

beforeEach(() => { perms.isAdmin = false; perms.keys = new Set(); });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
/** Código sem comentários (um comentário não pode mascarar a conferência). */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
function between(src: string, from: string, to: string): string {
    const i = src.indexOf(from);
    if (i < 0) return '';
    const j = src.indexOf(to, i + from.length);
    return j < 0 ? '' : src.slice(i, j + to.length);
}

describe('TELA5-03 — a dica do avulso cancelado só diz "a cobrança continua valendo" quando há cobrança em aberto', () => {
    it('avulso com openChargeCount > 0 (legado) → texto do avulso; 0 (paga ou anulada) ou ausente → o neutro', () => {
        expect(cancelledReopenNeedsBaixaHint(sess('CANCELLED', 1))).toBe(CANCELLED_AVULSO_REOPEN_NEEDS_BAIXA);
        for (const n of [0, null, undefined]) {
            const h = cancelledReopenNeedsBaixaHint(sess('CANCELLED', n));
            expect(h, String(n)).toBe(CANCELLED_REOPEN_NEEDS_BAIXA);
            expect(h, String(n)).not.toMatch(/continua valendo|Não crie um novo agendamento/);
        }
        for (const t of ['FIXO', 'SERVICO', null]) expect(cancelledReopenNeedsBaixaHint(sess('CANCELLED', 1, t)), String(t)).toBe(CANCELLED_REOPEN_NEEDS_BAIXA);
    });
});

describe('TELA5-05 — Lixeira com cobrança em aberto', () => {
    it('hardDeleteBlockedByOpenCharge: sem a baixa e contagem > 0 trava em QUALQUER status; com a baixa ou contagem desconhecida, não', () => {
        for (const status of ['RESERVED', 'CONFIRMED', 'COMPLETED', 'FALTA', 'NAO_REALIZADO', 'CANCELLED']) {
            expect(hardDeleteBlockedByOpenCharge(sess(status, 1), false), status).toBe(true);
            expect(hardDeleteBlockedByOpenCharge(sess(status, 1), true), status).toBe(false);
            expect(hardDeleteBlockedByOpenCharge(sess(status, 0), false), status).toBe(false);
            expect(hardDeleteBlockedByOpenCharge(sess(status, null), false), status).toBe(false);
        }
    });
    it('bp.hardDeleteNeedsBaixa: só para quem exclui e não tem a baixa', () => {
        expect(as([...RECEPCAO, 'agendamentos.excluir']).hardDeleteNeedsBaixa(sess('CANCELLED', 1))).toBe(true);
        expect(as(RECEPCAO).hardDeleteNeedsBaixa(sess('RESERVED', 1))).toBe(false); // nem vê a Lixeira
        expect(as([...RECEPCAO, 'agendamentos.excluir', 'cobrancas.baixa']).hardDeleteNeedsBaixa(sess('RESERVED', 1))).toBe(false);
        expect(as([], true).hardDeleteNeedsBaixa(sess('RESERVED', 1))).toBe(false);
    });
    it('paridade: o texto da tela é o do 403 do servidor (OPEN_CHARGE_DELETE_NEEDS_BAIXA) e não fala em Falta', () => {
        const server = read('backend/src/modules/bookings/booking.service.ts');
        expect(server.includes(`'${HARD_DELETE_OPEN_CHARGE_NEEDS_BAIXA}'`)).toBe(true);
        expect(HARD_DELETE_OPEN_CHARGE_NEEDS_BAIXA).toMatch(/^Esta sessão tem cobrança em aberto: excluir anula a cobrança/);
        expect(HARD_DELETE_OPEN_CHARGE_NEEDS_BAIXA).not.toMatch(/Falta|cancelar/);
    });
    it('hardDeleteConsequences: com a baixa avisa a anulação (contagem > 0 ou desconhecida); sem a baixa e sem contagem, avisa a recusa', () => {
        const base = { date: '2026-11-20T00:00:00.000Z', startTime: '10:00', endTime: '12:00', makeupStatus: null, makeupDeadline: null, user: { name: 'Ana' }, contract: { id: 'a', name: 'Avulso', type: 'AVULSO' as const, tier: 'COMERCIAL' as const } };
        const now = new Date('2026-11-05T15:00:00.000Z');
        const withBaixa = (n: number | null) => hardDeleteConsequences({ ...base, status: 'RESERVED', openChargeCount: n }, { canSettleCharges: true, now });
        expect(withBaixa(1)).toContain(HARD_DELETE_VOIDS_OPEN_CHARGE);
        expect(withBaixa(null)).toContain(HARD_DELETE_VOIDS_OPEN_CHARGE);
        expect(withBaixa(0)).not.toContain(HARD_DELETE_VOIDS_OPEN_CHARGE);
        expect(HARD_DELETE_VOIDS_OPEN_CHARGE).toMatch(/anulada/);
        const noBaixa = (n: number | null) => hardDeleteConsequences({ ...base, status: 'RESERVED', openChargeCount: n }, { canSettleCharges: false, now });
        expect(noBaixa(null)).toContain(HARD_DELETE_UNKNOWN_CHARGE_NEEDS_BAIXA);
        expect(noBaixa(0)).not.toContain(HARD_DELETE_UNKNOWN_CHARGE_NEEDS_BAIXA);
        expect(noBaixa(0).some(l => /anulada/.test(l))).toBe(false);
    });
});

describe('Ligação das telas (código-fonte)', () => {
    it('Agendamentos: a Lixeira trava por hardDeleteNeedsBaixa (Tooltip + alerta com o texto do 403) e o diálogo recebe canSettleCharges', () => {
        const src = code(read('frontend/src/pages/AdminBookingsPage.tsx'));
        expect(src).toMatch(/consequences: hardDeleteConsequences\(b, \{ canSettleCharges: bp\.canSettleCharges \}\)/);
        const branch = between(src, '{bp.canHardDelete && (bp.hardDeleteNeedsBaixa(b) ? (', 'handleHardDelete(b)');
        expect(branch).not.toBe('');
        expect(branch).toMatch(/<Tooltip content=\{HARD_DELETE_OPEN_CHARGE_NEEDS_BAIXA\}>/);
        expect(branch).toMatch(/message: HARD_DELETE_OPEN_CHARGE_NEEDS_BAIXA/);
        expect(branch).toMatch(/\) : \(/); // o handleHardDelete fica no ramo "senão"
    });
    it('AUDFIN-01: o seletor da lista e o Editar mostram o aviso do servidor quando a sessão volta sem cobrança', () => {
        expect(code(read('frontend/src/pages/AdminBookingsPage.tsx'))).toMatch(/if \(res\?\.reopenedWithoutCharge\) showAlert\(\{ type: 'warning', title: 'Sessão reaberta sem cobrança', message: res\.message \}\)/);
        expect(code(read('frontend/src/components/admin/bookings/EditBookingModal.tsx'))).toMatch(/if \(res\.reopenedWithoutCharge\) showAlert\(\{ type: 'warning', title: 'Sessão reaberta sem cobrança', message: res\.message \}\)/);
    });
    it('AUDFIN-05: o BookingModal usa planSessionsUsed no FIXO para o crédito e o saldo', () => {
        const src = code(read('frontend/src/components/BookingModal.tsx'));
        expect(src).toMatch(/c\.type === 'FIXO' && c\.planSessionsUsed != null \? c\.planSessionsUsed : c\.completedBookings/);
        expect(src).toMatch(/return planUsed\(c\) < c\.totalBookings;/);
        expect(src).toMatch(/Saldo: \$\{c\.totalBookings - planUsed\(c\)\} gravações disponíveis/);
        expect(src).not.toMatch(/c\.completedBookings < c\.totalBookings/);
    });
    it('ATU5-03: Contratos tira o status Cancelado e o "Cancelar contrato" livre do avulso com cobrança em aberto sem a baixa', () => {
        // R7 (AUDFIN6-01/TELA6-05): a decisão foi para contractCancelRules (testada no eq-r7-front-contratos); aqui, a ligação.
        const src = code(read('frontend/src/pages/AdminContractsPage.tsx'));
        expect(src).toMatch(/const cancelBlockReason = \(c: Contract\) => contractCancelBlockReason\(c, canSettleCharges\);/);
        expect(src).toMatch(/s === 'CANCELLED' \? canCancel && !cancelBlockReason\(c\) : canEdit/);
        expect(src).toMatch(/\{canCancel && c\.status === 'ACTIVE' && !cancelBlockReason\(c\) && \(/);
    });
    it('AUDFIN-03/TELA6-04: o diálogo da pausa usa pauseContractConsequences (o texto verdadeiro está no eq-r7-front-contratos)', () => {
        const src = code(read('frontend/src/pages/AdminContractsPage.tsx'));
        expect(src).toMatch(/consequences: pauseContractConsequences\(c, \{ canSettleCharges \}\)/);
        expect(src).not.toMatch(/Sessões extras \(cobradas à parte\) são mantidas/);
    });
    it('AUDFIN-04: a exclusão de cliente checa blockedByPermissions ANTES de abrir o diálogo de perigo', () => {
        const src = code(read('frontend/src/hooks/useDeleteClient.ts'));
        const i = src.indexOf('if (blockedByPermissions(preview)) {');
        const j = src.indexOf('showConfirm({');
        expect(i).toBeGreaterThan(0);
        expect(j).toBeGreaterThan(i);
        expect(between(src, 'if (blockedByPermissions(preview)) {', 'return;')).toMatch(/message: preview\.blockedMessage/);
        expect(src).toMatch(/return \(p\.missingPermissions\?\.length \?\? 0\) > 0;/);
    });
});
