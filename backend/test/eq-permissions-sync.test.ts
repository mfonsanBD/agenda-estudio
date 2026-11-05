import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ADMIN_ONLY_KEYS,
    STAFF_PRESETS,
    STAFF_SETTINGS_SECTIONS,
    allModuleKeys,
    allPermissionKeys,
    buildStaffCatalog,
} from '../src/config/staffPermissions';
// O arquivo do front não tem imports (só a união de chaves): dá para carregá-lo direto daqui.
import * as front from '../../frontend/src/constants/permissions';

// FRENTE T — sincronia das chaves de permissão entre backend e frontend (DECISOES D2, crítica C5).
// A fonte única é backend/src/config/staffPermissions.ts (rótulos, níveis e perfis vêm do servidor em
// GET /api/staff/catalog); o front guarda só a união das chaves, para tipagem. Este teste quebra quando
// alguém acrescenta, renomeia ou reordena uma chave de um lado sem o outro.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FRONT_FILE = path.join(ROOT, 'frontend/src/constants/permissions.ts');

describe('chaves de permissão: backend × frontend/src/constants/permissions.ts', () => {
    it('chaves delegáveis iguais e na mesma ordem do catálogo', () => {
        expect([...front.PERMISSION_KEYS]).toEqual(allPermissionKeys());
    });

    it('chaves exclusivas do ADMIN iguais (e nunca delegáveis)', () => {
        expect([...front.ADMIN_ONLY_PERMISSION_KEYS]).toEqual([...ADMIN_ONLY_KEYS]);
        const delegable = new Set<string>(allPermissionKeys());
        expect(front.ADMIN_ONLY_PERMISSION_KEYS.filter(k => delegable.has(k))).toEqual([]);
    });

    it('as caixas de Configurações (config.*) são as mesmas', () => {
        expect([...front.CONFIG_PERMISSION_KEYS]).toEqual(allPermissionKeys().filter(k => k.startsWith('config.')));
    });

    it('seção de Configurações → chave: espelho exato de STAFF_SETTINGS_SECTIONS (mesma ordem)', () => {
        expect(Object.entries(front.SETTINGS_SECTION_PERMISSIONS)).toEqual(STAFF_SETTINGS_SECTIONS.map(s => [s.sec, s.permission]));
        expect(front.settingsSectionPermission('email')).toBe('config.email');
        expect(front.settingsSectionPermission('nao-existe')).toBeUndefined();
    });

    it('os módulos do tipo PermissionModuleKey do front são os do catálogo (mesma ordem)', () => {
        const src = readFileSync(FRONT_FILE, 'utf8');
        const m = /export type PermissionModuleKey\s*=([^;]+);/.exec(src);
        expect(m, 'tipo PermissionModuleKey no front').not.toBeNull();
        const modules = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
        expect(modules).toEqual(allModuleKeys());
    });

    it('isPermissionKey / isAdminOnlyPermission do front concordam com o backend', () => {
        for (const k of allPermissionKeys()) expect(front.isPermissionKey(k), k).toBe(true);
        for (const k of ADMIN_ONLY_KEYS) {
            expect(front.isPermissionKey(k), k).toBe(false);
            expect(front.isAdminOnlyPermission(k), k).toBe(true);
        }
        expect(front.isPermissionKey('agendamentos.inexistente')).toBe(false);
    });

    it('as permissões do Painel do front existem no catálogo', () => {
        const delegable = new Set<string>(allPermissionKeys());
        expect(front.DASHBOARD_PERMISSIONS.filter(k => !delegable.has(k))).toEqual([]);
    });
});

// ─── Nomes do menu × nomes do catálogo (EQ-REQ-03) ──────
// A etapa Permissões da tela Equipe mostra os nomes do catálogo (coluna "Módulo (menu)" do D2); o
// colaborador procura no MENU o nome que o administrador marcou. frontend/src/config/nav.ts importa
// ícones e o React, então é lido como TEXTO.
const NAV_FILE = path.join(ROOT, 'frontend/src/config/nav.ts');

describe('menu da equipe (frontend/src/config/nav.ts) usa os nomes do catálogo', () => {
    const nav = readFileSync(NAV_FILE, 'utf8');

    it('cada subitem de Configurações (settingsSub) tem o rótulo de STAFF_SETTINGS_SECTIONS, na mesma ordem', () => {
        const subs = [...nav.matchAll(/settingsSub\(\s*['"]([a-z_]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g)].map(m => [m[1], m[2]]);
        expect(subs.length, 'a leitura achou os settingsSub do menu').toBeGreaterThan(5);
        expect(subs).toEqual(STAFF_SETTINGS_SECTIONS.map(s => [s.sec, s.label]));
    });

    it('o item de /admin/notificacoes não se chama "Notificações" (é o nome do sino, que todos têm)', () => {
        const m = /to:\s*['"]\/admin\/notificacoes['"]\s*,\s*label:\s*['"]([^'"]+)['"]/.exec(nav);
        expect(m, 'item /admin/notificacoes no menu').not.toBeNull();
        expect(m![1]).not.toBe('Notificações');
    });
});

describe('catálogo servido ao front (GET /api/staff/catalog) fecha com as chaves', () => {
    it('as ações dos módulos são exatamente as chaves delegáveis; adminOnly são as exclusivas', () => {
        const catalog = buildStaffCatalog();
        expect(catalog.modules.map(m => m.key)).toEqual(allModuleKeys());
        expect(catalog.modules.flatMap(m => m.actions.map(a => a.key))).toEqual(allPermissionKeys());
        expect(catalog.adminOnly.map(a => a.key)).toEqual([...ADMIN_ONLY_KEYS]);
    });

    it('perfis modelo e dependências só citam chaves delegáveis', () => {
        const delegable = new Set<string>(allPermissionKeys());
        const catalog = buildStaffCatalog();
        expect(STAFF_PRESETS.flatMap(p => p.permissions).filter(k => !delegable.has(k))).toEqual([]);
        expect(catalog.presets.flatMap(p => p.permissions).filter(k => !delegable.has(k))).toEqual([]);
        const deps = catalog.modules.flatMap(m => m.actions.flatMap(a => a.requires));
        expect(deps.filter(k => !delegable.has(k))).toEqual([]);
    });
});

// ─── Nenhum literal de permissão desconhecido no código ─
// Varre backend/src e frontend/src atrás de literais com cara de chave ('modulo.acao' com um dos módulos
// do catálogo ou das exclusivas). Pega erro de digitação em lugar sem tipo (ex.: um array de strings).
// Literal que não é permissão e por acaso tem esse formato entra em NOT_PERMISSION, com o motivo.

const PREFIXES = [...new Set([...allPermissionKeys(), ...ADMIN_ONLY_KEYS].map(k => k.split('.')[0]))];
const LITERAL = new RegExp(`['"\`]((?:${PREFIXES.join('|')})\\.[a-z_]+)['"\`]`, 'g');
const NOT_PERMISSION: Record<string, string> = {};

function* sourceFiles(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'generated' || name === 'dist') continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) yield* sourceFiles(full);
        else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) yield full;
    }
}

describe('literais de permissão no código', () => {
    for (const area of ['backend/src', 'frontend/src']) {
        it(`${area}: todo literal 'modulo.acao' é uma chave do catálogo ou exclusiva do ADMIN`, () => {
            const valid = new Set<string>([...allPermissionKeys(), ...ADMIN_ONLY_KEYS]);
            const unknown: string[] = [];
            let seen = 0;
            for (const file of sourceFiles(path.join(ROOT, area))) {
                const src = readFileSync(file, 'utf8');
                for (const m of src.matchAll(LITERAL)) {
                    seen++;
                    const key = m[1]!;
                    if (!valid.has(key) && !NOT_PERMISSION[key]) unknown.push(`${path.relative(ROOT, file)}: ${key}`);
                }
            }
            expect(seen, 'a varredura encontrou literais (o filtro não ficou vazio)').toBeGreaterThan(20);
            expect(unknown).toEqual([]);
        });
    }
});
