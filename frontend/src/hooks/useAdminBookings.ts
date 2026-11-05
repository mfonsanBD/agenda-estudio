import { useState, useEffect, useCallback } from 'react';
import { bookingsApi, usersApi, BookingWithUser, UserSummary } from '../api/client';

interface UseAdminBookingsOptions {
    /**
     * Carrega a lista de clientes (seletor do "Novo agendamento"). Só quem tem `agendamentos.criar`
     * precisa dela: sem a permissão, a tela nem pede (menos dados de cliente no navegador).
     */
    loadClients?: boolean;
}

export function useAdminBookings({ loadClients = true }: UseAdminBookingsOptions = {}) {
    const [bookings, setBookings] = useState<BookingWithUser[]>([]);
    const [users, setUsers] = useState<UserSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [dateFilter, setDateFilter] = useState('');
    const [statusFilter, setStatusFilter] = useState('');

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            // Cargas independentes: uma falha (ou 403) na lista de clientes não derruba a de agendamentos.
            const [bRes, uRes] = await Promise.allSettled([
                bookingsApi.getAll(dateFilter || undefined, statusFilter || undefined),
                loadClients ? usersApi.getAll() : Promise.resolve({ users: [] as UserSummary[] }),
            ]);
            if (bRes.status === 'fulfilled') setBookings(bRes.value.bookings);
            else console.error(bRes.reason);
            if (uRes.status === 'fulfilled') setUsers(uRes.value.users);
            else console.error(uRes.reason);
        } finally { setLoading(false); }
    }, [dateFilter, statusFilter, loadClients]);

    useEffect(() => { reload(); }, [reload]);

    return { bookings, setBookings, users, loading, dateFilter, setDateFilter, statusFilter, setStatusFilter, reload };
}
