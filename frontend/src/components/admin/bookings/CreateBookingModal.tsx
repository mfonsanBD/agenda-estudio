import { getErrorMessage } from '../../../utils/errors';
import { useState, useCallback, useEffect, useId, useRef } from 'react';
import { bookingsApi, contractsApi, pricingApi, UserSummary, Contract, Slot, AddOnConfig, CouponValidation } from '../../../api/client';
import { useUI } from '../../../context/UIContext';
import BottomSheetModal from '../../BottomSheetModal';
import CouponField from '../../CouponField';
import ServiceLineItem from '../../ui/ServiceLineItem';
import CurrencyInput from '../../ui/fields/CurrencyInput';
import BrandLoader from '../../ui/BrandLoader';
import { formatBRL, DAY_NAMES } from '../../../utils/format';
import { todayStrSaoPaulo, studioSlotDate } from '../../../utils/time';
import { isAvulsoContract } from '../../../utils/contractStatus';
import { ignoreMultiClick, wizardStepBodyStyle as stepBodyStyle, wizardStepContentStyle as stepContentStyle } from '../../../hooks/useWizardStep';
import { TIER_META, getMeta } from '../../../constants/adminMeta';
import WizardSteps from '../WizardSteps';
import ChargeNowSheet from '../ChargeNowSheet';
import Tooltip from '../../ui/Tooltip';
import { usePermission } from '../../../hooks/usePermission';
import {
    Search, FileText, CalendarDays, Zap, Wallet, TicketPercent, Sparkles,
    CreditCard, Check, NotebookPen, CheckCircle2, Clock as ClockIcon, AlertTriangle,
    Plus, Pin, RefreshCw,
} from 'lucide-react';


// Casca das etapas (stepBodyStyle/stepContentStyle, compartilhados em useWizardStep): a etapa abraça o
// conteúdo e o dialog fica ancorado no topo no desktop (desktopAnchor="top"), sem o cabeçalho pular.
// Os botões do rodapé usam ignoreMultiClick: o 2º clique de um duplo clique no "Próximo" da etapa 2 não agenda sem o admin ver
// a confirmação, e o de um duplo "Voltar" (etapa 2) não cai no "Cancelar" da etapa 1.

/**
 * Contratos a que o admin pode vincular a nova sessão: ACTIVE, ou COMPLETED/"Concluído" (D6) de
 * plano (não avulso) ainda na vigência — um FIXO/FLEX/CUSTOM vira COMPLETED quando não resta sessão,
 * mesmo antes do fim; o backend reabre o contrato (ACTIVE) ao receber a sessão (syncContractCompletion).
 * FLEX/CUSTOM concluídos continuam desabilitados pelo saldo (hasCredits), como quando ficavam ACTIVE.
 */
function isLinkableContract(c: Pick<Contract, 'status' | 'type' | 'durationMonths' | 'endDate'>, today: string): boolean {
    if (c.status === 'ACTIVE') return true;
    return c.status === 'COMPLETED' && !isAvulsoContract(c) && (!c.endDate || c.endDate.slice(0, 10) >= today);
}

interface CreateBookingModalProps {
    isOpen: boolean;
    onClose: () => void;
    users: UserSummary[];
    onCreated: () => void;
    /** Clique num horário livre da Agenda: data e horário já escolhidos (a etapa 1 continua sendo o cliente). */
    prefill?: { date: string; startTime: string } | null;
    /** A lista de clientes ainda está chegando (a Agenda só busca ao abrir o modal). */
    usersLoading?: boolean;
}

/** Texto do status "Confirmado" travado para quem não tem a baixa manual (DECISÕES D3/D7). */
const CONFIRMED_LOCKED_HINT = 'Criar como Confirmado registra o pagamento como pago e exige a permissão “Marcar como pago, anular ou estornar”. O agendamento nasce Reservado, aguardando pagamento.';
/**
 * REG-1: sessão de PLANO (Flex, Personalizado) criada sem a baixa manual. O plano já cobre a sessão (o servidor
 * não gera cobrança da sessão, só dos serviços extras): nada de "aguardando pagamento" — a presença é que fica a
 * confirmar. O FIXO tem textos próprios (FIN-04, abaixo).
 */
const CONFIRMED_LOCKED_HINT_PLAN = 'Criar como Confirmado registra a sessão como paga e exige a permissão “Marcar como pago, anular ou estornar”. A sessão do plano nasce Reservada, com a presença a confirmar.';
const PLAN_RESERVED_NOTE = 'A sessão do plano nasce Reservada, com a presença a confirmar: o plano já cobre a sessão.';
const PLAN_RESERVED_TOAST = 'Agendamento criado como Reservado (presença a confirmar). A sessão já é coberta pelo plano.';
/**
 * FIN-04: FIXO sem a baixa manual. O FIXO nasce com TODAS as sessões do plano geradas (meses × sessões/mês),
 * então o teto já está usado desde o 1º dia e uma sessão a mais é EXTRA — o servidor a cobra (PENDING do valor
 * da sessão, `notice` FIXO_LIMIT). Só sobra vaga coberta quando alguma sessão do plano foi cancelada ou marcada
 * como Não realizado, e a lista de contratos (GET /contracts) não traz as sessões usadas: o texto é condicional.
 * FIXO Concluído = teto usado (contractCompletion): aí a sessão é extra com certeza.
 */
const FIXO_EXTRA_NOTE = 'No plano fixo, as sessões do plano já são geradas na contratação; uma sessão a mais é extra e será cobrada (aguardando pagamento), a não ser que alguma sessão do plano tenha sido cancelada ou marcada como Não realizado.';
const FIXO_EXTRA_CHARGED_NOTE = 'Sessão extra: o plano fixo já usou todas as sessões, então esta será cobrada (aguardando pagamento).';
const CONFIRMED_LOCKED_HINT_FIXO = 'Criar como Confirmado registra a sessão como paga e exige a permissão “Marcar como pago, anular ou estornar”. A sessão nasce Reservada: aguardando pagamento se for extra, ou com a presença a confirmar se o plano ainda tiver sessão livre.';
/**
 * REG-1 (espelho do POST /bookings/admin): só FIXO, FLEX e Personalizado cobrem a sessão. Contrato de
 * SERVIÇO e AVULSO vinculado continuam cobrando a sessão; o FIXO que já usou o teto também é cobrado (FIN-04:
 * é o caso comum — textos próprios; a resposta do servidor traz o `notice`).
 */
const PLAN_COVERED_TYPES: readonly string[] = ['FIXO', 'FLEX', 'CUSTOM'];
/** FE-2: cupom que zera o valor registra o agendamento como pago (o servidor recusa sem a baixa manual). */
const ZERO_COUPON_NEEDS_BAIXA = 'Cupom que zera o valor registra o agendamento como pago e exige a permissão “Marcar como pago, anular ou estornar”. Remova o cupom ou use um de valor menor.';

export default function CreateBookingModal({ isOpen, onClose, users, onCreated, prefill, usersLoading }: CreateBookingModalProps) {
    const uid = useId();
    const { showToast } = useUI();
    const { can } = usePermission();
    // Sem cobrancas.baixa nada nasce PAGO (DECISÕES D3/D7): o padrão é "Reservado" (o servidor rebaixa um
    // "Confirmado" para RESERVED com pagamento PENDING) e o preço manual some (customPrice diferente do
    // preço da faixa dá 403). "Cobrar agora" só com cobrancas.cobrar.
    const canMarkPaid = can('cobrancas.baixa');
    const canCharge = can('cobrancas.cobrar');
    const defaultStatus = canMarkPaid ? 'CONFIRMED' : 'RESERVED';
    const emptyForm = () => ({ userId: '', contractId: '', date: prefill?.date ?? '', startTime: prefill?.startTime ?? '', status: defaultStatus, adminNotes: '' });

    const [createStep, setCreateStep] = useState(1);
    const [createForm, setCreateForm] = useState(emptyForm);
    const [createError, setCreateError] = useState('');
    const [createSearch, setCreateSearch] = useState('');
    const [clientContracts, setClientContracts] = useState<Contract[]>([]);
    const [daySlots, setDaySlots] = useState<Slot[]>([]);
    const [slotsLoading, setSlotsLoading] = useState(false);
    const [creating, setCreating] = useState(false);
    const [customPrice, setCustomPrice] = useState<number | null>(null);
    // Rascunho do valor avulso em CENTAVOS (CurrencyInput, D10). Só vira `customPrice` no blur:
    // o CouponField revalida (debounce 400ms) a cada mudança de `amount` e removeria o cupom
    // aplicado com valores intermediários da digitação.
    const [priceDraft, setPriceDraft] = useState<number | null>(null);
    // Per-episode services on this recording (inherit the linked contract's discount; avulso = 0%).
    const [addons, setAddons] = useState<AddOnConfig[]>([]);
    const [selectedAddons, setSelectedAddons] = useState<string[]>([]);
    useEffect(() => {
        if (!isOpen) return;
        pricingApi.getAddons().then(r => setAddons(r.addons.filter(a => !a.monthly))).catch(() => setAddons([]));
    }, [isOpen]);
    // Avulso "charge now" (unified with the client): generate PIX / charge the client's card.
    const [chargeNow, setChargeNow] = useState(false);
    const [chargeMethod, setChargeMethod] = useState<'CARTAO' | 'PIX'>('CARTAO');
    const [chargePaymentId, setChargePaymentId] = useState<string | null>(null);
    // Cupom (só avulso — elegibilidade é do CLIENTE selecionado) + valor já descontado retornado pelo backend.
    const [appliedCoupon, setAppliedCoupon] = useState<CouponValidation | null>(null);
    const [chargeAmountApi, setChargeAmountApi] = useState<number | null>(null);
    // Trava por requisição em voo (estado da chamada, nunca por tempo): um 2º clique em "Agendar"
    // antes do re-render não cria um 2º agendamento.
    const inFlightRef = useRef(false);

    // Troca de etapa: volta a rolagem do sheet ao topo (o erro fica no topo do corpo).
    const headRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const body = headRef.current?.closest('.bottom-sheet-body');
        if (body) body.scrollTop = 0;
    }, [createStep]);

    const resetCreateModal = () => {
        onClose();
        setCreateStep(1);
        setCreateForm(emptyForm());
        setCreateError('');
        setCreateSearch('');
        setClientContracts([]);
        setDaySlots([]);
        setCustomPrice(null);
        setPriceDraft(null);
        setSelectedAddons([]);
        setChargeNow(false);
        setChargeMethod('CARTAO');
        setChargePaymentId(null);
        setAppliedCoupon(null);
        setChargeAmountApi(null);
    };

    const handleCreate = async () => {
        if (createStep !== 3) return; // rede de segurança: só cria na última etapa
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        setCreateError('');
        setCreating(true);
        try {
            const isAvulsoCharge = canCharge && !createForm.contractId && chargeNow;
            const payload: any = {
                userId: createForm.userId, date: createForm.date, startTime: createForm.startTime,
                // To charge inline the booking must await payment (RESERVED), then the payment confirms it.
                // Sem a baixa manual, nunca pede "Confirmado" (nasce aguardando pagamento).
                status: isAvulsoCharge || !canMarkPaid ? 'RESERVED' : createForm.status,
            };
            if (createForm.contractId) payload.contractId = createForm.contractId;
            if (createForm.adminNotes.trim()) payload.adminNotes = createForm.adminNotes;
            // Preço manual só com a baixa manual; sem ela o servidor usa o preço da faixa.
            if (canMarkPaid && !createForm.contractId && customPrice != null) payload.customPrice = customPrice;
            if (selectedAddons.length > 0) payload.addOns = selectedAddons;
            if (isAvulsoCharge) payload.paymentMethod = chargeMethod;
            // Cupom só vale para avulso (contrato tem fluxo próprio).
            if (!createForm.contractId && appliedCoupon) payload.couponCode = appliedCoupon.code;
            // `downgraded`/`notice`: o "Confirmado" virou Reservado (aguardando pagamento) no servidor.
            // `coveredByPlan` (REG-1): sessão de plano sem a baixa — a `message` diz se só os extras ficaram pendentes.
            const res = await bookingsApi.adminCreate(payload) as Awaited<ReturnType<typeof bookingsApi.adminCreate>> & { downgraded?: boolean; notice?: string; coveredByPlan?: boolean };
            if (isAvulsoCharge && res.paymentId) {
                // Open the same InlineCheckout the client uses — charges the CLIENT (payment.userId).
                // O backend retorna o valor JÁ com o cupom descontado (paymentAmount).
                // A lista só recarrega quando o sheet de cobrança fecha (fluxo encerrado).
                setChargeAmountApi(res.paymentAmount ?? null);
                setChargePaymentId(res.paymentId);
            } else {
                onCreated();
                resetCreateModal();
                // REG-1: sessão de plano sem a baixa manual não fica "aguardando pagamento" (o plano já cobre);
                // o aviso do servidor, quando vem, tem a palavra final (ex.: serviços extras pendentes).
                const linkedType = clientContracts.find(c => c.id === createForm.contractId)?.type;
                const planReserved = !!createForm.contractId && !!linkedType && PLAN_COVERED_TYPES.includes(linkedType) && !canMarkPaid;
                showToast(res.notice
                    || (res.downgraded || res.coveredByPlan
                        ? res.message
                        : payload.status === 'RESERVED'
                            ? (planReserved ? PLAN_RESERVED_TOAST : 'Agendamento criado como Reservado, aguardando pagamento.')
                            : 'Agendamento criado com sucesso!'));
            }
        } catch (err: unknown) { setCreateError(getErrorMessage(err)); }
        finally { inFlightRef.current = false; setCreating(false); }
    };

    // Load contracts when client is selected
    const loadClientContracts = useCallback(async (userId: string) => {
        try {
            const res = await contractsApi.getAll();
            const today = todayStrSaoPaulo();
            setClientContracts(res.contracts.filter(c => c.user?.id === userId && isLinkableContract(c, today)));
        } catch { setClientContracts([]); }
    }, []);

    // Load slot availability when date changes. `pickTime` (prefill da Agenda): já escolhe o horário e
    // o valor da faixa, como o clique no horário faria.
    const loadDaySlots = useCallback(async (date: string, pickTime?: string) => {
        setSlotsLoading(true);
        try {
            const res = await bookingsApi.getAvailability(date);
            const slots = res.slots || [];
            setDaySlots(slots);
            if (pickTime) {
                const picked = slots.find(s => s.time === pickTime);
                if (picked?.available && picked.price != null) { setCustomPrice(picked.price); setPriceDraft(picked.price); }
                else if (picked && !picked.available) setCreateForm(f => (f.startTime === pickTime ? { ...f, startTime: '' } : f));
            }
        } catch { setDaySlots([]); }
        finally { setSlotsLoading(false); }
    }, []);

    // Aberto pela Agenda com data e horário: carrega a grade do dia uma vez (a etapa 2 já vem escolhida).
    const prefillLoadedRef = useRef(false);
    useEffect(() => {
        if (!isOpen || !prefill?.date || prefillLoadedRef.current) return;
        prefillLoadedRef.current = true;
        void loadDaySlots(prefill.date, prefill.startTime);
    }, [isOpen, prefill?.date, prefill?.startTime, loadDaySlots]);

    if (!isOpen) return null;

    const selectedUser = users.find(u => u.id === createForm.userId);
    const selectedSlot = daySlots.find(s => s.time === createForm.startTime);
    const selectedContract = clientContracts.find(c => c.id === createForm.contractId);
    // Services on this recording inherit the contract's loyalty discount (avulso = 0%).
    const inheritedDiscount = selectedContract?.discountPct || 0;
    const servicesValue = selectedAddons.reduce((acc, key) => {
        const a = addons.find(x => x.key === key);
        return a ? acc + Math.round(a.price * (1 - inheritedDiscount / 100)) : acc;
    }, 0);
    // /api/users já lista só clientes (D1); o filtro positivo é a segunda trava.
    const filteredClients = users.filter(u => u.role === 'CLIENTE').filter(u => {
        if (!createSearch) return true;
        const q = createSearch.toLowerCase();
        return u.name.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q);
    });
    const tc = (tier: string) => TIER_META[tier] || TIER_META.COMERCIAL;

    // Trocar o vínculo (avulso ↔ plano) mantém o horário já escolhido (ex.: vindo da Agenda) quando ele
    // continua livre e é da faixa do plano; senão limpa, como antes.
    const keptTimeFor = (tier: string | null) => {
        const s = daySlots.find(x => x.time === createForm.startTime);
        return s && s.available && (!tier || s.tier === tier) ? createForm.startTime : '';
    };
    const selectAvulso = () => {
        const keep = keptTimeFor(null);
        setCreateForm({ ...createForm, contractId: '', startTime: keep });
        const s = daySlots.find(x => x.time === keep);
        if (keep && s?.price != null) { setCustomPrice(s.price); setPriceDraft(s.price); }
    };
    const selectContract = (c: Contract) => setCreateForm({ ...createForm, contractId: c.id, startTime: keptTimeFor(c.tier) });

    // FE-2: sem a baixa manual, cupom que zera o avulso não pode ser usado (o servidor recusaria com 403):
    // "Agendar" fica desabilitado com a explicação embaixo do cupom, em vez de um 403 genérico.
    const zeroNeedsBaixa = !canMarkPaid && !createForm.contractId && !!appliedCoupon && appliedCoupon.finalAmount <= 0;
    // REG-1: sessão de plano sem a baixa manual — textos de "presença a confirmar", não de pagamento. Contrato
    // AVULSO ou de SERVIÇO vinculado continua cobrando a sessão (o servidor só deixa de cobrar FIXO/FLEX/Personalizado).
    const planReservedLocked = !canMarkPaid && !!selectedContract && PLAN_COVERED_TYPES.includes(selectedContract.type);
    // FIN-04: no FIXO o plano quase nunca cobre a sessão nova (o teto nasce usado) — nada de "o plano já cobre".
    const fixoLocked = planReservedLocked && selectedContract!.type === 'FIXO';
    const fixoCapUsed = fixoLocked && selectedContract!.status === 'COMPLETED';

    const stepLabels = ['Cliente', 'Horário', 'Confirmar'];

    // Charge-now step (avulso): same InlineCheckout + unified policy as the client.
    if (chargePaymentId) {
        return (
            <ChargeNowSheet
                paymentId={chargePaymentId}
                amount={chargeAmountApi ?? ((customPrice || 0) + servicesValue)}
                description="Agendamento avulso"
                title="Cobrar agendamento"
                subtitle="Cobre no PIX (mostre o QR Code ao cliente) ou no cartão dele (crédito ou débito), com o cliente presente. A reserva confirma ao pagar."
                // E1: sempre PIX | Cartão, abrindo na forma escolhida na etapa Confirmar. O sheet também oferece
                // a aba Boleto quando ele está disponível (E3: chave-mestra + Cora) — a avulsa do admin nasce num
                // contrato AVULSO já ativo, sem prazo de 10 minutos, e o backend aceita. A pré-escolha da etapa
                // Confirmar fica só em PIX | Cartão de propósito: mandar BOLETO ao POST /bookings/admin já emitiria
                // o boleto na criação e o sheet pediria outro.
                initialMethod={chargeMethod}
                context="avulso"
                client={selectedUser ? { id: selectedUser.id, name: selectedUser.name, cpfCnpj: selectedUser.cpfCnpj } : undefined}
                error={createError || undefined}
                onError={(msg) => setCreateError(msg)}
                onSuccess={() => { onCreated(); resetCreateModal(); showToast('Pagamento confirmado!'); }}
                onDismiss={() => { onCreated(); resetCreateModal(); showToast('Agendamento criado (pagamento pendente).'); }}
                dismissLabel="Fechar (deixar pendente)"
            />
        );
    }

    return (
        <BottomSheetModal isOpen onClose={resetCreateModal} preventClose={creating} hideHeader size="lg" desktopAnchor="top" floatingClose className="admin-sheet" title="Novo Agendamento">
                {/* --- HEADER --- */}
                <div className="admin-modal-head" ref={headRef}>
                    <h2 className="admin-modal-title">
                        <span className="admin-modal-title__icon"><Plus size={18} aria-hidden="true" /></span>
                        Novo Agendamento
                    </h2>

                    {/* Step indicator */}
                    <WizardSteps steps={stepLabels} current={createStep} onStepClick={setCreateStep} />
                </div>

                <div className="admin-modal-body">
                    {createError && <div className="admin-alert admin-alert--danger" role="alert" style={{ marginBottom: '16px' }}>{createError}</div>}

                    {/* -------- STEP 1: Select Client -------- */}
                    {createStep === 1 && (
                        <div style={stepBodyStyle}>
                            <div style={stepContentStyle}>
                            <div className="admin-search" style={{ marginBottom: '14px' }}>
                                <input
                                    type="text" placeholder="Buscar cliente por nome ou e-mail..."
                                    aria-label="Buscar cliente por nome ou e-mail"
                                    value={createSearch} onChange={e => setCreateSearch(e.target.value)} autoFocus
                                />
                                <Search size={14} className="admin-search__icon" aria-hidden="true" />
                            </div>

                            {prefill && createForm.date && createForm.startTime && (
                                <div style={{ marginBottom: '12px', fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <CalendarDays size={13} aria-hidden="true" />
                                    Horário escolhido na agenda: <strong style={{ color: 'var(--text-primary)' }}>{new Date(createForm.date + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })} às {createForm.startTime}</strong>
                                </div>
                            )}
                            <div style={{ maxHeight: '340px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {usersLoading && users.length === 0 ? (
                                    <div style={{ padding: '32px', textAlign: 'center' }}><BrandLoader size="inline" label="Carregando clientes…" /></div>
                                ) : filteredClients.length === 0 ? (
                                    <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                                        Nenhum cliente encontrado
                                    </div>
                                ) : filteredClients.map(u => {
                                    const isSelected = createForm.userId === u.id;
                                    return (
                                        <button type="button" key={u.id}
                                            className={`admin-select-row${isSelected ? ' admin-select-row--active' : ''}`}
                                            aria-pressed={isSelected}
                                            onClick={() => {
                                                setCreateForm({ ...createForm, userId: u.id, contractId: '' });
                                                loadClientContracts(u.id);
                                            }}
                                        >
                                            <div style={{
                                                width: 36, height: 36, borderRadius: '50%',
                                                background: isSelected ? 'var(--accent-gradient-go)' : 'var(--bg-elevated)',
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                fontSize: '0.8125rem', fontWeight: 700, color: isSelected ? '#fff' : 'var(--text-muted)',
                                                flexShrink: 0,
                                            }}>
                                                {u.name.charAt(0).toUpperCase()}
                                            </div>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ fontWeight: 600, fontSize: '0.8125rem', color: isSelected ? 'var(--success)' : 'var(--text-primary)' }}>{u.name}</div>
                                                <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                {(u._count?.contracts ?? 0) > 0 && (
                                                    <span style={{
                                                        padding: '2px 8px', borderRadius: '6px', fontSize: '0.625rem', fontWeight: 700,
                                                        background: 'var(--success-bg)', color: 'var(--success)',
                                                    }}>{u._count.contracts} contrato{u._count.contracts > 1 ? 's' : ''}</span>
                                                )}
                                                {isSelected && <Check size={16} style={{ color: 'var(--success)' }} aria-hidden="true" />}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                            </div>

                            <div className="admin-actions-row" style={{ marginTop: '20px' }}>
                                <button key="cancel" type="button" onClick={ignoreMultiClick(resetCreateModal)} className="btn-admin-ghost">
                                    Cancelar
                                </button>
                                <button key="next" type="button" disabled={!createForm.userId}
                                    onClick={ignoreMultiClick(() => { setTimeout(() => setCreateStep(2), 0); })}
                                    className="btn-admin-go">
                                    Próximo →
                                </button>
                            </div>
                        </div>
                    )}

                    {/* -------- STEP 2: Contract, Date, Slot -------- */}
                    {createStep === 2 && (() => {
                        const TIER_LABEL: Record<string, string> = { COMERCIAL: 'Comercial', AUDIENCIA: 'Audiência', SABADO: 'Sábado' };
                        // L2: rótulo do TIPO real do contrato — antes era binário (FIXO→"Fixo", resto→"Flex"),
                        // rotulando errado CUSTOM/AVULSO/SERVICO como "Flex".
                        const TYPE_LABEL: Record<string, string> = { FIXO: 'Fixo', FLEX: 'Flex', CUSTOM: 'Personalizado', AVULSO: 'Avulso', SERVICO: 'Serviço' };

                        // Determine selected contract and its tier for slot filtering
                        const activeContract = clientContracts.find(c => c.id === createForm.contractId);
                        const filterTier = activeContract?.tier || null; // null = avulso, show all

                        // Check day compatibility for FIXO contracts
                        const selectedDateDOW = createForm.date ? new Date(createForm.date + 'T12:00:00').getDay() : null;
                        const isFixoDayMismatch = activeContract?.type === 'FIXO' && activeContract.fixedDayOfWeek != null && selectedDateDOW !== null && selectedDateDOW !== activeContract.fixedDayOfWeek;

                        // Filter slots by contract tier
                        const filteredSlots = filterTier
                            ? daySlots.filter(s => s.tier === filterTier || !s.available)
                            : daySlots;

                        // Não permitir agendar no passado (fuso do estúdio). `min` no <input> só cobre o
                        // seletor; aqui removemos horários que já passaram HOJE e zeramos datas passadas
                        // (digitadas). A trava autoritativa está no backend (POST /bookings/admin).
                        const todayStr = todayStrSaoPaulo();
                        const isPastDate = !!createForm.date && createForm.date < todayStr;
                        const isToday = createForm.date === todayStr;
                        const nowMs = Date.now();
                        const slotsForDay = isPastDate
                            ? []
                            : filteredSlots.filter(s => !(isToday && studioSlotDate(createForm.date, s.time).getTime() < nowMs));

                        return (
                        <div style={stepBodyStyle}>
                            <div style={stepContentStyle}>
                            {/* -- Contract Selector (always shown) -- */}
                            <div style={{ marginBottom: '20px' }}>
                                <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <FileText size={13} aria-hidden="true" /> Vincular a Contrato
                                    {clientContracts.length > 0 && <span style={{ fontSize: '0.5625rem', fontWeight: 600, padding: '1px 6px', borderRadius: '4px', background: 'rgba(16,185,129,0.1)', color: 'var(--success)' }}>{clientContracts.length} {clientContracts.length > 1 ? 'disponíveis' : 'disponível'}</span>}
                                </label>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    {/* Avulso card */}
                                    <div
                                        role="button" tabIndex={0}
                                        aria-pressed={!createForm.contractId}
                                        onClick={selectAvulso}
                                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectAvulso(); } }}
                                        style={{
                                            padding: '14px 16px', borderRadius: '12px', cursor: 'pointer',
                                            display: 'flex', alignItems: 'center', gap: '14px',
                                            background: !createForm.contractId
                                                ? 'linear-gradient(135deg, rgba(17,129,155,0.12), rgba(9,110,133,0.04))'
                                                : 'var(--bg-elevated)',
                                            border: `1px solid ${!createForm.contractId ? 'rgba(17,129,155,0.45)' : 'var(--border-default)'}`,
                                            transition: 'background 0.2s ease, border-color 0.2s ease',
                                        }}
                                    >
                                        <div style={{
                                            width: 40, height: 40, borderRadius: '10px', flexShrink: 0,
                                            background: !createForm.contractId ? 'var(--accent-gradient)' : 'var(--bg-secondary)',
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            fontSize: '1.1rem',
                                        }}>
                                            <Zap size={18} aria-hidden="true" />
                                        </div>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontWeight: 700, fontSize: '0.8125rem', color: !createForm.contractId ? 'var(--accent-text)' : 'var(--text-primary)' }}>Agendamento Avulso</div>
                                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '2px' }}>Cria contrato automático · Todos os horários</div>
                                        </div>
                                        {!createForm.contractId && <Check size={17} style={{ color: 'var(--accent-text)' }} aria-hidden="true" />}
                                    </div>

                                    {/* Active contract cards */}
                                    {clientContracts.map(c => {
                                        const isSelected = createForm.contractId === c.id;
                                        const ct = tc(c.tier);
                                        // L3: CUSTOM só é agendável se houver reagendamento livre (customCreditsRemaining>0) —
                                        // suas sessões são todas pré-geradas na criação. Antes, qualquer não-FLEX ficava sempre
                                        // habilitado, deixando o admin vincular além do total do CUSTOM. Espelha o BookingModal do cliente.
                                        const hasCredits = c.type === 'FLEX'
                                            ? (c.flexCreditsRemaining ?? 0) > 0
                                            : c.type === 'CUSTOM'
                                                ? (c.customCreditsRemaining ?? 0) > 0
                                                : true;
                                        const compat = true; // day compat checked after date selection

                                        return (
                                            <div key={c.id}
                                                role="button" tabIndex={hasCredits ? 0 : -1}
                                                aria-pressed={isSelected}
                                                aria-disabled={!hasCredits}
                                                onClick={() => {
                                                    if (!hasCredits) return;
                                                    selectContract(c);
                                                }}
                                                onKeyDown={e => { if (hasCredits && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectContract(c); } }}
                                                style={{
                                                    padding: '14px 16px', borderRadius: '12px',
                                                    cursor: hasCredits ? 'pointer' : 'not-allowed',
                                                    display: 'flex', alignItems: 'center', gap: '14px',
                                                    background: isSelected
                                                        ? `linear-gradient(135deg, ${ct.bg}, rgba(0,0,0,0))`
                                                        : !hasCredits ? 'rgba(255,255,255,0.01)' : 'var(--bg-elevated)',
                                                    border: `1px solid ${isSelected ? ct.color + '55' : 'var(--border-default)'}`,
                                                    opacity: hasCredits ? 1 : 0.4,
                                                    transition: 'background 0.2s ease, border-color 0.2s ease, opacity 0.2s ease',
                                                }}
                                            >
                                                {/* Tier icon */}
                                                <div style={{
                                                    width: 40, height: 40, borderRadius: '10px', flexShrink: 0,
                                                    background: isSelected ? `linear-gradient(135deg, ${ct.color}, ${ct.color}88)` : ct.bg,
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    fontSize: '1.1rem', border: `1px solid ${ct.color}33`,
                                                }}>
                                                    <ct.icon size={18} aria-hidden="true" />
                                                </div>

                                                {/* Contract info */}
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                                        <span style={{ fontWeight: 700, fontSize: '0.8125rem', color: isSelected ? ct.color : 'var(--text-primary)' }}>{c.name}</span>
                                                        <span style={{
                                                            fontSize: '0.5625rem', fontWeight: 700, padding: '1px 6px', borderRadius: '4px',
                                                            background: ct.bg, color: ct.color,
                                                        }}>{TIER_LABEL[c.tier] || c.tier}</span>
                                                        <span style={{
                                                            fontSize: '0.5625rem', fontWeight: 600, padding: '1px 6px', borderRadius: '4px',
                                                            background: c.type === 'FIXO' ? 'rgba(245,158,11,0.1)' : 'rgba(59,130,246,0.1)',
                                                            color: c.type === 'FIXO' ? 'var(--warning)' : 'var(--info)',
                                                        }}>{c.type === 'FIXO' ? <><Pin size={10} aria-hidden="true" style={{ verticalAlign: '-1px' }} /> Fixo</> : <><RefreshCw size={10} aria-hidden="true" style={{ verticalAlign: '-1px' }} /> {TYPE_LABEL[c.type] || 'Flex'}</>}</span>
                                                        {c.status === 'COMPLETED' && (
                                                            <span style={{
                                                                fontSize: '0.5625rem', fontWeight: 700, padding: '1px 6px', borderRadius: '4px',
                                                                background: 'var(--success-bg)', color: 'var(--success)',
                                                                display: 'inline-flex', alignItems: 'center', gap: 3,
                                                            }}><CheckCircle2 size={10} aria-hidden="true" /> Concluído</span>
                                                        )}
                                                    </div>
                                                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                                                        {c.type === 'FIXO' && c.fixedDayOfWeek != null && (
                                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><CalendarDays size={12} aria-hidden="true" /> {DAY_NAMES[c.fixedDayOfWeek]} {c.fixedTime ? `às ${c.fixedTime}` : ''}</span>
                                                        )}
                                                        {c.type === 'FLEX' && c.flexCreditsRemaining != null && (
                                                            <span style={{ color: c.flexCreditsRemaining > 0 ? 'var(--success)' : 'var(--danger)', fontWeight: 600 }}>
                                                                {c.flexCreditsRemaining > 0 ? `✅ ${c.flexCreditsRemaining} crédito${c.flexCreditsRemaining > 1 ? 's' : ''} restante${c.flexCreditsRemaining > 1 ? 's' : ''}` : '❌ Sem créditos'}
                                                            </span>
                                                        )}
                                                        {!hasCredits && <span style={{ color: 'var(--danger)', fontWeight: 600 }}>Créditos esgotados</span>}
                                                        {/* FIN-04: sem a baixa, a sessão a mais no FIXO concluído é extra e cobrada (o servidor reabre o plano de qualquer jeito). */}
                                                        {c.status === 'COMPLETED' && hasCredits && <span>{!canMarkPaid && c.type === 'FIXO' ? 'Todas as sessões feitas · uma sessão a mais é extra e será cobrada' : 'Todas as sessões feitas · vincular reabre o plano'}</span>}
                                                    </div>
                                                </div>

                                                {isSelected && <Check size={17} style={{ color: ct.color }} aria-hidden="true" />}
                                            </div>
                                        );
                                    })}

                                    {clientContracts.length === 0 && (
                                        <div style={{
                                            padding: '16px', borderRadius: '10px', textAlign: 'center',
                                            background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.15)',
                                            color: 'var(--warning)', fontSize: '0.8125rem', fontWeight: 600,
                                        }}>
                                            <AlertTriangle size={13} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> Cliente sem contratos ativos · Será criado contrato avulso
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* -- Date -- */}
                            <div style={{ marginBottom: '18px' }}>
                                <label htmlFor={`${uid}-date`} style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px', display: 'block' }}>
                                    <CalendarDays size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} aria-hidden="true" />Data da gravação
                                </label>
                                <input id={`${uid}-date`} type="date" value={createForm.date}
                                    min={todayStr}
                                    aria-label="Data da gravação"
                                    onChange={e => {
                                        const newDate = e.target.value;
                                        setCreateForm({ ...createForm, date: newDate, startTime: '' });
                                        if (newDate) loadDaySlots(newDate);
                                    }}
                                    className="form-input form-input--raised"
                                />
                                {/* FIXO day mismatch warning */}
                                {isFixoDayMismatch && (
                                    <div style={{
                                        marginTop: '8px', padding: '8px 12px', borderRadius: '8px',
                                        background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
                                        fontSize: '0.75rem', color: 'var(--warning)', fontWeight: 600, lineHeight: 1.5,
                                    }}>
                                        <AlertTriangle size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} aria-hidden="true" />Contrato {activeContract?.name} é fixo em <strong>{DAY_NAMES[activeContract!.fixedDayOfWeek!]}</strong>. A data selecionada é {DAY_NAMES[selectedDateDOW!]}.
                                    </div>
                                )}
                            </div>

                            {/* -- Filtered Slot Grid -- */}
                            {createForm.date && (
                                <div>
                                    <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        Horário disponível
                                        {filterTier && (
                                            <span style={{
                                                fontSize: '0.5625rem', fontWeight: 700, padding: '1px 8px', borderRadius: '4px',
                                                background: tc(filterTier).bg, color: tc(filterTier).color,
                                            }}>
                                                Filtrado: {TIER_LABEL[filterTier]}
                                            </span>
                                        )}
                                    </label>
                                    {slotsLoading ? (
                                        <div style={{ padding: '24px', textAlign: 'center' }}><BrandLoader size="inline" label="Carregando horários…" /></div>
                                    ) : isPastDate ? (
                                        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--warning)', fontSize: '0.8125rem', background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.15)', borderRadius: 10, fontWeight: 600 }}>
                                            Data no passado — escolha uma data a partir de hoje.
                                        </div>
                                    ) : slotsForDay.filter(s => s.available).length === 0 ? (
                                        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8125rem', background: 'var(--bg-elevated)', borderRadius: 10 }}>
                                            {isToday
                                                ? 'Nenhum horário disponível ainda hoje — os horários de hoje já passaram ou estão ocupados.'
                                                : filterTier
                                                    ? `Nenhum horário ${TIER_LABEL[filterTier]} disponível nesta data`
                                                    : 'Nenhum horário disponível nesta data'}
                                        </div>
                                    ) : (
                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '6px' }}>
                                            {slotsForDay.map(slot => {
                                                const isSelected = createForm.startTime === slot.time;
                                                const slotTc = tc(slot.tier || 'COMERCIAL');
                                                return (
                                                    <button key={slot.time} type="button"
                                                        disabled={!slot.available}
                                                        onClick={() => { setCreateForm({ ...createForm, startTime: slot.time }); if (!createForm.contractId && slot.price != null) { setCustomPrice(slot.price); setPriceDraft(slot.price); } }}
                                                        style={{
                                                            padding: '10px 8px', borderRadius: '10px', cursor: slot.available ? 'pointer' : 'not-allowed',
                                                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
                                                            background: isSelected ? slotTc.bg : !slot.available ? 'rgba(255,255,255,0.02)' : 'var(--bg-elevated)',
                                                            border: `1px solid ${isSelected ? slotTc.color + '55' : 'var(--border-default)'}`,
                                                            opacity: slot.available ? 1 : 0.35,
                                                            transition: 'background 0.15s ease, border-color 0.15s ease',
                                                            fontFamily: 'inherit',
                                                        }}
                                                        aria-pressed={isSelected}
                                                    >
                                                        <span style={{ fontSize: '0.875rem', fontWeight: 700, color: isSelected ? slotTc.color : 'var(--text-primary)' }}>
                                                            {slot.time}
                                                        </span>
                                                        <span style={{
                                                            fontSize: '0.5625rem', fontWeight: 600, padding: '1px 6px', borderRadius: '4px',
                                                            background: slot.available ? slotTc.bg : 'rgba(255,255,255,0.05)',
                                                            color: slot.available ? slotTc.color : 'var(--text-muted)',
                                                        }}>
                                                            {slot.available ? (slot.tier ? getMeta(TIER_META, slot.tier).label : '') : 'Ocupado'}
                                                        </span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            )}
                            </div>

                            <div className="admin-actions-row admin-actions-row--between" style={{ marginTop: '20px' }}>
                                <button key="back" type="button" onClick={() => setCreateStep(1)} className="btn-admin-ghost">
                                    ← Voltar
                                </button>
                                <button key="next" type="button" disabled={!createForm.date || !createForm.startTime}
                                    onClick={ignoreMultiClick(() => { setTimeout(() => setCreateStep(3), 0); })}
                                    className="btn-admin-go">
                                    Próximo →
                                </button>
                            </div>
                        </div>
                        );
                    })()}

                    {/* -------- STEP 3: Confirm -------- */}
                    {createStep === 3 && (
                        <div style={stepBodyStyle}>
                            <div style={stepContentStyle}>
                            {/* Summary card */}
                            <div style={{
                                padding: '18px', borderRadius: '14px', marginBottom: '18px',
                                background: 'var(--bg-elevated)', border: '1px solid rgba(16,185,129,0.15)',
                            }}>
                                <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '14px' }}>
                                    Resumo do Agendamento
                                </div>

                                <div className="admin-grid-2" style={{ gap: '12px 20px' }}>
                                    <div>
                                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>Cliente</div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <div style={{
                                                width: 28, height: 28, borderRadius: '50%', background: 'var(--accent-gradient-go)',
                                                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6875rem', fontWeight: 700, color: '#fff',
                                            }}>{selectedUser?.name?.charAt(0).toUpperCase()}</div>
                                            <span style={{ fontWeight: 600, fontSize: '0.8125rem' }}>{selectedUser?.name}</span>
                                        </div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>Data</div>
                                        <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>
                                            {createForm.date ? new Date(createForm.date + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                                        </div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>Horário</div>
                                        <div style={{ fontWeight: 700, fontSize: '1rem' }}>{createForm.startTime || '—'}</div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>Faixa</div>
                                        {selectedSlot?.tier ? (
                                            <span style={{
                                                display: 'inline-flex', alignItems: 'center', gap: '4px',
                                                padding: '2px 10px', borderRadius: '6px', fontSize: '0.6875rem', fontWeight: 700,
                                                background: tc(selectedSlot.tier).bg, color: tc(selectedSlot.tier).color,
                                            }}>
                                                {(() => { const TI = tc(selectedSlot.tier).icon; return <TI size={12} aria-hidden="true" />; })()} {getMeta(TIER_META, selectedSlot.tier).label}
                                            </span>
                                        ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                    </div>
                                    <div style={{ gridColumn: '1 / -1' }}>
                                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>Contrato</div>
                                        <div style={{ fontWeight: 600, fontSize: '0.8125rem' }}>
                                            {selectedContract ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>{(() => { const TI = tc(selectedContract.tier).icon; return <TI size={13} aria-hidden="true" />; })()} {selectedContract.name}</span> : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Zap size={13} aria-hidden="true" /> Avulso (contrato automático)</span>}
                                        </div>
                                    </div>
                                    {/* Sem a baixa manual: valor da faixa, sem edição (preço manual exige cobrancas.baixa). */}
                                    {!createForm.contractId && !canMarkPaid && (
                                        <div style={{ gridColumn: '1 / -1', marginTop: '4px' }}>
                                            <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}><Wallet size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} aria-hidden="true" />Valor do Agendamento</div>
                                            <div style={{ fontWeight: 800, fontSize: '1.125rem', color: 'var(--success)' }}>{customPrice != null ? formatBRL(customPrice) : 'Preço da faixa'}</div>
                                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '2px' }}>Preço da faixa. Mudar o valor exige a permissão “Marcar como pago, anular ou estornar”.</div>
                                        </div>
                                    )}
                                    {/* Editable price for Avulso */}
                                    {!createForm.contractId && canMarkPaid && (
                                        <div style={{ gridColumn: '1 / -1', marginTop: '4px' }}>
                                            <label htmlFor={`${uid}-price`} style={{ display: 'block', fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '6px' }}><Wallet size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} aria-hidden="true" />Valor do Agendamento</label>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                <CurrencyInput
                                                    id={`${uid}-price`}
                                                    value={priceDraft}
                                                    onChange={setPriceDraft}
                                                    wrapperStyle={{ flex: 1, maxWidth: '200px' }}
                                                    prefixStyle={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--success)' }}
                                                    style={{
                                                        padding: '8px 12px 8px 38px', borderRadius: '10px',
                                                        fontSize: '1.125rem', fontWeight: 800,
                                                        background: 'var(--bg-elevated)', border: '1px solid rgba(16,185,129,0.3)',
                                                        color: 'var(--success)',
                                                    }}
                                                    onFocus={e => (e.currentTarget.style.borderColor = 'var(--success)')}
                                                    onBlur={e => {
                                                        e.currentTarget.style.borderColor = 'rgba(16,185,129,0.3)';
                                                        // Commit do rascunho (centavos). Sem digitação e sem preço do slot
                                                        // (null), mantém customPrice null → o backend usa o preço da faixa.
                                                        if (priceDraft != null) setCustomPrice(priceDraft);
                                                    }}
                                                />
                                                <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                                                    Editável · Apenas para este agendamento
                                                </span>
                                            </div>
                                        </div>
                                    )}
                                    {/* Linha do cupom aplicado (só avulso) */}
                                    {!createForm.contractId && appliedCoupon && (
                                        <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8125rem', fontWeight: 700, color: 'var(--success)' }}>
                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><TicketPercent size={13} aria-hidden="true" /> Cupom {appliedCoupon.code}</span>
                                            <span>−{formatBRL(appliedCoupon.discountAmount)}</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Serviços por gravação — herdam o desconto do contrato (avulso = 0%) */}
                            {addons.length > 0 && (
                                <div style={{ marginBottom: '14px' }}>
                                    <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        <Sparkles size={13} aria-hidden="true" /> Serviços desta gravação
                                        {selectedContract && inheritedDiscount > 0 && (
                                            <span style={{ fontSize: '0.5625rem', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: 'rgba(45,212,191,0.12)', color: 'var(--accent-text)' }}>-{inheritedDiscount}% do contrato</span>
                                        )}
                                    </label>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                        {addons.map(addon => {
                                            const selected = selectedAddons.includes(addon.key);
                                            const perRecording = Math.round(addon.price * (1 - inheritedDiscount / 100));
                                            return (
                                                <ServiceLineItem
                                                    key={addon.key}
                                                    name={addon.name}
                                                    perRecordingCents={perRecording}
                                                    compact
                                                    selected={selected}
                                                    onToggle={() => setSelectedAddons(prev => selected ? prev.filter(k => k !== addon.key) : [...prev, addon.key])}
                                                />
                                            );
                                        })}
                                    </div>
                                    {servicesValue > 0 && (
                                        <div style={{ marginTop: 8, fontSize: '0.75rem', color: 'var(--accent-text)', fontWeight: 700, textAlign: 'right' }}>
                                            +{formatBRL(servicesValue)} em serviços {createForm.contractId ? '(somados a esta gravação)' : '(somados ao valor)'}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Cupom de desconto (só avulso — elegibilidade validada para o CLIENTE selecionado) */}
                            {!createForm.contractId && (
                                <div style={{ marginBottom: '14px' }}>
                                    <CouponField
                                        amount={(customPrice || 0) + servicesValue}
                                        userId={createForm.userId || undefined}
                                        applied={appliedCoupon}
                                        onApply={setAppliedCoupon}
                                        onRemove={() => setAppliedCoupon(null)}
                                        disabled={creating}
                                    />
                                    {zeroNeedsBaixa && (
                                        <div id={`${uid}-zero-coupon`} className="admin-alert admin-alert--warning" role="status" style={{ marginTop: '8px', marginBottom: 0, fontSize: '0.75rem', lineHeight: 1.45 }}>
                                            <AlertTriangle size={13} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 4 }} />{ZERO_COUPON_NEEDS_BAIXA}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Avulso: cobrar agora (mesmo InlineCheckout do cliente) — só com cobrancas.cobrar */}
                            {!createForm.contractId && canCharge && (
                                <div style={{ marginBottom: '14px' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '12px 14px', borderRadius: '10px', background: chargeNow ? 'rgba(17,129,155,0.08)' : 'var(--bg-elevated)', border: `1px solid ${chargeNow ? 'rgba(17,129,155,0.35)' : 'var(--border-default)'}` }}>
                                        <input type="checkbox" checked={chargeNow} onChange={e => setChargeNow(e.target.checked)} style={{ width: 18, height: 18, accentColor: 'var(--accent-primary)', cursor: 'pointer' }} />
                                        <div>
                                            <div style={{ fontSize: '0.8125rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}><CreditCard size={14} aria-hidden="true" /> Cobrar o cliente agora</div>
                                            <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', marginTop: '2px' }}>Gera PIX ou cobra o cartão do cliente (presente) — a forma pode ser trocada na hora de cobrar. Sem marcar, segue o status escolhido.</div>
                                        </div>
                                    </label>
                                    {chargeNow && (
                                        <div className="admin-grid-2" style={{ gap: '8px', marginTop: '8px' }}>
                                            {([{ key: 'PIX' as const, icon: Zap, label: 'PIX' }, { key: 'CARTAO' as const, icon: CreditCard, label: 'Cartão' }]).map(m => {
                                                const active = chargeMethod === m.key;
                                                return (
                                                    <button key={m.key} type="button" onClick={() => setChargeMethod(m.key)} aria-pressed={active}
                                                        style={{ padding: '10px', minHeight: 44, borderRadius: '10px', cursor: 'pointer', textAlign: 'center', fontFamily: 'inherit', background: active ? 'rgba(17,129,155,0.10)' : 'var(--bg-elevated)', border: `1.5px solid ${active ? 'rgba(17,129,155,0.4)' : 'var(--border-default)'}`, transition: 'background 0.15s ease, border-color 0.15s ease' }}>
                                                        <m.icon size={14} style={{ verticalAlign: '-2px' }} aria-hidden="true" /> <span style={{ fontSize: '0.75rem', fontWeight: 700, color: active ? 'var(--accent-text)' : 'var(--text-primary)' }}>{m.label}</span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            )}
                            {/* Status */}
                            <div style={{ marginBottom: '14px' }}>
                                <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px', display: 'block' }}>Status inicial</label>
                                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                                    {[{ key: 'CONFIRMED', icon: CheckCircle2, label: 'Confirmado' }, { key: 'RESERVED', icon: ClockIcon, label: 'Reservado' }].map(s => {
                                        // "Confirmado" grava o pagamento como PAGO: travado (com a explicação) sem a baixa manual.
                                        const locked = s.key === 'CONFIRMED' && !canMarkPaid;
                                        const on = !locked && createForm.status === s.key;
                                        const btn = (
                                            <button key={s.key} type="button"
                                                onClick={() => { if (!locked) setCreateForm({ ...createForm, status: s.key }); }}
                                                aria-pressed={on}
                                                disabled={locked}
                                                aria-describedby={locked ? `${uid}-confirmed-locked` : undefined}
                                                style={{
                                                    padding: '8px 16px', minHeight: 40, borderRadius: '8px', fontSize: '0.8125rem', fontWeight: 600, cursor: locked ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
                                                    background: on ? 'var(--success-bg)' : 'var(--bg-elevated)',
                                                    border: `1px solid ${on ? 'rgba(16,185,129,0.3)' : 'var(--border-default)'}`,
                                                    color: on ? 'var(--success)' : 'var(--text-secondary)',
                                                    opacity: locked ? 0.55 : 1,
                                                    transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
                                                }}>
                                                <s.icon size={13} style={{ verticalAlign: '-2px', marginRight: 5 }} aria-hidden="true" />{s.label}
                                            </button>
                                        );
                                        // Botão desabilitado não dispara eventos de ponteiro: a dica vai no span.
                                        return locked ? (
                                            <Tooltip key={s.key} content={fixoCapUsed ? CONFIRMED_LOCKED_HINT : fixoLocked ? CONFIRMED_LOCKED_HINT_FIXO : planReservedLocked ? CONFIRMED_LOCKED_HINT_PLAN : CONFIRMED_LOCKED_HINT}>
                                                <span style={{ display: 'inline-flex' }} tabIndex={0}>{btn}</span>
                                            </Tooltip>
                                        ) : btn;
                                    })}
                                </div>
                                {!canMarkPaid && (fixoLocked ? (
                                    // FIN-04: antes de agendar — no FIXO a sessão a mais é extra e cobrada (quase sempre).
                                    <div id={`${uid}-confirmed-locked`} className="admin-alert admin-alert--warning" role="status" style={{ marginTop: '8px', marginBottom: 0, fontSize: '0.75rem', lineHeight: 1.45 }}>
                                        <AlertTriangle size={13} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 4 }} />{fixoCapUsed ? FIXO_EXTRA_CHARGED_NOTE : FIXO_EXTRA_NOTE}
                                    </div>
                                ) : (
                                    <div id={`${uid}-confirmed-locked`} style={{ marginTop: '6px', fontSize: '0.6875rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                                        {planReservedLocked
                                            ? PLAN_RESERVED_NOTE
                                            : 'O agendamento nasce Reservado, aguardando pagamento: confirmar na criação registra o pagamento como pago.'}
                                    </div>
                                ))}
                            </div>

                            {/* Admin notes */}
                            <div style={{ marginBottom: '14px' }}>
                                <label htmlFor={`${uid}-adminNotes`} style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px', display: 'block' }}>
                                    <NotebookPen size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} aria-hidden="true" />Notas internas (opcional)
                                </label>
                                <textarea
                                    id={`${uid}-adminNotes`}
                                    value={createForm.adminNotes}
                                    onChange={e => setCreateForm({ ...createForm, adminNotes: e.target.value })}
                                    placeholder="Observações internas sobre esta gravação..."
                                    rows={3}
                                    className="form-input form-input--raised"
                                    style={{ fontSize: '0.8125rem', resize: 'vertical' }}
                                />
                            </div>
                            </div>

                            <div className="admin-actions-row admin-actions-row--between" style={{ marginTop: '20px' }}>
                                <button key="back" type="button" onClick={() => setCreateStep(2)} className="btn-admin-ghost">
                                    ← Voltar
                                </button>
                                <button key="submit" type="button" onClick={ignoreMultiClick(handleCreate)} disabled={creating || zeroNeedsBaixa}
                                    aria-describedby={zeroNeedsBaixa ? `${uid}-zero-coupon` : undefined} className="btn-admin-go">
                                    {creating ? 'Criando…' : <><CalendarDays size={15} aria-hidden="true" /> Agendar</>}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
        </BottomSheetModal>
    );
}
