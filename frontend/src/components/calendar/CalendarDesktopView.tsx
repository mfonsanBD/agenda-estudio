import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Slot, MyBookingSlot } from '../../api/client';
import { studioSlotDate } from '../../utils/time';
import HoldCountdownCell from './HoldCountdownCell';
import Tooltip from '../ui/Tooltip';
import BrandLoader from '../ui/BrandLoader';
import { DAYS, GRID_ROWS, TIER_COLORS, formatDate, formatDateShort, BookingLookup } from './calendarShared';

/**
 * Visão DESKTOP da agenda (grade semanal Seg–Sáb, compartilhada admin+cliente).
 * Extraída verbatim de CalendarPage.tsx (R4 L2) — o pai continua dono do estado.
 */
interface CalendarDesktopViewProps {
    /** Modo equipe (ADMIN ou COLABORADOR): grade do estúdio, sem antecedência mínima. */
    isAdmin: boolean;
    /**
     * Clicar num horário livre agenda (cliente: autoatendimento; equipe: "Novo agendamento", só com
     * agendamentos.criar). false → os horários livres aparecem, mas não são clicáveis. Padrão true.
     */
    canCreate?: boolean;
    userFirstName: string;
    minAdvanceHours: number;
    loading: boolean;
    weekDates: Date[];
    displayMonth: string;
    today: string;
    slotsMap: Record<string, Slot[]>;
    buildBookingLookup: (date: string) => BookingLookup;
    onSlotClick: (date: string, time: string, slot: Slot, info?: { isMine: boolean; myBooking?: MyBookingSlot }) => void;
    onPastSlot: () => void;
    onHoldExpire: () => void;
    goToday: () => void;
    navigateWeek: (direction: number) => void;
}

export default function CalendarDesktopView({
    isAdmin, canCreate = true, userFirstName, minAdvanceHours, loading,
    weekDates, displayMonth, today, slotsMap,
    buildBookingLookup, onSlotClick, onPastSlot, onHoldExpire,
    goToday, navigateWeek,
}: CalendarDesktopViewProps) {
    return (
        <div className="calendar-container" style={{ borderRadius: '16px', overflow: 'hidden' }}>
            {/* Navigation Bar */}
            <div className="calendar-header calendar-toolbar">
                <button className="btn btn-ghost calendar-toolbar__today" onClick={goToday}>
                    Hoje
                </button>
                <div className="calendar-toolbar__nav-group">
                    <Tooltip content="Semana anterior" describe={false}>
                        <button type="button" className="calendar-toolbar__nav" aria-label="Semana anterior" onClick={() => navigateWeek(-1)}><ChevronLeft size={18} aria-hidden="true" /></button>
                    </Tooltip>

                    <div className="calendar-toolbar__range">
                        <div className="calendar-toolbar__range-dates">
                            {weekDates.length > 0 && `${formatDateShort(weekDates[0])} — ${formatDateShort(weekDates[5])}`}
                        </div>
                        <div className="calendar-toolbar__range-month">{displayMonth}</div>
                    </div>

                    <Tooltip content="Próxima semana" describe={false}>
                        <button type="button" className="calendar-toolbar__nav" aria-label="Próxima semana" onClick={() => navigateWeek(1)}><ChevronRight size={18} aria-hidden="true" /></button>
                    </Tooltip>
                </div>
                {/* Spacer to balance */}
                <div className="calendar-toolbar__spacer" />
            </div>

            {loading ? (
                <BrandLoader size="section" label="Carregando a agenda…" />
            ) : (
                <div className="calendar-grid calendar-grid--scroll">
                    <div className="calendar-day-header calendar-day-header--sticky"></div>
                    {weekDates.map((d, i) => (
                        <div key={formatDate(d)} className={`calendar-day-header calendar-day-header--sticky ${formatDate(d) === today ? 'today' : ''}`}>
                            <span className="calendar-day-header__dow">{DAYS[i]}</span>
                            <br />
                            <span className="calendar-day-header__num">{d.getDate()}</span>
                        </div>
                    ))}

                    {GRID_ROWS.map(row => (
                        <React.Fragment key={row.id}>
                            <div className={`calendar-time-label calendar-time-cell${row.type === 'TRANSITION' ? ' calendar-time-cell--ghost' : ''}`}
                                style={{ height: row.height }}>
                                {row.type === 'SLOT' && (
                                    <>
                                        <span className="calendar-time-cell__start">{row.time}</span>
                                        <span className="calendar-time-cell__end">até {row.timeEnd}</span>
                                    </>
                                )}
                            </div>
                            {weekDates.map((d) => {
                                const dateStr = formatDate(d);

                                if (row.type === 'TRANSITION') {
                                    return (
                                        <div key={`${dateStr}-${row.id}`} className="calendar-cell--break"
                                            style={{ height: row.height }}
                                            title={`${row.time} - ${row.timeEnd}: ${row.label}`}>
                                        </div>
                                    );
                                }

                                const slots = slotsMap[dateStr] || [];
                                const slot = slots.find(s => s.time === row.time);
                                const isAvailable = slot?.available && slot?.tier;
                                const lookup = buildBookingLookup(dateStr);
                                const info = lookup[row.time];

                                if (info) {
                                    // Check if this is an avulso booking with active hold timer
                                    const hasActiveHold = info.isMine && info.myBooking?.holdExpiresAt
                                        && new Date(info.myBooking.holdExpiresAt).getTime() > Date.now();

                                    if (hasActiveHold && info.myBooking) {
                                        return (
                                            <HoldCountdownCell
                                                key={`${dateStr}-${row.id}`}
                                                expiresAt={info.myBooking.holdExpiresAt!}
                                                label={userFirstName}
                                                tier={info.tier}
                                                rowLabel={row.label}
                                                onExpire={onHoldExpire}
                                                onClick={() => slot && onSlotClick(dateStr, row.time, slot, info)}
                                            />
                                        );
                                    }

                                    return (
                                        <div
                                            key={`${dateStr}-${row.id}`}
                                            className={`calendar-cell occupied${info.isMine ? ' calendar-cell--mine' : ''}`}
                                            onClick={() => slot && onSlotClick(dateStr, row.time, slot, info)}
                                            style={{ height: row.height, padding: '4px' }}
                                        >
                                            <div className={`calendar-slot calendar-slot--fill tier-${info.tier}`}>
                                                <div>{info.label}</div>
                                                <div className="calendar-slot__sub">{row.label}</div>
                                            </div>
                                        </div>
                                    );
                                }

                                const slotNotAvailable = slot && !slot.available;
                                const slotDateTime = studioSlotDate(dateStr, row.time);
                                // Clients need the minimum advance notice; admin can book any time (0).
                                const minAheadMinutes = isAdmin ? 0 : minAdvanceHours * 60;
                                const isPast = (slotDateTime.getTime() - Date.now()) / (1000 * 60) < minAheadMinutes;

                                const tierKey = slot?.tier?.toLowerCase() || '';
                                const tierMeta = TIER_COLORS[tierKey];

                                return (
                                    <div
                                        key={`${dateStr}-${row.id}`}
                                        className={`calendar-cell ${(slotNotAvailable || isPast) ? 'occupied' : ''}${isPast ? ' calendar-cell--past' : ''}${!slot?.tier ? ' calendar-cell--void' : ''}`}
                                        onClick={() => {
                                            if (!canCreate) return;
                                            if (isPast) {
                                                onPastSlot();
                                                return;
                                            }
                                            if (slot && isAvailable) onSlotClick(dateStr, row.time, slot);
                                        }}
                                        title={!slot?.tier ? 'Fora da Grade' : isPast ? 'Encerrado — horário já passou' : `${tierMeta?.label || ''} — ${row.label}`}
                                        style={{
                                            height: row.height, padding: '4px',
                                            background: (isAvailable && !isPast && tierMeta)
                                                ? tierMeta.bg
                                                : undefined,
                                            borderLeft: (isAvailable && !isPast && tierMeta)
                                                ? `3px solid ${tierMeta.color}`
                                                : undefined,
                                            cursor: !canCreate ? 'default' : (isAvailable && !isPast) ? 'pointer' : isPast ? 'not-allowed' : 'default',
                                            transition: 'background 0.2s',
                                        }}
                                    >
                                        {(slotNotAvailable || isPast) && !info ? (
                                            isPast ? (
                                                <div className="calendar-slot calendar-slot--fill calendar-slot--off">
                                                    Encerrado
                                                </div>
                                            ) : (
                                                <div className={`calendar-slot calendar-slot--fill tier-${slot?.tier?.toLowerCase() || 'blocked'}`}>
                                                    Ocupado
                                                </div>
                                            )
                                        ) : (
                                            (isAvailable && !isPast && !info) && (
                                                <div className="calendar-cell__free">
                                                    <span className="calendar-cell__free-title" style={{ color: tierMeta?.color || 'var(--text-primary)' }}>
                                                        Disponível
                                                    </span>
                                                    {tierMeta && (
                                                        <span className="calendar-cell__free-tier" style={{ color: tierMeta.color }}>
                                                            {tierMeta.label}
                                                        </span>
                                                    )}
                                                </div>
                                            )
                                        )}
                                    </div>
                                );
                            })}
                        </React.Fragment>
                    ))}
                </div>
            )}
        </div>
    );
}
