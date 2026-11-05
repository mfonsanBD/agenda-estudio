// ─── Destinatários dos avisos da EQUIPE ─────────────────
// Substitui os `prisma.user.findMany({ where: { role: 'ADMIN' } })` dos avisos de audiência "admin":
// recebe todo ADMIN ativo + todo COLABORADOR ativo que tem QUALQUER uma das permissões do evento
// (STAFF_EVENT_PERMISSIONS em config/staffPermissions.ts). NUNCA conta BLOCKED (desativado) nem
// excluído (deletedAt). Evento sem mapeamento → só ADMIN (nega por padrão).
//
// Se a consulta com staff_profiles falhar (ex.: migration da tabela não aplicada — crítica M1), cai
// para "só ADMIN" em vez de derrubar o aviso: o administrador continua sendo avisado.

import { prisma } from './prisma.js';
import {
    isPermissionKey,
    staffEventPermissions,
    type PermissionKey,
} from '../config/staffPermissions.js';

/** Cliente Prisma ou transação (`tx`) — basta o `user.findMany`. */
export interface StaffRecipientsDb {
    user: { findMany: (args: any) => Promise<Array<{ id: string }>> };
}

export interface StaffRecipientsOptions {
    /** Não avisar quem causou o evento (ex.: quem remarcou). */
    excludeUserId?: string | null;
    /** Rodar dentro de uma transação. */
    db?: StaffRecipientsDb;
}

/**
 * Permissões (QUALQUER uma) de um alvo: chave de evento do catálogo de notificações (ex.:
 * 'admin_cancellation_requested'), uma permissão ('contratos.multa') ou uma lista de permissões.
 * Desconhecido → [] (só ADMIN).
 */
export function resolveRecipientPermissions(target: string | readonly string[]): PermissionKey[] {
    if (Array.isArray(target)) return (target as readonly string[]).filter(isPermissionKey);
    const one = target as string;
    if (isPermissionKey(one)) return [one];
    return [...staffEventPermissions(one)];
}

/**
 * Ids de quem da equipe deve receber o aviso: ADMIN ativo + COLABORADOR ativo com a permissão.
 *   await getStaffRecipientIds('admin_cancellation_requested')
 *   await getStaffRecipientIds('contratos.multa', { excludeUserId: actorId })
 *   await getStaffRecipientIds(['financeiro.ver', 'cobrancas.baixa'], { db: tx })
 */
export async function getStaffRecipientIds(
    target: string | readonly string[],
    opts: StaffRecipientsOptions = {},
): Promise<string[]> {
    const db = opts.db ?? prisma;
    const anyOf = resolveRecipientPermissions(target);
    const base = {
        deletedAt: null,
        clientStatus: { not: 'BLOCKED' },
        ...(opts.excludeUserId ? { id: { not: opts.excludeUserId } } : {}),
    };
    const adminsOnly = { ...base, role: 'ADMIN' };
    if (anyOf.length === 0) {
        return (await db.user.findMany({ where: adminsOnly, select: { id: true } })).map(u => u.id);
    }
    try {
        const rows = await db.user.findMany({
            where: {
                ...base,
                OR: [
                    { role: 'ADMIN' },
                    { role: 'COLABORADOR', staffProfile: { is: { permissions: { hasSome: anyOf } } } },
                ],
            },
            select: { id: true },
        });
        return rows.map(u => u.id);
    } catch (err) {
        // Dentro de uma transação o Postgres já abortou tudo — não há como tentar de novo: propaga.
        if (opts.db) throw err;
        console.error('[STAFF] Falha ao buscar colaboradores para o aviso (seguindo só com os administradores):', err instanceof Error ? err.message : err);
        return (await db.user.findMany({ where: adminsOnly, select: { id: true } })).map(u => u.id);
    }
}
