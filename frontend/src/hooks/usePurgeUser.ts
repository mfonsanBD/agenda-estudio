import { useCallback, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { usersApi, type UserPurgePreview } from '../api/client';
import { useUI } from '../context/UIContext';
import { getErrorMessage } from '../utils/errors';
import { formatBRL } from '../utils/format';

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const ROLE_LABEL: Record<string, string> = { CLIENTE: 'cliente', COLABORADOR: 'colaborador', ADMIN: 'administrador' };

/** "O que vai acontecer" da exclusão definitiva, a partir da prévia real do servidor. */
export function buildPurgeConsequences(p: UserPurgePreview): string[] {
    const out: string[] = ['A conta é apagada do banco de dados e a pessoa perde o acesso na hora.'];
    if (p.contracts > 0) out.push(`${n(p.contracts, 'contrato é apagado', 'contratos são apagados')}.`);
    if (p.bookings > 0) out.push(`${n(p.bookings, 'gravação é apagada', 'gravações são apagadas')} (inclusive as já realizadas).`);
    if (p.payments > 0) {
        out.push(p.paidPayments > 0
            ? `${n(p.payments, 'cobrança é apagada', 'cobranças são apagadas')}, ${n(p.paidPayments, 'paga', 'pagas')} (${formatBRL(p.paidAmount)}): esses valores somem do financeiro e dos relatórios.`
            : `${n(p.payments, 'cobrança é apagada', 'cobranças são apagadas')}.`);
    }
    if (p.blockedSlots > 0) out.push(`${n(p.blockedSlots, 'bloqueio de agenda criado por ela continua', 'bloqueios de agenda criados por ela continuam')}, agora em seu nome.`);
    out.push('Não é possível desfazer.');
    return out;
}

/**
 * Fluxo "Excluir definitivamente" (só o ADMIN): prévia real → diálogo de perigo (digitar EXCLUIR) → DELETE /users/:id/permanent.
 * Erro da prévia aparece num alerta; erro do DELETE aparece dentro do diálogo.
 */
export function usePurgeUser() {
    const { showAlert, showConfirm, showToast } = useUI();
    const [loadingId, setLoadingId] = useState<string | null>(null);
    const inFlight = useRef(false);

    const requestPurge = useCallback(async (target: { id: string; name: string }, onDone: () => void) => {
        if (inFlight.current) return;
        inFlight.current = true;
        setLoadingId(target.id);
        let preview: UserPurgePreview;
        try {
            preview = (await usersApi.purgePreview(target.id)).preview;
        } catch (err) {
            showAlert({ type: 'error', title: 'Não é possível excluir', message: getErrorMessage(err) || 'Não foi possível calcular o que será apagado.' });
            return;
        } finally {
            inFlight.current = false;
            setLoadingId(null);
        }

        const name = preview.name || target.name;
        const role = ROLE_LABEL[preview.role] ?? 'usuário';
        showConfirm({
            tone: 'danger',
            icon: Trash2,
            title: `Excluir ${name} definitivamente?`,
            message: `Apaga de vez a conta deste ${role} e tudo o que está ligado a ela.`,
            consequences: buildPurgeConsequences(preview),
            confirmLabel: 'Excluir definitivamente',
            loadingLabel: 'Excluindo…',
            requireText: 'EXCLUIR',
            // Sem try/catch: um 400/409/500 do DELETE aparece dentro do diálogo.
            onConfirm: async () => {
                const res = await usersApi.purge(target.id);
                showToast(res.message || 'Conta excluída definitivamente.');
                try { onDone(); } catch (err) { console.error(err); }
            },
        });
    }, [showAlert, showConfirm, showToast]);

    return { requestPurge, purgingId: loadingId };
}
