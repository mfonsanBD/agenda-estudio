import React, { useRef, useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import { Slot, MyBookingSlot } from '../../api/client';
import { studioSlotDate } from '../../utils/time';
import { DAYS, GRID_ROWS, TIER_COLORS, formatDate, BookingLookup } from './calendarShared';
import BrandLoader from '../ui/BrandLoader';

/**
 * Visão MOBILE da agenda (pills de dia com carrossel de semanas + lista de slots).
 * Extraída verbatim de CalendarPage.tsx (R4 L2) — o pai continua dono de todo o
 * estado; aqui vive só o DOM da view e a mecânica de drag do carrossel de pills.
 */
interface CalendarMobileViewProps {
    /** Modo equipe (ADMIN ou COLABORADOR): grade do estúdio, sem antecedência mínima. */
    isAdmin: boolean;
    /**
     * Tocar num horário livre agenda (cliente: autoatendimento; equipe: "Novo agendamento", só com
     * agendamentos.criar). false → os horários livres aparecem, mas não são clicáveis. Padrão true.
     */
    canCreate?: boolean;
    minAdvanceHours: number;
    loading: boolean;
    weekDates: Date[];
    prevWeekDates: Date[];
    nextWeekDates: Date[];
    selectedDayIndex: number;
    onSelectDay: (index: number) => void;
    navigateWeek: (direction: number) => void;
    goToday: () => void;
    today: string;
    displayMonth: string;
    slotsPhase: 'visible' | 'out' | 'out_done' | 'in';
    displayDateStr: string;
    selectedDateStr: string;
    slotsMap: Record<string, Slot[]>;
    buildBookingLookup: (date: string) => BookingLookup;
    onSlotClick: (date: string, time: string, slot: Slot, info?: { isMine: boolean; myBooking?: MyBookingSlot }) => void;
    onOpenDetail: (b: MyBookingSlot, date: string) => void;
    onPastSlot: () => void;
}

export default function CalendarMobileView({
    isAdmin, canCreate = true, minAdvanceHours, loading,
    weekDates, prevWeekDates, nextWeekDates,
    selectedDayIndex, onSelectDay, navigateWeek, goToday,
    today, displayMonth, slotsPhase, displayDateStr, selectedDateStr,
    slotsMap, buildBookingLookup, onSlotClick, onOpenDetail, onPastSlot,
}: CalendarMobileViewProps) {
    // ─── Pills carousel (3-panel: prev | current | next) ───
    const pillsCarouselRef = useRef<HTMLDivElement>(null);
    const pillsDragStartX = useRef(0);
    const pillsDragDelta = useRef(0);
    const pillsDragging = useRef(false);
    const pillsTransitioning = useRef(false);
    const pillsDragStartY = useRef(0);
    const pillsIsHorizontal = useRef<boolean | null>(null);

    const slotListRef = useRef<HTMLDivElement>(null);
    const swipeTouchStartX = useRef(0);
    const swipeTouchStartY = useRef(0);

    const setPillsTransform = (px: number, withTransition = false) => {
        const el = pillsCarouselRef.current;
        if (!el) return;
        el.style.transition = withTransition ? 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)' : 'none';
        el.style.transform = `translateX(calc(-33.333% + ${px}px))`;
    };

    const finishPillsSnap = (direction: number) => {
        pillsTransitioning.current = true;
        const el = pillsCarouselRef.current;
        // Animate to target panel
        if (direction === 0) {
            setPillsTransform(0, true); // snap back
        } else {
            // direction 1 = next (slide left to -200%), direction -1 = prev (slide right to 0%)
            if (el) {
                el.style.transition = 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)';
                el.style.transform = direction > 0 ? 'translateX(-66.666%)' : 'translateX(0%)';
            }
        }
        setTimeout(() => {
            pillsTransitioning.current = false;
            if (direction !== 0) {
                navigateWeek(direction);
                // Reset to center without animation
                requestAnimationFrame(() => {
                    if (el) {
                        el.style.transition = 'none';
                        el.style.transform = 'translateX(-33.333%)';
                    }
                });
            }
        }, 360);
    };

    const handlePillsDragStart = (clientX: number, clientY: number) => {
        if (pillsTransitioning.current) return;
        pillsDragging.current = true;
        pillsDragStartX.current = clientX;
        pillsDragStartY.current = clientY;
        pillsDragDelta.current = 0;
        pillsIsHorizontal.current = null;
    };
    const handlePillsDragMove = (clientX: number, clientY: number) => {
        if (!pillsDragging.current) return;
        const dx = clientX - pillsDragStartX.current;
        const dy = clientY - pillsDragStartY.current;
        // Lock direction on first significant move
        if (pillsIsHorizontal.current === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
            pillsIsHorizontal.current = Math.abs(dx) > Math.abs(dy);
        }
        if (pillsIsHorizontal.current === false) return; // vertical scroll, ignore
        if (pillsIsHorizontal.current === true) {
            // Prevent page scroll during horizontal drag
            pillsDragDelta.current = dx;
            setPillsTransform(dx);
        }
    };
    const handlePillsDragEnd = () => {
        if (!pillsDragging.current) return;
        pillsDragging.current = false;
        const dx = pillsDragDelta.current;
        const THRESHOLD = 60;
        if (dx < -THRESHOLD) {
            finishPillsSnap(1); // next week
        } else if (dx > THRESHOLD) {
            finishPillsSnap(-1); // prev week
        } else {
            finishPillsSnap(0); // snap back
        }
        pillsDragDelta.current = 0;
    };

    // Double-rAF ensures the carousel resets after React's DOM commit
    useEffect(() => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const el = pillsCarouselRef.current;
                if (el) {
                    el.style.transition = 'none';
                    el.style.transform = 'translateX(-33.333%)';
                }
            });
        });
    }, [weekDates]);

    return (
        <div className="calendar-mobile">
            {/* Month/Year Header + Today Button */}
            <div className="calendar-mobile-month">
                <span className="calendar-mobile-month__text">{displayMonth}</span>
                <button className="calendar-mobile-today-btn" onClick={goToday}>
                    Hoje
                </button>
            </div>

            {/* Day Picker Pills Carousel — drag to navigate weeks */}
            <div className="pills-carousel-viewport">
                <div
                    key={weekDates[0]?.getTime()}
                    ref={pillsCarouselRef}
                    className="pills-carousel-track"
                    style={{ transform: 'translateX(-33.333%)' }}
                    onTouchStart={(e) => handlePillsDragStart(e.touches[0].clientX, e.touches[0].clientY)}
                    onTouchMove={(e) => {
                        handlePillsDragMove(e.touches[0].clientX, e.touches[0].clientY);
                        if (pillsIsHorizontal.current === true) e.preventDefault();
                    }}
                    onTouchEnd={() => handlePillsDragEnd()}
                    onMouseDown={(e) => { handlePillsDragStart(e.clientX, e.clientY); e.preventDefault(); }}
                    onMouseMove={(e) => handlePillsDragMove(e.clientX, e.clientY)}
                    onMouseUp={() => handlePillsDragEnd()}
                    onMouseLeave={() => { if (pillsDragging.current) handlePillsDragEnd(); }}
                >
                    {/* Previous Week */}
                    <div className="pills-carousel-panel">
                        {prevWeekDates.map((d, i) => (
                            <div key={`prev-${i}`} className="calendar-day-pill">
                                <span className="calendar-day-pill-name">{DAYS[i]}</span>
                                <span className="calendar-day-pill-number">{d.getDate()}</span>
                            </div>
                        ))}
                    </div>
                    {/* Current Week */}
                    <div className="pills-carousel-panel">
                        {weekDates.map((d, i) => {
                            const isToday = formatDate(d) === today;
                            const isSelected = i === selectedDayIndex;
                            return (
                                <button
                                    key={formatDate(d)}
                                    className={`calendar-day-pill ${isSelected ? 'calendar-day-pill--selected' : ''} ${isToday ? 'calendar-day-pill--today' : ''}`}
                                    onClick={() => onSelectDay(i)}
                                >
                                    <span className="calendar-day-pill-name">{DAYS[i]}</span>
                                    <span className="calendar-day-pill-number">{d.getDate()}</span>
                                    {isToday && <span className="calendar-day-pill-dot" />}
                                </button>
                            );
                        })}
                    </div>
                    {/* Next Week */}
                    <div className="pills-carousel-panel">
                        {nextWeekDates.map((d, i) => (
                            <div key={`next-${i}`} className="calendar-day-pill">
                                <span className="calendar-day-pill-name">{DAYS[i]}</span>
                                <span className="calendar-day-pill-number">{d.getDate()}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>



            {/* Slot Cards — crossfade on date change */}
            {loading ? (
                <BrandLoader size="section" label="Carregando horários…" />
            ) : (
            <div className={`calendar-slots-crossfade slots-phase-${slotsPhase}`}>
                <div
                    ref={slotListRef}
                    className="calendar-mobile-slots"
                    onTouchStart={(e) => {
                        swipeTouchStartX.current = e.touches[0].clientX;
                        swipeTouchStartY.current = e.touches[0].clientY;
                    }}
                    onTouchEnd={(e) => {
                        const dx = e.changedTouches[0].clientX - swipeTouchStartX.current;
                        const dy = e.changedTouches[0].clientY - swipeTouchStartY.current;
                        // Only trigger if horizontal swipe dominates
                        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                            if (dx < 0) {
                                // Swipe left = next day / next week on last day
                                if (selectedDayIndex < 5) onSelectDay(selectedDayIndex + 1);
                                else navigateWeek(1);
                            } else {
                                // Swipe right = prev day / prev week on first day
                                if (selectedDayIndex > 0) onSelectDay(selectedDayIndex - 1);
                                else navigateWeek(-1);
                            }
                        }
                    }}
                >
                    {GRID_ROWS.filter(row => row.type !== 'TRANSITION').map(row => {
                        const slots = slotsMap[displayDateStr] || [];
                        const slot = slots.find(s => s.time === row.time);
                        const isAvailable = slot?.available && slot?.tier;
                        const lookup = buildBookingLookup(displayDateStr);
                        const info = lookup[row.time];
                        const slotDateTime = studioSlotDate(displayDateStr, row.time);
                        // Clients need the minimum advance notice; admin can book any time (0).
                        const minAheadMinutes = isAdmin ? 0 : minAdvanceHours * 60;
                        const isPast = (slotDateTime.getTime() - Date.now()) / (1000 * 60) < minAheadMinutes;
                        const tierKey = slot?.tier?.toLowerCase() || '';
                        const tierMeta = TIER_COLORS[tierKey];

                        // Hold countdown
                        const hasActiveHold = info?.isMine && info.myBooking?.holdExpiresAt
                            && new Date(info.myBooking.holdExpiresAt).getTime() > Date.now();
                        // Cinto de segurança: entre a expiração e o refetch reagendado, o
                        // lookup pode ainda trazer um hold caducado. NÃO renderizar como
                        // "Meu Agendamento" (verde/clicável) — o backend já liberou o slot.
                        const isLapsedHold = info?.isMine && info.myBooking?.status === 'RESERVED'
                            && info.myBooking.holdExpiresAt
                            && new Date(info.myBooking.holdExpiresAt).getTime() <= Date.now();

                        let statusLabel = '';
                        let statusColor = 'var(--text-muted)';
                        let cardBg = 'var(--bg-card)';
                        let borderColor = 'var(--border-subtle)';
                        let clickable = false;

                        if (hasActiveHold) {
                            statusLabel = 'Aguardando Pagamento';
                            statusColor = 'var(--warning)';
                            cardBg = 'rgba(245,158,11,0.06)';
                            borderColor = 'var(--warning)';
                            clickable = true;
                        } else if (info && !isLapsedHold) {
                            statusLabel = info.isMine ? 'Meu Agendamento' : 'Ocupado';
                            statusColor = info.isMine ? 'var(--success)' : 'var(--text-muted)';
                            cardBg = info.isMine ? 'rgba(16,185,129,0.06)' : 'var(--bg-secondary)';
                            borderColor = info.isMine ? 'var(--success)' : 'var(--border-subtle)';
                            clickable = info.isMine;
                        } else if (isPast || !isAvailable) {
                            // Skip "Fora da Grade" rows — no slot data for this timeslot
                            if (!slot?.tier) return null;
                            // "Encerrado" = horário já passou; "Bloqueado" = indisponibilizado pelo estúdio.
                            statusLabel = isPast ? 'Encerrado' : 'Bloqueado';
                            statusColor = 'var(--text-muted)';
                            cardBg = 'var(--bg-secondary)';
                        } else {
                            statusLabel = 'Disponível';
                            statusColor = tierMeta?.color || 'var(--accent-primary)';
                            cardBg = tierMeta?.bg || 'var(--bg-card)';
                            borderColor = tierMeta?.color || 'var(--accent-primary)';
                            clickable = canCreate;
                        }

                        return (
                            <div
                                key={row.id}
                                className={`calendar-mobile-slot ${clickable ? 'calendar-mobile-slot--clickable' : ''}`}
                                style={{ background: cardBg, borderLeft: `3px solid ${borderColor}` }}
                                onClick={() => {
                                    if (hasActiveHold && info?.myBooking && slot) {
                                        onSlotClick(selectedDateStr, row.time, slot, info);
                                    } else if (info?.isMine && info.myBooking && !isLapsedHold) {
                                        onOpenDetail(info.myBooking, selectedDateStr);
                                    } else if (clickable && slot && isAvailable && !isPast) {
                                        onSlotClick(selectedDateStr, row.time, slot);
                                    } else if (isPast && canCreate) {
                                        onPastSlot();
                                    }
                                }}
                            >
                                <div className="calendar-mobile-slot-time">
                                    <span className="calendar-mobile-slot-start">{row.time}</span>
                                    <span className="calendar-mobile-slot-end">até {row.timeEnd}</span>
                                </div>
                                <div className="calendar-mobile-slot-info">
                                    <span className="calendar-mobile-slot-status" style={{ color: statusColor }}>
                                        {info?.isMine ? info.label : statusLabel}
                                    </span>
                                    {tierMeta && isAvailable && !isPast && !info && (
                                        <span className="calendar-mobile-slot-tier" style={{ color: tierMeta.color }}>
                                            {tierMeta.label}
                                        </span>
                                    )}
                                    {info && (
                                        <span className="calendar-mobile-slot-detail">{row.label}</span>
                                    )}
                                </div>
                                {clickable && (
                                    <ChevronRight size={18} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
            )}
        </div>
    );
}
