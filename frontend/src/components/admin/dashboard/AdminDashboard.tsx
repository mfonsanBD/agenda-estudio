import { getErrorMessage } from '../../../utils/errors';
import { useState, useEffect } from 'react';
import { bookingsApi, contractsApi, usersApi, ApiError, BookingWithUser, Contract, UserSummary } from '../../../api/client';
import { useUI } from '../../../context/UIContext';
import { useNavigate } from 'react-router-dom';
import StatusBadge from '../../ui/StatusBadge';
import Tooltip from '../../ui/Tooltip';
import StatusReasonModal, { type ReasonKind, type ReasonConfirmOptions } from '../bookings/StatusReasonModal';
import { bookingSummary } from '../bookings/bookingDanger';
import AdminPageHeader from '../AdminPageHeader';
import { DashboardSkeleton } from '../../ui/SkeletonLoader';
import {
    CalendarDays, LayoutDashboard, Flag, XCircle, ClipboardCheck, AlertTriangle,
    AlertCircle, Clock, CheckCircle2, TrendingUp, CalendarClock, Target, Moon, Radio, Undo2,
} from 'lucide-react';
import { TIER_META, BOOKING_STATUS_META, CONTRACT_TYPE_META, getMeta } from '../../../constants/adminMeta';
import { isAvulsoContract, isBookingMakeupOpen } from '../../../utils/contractStatus';
import { buildReasonUpdate, reasonSaveFeedback, showReasonFeedback, makeupDeadlineDdmm } from '../../../utils/avulsoMakeup';
import { useBusinessConfig } from '../../../hooks/useBusinessConfig';
import { formatBRL, DAY_NAMES, getInitials } from '../../../utils/format';
import { todayStrSaoPaulo } from '../../../utils/time';
import { STUDIO_SLOTS } from '../../../constants/slots';
import { usePermission } from '../../../hooks/usePermission';
import { useBookingPermissions } from '../bookings/bookingPermissions';


function getMonthRange(): { start: Date; end: Date } {
    const now = new Date();
    return {
        // A18: usar UTC-midnight para bater com `new Date("YYYY-MM-DD")` (que é 00:00Z). Antes, o
        // Date(y,m,1) em horário LOCAL (03:00Z em UTC-3) fazia a comparação `b.date (00:00Z) >= start`
        // ser falsa para o DIA 1, derrubando receita/contagem/presença das reservas do 1º dia do mês.
        start: new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1)),
        end: new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0)),
    };
}

function getWeekDates(): Date[] {
    const d = new Date();
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const start = new Date(d);
    start.setDate(diff);
    const dates: Date[] = [];
    for (let i = 0; i < 6; i++) {
        dates.push(new Date(start));
        start.setDate(start.getDate() + 1);
    }
    return dates;
}

function daysUntil(dateStr: string): number {
    const target = new Date(dateStr.split('T')[0] + 'T12:00:00');
    const now = new Date();
    return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

// ─── Admin Dashboard ──────────────────────────────────────

export default function AdminDashboard() {
    const navigate = useNavigate();
    const { showToast, showConfirm, showAlert } = useUI();
    useBusinessConfig(); // pré-carrega as regras (prazo da remarcação) que o modal de motivo mostra
    // Painel sem permissão própria (proposta §2.4): cada bloco segue o módulo de origem e cada carga só
    // sai com a permissão dela — um 403 nunca derruba o painel inteiro.
    const { can, canAny } = usePermission();
    const bp = useBookingPermissions();
    const canBookings = canAny('agendamentos.ver', 'hoje.ver');
    const canContracts = can('contratos.ver');
    const canClients = can('clientes.ver');
    const canRevenue = can('financeiro.ver');
    const [allBookings, setAllBookings] = useState<BookingWithUser[]>([]);
    const [allContracts, setAllContracts] = useState<Contract[]>([]);
    const [allUsers, setAllUsers] = useState<UserSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [reasonModal, setReasonModal] = useState<{ booking: BookingWithUser; kind: ReasonKind } | null>(null);
    const [savingReason, setSavingReason] = useState(false);

    useEffect(() => { loadAll(); }, [canBookings, canContracts, canClients]);

    const loadAll = async () => {
        setLoading(true);
        try {
            // Cargas condicionais e independentes (allSettled): sem a permissão, nem pede; uma falha
            // (rede, 403 de permissão retirada) deixa só aquele bloco vazio.
            const [bRes, cRes, uRes] = await Promise.allSettled([
                canBookings ? bookingsApi.getAll() : Promise.resolve({ bookings: [] as BookingWithUser[] }),
                canContracts ? contractsApi.getAll() : Promise.resolve({ contracts: [] as Contract[] }),
                canClients ? usersApi.getAll() : Promise.resolve({ users: [] as UserSummary[] }),
            ]);
            if (bRes.status === 'fulfilled') setAllBookings(bRes.value.bookings); else console.error(bRes.reason);
            if (cRes.status === 'fulfilled') setAllContracts(cRes.value.contracts); else console.error(cRes.reason);
            if (uRes.status === 'fulfilled') setAllUsers(uRes.value.users); else console.error(uRes.reason);
        } finally { setLoading(false); }
    };

    const handleQuickAction = async (id: string, action: 'checkin' | 'start' | 'complete') => {
        try {
            let res;
            // Confirmar presença: o check-in exige hoje.presenca; quem só tem agendamentos.editar confirma
            // pelo PATCH (RESERVED → CONFIRMED, mesma tabela de transições do servidor).
            if (action === 'checkin') res = bp.canCheckIn ? await bookingsApi.checkIn(id) : await bookingsApi.update(id, { status: 'CONFIRMED' });
            else if (action === 'start') res = await bookingsApi.startRecording(id);
            else res = await bookingsApi.complete(id);
            showToast(res.message);
            await loadAll();
        } catch (err: unknown) {
            showToast({ message: getErrorMessage(err) || 'Erro ao atualizar.', type: 'error' });
            // "Finalizar" recusado porque a gravação mudou em outra tela (início desfeito / status): o painel está velho.
            if (err instanceof ApiError && err.code === 'RECORDING_STATE_CHANGED') void loadAll();
        }
    };

    // "Iniciar" clicado por engano: desfaz o início (mesmo fluxo e mesmos textos da tela Hoje). O cliente
    // deixa de ver "AO VIVO" e a sessão volta a pedir "Iniciar" antes de finalizar. Sem try/catch no
    // onConfirm: o erro da API (ex.: 409 RECORDING_UNDO_NOT_ALLOWED) aparece DENTRO do diálogo.
    const handleUndoStartRecording = (booking: BookingWithUser) => {
        showConfirm({
            tone: 'warning',
            icon: Undo2,
            title: 'Desfazer o início da gravação?',
            message: bookingSummary(booking),
            consequences: [
                'O registro de quem iniciou e do horário de início é apagado.',
                'O cliente deixa de ver o selo "AO VIVO" nesta gravação.',
                'Para finalizar, será preciso clicar em "Iniciar gravação" de novo.',
                'O agendamento continua confirmado — nada é cancelado nem cobrado.',
            ],
            confirmLabel: 'Desfazer início',
            loadingLabel: 'Desfazendo…',
            onConfirm: async () => {
                // Recusado (ex.: outra aba já finalizou): o painel daqui está velho — recarrega por trás do diálogo.
                const res = await bookingsApi.undoStartRecording(booking.id).catch((err: unknown) => { void loadAll(); throw err; });
                // A rota devolve a reserva SEM `user`: mescla só os campos do início no item da lista.
                const u = res.booking;
                setAllBookings(prev => prev.map(b => b.id === booking.id ? {
                    ...b,
                    status: u?.status ?? b.status,
                    recordingStartedAt: u?.recordingStartedAt ?? null,
                    recordingStartedByName: u?.recordingStartedByName ?? null,
                } : b));
                showToast(res.message || 'Início da gravação desfeito.');
            },
        });
    };

    // Falta / Não Realizado passam pelo modal que exige o MOTIVO antes de aplicar o status (igual à tela Hoje).
    // Avulso (D4/D5): a FALTA pode ser justificada (noShowJustified → remarcação sem novo pagamento).
    const handleConfirmReason = async (reason: string, { justified }: ReasonConfirmOptions) => {
        if (!reasonModal || savingReason) return;
        const { booking, kind } = reasonModal;
        const isAvulso = booking.contract?.type === 'AVULSO';
        setSavingReason(true);
        try {
            const res = await bookingsApi.update(booking.id, buildReasonUpdate(kind, reason, { isAvulso, justified }));
            // AUDFIN6-03: o retorno segue a RESPOSTA do servidor (a remarcação só é prometida se a janela abriu).
            showReasonFeedback(reasonSaveFeedback(kind, { isAvulso, justified }, res), { showToast, showAlert });
            setReasonModal(null);
            await loadAll();
        } catch (err: unknown) { showToast(getErrorMessage(err) || 'Erro ao registrar.'); }
        finally { setSavingReason(false); }
    };

    if (loading) return <DashboardSkeleton />;

    const today = todayStrSaoPaulo();
    const now = new Date();
    const { start: monthStart, end: monthEnd } = getMonthRange();
    const weekDates = getWeekDates();

    // ── Computations ──
    const todaysBookings = allBookings.filter(b => b.date.split('T')[0] === today && b.status !== 'CANCELLED');
    const isSunday = new Date().getDay() === 0;

    const monthBookings = allBookings.filter(b => {
        const d = new Date(b.date.split('T')[0]);
        return d >= monthStart && d <= monthEnd && b.status !== 'CANCELLED';
    });
    const monthRevenue = monthBookings.filter(b => b.status === 'CONFIRMED' || b.status === 'COMPLETED').reduce((s, b) => s + b.price, 0);

    const completedThisMonth = monthBookings.filter(b => b.status === 'COMPLETED').length;
    const noShowsThisMonth = monthBookings.filter(b => b.status === 'FALTA' || b.status === 'NAO_REALIZADO').length;
    const attendanceRate = completedThisMonth + noShowsThisMonth > 0 ? Math.round((completedThisMonth / (completedThisMonth + noShowsThisMonth)) * 100) : 100;

    const activeContracts = allContracts.filter(c => c.status === 'ACTIVE');
    const pendingCancellations = allContracts.filter(c => c.status === 'PENDING_CANCELLATION');
    // Planos a vencer: ACTIVE ou COMPLETED (o concluído continua renovável — D6). O AVULSO é uma
    // sessão única e nunca "vence" (mesma regra do alerta de expiração do backend).
    const expiringContracts = allContracts.filter(c =>
        (c.status === 'ACTIVE' || c.status === 'COMPLETED') && !isAvulsoContract(c)
        && daysUntil(c.endDate) <= 7 && daysUntil(c.endDate) >= 0);
    const unconfirmedToday = todaysBookings.filter(b => b.status === 'RESERVED');

    // Week occupancy
    const weekOccupancy = weekDates.map(d => {
        const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const dayOfWeek = d.getDay();
        if (dayOfWeek === 0) return { date: ds, day: DAY_NAMES[dayOfWeek], pct: 0, count: 0, total: 0, closed: true };
        const count = allBookings.filter(b => b.date.split('T')[0] === ds && b.status !== 'CANCELLED').length;
        return { date: ds, day: DAY_NAMES[dayOfWeek], pct: Math.round((count / 5) * 100), count, total: 5, closed: false };
    });

    // Next 5 upcoming bookings
    const futureBookings = allBookings
        .filter(b => {
            const dt = new Date(`${b.date.split('T')[0]}T${b.startTime}:00`);
            return dt > now && (b.status === 'RESERVED' || b.status === 'CONFIRMED');
        })
        .sort((a, b) => new Date(`${a.date.split('T')[0]}T${a.startTime}`).getTime() - new Date(`${b.date.split('T')[0]}T${b.startTime}`).getTime())
        .slice(0, 5);

    // Churn risk: active contract clients who haven't booked in 14 days
    // (precisa das três cargas: clientes, contratos e agendamentos — sem uma delas o bloco some).
    const canChurn = canClients && canContracts && canBookings;
    const clientsWithActiveContracts = new Set(activeContracts.map(c => c.user?.id).filter(Boolean));
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const churnRisk = allUsers
        .filter(u => clientsWithActiveContracts.has(u.id))
        .filter(u => {
            const userBookings = allBookings.filter(b => b.user?.id === u.id && b.status !== 'CANCELLED');
            if (userBookings.length === 0) return true;
            const lastBooking = userBookings.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
            return new Date(lastBooking.date) < fourteenDaysAgo;
        });

    const totalAlerts = expiringContracts.length + pendingCancellations.length + unconfirmedToday.length;
    // Alertas: contratos (contratos.ver) e sessões sem confirmação (agenda).
    const canAlerts = canContracts || canBookings;
    // KPIs visíveis (cada um com a sua origem). A receita é consolidada: só com financeiro.ver
    // (e depende das sessões, que vêm da agenda).
    const kpis = [
        ...(canRevenue && canBookings ? [{ label: 'Receita do Mês', value: formatBRL(monthRevenue), sub: `${monthBookings.length} agendamentos`, mod: ' admin-kpi-card--success' }] : []),
        ...(canBookings ? [
            { label: 'Ocupação Hoje', value: isSunday ? '—' : `${todaysBookings.length}/5`, sub: isSunday ? 'Fechado' : `${Math.round((todaysBookings.length / 5) * 100)}% dos slots`, mod: '' },
            { label: 'Taxa de Presença', value: `${attendanceRate}%`, sub: `${completedThisMonth} concluídas, ${noShowsThisMonth} faltas`, mod: attendanceRate >= 80 ? ' admin-kpi-card--success' : ' admin-kpi-card--danger' },
        ] : []),
        ...(canContracts ? [{
            label: 'Contratos Ativos', value: `${activeContracts.length}`,
            sub: canClients
                ? (() => { const n = allUsers.filter(u => u.role === 'CLIENTE').length; return `${n} cliente${n !== 1 ? 's' : ''} cadastrado${n !== 1 ? 's' : ''}`; })()
                : 'contratos em andamento',
            mod: ' admin-kpi-card--accent',
        }] : []),
        ...(!canContracts && canClients ? [{
            label: 'Clientes', value: `${allUsers.filter(u => u.role === 'CLIENTE').length}`, sub: 'clientes cadastrados', mod: ' admin-kpi-card--accent',
        }] : []),
    ];
    // Abrir o cliente: perfil com clientes.ver; senão, o contrato (alerta de contrato) ou nada.
    const clientLink = (name: string, userId: string | undefined, sm?: boolean) => (userId && canClients ? (
        <Tooltip content={`Abrir perfil de ${name}`}>
            <button type="button" className={`dash-name-btn${sm ? ' dash-name-btn--sm dash-name-btn--ellipsis' : ''}`}
                onClick={() => navigate(`/admin/clients/${userId}`)}>
                {name}
            </button>
        </Tooltip>
    ) : (
        <span className={`dash-name-btn${sm ? ' dash-name-btn--sm dash-name-btn--ellipsis' : ''}`} style={{ cursor: 'inherit', display: 'inline-block' }}>{name}</span>
    ));

    // Nenhum bloco para este acesso (ex.: só "Financeiro e receita", que depende da agenda): estado vazio.
    if (!canBookings && !canContracts && !canClients) {
        return (
            <div aria-label="Painel principal">
                <AdminPageHeader
                    icon={LayoutDashboard}
                    title="Centro de Comando"
                    subtitle={new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
                />
                <div className="admin-empty" role="status">
                    <Target size={40} className="admin-empty__icon" aria-hidden="true" />
                    <div className="admin-empty__title">O painel não tem blocos para o seu acesso</div>
                    <div className="admin-empty__hint">Abra uma das áreas liberadas no menu. Para ver mais aqui, fale com o administrador.</div>
                </div>
            </div>
        );
    }

    // ── Slot enrichment for today ──
    const todaySlots = STUDIO_SLOTS.map(slot => {
        const booking = todaysBookings.find(b => b.startTime === slot.time);
        return { ...slot, booking: booking || null };
    });

    return (
        <div aria-label="Painel principal">
            {/* ─── HEADER (padrão AdminPageHeader) ─── */}
            <AdminPageHeader
                icon={LayoutDashboard}
                title="Centro de Comando"
                subtitle={new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
            />
            {/* ── SECTION 1: Agenda do Dia (Hero) — agenda (agendamentos.ver ou hoje.ver) ── */}
            {canBookings && (
            <div className="admin-card admin-card--lg dash-agenda-card">
                <div className="dash-card-head">
                    <div className="dash-card-head__title">
                        <h2 className="dash-panel__title dash-panel__title--lg">
                            <CalendarDays size={18} style={{ color: 'var(--accent-primary)' }} aria-hidden="true" /> Agenda de Hoje
                        </h2>
                        <p className="dash-panel__sub">
                            {todaysBookings.length} de 5 slots ocupados
                        </p>
                    </div>
                    <button onClick={() => navigate('/calendar')} className="dash-card-head__action btn-admin-ghost btn-admin-ghost--compact">
                        Ver Agenda Completa →
                    </button>
                </div>

                {isSunday ? (
                    <div className="admin-empty">
                        <Moon size={40} className="admin-empty__icon" aria-hidden="true" />
                        <div className="admin-empty__title">Estúdio fechado aos domingos</div>
                    </div>
                ) : (
                    <div className="dash-panel__list">
                        {todaySlots.map(slot => {
                            const b = slot.booking;
                            const isPast = new Date(`${today}T${slot.end}:00`) < now;
                            return (
                                // flexWrap + marginLeft:auto: no celular (375 px) as ações e o selo descem para a linha de
                                // baixo, alinhados à direita, em vez de vazar do card (no desktop nada muda).
                                <div key={slot.time} className={`dash-slot${b ? ' dash-slot--filled' : ''}${isPast && !b ? ' dash-slot--past' : ''}`} style={{ flexWrap: 'wrap' }}>
                                    {/* Time column */}
                                    <div className="dash-slot__time">{slot.label}</div>

                                    {/* Divider */}
                                    <div className="dash-slot__bar" />

                                    {/* Content */}
                                    <div className="dash-slot__main">
                                        {b ? (
                                            <>
                                                {clientLink(b.user.name, b.user.id)}
                                                <StatusBadge meta={getMeta(TIER_META, b.tierApplied)} />
                                                <StatusBadge meta={getMeta(BOOKING_STATUS_META, b.status)} />
                                                <span className="dash-slot__price">{formatBRL(b.price)}</span>
                                            </>
                                        ) : (
                                            <span className="dash-slot__free">
                                                {isPast ? 'Horário encerrado' : '— Disponível —'}
                                            </span>
                                        )}
                                    </div>

                                    {/* Quick Actions */}
                                    {b && b.status === 'RESERVED' && !isPast && (bp.canConfirmPresence || bp.canFaltas) && (
                                        <div className="dash-slot__actions" style={{ marginLeft: 'auto' }}>
                                            {bp.canConfirmPresence && (
                                                <Tooltip content="Confirmar presença (check-in)">
                                                    <button type="button" className="today-action-btn today-action-btn--info"
                                                        onClick={() => handleQuickAction(b.id, 'checkin')}>
                                                        <ClipboardCheck size={14} aria-hidden="true" /> Check-in
                                                    </button>
                                                </Tooltip>
                                            )}
                                            {bp.canFaltas && (
                                                <Tooltip content="Registrar falta" describe={false}>
                                                    <button type="button" className="today-action-btn today-action-btn--danger"
                                                        aria-label={`Registrar falta de ${b.user.name}`}
                                                        onClick={() => setReasonModal({ booking: b, kind: 'FALTA' })}>
                                                        <XCircle size={15} aria-hidden="true" />
                                                    </button>
                                                </Tooltip>
                                            )}
                                        </div>
                                    )}
                                    {/* Sessão já INICIADA continua com Desfazer/Finalizar depois do fim do horário (senão o
                                        cliente ficaria vendo “AO VIVO” sem o operador ter onde finalizar). */}
                                    {b && b.status === 'CONFIRMED' && (!isPast || !!b.recordingStartedAt) && (bp.canOperateRecording || (!isPast && bp.canFaltas)) && (
                                        <div className="dash-slot__actions" style={{ marginLeft: 'auto' }}>
                                            {/* Iniciar Gravação é obrigatório antes de finalizar (registra o operador presente). */}
                                            {!bp.canOperateRecording ? null : !b.recordingStartedAt ? (
                                                <Tooltip content="Iniciar gravação">
                                                    <button type="button" className="today-action-btn today-action-btn--danger"
                                                        onClick={() => handleQuickAction(b.id, 'start')}>
                                                        <Radio size={14} aria-hidden="true" /> Iniciar
                                                    </button>
                                                </Tooltip>
                                            ) : (
                                                <>
                                                    {/* Em gravação: "Iniciar" clicado por engano pode ser desfeito (igual à tela Hoje). */}
                                                    <Tooltip content="Desfazer início da gravação" describe={false}>
                                                        <button type="button" className="today-action-btn today-action-btn--neutral"
                                                            aria-label={`Desfazer início da gravação de ${b.user.name}`}
                                                            onClick={() => handleUndoStartRecording(b)}>
                                                            <Undo2 size={15} aria-hidden="true" />
                                                        </button>
                                                    </Tooltip>
                                                    <Tooltip content="Finalizar sessão">
                                                        <button type="button" className="today-action-btn today-action-btn--success"
                                                            onClick={() => handleQuickAction(b.id, 'complete')}>
                                                            <Flag size={14} aria-hidden="true" /> Finalizar
                                                        </button>
                                                    </Tooltip>
                                                </>
                                            )}
                                            {!isPast && bp.canFaltas && (
                                                <Tooltip content="Registrar falta" describe={false}>
                                                    <button type="button" className="today-action-btn today-action-btn--danger"
                                                        aria-label={`Registrar falta de ${b.user.name}`}
                                                        onClick={() => setReasonModal({ booking: b, kind: 'FALTA' })}>
                                                        <XCircle size={15} aria-hidden="true" />
                                                    </button>
                                                </Tooltip>
                                            )}
                                        </div>
                                    )}

                                    {b && b.status === 'COMPLETED' && (
                                        <span className="dash-status-chip dash-status-chip--success" style={{ marginLeft: 'auto' }}><Flag size={13} aria-hidden="true" /> Concluído</span>
                                    )}
                                    {b && b.status === 'FALTA' && (
                                        <span className="dash-status-chip dash-status-chip--danger" style={{ marginLeft: 'auto' }}>
                                            <XCircle size={13} aria-hidden="true" /> Falta
                                            {/* D4: falta justificada do avulso → remarcação sem novo pagamento em aberto. */}
                                            {isBookingMakeupOpen(b) && b.makeupDeadline ? ` · remarcável até ${makeupDeadlineDdmm(b.makeupDeadline)}` : ''}
                                        </span>
                                    )}
                                    {b && b.status === 'NAO_REALIZADO' && isBookingMakeupOpen(b) && b.makeupDeadline && (
                                        // D5: não realizada pelo estúdio → remarcação sem custo em aberto.
                                        <span className="dash-status-chip" style={{ color: 'var(--warning)', marginLeft: 'auto' }}>
                                            <AlertCircle size={13} aria-hidden="true" /> Não realizado · remarcável até {makeupDeadlineDdmm(b.makeupDeadline)}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
            )}

            {/* ── SECTION 2: KPIs (2 colunas mobile · 4 desktop; padrão .admin-kpi-card) ─── */}
            {kpis.length > 0 && (
            <div className="dash-kpi-grid">
                {kpis.map((kpi, i) => (
                    <div key={i} className={`admin-kpi-card${kpi.mod}`}>
                        <div className="admin-kpi-card__label">{kpi.label}</div>
                        <div className="admin-kpi-card__value admin-kpi-card__value--sm">{kpi.value}</div>
                        <div className="admin-kpi-card__caption">{kpi.sub}</div>
                    </div>
                ))}
            </div>
            )}

            {/* ── SECTION 3: Alertas + Ocupação Semanal ────────── (um só ocupa a linha inteira) */}
            {(canAlerts || canBookings) && (
            <div className={canAlerts && canBookings ? 'admin-grid-2' : undefined} style={{ marginBottom: '24px' }}>

                {/* Alerts */}
                {canAlerts && (
                <div className="admin-card dash-panel">
                    <h3 className="dash-panel__title">
                        <AlertTriangle size={18} style={{ color: 'var(--danger)' }} aria-hidden="true" /> Alertas
                        {totalAlerts > 0 && (
                            <span className="dash-count-badge dash-count-badge--danger">{totalAlerts}</span>
                        )}
                    </h3>

                    {totalAlerts === 0 ? (
                        <div className="admin-empty">
                            <CheckCircle2 size={36} className="admin-empty__icon" aria-hidden="true" />
                            <div className="admin-empty__title">Tudo em ordem!</div>
                        </div>
                    ) : (
                        <div className="dash-panel__list dash-panel__list--lg">
                            {expiringContracts.map(c => (
                                <div key={c.id} className="dash-alert dash-alert--danger">
                                    <AlertCircle size={18} className="dash-alert__icon" aria-hidden="true" />
                                    <div className="dash-alert__body">
                                        <div className="dash-alert__title">
                                            {/* Com clientes.ver abre o perfil (como antes); sem, o detalhe do contrato (contratos.ver). */}
                                            Contrato de <button type="button" className="dash-inline-link" onClick={() => (canClients && c.user?.id ? navigate(`/admin/clients/${c.user.id}`) : navigate(`/admin/contracts/${c.id}`))}>{c.user?.name}</button> {(() => { const d = daysUntil(c.endDate); return d === 0 ? 'expira hoje' : `expira em ${d} ${d === 1 ? 'dia' : 'dias'}`; })()}
                                        </div>
                                        <div className="dash-alert__sub">{getMeta(CONTRACT_TYPE_META, c.type).label} · {getMeta(TIER_META, c.tier).label}</div>
                                    </div>
                                </div>
                            ))}

                            {pendingCancellations.map(c => (
                                <div key={c.id} className="dash-alert dash-alert--warning">
                                    <AlertTriangle size={18} className="dash-alert__icon" aria-hidden="true" />
                                    <div className="dash-alert__body">
                                        <div className="dash-alert__title">
                                            Cancelamento pendente: <button type="button" className="dash-inline-link" onClick={() => navigate('/admin/contracts')}>{c.user?.name}</button>
                                        </div>
                                        <div className="dash-alert__sub">Aguardando resolução (multa ou isenção)</div>
                                    </div>
                                </div>
                            ))}

                            {unconfirmedToday.map(b => (
                                <div key={b.id} className="dash-alert dash-alert--warning">
                                    <Clock size={18} className="dash-alert__icon" aria-hidden="true" />
                                    <div className="dash-alert__body">
                                        <div className="dash-alert__title">
                                            {b.user.name} às {b.startTime} — ainda sem confirmação
                                        </div>
                                    </div>
                                    {bp.canConfirmPresence && (
                                        <button className="today-action-btn today-action-btn--success"
                                            onClick={() => handleQuickAction(b.id, 'checkin')}>
                                            Confirmar
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                )}

                {/* Weekly Occupancy */}
                {canBookings && (
                <div className="admin-card dash-panel">
                    <h3 className="dash-panel__title"><TrendingUp size={18} style={{ color: 'var(--accent-text)' }} aria-hidden="true" /> Ocupação da Semana</h3>
                    <div className="dash-panel__list dash-panel__list--lg">
                        {weekOccupancy.map(d => (
                            <div key={d.date} className="dash-occ">
                                <span className={`dash-occ__day${d.date === today ? ' dash-occ__day--today' : ''}`}>
                                    {d.day}
                                </span>
                                <div className="dash-occ__track">
                                    {!d.closed && (
                                        <div
                                            className={`dash-occ__fill ${d.pct > 80 ? 'dash-occ__fill--high' : d.pct > 60 ? 'dash-occ__fill--mid' : 'dash-occ__fill--low'}`}
                                            style={{ width: `${d.pct}%` }}
                                        />
                                    )}
                                </div>
                                <span className={`dash-occ__count${d.closed ? ' dash-occ__count--closed' : ''}`}>
                                    {d.closed ? 'Fech.' : `${d.count}/${d.total}`}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
                )}
            </div>
            )}

            {/* ── SECTION 4: Próximos Agendamentos + Churn Risk ── */}
            {(canBookings || canChurn) && (
            <div className={canBookings && canChurn ? 'admin-grid-2' : undefined}>

                {/* Next Bookings */}
                {canBookings && (
                <div className="admin-card dash-panel">
                    <h3 className="dash-panel__title"><CalendarClock size={18} style={{ color: 'var(--accent-text)' }} aria-hidden="true" /> Próximos Agendamentos</h3>
                    {futureBookings.length === 0 ? (
                        <div className="admin-empty">
                            <CalendarDays size={36} className="admin-empty__icon" aria-hidden="true" />
                            <div className="admin-empty__title">Nenhum agendamento futuro</div>
                            <button className="btn-admin-ghost btn-admin-ghost--compact" onClick={() => navigate('/calendar')}>
                                Abrir agenda
                            </button>
                        </div>
                    ) : (
                        <div className="dash-panel__list">
                            {futureBookings.map(b => (
                                <div key={b.id} className="dash-row">
                                    <div className="dash-row__date">
                                        {new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' })}
                                    </div>
                                    <div className="dash-row__time">{b.startTime}</div>
                                    <div className="dash-row__body">
                                        {clientLink(b.user.name, b.user.id, true)}
                                    </div>
                                    <StatusBadge meta={getMeta(TIER_META, b.tierApplied)} size="sm" />
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                )}

                {/* Churn Risk */}
                {canChurn && (
                <div className="admin-card dash-panel">
                    <h3 className="dash-panel__title">
                        <AlertTriangle size={18} style={{ color: 'var(--warning)' }} aria-hidden="true" /> Clientes em Risco
                        {churnRisk.length > 0 && (
                            <span className="dash-count-badge dash-count-badge--warning">{churnRisk.length}</span>
                        )}
                    </h3>
                    {churnRisk.length === 0 ? (
                        <div className="admin-empty">
                            <Target size={36} className="admin-empty__icon" aria-hidden="true" />
                            <div className="admin-empty__title">Todos os clientes engajados!</div>
                        </div>
                    ) : (
                        <div className="dash-panel__list">
                            {churnRisk.slice(0, 5).map(u => {
                                const userContract = activeContracts.find(c => c.user?.id === u.id);
                                const userBookings = allBookings.filter(b => b.user?.id === u.id && b.status !== 'CANCELLED').sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
                                const lastDate = userBookings[0] ? new Date(userBookings[0].date).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' }) : 'Nunca agendou';

                                return (
                                    <div key={u.id} className="dash-row dash-row--warning">
                                        <div className="admin-avatar">{getInitials(u.name)}</div>
                                        <div className="dash-row__body">
                                            <button className="dash-name-btn dash-name-btn--sm"
                                                onClick={() => navigate(`/admin/clients/${u.id}`)}>
                                                {u.name}
                                            </button>
                                            <div className="dash-row__sub">
                                                Último agendamento: {lastDate} · {userContract?.type || '—'}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
                )}
            </div>
            )}

            <StatusReasonModal
                isOpen={!!reasonModal}
                kind={reasonModal?.kind ?? null}
                subtitle={reasonModal ? `${reasonModal.booking.user.name} · ${reasonModal.booking.startTime}` : undefined}
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
