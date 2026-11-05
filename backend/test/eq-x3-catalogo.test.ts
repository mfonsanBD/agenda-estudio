import { describe, it, expect } from 'vitest';
import {
    STAFF_EVENT_PERMISSIONS,
    STAFF_PRESETS,
    buildStaffCatalog,
} from '../src/config/staffPermissions';
import { NOTIFICATION_EVENT_CATALOG } from '../src/config/notificationEventCatalog';

// FRENTE X3 — textos que o dono lê ao decidir (etapa Permissões da tela Equipe e tela de avisos). Cada
// asserção prende uma correção da revisão adversarial para o texto errado não voltar:
//  • MAT-01/EQ-REQ-01: contratos.criar não promete "renovar com parcelas em aberto" (a renovação não gera
//    parcelas e exige também a baixa manual);
//  • MAT-06/EQ-REQ-02: contratos.condicoes não promete a "liberação de boleto", que não existe mais;
//  • EQ-REQ-06: financeiro.ver diz que a receita do painel depende da Agenda e a dos relatórios de Relatórios;
//  • MAT-02/NS-1: avisos.modelos diz que os avisos da equipe são só do administrador;
//  • NS-5: os avisos da equipe (audiência "admin") não dizem mais "Admin —" / "avisa o admin", porque vão
//    também para o colaborador com a permissão do evento.

const catalog = buildStaffCatalog();
const actions = catalog.modules.flatMap(m => m.actions);
const action = (key: string) => {
    const a = actions.find(x => x.key === key);
    if (!a) throw new Error(`ação ${key} fora do catálogo`);
    return a;
};

describe('catálogo de permissões: descrições que dizem a verdade', () => {
    it('contratos.criar: renovar exige também a baixa manual, porque a renovação não gera parcelas', () => {
        const baixa = action('cobrancas.baixa').label; // "Marcar como pago, anular ou estornar (baixa manual)"
        const desc = action('contratos.criar').description;
        expect(desc).toMatch(/Renovar exige também/);
        expect(desc).toContain(baixa.replace(/\s*\(baixa manual\)$/, ''));
        expect(desc).toMatch(/renovação não gera parcelas/);
        expect(desc).not.toMatch(/renova os existentes/);
    });

    it('contratos.condicoes: sem a "liberação de boleto" (o PATCH ignora boletoAllowed) — e nenhuma descrição a promete', () => {
        expect(action('contratos.condicoes').description).not.toMatch(/boleto/i);
        expect(actions.filter(a => /libera[çc][ãa]o de boleto/i.test(a.description)).map(a => a.key)).toEqual([]);
    });

    it('financeiro.ver: sozinha abre só a tela Financeiro; a receita do painel depende da Agenda e a dos relatórios, de Relatórios', () => {
        const desc = action('financeiro.ver').description;
        expect(desc).toMatch(/tela Financeiro/);
        expect(desc).toMatch(/Agenda/);
        expect(desc).toMatch(/Relatórios/);
    });

    it('avisos.modelos: os avisos da equipe só o administrador altera', () => {
        expect(action('avisos.modelos').description).toMatch(/avisos da equipe só o administrador/);
    });

    it('perfil Recepção: sem a baixa, não renova plano (e a descrição avisa)', () => {
        const recepcao = STAFF_PRESETS.find(p => p.key === 'recepcao')!;
        expect(recepcao.permissions).toContain('contratos.criar');
        expect(recepcao.permissions).not.toContain('cobrancas.baixa');
        expect(recepcao.description).toMatch(/não renova/);
    });
});

describe('avisos da equipe (audiência "admin"): rótulo e descrição dizem quem recebe', () => {
    const team = NOTIFICATION_EVENT_CATALOG.filter(e => e.audience === 'admin');
    /** Eventos da equipe que vão SÓ para o ADMIN (nenhuma permissão delegável recebe). Hoje: nenhum. */
    const ADMIN_ONLY_EVENTS: readonly string[] = [];

    it('há avisos da equipe no catálogo (premissa)', () => {
        expect(team.length).toBeGreaterThanOrEqual(10);
    });

    it('rótulo "Equipe — …" (não "Admin — …") e descrição sem "o admin" / "os admins"', () => {
        for (const e of team) {
            expect(e.label, e.eventKey).not.toMatch(/^Admin\b/);
            expect(e.label, e.eventKey).toMatch(/^Equipe — /);
            expect(e.description, e.eventKey).not.toMatch(/\b(?:o|os|ao|aos|do|dos) admins?\b/i);
            expect(e.description, e.eventKey).toMatch(/administradores e quem da equipe/);
        }
    });

    it('todo aviso da equipe tem destinatário decidido: permissão em STAFF_EVENT_PERMISSIONS ou lista explícita de só-ADMIN', () => {
        const undecided = team.map(e => e.eventKey)
            .filter(k => !Object.prototype.hasOwnProperty.call(STAFF_EVENT_PERMISSIONS, k) && !ADMIN_ONLY_EVENTS.includes(k));
        expect(undecided).toEqual([]);
        for (const k of Object.keys(STAFF_EVENT_PERMISSIONS)) expect(STAFF_EVENT_PERMISSIONS[k]!.length, k).toBeGreaterThan(0);
    });

    it('STAFF_EVENT_PERMISSIONS só cita avisos da equipe que existem no catálogo', () => {
        const teamKeys = new Set(team.map(e => e.eventKey));
        expect(Object.keys(STAFF_EVENT_PERMISSIONS).filter(k => !teamKeys.has(k))).toEqual([]);
    });
});
