import { getErrorMessage } from '../../../utils/errors';
import { useState, useEffect, useId, useRef, type CSSProperties } from 'react';
import {
    contractsApi, pricingApi, ApiError,
    type UserSummary, type CreateContractData, type PricingConfig, type InstallmentPlan, type AddOnConfig,
    type ServiceBreakdownItem, type CouponValidation, type ContractTier,
} from '../../../api/client';
import { useBusinessConfig } from '../../../hooks/useBusinessConfig';
import { isBoletoAvailable, loadPaymentMethods, usePaymentMethodsVersion } from '../../../constants/paymentMethods';
import { useWizardStep, ignoreMultiClick, wizardStepBodyStyle as stepBodyStyle, wizardStepContentStyle as stepContentStyle } from '../../../hooks/useWizardStep';
import { useContractSlotGrid } from '../../../hooks/useContractSlotGrid';
import { usePermission } from '../../../hooks/usePermission';
import { useUI } from '../../../context/UIContext';
import BottomSheetModal from '../../BottomSheetModal';
import WizardSteps from '../WizardSteps';
import ChargeNowSheet from '../ChargeNowSheet';
import ContractSlotPicker, { formatSlotRange } from '../../contracts/ContractSlotPicker';
import {
    FileText, UserRound, NotebookPen, CalendarDays, Link2, Pin, RefreshCw,
    Wallet, Zap, CreditCard, TicketPercent, AlertTriangle, AlertCircle, CalendarX2,
    Sparkles,
} from 'lucide-react';
import CouponField from '../../CouponField';
import ServiceLineItem from '../../ui/ServiceLineItem';
import BrandLoader from '../../ui/BrandLoader';
import { TIER_META } from '../../../constants/adminMeta';
import { formatBRL, DAY_NAMES, DAY_NAMES_FULL } from '../../../utils/format';
import { todayStrSaoPaulo } from '../../../utils/time';

type AdminMethod = 'CARTAO' | 'PIX' | 'BOLETO';
type ResolvedConflict = { originalDate: string; originalTime: string; newDate: string; newTime: string };

/** Etapas do wizard (casca canônica do CreateBookingModal — design-system.md §3b). */
const STEPS = ['Plano', 'Agenda', 'Serviços', 'Resumo'];
const LAST_STEP = STEPS.length;

/** Etapa de cada campo do payload: erro de campo da API → goTo(etapa do campo). */
const FIELD_STEP: Record<string, number> = {
    userId: 1, name: 1, type: 1, tier: 1, durationMonths: 1,
    startDate: 2, fixedDayOfWeek: 2, fixedTime: 2, contractUrl: 2, resolvedConflicts: 2,
    addOns: 3,
    paymentPlan: 4, paymentMethod: 4, couponCode: 4,
};

/** Campo exibido na tela para cada campo do payload (dia/horário/trocas = o seletor de horário). */
const FIELD_UI: Record<string, string> = {
    fixedDayOfWeek: 'slot', fixedTime: 'slot', resolvedConflicts: 'slot',
};

/** Mensagens em português para erros de validação por campo (as do zod podem vir em inglês). */
const FIELD_MESSAGE: Record<string, string> = {
    userId: 'Selecione um cliente válido.',
    name: 'Informe o nome do projeto.',
    startDate: 'Data de início inválida.',
    contractUrl: 'Link inválido — use um endereço completo começando com https://',
    slot: 'Escolha um dos horários acima.',
};

const WEEKDAY_AT = ['aos domingos', 'às segundas', 'às terças', 'às quartas', 'às quintas', 'às sextas', 'aos sábados'];
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const DAY_LOWER = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
/** Dias da grade em texto ("de segunda a sexta", "só aos sábados", "segunda, terça e quinta"). */
function describeDays(days: number[]): string {
    if (days.length === 0) return 'em nenhum dia na grade atual';
    if (days.length === 1) return `só ${WEEKDAY_AT[days[0]]}`;
    const last = days[days.length - 1];
    const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
    if (contiguous && days.length > 2) return `de ${DAY_LOWER[days[0]]} a ${DAY_LOWER[last]}`;
    return `${days.slice(0, -1).map(d => DAY_LOWER[d]).join(', ')} e ${DAY_LOWER[last]}`;
}

const LINK_ERROR = FIELD_MESSAGE.contractUrl;

/** Link do contrato: vazio é permitido; preenchido precisa ser um endereço http(s) completo. */
function isValidContractUrl(raw: string): boolean {
    const v = raw.trim();
    if (!v) return true;
    if (/\s/.test(v)) return false;
    try {
        const u = new URL(v);
        return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.');
    } catch {
        return false;
    }
}

/** 'YYYY-MM-DD' → 'DD/MM/AAAA' (sem Date: evita deslocar o dia pelo fuso). */
function formatYmd(ds: string | null | undefined): string {
    if (!ds) return '—';
    const [y, m, d] = ds.split('-');
    return y && m && d ? `${d}/${m}/${y}` : ds;
}

interface ContractForm {
    userId: string;
    name: string;
    type: 'FIXO' | 'FLEX';
    tier: ContractTier;
    durationMonths: 3 | 6;
    startDate: string;
    contractUrl: string;
    paymentPlan: 'MONTHLY' | 'FULL';
    /** Só FIXO. null = ainda não escolhido (nunca há padrão fixo — D8). */
    fixedDayOfWeek: number | null;
    fixedTime: string | null;
}

/** check-fixo respondeu que o dia da semana inteiro está lotado no período (weekdayUnavailable). */
interface WeekdayNotice {
    dayOfWeek: number;
    time: string;
    tier: ContractTier;
    forecast: string | null;
    alternatives: { dayOfWeek: number; conflictCount: number; conflictFree: boolean }[];
}

interface CreateContractModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreated: () => void;
    users: UserSummary[];
    pricing: PricingConfig[];
}

const iconInInput: CSSProperties = { position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', opacity: 0.5, pointerEvents: 'none' };

const selectStyle: CSSProperties = {
    width: '100%', padding: '10px 14px 10px 36px', borderRadius: 'var(--radius-md)', fontSize: '0.8125rem',
    background: 'var(--input-bg-raised)', border: '1px solid var(--border-default)',
    color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit',
    appearance: 'none', cursor: 'pointer', minHeight: 'var(--control-h)',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23666'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center',
};

type ChoiceTone = { color: string; bg: string; border: string };
const ACCENT_TONE: ChoiceTone = { color: 'var(--accent-text)', bg: 'rgba(17,129,155,0.10)', border: 'rgba(17,129,155,0.4)' };
const SUCCESS_TONE: ChoiceTone = { color: 'var(--success)', bg: 'rgba(16,185,129,0.08)', border: 'rgba(16,185,129,0.3)' };

/** Cartão de escolha (toggle) — ativo com a cor do tom; teal da marca por padrão. */
function choiceStyle(active: boolean, tone: ChoiceTone = ACCENT_TONE, extra?: CSSProperties): CSSProperties {
    return {
        padding: '12px', borderRadius: '10px', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary)',
        background: active ? tone.bg : 'var(--bg-elevated)',
        border: `1.5px solid ${active ? tone.border : 'var(--border-default)'}`,
        transition: 'background 0.15s ease, border-color 0.15s ease',
        ...extra,
    };
}

const blockLabel: CSSProperties = { display: 'block', marginBottom: 6 };
// Casca das etapas (stepBodyStyle/stepContentStyle, compartilhados em useWizardStep): a etapa abraça o
// conteúdo e o dialog fica ancorado no topo no desktop (desktopAnchor="top"), sem o cabeçalho pular.
// Os botões do rodapé e as escolhas de cobrança da etapa 4 usam ignoreMultiClick: o 2º clique de um
// duplo clique no "Próximo" não cria o contrato nem troca o plano/forma de cobrança sem o admin ver a etapa 4.
// A linha da dica fica SEMPRE reservada (vazia quando a etapa está válida): sem altura mínima na casca, ela
// sumir no meio da etapa faria o "Próximo" subir ~35px logo antes do clique.
const stepHintStyle: CSSProperties = { margin: '16px 0 0', fontSize: '0.75rem', lineHeight: 1.5, minHeight: '1.5em', color: 'var(--text-secondary)', textAlign: 'right' };

export default function CreateContractModal({ isOpen, onClose, onCreated, users, pricing }: CreateContractModalProps) {
    const uid = useId();
    const { showToast } = useUI();
    // Equipe (D7): o contrato nasce ATIVO com as parcelas em aberto; "Cobrar agora" a 1ª parcela só com
    // "Cobrar o cliente" (cobrancas.cobrar). Sem ela, a cobrança fica pendente e o cliente paga pelo app.
    const { can } = usePermission();
    const canChargeNow = can('cobrancas.cobrar');
    // FE-2: parcela zerada por cupom nasce PAGA — sem a baixa manual o servidor recusa (403); aqui o
    // "Criar Contrato" fica desabilitado com a explicação, em vez do 403 genérico.
    const canMarkPaid = can('cobrancas.baixa');
    const { get: getRule } = useBusinessConfig();
    const ep3 = getRule('episodes_3months');
    const ep6 = getRule('episodes_6months');
    const disc3 = getRule('discount_3months');
    const disc6 = getRule('discount_6months');
    const sessionsPerMonth = getRule('sessions_per_month');

    // Wizard (D11): next() adia 1 tick (setTimeout 0) — correção do submit espúrio; back/goTo síncronos.
    const { step, next, back, goTo } = useWizardStep(LAST_STEP);
    // Etapa atual para checagens DEPOIS de um await (o admin pode ter voltado pelo stepper).
    const stepRef = useRef(step);
    stepRef.current = step;

    const [createForm, setCreateForm] = useState<ContractForm>(() => ({
        userId: '', name: '', type: 'FIXO', tier: 'COMERCIAL', durationMonths: 3,
        startDate: todayStrSaoPaulo(), contractUrl: '', paymentPlan: 'MONTHLY',
        fixedDayOfWeek: null, fixedTime: null,
    }));
    const [createError, setCreateError] = useState('');
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [linkTouched, setLinkTouched] = useState(false);
    const [weekdayNotice, setWeekdayNotice] = useState<WeekdayNotice | null>(null);
    const [creating, setCreating] = useState(false);
    const creatingRef = useRef(false); // trava anti-duplo-clique (evita contrato/pagamento duplicado)
    const [checking, setChecking] = useState(false);
    const checkingRef = useRef(false); // não dispara 2 check-fixo em paralelo (estado, não tempo)
    const [paymentMethod, setPaymentMethod] = useState<AdminMethod>('CARTAO');
    // E3 — o Boleto só é opção com a chave-mestra "Aceitar pagamento por boleto" ligada E a Cora ativa
    // (fonte única: boleto.available de GET /pricing/payment-methods). Não há mais liberação por contrato.
    usePaymentMethodsVersion();
    const boletoOn = isBoletoAvailable();
    useEffect(() => {
        // Revalida a chave ao abrir o wizard (o cache é carregado uma vez por sessão).
        if (isOpen) void loadPaymentMethods();
    }, [isOpen]);
    useEffect(() => {
        // Boleto desligado com Boleto escolhido → volta para Cartão (a opção some).
        if (!boletoOn && paymentMethod === 'BOLETO') setPaymentMethod('CARTAO');
    }, [boletoOn, paymentMethod]);

    const [conflicts, setConflicts] = useState<{ date: string, originalTime: string, suggestedReplacement?: { date: string, time: string } }[]>([]);
    const [resolvedConflicts, setResolvedConflicts] = useState<ResolvedConflict[]>([]);
    const [showConflictModal, setShowConflictModal] = useState(false);

    // Authoritative pricing (same rules as the client) + optional "charge now" step.
    const [quote, setQuote] = useState<{ monthlyAmount: number; fullPix: number; fullCard: number; installmentPlans: InstallmentPlan[]; services: ServiceBreakdownItem[]; servicesPerRecordingCents: number } | null>(null);
    const [chargePaymentId, setChargePaymentId] = useState<string | null>(null);
    // Cupom (elegibilidade validada para o CLIENTE selecionado) + 1ª cobrança já descontada retornada pelo backend.
    const [appliedCoupon, setAppliedCoupon] = useState<CouponValidation | null>(null);
    const [chargeAmountApi, setChargeAmountApi] = useState<number | null>(null);

    // Per-episode services (accompany every recording). GESTAO_SOCIAL (monthly) is excluded,
    // matching the client wizard; the per-recording value is shown via ServiceLineItem.
    const [addons, setAddons] = useState<AddOnConfig[]>([]);
    const [addonsLoading, setAddonsLoading] = useState(true);
    const [selectedAddons, setSelectedAddons] = useState<string[]>([]);
    useEffect(() => {
        if (!isOpen) return;
        setAddonsLoading(true);
        pricingApi.getAddons()
            .then(r => setAddons(r.addons.filter(a => !a.monthly)))
            .catch(() => setAddons([]))
            .finally(() => setAddonsLoading(false));
    }, [isOpen]);

    const planSel = createForm.paymentPlan;
    useEffect(() => {
        if (!isOpen) return;
        let alive = true;
        pricingApi.checkoutQuote({ durationMonths: createForm.durationMonths, contractType: createForm.type, tier: createForm.tier, addOns: selectedAddons })
            .then(q => { if (alive) setQuote(q); })
            .catch(() => { if (alive) setQuote(null); });
        return () => { alive = false; };
    }, [isOpen, createForm.tier, createForm.durationMonths, createForm.type, selectedAddons]);

    // Grade de horários de CONTRATO da faixa (D8), vinda da BusinessConfig — só importa no FIXO.
    // Em erro NÃO há lista de reserva: a etapa Agenda fica bloqueada até recarregar.
    const slotGrid = useContractSlotGrid(createForm.type === 'FIXO' ? createForm.tier : null);
    const { grid, allowedDays, isValidSlot } = slotGrid;

    // Ao trocar a faixa (ou a grade recarregar), limpa o dia/horário que deixou de valer.
    // Faixa com um único dia (Sábado) já vem com o dia marcado — o horário nunca tem padrão.
    useEffect(() => {
        if (!grid) return; // carregando, erro ou FLEX
        setCreateForm(f => {
            let day = f.fixedDayOfWeek;
            let time = f.fixedTime;
            if (day != null && !allowedDays.includes(day)) day = null;
            if (day == null && allowedDays.length === 1) day = allowedDays[0];
            if (time && (day == null || !isValidSlot(day, time))) time = null;
            if (day === f.fixedDayOfWeek && time === f.fixedTime) return f;
            return { ...f, fixedDayOfWeek: day, fixedTime: time };
        });
    }, [grid, allowedDays, isValidSlot, createForm.fixedDayOfWeek, createForm.fixedTime]);

    // Troca de etapa: volta a rolagem do sheet ao topo (o erro/aviso fica no topo do corpo).
    const headRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const body = headRef.current?.closest('.bottom-sheet-body');
        if (body) body.scrollTop = 0;
    }, [step]);

    const patchForm = (patch: Partial<ContractForm>) => setCreateForm(f => ({ ...f, ...patch }));
    const clearFieldError = (...keys: string[]) => setFieldErrors(fe => {
        if (!keys.some(k => k in fe)) return fe;
        const nextFe = { ...fe };
        keys.forEach(k => { delete nextFe[k]; });
        return nextFe;
    });
    /** Próximo: só avança se a etapa é válida; o avanço é ADIADO 1 tick pelo next() (anti-submit espúrio). */
    const goNext = (ok: boolean) => {
        if (!ok) return;
        setCreateError(''); // o aviso da etapa atual já foi resolvido
        next();
    };
    /** Mudança que afeta a agenda: o aviso de "dia lotado" e o erro de horário deixam de valer. */
    const patchSchedule = (patch: Partial<ContractForm>) => {
        patchForm(patch);
        setWeekdayNotice(null);
        setCreateError('');
        clearFieldError('slot', 'startDate');
    };

    /**
     * Erro de CAMPO vindo da API → mostra no campo e leva à etapa dele (nunca como conflito).
     * Devolve true quando tratou o erro.
     */
    const applyFieldError = (err: unknown): boolean => {
        if (!(err instanceof ApiError)) return false;
        const invalidSlot = err.code === 'INVALID_SLOT'
            || (err.status === 400 && /^hor[aá]rio inv[aá]lido/i.test(err.message))
            || (err.status === 400 && /requer dia da semana e hor[aá]rio/i.test(err.message));
        if (invalidSlot) {
            setShowConflictModal(false);
            setWeekdayNotice(null);
            // A grade pode ter mudado em Configurações: recarrega (o efeito limpa o que deixou de valer).
            slotGrid.invalidate();
            setFieldErrors({ slot: FIELD_MESSAGE.slot });
            setCreateError(getErrorMessage(err));
            goTo(2);
            return true;
        }
        if (err.status === 400 && Array.isArray(err.details)) {
            const fields = (err.details as { path?: unknown[] }[])
                .map(d => d?.path?.[0])
                .filter((p): p is string => typeof p === 'string' && p in FIELD_STEP);
            if (fields.length > 0) {
                const target = Math.min(...fields.map(f => FIELD_STEP[f]));
                const fe: Record<string, string> = {};
                fields.forEach(f => {
                    const key = FIELD_UI[f] ?? f;
                    fe[key] = FIELD_MESSAGE[key] ?? 'Valor inválido.';
                });
                setShowConflictModal(false);
                setFieldErrors(fe);
                if (fe.contractUrl) setLinkTouched(true);
                setCreateError(`Revise os dados da etapa ${STEPS[target - 1]}.`);
                goTo(target);
                return true;
            }
        }
        return false;
    };

    const executeCreate = async (resolutions: ResolvedConflict[] = []) => {
        if (creatingRef.current) return;
        creatingRef.current = true;
        setCreating(true);
        setCreateError('');
        try {
            const data: CreateContractData = {
                userId: createForm.userId,
                name: createForm.name.trim(),
                type: createForm.type,
                tier: createForm.tier,
                durationMonths: createForm.durationMonths,
                startDate: createForm.startDate,
                contractUrl: createForm.contractUrl.trim() || undefined,
                paymentPlan: createForm.paymentPlan,
                paymentMethod,
                addOns: selectedAddons.length > 0 ? selectedAddons : undefined,
                resolvedConflicts: resolutions.length > 0 ? resolutions : undefined,
                couponCode: appliedCoupon?.code || undefined,
                // FIXO: dia e horário da grade (sem padrão '14:00' — a etapa Agenda exige um horário válido).
                ...(createForm.type === 'FIXO' && createForm.fixedDayOfWeek != null && createForm.fixedTime
                    ? { fixedDayOfWeek: createForm.fixedDayOfWeek, fixedTime: createForm.fixedTime }
                    : {}),
            };
            const res = await contractsApi.create(data);
            setShowConflictModal(false);
            // Offer to charge the first payment on the spot (PIX QR / client's card present),
            // using the SAME InlineCheckout + unified policy as the client. Otherwise it stays
            // PENDING and the client pays later (or via auto-charge).
            // onCreated() (recarregar a lista) só quando o sheet de cobrança FECHAR — ou já, se não há cobrança.
            // Sem "Cobrar o cliente" o sheet não abre (as rotas de cobrança dariam 403): fica pendente.
            if (res.firstPaymentId && canChargeNow) {
                // O 1º payment retornado JÁ vem com o cupom descontado pelo backend.
                setChargeAmountApi(res.payments?.[0]?.amount ?? null);
                setChargePaymentId(res.firstPaymentId);
            } else {
                onCreated();
                onClose();
                showToast(res.firstPaymentId
                    ? 'Contrato criado. A 1ª cobrança ficou pendente: o cliente paga pelo app (ou quem tem permissão de cobrança cobra depois).'
                    : (res.message || 'Contrato criado com sucesso!'));
            }
        } catch (err: unknown) {
            // E3: o boleto foi desligado (ou a Cora desativada) depois que o wizard abriu — nada foi criado.
            // Revalida a chave (a opção some e a forma volta para Cartão) e mostra o aviso no Resumo.
            if (err instanceof ApiError && err.code === 'BOLETO_UNAVAILABLE') {
                void loadPaymentMethods();
                setPaymentMethod('CARTAO');
                setShowConflictModal(false);
                setCreateError(`${getErrorMessage(err)} Escolha PIX ou cartão e crie o contrato de novo.`);
                goTo(LAST_STEP);
            } else if (!applyFieldError(err)) setCreateError(getErrorMessage(err));
        } finally { creatingRef.current = false; setCreating(false); }
    };

    // ── Validação por etapa ──
    const canStep1 = !!createForm.userId && createForm.name.trim().length > 0;
    const startDateOk = /^\d{4}-\d{2}-\d{2}$/.test(createForm.startDate);
    const linkOk = isValidContractUrl(createForm.contractUrl);
    const scheduleOk = createForm.type !== 'FIXO'
        || (!!grid && createForm.fixedDayOfWeek != null && isValidSlot(createForm.fixedDayOfWeek, createForm.fixedTime));
    const canStep2 = startDateOk && linkOk && scheduleOk;
    const canCreate = canStep1 && canStep2;
    // FE-2: o servidor recusa qualquer parcela zerada sem a baixa manual; aqui cobre o caso do cupom
    // (que age na 1ª cobrança): finalAmount ≤ 0 = 1ª parcela zerada.
    const zeroCouponNeedsBaixa = !canMarkPaid && !!appliedCoupon && appliedCoupon.finalAmount <= 0;

    const handleCreate = async () => {
        if (step !== LAST_STEP) return; // rede de segurança: só cria na última etapa
        if (!createForm.userId || creatingRef.current || checkingRef.current) return;
        setCreateError('');
        setFieldErrors({});
        // Valida TODAS as etapas (o stepper permite voltar e mudar algo depois).
        if (!canStep1) { setCreateError('Selecione o cliente e informe o nome do projeto.'); goTo(1); return; }
        if (!canStep2) { setCreateError('Revise a agenda do contrato antes de criar.'); goTo(2); return; }

        if (createForm.type === 'FIXO' && createForm.fixedDayOfWeek != null && createForm.fixedTime) {
            const dayOfWeek = createForm.fixedDayOfWeek;
            const time = createForm.fixedTime;
            checkingRef.current = true;
            setChecking(true);
            try {
                const res = await contractsApi.checkFixo({
                    tier: createForm.tier,
                    durationMonths: createForm.durationMonths,
                    startDate: createForm.startDate,
                    fixedDayOfWeek: dayOfWeek,
                    fixedTime: time,
                });
                // Voltou de etapa durante a verificação: não cria (só cria a partir do Resumo).
                if (stepRef.current !== LAST_STEP) return;

                if (!res.available) {
                    // Dia da semana inteiro lotado no período: mensagem clara na etapa Agenda
                    // (previsão + dias alternativos), nunca o modal de conflitos vazio.
                    if (res.weekdayUnavailable || res.conflicts.length === 0) {
                        setWeekdayNotice({
                            dayOfWeek, time, tier: createForm.tier,
                            forecast: res.forecast ?? null,
                            alternatives: res.alternativeWeekdays ?? [],
                        });
                        goTo(2);
                        return;
                    }
                    setConflicts(res.conflicts);
                    const autoResolutions = res.conflicts
                        .filter(c => c.suggestedReplacement)
                        .map(c => ({
                            originalDate: c.date,
                            originalTime: c.originalTime,
                            newDate: c.suggestedReplacement!.date,
                            newTime: c.suggestedReplacement!.time
                        }));
                    setResolvedConflicts(autoResolutions);
                    setShowConflictModal(true);
                    return;
                }
            } catch (err: unknown) {
                // 400 INVALID_SLOT = horário fora da grade → erro de campo na etapa Agenda (não é conflito).
                if (!applyFieldError(err)) setCreateError(getErrorMessage(err) || 'Erro ao validar agenda.');
                return;
            } finally {
                checkingRef.current = false;
                setChecking(false);
            }
        }

        await executeCreate([]);
    };

    if (!isOpen) return null;

    const tierPrice = pricing.find(p => p.tier === createForm.tier);
    const base = tierPrice?.price || 0;
    const episodes = createForm.durationMonths === 3 ? ep3 : ep6;
    const discount = createForm.durationMonths === 3 ? disc3 : disc6;
    const discounted = Math.round(base * (1 - discount / 100));
    const total = discounted * episodes;
    const monthly = createForm.durationMonths ? Math.round(total / createForm.durationMonths) : 0;

    const chargeAmount = planSel === 'FULL'
        ? (paymentMethod === 'PIX' ? (quote?.fullPix ?? total) : (quote?.fullCard ?? total))
        : (quote?.monthlyAmount ?? monthly);

    // Só clientes (a equipe nunca é alvo de contrato — o servidor responde 404 "Cliente não encontrado").
    const clientUsers = users.filter(u => u.role === 'CLIENTE' && !u.deletedAt);
    const selectedUser = clientUsers.find(u => u.id === createForm.userId);
    const tierMeta = TIER_META[createForm.tier] ?? TIER_META.COMERCIAL;
    const selectedSlot = createForm.fixedDayOfWeek != null
        ? slotGrid.slotsFor(createForm.fixedDayOfWeek).find(s => s.time === createForm.fixedTime) ?? null
        : null;

    // Erro local (após sair do campo) ou recusado pela API (zod .url()) — some ao editar o campo.
    const showLinkError = (!linkOk && linkTouched) || !!fieldErrors.contractUrl;

    // Por que o "Próximo" está desabilitado (texto curto acima do rodapé).
    const step1Hint = !createForm.userId ? 'Selecione o cliente para continuar.'
        : !createForm.name.trim() ? 'Informe o nome do projeto para continuar.' : '';
    const step2Hint = !startDateOk ? 'Informe a data de início.'
        : !linkOk ? 'Corrija o link do contrato (use https://…).'
            : createForm.type !== 'FIXO' ? ''
                : slotGrid.error ? 'Não foi possível carregar os horários — tente novamente.'
                    : !grid ? 'Carregando os horários da faixa…'
                        : createForm.fixedDayOfWeek == null ? 'Escolha o dia da semana.'
                            : !scheduleOk ? 'Escolha o horário de gravação.' : '';

    // Charge-now step: same InlineCheckout + unified policy as the client. PIX shows a QR;
    // cartão uses Stripe Elements with the client's card present. Charges the CLIENT
    // (payment.userId) — the backend resolves the payer from the payment, not the admin.
    // Substitui o wizard (como no CreateBookingModal). A lista só recarrega ao fechar o sheet.
    if (chargePaymentId) {
        return (
            <ChargeNowSheet
                paymentId={chargePaymentId}
                amount={chargeAmountApi ?? chargeAmount}
                description={`${createForm.name.trim() || 'Contrato'} - 1ª cobrança`}
                title="Cobrar 1ª parcela"
                subtitle="Cobre agora no PIX ou no cartão do cliente (crédito ou débito), com ele presente — ou deixe pendente: o cliente paga depois / cobrança automática."
                contractDuration={planSel === 'FULL' ? createForm.durationMonths : 1}
                // E1: sempre PIX | Cartão (| Boleto quando disponível), abrindo na forma escolhida no Resumo.
                initialMethod={paymentMethod}
                context="contract"
                client={selectedUser ? { id: selectedUser.id, name: selectedUser.name, cpfCnpj: selectedUser.cpfCnpj } : undefined}
                error={createError || undefined}
                onError={(msg) => setCreateError(msg)}
                onSuccess={() => { onCreated(); onClose(); showToast('Pagamento confirmado!'); }}
                onDismiss={() => { onCreated(); onClose(); showToast('Contrato criado (1ª cobrança pendente).'); }}
            />
        );
    }

    return (
        <>
            <BottomSheetModal isOpen onClose={onClose} preventClose={creating || checking} hideHeader size="lg" desktopAnchor="top" floatingClose className="admin-sheet" title="Novo Contrato">
                {/* --- HEADER --- */}
                <div className="admin-modal-head" ref={headRef}>
                    <h2 className="admin-modal-title">
                        <span className="admin-modal-title__icon"><FileText size={18} aria-hidden="true" /></span>
                        Novo Contrato
                    </h2>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>
                        Crie um contrato de fidelidade vinculado a um cliente
                    </p>
                    <WizardSteps steps={STEPS} current={step} onStepClick={goTo} />
                </div>

                <div className="admin-modal-body">
                    {createError && <div className="admin-alert admin-alert--danger" role="alert">{createError}</div>}

                    {/* -------- STEP 1: Plano (cliente, projeto, tipo, faixa, duração) -------- */}
                    {step === 1 && (
                        <div style={stepBodyStyle}>
                            <div style={stepContentStyle}>
                            <div className="admin-grid-2" style={{ gap: '12px', marginBottom: '16px' }}>
                                {/* Client selector */}
                                <div className="admin-field">
                                    <label className="admin-field__label" htmlFor={`${uid}-cliente`}>Cliente *</label>
                                    <div style={{ position: 'relative' }}>
                                        <UserRound size={13} style={iconInInput} aria-hidden="true" />
                                        <select
                                            id={`${uid}-cliente`}
                                            value={createForm.userId}
                                            onChange={e => { patchForm({ userId: e.target.value }); clearFieldError('userId'); }}
                                            aria-invalid={!!fieldErrors.userId || undefined}
                                            style={selectStyle}
                                        >
                                            <option value="">Selecione o cliente</option>
                                            {clientUsers.map(u => <option key={u.id} value={u.id}>{u.name}{u.email ? ` (${u.email})` : ''}</option>)}
                                        </select>
                                    </div>
                                    {fieldErrors.userId && <div className="field-error-message">{fieldErrors.userId}</div>}
                                    {selectedUser && (
                                        <div style={{ padding: '6px 10px', borderRadius: '8px', background: 'var(--success-bg)', border: '1px solid rgba(16,185,129,0.2)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <span style={{ width: 24, height: 24, borderRadius: 6, background: 'rgba(16,185,129,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.625rem', fontWeight: 700, color: 'var(--success)' }}>{selectedUser.name.charAt(0)}</span>
                                            <div style={{ minWidth: 0 }}>
                                                <div style={{ fontSize: '0.75rem', fontWeight: 600 }}>{selectedUser.name}</div>
                                                {selectedUser.email && <div style={{ fontSize: '0.625rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedUser.email}</div>}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Project name */}
                                <div className="admin-field">
                                    <label className="admin-field__label" htmlFor={`${uid}-nome-projeto`}>Nome do Projeto *</label>
                                    <div style={{ position: 'relative' }}>
                                        <NotebookPen size={13} style={iconInInput} aria-hidden="true" />
                                        <input
                                            id={`${uid}-nome-projeto`}
                                            value={createForm.name}
                                            onChange={e => { patchForm({ name: e.target.value }); clearFieldError('name'); }}
                                            placeholder="Ex: Podcast Verão 2026"
                                            aria-invalid={!!fieldErrors.name || undefined}
                                            className={`form-input form-input--raised${fieldErrors.name ? ' error' : ''}`}
                                            style={{ paddingLeft: 36, fontSize: '0.8125rem' }}
                                        />
                                    </div>
                                    {fieldErrors.name && <div className="field-error-message">{fieldErrors.name}</div>}
                                </div>
                            </div>

                            {/* Type selector cards */}
                            <div style={{ marginBottom: '14px' }}>
                                <span className="admin-field__label" style={blockLabel}>Tipo de contrato</span>
                                <div className="admin-grid-2" style={{ gap: '8px' }}>
                                    {([
                                        { key: 'FIXO' as const, icon: Pin, label: 'Fixo', desc: 'Recorrente: dia e horário fixos toda semana', tone: ACCENT_TONE },
                                        { key: 'FLEX' as const, icon: RefreshCw, label: 'Flex', desc: 'Créditos: agende quando quiser', tone: SUCCESS_TONE },
                                    ]).map(t => {
                                        const active = createForm.type === t.key;
                                        return (
                                            <button key={t.key} type="button" aria-pressed={active}
                                                onClick={() => patchSchedule({ type: t.key })}
                                                style={choiceStyle(active, t.tone, { textAlign: 'left' })}>
                                                <div style={{ fontSize: '0.875rem', fontWeight: 700, color: active ? t.tone.color : 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}><t.icon size={14} aria-hidden="true" /> {t.label}</div>
                                                <div style={{ fontSize: '0.625rem', color: 'var(--text-secondary)', marginTop: '3px' }}>{t.desc}</div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Tier selector cards */}
                            <div style={{ marginBottom: '14px' }}>
                                <span className="admin-field__label" style={blockLabel}>Faixa</span>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
                                    {(['COMERCIAL', 'AUDIENCIA', 'SABADO'] as const).map(key => {
                                        const meta = TIER_META[key];
                                        const active = createForm.tier === key;
                                        const price = pricing.find(p => p.tier === key)?.price;
                                        return (
                                            <button key={key} type="button" aria-pressed={active}
                                                onClick={() => patchSchedule({ tier: key })}
                                                style={choiceStyle(active, { color: meta.color, bg: meta.bg, border: `${meta.color}66` }, { padding: '10px 8px', textAlign: 'center' })}>
                                                <div style={{ display: 'flex', justifyContent: 'center', color: active ? meta.color : 'var(--text-secondary)' }}><meta.icon size={16} aria-hidden="true" /></div>
                                                <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: active ? meta.color : 'var(--text-primary)', marginTop: '2px' }}>{meta.label}</div>
                                                {price != null && <div style={{ fontSize: '0.625rem', color: 'var(--text-secondary)', marginTop: '2px' }}>{formatBRL(price)}/ep</div>}
                                            </button>
                                        );
                                    })}
                                </div>
                                {createForm.type === 'FIXO' && (
                                    <p style={{ fontSize: '0.6875rem', color: 'var(--text-secondary)', margin: '6px 0 0' }}>
                                        No Fixo, a faixa {tierMeta.label} grava {grid
                                            ? describeDays(allowedDays)
                                            : createForm.tier === 'SABADO' ? 'só aos sábados' : 'de segunda a sexta'}.
                                    </p>
                                )}
                            </div>

                            {/* Duration selector */}
                            <div>
                                <span className="admin-field__label" style={blockLabel}>Pacote & Duração</span>
                                <div className="admin-grid-2" style={{ gap: '8px' }}>
                                    {[
                                        { months: 3 as const, eps: ep3, disc: disc3 },
                                        { months: 6 as const, eps: ep6, disc: disc6 },
                                    ].map(p => {
                                        const active = createForm.durationMonths === p.months;
                                        return (
                                            <button key={p.months} type="button" aria-pressed={active}
                                                onClick={() => patchSchedule({ durationMonths: p.months })}
                                                style={choiceStyle(active, SUCCESS_TONE, { textAlign: 'center' })}>
                                                <div style={{ fontSize: '1.25rem', fontWeight: 800, color: active ? 'var(--success)' : 'var(--text-primary)' }}>{p.eps}</div>
                                                <div style={{ fontSize: '0.625rem', color: 'var(--text-secondary)' }}>gravações · {p.months} meses</div>
                                                <div style={{ marginTop: '4px', display: 'inline-flex', padding: '2px 6px', borderRadius: '6px', fontSize: '0.625rem', fontWeight: 700, background: 'var(--success-bg)', color: 'var(--success)' }}>-{p.disc}% desconto</div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            </div>
                            <p style={stepHintStyle} aria-live="polite">{!canStep1 && step1Hint ? step1Hint : ''}</p>
                            <div className="admin-actions-row">
                                <button key="cancel" type="button" onClick={ignoreMultiClick(onClose)} className="btn-admin-ghost">
                                    Cancelar
                                </button>
                                <button key="next" type="button" disabled={!canStep1}
                                    onClick={ignoreMultiClick(() => goNext(canStep1))}
                                    className="btn-admin-go">
                                    Próximo →
                                </button>
                            </div>
                        </div>
                    )}

                    {/* -------- STEP 2: Agenda (início, dia/horário da grade, link) -------- */}
                    {step === 2 && (
                        <div style={stepBodyStyle}>
                            <div style={stepContentStyle}>
                            <div className="admin-grid-2" style={{ gap: '12px', marginBottom: '14px' }}>
                                <div className="admin-field">
                                    <label className="admin-field__label" htmlFor={`${uid}-data-inicio`}>Data de Início *</label>
                                    <div style={{ position: 'relative' }}>
                                        <CalendarDays size={13} style={iconInInput} aria-hidden="true" />
                                        <input id={`${uid}-data-inicio`} type="date" value={createForm.startDate}
                                            onChange={e => patchSchedule({ startDate: e.target.value })}
                                            aria-invalid={!startDateOk || !!fieldErrors.startDate || undefined}
                                            className={`form-input form-input--raised${!startDateOk || fieldErrors.startDate ? ' error' : ''}`}
                                            style={{ paddingLeft: 36, fontSize: '0.8125rem' }} />
                                    </div>
                                    {fieldErrors.startDate && <div className="field-error-message">{fieldErrors.startDate}</div>}
                                </div>
                                <div className="admin-field">
                                    <label className="admin-field__label" htmlFor={`${uid}-contract-url`}>Link do Contrato</label>
                                    <div style={{ position: 'relative' }}>
                                        <Link2 size={13} style={iconInInput} aria-hidden="true" />
                                        <input id={`${uid}-contract-url`} type="url" inputMode="url" value={createForm.contractUrl}
                                            onChange={e => { patchForm({ contractUrl: e.target.value }); clearFieldError('contractUrl'); }}
                                            onBlur={() => setLinkTouched(true)}
                                            placeholder="https://contrato.digital/..."
                                            aria-invalid={showLinkError || undefined}
                                            aria-describedby={showLinkError ? `${uid}-contract-url-err` : undefined}
                                            className={`form-input form-input--raised${showLinkError ? ' error' : ''}`}
                                            style={{ paddingLeft: 36, fontSize: '0.8125rem' }} />
                                    </div>
                                    {showLinkError && <div id={`${uid}-contract-url-err`} className="field-error-message">{LINK_ERROR}</div>}
                                </div>
                            </div>

                            {/* FIXO: dia e horário SÓ da grade da faixa (D8) */}
                            {createForm.type === 'FIXO' && (
                                <div style={{ padding: '14px', borderRadius: '10px', background: 'rgba(17,129,155,0.05)', border: '1px solid rgba(17,129,155,0.18)' }}>
                                    <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--accent-text)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                        <RefreshCw size={11} aria-hidden="true" />Configuração Recorrente
                                        <span style={{ fontSize: '0.625rem', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: tierMeta.bg, color: tierMeta.color, letterSpacing: 0, textTransform: 'none' }}>Faixa {tierMeta.label}</span>
                                    </div>

                                    {slotGrid.error ? (
                                        <div className="admin-alert admin-alert--danger" role="alert" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                            <AlertCircle size={16} aria-hidden="true" />
                                            <span style={{ flex: '1 1 200px' }}>{slotGrid.error}</span>
                                            <button key="retry-grid" type="button" className="btn-admin-ghost" onClick={slotGrid.invalidate}>
                                                <RefreshCw size={14} aria-hidden="true" /> Tentar novamente
                                            </button>
                                        </div>
                                    ) : !grid ? (
                                        <p style={{ margin: 0 }}>
                                            <BrandLoader size="inline" label="Carregando os horários da faixa…" />
                                        </p>
                                    ) : (
                                        <>
                                            <div className="admin-field">
                                                <span className="admin-field__label" id={`${uid}-dia-label`}>Dia da Semana *</span>
                                                {allowedDays.length === 0 ? (
                                                    <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--warning)' }}>
                                                        A faixa {tierMeta.label} não tem dias de gravação na grade atual. Ajuste em Configurações.
                                                    </p>
                                                ) : (
                                                    <div role="group" aria-labelledby={`${uid}-dia-label`}
                                                        style={{ display: 'grid', gridTemplateColumns: `repeat(${allowedDays.length}, minmax(0, 1fr))`, gap: '6px' }}>
                                                        {allowedDays.map(d => {
                                                            const active = createForm.fixedDayOfWeek === d;
                                                            return (
                                                                <button key={`dia-${d}`} type="button" aria-pressed={active} aria-label={DAY_NAMES_FULL[d]}
                                                                    onClick={() => patchSchedule({
                                                                        fixedDayOfWeek: d,
                                                                        // Mantém o horário só se ele existir no novo dia.
                                                                        fixedTime: isValidSlot(d, createForm.fixedTime) ? createForm.fixedTime : null,
                                                                    })}
                                                                    style={choiceStyle(active, ACCENT_TONE, { padding: '8px 2px', minHeight: 44, fontSize: '0.75rem', fontWeight: 700, textAlign: 'center', color: active ? 'var(--accent-text)' : 'var(--text-secondary)' })}>
                                                                    {DAY_NAMES[d]}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                )}
                                            </div>

                                            <div className="admin-field" style={{ marginTop: '14px' }}>
                                                <span className="admin-field__label" id={`${uid}-horario-label`}>Horário *</span>
                                                <ContractSlotPicker
                                                    tier={createForm.tier}
                                                    dayOfWeek={createForm.fixedDayOfWeek}
                                                    value={createForm.fixedTime}
                                                    onChange={time => patchSchedule({ fixedTime: time })}
                                                    label="Horário de gravação"
                                                />
                                                {fieldErrors.slot && <div className="field-error-message" role="alert">{fieldErrors.slot}</div>}
                                            </div>
                                        </>
                                    )}

                                    {/* check-fixo: o dia da semana inteiro está lotado no período */}
                                    {weekdayNotice && (
                                        <div role="alert" style={{ marginTop: '14px', padding: '12px 14px', borderRadius: '10px', background: 'var(--warning-bg)', border: '1px solid rgba(245,158,11,0.3)' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: '0.8125rem', color: 'var(--warning)' }}>
                                                <CalendarX2 size={16} aria-hidden="true" />
                                                Sem vaga {WEEKDAY_AT[weekdayNotice.dayOfWeek]} neste período
                                            </div>
                                            <p style={{ margin: '6px 0 0', fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                                                Não há horário livre na faixa {TIER_META[weekdayNotice.tier]?.label ?? weekdayNotice.tier} {WEEKDAY_AT[weekdayNotice.dayOfWeek]} em
                                                todo o período do contrato (a partir de {formatYmd(createForm.startDate)}): nenhuma gravação caberia nesse dia.
                                            </p>
                                            <p style={{ margin: '6px 0 0', fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                                                {weekdayNotice.forecast
                                                    ? <>Previsão: há vaga {WEEKDAY_AT[weekdayNotice.dayOfWeek]} a partir de <strong style={{ color: 'var(--text-primary)' }}>{formatYmd(weekdayNotice.forecast)}</strong>.</>
                                                    : <>Não encontramos vaga nesse dia nas próximas 26 semanas.</>}
                                            </p>
                                            {weekdayNotice.alternatives.length > 0 ? (
                                                <>
                                                    <p style={{ margin: '10px 0 6px', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                                                        Trocar o dia da semana (mantendo {weekdayNotice.time}):
                                                    </p>
                                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                                        {weekdayNotice.alternatives.map(a => (
                                                            <button key={`alt-${a.dayOfWeek}`} type="button" className="btn-admin-ghost"
                                                                style={{ padding: '8px 12px', fontSize: '0.75rem' }}
                                                                onClick={() => patchSchedule({ fixedDayOfWeek: a.dayOfWeek })}>
                                                                {DAY_NAMES_FULL[a.dayOfWeek]}
                                                                <span style={{ fontWeight: 600, color: a.conflictFree ? 'var(--success)' : 'var(--warning)' }}>
                                                                    · {a.conflictFree ? 'sem conflitos' : `${a.conflictCount} conflito${a.conflictCount > 1 ? 's' : ''}`}
                                                                </span>
                                                            </button>
                                                        ))}
                                                    </div>
                                                </>
                                            ) : (
                                                <p style={{ margin: '6px 0 0', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                                    Nenhum outro dia da semana tem {weekdayNotice.time} livre no período — escolha outro horário ou outra data de início.
                                                </p>
                                            )}
                                            {weekdayNotice.forecast && weekdayNotice.forecast !== createForm.startDate && (
                                                <button key="use-forecast" type="button" className="btn-admin-ghost"
                                                    style={{ marginTop: 8, padding: '8px 12px', fontSize: '0.75rem' }}
                                                    onClick={() => patchSchedule({ startDate: weekdayNotice.forecast! })}>
                                                    <CalendarDays size={14} aria-hidden="true" /> Começar em {formatYmd(weekdayNotice.forecast)}
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* FLEX info */}
                            {createForm.type === 'FLEX' && (
                                <div style={{ padding: '12px 14px', borderRadius: '10px', background: 'rgba(16,185,129,0.04)', border: '1px solid rgba(16,185,129,0.12)', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                    <div style={{ fontWeight: 700, color: 'var(--success)', marginBottom: '6px', fontSize: '0.6875rem' }}><RefreshCw size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} aria-hidden="true" />Regras Flex</div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                        <span>• Mínimo 1 gravação/semana (use ou perca)</span>
                                        <span>• Adiantamento livre de créditos</span>
                                        <span>• Compensação automática de semanas futuras</span>
                                    </div>
                                </div>
                            )}

                            </div>
                            <p style={stepHintStyle} aria-live="polite">{!canStep2 && step2Hint ? step2Hint : ''}</p>
                            <div className="admin-actions-row admin-actions-row--between">
                                <button key="back" type="button" onClick={back} className="btn-admin-ghost">
                                    ← Voltar
                                </button>
                                <button key="next" type="button" disabled={!canStep2}
                                    onClick={ignoreMultiClick(() => goNext(canStep2))}
                                    className="btn-admin-go">
                                    Próximo →
                                </button>
                            </div>
                        </div>
                    )}

                    {/* -------- STEP 3: Serviços por gravação -------- */}
                    {step === 3 && (
                        <div style={stepBodyStyle}>
                            <div style={stepContentStyle}>
                            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0 0 12px' }}>
                                Opcional. Acompanham toda gravação do contrato e entram na parcela. Valor com {discount}% de desconto de fidelidade.
                            </p>
                            {addonsLoading ? (
                                <p style={{ margin: 0 }}>
                                    <BrandLoader size="inline" label="Carregando serviços…" />
                                </p>
                            ) : addons.length === 0 ? (
                                <div className="admin-empty" style={{ padding: '24px 16px' }}>
                                    <Sparkles size={22} className="admin-empty__icon" aria-hidden="true" />
                                    <div className="admin-empty__title">Nenhum serviço por gravação cadastrado</div>
                                    <div className="admin-empty__hint">Siga para o resumo: o contrato fica sem serviços extras.</div>
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    {addons.map(addon => {
                                        const selected = selectedAddons.includes(addon.key);
                                        const perRecording = Math.round(addon.price * (1 - discount / 100));
                                        return (
                                            <ServiceLineItem
                                                key={addon.key}
                                                name={addon.name}
                                                description={addon.description}
                                                perRecordingCents={perRecording}
                                                sessionsPerMonth={sessionsPerMonth}
                                                selected={selected}
                                                onToggle={() => setSelectedAddons(prev => selected ? prev.filter(k => k !== addon.key) : [...prev, addon.key])}
                                            />
                                        );
                                    })}
                                </div>
                            )}
                            {selectedAddons.length > 0 && quote && (
                                <div style={{ marginTop: 10, fontSize: '0.75rem', color: 'var(--accent-text)', fontWeight: 700, textAlign: 'right' }}>
                                    +{formatBRL(quote.servicesPerRecordingCents)}/gravação em serviços
                                </div>
                            )}

                            </div>
                            <div className="admin-actions-row admin-actions-row--between">
                                <button key="back" type="button" onClick={back} className="btn-admin-ghost">
                                    ← Voltar
                                </button>
                                <button key="next" type="button" onClick={ignoreMultiClick(() => goNext(true))} className="btn-admin-go">
                                    Próximo →
                                </button>
                            </div>
                        </div>
                    )}

                    {/* -------- STEP 4: Resumo (cobrança, estimativa, cupom e criar) -------- */}
                    {step === 4 && (
                        <div style={stepBodyStyle}>
                            <div style={stepContentStyle}>
                            {/* Summary card */}
                            <div style={{ padding: '16px 18px', borderRadius: '14px', marginBottom: '18px', background: 'var(--bg-secondary)', border: '1px solid var(--border-default)' }}>
                                <div className="admin-field__label" style={{ marginBottom: 12 }}>Resumo do contrato</div>
                                <div className="admin-grid-2" style={{ gap: '12px 20px', fontSize: '0.8125rem' }}>
                                    <div>
                                        <div style={{ fontSize: '0.6875rem', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 2 }}>Cliente</div>
                                        <div style={{ fontWeight: 700 }}>{selectedUser?.name ?? '—'}</div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '0.6875rem', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 2 }}>Projeto</div>
                                        <div style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{createForm.name.trim() || '—'}</div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '0.6875rem', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 2 }}>Plano</div>
                                        <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                            {createForm.type === 'FIXO' ? 'Fixo' : 'Flex'}
                                            <span style={{ fontSize: '0.625rem', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: tierMeta.bg, color: tierMeta.color }}>{tierMeta.label}</span>
                                            <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{episodes} gravações · {createForm.durationMonths} meses</span>
                                        </div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '0.6875rem', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 2 }}>Agenda</div>
                                        <div style={{ fontWeight: 600 }}>
                                            Início em {formatYmd(createForm.startDate)}
                                            {createForm.type === 'FIXO' && createForm.fixedDayOfWeek != null && createForm.fixedTime && (
                                                <div style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>
                                                    {capitalize(WEEKDAY_AT[createForm.fixedDayOfWeek])} · {selectedSlot ? formatSlotRange(selectedSlot) : createForm.fixedTime}
                                                </div>
                                            )}
                                            {createForm.type === 'FLEX' && <div style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>Agenda livre com créditos</div>}
                                        </div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '0.6875rem', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 2 }}>Serviços</div>
                                        <div style={{ fontWeight: 600 }}>
                                            {selectedAddons.length === 0 ? 'Nenhum' : selectedAddons.map(k => addons.find(a => a.key === k)?.name ?? k).join(', ')}
                                        </div>
                                    </div>
                                    {createForm.contractUrl.trim() && (
                                        <div>
                                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 2 }}>Link do contrato</div>
                                            <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{createForm.contractUrl.trim()}</div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Billing plan toggle: Mensal | Integral */}
                            <div style={{ marginBottom: '14px' }}>
                                <span className="admin-field__label" style={blockLabel}>Plano de cobrança</span>
                                <div className="admin-grid-2" style={{ gap: '8px' }}>
                                    {[
                                        { key: 'MONTHLY' as const, icon: CalendarDays, label: 'Mensal', desc: `${createForm.durationMonths} parcelas` },
                                        { key: 'FULL' as const, icon: Wallet, label: 'Integral', desc: '1 cobrança do total' },
                                    ].map(p => {
                                        const active = createForm.paymentPlan === p.key;
                                        return (
                                            <button key={p.key} type="button" aria-pressed={active}
                                                onClick={ignoreMultiClick(() => patchForm({ paymentPlan: p.key }))}
                                                style={choiceStyle(active, ACCENT_TONE, { textAlign: 'left' })}>
                                                <div style={{ fontSize: '0.875rem', fontWeight: 700, color: active ? 'var(--accent-text)' : 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}><p.icon size={14} aria-hidden="true" /> {p.label}</div>
                                                <div style={{ fontSize: '0.625rem', color: 'var(--text-secondary)', marginTop: '3px' }}>{p.desc}</div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Payment method selector — unified with the client (PIX / Cartão / Boleto só com a
                                chave-mestra das Configurações ligada + Cora ativa — E3). */}
                            <div style={{ marginBottom: '18px' }}>
                                <span className="admin-field__label" style={blockLabel}>Forma de pagamento</span>
                                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${boletoOn ? 3 : 2}, 1fr)`, gap: '8px' }}>
                                    {([
                                        { key: 'PIX' as const, icon: Zap, label: 'PIX' },
                                        { key: 'CARTAO' as const, icon: CreditCard, label: 'Cartão' },
                                        ...(boletoOn ? [{ key: 'BOLETO' as const, icon: FileText, label: 'Boleto' }] : []),
                                    ]).map(m => {
                                        const active = paymentMethod === m.key;
                                        return (
                                            <button key={m.key} type="button" aria-pressed={active}
                                                onClick={ignoreMultiClick(() => setPaymentMethod(m.key))}
                                                style={choiceStyle(active, ACCENT_TONE, { padding: '10px 8px', textAlign: 'center' })}>
                                                <div style={{ display: 'flex', justifyContent: 'center', color: active ? 'var(--accent-text)' : 'var(--text-secondary)' }}><m.icon size={16} aria-hidden="true" /></div>
                                                <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: active ? 'var(--accent-text)' : 'var(--text-primary)', marginTop: '2px' }}>{m.label}</div>
                                            </button>
                                        );
                                    })}
                                </div>
                                <div style={{ fontSize: '0.6875rem', color: 'var(--text-secondary)', marginTop: '6px', lineHeight: 1.45 }}>
                                    É a forma do contrato e a aba que abre na cobrança — na hora de cobrar dá para trocar entre PIX e cartão{boletoOn ? ' (ou boleto)' : ''}.
                                    {planSel === 'FULL' && quote && quote.fullPix < quote.fullCard && (
                                        <> À vista: <strong>{formatBRL(quote.fullPix)} no PIX</strong> (com desconto) · {formatBRL(quote.fullCard)} no cartão{boletoOn ? ' ou boleto' : ''}.</>
                                    )}
                                </div>
                            </div>

                            {/* Price Preview */}
                            {tierPrice && (
                                <div style={{ marginBottom: '18px' }}>
                                    <span className="admin-field__label" style={blockLabel}>Estimativa de preço</span>
                                    <div style={{ padding: '16px', borderRadius: '12px', background: 'linear-gradient(135deg, rgba(16,185,129,0.06), rgba(6,78,59,0.03))', border: '1px solid rgba(16,185,129,0.15)' }}>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px', fontSize: '0.8125rem' }}>
                                            <span style={{ color: 'var(--text-secondary)' }}>Preço base/episódio</span>
                                            <span style={{ textAlign: 'right', fontWeight: 600 }}>{formatBRL(base)}</span>

                                            <span style={{ color: 'var(--text-secondary)' }}>Desconto fidelidade ({discount}%)</span>
                                            <span style={{ textAlign: 'right', color: 'var(--success)', fontWeight: 600 }}>-{formatBRL(base - discounted)}</span>

                                            <span style={{ color: 'var(--text-secondary)' }}>Preço/ep com desconto</span>
                                            <span style={{ textAlign: 'right', fontWeight: 700 }}>{formatBRL(discounted)}</span>

                                            <div style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--border-default)', margin: '4px 0' }} />

                                            <span style={{ fontWeight: 700 }}>{episodes} episódios × {formatBRL(discounted)}</span>
                                            <span style={{ textAlign: 'right', fontSize: '1.125rem', fontWeight: 800, color: 'var(--success)' }}>{formatBRL(total)}</span>

                                            {selectedAddons.length > 0 && quote && (
                                                <>
                                                    <span style={{ color: 'var(--accent-text)', fontWeight: 600 }}>Serviços ({episodes} grav. × {formatBRL(quote.servicesPerRecordingCents)})</span>
                                                    <span style={{ textAlign: 'right', color: 'var(--accent-text)', fontWeight: 700 }}>+{formatBRL(quote.servicesPerRecordingCents * episodes)}</span>
                                                </>
                                            )}

                                            {planSel === 'FULL' ? (
                                                <>
                                                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>À vista {paymentMethod === 'PIX'
                                                        ? '(PIX, com desconto)'
                                                        : paymentMethod === 'BOLETO' ? '(boleto)'
                                                        // Parcelas só se o gateway parcela (a cotação já filtra: conta Stripe BR → só 1x).
                                                        : (() => {
                                                            const maxCard = (quote?.installmentPlans ?? []).reduce((m, p) => Math.max(m, p.count), 1);
                                                            return maxCard > 1 ? `(cartão, até ${maxCard}x)` : '(cartão, 1x)';
                                                        })()}</span>
                                                    <span style={{ textAlign: 'right', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{formatBRL(quote ? (paymentMethod === 'PIX' ? quote.fullPix : quote.fullCard) : total)}</span>
                                                </>
                                            ) : (
                                                <>
                                                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>Mensal (1x, sem acréscimo)</span>
                                                    <span style={{ textAlign: 'right', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{createForm.durationMonths}× {formatBRL(quote ? quote.monthlyAmount : monthly)}/mês</span>
                                                </>
                                            )}

                                            {appliedCoupon && (
                                                <>
                                                    <span style={{ color: 'var(--success)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}><TicketPercent size={13} aria-hidden="true" /> Cupom {appliedCoupon.code}</span>
                                                    <span style={{ textAlign: 'right', color: 'var(--success)', fontWeight: 700 }}>−{formatBRL(appliedCoupon.discountAmount)}</span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Cupom de desconto (aplica na 1ª cobrança; elegibilidade é do cliente) */}
                            <div>
                                <CouponField
                                    amount={chargeAmount}
                                    userId={createForm.userId || undefined}
                                    applied={appliedCoupon}
                                    onApply={setAppliedCoupon}
                                    onRemove={() => setAppliedCoupon(null)}
                                    disabled={!createForm.userId || creating || checking}
                                />
                                {zeroCouponNeedsBaixa && (
                                    <div id={`${uid}-zero-coupon`} className="admin-alert admin-alert--warning" role="status" style={{ marginTop: 8, marginBottom: 0, fontSize: '0.75rem', lineHeight: 1.45 }}>
                                        <AlertCircle size={13} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 4 }} />
                                        Cupom que zera a 1ª cobrança registra a parcela como paga e exige a permissão “Marcar como pago, anular ou estornar”. Remova o cupom ou use um de valor menor.
                                    </div>
                                )}
                            </div>

                            {/* Equipe sem "Cobrar o cliente": avisa ANTES de criar que a 1ª cobrança fica pendente. */}
                            {!canChargeNow && (
                                <div className="admin-info-banner" role="note" style={{ marginTop: 14 }}>
                                    <AlertCircle size={16} className="admin-info-banner__icon" aria-hidden="true" />
                                    <span>O contrato nasce ativo e a 1ª cobrança fica <strong>pendente</strong>: o cliente paga pelo app. Cobrar na hora (PIX ou cartão) exige a permissão “Cobrar o cliente”.</span>
                                </div>
                            )}

                            </div>
                            <div className="admin-actions-row admin-actions-row--between">
                                <button key="back" type="button" onClick={back} disabled={creating || checking} className="btn-admin-ghost">
                                    ← Voltar
                                </button>
                                <button key="submit" type="button" onClick={ignoreMultiClick(handleCreate)} disabled={!canCreate || creating || checking || zeroCouponNeedsBaixa}
                                    aria-describedby={zeroCouponNeedsBaixa ? `${uid}-zero-coupon` : undefined} className="btn-admin-go">
                                    {checking ? 'Verificando agenda…' : creating ? 'Criando…' : <><FileText size={15} aria-hidden="true" /> Criar Contrato</>}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </BottomSheetModal>

            {/* Conflict Resolution Modal */}
            {showConflictModal && (
                <BottomSheetModal isOpen onClose={() => setShowConflictModal(false)} preventClose={creating} hideHeader size="md" title="Conflitos de Agenda">
                        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                            <AlertTriangle size={40} style={{ color: 'var(--warning)', opacity: 0.6, marginBottom: 8 }} aria-hidden="true" />
                            <h3 style={{ fontSize: '1.25rem', color: '#ef4444' }}>Conflitos de Agenda</h3>
                            <p style={{ color: 'var(--text-muted)' }}>Alguns dias já têm gravações. Aplicamos a auto-substituição (mesmo dia ou outro dia); dias sem alternativa são pulados — nunca gravamos por cima.</p>
                        </div>

                        {createError && <div className="admin-alert admin-alert--danger" role="alert">{createError}</div>}

                        <div style={{ background: 'var(--bg-secondary)', padding: '16px', borderRadius: 'var(--radius-md)', marginBottom: '24px', maxHeight: '400px', overflowY: 'auto' }}>
                            <div style={{ fontWeight: 700, marginBottom: '12px', fontSize: '0.875rem' }}>Ocorrências Interceptadas:</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                {conflicts.map((c, i) => {
                                    const ymd = c.date.split('-');
                                    const dateObj = new Date(`${c.date}T12:00:00`);
                                    const localDate = `${ymd[2]}/${ymd[1]}/${ymd[0]}`;
                                    const dow = DAY_NAMES_FULL[dateObj.getDay()];

                                    return (
                                        <div key={i} style={{ padding: '12px', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                                                <span style={{ fontWeight: 600 }}>{dow}, {localDate} às {c.originalTime}</span>
                                                <span style={{ fontSize: '0.75rem', color: '#ef4444', fontWeight: 600, background: 'rgba(239, 68, 68, 0.1)', padding: '2px 8px', borderRadius: '10px' }}>Indisponível</span>
                                            </div>

                                            {c.suggestedReplacement ? (
                                                <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><RefreshCw size={12} aria-hidden="true" /> Auto-substituição:</span>
                                                    <span style={{ background: 'rgba(34, 197, 94, 0.1)', color: '#22c55e', padding: '4px 8px', borderRadius: '4px', fontWeight: 600 }}>
                                                        {c.suggestedReplacement.date === c.date
                                                            ? `${c.suggestedReplacement.time} (mesmo dia)`
                                                            : (() => { const p = c.suggestedReplacement!.date.split('-'); return `${DAY_NAMES_FULL[new Date(`${c.suggestedReplacement!.date}T12:00:00`).getDay()]} ${p[2]}/${p[1]} · ${c.suggestedReplacement!.time} (outro dia)`; })()}
                                                    </span>
                                                </div>
                                            ) : (
                                                <div style={{ fontSize: '0.8125rem', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={12} aria-hidden="true" /> Dia lotado e sem dia próximo livre — esta ocorrência será <strong>pulada</strong> (não gravamos por cima). Remarque manualmente.</span>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="modal-actions" style={{ flexDirection: 'column', gap: '12px' }}>
                            <button key="conflict-confirm" type="button" className="btn btn-primary" style={{ width: '100%', padding: '14px' }}
                                disabled={creating}
                                onClick={ignoreMultiClick(() => executeCreate(resolvedConflicts))}>
                                {creating ? 'Criando…' : 'Criar (aplicar sugestões · pular dias lotados)'}
                            </button>
                            <button key="conflict-cancel" type="button" className="btn btn-secondary" style={{ width: '100%', padding: '14px' }}
                                disabled={creating}
                                onClick={ignoreMultiClick(() => setShowConflictModal(false))}>
                                Cancelar e voltar para escolhas
                            </button>
                        </div>
                </BottomSheetModal>
            )}
        </>
    );
}
