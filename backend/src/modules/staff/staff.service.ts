// ─── Equipe: regras compartilhadas pelas rotas de /api/staff ─
// Tudo o que pode tirar um ADMIN ativo do sistema (rebaixar, desativar) roda numa transação que pega a
// trava `pg_advisory_xact_lock` ANTES de ler o alvo e contar os administradores. A trava é do Postgres
// (não do Redis, que falha aberto): duas rebaixas concorrentes se enfileiram e a segunda vê a primeira já
// gravada — exatamente uma passa e a outra recebe 409 LAST_ADMIN.

import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { sanitizeStoredPermissions } from '../../config/staffPermissions.js';
import { PERMISSION_DENIED_MESSAGE } from '../../middleware/permissions.js';

export type Tx = Prisma.TransactionClient;
export type StaffRole = 'ADMIN' | 'COLABORADOR';

/** Chave da trava que serializa as mudanças da equipe (hashtextextended no Postgres). */
export const STAFF_GUARD_LOCK_KEY = 'staff:admin-guard';

/** Erro de regra da Equipe: o handler responde `status` com `{ error, code, ...extra }`. */
export class StaffError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly extra: Readonly<Record<string, unknown>> = {},
    ) {
        super(message);
        this.name = 'StaffError';
    }

    body(): Record<string, unknown> {
        return { error: this.message, code: this.code, ...this.extra };
    }
}

// ─── Mensagens estáveis (a UI leva cada código à etapa certa) ──
export const STAFF_ERRORS = {
    notFound: () => new StaffError(404, 'STAFF_NOT_FOUND', 'Membro da equipe não encontrado.'),
    selfChange: () => new StaffError(400, 'SELF_CHANGE_FORBIDDEN', 'Você não pode alterar o seu próprio acesso. Peça a outro administrador.'),
    lastAdmin: () => new StaffError(409, 'LAST_ADMIN', 'É o único administrador ativo. Promova outra pessoa a administrador antes.'),
    emailTaken: () => new StaffError(409, 'EMAIL_TAKEN', 'Este e-mail já está em uso por outra conta.'),
    emailIsClient: () => new StaffError(409, 'EMAIL_IS_CLIENT', 'Este e-mail já é de um cliente. Use outro e-mail para a conta da equipe.'),
    adminCredentials: () => new StaffError(
        403,
        'ADMIN_TARGET_FORBIDDEN',
        'Por segurança, o e-mail e a senha de um administrador não se alteram pela tela Equipe. Use “Enviar acesso”: o código de entrada vai para o e-mail dele.',
    ),
    notAdminAnymore: () => new StaffError(403, 'PERMISSION_DENIED', PERMISSION_DENIED_MESSAGE, { permission: 'ADMIN' }),
    invalidPermissions: (invalid: string[]) => new StaffError(
        400,
        'INVALID_PERMISSION',
        `Permissões inválidas: ${invalid.join(', ')}.`,
        { invalid },
    ),
    inactive: () => new StaffError(409, 'STAFF_INACTIVE', 'Este acesso está desativado. Reative antes de enviar o e-mail de acesso.'),
} as const;

// ─── Leitura ────────────────────────────────────────────

export const MEMBER_SELECT = {
    id: true,
    name: true,
    email: true,
    phone: true,
    photoUrl: true,
    role: true,
    clientStatus: true,
    deletedAt: true,
    createdAt: true,
    updatedAt: true,
    staffProfile: { select: { title: true, permissions: true, updatedAt: true } },
} as const satisfies Prisma.UserSelect;

export type MemberRow = Prisma.UserGetPayload<{ select: typeof MEMBER_SELECT }>;

/**
 * Formato de `members[]` / `member` (contrato D5). ADMIN tem acesso total: `permissions` vem vazio.
 * `credentialsLocked`: o e-mail e a senha NÃO se alteram pela tela Equipe — a pessoa é ADMIN ou já foi
 * (E2). É o mesmo critério do assertCredentialsEditable, para a tela travar o e-mail e esconder "Definir
 * senha" em vez de oferecer a ação e colher o 403 ADMIN_TARGET_FORBIDDEN (TELA-1).
 */
export interface StaffMember {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    photoUrl: string | null;
    role: StaffRole;
    title: string | null;
    permissions: string[];
    active: boolean;
    isSelf: boolean;
    credentialsLocked: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export function isStaffMemberRow(row: { role: string; deletedAt: Date | null } | null | undefined): boolean {
    return !!row && !row.deletedAt && (row.role === 'ADMIN' || row.role === 'COLABORADOR');
}

/** `exAdminIds`: as contas que já foram ADMIN (exAdminIdsOf). Use toMembers/toMemberResponse, que o calculam. */
export function toMember(row: MemberRow, actorId: string, exAdminIds: ReadonlySet<string>): StaffMember {
    const profile = row.staffProfile;
    const updatedAt = profile && profile.updatedAt > row.updatedAt ? profile.updatedAt : row.updatedAt;
    return {
        id: row.id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        photoUrl: row.photoUrl,
        role: row.role as StaffRole,
        title: profile?.title ?? null,
        permissions: row.role === 'COLABORADOR' ? sanitizeStoredPermissions(profile?.permissions) : [],
        active: row.clientStatus !== 'BLOCKED',
        isSelf: row.id === actorId,
        credentialsLocked: credentialsLockedFor(row, exAdminIds),
        createdAt: row.createdAt,
        updatedAt,
    };
}

/**
 * Membros no formato da resposta, com `credentialsLocked` calculado em LOTE: uma consulta à auditoria para a
 * lista inteira (sem N+1), e só pelos COLABORADORes (ADMIN já é travado pelo papel). Dentro de uma
 * transação, passe o `tx`: a auditoria de uma rebaixa gravada nela já conta (ADMIN → COLABORADOR sai true).
 */
export async function toMembers(db: Tx | typeof prisma, rows: readonly MemberRow[], actorId: string): Promise<StaffMember[]> {
    const exAdminIds = await exAdminIdsOf(db, rows.filter(r => r.role === 'COLABORADOR').map(r => r.id));
    return rows.map(r => toMember(r, actorId, exAdminIds));
}

/** toMembers de um membro só (POST, PATCH, desativar/reativar). */
export async function toMemberResponse(db: Tx | typeof prisma, row: MemberRow, actorId: string): Promise<StaffMember> {
    const [member] = await toMembers(db, [row], actorId);
    return member;
}

/** Membro da equipe (ADMIN/COLABORADOR não excluído) ou 404 — o alvo de /api/staff/:id (crítica E1). */
export async function loadMemberOrThrow(db: Tx | typeof prisma, id: string): Promise<MemberRow> {
    const row = await db.user.findUnique({ where: { id }, select: MEMBER_SELECT });
    if (!row || !isStaffMemberRow(row)) throw STAFF_ERRORS.notFound();
    return row;
}

/**
 * E-mail já usado por OUTRA conta (sem diferenciar maiúsculas — crítica E6): 409 EMAIL_IS_CLIENT se for
 * de um cliente; 409 EMAIL_TAKEN se for de alguém da equipe. `exceptId` = a própria conta (edição).
 */
export async function assertEmailAvailableForStaff(db: Tx | typeof prisma, email: string, exceptId?: string): Promise<void> {
    const other = await db.user.findFirst({
        where: {
            email: { equals: email, mode: 'insensitive' },
            ...(exceptId ? { id: { not: exceptId } } : {}),
        },
        select: { role: true },
    });
    if (!other) return;
    throw other.role === 'CLIENTE' ? STAFF_ERRORS.emailIsClient() : STAFF_ERRORS.emailTaken();
}

// ─── Trava e "nunca ficar sem ADMIN ativo" ──────────────

/**
 * Transação da Equipe: pega a trava (Postgres) e roda `fn`. Lançar StaffError dentro desfaz tudo.
 * `fn` recebe `assertActorStillAdmin`, que relê quem age e recusa (403) se ele deixou de ser ADMIN ativo
 * depois do requireAdmin (corrida com outra mudança). Cada rota chama no ponto certo: na rebaixa, o
 * LAST_ADMIN é conferido antes, para a resposta da corrida "A rebaixa B × B rebaixa A" ser 409 LAST_ADMIN.
 */
export async function withStaffGuard<T>(actorId: string, fn: (tx: Tx, assertActorStillAdmin: () => Promise<void>) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${STAFF_GUARD_LOCK_KEY}, 0))::text`;
        const assertActorStillAdmin = async () => {
            const me = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, clientStatus: true, deletedAt: true } });
            if (!me || me.role !== 'ADMIN' || me.deletedAt || me.clientStatus === 'BLOCKED') throw STAFF_ERRORS.notAdminAnymore();
        };
        return fn(tx, assertActorStillAdmin);
    });
}

/**
 * true se a conta JÁ FOI ADMIN (há STAFF_ROLE_CHANGED com from ADMIN na auditoria — gravada na mesma
 * transação da rebaixa). Conta que já foi ADMIN segue a regra de ADMIN para e-mail e senha (E2): senão
 * bastaria rebaixar, trocar a senha/o e-mail e promover de novo para entrar como aquele administrador.
 */
export async function wasAdminBefore(db: Tx | typeof prisma, userId: string): Promise<boolean> {
    const row = await db.auditLog.findFirst({ where: exAdminAuditWhere([userId]), select: { id: true } });
    return !!row;
}

/** A auditoria que marca "esta conta já foi ADMIN" — o MESMO filtro no wasAdminBefore e no exAdminIdsOf. */
function exAdminAuditWhere(userIds: readonly string[]): Prisma.AuditLogWhereInput {
    return {
        entityType: 'USER',
        entityId: userIds.length === 1 ? userIds[0] : { in: [...userIds] },
        action: 'STAFF_ROLE_CHANGED',
        changes: { contains: '"from":"ADMIN"' },
    };
}

/** wasAdminBefore em lote: quais de `userIds` já foram ADMIN, numa consulta só (índice entity_type, entity_id). */
export async function exAdminIdsOf(db: Tx | typeof prisma, userIds: readonly string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await db.auditLog.findMany({ where: exAdminAuditWhere(userIds), select: { entityId: true } });
    return new Set(rows.map(r => r.entityId));
}

/** O critério do assertCredentialsEditable com o conjunto de ex-ADMIN já calculado (flag da resposta). */
export function credentialsLockedFor(target: { id: string; role: string }, exAdminIds: ReadonlySet<string>): boolean {
    return target.role !== 'COLABORADOR' || exAdminIds.has(target.id);
}

/**
 * E2: e-mail e senha só se alteram pela tela Equipe em quem é COLABORADOR e NUNCA foi ADMIN. Senão
 * 403 ADMIN_TARGET_FORBIDDEN ("Enviar acesso" manda o código para o e-mail dele). As respostas trazem o
 * mesmo critério em `credentialsLocked` (toMembers).
 */
export async function assertCredentialsEditable(db: Tx | typeof prisma, target: { id: string; role: string }): Promise<void> {
    if (target.role !== 'COLABORADOR' || await wasAdminBefore(db, target.id)) throw STAFF_ERRORS.adminCredentials();
}

/** Lança 409 LAST_ADMIN se tirar `targetId` deixaria o sistema sem nenhum ADMIN ativo. Chamar DENTRO de withStaffGuard. */
export async function assertNotLastActiveAdmin(tx: Tx, targetId: string): Promise<void> {
    const others = await tx.user.count({
        where: { role: 'ADMIN', deletedAt: null, clientStatus: { not: 'BLOCKED' }, id: { not: targetId } },
    });
    if (others === 0) throw STAFF_ERRORS.lastAdmin();
}

/** Diferença de conjuntos para a auditoria de permissões. */
export function permissionDiff(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
    const b = new Set(before);
    const a = new Set(after);
    return { added: after.filter(k => !b.has(k)), removed: before.filter(k => !a.has(k)) };
}

/** Grava a auditoria DENTRO da transação (entityType USER, entityId = alvo, performedBy = ator). */
export async function auditStaff(tx: Tx, targetId: string, action: string, actorId: string, changes?: Record<string, unknown>): Promise<void> {
    await tx.auditLog.create({
        data: {
            entityType: 'USER',
            entityId: targetId,
            action,
            performedBy: actorId,
            changes: changes ? JSON.stringify(changes) : null,
        },
    });
}

/** Violação de UNIQUE (P2002) — corrida de e-mail repetido entre a checagem e a gravação. */
export function isUniqueViolation(err: unknown): boolean {
    return !!err && typeof err === 'object' && (err as { code?: string }).code === 'P2002';
}
