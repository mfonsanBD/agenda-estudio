import React from 'react';
import { usePermission } from '../../hooks/usePermission';
import type { Permission } from '../../constants/permissions';

interface CanProps {
    /** Exige esta chave. */
    perm?: Permission;
    /** Exige QUALQUER uma destas. */
    anyOf?: readonly Permission[];
    /** Exige TODAS estas. */
    allOf?: readonly Permission[];
    /** Só o papel ADMIN (ex.: Equipe, Integrações). */
    adminOnly?: boolean;
    /** Só a equipe (ADMIN ou COLABORADOR), sem chave específica. */
    staffOnly?: boolean;
    /** O que mostrar quando não pode (padrão: nada). Ex.: botão desabilitado com Tooltip explicando. */
    fallback?: React.ReactNode;
    children: React.ReactNode;
}

/**
 * Mostra `children` só para quem pode (as condições informadas se somam). Esconder no front é
 * conforto: quem protege é o servidor (403 PERMISSION_DENIED).
 *
 *   <Can perm="agendamentos.criar"><button …>Novo agendamento</button></Can>
 *   <Can anyOf={['hoje.ver', 'agendamentos.ver']} fallback={<Bloqueado />}>…</Can>
 */
export default function Can({ perm, anyOf, allOf, adminOnly, staffOnly, fallback = null, children }: CanProps) {
    const { isAdmin, isStaff, can, canAny, canAll } = usePermission();
    const allowed =
        (!adminOnly || isAdmin)
        && (!staffOnly || isStaff)
        && (!perm || can(perm))
        && (!anyOf || canAny(...anyOf))
        && (!allOf || canAll(...allOf));
    return <>{allowed ? children : fallback}</>;
}

export { Can };
