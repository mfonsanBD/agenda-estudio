import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Só a paridade do texto importa o módulo do front: React e o hook de permissão viram stubs (como no eq-r5-front).
vi.mock('react', () => ({ useMemo: (f: () => unknown) => f() }));
vi.mock('../../frontend/src/hooks/usePermission', () => ({ usePermission: () => { throw new Error('stub'); } }));

// FRENTE R5b — UXT-08: a LIGAÇÃO das telas às decisões puras (eq-r5-front). O front não tem runner de componente
// (sem DOM/React no vitest do backend), então este teste lê o código-fonte das telas e confere que cada decisão
// passa pela função testada — reverter a ligação para a conta inline antiga (a da R3 no FIN-03, o
// `m.role === 'COLABORADOR'` no TELA-1, o Cancelar sem a trava da cobrança em aberto) quebra este teste. Os
// comentários são removidos antes das conferências de AUSÊNCIA, para um comentário não mascarar o código.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
/** Código sem comentários de bloco (inclusive {/* … *\/} do JSX) e de linha. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const count = (s: string, re: RegExp) => (s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) ?? []).length;
/** Trecho de `src` entre a 1ª ocorrência de `from` e a próxima de `to` (vazio se não achar). */
function between(src: string, from: string, to: string): string {
    const i = src.indexOf(from);
    if (i < 0) return '';
    const j = src.indexOf(to, i + from.length);
    return j < 0 ? '' : src.slice(i, j + to.length);
}

const EDIT = 'frontend/src/components/admin/bookings/EditBookingModal.tsx';
const LIST = 'frontend/src/pages/AdminBookingsPage.tsx';
const TODAY = 'frontend/src/pages/AdminTodayPage.tsx';
const TEAM_TABLE = 'frontend/src/components/admin/team/TeamTable.tsx';
const TEAM_MODAL = 'frontend/src/components/admin/team/TeamMemberModal.tsx';

describe('UXT-08 — FIN-03: o EditBookingModal decide a troca de faixa com tierChangeBlockedFor', () => {
    const src = code(read(EDIT));

    it('a única atribuição de tierChangeBlocked é a chamada da função pura, e ela trava o Salvar', () => {
        expect(src).toMatch(/import \{[^}]*\btierChangeBlockedFor\b[^}]*\} from '\.\/tierAccess'/);
        expect(count(src, /\btierChangeBlocked\s*=/)).toBe(1);
        expect(src).toMatch(/const tierChangeBlocked = !!booking && tierChangeBlockedFor\(\{\s*canMarkPaid, slotChanged, targetTier, tierApplied: booking\.tierApplied, contract: booking\.contract,?\s*\}\)/);
        expect(src).toMatch(/if \(tierChangeBlocked\) return;/);
        expect(src).toMatch(/disabled=\{saving \|\| tierChangeBlocked\}/);
    });

    it('a conta da R3 (tierDiffers) e a decisão inline (SESSION_PLAN_TYPES/canAccessTier) não voltaram ao componente', () => {
        expect(src).not.toMatch(/\btierDiffers\b/);
        expect(src).not.toMatch(/SESSION_PLAN_TYPES/);
        expect(src).not.toMatch(/\bcanAccessTier\(/);
        expect(src).toMatch(/const planContract = planContractOf\(booking\?\.contract\);/);
    });
});

describe('UXT-08 — TELA-1: a tela Equipe usa canSetPasswordFor e memberCredentialsLocked', () => {
    it('TeamTable: o "Definir senha" só aparece por canSetPasswordFor(m)', () => {
        const src = code(read(TEAM_TABLE));
        const guard = between(src, '{canSetPasswordFor(m) && (', 'Definir senha');
        expect(guard).not.toBe('');
        expect(guard.length).toBeLessThan(120); // o guarda é o que abre o bloco do botão
        expect(count(src, /Definir senha de/)).toBe(1);
        expect(src).not.toMatch(/m\.role === 'COLABORADOR'/);
        expect(src).not.toMatch(/\bcredentialsLocked\(/);
    });

    it('TeamMemberModal: e-mail editável e aviso da senha saem de memberCredentialsLocked', () => {
        const src = code(read(TEAM_MODAL));
        expect(src).toMatch(/const credsLocked = memberCredentialsLocked\(member, \{ serverLocked \}\);/);
        expect(src).toMatch(/const emailEditable = !credsLocked;/);
        expect(count(src, /\bcredsLocked\s*=/)).toBe(1);
        expect(count(src, /\bemailEditable\s*=/)).toBe(1);
        expect(src).toMatch(/readOnly=\{!emailEditable\}/);
        expect(src).not.toMatch(/\bcredentialsLocked\(/);
    });
});

describe('R5 — as telas de cancelar usam cancelNeedsBaixa e passam canSettleCharges', () => {
    it('Hoje: o botão que abre o diálogo de cancelar só existe no ramo SEM a trava da cobrança em aberto', () => {
        const src = code(read(TODAY));
        expect(src).toMatch(/consequences: cancelBookingConsequences\(booking, \{ canSettleCharges: bp\.canSettleCharges \}\)/);
        expect(count(src, /handleCancel\(booking\)/)).toBe(1);
        const branch = between(src, '{bp.cancelNeedsBaixa(booking) ? (', 'handleCancel(booking)');
        expect(branch).not.toBe('');
        expect(branch).toMatch(/content=\{CANCEL_OPEN_CHARGE_NEEDS_BAIXA\}/);
        expect(branch).toMatch(/aria-disabled="true"/);
        expect(branch).toMatch(/message: CANCEL_OPEN_CHARGE_NEEDS_BAIXA/);
        expect(branch).toMatch(/\) : \(/); // o handleCancel fica no ramo "senão"
    });

    it('Agendamentos: seletor pelo statusOptions (sem o Cancelado travado) + selo com a explicação', () => {
        const src = code(read(LIST));
        expect(src).toMatch(/const statusChoices = bp\.statusOptions\(b, /);
        expect(src).toMatch(/consequences: cancelBookingConsequences\(b, \{ canSettleCharges: bp\.canSettleCharges \}\)/);
        const chip = between(src, '{bp.cancelNeedsBaixa(b) && (', '</Tooltip>');
        expect(chip).toMatch(/<Tooltip content=\{CANCEL_OPEN_CHARGE_NEEDS_BAIXA\}>/);
        expect(chip).toMatch(/message: CANCEL_OPEN_CHARGE_NEEDS_BAIXA/);
    });

    it('paridade: a explicação da tela é o mesmo texto do 403 do servidor (R5a)', async () => {
        const { CANCEL_OPEN_CHARGE_NEEDS_BAIXA } = await import('../../frontend/src/components/admin/bookings/bookingPermissions');
        const dir = path.join(ROOT, 'backend/src/modules/bookings');
        const server = fs.readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
        expect(server.includes(`'${CANCEL_OPEN_CHARGE_NEEDS_BAIXA}'`)).toBe(true);
    });

    it('Editar: explicação da cobrança em aberto e aviso de acesso pelo hiddenByAccess', () => {
        const src = code(read(EDIT));
        expect(src).toMatch(/const cancelNeedsBaixa = bp\.cancelNeedsBaixa\(booking\);/);
        expect(src).toMatch(/\{cancelNeedsBaixa && \(\s*<div id="edit-booking-cancel-locked"[^>]*>\s*\{CANCEL_OPEN_CHARGE_NEEDS_BAIXA\}/);
        expect(src).toMatch(/allStatusKeys\.some\(to => bp\.hiddenByAccess\(booking, to\)\)/);
        expect(src).toMatch(/const statusKeys = bp\.statusOptions\(booking, allStatusKeys\);/);
        expect(src).toMatch(/consequences=\{cancelBookingConsequences\(booking, \{ canSettleCharges: bp\.canSettleCharges \}\)\}/);
    });
});
