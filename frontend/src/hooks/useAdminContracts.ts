import { useState, useEffect, useCallback, useRef } from 'react';
import { contractsApi, usersApi, pricingApi, AdminContract, UserSummary, PricingConfig } from '../api/client';
import { usePermission } from './usePermission';

export type ContractFilter = 'ALL' | 'ACTIVE' | 'AWAITING_PAYMENT' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED' | 'PENDING_CANCELLATION' | 'PAUSED';

export function useAdminContracts() {
    // GET /contracts devolve AdminContract: os dados de multa/cancelamento (E13) e de renovação (E4) vêm SEMPRE.
    const [contracts, setContracts] = useState<AdminContract[]>([]);
    const [users, setUsers] = useState<UserSummary[]>([]);
    const [pricing, setPricing] = useState<PricingConfig[]>([]);
    const [loading, setLoading] = useState(true);
    /** true durante um recarregamento SILENCIOSO (após o 1º carregamento). */
    const [refreshing, setRefreshing] = useState(false);
    const [filter, setFilter] = useState<ContractFilter>('ALL');
    const [search, setSearch] = useState('');
    const loadedOnce = useRef(false);
    // A lista de clientes só alimenta os seletores de "Novo contrato"/"Personalizado" (contratos.criar).
    // Sem essa chave ela nem é pedida (menos dados pessoais no navegador de quem só consulta contratos).
    const { can } = usePermission();
    const needsClients = can('contratos.criar');
    const needsClientsRef = useRef(needsClients);
    needsClientsRef.current = needsClients;

    // `loading` só liga no PRIMEIRO carregamento. Os seguintes (após criar/editar/cancelar)
    // atualizam os dados em silêncio: a página mostra o skeleton quando `loading`, o que
    // DESMONTAVA os modais abertos (ex.: o personalizado do admin fechava e reabria no passo 1
    // logo após "Criar Contrato", perdendo o sheet de cobrança).
    const reload = useCallback(async () => {
        const first = !loadedOnce.current;
        if (first) setLoading(true);
        else setRefreshing(true);
        try {
            const [cRes, uRes, pRes] = await Promise.all([
                contractsApi.getAll(),
                needsClientsRef.current ? usersApi.getAll('CLIENTE') : Promise.resolve({ users: [] as UserSummary[] }),
                pricingApi.get(),
            ]);
            setContracts(cRes.contracts);
            setUsers(uRes.users);
            setPricing(pRes.pricing);
        } catch (err) { console.error(err); }
        finally {
            loadedOnce.current = true;
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => { reload(); }, [reload]);

    return {
        contracts, setContracts,
        users,
        pricing,
        loading,
        refreshing,
        filter, setFilter,
        search, setSearch,
        reload,
    };
}
