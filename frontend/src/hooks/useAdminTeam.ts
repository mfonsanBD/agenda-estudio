import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { staffApi, type StaffCatalog, type StaffMember } from '../api/client';
import { getErrorMessage } from '../utils/errors';

/** Filtro dos KPIs da tela Equipe. */
export type TeamFilter = 'ALL' | 'ADMIN' | 'COLABORADOR' | 'INACTIVE';

export interface TeamCounts {
    total: number;
    admins: number;
    colaboradores: number;
    inactive: number;
    /** Administradores ATIVOS (a trava do "último administrador"). */
    activeAdmins: number;
}

/** Mesma ordem do GET /api/staff: administradores primeiro, depois por nome. */
function sortMembers(list: StaffMember[]): StaffMember[] {
    return [...list].sort((a, b) => {
        if (a.role !== b.role) return a.role === 'ADMIN' ? -1 : 1;
        return a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });
    });
}

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Estado da tela Equipe (`/admin/equipe`, só ADMIN): membros (GET /api/staff), catálogo de
 * permissões (GET /api/staff/catalog — rótulos, níveis e perfis vêm do servidor), busca e filtro dos KPIs.
 * - `loading`: só a 1ª carga (a tela mostra esqueleto); `refreshing`: recarga silenciosa.
 * - `upsertMember`: aplica na lista o `member` que o servidor devolveu (criar/editar/desativar/reativar)
 *   sem recarregar tudo — assim um diálogo aberto não desmonta no meio.
 * - O catálogo carrega à parte: se falhar, a lista funciona e só a etapa Permissões mostra o erro.
 */
export function useAdminTeam() {
    const [members, setMembers] = useState<StaffMember[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [catalog, setCatalog] = useState<StaffCatalog | null>(null);
    const [catalogError, setCatalogError] = useState<string | null>(null);
    const [catalogLoading, setCatalogLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState<TeamFilter>('ALL');
    const loadedOnce = useRef(false);

    const reload = useCallback(async () => {
        if (loadedOnce.current) setRefreshing(true);
        try {
            const res = await staffApi.list();
            setMembers(sortMembers(res.members));
            setError(null);
        } catch (err) {
            console.error('[Equipe] Falha ao carregar a equipe:', err);
            setError(getErrorMessage(err));
        } finally {
            loadedOnce.current = true;
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    const reloadCatalog = useCallback(async () => {
        setCatalogLoading(true);
        try {
            setCatalog(await staffApi.getCatalog());
            setCatalogError(null);
        } catch (err) {
            console.error('[Equipe] Falha ao carregar o catálogo de permissões:', err);
            setCatalogError(getErrorMessage(err));
        } finally {
            setCatalogLoading(false);
        }
    }, []);

    useEffect(() => {
        void reload();
        void reloadCatalog();
    }, [reload, reloadCatalog]);

    const upsertMember = useCallback((member: StaffMember) => {
        setMembers(prev => sortMembers([...prev.filter(m => m.id !== member.id), member]));
    }, []);

    const counts = useMemo<TeamCounts>(() => ({
        total: members.length,
        admins: members.filter(m => m.role === 'ADMIN').length,
        colaboradores: members.filter(m => m.role === 'COLABORADOR').length,
        inactive: members.filter(m => !m.active).length,
        activeAdmins: members.filter(m => m.role === 'ADMIN' && m.active).length,
    }), [members]);

    const filtered = useMemo(() => {
        let list = members;
        if (filter === 'ADMIN') list = list.filter(m => m.role === 'ADMIN');
        else if (filter === 'COLABORADOR') list = list.filter(m => m.role === 'COLABORADOR');
        else if (filter === 'INACTIVE') list = list.filter(m => !m.active);
        const q = normalize(search.trim());
        if (q) {
            list = list.filter(m =>
                normalize(m.name).includes(q)
                || normalize(m.email ?? '').includes(q)
                || normalize(m.title ?? '').includes(q));
        }
        return list;
    }, [members, filter, search]);

    return {
        members, filtered, counts, loading, refreshing, error, reload, upsertMember,
        catalog, catalogError, catalogLoading, reloadCatalog,
        search, setSearch, filter, setFilter,
    };
}

export default useAdminTeam;
