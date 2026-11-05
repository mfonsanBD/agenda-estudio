import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import HeroAmbient from '../components/client/HeroAmbient';
import { bookingsApi, blockedSlotsApi, pricingApi, contractsApi, usersApi, Slot, BookingWithUser, MyBookingSlot, PricingConfig, AddOnConfig, ContractWithStats, type ClientBooking, type UserSummary } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useUI } from '../context/UIContext';
import { useNavigate } from 'react-router-dom';
import BookingDetailModal from '../components/BookingDetailModal';
import BookingModal from '../components/BookingModal';
import ContractWizard from '../components/ContractWizard';
import CustomContractWizard from '../components/CustomContractWizard';
import BottomSheetModal from '../components/BottomSheetModal';
import { PosterGallery, PosterCard } from '../components/client/PosterGallery';
import Skeleton from '../components/ui/SkeletonLoader';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { useIsMobile } from '../hooks/useIsMobile';
import { studioSlotDate, todayStrSaoPaulo } from '../utils/time';
import { CalendarDays, Mic, Clock, List, Radio } from 'lucide-react';
import CalendarMobileView from '../components/calendar/CalendarMobileView';
import CalendarDesktopView from '../components/calendar/CalendarDesktopView';
import { TIER_COLORS, getWeekDates, formatDate, BookingLookup } from '../components/calendar/calendarShared';
import { peekPendingIntent, clearPendingIntent, type PendingIntent } from '../utils/pendingIntent';
import type { ContractWizardPrefill } from '../components/ContractWizard';
import { LIVE_BADGE_LABEL, hasOpenSessionToday, isRecordingLive, sessionEndMs, useRecordingWatch } from '../utils/recording';
import { TIER_META, getMeta } from '../constants/adminMeta';
import { usePermission } from '../hooks/usePermission';
import CreateBookingModal from '../components/admin/bookings/CreateBookingModal';

/**
 * Data/dia iniciais da agenda. No domingo a grade Seg–Sáb da semana corrente
 * já passou INTEIRA — para o cliente, abrir nela é uma parede de "Encerrado";
 * começamos na segunda seguinte. Admin consulta o passado, mantém a corrente.
 * D16: com um horário escolhido na landing (`focusDate`), a PRIMEIRA carga já é a
 * semana dele e o mobile abre no dia (sem buscar a semana corrente antes).
 */
function initialCalendarStart(isStaff: boolean, focusDate?: string | null): { base: Date; dayIndex: number } {
    if (focusDate) {
        const d = new Date(`${focusDate}T12:00:00`);
        if (!Number.isNaN(d.getTime())) {
            return { base: d, dayIndex: d.getDay() === 0 ? 5 : d.getDay() - 1 };
        }
    }
    const now = new Date();
    if (!isStaff && now.getDay() === 0) {
        const d = new Date(now);
        d.setDate(d.getDate() + 1);
        return { base: d, dayIndex: 0 };
    }
    return { base: now, dayIndex: now.getDay() === 0 ? 5 : now.getDay() - 1 };
}

export default function CalendarPage() {
    const { user } = useAuth();
    const navigate = useNavigate();
    // Agenda em modo EQUIPE (ADMIN ou COLABORADOR com agendamentos.ver/hoje.ver — guarda da rota): grade
    // do estúdio com os nomes dos clientes. O autoatendimento (BookingModal → POST /bookings) é só do
    // CLIENTE (S5): na equipe, clicar num horário livre abre o "Novo agendamento" do admin, com data e
    // hora preenchidas, e só com agendamentos.criar. (As views ainda chamam a prop de `isAdmin` = modo equipe.)
    const { isStaff, can } = usePermission();
    const canCreateForClient = isStaff && can('agendamentos.criar');
    const [staffCreate, setStaffCreate] = useState<{ date: string; startTime: string } | null>(null);
    const [staffClients, setStaffClients] = useState<UserSummary[] | null>(null);
    const [staffClientsLoading, setStaffClientsLoading] = useState(false);
    const isMobile = useIsMobile();
    const { get: getConfigNum, loaded: configLoaded } = useBusinessConfig();
    // Minimum advance notice for clients (admin books any time). Slots closer than this
    // are greyed out to match the backend rule.
    // B13: usar o valor real (0 é válido); `|| 12` transformava uma config legítima de 0h em 12h só no front.
    const minAdvanceHoursRaw = getConfigNum('booking_min_advance_hours');
    const minAdvanceHours = Number.isFinite(minAdvanceHoursRaw) ? minAdvanceHoursRaw : 12;
    // D16: horário escolhido na landing antes do login — lido UMA vez (só cliente). Fica em estado
    // desta instância; o sessionStorage é limpo quando a retomada é tratada ou ao sair da página.
    const [resumeIntent] = useState<PendingIntent | null>(() => (user && user.role === 'CLIENTE' ? peekPendingIntent() : null));
    const initialStart = useRef(initialCalendarStart(isStaff, resumeIntent?.date)).current;
    const [currentWeek, setCurrentWeek] = useState(initialStart.base);
    const [weekDates, setWeekDates] = useState<Date[]>(getWeekDates(initialStart.base));

    const [selectedDayIndex, setSelectedDayIndex] = useState(initialStart.dayIndex); // Mon=0 ... Sat=5
    const [slotsMap, setSlotsMap] = useState<Record<string, Slot[]>>({});
    const [bookingsMap, setBookingsMap] = useState<Record<string, BookingWithUser[]>>({});
    const [myBookingsMap, setMyBookingsMap] = useState<Record<string, MyBookingSlot[]>>({});
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    const [isFetchingWeek, setIsFetchingWeek] = useState(false);
    // Crossfade state for slot cards (4-phase: visible → out → out_done → in)
    const [slotsPhase, setSlotsPhase] = useState<'visible' | 'out' | 'out_done' | 'in'>('visible');
    const [showPastSlotAlert, setShowPastSlotAlert] = useState(false);
    const [displayDateStr, setDisplayDateStr] = useState(() => {
        const initialDates = getWeekDates(initialStart.base);
        const d = initialDates[initialStart.dayIndex] || initialDates[0];
        return d ? formatDate(d) : '';
    });
    const slotsFadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    
    const getStartOfWeek = (d: Date) => {
        const date = new Date(d);
        const day = date.getDay();
        const diff = date.getDate() - day + (day === 0 ? -6 : 1);
        return new Date(date.setDate(diff));
    };

    const [currentDate, setCurrentDate] = useState(() => getStartOfWeek(new Date()));
    const [selectedSlot, setSelectedSlot] = useState<{ date: string, time: string, tier: string, price: number } | null>(null);
    const lastSelectedSlot = useRef<{ date: string, time: string, tier: string, price: number } | null>(null);
    if (selectedSlot) lastSelectedSlot.current = selectedSlot;

    // E12: o detalhe DESMONTA ao fechar e tem `key` = id — o texto digitado e não salvo e os dados da
    // gravação anterior não reaparecem ao reabrir/trocar de agendamento.
    const [detailBooking, setDetailBooking] = useState<{ date: string, booking: MyBookingSlot } | null>(null);

    const [activeTab, setActiveTab] = useState<'agendar' | 'agendados'>('agendar');
    // Lista completa do cliente (GET /bookings/my) + o instante da leitura: "Seus Agendamentos" junta
    // esta lista com a da semana (GET /availability) e vale SEMPRE a leitura mais recente de cada uma.
    const [allMy, setAllMy] = useState<{ list: ClientBooking[]; at: number }>({ list: [], at: 0 });
    const [weekFetchedAt, setWeekFetchedAt] = useState<Record<string, number>>({});

    const [showWizard, setShowWizard] = useState(false);
    // D16: "Criar Novo Contrato" no BookingModal abre o wizard já com a faixa, a data e a hora do horário.
    const [wizardPrefill, setWizardPrefill] = useState<ContractWizardPrefill | null>(null);
    const [showCustomWizard, setShowCustomWizard] = useState(false);
    const [pricing, setPricing] = useState<PricingConfig[]>([]);
    const [allAddons, setAllAddons] = useState<AddOnConfig[]>([]);
    const [contracts, setContracts] = useState<ContractWithStats[]>([]);
    const { showAlert, showToast } = useUI();

    const prevWeekDates = useMemo(() => {
        const d = new Date(currentWeek);
        d.setDate(d.getDate() - 7);
        return getWeekDates(d);
    }, [currentWeek]);
    const nextWeekDates = useMemo(() => {
        const d = new Date(currentWeek);
        d.setDate(d.getDate() + 7);
        return getWeekDates(d);
    }, [currentWeek]);

    const bookingsSectionRef = useRef<HTMLDivElement>(null);


    // Load addons and contracts once on mount so the detail modal has full context
    useEffect(() => {
        pricingApi.getAddons().then(res => setAllAddons(res.addons)).catch(() => {});
        if (!isStaff) {
            contractsApi.getMy().then(res => setContracts(res.contracts)).catch(() => {});
        }
    }, [isStaff]);

    const loadWeekData = useCallback(async (dates: Date[]) => {
        setIsFetchingWeek(true);
        setLoadError(false);
        // Instante do PEDIDO (comparável ao do GET /my): decide qual leitura vale em "Seus Agendamentos".
        const fetchedAt = Date.now();
        try {
            const results = await Promise.all(
                dates.map(d => bookingsApi.getAvailability(formatDate(d)))
            );
            const newSlotsMap: Record<string, Slot[]> = {};
            const newMyBookingsMap: Record<string, MyBookingSlot[]> = {};
            const newFetchedAt: Record<string, number> = {};
            results.forEach((res, i) => {
                const dateKey = formatDate(dates[i]);
                newSlotsMap[dateKey] = res.slots;
                newMyBookingsMap[dateKey] = res.myBookings || [];
                newFetchedAt[dateKey] = fetchedAt;
            });
            setSlotsMap(prev => ({ ...prev, ...newSlotsMap }));
            setMyBookingsMap(prev => ({ ...prev, ...newMyBookingsMap }));
            setWeekFetchedAt(prev => ({ ...prev, ...newFetchedAt }));

            if (isStaff) {
                const bookingResults = await Promise.all(
                    dates.map(d => bookingsApi.getAll(formatDate(d)))
                );
                const newBookingsMap: Record<string, BookingWithUser[]> = {};
                bookingResults.forEach((res, i) => {
                    newBookingsMap[formatDate(dates[i])] = res.bookings;
                });
                setBookingsMap(prev => ({ ...prev, ...newBookingsMap }));
            }
        } catch (err) { console.error('Failed to load calendar data:', err); setLoadError(true); }
        finally {
            setLoading(false);
            setIsFetchingWeek(false);
        }
    }, [isStaff]);

    // Lista completa do cliente — silenciosa (a galeria não pisca); uma falha mantém o que já estava.
    const loadMyBookings = useCallback(() => {
        if (isStaff) return;
        const startedAt = Date.now();
        bookingsApi.getMy()
            .then(res => setAllMy(prev => (startedAt >= prev.at ? { list: res.bookings, at: startedAt } : prev)))
            .catch(err => console.error('Failed to fetch all bookings', err));
    }, [isStaff]);

    useEffect(() => {
        const dates = getWeekDates(currentWeek);
        setWeekDates(dates);
        loadWeekData(dates);
        // (o reset do carrossel de pills vive na CalendarMobileView, que observa weekDates)
    }, [currentWeek, loadWeekData]);

    // Refetch calendar data when user returns to this tab (e.g. after paying)
    useEffect(() => {
        const handleVisibility = () => {
            if (document.visibilityState === 'visible') {
                const dates = getWeekDates(currentWeek);
                loadWeekData(dates);
                loadMyBookings();
            }
        };
        document.addEventListener('visibilitychange', handleVisibility);
        return () => document.removeEventListener('visibilitychange', handleVisibility);
    }, [currentWeek, loadWeekData, loadMyBookings]);

    useEffect(() => {
        pricingApi.get().then(res => setPricing(res.pricing)).catch(err => console.error(err));
    }, []);

    const navigateWeek = (direction: number) => {
        const d = new Date(currentWeek);
        d.setDate(d.getDate() + direction * 7);
        setCurrentWeek(d);
    };
    const goToday = () => {
        const now = new Date();
        setCurrentWeek(now);
        setSelectedDayIndex(now.getDay() === 0 ? 5 : now.getDay() - 1);
    };

    const today = formatDate(new Date());

    // Lookups por data memoizados: antes eram reconstruídos POR CÉLULA a cada
    // render (30×/render na grade desktop). O filtro de hold expirado usa
    // Date.now() no instante do memo — como o memo só recomputa quando os mapas
    // mudam (fetch), agenda-se um refetch no momento da expiração mais próxima
    // (useEffect abaixo) para o hold caducado sair sozinho — no mobile não há
    // countdown e trocar de dia não refaz fetch.
    const bookingLookups = useMemo(() => {
        const lookups: Record<string, BookingLookup> = {};
        const dates = new Set([...Object.keys(myBookingsMap), ...Object.keys(bookingsMap)]);
        for (const date of dates) {
            const map: BookingLookup = {};
            const myBookings = myBookingsMap[date] || [];
            for (const b of myBookings) {
                if (b.status === 'RESERVED' && b.holdExpiresAt && new Date(b.holdExpiresAt).getTime() <= Date.now()) {
                    continue;
                }
                map[b.startTime] = { label: `${user?.name?.split(' ')[0] || 'Eu'}`, tier: b.tierApplied.toLowerCase(), isMine: true, myBooking: b };
            }
            if (isStaff && bookingsMap[date]) {
                for (const b of bookingsMap[date]) {
                    if (b.status === 'RESERVED' && b.holdExpiresAt && new Date(b.holdExpiresAt).getTime() <= Date.now()) {
                        continue;
                    }
                    if (!map[b.startTime]) map[b.startTime] = { label: b.user.name, tier: b.tierApplied.toLowerCase(), isMine: false };
                }
            }
            lookups[date] = map;
        }
        return lookups;
    }, [myBookingsMap, bookingsMap, isStaff, user?.name]);

    // Reagenda um refetch para o instante da expiração de hold mais próxima —
    // sem isso, um hold que caduca enquanto o cliente navega ficaria preso no
    // lookup congelado (no mobile viraria "Meu Agendamento" verde/clicável; o
    // weekSummary contaria como ocupado). Restaura o invariante pré-extração.
    useEffect(() => {
        const now = Date.now();
        let earliest = Infinity;
        const scan = (list: { status: string; holdExpiresAt?: string | null }[]) => {
            for (const b of list) {
                if (b.status === 'RESERVED' && b.holdExpiresAt) {
                    const t = new Date(b.holdExpiresAt).getTime();
                    if (t > now && t < earliest) earliest = t;
                }
            }
        };
        Object.values(myBookingsMap).forEach(scan);
        if (isStaff) Object.values(bookingsMap).forEach(scan);
        if (earliest === Infinity) return;
        const timer = setTimeout(() => loadWeekData(weekDates), earliest - now + 500);
        return () => clearTimeout(timer);
    }, [myBookingsMap, bookingsMap, isStaff, weekDates, loadWeekData]);

    const buildBookingLookup = useCallback(
        (date: string): BookingLookup => bookingLookups[date] || {},
        [bookingLookups]
    );

    const openDetailModal = useCallback((b: MyBookingSlot, date: string) => {
        setDetailBooking({ booking: b, date });
    }, []);

    // Equipe: "Novo agendamento" (CreateBookingModal) com data e hora do horário clicado. A lista de
    // clientes só é buscada aqui (a Agenda não precisa dela para mostrar a grade).
    const openStaffCreate = useCallback((date: string, startTime: string) => {
        setStaffCreate({ date, startTime });
        if (staffClients || staffClientsLoading) return;
        setStaffClientsLoading(true);
        usersApi.getAll()
            .then(res => setStaffClients(res.users))
            .catch(err => { console.error(err); setStaffClients(null); })
            .finally(() => setStaffClientsLoading(false));
    }, [staffClients, staffClientsLoading]);

    // Horário passado: o aviso "não dá para agendar" só faz sentido para quem agenda.
    const handlePastSlot = useCallback(() => {
        if (!isStaff || canCreateForClient) setShowPastSlotAlert(true);
    }, [isStaff, canCreateForClient]);

    const handleSlotClick = useCallback((date: string, time: string, slot: Slot, info?: { isMine: boolean; myBooking?: MyBookingSlot }) => {
        if (isStaff) {
            // S5: a equipe nunca usa o autoatendimento do cliente (POST /bookings é só CLIENTE).
            if (canCreateForClient && slot.available && slot.tier) openStaffCreate(date, time);
            return;
        }
        if (info?.isMine && info.myBooking) { openDetailModal(info.myBooking, date); return; }
        if (!slot.available || !slot.tier || !slot.price) return;
        setSelectedSlot({ date, time, tier: slot.tier, price: slot.price });
    }, [openDetailModal, isStaff, canCreateForClient, openStaffCreate]);

    // ─── D16: retomar o horário escolhido na landing ───
    // A semana/dia iniciais já são os da intenção (initialCalendarStart). Espera a 1ª carga dessa
    // semana (sem fetch próprio → sem corrida com o StrictMode) e decide UMA vez (guard em ref):
    //  - horário já é do cliente → detalhe; livre e com antecedência → BookingModal no passo de
    //    opções (usar plano / avulso / novo contrato); livre mas em cima da hora → aviso de
    //    antecedência; ocupado/bloqueado → "Horário indisponível" com a agenda já naquele dia.
    // Falha de carga: aguarda o "Tentar novamente" (a intenção continua em memória).
    const resumeHandled = useRef(false);
    useEffect(() => {
        if (!resumeIntent) return;
        // Ao sair da página sem retomar (ou no desmonte), a intenção não pode sobrar para um próximo login.
        return () => clearPendingIntent();
    }, [resumeIntent]);
    useEffect(() => {
        if (!resumeIntent || resumeHandled.current) return;
        if (loading || isFetchingWeek || !configLoaded) return;
        const { date, time } = resumeIntent;
        const daySlots = slotsMap[date];
        if (!daySlots) return;
        resumeHandled.current = true;
        clearPendingIntent();

        const mine = bookingLookups[date]?.[time];
        if (mine?.isMine && mine.myBooking) {
            openDetailModal(mine.myBooking, date);
            return;
        }
        const slot = daySlots.find(s => s.time === time);
        if (slot && slot.available && slot.tier && slot.price) {
            const cutoffMs = Date.now() + minAdvanceHours * 60 * 60 * 1000;
            if (studioSlotDate(date, time).getTime() >= cutoffMs) {
                setSelectedSlot({ date, time, tier: slot.tier, price: slot.price });
            } else {
                setShowPastSlotAlert(true);
            }
            return;
        }
        const [, mm, dd] = date.split('-');
        showAlert({
            type: 'warning',
            title: 'Horário indisponível',
            message: `O horário de ${dd}/${mm} às ${time} não está mais disponível. Escolha outro horário — a agenda já está nesse dia.`,
        });
    }, [resumeIntent, loading, isFetchingWeek, configLoaded, slotsMap, bookingLookups, minAdvanceHours, openDetailModal, showAlert]);

    // Compute weekly summary
    const weekSummary = (() => {
        let booked = 0, available = 0, total = 0;
        // Clients must respect the minimum advance notice; admin can book any time.
        const cutoffMs = Date.now() + (isStaff ? 0 : minAdvanceHours * 60 * 60 * 1000);
        weekDates.forEach(d => {
            const dateStr = formatDate(d);
            const slots = slotsMap[dateStr] || [];
            const dayBookings = buildBookingLookup(dateStr);
            slots.forEach(s => {
                if (s.tier) {
                    total++;
                    if (dayBookings[s.time]) {
                        booked++;
                    } else if (s.available) {
                        // Only count as available if the slot starts after the cutoff (São Paulo)
                        const slotStart = studioSlotDate(dateStr, s.time);
                        if (slotStart.getTime() >= cutoffMs) available++;
                    }
                }
            });
        });
        return { booked, available, total, pct: total > 0 ? Math.round((booked / total) * 100) : 0 };
    })();

    // Current month/year for display
    const displayMonth = weekDates.length > 0
        ? weekDates[Math.floor(weekDates.length / 2)].toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
        : '';

    // Selected day for mobile
    const selectedDate = weekDates[selectedDayIndex] || weekDates[0];
    const selectedDateStr = selectedDate ? formatDate(selectedDate) : '';

    // 4-phase crossfade: fade-out → wait for fetch → swap content → fade-in
    useEffect(() => {
        if (!selectedDateStr || loading || selectedDateStr === displayDateStr) return;
        
        if (slotsFadeTimer.current) clearTimeout(slotsFadeTimer.current);
        // Phase 1: fade out (150ms)
        setSlotsPhase('out');
        slotsFadeTimer.current = setTimeout(() => {
            // Phase 2: wait for data
            setSlotsPhase('out_done');
        }, 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedDateStr, loading, displayDateStr]);

    useEffect(() => {
        if (slotsPhase === 'out_done' && !isFetchingWeek) {
            // Phase 3: swap content while invisible, then fade in (260ms)
            setDisplayDateStr(selectedDateStr);
            setSlotsPhase('in');
            if (slotsFadeTimer.current) clearTimeout(slotsFadeTimer.current);
            slotsFadeTimer.current = setTimeout(() => setSlotsPhase('visible'), 260);
        }
    }, [slotsPhase, isFetchingWeek, selectedDateStr]);

    // Cleanup do timer de crossfade no unmount (setState em componente morto).
    useEffect(() => () => {
        if (slotsFadeTimer.current) clearTimeout(slotsFadeTimer.current);
    }, []);

    // Fetch all user bookings on mount so the Agendados carrousel has the complete list
    useEffect(() => { loadMyBookings(); }, [loadMyBookings]);

    // E11: enquanto houver sessão de hoje em aberto (reservada, confirmada ou já em gravação), recarrega a lista de
    // tempos em tempos — o selo "AO VIVO" liga quando o estúdio inicia e a sessão sai de "Agendados"
    // quando ele finaliza. (A volta para a aba já é tratada pelo handler de visibilidade acima.)
    useRecordingWatch(!isStaff && hasOpenSessionToday(allMy.list), loadMyBookings, { onVisible: false });

    // ─── Derive upcoming bookings from allMy (GET /my) + myBookingsMap (semana) ───
    const DAY_NAMES_FULL = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const upcomingBookings = useMemo(() => {
        const now = Date.now();
        const map = new Map<string, { booking: ClientBooking; date: string; dateObj: Date }>();
        // Agendado = reservado/confirmado que ainda não terminou. A sessão continua na lista até o FIM do
        // horário e enquanto estiver sendo gravada (antes ela sumia no minuto em que começava).
        const add = (b: ClientBooking, dateStr: string) => {
            if (b.status === 'RESERVED' && b.holdExpiresAt && new Date(b.holdExpiresAt).getTime() <= now) return;
            if (b.status !== 'RESERVED' && b.status !== 'CONFIRMED') return;
            const live = isRecordingLive(b);
            if (!live && sessionEndMs(dateStr, b.startTime, b.endTime) < now) return;
            map.set(b.id, { booking: b, date: dateStr, dateObj: studioSlotDate(dateStr, b.startTime) });
        };

        // 1. Lista completa (GET /my)
        allMy.list.forEach(b => add(b, b.date.split('T')[0]));

        // 2. Semana visível (GET /availability): mesma forma do /my. Só entra por cima quando foi lida
        //    DEPOIS do /my — senão um dado velho da semana desfaria o que o /my acabou de trazer (título
        //    salvo, "AO VIVO", gravação finalizada/cancelada).
        for (const [dateStr, bookings] of Object.entries(myBookingsMap)) {
            if (allMy.at > 0 && (weekFetchedAt[dateStr] ?? 0) <= allMy.at) continue;
            for (const b of bookings) {
                map.delete(b.id);
                add(b, dateStr);
            }
        }

        const list = Array.from(map.values());
        list.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
        return list;
    }, [myBookingsMap, allMy, weekFetchedAt]);

    return (
        <div>
            {/* ─── CLIENT HERO ─── */}
            {!isStaff && (
                <div className="client-hero client-hero--default animate-card-enter">
                    <HeroAmbient variant="agenda" />
                    <div className="client-hero__header" style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '20px' }}>
                        <div className="client-hero__icon-wrapper">
                            <CalendarDays size={24} />
                        </div>
                        <div>
                            <h2 className="client-hero__greeting" style={{ margin: 0 }}>Agenda</h2>
                            <p className="client-hero__message" style={{ margin: '4px 0 0 0' }}>
                                {upcomingBookings.length > 0 
                                    ? `Você tem ${upcomingBookings.length} sessão(ões) agendada(s)`
                                    : 'Acompanhe seus horários de gravação'}
                            </p>
                        </div>
                    </div>
                    <div className="client-cta-stack">
                        <button 
                            className={`btn ${activeTab === 'agendar' ? 'btn-primary' : 'btn-secondary'}`}
                            onClick={() => setActiveTab('agendar')}
                        >
                            <CalendarDays size={18} /> Agendar
                        </button>
                        <button 
                            className={`btn ${activeTab === 'agendados' ? 'btn-primary' : 'btn-secondary'}`}
                            onClick={() => setActiveTab('agendados')}
                        >
                            <List size={18} /> Agendados
                            {upcomingBookings.length > 0 && (
                                <span style={{ 
                                    background: activeTab === 'agendados' ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.08)',
                                    color: '#fff',
                                    borderRadius: '10px', padding: '2px 8px', fontSize: '0.7rem', fontWeight: 700,
                                    lineHeight: '1.2'
                                }}>
                                    {upcomingBookings.length}
                                </span>
                            )}
                        </button>
                    </div>
                </div>
            )}
            
            {isStaff && (
                <AdminPageHeader
                    icon={CalendarDays}
                    title="Agenda"
                    subtitle="Visão completa da agenda do estúdio"
                    actions={
                        <div className="agenda-hero-stats" role="group" aria-label="Resumo da semana">
                            <div className="agenda-hero-stat">
                                <div className="agenda-hero-stat__value agenda-hero-stat__value--success">{weekSummary.booked}</div>
                                <div className="agenda-hero-stat__label">Agendados</div>
                            </div>
                            <div className="agenda-hero-stat">
                                <div className="agenda-hero-stat__value agenda-hero-stat__value--info">{weekSummary.available}</div>
                                <div className="agenda-hero-stat__label">Disponíveis</div>
                            </div>
                            <div className="agenda-hero-stat">
                                <div className={`agenda-hero-stat__value agenda-hero-stat__value--${weekSummary.pct >= 70 ? 'success' : weekSummary.pct >= 30 ? 'warning' : 'muted'}`}>{weekSummary.pct}%</div>
                                <div className="agenda-hero-stat__label">Ocupação</div>
                            </div>
                        </div>
                    }
                />
            )}

            {/* ─── TAB CONTENT WRAPPER ─── */}
            <div className="view-transition-wrapper">
                {/* U4: a failed week load must not masquerade as an empty/fully-available agenda. */}
                {!loading && loadError && (
                    <div className="client-empty animate-card-enter" style={{ marginBottom: 16 }} role="alert">
                        <CalendarDays size={32} className="client-empty__icon" />
                        <div className="client-empty__text">Não foi possível carregar a agenda desta semana.</div>
                        <button
                            className="btn btn-primary btn-sm"
                            style={{ marginTop: 10 }}
                            onClick={() => loadWeekData(weekDates)}
                        >
                            Tentar novamente
                        </button>
                    </div>
                )}
                {(!isStaff && activeTab === 'agendados') ? (
                    // ─── UPCOMING BOOKINGS TAB (client only) ───
                    <div key="agendados" className="fade-in-view">
                        {!loading && upcomingBookings.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
                                <CalendarDays size={48} style={{ opacity: 0.2, margin: '0 auto 16px' }} />
                                <p>Você não possui agendamentos futuros.</p>
                            </div>
                        ) : (
                            <div ref={bookingsSectionRef} className="client-section" style={{ marginBottom: '20px' }}>
                                <div className="client-section__header-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                    <h3 className="client-section__heading" style={{ marginBottom: 0 }}>
                                        <span className="client-section__heading-icon client-section__heading-icon--accent">
                                            <CalendarDays size={16} />
                                        </span>
                                        Seus Agendamentos
                                    </h3>
                                </div>
                                <PosterGallery
                                    revision={loading ? 'loading' : upcomingBookings.length}
                                    busy={loading}
                                    label="Seus agendamentos"
                                >
                                    {loading
                                        ? [0, 1, 2].map(i => (
                                            <div key={i} className="poster-card poster-card--skel">
                                                <Skeleton variant="rounded" width="100%" height="100%" />
                                            </div>
                                        ))
                                        : upcomingBookings.map((item, i) => {
                                            const dayLabel = DAY_NAMES_FULL[item.dateObj.getUTCDay()];
                                            const dateLabel = item.dateObj.toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' });
                                            const isToday = item.date === todayStrSaoPaulo();
                                            const b = item.booking;
                                            // Sem título nem nome do contrato: rótulo legível da faixa ("Audiência"), nunca a chave.
                                            const title = b.episodeTitle || b.contract?.name || getMeta(TIER_META, b.tierApplied).label;
                                            // E11: "AO VIVO" só enquanto o estúdio está gravando (isRecordingNow).
                                            const live = isRecordingLive(b);
                                            return (
                                                <PosterCard
                                                    key={b.id}
                                                    index={i}
                                                    tone="teal"
                                                    highlight={isToday && !live}
                                                    live={live}
                                                    coverUrl={b.coverImageUrl}
                                                    placeholder={<Mic size={46} strokeWidth={1.25} />}
                                                    badgeTopLeft={live ? <span className="poster-chip poster-chip--live"><Radio size={10} aria-hidden="true" /> {LIVE_BADGE_LABEL}</span> : undefined}
                                                    badgeTopRight={isToday ? <span className="poster-chip poster-chip--today">Hoje</span> : undefined}
                                                    eyebrow={`${dayLabel}, ${dateLabel}`}
                                                    title={title}
                                                    footer={<span className="poster-card__time">{b.startTime} — {b.endTime}</span>}
                                                    ariaLabel={`${title}, ${live ? 'ao vivo, gravando agora, ' : ''}${isToday ? 'hoje, ' : ''}${dayLabel} ${dateLabel}, ${b.startTime} às ${b.endTime}. Abrir detalhes e informações da gravação`}
                                                    onClick={() => setDetailBooking({ booking: b, date: item.date })}
                                                />
                                            );
                                        })}
                                </PosterGallery>
                            </div>
                        )}
                    </div>
                ) : (
                    // ─── AGENDAR TAB (Calendar Grid) ───
                    <div key="agendar" className="fade-in-view">
            {isMobile ? (
                <CalendarMobileView
                    isAdmin={isStaff}
                    canCreate={!isStaff || canCreateForClient}
                    minAdvanceHours={minAdvanceHours}
                    loading={loading}
                    weekDates={weekDates}
                    prevWeekDates={prevWeekDates}
                    nextWeekDates={nextWeekDates}
                    selectedDayIndex={selectedDayIndex}
                    onSelectDay={setSelectedDayIndex}
                    navigateWeek={navigateWeek}
                    goToday={goToday}
                    today={today}
                    displayMonth={displayMonth}
                    slotsPhase={slotsPhase}
                    displayDateStr={displayDateStr}
                    selectedDateStr={selectedDateStr}
                    slotsMap={slotsMap}
                    buildBookingLookup={buildBookingLookup}
                    onSlotClick={handleSlotClick}
                    onOpenDetail={openDetailModal}
                    onPastSlot={handlePastSlot}
                />
            ) : (
                <CalendarDesktopView
                    isAdmin={isStaff}
                    canCreate={!isStaff || canCreateForClient}
                    userFirstName={user?.name?.split(' ')[0] || 'Eu'}
                    minAdvanceHours={minAdvanceHours}
                    loading={loading}
                    weekDates={weekDates}
                    displayMonth={displayMonth}
                    today={today}
                    slotsMap={slotsMap}
                    buildBookingLookup={buildBookingLookup}
                    onSlotClick={handleSlotClick}
                    onPastSlot={handlePastSlot}
                    onHoldExpire={() => loadWeekData(weekDates)}
                    goToday={goToday}
                    navigateWeek={navigateWeek}
                />
            )}

            {/* ─── LEGEND ─── */}
            <div style={{
                display: 'flex', gap: '16px', marginTop: '16px', flexWrap: 'wrap',
                padding: '12px 16px', borderRadius: '12px',
                background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
            }}>
                {Object.entries(TIER_COLORS).map(([key, meta]) => (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.6875rem', fontWeight: 600 }}>
                        <span style={{ width: 10, height: 10, borderRadius: 3, background: meta.color, display: 'inline-block' }} />
                        <span style={{ color: meta.color }}>{meta.label}</span>
                    </div>
                ))}
                {!isStaff && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.6875rem', fontWeight: 600 }}>
                        <span style={{ width: 10, height: 10, borderRadius: 3, border: '2px solid var(--success)', background: 'rgba(52,211,153,0.2)', display: 'inline-block' }} />
                        <span style={{ color: 'var(--success)' }}>Meu Agendamento</span>
                    </div>
                )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.6875rem', fontWeight: 600 }}>
                        <span style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--status-blocked)', display: 'inline-block' }} />
                        <span style={{ color: 'var(--text-muted)' }}>Bloqueado / Ocupado</span>
                    </div>
                </div>
            </div>
            )}
        </div>

            {/* ─── MODALS ─── */}
            {/* Equipe: "Novo agendamento" para um cliente, com o horário clicado (montado só enquanto aberto). */}
            {isStaff && staffCreate && (
                <CreateBookingModal
                    key={`${staffCreate.date}-${staffCreate.startTime}`}
                    isOpen
                    prefill={staffCreate}
                    users={staffClients ?? []}
                    usersLoading={staffClientsLoading}
                    onClose={() => setStaffCreate(null)}
                    onCreated={() => loadWeekData(weekDates)}
                />
            )}

            {/* Autoatendimento do CLIENTE (POST /bookings): nunca para a equipe (S5). */}
            {!isStaff && (selectedSlot || lastSelectedSlot.current) && (
                <BookingModal 
                    isOpen={!!selectedSlot}
                    date={(selectedSlot || lastSelectedSlot.current)?.date || ''}
                    time={(selectedSlot || lastSelectedSlot.current)?.time || ''}
                    tier={(selectedSlot || lastSelectedSlot.current)?.tier || ''}
                    price={(selectedSlot || lastSelectedSlot.current)?.price || 0}
                    onClose={() => { setSelectedSlot(null); loadWeekData(weekDates); }}
                    onBooked={() => { setSelectedSlot(null); loadWeekData(weekDates); }}
                    onNewContract={(date, time, tier) => {
                        setWizardPrefill({ date, time, tier });
                        setShowWizard(true);
                    }}
                />
            )}

            {showWizard && (
                <ContractWizard
                    pricing={pricing}
                    prefill={wizardPrefill ?? undefined}
                    onClose={() => { setShowWizard(false); setWizardPrefill(null); }}
                    onComplete={() => navigate('/meus-contratos')}
                    onOpenCustom={() => {
                        setShowWizard(false);
                        setWizardPrefill(null);
                        setShowCustomWizard(true);
                    }}
                />
            )}

            {showCustomWizard && (
                <CustomContractWizard
                    pricing={pricing}
                    onClose={() => setShowCustomWizard(false)}
                    onComplete={() => navigate('/meus-contratos')}
                />
            )}

            {/* ─── DETAIL MODAL ─── */}
            {/* E12: montado só enquanto aberto e com key = id (estado não vaza entre aberturas). Recebe a
                reserva completa do cliente (título/capa/contrato já aparecem na hora); o modal relê por id. */}
            {detailBooking && (() => {
                const parent = contracts.find(c => c.bookings?.some(b => b.id === detailBooking.booking.id));
                const reloadLists = () => { loadWeekData(weekDates); loadMyBookings(); };
                return (
                    <BookingDetailModal
                        key={detailBooking.booking.id}
                        booking={detailBooking.booking}
                        onClose={() => setDetailBooking(null)}
                        // Salvou: fecha e relê a semana E a lista completa — o card passa a mostrar título/capa salvos.
                        onSaved={() => { setDetailBooking(null); reloadLists(); }}
                        onChanged={reloadLists}
                        allAddons={allAddons}
                        contractDiscountPct={parent?.discountPct || 0}
                        contractAddOns={parent?.addOns || []}
                    />
                );
            })()}

            <BottomSheetModal isOpen={showPastSlotAlert} onClose={() => setShowPastSlotAlert(false)} title="Ação Indisponível">
                <div style={{ padding: '0 20px 30px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{ margin: '10px 0 20px', color: 'var(--text-muted)' }}>
                        <Clock size={48} strokeWidth={1.5} />
                    </div>
                    <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: '10px', fontSize: '0.9375rem', maxWidth: '300px' }}>
                        {isStaff
                            ? 'Não é possível agendar um horário que já passou.'
                            : <>Não é possível agendar um horário no passado, ou com menos de {minAdvanceHours} hora{minAdvanceHours !== 1 ? 's' : ''} de antecedência.</>}
                    </p>
                </div>
            </BottomSheetModal>
        </div>
    );
}
