import { useCallback, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { usersApi, type UserDeletionPreview } from '../api/client';
import { useUI } from '../context/UIContext';
import { getErrorMessage } from '../utils/errors';
import { formatBRL } from '../utils/format';

/**
 * Resposta do DELETE /users/:id. `paidDuringDeletion`: cobranças confirmadas no provedor durante a
 * exclusão (PIX pago no último instante, cartão aprovado) — ficam pagas, sem estorno automático.
 */
export type DeleteClientResult = Awaited<ReturnType<typeof usersApi.remove>> & {
    paidDuringDeletion?: { payments: number; amount: number };
};

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Lista "O que vai acontecer" montada a partir da prévia REAL do backend (GET /users/:id/deletion-preview).
 * mode 'hard' = nada de negócio vinculado → delete físico; 'soft' = anonimiza e encerra pendências (D3).
 */
export function buildDeletionConsequences(p: UserDeletionPreview): string[] {
    const out: string[] = [];
    if (p.mode === 'hard') {
        out.push('O cadastro será apagado definitivamente (não há contratos, gravações nem pagamentos).');
        if (p.accessories.savedCards > 0) out.push(`${n(p.accessories.savedCards, 'cartão salvo será removido', 'cartões salvos serão removidos')}.`);
    } else {
        const { activeContracts, futureBookings, pendingPayments, pendingAmount } = p.pending;
        if (activeContracts > 0) {
            out.push(`${n(activeContracts, 'contrato em andamento será cancelado', 'contratos em andamento serão cancelados')}.`);
        }
        if (futureBookings > 0) {
            out.push(futureBookings === 1
                ? '1 gravação futura será cancelada e o horário volta a ficar livre.'
                : `${futureBookings} gravações futuras serão canceladas e os horários voltam a ficar livres.`);
        }
        if (pendingPayments > 0) {
            out.push(pendingPayments === 1
                ? `1 cobrança pendente (${formatBRL(pendingAmount)}) será anulada e deixa de ser cobrada.`
                : `${pendingPayments} cobranças pendentes (${formatBRL(pendingAmount)}) serão anuladas e deixam de ser cobradas.`);
        }
        if (activeContracts > 0 || futureBookings > 0) {
            out.push('Nada do que já foi pago é estornado automaticamente. Se houver devolução, faça antes de excluir: os dados de contato do cliente serão apagados.');
        }
        if (p.accessories.autoChargeEnabled) out.push('A cobrança automática no cartão será desligada.');
        if (p.accessories.savedCards > 0) out.push(`${n(p.accessories.savedCards, 'cartão salvo será removido', 'cartões salvos serão removidos')}.`);
        out.push(p.preserved.paidPayments > 0
            ? `O histórico de ${n(p.preserved.paidPayments, 'pagamento', 'pagamentos')} (${formatBRL(p.preserved.paidAmount)}) continua no financeiro, sem dados pessoais.`
            : 'Contratos e gravações antigos continuam no histórico, sem dados pessoais.');
    }
    out.push('O e-mail e o CPF/CNPJ ficam livres para um novo cadastro.');
    out.push('O acesso do cliente ao app é encerrado na hora, inclusive uma sessão já aberta.');
    return out;
}

/** AUDFIN-04: a prévia diz que falta ao acesso a chave de algo que a exclusão anularia (o DELETE daria 403). */
export function blockedByPermissions(p: Pick<UserDeletionPreview, 'missingPermissions'>): boolean {
    return (p.missingPermissions?.length ?? 0) > 0;
}

/**
 * Fluxo "Excluir cliente" (D3), usado na lista de clientes e na Zona de perigo do perfil:
 * busca a prévia → abre o diálogo de perigo (digitar EXCLUIR) → DELETE. Erro da prévia (400/409)
 * aparece num diálogo de erro; erro do DELETE aparece DENTRO do diálogo de perigo (não é engolido).
 */
export function useDeleteClient() {
    const { showAlert, showConfirm, showToast } = useUI();
    // id do cliente cuja prévia está sendo buscada (o botão mostra "carregando" e ignora cliques repetidos).
    const [previewingId, setPreviewingId] = useState<string | null>(null);
    const inFlight = useRef(false);

    const requestDelete = useCallback(async (
        target: { id: string; name: string },
        onDeleted: (res: DeleteClientResult) => void,
    ) => {
        if (inFlight.current) return;
        inFlight.current = true;
        setPreviewingId(target.id);
        let preview: UserDeletionPreview;
        try {
            preview = (await usersApi.deletionPreview(target.id)).preview;
        } catch (err) {
            showAlert({ type: 'error', title: 'Não é possível excluir', message: getErrorMessage(err) || 'Não foi possível calcular as consequências da exclusão.' });
            return;
        } finally {
            inFlight.current = false;
            setPreviewingId(null);
        }

        // AUDFIN-04: a exclusão anularia algo cuja chave o acesso não tem (cancelar contrato, decidir a multa, dar baixa)
        // — o DELETE responderia 403. A prévia já diz isso: o diálogo de perigo nem abre.
        if (blockedByPermissions(preview)) {
            showAlert({ type: 'error', title: 'Não é possível excluir', message: preview.blockedMessage || 'Excluir este cliente exige outras permissões.' });
            return;
        }

        const name = preview.name || target.name;
        showConfirm({
            tone: 'danger',
            icon: Trash2,
            title: `Excluir ${name}?`,
            message: preview.mode === 'hard'
                ? 'Nada no histórico do estúdio depende deste cadastro.'
                : 'Este cliente tem histórico no estúdio. O cadastro fica marcado como excluído e os dados pessoais (e-mail, CPF/CNPJ, telefone, endereço, foto, redes sociais e notas) são apagados; o nome fica no histórico.',
            consequences: buildDeletionConsequences(preview),
            confirmLabel: 'Excluir cliente',
            loadingLabel: 'Excluindo…',
            requireText: 'EXCLUIR',
            // Sem try/catch: um 400/409/500 do DELETE sobe e aparece dentro do diálogo.
            onConfirm: async () => {
                const res: DeleteClientResult = await usersApi.remove(target.id);
                const paidLate = res.paidDuringDeletion?.payments ?? 0;
                // O modo real vem do DELETE: um vínculo criado depois da prévia troca "apagar de vez"
                // por "anonimizar" (e vice-versa) — o aviso não pode contradizer o que aconteceu.
                const modeChanged = res.softDeleted !== (preview.mode === 'soft');
                if (paidLate > 0 || modeChanged) {
                    const lead = !modeChanged ? ''
                        : res.softDeleted
                            ? 'Durante a exclusão surgiu um vínculo (ex.: uma reserva ou um pagamento), então o cadastro foi anonimizado em vez de apagado de vez. '
                            : 'Os vínculos do cliente deixaram de existir antes da confirmação, então o cadastro foi apagado de vez. ';
                    showAlert({
                        type: 'warning',
                        title: paidLate > 0 ? 'Cliente excluído — confira o pagamento recebido' : 'Cliente excluído',
                        message: `${lead}${res.message || 'Cliente excluído.'}`,
                    });
                } else {
                    showToast(res.message || 'Cliente excluído.');
                }
                // Já excluído: uma falha de atualização da tela não pode virar "erro" no diálogo.
                try { onDeleted(res); } catch (err) { console.error(err); }
            },
        });
    }, [showAlert, showConfirm, showToast]);

    return { requestDelete, previewingId };
}
