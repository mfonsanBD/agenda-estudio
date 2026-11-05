import { getErrorMessage } from '../utils/errors';
import { useState, useMemo } from 'react';
import { bookingsApi, BookingWithUser, ApiError } from '../api/client';
import { useNavigate } from 'react-router-dom';
import { useUI } from '../context/UIContext';
import { ClipboardList, Search, FilterX, Pencil, Trash2, Clock, Moon, Ban, Lock } from 'lucide-react';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import { HeroSkeleton, TableSkeleton } from '../components/ui/SkeletonLoader';
import StatusBadge from '../components/ui/StatusBadge';
import Tooltip from '../components/ui/Tooltip';
import { TIER_META, BOOKING_STATUS_META, getMeta } from '../constants/adminMeta';
import { formatBRL } from '../utils/format';
import { useAdminBookings } from '../hooks/useAdminBookings';
import CreateBookingModal from '../components/admin/bookings/CreateBookingModal';
import EditBookingModal from '../components/admin/bookings/EditBookingModal';
import StatusReasonModal, { type ReasonKind, type ReasonConfirmOptions } from '../components/admin/bookings/StatusReasonModal';
import { MakeupStatusPanel } from '../components/admin/bookings/MakeupRescheduleModal';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { buildReasonUpdate, reasonSaveFeedback, showReasonFeedback } from '../utils/avulsoMakeup';
import { bookingSummary, cancelBookingConsequences, cancelBookingRequest, hardDeleteConsequences } from '../components/admin/bookings/bookingDanger';
import { useBookingPermissions, cancelledReopenNeedsBaixaHint, CANCEL_OPEN_CHARGE_NEEDS_BAIXA, HARD_DELETE_OPEN_CHARGE_NEEDS_BAIXA } from '../components/admin/bookings/bookingPermissions';
import CommitSelect from '../components/admin/CommitSelect';
import { usePermission } from '../hooks/usePermission';

/** Status oferecidos no seletor inline (HELD é interno do fluxo de pagamento). */
const INLINE_STATUSES = Object.keys(BOOKING_STATUS_META).filter(key => key !== 'HELD');

export default function AdminBookingsPage() {
    const navigate = useNavigate();
    const { showAlert, showConfirm, showToast } = useUI();
    const { can } = usePermission();
    // Botões e opções seguem a permissão (o servidor recusa o resto com 403).
    const bp = useBookingPermissions();
    // Receita consolidada só com "Financeiro e receita" (DECISÕES, resposta 3).
    const canSeeRevenue = can('financeiro.ver');
    // Coluna "Ações" só quando o acesso tem alguma ação de agendamento (Editar abre com data/horário ou
    // com qualquer troca de status; Excluir com agendamentos.excluir).
    const showActionsCol = bp.canHardDelete || bp.canEditSlot || bp.canFaltas || bp.canCancel || bp.canConfirmPresence || bp.canOperateRecording;
    const { bookings, setBookings, users, loading, dateFilter, setDateFilter, statusFilter, setStatusFilter, reload } = useAdminBookings({ loadClients: bp.canCreate });
    const [searchQuery, setSearchQuery] = useState('');

    const [showCreate, setShowCreate] = useState(false);
    const [editBooking, setEditBooking] = useState<BookingWithUser | null>(null);
    // Falta / Não Realizado pelo select inline passam pelo modal de MOTIVO (e, no avulso, a falta justificada).
    const [reasonModal, setReasonModal] = useState<{ booking: BookingWithUser; kind: ReasonKind } | null>(null);
    const [savingReason, setSavingReason] = useState(false);
    useBusinessConfig(); // pré-carrega as regras (prazo da remarcação) que o modal de motivo mostra

    // D3: exclusão PERMANENTE (hard-delete) — diálogo de perigo com as consequências reais do backend.
    // Sem try/catch no onConfirm: o erro da API aparece dentro do diálogo.
    const handleHardDelete = (b: BookingWithUser) => {
        showConfirm({
            tone: 'danger',
            icon: Trash2,
            title: 'Excluir agendamento permanentemente?',
            message: `${bookingSummary(b)}\n\nPara manter o registro no histórico, mude o status para "Cancelado" em vez de excluir.`,
            consequences: hardDeleteConsequences(b, { canSettleCharges: bp.canSettleCharges }),
            confirmLabel: 'Excluir agendamento',
            loadingLabel: 'Excluindo…',
            onConfirm: async () => {
                const res = await bookingsApi.hardDelete(b.id);
                showToast(res.message);
                await reload();
            },
        });
    };

    // D3: CANCELAR pelo select inline pede confirmação de perigo ANTES de gravar (o select controlado
    // volta ao status atual enquanto isso). Sessão não realizada usa o cancelamento canônico
    // (libera o horário e devolve o crédito); as demais, o PATCH de status.
    const confirmCancelBooking = (b: BookingWithUser) => {
        showConfirm({
            tone: 'danger',
            icon: Ban,
            title: 'Cancelar agendamento?',
            message: bookingSummary(b),
            consequences: cancelBookingConsequences(b, { canSettleCharges: bp.canSettleCharges }),
            confirmLabel: 'Cancelar agendamento',
            loadingLabel: 'Cancelando…',
            onConfirm: async () => {
                const { booking: u } = await cancelBookingRequest(b);
                const mk = u ? { makeupStatus: u.makeupStatus ?? null, makeupDeadline: u.makeupDeadline ?? null, missedDate: u.missedDate ?? null } : {};
                setBookings(prev => prev.map(x => x.id === b.id ? { ...x, status: 'CANCELLED' as const, ...mk } : x));
                showToast('Agendamento cancelado.');
            },
        });
    };

    const handleInlineStatusChange = async (b: BookingWithUser, newStatus: string) => {
        const id = b.id;
        // Rede de segurança: o seletor só oferece as transições permitidas.
        if (newStatus !== b.status && !bp.canChangeStatus(b, newStatus)) return;
        // FALTA / NAO_REALIZADO exigem motivo (e, no avulso, decidir a falta justificada): abre o modal
        // em vez de gravar direto. O select controlado volta sozinho ao status atual até confirmar.
        if ((newStatus === 'FALTA' || newStatus === 'NAO_REALIZADO') && newStatus !== b.status) {
            setReasonModal({ booking: b, kind: newStatus });
            return;
        }
        // CANCELADO: nada é gravado até o admin confirmar no diálogo de perigo.
        if (newStatus === 'CANCELLED' && b.status !== 'CANCELLED') {
            confirmCancelBooking(b);
            return;
        }
        try {
            const res = await bookingsApi.update(id, { status: newStatus });
            // Optimistic local patch (no refetch) — keeps the row visible even
            // under an active status filter and avoids a full table reload flash.
            // A janela de remarcação do avulso pode mudar junto (ex.: Falta → Confirmado = remarcada).
            const u = res?.booking;
            const mk = u ? { makeupStatus: u.makeupStatus ?? null, makeupDeadline: u.makeupDeadline ?? null, missedDate: u.missedDate ?? null } : {};
            // AUDFIN6-02 (espelho): a sessão reaberta sem cobrança não volta a ficar em aberto — a linha passa a saber.
            const voided = res?.reopenedWithoutCharge ? { ownChargeVoided: true } : {};
            setBookings(prev => prev.map(b => b.id === id ? { ...b, status: newStatus as any, ...mk, ...voided } : b));
            // AUDFIN-01: reabriu (Concluído/Não realizado) uma sessão cuja cobrança foi anulada — o servidor avisa.
            if (res?.reopenedWithoutCharge) showAlert({ type: 'warning', title: 'Sessão reaberta sem cobrança', message: res.message });
        } catch (err: unknown) {
            // AUDFIN6-02 (espelho): o servidor recusou a volta ao "em aberto" porque a cobrança foi anulada (409) — a
            // mensagem dele aparece e a linha deixa de oferecer Reservado/Confirmado.
            if (err instanceof ApiError && err.code === 'SESSION_CHARGE_VOIDED') {
                setBookings(prev => prev.map(x => x.id === id ? { ...x, ownChargeVoided: true } : x));
            }
            showAlert({ message: getErrorMessage(err), type: 'error' });
        }
    };

    const handleConfirmReason = async (reason: string, { justified }: ReasonConfirmOptions) => {
        if (!reasonModal || savingReason) return;
        const { booking, kind } = reasonModal;
        const isAvulso = booking.contract?.type === 'AVULSO';
        setSavingReason(true);
        try {
            const res = await bookingsApi.update(booking.id, buildReasonUpdate(kind, reason, { isAvulso, justified }));
            // Patch local (sem refetch, como o select inline): status + motivo + janela de remarcação.
            const u = res.booking;
            setBookings(prev => prev.map(x => x.id === booking.id ? {
                ...x, status: kind, statusReason: u?.statusReason ?? reason,
                makeupStatus: u?.makeupStatus ?? null, makeupDeadline: u?.makeupDeadline ?? null, missedDate: u?.missedDate ?? null,
                ...(res?.reopenedWithoutCharge ? { ownChargeVoided: true } : {}),
            } : x));
            // AUDFIN6-03/TELA6-01: o retorno segue a RESPOSTA (janela gravada / aviso da sessão sem cobrança).
            showReasonFeedback(reasonSaveFeedback(kind, { isAvulso, justified }, res), { showToast, showAlert });
            setReasonModal(null);
        } catch (err: unknown) { showToast({ message: getErrorMessage(err) || 'Erro ao registrar.', type: 'error' }); }
        finally { setSavingReason(false); }
    };

    const filtered = useMemo(() => {
        if (!searchQuery) return bookings;
        const q = searchQuery.toLowerCase();
        // e-mail null-safe: cliente excluído (D3) tem os dados pessoais anonimizados (email = null).
        return bookings.filter(b =>
            b.user.name.toLowerCase().includes(q) || (b.user.email ?? '').toLowerCase().includes(q)
        );
    }, [bookings, searchQuery]);

    // KPIs
    const kpis = useMemo(() => {
        const confirmed = bookings.filter(b => b.status === 'CONFIRMED' || b.status === 'RESERVED').length;
        const completed = bookings.filter(b => b.status === 'COMPLETED').length;
        const cancelled = bookings.filter(b => b.status === 'CANCELLED' || b.status === 'FALTA').length;
        const revenue = bookings.filter(b => b.status === 'COMPLETED' || b.status === 'CONFIRMED').reduce((s, b) => s + b.price, 0);
        return { total: bookings.length, confirmed, completed, cancelled, revenue };
    }, [bookings]);

    return (
        <div>
            {/* --- HEADER --- */}
            <AdminPageHeader
                icon={ClipboardList}
                title="Agendamentos"
                subtitle="Gerencie todos os agendamentos do estúdio"
                actions={bp.canCreate ? (
                    <button className="btn-admin-go" onClick={() => setShowCreate(true)}>
                        <span style={{ fontSize: '1.1rem' }} aria-hidden="true">+</span> Novo Agendamento
                    </button>
                ) : undefined}
            />

            {/* --- KPI CARDS --- (a "Receita" é consolidada: só com financeiro.ver) */}
            <div className="admin-kpi-grid">
                <div className="admin-kpi-card admin-kpi-card--accent">
                    <div className="admin-kpi-card__label">Total</div>
                    <div className="admin-kpi-card__value">{kpis.total}</div>
                    <div className="admin-kpi-card__caption">agendamentos</div>
                </div>
                <div className="admin-kpi-card">
                    <div className="admin-kpi-card__label" style={{ color: 'var(--info)' }}>Confirmados</div>
                    <div className="admin-kpi-card__value">{kpis.confirmed}</div>
                    <div className="admin-kpi-card__caption">a realizar</div>
                </div>
                <div className="admin-kpi-card">
                    <div className="admin-kpi-card__label" style={{ color: 'var(--success)' }}>Concluídos</div>
                    <div className="admin-kpi-card__value">{kpis.completed}</div>
                    <div className="admin-kpi-card__caption">realizados</div>
                </div>
                <div className={`admin-kpi-card${kpis.cancelled > 0 ? ' admin-kpi-card--danger' : ''}`}>
                    <div className="admin-kpi-card__label" style={{ color: 'var(--danger)' }}>Cancelados</div>
                    <div className="admin-kpi-card__value" style={kpis.cancelled > 0 ? { color: 'var(--danger)' } : undefined}>{kpis.cancelled}</div>
                    <div className="admin-kpi-card__caption">cancelados + faltas</div>
                </div>
                {canSeeRevenue && (
                    <div className="admin-kpi-card admin-kpi-card--success">
                        <div className="admin-kpi-card__label" style={{ color: 'var(--success)' }}>Receita</div>
                        <div className="admin-kpi-card__value admin-kpi-card__value--sm">{formatBRL(kpis.revenue)}</div>
                        <div className="admin-kpi-card__caption">confirmados + concluídos</div>
                    </div>
                )}
            </div>

            {/* --- SEARCH + FILTERS --- */}
            <div className="admin-filter-bar admin-filter-bar--panel">
                <div className="admin-search">
                    <input
                        type="text" placeholder="Buscar por nome ou e-mail..."
                        aria-label="Buscar por nome ou e-mail"
                        value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                    />
                    <Search size={14} className="admin-search__icon" aria-hidden="true" />
                </div>

                {/* Date filter */}
                <input type="date" value={dateFilter} onChange={e => setDateFilter(e.target.value)}
                    aria-label="Filtrar por data"
                    className="form-input form-input--raised"
                    style={{ maxWidth: '160px', fontSize: '0.8125rem' }}
                />

                {/* Status filter pills */}
                <div className="admin-segmented" role="group" aria-label="Filtrar por status">
                    {[
                        { key: '', label: 'Todos' },
                        { key: 'CONFIRMED', label: 'Confirmados' },
                        { key: 'COMPLETED', label: 'Concluídos' },
                        { key: 'RESERVED', label: 'Reservados' },
                        { key: 'CANCELLED', label: 'Cancelados' },
                    ].map(s => (
                        <button key={s.key}
                            onClick={() => setStatusFilter(s.key)}
                            aria-pressed={statusFilter === s.key}
                            className={`admin-segmented__btn${statusFilter === s.key ? ' admin-segmented__btn--active' : ''}`}
                        >
                            {s.label}
                        </button>
                    ))}
                </div>

                {(dateFilter || statusFilter || searchQuery) && (
                    <button className="admin-filter-clear" onClick={() => { setDateFilter(''); setStatusFilter(''); setSearchQuery(''); }}>
                        <FilterX size={14} aria-hidden="true" /> Limpar
                    </button>
                )}

                <span style={{
                    marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-muted)',
                    padding: '4px 10px', background: 'var(--bg-elevated)', borderRadius: '8px'
                }} aria-live="polite">
                    {filtered.length} resultado{filtered.length !== 1 ? 's' : ''}
                </span>
            </div>

            {/* --- BOOKINGS TABLE --- */}
            {loading ? (
                <div><HeroSkeleton /><TableSkeleton rows={6} cols={7} /></div>
            ) : (
                <div style={{ borderRadius: '16px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
                    {filtered.length === 0 ? (
                        <div className="admin-empty">
                            <Moon size={44} className="admin-empty__icon" aria-hidden="true" />
                            <div className="admin-empty__title">Nenhum agendamento encontrado</div>
                            <div className="admin-empty__hint">Tente ajustar os filtros ou período</div>
                        </div>
                    ) : (
                        <div className="table-container" style={{ margin: 0 }}>
                            <div className="admin-table-wrap">
                            <table className="admin-table--cards">
                                <thead>
                                    <tr>
                                        <th style={{ paddingLeft: '20px' }}>Cliente</th>
                                        <th>Data / Horário</th>
                                        <th>Contrato</th>
                                        <th>Agendado em</th>
                                        <th style={{ textAlign: 'right' }}>Valor</th>
                                        <th style={{ textAlign: 'center' }}>Status</th>
                                        {showActionsCol && <th style={{ textAlign: 'center' }}>Ações</th>}
                                    </tr>
                                </thead>
                                <tbody>
                                    {filtered.map((b) => {
                                        const sc = getMeta(BOOKING_STATUS_META, b.status);
                                        // Só as transições que o acesso permite (mesma tabela do servidor); sem
                                        // nenhuma, o status vira um selo (nada a escolher).
                                        const statusChoices = bp.statusOptions(b, INLINE_STATUSES.includes(b.status) ? INLINE_STATUSES : [b.status, ...INLINE_STATUSES]);
                                        // Editar: data/horário (agendamentos.editar) ou alguma troca de status permitida.
                                        const canOpenEdit = bp.canEditSlot || statusChoices.length > 1;
                                        const dateObj = new Date(b.date);
                                        const dayStr = dateObj.toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit' });
                                        const createdStr = b.createdAt ? new Date(b.createdAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
                                        return (
                                            <tr key={b.id} className="admin-zebra-row">
                                                {/* Client */}
                                                <td className="admin-card-title" style={{ paddingLeft: '20px' }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                        <div style={{
                                                            width: '36px', height: '36px', borderRadius: '10px',
                                                            background: sc.bg,
                                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                            fontSize: '0.875rem', flexShrink: 0, fontWeight: 700, color: sc.color
                                                        }}>
                                                            {b.user.name.charAt(0).toUpperCase()}
                                                        </div>
                                                        <div>
                                                            {/* Perfil do cliente só com clientes.ver (senão o link cairia no redirecionamento). */}
                                                            {bp.canOpenClient ? (
                                                                <Tooltip content={`Abrir perfil de ${b.user.name}`}>
                                                                    <button type="button"
                                                                        style={{ fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', color: 'var(--accent-text)', background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', textAlign: 'left' }}
                                                                        onClick={() => navigate(`/admin/clients/${b.user.id}`)}>
                                                                        {b.user.name}
                                                                    </button>
                                                                </Tooltip>
                                                            ) : (
                                                                <span style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text-primary)' }}>{b.user.name}</span>
                                                            )}
                                                            {b.user.email && (
                                                                <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '1px' }}>
                                                                    {b.user.email}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                </td>

                                                {/* Date + Time */}
                                                <td data-label="Quando">
                                                    <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{dayStr}</div>
                                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                        <Clock size={12} aria-hidden="true" />
                                                        {b.startTime} – {b.endTime}
                                                    </div>
                                                </td>

                                                {/* Contract */}
                                                <td data-label="Contrato">
                                                    {b.contract ? (
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                                                            <StatusBadge meta={getMeta(TIER_META, b.contract.tier)} label={b.contract.name} />
                                                        </div>
                                                    ) : (
                                                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>—</span>
                                                    )}
                                                </td>

                                                {/* Created at */}
                                                <td data-label="Agendado">
                                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{createdStr}</div>
                                                </td>

                                                {/* Valor */}
                                                <td data-label="Valor" style={{ textAlign: 'right', fontWeight: 700, fontSize: '0.875rem', fontVariantNumeric: 'tabular-nums', color: 'var(--success)' }}>
                                                    {formatBRL(b.price)}
                                                </td>

                                                {/* Status - premium inline select */}
                                                <td data-label="Status" style={{ textAlign: 'center' }}>
                                                    {statusChoices.length <= 1 ? (
                                                        // FIN-01/ATK-02: cancelada sem a baixa — o selo explica por que não reabre.
                                                        bp.cancelledReopenNeedsBaixa(b) ? (
                                                            <Tooltip content={cancelledReopenNeedsBaixaHint(b)}>
                                                                <span tabIndex={0} style={{ display: 'inline-flex' }}><StatusBadge meta={sc} /></span>
                                                            </Tooltip>
                                                        ) : <StatusBadge meta={sc} />
                                                    ) : (
                                                    <div style={{ display: 'inline-flex', alignItems: 'center', position: 'relative' }}>
                                                        {/* Animated dot */}
                                                        <span style={{
                                                            width: 6, height: 6, borderRadius: '50%', background: sc.color,
                                                            position: 'absolute', left: '11px', top: '50%', transform: 'translateY(-50%)',
                                                            pointerEvents: 'none', zIndex: 1,
                                                            boxShadow: `0 0 6px ${sc.color}66`,
                                                        }} />
                                                        {/* CommitSelect: com o select fechado, as setas não gravam cada status
                                                            intermediário (antes ↓ em "Confirmado" gravava "Concluído" a caminho do
                                                            "Cancelado"); Enter ou sair do campo aplica, clique na lista aplica na hora. */}
                                                        <CommitSelect
                                                            value={b.status}
                                                            onCommit={v => handleInlineStatusChange(b, v)}
                                                            aria-label={`Status do agendamento de ${b.user.name}`}
                                                            className="admin-status-select"
                                                            style={{ color: sc.color }}
                                                        >
                                                            {statusChoices.map(key => {
                                                                const cfg = getMeta(BOOKING_STATUS_META, key);
                                                                return <option key={key} value={key} style={{ background: 'var(--sheet-bg)', color: cfg.color, padding: '6px' }}>{cfg.label}</option>;
                                                            })}
                                                        </CommitSelect>
                                                    </div>
                                                    )}
                                                    {/* R5: com cobrança em aberto e sem a baixa, o "Cancelado" some do seletor — o selo
                                                        explica (dica no mouse/teclado; no toque, o clique mostra o mesmo texto). */}
                                                    {bp.cancelNeedsBaixa(b) && (
                                                        <span className="mkp-chips">
                                                            <Tooltip content={CANCEL_OPEN_CHARGE_NEEDS_BAIXA}>
                                                                <button type="button" className="mkp-chip mkp-chip--muted"
                                                                    aria-label={`Cancelar indisponível para ${b.user.name}: ver por quê`}
                                                                    onClick={() => showAlert({ type: 'info', title: 'Cancelar indisponível', message: CANCEL_OPEN_CHARGE_NEEDS_BAIXA })}>
                                                                    <Lock size={12} aria-hidden="true" /> Cancelar indisponível
                                                                </button>
                                                            </Tooltip>
                                                        </span>
                                                    )}
                                                    {/* Remarcação do avulso (D4/D5): "Remarcar até DD/MM" / "Justificar falta" / status. */}
                                                    <MakeupStatusPanel booking={b} clientName={b.user.name} layout="chips" onChanged={reload} />
                                                </td>

                                                {/* Actions (cada uma com a sua permissão; sem nenhuma, a coluna some) */}
                                                {showActionsCol && (
                                                <td data-label="" style={{ textAlign: 'center' }}>
                                                    <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                                                        {canOpenEdit && (
                                                            <Tooltip content="Editar agendamento" describe={false}>
                                                                <button type="button" className="admin-icon-btn admin-icon-btn--success"
                                                                    aria-label={`Editar agendamento de ${b.user.name}`}
                                                                    onClick={() => setEditBooking(b)}>
                                                                    <Pencil size={16} aria-hidden="true" />
                                                                </button>
                                                            </Tooltip>
                                                        )}
                                                        {/* TELA5-05: sem a baixa e com cobrança em aberto, excluir é recusado — a Lixeira
                                                            fica travada com o motivo (no toque, o clique mostra o mesmo texto). */}
                                                        {bp.canHardDelete && (bp.hardDeleteNeedsBaixa(b) ? (
                                                            <Tooltip content={HARD_DELETE_OPEN_CHARGE_NEEDS_BAIXA}>
                                                                <button type="button" className="admin-icon-btn" aria-disabled="true"
                                                                    aria-label={`Excluir indisponível para ${b.user.name}: ver por quê`}
                                                                    onClick={() => showAlert({ type: 'info', title: 'Excluir indisponível', message: HARD_DELETE_OPEN_CHARGE_NEEDS_BAIXA })}>
                                                                    <Lock size={16} aria-hidden="true" />
                                                                </button>
                                                            </Tooltip>
                                                        ) : (
                                                            <Tooltip content="Excluir agendamento" describe={false}>
                                                                <button type="button" className="admin-icon-btn admin-icon-btn--danger"
                                                                    aria-label={`Excluir permanentemente agendamento de ${b.user.name}`}
                                                                    onClick={() => handleHardDelete(b)}>
                                                                    <Trash2 size={16} aria-hidden="true" />
                                                                </button>
                                                            </Tooltip>
                                                        ))}
                                                    </div>
                                                </td>
                                                )}
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* -------------------------------------------------------
               MODALS (preserved from original)
            ------------------------------------------------------- */}

            {showCreate && (
                <CreateBookingModal
                    isOpen
                    onClose={() => setShowCreate(false)}
                    users={users}
                    onCreated={reload}
                />
            )}

            <EditBookingModal
                booking={editBooking}
                onClose={() => setEditBooking(null)}
                onSaved={reload}
            />

            <StatusReasonModal
                isOpen={!!reasonModal}
                kind={reasonModal?.kind ?? null}
                subtitle={reasonModal ? `${reasonModal.booking.user.name} · ${new Date(reasonModal.booking.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' })} às ${reasonModal.booking.startTime}` : undefined}
                isAvulso={reasonModal?.booking.contract?.type === 'AVULSO'}
                bookingDate={reasonModal?.booking.date}
                makeupStatus={reasonModal?.booking.makeupStatus ?? null}
                onConfirm={handleConfirmReason}
                onClose={() => setReasonModal(null)}
                saving={savingReason}
            />
        </div>
    );
}
