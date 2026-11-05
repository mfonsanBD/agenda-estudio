import { useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import type { User } from '../api/client';
import { isAdminOnlyPermission, type Permission } from '../constants/permissions';

// ─── Permissões da equipe no front ──────────────────────
// Fonte: `user.role` + `user.permissions` do /api/auth/me. O servidor é a autoridade (403
// PERMISSION_DENIED); aqui só se decide o que MOSTRAR (menu, rotas, botões).
//   ADMIN       → tudo (inclusive as chaves exclusivas), mesmo que `permissions` venha vazio/ausente;
//   COLABORADOR → só as chaves dele (nunca as exclusivas do ADMIN);
//   CLIENTE     → nada (a área do cliente não usa can()).

type MaybeUser = Pick<User, 'role'> & Partial<Pick<User, 'permissions' | 'staffTitle'>>;

/** ADMIN ou COLABORADOR (área administrativa). */
export function isStaffUser(user: MaybeUser | null | undefined): boolean {
    return user?.role === 'ADMIN' || user?.role === 'COLABORADOR';
}

/** Versão pura do `can` (fora de componentes: utilitários, testes). */
export function userCan(user: MaybeUser | null | undefined, key: Permission): boolean {
    if (!user) return false;
    if (user.role === 'ADMIN') return true;
    if (user.role !== 'COLABORADOR') return false;
    if (isAdminOnlyPermission(key)) return false;
    return Array.isArray(user.permissions) && user.permissions.includes(key);
}

/** Rótulo do papel (abaixo do nome no menu): "Administrador", o cargo ou "Colaborador", ou "Cliente". */
export function roleLabelOf(user: MaybeUser | null | undefined): string {
    if (user?.role === 'ADMIN') return 'Administrador';
    if (user?.role === 'COLABORADOR') return user.staffTitle?.trim() || 'Colaborador';
    return 'Cliente';
}

export interface PermissionApi {
    /** Papel ADMIN (acesso total; único que gerencia a Equipe). */
    isAdmin: boolean;
    /** ADMIN ou COLABORADOR (área administrativa). */
    isStaff: boolean;
    /** CLIENTE (área do cliente). */
    isClient: boolean;
    /** Pode a ação? ADMIN sempre; COLABORADOR só se tiver a chave; CLIENTE nunca. */
    can: (key: Permission) => boolean;
    /** Pode QUALQUER uma? (lista vazia → false) */
    canAny: (...keys: Permission[]) => boolean;
    /** Pode TODAS? (lista vazia → true para a equipe) */
    canAll: (...keys: Permission[]) => boolean;
    /** Rótulo do papel ("Administrador", cargo/"Colaborador" ou "Cliente"). */
    roleLabel: string;
}

/**
 * `const { can, canAny, isAdmin, isStaff } = usePermission();`
 * Ex.: `{can('agendamentos.criar') && <button …>Novo agendamento</button>}` — ou `<Can perm="…">`.
 */
export function usePermission(): PermissionApi {
    const { user } = useAuth();
    const role = user?.role;
    const isAdmin = role === 'ADMIN';
    const isStaff = isAdmin || role === 'COLABORADOR';
    const permissions = user?.permissions;
    const set = useMemo(() => new Set<string>(Array.isArray(permissions) ? permissions : []), [permissions]);

    const can = useCallback((key: Permission) => {
        if (isAdmin) return true;
        if (!isStaff || isAdminOnlyPermission(key)) return false;
        return set.has(key);
    }, [isAdmin, isStaff, set]);
    const canAny = useCallback((...keys: Permission[]) => keys.some(can), [can]);
    const canAll = useCallback((...keys: Permission[]) => isStaff && keys.every(can), [isStaff, can]);
    const roleLabel = roleLabelOf(user);

    return useMemo(
        () => ({ isAdmin, isStaff, isClient: role === 'CLIENTE', can, canAny, canAll, roleLabel }),
        [isAdmin, isStaff, role, can, canAny, canAll, roleLabel],
    );
}

export default usePermission;
