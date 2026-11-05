// ─── Remarcação do avulso (D4/D5) ──────────────────────────
// • MakeupRescheduleModal (default): sheet de ETAPA ÚNICA — escolhe um dia do prazo (só os da faixa
//   da reserva) e um horário livre da MESMA faixa (tierApplied, regra estrita do backend) e chama
//   PATCH /bookings/:id/makeup. Reaproveita a mesma reserva e o mesmo pagamento (sem nova cobrança).
//   variant 'admin' (Hoje, Detalhe do Contrato, Agendamentos) ou 'client' (BookingDetailModal).
//   Trava por requisição em voo (estado + ref, nunca tempo); 400/409 aparecem dentro do sheet.
// • MakeupStatusPanel: bloco/chips de status da remarcação no admin com as ações "Justificar falta"
//   (PATCH { noShowJustified: true }) e "Remarcar" (abre o sheet acima).
import { useState, useEffect, useMemo, useRef, useId } from 'react';
import { CalendarClock, CalendarCheck, CalendarX, ShieldCheck, AlertTriangle, RefreshCw } from 'lucide-react';
import BottomSheetModal from '../../BottomSheetModal';
import BrandLoader from '../../ui/BrandLoader';
import { bookingsApi, ApiError, type Booking, type MakeupStatus, type Slot } from '../../../api/client';
import { useBusinessConfig } from '../../../hooks/useBusinessConfig';
import { useUI } from '../../../context/UIContext';
import { TIER_META, getMeta } from '../../../constants/adminMeta';
import { DAY_NAMES, DAY_NAMES_FULL } from '../../../utils/format';
import { studioSlotDate } from '../../../utils/time';
import { getErrorMessage } from '../../../utils/errors';
import {
    spYmd, calendarYmd, addDaysYmd, ddmmOfYmd, dowOfYmd, makeupLastYmd, allowedDaysForTier,
    describeMakeupForAdmin, previewMakeupWindow, type MakeupTone,
} from '../../../utils/avulsoMakeup';
import { useBookingPermissions } from './bookingPermissions';
import '../../../styles/makeup.css';

/** Campos da reserva que o sheet usa (Booking, BookingWithUser e o item de ContractDetail servem). */
export interface MakeupBooking {
    id: string;
    date: string;
    startTime: string;
    endTime?: string;
    status: string;
    tierApplied: string;
    makeupStatus?: MakeupStatus | string | null;
    makeupDeadline?: string | null;
    missedDate?: string | null;
}

interface MakeupRescheduleModalProps {
    isOpen: boolean;
    booking: MakeupBooking | null;
    /** 'admin': sem antecedência mínima (só não pode ser no passado) e, no NAO_REALIZADO, sem teto de data (D5). */
    variant?: 'admin' | 'client';
    /** Nome do cliente (cabeçalho do admin). */
    clientName?: string;
    zIndex?: number;
    onClose: () => void;
    /** Só quando a remarcação foi GRAVADA (o fluxo terminou). */
    onDone: (res: { booking: Booking; message: string }) => void;
}

/** Horizonte de dias oferecidos quando não há teto (admin remarcando um "Não realizado"). */
const OVERRIDE_HORIZON_DAYS = 21;

type SlotState = 'ok' | 'taken' | 'soon';

function durationMinutes(start: string, end?: string): number {
    if (!end) return 120;
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const d = (eh * 60 + em) - (sh * 60 + sm);
    return d > 0 ? d : 120;
}

function addMinutes(time: string, minutes: number): string {
    const [h, m] = time.split(':').map(Number);
    const t = h * 60 + m + minutes;
    return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

export default function MakeupRescheduleModal({
    isOpen, booking, variant = 'admin', clientName, zIndex, onClose, onDone,
}: MakeupRescheduleModalProps) {
    const uid = useId();
    const { get: getRule, getString } = useBusinessConfig();
    const isAdmin = variant === 'admin';
    const minAdvanceH = isAdmin ? 0 : getRule('booking_min_advance_hours');
    // D5: o admin remarca um "Não realizado" mesmo sem janela / depois do prazo e sem o teto D+N.
    const adminOverride = isAdmin && booking?.status === 'NAO_REALIZADO';
    const lastYmd = booking?.makeupDeadline && !adminOverride ? makeupLastYmd(booking.makeupDeadline) : null;
    const tier = booking?.tierApplied ?? '';
    const tierLabel = getMeta(TIER_META, tier).label;

    const [openedAt, setOpenedAt] = useState(() => Date.now());
    const [date, setDate] = useState('');
    const [time, setTime] = useState('');
    const [error, setError] = useState('');
    const [otherDraft, setOtherDraft] = useState('');
    const [otherDateError, setOtherDateError] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [done, setDone] = useState(false);
    const inFlight = useRef(false);

    const [avail, setAvail] = useState<{ date: string; closed: boolean; slots: Slot[] } | null>(null);
    const [loadingSlots, setLoadingSlots] = useState(false);
    const [slotsError, setSlotsError] = useState('');
    const [reloadKey, setReloadKey] = useState(0);
    const reqSeq = useRef(0);

    // Cada abertura começa limpa (e recalcula "hoje"/antecedência a partir de agora).
    useEffect(() => {
        if (!isOpen) return;
        setOpenedAt(Date.now());
        setDate(''); setTime(''); setError(''); setDone(false);
        setAvail(null); setSlotsError(''); setOtherDateError(''); setOtherDraft('');
    }, [isOpen, booking?.id]);

    // Dias oferecidos: do 1º dia possível (hoje, ou hoje + antecedência do cliente) até o último dia
    // da janela — só os dias da semana em que a faixa grava (sábado ↔ SABADO; seg–sex ↔ demais).
    const operatingDays = getString('operating_days', '1,2,3,4,5,6');
    const allowedDows = useMemo(() => allowedDaysForTier(tier, operatingDays), [tier, operatingDays]);
    const firstYmd = spYmd(openedAt + minAdvanceH * 3_600_000);
    const days = useMemo(() => {
        if (!booking) return [] as string[];
        if (!adminOverride && !lastYmd) return [];
        const endYmd = lastYmd ?? addDaysYmd(firstYmd, OVERRIDE_HORIZON_DAYS - 1);
        const out: string[] = [];
        for (let d = firstYmd, i = 0; d <= endYmd && i < 62; d = addDaysYmd(d, 1), i++) {
            if (allowedDows.includes(dowOfYmd(d))) out.push(d);
        }
        return out;
    }, [booking, adminOverride, lastYmd, firstYmd, allowedDows]);

    // Admin + "Não realizado" (D5) não tem teto: além dos próximos dias, aceita "Outra data" qualquer
    // (a partir de hoje, num dia em que a faixa grava).
    const isOtherDateOk = (d: string) => adminOverride && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= firstYmd && allowedDows.includes(dowOfYmd(d));
    const effectiveDate = date && (days.includes(date) || isOtherDateOk(date)) ? date : (days[0] ?? '');
    const tierDaysText = tier === 'SABADO' ? 'só aos sábados' : 'de segunda a sexta';
    const pickOtherDate = (v: string) => {
        setOtherDraft(v);
        setError('');
        if (!v) { setOtherDateError(''); return; }
        // Digitando o ano (0002, 0020, 0202…): ainda não valida nem troca a data.
        if (v.slice(0, 4) < firstYmd.slice(0, 4)) { setOtherDateError(''); return; }
        if (v < firstYmd) { setOtherDateError('Escolha uma data a partir de hoje.'); return; }
        if (!allowedDows.includes(dowOfYmd(v))) { setOtherDateError(`A faixa ${tierLabel} grava ${tierDaysText}. Escolha outro dia.`); return; }
        setOtherDateError('');
        setDate(v);
        setTime('');
    };

    useEffect(() => {
        if (!isOpen || !effectiveDate) return;
        const seq = ++reqSeq.current;
        setLoadingSlots(true);
        setSlotsError('');
        bookingsApi.getAvailability(effectiveDate)
            .then(r => { if (seq === reqSeq.current) setAvail({ date: effectiveDate, closed: r.closed, slots: r.slots }); })
            .catch(err => {
                if (seq !== reqSeq.current) return;
                setAvail(null);
                setSlotsError(getErrorMessage(err) || 'Não foi possível carregar os horários.');
            })
            .finally(() => { if (seq === reqSeq.current) setLoadingSlots(false); });
    }, [isOpen, effectiveDate, reloadKey]);

    const dur = booking ? durationMinutes(booking.startTime, booking.endTime) : 120;
    const slotView = useMemo(() => {
        if (!avail || avail.date !== effectiveDate || avail.closed) return [];
        const minStart = Date.now() + minAdvanceH * 3_600_000;
        return avail.slots
            .filter(s => s.tier === tier)
            .map(s => {
                const start = studioSlotDate(effectiveDate, s.time).getTime();
                const tooSoon = isAdmin ? start <= Date.now() : start < minStart;
                const state: SlotState = !s.available ? 'taken' : tooSoon ? 'soon' : 'ok';
                return { time: s.time, end: addMinutes(s.time, dur), state };
            });
    }, [avail, effectiveDate, tier, isAdmin, minAdvanceH, dur]);

    const effectiveTime = slotView.some(v => v.time === time && v.state === 'ok') ? time : '';
    const busy = submitting || done;

    const handleSubmit = async () => {
        if (!booking || !effectiveDate || !effectiveTime || inFlight.current || done) return;
        inFlight.current = true;
        setSubmitting(true);
        // O erro anterior só é trocado pelo resultado (sem "piscar" e deslocar o rodapé durante o envio).
        try {
            const res = await bookingsApi.makeup(booking.id, { date: effectiveDate, startTime: effectiveTime });
            setDone(true);
            onDone(res);
        } catch (err: unknown) {
            const msg = getErrorMessage(err) || 'Não foi possível remarcar a gravação.';
            // 409: o horário foi ocupado/travado por outra pessoa → recarrega o dia e limpa a escolha.
            if (err instanceof ApiError && err.status === 409) {
                setError(`${msg} Escolha outro horário.`);
                setTime('');
                setReloadKey(k => k + 1);
            } else {
                setError(msg);
            }
        } finally {
            inFlight.current = false;
            setSubmitting(false);
        }
    };

    if (!isOpen || !booking) return null;

    const missedYmd = calendarYmd(booking.date);
    const missedLabel = `${DAY_NAMES[dowOfYmd(missedYmd)]}, ${ddmmOfYmd(missedYmd)} às ${booking.startTime}`;
    const statusText = booking.status === 'NAO_REALIZADO' ? 'não realizada pelo estúdio'
        : booking.makeupStatus ? 'falta justificada' : 'falta';
    const submitLabel = effectiveTime
        ? `Remarcar para ${ddmmOfYmd(effectiveDate)} às ${effectiveTime}`
        : 'Remarcar';

    const body = (
        <div className="mkp-sheet">
            {error && <div className="admin-alert admin-alert--danger" role="alert" style={{ marginBottom: 0 }}>{error}</div>}

            <div className="mkp-summary">
                <span>Gravação perdida: <strong>{missedLabel}</strong> · {statusText}</span>
                <span>Faixa: <strong>{tierLabel}</strong> — a nova data precisa ser na mesma faixa.</span>
                {lastYmd ? (
                    <span>Prazo: nova data até <strong>{ddmmOfYmd(lastYmd)}</strong>.</span>
                ) : adminOverride ? (
                    <span>Sem limite de data: a gravação não foi realizada pelo estúdio e o cliente não perde o valor.</span>
                ) : null}
                <span className="mkp-summary__note">
                    Sem novo pagamento: a mesma reserva e o mesmo pagamento são reaproveitados. A remarcação é única.
                    {!isAdmin && minAdvanceH > 0 ? ` Horários com pelo menos ${minAdvanceH}h de antecedência.` : ''}
                </span>
            </div>

            <div>
                <span className="mkp-label" id={`${uid}-days`}>Nova data</span>
                {days.length === 0 ? (
                    <div className="mkp-state" role="status">
                        <CalendarX size={20} aria-hidden="true" />
                        {lastYmd
                            ? `Não há mais dias da faixa ${tierLabel} disponíveis até ${ddmmOfYmd(lastYmd)}.`
                            : adminOverride
                                ? `A faixa ${tierLabel} não tem dia de funcionamento nos próximos dias.`
                                : 'O prazo desta remarcação já terminou.'}
                    </div>
                ) : (
                    <div className="mkp-days" role="group" aria-labelledby={`${uid}-days`}>
                        {days.map(d => {
                            const dow = dowOfYmd(d);
                            const selected = d === effectiveDate;
                            return (
                                <button
                                    key={d}
                                    type="button"
                                    className={`mkp-day${selected ? ' mkp-day--selected' : ''}`}
                                    aria-pressed={selected}
                                    aria-label={`${DAY_NAMES_FULL[dow]}, ${ddmmOfYmd(d)}`}
                                    disabled={busy}
                                    onClick={() => { if (!selected) { setDate(d); setTime(''); setError(''); setOtherDateError(''); setOtherDraft(''); } }}
                                >
                                    <span className="mkp-day__dow" aria-hidden="true">{DAY_NAMES[dow]}</span>
                                    <span className="mkp-day__date" aria-hidden="true">{ddmmOfYmd(d)}</span>
                                </button>
                            );
                        })}
                    </div>
                )}
                {adminOverride && (
                    <div className="mkp-other-date">
                        <label htmlFor={`${uid}-other`}>Outra data</label>
                        <input
                            id={`${uid}-other`}
                            type="date"
                            className="form-input form-input--raised"
                            min={firstYmd}
                            value={otherDraft}
                            onChange={e => pickOtherDate(e.target.value)}
                            disabled={busy}
                            aria-invalid={otherDateError ? true : undefined}
                            aria-describedby={`${uid}-other-hint`}
                        />
                        <span id={`${uid}-other-hint`} className={`mkp-other-date__hint${otherDateError ? ' mkp-other-date__hint--error' : ''}`} role={otherDateError ? 'alert' : undefined}>
                            {otherDateError || `Sem limite de data · faixa ${tierLabel} grava ${tierDaysText}.`}
                        </span>
                    </div>
                )}
            </div>

            {!!effectiveDate && (
                <div>
                    <span className="mkp-label" id={`${uid}-slots`}>Horário · {tierLabel}</span>
                    <div className="mkp-slots-area" aria-live="polite" aria-busy={loadingSlots || undefined}>
                        {loadingSlots ? (
                            // role="status" fica no próprio BrandLoader.
                            <div className="mkp-state">
                                <BrandLoader size="inline" label="Carregando horários…" />
                            </div>
                        ) : slotsError ? (
                            <div className="mkp-state mkp-state--error" role="alert">
                                <AlertTriangle size={20} aria-hidden="true" />
                                {slotsError}
                                <button type="button" className="btn-admin-ghost btn-admin-ghost--compact" onClick={() => setReloadKey(k => k + 1)}>
                                    <RefreshCw size={14} aria-hidden="true" /> Tentar novamente
                                </button>
                            </div>
                        ) : avail?.closed ? (
                            <div className="mkp-state">O estúdio não abre neste dia. Escolha outra data.</div>
                        ) : slotView.length === 0 ? (
                            <div className="mkp-state">Nenhum horário da faixa {tierLabel} neste dia. Escolha outra data.</div>
                        ) : (
                            <div className="mkp-slots" role="group" aria-labelledby={`${uid}-slots`}>
                                {slotView.map(v => {
                                    const selected = v.time === effectiveTime;
                                    const stateText = v.state === 'ok' ? (selected ? 'Selecionado' : 'Livre')
                                        : v.state === 'taken' ? 'Ocupado' : (isAdmin ? 'Já passou' : 'Indisponível');
                                    return (
                                        <button
                                            key={v.time}
                                            type="button"
                                            className={`mkp-slot${selected ? ' mkp-slot--selected' : ''}`}
                                            aria-pressed={selected}
                                            aria-label={`${v.time} às ${v.end} — ${stateText}`}
                                            disabled={v.state !== 'ok' || busy}
                                            // Não limpa o erro aqui: sumir com a faixa de erro encolhe o
                                            // card e desloca o rodapé entre o clique no horário e o "Remarcar".
                                            onClick={() => setTime(v.time)}
                                        >
                                            <span className="mkp-slot__range" aria-hidden="true">{v.time}–{v.end}</span>
                                            <span className="mkp-slot__state" aria-hidden="true">{stateText}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {isAdmin ? (
                <div className="admin-actions-row" style={{ marginTop: 0 }}>
                    <button key="cancel" type="button" className="btn-admin-ghost" onClick={onClose} disabled={submitting}>Cancelar</button>
                    <button key="submit" type="button" className="btn-admin-go" onClick={handleSubmit}
                        disabled={!effectiveTime || busy} aria-busy={submitting || undefined}>
                        {submitting ? 'Remarcando…' : <><CalendarCheck size={15} aria-hidden="true" /> {submitLabel}</>}
                    </button>
                </div>
            ) : (
                <div className="mkp-footer">
                    <button key="cancel" type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancelar</button>
                    <button key="submit" type="button" className="btn btn-primary" onClick={handleSubmit}
                        disabled={!effectiveTime || busy} aria-busy={submitting || undefined}>
                        {submitting ? 'Remarcando…' : <><CalendarCheck size={15} aria-hidden="true" /> {submitLabel}</>}
                    </button>
                </div>
            )}
        </div>
    );

    return (
        <BottomSheetModal
            isOpen
            onClose={onClose}
            title="Remarcar gravação"
            hideHeader={isAdmin}
            size="sm"
            className={isAdmin ? 'admin-sheet' : undefined}
            preventClose={submitting}
            zIndex={zIndex}
        >
            {isAdmin ? (
                <>
                    <div className="admin-modal-head">
                        <h2 className="admin-modal-title">
                            <span className="admin-modal-title__icon"><CalendarClock size={16} aria-hidden="true" /></span>
                            Remarcar gravação
                        </h2>
                        {clientName && <p style={{ margin: '6px 0 0', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>{clientName}</p>}
                    </div>
                    <div className="admin-modal-body">{body}</div>
                </>
            ) : body}
        </BottomSheetModal>
    );
}

// ─── Bloco / chips de status da remarcação (admin) ─────────

const TONE_ICON: Record<MakeupTone, typeof CalendarClock> = {
    warning: CalendarClock,
    danger: AlertTriangle,
    info: CalendarCheck,
    muted: CalendarX,
};

interface MakeupStatusPanelProps {
    booking: MakeupBooking & { contract?: { type?: string | null } | null };
    /** Tipo do contrato quando a reserva não traz `contract` (ex.: Detalhe do Contrato). */
    contractType?: string | null;
    clientName?: string;
    /** 'block' = bloco com explicação e botões (Hoje, Detalhe do Contrato); 'chips' = compacto (tabela). */
    layout?: 'block' | 'chips';
    /** Depois de justificar/remarcar com sucesso — o pai recarrega os dados. */
    onChanged: () => void;
}

export function MakeupStatusPanel({ booking, contractType, clientName, layout = 'block', onChanged }: MakeupStatusPanelProps) {
    const { get: getRule } = useBusinessConfig();
    const { showConfirm, showToast } = useUI();
    const [rescheduling, setRescheduling] = useState(false);
    // Justificar falta e remarcar o avulso perdido exigem agendamentos.faltas (PATCH noShowJustified e
    // PATCH /makeup). Sem a permissão, o status da remarcação continua visível, mas sem as ações.
    const { canFaltas } = useBookingPermissions();

    const makeupDays = getRule('avulso_makeup_days');
    const described = describeMakeupForAdmin(booking, { contractType: contractType ?? booking.contract?.type, makeupDays });
    if (!described) return null;
    // Sem a permissão, o chip mostra a descrição ("Falta sem justificativa"), não o verbo da ação.
    const hadAction = described.canJustify || described.canReschedule;
    const view = canFaltas ? described
        : { ...described, canJustify: false, canReschedule: false, short: hadAction ? described.label : described.short };

    const who = clientName || 'O cliente';
    const justify = () => {
        const preview = previewMakeupWindow(booking.date, makeupDays);
        showConfirm({
            tone: 'warning',
            icon: ShieldCheck,
            title: 'Justificar falta?',
            message: `${who} poderá remarcar esta gravação uma única vez, sem novo pagamento, para uma data até ${preview.ddmm} (fim do dia).`,
            consequences: [
                'O cliente recebe um aviso agora e lembretes nos 2 últimos dias.',
                `Se não remarcar até ${preview.ddmm}, o valor é perdido e o contrato avulso fica Concluído.`,
                'A falta continua registrada no histórico (motivo e data).',
            ],
            confirmLabel: 'Justificar falta',
            loadingLabel: 'Justificando…',
            // Com tone o diálogo aguarda e mostra o erro (400) dentro dele — não capturar aqui.
            onConfirm: async () => {
                await bookingsApi.update(booking.id, { noShowJustified: true });
                showToast(`Falta justificada — remarcação liberada até ${preview.ddmm}.`);
                onChanged();
            },
        });
    };

    const sheet = (
        <MakeupRescheduleModal
            isOpen={rescheduling}
            booking={booking}
            variant="admin"
            clientName={clientName}
            onClose={() => setRescheduling(false)}
            onDone={(res) => { setRescheduling(false); showToast(res.message); onChanged(); }}
        />
    );

    const rescheduleLabel = view.lastDdmm && booking.makeupStatus === 'OPEN' && view.tone === 'warning'
        ? `Remarcar até ${view.lastDdmm}` : 'Remarcar';

    if (layout === 'chips') {
        return (
            <span className="mkp-chips">
                {view.canReschedule ? (
                    <button type="button" className={`mkp-chip mkp-chip--${view.tone}`} onClick={() => setRescheduling(true)}
                        aria-label={`${view.label}. Remarcar a gravação${clientName ? ` de ${clientName}` : ''}`}>
                        <CalendarClock size={12} aria-hidden="true" /> {view.short}
                    </button>
                ) : view.canJustify ? (
                    <button type="button" className="mkp-chip mkp-chip--danger" onClick={justify}
                        aria-label={`Falta sem justificativa. Justificar a falta${clientName ? ` de ${clientName}` : ''} até ${view.lastDdmm}`}>
                        <ShieldCheck size={12} aria-hidden="true" /> {view.short}
                    </button>
                ) : (
                    <span className={`mkp-chip mkp-chip--${view.tone}`}>{view.short}</span>
                )}
                {sheet}
            </span>
        );
    }

    const Icon = TONE_ICON[view.tone];
    return (
        <div className={`mkp-block mkp-block--${view.tone}`}>
            <div className="mkp-block__head"><Icon size={14} aria-hidden="true" /> {view.label}</div>
            <p className="mkp-block__desc">{view.description}</p>
            {(view.canJustify || view.canReschedule) && (
                <div className="mkp-block__actions">
                    {view.canJustify && (
                        <button type="button" className="today-action-btn today-action-btn--info" onClick={justify}>
                            <ShieldCheck size={14} aria-hidden="true" /> Justificar falta
                        </button>
                    )}
                    {view.canReschedule && (
                        <button type="button" className="today-action-btn today-action-btn--success" onClick={() => setRescheduling(true)}>
                            <CalendarClock size={14} aria-hidden="true" /> {rescheduleLabel}
                        </button>
                    )}
                </div>
            )}
            {sheet}
        </div>
    );
}
