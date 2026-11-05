import { getErrorMessage } from '../utils/errors';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { bookingsApi, ApiError, AddOnConfig, type ClientBooking, type MakeupStatus } from '../api/client';
import { useUI } from '../context/UIContext';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import BottomSheetModal from './BottomSheetModal';
import PaymentModal from './PaymentModal';
import Tooltip from './ui/Tooltip';
import { PLATFORMS, METRIC_FIELDS, parsePlatforms } from '../constants/platforms';
import { TIER_META, getMeta } from '../constants/adminMeta';
import {
    CalendarDays, Clock, Tag, FileText, Sparkles, Plus, Check, ChevronLeft, RefreshCw,
    ImageIcon, Upload, Youtube, Instagram, Facebook, Music2, FolderOpen, Radio, ExternalLink,
    CreditCard, CalendarClock, BarChart3, MessageCircle, Lock,
    type LucideIcon,
} from 'lucide-react';
import { formatBRL } from '../utils/format';
import { useCountdown } from '../hooks/useCountdown';
import { GRID_ROWS } from './calendar/calendarShared';
import MakeupRescheduleModal from './admin/bookings/MakeupRescheduleModal';
import { isBookingMakeupOpen } from '../utils/contractStatus';
import { calendarYmd, ddmmOfYmd, isMissedStatus, makeupDeadlineDdmm } from '../utils/avulsoMakeup';
import { ignoreMultiClick } from '../hooks/useWizardStep';
import {
    LIVE_BADGE_LABEL, LIVESTREAMED_LABEL, formatDurationMinutes, formatStudioClock,
    isOpenSessionToday, isRecordingLive, summarizeRecording, useRecordingWatch,
} from '../utils/recording';

// Horários de início da grade do estúdio — o reagendamento só faz sentido neles.
const SLOT_TIMES = GRID_ROWS.filter(r => r.type === 'SLOT').map(r => r.time);

export interface BookingDetailData {
    id: string;
    date: string;
    startTime: string;
    endTime: string;
    tierApplied: string;
    status: string;
    price: number;
    /** Recado do estúdio para o cliente (somente leitura). */
    clientNotes?: string | null;
    /**
     * @deprecated A nota INTERNA do admin nunca é exibida ao cliente (E11) e não vem mais nas rotas do
     * cliente. A chave só existe (como `never`) para os chamadores antigos compilarem; o modal a ignora.
     */
    adminNotes?: never;
    platforms?: string | null;
    platformLinks?: string | null;
    episodeTitle?: string | null;
    episodeDescription?: string | null;
    coverImageUrl?: string | null;
    streamMetrics?: string | null;
    isLivestream?: boolean | null;
    addOns?: string[];
    durationMinutes?: number | null;
    peakViewers?: number | null;
    chatMessages?: number | null;
    audienceOrigin?: string | null;
    holdExpiresAt?: string | null;
    // Gravação (E11/E12) — vêm da visão do cliente (ClientBooking); o modal sempre re-hidrata por GET /bookings/:id.
    recordingStartedAt?: string | null;
    recordingFinishedAt?: string | null;
    isRecordingNow?: boolean;
    canEditEpisode?: boolean;
    editBlockedReason?: string | null;
    // Remarcação do avulso (D4/D5) — a hidratação por GET /bookings/:id sempre traz estes campos.
    makeupStatus?: MakeupStatus | null;
    makeupDeadline?: string | null;
    missedDate?: string | null;
    contract?: { id: string; name: string; type: string; tier?: string; discountPct?: number; addOns?: string[] } | null;
}

interface BookingDetailModalProps {
    isOpen?: boolean;
    booking: BookingDetailData;
    onClose: () => void;
    /** Algo foi GRAVADO e o fluxo terminou: o pai fecha o modal e recarrega a lista. */
    onSaved: () => void;
    /**
     * Os dados mudaram no servidor SEM fechar o modal (capa enviada, rascunho salvo ao fechar, gravação
     * finalizada enquanto o modal estava aberto): o pai só recarrega a lista, em silêncio — não fecha nada.
     */
    onChanged?: () => void;
    allAddons?: AddOnConfig[];
    contractDiscountPct?: number;
    contractAddOns?: string[];
}

const PLATFORM_ICON: Record<string, LucideIcon> = {
    YOUTUBE: Youtube, INSTAGRAM: Instagram, FACEBOOK: Facebook, TIKTOK: Music2,
};
const PLATFORM_CFG: Record<string, string> = {
    YOUTUBE: 'platform_youtube_enabled', INSTAGRAM: 'platform_instagram_enabled',
    FACEBOOK: 'platform_facebook_enabled', TIKTOK: 'platform_tiktok_enabled',
};
const ADDON_ICONS: Record<string, string> = {
    EDICAO_VIDEO: '🎬', CORTES_REELS: '📱', CAPA_YOUTUBE: '🖼️', GESTAO_SOCIAL: '📊',
};
const CONTRACT_TYPE_LABEL: Record<string, string> = {
    FIXO: 'Plano Fixo', FLEX: 'Plano Flex', AVULSO: 'Avulso', SERVICO: 'Serviço', CUSTOM: 'Personalizado',
};

function statusLabel(s: string, makeupStatus?: string | null) {
    switch (s) {
        case 'COMPLETED': return 'Concluída';
        case 'CONFIRMED': return 'Confirmada';
        case 'RESERVED': return 'Reservada';
        case 'HELD': return 'Em espera';
        // Falta que o estúdio justificou (janela aberta ou já encerrada — D4).
        case 'FALTA': return makeupStatus === 'OPEN' || makeupStatus === 'EXPIRED' ? 'Falta justificada' : 'Falta';
        case 'NAO_REALIZADO': return 'Não realizada';
        case 'CANCELLED': return 'Cancelada';
        default: return '—';
    }
}
function statusColor(s: string, makeupOpen = false) {
    if (s === 'COMPLETED') return 'var(--success)';
    if (s === 'CONFIRMED') return 'var(--client-accent-teal)';
    if (s === 'RESERVED') return 'var(--warning)';
    if (makeupOpen) return 'var(--warning)';
    return 'var(--text-muted)';
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div className="metric-card">
            <div className="metric-card__label">{label}</div>
            <div className="metric-card__value">{value}</div>
        </div>
    );
}

function HoldBanner({ expiresAt, onExpire }: { expiresAt: string; onExpire: () => void }) {
    const remaining = useCountdown(expiresAt, onExpire) ?? 0;
    const mins = Math.floor(remaining / 60), secs = remaining % 60;
    const color = remaining <= 60 ? 'var(--danger)' : remaining <= 180 ? 'var(--warning)' : 'var(--warning-strong)';
    return (
        <div className="info-box info-box--warning" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <span>Aguardando pagamento — conclua para confirmar.</span>
            <strong style={{ color, fontVariantNumeric: 'tabular-nums' }}>{String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}</strong>
        </div>
    );
}

/** Status em que o cliente ainda edita o episódio — só usado se a resposta não trouxer `canEditEpisode`. */
const EDITABLE_STATUSES = ['RESERVED', 'HELD', 'CONFIRMED'];
const KNOWN_PLATFORMS = new Set(PLATFORMS.map(p => p.key));

/**
 * Modal único de detalhe da gravação/agendamento do cliente: métricas e recado do estúdio (E11) +
 * editor das informações do episódio (E12).
 *
 * Fechado = desmontado, e cada gravação é uma instância própria (`key` = id): nenhum estado — texto
 * digitado e não salvo, dados hidratados da gravação anterior, painéis abertos — sobrevive a fechar,
 * reabrir ou trocar de gravação, mesmo que o pai mantenha o componente montado com `isOpen={false}`.
 */
export default function BookingDetailModal(props: BookingDetailModalProps) {
    if (props.isOpen === false) return null;
    return <BookingDetailModalInner key={props.booking.id} {...props} />;
}

function BookingDetailModalInner({
    isOpen = true, booking, onClose, onSaved, onChanged,
    allAddons = [], contractDiscountPct = 0, contractAddOns = [],
}: BookingDetailModalProps) {
    const { showAlert, showToast } = useUI();
    const { get: getRule, getBool } = useBusinessConfig();
    const navigate = useNavigate();

    // Hydrate full booking (contract/cover/episode/metrics) regardless of caller's data.
    const [full, setFull] = useState<ClientBooking | null>(null);
    const src = (full || booking) as BookingDetailData;
    // O chamador já entregou a visão completa do cliente (GET /my ou /availability)? Então o formulário
    // nasce confiável. Senão (ex.: lista de contratos, sem título/descrição) os campos ficam travados
    // até a hidratação — salvar antes dela gravaria campos vazios por cima do que está no servidor.
    const propIsFull = typeof booking.canEditEpisode === 'boolean';
    const [hydrateFailed, setHydrateFailed] = useState(false);
    const formReady = propIsFull || full !== null;

    const [episodeTitle, setEpisodeTitle] = useState(booking.episodeTitle || '');
    const [episodeDescription, setEpisodeDescription] = useState(booking.episodeDescription || '');
    const [platforms, setPlatforms] = useState<string[]>(parsePlatforms(booking.platforms));
    const [coverUrl, setCoverUrl] = useState(booking.coverImageUrl || '');
    const [localAddOns, setLocalAddOns] = useState<string[]>(booking.addOns || []);
    const [saving, setSaving] = useState(false);
    const [uploadingCover, setUploadingCover] = useState(false);
    // Erros do backend (400 do campo / 409 "não pode mais editar") ficam visíveis dentro do modal.
    const [saveError, setSaveError] = useState('');
    const [coverError, setCoverError] = useState('');
    const fileRef = useRef<HTMLInputElement>(null);
    // Campos que o cliente já mexeu nesta abertura: a hidratação não passa por cima deles.
    const dirty = useRef({ title: false, description: false, platforms: false, cover: false });
    const alive = useRef(true);

    // Reschedule
    const [showReschedule, setShowReschedule] = useState(false);
    const [rescheduleDate, setRescheduleDate] = useState('');
    const [rescheduleTime, setRescheduleTime] = useState('');
    const [rescheduleError, setRescheduleError] = useState('');
    const [rescheduling, setRescheduling] = useState(false);

    // Remarcação sem novo pagamento (falta justificada / não realizada no avulso — D4/D5)
    const [showMakeup, setShowMakeup] = useState(false);

    // Services sheet + payment
    const [showServicesSheet, setShowServicesSheet] = useState(false);
    const [servicesStep, setServicesStep] = useState<1 | 2>(1);
    const [selectedNewAddons, setSelectedNewAddons] = useState<string[]>([]);
    const [payingAddon, setPayingAddon] = useState<{ paymentId: string; amount: number; description: string; addonKeys: string[] } | null>(null);

    /**
     * Lê a gravação no servidor. `applyForm`: também preenche o formulário (só os campos que o cliente
     * ainda não mexeu). Sem `applyForm` atualiza apenas o estado da gravação (status, "AO VIVO",
     * permissão de edição, métricas) — usado no recarregamento periódico e depois de um 409.
     */
    const hydrate = useCallback(async (applyForm: boolean): Promise<ClientBooking | null> => {
        try {
            const r = await bookingsApi.getOne(booking.id);
            if (!alive.current) return null;
            setFull(r.booking);
            setHydrateFailed(false);
            if (applyForm) {
                if (!dirty.current.title) setEpisodeTitle(r.booking.episodeTitle || '');
                if (!dirty.current.description) setEpisodeDescription(r.booking.episodeDescription || '');
                if (!dirty.current.platforms) setPlatforms(parsePlatforms(r.booking.platforms));
                if (!dirty.current.cover) setCoverUrl(r.booking.coverImageUrl || '');
                setLocalAddOns(r.booking.addOns || []);
            }
            return r.booking;
        } catch {
            if (alive.current && applyForm) setHydrateFailed(true);
            return null;
        }
    }, [booking.id]);

    useEffect(() => {
        alive.current = true;
        void hydrate(true);
        return () => { alive.current = false; };
    }, [hydrate]);

    // Sessão de hoje em aberto: acompanha o início/fim da gravação com o modal aberto (o "AO VIVO" liga
    // e desliga, e ao finalizar os campos travam e as métricas aparecem) sem mexer no que foi digitado.
    useRecordingWatch(isOpenSessionToday(src), () => {
        void hydrate(false).then(fresh => {
            if (fresh && (fresh.status !== src.status || fresh.isRecordingNow !== !!src.isRecordingNow)) onChanged?.();
        });
    });

    const dateStr = src.date.split('T')[0];
    const isCompleted = src.status === 'COMPLETED';
    const liveNow = isRecordingLive(src);
    // Edição do episódio (E12): o backend é a autoridade (`canEditEpisode` + `editBlockedReason`).
    const canEdit = formReady && (src.canEditEpisode ?? EDITABLE_STATUSES.includes(src.status));
    const blockedReason = formReady && !canEdit
        ? (src.editBlockedReason || 'As informações desta gravação não podem mais ser alteradas.')
        : null;
    // Com a edição encerrada, os campos mostram o que está GRAVADO no servidor — nunca um texto digitado
    // e não salvo (ex.: o estúdio finalizou a gravação com o modal aberto).
    const shownTitle = canEdit ? episodeTitle : (src.episodeTitle || '');
    const shownDescription = canEdit ? episodeDescription : (src.episodeDescription || '');
    const shownPlatforms = canEdit ? platforms : parsePlatforms(src.platforms);
    const contract = full?.contract || booking.contract || null;
    const discountPct = contract?.discountPct ?? contractDiscountPct ?? 0;
    const ctrAddOns = contract?.addOns ?? contractAddOns ?? [];

    // Janela de remarcação do avulso: aberta e dentro do prazo (o backend confere dono, faixa e antecedência).
    const makeupOpen = isMissedStatus(src.status) && isBookingMakeupOpen(src);
    const makeupDdmm = src.makeupDeadline ? makeupDeadlineDdmm(src.makeupDeadline) : null;
    const missedDdmm = src.missedDate ? ddmmOfYmd(calendarYmd(src.missedDate)) : null;

    const canReschedule = useCallback((): boolean => {
        if (src.status !== 'RESERVED' && src.status !== 'CONFIRMED') return false;
        const dt = new Date(`${dateStr}T${src.startTime}:00-03:00`);
        return (dt.getTime() - Date.now()) / (1000 * 60 * 60) >= 24;
    }, [src.status, dateStr, src.startTime]);

    const togglePlatform = (key: string) => {
        if (!canEdit) return;
        dirty.current.platforms = true;
        setPlatforms(prev => prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key]);
    };

    /**
     * Erro de uma escrita do cliente (client-update / cover-image): mostra a mensagem do backend dentro do
     * modal. 409 BOOKING_NOT_EDITABLE = a gravação foi finalizada/cancelada nesse meio-tempo: relê a
     * gravação (os campos travam com o motivo) e avisa o pai para atualizar o card.
     */
    const showWriteError = async (err: unknown, setMsg: (m: string) => void) => {
        setMsg(getErrorMessage(err));
        if (err instanceof ApiError && err.status === 409 && err.code === 'BOOKING_NOT_EDITABLE') {
            const fresh = await hydrate(false);
            // Com os campos travados, o próprio aviso de "somente leitura" já traz o motivo.
            if (fresh && fresh.canEditEpisode === false && alive.current) setMsg('');
            onChanged?.();
        }
    };

    const handleCoverFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !canEdit) return;
        setUploadingCover(true);
        setCoverError('');
        try {
            const r = await bookingsApi.uploadCover(booking.id, file);
            if (!alive.current) return;
            dirty.current.cover = true;
            setCoverUrl(r.coverImageUrl);
            showToast('Capa atualizada!');
            // A capa já está gravada: o card atrás do modal passa a mostrá-la mesmo sem "Salvar".
            onChanged?.();
        } catch (err: unknown) {
            if (alive.current) await showWriteError(err, setCoverError);
        } finally {
            if (alive.current) setUploadingCover(false);
            if (fileRef.current) fileRef.current.value = '';
        }
    };

    // Persiste o pré-cadastro do episódio (título/descrição/plataformas). O backend aceita isso mesmo
    // com a reserva em RESERVED (aguardando pagamento); a capa já é salva na hora, no upload.
    // Só as redes conhecidas vão no corpo (o backend recusa chave fora do catálogo — dado legado).
    const persistEpisode = () => bookingsApi.clientUpdate(booking.id, {
        episodeTitle: episodeTitle.trim(),
        episodeDescription: episodeDescription.trim(),
        platforms: JSON.stringify(platforms.filter(k => KNOWN_PLATFORMS.has(k))),
    });

    const handleSave = async () => {
        if (saving || !canEdit) return;
        setSaving(true);
        setSaveError('');
        try {
            await persistEpisode();
            showToast('Gravação salva!');
            onSaved();
        } catch (err: unknown) {
            if (alive.current) await showWriteError(err, setSaveError);
        } finally { if (alive.current) setSaving(false); }
    };

    // Reserva aguardando pagamento: salva o pré-cadastro SEM fechar o modal (o cliente segue para o
    // pagamento em seguida). Se não pagar no prazo, o job de expiração de holds apaga a reserva avulsa
    // e o rascunho vai junto — comportamento desejado (nada fica "perdido" no banco).
    const handleSaveDraft = async () => {
        if (saving || !canEdit) return;
        setSaving(true);
        setSaveError('');
        try {
            await persistEpisode();
            showToast('Rascunho salvo! Suas informações ficam guardadas até o pagamento.');
            onChanged?.();
        } catch (err: unknown) {
            if (alive.current) await showWriteError(err, setSaveError);
        } finally { if (alive.current) setSaving(false); }
    };

    // "Pagar agora": salva o que foi digitado antes de sair para o pagamento (não perde o rascunho).
    const handlePayNow = async () => {
        if (saving) return;
        setSaving(true);
        try { if (canEdit) await persistEpisode(); }
        catch { /* não bloqueia o pagamento se o rascunho falhar ao salvar */ }
        finally { if (alive.current) setSaving(false); }
        onClose();
        navigate('/meus-pagamentos');
    };

    // Fechar o modal (X / clicar fora / Esc / arrastar) com a reserva aguardando pagamento: auto-salva
    // o rascunho antes de fechar, para o cliente não perder o que digitou por não clicar em "Salvar".
    // Fire-and-forget (não trava o fechamento). Se não pagar no prazo, o hold expira e apaga tudo.
    const isAwaitingHold = src.status === 'RESERVED' && !!src.holdExpiresAt && new Date(src.holdExpiresAt).getTime() > Date.now();
    const handleClose = () => {
        if (isAwaitingHold && canEdit) persistEpisode().then(() => onChanged?.()).catch(() => {});
        onClose();
    };

    const handleReschedule = async () => {
        setRescheduling(true); setRescheduleError('');
        try {
            await bookingsApi.reschedule(booking.id, { date: rescheduleDate, startTime: rescheduleTime });
            showToast('Reagendado com sucesso!');
            onSaved();
        } catch (err: unknown) { setRescheduleError(getErrorMessage(err)); }
        finally { setRescheduling(false); }
    };

    const handleConfirmAddons = async () => {
        setSaving(true);
        try {
            const res = await bookingsApi.purchaseAddon(booking.id, selectedNewAddons);
            if (res.activatedKeys?.length > 0) setLocalAddOns(prev => [...prev, ...res.activatedKeys]);
            if (res.paymentId && res.amount > 0) {
                setPayingAddon({ paymentId: res.paymentId, amount: res.amount, description: `${res.pendingKeys.length} serviço(s) — ${formatBRL(res.amount)}`, addonKeys: res.pendingKeys });
            } else {
                showToast('Serviços ativados com sucesso!');
                onSaved();
            }
            setShowServicesSheet(false); setServicesStep(1); setSelectedNewAddons([]);
        } catch (err: unknown) {
            showAlert({ message: getErrorMessage(err), type: 'error' });
        } finally { setSaving(false); }
    };

    const displayDate = (() => {
        const d = new Date(dateStr + 'T12:00:00');
        return d.toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'long', day: '2-digit', month: 'long' });
    })();

    const episodeAddons = allAddons.filter(a => !a.monthly);
    const activeAddons = episodeAddons.filter(a => localAddOns.includes(a.key) || ctrAddOns.includes(a.key));
    const availableForPurchase = episodeAddons.filter(a => !localAddOns.includes(a.key) && !ctrAddOns.includes(a.key));
    const contractAvailable = episodeAddons.filter(a => ctrAddOns.includes(a.key) && !localAddOns.includes(a.key));

    const totalPaid = selectedNewAddons.filter(k => !ctrAddOns.includes(k)).reduce((s, k) => {
        const a = episodeAddons.find(x => x.key === k); return a ? s + Math.round(a.price * (1 - discountPct / 100)) : s;
    }, 0);

    // Platforms shown: admin-enabled ∪ already-selected.
    const visiblePlatforms = PLATFORMS.filter(p => getBool(PLATFORM_CFG[p.key], true) || shownPlatforms.includes(p.key));

    // Snapshot do encerramento: totais + detalhe por rede (com links) + agregados da sessão.
    const wasLivestream = !!src.isLivestream;
    const summary = summarizeRecording(src);
    const { totals, networks, recordingLink } = summary;
    const showAudience = wasLivestream || summary.hasAudience;
    const fmtN = (n: number) => n.toLocaleString('pt-BR');
    const orDash = (n: number | null | undefined) => (n ? fmtN(n) : '--');
    const startedClock = formatStudioClock(src.recordingStartedAt);
    const finishedClock = formatStudioClock(src.recordingFinishedAt);

    return (
        <>
            <BottomSheetModal isOpen={isOpen} onClose={handleClose} title="Detalhes da Gravação" maxWidth="560px" preventClose={saving || rescheduling || uploadingCover || (showMakeup && makeupOpen)}>
                <div className="bdm">
                    {/* Hold banner */}
                    {src.holdExpiresAt && new Date(src.holdExpiresAt).getTime() > Date.now() && (
                        <HoldBanner expiresAt={src.holdExpiresAt} onExpire={onSaved} />
                    )}

                    {/* Contract origin + status */}
                    <div className="bdm-top">
                        <div className="bdm-contract">
                            <span className="bdm-contract__icon"><FolderOpen size={14} /></span>
                            <div>
                                <div className="bdm-contract__name">{contract?.name || 'Avulso'}</div>
                                <div className="bdm-contract__type">{CONTRACT_TYPE_LABEL[contract?.type || 'AVULSO'] || contract?.type}</div>
                            </div>
                        </div>
                        {/* "AO VIVO" só enquanto a gravação está acontecendo (isRecordingNow) — nunca por isLivestream. */}
                        {liveNow ? (
                            <span className="poster-chip poster-chip--live bdm-live-chip"><Radio size={11} aria-hidden="true" /> {LIVE_BADGE_LABEL}</span>
                        ) : (
                            <span className="bdm-status" style={{ color: statusColor(src.status, makeupOpen), background: `color-mix(in srgb, ${statusColor(src.status, makeupOpen)} 12%, transparent)` }}>
                                {statusLabel(src.status, src.makeupStatus)}
                            </span>
                        )}
                    </div>

                    {/* Gravação em andamento (E11) */}
                    {liveNow && (
                        <div className="bdm-live" role="status">
                            <Radio size={16} aria-hidden="true" />
                            <span>
                                <strong>Gravação em andamento</strong>{startedClock ? ` desde ${startedClock}` : ''}.
                                {' '}Os resultados aparecem aqui assim que o estúdio finalizar.
                            </span>
                        </div>
                    )}

                    {/* Remarcação do avulso (D4/D5): prazo aberto, encerrado ou já usado. */}
                    {makeupOpen && makeupDdmm && (
                        <div className="info-box info-box--warning mkp-client-banner" style={{ marginBottom: 0 }}>
                            <span role="status">
                                {src.status === 'FALTA'
                                    ? <>Falta justificada: você pode remarcar esta gravação <strong>sem pagar de novo</strong> até <strong>{makeupDdmm} às 23h59</strong>. Se não remarcar, o valor pago é perdido.</>
                                    : <>O estúdio não pôde realizar sua gravação. Remarque <strong>sem custo</strong> até <strong>{makeupDdmm} às 23h59</strong>.</>}
                            </span>
                            {/* Atalho no topo (o rodapé também tem "Remarcar"): o prazo é o assunto principal aqui. */}
                            <button key="makeup-cta" type="button" className="btn btn-primary btn-sm" onClick={() => setShowMakeup(true)}>
                                <CalendarClock size={15} aria-hidden="true" /> Escolher nova data
                            </button>
                        </div>
                    )}
                    {!makeupOpen && isMissedStatus(src.status) && (src.makeupStatus === 'OPEN' || src.makeupStatus === 'EXPIRED') && (
                        <div className={`info-box ${src.status === 'FALTA' ? 'info-box--error' : 'info-box--warning'}`} role="status" style={{ marginBottom: 0 }}>
                            {src.status === 'FALTA'
                                ? `O prazo para remarcar terminou${makeupDdmm ? ` em ${makeupDdmm}` : ''}. O valor pago desta gravação foi perdido.`
                                : `O prazo para remarcar terminou${makeupDdmm ? ` em ${makeupDdmm}` : ''}, mas você não perde o valor: o estúdio vai entrar em contato para combinar a nova data.`}
                        </div>
                    )}
                    {src.status === 'FALTA' && src.makeupStatus === 'USED' && (
                        <div className="info-box info-box--error" role="status" style={{ marginBottom: 0 }}>
                            Esta gravação já tinha sido remarcada uma vez (a remarcação é única), então esta falta não dá direito a outra.
                        </div>
                    )}
                    {!isMissedStatus(src.status) && src.makeupStatus === 'USED' && missedDdmm && (
                        <div className="info-box info-box--success" role="status" style={{ marginBottom: 0 }}>
                            Gravação remarcada sem novo pagamento — a data original era {missedDdmm}.
                        </div>
                    )}

                    {/* Date / time / tier */}
                    <div className="bdm-meta">
                        <div className="bdm-meta__item"><CalendarDays size={14} /><span style={{ textTransform: 'capitalize' }}>{displayDate}</span></div>
                        <div className="bdm-meta__item"><Clock size={14} />{src.startTime} — {src.endTime}</div>
                        <div className="bdm-meta__item"><Tag size={14} />{getMeta(TIER_META, src.tierApplied).label}</div>
                    </div>

                    {/* Não deu para ler a gravação e o chamador não trouxe os dados completos: nada de editar às cegas. */}
                    {hydrateFailed && !formReady && (
                        <div className="error-message bdm-error bdm-error--retry" role="alert">
                            <span>Não foi possível carregar os detalhes desta gravação.</span>
                            <button key="retry" type="button" className="btn btn-secondary btn-sm" onClick={() => { setHydrateFailed(false); void hydrate(true); }}>
                                Tentar novamente
                            </button>
                        </div>
                    )}

                    {/* Resultados (concluída) — somente leitura, logo no topo: é o que o cliente vem ver (E11). */}
                    {isCompleted && (
                        <div className="bdm-section bdm-results">
                            <div className="bdm-section__title">
                                <BarChart3 size={14} /> Resultados da gravação
                                {wasLivestream && (
                                    <span className="bdm-seal"><Radio size={11} aria-hidden="true" /> {LIVESTREAMED_LABEL}</span>
                                )}
                            </div>
                            <p className="bdm-snapshot-note">Números registrados pelo estúdio no encerramento.</p>
                            <div className="metrics-grid bdm-metrics">
                                <Metric label="Duração" value={formatDurationMinutes(src.durationMinutes) || '--'} />
                                <Metric label="Início" value={startedClock || '--'} />
                                <Metric label="Fim" value={finishedClock || '--'} />
                                {showAudience && (
                                    <>
                                        <Metric label="Visualizações" value={orDash(totals.views)} />
                                        <Metric label="Pico de espectadores" value={orDash(totals.peak)} />
                                        <Metric label="Inscritos" value={orDash(totals.subscribers)} />
                                        <Metric label="Curtidas" value={orDash(totals.likes)} />
                                        <Metric label="Comentários" value={orDash(totals.comments)} />
                                        <Metric label="Mensagens no chat" value={orDash(summary.chatMessages)} />
                                    </>
                                )}
                            </div>
                            {/* Detalhe por rede, com o link de cada transmissão */}
                            {networks.length > 0 && (
                                <div className="bdm-net-list" role="list" aria-label="Resultados por rede">
                                    {networks.map(n => {
                                        const Icon = PLATFORM_ICON[n.key] || Radio;
                                        return (
                                            <div key={n.key} className="bdm-net" role="listitem">
                                                <div className="bdm-net__head">
                                                    <span className="bdm-net__name"><Icon size={14} style={{ color: n.color }} /> {n.label}</span>
                                                    {n.link && (
                                                        <Tooltip content={`Abrir ${n.label} em nova aba`} describe={false}>
                                                            <a href={n.link} target="_blank" rel="noopener noreferrer" className="bdm-net__link" aria-label={`Abrir ${n.label} em nova aba`}>
                                                                <ExternalLink size={13} aria-hidden="true" /> Abrir
                                                            </a>
                                                        </Tooltip>
                                                    )}
                                                </div>
                                                {n.hasMetrics ? (
                                                    <div className="bdm-net__stats">
                                                        {METRIC_FIELDS.map(f => (
                                                            <span key={f.key} className="bdm-net__stat"><b>{fmtN(Number(n.metric[f.key]) || 0)}</b>{f.short}</span>
                                                        ))}
                                                    </div>
                                                ) : (
                                                    <div className="bdm-net__empty">Sem números registrados nesta rede.</div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                            {src.audienceOrigin && <div className="bdm-origin">Origem da audiência: <strong>{src.audienceOrigin}</strong></div>}
                            {recordingLink && (
                                <a href={recordingLink} target="_blank" rel="noopener noreferrer" className="btn btn-secondary bdm-results__watch">
                                    <ExternalLink size={15} aria-hidden="true" /> Assistir gravação
                                </a>
                            )}
                        </div>
                    )}

                    {/* Recado do estúdio (clientNotes) — somente leitura. A nota INTERNA do admin nunca aparece aqui. */}
                    {src.clientNotes && (
                        <div className="bdm-section">
                            <div className="bdm-section__title"><MessageCircle size={14} /> Recado do estúdio</div>
                            <div className="bdm-note">{src.clientNotes}</div>
                        </div>
                    )}

                    {/* Edição encerrada (E12): os campos abaixo ficam desabilitados, com o motivo do backend. */}
                    {blockedReason && (
                        <div className="bdm-readonly" role="note">
                            <Lock size={14} aria-hidden="true" />
                            <span>{blockedReason}</span>
                        </div>
                    )}

                    {/* Cover */}
                    {(canEdit || !!coverUrl || !formReady) && (
                        <div className="bdm-section">
                            <div className="bdm-section__title"><ImageIcon size={14} /> Capa do episódio</div>
                            <div className={`bdm-cover ${coverUrl ? 'bdm-cover--has' : ''}`}>
                                {coverUrl ? <img className="bdm-cover__img" src={coverUrl} alt="Capa do episódio" onError={() => setCoverUrl('')} /> : (
                                    <div className="bdm-cover__placeholder"><ImageIcon size={28} /><span>Sem capa</span></div>
                                )}
                                {canEdit && (
                                    <>
                                        <button type="button" className="bdm-cover__btn" onClick={() => fileRef.current?.click()} disabled={uploadingCover}>
                                            <Upload size={14} /> {uploadingCover ? 'Enviando...' : coverUrl ? 'Trocar capa' : 'Enviar capa'}
                                        </button>
                                        <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleCoverFile} />
                                    </>
                                )}
                            </div>
                            {coverError && <div className="error-message bdm-error" role="alert">{coverError}</div>}
                        </div>
                    )}

                    {/* Episode title + description */}
                    <div className="bdm-section">
                        <div className="bdm-section__title"><FileText size={14} /> Episódio</div>
                        <input className="form-input" value={shownTitle} maxLength={140} disabled={!canEdit}
                            aria-label="Título do episódio"
                            onChange={e => { dirty.current.title = true; setEpisodeTitle(e.target.value); }}
                            placeholder={blockedReason ? 'Sem título' : 'Título do episódio'} />
                        <textarea className="form-input" rows={3} value={shownDescription} maxLength={4000} disabled={!canEdit}
                            aria-label="Descrição do episódio"
                            onChange={e => { dirty.current.description = true; setEpisodeDescription(e.target.value); }}
                            placeholder={blockedReason ? 'Sem descrição' : 'Descrição do episódio...'}
                            style={{ resize: 'vertical', marginTop: 8 }} />
                    </div>

                    {/* Planned broadcast platforms (subdued icons, no links). Hidden once completed —
                        the "Resultados da gravação" block above shows the real links/metrics. */}
                    {!isCompleted && (!blockedReason || shownPlatforms.length > 0) && (
                        <div className="bdm-section">
                            <div className="bdm-section__title"><Radio size={14} /> Onde vai transmitir</div>
                            <div className="bdm-platforms">
                                {visiblePlatforms.map(p => {
                                    const Icon = PLATFORM_ICON[p.key] || Radio;
                                    const active = shownPlatforms.includes(p.key);
                                    return (
                                        <button key={p.key} type="button" aria-pressed={active} disabled={!canEdit}
                                            className={`bdm-plat ${active ? 'bdm-plat--active' : ''}`} onClick={() => togglePlatform(p.key)}>
                                            <Icon size={16} /> {p.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Services */}
                    <div className="bdm-section">
                        <div className="bdm-section__title"><Sparkles size={14} /> Serviços</div>
                        <div className="bdm-services">
                            {activeAddons.length > 0 ? activeAddons.map(a => {
                                const isContract = ctrAddOns.includes(a.key);
                                return (
                                    <div key={a.key} className="bdm-service">
                                        <span className="bdm-service__icon">{ADDON_ICONS[a.key] || <Sparkles size={13} />}</span>
                                        <span className="bdm-service__name">{a.name}</span>
                                        <span className={`bdm-service__tag ${isContract ? 'bdm-service__tag--plan' : ''}`}>{isContract ? 'Plano' : 'Ativo'}</span>
                                    </div>
                                );
                            }) : <div className="bdm-service bdm-service--empty">Nenhum serviço ativo</div>}

                            {/* FIN-08: reserva avulsa ainda no prazo de pagamento — os extras vão no checkout dela (o servidor recusa 409). */}
                            {(availableForPurchase.length > 0 || contractAvailable.length > 0) && ['RESERVED', 'CONFIRMED', 'COMPLETED'].includes(src.status) && !src.holdExpiresAt && (
                                <button type="button" className="bdm-service-add" onClick={() => { setShowServicesSheet(true); setServicesStep(1); setSelectedNewAddons([]); }}>
                                    <Plus size={15} /> Adicionar serviço
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Reschedule */}
                    {showReschedule && canReschedule() && (
                        <div className="reschedule-panel" style={{ marginTop: 4 }}>
                            <h4 className="reschedule-panel__title">Reagendar</h4>
                            <p className="reschedule-panel__note">Máx. {getRule('reschedule_max_days') || 7} dias · Mesma faixa ({getMeta(TIER_META, src.tierApplied).label})</p>
                            <div className="reschedule-panel__form">
                                <input type="date" className="form-input" value={rescheduleDate} onChange={e => setRescheduleDate(e.target.value)}
                                    min={new Date().toISOString().split('T')[0]} max={new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]} style={{ flex: 1 }} />
                                {/* Select com os horários REAIS da grade: o input time com step 3600
                                    travava os minutos em :00 — 15:30 e 20:30 eram inescolhíveis. */}
                                <select className="form-input" value={rescheduleTime} onChange={e => setRescheduleTime(e.target.value)} style={{ width: 120 }}>
                                    <option value="">Horário…</option>
                                    {SLOT_TIMES.map(t => <option key={t} value={t}>{t}</option>)}
                                </select>
                                <button type="button" className="btn btn-primary btn-sm" onClick={ignoreMultiClick(handleReschedule)} disabled={rescheduling || !rescheduleDate || !rescheduleTime}>Confirmar</button>
                            </div>
                            {rescheduleError && <div className="error-message" style={{ marginTop: 8 }}>{rescheduleError}</div>}
                        </div>
                    )}

                    {/* Erro do backend ao salvar (400 do campo / 409) — fica visível junto do botão */}
                    {saveError && <div className="error-message bdm-error" role="alert">{saveError}</div>}

                    {/* Footer — sem <form>; todo botão type="button", key própria e guarda de clique duplo no envio */}
                    <div className="bdm-footer">
                        {isAwaitingHold ? (
                            <>
                                <button key="draft" type="button" className="btn btn-secondary" onClick={ignoreMultiClick(handleSaveDraft)} disabled={saving || !canEdit}>{saving ? 'Salvando...' : 'Salvar rascunho'}</button>
                                <button key="pay" type="button" className="btn btn-primary" onClick={ignoreMultiClick(handlePayNow)} disabled={saving}><CreditCard size={15} /> Pagar agora</button>
                            </>
                        ) : (
                            <>
                                {makeupOpen && (
                                    <button key="makeup" type="button" className="btn btn-secondary" onClick={() => setShowMakeup(true)}><CalendarClock size={15} /> Remarcar</button>
                                )}
                                {canReschedule() && (
                                    <button key="reschedule" type="button" className="btn btn-secondary" onClick={() => setShowReschedule(v => !v)}><RefreshCw size={15} /> Reagendar</button>
                                )}
                                {canEdit || (!formReady && !hydrateFailed) ? (
                                    <button key="save" type="button" className="btn btn-primary" onClick={ignoreMultiClick(handleSave)} disabled={saving || !canEdit}>{saving ? 'Salvando...' : 'Salvar'}</button>
                                ) : (
                                    <button key="close" type="button" className="btn btn-secondary" onClick={ignoreMultiClick(handleClose)}>Fechar</button>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </BottomSheetModal>

            {/* Remarcação sem novo pagamento (sheet de etapa única, acima deste modal) */}
            <MakeupRescheduleModal
                isOpen={showMakeup && makeupOpen}
                booking={src}
                variant="client"
                zIndex={1100}
                onClose={() => setShowMakeup(false)}
                onDone={(res) => { setShowMakeup(false); showToast(res.message); onSaved(); }}
            />

            {/* Services bottom sheet */}
            <BottomSheetModal isOpen={showServicesSheet} onClose={() => { setShowServicesSheet(false); setServicesStep(1); setSelectedNewAddons([]); }}
                title={servicesStep === 1 ? 'Serviços para este episódio' : 'Confirmação'} zIndex={1100}>
                {servicesStep === 1 ? (
                    <div className="svc-catalog">
                        {contractAvailable.length > 0 && (
                            <>
                                <p className="svc-catalog__group-title">Inclusos no seu plano</p>
                                <div className="svc-catalog__list">
                                    {contractAvailable.map(a => {
                                        const sel = selectedNewAddons.includes(a.key);
                                        return (
                                            <div key={a.key} className={`svc-card svc-card--contract ${sel ? 'svc-card--selected' : ''}`} onClick={() => setSelectedNewAddons(p => p.includes(a.key) ? p.filter(k => k !== a.key) : [...p, a.key])}>
                                                <div className="svc-card__header">
                                                    <div className="svc-card__icon">{ADDON_ICONS[a.key] || '✨'}</div>
                                                    <div className="svc-card__info"><p className="svc-card__name">{a.name}</p>{a.description && <p className="svc-card__desc">{a.description}</p>}</div>
                                                    <div className="svc-card__check"><Check size={14} /></div>
                                                </div>
                                                <div className="svc-card__footer"><span className="svc-card__contract-badge">Incluso no plano</span></div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </>
                        )}
                        {availableForPurchase.length > 0 && (
                            <>
                                <p className="svc-catalog__group-title">Serviços avulsos</p>
                                <div className="svc-catalog__list">
                                    {availableForPurchase.map(a => {
                                        const sel = selectedNewAddons.includes(a.key);
                                        const finalPrice = Math.round(a.price * (1 - discountPct / 100));
                                        return (
                                            <div key={a.key} className={`svc-card ${sel ? 'svc-card--selected' : ''}`} onClick={() => setSelectedNewAddons(p => p.includes(a.key) ? p.filter(k => k !== a.key) : [...p, a.key])}>
                                                <div className="svc-card__header">
                                                    <div className="svc-card__icon">{ADDON_ICONS[a.key] || '✨'}</div>
                                                    <div className="svc-card__info"><p className="svc-card__name">{a.name}</p>{a.description && <p className="svc-card__desc">{a.description}</p>}</div>
                                                    <div className="svc-card__check"><Check size={14} /></div>
                                                </div>
                                                <div className="svc-card__footer">
                                                    <div className="svc-card__price">
                                                        {discountPct > 0 && <span className="svc-card__price-original">{formatBRL(a.price)}</span>}
                                                        <span className="svc-card__price-final">{formatBRL(finalPrice)}</span>
                                                        {discountPct > 0 && <span className="svc-card__price-discount">{discountPct}% desc.</span>}
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </>
                        )}
                        {selectedNewAddons.length > 0 && (
                            <div className="svc-catalog__cta">
                                <button key="svc-next" type="button" className="btn btn-primary" onClick={ignoreMultiClick(() => setTimeout(() => setServicesStep(2), 0))}>Continuar ({selectedNewAddons.length})</button>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="svc-summary">
                        <div className="svc-summary__list">
                            {selectedNewAddons.map(key => {
                                const a = episodeAddons.find(x => x.key === key); if (!a) return null;
                                const isContract = ctrAddOns.includes(key);
                                const finalPrice = isContract ? 0 : Math.round(a.price * (1 - discountPct / 100));
                                return (
                                    <div key={key} className="svc-summary__item">
                                        <span className="svc-summary__item-name">{ADDON_ICONS[key] || '✨'} {a.name}</span>
                                        <span className={`svc-summary__item-price ${isContract ? 'svc-summary__item-price--free' : ''}`}>{isContract ? 'Incluso' : formatBRL(finalPrice)}</span>
                                    </div>
                                );
                            })}
                        </div>
                        {totalPaid > 0 && (
                            <div className="svc-summary__total"><span className="svc-summary__total-label">Total a pagar</span><span className="svc-summary__total-value">{formatBRL(totalPaid)}</span></div>
                        )}
                        <div className="svc-summary__actions">
                            <button key="svc-confirm" type="button" className="btn btn-primary" onClick={ignoreMultiClick(handleConfirmAddons)} disabled={saving}>{saving ? 'Processando...' : totalPaid > 0 ? `Pagar ${formatBRL(totalPaid)}` : 'Confirmar Ativação'}</button>
                            <button key="svc-back" type="button" className="btn btn-secondary" onClick={() => setServicesStep(1)}><ChevronLeft size={16} /> Voltar</button>
                        </div>
                    </div>
                )}
            </BottomSheetModal>

            {/* Payment */}
            {payingAddon && (
                <PaymentModal
                    title="Pagar Serviço"
                    amount={payingAddon.amount}
                    paymentId={payingAddon.paymentId}
                    description={payingAddon.description}
                    allowedMethods={['CARTAO', 'PIX']}
                    // E3: serviço extra de uma gravação não é fatura de contrato — nunca oferece boleto.
                    offerBoleto={false}
                    onSuccess={() => { setLocalAddOns(prev => [...prev, ...payingAddon.addonKeys]); setPayingAddon(null); showToast('Serviço pago e ativado!'); onSaved(); }}
                    onError={(msg) => showAlert({ message: msg, type: 'error' })}
                    onClose={() => { setPayingAddon(null); showToast('Pagamento não concluído. O serviço só ativa após o pagamento.'); }}
                />
            )}
        </>
    );
}
