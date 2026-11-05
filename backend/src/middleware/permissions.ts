// ─── Permissões da EQUIPE (ADMIN / COLABORADOR) ─────────
// Quem é da equipe tem o papel e as permissões lidos do BANCO a cada requisição (1 consulta por chave
// primária, memo em `req.actor`): mudar permissões, rebaixar ou desativar vale NA HORA, mesmo com o
// Redis fora do ar (a revogação de sessão é fail-open). Cliente continua sem consultar o banco: o JWT
// diz CLIENTE → nenhuma permissão.
//
//   • ADMIN: acesso total (todas as chaves + as exclusivas) — SEM join em staff_profiles (crítica M1:
//     se a migration da tabela falhar, o ADMIN continua entrando);
//   • COLABORADOR: role/situação de `users` + `staff_profiles.permissions` (sanitizadas);
//   • conta BLOCKED ou excluída (ou que não existe mais) → 401 ACCOUNT_DISABLED;
//   • falha do banco → 503 (FALHA FECHADA — o contrário da revogação).
//
// Express 4 não captura rejeições de handlers async: todo middleware daqui faz try/catch e RESPONDE,
// nunca lança. Nos handlers use `const actor = await actorOrReply(req, res); if (!actor) return;`.
// `authorize` (middleware/auth.ts, papel pelo JWT) continua exportado para as rotas ainda não convertidas.

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { prisma } from '../lib/prisma.js';
import {
    ADMIN_REQUIREMENT,
    isPermissionKey,
    permissionsForRole,
    sanitizeStoredPermissions,
    type AdminOnlyKey,
    type PermissionKey,
    type RequirementKey,
} from '../config/staffPermissions.js';
import type { RejectedField, Requirement, RuleResult } from '../lib/permissionRules.js';

export type ActorRole = 'ADMIN' | 'COLABORADOR' | 'CLIENTE';

export interface Actor {
    userId: string;
    /** Papel EFETIVO: do banco para a equipe; do JWT para cliente. */
    role: ActorRole;
    isAdmin: boolean;
    /** ADMIN ou COLABORADOR (área administrativa). */
    isStaff: boolean;
    /** Chaves efetivas: ADMIN = todas (catálogo + exclusivas); COLABORADOR = as dele; CLIENTE = vazio. */
    permissions: ReadonlySet<PermissionKey | AdminOnlyKey>;
}

declare global {
    namespace Express {
        interface Request {
            /** Memo do getActor (uma consulta por requisição). */
            actor?: Actor;
        }
    }
}

/** 403 padrão (D4). `permission` = a chave que faltou, 'ADMIN' (só o administrador), 'STAFF' ou o(s) papel(éis) exigido(s). */
export const PERMISSION_DENIED_MESSAGE = 'Você não tem permissão para esta ação.';
/** 401 de conta desativada/excluída (D4). O front faz logout com esta mensagem. */
export const ACCOUNT_DISABLED_BODY = Object.freeze({
    code: 'ACCOUNT_DISABLED',
    error: 'Seu acesso foi desativado. Fale com o administrador.',
});
/** 503 quando não dá para ler as permissões (falha fechada). */
export const PERMISSIONS_UNAVAILABLE_BODY = Object.freeze({
    code: 'PERMISSIONS_UNAVAILABLE',
    error: 'Não foi possível verificar suas permissões agora. Tente novamente em instantes.',
});
const AUTH_REQUIRED_BODY = Object.freeze({ error: 'Autenticação necessária.' });

/** Falha ao resolver o ator: o handler responde `status` com `body`. */
export class ActorError extends Error {
    constructor(public readonly status: 401 | 503, public readonly body: Readonly<Record<string, unknown>>) {
        super(String(body.error ?? 'actor error'));
        this.name = 'ActorError';
    }
}

function makeActor(userId: string, role: ActorRole, storedPermissions: readonly unknown[] | null): Actor {
    return {
        userId,
        role,
        isAdmin: role === 'ADMIN',
        isStaff: role === 'ADMIN' || role === 'COLABORADOR',
        permissions: new Set(permissionsForRole(role, storedPermissions)),
    };
}

/**
 * Resolve quem está agindo (memo em `req.actor`). Exige `authenticate` antes (req.user).
 * Lança ActorError (401 sem login / ACCOUNT_DISABLED; 503 se o banco falhar). Prefira `actorOrReply`
 * nos handlers e os middlewares `require*` nas rotas.
 */
export async function getActor(req: Request): Promise<Actor> {
    const jwtUser = req.user;
    if (!jwtUser) throw new ActorError(401, AUTH_REQUIRED_BODY);
    if (req.actor && req.actor.userId === jwtUser.userId) return req.actor;

    // Cliente: zero consulta (o JWT basta — rota de equipe recusa com 403).
    if (jwtUser.role !== 'ADMIN' && jwtUser.role !== 'COLABORADOR') {
        req.actor = makeActor(jwtUser.userId, 'CLIENTE', null);
        return req.actor;
    }

    let row: { role: string; clientStatus: string; deletedAt: Date | null } | null;
    try {
        row = await prisma.user.findUnique({
            where: { id: jwtUser.userId },
            select: { role: true, clientStatus: true, deletedAt: true },
        });
    } catch (err) {
        console.error('[PERMISSIONS] Falha ao ler o usuário da equipe:', err instanceof Error ? err.message : err);
        throw new ActorError(503, PERMISSIONS_UNAVAILABLE_BODY);
    }
    if (!row || row.deletedAt || row.clientStatus === 'BLOCKED') throw new ActorError(401, ACCOUNT_DISABLED_BODY);

    if (row.role === 'ADMIN') {
        req.actor = makeActor(jwtUser.userId, 'ADMIN', null); // sem join (M1)
        return req.actor;
    }
    if (row.role !== 'COLABORADOR') {
        // Rebaixado a cliente (não existe pela tela Equipe, mas o banco é a fonte): sem permissão de equipe.
        req.actor = makeActor(jwtUser.userId, 'CLIENTE', null);
        return req.actor;
    }

    let stored: readonly unknown[] = [];
    try {
        const profile = await prisma.staffProfile.findUnique({
            where: { userId: jwtUser.userId },
            select: { permissions: true },
        });
        stored = profile?.permissions ?? [];
    } catch (err) {
        console.error('[PERMISSIONS] Falha ao ler as permissões do colaborador:', err instanceof Error ? err.message : err);
        throw new ActorError(503, PERMISSIONS_UNAVAILABLE_BODY);
    }
    req.actor = makeActor(jwtUser.userId, 'COLABORADOR', sanitizeStoredPermissions(stored));
    return req.actor;
}

/** Responde o erro do ator (401/503) — ou 503 para falha inesperada. */
function replyActorError(res: Response, err: unknown): void {
    if (res.headersSent) return;
    if (err instanceof ActorError) { res.status(err.status).json(err.body); return; }
    console.error('[PERMISSIONS] Erro inesperado ao verificar permissões:', err instanceof Error ? err.message : err);
    res.status(503).json(PERMISSIONS_UNAVAILABLE_BODY);
}

/**
 * Para handlers: resolve o ator ou JÁ RESPONDE (401/503) e devolve null.
 *   const actor = await actorOrReply(req, res); if (!actor) return;
 */
export async function actorOrReply(req: Request, res: Response): Promise<Actor | null> {
    try {
        return await getActor(req);
    } catch (err) {
        replyActorError(res, err);
        return null;
    }
}

/** O ator tem a chave? ADMIN: sempre. COLABORADOR: se estiver na lista (nunca 'ADMIN' nem exclusivas). CLIENTE: nunca. */
export function can(actor: Actor, key: RequirementKey): boolean {
    if (actor.isAdmin) return true;
    if (actor.role !== 'COLABORADOR') return false;
    return isPermissionKey(key) && actor.permissions.has(key);
}

/** Tem QUALQUER uma das chaves? (lista vazia → false). */
export function canAny(actor: Actor, ...keys: RequirementKey[]): boolean {
    return keys.some(k => can(actor, k));
}

/** Primeira chave do primeiro requisito não atendido (para o 403), ou null se todos passam. */
export function missingRequirement(actor: Actor, requirements: readonly Requirement[]): RequirementKey | null {
    for (const r of requirements) {
        if (!r.anyOf.some(k => can(actor, k))) return r.anyOf[0] ?? ADMIN_REQUIREMENT;
    }
    return null;
}

/** 403 padronizado: `{ error, code: 'PERMISSION_DENIED', permission }`. */
export function denyPermission(res: Response, permission: string): void {
    if (res.headersSent) return;
    res.status(403).json({ error: PERMISSION_DENIED_MESSAGE, code: 'PERMISSION_DENIED', permission });
}

/**
 * Aplica o resultado de uma regra de lib/permissionRules.ts no handler. Responde e devolve false
 * quando não pode seguir: 401/503 (ator), 400 (campo recusado para todos), 403 (falta permissão).
 *   if (!(await enforceRuleResult(req, res, requiredForContractPatch(data, contract)))) return;
 */
export async function enforceRuleResult(req: Request, res: Response, result: RuleResult): Promise<boolean> {
    const rejected: RejectedField | undefined = result.rejected[0];
    if (rejected) {
        if (!res.headersSent) res.status(400).json({ error: rejected.error, code: rejected.code, field: rejected.field });
        return false;
    }
    const actor = await actorOrReply(req, res);
    if (!actor) return false;
    const missing = missingRequirement(actor, result.requirements);
    if (missing) { denyPermission(res, missing); return false; }
    return true;
}

/** Monta um middleware que resolve o ator e decide; nunca lança (Express 4). */
function guard(decide: (actor: Actor, req: Request, res: Response) => boolean): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        let actor: Actor;
        try {
            actor = await getActor(req);
        } catch (err) {
            replyActorError(res, err);
            return;
        }
        let ok = false;
        try {
            ok = decide(actor, req, res);
        } catch (err) {
            replyActorError(res, err);
            return;
        }
        if (ok) next();
    };
}

/** Passa com QUALQUER uma das chaves (ADMIN passa sempre). Sem nenhuma → 403 com a primeira. */
export function requirePermission(...anyOf: RequirementKey[]): RequestHandler {
    if (anyOf.length === 0) throw new Error('requirePermission: informe ao menos uma chave.');
    return guard((actor, _req, res) => {
        if (canAny(actor, ...anyOf)) return true;
        denyPermission(res, anyOf[0]);
        return false;
    });
}

/** Passa só com TODAS as chaves (ADMIN passa sempre). 403 com a primeira que faltar. */
export function requireAllPermissions(...keys: RequirementKey[]): RequestHandler {
    if (keys.length === 0) throw new Error('requireAllPermissions: informe ao menos uma chave.');
    return guard((actor, _req, res) => {
        const missing = keys.find(k => !can(actor, k));
        if (!missing) return true;
        denyPermission(res, missing);
        return false;
    });
}

/** ADMIN ou COLABORADOR (papel do banco). Para routers 100% administrativos e rotas multiuso (a checagem fina vem no handler). */
export function requireStaff(): RequestHandler {
    return guard((actor, _req, res) => {
        if (actor.isStaff) return true;
        denyPermission(res, 'STAFF');
        return false;
    });
}

/** Só ADMIN — papel conferido no BANCO (fecha a janela de 1h de um admin rebaixado com JWT antigo). */
export function requireAdmin(): RequestHandler {
    return guard((actor, _req, res) => {
        if (actor.isAdmin) return true;
        denyPermission(res, ADMIN_REQUIREMENT);
        return false;
    });
}

/**
 * Só os papéis listados. CLIENTE no JWT: decide pelo JWT (custo zero). Equipe no JWT: decide pelo
 * papel do BANCO via getActor (crítica S4). Uso típico: `requireRole('CLIENTE')` no autoatendimento.
 * Atenção: ao contrário de requirePermission, aqui o ADMIN NÃO passa se não estiver na lista.
 */
export function requireRole(...roles: ActorRole[]): RequestHandler {
    if (roles.length === 0) throw new Error('requireRole: informe ao menos um papel.');
    return guard((actor, _req, res) => {
        if (roles.includes(actor.role)) return true;
        denyPermission(res, roles.join('|'));
        return false;
    });
}
