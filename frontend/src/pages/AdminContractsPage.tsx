import { getErrorMessage } from '../utils/errors';
import { useState, useId, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { contractsApi, stripeApi, ApiError, Contract, ContractStatus } from '../api/client';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { useUI } from '../context/UIContext';
import { FileText, Search, X, Inbox, Link2, FolderOpen, FolderSymlink, Pencil, CircleDollarSign, HandCoins, Banknote, Ban, RefreshCw, Pause, Play, CreditCard, Sparkles, Loader2, Clock, UserX, Lock } from 'lucide-react';
import { usePermission } from '../hooks/usePermission';
import BottomSheetModal from '../components/BottomSheetModal';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import ChargeNowSheet from '../components/admin/ChargeNowSheet';
import BrandLoader from '../components/ui/BrandLoader';
import { HeroSkeleton, TableSkeleton } from '../components/ui/SkeletonLoader';
import StatusBadge from '../components/ui/StatusBadge';
import Tooltip from '../components/ui/Tooltip';
import { CONTRACT_STATUS_META, CONTRACT_TYPE_META, TIER_META, getMeta } from '../constants/adminMeta';
import { getPaymentMethods, getBoletoMethodConfig, getPaymentBadge, getBoletoStatus, isBoletoAvailable, loadPaymentMethods, usePaymentMethodsVersion } from '../constants/paymentMethods';
import { useAdminContracts } from '../hooks/useAdminContracts';
import { describeContractTerms, isAvulsoContract } from '../utils/contractStatus';
import { formatBRL } from '../utils/format';
import CreateContractModal from '../components/admin/contracts/CreateContractModal';
import CustomContractModal from '../components/admin/contracts/CustomContractModal';
import { cancelContractConsequences, contractCancelBlockReason, contractDecideBlockReason, pauseContractConsequences, sessionChargeLines } from '../components/admin/contracts/contractCancelRules';

/** Status que o admin pode escolher no "Editar" (espelha updateContractSchema do backend). */
const EDITABLE_STATUSES: readonly ContractStatus[] = ['ACTIVE', 'COMPLETED', 'EXPIRED', 'CANCELLED'];

/** Selo do contrato de cliente excluído (D3) — mesmas cores do selo "Excluído" do perfil. */
const DELETED_CLIENT_META = { label: 'Cliente excluído', color: 'var(--danger)', bg: 'var(--danger-bg)', icon: UserX };

/**
 * D3: GET /contracts traz user.deletedAt. Cliente excluído (anonimizado) não ganha obrigação nova:
 * a lista esconde Renovar/Pausar/Retomar/Cobrar multa e o "Editar" não reativa (o backend recusa 409).
 */
const isClientDeleted = (c: Contract) => !!(c.user as { deletedAt?: string | null } | undefined)?.deletedAt;

/** Instante (ISO) → data no fuso do estúdio. Para carimbos de data/hora (cancelledAt), não para datas @db.Date. */
const fmtDateSP = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

/** E13: a multa de cancelamento gerada ainda está em aberto (o admin pode "Cobrar agora"). */
const isFineOpen = (c: Contract) => c.cancellationFine?.status === 'PENDING' || c.cancellationFine?.status === 'FAILED';

/** Junta itens em português: "a", "a e b", "a, b e c". */
const joinPt = (items: string[]) => items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;

/** Campo travado no "Editar" (sem a permissão): em cinza — o CSS global não estiliza `.form-input:disabled`. */
const lockedField = (locked: boolean): React.CSSProperties | undefined => (locked ? { opacity: 0.5, cursor: 'not-allowed' } : undefined);

/** Resposta da API que deixou a lista defasada (o servidor recusou com base no estado atual): recarregar. */
const isStaleListError = (err: unknown) => err instanceof ApiError && [400, 403, 409].includes(err.status);

/** Cobrança da multa aberta no ChargeNowSheet (E13 — "Cobrar agora"). */
interface FineCharge {
    paymentId: string;
    amount: number;
    contractName: string;
    /** Forma de pagamento do contrato: a aba que abre primeiro no checkout. */
    initialMethod: Contract['paymentMethod'];
    client: { id: string; name?: string | null; cpfCnpj?: string | null };
}

export default function AdminContractsPage() {
    const uid = useId();
    const navigate = useNavigate();
    const { showConfirm, showToast, showAlert } = useUI();
    // Equipe (D2/D3): cada botão segue a sua chave — o servidor é a autoridade (403 PERMISSION_DENIED).
    const { can } = usePermission();
    const canCreate = can('contratos.criar');           // Novo e Personalizado
    // MAT-01: Renovar exige também a baixa manual — a renovação não gera parcelas (o servidor exige as duas).
    const canRenew = canCreate && can('cobrancas.baixa');
    const canEdit = can('contratos.editar');          // término, link, forma, ACTIVE/COMPLETED/EXPIRED, pausar/retomar
    const canConditions = can('contratos.condicoes');   // créditos FLEX (e serviços, no detalhe)
    const canCancel = can('contratos.cancelar');        // Cancelar contrato / status Cancelado
    const canDecideFine = can('contratos.multa');       // Cobrar/Isentar multa e qualquer mudança em PENDING_CANCELLATION
    const canSettleCharges = can('cobrancas.baixa');    // anular cobrança em aberto (R5): cancelar avulso, pausar Fixo
    /**
     * ATU5-03/AUDFIN6-01 (espelho do DELETE/PATCH /contracts/:id): cancelar o contrato anula a cobrança de sessão em
     * aberto (o avulso inteiro; nos outros tipos, a cobrança própria de uma gravação). Sem a baixa e com ela (contagem
     * conhecida > 0), o servidor recusa (403): a tela não oferece o status Cancelado e o botão "Cancelar contrato" fica
     * travado com o motivo (TELA6-05). Contagem ausente não trava (o 403 aparece no diálogo). Devolve o motivo ou null.
     */
    const cancelBlockReason = (c: Contract) => contractCancelBlockReason(c, canSettleCharges);
    /** ATU6-02 (espelho do resolve-cancellation): decidir o pedido anula o mesmo — sem a baixa, a decisão fica travada. */
    const decideBlockReason = (c: Contract) => contractDecideBlockReason(c, canSettleCharges);
    const canCharge = can('cobrancas.cobrar');          // "Cobrar multa agora"
    const canOpenClient = can('clientes.ver');          // link para o perfil do cliente
    const {
        contracts,
        users,
        pricing,
        loading,
        refreshing,
        filter, setFilter,
        search, setSearch,
        reload,
    } = useAdminContracts();

    const [showCreate, setShowCreate] = useState(false);


    const [editContract, setEditContract] = useState<Contract | null>(null);
    const [editForm, setEditForm] = useState({ status: '', endDate: '', flexCreditsRemaining: '', contractUrl: '', paymentMethod: '' });
    const [editError, setEditError] = useState('');
    // E3: o Boleto só é oferecido como forma com a chave-mestra ligada E a Cora ativa — fonte ÚNICA:
    // isBoletoAvailable() (constants/paymentMethods). Enquanto a API não respondeu, o Boleto fica de fora.
    // A página revalida o estado ao montar e ao abrir o "Editar" (se falhar, mantém o último estado conhecido)
    // e re-renderiza quando ele muda.
    usePaymentMethodsVersion();
    const refreshBoleto = useCallback(() => { void loadPaymentMethods(); }, []);
    useEffect(() => { refreshBoleto(); }, [refreshBoleto]);

    // E13: "Cobrar agora" da multa de cancelamento (PIX/cartão com o cliente presente).
    const [fineCharge, setFineCharge] = useState<FineCharge | null>(null);
    const [fineChargeError, setFineChargeError] = useState('');
    const [fineChargeLoadingId, setFineChargeLoadingId] = useState<string | null>(null);
    // D3: "Editar" → status Cancelado passa pela confirmação de perigo; enquanto ela está aberta o
    // modal de edição não fecha pelo Esc (o Esc fecha só a confirmação).
    const [confirmingEditCancel, setConfirmingEditCancel] = useState(false);

    // --- Custom Contract Wizard ---
    const [showCustom, setShowCustom] = useState(false);

    const { get: getRule } = useBusinessConfig();
    const ep3 = getRule('episodes_3months');
    const ep6 = getRule('episodes_6months');
    const cancFine = getRule('cancellation_fine_pct');

    const submitEdit = async (contract: Contract, data: Record<string, unknown>) => {
        const res = await contractsApi.update(contract.id, data);
        setEditContract(null);
        await reload();
        return res;
    };

    /**
     * Status que ESTA pessoa pode escolher no "Editar" (além do atual). Espelha requiredForContractPatch:
     * Cancelado → contratos.cancelar; Ativo/Concluído/Expirado → contratos.editar; e, com o pedido de
     * cancelamento em análise, qualquer mudança de status decide a multa → também contratos.multa; reabrir
     * um contrato CANCELADO (sair de Cancelado) exige também contratos.cancelar e contratos.condicoes
     * (MAT-03/DIN-04: devolve créditos e sessões sem parcela em aberto).
     */
    const statusTargetsFor = (c: Contract): ContractStatus[] => {
        if (c.status === 'PENDING_CANCELLATION' && !canDecideFine) return [];
        if (c.status === 'CANCELLED' && !(canCancel && canConditions)) return [];
        return EDITABLE_STATUSES.filter(s => s !== c.status && (s === 'CANCELLED' ? canCancel && !cancelBlockReason(c) : canEdit));
    };
    /** Créditos FLEX editáveis (contratos.condicoes; nunca para cliente excluído). */
    const creditsEditable = (c: Contract) => c.type === 'FLEX' && canConditions && !isClientDeleted(c);
    /** O lápis só aparece se houver algo que a pessoa possa mudar no formulário. */
    const canOpenEdit = (c: Contract) => canEdit || creditsEditable(c) || statusTargetsFor(c).length > 0;

    const handleEdit = async () => {
        if (!editContract) return;
        setEditError('');
        try {
            const data: any = {};
            // Só envia o que MUDOU (a permissão é conferida por campo alterado — requiredForContractPatch).
            // Status: o PATCH aceita apenas ACTIVE/COMPLETED/EXPIRED/CANCELLED, então reenviar o atual de um
            // contrato Pausado/Pend. cancelamento/Aguard. pagamento dava 400.
            if (editForm.status && editForm.status !== editContract.status) data.status = editForm.status;
            if (editForm.endDate && editForm.endDate !== editContract.endDate.split('T')[0]) data.endDate = editForm.endDate;
            if (editForm.flexCreditsRemaining !== '' && editForm.flexCreditsRemaining !== (editContract.flexCreditsRemaining?.toString() || '')) {
                data.flexCreditsRemaining = Number(editForm.flexCreditsRemaining);
            }
            if (editForm.contractUrl !== (editContract.contractUrl || '')) data.contractUrl = editForm.contractUrl;
            if (editForm.paymentMethod && editForm.paymentMethod !== (editContract.paymentMethod || '')) data.paymentMethod = editForm.paymentMethod;
            // Nada mudou: fecha sem chamar a API.
            if (Object.keys(data).length === 0) { setEditContract(null); return; }
            // Mudar para Cancelado pelo "Editar" faz o MESMO que "Cancelar contrato" no backend (anula
            // parcelas, encerra a recorrência, cancela as gravações de hoje em diante) → confirmação danger.
            if (data.status === 'CANCELLED') {
                const c = editContract;
                setConfirmingEditCancel(true);
                showConfirm({
                    tone: 'danger',
                    icon: Ban,
                    title: 'Cancelar este contrato?',
                    message: `“${c.name}”${clientLabel(c)} será encerrado ao salvar. As demais alterações deste formulário são salvas junto.`,
                    consequences: [
                        ...cancelContractConsequences(c, { canSettleCharges }),
                        ...(c.status === 'PENDING_CANCELLATION'
                            ? ['O cliente pediu o cancelamento: salvar como Cancelado equivale a isentar a multa (para cobrá-la, use “Cobrar multa” na lista).']
                            : []),
                    ],
                    confirmLabel: 'Salvar e cancelar contrato',
                    cancelLabel: 'Voltar à edição',
                    // O erro do PATCH aparece dentro do diálogo. 409 CONTRACT_STATUS_CHANGED (o status mudou
                    // entre abrir e salvar, ex.: o cliente pediu o cancelamento): nada foi gravado — fecha o
                    // "Editar" e recarrega a lista por trás do diálogo.
                    onConfirm: async () => {
                        const res = await submitEdit(c, data).catch(async (err: unknown) => {
                            if (err instanceof ApiError && err.code === 'CONTRACT_STATUS_CHANGED') {
                                setEditContract(null);
                                setConfirmingEditCancel(false);
                                await reload();
                            }
                            throw err;
                        });
                        setConfirmingEditCancel(false);
                        // Mesmo aviso do botão “Cancelar contrato”: cobrança já paga / não cancelável no banco fica NA TELA.
                        announceCancellation(res);
                    },
                    onCancel: () => setConfirmingEditCancel(false),
                });
                return;
            }
            await submitEdit(editContract, data);
        } catch (err: unknown) {
            // O status do contrato mudou entre abrir e salvar (ex.: o cliente pediu o cancelamento) — nada foi
            // gravado. Fecha o formulário velho e recarrega a lista.
            if (err instanceof ApiError && err.code === 'CONTRACT_STATUS_CHANGED') {
                setEditContract(null);
                showToast({ message: err.message || 'O status deste contrato mudou. Confira e edite de novo.', type: 'error' });
                await reload();
                return;
            }
            // E3: o boleto foi desligado (ou a Cora desativada) entre abrir o modal e salvar — nada foi gravado.
            if (err instanceof ApiError && err.code === 'BOLETO_UNAVAILABLE') {
                setEditError(`${err.message || 'O pagamento por boleto não está disponível.'} Escolha PIX ou Cartão.`);
                setEditForm(f => ({ ...f, paymentMethod: editContract.paymentMethod || '' }));
                refreshBoleto();
                return;
            }
            setEditError(getErrorMessage(err));
        }
    };

    const openEdit = (c: Contract) => {
        setEditContract(c);
        setEditForm({ status: c.status, endDate: c.endDate.split('T')[0], flexCreditsRemaining: c.flexCreditsRemaining?.toString() || '', contractUrl: c.contractUrl || '', paymentMethod: c.paymentMethod || '' });
        setEditError('');
        refreshBoleto();
    };

    // D3 — confirmações com o que o backend faz DE FATO (contract.lifecycle.ts). Com `tone`, o
    // diálogo aguarda o onConfirm e mostra o erro dentro dele: por isso nada de try/catch aqui.
    function clientLabel(c: Contract) { return c.user?.name ? ` de ${c.user.name}` : ''; }
    // O que o cancelamento faz: cancelContractConsequences (components/admin/contracts/contractCancelRules).

    /**
     * Resultado de um cancelamento (DELETE, resolve-cancellation ou PATCH status CANCELLED). Quando o banco confirmou uma cobrança como
     * paga, ou não deixou cancelar uma cobrança já emitida, o aviso fica NA TELA (o toast some em 4 s) — a
     * `message` do backend já traz o texto desses casos.
     */
    function announceCancellation(res: { message?: string; paidAtProvider?: number; liveAtProvider?: number }) {
        const message = res.message || 'Contrato cancelado.';
        if ((res.paidAtProvider ?? 0) > 0 || (res.liveAtProvider ?? 0) > 0) {
            showAlert({ type: 'warning', title: 'Contrato cancelado — confira as cobranças', message });
        } else {
            showToast(message);
        }
    }

    const handleCancel = (c: Contract) => {
        showConfirm({
            tone: 'danger',
            icon: Ban,
            title: 'Cancelar este contrato?',
            message: `“${c.name}”${clientLabel(c)} será encerrado agora.`,
            consequences: cancelContractConsequences(c, { canSettleCharges }),
            confirmLabel: 'Cancelar contrato',
            cancelLabel: 'Manter contrato',
            onConfirm: async () => {
                try {
                    const res = await contractsApi.cancel(c.id);
                    await reload();
                    announceCancellation(res);
                } catch (err: unknown) {
                    // 400/409 = a lista estava defasada (ex.: “Contrato já está cancelado.”); 403 = o contrato
                    // passou a ter pedido de cancelamento (decidir a multa exige outra permissão): recarrega
                    // ANTES de o erro aparecer no diálogo, para a linha não continuar oferecendo a ação.
                    if (isStaleListError(err)) await reload();
                    throw err;
                }
            },
        });
    };

    // E13 — decide o pedido de cancelamento. 409 = o pedido já foi resolvido (lista defasada, outra aba/admin ou
    // duplo clique — code CANCELLATION_NOT_PENDING): não há o que corrigir, então avisa, recarrega e fecha o
    // diálogo. 400 = a lista também pode estar defasada: recarrega e o erro aparece DENTRO do diálogo, como os demais.
    const runResolveCancel = async (c: Contract, action: 'CHARGE_FEE' | 'WAIVE_FEE') => {
        try {
            const res = await contractsApi.resolveCancellation(c.id, action);
            await reload();
            announceCancellation(res);
        } catch (err: unknown) {
            if (err instanceof ApiError && err.status === 409) {
                await reload();
                showToast({ message: err.message || 'Este pedido de cancelamento já foi resolvido.', type: 'error' });
                return;
            }
            if (err instanceof ApiError && err.status === 400) await reload();
            throw err;
        }
    };

    const handleResolveCancel = (c: Contract, action: 'CHARGE_FEE' | 'WAIVE_FEE') => {
        const common = [
            'O contrato passa a Cancelado (as gravações que ainda não tinham acontecido já foram liberadas quando o cliente pediu o cancelamento).',
            'As parcelas pendentes são anuladas: a cobrança já emitida (QR PIX, boleto ou cartão em aberto) é cancelada no banco antes.',
            ...sessionChargeLines(c, canSettleCharges, 'decide'),
        ];
        // Multa do pedido (vem em GET /contracts): o % congelado no pedido sobre a base EFETIVA — as parcelas da
        // base ainda não pagas (parcela paga durante a análise sai; a multa nunca aumenta).
        const pct = c.finePct ?? cancFine;
        const fineKnown = typeof c.fineAmountPreview === 'number';
        const fineAmount = c.fineAmountPreview ?? 0;
        if (action === 'CHARGE_FEE') {
            if (fineKnown && fineAmount <= 0) {
                // Sem saldo a pagar do plano (ex.: à vista quitado) → o backend cancela sem gerar cobrança.
                showConfirm({
                    tone: 'danger',
                    icon: CircleDollarSign,
                    title: 'Não haverá multa neste cancelamento',
                    message: `Não falta nada a pagar do plano em “${c.name}”${clientLabel(c)}, e a multa é ${pct}% do que falta pagar.\nConfirmar encerra o contrato sem gerar cobrança.`,
                    consequences: [
                        'Nenhuma cobrança de multa é gerada (multa: R$ 0,00).',
                        ...common,
                        'Nada do que já foi pago é devolvido automaticamente.',
                    ],
                    confirmLabel: 'Cancelar sem multa',
                    onConfirm: () => runResolveCancel(c, action),
                });
                return;
            }
            showConfirm({
                tone: 'danger',
                icon: CircleDollarSign,
                title: 'Cobrar a multa de cancelamento?',
                message: fineKnown
                    ? (
                        <>
                            <strong style={{ color: 'var(--text-primary)' }}>Multa: {formatBRL(fineAmount)}</strong>
                            {` — ${pct}% de ${formatBRL(c.fineBaseAmount ?? 0)} que faltavam pagar.\n`}
                            {`Encerra “${c.name}”${clientLabel(c)}.`}
                        </>
                    )
                    : `Encerra “${c.name}”${clientLabel(c)} com a multa de ${pct}% sobre o que faltava pagar do plano.`,
                consequences: [
                    `É gerada a cobrança “Multa de cancelamento”${fineKnown ? ` de ${formatBRL(fineAmount)}` : ''}, que fica pendente: o cliente é avisado e paga em Meus Pagamentos (PIX ou cartão).`,
                    // TELA-3: "Cobrar multa agora" (lista e detalhe) exige cobrancas.cobrar — sem ela, não citar o botão.
                    canCharge
                        ? 'Com o cliente presente, use “Cobrar multa agora” (na lista ou dentro do contrato). Ela não é cobrada sozinha no cartão salvo, mesmo com a cobrança automática ligada.'
                        : 'A multa fica pendente para o cliente pagar pelo app (cobrar no balcão exige “Cobrar o cliente”). Ela não é cobrada sozinha no cartão salvo, mesmo com a cobrança automática ligada.',
                    ...common,
                ],
                confirmLabel: 'Cobrar multa e cancelar',
                onConfirm: () => runResolveCancel(c, action),
            });
            return;
        }
        showConfirm({
            tone: 'warning',
            icon: HandCoins,
            title: 'Isentar a multa de cancelamento?',
            message: fineKnown && fineAmount > 0
                ? `Aceita o cancelamento de “${c.name}”${clientLabel(c)} sem cobrar a multa de ${formatBRL(fineAmount)}.`
                : `Aceita o cancelamento de “${c.name}”${clientLabel(c)} sem cobrar multa.`,
            consequences: [
                'Nenhuma multa é gerada; o cliente é avisado de que o contrato foi cancelado sem multa.',
                ...common,
            ],
            confirmLabel: 'Isentar multa e cancelar',
            onConfirm: () => runResolveCancel(c, action),
        });
    };

    // E13 — "Cobrar agora" da multa em aberto. A lista não traz o CPF do cliente: busca o PAGADOR da cobrança
    // (E1: o PIX usa o CPF do CLIENTE, nunca o do admin). Se essa busca falhar, o sheet abre do mesmo jeito e o
    // próprio checkout resolve o CPF.
    const openFineCharge = async (c: Contract) => {
        const fine = c.cancellationFine;
        if (!fine || !c.user || fineChargeLoadingId) return;
        setFineChargeError('');
        setFineChargeLoadingId(c.id);
        let client: FineCharge['client'] = { id: c.user.id, name: c.user.name };
        try {
            const { payer } = await stripeApi.paymentMethodsForPayment(fine.id);
            client = { id: payer.id, name: payer.name, cpfCnpj: payer.cpfCnpj };
        } catch (err: unknown) {
            // 404 = a cobrança não existe mais (lista desatualizada): recarrega em vez de abrir um sheet sem saída.
            if (err instanceof ApiError && err.status === 404) {
                setFineChargeLoadingId(null);
                showToast({ message: 'Esta multa não está mais disponível para cobrança.', type: 'error' });
                await reload();
                return;
            }
        }
        setFineChargeLoadingId(null);
        setFineCharge({ paymentId: fine.id, amount: fine.amount, contractName: c.name, initialMethod: c.paymentMethod ?? null, client });
    };

    // E4 — confirmação neutra (legado). O botão só aparece com c.canRenew; se mesmo assim o backend recusar
    // (lista desatualizada: já renovado por outro admin), mostra o motivo e recarrega.
    const handleRenew = (c: Contract) => {
        showConfirm({
            title: 'Renovar Contrato',
            message: `Renovar "${c.name}" por mais 3 meses?`,
            onConfirm: async () => {
                try {
                    const r = await contractsApi.renew(c.id, { durationMonths: 3 });
                    showToast(r.message);
                } catch (e: unknown) {
                    showToast({ message: getErrorMessage(e) || 'Erro ao renovar o contrato.', type: 'error' });
                }
                reload();
            },
        });
    };

    // Pausar é reversível (warning). O backend só cancela gravações futuras do FIXO (a retomada
    // recria as do dia/horário fixo); FLEX/CUSTOM mantêm as sessões já agendadas.
    const handlePause = (c: Contract) => {
        showConfirm({
            tone: 'warning',
            icon: Pause,
            title: 'Pausar este contrato?',
            message: `“${c.name}”${clientLabel(c)} fica pausado até você retomar.`,
            // TELA6-04: o que o servidor faz de fato (só a extra fica; a cobrada à parte dentro do plano é cancelada).
            consequences: pauseContractConsequences(c, { canSettleCharges }),
            confirmLabel: 'Pausar contrato',
            onConfirm: async () => {
                const r = await contractsApi.pause(c.id, { reason: 'Pausa administrativa' });
                showToast(r.message);
                await reload();
            },
        });
    };

    const statusFiltered = filter === 'ALL' ? contracts : contracts.filter(c => c.status === filter);
    const filtered = search.trim().length >= 3
        ? statusFiltered.filter(c => {
            const q = search.toLowerCase();
            return (c.user?.name || '').toLowerCase().includes(q) || c.name.toLowerCase().includes(q);
        })
        : statusFiltered;
    const episodeCount = (months: number) => months === 3 ? ep3 : ep6;
    // L6: episodeCount só cobre 3/6 meses — para AVULSO (durationMonths=1) caía no ramo ep6 (24) errado.
    // Deriva do TIPO: AVULSO = 1 gravação; CUSTOM = totalSessions real; demais = episódios do plano por duração.
    const contractEpisodes = (c: { type: string; durationMonths: number; totalSessions?: number | null }) =>
        isAvulsoContract(c) ? 1 : c.type === 'CUSTOM' ? (c.totalSessions ?? episodeCount(c.durationMonths)) : episodeCount(c.durationMonths);

    // E4: `daysToEnd` vem do backend (dias de calendário em SP; negativo = vigência encerrada) — a mesma conta
    // que decide `canRenew`, para o selo "Vence em Nd" e o botão Renovar nunca discordarem. A conta local
    // fica só como reserva (resposta sem o campo).
    const getDaysToExpiry = (c: Contract) => {
        if (typeof c.daysToEnd === 'number') return c.daysToEnd;
        return Math.ceil((new Date(c.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    };

    // Vencimento só vale para PLANOS ativos ou concluídos (o concluído continua renovável — D6).
    // O AVULSO é uma sessão única e nunca "vence" (mesma regra do alerta de expiração do backend).
    const tracksExpiry = (c: Contract) => (c.status === 'ACTIVE' || c.status === 'COMPLETED') && !isAvulsoContract(c);

    const getVencimentoBadge = (c: Contract) => {
        if (!tracksExpiry(c)) return null;
        const days = getDaysToExpiry(c);
        if (days < 0) return { label: 'Vigência encerrada', color: '#6b7280', bg: 'rgba(107,114,128,0.15)' };
        if (days === 0) return { label: 'Vence hoje', color: '#dc2626', bg: 'rgba(220,38,38,0.15)' };
        if (days <= 7) return { label: `Vence em ${days}d`, color: '#dc2626', bg: 'rgba(220,38,38,0.15)' };
        if (days <= 30) return { label: `Vence em ${days}d`, color: '#d97706', bg: 'rgba(217,119,6,0.15)' };
        return null;
    };

    // KPI computations
    const activeContracts = contracts.filter(c => c.status === 'ACTIVE');
    const totalFlexCredits = activeContracts.reduce((sum, c) => sum + (c.flexCreditsRemaining || 0), 0);
    const expiringIn30 = contracts.filter(c => tracksExpiry(c) && getDaysToExpiry(c) <= 30 && getDaysToExpiry(c) >= 0).length;
    const pendingCancellation = contracts.filter(c => c.status === 'PENDING_CANCELLATION').length;

    // E3 — formas oferecidas no "Editar": Boleto só com isBoletoAvailable() (chave-mestra + Cora). A liberação
    // por contrato ("Permitir boleto neste contrato") deixou de existir.
    const boletoAvailable = isBoletoAvailable();
    const boleto = getBoletoStatus();
    const editMethodOptions = (() => {
        const base = getPaymentMethods().filter(pm => pm.key !== 'BOLETO');
        return boletoAvailable ? [...base, getBoletoMethodConfig()] : base;
    })();

    // "Editar" — o que ESTA pessoa pode mudar no contrato aberto (os demais campos ficam em cinza).
    const editTargets = editContract ? statusTargetsFor(editContract) : [];
    const editCreditsOk = !!editContract && creditsEditable(editContract);
    const editPendingLocked = editContract?.status === 'PENDING_CANCELLATION' && !canDecideFine;
    const editCancelledLocked = editContract?.status === 'CANCELLED' && !(canCancel && canConditions);
    // ATU5-03/AUDFIN6-01: cobrança de sessão em aberto e sem a baixa — o Cancelado sai das opções (o servidor recusa com 403).
    const editCancelBlockReason = editContract && canCancel ? cancelBlockReason(editContract) : null;
    const editLockNote = (() => {
        if (!editContract) return null;
        const isFlex = editContract.type === 'FLEX';
        const statusFull = canEdit && canCancel && !editPendingLocked && !editCancelledLocked && !editCancelBlockReason;
        const locked = !statusFull || !canEdit || (isFlex && !canConditions);
        if (!locked) return null;
        const parts = [
            editTargets.length > 0 ? (statusFull ? 'o status' : `o status (para ${joinPt(editTargets.map(s => getMeta(CONTRACT_STATUS_META, s).label))})`) : '',
            canEdit ? 'o término, o link e a forma de pagamento' : '',
            isFlex && editCreditsOk ? 'os créditos' : '',
        ].filter(Boolean);
        const base = parts.length > 0
            ? `Com o seu acesso, dá para alterar só ${joinPt(parts)}. Os campos em cinza exigem outra permissão.`
            : 'Com o seu acesso, nenhum campo deste contrato pode ser alterado.';
        if (editCancelledLocked) return `${base} Reabrir um contrato cancelado exige “Cancelar contrato” e “Mudar créditos, serviços e condições de pagamento”.`;
        if (editCancelBlockReason) return `${base} ${editCancelBlockReason}`;
        return base;
    })();

    if (loading) return <div><HeroSkeleton /><TableSkeleton rows={6} cols={7} /></div>;

    return (
        <div>
            {/* --- HEADER --- */}
            <AdminPageHeader
                icon={FileText}
                title="Contratos"
                subtitle="Gestão do ciclo de vida dos contratos"
                actions={canCreate ? (
                    <>
                        <button className="btn-admin-go" onClick={() => { setShowCreate(true); }}>
                            <span style={{ fontSize: '1.1rem' }} aria-hidden="true">+</span> Novo Contrato
                        </button>
                        <button onClick={() => { setShowCustom(true); }}
                            style={{
                                display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 24px', borderRadius: '12px', fontWeight: 700,
                                background: 'linear-gradient(135deg, rgba(45,212,191,0.15), rgba(59,130,246,0.1))',
                                border: '1px solid rgba(45,212,191,0.3)', color: 'var(--accent-text)', cursor: 'pointer',
                                fontSize: '0.875rem', transition: 'background 0.2s ease, border-color 0.2s ease',
                            }}>
                            <Sparkles size={16} aria-hidden="true" /> Contrato Personalizado
                        </button>
                    </>
                ) : undefined}
            />

            {/* --- KPI CARDS --- */}
            <div className="admin-kpi-grid" style={{ marginBottom: '24px' }}>
                {/* Active */}
                <button type="button" onClick={() => setFilter('ACTIVE')} aria-pressed={filter === 'ACTIVE'}
                    className={`admin-kpi-card${filter === 'ACTIVE' ? ' admin-kpi-card--success' : ''}`}>
                    <div className="admin-kpi-card__label" style={{ color: 'var(--success)' }}>Ativos</div>
                    <div className="admin-kpi-card__value">{activeContracts.length}</div>
                    <div className="admin-kpi-card__caption">contratos em vigor</div>
                </button>
                {/* Pending Cancellation */}
                <button type="button" onClick={() => setFilter('PENDING_CANCELLATION')} aria-pressed={filter === 'PENDING_CANCELLATION'}
                    className="admin-kpi-card"
                    style={filter === 'PENDING_CANCELLATION' ? { background: 'linear-gradient(135deg, rgba(245,158,11,0.12), rgba(120,53,15,0.08))', borderColor: 'rgba(245,158,11,0.3)' } : undefined}>
                    <div className="admin-kpi-card__label" style={{ color: 'var(--warning)' }}>Pend. Cancelamento</div>
                    <div className="admin-kpi-card__value" style={pendingCancellation > 0 ? { color: 'var(--warning)' } : undefined}>{pendingCancellation}</div>
                    <div className="admin-kpi-card__caption">a resolver</div>
                </button>
                {/* Flex Credits */}
                <div className="admin-kpi-card">
                    <div className="admin-kpi-card__label" style={{ color: 'var(--accent-text)' }}>Créditos Flex</div>
                    <div className="admin-kpi-card__value">{totalFlexCredits}</div>
                    <div className="admin-kpi-card__caption">episódios restantes</div>
                </div>
                {/* Expiring */}
                <div className={`admin-kpi-card${expiringIn30 > 0 ? ' admin-kpi-card--danger' : ''}`}>
                    <div className="admin-kpi-card__label" style={expiringIn30 > 0 ? { color: 'var(--danger)' } : undefined}>Vencendo (30d)</div>
                    <div className="admin-kpi-card__value" style={expiringIn30 > 0 ? { color: 'var(--danger)' } : undefined}>{expiringIn30}</div>
                    <div className="admin-kpi-card__caption">atenção necessária</div>
                </div>
                {/* Total */}
                <button type="button" onClick={() => setFilter('ALL')} aria-pressed={filter === 'ALL'}
                    className={`admin-kpi-card${filter === 'ALL' ? ' admin-kpi-card--accent' : ''}`}>
                    <div className="admin-kpi-card__label">Total</div>
                    <div className="admin-kpi-card__value">{contracts.length}</div>
                    <div className="admin-kpi-card__caption">todos os contratos</div>
                </button>
            </div>

            {/* --- SEARCH + FILTERS --- */}
            <div className="admin-filter-bar admin-filter-bar--panel">
                <div className="admin-search">
                    <input
                        type="text" placeholder="Buscar por projeto ou cliente..."
                        aria-label="Buscar por projeto ou cliente"
                        value={search} onChange={e => setSearch(e.target.value)}
                    />
                    <Search size={14} className="admin-search__icon" aria-hidden="true" />
                </div>
                {search && (
                    <Tooltip content="Limpar busca" describe={false}>
                        <button onClick={() => setSearch('')} aria-label="Limpar busca"
                            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem', minWidth: 36, minHeight: 36 }}><X size={16} aria-hidden="true" /></button>
                    </Tooltip>
                )}

                <div className="admin-segmented" role="group" aria-label="Filtrar por status">
                    {([
                        { key: 'ALL', label: 'Todos' },
                        { key: 'ACTIVE', label: 'Ativos' },
                        { key: 'AWAITING_PAYMENT', label: 'Aguard. pagamento' },
                        { key: 'PAUSED', label: 'Pausados' },
                        { key: 'COMPLETED', label: 'Concluídos' },
                        { key: 'EXPIRED', label: 'Expirados' },
                        { key: 'CANCELLED', label: 'Cancelados' },
                    ] as const).map(s => (
                        <button key={s.key}
                            onClick={() => setFilter(s.key)}
                            aria-pressed={filter === s.key}
                            className={`admin-segmented__btn${filter === s.key ? ' admin-segmented__btn--active' : ''}`}
                        >
                            {s.label}
                        </button>
                    ))}
                </div>

                {search.trim().length >= 3 && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '4px 10px', background: 'var(--bg-elevated)', borderRadius: '8px' }} aria-live="polite">
                        {filtered.length} resultado{filtered.length !== 1 ? 's' : ''}
                    </span>
                )}

                {/* Recarregamento silencioso (após criar/editar/renovar): a lista continua visível. */}
                {refreshing && (
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center' }}>
                        <BrandLoader size="inline" label="Atualizando…" />
                    </span>
                )}
            </div>

            {/* --- CONTRACTS TABLE --- */}
            <div style={{ borderRadius: '16px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
                {filtered.length === 0 ? (
                    <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                        <Inbox size={44} className="admin-empty__icon" aria-hidden="true" />
                        <div className="admin-empty__title">Nenhum contrato encontrado</div>
                        <div className="admin-empty__hint">Tente ajustar os filtros ou busca</div>
                    </div>
                ) : (
                    <div className="table-container admin-table-wrap" style={{ margin: 0 }}>
                        <table className="admin-table--cards">
                            <thead>
                                <tr>
                                    <th style={{ paddingLeft: '20px' }}>Cliente / Projeto</th>
                                    <th>Tipo</th>
                                    <th>Gravações</th>
                                    <th>Pagamento</th>
                                    <th>Vigência</th>
                                    <th style={{ textAlign: 'center' }}>Status</th>
                                    <th style={{ textAlign: 'center' }}>Ações</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.map((c) => {
                                    const venc = getVencimentoBadge(c);
                                    const clientDeleted = isClientDeleted(c);
                                    // A lista não traz reservas/pagamentos: o avulso mostra a data do contrato (= da gravação).
                                    const terms = describeContractTerms(c, null, null, { dateFormat: 'short' });
                                    // E13 — multa: prevista (pedido em análise, já congelada) ou gerada (pendente/paga).
                                    const fine = c.cancellationFine;
                                    const fineNote = c.status === 'PENDING_CANCELLATION' && typeof c.fineAmountPreview === 'number'
                                        ? (c.fineAmountPreview > 0
                                            ? { text: `Multa prevista: ${formatBRL(c.fineAmountPreview)}`, color: 'var(--warning)' }
                                            : { text: 'Sem multa a cobrar', color: 'var(--text-muted)' })
                                        : fine && isFineOpen(c)
                                            ? { text: `Multa pendente: ${formatBRL(fine.amount)}`, color: 'var(--warning)' }
                                            : fine && fine.status === 'PAID'
                                                ? { text: `Multa paga: ${formatBRL(fine.amount)}`, color: 'var(--success)' }
                                                : null;
                                    return (
                                        <tr key={c.id} className="admin-zebra-row">
                                            {/* Cliente + Projeto merged */}
                                            <td className="admin-card-title" style={{ paddingLeft: '20px' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                    <div style={{
                                                        width: '36px', height: '36px', borderRadius: '10px',
                                                        background: getMeta(TIER_META, c.tier).bg,
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        fontSize: '0.9375rem', flexShrink: 0
                                                    }}>
                                                        {(() => { const TI = getMeta(CONTRACT_TYPE_META, c.type).icon; return <TI size={17} />; })()}
                                                    </div>
                                                    <div>
                                                        {/* O perfil do cliente só abre com "Ver clientes": sem ela, o nome é só texto. */}
                                                        {canOpenClient ? (
                                                            <Tooltip content={c.user?.name ? 'Abrir perfil do cliente' : null}>
                                                                <button
                                                                    style={{ fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', color: 'var(--accent-text)', background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', textAlign: 'left' }}
                                                                    onClick={() => c.user?.id && navigate(`/admin/clients/${c.user.id}`)}>
                                                                    {c.user?.name || '—'}
                                                                </button>
                                                            </Tooltip>
                                                        ) : (
                                                            <span style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text-primary)' }}>{c.user?.name || '—'}</span>
                                                        )}
                                                        {clientDeleted && (
                                                            <div style={{ marginTop: 3 }}>
                                                                <StatusBadge meta={DELETED_CLIENT_META} />
                                                            </div>
                                                        )}
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '1px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                            <Tooltip content="Abrir contrato">
                                                                <button style={{ cursor: 'pointer', background: 'none', border: 'none', padding: 0, color: 'inherit', font: 'inherit', textAlign: 'left' }} onClick={() => navigate(`/admin/contracts/${c.id}`)}>{c.name}</button>
                                                            </Tooltip>
                                                            {c.contractUrl && (
                                                                <Tooltip content="Abrir contrato digital" describe={false}>
                                                                    <a href={c.contractUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-primary)', fontSize: '0.65rem' }} aria-label="Abrir contrato digital"><Link2 size={12} aria-hidden="true" /></a>
                                                                </Tooltip>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </td>

                                            {/* Type + Tier */}
                                            {/* Cada selo fica numa linha própria como conteúdo INLINE: ocupa só a largura do
                                                texto (não estica como item de flex/grid) e acompanha o text-align da célula —
                                                à esquerda na tabela, à direita no card do mobile (admin-table--cards). */}
                                            <td data-label="Tipo">
                                                <div style={{ lineHeight: 0 }}>
                                                    <div><StatusBadge meta={getMeta(CONTRACT_TYPE_META, c.type)} /></div>
                                                    <div style={{ marginTop: 4 }}>
                                                        <span style={{
                                                            display: 'inline-block', lineHeight: 1.5,
                                                            padding: '2px 8px', borderRadius: '6px', fontSize: '0.625rem', fontWeight: 700,
                                                            textTransform: 'uppercase', whiteSpace: 'nowrap',
                                                            background: getMeta(TIER_META, c.tier).bg,
                                                            color: getMeta(TIER_META, c.tier).color,
                                                        }}>
                                                            {getMeta(TIER_META, c.tier).label}
                                                        </span>
                                                    </div>
                                                </div>
                                            </td>

                                            {/* Episodes */}
                                            <td data-label="Gravações">
                                                <div style={{ fontWeight: 700, fontSize: '0.9375rem' }}>{contractEpisodes(c)}</div>
                                                <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                                    {terms.duracao}
                                                </div>
                                                {c.type === 'FLEX' && c.flexCreditsRemaining != null && (
                                                    <div style={{
                                                        marginTop: '4px', fontSize: '0.625rem', fontWeight: 600,
                                                        color: c.flexCreditsRemaining > 0 ? 'var(--success)' : 'var(--danger)',
                                                        display: 'flex', alignItems: 'center', gap: '3px'
                                                    }}>
                                                        <span style={{
                                                            width: '6px', height: '6px', borderRadius: '50%',
                                                            background: c.flexCreditsRemaining > 0 ? 'var(--success)' : 'var(--danger)'
                                                        }} />
                                                        {c.flexCreditsRemaining} restante{c.flexCreditsRemaining !== 1 ? 's' : ''}
                                                    </div>
                                                )}
                                            </td>

                                            {/* Payment */}
                                            <td data-label="Pagamento">
                                                {c.paymentMethod ? (() => {
                                                    const pmBadge = getPaymentBadge(c.paymentMethod);
                                                    return (
                                                        <span style={{
                                                            display: 'inline-flex', alignItems: 'center', gap: '4px',
                                                            padding: '3px 8px', borderRadius: '6px', fontSize: '0.6875rem', fontWeight: 600,
                                                            background: 'var(--bg-elevated)', color: 'var(--text-secondary)'
                                                        }}>
                                                            {pmBadge.emoji}
                                                            {pmBadge.label}
                                                        </span>
                                                    );
                                                })() : <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>—</span>}
                                                <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                                                    {terms.plano}
                                                </div>
                                            </td>

                                            {/* Vigência */}
                                            <td data-label="Vigência">
                                                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                                    {terms.vigencia}
                                                    {/* E13: o contrato cancelado mostra QUANDO foi cancelado (dentro do mesmo bloco:
                                                        no card do mobile a célula é flex e cada filho viraria uma coluna). */}
                                                    {c.status === 'CANCELLED' && c.cancelledAt && (
                                                        <div style={{ marginTop: '2px', fontSize: '0.6875rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                                                            Cancelado em {fmtDateSP(c.cancelledAt)}
                                                        </div>
                                                    )}
                                                </div>
                                                {venc && (
                                                    <span style={{
                                                        display: 'inline-flex', alignItems: 'center', gap: '3px',
                                                        marginTop: '4px', fontSize: '0.625rem', fontWeight: 700,
                                                        color: venc.color, background: venc.bg,
                                                        padding: '2px 8px', borderRadius: '10px', whiteSpace: 'nowrap'
                                                    }}>
                                                        <Clock size={11} aria-hidden="true" /> {venc.label}
                                                    </span>
                                                )}
                                            </td>

                                            {/* Status (+ situação da multa de cancelamento — E13). Um único filho na célula:
                                                no card do mobile o <td> é flex (rótulo × valor). */}
                                            <td data-label="Status" style={{ textAlign: 'center' }}>
                                                <div>
                                                    <StatusBadge meta={getMeta(CONTRACT_STATUS_META, c.status)} size="md" />
                                                    {fineNote && (
                                                        <div style={{ marginTop: '4px', fontSize: '0.6875rem', fontWeight: 600, color: fineNote.color, whiteSpace: 'nowrap' }}>
                                                            {fineNote.text}
                                                        </div>
                                                    )}
                                                </div>
                                            </td>

                                            {/* Actions */}
                                            <td data-label="" style={{ textAlign: 'center' }}>
                                                <div style={{ display: 'flex', gap: '4px', justifyContent: 'center', flexWrap: 'wrap' }}>
                                                    <Tooltip content="Abrir contrato" describe={false}>
                                                        <button className="admin-icon-btn" aria-label={`Abrir contrato ${c.name}`}
                                                            onClick={() => navigate(`/admin/contracts/${c.id}`)}><FolderOpen size={16} aria-hidden="true" /></button>
                                                    </Tooltip>
                                                    {canOpenEdit(c) && (
                                                        <Tooltip content="Editar contrato" describe={false}>
                                                            <button className="admin-icon-btn admin-icon-btn--success" aria-label={`Editar contrato ${c.name}`}
                                                                onClick={() => openEdit(c)}><Pencil size={16} aria-hidden="true" /></button>
                                                        </Tooltip>
                                                    )}

                                                    {/* E13: multa gerada e ainda em aberto → cobrar com o cliente presente (PIX/cartão).
                                                        Nunca para cliente excluído (D3). Exige "Cobrar o cliente". */}
                                                    {canCharge && !clientDeleted && fine && isFineOpen(c) && (
                                                        <Tooltip content={`Cobrar multa agora (${formatBRL(fine.amount)})`} describe={false}>
                                                            <button type="button" className="admin-icon-btn admin-icon-btn--success"
                                                                aria-label={`Cobrar agora a multa de cancelamento de ${c.name} (${formatBRL(fine.amount)})`}
                                                                aria-busy={fineChargeLoadingId === c.id}
                                                                onClick={() => openFineCharge(c)}>
                                                                {fineChargeLoadingId === c.id
                                                                    ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} aria-hidden="true" />
                                                                    : <Banknote size={16} aria-hidden="true" />}
                                                            </button>
                                                        </Tooltip>
                                                    )}

                                                    {/* Decidir o pedido de cancelamento (cobrar ou isentar a multa): contratos.multa.
                                                        ATU6-02 (espelho): com cobrança de sessão em aberto e sem a baixa, o servidor
                                                        recusa — a decisão fica travada com o motivo (no toque, o clique mostra o texto). */}
                                                    {canDecideFine && c.status === 'PENDING_CANCELLATION' && decideBlockReason(c) && (
                                                        <Tooltip content={decideBlockReason(c)}>
                                                            <button type="button" className="admin-icon-btn" aria-disabled="true"
                                                                aria-label={`Decidir o pedido de cancelamento de ${c.name} indisponível: ver por quê`}
                                                                onClick={() => showAlert({ type: 'info', title: 'Decidir o pedido indisponível', message: decideBlockReason(c) ?? '' })}>
                                                                <Lock size={16} aria-hidden="true" />
                                                            </button>
                                                        </Tooltip>
                                                    )}
                                                    {canDecideFine && c.status === 'PENDING_CANCELLATION' && !decideBlockReason(c) && (
                                                        <>
                                                            {/* Multa = cobrança nova: nunca para cliente excluído (D3). */}
                                                            {!clientDeleted && (
                                                                <Tooltip content="Cobrar multa de cancelamento" describe={false}>
                                                                    <button className="admin-icon-btn admin-icon-btn--danger" aria-label="Cobrar multa de cancelamento"
                                                                        onClick={() => handleResolveCancel(c, 'CHARGE_FEE')}><CircleDollarSign size={16} aria-hidden="true" /></button>
                                                                </Tooltip>
                                                            )}
                                                            <Tooltip content="Isentar multa de cancelamento" describe={false}>
                                                                <button className="admin-icon-btn admin-icon-btn--success" aria-label="Isentar multa de cancelamento"
                                                                    onClick={() => handleResolveCancel(c, 'WAIVE_FEE')}><HandCoins size={16} aria-hidden="true" /></button>
                                                            </Tooltip>
                                                        </>
                                                    )}

                                                    {canCancel && c.status === 'ACTIVE' && !cancelBlockReason(c) && (
                                                        <Tooltip content="Cancelar contrato" describe={false}>
                                                            <button className="admin-icon-btn admin-icon-btn--danger" aria-label={`Cancelar contrato ${c.name}`}
                                                                onClick={() => handleCancel(c)}><Ban size={16} aria-hidden="true" /></button>
                                                        </Tooltip>
                                                    )}
                                                    {/* TELA6-05: com cobrança de sessão em aberto e sem a baixa, o Cancelar fica travado com o
                                                        motivo (antes sumia sem explicação para quem não tem "Editar"); no toque, o clique mostra o texto. */}
                                                    {canCancel && c.status === 'ACTIVE' && cancelBlockReason(c) && (
                                                        <Tooltip content={cancelBlockReason(c)}>
                                                            <button type="button" className="admin-icon-btn" aria-disabled="true"
                                                                aria-label={`Cancelar contrato ${c.name} indisponível: ver por quê`}
                                                                onClick={() => showAlert({ type: 'info', title: 'Cancelar indisponível', message: cancelBlockReason(c) ?? '' })}>
                                                                <Lock size={16} aria-hidden="true" />
                                                            </button>
                                                        </Tooltip>
                                                    )}

                                                    {/* E4: o backend decide (`canRenew`) — plano Ativo/Concluído a ≤ 30 dias do fim, ou
                                                        Expirado; ainda não renovado; nunca avulso/serviço nem cliente excluído (D3).
                                                        O `!clientDeleted` é só cinto e suspensório. Renovar = contratos.criar + cobrancas.baixa (MAT-01). */}
                                                    {canRenew && !clientDeleted && c.canRenew === true && (
                                                        <Tooltip content="Renovar contrato (+3 meses)" describe={false}>
                                                            <button type="button" className="admin-icon-btn" aria-label={`Renovar contrato ${c.name}`}
                                                                onClick={() => handleRenew(c)}><RefreshCw size={16} aria-hidden="true" /></button>
                                                        </Tooltip>
                                                    )}
                                                    {/* Já renovado (só 1 renovação por contrato): atalho para o contrato novo. */}
                                                    {c.alreadyRenewed && c.renewedToId && (
                                                        <Tooltip content="Já renovado — abrir contrato novo" describe={false}>
                                                            <button type="button" className="admin-icon-btn" aria-label={`Abrir o contrato novo (renovação de ${c.name})`}
                                                                onClick={() => navigate(`/admin/contracts/${c.renewedToId}`)}><FolderSymlink size={16} aria-hidden="true" /></button>
                                                        </Tooltip>
                                                    )}
                                                    {/* Pausar e retomar fazem parte de "Editar, pausar e retomar contratos". */}
                                                    {canEdit && !clientDeleted && c.status === 'ACTIVE' && (
                                                        <Tooltip content="Pausar contrato" describe={false}>
                                                            <button className="admin-icon-btn" aria-label={`Pausar contrato ${c.name}`}
                                                                onClick={() => handlePause(c)}><Pause size={16} aria-hidden="true" /></button>
                                                        </Tooltip>
                                                    )}
                                                    {canEdit && !clientDeleted && (c.status as string) === 'PAUSED' && (
                                                        <Tooltip content="Retomar contrato" describe={false}>
                                                            <button className="admin-icon-btn admin-icon-btn--success" aria-label={`Retomar contrato ${c.name}`}
                                                                onClick={() => {
                                                                    showConfirm({ title: 'Retomar Contrato', message: `Retomar "${c.name}"? Vigência será estendida.`, onConfirm: async () => { try { const r = await contractsApi.resume(c.id); showToast(r.message); reload(); } catch (e: unknown) { showToast(getErrorMessage(e) || 'Erro'); } } });
                                                                }}><Play size={16} aria-hidden="true" /></button>
                                                        </Tooltip>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* ---------------------------------------------------------------
               MODALS
            --------------------------------------------------------------- */}

            {showCreate && (
                <CreateContractModal
                    isOpen={showCreate}
                    onClose={() => setShowCreate(false)}
                    onCreated={reload}
                    users={users}
                    pricing={pricing}
                />
            )}

            {/* Edit Modal */}
            {editContract && (
                <BottomSheetModal isOpen onClose={() => setEditContract(null)} preventClose={confirmingEditCancel} title="Editar Contrato" size="md">
                    <div>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '16px' }}>
                            {getMeta(CONTRACT_TYPE_META, editContract.type).label} · {getMeta(TIER_META, editContract.tier).label} · {editContract.user?.name} · {(() => { const n = contractEpisodes(editContract); return `${n} ${n === 1 ? 'gravação' : 'gravações'}`; })()}
                        </p>
                        {editError && <div className="error-message">{editError}</div>}
                        {isClientDeleted(editContract) && (
                            <div className="admin-alert admin-alert--danger" role="note" style={{ marginBottom: 12 }}>
                                Cliente excluído: o contrato não pode voltar a Ativo nem ter os créditos alterados. Link, forma de pagamento, término e encerramento continuam editáveis.
                            </div>
                        )}
                        {/* Equipe: o que o acesso desta pessoa permite mudar (os campos bloqueados ficam em cinza). */}
                        {editLockNote && (
                            <div className="admin-info-banner" role="note" style={{ marginBottom: 14 }}>
                                <Lock size={15} className="admin-info-banner__icon" aria-hidden="true" />
                                <span>{editLockNote}</span>
                            </div>
                        )}
                        <div className="form-group"><label className="form-label" htmlFor={`${uid}-status`}>Status</label>
                            <select id={`${uid}-status`} className="form-select" value={editForm.status} disabled={editTargets.length === 0}
                                style={lockedField(editTargets.length === 0)}
                                onChange={e => setEditForm({ ...editForm, status: e.target.value })}>
                                {/* O PATCH aceita só estes 4. Pausado/Pend. cancelamento/Aguard. pagamento têm fluxo
                                    próprio (Retomar, Cobrar/Isentar multa, pagamento) e aparecem só como "atual".
                                    Equipe: só o atual + os status que a pessoa pode escolher (statusTargetsFor). */}
                                {!EDITABLE_STATUSES.includes(editContract.status) && (
                                    <option value={editContract.status} disabled>{getMeta(CONTRACT_STATUS_META, editContract.status).label} (atual)</option>
                                )}
                                {EDITABLE_STATUSES.filter(s => s === editContract.status || editTargets.includes(s)).map(s => (
                                    <option key={s} value={s}
                                        disabled={s === 'ACTIVE' && editContract.status !== 'ACTIVE' && isClientDeleted(editContract)}>
                                        {getMeta(CONTRACT_STATUS_META, s).label}
                                    </option>
                                ))}
                            </select>
                            {editPendingLocked && (
                                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '6px 0 0' }}>
                                    O cliente pediu o cancelamento: mudar o status decide a multa e exige a permissão “Decidir pedido de cancelamento (cobrar ou isentar multa)”.
                                </p>
                            )}
                        </div>
                        <div className="form-group"><label className="form-label" htmlFor={`${uid}-end-date`}>Data de Término</label>
                            <input id={`${uid}-end-date`} type="date" className="form-input" value={editForm.endDate} disabled={!canEdit}
                                style={lockedField(!canEdit)}
                                onChange={e => setEditForm({ ...editForm, endDate: e.target.value })} />
                        </div>
                        {editContract.type === 'FLEX' && (
                            <div className="form-group"><label className="form-label" htmlFor={`${uid}-flex-credits`}>Créditos Flex Restantes</label>
                                <input id={`${uid}-flex-credits`} type="number" className="form-input" min={0} value={editForm.flexCreditsRemaining}
                                    disabled={!editCreditsOk} style={lockedField(!editCreditsOk)}
                                    onChange={e => setEditForm({ ...editForm, flexCreditsRemaining: e.target.value })} />
                            </div>
                        )}
                        <div className="form-group">
                            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 5 }} htmlFor={`${uid}-contract-url`}><Link2 size={13} aria-hidden="true" /> Link do Contrato Digital</label>
                            <input id={`${uid}-contract-url`} className="form-input" type="url" placeholder="https://..." value={editForm.contractUrl} disabled={!canEdit}
                                style={lockedField(!canEdit)}
                                onChange={e => setEditForm({ ...editForm, contractUrl: e.target.value })} />
                        </div>
                        <div className="form-group">
                            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 5 }} htmlFor={`${uid}-payment-method`}><CreditCard size={13} aria-hidden="true" /> Forma de Pagamento</label>
                            <select id={`${uid}-payment-method`} className="form-select" value={editForm.paymentMethod} disabled={!canEdit}
                                style={lockedField(!canEdit)}
                                onChange={e => setEditForm({ ...editForm, paymentMethod: e.target.value })}>
                                <option value="">-- Não definido --</option>
                                {editMethodOptions.map(pm => (
                                    <option key={pm.key} value={pm.key}>{pm.emoji} {pm.label}</option>
                                ))}
                                {/* Contrato legado em boleto com o boleto desligado: aparece só como "atual" (não é escolha). */}
                                {editContract.paymentMethod === 'BOLETO' && !boletoAvailable && (
                                    <option value="BOLETO" disabled>{getBoletoMethodConfig().emoji} {getBoletoMethodConfig().label} (atual — indisponível)</option>
                                )}
                            </select>
                            {editContract.paymentMethod === 'BOLETO' && !boletoAvailable && (
                                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '6px 0 0' }}>
                                    {boleto.message || 'O pagamento por boleto está desligado.'} As cobranças deste contrato saem por PIX ou cartão.
                                </p>
                            )}
                        </div>
                        <div className="admin-actions-row">
                            <button className="btn btn-secondary" onClick={() => setEditContract(null)}>Cancelar</button>
                            <button className="btn btn-primary" onClick={handleEdit}>Salvar</button>
                        </div>
                    </div>
                </BottomSheetModal>
            )}

            {/* E13 — "Cobrar agora" da multa de cancelamento (PIX/cartão do CLIENTE, presente). */}
            {fineCharge && (
                <ChargeNowSheet
                    paymentId={fineCharge.paymentId}
                    amount={fineCharge.amount}
                    description={`${fineCharge.contractName} - Multa de cancelamento`}
                    title="Cobrar multa de cancelamento"
                    subtitle={`${fineCharge.contractName}${fineCharge.client.name ? ` · ${fineCharge.client.name}` : ''}. Gere o PIX ou cobre o cartão do cliente (presente) — a cobrança é feita em nome do cliente.`}
                    context="contract"
                    initialMethod={fineCharge.initialMethod}
                    client={fineCharge.client}
                    error={fineChargeError || undefined}
                    onError={setFineChargeError}
                    onSuccess={() => { setFineCharge(null); showToast('Multa de cancelamento paga!'); reload(); }}
                    onDismiss={() => { setFineCharge(null); reload(); }}
                    dismissLabel="Fechar (a multa continua pendente)"
                />
            )}

            {/* -------------------------------------------------------
               CUSTOM CONTRACT WIZARD
            ------------------------------------------------------- */}
            {showCustom && (
                <CustomContractModal
                    isOpen={showCustom}
                    onClose={() => setShowCustom(false)}
                    onCreated={reload}
                    users={users}
                    pricing={pricing}
                />
            )}
        </div>
    );
}
