import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { contractsApi, pricingApi, paymentsApi, bookingsApi, ContractDetail, PaymentSummary, AddOnConfig, Booking } from '../api/client';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { useUI } from '../context/UIContext';
import { HeroSkeleton, TableSkeleton } from '../components/ui/SkeletonLoader';
import StatusBadge from '../components/ui/StatusBadge';
import Tooltip from '../components/ui/Tooltip';
import BrandLoader from '../components/ui/BrandLoader';
import ServiceLineItem from '../components/ui/ServiceLineItem';
import ServiceContractPanel from '../components/client/ServiceContractPanel';
import ChargeNowSheet from '../components/admin/ChargeNowSheet';
import FinalizeRecordingModal from '../components/admin/bookings/FinalizeRecordingModal';
import { MakeupStatusPanel } from '../components/admin/bookings/MakeupRescheduleModal';
import { TIER_META, BOOKING_STATUS_META, CONTRACT_STATUS_META, CONTRACT_TYPE_META, PAYMENT_STATUS_META, getMeta } from '../constants/adminMeta';
import { getPaymentBadge, providerToMethod } from '../constants/paymentMethods';
import { describeContractTerms } from '../utils/contractStatus';
import { decomposeBookingPricing, AddonCatalogEntry } from '../utils/bookingPricing';
import { formatBRL } from '../utils/format';
import { paidChargedAmount } from '../utils/clientHealth';
import { getErrorMessage } from '../utils/errors';
import { todayStrSaoPaulo } from '../utils/time';
import { bookingSummary } from '../components/admin/bookings/bookingDanger';
import { ArrowLeft, Mic, CreditCard, Receipt, Sparkles, ExternalLink, CheckCircle2, Zap, Eye, MessageCircle, Radio, ClipboardCheck, UserX, RefreshCw, FolderSymlink, Scale, Undo2 } from 'lucide-react';
import { usePermission } from '../hooks/usePermission';
import { useBookingPermissions } from '../components/admin/bookings/bookingPermissions';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
/** Instante (ISO) → data no fuso do estúdio. Para carimbos de data/hora (pedido/cancelamento), não para datas @db.Date. */
const fmtDateSP = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'short', year: 'numeric' });

/** E13: a cobrança é a multa de cancelamento (rótulo próprio, fora da contagem de parcelas). */
const isFinePayment = (p: PaymentSummary) => p.kind === 'CANCELLATION_FINE' || p.metadata?.kind === 'CANCELLATION_FINE';

export default function AdminContractDetailPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const { showToast, showConfirm } = useUI();
    // Equipe (D2): cada ação segue a sua chave; a página em si abre com contratos.ver (rota).
    const { can } = usePermission();
    // Confirmar presença (FE-3): check-in (hoje.presenca) OU PATCH RESERVED→CONFIRMED (agendamentos.editar),
    // a mesma regra do Painel e da tela Hoje (bp.canConfirmPresence).
    const bp = useBookingPermissions();
    // MAT-01: Renovar = criar contrato E baixa manual — a renovação não gera parcelas (o servidor exige as duas).
    const canRenewPerm = can('contratos.criar') && can('cobrancas.baixa');
    const canConditions = can('contratos.condicoes');      // Editar serviços (reprecifica parcelas)
    const canRecord = can('hoje.gravacao');                // Iniciar / desfazer / finalizar / dados da gravação
    const canCharge = can('cobrancas.cobrar');             // Cobrar parcela/multa (e simular no sandbox)
    const canMarkPaid = can('cobrancas.baixa');            // Marcar pago (baixa manual)
    const canDecideFine = can('contratos.multa');          // Pedido de cancelamento
    const canOpenClient = can('clientes.ver');             // link para o perfil do cliente
    const { get: getRule } = useBusinessConfig();
    const sessionsPerMonth = getRule('sessions_per_month');

    const [contract, setContract] = useState<ContractDetail | null>(null);
    const [addons, setAddons] = useState<AddOnConfig[]>([]);
    const [loading, setLoading] = useState(true);
    const [sandbox, setSandbox] = useState(false);
    const [charge, setCharge] = useState<PaymentSummary | null>(null);
    const [chargeError, setChargeError] = useState('');
    const [editingServices, setEditingServices] = useState(false);
    const [serviceDraft, setServiceDraft] = useState<string[]>([]);
    const [savingServices, setSavingServices] = useState(false);
    const [finalizeBooking, setFinalizeBooking] = useState<Booking | null>(null);
    /** true durante uma recarga SILENCIOSA (após uma ação): a página continua na tela, com "Atualizando…". */
    const [refreshing, setRefreshing] = useState(false);
    const loadedOnce = useRef(false);

    const load = useCallback(async () => {
        if (!id) return;
        if (loadedOnce.current) setRefreshing(true);
        try {
            const [c, a] = await Promise.all([contractsApi.getById(id), pricingApi.getAddons()]);
            setContract(c.contract);
            setAddons(a.addons);
        } catch { setContract(null); }
        finally { loadedOnce.current = true; setLoading(false); setRefreshing(false); }
    }, [id]);

    // `load` só muda com o id: trocar de contrato na MESMA tela (link "abrir contrato novo" da renovação)
    // volta ao esqueleto em vez de mostrar o contrato anterior com "Atualizando…".
    useEffect(() => { loadedOnce.current = false; setLoading(true); setCharge(null); load(); }, [load]);
    useEffect(() => { paymentsApi.getSandboxMode().then(s => setSandbox(s.pix || s.card)).catch(() => {}); }, []);

    if (loading) return <div><HeroSkeleton /><TableSkeleton rows={4} cols={3} /></div>;
    if (!contract) return (
        <div style={{ padding: 24 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/contracts')}><ArrowLeft size={14} /> Voltar</button>
            <div style={{ marginTop: 24, textAlign: 'center', color: 'var(--text-muted)' }}>Contrato não encontrado.</div>
        </div>
    );

    // Add-on catalog for booking decomposition + contract services summary.
    const catalog: Record<string, AddonCatalogEntry> = Object.fromEntries(addons.map(a => [a.key, { name: a.name, price: a.price, monthly: a.monthly }]));
    const discountPct = contract.discountPct || 0;
    const priceIncludesServices = contract.type === 'AVULSO'; // contract bookings bill services monthly; avulso bundles them

    // Per-episode services on the contract (accompany every recording).
    const episodeServices = (contract.addOns || []).map(k => addons.find(a => a.key === k)).filter((a): a is AddOnConfig => !!a && !a.monthly);
    const monthlyServices = (contract.addOns || []).map(k => addons.find(a => a.key === k)).filter((a): a is AddOnConfig => !!a && !!a.monthly);

    // Payment-derived totals (most reliable single source). "Pago" = valor EFETIVAMENTE cobrado (no
    // cartão, o do PaymentIntent — mesmo critério do fechamento financeiro); em aberto = o amount.
    const payments = contract.payments || [];
    const valueOf = (p: PaymentSummary) => (p.status === 'PAID' ? paidChargedAmount(p) : p.amount);
    // E13: a multa de cancelamento não é parcela — fica fora do "Valor do contrato" e da numeração das
    // parcelas (as demais mantêm o número original, mesmo anuladas). Em "Pago"/"Pendente" ela entra: é
    // dinheiro recebido / a receber de verdade.
    const contractValue = payments.filter(p => !isFinePayment(p)).reduce((s, p) => s + valueOf(p), 0);
    const installmentNumber = new Map(payments.filter(p => !isFinePayment(p)).map((p, i) => [p.id, i + 1]));
    const paidValue = payments.filter(p => p.status === 'PAID').reduce((s, p) => s + paidChargedAmount(p), 0);
    const pendingValue = payments.filter(p => p.status === 'PENDING' || p.status === 'FAILED').reduce((s, p) => s + p.amount, 0);

    const bookings = contract.bookings || [];
    const completedCount = bookings.filter(b => b.status === 'COMPLETED').length;

    // Vigência/duração/plano coerentes com o TIPO (avulso = data da gravação, sessão e pagamento únicos).
    const terms = describeContractTerms(contract, bookings, payments);

    // Forma de pagamento: a do contrato; sem ela (avulsos antigos criados pelo admin não a gravavam),
    // a da parcela — a paga, senão a primeira — pelo provedor (SICOOB/CORA → PIX, STRIPE → Cartão).
    const methodPayment = payments.find(p => p.status === 'PAID') ?? payments[0];
    const paymentMethodKey = contract.paymentMethod
        || (methodPayment ? providerToMethod(methodPayment.provider, { boletoUrl: methodPayment.boletoUrl, pixString: methodPayment.pixString }) : null);

    const cMeta = getMeta(CONTRACT_STATUS_META, contract.status);
    const tMeta = getMeta(CONTRACT_TYPE_META, contract.type);
    const tierMeta = getMeta(TIER_META, contract.tier);

    // D3: marcar pago = warning. Efeitos reais do PATCH /payments/:id {PAID} (payments.admin.ts):
    // roda onPaymentConfirmed (confirma gravação/contrato, cupom, notifica o cliente) e PAID só
    // pode virar REFUNDED depois. Sem try/catch: com tone o erro aparece dentro do diálogo.
    const markPaid = (p: PaymentSummary) => showConfirm({
        tone: 'warning',
        icon: CheckCircle2,
        title: `Marcar ${formatBRL(p.amount)} como pago?`,
        message: 'Use só se o valor foi recebido por fora do sistema (dinheiro, transferência, maquininha).',
        consequences: [
            // E13: a multa paga só avisa o cliente — não reativa nem confirma nada do contrato cancelado.
            ...(isFinePayment(p)
                ? [
                    'A multa de cancelamento passa a Paga, com a data de hoje como data do pagamento.',
                    'O cliente é avisado do pagamento confirmado; o contrato continua Cancelado.',
                ]
                : [
                    'A parcela passa a Pago, com a data de hoje como data do pagamento.',
                    'O sistema segue como num pagamento online: confirma a gravação ou o contrato vinculado, confirma o cupom usado e avisa o cliente.',
                ]),
            ...(p.pixString || p.boletoUrl
                ? ['Um PIX ou boleto já emitido para esta cobrança continua válido no banco — oriente o cliente a não pagá-lo.']
                : []),
            'Depois disso ela não volta a Pendente (só pode ser marcada como estornada).',
        ],
        confirmLabel: 'Marcar como pago',
        onConfirm: async () => {
            await paymentsApi.update(p.id, { status: 'PAID' });
            showToast('Pagamento marcado como pago.');
            await load();
        },
    });

    const simulate = async (p: PaymentSummary) => { try { await paymentsApi.simulate(p.id); showToast('Pagamento simulado (sandbox).'); load(); } catch { showToast('Erro na simulação.'); } };

    // E4 — mesma confirmação neutra da lista. O botão só aparece com `contract.canRenew` (backend); se ainda
    // assim a renovação for recusada (já renovado por outro admin), mostra o motivo e recarrega.
    const renew = () => showConfirm({
        title: 'Renovar Contrato',
        message: `Renovar "${contract.name}" por mais 3 meses?`,
        onConfirm: async () => {
            try {
                const r = await contractsApi.renew(contract.id, { durationMonths: 3 });
                showToast(r.message);
            } catch (e) {
                showToast({ message: getErrorMessage(e) || 'Erro ao renovar o contrato.', type: 'error' });
            }
            load();
        },
    });

    // E13 — cancelamento e multa (dados do backend; o pedido congela o % — a base é a efetiva: parcela paga
    // durante a análise sai, e a multa nunca aumenta).
    const fine = contract.cancellationFine;
    const clientDeleted = !!(contract.user as { deletedAt?: string | null } | undefined)?.deletedAt;
    const openCharge = (p: PaymentSummary) => { setChargeError(''); setCharge(p); };

    // Fluxo de gravação em etapas: Confirmar presença → Iniciar (registra operador) → Finalizar.
    // "Iniciar" só é oferecido para sessão de hoje ou passada; se ainda assim o backend recusar
    // (400 RECORDING_START_FUTURE), a mensagem dele aparece no aviso de erro.
    const bookingStep = async (bookingId: string, action: 'checkin' | 'start') => {
        try {
            // Confirmar presença: o check-in exige hoje.presenca; quem só tem agendamentos.editar confirma
            // pelo PATCH (RESERVED → CONFIRMED, mesma tabela de transições do servidor) — como no Painel.
            const res = action === 'checkin'
                ? (bp.canCheckIn ? await bookingsApi.checkIn(bookingId) : await bookingsApi.update(bookingId, { status: 'CONFIRMED' }))
                : await bookingsApi.startRecording(bookingId);
            showToast(res.message);
            load();
        } catch (e) { showToast({ message: getErrorMessage(e) || 'Erro ao atualizar a gravação.', type: 'error' }); }
    };

    // "Iniciar gravação" clicado por engano: desfaz o início — mesma confirmação e mesmos textos da tela Hoje.
    // Sem try/catch no onConfirm: o erro da API (ex.: 409 já finalizada) aparece DENTRO do diálogo.
    const undoStartRecording = (b: Booking) => showConfirm({
        tone: 'warning',
        icon: Undo2,
        title: 'Desfazer o início da gravação?',
        message: bookingSummary({ ...b, user: { name: contract.user?.name || '' }, contract: b.contract ?? { id: contract.id, name: contract.name, type: contract.type, tier: contract.tier } }),
        consequences: [
            'O registro de quem iniciou e do horário de início é apagado.',
            'O cliente deixa de ver o selo "AO VIVO" nesta gravação.',
            'Para finalizar, será preciso clicar em "Iniciar gravação" de novo.',
            'O agendamento continua confirmado — nada é cancelado nem cobrado.',
        ],
        confirmLabel: 'Desfazer início',
        loadingLabel: 'Desfazendo…',
        onConfirm: async () => {
            // Recusado (ex.: outra aba já finalizou): o detalhe daqui está velho — recarrega por trás do diálogo.
            const res = await bookingsApi.undoStartRecording(b.id).catch((err: unknown) => { void load(); throw err; });
            showToast(res.message || 'Início da gravação desfeito.');
            await load();
        },
    });
    /** Hoje no fuso do estúdio (YYYY-MM-DD) — "Iniciar gravação" só aparece para sessão de hoje ou passada. */
    const todaySP = todayStrSaoPaulo();


    // Editing recurring services is allowed only for FIXO/FLEX active contracts (recompute future).
    // Equipe: "Mudar créditos, serviços e condições de pagamento" (contratos.condicoes).
    const canEditServices = canConditions && contract.status === 'ACTIVE' && (contract.type === 'FIXO' || contract.type === 'FLEX');
    const episodeCatalog = addons.filter(a => !a.monthly);
    const startEditServices = () => { setServiceDraft(episodeServices.map(s => s.key)); setEditingServices(true); };
    const saveServices = async () => {
        setSavingServices(true);
        try {
            const monthlyKept = (contract.addOns || []).filter(k => addons.find(a => a.key === k)?.monthly);
            await contractsApi.update(contract.id, { addOns: [...monthlyKept, ...serviceDraft] });
            setEditingServices(false);
            showToast('Serviços atualizados. Parcelas pendentes e próximos episódios recalculados.');
            load();
        } catch (e) { showToast(getErrorMessage(e) || 'Erro ao atualizar serviços.'); }
        finally { setSavingServices(false); }
    };

    return (
        <div>
            <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 32 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/contracts')}><ArrowLeft size={14} /> Voltar para Contratos</button>
                {/* Recarga silenciosa após uma ação (cobrar, marcar pago, renovar, editar serviços…). */}
                {refreshing && <BrandLoader size="inline" label="Atualizando…" />}
            </div>

            {/* ── Header ── */}
            <div className="admin-card" style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                    <div style={{ width: 52, height: 52, borderRadius: 14, flexShrink: 0, display: 'grid', placeItems: 'center', background: tierMeta.bg, color: tierMeta.color }}>
                        {(() => { const TI = tMeta.icon; return <TI size={24} />; })()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <h1 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0 }}>{contract.name}</h1>
                        {/* O perfil do cliente só abre com "Ver clientes": sem ela, o nome é só texto. */}
                        {contract.user && (canOpenClient ? (
                            <button onClick={() => navigate(`/admin/clients/${contract.user!.id}`)}
                                style={{ marginTop: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent-primary)', fontSize: '0.8125rem', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                {contract.user.name} <ExternalLink size={12} />
                            </button>
                        ) : (
                            <div style={{ marginTop: 4, color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600 }}>{contract.user.name}</div>
                        ))}
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                            <StatusBadge meta={tMeta} />
                            <StatusBadge meta={tierMeta} label={tierMeta.label.toLocaleUpperCase('pt-BR')} />
                            <StatusBadge meta={cMeta} />
                            {clientDeleted && (
                                <StatusBadge meta={{ label: 'Cliente excluído', color: 'var(--danger)', bg: 'var(--danger-bg)', icon: UserX }} />
                            )}
                            {contract.contractUrl && (
                                <a href={contract.contractUrl} target="_blank" rel="noopener noreferrer" className="status-badge status-badge--sm" style={{ color: 'var(--accent-primary)', background: 'var(--tier-audiencia-bg)', textDecoration: 'none' }}>
                                    <ExternalLink size={12} /> <span className="status-badge__text">Contrato digital</span>
                                </a>
                            )}
                        </div>
                    </div>
                    {/* E4 — Renovar: só quando o backend libera (`canRenew`: plano Ativo/Concluído a ≤ 30 dias do fim
                        ou Expirado, ainda não renovado, nunca avulso/serviço nem cliente excluído). Já renovado →
                        atalho para o contrato novo. Equipe: Renovar exige "Criar e renovar contratos" E "Marcar como
                        pago, anular ou estornar" — a renovação não gera parcelas (MAT-01). */}
                    {((canRenewPerm && contract.canRenew) || (contract.alreadyRenewed && contract.renewedToId)) && (
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                            {canRenewPerm && contract.canRenew && (
                                <button type="button" className="btn btn-secondary btn-sm" onClick={renew}
                                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                    <RefreshCw size={14} aria-hidden="true" /> Renovar (+3 meses)
                                </button>
                            )}
                            {contract.alreadyRenewed && contract.renewedToId && (
                                <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(`/admin/contracts/${contract.renewedToId}`)}
                                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                    <FolderSymlink size={14} aria-hidden="true" /> Renovado — abrir contrato novo
                                </button>
                            )}
                        </div>
                    )}
                </div>

                <div className="admin-grid-2" style={{ marginTop: 16, gap: 12 }}>
                    <Meta label="Vigência" value={terms.vigencia} />
                    <Meta label={terms.duracaoLabel} value={terms.duracao} />
                    <Meta label="Plano de pagamento" value={terms.plano} />
                    <Meta label="Forma de pagamento" value={paymentMethodKey ? `${getPaymentBadge(paymentMethodKey).emoji} ${getPaymentBadge(paymentMethodKey).label}` : '—'} />
                    {contract.type === 'FLEX' && contract.flexCreditsRemaining != null && (
                        <Meta label="Créditos restantes" value={`${contract.flexCreditsRemaining} de ${contract.flexCreditsTotal ?? '—'}`} />
                    )}
                    {/* E13 — pedido de cancelamento em análise: quando foi pedido e a multa prevista (% do pedido × base efetiva). */}
                    {contract.status === 'PENDING_CANCELLATION' && (
                        <>
                            {contract.cancellationRequestedAt && <Meta label="Cancelamento pedido em" value={fmtDateSP(contract.cancellationRequestedAt)} />}
                            <Meta label="Multa prevista" value={contract.fineAmountPreview > 0
                                ? `${formatBRL(contract.fineAmountPreview)} — ${contract.finePct}% de ${formatBRL(contract.fineBaseAmount)} que faltavam pagar`
                                : 'Sem multa (nada a pagar do plano)'} />
                        </>
                    )}
                    {/* E13 — contrato cancelado mostra QUANDO foi cancelado e a situação da multa. */}
                    {contract.status === 'CANCELLED' && (
                        <>
                            {contract.cancelledAt && <Meta label="Cancelado em" value={fmtDateSP(contract.cancelledAt)} />}
                            <Meta label="Multa de cancelamento" value={fine && fine.status !== 'CANCELLED'
                                ? `${formatBRL(fine.amount)} · ${getMeta(PAYMENT_STATUS_META, fine.status).label}${fine.status === 'PAID' && fine.paidAt ? ` em ${fmtDateSP(fine.paidAt)}` : ''}`
                                : 'Sem multa'} />
                        </>
                    )}
                </div>
                {contract.status === 'PENDING_CANCELLATION' && (
                    <div className="admin-alert admin-alert--warning" role="note" style={{ margin: '14px 0 0' }}>
                        {canDecideFine
                            ? <>O cliente pediu o cancelamento. Resolva na lista de Contratos: <strong>Cobrar multa</strong> ou <strong>Isentar multa</strong>.</>
                            : 'O cliente pediu o cancelamento e o pedido está em análise. Cobrar ou isentar a multa é decidido por quem tem a permissão “Decidir pedido de cancelamento”.'}
                    </div>
                )}
            </div>

            {/* ── Totals strip ── */}
            <div className="admin-grid-3" style={{ gap: 12, marginBottom: 16 }}>
                <TotalCard label="Valor do contrato" value={contractValue} color="var(--text-primary)" />
                <TotalCard label="Pago" value={paidValue} color="var(--success)" />
                <TotalCard label="Pendente" value={pendingValue} color={pendingValue > 0 ? 'var(--warning)' : 'var(--text-muted)'} />
            </div>

            {/* ── Contract services (editable for FIXO/FLEX active) ── */}
            {(canEditServices || episodeServices.length > 0 || monthlyServices.length > 0) && (
                <div className="admin-card" style={{ marginBottom: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <SectionTitle icon={<Sparkles size={16} />} title="Serviços do contrato" />
                        {canEditServices && !editingServices && (
                            <button className="btn btn-ghost btn-sm" onClick={startEditServices} style={{ marginBottom: 14 }}>
                                Editar serviços
                            </button>
                        )}
                    </div>

                    {editingServices ? (
                        <>
                            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0 0 12px' }}>
                                Afeta as <strong>parcelas pendentes</strong> e os <strong>próximos episódios</strong>; não altera o que já foi pago/realizado.
                            </p>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {episodeCatalog.map(a => {
                                    const selected = serviceDraft.includes(a.key);
                                    return (
                                        <ServiceLineItem key={a.key} name={a.name} description={a.description}
                                            perRecordingCents={Math.round(a.price * (1 - discountPct / 100))} sessionsPerMonth={sessionsPerMonth}
                                            selected={selected}
                                            onToggle={() => setServiceDraft(prev => selected ? prev.filter(k => k !== a.key) : [...prev, a.key])} />
                                    );
                                })}
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                                <button className="btn btn-ghost btn-sm" onClick={() => setEditingServices(false)} disabled={savingServices}>Cancelar</button>
                                <button className="btn btn-primary btn-sm" onClick={saveServices} disabled={savingServices}>
                                    {savingServices ? 'Salvando…' : 'Salvar serviços'}
                                </button>
                            </div>
                        </>
                    ) : (episodeServices.length > 0 || monthlyServices.length > 0) ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {episodeServices.map(s => (
                                <ServiceLineItem key={s.key} name={s.name} description={s.description}
                                    perRecordingCents={Math.round(s.price * (1 - discountPct / 100))} sessionsPerMonth={sessionsPerMonth} />
                            ))}
                            {monthlyServices.map(s => (
                                <ServiceLineItem key={s.key} name={s.name} description={s.description} monthly
                                    perRecordingCents={0} perMonthCents={Math.round(s.price * (1 - discountPct / 100))} />
                            ))}
                        </div>
                    ) : (
                        <Empty>{canEditServices ? 'Nenhum serviço recorrente. Use "Editar serviços" para incluir.' : 'Nenhum serviço recorrente.'}</Empty>
                    )}
                </div>
            )}

            {/* ── Recordings (standalone monthly services have none) ── */}
            {contract.type === 'SERVICO' ? (
            <div className="admin-card" style={{ marginBottom: 16 }}>
                <ServiceContractPanel contract={contract} addon={addons.find(a => a.key === (contract.addOns || [])[0]) || null} />
            </div>
            ) : (
            <div className="admin-card" style={{ marginBottom: 16 }}>
                <SectionTitle icon={<Mic size={16} />} title={`Gravações (${completedCount}/${bookings.length})`} />
                {bookings.length === 0 ? (
                    <Empty>Nenhuma gravação ainda.</Empty>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {bookings.map(b => {
                            const dec = decomposeBookingPricing({ priceCents: b.price, addOns: b.addOns, addonCatalog: catalog, discountPct, priceIncludesServices });
                            const bMeta = getMeta(BOOKING_STATUS_META, b.status);
                            return (
                                <div key={b.id} style={{ padding: 'var(--space-3)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                        <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>
                                            {new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short' })}
                                        </div>
                                        <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>{b.startTime}–{b.endTime}</div>
                                        <StatusBadge meta={bMeta} />
                                        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                                            <div style={{ fontWeight: 800, fontSize: '0.9375rem' }}>{formatBRL(dec.totalCents)}</div>
                                            {dec.servicesCents > 0 && (
                                                <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                                    {formatBRL(dec.baseCents)} base + {formatBRL(dec.servicesCents)} serviços
                                                    {!priceIncludesServices && <span> · cobrados na mensalidade</span>}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    {dec.perService.length > 0 && (
                                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                                            {dec.perService.map(s => (
                                                <span key={s.key} style={{ fontSize: '0.6875rem', fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: 'var(--tier-audiencia-bg)', color: 'var(--accent-primary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                    <Sparkles size={11} /> {s.name} · {formatBRL(s.unitCents)}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                    {(b.status === 'COMPLETED' && (b.peakViewers != null || b.durationMinutes != null)) && (
                                        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8, fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                            {b.durationMinutes != null && <span>⏱️ {b.durationMinutes} min</span>}
                                            {b.peakViewers != null && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Eye size={12} aria-hidden="true" /> {b.peakViewers} pico</span>}
                                            {b.chatMessages != null && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><MessageCircle size={12} aria-hidden="true" /> {b.chatMessages}</span>}
                                        </div>
                                    )}
                                    {/* Fluxo em etapas: Confirmar presença → Iniciar Gravação (registra o operador) → Finalizar.
                                        Equipe: presença = hoje.presenca (check-in) ou agendamentos.editar (PATCH);
                                        iniciar/desfazer/finalizar/dados = hoje.gravacao (PUT start-recording / undo / complete). */}
                                    {bp.canConfirmPresence && b.status === 'RESERVED' && (
                                        <div style={{ marginTop: 8 }}>
                                            <button className="btn btn-ghost btn-sm" onClick={() => bookingStep(b.id, 'checkin')}>
                                                <ClipboardCheck size={14} /> Confirmar presença
                                            </button>
                                        </div>
                                    )}
                                    {/* Sessão FUTURA não mostra "Iniciar": o backend recusa e o cliente veria "AO VIVO" falso. */}
                                    {canRecord && b.status === 'CONFIRMED' && !b.recordingStartedAt && b.date.split('T')[0] <= todaySP && (
                                        <div style={{ marginTop: 8 }}>
                                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => bookingStep(b.id, 'start')}>
                                                <Radio size={14} /> Iniciar gravação
                                            </button>
                                        </div>
                                    )}
                                    {b.status === 'CONFIRMED' && b.recordingStartedAt && (
                                        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                            {canRecord && (
                                                <>
                                                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFinalizeBooking(b)}>
                                                        <CheckCircle2 size={14} /> Finalizar gravação
                                                    </button>
                                                    <Tooltip content="Clicou em “Iniciar gravação” por engano? Desfaz o início: o cliente deixa de ver “AO VIVO”.">
                                                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => undoStartRecording(b)}>
                                                            <Undo2 size={14} aria-hidden="true" /> Desfazer início
                                                        </button>
                                                    </Tooltip>
                                                </>
                                            )}
                                            <span style={{ fontSize: '0.6875rem', fontWeight: 600, color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                <Radio size={12} /> Em gravação{b.recordingStartedByName ? ` — ${b.recordingStartedByName}` : ''}
                                            </span>
                                        </div>
                                    )}
                                    {canRecord && b.status === 'COMPLETED' && (
                                        <div style={{ marginTop: 8 }}>
                                            <button className="btn btn-ghost btn-sm" onClick={() => setFinalizeBooking(b)}>
                                                <CheckCircle2 size={14} /> Editar dados da gravação
                                            </button>
                                        </div>
                                    )}
                                    {(b.status === 'FALTA' || b.status === 'NAO_REALIZADO') && b.statusReason && (
                                        <div style={{ marginTop: 8, fontSize: '0.6875rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                                            <strong style={{ color: b.status === 'FALTA' ? 'var(--danger)' : 'var(--warning)' }}>
                                                {b.status === 'FALTA' ? 'Motivo da falta: ' : 'Motivo (não realizado): '}
                                            </strong>
                                            {b.statusReason}
                                        </div>
                                    )}
                                    {/* Remarcação do avulso (D4/D5): status da janela (explica por que o contrato
                                        ainda não está "Concluído") + ações Justificar falta / Remarcar. */}
                                    <MakeupStatusPanel booking={b} contractType={contract.type} clientName={contract.user?.name} onChanged={load} />
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
            )}

            {/* ── Payments / installments ── */}
            <div className="admin-card" style={{ marginBottom: 16 }}>
                <SectionTitle icon={<Receipt size={16} />} title={`Pagamentos & Parcelas (${payments.length})`} />
                {payments.length === 0 ? (
                    <Empty>Nenhuma cobrança gerada.</Empty>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {payments.map(p => {
                            const pMeta = getMeta(PAYMENT_STATUS_META, p.status);
                            const isOpen = p.status === 'PENDING' || p.status === 'FAILED';
                            // E13 — multa de cancelamento: rótulo próprio e sem número de parcela. % e base vêm
                            // gravados na cobrança (metadata); multas anteriores à regra caem no % do contrato.
                            const isFine = isFinePayment(p);
                            const finePct = isFine ? (p.metadata?.finePct ?? fine?.finePct ?? contract.finePct) : null;
                            const fineBase = isFine ? (p.metadata?.baseAmount ?? fine?.baseAmount ?? null) : null;
                            // Forma de pagamento pelo PROVEDOR (SICOOB/CORA → PIX, STRIPE → Cartão; nunca a chave crua).
                            const method = providerToMethod(p.provider, { boletoUrl: p.boletoUrl, pixString: p.pixString });
                            const methodText = method
                                ? `${getPaymentBadge(method).label}${method === 'CARTAO' && (p.installments ?? 1) > 1 ? ` em ${p.installments}x` : ''}`
                                : '';
                            return (
                                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: 'var(--space-3)', border: `1px solid ${isFine ? 'var(--warning)' : 'var(--border-default)'}`, borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)' }}>
                                    {isFine ? (
                                        <div aria-hidden="true" style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--warning-bg)', color: 'var(--warning)', flexShrink: 0 }}><Scale size={15} /></div>
                                    ) : (
                                        <div style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--bg-elevated)', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', flexShrink: 0 }}>{installmentNumber.get(p.id)}</div>
                                    )}
                                    <div style={{ minWidth: 0, flex: '1 1 150px' }}>
                                        {isFine && (
                                            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--warning)' }}>
                                                Multa de cancelamento{finePct != null ? ` (${finePct}%)` : ''}
                                            </div>
                                        )}
                                        <div style={{ fontWeight: 700, fontSize: '0.9375rem' }}>{formatBRL(valueOf(p))}</div>
                                        <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                            {isFine && finePct != null && fineBase != null ? `${finePct}% de ${formatBRL(fineBase)} que faltavam pagar · ` : ''}
                                            Vence {p.dueDate ? fmtDate(p.dueDate) : '—'}{methodText ? ` · ${methodText}` : ''}
                                        </div>
                                    </div>
                                    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                        <StatusBadge meta={pMeta} />
                                        {isOpen && (
                                            <>
                                                {/* D3: cliente excluído (anonimizado) não é cobrado — mesmo critério da lista de contratos.
                                                    Equipe: Cobrar e Simular = cobrancas.cobrar; Marcar pago = cobrancas.baixa. */}
                                                {canCharge && !clientDeleted && (
                                                    <button type="button" className="btn btn-sm" style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, padding: '5px 12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={() => openCharge(p)}>
                                                        <CreditCard size={13} aria-hidden="true" /> {isFine ? 'Cobrar agora' : 'Cobrar'}
                                                    </button>
                                                )}
                                                {canCharge && sandbox && (
                                                    <Tooltip content="Simular pagamento (sandbox)" describe={false}>
                                                        <button type="button" className="btn btn-ghost btn-sm" aria-label="Simular pagamento (sandbox)" onClick={() => simulate(p)}><Zap size={13} aria-hidden="true" /></button>
                                                    </Tooltip>
                                                )}
                                                {canMarkPaid && (
                                                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => markPaid(p)}>Marcar pago</button>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ── Cobrar agora (E1): o mesmo ChargeNowSheet da criação de contrato, com o CLIENTE do contrato —
                 o CPF do PIX e os cartões salvos são os dele, nunca os do admin. As formas oferecidas (PIX,
                 Cartão e Boleto quando a chave-mestra permite) são decididas pelo próprio sheet. ── */}
            {charge && (
                <ChargeNowSheet
                    paymentId={charge.id}
                    amount={charge.amount}
                    description={`${contract.name} - ${isFinePayment(charge) ? 'Multa de cancelamento' : 'parcela'}`}
                    title={isFinePayment(charge) ? 'Cobrar multa de cancelamento' : `Cobrar parcela ${installmentNumber.get(charge.id) ?? ''}`.trim()}
                    subtitle="Gere o PIX ou cobre o cartão do cliente (presente). A cobrança é feita em nome do cliente."
                    context="contract"
                    initialMethod={contract.paymentMethod ?? null}
                    client={contract.user ? { id: contract.user.id, name: contract.user.name, cpfCnpj: contract.user.cpfCnpj } : undefined}
                    error={chargeError || undefined}
                    onError={setChargeError}
                    onSuccess={() => { setCharge(null); showToast('Pagamento confirmado!'); load(); }}
                    // Recarrega também ao fechar: gerar o PIX de um à vista pode ter mudado o valor da cobrança (E2).
                    onDismiss={() => { setCharge(null); load(); }}
                    dismissLabel="Fechar (a cobrança continua pendente)"
                />
            )}

            <FinalizeRecordingModal
                isOpen={!!finalizeBooking}
                booking={finalizeBooking}
                onClose={() => setFinalizeBooking(null)}
                onSaved={() => { setFinalizeBooking(null); load(); }}
                onStale={load}
            />
        </div>
    );
}

// ── Small presentational helpers ──
function Meta({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <div style={{ fontSize: '0.625rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700, marginBottom: 3 }}>{label}</div>
            <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)' }}>{value}</div>
        </div>
    );
}

function TotalCard({ label, value, color }: { label: string; value: number; color: string }) {
    return (
        <div className="admin-card" style={{ padding: 'var(--space-4)' }}>
            <div style={{ fontSize: '0.625rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700, marginBottom: 6 }}>{label}</div>
            <div style={{ fontSize: '1.25rem', fontWeight: 800, color }}>{formatBRL(value)}</div>
        </div>
    );
}

function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, color: 'var(--text-primary)' }}>
            <span style={{ color: 'var(--accent-primary)', display: 'flex' }}>{icon}</span>
            <h2 style={{ fontSize: '0.9375rem', fontWeight: 700, margin: 0 }}>{title}</h2>
        </div>
    );
}

function Empty({ children }: { children: React.ReactNode }) {
    return <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8125rem' }}>{children}</div>;
}
