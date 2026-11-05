import { getErrorMessage } from '../utils/errors';
import React, { useState, useEffect, useCallback, useMemo, useId, useRef } from 'react';
import {
    Clapperboard, CheckCircle2, ChevronRight, CalendarDays, Flag, XCircle,
    AlertCircle, Ban, UserRound, Save, Radio, Timer, Eye, MessageCircle, Globe,
    Moon, Undo2,
} from 'lucide-react';
import { bookingsApi, BookingWithUser } from '../api/client';
import { useUI } from '../context/UIContext';
import { useNavigate } from 'react-router-dom';
import { HeroSkeleton } from '../components/ui/SkeletonLoader';
import BrandLoader from '../components/ui/BrandLoader';
import Tooltip from '../components/ui/Tooltip';
import StatusBadge from '../components/ui/StatusBadge';
import FinalizeRecordingModal from '../components/admin/bookings/FinalizeRecordingModal';
import StatusReasonModal, { type ReasonKind, type ReasonConfirmOptions } from '../components/admin/bookings/StatusReasonModal';
import { MakeupStatusPanel } from '../components/admin/bookings/MakeupRescheduleModal';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { useIsMobile } from '../hooks/useIsMobile';
import { buildReasonUpdate, reasonSaveFeedback, showReasonFeedback } from '../utils/avulsoMakeup';
import { bookingSummary, cancelBookingConsequences, cancelBookingRequest } from '../components/admin/bookings/bookingDanger';
import { useBookingPermissions, CANCEL_OPEN_CHARGE_NEEDS_BAIXA } from '../components/admin/bookings/bookingPermissions';
import { TIER_META, BOOKING_STATUS_META, getMeta } from '../constants/adminMeta';

import { formatBRL, getInitials } from '../utils/format';
import { todayStrSaoPaulo } from '../utils/time';
import { buildDayTimeline } from '../constants/slots';

const TIMELINE = buildDayTimeline();

// Estilos .today-* vivem em styles/admin-area.css (seção AdminTodayPage).

export default function AdminTodayPage() {
    const uid = useId();
    const navigate = useNavigate();
    const { showToast, showConfirm, showAlert } = useUI();
    useBusinessConfig(); // pré-carrega as regras (prazo da remarcação) que o modal de motivo mostra
    // Cada ação segue a sua permissão (o servidor recusa o resto com 403): presença, gravação, falta,
    // cancelar, notas/métricas e o link do perfil do cliente.
    const bp = useBookingPermissions();
    // Tela estreita (celular): o cabeçalho do horário não cabe numa linha só — horário + status em
    // cima, cliente embaixo; as ações rápidas (ícones) ficam só no painel aberto, com rótulo.
    const compact = useIsMobile(640);
    const [bookings, setBookings] = useState<BookingWithUser[]>([]);
    const [loading, setLoading] = useState(true);
    // Recarga DEPOIS da 1ª carga (após uma ação): a agenda continua na tela, com "Atualizando…" no topo.
    const [refreshing, setRefreshing] = useState(false);
    const loadedOnceRef = useRef(false);
    const [loadError, setLoadError] = useState(false);
    const [expandedSlot, setExpandedSlot] = useState<string | null>(null);
    const [finalizeBooking, setFinalizeBooking] = useState<BookingWithUser | null>(null);
    const [reasonModal, setReasonModal] = useState<{ booking: BookingWithUser; kind: ReasonKind } | null>(null);
    const [savingReason, setSavingReason] = useState(false);

    const [adminNotes, setAdminNotes] = useState('');
    const [clientNotes, setClientNotes] = useState('');
    const [durationMin, setDurationMin] = useState<number | ''>('');
    const [peakViewers, setPeakViewers] = useState<number | ''>('');
    const [chatMessages, setChatMessages] = useState<number | ''>('');
    const [audienceOrigin, setAudienceOrigin] = useState('');
    const [saving, setSaving] = useState(false);

    const today = todayStrSaoPaulo();
    const isSunday = new Date().getDay() === 0;

    const loadData = useCallback(async () => {
        // Só a 1ª carga troca a tela pelo loading; as seguintes não desmontam a agenda (o painel
        // aberto e o que o operador digitou continuam lá).
        if (loadedOnceRef.current) setRefreshing(true); else setLoading(true);
        setLoadError(false);
        try {
            const res = await bookingsApi.getAll(today);
            setBookings(res.bookings.filter(b => b.status !== 'CANCELLED'));
            loadedOnceRef.current = true;
        } catch (err) { console.error(err); setLoadError(true); }
        finally { setLoading(false); setRefreshing(false); }
    }, [today]);

    useEffect(() => { loadData(); }, [loadData]);

    const bookingForSlot = (time: string): BookingWithUser | undefined =>
        bookings.find(b => b.startTime === time);

    const handleStatusChange = async (bookingId: string, newStatus: string, label: string) => {
        try {
            await bookingsApi.update(bookingId, { status: newStatus });
            showToast(newStatus === 'CONFIRMED' ? 'Presença confirmada!' : `${label}: registrado com sucesso!`);
            await loadData();
        } catch (err: unknown) { showToast({ message: getErrorMessage(err) || `Não foi possível registrar: ${label.toLowerCase()}.`, type: 'error' }); }
    };

    // Operador clica em "Iniciar Gravação" → registra quem operou e quando (pré-requisito p/ finalizar).
    const handleStartRecording = async (bookingId: string) => {
        try {
            await bookingsApi.startRecording(bookingId);
            showToast('🔴 Gravação iniciada!');
            await loadData();
        } catch (err: unknown) { showToast({ message: getErrorMessage(err) || 'Erro ao iniciar a gravação.', type: 'error' }); }
    };

    // "Iniciar gravação" clicado por engano: desfaz o início (o cliente deixa de ver "AO VIVO" e a
    // sessão volta a pedir "Iniciar gravação" antes de finalizar). Reversível → confirmação em tom
    // warning. Sem try/catch no onConfirm: o erro da API (ex.: 409 já finalizada) aparece no diálogo.
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
                // Recusado (ex.: outra aba já finalizou): a lista daqui está velha — recarrega por trás do diálogo.
                const res = await bookingsApi.undoStartRecording(booking.id).catch((err: unknown) => { void loadData(); throw err; });
                // A rota devolve a reserva SEM `user`: mescla só os campos do início no item da lista.
                const u = res.booking;
                setBookings(prev => prev.map(b => b.id === booking.id ? {
                    ...b,
                    status: u?.status ?? b.status,
                    recordingStartedAt: u?.recordingStartedAt ?? null,
                    recordingStartedByName: u?.recordingStartedByName ?? null,
                } : b));
                showToast(res.message || 'Início da gravação desfeito.');
            },
        });
    };

    // Falta / Não Realizado passam por um modal que exige o MOTIVO antes de aplicar o status.
    // Avulso (D4/D5): a FALTA pode ser justificada (noShowJustified) e o NAO_REALIZADO abre a remarcação.
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
            await loadData();
        } catch (err: unknown) { showToast({ message: getErrorMessage(err) || 'Erro ao registrar.', type: 'error' }); }
        finally { setSavingReason(false); }
    };

    // D3: cancelar é destrutivo — diálogo de perigo com as consequências reais. Sem try/catch no
    // onConfirm: um erro da API aparece DENTRO do diálogo (antes só ia para o console).
    const handleCancel = (booking: BookingWithUser) => {
        showConfirm({
            tone: 'danger',
            icon: Ban,
            title: 'Cancelar agendamento?',
            message: bookingSummary(booking),
            consequences: cancelBookingConsequences(booking, { canSettleCharges: bp.canSettleCharges }),
            confirmLabel: 'Cancelar agendamento',
            loadingLabel: 'Cancelando…',
            onConfirm: async () => {
                await cancelBookingRequest(booking);
                showToast('Agendamento cancelado.');
                await loadData();
            },
        });
    };

    const openSlotDetails = (booking: BookingWithUser) => {
        setExpandedSlot(prev => prev === booking.id ? null : booking.id);
        setAdminNotes(booking.adminNotes || '');
        setClientNotes(booking.clientNotes || '');
        setDurationMin(booking.durationMinutes || '');
        setPeakViewers(booking.peakViewers || '');
        setChatMessages(booking.chatMessages || '');
        setAudienceOrigin(booking.audienceOrigin || '');
    };

    const handleSaveMetrics = async (bookingId: string) => {
        setSaving(true);
        try {
            await bookingsApi.update(bookingId, {
                adminNotes,
                clientNotes,
                durationMinutes: durationMin === '' ? null : Number(durationMin),
                peakViewers: peakViewers === '' ? null : Number(peakViewers),
                chatMessages: chatMessages === '' ? null : Number(chatMessages),
                audienceOrigin: audienceOrigin || null,
            });
            showToast('Métricas salvas com sucesso! ✅');
            await loadData();
        } catch (err: unknown) { showToast({ message: getErrorMessage(err) || 'Não foi possível salvar as alterações.', type: 'error' }); }
        finally { setSaving(false); }
    };

    const [now, setNow] = useState(new Date());
    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const nowTime = `${hh}:${mm}`;

    // --- Lean day summary (clean, no KPI cards) ---
    const dayStats = useMemo(() => {
        const recordings = bookings.length;
        const completed = bookings.filter(b => b.status === 'COMPLETED').length;
        const isPending = (b: BookingWithUser) => b.status !== 'COMPLETED' && b.status !== 'FALTA' && b.status !== 'NAO_REALIZADO';
        // Session whose slot is happening right now.
        const nowSlot = TIMELINE.find(s => s.type === 'SLOT' && nowTime >= s.time && nowTime <= s.timeEnd);
        const nowSession = nowSlot ? bookings.find(b => b.startTime === nowSlot.time && isPending(b)) : undefined;
        // Next upcoming pending session.
        const next = bookings
            .filter(b => b.startTime > nowTime && isPending(b))
            .sort((a, b) => a.startTime.localeCompare(b.startTime))[0];
        return { recordings, completed, nowSession, next };
    }, [bookings, nowTime]);

    if (loading) return <div><HeroSkeleton /><BrandLoader size="section" label="Carregando a agenda de hoje…" /></div>;

    // U4: a failed load must not render as an empty day (0 gravações) — show a clear retry.
    if (loadError && bookings.length === 0) {
        return (
            <div className="client-empty animate-card-enter" role="alert" style={{ marginTop: 24 }}>
                <Clapperboard size={32} className="client-empty__icon" />
                <div className="client-empty__text">Não foi possível carregar a agenda de hoje.</div>
                <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} onClick={loadData}>Tentar novamente</button>
            </div>
        );
    }

    return (
        <div>
            {/* --- LIVE HERO (real-time clock + lean day summary) --- */}
            <div className="today-hero">
                <div className="today-live-badge">
                    <span className="today-live-dot" /> Ao vivo · Visão do dia
                </div>
                {refreshing && (
                    <div style={{ position: 'absolute', top: 14, right: 16 }}>
                        <BrandLoader size="inline" label="Atualizando…" labelHidden={compact} />
                    </div>
                )}
                <div className="today-clock" aria-label={`Agora são ${hh}:${mm}:${ss}`}>
                    <span className="today-clock-time">{hh}<span className="today-clock-colon">:</span>{mm}</span>
                    <span className="today-clock-secs">{ss}</span>
                </div>
                <div className="today-date">
                    {now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
                </div>

                {!isSunday && (
                    <div className="today-summary">
                        <span className="today-summary-item">
                            <Clapperboard size={16} style={{ color: 'var(--accent-primary)' }} />
                            <span className="today-summary-num">{dayStats.recordings}</span>&nbsp;gravações hoje
                        </span>
                        <span className="today-summary-item">
                            <CheckCircle2 size={16} style={{ color: 'var(--success)' }} />
                            <span className="today-summary-num">{dayStats.completed}</span>&nbsp;concluídas
                        </span>

                        {dayStats.nowSession ? (
                            <span className="today-next today-next--now">
                                <span className="today-live-dot" />
                                <span><strong style={{ color: 'var(--success)' }}>Gravando agora:</strong> {dayStats.nowSession.user.name}</span>
                            </span>
                        ) : dayStats.next ? (
                            <span className="today-next">
                                <ChevronRight size={15} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
                                <span>Próxima às <strong style={{ color: 'var(--text-primary)' }}>{dayStats.next.startTime}</strong> · {dayStats.next.user.name}</span>
                            </span>
                        ) : dayStats.recordings > 0 ? (
                            <span className="today-next"><CheckCircle2 size={15} style={{ color: 'var(--success)', flexShrink: 0 }} /> Tudo concluído por hoje</span>
                        ) : (
                            <button className="today-next" style={{ cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-secondary)' }}
                                onClick={() => navigate('/calendar')}>
                                <CalendarDays size={15} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
                                <span>Nenhuma gravação hoje — abrir agenda</span>
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* --- SUNDAY --- */}
            {isSunday ? (
                <div style={{
                    padding: '64px 24px', textAlign: 'center', borderRadius: '16px',
                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                }}>
                    <Moon size={56} aria-hidden="true" style={{ marginBottom: '16px', opacity: 0.5 }} />
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>Estúdio fechado aos domingos</div>
                    <p style={{ color: 'var(--text-muted)', marginTop: '8px', fontSize: '0.9375rem' }}>Descanse bem. A semana começa amanhã! 🎉</p>
                </div>
            ) : (
                /* --- TIMELINE --- */
                <div className="today-timeline">
                    {TIMELINE.map((item, index) => {
                        if (item.type === 'BREAK') {
                            const isBreakNow = nowTime >= item.time && nowTime <= item.timeEnd;
                            return (
                                <div key={item.id} className="today-break-row">
                                    <div className={`today-break-dot${isBreakNow ? ' today-break-dot--now' : ''}`} />
                                    <div className={`today-break-chip${isBreakNow ? ' today-break-chip--now' : ''}`}>
                                        {item.breakIcon && <item.breakIcon size={14} aria-hidden="true" />}
                                        <span>{item.breakLabel}</span>
                                        {isBreakNow && <span className="today-now-chip">agora</span>}
                                    </div>
                                </div>
                            );
                        }

                        const booking = bookingForSlot(item.time);
                        const isPast = nowTime > item.timeEnd;
                        const isNow = nowTime >= item.time && nowTime <= item.timeEnd;
                        const isExpanded = booking && expandedSlot === booking.id;
                        const tierInfo = booking ? getMeta(TIER_META, booking.tierApplied) : null;
                        const TierIcon = tierInfo ? tierInfo.icon : null;

                        return (
                            <div key={item.id} className="today-slot-row" style={{ opacity: isPast && !booking ? 0.3 : 1 }}>
                                {/* -- Left: Dot + Connector -- */}
                                <div className="today-rail">
                                    <div className={`today-dot${isNow ? ' today-dot--now' : ''}`} style={{
                                        width: isNow ? 18 : 12, height: isNow ? 18 : 12,
                                        borderRadius: '50%',
                                        border: `2px solid ${
                                            isNow ? 'var(--success)'
                                            : booking ? (booking.status === 'COMPLETED' ? 'var(--success)' : booking.status === 'FALTA' ? 'var(--danger)' : 'var(--info)')
                                            : 'var(--border-color)'
                                        }`,
                                        background: booking
                                            ? (booking.status === 'COMPLETED' ? 'var(--success)' : booking.status === 'FALTA' ? 'var(--danger)' : booking.status === 'CONFIRMED' ? 'var(--info)' : 'transparent')
                                            : 'transparent',
                                        transition: 'border-color 0.3s ease, background 0.3s ease',
                                        flexShrink: 0,
                                    }} />

                                    {isNow && (
                                        <div className="today-now-chip" style={{ marginTop: '6px' }}>AGORA</div>
                                    )}

                                    {index < TIMELINE.length - 1 && (
                                        <div className={`today-connector${isNow ? ' today-connector--now' : ''}`} />
                                    )}
                                </div>

                                {/* -- Right: Slot Card -- */}
                                <div className={`today-slot-card${booking ? ' today-slot-card--filled' : ''}${isNow ? ' today-slot-card--now' : ''}`}>
                                    {/* Card Header */}
                                    <div
                                        className={`today-slot-head${booking ? ' today-slot-head--clickable' : ''}`}
                                        role={booking ? 'button' : undefined}
                                        tabIndex={booking ? 0 : undefined}
                                        aria-expanded={booking ? !!isExpanded : undefined}
                                        style={compact && booking ? { flexWrap: 'wrap', rowGap: 10, padding: '14px' } : undefined}
                                        onClick={() => booking && openSlotDetails(booking)}
                                        onKeyDown={(e) => {
                                            if (booking && (e.key === 'Enter' || e.key === ' ')) {
                                                e.preventDefault();
                                                openSlotDetails(booking);
                                            }
                                        }}
                                    >
                                        {/* Time badge */}
                                        <div className={`today-time-badge${isNow ? ' today-time-badge--now' : ''}`}
                                            style={compact && booking ? { minWidth: 0 } : undefined}>
                                            {item.label}
                                        </div>

                                        {/* Content */}
                                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, ...(compact && booking ? { order: 3, flex: '1 1 100%' } : null) }}>
                                            {booking && tierInfo ? (
                                                <>
                                                    {/* Avatar — gradient dinâmico do tier (inline permitido) */}
                                                    <div className="today-avatar" style={{
                                                        background: `linear-gradient(135deg, ${tierInfo.color}, ${tierInfo.color}66)`,
                                                        border: `1px solid ${tierInfo.color}33`,
                                                    }}>
                                                        {getInitials(booking.user.name)}
                                                    </div>

                                                    <div style={{ minWidth: 0 }}>
                                                        {/* Botão de verdade (teclado) dentro da linha clicável: o Enter/Espaço não sobe
                                                            para a linha (que abriria os detalhes e cancelaria o clique do botão). */}
                                                        {bp.canOpenClient ? (
                                                            <Tooltip content={`Abrir perfil de ${booking.user.name}`}>
                                                                <button type="button" className="dash-name-btn dash-name-btn--ellipsis"
                                                                    style={{ display: 'block', color: 'var(--accent-text)', lineHeight: 'inherit' }}
                                                                    onKeyDown={(e) => e.stopPropagation()}
                                                                    onClick={(e) => { e.stopPropagation(); navigate(`/admin/clients/${booking.user.id}`); }}>
                                                                    {booking.user.name}
                                                                </button>
                                                            </Tooltip>
                                                        ) : (
                                                            // Sem clientes.ver: só o nome (o perfil cairia no redirecionamento).
                                                            <span className="dash-name-btn dash-name-btn--ellipsis" style={{ display: 'block', lineHeight: 'inherit', cursor: 'inherit' }}>
                                                                {booking.user.name}
                                                            </span>
                                                        )}
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                                                            <span style={{
                                                                fontSize: '0.625rem', color: tierInfo.color, fontWeight: 700,
                                                                background: tierInfo.bg, padding: '1px 6px', borderRadius: '4px',
                                                                display: 'inline-flex', alignItems: 'center', gap: '4px',
                                                            }}>
                                                                {TierIcon && <TierIcon size={11} />} {tierInfo.label}
                                                            </span>
                                                            <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', fontWeight: 600 }}>{formatBRL(booking.price)}</span>
                                                        </div>
                                                    </div>
                                                </>
                                            ) : (
                                                <span style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                                                    {isPast ? '— Encerrado —' : 'Horário disponível'}
                                                </span>
                                            )}
                                        </div>

                                        {/* Right side: Status + Quick Actions */}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, ...(compact && booking ? { marginLeft: 'auto' } : null) }}>
                                            {booking && (
                                                <StatusBadge meta={getMeta(BOOKING_STATUS_META, booking.status)} size={compact ? 'sm' : 'md'} />
                                            )}

                                            {/* Sessão já INICIADA mantém Desfazer/Finalizar depois do fim do horário (é quando se finaliza). */}
                                            {booking && !isExpanded && !compact && (booking.status === 'CONFIRMED' || booking.status === 'RESERVED')
                                                && (!isPast || (booking.status === 'CONFIRMED' && !!booking.recordingStartedAt)) && (
                                                <div style={{ display: 'flex', gap: '3px' }}>
                                                    {booking.status === 'RESERVED' && bp.canConfirmPresence && (
                                                        <button className="today-action-btn today-action-btn--info"
                                                            aria-label="Confirmar presença"
                                                            style={{ padding: '4px 10px', fontSize: '0.6875rem' }}
                                                            onClick={(e) => { e.stopPropagation(); handleStatusChange(booking.id, 'CONFIRMED', 'Confirmação'); }}>
                                                            Confirmar
                                                        </button>
                                                    )}
                                                    {booking.status === 'CONFIRMED' && !booking.recordingStartedAt && bp.canOperateRecording && (
                                                        <Tooltip content="Iniciar gravação" describe={false}>
                                                            <button type="button" className="today-action-btn today-action-btn--danger"
                                                                aria-label="Iniciar gravação"
                                                                style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                                                                onClick={(e) => { e.stopPropagation(); handleStartRecording(booking.id); }}>
                                                                <Radio size={15} aria-hidden="true" />
                                                            </button>
                                                        </Tooltip>
                                                    )}
                                                    {booking.status === 'CONFIRMED' && booking.recordingStartedAt && bp.canOperateRecording && (
                                                        <>
                                                            <Tooltip content="Desfazer início da gravação" describe={false}>
                                                                <button type="button" className="today-action-btn today-action-btn--neutral"
                                                                    aria-label="Desfazer início da gravação"
                                                                    style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                                                                    onClick={(e) => { e.stopPropagation(); handleUndoStartRecording(booking); }}>
                                                                    <Undo2 size={15} aria-hidden="true" />
                                                                </button>
                                                            </Tooltip>
                                                            <Tooltip content="Finalizar gravação" describe={false}>
                                                                <button type="button" className="today-action-btn today-action-btn--success"
                                                                    aria-label="Finalizar gravação"
                                                                    style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                                                                    onClick={(e) => { e.stopPropagation(); setFinalizeBooking(booking); }}>
                                                                    <Flag size={15} aria-hidden="true" />
                                                                </button>
                                                            </Tooltip>
                                                        </>
                                                    )}
                                                    {!isPast && bp.canFaltas && (
                                                        <Tooltip content="Registrar falta" describe={false}>
                                                            <button type="button" className="today-action-btn today-action-btn--danger"
                                                                aria-label="Registrar falta"
                                                                style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                                                                onClick={(e) => { e.stopPropagation(); setReasonModal({ booking, kind: 'FALTA' }); }}>
                                                                <XCircle size={15} aria-hidden="true" />
                                                            </button>
                                                        </Tooltip>
                                                    )}
                                                </div>
                                            )}

                                            {booking && (
                                                <ChevronRight size={14} aria-hidden="true"
                                                    className={`today-chevron${isExpanded ? ' today-chevron--open' : ''}`} />
                                            )}
                                        </div>
                                    </div>

                                    {/* -- Expanded Panel -- */}
                                    {booking && isExpanded && (
                                        <div className="today-expand-panel">
                                            {/* Action buttons row (cada botão com a sua permissão; sem nenhum, a barra some) */}
                                            {(booking.status === 'CONFIRMED' || booking.status === 'RESERVED') && !isPast
                                                && ((booking.status === 'RESERVED' && bp.canConfirmPresence) || (booking.status === 'CONFIRMED' && bp.canOperateRecording) || bp.canFaltas || bp.canCancel) && (
                                                <div className="today-actions-bar">
                                                    {booking.status === 'RESERVED' && bp.canConfirmPresence && (
                                                        <button className="today-action-btn today-action-btn--info"
                                                            onClick={() => handleStatusChange(booking.id, 'CONFIRMED', 'Confirmação')}>
                                                            <CheckCircle2 size={14} aria-hidden="true" /> Confirmar Presença
                                                        </button>
                                                    )}
                                                    {/* CONFIRMED: iniciar (marca operador) → depois libera o Finalizar. */}
                                                    {booking.status === 'CONFIRMED' && !booking.recordingStartedAt && bp.canOperateRecording && (
                                                        <button className="today-action-btn today-action-btn--danger"
                                                            onClick={() => handleStartRecording(booking.id)}>
                                                            <Radio size={14} aria-hidden="true" /> Iniciar Gravação
                                                        </button>
                                                    )}
                                                    {booking.status === 'CONFIRMED' && booking.recordingStartedAt && bp.canOperateRecording && (
                                                        <button className="today-action-btn today-action-btn--success"
                                                            onClick={() => setFinalizeBooking(booking)}>
                                                            <Flag size={14} aria-hidden="true" /> Finalizar gravação
                                                        </button>
                                                    )}
                                                    {bp.canFaltas && (
                                                        <>
                                                            <button className="today-action-btn today-action-btn--danger"
                                                                onClick={() => setReasonModal({ booking, kind: 'FALTA' })}>
                                                                <XCircle size={14} aria-hidden="true" /> Falta
                                                            </button>
                                                            <button className="today-action-btn today-action-btn--teal"
                                                                onClick={() => setReasonModal({ booking, kind: 'NAO_REALIZADO' })}>
                                                                <AlertCircle size={14} aria-hidden="true" /> Não Realizado
                                                            </button>
                                                        </>
                                                    )}
                                                    {bp.canCancel && (
                                                        <>
                                                            <div style={{ flex: 1 }} />
                                                            {bp.cancelNeedsBaixa(booking) ? (
                                                                // R5: cobrança em aberto e sem a baixa — o Cancelar fica indisponível com a
                                                                // explicação (dica no mouse/teclado; no toque, o clique mostra o mesmo texto).
                                                                <Tooltip content={CANCEL_OPEN_CHARGE_NEEDS_BAIXA}>
                                                                    <button type="button" className="today-action-btn today-action-btn--danger"
                                                                        aria-disabled="true" style={{ opacity: 0.5, cursor: 'not-allowed', transform: 'none', filter: 'none' }}
                                                                        onClick={() => showAlert({ type: 'info', title: 'Cancelar indisponível', message: CANCEL_OPEN_CHARGE_NEEDS_BAIXA })}>
                                                                        <Ban size={14} aria-hidden="true" /> Cancelar
                                                                    </button>
                                                                </Tooltip>
                                                            ) : (
                                                                <button className="today-action-btn today-action-btn--danger"
                                                                    onClick={() => handleCancel(booking)}>
                                                                    <Ban size={14} aria-hidden="true" /> Cancelar
                                                                </button>
                                                            )}
                                                        </>
                                                    )}
                                                </div>
                                            )}

                                            {/* Em gravação — quem iniciou e quando. */}
                                            {booking.status === 'CONFIRMED' && booking.recordingStartedAt && (
                                                <div style={{ margin: '10px 0 14px', padding: '8px 12px', borderRadius: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', fontSize: '0.75rem', color: 'var(--danger)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px 10px', flexWrap: 'wrap' }}>
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: '1 1 220px', minWidth: 0 }}>
                                                        <Radio size={13} aria-hidden="true" style={{ flexShrink: 0 }} /> Em gravação — iniciada por {booking.recordingStartedByName || 'operador'} às {new Date(booking.recordingStartedAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}
                                                    </span>
                                                    {/* Fica aqui (e não só na barra de ações) para continuar ao alcance depois que o horário passou. */}
                                                    {bp.canOperateRecording && (
                                                        <Tooltip content="Clicou em “Iniciar gravação” por engano? Desfaz o início: o cliente deixa de ver “AO VIVO”.">
                                                            <button type="button" className="today-action-btn today-action-btn--neutral"
                                                                onClick={() => handleUndoStartRecording(booking)}>
                                                                <Undo2 size={14} aria-hidden="true" /> Desfazer início
                                                            </button>
                                                        </Tooltip>
                                                    )}
                                                    {/* Depois do fim do horário a barra de ações some: o Finalizar continua aqui
                                                        (antes disso ele já está na barra — sem duplicar). */}
                                                    {isPast && bp.canOperateRecording && (
                                                        <button type="button" className="today-action-btn today-action-btn--success"
                                                            onClick={() => setFinalizeBooking(booking)}>
                                                            <Flag size={14} aria-hidden="true" /> Finalizar gravação
                                                        </button>
                                                    )}
                                                </div>
                                            )}

                                            {/* Motivo registrado na Falta / Não Realizado. */}
                                            {(booking.status === 'FALTA' || booking.status === 'NAO_REALIZADO') && booking.statusReason && (
                                                <div style={{ margin: '10px 0 0', padding: '8px 12px', borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                                                    <strong style={{ color: booking.status === 'FALTA' ? 'var(--danger)' : 'var(--warning)' }}>
                                                        {booking.status === 'FALTA' ? 'Motivo da falta: ' : 'Motivo (não realizado): '}
                                                    </strong>
                                                    {booking.statusReason}
                                                </div>
                                            )}

                                            {/* Remarcação do avulso (D4/D5): status + Justificar falta / Remarcar. */}
                                            <MakeupStatusPanel booking={booking} clientName={booking.user.name} onChanged={loadData} />

                                            {/* Metrics grid (COMPLETED) */}
                                            {booking.status === 'COMPLETED' && (
                                                <div style={{ marginBottom: '24px' }}>
                                                    <div style={{
                                                        fontSize: '0.6875rem', fontWeight: 700, color: 'var(--success)',
                                                        textTransform: 'uppercase', letterSpacing: '0.1em',
                                                        marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '8px',
                                                    }}>
                                                        <span style={{ width: 20, height: 2, background: 'var(--success)', borderRadius: 1 }} />
                                                        Métricas Pós-Gravação
                                                    </div>
                                                    {bp.canOperateRecording && (
                                                        <button className="today-action-btn today-action-btn--danger" style={{ marginBottom: '14px' }}
                                                            onClick={() => setFinalizeBooking(booking)}>
                                                            <Radio size={14} aria-hidden="true" /> Dados da transmissão (redes, links e métricas por rede)
                                                        </button>
                                                    )}
                                                    <div className="admin-kpi-grid">
                                                        {[
                                                            { icon: Timer, label: 'Duração (min)', value: durationMin, onChange: (v: string) => setDurationMin(v === '' ? '' : Number(v)), type: 'number', ph: 'Ex: 120' },
                                                            { icon: Eye, label: 'Pico Viewers', value: peakViewers, onChange: (v: string) => setPeakViewers(v === '' ? '' : Number(v)), type: 'number', ph: 'Ex: 1530' },
                                                            { icon: MessageCircle, label: 'Mensagens', value: chatMessages, onChange: (v: string) => setChatMessages(v === '' ? '' : Number(v)), type: 'number', ph: 'Ex: 2400' },
                                                            { icon: Globe, label: 'Origem', value: audienceOrigin, onChange: setAudienceOrigin, type: 'text', ph: 'Ex: SP Capital' },
                                                        ].map((f, fi) => (
                                                            <div key={f.label} className="admin-field">
                                                                <label className="admin-field__label" style={{ display: 'flex', alignItems: 'center', gap: 4 }} htmlFor={`${uid}-metric-${fi}`}><f.icon size={13} aria-hidden="true" /> {f.label}</label>
                                                                <input id={`${uid}-metric-${fi}`} type={f.type} className="form-input form-input--raised" placeholder={f.ph}
                                                                    style={{ fontSize: '0.8125rem' }}
                                                                    readOnly={!bp.canEditNotes}
                                                                    value={f.value} onChange={e => f.onChange(e.target.value)} />
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}

                                            {/* Notes — `admin-grid-2` collapses to 1 column on ≤640px (mobile). */}
                                            <div className="admin-grid-2" style={{ marginBottom: '20px' }}>
                                                <div>
                                                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.6875rem', fontWeight: 700, color: 'var(--accent-text)', marginBottom: '8px' }} htmlFor={`${uid}-admin-notes`}>
                                                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent-text)' }} />
                                                        Observação Interna (Admin)
                                                    </label>
                                                    <textarea id={`${uid}-admin-notes`} className="form-input form-input--raised"
                                                        style={{ minHeight: 80, resize: 'vertical', fontFamily: 'inherit', fontSize: '0.8125rem' }}
                                                        placeholder="Notas privadas sobre a sessão..."
                                                        readOnly={!bp.canEditNotes}
                                                        value={adminNotes}
                                                        onChange={e => setAdminNotes(e.target.value)} />
                                                </div>
                                                <div>
                                                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.6875rem', fontWeight: 700, color: 'var(--success)', marginBottom: '8px' }} htmlFor={`${uid}-client-notes`}>
                                                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--success)' }} />
                                                        Feedback para o Cliente
                                                    </label>
                                                    <textarea id={`${uid}-client-notes`} className="form-input form-input--raised"
                                                        style={{ minHeight: 80, resize: 'vertical', fontFamily: 'inherit', fontSize: '0.8125rem' }}
                                                        placeholder="Visível no painel do cliente..."
                                                        readOnly={!bp.canEditNotes}
                                                        value={clientNotes}
                                                        onChange={e => setClientNotes(e.target.value)} />
                                                </div>
                                            </div>

                                            {/* Footer actions */}
                                            <div style={{
                                                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
                                                paddingTop: '16px', borderTop: '1px solid var(--border-color)',
                                            }}>
                                                {bp.canOpenClient ? (
                                                    <button className="today-action-btn today-action-btn--neutral"
                                                        onClick={() => navigate(`/admin/clients/${booking.user.id}`)}>
                                                        <UserRound size={14} aria-hidden="true" /> Ver Perfil
                                                    </button>
                                                ) : <span />}
                                                {/* Notas e métricas: hoje.gravacao OU agendamentos.editar (PATCH /bookings/:id). */}
                                                {bp.canEditNotes ? (
                                                    <button className="btn-admin-go"
                                                        onClick={() => handleSaveMetrics(booking.id)}
                                                        disabled={saving}>
                                                        {saving ? 'Salvando…' : <><Save size={15} aria-hidden="true" /> Salvar Alterações</>}
                                                    </button>
                                                ) : (
                                                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                                        Somente leitura: editar notas e métricas exige operar a gravação ou mudar agendamentos.
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            <FinalizeRecordingModal
                isOpen={!!finalizeBooking}
                booking={finalizeBooking}
                onClose={() => setFinalizeBooking(null)}
                onSaved={() => { setFinalizeBooking(null); loadData(); }}
                onStale={loadData}
            />

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
