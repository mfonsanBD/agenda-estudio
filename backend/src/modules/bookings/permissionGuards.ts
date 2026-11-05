// ─── Guardas das rotas MISTAS (cliente + equipe) de Agenda, Hoje e Contratos ─
// Rota mista = o CLIENTE usa para os próprios dados e a EQUIPE usa para qualquer cliente (ex.: DELETE
// /bookings/:id, PATCH /bookings/:id/makeup, POST /contracts/custom, GET /contracts/:id). A regra é:
//   • CLIENTE (pelo JWT, sem banco) → segue para o handler, que aplica a regra atual do cliente
//     (filtro por userId, política de cancelamento etc.);
//   • EQUIPE (papel do BANCO via getActor) → precisa de QUALQUER uma das permissões; sem ela, 403
//     PERMISSION_DENIED explícito — nunca cai no ramo do cliente.
// Nunca usar `isAdmin = role !== 'CLIENTE'` nem um "isStaff" genérico como autorização (proposta §4.5):
// o handler decide o ramo por `req.actor.isStaff` DEPOIS desta guarda, que já garantiu a permissão.
//
// Express 4 não captura rejeições async: a guarda sempre RESPONDE (401/503/403) em vez de lançar.

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { actorOrReply, canAny, denyPermission, type Actor } from '../../middleware/permissions.js';
import type { RequirementKey } from '../../config/staffPermissions.js';

/**
 * Rota mista: cliente passa (o handler aplica a regra do cliente); equipe precisa de QUALQUER uma das
 * chaves (ADMIN passa sempre). Deixa o ator em `req.actor` (memo) para o handler.
 *   router.delete('/:id', authenticate, requirePermissionIfStaff('agendamentos.cancelar'), handler)
 */
export function requirePermissionIfStaff(...anyOf: RequirementKey[]): RequestHandler {
    if (anyOf.length === 0) throw new Error('requirePermissionIfStaff: informe ao menos uma chave.');
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const actor = await actorOrReply(req, res);
        if (!actor) return;
        if (actor.isStaff && !canAny(actor, ...anyOf)) {
            denyPermission(res, anyOf[0]!);
            return;
        }
        next();
    };
}

/**
 * Ator já resolvido pela guarda da rota (memo em req.actor). Se por algum motivo não houver memo,
 * resolve de novo (uma consulta) — e responde 401/503 devolvendo null.
 */
export async function routeActor(req: Request, res: Response): Promise<Actor | null> {
    if (req.actor && req.user && req.actor.userId === req.user.userId) return req.actor;
    return actorOrReply(req, res);
}
