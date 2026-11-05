import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
    AlertCircle, AlertTriangle, ArrowLeft, ArrowRight, BadgePercent, CalendarCheck, CalendarClock, CalendarDays,
    CalendarRange, Check, CheckCircle2, ChevronLeft, ChevronRight, Clock, Lightbulb, Loader2, NotebookPen,
    RefreshCw, ShieldCheck, Sparkles, UserRound, Wallet, Wand2, X,
} from 'lucide-react';
import BottomSheetModal from '../BottomSheetModal';
import WizardSteps from '../admin/WizardSteps';
import ChargeNowSheet from '../admin/ChargeNowSheet';
import InlineCheckout from '../InlineCheckout';
import CouponField from '../CouponField';
import CpfCnpjPrompt from '../CpfCnpjPrompt';
import DangerConfirmDialog from '../ui/DangerConfirmDialog';
import Tooltip from '../ui/Tooltip';
import BrandLoader from '../ui/BrandLoader';
import ContractSlotPicker, { formatSlotRange } from './ContractSlotPicker';
import { useContractSlotGrid } from '../../hooks/useContractSlotGrid';
import { useWizardStep } from '../../hooks/useWizardStep';
import { useBusinessConfig } from '../../hooks/useBusinessConfig';
import { useCountdown } from '../../hooks/useCountdown';
import { useCardInstallments } from '../../hooks/useCardInstallments';
import { useAuth } from '../../context/AuthContext';
import { useUI } from '../../context/UIContext';
import { usePermission } from '../../hooks/usePermission';
import {
    ApiError, authApi, contractsApi, pricingApi,
    type AddOnConfig, type ContractTier, type CouponValidation, type CustomConflict, type CustomContractData,
    type PricingConfig, type UserSummary,
} from '../../api/client';
import { TIER_META } from '../../constants/adminMeta';
import {
    getClientPaymentMethods, getPaymentMethods, methodInContext, loadPaymentMethods, usePaymentMethodsVersion,
    type PaymentMethodConfig, type PaymentMethodKey,
} from '../../constants/paymentMethods';
import { DAY_NAMES, DAY_NAMES_FULL, formatBRL } from '../../utils/format';
import { getErrorMessage } from '../../utils/errors';
import { isValidCpfCnpj } from '../../utils/mask';
import { todayStrSaoPaulo } from '../../utils/time';

// ─── Contrato PERSONALIZADO — fluxo único admin + cliente (D7/D9) ───────────
// Mesma casca nos dois modos (casca canônica dos wizards admin: BottomSheetModal xl +
// .admin-modal-head + WizardSteps Plano/Agenda/Serviços/Resumo + .admin-actions-row).
//  • ADMIN: todas as opções (cliente, frequências, data de início, 1–12 ciclos, plano Mensal/Integral,
//    forma de pagamento, cupom). checkCustom → conflitos → createCustom (contrato nasce ATIVO, sem
//    gateway) → ChargeNowSheet com a 1ª cobrança (cartão / QR PIX com gate do CPF do CLIENTE) ou
//    "Deixar pendente". onCreated() só quando esse sheet fecha.
//  • CLIENTE: opções restritas (só semanal, início "a partir de amanhã", 1/3/6/9/12 ciclos), termos,
//    CPF antes de PIX. checkCustom → conflitos → createCustom (AGUARDANDO PAGAMENTO por 10 min, sessões
//    reservadas) → checkout inline com o VALOR DO BACKEND (res.payments[0].amount) e contagem regressiva.
// Horários SEMPRE da grade do backend (useContractSlotGrid / ContractSlotPicker) — nada fixo no front.
// Desconto exibido = regra cobrada: por nº de gravações (episodes_3/6months → discount_3/6months).
// Regras anti-submit espúrio: sem <form>, todo botão type="button", keys distintas no rodapé,
// avanço por useWizardStep.next() (setTimeout 0), guard `if (!isLast) return` no envio, sem trava por tempo.
// Envio e "Aceitar sugestões" ignoram o 2º clique de um clique duplo (e.detail > 1; teclado = 0).
// Nenhuma ocorrência fica de fora: conflito sem sugestão bloqueia o aceite (ajustar a agenda) e o backend
// recusa com 409 SLOTS_TAKEN o que ficar ocupado entre o check e a criação.

export type CustomContractFlowMode = 'admin' | 'client';

export interface CustomContractFlowProps {
    mode: CustomContractFlowMode;
    pricing: PricingConfig[];
    /** Admin: lista de usuários (só role CLIENTE não excluídos aparecem). Ignorado no modo cliente. */
    users?: UserSummary[];
    onClose: () => void;
    /**
     * Um contrato foi criado e o fluxo terminou: pago, "Deixar pendente" (admin), saída sem pagar
     * dentro do prazo (cliente) ou tela de sucesso. Nunca é chamado antes disso.
     */
    onCreated: () => void;
}

type Frequency = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'CUSTOM';
type PaymentPlan = 'MONTHLY' | 'FULL';
type Phase = 'form' | 'conflicts' | 'creating' | 'checkout' | 'success' | 'charge';
type AddonMode = 'none' | 'all' | 'credits';
interface AddonChoice { mode: AddonMode; perCycle: number }
interface CustomDate { date: string; time: string }
interface Resolution { originalDate: string; originalTime: string; newDate: string; newTime: string }
interface CreatedContract {
    firstPaymentId: string | null;
    /** Valor autoritativo da 1ª cobrança (backend, já com cupom). */
    firstAmount: number;
    firstPending: boolean;
    status: string;
    paymentDeadline: string | null;
    reservedMinutes: number;
    skipped: { date: string; time: string }[];
    totalBookings: number;
    discountPct: number;
}

const STEPS = ['Plano', 'Agenda', 'Serviços', 'Resumo'];
const ALL_TIERS: ContractTier[] = ['COMERCIAL', 'AUDIENCIA', 'SABADO'];
const TIER_HINT: Record<ContractTier, string> = {
    COMERCIAL: 'Segunda a sexta, horários comerciais',
    AUDIENCIA: 'Segunda a sexta, inclui os horários da noite',
    SABADO: 'Somente aos sábados',
};
const CLIENT_DURATIONS = [1, 3, 6, 9, 12];
const ADMIN_DURATIONS = Array.from({ length: 12 }, (_, i) => i + 1);
const FREQUENCIES = [
    { key: 'WEEKLY', label: 'Semanal', icon: CalendarDays },
    { key: 'BIWEEKLY', label: 'Quinzenal', icon: CalendarRange },
    { key: 'MONTHLY', label: 'Mensal', icon: CalendarClock },
    { key: 'CUSTOM', label: 'Datas livres', icon: Sparkles },
] as const;
const BIWEEKLY_PATTERNS = [
    { pattern: [1, 3], label: 'Semanas 1 e 3', sub: '1ª e 3ª do ciclo' },
    { pattern: [2, 4], label: 'Semanas 2 e 4', sub: '2ª e 4ª do ciclo' },
];
const MONTH_NAMES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const ADMIN_CREDIT_MAX = 20;
const DEFAULT_RESERVE_MINUTES = 10;
/** Por quanto tempo o "amanhã" devolvido pelo servidor (400 START_DATE_TOMORROW) prevalece sobre o relógio local. */
const SERVER_TOMORROW_TTL_MS = 10 * 60 * 1000;

// ─── Datas (sempre 'YYYY-MM-DD' em UTC, como o backend) ─────────────────────
const isDateStr = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const addDaysStr = (ds: string, n: number) => {
    const d = new Date(`${ds}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};
const addMonthsStr = (ds: string, n: number) => {
    const d = new Date(`${ds}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    return d.toISOString().slice(0, 10);
};
const weekdayOf = (ds: string) => new Date(`${ds}T00:00:00Z`).getUTCDay();
const fmtDate = (ds: string) => { const [y, m, d] = ds.split('-'); return `${d}/${m}/${y}`; };
const fmtDayMonth = (ds: string) => { const [, m, d] = ds.split('-'); return `${d}/${m}`; };
const monthOf = (ds: string) => {
    const [y, m] = ds.split('-').map(Number);
    return { year: y || new Date().getFullYear(), month: (m || 1) - 1 };
};
const fmtClock = (secs: number) => {
    const s = Math.max(0, secs);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtTimeSp = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const samePattern = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

// ─── Preço (espelho de POST /contracts/custom — o backend continua autoritativo) ──
const applyDiscount = (value: number, pct: number) => Math.round(value * (1 - pct / 100));

interface Volume { totalSessions: number; sessionsPerWeek: number; sessionsPerCycle: number }
/** Mesmo cálculo de computeCustomVolume (backend/src/utils/pricing.ts). */
function computeVolume(frequency: Frequency, months: number, daysCount: number, weekPatternCount: number, customDatesCount: number): Volume {
    const m = Math.max(1, months);
    if (frequency === 'CUSTOM') {
        return {
            totalSessions: customDatesCount,
            sessionsPerWeek: Math.round(customDatesCount / (m * 4)),
            sessionsPerCycle: Math.round(customDatesCount / m),
        };
    }
    const sessionsPerCycle = frequency === 'BIWEEKLY' ? daysCount * 2
        : frequency === 'MONTHLY' ? daysCount * weekPatternCount
            : daysCount * 4;
    return { totalSessions: sessionsPerCycle * m, sessionsPerWeek: daysCount, sessionsPerCycle };
}

interface QuoteAddon { price: number; mode: 'all' | 'credits'; perCycle: number }
interface Quote extends Volume {
    discountPct: number;
    discountedSessionPrice: number;
    cycleBaseAmount: number;
    addonsPerCycle: number;
    cycleAmount: number;
    /** Parcelas do plano Mensal (Datas Livres: total exato com o resto na última). */
    monthlyInstallments: number[];
    /** Total do contrato sem o desconto PIX. */
    contractTotal: number;
    fullPix: number;
    /** Total do plano escolhido (Integral+PIX já com o desconto PIX). */
    planTotal: number;
    /** 1ª cobrança antes do cupom (Integral = total; Mensal = 1ª parcela). */
    firstChargeBase: number;
}
function computeQuote(args: {
    basePrice: number; volume: Volume; frequency: Frequency; months: number; addons: QuoteAddon[];
    discount: { ep3: number; ep6: number; d3: number; d6: number }; pixPct: number;
    plan: PaymentPlan; method: PaymentMethodKey | null;
}): Quote {
    const { volume, frequency, discount, pixPct } = args;
    const months = Math.max(1, args.months);
    const { totalSessions, sessionsPerCycle } = volume;
    // Desconto por nº de gravações do plano (mesma régua do backend, valores da config).
    const discountPct = totalSessions >= discount.ep6 ? discount.d6 : totalSessions >= discount.ep3 ? discount.d3 : 0;
    const discountedSessionPrice = applyDiscount(args.basePrice, discountPct);
    const cycleBaseAmount = sessionsPerCycle * discountedSessionPrice;
    let addonsPerCycle = 0;
    for (const a of args.addons) {
        addonsPerCycle += a.mode === 'credits' && a.perCycle > 0
            ? applyDiscount(a.price * a.perCycle, discountPct)
            : applyDiscount(a.price * sessionsPerCycle, discountPct);
    }
    const cycleAmount = cycleBaseAmount + addonsPerCycle;
    let contractTotal: number;
    let monthlyInstallments: number[];
    if (frequency === 'CUSTOM') {
        let addonsExact = 0;
        for (const a of args.addons) {
            addonsExact += a.mode === 'credits' && a.perCycle > 0
                ? applyDiscount(a.price * a.perCycle * months, discountPct)
                : applyDiscount(a.price * totalSessions, discountPct);
        }
        contractTotal = discountedSessionPrice * totalSessions + addonsExact;
        const per = Math.floor(contractTotal / months);
        monthlyInstallments = Array.from({ length: months }, (_, i) => (i === months - 1 ? contractTotal - per * (months - 1) : per));
    } else {
        contractTotal = cycleAmount * months;
        monthlyInstallments = Array.from({ length: months }, () => cycleAmount);
    }
    const fullPix = Math.round(contractTotal * (1 - pixPct / 100));
    const planTotal = args.plan === 'FULL' ? (args.method === 'PIX' ? fullPix : contractTotal) : contractTotal;
    const firstChargeBase = args.plan === 'FULL' ? planTotal : (monthlyInstallments[0] ?? 0);
    return {
        ...volume, discountPct, discountedSessionPrice, cycleBaseAmount, addonsPerCycle, cycleAmount,
        monthlyInstallments, contractTotal, fullPix, planTotal, firstChargeBase,
    };
}

function tierLabel(t: string, pricing: PricingConfig[]) {
    return pricing.find(p => p.tier === t)?.label || TIER_META[t]?.label || t;
}

export default function CustomContractFlow({ mode, pricing, users = [], onClose, onCreated }: CustomContractFlowProps) {
    const isAdmin = mode === 'admin';
    const uid = useId();
    const { user, updateUser } = useAuth();
    const { showToast } = useUI();
    // Modo equipe (D7): o contrato nasce ATIVO com a 1ª cobrança em aberto; o sheet "Cobrar agora" só abre
    // com "Cobrar o cliente" (cobrancas.cobrar) — sem ela, a cobrança fica pendente (o cliente paga pelo app).
    const { can } = usePermission();
    const staffCanCharge = isAdmin && can('cobrancas.cobrar');
    const { get: getRule } = useBusinessConfig();
    const { step, next, back, goTo, isLast } = useWizardStep(STEPS.length);

    // Cliente: início fixo "amanhã" (SP). Estado (não memo): recalculado a cada envio — se o assistente
    // atravessar a meia-noite, o início anda junto e o resumo se atualiza (senão o servidor recusaria tudo).
    const [tomorrow, setTomorrow] = useState(() => addDaysStr(todayStrSaoPaulo(), 1));
    const tierOptions = useMemo(() => {
        const listed = ALL_TIERS.filter(t => pricing.some(p => p.tier === t));
        return listed.length > 0 ? listed : ALL_TIERS;
    }, [pricing]);

    // ── Etapa 1: plano ──
    const [userId, setUserId] = useState('');
    const [name, setName] = useState('');
    const [tier, setTier] = useState<ContractTier>(() => (tierOptions.includes('COMERCIAL') ? 'COMERCIAL' : tierOptions[0]));
    const [durationMonths, setDurationMonths] = useState(3);
    const [startDate, setStartDate] = useState(tomorrow);
    // ── Etapa 2: agenda ──
    const [frequency, setFrequency] = useState<Frequency>('WEEKLY');
    const [weekPattern, setWeekPattern] = useState<number[]>([1, 3]);
    const [selectedDays, setSelectedDays] = useState<number[]>([]);
    const [dayTimes, setDayTimes] = useState<Record<number, string>>({});
    const [customDates, setCustomDates] = useState<CustomDate[]>([]);
    const [calMonth, setCalMonth] = useState(() => monthOf(tomorrow));
    // ── Etapa 3: serviços ──
    const [addons, setAddons] = useState<AddOnConfig[]>([]);
    const [addonsLoading, setAddonsLoading] = useState(true);
    const [addonsError, setAddonsError] = useState(false);
    const [addonConfig, setAddonConfig] = useState<Record<string, AddonChoice>>({});
    // ── Etapa 4: resumo ──
    const [paymentPlan, setPaymentPlan] = useState<PaymentPlan>('MONTHLY');
    const [paymentMethod, setPaymentMethod] = useState<PaymentMethodKey | null>(null);
    const [appliedCoupon, setAppliedCoupon] = useState<CouponValidation | null>(null);
    const [acceptedTerms, setAcceptedTerms] = useState(false);
    // ── Envio ──
    const [phase, setPhase] = useState<Phase>('form');
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState('');
    /** Ação oferecida junto de um erro específico (só aparece enquanto ESSE erro estiver na tela). */
    const [errorAction, setErrorAction] = useState<{ msg: string; kind: 'contracts' } | null>(null);
    const [conflicts, setConflicts] = useState<CustomConflict[]>([]);
    const [totalConflicts, setTotalConflicts] = useState(0);
    const [created, setCreated] = useState<CreatedContract | null>(null);
    const [chargeError, setChargeError] = useState('');
    const [checkoutError, setCheckoutError] = useState('');
    /**
     * CPF/CNPJ antes do PIX (cliente). resolutions null = ainda falta checar a agenda; senão refaz a
     * criação com as mesmas trocas e o MESMO início usado no check.
     */
    const [cpfPrompt, setCpfPrompt] = useState<{ resolutions: Resolution[] | null; start: string } | null>(null);
    const [exitOpen, setExitOpen] = useState(false);
    /** Envio em andamento (check/criação). Trava por ESTADO da requisição — nunca por tempo. */
    const inFlight = useRef(false);
    /** Início usado no último check: a criação (aceite dos conflitos) usa exatamente o mesmo. */
    const checkedStart = useRef('');
    /** "Amanhã" do servidor (400 START_DATE_TOMORROW) e quando chegou. */
    const serverTomorrow = useRef<{ date: string; at: number } | null>(null);

    const slotGrid = useContractSlotGrid(tier);

    const loadAddons = () => {
        setAddonsLoading(true);
        setAddonsError(false);
        pricingApi.getAddons()
            .then(res => setAddons(res.addons))
            .catch(() => setAddonsError(true))
            .finally(() => setAddonsLoading(false));
    };
    useEffect(loadAddons, []);
    // E3: o admin revalida a chave-mestra do boleto ao abrir (o cache é carregado uma vez por sessão).
    useEffect(() => { if (isAdmin) void loadPaymentMethods(); }, [isAdmin]);

    // ── Derivados ──────────────────────────────────────────
    const clientOptions = useMemo(
        () => users.filter(u => u.role === 'CLIENTE' && !u.deletedAt).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
        [users],
    );
    const selectedClient = clientOptions.find(u => u.id === userId) ?? null;
    const effectiveStart = isAdmin ? startDate : tomorrow;
    const startValid = isDateStr(effectiveStart);
    const periodEnd = startValid ? addMonthsStr(effectiveStart, durationMonths) : effectiveStart; // exclusivo
    const inPeriod = (ds: string) => startValid && ds >= effectiveStart && ds < periodEnd;
    const allowedDays = slotGrid.allowedDays.filter(d => d >= 1 && d <= 6);
    const durations = isAdmin ? ADMIN_DURATIONS : CLIENT_DURATIONS;

    const eligibleAddons = addons.filter(a => !a.monthly && a.active !== false);
    const volume = computeVolume(frequency, durationMonths, selectedDays.length, weekPattern.length, customDates.length);
    const creditMax = isAdmin ? ADMIN_CREDIT_MAX : Math.max(1, volume.sessionsPerCycle);
    const clampCredits = (n: number) => Math.min(creditMax, Math.max(1, Math.round(n) || 1));
    const activeAddons = eligibleAddons.flatMap(a => {
        const c = addonConfig[a.key];
        if (!c || c.mode === 'none') return [];
        return [{ addon: a, mode: c.mode, perCycle: clampCredits(c.perCycle) }];
    });

    // E3 — formas de pagamento. Admin: as ativas, e o BOLETO só quando a chave-mestra está ligada E a Cora
    // ativa (o cache só traz BOLETO com boleto.available). Cliente: nunca boleto (reserva de 10 minutos).
    usePaymentMethodsVersion();
    const methodOptions: PaymentMethodConfig[] = (() => {
        if (isAdmin) return getPaymentMethods();
        const all = getClientPaymentMethods();
        const inCtx = all.filter(m => methodInContext(m, 'contract'));
        return inCtx.length > 0 ? inCtx : all;
    })();
    const method = paymentMethod && methodOptions.some(m => m.key === paymentMethod) ? paymentMethod : null;
    const pixPct = getRule('pix_extra_discount_pct');
    const ep3 = getRule('episodes_3months');
    const ep6 = getRule('episodes_6months');
    const quote = computeQuote({
        basePrice: pricing.find(p => p.tier === tier)?.price ?? 0,
        volume,
        frequency,
        months: durationMonths,
        addons: activeAddons.map(x => ({ price: x.addon.price, mode: x.mode as 'all' | 'credits', perCycle: x.perCycle })),
        discount: { ep3, ep6, d3: getRule('discount_3months'), d6: getRule('discount_6months') },
        pixPct,
        plan: paymentPlan,
        method,
    });
    const basePrice = pricing.find(p => p.tier === tier)?.price ?? 0;
    const estimatedFirstCharge = appliedCoupon ? appliedCoupon.finalAmount : quote.firstChargeBase;
    // Integral no cartão: "em até Nx sem juros" só se o GATEWAY parcela (conta Stripe BR não parcela →
    // só 1x). Volta a aparecer sozinho quando o gateway parcelar.
    const fullCardInstallments = useCardInstallments({
        amount: quote.contractTotal,
        durationMonths,
        enabled: paymentPlan === 'FULL' && methodOptions.some(m => m.key === 'CARTAO'),
    });
    const fullCardFreeMax = Math.min(fullCardInstallments.freeCount, fullCardInstallments.maxCount, durationMonths);

    const scheduleItems = selectedDays.map(day => ({ day, time: dayTimes[day] ?? '' }));
    const slotLabel = (dow: number, time: string) => {
        const slot = slotGrid.slotsFor(dow).find(s => s.time === time);
        return slot ? formatSlotRange(slot) : time;
    };

    // ── Validação por etapa (o envio revalida TODAS) ────────
    const nameOk = name.trim().length >= 2;
    const canStep1 = (!isAdmin || !!selectedClient) && nameOk && startValid;
    const gridReady = !!slotGrid.grid && !slotGrid.error;
    const patternOk = frequency === 'BIWEEKLY' || frequency === 'MONTHLY' ? weekPattern.length > 0 : true;
    const scheduleOk = selectedDays.length > 0 && scheduleItems.every(s => slotGrid.isValidSlot(s.day, s.time));
    const customOk = customDates.length > 0 && customDates.every(cd => inPeriod(cd.date) && slotGrid.isValidSlot(weekdayOf(cd.date), cd.time));
    const canStep2 = gridReady && volume.totalSessions > 0 && (frequency === 'CUSTOM' ? customOk : scheduleOk && patternOk);
    const canStep4 = !!method && (isAdmin || acceptedTerms);
    // FE-2 (modo equipe): cupom que zera a 1ª cobrança registra a parcela como paga — sem a baixa manual o
    // servidor recusa (403). "Criar contrato" fica desabilitado com a explicação, em vez do 403 genérico.
    const zeroCouponNeedsBaixa = isAdmin && !can('cobrancas.baixa') && !!appliedCoupon && appliedCoupon.finalAmount <= 0;

    const step1Hint = isAdmin && !selectedClient ? 'Escolha o cliente.'
        : !nameOk ? `Dê um nome ao ${isAdmin ? 'contrato' : 'projeto'} (pelo menos 2 letras).`
            : !startValid ? 'Informe a data de início.' : '';
    const step2Hint = slotGrid.loading ? 'Carregando os horários…'
        : slotGrid.error ? 'Não foi possível carregar os horários.'
            : frequency === 'CUSTOM'
                ? (customDates.length === 0 ? 'Escolha pelo menos uma data no calendário.' : 'Escolha o horário de cada data.')
                : selectedDays.length === 0 ? 'Escolha pelo menos um dia da semana.'
                    : !patternOk ? 'Escolha pelo menos uma semana do mês.' : 'Escolha o horário de cada dia.';
    const step4Hint = !method ? 'Escolha a forma de pagamento.' : !isAdmin && !acceptedTerms ? 'Aceite os termos para continuar.' : '';

    const busy = checking || phase === 'creating';

    // ── Handlers de formulário ──────────────────────────────
    const resetSchedule = () => { setSelectedDays([]); setDayTimes({}); setCustomDates([]); };
    const changeTier = (t: ContractTier) => {
        if (t === tier) return;
        setTier(t);
        resetSchedule();
    };
    const pruneDates = (start: string, months: number) => {
        if (!isDateStr(start)) return;
        const end = addMonthsStr(start, months);
        setCustomDates(prev => prev.filter(cd => cd.date >= start && cd.date < end));
    };
    const changeDuration = (m: number) => { setDurationMonths(m); pruneDates(effectiveStart, m); };
    const changeStartDate = (ds: string) => {
        setStartDate(ds);
        if (isDateStr(ds)) { pruneDates(ds, durationMonths); setCalMonth(monthOf(ds)); }
    };
    const changeFrequency = (f: Frequency) => {
        if (f === frequency) return;
        setFrequency(f);
        if (f === 'BIWEEKLY') setWeekPattern(p => (samePattern(p, [2, 4]) ? [2, 4] : [1, 3]));
        else if (f === 'MONTHLY') setWeekPattern(p => (p.length > 0 ? p : [1]));
    };
    const toggleDay = (day: number) => {
        if (selectedDays.includes(day)) {
            setSelectedDays(prev => prev.filter(d => d !== day));
            setDayTimes(prev => { const n = { ...prev }; delete n[day]; return n; });
            return;
        }
        const first = slotGrid.slotsFor(day)[0]?.time ?? '';
        setSelectedDays(prev => [...prev, day].sort((a, b) => a - b));
        setDayTimes(prev => ({ ...prev, [day]: first }));
    };
    const toggleMonthlyWeek = (wk: number) => {
        setWeekPattern(p => (p.includes(wk) ? p.filter(w => w !== wk) : [...p, wk].sort((a, b) => a - b)));
    };
    const toggleDate = (ds: string) => {
        const first = slotGrid.slotsFor(weekdayOf(ds))[0]?.time ?? '';
        setCustomDates(prev => (prev.some(cd => cd.date === ds)
            ? prev.filter(cd => cd.date !== ds)
            : [...prev, { date: ds, time: first }].sort((a, b) => a.date.localeCompare(b.date))));
    };
    const setDateTime = (ds: string, time: string) => setCustomDates(prev => prev.map(cd => (cd.date === ds ? { ...cd, time } : cd)));
    const setAddonMode = (key: string, m: AddonMode) => setAddonConfig(prev => ({
        ...prev,
        [key]: { mode: m, perCycle: clampCredits(prev[key]?.perCycle ?? Math.min(4, creditMax)) },
    }));
    const setAddonCredits = (key: string, n: number) => setAddonConfig(prev => ({ ...prev, [key]: { mode: 'credits', perCycle: clampCredits(n) } }));

    // ── Envio ───────────────────────────────────────────────
    const finish = () => { onCreated(); onClose(); };
    /** Uma chamada por vez: um 2º clique enquanto a 1ª requisição está em voo é ignorado. */
    const withLock = async (fn: () => Promise<void>) => {
        if (inFlight.current) return;
        inFlight.current = true;
        try { await fn(); } finally { inFlight.current = false; }
    };

    const schedulePayload = frequency === 'CUSTOM' ? [] : scheduleItems;
    const weekPatternPayload = frequency === 'BIWEEKLY' || frequency === 'MONTHLY' ? [...weekPattern].sort((a, b) => a - b) : undefined;
    const customDatesPayload = frequency === 'CUSTOM' ? customDates : undefined;

    /**
     * Início para ESTE envio. Admin: a data escolhida. Cliente: "amanhã" recalculado agora (o estado é
     * atualizado para o resumo acompanhar; o valor devolvido vale já neste clique).
     */
    /** "Amanhã" (SP) agora. O informado pelo servidor num 400 recente vale mais que o relógio do aparelho. */
    const currentTomorrow = (): string => {
        const server = serverTomorrow.current;
        return server && Date.now() - server.at < SERVER_TOMORROW_TTL_MS ? server.date : addDaysStr(todayStrSaoPaulo(), 1);
    };
    const startForSubmit = (): string => {
        if (isAdmin) return startDate;
        const fresh = currentTomorrow();
        if (fresh !== tomorrow) setTomorrow(fresh);
        return fresh;
    };

    const buildCreatePayload = (resolutions: Resolution[], start: string): CustomContractData => {
        const addOns = activeAddons.map(x => x.addon.key);
        const addonConfigPayload: Record<string, { mode: 'all' | 'credits'; perCycle?: number }> = {};
        for (const x of activeAddons) {
            addonConfigPayload[x.addon.key] = x.mode === 'credits' ? { mode: 'credits', perCycle: x.perCycle } : { mode: 'all' };
        }
        return {
            ...(isAdmin ? { userId } : {}),
            name: name.trim(),
            tier,
            durationMonths,
            startDate: start,
            frequency,
            schedule: schedulePayload,
            weekPattern: weekPatternPayload,
            customDates: customDatesPayload,
            paymentMethod: method as PaymentMethodKey,
            paymentPlan,
            addOns: addOns.length > 0 ? addOns : undefined,
            addonConfig: addOns.length > 0 ? addonConfigPayload : undefined,
            resolvedConflicts: resolutions.length > 0 ? resolutions : undefined,
            couponCode: appliedCoupon?.code || undefined,
        };
    };

    /**
     * Erro de API → etapa certa:
     *  - INVALID_SLOT (grade mudou) → recarrega a grade e volta à Agenda;
     *  - SLOTS_TAKEN / ALL_SLOTS_TAKEN (horário ocupado entre o check e a criação) → Agenda com a lista;
     *  - START_DATE_TOMORROW (virou o dia) → atualiza "amanhã" e fica no Resumo para reenviar;
     *  - CPF_CNPJ_REQUIRED (cliente) → prompt de CPF e refaz com as mesmas trocas/início;
     *  - CUSTOM_PREVIOUS_PAID / CUSTOM_PREVIOUS_INFLIGHT → a contratação anterior foi paga ou está em
     *    processamento: alerta + "Ver meus contratos";
     *  - demais (inclusive CUSTOM_IN_PROGRESS) → alerta no Resumo.
     */
    const handleApiError = (err: unknown, resolutions: Resolution[] | null, start: string) => {
        const code = err instanceof ApiError ? err.code : undefined;
        const msg = getErrorMessage(err) || 'Não foi possível concluir. Tente novamente.';
        setPhase('form');
        setErrorAction(null);
        if (code === 'INVALID_SLOT') slotGrid.invalidate();
        // E3: boleto recusado (chave desligada / Cora inativa / contratação com prazo) → revalida a chave;
        // a opção some das formas de pagamento e o aviso do servidor fica no Resumo.
        if (method === 'BOLETO' || code === 'BOLETO_UNAVAILABLE' || code === 'BOLETO_NOT_ALLOWED_HERE') void loadPaymentMethods();
        if (code === 'INVALID_SLOT' || code === 'SLOTS_TAKEN' || code === 'ALL_SLOTS_TAKEN') {
            goTo(2);
            setError(msg);
            return;
        }
        if (code === 'START_DATE_TOMORROW' && !isAdmin) {
            const serverStart = err instanceof ApiError ? err.details?.startDate : undefined;
            const next = typeof serverStart === 'string' && isDateStr(serverStart) ? serverStart : addDaysStr(todayStrSaoPaulo(), 1);
            if (next === serverStart) serverTomorrow.current = { date: next, at: Date.now() };
            setTomorrow(next);
            goTo(STEPS.length);
            setError(msg);
            return;
        }
        if (code === 'CPF_CNPJ_REQUIRED' && !isAdmin) {
            setError('');
            setCpfPrompt({ resolutions, start });
            return;
        }
        if ((code === 'CUSTOM_PREVIOUS_PAID' || code === 'CUSTOM_PREVIOUS_INFLIGHT') && !isAdmin) setErrorAction({ msg, kind: 'contracts' });
        setError(msg);
    };

    const createContract = async (resolutions: Resolution[], start: string) => {
        setPhase('creating');
        setError('');
        try {
            const res = await contractsApi.createCustom(buildCreatePayload(resolutions, start));
            const first = res.payments?.[0];
            const deadline = res.paymentDeadline ?? null;
            const info: CreatedContract = {
                firstPaymentId: res.firstPaymentId ?? first?.id ?? null,
                firstAmount: first?.amount ?? 0,
                firstPending: !!first && first.status === 'PENDING' && first.amount > 0,
                status: res.status ?? res.contract?.status ?? (isAdmin ? 'ACTIVE' : 'AWAITING_PAYMENT'),
                paymentDeadline: deadline,
                reservedMinutes: deadline
                    ? Math.max(1, Math.round((new Date(deadline).getTime() - Date.now()) / 60000))
                    : DEFAULT_RESERVE_MINUTES,
                skipped: res.skipped ?? [],
                totalBookings: res.summary?.totalBookingsGenerated ?? 0,
                discountPct: res.summary?.discountPct ?? quote.discountPct,
            };
            setCreated(info);
            setChargeError('');
            setCheckoutError('');
            if (isAdmin) {
                setPhase(staffCanCharge && info.firstPaymentId && info.firstPending ? 'charge' : 'success');
            } else {
                setPhase(info.status === 'AWAITING_PAYMENT' && info.firstPaymentId && info.firstPending ? 'checkout' : 'success');
            }
        } catch (err) {
            handleApiError(err, resolutions, start);
        }
    };

    const runCheck = async (start: string) => {
        setChecking(true);
        setError('');
        checkedStart.current = start;
        try {
            const res = await contractsApi.checkCustom({
                tier,
                durationMonths,
                startDate: start,
                schedule: schedulePayload,
                frequency,
                weekPattern: weekPatternPayload,
                customDates: customDatesPayload,
                // Admin: o backend descarta tentativas vencidas (AWAITING_PAYMENT) do cliente-alvo antes do check.
                // Cliente: descarta a tentativa anterior dele (viva ou vencida) — a nova a substitui.
                ...(isAdmin && userId ? { userId } : {}),
            });
            if (!res.available && res.conflicts.length > 0) {
                setConflicts(res.conflicts);
                setTotalConflicts(Math.max(res.totalConflicts ?? 0, res.conflicts.length));
                setPhase('conflicts');
                return;
            }
            await createContract([], start);
        } catch (err) {
            handleApiError(err, null, start);
        } finally {
            setChecking(false);
        }
    };

    /** O cliente paga PIX/boleto em nome próprio → exige CPF/CNPJ válido (confere no servidor antes de pedir). */
    const clientHasDocument = async () => {
        if (isValidCpfCnpj(user?.cpfCnpj)) return true;
        try {
            const { user: fresh } = await authApi.me();
            updateUser(fresh);
            return isValidCpfCnpj(fresh?.cpfCnpj);
        } catch {
            return false;
        }
    };

    const handleSubmit = () => withLock(async () => {
        // Guard anti-submit espúrio: só a última etapa envia, e nunca duas vezes.
        if (!isLast || phase !== 'form' || busy) return;
        if (!canStep1) { goTo(1); setError(step1Hint || 'Revise os dados do plano.'); return; }
        if (!canStep2) { goTo(2); setError(step2Hint || 'Revise a agenda.'); return; }
        if (!canStep4) { setError(step4Hint); return; }
        setError('');
        setErrorAction(null);
        const start = startForSubmit();
        const needsDocument = !isAdmin && (method === 'PIX' || method === 'BOLETO') && estimatedFirstCharge > 0;
        if (needsDocument) {
            setChecking(true);
            const ok = await clientHasDocument();
            setChecking(false);
            if (!ok) { setCpfPrompt({ resolutions: null, start }); return; }
        }
        await runCheck(start);
    });

    const acceptConflicts = () => withLock(async () => {
        if (phase !== 'conflicts' || busy) return;
        // Só aceita quando TODA ocorrência em conflito tem sugestão (o backend recusa qualquer pulada).
        if (conflicts.some(c => !c.suggestedReplacement) || totalConflicts > conflicts.length) return;
        const start = checkedStart.current;
        // Cliente: se virou o dia desde o check, as datas simuladas não valem mais → refazer pelo Resumo.
        if (!isAdmin) {
            const fresh = currentTomorrow();
            if (fresh !== start) {
                setTomorrow(fresh);
                setPhase('form');
                goTo(STEPS.length);
                setError(`Virou o dia: o plano agora começa em ${fmtDate(fresh)}. Confira o resumo e envie de novo.`);
                return;
            }
        }
        const resolutions: Resolution[] = conflicts
            .filter(c => c.suggestedReplacement)
            .map(c => ({
                originalDate: c.date,
                originalTime: c.originalTime,
                newDate: c.suggestedReplacement!.date,
                newTime: c.suggestedReplacement!.time,
            }));
        await createContract(resolutions, start);
    });

    const handleExpire = () => {
        setExitOpen(false);
        setCreated(null);
        setCheckoutError('');
        setPhase('form');
        goTo(STEPS.length);
        setError('O tempo para pagamento acabou e a reserva dos horários foi desfeita. Revise o resumo e tente novamente em instantes.');
    };
    const remaining = useCountdown(phase === 'checkout' ? created?.paymentDeadline ?? null : null, handleExpire);

    const requestClose = () => {
        if (busy) return;
        if (phase === 'checkout') { setExitOpen(true); return; }
        if (phase === 'success') { finish(); return; }
        onClose();
    };

    // ── Admin: cobrança da 1ª parcela (substitui o wizard) ──
    if (staffCanCharge && phase === 'charge' && created?.firstPaymentId) {
        const skippedNote = created.skipped.length > 0
            ? ` ${plural(created.skipped.length, 'ocorrência pulada', 'ocorrências puladas')} por conflito.`
            : '';
        return (
            <ChargeNowSheet
                paymentId={created.firstPaymentId}
                amount={created.firstAmount}
                description={`${name.trim() || 'Contrato personalizado'} · ${paymentPlan === 'FULL' ? 'pagamento integral' : '1ª parcela'}`}
                title={paymentPlan === 'FULL' ? 'Cobrar pagamento integral' : 'Cobrar 1ª cobrança'}
                subtitle={`Contrato criado e ativo.${skippedNote} Cobre agora no PIX ou no cartão do cliente (crédito ou débito), com ele presente — ou deixe pendente: o cliente paga depois.`}
                // E1: sempre PIX | Cartão (| Boleto quando disponível), abrindo na forma escolhida no Resumo.
                initialMethod={method}
                context="contract"
                contractDuration={paymentPlan === 'FULL' ? durationMonths : 1}
                client={selectedClient ? { id: selectedClient.id, name: selectedClient.name, cpfCnpj: selectedClient.cpfCnpj } : undefined}
                error={chargeError || undefined}
                onError={setChargeError}
                onSuccess={() => { showToast({ type: 'success', message: 'Pagamento confirmado!' }); finish(); }}
                onDismiss={() => { showToast({ type: 'success', message: 'Contrato criado (pagamento pendente).' }); finish(); }}
            />
        );
    }

    // ── Blocos de UI ────────────────────────────────────────
    const headTitle = isAdmin ? 'Contrato Personalizado' : 'Plano Personalizado';
    const headSubtitle = phase === 'conflicts' ? 'Alguns horários já estão ocupados'
        : phase === 'creating' ? (isAdmin ? 'Criando o contrato' : 'Reservando seus horários')
            : phase === 'checkout' ? 'Pagamento para confirmar o plano'
                : phase === 'success' ? 'Tudo certo'
                    : isAdmin ? 'Monte um plano sob medida para o cliente' : 'Monte seu plano com os dias e horários que preferir';

    const discountMeter = (() => {
        const total = volume.totalSessions;
        const nextTarget = total < ep3 ? ep3 : total < ep6 ? ep6 : null;
        const nextPct = nextTarget === ep3 ? getRule('discount_3months') : getRule('discount_6months');
        const progress = ep6 > 0 ? Math.min(1, total / ep6) : 1;
        const fillClass = quote.discountPct > 0 && total >= ep6 ? ' ccf-meter__fill--max' : quote.discountPct > 0 ? ' ccf-meter__fill--mid' : '';
        return (
            <div className="ccf-meter" aria-live="polite">
                <div className="ccf-meter__head">
                    <span className="ccf-meter__title">{plural(total, 'gravação', 'gravações')} no plano</span>
                    <span className={`ccf-meter__value${quote.discountPct > 0 ? ' ccf-meter__value--on' : ''}`}>
                        {quote.discountPct > 0 ? `${quote.discountPct}% de desconto` : 'Sem desconto'}
                    </span>
                </div>
                <div className="ccf-meter__bar" aria-hidden="true">
                    <div className={`ccf-meter__fill${fillClass}`} style={{ '--ccf-progress': progress } as CSSProperties} />
                </div>
                <div className="ccf-meter__hint">
                    {nextTarget
                        ? `Faltam ${plural(nextTarget - total, 'gravação', 'gravações')} para ${nextPct}% de desconto (a partir de ${nextTarget}).`
                        : 'Desconto máximo por volume alcançado.'}
                </div>
                <div className="ccf-stats">
                    {frequency !== 'CUSTOM' && (
                        <div className="ccf-stat">
                            <div className="ccf-stat__num">{volume.sessionsPerWeek}</div>
                            <div className="ccf-stat__label">por semana</div>
                        </div>
                    )}
                    <div className="ccf-stat">
                        <div className="ccf-stat__num">{volume.sessionsPerCycle}</div>
                        <div className="ccf-stat__label">por ciclo</div>
                    </div>
                    <div className="ccf-stat">
                        <div className="ccf-stat__num ccf-stat__num--accent">{formatBRL(quote.discountedSessionPrice)}</div>
                        <div className="ccf-stat__label">por gravação</div>
                    </div>
                </div>
            </div>
        );
    })();

    // Rodapé logo depois do conteúdo da etapa (a etapa abraça o conteúdo; no desktop o dialog fica
    // ancorado no topo — desktopAnchor="top" — e o cabeçalho não pula). Sticky no fim da área rolável
    // quando a etapa é maior que a tela. O 2º clique de um clique duplo em "Próximo" que cair fora do
    // sheet é ignorado pelo overlay (e.detail > 1); o envio (etapa 4) e o "Aceitar sugestões" também
    // ignoram o 2º clique (e.detail > 1).
    const actions = (left: ReactNode, right: ReactNode, hint?: string) => (
        <div className="ccf-footer">
            <p className="ccf-hint" aria-live="polite">{hint ?? ''}</p>
            <div className="admin-actions-row admin-actions-row--between">
                {left}
                {right}
            </div>
        </div>
    );

    const renderStep1 = () => (
        <div className="ccf-step">
            {isAdmin && (
                <div className="ccf-section admin-field">
                    <label className="admin-field__label" htmlFor={`${uid}-client`}>Cliente *</label>
                    <div className="admin-input-icon">
                        <UserRound size={14} aria-hidden="true" />
                        <select
                            id={`${uid}-client`}
                            className="form-input form-input--raised"
                            value={userId}
                            onChange={e => { setUserId(e.target.value); setAppliedCoupon(null); }}
                        >
                            <option value="">Selecione um cliente…</option>
                            {clientOptions.map(u => (
                                <option key={u.id} value={u.id}>{u.name}{u.email ? ` (${u.email})` : ''}</option>
                            ))}
                        </select>
                    </div>
                </div>
            )}

            <div className="ccf-section admin-field">
                <label className="admin-field__label" htmlFor={`${uid}-name`}>{isAdmin ? 'Nome do contrato *' : 'Nome do projeto *'}</label>
                <div className="admin-input-icon">
                    <NotebookPen size={14} aria-hidden="true" />
                    <input
                        id={`${uid}-name`}
                        className="form-input form-input--raised"
                        value={name}
                        maxLength={120}
                        onChange={e => setName(e.target.value)}
                        placeholder={isAdmin ? 'Ex.: Podcast Verão 2x/semana' : 'Ex.: Podcast de Tecnologia'}
                    />
                </div>
            </div>

            <div className="ccf-section" role="group" aria-labelledby={`${uid}-tier-label`}>
                <span className="admin-field__label ccf-section__label" id={`${uid}-tier-label`}>Faixa de horário</span>
                <div className="ccf-choices">
                    {tierOptions.map(t => {
                        const meta = TIER_META[t];
                        const Icon = meta?.icon;
                        const active = tier === t;
                        return (
                            <button
                                key={t}
                                type="button"
                                className={`ccf-choice${active ? ' ccf-choice--active' : ''}`}
                                style={{ '--ccf-color': meta?.color } as CSSProperties}
                                aria-pressed={active}
                                onClick={() => changeTier(t)}
                            >
                                <span className="ccf-choice__head">
                                    {Icon && <Icon size={18} aria-hidden="true" />}
                                    {tierLabel(t, pricing)}
                                    {active && <Check size={16} className="ccf-choice__check" aria-hidden="true" />}
                                </span>
                                <span className="ccf-choice__desc">{TIER_HINT[t]}</span>
                                <span className="ccf-choice__price">{formatBRL(pricing.find(p => p.tier === t)?.price ?? 0)} por gravação</span>
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="ccf-section" role="group" aria-labelledby={`${uid}-dur-label`}>
                <span className="admin-field__label ccf-section__label" id={`${uid}-dur-label`}>Duração</span>
                <p className="ccf-section__help">1 ciclo = 4 semanas de gravação, cobrado a cada ciclo no plano mensal.</p>
                <div className="ccf-pill-grid">
                    {durations.map(m => (
                        <button
                            key={m}
                            type="button"
                            className={`ccf-pill${durationMonths === m ? ' ccf-pill--active' : ''}`}
                            aria-pressed={durationMonths === m}
                            aria-label={plural(m, 'ciclo', 'ciclos')}
                            onClick={() => changeDuration(m)}
                        >
                            <span className="ccf-pill__main">{m}</span>
                            <span className="ccf-pill__sub">{m === 1 ? 'ciclo' : 'ciclos'}</span>
                        </button>
                    ))}
                </div>
            </div>

            {isAdmin ? (
                <div className="ccf-section admin-field" style={{ maxWidth: 280 }}>
                    <label className="admin-field__label" htmlFor={`${uid}-start`}>Data de início</label>
                    <div className="admin-input-icon">
                        <CalendarDays size={14} aria-hidden="true" />
                        <input
                            id={`${uid}-start`}
                            type="date"
                            className="form-input form-input--raised"
                            value={startDate}
                            onChange={e => changeStartDate(e.target.value)}
                        />
                    </div>
                </div>
            ) : (
                <div className="ccf-section">
                    <span className="admin-field__label ccf-section__label">Início</span>
                    <div className="ccf-readonly">
                        <CalendarDays size={16} aria-hidden="true" />
                        <span>A partir de amanhã, {fmtDate(tomorrow)}</span>
                    </div>
                </div>
            )}

            {actions(
                <button key="cancel" type="button" className="btn-admin-ghost" onClick={onClose}>Cancelar</button>,
                <button key="next" type="button" className="btn-admin-go" disabled={!canStep1}
                    onClick={() => { if (canStep1) { setError(''); next(); } }}>
                    Próximo <ArrowRight size={16} aria-hidden="true" />
                </button>,
                canStep1 ? undefined : step1Hint,
            )}
        </div>
    );

    const renderGridState = () => {
        if (slotGrid.loading) {
            return (
                <p className="ccf-grid-state">
                    <BrandLoader size="inline" label="Carregando os horários da faixa…" />
                </p>
            );
        }
        if (slotGrid.error) {
            return (
                <div className="ccf-grid-state ccf-grid-state--error" role="alert">
                    <AlertCircle size={16} aria-hidden="true" />
                    <span>{slotGrid.error}</span>
                    <button key="retry-grid" type="button" className="btn-admin-ghost btn-admin-ghost--compact" onClick={slotGrid.invalidate}>
                        <RefreshCw size={14} aria-hidden="true" /> Tentar novamente
                    </button>
                </div>
            );
        }
        return null;
    };

    const renderCalendar = () => {
        const { year, month } = calMonth;
        const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
        const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
        const today = todayStrSaoPaulo();
        const cells: (string | null)[] = [...Array(firstDow).fill(null)];
        for (let d = 1; d <= daysInMonth; d++) {
            cells.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
        }
        const monthKey = (y: number, m: number) => y * 12 + m;
        const firstMonth = startValid ? monthOf(effectiveStart) : null;
        const lastMonth = startValid ? monthOf(addDaysStr(periodEnd, -1)) : null;
        const startKey = firstMonth ? monthKey(firstMonth.year, firstMonth.month) : -Infinity;
        const endKey = lastMonth ? monthKey(lastMonth.year, lastMonth.month) : Infinity;
        const curKey = monthKey(year, month);
        const go = (delta: number) => setCalMonth(({ year: y, month: m }) => {
            const k = monthKey(y, m) + delta;
            return { year: Math.floor(k / 12), month: k % 12 };
        });
        return (
            <div className="ccf-cal">
                <div className="ccf-cal__nav">
                    <Tooltip key="cal-prev" content="Mês anterior" describe={false}>
                        <span style={{ display: 'inline-flex' }}>
                            <button type="button" className="ccf-cal__navbtn" aria-label="Mês anterior"
                                disabled={curKey <= startKey} onClick={() => go(-1)}>
                                <ChevronLeft size={18} aria-hidden="true" />
                            </button>
                        </span>
                    </Tooltip>
                    <span className="ccf-cal__month" aria-live="polite">{MONTH_NAMES[month]} {year}</span>
                    <Tooltip key="cal-next" content="Próximo mês" describe={false}>
                        <span style={{ display: 'inline-flex' }}>
                            <button type="button" className="ccf-cal__navbtn" aria-label="Próximo mês"
                                disabled={curKey >= endKey} onClick={() => go(1)}>
                                <ChevronRight size={18} aria-hidden="true" />
                            </button>
                        </span>
                    </Tooltip>
                </div>
                <div className="ccf-cal__grid" role="group" aria-label={`Datas de ${MONTH_NAMES[month]} de ${year}`}>
                    {DAY_NAMES.map(d => <div key={`dow-${d}`} className="ccf-cal__dow" aria-hidden="true">{d}</div>)}
                    {cells.map((ds, i) => {
                        if (!ds) return <div key={`empty-${i}`} aria-hidden="true" />;
                        const dow = weekdayOf(ds);
                        const inRange = inPeriod(ds);
                        const allowed = allowedDays.includes(dow);
                        const selected = customDates.some(cd => cd.date === ds);
                        const enabled = selected || (inRange && allowed && gridReady);
                        const dayNum = Number(ds.slice(8));
                        const reason = !inRange ? 'fora do período' : !allowed ? `sem gravação da faixa ${tierLabel(tier, pricing)}` : selected ? 'selecionada' : 'disponível';
                        return (
                            <button
                                key={ds}
                                type="button"
                                className={[
                                    'ccf-cal__day',
                                    selected ? 'ccf-cal__day--selected' : '',
                                    ds === today ? 'ccf-cal__day--today' : '',
                                    inRange && !allowed ? 'ccf-cal__day--blocked' : '',
                                ].filter(Boolean).join(' ')}
                                disabled={!enabled}
                                aria-pressed={selected}
                                aria-label={`${dayNum} de ${MONTH_NAMES[month]}, ${DAY_NAMES_FULL[dow]}: ${reason}`}
                                onClick={() => toggleDate(ds)}
                            >
                                {dayNum}
                            </button>
                        );
                    })}
                </div>
                <div className="ccf-cal__legend">
                    <span>Período: {startValid ? `${fmtDate(effectiveStart)} a ${fmtDate(addDaysStr(periodEnd, -1))}` : '—'}</span>
                    <span>Dias riscados não têm gravação nesta faixa.</span>
                </div>
            </div>
        );
    };

    const renderStep2 = () => (
        <div className="ccf-step">
            {isAdmin ? (
                <div className="ccf-section" role="group" aria-labelledby={`${uid}-freq-label`}>
                    <span className="admin-field__label ccf-section__label" id={`${uid}-freq-label`}>Frequência</span>
                    <div className="ccf-freq">
                        {FREQUENCIES.map(f => {
                            const Icon = f.icon;
                            const active = frequency === f.key;
                            return (
                                <button key={f.key} type="button" aria-pressed={active}
                                    className={`ccf-freq__btn${active ? ' ccf-freq__btn--active' : ''}`}
                                    onClick={() => changeFrequency(f.key)}>
                                    <Icon size={16} aria-hidden="true" />
                                    {f.label}
                                </button>
                            );
                        })}
                    </div>
                </div>
            ) : (
                <p className="ccf-section__help" style={{ margin: '0 0 var(--space-4)' }}>
                    Gravações <strong>toda semana</strong> nos dias e horários que você escolher, durante {plural(durationMonths, 'ciclo', 'ciclos')}.
                </p>
            )}

            {renderGridState()}

            {gridReady && frequency !== 'CUSTOM' && (
                <>
                    <div className="ccf-section" role="group" aria-labelledby={`${uid}-days-label`}>
                        <span className="admin-field__label ccf-section__label" id={`${uid}-days-label`}>Dias da semana</span>
                        {allowedDays.length === 0 ? (
                            <p className="ccf-grid-state">A faixa {tierLabel(tier, pricing)} não tem dias de gravação na grade atual.</p>
                        ) : (
                            <div className="ccf-pill-grid">
                                {allowedDays.map(day => {
                                    const sel = selectedDays.includes(day);
                                    return (
                                        <button key={`day-${day}`} type="button" aria-pressed={sel}
                                            aria-label={DAY_NAMES_FULL[day]}
                                            className={`ccf-pill${sel ? ' ccf-pill--active' : ''}`}
                                            onClick={() => toggleDay(day)}>
                                            <span className="ccf-pill__main">{DAY_NAMES[day]}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {frequency === 'BIWEEKLY' && (
                        <div className="ccf-section" role="group" aria-labelledby={`${uid}-bw-label`}>
                            <span className="admin-field__label ccf-section__label" id={`${uid}-bw-label`}>Padrão de semanas</span>
                            <div className="ccf-pill-grid ccf-pill-grid--wide">
                                {BIWEEKLY_PATTERNS.map(wp => {
                                    const sel = samePattern(weekPattern, wp.pattern);
                                    return (
                                        <button key={wp.label} type="button" aria-pressed={sel}
                                            className={`ccf-pill${sel ? ' ccf-pill--active' : ''}`}
                                            onClick={() => setWeekPattern(wp.pattern)}>
                                            <span className="ccf-pill__main">{wp.label}</span>
                                            <span className="ccf-pill__sub">{wp.sub}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {frequency === 'MONTHLY' && (
                        <div className="ccf-section" role="group" aria-labelledby={`${uid}-mw-label`}>
                            <span className="admin-field__label ccf-section__label" id={`${uid}-mw-label`}>Semanas do mês</span>
                            <div className="ccf-pill-grid">
                                {[1, 2, 3, 4].map(wk => {
                                    const sel = weekPattern.includes(wk);
                                    return (
                                        <button key={`wk-${wk}`} type="button" aria-pressed={sel}
                                            aria-label={`${wk}ª semana do mês`}
                                            className={`ccf-pill${sel ? ' ccf-pill--active' : ''}`}
                                            onClick={() => toggleMonthlyWeek(wk)}>
                                            <span className="ccf-pill__main">{wk}ª</span>
                                            <span className="ccf-pill__sub">semana</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {selectedDays.length > 0 && (
                        <div className="ccf-section">
                            <span className="admin-field__label ccf-section__label">Horário de cada dia</span>
                            {/* Um grupo por dia com as pílulas de horário (mesmo visual de "Dias da semana"). */}
                            <div className="ccf-day-slots">
                                {selectedDays.map(day => (
                                    <div key={`slot-${day}`} className="ccf-day-slots__group">
                                        <span className="ccf-day-slots__day" id={`${uid}-slot-${day}`}>{DAY_NAMES_FULL[day]}</span>
                                        <ContractSlotPicker
                                            variant="pills"
                                            tier={tier}
                                            dayOfWeek={day}
                                            value={dayTimes[day] ?? ''}
                                            label={`Horário de ${DAY_NAMES_FULL[day].toLowerCase()}`}
                                            onChange={time => setDayTimes(prev => ({ ...prev, [day]: time }))}
                                        />
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </>
            )}

            {gridReady && frequency === 'CUSTOM' && (
                <div className="ccf-section">
                    <span className="admin-field__label ccf-section__label">Selecione as datas</span>
                    {renderCalendar()}
                    {customDates.length > 0 && (
                        <div className="ccf-date-list" aria-label={`${plural(customDates.length, 'data selecionada', 'datas selecionadas')}`} role="group">
                            {customDates.map(cd => {
                                const dow = weekdayOf(cd.date);
                                return (
                                    <div key={cd.date} className="ccf-date-row">
                                        <span className="ccf-date-row__dow">{DAY_NAMES[dow]}</span>
                                        <span className="ccf-date-row__date">{fmtDate(cd.date)}</span>
                                        <ContractSlotPicker
                                            variant="select"
                                            tier={tier}
                                            dayOfWeek={dow}
                                            value={cd.time}
                                            label={`Horário de ${fmtDate(cd.date)}`}
                                            onChange={time => setDateTime(cd.date, time)}
                                        />
                                        <Tooltip key={`rm-${cd.date}`} content="Remover data" describe={false}>
                                            <button type="button" className="ccf-icon-btn"
                                                aria-label={`Remover data ${fmtDate(cd.date)}`} onClick={() => toggleDate(cd.date)}>
                                                <X size={16} aria-hidden="true" />
                                            </button>
                                        </Tooltip>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {gridReady && volume.totalSessions > 0 && <div className="ccf-section">{discountMeter}</div>}

            {actions(
                <button key="back" type="button" className="btn-admin-ghost" onClick={() => { setError(''); back(); }}>
                    <ArrowLeft size={16} aria-hidden="true" /> Voltar
                </button>,
                <button key="next" type="button" className="btn-admin-go" disabled={!canStep2}
                    onClick={() => { if (canStep2) { setError(''); next(); } }}>
                    Próximo <ArrowRight size={16} aria-hidden="true" />
                </button>,
                canStep2 ? undefined : step2Hint,
            )}
        </div>
    );

    const renderStep3 = () => (
        <div className="ccf-step">
            <p className="ccf-section__help" style={{ margin: '0 0 var(--space-4)' }}>
                Serviços por gravação, opcionais.{' '}
                {quote.discountPct > 0
                    ? <>O desconto de <strong>{quote.discountPct}%</strong> do plano vale também para eles.</>
                    : 'Planos a partir de ' + plural(ep3, 'gravação', 'gravações') + ' ganham desconto também nos serviços.'}
            </p>

            {addonsLoading ? (
                <p className="ccf-grid-state"><BrandLoader size="inline" label="Carregando serviços…" /></p>
            ) : addonsError ? (
                <div className="ccf-grid-state ccf-grid-state--error" role="alert">
                    <AlertCircle size={16} aria-hidden="true" />
                    <span>Não foi possível carregar os serviços. Você pode seguir sem eles.</span>
                    <button key="retry-addons" type="button" className="btn-admin-ghost btn-admin-ghost--compact" onClick={loadAddons}>
                        <RefreshCw size={14} aria-hidden="true" /> Tentar novamente
                    </button>
                </div>
            ) : eligibleAddons.length === 0 ? (
                <p className="ccf-grid-state">Nenhum serviço adicional disponível no momento.</p>
            ) : (
                <div className="ccf-addons">
                    {eligibleAddons.map(addon => {
                        const cfg = addonConfig[addon.key];
                        const addonMode: AddonMode = cfg?.mode ?? 'none';
                        const credits = clampCredits(cfg?.perCycle ?? Math.min(4, creditMax));
                        const unit = applyDiscount(addon.price, quote.discountPct);
                        const lineTotal = addonMode === 'credits'
                            ? applyDiscount(addon.price * credits, quote.discountPct)
                            : applyDiscount(addon.price * volume.sessionsPerCycle, quote.discountPct);
                        return (
                            <div key={addon.key} className={`ccf-addon${addonMode !== 'none' ? ' ccf-addon--on' : ''}`}>
                                <div className="ccf-addon__top">
                                    <div className="ccf-addon__info">
                                        <div className="ccf-addon__name" id={`${uid}-addon-${addon.key}`}>{addon.name}</div>
                                        {addon.description && <div className="ccf-addon__desc">{addon.description}</div>}
                                        <div className="ccf-addon__price">
                                            {quote.discountPct > 0 && <s>{formatBRL(addon.price)}</s>}
                                            {formatBRL(unit)} por gravação
                                        </div>
                                    </div>
                                    <div className="ccf-addon__modes" role="group" aria-labelledby={`${uid}-addon-${addon.key}`}>
                                        {(['none', 'all', 'credits'] as const).map(m => (
                                            <button key={`${addon.key}-${m}`} type="button" aria-pressed={addonMode === m}
                                                className={`ccf-addon__mode${addonMode === m ? ' ccf-addon__mode--active' : ''}`}
                                                onClick={() => setAddonMode(addon.key, m)}>
                                                {m === 'none' ? 'Não' : m === 'all' ? 'Todas' : 'Créditos'}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                {addonMode === 'all' && (
                                    <div className="ccf-addon__credits">
                                        <span>Em todas as gravações ({volume.sessionsPerCycle} por ciclo)</span>
                                        <span className="ccf-addon__line-total">+ {formatBRL(lineTotal)}/ciclo</span>
                                    </div>
                                )}
                                {addonMode === 'credits' && (
                                    <div className="ccf-addon__credits">
                                        <span id={`${uid}-cred-${addon.key}`}>Créditos por ciclo</span>
                                        <div className="ccf-stepper" role="group" aria-labelledby={`${uid}-cred-${addon.key}`}>
                                            <Tooltip key="dec" content="Diminuir créditos" describe={false}>
                                                <span style={{ display: 'inline-flex' }}>
                                                    <button type="button" className="ccf-stepper__btn" aria-label="Diminuir créditos"
                                                        disabled={credits <= 1} onClick={() => setAddonCredits(addon.key, credits - 1)}>−</button>
                                                </span>
                                            </Tooltip>
                                            <span className="ccf-stepper__value" aria-live="polite">{credits}</span>
                                            <Tooltip key="inc" content="Aumentar créditos" describe={false}>
                                                <span style={{ display: 'inline-flex' }}>
                                                    <button type="button" className="ccf-stepper__btn" aria-label="Aumentar créditos"
                                                        disabled={credits >= creditMax} onClick={() => setAddonCredits(addon.key, credits + 1)}>+</button>
                                                </span>
                                            </Tooltip>
                                        </div>
                                        <span className="ccf-addon__line-total">+ {formatBRL(lineTotal)}/ciclo</span>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {quote.addonsPerCycle > 0 && (
                <div className="ccf-summary" style={{ marginTop: 'var(--space-4)' }}>
                    <div className="ccf-summary__row"><span>Gravações por ciclo</span><span>{formatBRL(quote.cycleBaseAmount)}</span></div>
                    <div className="ccf-summary__row"><span>Serviços por ciclo</span><span>+ {formatBRL(quote.addonsPerCycle)}</span></div>
                    <div className="ccf-summary__row ccf-summary__row--total"><span>Total por ciclo</span><span>{formatBRL(quote.cycleAmount)}</span></div>
                </div>
            )}

            {actions(
                <button key="back" type="button" className="btn-admin-ghost" onClick={() => { setError(''); back(); }}>
                    <ArrowLeft size={16} aria-hidden="true" /> Voltar
                </button>,
                <button key="next" type="button" className="btn-admin-go" onClick={() => { setError(''); next(); }}>
                    {activeAddons.length > 0 ? 'Próximo' : 'Seguir sem serviços'} <ArrowRight size={16} aria-hidden="true" />
                </button>,
            )}
        </div>
    );

    const scheduleChips = frequency === 'CUSTOM'
        ? customDates.slice(0, 12).map(cd => `${fmtDayMonth(cd.date)} ${cd.time}`)
        : scheduleItems.map(s => `${DAY_NAMES[s.day]} ${slotLabel(s.day, s.time)}`);
    const frequencyLabel = FREQUENCIES.find(f => f.key === frequency)?.label ?? 'Semanal';
    const months = durationMonths;
    const lastInstallment = quote.monthlyInstallments[quote.monthlyInstallments.length - 1] ?? 0;
    const monthlyDesc = months === 1
        ? `1 cobrança de ${formatBRL(quote.monthlyInstallments[0] ?? 0)}`
        : lastInstallment !== quote.monthlyInstallments[0]
            ? `${months} cobranças (1ª de ${formatBRL(quote.monthlyInstallments[0] ?? 0)})`
            : `${months}x de ${formatBRL(quote.monthlyInstallments[0] ?? 0)}`;
    const planWithPix = paymentPlan === 'FULL' && method === 'PIX';
    const accessProgressive = paymentPlan === 'MONTHLY' && methodOptions.find(m => m.key === method)?.accessMode === 'PROGRESSIVE';

    const renderStep4 = () => (
        <div className="ccf-step">
            <div className="ccf-section ccf-summary">
                <div className="ccf-summary__title"><Wallet size={13} aria-hidden="true" /> Resumo do plano</div>
                <ul className="ccf-summary__schedule" aria-label="Agenda escolhida">
                    {scheduleChips.map((c, i) => <li key={`chip-${i}`}>{c}</li>)}
                    {frequency === 'CUSTOM' && customDates.length > 12 && <li>+{customDates.length - 12} datas</li>}
                </ul>
                {isAdmin && selectedClient && <div className="ccf-summary__row"><span>Cliente</span><span>{selectedClient.name}</span></div>}
                <div className="ccf-summary__row"><span>{isAdmin ? 'Contrato' : 'Projeto'}</span><span>{name.trim()}</span></div>
                <div className="ccf-summary__row">
                    <span>Faixa · frequência</span>
                    <span>{tierLabel(tier, pricing)} · {frequencyLabel}{weekPatternPayload ? ` (semanas ${weekPatternPayload.join(', ')})` : ''}</span>
                </div>
                <div className="ccf-summary__row">
                    <span>Período</span>
                    <span>{startValid ? `${fmtDate(effectiveStart)} · ${plural(months, 'ciclo', 'ciclos')}` : '—'}</span>
                </div>
                <div className="ccf-summary__row"><span>Gravações no plano</span><span>{volume.totalSessions}</span></div>
                <div className="ccf-summary__row">
                    <span>Valor por gravação</span>
                    <span>
                        {quote.discountPct > 0 && <span className="ccf-summary__strike">{formatBRL(basePrice)}</span>}
                        {formatBRL(quote.discountedSessionPrice)}
                    </span>
                </div>
                {quote.discountPct > 0 && (
                    <div className="ccf-summary__row ccf-summary__row--good">
                        <span>Desconto por volume</span><span>{quote.discountPct}% aplicado</span>
                    </div>
                )}
                {activeAddons.map(x => {
                    const perCycle = x.mode === 'credits'
                        ? applyDiscount(x.addon.price * x.perCycle, quote.discountPct)
                        : applyDiscount(x.addon.price * volume.sessionsPerCycle, quote.discountPct);
                    return (
                        <div key={`sum-${x.addon.key}`} className="ccf-summary__row">
                            <span>{x.addon.name} ({x.mode === 'all' ? 'todas as gravações' : `${x.perCycle} por ciclo`})</span>
                            <span>+ {formatBRL(perCycle)}/ciclo</span>
                        </div>
                    );
                })}
                {frequency !== 'CUSTOM' && <div className="ccf-summary__row"><span>Valor por ciclo</span><span>{formatBRL(quote.cycleAmount)}</span></div>}
                {planWithPix && pixPct > 0 && (
                    <div className="ccf-summary__row ccf-summary__row--good">
                        <span>Desconto PIX à vista</span><span>−{formatBRL(quote.contractTotal - quote.fullPix)}</span>
                    </div>
                )}
                <div className="ccf-summary__row ccf-summary__row--total">
                    <span>Total do contrato</span>
                    <span>{formatBRL(quote.planTotal)}</span>
                </div>
            </div>

            <div className="ccf-section" role="group" aria-labelledby={`${uid}-plan-label`}>
                <span className="admin-field__label ccf-section__label" id={`${uid}-plan-label`}>Plano de cobrança</span>
                <div className="ccf-choices">
                    {([
                        { key: 'MONTHLY' as const, icon: CalendarDays, label: 'Mensal', desc: `${monthlyDesc}, a cada 4 semanas`, price: formatBRL(quote.contractTotal) },
                        {
                            key: 'FULL' as const, icon: Wallet, label: 'Integral',
                            desc: pixPct > 0 ? `1 cobrança do total · ${pixPct}% de desconto no PIX` : '1 cobrança do total',
                            price: pixPct > 0 ? `${formatBRL(quote.fullPix)} no PIX` : formatBRL(quote.contractTotal),
                        },
                    ]).map(p => {
                        const active = paymentPlan === p.key;
                        const Icon = p.icon;
                        return (
                            <button key={`plan-${p.key}`} type="button" aria-pressed={active}
                                className={`ccf-choice${active ? ' ccf-choice--active' : ''}`}
                                onClick={() => setPaymentPlan(p.key)}>
                                <span className="ccf-choice__head">
                                    <Icon size={16} aria-hidden="true" /> {p.label}
                                    {active && <Check size={16} className="ccf-choice__check" aria-hidden="true" />}
                                </span>
                                <span className="ccf-choice__desc">{p.desc}</span>
                                <span className="ccf-choice__price">{p.price}</span>
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="ccf-section" role="group" aria-labelledby={`${uid}-method-label`}>
                <span className="admin-field__label ccf-section__label" id={`${uid}-method-label`}>Forma de pagamento</span>
                <div className="ccf-choices">
                    {methodOptions.map(pm => {
                        const active = method === pm.key;
                        const isPixFull = paymentPlan === 'FULL' && pm.key === 'PIX' && pixPct > 0;
                        const price = paymentPlan === 'FULL'
                            ? (pm.key === 'PIX' ? quote.fullPix : quote.contractTotal)
                            : quote.monthlyInstallments[0] ?? 0;
                        const desc = paymentPlan === 'FULL'
                            ? (pm.key === 'CARTAO'
                                ? (fullCardFreeMax > 1 ? `À vista ou em até ${fullCardFreeMax}x sem juros` : 'Pagamento único no cartão (1x)')
                                : pm.key === 'PIX' ? 'Pagamento único à vista' : 'Pagamento único')
                            : (pm.key === 'CARTAO' ? '1 cobrança no cartão a cada ciclo' : isAdmin ? pm.adminDescription : pm.description);
                        return (
                            <button key={`pm-${pm.key}`} type="button" aria-pressed={active}
                                className={`ccf-choice${active ? ' ccf-choice--active' : ''}`}
                                style={{ '--ccf-color': pm.color } as CSSProperties}
                                onClick={() => setPaymentMethod(pm.key)}>
                                <span className="ccf-choice__head">
                                    <span aria-hidden="true">{pm.emoji}</span> {isAdmin ? pm.shortLabel : pm.label}
                                    {isPixFull && <span className="ccf-badge">−{pixPct}%</span>}
                                    {active && <Check size={16} className="ccf-choice__check" aria-hidden="true" />}
                                </span>
                                <span className="ccf-choice__desc">{desc}</span>
                                <span className="ccf-choice__price">
                                    {paymentPlan === 'FULL' ? formatBRL(price) : `${formatBRL(price)} por ciclo`}
                                    {isPixFull && <span className="ccf-choice__strike">{formatBRL(quote.contractTotal)}</span>}
                                </span>
                            </button>
                        );
                    })}
                </div>
                {accessProgressive && (
                    <div className="admin-alert admin-alert--warning" style={{ marginTop: 'var(--space-2)', marginBottom: 0 }}>
                        No plano mensal com esta forma de pagamento, as sessões de cada ciclo são liberadas quando o pagamento do ciclo compensa.
                    </div>
                )}
            </div>

            <div className="ccf-section">
                <CouponField
                    amount={quote.firstChargeBase}
                    userId={isAdmin ? (userId || undefined) : undefined}
                    applied={appliedCoupon}
                    onApply={setAppliedCoupon}
                    onRemove={() => setAppliedCoupon(null)}
                    disabled={busy}
                />
                {zeroCouponNeedsBaixa && (
                    <div id={`${uid}-zero-coupon`} className="admin-alert admin-alert--warning" role="status" style={{ marginTop: 'var(--space-2)', marginBottom: 0, fontSize: '0.75rem', lineHeight: 1.45 }}>
                        Cupom que zera a 1ª cobrança registra a parcela como paga e exige a permissão “Marcar como pago, anular ou estornar”. Remova o cupom ou use um de valor menor.
                    </div>
                )}
                <div className="ccf-summary">
                    <div className="ccf-summary__row">
                        <span>{paymentPlan === 'FULL' ? 'Pagamento integral' : '1ª cobrança'}</span>
                        <span>{formatBRL(quote.firstChargeBase)}</span>
                    </div>
                    {appliedCoupon && (
                        <div className="ccf-summary__row ccf-summary__row--good">
                            <span>Cupom {appliedCoupon.code}{appliedCoupon.scope === 'ALL_INSTALLMENTS' && paymentPlan === 'MONTHLY' ? ' (em todas as parcelas)' : ''}</span>
                            <span>−{formatBRL(appliedCoupon.discountAmount)}</span>
                        </div>
                    )}
                    <div className="ccf-summary__row ccf-summary__row--total">
                        <span>{isAdmin ? 'Valor da 1ª cobrança' : 'Você paga agora'}</span>
                        <span>{formatBRL(estimatedFirstCharge)}</span>
                    </div>
                </div>
            </div>

            {isAdmin ? (
                <div className="admin-info-banner ccf-section">
                    <ShieldCheck size={16} className="admin-info-banner__icon" aria-hidden="true" />
                    {staffCanCharge
                        ? <span>O contrato nasce <strong>ativo</strong>, com as sessões confirmadas. Em seguida você cobra a 1ª cobrança (cartão ou PIX) ou deixa pendente para o cliente pagar depois.</span>
                        : <span>O contrato nasce <strong>ativo</strong>, com as sessões confirmadas. A 1ª cobrança fica <strong>pendente</strong>: o cliente paga pelo app. Cobrar na hora (cartão ou PIX) exige a permissão “Cobrar o cliente”.</span>}
                </div>
            ) : (
                <>
                    <div className="admin-info-banner ccf-section">
                        <Clock size={16} className="admin-info-banner__icon" aria-hidden="true" />
                        <span>Ao continuar, seus horários ficam reservados por {DEFAULT_RESERVE_MINUTES} minutos até a confirmação do pagamento.</span>
                    </div>
                    <div className="ccf-section ccf-terms">
                        <div className="ccf-summary__title">Termos e regras</div>
                        <ul className="ccf-terms__list">
                            <li>Os pagamentos são por ciclos pré-pagos de <strong>4 semanas</strong> ({plural(months, 'ciclo', 'ciclos')} no total).</li>
                            <li>Cancelamento com menos de <strong>24 horas</strong> de antecedência resulta na perda do crédito.</li>
                            <li>Remarcação permitida com até <strong>7 dias</strong> de antecedência.</li>
                            <li>Créditos não usados dentro da vigência expiram ao fim do período.</li>
                            <li>A grade escolhida bloqueia outros agendamentos nos mesmos horários durante a vigência.</li>
                        </ul>
                        <label className={`ccf-terms__accept${acceptedTerms ? ' ccf-terms__accept--on' : ''}`}>
                            <input type="checkbox" checked={acceptedTerms} onChange={e => setAcceptedTerms(e.target.checked)} />
                            Li e aceito as regras acima
                        </label>
                    </div>
                </>
            )}

            {actions(
                <button key="back" type="button" className="btn-admin-ghost" disabled={busy} onClick={() => { setError(''); back(); }}>
                    <ArrowLeft size={16} aria-hidden="true" /> Voltar
                </button>,
                <button key="submit" type="button" className="btn-admin-go" disabled={!canStep4 || busy || zeroCouponNeedsBaixa} aria-busy={busy}
                    aria-describedby={zeroCouponNeedsBaixa ? `${uid}-zero-coupon` : undefined}
                    onClick={e => { if (e.detail > 1) return; void handleSubmit(); }}>
                    {busy
                        ? <><Loader2 size={16} className="csp-spin" aria-hidden="true" /> Verificando agenda…</>
                        : isAdmin ? <>Criar contrato <ArrowRight size={16} aria-hidden="true" /></> : <><ShieldCheck size={16} aria-hidden="true" /> Ir para pagamento</>}
                </button>,
                !canStep4 ? step4Hint : zeroCouponNeedsBaixa ? 'Remova o cupom que zera a 1ª cobrança.' : undefined,
            )}
        </div>
    );

    const renderConflicts = () => {
        const withSuggestion = conflicts.filter(c => c.suggestedReplacement).length;
        const hidden = Math.max(0, totalConflicts - conflicts.length);
        // Sem sugestão (dia lotado) ou conflito não listado → não dá para aceitar: o plano só é criado com
        // todas as gravações agendadas (o valor é calculado por elas).
        const blocked = conflicts.length - withSuggestion + hidden;
        const canAccept = blocked === 0;
        return (
            <div className="ccf-step">
                <div className="admin-alert admin-alert--warning" role="status">
                    {plural(totalConflicts, 'ocorrência cai', 'ocorrências caem')} em horário já ocupado.
                    {canAccept
                        ? (totalConflicts === 1 ? ' Sugerimos outro horário no mesmo dia.' : ' Sugerimos outro horário no mesmo dia para cada uma.')
                        : ` ${blocked === 1 ? (totalConflicts === 1 ? 'Ela não tem' : '1 delas não tem') : `${blocked} delas não têm`} outro horário livre no mesmo dia: ajuste a agenda (outro dia ou horário) para continuar. O plano só é criado com todas as gravações agendadas.`}
                    {hidden > 0 ? ` Mostrando as ${conflicts.length} primeiras.` : ''}
                </div>
                <div className="ccf-conflicts" aria-label="Datas em conflito" role="list">
                    {conflicts.map(c => {
                        const dow = weekdayOf(c.date);
                        return (
                            <div key={`${c.date}-${c.originalTime}`} className="ccf-conflict" role="listitem">
                                <div className="ccf-conflict__head">
                                    <span className="ccf-conflict__date">{DAY_NAMES_FULL[dow]}, {fmtDate(c.date)} · {slotLabel(dow, c.originalTime)}</span>
                                    <span className="ccf-conflict__badge">Ocupado</span>
                                </div>
                                {c.suggestedReplacement ? (
                                    <div className="ccf-conflict__line ccf-conflict__line--ok">
                                        <Lightbulb size={14} aria-hidden="true" />
                                        <span>Sugestão: <span className="ccf-conflict__alt">{slotLabel(weekdayOf(c.suggestedReplacement.date), c.suggestedReplacement.time)}</span> no mesmo dia</span>
                                    </div>
                                ) : (
                                    <div className="ccf-conflict__line ccf-conflict__line--warn">
                                        <AlertTriangle size={14} aria-hidden="true" />
                                        <span>Dia lotado: nenhum outro horário livre neste dia. Ajuste a agenda.</span>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
                <div className="ccf-footer">
                    <div className="admin-actions-row admin-actions-row--between">
                        <button key="conflicts-back" type="button" className="btn-admin-ghost" disabled={busy}
                            onClick={() => { setPhase('form'); goTo(2); }}>
                            <ArrowLeft size={16} aria-hidden="true" /> Ajustar a agenda
                        </button>
                        {/* Botão pode estar desabilitado (não dispara eventos de ponteiro): a dica fica no span.
                            alignSelf/flex mantêm a largura total no mobile (.admin-actions-row > button). */}
                        <Tooltip key="conflicts-accept" content={canAccept ? null : 'Ajuste a agenda: há datas sem outro horário livre.'}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', alignSelf: 'stretch' }}>
                                <button type="button" className="btn-admin-go ccf-accept-btn" style={{ flex: '1 1 auto' }} disabled={busy || !canAccept}
                                    onClick={e => { if (e.detail > 1) return; void acceptConflicts(); }}>
                                    <Check size={16} aria-hidden="true" />
                                    {isAdmin ? 'Aceitar sugestões e criar contrato' : 'Aceitar sugestões e ir para pagamento'}
                                </button>
                            </span>
                        </Tooltip>
                    </div>
                </div>
            </div>
        );
    };

    const renderCreating = () => (
        // Loading de marca compacto (E5): o BrandLoader já é o `role="status"` e o rótulo faz as vezes do título.
        <div className="ccf-state">
            <BrandLoader size="compact" label={isAdmin ? 'Criando o contrato…' : 'Reservando seus horários…'} />
            <p className="ccf-state__desc">Gerando {plural(volume.totalSessions, 'gravação', 'gravações')} do plano. Aguarde um instante.</p>
        </div>
    );

    const skippedAlert = created && created.skipped.length > 0 && (
        <div className="admin-alert admin-alert--warning" role="status">
            {plural(created.skipped.length, 'ocorrência pulada', 'ocorrências puladas')} por conflito
            {' '}({created.skipped.slice(0, 6).map(s => `${fmtDayMonth(s.date)} ${s.time}`).join(', ')}{created.skipped.length > 6 ? '…' : ''}): não entrou na agenda.
        </div>
    );

    const renderCheckout = () => {
        if (!created?.firstPaymentId || !method) return null;
        const secs = remaining ?? created.reservedMinutes * 60;
        const tone = secs <= 60 ? ' ccf-timer--danger' : secs <= 180 ? ' ccf-timer--warning' : '';
        return (
            <div>
                <div className={`ccf-timer${tone}`}>
                    <Clock size={20} aria-hidden="true" />
                    <span className="ccf-timer__text">
                        Seus horários ficam reservados por {plural(created.reservedMinutes, 'minuto', 'minutos')} até a confirmação do pagamento.
                    </span>
                    <span className="ccf-timer__clock" role="timer" aria-label={`Tempo restante: ${fmtClock(secs)}`}>{fmtClock(secs)}</span>
                </div>
                {skippedAlert}
                {checkoutError && <div className="admin-alert admin-alert--danger" role="alert">{checkoutError}</div>}
                <InlineCheckout
                    amount={created.firstAmount}
                    paymentId={created.firstPaymentId}
                    description={paymentPlan === 'FULL' ? `Pagamento integral · ${name.trim()}` : `1ª parcela de ${months} · ${name.trim()}`}
                    contractDuration={paymentPlan === 'FULL' ? months : 1}
                    allowedMethods={[method]}
                    context="contract"
                    onSuccess={() => { setExitOpen(false); setCheckoutError(''); setPhase('success'); }}
                    onError={msg => setCheckoutError(msg)}
                />
                <div className="ccf-checkout-exit">
                    <button key="exit" type="button" className="btn-admin-ghost" onClick={() => setExitOpen(true)}>
                        Sair sem pagar
                    </button>
                </div>
            </div>
        );
    };

    const renderSuccess = () => {
        if (!created) return null;
        const freeFirst = created.firstAmount === 0;
        return (
            <div className="ccf-state">
                <div className="ccf-state__icon"><CheckCircle2 size={34} aria-hidden="true" /></div>
                <h3 className="ccf-state__title">{isAdmin ? 'Contrato criado' : 'Plano ativado!'}</h3>
                <p className="ccf-state__desc">
                    {isAdmin
                        ? `O contrato "${name.trim()}" de ${selectedClient?.name ?? 'cliente'} está ativo${freeFirst ? ' e a 1ª cobrança foi coberta pelo cupom' : created.firstPending ? '. A 1ª cobrança ficou pendente: o cliente paga pelo app' : ''}.`
                        : freeFirst
                            ? `Seu cupom cobriu a 1ª cobrança e o plano "${name.trim()}" já está ativo.`
                            : `Pagamento confirmado. Seu plano "${name.trim()}" está ativo.`}
                </p>
                <ul className="ccf-state__list">
                    <li><CalendarCheck size={16} aria-hidden="true" /> {plural(created.totalBookings, 'gravação agendada', 'gravações agendadas')}</li>
                    {created.discountPct > 0 && <li><BadgePercent size={16} aria-hidden="true" /> Desconto de {created.discountPct}% aplicado</li>}
                    {created.skipped.length > 0 && (
                        <li><AlertTriangle size={16} aria-hidden="true" /> {plural(created.skipped.length, 'ocorrência pulada', 'ocorrências puladas')} por conflito</li>
                    )}
                </ul>
                <div className="admin-actions-row" style={{ width: '100%', justifyContent: 'center' }}>
                    <button key="done" type="button" className="btn-admin-go" onClick={finish}>
                        {isAdmin ? 'Concluir' : 'Ver meus contratos'}
                    </button>
                </div>
            </div>
        );
    };

    const deadlineText = created?.paymentDeadline ? ` (até as ${fmtTimeSp(created.paymentDeadline)})` : '';

    return (
        <>
            <BottomSheetModal
                isOpen
                onClose={requestClose}
                hideHeader
                size="xl"
                desktopAnchor="top"
                floatingClose
                className="admin-sheet"
                title={headTitle}
                preventClose={busy || !!cpfPrompt || exitOpen}
            >
                <div className="admin-modal-head">
                    <h2 className="admin-modal-title">
                        <span className="admin-modal-title__icon"><Wand2 size={18} aria-hidden="true" /></span>
                        {headTitle}
                    </h2>
                    <p className="ccf-subtitle">{headSubtitle}</p>
                    {phase === 'form' && <WizardSteps steps={STEPS} current={step} onStepClick={n => { setError(''); goTo(n); }} />}
                </div>

                <div className="admin-modal-body">
                    {phase === 'form' && error && (
                        <div className="admin-alert admin-alert--danger" role="alert">
                            {error}
                            {errorAction?.msg === error && errorAction.kind === 'contracts' && (
                                <div style={{ marginTop: 'var(--space-2)' }}>
                                    <button key="err-contracts" type="button" className="btn-admin-ghost btn-admin-ghost--compact" onClick={finish}>
                                        Ver meus contratos
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                    {phase === 'form' && step === 1 && renderStep1()}
                    {phase === 'form' && step === 2 && renderStep2()}
                    {phase === 'form' && step === 3 && renderStep3()}
                    {phase === 'form' && step === 4 && renderStep4()}
                    {phase === 'conflicts' && renderConflicts()}
                    {phase === 'creating' && renderCreating()}
                    {phase === 'checkout' && renderCheckout()}
                    {phase === 'success' && renderSuccess()}
                </div>
            </BottomSheetModal>

            {cpfPrompt && (
                <BottomSheetModal isOpen onClose={() => setCpfPrompt(null)} size="sm" hideHeader className="admin-sheet" title="CPF ou CNPJ" zIndex={1010}>
                    <div className="ccf-cpf-sheet">
                        <CpfCnpjPrompt
                            saveLabel="Salvar e continuar"
                            subtitle="O pagamento via PIX é emitido no seu nome, por isso precisamos do seu CPF ou CNPJ. Fica salvo no seu perfil."
                            onSaved={() => {
                                const pending = cpfPrompt;
                                setCpfPrompt(null);
                                // Com trocas: mesmo início do check que as gerou. Sem check ainda: início recalculado agora.
                                void withLock(() => (pending.resolutions
                                    ? createContract(pending.resolutions, pending.start)
                                    : runCheck(startForSubmit())));
                            }}
                            onCancel={() => setCpfPrompt(null)}
                        />
                    </div>
                </BottomSheetModal>
            )}

            {!isAdmin && (
                <DangerConfirmDialog
                    isOpen={exitOpen}
                    tone="warning"
                    icon={Clock}
                    title="Sair sem pagar?"
                    description={`Seus horários ficam reservados por ${plural(created?.reservedMinutes ?? DEFAULT_RESERVE_MINUTES, 'minuto', 'minutos')} até a confirmação do pagamento${deadlineText}. Enquanto o prazo não acabar, você pode concluir o pagamento em Meus Contratos.`}
                    consequences={[
                        'Se o prazo acabar sem pagamento, a reserva é desfeita e os horários voltam a ficar livres.',
                        'Se você montar outro plano personalizado, esta reserva é descartada e substituída pela nova.',
                    ]}
                    confirmLabel="Sair sem pagar"
                    cancelLabel="Continuar pagamento"
                    onConfirm={finish}
                    onClose={() => setExitOpen(false)}
                    zIndex={1010}
                />
            )}
        </>
    );
}
