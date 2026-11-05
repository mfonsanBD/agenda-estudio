import { useState, useEffect } from 'react';
import { usersApi, UserDetail } from '../../../api/client';
import { useUI } from '../../../context/UIContext';
import AddressFields, { AddressValues } from './AddressFields';

const SAVE_ERROR = { message: 'Não foi possível salvar. Tente novamente.', type: 'error' as const };

const fromUser = (u: UserDetail): AddressValues => ({
    zipCode: u.zipCode || '', address: u.address || '', addressNumber: u.addressNumber || '',
    complement: u.complement || '', neighborhood: u.neighborhood || '', city: u.city || '', state: u.state || '',
});

/**
 * Endereço no perfil do cliente: estado local espelha o usuário, cada campo persiste
 * no blur (só quando muda) e o autopreenchimento por CEP salva o grupo de uma vez.
 */
export default function AddressEditor({ user, onSaved, readOnly = false }: { user: UserDetail; onSaved: () => void; readOnly?: boolean }) {
    const { showToast } = useUI();
    const [form, setForm] = useState<AddressValues>(() => fromUser(user));
    // Só reinicializa quando troca de cliente (user.id). Reagir a cada novo objeto `user`
    // (refetch silencioso, edição de nota de booking) sobrescreveria edição em andamento.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { setForm(fromUser(user)); }, [user.id]);

    const persist = async (patch: Partial<Record<keyof AddressValues, string | null>>) => {
        try { await usersApi.update(user.id, patch); onSaved(); }
        catch { showToast(SAVE_ERROR); }
    };

    const saveField = (field: keyof AddressValues) => {
        const current = (user[field] as string) || '';
        if (form[field] !== current) persist({ [field]: form[field] || null });
    };

    return (
        <AddressFields
            values={form}
            onChange={patch => setForm(f => ({ ...f, ...patch }))}
            disabled={readOnly}
            onFieldBlur={saveField}
            onCepFilled={patch => persist({
                zipCode: patch.zipCode || null, address: patch.address || null,
                neighborhood: patch.neighborhood || null, city: patch.city || null, state: patch.state || null,
            })}
        />
    );
}
