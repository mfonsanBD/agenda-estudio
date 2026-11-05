import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Sem banco: o prisma é um dublê (getActor / getStaffRecipientIds são testados pela forma da consulta).
const mockPrisma = vi.hoisted(() => ({
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    staffProfile: { findUnique: vi.fn() },
}));
vi.mock('../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

import {
    ADMIN_ONLY_KEYS,
    ADMIN_REQUIREMENT,
    BUSINESS_CONFIG_GROUP_PERMISSION,
    STAFF_EVENT_PERMISSIONS,
    STAFF_PRESETS,
    STAFF_SETTINGS_SECTIONS,
    allModuleKeys,
    allPermissionKeys,
    buildStaffCatalog,
    isAdminOnlyKey,
    levelOf,
    moduleLevels,
    modulesWithAccess,
    normalizePermissions,
    permissionForConfigGroup,
    permissionsForRole,
    sanitizeStoredPermissions,
    staffEventPermissions,
    type PermissionKey,
} from '../src/config/staffPermissions';
import {
    ADMIN_BOOKING_CREATE_FIELDS,
    BOOKING_PATCH_FIELD_RULES,
    CONTRACT_PATCH_FIELDS,
    PAYMENT_PATCH_FIELDS,
    USER_CREATE_FIELDS,
    USER_PATCH_FIELDS,
    businessConfigGroupOf,
    requiredForAdminBookingCreate,
    requiredForBookingPatch,
    requiredForBookingStatusChange,
    requiredForBusinessConfig,
    requiredForContractCancel,
    requiredForContractPatch,
    requiredForPaymentPatch,
    requiredForUserCreate,
    requiredForUserPatch,
    type RuleResult,
} from '../src/lib/permissionRules';
import {
    ActorError,
    can,
    enforceRuleResult,
    getActor,
    missingRequirement,
    requireAdmin,
    requirePermission,
    requireRole,
    requireStaff,
    type Actor,
} from '../src/middleware/permissions';
import { getStaffRecipientIds, resolveRecipientPermissions } from '../src/lib/staffRecipients';
import { adminCreateBookingSchema, adminUpdateBookingSchema } from '../src/modules/bookings/validators';
import { updateContractSchema } from '../src/modules/contracts/validators';
import { BUSINESS_CONFIG_CATALOG } from '../src/config/businessConfigCatalog';
import { NOTIFICATION_EVENT_CATALOG } from '../src/config/notificationEventCatalog';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

/** Chaves de topo de um `z.object({...})` não exportado, lidas do fonte (schemas planos). */
function schemaKeysFromSource(relFile: string, schemaName: string): string[] {
    const src = readFileSync(path.join(SRC, relFile), 'utf8');
    const m = new RegExp(`const\\s+${schemaName}\\s*=\\s*z\\.object\\(\\{([\\s\\S]*?)\\n\\s*\\}\\)`).exec(src);
    if (!m) throw new Error(`schema ${schemaName} não encontrado em ${relFile}`);
    return [...m[1].matchAll(/^\s*(\w+)\s*:/gm)].map(x => x[1]);
}

const keysOf = (r: RuleResult) => r.requirements.map(q => [...q.anyOf]);
const flat = (r: RuleResult) => r.requirements.flatMap(q => q.anyOf);
const needsAdmin = (r: RuleResult) => r.requirements.some(q => q.anyOf.length === 1 && q.anyOf[0] === ADMIN_REQUIREMENT);

// ─── Catálogo = tabela D2 do DECISOES-EQUIPE.md ─────────

// [chave, rótulo, nível, selos]
const D2: Array<[string, string, 'ver' | 'editar' | 'tudo' | null, string[]]> = [
    ['agendamentos.ver', 'Ver agenda e agendamentos (inclui o preço de cada sessão)', 'ver', []],
    ['agendamentos.criar', 'Criar agendamento para cliente', 'editar', []],
    ['agendamentos.editar', 'Mudar data, horário e status', 'editar', []],
    ['agendamentos.faltas', 'Registrar falta ou não realizado (e remarcar avulso perdido)', 'editar', []],
    ['agendamentos.cancelar', 'Cancelar sessão', 'tudo', ['sensivel']],
    ['agendamentos.excluir', 'Excluir agendamento definitivamente', 'tudo', ['irreversivel']],
    ['hoje.ver', 'Ver a operação do dia', 'ver', []],
    ['hoje.presenca', 'Confirmar presença (check-in)', 'editar', []],
    ['hoje.gravacao', 'Operar a gravação (iniciar, desfazer, finalizar, métricas)', 'editar', []],
    ['clientes.ver', 'Ver clientes', 'ver', []],
    ['clientes.criar', 'Cadastrar cliente', 'editar', []],
    ['clientes.editar', 'Editar o cadastro do cliente', 'editar', []],
    ['clientes.acesso', 'Alterar o acesso ao app do cliente (e-mail de login e bloqueio)', 'tudo', ['sensivel']],
    ['clientes.excluir', 'Excluir cliente', 'tudo', ['irreversivel']],
    ['contratos.ver', 'Ver contratos (inclui parcelas e valores)', 'ver', []],
    ['contratos.criar', 'Criar e renovar contratos', 'editar', []],
    ['contratos.editar', 'Editar, pausar e retomar contratos', 'editar', []],
    ['contratos.condicoes', 'Mudar créditos, serviços e condições de pagamento', 'tudo', ['dinheiro']],
    ['contratos.cancelar', 'Cancelar contrato', 'tudo', ['sensivel']],
    ['contratos.multa', 'Decidir pedido de cancelamento (cobrar ou isentar multa)', 'tudo', ['dinheiro']],
    ['cobrancas.cobrar', 'Cobrar o cliente (PIX, boleto ou cartão digitado)', 'editar', []],
    ['cobrancas.cartao_salvo', 'Debitar o cartão salvo do cliente', 'tudo', ['dinheiro']],
    ['cobrancas.baixa', 'Marcar como pago, anular ou estornar (baixa manual)', 'tudo', ['dinheiro']],
    ['cobrancas.automatica', 'Ligar ou desligar a cobrança automática do cliente', 'tudo', ['dinheiro']],
    ['financeiro.ver', 'Ver o financeiro e a receita', 'ver', []],
    ['cupons.ver', 'Ver cupons', 'ver', []],
    ['cupons.editar', 'Criar, editar, ativar e excluir cupons', 'editar', ['dinheiro']],
    ['relatorios.ver', 'Ver relatórios (receita só com “Financeiro e receita”)', 'ver', []],
    ['avisos.enviar', 'Enviar aviso aos clientes', 'tudo', ['sensivel', 'clienteVe']],
    ['avisos.modelos', 'Editar os textos das mensagens automáticas', 'tudo', ['sensivel', 'clienteVe']],
    ['config.gerais', 'Gerais (aparece no site para os clientes)', null, ['sensivel', 'clienteVe']],
    ['config.horarios', 'Horários & Grade', null, []],
    ['config.precos', 'Preços e regras (planos e pagamentos; sem taxas de gateway)', null, ['dinheiro']],
    ['config.politicas', 'Políticas', null, []],
    ['config.servicos', 'Serviços', null, ['dinheiro']],
    ['config.pagamentos', 'Formas de pagamento', null, ['dinheiro']],
    ['config.ambiente', 'Ambiente', null, []],
    ['config.gravacoes', 'Gravações (plataformas)', null, []],
];

describe('catálogo (D2)', () => {
    const catalog = buildStaffCatalog();
    const actions = catalog.modules.flatMap(m => m.actions);

    it('módulos na ordem do menu, com os rótulos do D2', () => {
        expect(catalog.modules.map(m => [m.key, m.label])).toEqual([
            ['agendamentos', 'Agenda e Agendamentos'],
            ['hoje', 'Hoje'],
            ['clientes', 'Clientes'],
            ['contratos', 'Contratos'],
            ['cobrancas', 'Cobranças'],
            ['financeiro', 'Financeiro e receita'],
            ['cupons', 'Cupons'],
            ['relatorios', 'Relatórios'],
            ['avisos', 'Avisos e modelos de mensagem'],
            ['config', 'Configurações'],
        ]);
        expect(allModuleKeys()).toEqual(catalog.modules.map(m => m.key));
    });

    it('chaves, rótulos, níveis e selos batem exatamente com a tabela D2', () => {
        expect(actions.map(a => [a.key, a.label, a.level, a.badges])).toEqual(D2);
        expect(allPermissionKeys()).toEqual(D2.map(r => r[0]));
        expect(new Set(allPermissionKeys()).size).toBe(D2.length);
    });

    it('toda ação tem descrição curta e todo módulo tem descrição', () => {
        for (const a of actions) {
            expect(a.description.length, a.key).toBeGreaterThan(10);
            expect(a.description.length, a.key).toBeLessThan(200);
        }
        for (const m of catalog.modules) expect(m.description.length, m.key).toBeGreaterThan(5);
    });

    it('cada chave pertence ao módulo do seu prefixo', () => {
        for (const m of catalog.modules) for (const a of m.actions) expect(a.key.split('.')[0]).toBe(m.key);
    });

    it('exclusivas do ADMIN: equipe, e-mail, integrações, taxas e manutenção — nunca delegáveis', () => {
        expect([...ADMIN_ONLY_KEYS]).toEqual(['equipe.gerenciar', 'config.email', 'config.integracoes', 'config.taxas', 'sistema.manutencao']);
        expect(catalog.adminOnly.map(a => a.key)).toEqual([...ADMIN_ONLY_KEYS]);
        for (const a of catalog.adminOnly) expect(a.label.length).toBeGreaterThan(5);
        for (const k of ADMIN_ONLY_KEYS) expect(allPermissionKeys()).not.toContain(k);
        expect(isAdminOnlyKey('config.email')).toBe(true);
        expect(isAdminOnlyKey('config.gerais')).toBe(false);
    });

    it('dependências: ação de módulo exige o .ver; cartão salvo exige cobrar; automática exige clientes.ver; o resto não exige nada', () => {
        const req = Object.fromEntries(actions.map(a => [a.key, a.requires]));
        for (const mod of ['agendamentos', 'hoje', 'clientes', 'contratos', 'cupons']) {
            for (const a of actions.filter(x => x.key.startsWith(`${mod}.`))) {
                expect(req[a.key], a.key).toEqual(a.key === `${mod}.ver` ? [] : [`${mod}.ver`]);
            }
        }
        expect(req['cobrancas.cartao_salvo']).toEqual(['cobrancas.cobrar']);
        expect(req['cobrancas.automatica']).toEqual(['clientes.ver']);
        for (const k of ['avisos.enviar', 'avisos.modelos', 'financeiro.ver', 'relatorios.ver', 'cobrancas.cobrar', 'cobrancas.baixa']) {
            expect(req[k], k).toEqual([]);
        }
        for (const a of actions.filter(x => x.key.startsWith('config.'))) expect(a.requires, a.key).toEqual([]);
    });

    it('níveis cumulativos por módulo; Configurações sem nível', () => {
        expect(moduleLevels('agendamentos')).toEqual({
            ver: ['agendamentos.ver'],
            editar: ['agendamentos.ver', 'agendamentos.criar', 'agendamentos.editar', 'agendamentos.faltas'],
            tudo: ['agendamentos.ver', 'agendamentos.criar', 'agendamentos.editar', 'agendamentos.faltas', 'agendamentos.cancelar', 'agendamentos.excluir'],
        });
        expect(moduleLevels('cobrancas').ver).toEqual([]);
        expect(moduleLevels('cobrancas').editar).toEqual(['cobrancas.cobrar']);
        expect(moduleLevels('avisos')).toEqual({ ver: [], editar: [], tudo: ['avisos.enviar', 'avisos.modelos'] });
        expect(moduleLevels('config')).toEqual({ ver: [], editar: [], tudo: [] });
        const cat = catalog.modules.find(m => m.key === 'contratos')!;
        expect(cat.levels).toEqual(moduleLevels('contratos'));
    });

    it('catálogo segue o contrato D5 (modules/adminOnly/presets) e é uma cópia mutável', () => {
        expect(Object.keys(catalog).sort()).toEqual(['adminOnly', 'modules', 'presets']);
        const m = catalog.modules[0];
        expect(Object.keys(m).sort()).toEqual(['actions', 'description', 'key', 'label', 'levels']);
        expect(Object.keys(m.actions[0]).sort()).toEqual(['badges', 'description', 'key', 'label', 'level', 'requires']);
        expect(Object.keys(catalog.presets[0]).sort()).toEqual(['description', 'key', 'label', 'permissions']);
        catalog.modules[0].actions[0].badges.push('dinheiro');
        expect(buildStaffCatalog().modules[0].actions[0].badges).toEqual([]);
    });
});

describe('normalizePermissions / sanitize / permissionsForRole', () => {
    it('aplica dependências (fecho), tira duplicatas e ordena pelo catálogo', () => {
        const n = normalizePermissions(['agendamentos.criar', 'cobrancas.cartao_salvo', 'agendamentos.criar', 'cobrancas.automatica']);
        expect(n.permissions).toEqual(['agendamentos.ver', 'agendamentos.criar', 'clientes.ver', 'cobrancas.cobrar', 'cobrancas.cartao_salvo', 'cobrancas.automatica']);
        expect(n.added).toEqual(['agendamentos.ver', 'clientes.ver', 'cobrancas.cobrar']);
        expect(n.invalid).toEqual([]);
        expect(n.removedAdminOnly).toEqual([]);
    });

    it('chave desconhecida vai para invalid; exclusiva do ADMIN é removida', () => {
        const n = normalizePermissions(['hoje.gravacao', 'equipe.gerenciar', 'config.email', 'xpto.ver', 42 as unknown as string, 'xpto.ver']);
        expect(n.permissions).toEqual(['hoje.ver', 'hoje.gravacao']);
        expect(n.invalid).toEqual(['xpto.ver', '42']);
        expect(n.removedAdminOnly).toEqual(['equipe.gerenciar', 'config.email']);
    });

    it('lista vazia / nula → vazia', () => {
        expect(normalizePermissions([]).permissions).toEqual([]);
        expect(normalizePermissions(null).permissions).toEqual([]);
    });

    it('é idempotente para todo o catálogo', () => {
        const all = normalizePermissions(allPermissionKeys());
        expect(all.permissions).toEqual(allPermissionKeys());
        expect(normalizePermissions(all.permissions).permissions).toEqual(all.permissions);
    });

    it('sanitizeStoredPermissions (leitura): ignora chave fora do catálogo e exclusiva, NÃO acrescenta dependência', () => {
        expect(sanitizeStoredPermissions(['contratos.multa', 'velha.chave', 'config.integracoes', 'contratos.multa'])).toEqual(['contratos.multa']);
        expect(sanitizeStoredPermissions(undefined)).toEqual([]);
    });

    it('permissionsForRole: ADMIN = catálogo + exclusivas; COLABORADOR = as dele; CLIENTE = []', () => {
        expect(permissionsForRole('ADMIN', ['hoje.ver'])).toEqual([...allPermissionKeys(), ...ADMIN_ONLY_KEYS]);
        expect(permissionsForRole('COLABORADOR', ['hoje.ver', 'equipe.gerenciar', 'nada'])).toEqual(['hoje.ver']);
        expect(permissionsForRole('CLIENTE', ['hoje.ver'])).toEqual([]);
        expect(permissionsForRole(undefined)).toEqual([]);
    });
});

describe('levelOf / modulesWithAccess', () => {
    it('reconhece os níveis e o personalizado', () => {
        expect(levelOf('agendamentos', [])).toBe('nenhum');
        expect(levelOf('agendamentos', ['agendamentos.ver'])).toBe('ver');
        expect(levelOf('agendamentos', moduleLevels('agendamentos').editar)).toBe('editar');
        expect(levelOf('agendamentos', moduleLevels('agendamentos').tudo)).toBe('tudo');
        expect(levelOf('agendamentos', ['agendamentos.ver', 'agendamentos.cancelar'])).toBe('personalizado');
        // chaves de outros módulos não contam
        expect(levelOf('agendamentos', ['agendamentos.ver', 'hoje.ver', 'config.gerais'])).toBe('ver');
    });

    it('quando dois níveis coincidem devolve o menor', () => {
        expect(levelOf('hoje', ['hoje.ver', 'hoje.presenca', 'hoje.gravacao'])).toBe('editar');
        expect(levelOf('financeiro', ['financeiro.ver'])).toBe('ver');
    });

    it('módulos sem "Ver" (Cobranças, Avisos) e Configurações (caixas)', () => {
        expect(levelOf('cobrancas', ['cobrancas.cobrar'])).toBe('editar');
        expect(levelOf('cobrancas', moduleLevels('cobrancas').tudo)).toBe('tudo');
        expect(levelOf('avisos', ['avisos.enviar'])).toBe('personalizado');
        expect(levelOf('avisos', ['avisos.enviar', 'avisos.modelos'])).toBe('tudo');
        expect(levelOf('config', [])).toBe('nenhum');
        expect(levelOf('config', ['config.gerais'])).toBe('personalizado');
        expect(levelOf('config', allPermissionKeys().filter(k => k.startsWith('config.')))).toBe('tudo');
    });

    it('modulesWithAccess conta só módulos com alguma chave válida', () => {
        expect(modulesWithAccess(['hoje.ver', 'config.gravacoes', 'equipe.gerenciar', 'lixo'])).toEqual(['hoje', 'config']);
    });
});

describe('perfis modelo (D2)', () => {
    const byKey = Object.fromEntries(STAFF_PRESETS.map(p => [p.key, [...p.permissions].sort()]));

    it('Recepção, Operador e Financeiro com as chaves exatas do D2', () => {
        expect(STAFF_PRESETS.map(p => [p.key, p.label])).toEqual([
            ['recepcao', 'Recepção / Atendimento'],
            ['operador', 'Operador de estúdio'],
            ['financeiro', 'Financeiro'],
        ]);
        expect(byKey.recepcao).toEqual([
            'agendamentos.ver', 'agendamentos.criar', 'agendamentos.editar', 'agendamentos.faltas', 'agendamentos.cancelar',
            'hoje.ver', 'hoje.presenca', 'clientes.ver', 'clientes.criar', 'clientes.editar',
            'contratos.ver', 'contratos.criar', 'cobrancas.cobrar', 'cupons.ver',
        ].sort());
        expect(byKey.operador).toEqual([
            'agendamentos.ver', 'agendamentos.faltas', 'hoje.ver', 'hoje.presenca', 'hoje.gravacao',
            'clientes.ver', 'relatorios.ver', 'config.gravacoes',
        ].sort());
        expect(byKey.financeiro).toEqual([
            'financeiro.ver', 'cobrancas.cobrar', 'cobrancas.cartao_salvo', 'cobrancas.baixa', 'cobrancas.automatica',
            'contratos.ver', 'contratos.editar', 'contratos.condicoes', 'contratos.cancelar', 'contratos.multa',
            'clientes.ver', 'clientes.editar', 'agendamentos.ver', 'relatorios.ver', 'cupons.ver', 'cupons.editar',
        ].sort());
    });

    it('todo perfil já vem normalizado, sem avisos.modelos e sem exclusivas', () => {
        for (const p of STAFF_PRESETS) {
            const n = normalizePermissions(p.permissions);
            expect(n.added, p.key).toEqual([]);
            expect(n.invalid, p.key).toEqual([]);
            expect(n.permissions, p.key).toEqual([...p.permissions]);
            expect(p.permissions, p.key).not.toContain('avisos.modelos');
            expect(p.description.length, p.key).toBeGreaterThan(10);
        }
    });

    it('Recepção não tem dinheiro nem baixa (nasce aguardando pagamento — D7)', () => {
        expect(byKey.recepcao).not.toContain('cobrancas.baixa');
        expect(byKey.recepcao).not.toContain('financeiro.ver');
    });
});

describe('Configurações: seções e grupos de business-config', () => {
    it('mapa grupo → permissão do DECISOES; email/gateway exclusivos; resto só ADMIN', () => {
        expect(BUSINESS_CONFIG_GROUP_PERMISSION).toEqual({
            studio: 'config.gerais', schedule: 'config.horarios', plans: 'config.precos', payments: 'config.precos',
            policies: 'config.politicas', ambient: 'config.ambiente', recordings: 'config.gravacoes',
            email: 'config.email', gateway: 'config.taxas',
        });
        expect(permissionForConfigGroup('outros')).toBe(ADMIN_REQUIREMENT);
        expect(permissionForConfigGroup(undefined)).toBe(ADMIN_REQUIREMENT);
        expect(permissionForConfigGroup('__proto__')).toBe(ADMIN_REQUIREMENT);
    });

    it('todo grupo do businessConfigCatalog tem mapeamento', () => {
        for (const g of new Set(BUSINESS_CONFIG_CATALOG.map(c => c.group))) {
            expect(permissionForConfigGroup(g), g).not.toBe(ADMIN_REQUIREMENT);
        }
    });

    it('seções da tela Configurações → permissão (e-mail e integrações só ADMIN)', () => {
        const map = Object.fromEntries(STAFF_SETTINGS_SECTIONS.map(s => [s.sec, s.permission]));
        expect(map).toEqual({
            gerais: 'config.gerais', horarios: 'config.horarios', financeiro: 'config.precos', politicas: 'config.politicas',
            servicos: 'config.servicos', pagamentos: 'config.pagamentos', ambiente: 'config.ambiente', gravacoes: 'config.gravacoes',
            email: 'config.email', integracoes: 'config.integracoes',
        });
    });
});

describe('STAFF_EVENT_PERMISSIONS (avisos da equipe)', () => {
    const adminEvents = NOTIFICATION_EVENT_CATALOG.filter(e => e.audience === 'admin');

    it('todo evento de audiência admin tem mapeamento, e só eles', () => {
        expect(Object.keys(STAFF_EVENT_PERMISSIONS).sort()).toEqual(adminEvents.map(e => e.eventKey).sort());
        for (const e of NOTIFICATION_EVENT_CATALOG.filter(x => x.audience !== 'admin')) {
            expect(staffEventPermissions(e.eventKey), e.eventKey).toEqual([]);
        }
        expect(staffEventPermissions('evento_inexistente')).toEqual([]);
        expect(staffEventPermissions('__proto__')).toEqual([]);
    });

    it('toda permissão de um evento abre a tela do link (crítica I3)', () => {
        const OPENS: Record<string, PermissionKey> = {
            '/admin/today': 'hoje.ver', '/admin/finance': 'financeiro.ver', '/admin/contracts': 'contratos.ver',
            '/admin/bookings': 'agendamentos.ver', // admin_makeup_expired_studio (link ajustado pela frente B4)
        };
        expect(NOTIFICATION_EVENT_CATALOG.find(e => e.eventKey === 'admin_makeup_expired_studio')?.actionUrl).toBe('/admin/bookings');
        for (const e of adminEvents) {
            const perms = STAFF_EVENT_PERMISSIONS[e.eventKey];
            expect(perms.length, e.eventKey).toBeGreaterThan(0);
            const opener = OPENS[e.actionUrl ?? ''];
            expect(opener, `${e.eventKey} → ${e.actionUrl}`).toBeTruthy();
            for (const p of perms) expect(normalizePermissions([p]).permissions, `${e.eventKey}: ${p}`).toContain(opener);
        }
        expect(normalizePermissions(['agendamentos.faltas']).permissions).toContain('agendamentos.ver');
    });
});

// ─── Regras de corpo/estado (D3) ────────────────────────

const BOOKING = {
    status: 'CONFIRMED', date: new Date('2026-11-10T00:00:00Z'), startTime: '14:00', recordingStartedAt: null,
    statusReason: null, adminNotes: null, clientNotes: null, platforms: null, platformLinks: null,
    durationMinutes: null, peakViewers: null, chatMessages: null, audienceOrigin: null, isLivestream: null, streamMetrics: null,
};

describe('requiredForBookingStatusChange (transição de → para)', () => {
    const t = (from: string, to: string, rec = false) => requiredForBookingStatusChange(from, to, { recordingStarted: rec });

    it('mesmo status não exige nada', () => {
        expect(t('CONFIRMED', 'CONFIRMED')).toEqual([]);
    });
    it('RESERVED/HELD → CONFIRMED: presença OU editar', () => {
        expect(t('RESERVED', 'CONFIRMED')).toEqual([['hoje.presenca', 'agendamentos.editar']]);
        expect(t('HELD', 'CONFIRMED')).toEqual([['hoje.presenca', 'agendamentos.editar']]);
    });
    it('hoje.presenca NÃO reabre CANCELLED nem FALTA (sair do desfecho exige editar)', () => {
        expect(t('FALTA', 'CONFIRMED')).toEqual([['agendamentos.editar']]);
        expect(t('COMPLETED', 'RESERVED')).toEqual([['agendamentos.editar']]);
    });
    it('R4: sair de CANCELLED (para qualquer status) exige editar E cobrancas.baixa (+ faltas se envolve NAO_REALIZADO)', () => {
        expect(t('CANCELLED', 'CONFIRMED')).toEqual([['agendamentos.editar'], ['cobrancas.baixa']]);
        expect(t('CANCELLED', 'RESERVED')).toEqual([['agendamentos.editar'], ['cobrancas.baixa']]);
        expect(t('CANCELLED', 'HELD')).toEqual([['agendamentos.editar'], ['cobrancas.baixa']]);
        expect(t('CANCELLED', 'COMPLETED')).toEqual([['agendamentos.editar'], ['cobrancas.baixa']]);
        expect(t('CANCELLED', 'NAO_REALIZADO')).toEqual([['agendamentos.editar'], ['cobrancas.baixa'], ['agendamentos.faltas']]);
        expect(t('CANCELLED', 'FALTA')).toEqual([['agendamentos.editar'], ['cobrancas.baixa'], ['agendamentos.faltas']]);
        expect(t('CANCELLED', 'CANCELLED')).toEqual([]);
        // Os outros desfechos continuam sem a baixa.
        expect(t('COMPLETED', 'CONFIRMED')).toEqual([['agendamentos.editar']]);
        expect(t('NAO_REALIZADO', 'RESERVED')).toEqual([['agendamentos.editar'], ['agendamentos.faltas']]);
    });
    it('envolver NAO_REALIZADO (mexe em crédito) exige também faltas', () => {
        expect(t('NAO_REALIZADO', 'CONFIRMED')).toEqual([['agendamentos.editar'], ['agendamentos.faltas']]);
        expect(t('FALTA', 'NAO_REALIZADO')).toEqual([['agendamentos.editar'], ['agendamentos.faltas']]);
        expect(t('CONFIRMED', 'NAO_REALIZADO')).toEqual([['agendamentos.faltas']]);
    });
    it('→ COMPLETED: gravação iniciada = hoje.gravacao (ou editar); sem início = editar', () => {
        expect(t('CONFIRMED', 'COMPLETED', true)).toEqual([['hoje.gravacao', 'agendamentos.editar']]);
        expect(t('CONFIRMED', 'COMPLETED', false)).toEqual([['agendamentos.editar']]);
        expect(t('RESERVED', 'COMPLETED', true)).toEqual([['agendamentos.editar']]);
        expect(t('CANCELLED', 'COMPLETED', true)).toEqual([['agendamentos.editar'], ['cobrancas.baixa']]);
    });
    it('→ FALTA: faltas · → CANCELLED: cancelar · → RESERVED: editar', () => {
        expect(t('CONFIRMED', 'FALTA')).toEqual([['agendamentos.faltas']]);
        expect(t('RESERVED', 'CANCELLED')).toEqual([['agendamentos.cancelar']]);
        expect(t('FALTA', 'CANCELLED')).toEqual([['agendamentos.editar'], ['agendamentos.cancelar']]);
        expect(t('CONFIRMED', 'RESERVED')).toEqual([['agendamentos.editar']]);
    });
    it('status desconhecido → só ADMIN', () => {
        expect(t('CONFIRMED', 'XPTO')).toEqual([[ADMIN_REQUIREMENT]]);
        expect(t('XPTO', 'CONFIRMED')).toEqual([[ADMIN_REQUIREMENT]]);
    });
});

describe('requiredForBookingPatch (por valor alterado)', () => {
    it('payload completo do EditBookingModal com date/startTime iguais: só o requisito do status', () => {
        const r = requiredForBookingPatch({ date: '2026-11-10', startTime: '14:00', status: 'CANCELLED' }, BOOKING);
        expect(keysOf(r)).toEqual([['agendamentos.cancelar']]);
        expect(r.rejected).toEqual([]);
    });
    it('nada mudou → nenhum requisito', () => {
        expect(keysOf(requiredForBookingPatch({ date: '2026-11-10', startTime: '14:00', status: 'CONFIRMED' }, BOOKING))).toEqual([]);
    });
    it('remarcar data ou horário → editar', () => {
        expect(keysOf(requiredForBookingPatch({ date: '2026-11-11', startTime: '14:00', status: 'CONFIRMED' }, BOOKING))).toEqual([['agendamentos.editar']]);
        expect(keysOf(requiredForBookingPatch({ startTime: '16:00' }, BOOKING))).toEqual([['agendamentos.editar']]);
    });
    it('FALTA com motivo e justificativa → só faltas (sem repetir)', () => {
        const r = requiredForBookingPatch({ status: 'FALTA', statusReason: 'não veio', noShowJustified: true }, BOOKING);
        expect(keysOf(r)).toEqual([['agendamentos.faltas']]);
    });
    it('noShowJustified sozinho (botão Justificar) → faltas', () => {
        expect(keysOf(requiredForBookingPatch({ noShowJustified: false }, { ...BOOKING, status: 'FALTA' }))).toEqual([['agendamentos.faltas']]);
    });
    it('notas e métricas alteradas → gravação OU editar; nulls iguais aos atuais não contam', () => {
        expect(keysOf(requiredForBookingPatch({ adminNotes: 'ok' }, BOOKING))).toEqual([['hoje.gravacao', 'agendamentos.editar']]);
        expect(keysOf(requiredForBookingPatch({ adminNotes: '', durationMinutes: null, isLivestream: null }, BOOKING))).toEqual([]);
        expect(keysOf(requiredForBookingPatch({ peakViewers: 10 }, { ...BOOKING, status: 'COMPLETED', peakViewers: 10 }))).toEqual([]);
    });
    it('campo sem mapeamento → só ADMIN (nega por padrão)', () => {
        const r = requiredForBookingPatch({ price: 0 }, BOOKING);
        expect(needsAdmin(r)).toBe(true);
    });
    it('registro incompleto: campo ausente com valor conta como alterado', () => {
        const { adminNotes: _a, ...partial } = BOOKING;
        expect(keysOf(requiredForBookingPatch({ adminNotes: 'x' }, partial as typeof BOOKING))).toEqual([['hoje.gravacao', 'agendamentos.editar']]);
    });
    it('toda chave do adminUpdateBookingSchema tem regra (e nenhuma cai no ADMIN)', () => {
        const shapeKeys = Object.keys(adminUpdateBookingSchema.shape).sort();
        expect(Object.keys(BOOKING_PATCH_FIELD_RULES).sort()).toEqual(shapeKeys);
        const sample: Record<string, unknown> = {
            date: '2030-01-02', startTime: '10:00', status: 'CANCELLED', statusReason: 'motivo', noShowJustified: true,
            isLivestream: true, durationMinutes: 90, peakViewers: 5, chatMessages: 3,
        };
        for (const k of shapeKeys) {
            const v = k in sample ? sample[k] : 'valor novo';
            const r = requiredForBookingPatch({ [k]: v }, BOOKING);
            expect(r.requirements.length, k).toBeGreaterThan(0);
            expect(needsAdmin(r), k).toBe(false);
        }
    });
});

describe('requiredForAdminBookingCreate (F1 / D7)', () => {
    const base = { userId: 'u', date: '2030-01-02', startTime: '10:00', status: 'CONFIRMED', paymentMethod: 'PIX' };

    it('sem cobrancas.baixa: CONFIRMED vira RESERVED (sem 403) e informa', () => {
        const p = requiredForAdminBookingCreate(base, { standardPrice: 30000, canMarkPaid: false });
        expect(p.status).toBe('RESERVED');
        expect(p.downgraded).toBe(true);
        expect(keysOf(p)).toEqual([['agendamentos.criar']]);
    });
    it('com cobrancas.baixa: CONFIRMED mantido', () => {
        const p = requiredForAdminBookingCreate(base, { standardPrice: 30000, canMarkPaid: true });
        expect(p.status).toBe('CONFIRMED');
        expect(p.downgraded).toBe(false);
    });
    it('RESERVED pedido: nunca rebaixa; status ausente = default CONFIRMED do schema', () => {
        expect(requiredForAdminBookingCreate({ ...base, status: 'RESERVED' }, { standardPrice: 1, canMarkPaid: false })).toMatchObject({ status: 'RESERVED', downgraded: false });
        const { status: _s, ...noStatus } = base;
        expect(requiredForAdminBookingCreate(noStatus, { standardPrice: 1, canMarkPaid: false })).toMatchObject({ status: 'RESERVED', downgraded: true });
    });
    it('customPrice diferente do preço padrão (inclusive 0) → cobrancas.baixa; igual → nada a mais', () => {
        expect(keysOf(requiredForAdminBookingCreate({ ...base, customPrice: 0 }, { standardPrice: 30000, canMarkPaid: false })))
            .toEqual([['agendamentos.criar'], ['cobrancas.baixa']]);
        expect(keysOf(requiredForAdminBookingCreate({ ...base, customPrice: 25000 }, { standardPrice: 30000, canMarkPaid: true })))
            .toEqual([['agendamentos.criar'], ['cobrancas.baixa']]);
        expect(keysOf(requiredForAdminBookingCreate({ ...base, customPrice: 30000 }, { standardPrice: 30000, canMarkPaid: false })))
            .toEqual([['agendamentos.criar']]);
        expect(keysOf(requiredForAdminBookingCreate({ ...base, customPrice: 30000 }, { standardPrice: null, canMarkPaid: false })))
            .toEqual([['agendamentos.criar'], ['cobrancas.baixa']]);
    });
    it('campo sem mapeamento → só ADMIN; toda chave do adminCreateBookingSchema tem regra', () => {
        expect(needsAdmin(requiredForAdminBookingCreate({ ...base, price: 1 }, { standardPrice: 1, canMarkPaid: true }))).toBe(true);
        expect([...ADMIN_BOOKING_CREATE_FIELDS].sort()).toEqual(Object.keys(adminCreateBookingSchema.shape).sort());
        for (const k of Object.keys(adminCreateBookingSchema.shape)) {
            expect(needsAdmin(requiredForAdminBookingCreate({ ...base, [k]: k === 'customPrice' ? 1 : 'x' }, { standardPrice: 1, canMarkPaid: false })), k).toBe(false);
        }
    });
});

const CONTRACT = {
    status: 'ACTIVE', endDate: new Date('2026-12-15T00:00:00Z'), flexCreditsRemaining: 8,
    contractUrl: null, paymentMethod: 'PIX', boletoAllowed: false,
};

describe('requiredForContractPatch (F3 / F4)', () => {
    it('"Editar" reenviando endDate e créditos atuais → nenhum requisito', () => {
        expect(keysOf(requiredForContractPatch({ status: 'ACTIVE', endDate: '2026-12-15', flexCreditsRemaining: 8, contractUrl: '', paymentMethod: 'PIX' }, CONTRACT))).toEqual([]);
    });
    it('endDate, link e forma alterados → editar; créditos e boleto → condições; addOns presente → condições', () => {
        expect(keysOf(requiredForContractPatch({ endDate: '2027-01-15' }, CONTRACT))).toEqual([['contratos.editar']]);
        expect(keysOf(requiredForContractPatch({ contractUrl: 'https://x.y/z' }, CONTRACT))).toEqual([['contratos.editar']]);
        expect(keysOf(requiredForContractPatch({ paymentMethod: 'CARTAO' }, CONTRACT))).toEqual([['contratos.editar']]);
        expect(keysOf(requiredForContractPatch({ flexCreditsRemaining: 9 }, CONTRACT))).toEqual([['contratos.condicoes']]);
        expect(keysOf(requiredForContractPatch({ boletoAllowed: true }, CONTRACT))).toEqual([['contratos.condicoes']]);
        expect(keysOf(requiredForContractPatch({ boletoAllowed: false }, CONTRACT))).toEqual([]);
        expect(keysOf(requiredForContractPatch({ addOns: [] }, { ...CONTRACT }))).toEqual([['contratos.condicoes']]);
    });
    it('status: CANCELLED → cancelar; ACTIVE/COMPLETED/EXPIRED → editar', () => {
        expect(keysOf(requiredForContractPatch({ status: 'CANCELLED' }, CONTRACT))).toEqual([['contratos.cancelar']]);
        expect(keysOf(requiredForContractPatch({ status: 'EXPIRED' }, CONTRACT))).toEqual([['contratos.editar']]);
        expect(keysOf(requiredForContractPatch({ status: 'COMPLETED' }, CONTRACT))).toEqual([['contratos.editar']]);
        expect(keysOf(requiredForContractPatch({ status: 'ACTIVE' }, { ...CONTRACT, status: 'PAUSED' }))).toEqual([['contratos.editar']]);
    });
    it('PENDING_CANCELLATION: cancelar ou reabrir exige também contratos.multa', () => {
        const pend = { ...CONTRACT, status: 'PENDING_CANCELLATION' };
        expect(keysOf(requiredForContractPatch({ status: 'CANCELLED' }, pend))).toEqual([['contratos.cancelar'], ['contratos.multa']]);
        expect(keysOf(requiredForContractPatch({ status: 'ACTIVE' }, pend))).toEqual([['contratos.editar'], ['contratos.multa']]);
        expect(keysOf(requiredForContractPatch({ status: 'EXPIRED' }, pend))).toEqual([['contratos.editar'], ['contratos.multa']]);
        expect(keysOf(requiredForContractPatch({ endDate: '2026-12-15' }, pend))).toEqual([]);
    });
    it('DELETE: cancelar (+ multa em PENDING_CANCELLATION)', () => {
        expect(keysOf(requiredForContractCancel({ status: 'ACTIVE' }))).toEqual([['contratos.cancelar']]);
        expect(keysOf(requiredForContractCancel({ status: 'PENDING_CANCELLATION' }))).toEqual([['contratos.cancelar'], ['contratos.multa']]);
    });
    it('campo sem mapeamento → só ADMIN; toda chave do updateContractSchema tem regra', () => {
        expect(needsAdmin(requiredForContractPatch({ discountPct: 50 }, CONTRACT))).toBe(true);
        expect([...CONTRACT_PATCH_FIELDS].sort()).toEqual(Object.keys(updateContractSchema.shape).sort());
        const sample: Record<string, unknown> = { status: 'CANCELLED', endDate: '2030-01-01', flexCreditsRemaining: 1, contractUrl: 'https://a.b', paymentMethod: 'CARTAO', boletoAllowed: true, addOns: ['X'] };
        for (const k of Object.keys(updateContractSchema.shape)) {
            const r = requiredForContractPatch({ [k]: sample[k] }, CONTRACT);
            expect(r.requirements.length, k).toBeGreaterThan(0);
            expect(needsAdmin(r), k).toBe(false);
        }
    });
});

const CLIENT = {
    email: 'joao@x.com', cpfCnpj: null, clientStatus: 'ACTIVE', name: 'João', phone: '21999', notes: null,
    address: null, addressNumber: null, complement: null, neighborhood: null, city: null, state: null, zipCode: null,
    tags: ['vip'], socialLinks: null,
};

describe('requiredForUserPatch (D3 / D9 / F8)', () => {
    it('role CLIENTE é aceito e ignorado; outro papel é recusado (400) para todos', () => {
        expect(requiredForUserPatch({ role: 'CLIENTE' }, CLIENT)).toEqual({ requirements: [], rejected: [] });
        const r = requiredForUserPatch({ role: 'ADMIN' }, CLIENT);
        expect(r.rejected.map(x => [x.field, x.code])).toEqual([['role', 'ROLE_NOT_ALLOWED']]);
    });
    it('senha de cliente: só ADMIN', () => {
        expect(keysOf(requiredForUserPatch({ password: 'segredo1' }, CLIENT))).toEqual([[ADMIN_REQUIREMENT]]);
    });
    it('e-mail: mesmo valor (sem diferenciar maiúsculas) não conta; troca → clientes.acesso', () => {
        expect(keysOf(requiredForUserPatch({ email: ' JOAO@x.com ' }, CLIENT))).toEqual([]);
        expect(keysOf(requiredForUserPatch({ email: 'novo@x.com' }, CLIENT))).toEqual([['clientes.acesso']]);
    });
    it('situação: entrar/sair de BLOCKED → acesso; ACTIVE↔INACTIVE → editar', () => {
        expect(keysOf(requiredForUserPatch({ clientStatus: 'BLOCKED' }, CLIENT))).toEqual([['clientes.acesso']]);
        expect(keysOf(requiredForUserPatch({ clientStatus: 'ACTIVE' }, { ...CLIENT, clientStatus: 'BLOCKED' }))).toEqual([['clientes.acesso']]);
        expect(keysOf(requiredForUserPatch({ clientStatus: 'INACTIVE' }, CLIENT))).toEqual([['clientes.editar']]);
        expect(keysOf(requiredForUserPatch({ clientStatus: 'ACTIVE' }, CLIENT))).toEqual([]);
    });
    it('CPF/CNPJ: cliente sem CPF → editar OU cobrar; com CPF → editar; mesmo número formatado não conta', () => {
        expect(keysOf(requiredForUserPatch({ cpfCnpj: '529.982.247-25' }, CLIENT))).toEqual([['clientes.editar', 'cobrancas.cobrar']]);
        expect(keysOf(requiredForUserPatch({ cpfCnpj: '11144477735' }, { ...CLIENT, cpfCnpj: '52998224725' }))).toEqual([['clientes.editar']]);
        expect(keysOf(requiredForUserPatch({ cpfCnpj: '529.982.247-25' }, { ...CLIENT, cpfCnpj: '52998224725' }))).toEqual([]);
        expect(keysOf(requiredForUserPatch({ cpfCnpj: null }, CLIENT))).toEqual([]);
    });
    it('cadastro alterado → editar; formulário reenviado igual → nada', () => {
        expect(keysOf(requiredForUserPatch({ name: 'João S.', tags: ['vip', 'novo'] }, CLIENT))).toEqual([['clientes.editar']]);
        expect(keysOf(requiredForUserPatch({ name: 'João', phone: '21999', notes: '', tags: ['vip'], city: null }, CLIENT))).toEqual([]);
    });
    it('campo sem mapeamento → só ADMIN; toda chave do updateUserSchema (users.crud.ts) tem regra', () => {
        expect(needsAdmin(requiredForUserPatch({ stripeCustomerId: 'cus_1' }, CLIENT))).toBe(true);
        const shape = schemaKeysFromSource('modules/users/users.crud.ts', 'updateUserSchema');
        expect(shape.length).toBeGreaterThan(10);
        for (const k of shape) expect(USER_PATCH_FIELDS, k).toContain(k);
        const sample: Record<string, unknown> = { tags: ['a'], clientStatus: 'INACTIVE', role: 'CLIENTE', email: 'b@b.com', cpfCnpj: '52998224725' };
        for (const k of shape) {
            const r = requiredForUserPatch({ [k]: k in sample ? sample[k] : 'valor novo' }, CLIENT);
            if (k === 'password') { expect(needsAdmin(r)).toBe(true); continue; } // senha: só ADMIN por regra (F8)
            if (k === 'role') { expect(r).toEqual({ requirements: [], rejected: [] }); continue; }
            expect(r.requirements.length, k).toBeGreaterThan(0);
            expect(needsAdmin(r), k).toBe(false);
        }
    });
});

describe('requiredForUserCreate', () => {
    it('sempre clientes.criar; senha só ADMIN; nascer BLOCKED → acesso; role ≠ CLIENTE recusado', () => {
        expect(keysOf(requiredForUserCreate({ email: 'a@b.c', name: 'Ana', role: 'CLIENTE' }))).toEqual([['clientes.criar']]);
        expect(keysOf(requiredForUserCreate({ email: 'a@b.c', name: 'Ana', password: 'x123456' }))).toEqual([['clientes.criar'], [ADMIN_REQUIREMENT]]);
        expect(keysOf(requiredForUserCreate({ email: 'a@b.c', name: 'Ana', clientStatus: 'BLOCKED' }))).toEqual([['clientes.criar'], ['clientes.acesso']]);
        expect(requiredForUserCreate({ email: 'a@b.c', role: 'ADMIN' }).rejected[0]?.code).toBe('ROLE_NOT_ALLOWED');
        expect(needsAdmin(requiredForUserCreate({ email: 'a@b.c', autoChargeEnabled: true }))).toBe(true);
    });
    it('toda chave do createUserSchema (users.crud.ts) tem regra', () => {
        for (const k of schemaKeysFromSource('modules/users/users.crud.ts', 'createUserSchema')) expect(USER_CREATE_FIELDS, k).toContain(k);
    });
});

describe('requiredForPaymentPatch', () => {
    it('toda transição manual é baixa; campo desconhecido → só ADMIN; toda chave do updatePaymentSchema tem regra', () => {
        expect(keysOf(requiredForPaymentPatch({ status: 'PAID' }))).toEqual([['cobrancas.baixa']]);
        expect(needsAdmin(requiredForPaymentPatch({ amount: 1 }))).toBe(true);
        const shape = schemaKeysFromSource('modules/payments/payments.admin.ts', 'updatePaymentSchema');
        expect([...PAYMENT_PATCH_FIELDS].sort()).toEqual([...shape].sort());
    });
});

describe('requiredForBusinessConfig (tudo ou nada por grupo)', () => {
    it('cada grupo exige a sua permissão; chave de schedule fora do catálogo usa o grupo do banco', () => {
        const r = requiredForBusinessConfig(['cancellation_fine_pct', 'time_slots', 'studio_phone'], { time_slots: 'schedule' });
        expect(keysOf(r)).toEqual([['config.politicas'], ['config.horarios'], ['config.gerais']]);
        expect(r.groups).toEqual({ policies: 'config.politicas', schedule: 'config.horarios', studio: 'config.gerais' });
    });
    it('plans + payments → config.precos (uma vez só)', () => {
        expect(keysOf(requiredForBusinessConfig(['discount_3months', 'pix_extra_discount_pct']))).toEqual([['config.precos']]);
    });
    it('email/gateway → exclusivas; chave desconhecida → outros → só ADMIN', () => {
        expect(flat(requiredForBusinessConfig(['email_smtp_host']))).toEqual(['config.email']);
        expect(flat(requiredForBusinessConfig(['gateway_stripe_fee_pct']))).toEqual(['config.taxas']);
        expect(flat(requiredForBusinessConfig(['chave_nova']))).toEqual([ADMIN_REQUIREMENT]);
        expect(businessConfigGroupOf('chave_nova')).toBe('outros');
        expect(businessConfigGroupOf('studio_name', { studio_name: 'email' })).toBe('studio'); // catálogo vence o banco
    });
});

// ─── Middleware (getActor / can / guards) ───────────────

type FakeRes = { statusCode: number; body: unknown; headersSent: boolean; status(c: number): FakeRes; json(b: unknown): FakeRes };
function fakeRes(): FakeRes {
    return {
        statusCode: 200, body: undefined, headersSent: false,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; this.headersSent = true; return this; },
    };
}
const reqFor = (role: string, userId = 'u1') => ({ user: { userId, email: 'x@y.z', role } }) as any;
const actorOf = (role: Actor['role'], perms: string[] = []): Actor => ({
    userId: 'u', role, isAdmin: role === 'ADMIN', isStaff: role !== 'CLIENTE', permissions: new Set(permissionsForRole(role, perms)),
});

describe('getActor (D4)', () => {
    beforeEach(() => {
        mockPrisma.user.findUnique.mockReset();
        mockPrisma.user.findMany.mockReset();
        mockPrisma.staffProfile.findUnique.mockReset();
    });

    it('CLIENTE pelo JWT: sem consulta ao banco, nenhuma permissão', async () => {
        const a = await getActor(reqFor('CLIENTE'));
        expect(a.role).toBe('CLIENTE');
        expect(a.permissions.size).toBe(0);
        expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('ADMIN: lê o papel do banco SEM join em staff_profiles e tem tudo (inclusive exclusivas)', async () => {
        mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN', clientStatus: 'ACTIVE', deletedAt: null });
        const a = await getActor(reqFor('ADMIN'));
        expect(a.isAdmin).toBe(true);
        expect(mockPrisma.staffProfile.findUnique).not.toHaveBeenCalled();
        expect(mockPrisma.user.findUnique.mock.calls[0][0].select).toEqual({ role: true, clientStatus: true, deletedAt: true });
        expect(can(a, 'equipe.gerenciar')).toBe(true);
        expect(can(a, ADMIN_REQUIREMENT)).toBe(true);
    });

    it('COLABORADOR: permissões do banco, sanitizadas (sem chave velha nem exclusiva)', async () => {
        mockPrisma.user.findUnique.mockResolvedValue({ role: 'COLABORADOR', clientStatus: 'ACTIVE', deletedAt: null });
        mockPrisma.staffProfile.findUnique.mockResolvedValue({ permissions: ['hoje.ver', 'config.email', 'velha.chave'] });
        const a = await getActor(reqFor('COLABORADOR'));
        expect(a.role).toBe('COLABORADOR');
        expect([...a.permissions]).toEqual(['hoje.ver']);
        expect(can(a, 'hoje.ver')).toBe(true);
        expect(can(a, 'hoje.presenca')).toBe(false);
        expect(can(a, 'config.email')).toBe(false);
        expect(can(a, ADMIN_REQUIREMENT)).toBe(false);
    });

    it('papel do BANCO vence o do JWT (ADMIN rebaixado vira COLABORADOR na hora)', async () => {
        mockPrisma.user.findUnique.mockResolvedValue({ role: 'COLABORADOR', clientStatus: 'ACTIVE', deletedAt: null });
        mockPrisma.staffProfile.findUnique.mockResolvedValue(null);
        const a = await getActor(reqFor('ADMIN'));
        expect(a.role).toBe('COLABORADOR');
        expect(a.permissions.size).toBe(0);
    });

    it('conta BLOCKED, excluída ou inexistente → 401 ACCOUNT_DISABLED', async () => {
        for (const row of [
            { role: 'COLABORADOR', clientStatus: 'BLOCKED', deletedAt: null },
            { role: 'ADMIN', clientStatus: 'ACTIVE', deletedAt: new Date() },
            null,
        ]) {
            mockPrisma.user.findUnique.mockResolvedValueOnce(row);
            const err = await getActor(reqFor('ADMIN')).catch(e => e);
            expect(err).toBeInstanceOf(ActorError);
            expect(err.status).toBe(401);
            expect(err.body).toEqual({ code: 'ACCOUNT_DISABLED', error: 'Seu acesso foi desativado. Fale com o administrador.' });
        }
    });

    it('falha do banco → 503 (falha fechada), no usuário e no perfil', async () => {
        mockPrisma.user.findUnique.mockRejectedValueOnce(new Error('db down'));
        const e1 = await getActor(reqFor('ADMIN')).catch(e => e);
        expect(e1.status).toBe(503);
        mockPrisma.user.findUnique.mockResolvedValueOnce({ role: 'COLABORADOR', clientStatus: 'ACTIVE', deletedAt: null });
        mockPrisma.staffProfile.findUnique.mockRejectedValueOnce(new Error('relation "staff_profiles" does not exist'));
        const e2 = await getActor(reqFor('COLABORADOR')).catch(e => e);
        expect(e2.status).toBe(503);
    });

    it('memo por requisição: uma consulta só', async () => {
        mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN', clientStatus: 'ACTIVE', deletedAt: null });
        const req = reqFor('ADMIN');
        await getActor(req);
        await getActor(req);
        expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(1);
    });

    it('sem req.user → 401', async () => {
        const err = await getActor({} as any).catch(e => e);
        expect(err.status).toBe(401);
    });
});

describe('guards e enforceRuleResult', () => {
    beforeEach(() => {
        mockPrisma.user.findUnique.mockReset();
        mockPrisma.staffProfile.findUnique.mockReset();
    });
    const colab = (perms: string[]) => {
        mockPrisma.user.findUnique.mockResolvedValue({ role: 'COLABORADOR', clientStatus: 'ACTIVE', deletedAt: null });
        mockPrisma.staffProfile.findUnique.mockResolvedValue({ permissions: perms });
    };
    const run = async (mw: any, req: any) => {
        const res = fakeRes();
        const next = vi.fn();
        await mw(req, res, next);
        return { res, next };
    };

    it('requirePermission: qualquer uma passa; nenhuma → 403 padrão com a primeira chave', async () => {
        colab(['hoje.ver']);
        expect((await run(requirePermission('agendamentos.ver', 'hoje.ver'), reqFor('COLABORADOR'))).next).toHaveBeenCalled();
        const { res, next } = await run(requirePermission('financeiro.ver'), reqFor('COLABORADOR'));
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: 'Você não tem permissão para esta ação.', code: 'PERMISSION_DENIED', permission: 'financeiro.ver' });
    });

    it('CLIENTE recebe 403 em rota de equipe sem tocar no banco', async () => {
        const { res } = await run(requirePermission('hoje.ver'), reqFor('CLIENTE'));
        expect(res.statusCode).toBe(403);
        expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('requireStaff / requireAdmin / requireRole', async () => {
        colab([]);
        expect((await run(requireStaff(), reqFor('COLABORADOR'))).next).toHaveBeenCalled();
        const adm = await run(requireAdmin(), reqFor('COLABORADOR'));
        expect(adm.res.statusCode).toBe(403);
        expect((adm.res.body as any).permission).toBe('ADMIN');
        expect((await run(requireStaff(), reqFor('CLIENTE'))).res.statusCode).toBe(403);
        // autoatendimento: só CLIENTE — ADMIN (do banco) não passa
        mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN', clientStatus: 'ACTIVE', deletedAt: null });
        expect((await run(requireRole('CLIENTE'), reqFor('ADMIN'))).res.statusCode).toBe(403);
        expect((await run(requireRole('CLIENTE'), reqFor('CLIENTE'))).next).toHaveBeenCalled();
    });

    it('conta desativada → 401 ACCOUNT_DISABLED; banco fora → 503 (nunca lança)', async () => {
        mockPrisma.user.findUnique.mockResolvedValueOnce({ role: 'COLABORADOR', clientStatus: 'BLOCKED', deletedAt: null });
        const blocked = await run(requirePermission('hoje.ver'), reqFor('COLABORADOR'));
        expect(blocked.res.statusCode).toBe(401);
        expect((blocked.res.body as any).code).toBe('ACCOUNT_DISABLED');
        mockPrisma.user.findUnique.mockRejectedValueOnce(new Error('boom'));
        const down = await run(requireStaff(), reqFor('ADMIN'));
        expect(down.res.statusCode).toBe(503);
        expect(down.next).not.toHaveBeenCalled();
    });

    it('requirePermission sem chave é erro de programação', () => {
        expect(() => requirePermission()).toThrow();
    });

    it('missingRequirement: primeira chave do primeiro requisito não atendido', () => {
        const a = actorOf('COLABORADOR', ['agendamentos.ver', 'agendamentos.cancelar']);
        expect(missingRequirement(a, requiredForBookingPatch({ status: 'CANCELLED' }, BOOKING).requirements)).toBeNull();
        expect(missingRequirement(a, requiredForBookingPatch({ status: 'FALTA' }, BOOKING).requirements)).toBe('agendamentos.faltas');
        expect(missingRequirement(actorOf('ADMIN'), [{ anyOf: [ADMIN_REQUIREMENT], field: 'x' }])).toBeNull();
        expect(missingRequirement(actorOf('COLABORADOR', allPermissionKeys()), [{ anyOf: [ADMIN_REQUIREMENT], field: 'x' }])).toBe('ADMIN');
    });

    it('enforceRuleResult: 400 no campo recusado, 403 na falta, true quando passa', async () => {
        colab(['clientes.ver', 'clientes.editar']);
        const r400 = fakeRes();
        expect(await enforceRuleResult(reqFor('COLABORADOR'), r400 as any, requiredForUserPatch({ role: 'ADMIN' }, CLIENT))).toBe(false);
        expect(r400.statusCode).toBe(400);
        expect(r400.body).toMatchObject({ code: 'ROLE_NOT_ALLOWED', field: 'role' });
        const r403 = fakeRes();
        expect(await enforceRuleResult(reqFor('COLABORADOR'), r403 as any, requiredForUserPatch({ email: 'novo@x.com' }, CLIENT))).toBe(false);
        expect(r403.statusCode).toBe(403);
        expect((r403.body as any).permission).toBe('clientes.acesso');
        const ok = fakeRes();
        expect(await enforceRuleResult(reqFor('COLABORADOR'), ok as any, requiredForUserPatch({ name: 'Outro' }, CLIENT))).toBe(true);
        expect(ok.headersSent).toBe(false);
    });
});

describe('getStaffRecipientIds', () => {
    beforeEach(() => mockPrisma.user.findMany.mockReset());

    it('ADMIN ativo + COLABORADOR ativo com a permissão do evento; nunca BLOCKED/excluído', async () => {
        mockPrisma.user.findMany.mockResolvedValue([{ id: 'a' }, { id: 'c' }]);
        expect(await getStaffRecipientIds('admin_cancellation_requested', { excludeUserId: 'x' })).toEqual(['a', 'c']);
        const where = mockPrisma.user.findMany.mock.calls[0][0].where;
        expect(where).toEqual({
            deletedAt: null,
            clientStatus: { not: 'BLOCKED' },
            id: { not: 'x' },
            OR: [
                { role: 'ADMIN' },
                { role: 'COLABORADOR', staffProfile: { is: { permissions: { hasSome: ['contratos.multa'] } } } },
            ],
        });
    });

    it('evento sem mapeamento → só ADMIN; permissão direta e lista também valem', async () => {
        mockPrisma.user.findMany.mockResolvedValue([{ id: 'a' }]);
        await getStaffRecipientIds('evento_desconhecido');
        expect(mockPrisma.user.findMany.mock.calls[0][0].where).toEqual({ deletedAt: null, clientStatus: { not: 'BLOCKED' }, role: 'ADMIN' });
        expect(resolveRecipientPermissions('hoje.ver')).toEqual(['hoje.ver']);
        expect(resolveRecipientPermissions(['financeiro.ver', 'lixo'])).toEqual(['financeiro.ver']);
        expect(resolveRecipientPermissions('computed_booking_unconfirmed_admin')).toEqual(['hoje.presenca']);
    });

    it('falha na consulta com staff_profiles → segue só com os administradores (M1)', async () => {
        mockPrisma.user.findMany.mockRejectedValueOnce(new Error('relation "staff_profiles" does not exist')).mockResolvedValueOnce([{ id: 'a' }]);
        expect(await getStaffRecipientIds('admin_booking_confirmed')).toEqual(['a']);
        expect(mockPrisma.user.findMany.mock.calls[1][0].where.role).toBe('ADMIN');
    });

    it('dentro de transação a falha propaga (o Postgres já abortou)', async () => {
        const tx = { user: { findMany: vi.fn().mockRejectedValue(new Error('aborted')) } };
        await expect(getStaffRecipientIds('admin_booking_confirmed', { db: tx })).rejects.toThrow('aborted');
    });
});
