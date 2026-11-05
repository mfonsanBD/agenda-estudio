import { describe, it, expect, vi, beforeAll } from 'vitest';

// ─── Marcação das guardas (só neste arquivo) ────────────
// As guardas de permissão devolvem funções anônimas (closures), indistinguíveis de qualquer outro
// middleware. Os dublês abaixo chamam a implementação REAL e só penduram uma etiqueta `__eqGuard` na
// função devolvida, para o percurso da pilha do Express saber o que cada camada exige. Nada muda no
// comportamento das rotas. `authorize` (papel pelo JWT) fica marcado como LEGADO: nenhuma rota pode usá-lo.
vi.mock('../../src/middleware/permissions', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/middleware/permissions')>();
    const tag = <T extends object>(fn: T, info: Record<string, unknown>): T => Object.assign(fn, { __eqGuard: info });
    return {
        ...orig,
        requirePermission: (...keys: Parameters<typeof orig.requirePermission>) =>
            tag(orig.requirePermission(...keys), { kind: 'permission', keys }),
        requireAllPermissions: (...keys: Parameters<typeof orig.requireAllPermissions>) =>
            tag(orig.requireAllPermissions(...keys), { kind: 'allPermissions', keys }),
        requireStaff: () => tag(orig.requireStaff(), { kind: 'staff' }),
        requireAdmin: () => tag(orig.requireAdmin(), { kind: 'admin' }),
        requireRole: (...roles: Parameters<typeof orig.requireRole>) => tag(orig.requireRole(...roles), { kind: 'role', roles }),
    };
});
vi.mock('../../src/modules/bookings/permissionGuards', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/modules/bookings/permissionGuards')>();
    return {
        ...orig,
        requirePermissionIfStaff: (...keys: Parameters<typeof orig.requirePermissionIfStaff>) =>
            Object.assign(orig.requirePermissionIfStaff(...keys), { __eqGuard: { kind: 'ifStaff', keys } }),
    };
});
vi.mock('../../src/middleware/auth', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/middleware/auth')>();
    return {
        ...orig,
        authorize: (...roles: Parameters<typeof orig.authorize>) =>
            Object.assign(orig.authorize(...roles), { __eqGuard: { kind: 'legacyAuthorize', roles } }),
    };
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { authenticate } from '../../src/middleware/auth';
import { allPermissionKeys } from '../../src/config/staffPermissions';
import { MATRIX, MATRIX_ALL_OF, MOUNTS, matrixRouteKey } from './eq-authHelpers';

// FRENTE T — invariante da crítica E5 (DECISOES D4): percorre a PILHA DE ROTAS do Express (os mesmos
// routers e prefixos do src/index.ts) e exige, em toda rota que não é pública, `authenticate` + um
// middleware de permissão/papel — ou a presença numa allowlist EXPLÍCITA (pública, do próprio usuário,
// mista com a checagem no handler). Rota nova sem guarda nenhuma quebra este teste; allowlist com rota
// que não existe mais também (não deixa a lista apodrecer).
//
// Também confere:
//  • nenhuma rota usa o `authorize` legado (papel pelo JWT — a equipe tem o papel lido do banco);
//  • `authenticate` vem ANTES da guarda (sem req.user a guarda responde 401 — fecha, mas fora de ordem);
//  • routers 100% administrativos têm a guarda no `router.use` (crítica E4) e cada rota deles ainda tem a
//    permissão fina (só `requireStaff` não basta: qualquer colaborador passaria);
//  • as chaves usadas nas guardas existem no catálogo (ou são 'ADMIN');
//  • a matriz de permissões (eq-authHelpers.MATRIX, executada em eq-permissions-matrix.test.ts, mais a
//    MATRIX_ALL_OF das rotas com duas chaves obrigatórias, executada em eq-x3-renew-avisos.test.ts) cobre
//    TODA rota guardada ou mista, e a chave declarada em cada linha bate com a guarda real da rota.

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ─── Allowlists (cada entrada com o motivo) ─────────────

/** Rotas PÚBLICAS (sem login): autenticação, webhooks com assinatura, leituras públicas. */
const PUBLIC_ROUTES: Record<string, string> = {
    'GET /api/health': 'health check',
    'POST /api/auth/register/send-code': 'cadastro público (código por e-mail)',
    'POST /api/auth/register': 'cadastro público (sempre CLIENTE)',
    'POST /api/auth/login': 'login',
    'POST /api/auth/login/send-code': 'login por código',
    'POST /api/auth/login/verify-code': 'login por código',
    'POST /api/auth/google': 'login Google',
    'POST /api/auth/refresh': 'refresh token (cookie próprio)',
    'POST /api/auth/logout': 'logout',
    'GET /api/bookings/public-availability': 'disponibilidade pública (landing)',
    'GET /api/pricing': 'tabela de preços pública',
    'GET /api/pricing/addons': 'serviços ativos (público)',
    'GET /api/pricing/payment-methods': 'formas de pagamento ativas (público)',
    'GET /api/pricing/business-config/public': 'configurações públicas do site',
    'GET /api/ambient/weather': 'clima da landing',
    'GET /api/push/vapid-key': 'chave pública do Web Push',
    'POST /api/webhooks/cora': 'webhook do provedor (assinatura verificada no handler)',
    'POST /api/webhooks/sicoob/pix': 'webhook do provedor (assinatura verificada no handler)',
    'POST /api/webhooks/sicoob': 'webhook do provedor (assinatura verificada no handler)',
    'POST /api/webhooks/stripe': 'webhook do provedor (assinatura verificada no handler)',
};

/** Logado, mas só os DADOS DO PRÓPRIO USUÁRIO (filtro por req.user.userId no handler): sem permissão de equipe. */
const OWN_ROUTES: Record<string, string> = {
    'GET /api/auth/me': 'o próprio usuário',
    'PATCH /api/auth/profile': 'o próprio perfil',
    'POST /api/auth/profile/photo': 'a própria foto',
    'GET /api/bookings/availability': 'disponibilidade para quem agenda',
    'POST /api/bookings/:id/complete-payment': 'gravação do próprio cliente',
    'PATCH /api/bookings/:id/confirm': 'gravação do próprio cliente',
    'PUT /api/bookings/:id/client-cancel': 'gravação do próprio cliente',
    'GET /api/bookings/my': 'gravações do próprio cliente',
    'GET /api/bookings/my/results': 'resultados do próprio cliente',
    'GET /api/bookings/:id': 'gravação do próprio cliente (findFirst por userId)',
    'PATCH /api/bookings/:id/client-update': 'gravação do próprio cliente',
    'POST /api/bookings/:id/cover-image': 'gravação do próprio cliente',
    'PATCH /api/bookings/:id/reschedule': 'gravação do próprio cliente',
    'POST /api/bookings/:id/addons': 'gravação do próprio cliente',
    'GET /api/contracts/slot-options': 'cálculo de horários (sem dados de terceiros)',
    'POST /api/contracts/check-fixo': 'checagem de grade (sem dados de terceiros)',
    'GET /api/contracts/my': 'contratos do próprio cliente',
    'POST /api/contracts/:id/request-cancellation': 'contrato do próprio cliente',
    'POST /api/contracts/:id/pay': 'contrato do próprio cliente',
    'POST /api/contracts/:id/confirm-payment': 'contrato do próprio cliente',
    'POST /api/contracts/:id/subscribe': 'contrato do próprio cliente',
    'POST /api/contracts/:id/client-renew': 'contrato do próprio cliente',
    'GET /api/notifications': 'sino do próprio usuário (equipe: alertas pelo ator do banco)',
    'PATCH /api/notifications/read-all': 'sino do próprio usuário',
    'PATCH /api/notifications/:id/read': 'aviso do próprio usuário',
    'DELETE /api/notifications/:id': 'aviso do próprio usuário',
    'GET /api/payments/sandbox-mode': 'flag de ambiente (sem dados)',
    'POST /api/pricing/checkout-quote': 'cálculo de checkout (sem dados de terceiros)',
    'POST /api/push/subscribe': 'inscrição do próprio aparelho',
    'DELETE /api/push/unsubscribe': 'inscrição do próprio aparelho',
    'POST /api/push/test': 'push de teste para si',
    'GET /api/stripe/publishable-key': 'chave pública do Stripe',
    'GET /api/stripe/payment-methods': 'cartões do próprio usuário',
    'POST /api/stripe/setup-intent/confirm': 'cartão do próprio usuário',
    'DELETE /api/stripe/payment-methods/:pmId': 'cartão do próprio usuário',
    'PUT /api/stripe/payment-methods/:pmId/default': 'cartão do próprio usuário',
    'GET /api/stripe/auto-charge': 'preferência do próprio usuário',
};

/** Rotas MISTAS cuja checagem de equipe está NO HANDLER (só `authenticate` na pilha). A matriz as executa. */
const MIXED_HANDLER_ROUTES: Record<string, string> = {
    'POST /api/stripe/create-payment': 'equipe: cobrancas.cobrar (+ cartao_salvo com cartão salvo)',
    'POST /api/stripe/installment-plans': 'com paymentId, equipe: cobrancas.cobrar (prévia sem paymentId é livre)',
    'POST /api/stripe/verify-payment': 'equipe: cobrancas.cobrar',
    'GET /api/payments/:id/status': 'equipe: cobrancas.cobrar | financeiro.ver | cobrancas.baixa',
    'POST /api/payments/:id/simulate': 'equipe: cobrancas.cobrar (só sandbox)',
    'POST /api/coupons/validate': 'equipe com userId alvo: agendamentos.criar | contratos.criar | cobrancas.cobrar',
};

/** Rotas cuja ÚNICA guarda é `requireStaff` + regra do corpo no handler (lib/permissionRules). */
const STAFF_BODY_RULE_ROUTES: Record<string, string> = {
    'PUT /api/pricing/business-config': 'requiredForBusinessConfig (tudo ou nada por grupo)',
    'PATCH /api/users/:id': 'requiredForUserPatch (por valor alterado)',
};

/** Prefixos de routers 100% administrativos: a guarda tem de vir no router.use (E4). */
const ADMIN_ONLY_ROUTER_PREFIXES: Record<string, 'staff' | 'admin'> = {
    '/api/blocked-slots': 'staff',
    '/api/finance': 'staff',
    '/api/reports': 'staff',
    '/api/integrations': 'staff',
    '/api/notifications/admin': 'staff',
    '/api/staff': 'admin',
};

// ─── Percurso da pilha ──────────────────────────────────

type GuardKind = 'authenticate' | 'permission' | 'allPermissions' | 'staff' | 'admin' | 'role' | 'ifStaff' | 'legacyAuthorize';
interface Guard { kind: GuardKind; keys?: string[]; roles?: string[]; inherited: boolean }
interface RouteInfo { method: string; path: string; key: string; guards: Guard[] }

function classify(handle: unknown, inherited: boolean): Guard | null {
    if (handle === authenticate) return { kind: 'authenticate', inherited };
    const info = (handle as { __eqGuard?: { kind: GuardKind; keys?: string[]; roles?: string[] } } | null)?.__eqGuard;
    return info ? { ...info, inherited } : null;
}

/** Caminho de montagem de uma camada `use` (Express 4 / path-to-regexp 0.1): só caminhos estáticos. */
function mountPathOf(layer: { regexp: RegExp & { fast_slash?: boolean } }): string {
    if (layer.regexp.fast_slash) return '';
    const src = layer.regexp.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '');
    if (/[()[\]*+?|{}^$]/.test(src.replace(/\\./g, ''))) throw new Error(`camada montada num caminho dinâmico (${layer.regexp}): o percurso não sabe classificar`);
    return src.replace(/\\(.)/g, '$1');
}

const join = (a: string, b: string) => {
    const out = `${a}/${b}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
    return out === '' ? '/' : out;
};

interface ScopedGuard { scope: string; guard: Guard }

function walk(router: { stack: any[] }, prefix: string, inherited: ScopedGuard[], out: RouteInfo[]): void {
    const acc = [...inherited];
    for (const layer of router.stack) {
        if (layer.route) {
            const routePath = layer.route.path;
            if (typeof routePath !== 'string') throw new Error(`rota com caminho não textual em ${prefix}: ${String(routePath)}`);
            const full = join(prefix, routePath);
            const methods = Object.keys(layer.route.methods).filter(m => layer.route.methods[m]);
            for (const m of methods) {
                const own = (layer.route.stack as any[])
                    .filter(l => !l.method || l.method === m)
                    .map(l => classify(l.handle, false))
                    .filter((g): g is Guard => !!g);
                const fromUse = acc.filter(s => full === s.scope || full.startsWith(s.scope === '/' ? '/' : `${s.scope}/`)).map(s => s.guard);
                const method = m === '_all' ? 'ALL' : m.toUpperCase();
                out.push({ method, path: full, key: `${method} ${full}`, guards: [...fromUse, ...own] });
            }
            continue;
        }
        const mount = join(prefix, mountPathOf(layer));
        if (layer.handle && Array.isArray(layer.handle.stack)) {
            walk(layer.handle, mount, acc, out); // sub-router: herda as guardas acumuladas até aqui
            continue;
        }
        const g = classify(layer.handle, true);
        if (g) acc.push({ scope: mount, guard: g });
    }
}

interface IndexMount { path: string; module: string; ident: string }

/** Lê o src/index.ts: imports dos routers e `app.use('/api/...', router)`; rotas declaradas direto no app. */
function parseIndex(): { mounts: IndexMount[]; appRoutes: string[] } {
    const src = readFileSync(path.join(BACKEND, 'src/index.ts'), 'utf8');
    const imports = new Map<string, string>();
    for (const m of src.matchAll(/^import\s+(\w+)\s+from\s+'(\.\/modules\/[^']+)';/gm)) imports.set(m[1]!, m[2]!);
    for (const m of src.matchAll(/^import\s+\{\s*(\w+)\s*\}\s+from\s+'(\.\/modules\/[^']+)';/gm)) imports.set(m[1]!, m[2]!);
    const mounts: IndexMount[] = [];
    for (const m of src.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)) {
        const mod = imports.get(m[2]!);
        if (mod) mounts.push({ path: m[1]!, module: mod, ident: m[2]! });
    }
    const appRoutes = [...src.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)].map(m => `${m[1]!.toUpperCase()} ${m[2]!}`);
    return { mounts, appRoutes };
}

let ROUTES: RouteInfo[] = [];
let INDEX: ReturnType<typeof parseIndex>;

beforeAll(async () => {
    INDEX = parseIndex();
    const out: RouteInfo[] = [];
    for (const mnt of INDEX.mounts) {
        const file = path.join(BACKEND, 'src', mnt.module.replace(/^\.\//, '').replace(/\.js$/, '.ts'));
        const mod = await import(pathToFileURL(file).href);
        const router = mod[mnt.ident] ?? mod.default;
        if (!router || !Array.isArray(router.stack)) throw new Error(`${mnt.module} não exporta um Router (${mnt.ident})`);
        walk(router, mnt.path, [], out);
    }
    for (const r of INDEX.appRoutes) {
        const [method, p] = r.split(' ');
        if (p === '*') continue; // fallback do SPA em produção (frontend/dist)
        out.push({ method: method!, path: p!, key: r, guards: [] });
    }
    ROUTES = out;
    if (process.env.EQ_DUMP_ROUTES) {
        // eslint-disable-next-line no-console
        console.log(ROUTES.map(r => `${r.key.padEnd(58)} ${r.guards.map(g => `${g.inherited ? '^' : ''}${g.kind}${g.keys ? `(${g.keys.join('|')})` : ''}${g.roles ? `(${g.roles.join('|')})` : ''}`).join(' ')}`).join('\n'));
    }
});

const PERMISSION_KINDS: GuardKind[] = ['permission', 'allPermissions', 'admin', 'role', 'ifStaff'];
const hasAuth = (r: RouteInfo) => r.guards.some(g => g.kind === 'authenticate');
const fineGuards = (r: RouteInfo) => r.guards.filter(g => PERMISSION_KINDS.includes(g.kind));
const hasAnyGuard = (r: RouteInfo) => r.guards.some(g => g.kind !== 'authenticate' && g.kind !== 'legacyAuthorize');

/** A regra E5 em si: lista o que está errado (vazia = tudo guardado ou na allowlist). */
function guardProblems(routes: readonly RouteInfo[]): string[] {
    const problems: string[] = [];
    for (const r of routes) {
        if (r.guards.some(g => g.kind === 'legacyAuthorize')) problems.push(`${r.key}: usa o authorize legado (papel pelo JWT)`);
        if (PUBLIC_ROUTES[r.key]) continue;
        if (!hasAuth(r)) { problems.push(`${r.key}: sem authenticate (e fora da allowlist pública)`); continue; }
        if (OWN_ROUTES[r.key] || MIXED_HANDLER_ROUTES[r.key]) continue;
        if (!hasAnyGuard(r)) { problems.push(`${r.key}: só authenticate, sem guarda de permissão/papel (nem allowlist)`); continue; }
        if (fineGuards(r).length === 0 && !STAFF_BODY_RULE_ROUTES[r.key]) {
            problems.push(`${r.key}: só requireStaff — qualquer colaborador passa (falta a permissão fina ou a allowlist de regra no handler)`);
        }
    }
    return problems;
}

describe('o percurso da pilha enxerga as falhas (autoteste com routers sintéticos)', () => {
    it('rota sem authenticate, só com authenticate, só com requireStaff ou com authorize legado é apontada; a guardada não', async () => {
        const { Router } = await import('express');
        const perms = await import('../../src/middleware/permissions');
        const auth = await import('../../src/middleware/auth');
        const noop = (_req: unknown, res: { json: (b: unknown) => void }) => res.json({});
        const admin = Router();
        admin.use(auth.authenticate, perms.requireStaff());
        admin.get('/fina', perms.requirePermission('cupons.ver'), noop);
        admin.get('/so-staff', noop);
        const root = Router();
        root.get('/aberta', noop);
        root.get('/so-login', auth.authenticate, noop);
        root.get('/legado', auth.authenticate, auth.authorize('ADMIN'), noop);
        root.get('/mista', auth.authenticate, perms.requireRole('CLIENTE'), noop);
        root.use('/adm', admin);
        const out: RouteInfo[] = [];
        walk(root as unknown as { stack: any[] }, '/api/sintetico', [], out);
        const byKey = Object.fromEntries(out.map(r => [r.key, r]));
        expect(byKey['GET /api/sintetico/adm/fina']!.guards.map(g => `${g.inherited ? '^' : ''}${g.kind}`)).toEqual(['^authenticate', '^staff', 'permission']);
        expect(guardProblems(out).map(p => p.split(':')[0])).toEqual([
            'GET /api/sintetico/aberta',
            'GET /api/sintetico/so-login',
            'GET /api/sintetico/legado',
            'GET /api/sintetico/legado',
            'GET /api/sintetico/adm/so-staff',
        ]);
    });
});

describe('E5 — pilha de rotas do Express: nenhuma rota não pública sem guarda', () => {
    it('o percurso encontra as rotas de todos os routers montados no index.ts', () => {
        expect(INDEX.mounts.length).toBeGreaterThanOrEqual(17);
        expect(ROUTES.length).toBeGreaterThan(150);
        const prefixes = new Set(INDEX.mounts.map(m => m.path));
        for (const p of ['/api/auth', '/api/bookings', '/api/contracts', '/api/users', '/api/staff', '/api/pricing', '/api/stripe']) {
            expect(prefixes.has(p), `${p} montado no index.ts`).toBe(true);
        }
        // Rotas não podem se repetir (mesmo método + caminho declarado duas vezes = a 2ª nunca roda).
        const seen = new Map<string, number>();
        for (const r of ROUTES) seen.set(r.key, (seen.get(r.key) ?? 0) + 1);
        expect([...seen].filter(([, n]) => n > 1).map(([k]) => k)).toEqual([]);
    });

    it('nenhuma rota usa o `authorize` legado (papel pelo JWT)', () => {
        const legacy = ROUTES.filter(r => r.guards.some(g => g.kind === 'legacyAuthorize')).map(r => r.key);
        expect(legacy).toEqual([]);
    });

    it('toda rota fora da allowlist pública tem authenticate + guarda de permissão/papel (ou está numa allowlist explícita)', () => {
        expect(guardProblems(ROUTES)).toEqual([]);
    });

    it('authenticate vem antes de qualquer guarda de permissão/papel', () => {
        const bad: string[] = [];
        for (const r of ROUTES) {
            const iAuth = r.guards.findIndex(g => g.kind === 'authenticate');
            const iGuard = r.guards.findIndex(g => g.kind !== 'authenticate' && g.kind !== 'legacyAuthorize');
            if (iGuard >= 0 && (iAuth < 0 || iAuth > iGuard)) bad.push(r.key);
        }
        expect(bad).toEqual([]);
    });

    it('as allowlists só citam rotas que existem (lista sem entrada podre) e não se sobrepõem', () => {
        const keys = new Set(ROUTES.map(r => r.key));
        const lists = { PUBLIC_ROUTES, OWN_ROUTES, MIXED_HANDLER_ROUTES, STAFF_BODY_RULE_ROUTES };
        const stale = Object.entries(lists).flatMap(([name, l]) => Object.keys(l).filter(k => !keys.has(k)).map(k => `${name}: ${k}`));
        expect(stale).toEqual([]);
        const all = Object.values(lists).flatMap(l => Object.keys(l));
        expect(all.filter((k, i) => all.indexOf(k) !== i)).toEqual([]);
    });

    it('rotas da allowlist "própria" e "mista" não carregam guarda de equipe esquecida (classificação honesta)', () => {
        const misfiled = ROUTES.filter(r => (OWN_ROUTES[r.key] || MIXED_HANDLER_ROUTES[r.key]) && hasAnyGuard(r)).map(r => r.key);
        expect(misfiled).toEqual([]);
    });

    it('E4: routers 100% administrativos têm authenticate + guarda de equipe no router.use, e permissão fina por rota', () => {
        const problems: string[] = [];
        for (const [prefix, level] of Object.entries(ADMIN_ONLY_ROUTER_PREFIXES)) {
            const routes = ROUTES.filter(r => r.path === prefix || r.path.startsWith(`${prefix}/`));
            if (routes.length === 0) problems.push(`${prefix}: nenhuma rota encontrada`);
            for (const r of routes) {
                const inherited = r.guards.filter(g => g.inherited);
                if (!inherited.some(g => g.kind === 'authenticate')) problems.push(`${r.key}: sem authenticate no router.use`);
                if (!inherited.some(g => g.kind === level || (level === 'staff' && g.kind === 'admin'))) problems.push(`${r.key}: sem require${level === 'admin' ? 'Admin' : 'Staff'} no router.use`);
                if (level === 'staff' && fineGuards(r).length === 0) problems.push(`${r.key}: só a guarda do router (falta a permissão fina da rota)`);
            }
        }
        // Cupons (admin) é um sub-router de /api/coupons: tudo que não é o /validate herda a guarda de equipe.
        for (const r of ROUTES.filter(x => x.path.startsWith('/api/coupons') && x.key !== 'POST /api/coupons/validate')) {
            if (!r.guards.some(g => g.inherited && g.kind === 'staff')) problems.push(`${r.key}: cupons (admin) sem requireStaff no router.use`);
            if (fineGuards(r).length === 0) problems.push(`${r.key}: cupons (admin) sem permissão fina`);
        }
        expect(problems).toEqual([]);
    });

    it('/api/staff e integrações são só do ADMIN (requireAdmin, papel do banco)', () => {
        const notAdmin = ROUTES
            .filter(r => r.path.startsWith('/api/staff') || r.path.startsWith('/api/integrations'))
            .filter(r => !r.guards.some(g => g.kind === 'admin'))
            .map(r => r.key);
        expect(notAdmin).toEqual([]);
    });

    it('as chaves das guardas existem no catálogo (ou são ADMIN) e os papéis são válidos', () => {
        const valid = new Set<string>([...allPermissionKeys(), 'ADMIN']);
        const bad: string[] = [];
        for (const r of ROUTES) {
            for (const g of r.guards) {
                for (const k of g.keys ?? []) if (!valid.has(k)) bad.push(`${r.key}: chave desconhecida ${k}`);
                for (const role of g.roles ?? []) if (!['ADMIN', 'COLABORADOR', 'CLIENTE'].includes(role)) bad.push(`${r.key}: papel ${role}`);
            }
        }
        expect(bad).toEqual([]);
    });

    it('autoatendimento (requireRole) é só do CLIENTE (crítica S5: sem exceção para o ADMIN)', () => {
        const roleRoutes = ROUTES.filter(r => r.guards.some(g => g.kind === 'role'));
        expect(roleRoutes.map(r => r.key).sort()).toEqual([
            'POST /api/bookings',
            'POST /api/bookings/bulk',
            'POST /api/contracts/self',
            'POST /api/contracts/service',
            'POST /api/stripe/setup-intent',
            'PUT /api/stripe/auto-charge',
        ].sort());
        for (const r of roleRoutes) {
            for (const g of r.guards.filter(x => x.kind === 'role')) expect(g.roles, r.key).toEqual(['CLIENTE']);
        }
    });
});

describe('Matriz × pilha real — a tabela da verdade cobre toda rota guardada e bate com a guarda', () => {
    it('o app da matriz monta exatamente os mesmos routers e prefixos do src/index.ts', () => {
        const fromIndex = INDEX.mounts.map(m => `${m.path} ← ${m.module}`).sort();
        const fromMatrix = MOUNTS.map(m => `${m.path} ← ${m.module}`).sort();
        expect(fromMatrix).toEqual(fromIndex);
    });

    it('toda linha da matriz aponta para uma rota que existe', () => {
        const keys = new Set(ROUTES.map(r => r.key));
        expect([...MATRIX, ...MATRIX_ALL_OF].map(matrixRouteKey).filter(k => !keys.has(k))).toEqual([]);
    });

    it('toda rota com guarda de permissão/papel, regra no handler ou checagem mista tem ao menos uma linha na matriz', () => {
        const covered = new Set([...MATRIX, ...MATRIX_ALL_OF].map(matrixRouteKey));
        const needRow = ROUTES.filter(r =>
            !PUBLIC_ROUTES[r.key] && !OWN_ROUTES[r.key] && (hasAnyGuard(r) || MIXED_HANDLER_ROUTES[r.key]));
        expect(needRow.map(r => r.key).filter(k => !covered.has(k))).toEqual([]);
    });

    it('a chave declarada em cada linha simples é exatamente a guarda da rota (ADMIN → requireAdmin; CLIENTE → requireRole)', () => {
        const byKey = new Map(ROUTES.map(r => [r.key, r]));
        const bad: string[] = [];
        for (const row of MATRIX) {
            const r = byKey.get(matrixRouteKey(row));
            if (!r || row.bodyRule || MIXED_HANDLER_ROUTES[r.key]) continue;
            if (row.need === 'ADMIN') {
                if (!r.guards.some(g => g.kind === 'admin')) bad.push(`${r.key}: matriz diz ADMIN, rota sem requireAdmin`);
                continue;
            }
            if (row.need === 'CLIENTE') {
                if (!r.guards.some(g => g.kind === 'role' && g.roles?.join() === 'CLIENTE')) bad.push(`${r.key}: matriz diz CLIENTE, rota sem requireRole('CLIENTE')`);
                continue;
            }
            const routeKeys = new Set(r.guards.filter(g => g.kind === 'permission' || g.kind === 'ifStaff').flatMap(g => g.keys ?? []));
            const declared = new Set<string>(row.need);
            const same = routeKeys.size === declared.size && [...declared].every(k => routeKeys.has(k));
            if (!same) bad.push(`${r.key}: matriz [${[...declared].join('|')}] × guarda [${[...routeKeys].join('|')}]`);
            const mixedGuard = r.guards.some(g => g.kind === 'ifStaff');
            if (!!row.mixed !== mixedGuard) bad.push(`${r.key}: matriz mixed=${!!row.mixed} × guarda ${mixedGuard ? 'requirePermissionIfStaff' : 'requirePermission'}`);
        }
        expect(bad).toEqual([]);
    });

    it('duas chaves obrigatórias: toda rota com requireAllPermissions tem linha na MATRIX_ALL_OF com exatamente as mesmas chaves', () => {
        const byKey = new Map(ROUTES.map(r => [r.key, r]));
        const bad: string[] = [];
        const allOfRoutes = ROUTES.filter(r => r.guards.some(g => g.kind === 'allPermissions'));
        const declared = new Set(MATRIX_ALL_OF.map(matrixRouteKey));
        for (const r of allOfRoutes) if (!declared.has(r.key)) bad.push(`${r.key}: requireAllPermissions sem linha na MATRIX_ALL_OF`);
        for (const row of MATRIX_ALL_OF) {
            const r = byKey.get(matrixRouteKey(row));
            if (!r) continue; // "toda linha aponta para uma rota que existe" já acusa
            const guards = r.guards.filter(g => g.kind === 'allPermissions');
            const keys = new Set(guards.flatMap(g => g.keys ?? []));
            const want = new Set<string>(row.needAll);
            if (row.needAll.length < 2) bad.push(`${r.key}: MATRIX_ALL_OF é para duas ou mais chaves (use a MATRIX)`);
            if (guards.length === 0) bad.push(`${r.key}: MATRIX_ALL_OF diz [${row.needAll.join('+')}], rota sem requireAllPermissions`);
            else if (keys.size !== want.size || [...want].some(k => !keys.has(k))) bad.push(`${r.key}: MATRIX_ALL_OF [${row.needAll.join('+')}] × guarda [${[...keys].join('+')}]`);
            // Uma guarda "qualquer uma" na mesma rota mudaria a semântica da linha: não mistura.
            if (r.guards.some(g => g.kind === 'permission' || g.kind === 'ifStaff')) bad.push(`${r.key}: requireAllPermissions junto de requirePermission (a tabela não representa a mistura)`);
        }
        expect(bad).toEqual([]);
        // Hoje: a renovação (cria o plano sem parcelas → também a baixa manual).
        expect(MATRIX_ALL_OF.map(matrixRouteKey)).toContain('POST /api/contracts/:id/renew');
    });
});
