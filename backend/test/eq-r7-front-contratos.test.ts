import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// FRENTE R7b (revisão 6) — Contratos: decisões de TELA como funções puras (contractCancelRules) e a LIGAÇÃO da página:
//  • TELA6-05: quem tem "Cancelar contrato" sem a baixa vê o Cancelar TRAVADO, com o motivo (Tooltip + alerta), no
//    contrato com cobrança de sessão em aberto — antes ele sumia sem explicação (e o lápis também, sem "Editar").
//  • AUDFIN6-01/ATU6-02 (espelho do servidor R7a): cancelar ou decidir o pedido com cobrança de sessão em aberto exige a
//    baixa — no avulso, toda cobrança em aberto; nos outros tipos, a cobrança própria de uma gravação
//    (openSessionChargeCount). Desconhecido não trava: o diálogo avisa e o 403 do servidor aparece nele.
//  • AUDFIN6-01 (6): o diálogo do SERVIÇO diz que as gravações vinculadas futuras são canceladas.
//  • TELA6-04: o diálogo da pausa do Fixo diz só o que o servidor faz (a extra fica; a cobrada à parte dentro do plano é
//    cancelada; a cobrança em aberto é anulada com a baixa e recusa a pausa sem ela).

import {
    knownBaixaChargeCount,
    contractCancelBlockReason,
    contractDecideBlockReason,
    sessionChargeLines,
    cancelContractConsequences,
    pauseContractConsequences,
    AVULSO_CANCEL_NEEDS_BAIXA,
    SESSION_CHARGE_CANCEL_NEEDS_BAIXA,
    AVULSO_DECIDE_NEEDS_BAIXA,
    SESSION_CHARGE_DECIDE_NEEDS_BAIXA,
} from '../../frontend/src/components/admin/contracts/contractCancelRules';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const count = (s: string, re: RegExp) => (s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) ?? []).length;
function between(src: string, from: string, to: string): string {
    const i = src.indexOf(from);
    if (i < 0) return '';
    const j = src.indexOf(to, i + from.length);
    return j < 0 ? '' : src.slice(i, j + to.length);
}

type T = 'FIXO' | 'FLEX' | 'SERVICO' | 'CUSTOM' | 'AVULSO';
const ct = (type: T, openSessionChargeCount?: number | null, openChargeCount?: number | null) => ({ type, openSessionChargeCount, openChargeCount });

describe('AUDFIN6-01/ATU6-02 (espelho) — a conta do 403 de cancelar/decidir', () => {
    it('knownBaixaChargeCount: o campo do servidor; sem ele, só o avulso usa openChargeCount', () => {
        expect(knownBaixaChargeCount(ct('SERVICO', 2, 5))).toBe(2);
        expect(knownBaixaChargeCount(ct('AVULSO', 1, 1))).toBe(1);
        expect(knownBaixaChargeCount(ct('AVULSO', undefined, 1))).toBe(1);
        for (const t of ['SERVICO', 'FIXO', 'FLEX', 'CUSTOM'] as const) expect(knownBaixaChargeCount(ct(t, undefined, 3)), t).toBeNull();
    });
    it('cancelar: sem a baixa e com cobrança de sessão conhecida > 0 → o motivo (avulso × gravação cobrada à parte)', () => {
        expect(contractCancelBlockReason(ct('AVULSO', 1), false)).toBe(AVULSO_CANCEL_NEEDS_BAIXA);
        expect(contractCancelBlockReason(ct('AVULSO', undefined, 2), false)).toBe(AVULSO_CANCEL_NEEDS_BAIXA);
        for (const t of ['SERVICO', 'FIXO', 'FLEX', 'CUSTOM'] as const) {
            expect(contractCancelBlockReason(ct(t, 1), false), t).toBe(SESSION_CHARGE_CANCEL_NEEDS_BAIXA);
        }
        // Parcelas em aberto (openChargeCount) sem cobrança de sessão: D2 — cancela só com "Cancelar contrato".
        expect(contractCancelBlockReason(ct('SERVICO', 0, 4), false)).toBeNull();
        expect(contractCancelBlockReason(ct('FIXO', 0, 4), false)).toBeNull();
        // Desconhecido fora do avulso: não trava (o 403 aparece no diálogo).
        expect(contractCancelBlockReason(ct('SERVICO', undefined, 4), false)).toBeNull();
        // Com a baixa (inclui o ADMIN): nunca trava.
        for (const t of ['AVULSO', 'SERVICO', 'FIXO'] as const) expect(contractCancelBlockReason(ct(t, 3, 3), true), t).toBeNull();
    });
    it('decidir o pedido: o mesmo critério, com o texto da decisão', () => {
        expect(contractDecideBlockReason(ct('AVULSO', 1), false)).toBe(AVULSO_DECIDE_NEEDS_BAIXA);
        expect(contractDecideBlockReason(ct('SERVICO', 1), false)).toBe(SESSION_CHARGE_DECIDE_NEEDS_BAIXA);
        expect(contractDecideBlockReason(ct('SERVICO', 0, 2), false)).toBeNull();
        expect(contractDecideBlockReason(ct('AVULSO', 1), true)).toBeNull();
        expect(AVULSO_DECIDE_NEEDS_BAIXA).toMatch(/decidir o pedido de cancelamento \(cobrar ou isentar a multa\)/);
    });
    it('paridade: o texto da tela é o do 403 do servidor (contract.lifecycle.ts)', () => {
        const server = read('backend/src/modules/contracts/contract.lifecycle.ts');
        expect(server.includes(AVULSO_CANCEL_NEEDS_BAIXA)).toBe(true);
        expect(server.includes(SESSION_CHARGE_CANCEL_NEEDS_BAIXA)).toBe(true);
    });
});

describe('Diálogos de cancelar e decidir (o que o servidor faz)', () => {
    it('AUDFIN6-01 (6): o SERVIÇO diz que as gravações vinculadas futuras são canceladas', () => {
        const s = cancelContractConsequences(ct('SERVICO', 0), { canSettleCharges: true });
        expect(s.some(l => /^As gravações vinculadas a este serviço que ainda não aconteceram são canceladas/.test(l))).toBe(true);
        const f = cancelContractConsequences(ct('FIXO', 0), { canSettleCharges: true });
        expect(f.some(l => /^As gravações que ainda não aconteceram são canceladas/.test(l))).toBe(true);
    });
    it('com a baixa e cobrança de sessão conhecida: avisa que ela também é anulada (mesmo de gravação feita)', () => {
        expect(cancelContractConsequences(ct('SERVICO', 2), { canSettleCharges: true }).join('\n'))
            .toMatch(/Também é anulada a cobrança própria em aberto das gravações deste contrato cobradas à parte, mesmo a de uma gravação já feita\./);
        expect(cancelContractConsequences(ct('SERVICO', 0), { canSettleCharges: true }).join('\n')).not.toMatch(/Também é anulada/);
        expect(cancelContractConsequences(ct('AVULSO', 1), { canSettleCharges: true }).join('\n')).not.toMatch(/Também é anulada/);
    });
    it('sem a baixa e sem a contagem: avisa que o servidor pode recusar (cancelar × decidir)', () => {
        expect(sessionChargeLines(ct('SERVICO'), false, 'cancel')).toEqual([
            'Se alguma gravação deste contrato tiver cobrança própria em aberto (sessão cobrada à parte), o cancelamento é recusado: anular essa cobrança exige a permissão “Marcar como pago, anular ou estornar”.',
        ]);
        expect(sessionChargeLines(ct('SERVICO'), false, 'decide')[0]).toMatch(/, a decisão é recusada: /);
        expect(sessionChargeLines(ct('SERVICO', 0), false, 'cancel')).toEqual([]);
        expect(sessionChargeLines(ct('AVULSO'), false, 'cancel')).toEqual([]);
    });
});

describe('TELA6-04 — diálogo da pausa', () => {
    it('FIXO: a cobrada à parte dentro do plano é cancelada; só a extra (plano cheio) fica', () => {
        for (const canSettleCharges of [true, false]) {
            const s = pauseContractConsequences({ type: 'FIXO' }, { canSettleCharges }).join('\n');
            expect(s).not.toMatch(/Sessões extras \(cobradas à parte\) são mantidas/);
            expect(s).toMatch(/Isso inclui as cobradas à parte criadas enquanto o plano ainda tinha vaga: elas contam como gravações do plano, e o que já foi pago por elas não é estornado\./);
            expect(s).toMatch(/A sessão extra \(criada com o plano já cheio\) é mantida\./);
            expect(s).toMatch(/as gravações do dia e horário fixos são recriadas \(só essas: uma gravação cancelada em outra data ou horário não volta\)/);
        }
    });
    it('FIXO: com a baixa, anula a cobrança em aberto (a da própria sessão e a dos extras); sem ela, a pausa é recusada', () => {
        const withBaixa = pauseContractConsequences({ type: 'FIXO' }, { canSettleCharges: true }).join('\n');
        expect(withBaixa).toMatch(/A cobrança em aberto das gravações canceladas é anulada: a da própria sessão, quando ela foi cobrada à parte, e a de serviços extras contratados nelas\./);
        expect(withBaixa).not.toMatch(/a pausa é recusada/);
        const noBaixa = pauseContractConsequences({ type: 'FIXO' }, { canSettleCharges: false }).join('\n');
        expect(noBaixa).toMatch(/a pausa é recusada: anular a cobrança exige a permissão “Marcar como pago, anular ou estornar”/);
        expect(noBaixa).not.toMatch(/é anulada:/);
    });
    it('outros tipos: nada é cancelado', () => {
        for (const type of ['FLEX', 'CUSTOM', 'SERVICO', 'AVULSO'] as const) {
            expect(pauseContractConsequences({ type }, { canSettleCharges: false })[0], type).toBe('As gravações já agendadas são mantidas.');
        }
    });
    it('o servidor mantém só a marca fixoExtra na pausa (o texto se apoia nisso)', () => {
        const server = code(read('backend/src/modules/contracts/contract.lifecycle.ts'));
        const pause = between(server, "router.patch('/:id/pause'", "router.patch('/:id/resume'");
        expect(pause).toMatch(/payments: \{ none: FIXO_EXTRA_MARK_WHERE \}/);
    });
});

describe('Ligação da página Contratos', () => {
    const src = code(read('frontend/src/pages/AdminContractsPage.tsx'));

    it('TELA6-05: o Cancelar travado (Tooltip + aria-disabled + cadeado + alerta com o motivo) no lugar do que sumia', () => {
        const locked = between(src, "{canCancel && c.status === 'ACTIVE' && cancelBlockReason(c) && (", '</Tooltip>');
        expect(locked).not.toBe('');
        expect(locked).toMatch(/<Tooltip content=\{cancelBlockReason\(c\)\}>/);
        expect(locked).toMatch(/aria-disabled="true"/);
        expect(locked).toMatch(/<Lock size=\{16\} aria-hidden="true" \/>/);
        expect(locked).toMatch(/showAlert\(\{ type: 'info', title: 'Cancelar indisponível', message: cancelBlockReason\(c\) \?\? '' \}\)/);
        expect(locked).not.toMatch(/handleCancel/);
        const free = between(src, "{canCancel && c.status === 'ACTIVE' && !cancelBlockReason(c) && (", '</Tooltip>');
        expect(free).toMatch(/onClick=\{\(\) => handleCancel\(c\)\}/);
        expect(count(src, /handleCancel\(c\)/)).toBe(1);
    });
    it('ATU6-02 (espelho): a decisão do pedido fica travada com o motivo; Cobrar/Isentar só no ramo livre', () => {
        const locked = between(src, "{canDecideFine && c.status === 'PENDING_CANCELLATION' && decideBlockReason(c) && (", '</Tooltip>');
        expect(locked).toMatch(/<Tooltip content=\{decideBlockReason\(c\)\}>/);
        expect(locked).toMatch(/aria-disabled="true"/);
        expect(locked).toMatch(/message: decideBlockReason\(c\) \?\? ''/);
        expect(locked).not.toMatch(/handleResolveCancel/);
        const free = between(src, "{canDecideFine && c.status === 'PENDING_CANCELLATION' && !decideBlockReason(c) && (", "handleResolveCancel(c, 'WAIVE_FEE')");
        expect(free).toMatch(/handleResolveCancel\(c, 'CHARGE_FEE'\)/);
        expect(count(src, /handleResolveCancel\(c, 'CHARGE_FEE'\)/)).toBe(1);
        expect(count(src, /handleResolveCancel\(c, 'WAIVE_FEE'\)/)).toBe(1);
    });
    it('as decisões vêm do módulo (Cancelado no Editar, nota do Editar, diálogos e pausa)', () => {
        expect(src).toMatch(/const cancelBlockReason = \(c: Contract\) => contractCancelBlockReason\(c, canSettleCharges\);/);
        expect(src).toMatch(/const decideBlockReason = \(c: Contract\) => contractDecideBlockReason\(c, canSettleCharges\);/);
        expect(src).toMatch(/s === 'CANCELLED' \? canCancel && !cancelBlockReason\(c\) : canEdit/);
        expect(src).toMatch(/const editCancelBlockReason = editContract && canCancel \? cancelBlockReason\(editContract\) : null;/);
        expect(src).toMatch(/if \(editCancelBlockReason\) return `\$\{base\} \$\{editCancelBlockReason\}`;/);
        expect(count(src, /cancelContractConsequences\(c, \{ canSettleCharges \}\)/)).toBe(2);
        expect(src).not.toMatch(/function cancelContractConsequences/);
        expect(between(src, 'const handleResolveCancel = ', 'const pct')).toMatch(/\.\.\.sessionChargeLines\(c, canSettleCharges, 'decide'\),/);
        expect(src).toMatch(/consequences: pauseContractConsequences\(c, \{ canSettleCharges \}\)/);
        expect(src).not.toMatch(/avulsoCancelBlocked|AVULSO_CANCEL_NEEDS_BAIXA/);
    });
});
