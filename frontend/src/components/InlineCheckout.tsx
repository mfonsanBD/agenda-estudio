import { getErrorMessage } from '../utils/errors';
// ─── InlineCheckout — Unified Payment Component ─────────
// ÚNICO checkout do sistema: abas PIX | Cartão (Crédito | Débito) | Boleto.
//  - Boleto (E3): fonte ÚNICA = `boleto.available` de GET /pricing/payment-methods (chave-mestra das
//    Configurações + Cora) E o checkout precisa ser elegível (`offerBoleto`: cobrança do admin ou
//    fatura/parcela de contrato já ativo). Nunca nos fluxos com reserva de 10 minutos do cliente. A
//    liberação por contrato (`allowBoleto`/`boletoAllowed`) deixou de existir. O backend é a autoridade:
//    400 BOLETO_UNAVAILABLE / BOLETO_NOT_ALLOWED_HERE tiram a aba e avisam.
//  - Admin cobrando um cliente (E1): CPF e cartões salvos são os do CLIENTE dono do pagamento
//    (GET /stripe/payment-methods/for-payment/:paymentId) — nunca os do admin logado.
//  - Preço por aba ANTES de gerar (E2): `pixAmount`/`cardAmount` de /stripe/installment-plans. O PIX do
//    à vista tem desconto; cartão e boleto cobram o preço de cartão. Gerado o PIX, vale o `amount` dele.
// Toda cobrança sai de POST /stripe/create-payment a partir do paymentId (fonte única):
//  - PIX (D15): QR + validade + valor vêm da resposta (qrCodeDataUrl/expiresAt/amount) e o bloco é
//    o <PixQrCode>. QR expirado (contagem ou FAILED no polling) → "Gerar novo QR" chama o
//    create-payment de novo e reinicia o polling — nunca derruba o fluxo do pai (onError).
//  - Cartão: PaymentIntent criado com o nº de parcelas escolhido (política única do backend). N > 1 só
//    com cartão SALVO numa conta que parcela (o servidor fixa o plano); conta Stripe BR → só 1x.
//  - Valor exibido = valor cobrado (D1): no cartão, o total mostrado é o do plano 1x de
//    /stripe/installment-plans (o servidor calcula com cardChargeBaseAmount: SEM o desconto PIX do à
//    vista); com o PaymentIntent do cartão novo criado, o `amount` que o create-payment devolve (o
//    chargedAmount). No PIX, o `amount` da cobrança (com o desconto). Se diferem, o checkout avisa.
//    Se a cotação falhar com a cobrança já criada, o cartão/boleto mostram "valor a confirmar" (nunca o
//    preço do PIX), o cartão SALVO fica bloqueado e há "Tentar de novo"; PIX e cartão novo seguem.
//  - "Salvar cartão": a caixa fica ANTES do "Continuar com novo cartão" — o PaymentIntent já nasce com
//    (ou sem) `savePaymentMethod`; dentro do formulário do Stripe a escolha não teria mais efeito.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import StripeCardForm from './StripeCardForm';
import PixQrCode from './PixQrCode';
import BrandLoader from './ui/BrandLoader';
import { stripeApi, paymentsApi, ApiError, type SavedCard, type PaymentPayer } from '../api/client';
import {
    getClientPaymentMethods, getPaymentMethods, methodInContext, getBoletoMethodConfig,
    isBoletoAvailable, loadPaymentMethods, usePaymentMethodsVersion, type PaymentMethodKey,
} from '../constants/paymentMethods';
import { Copy, Check, Lock, QrCode, CreditCard, Plus, ShieldCheck, FileText, Info, AlertTriangle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { usePermission } from '../hooks/usePermission';
import { isValidCpfCnpj } from '../utils/mask';
import CpfCnpjPrompt from './CpfCnpjPrompt';
import { getBrandIcon } from '../utils/cardBrand';
import { formatBRL } from '../utils/format';
import '../styles/inline-checkout.css';

// ─── Types ──────────────────────────────────────────────

interface InlineCheckoutProps {
    /** Total amount in cents */
    amount: number;
    /** Internal Payment record ID (if it already exists) */
    paymentId?: string;
    /** Human-readable description shown in the checkout */
    description: string;
    /** Contract duration in months (for installment calculation) */
    contractDuration?: number;
    /**
     * Nº de parcelas pré-selecionado no cartão de crédito (ex.: serviço "parcelar o total em até N×").
     * A política do backend manda: se N não estiver disponível, cai para a maior opção ≤ N.
     */
    initialInstallments?: number;
    /** Called when payment succeeds (any method) */
    onSuccess: () => void;
    /** Called when an error occurs */
    onError: (msg: string) => void;
    /** Optional cancel handler */
    onCancel?: () => void;
    /**
     * Quais métodos podem aparecer. Padrão: PIX, Cartão e Boleto. O Boleto, mesmo listado aqui, só
     * aparece com `offerBoleto` E com o boleto efetivamente disponível (chave-mestra + Cora).
     */
    allowedMethods?: PaymentMethodKey[];
    /**
     * Aba aberta primeiro — ex.: a forma de pagamento do contrato (um PIX abre direto no PIX, sem
     * passar pelo cartão salvo padrão). Ignorada se não estiver disponível. Padrão: a 1ª disponível.
     */
    initialMethod?: PaymentMethodKey | null;
    /** Modo admin: o admin cobra o CLIENTE dono do pagamento (cartões e CPF do cliente, nunca os do admin). */
    isAdmin?: boolean;
    /**
     * @deprecated E3 — IGNORADO. A liberação de boleto por contrato (`Contract.boletoAllowed`) deixou de
     * ser autoridade; use `offerBoleto`. Mantido só para os chamadores antigos compilarem.
     */
    allowBoleto?: boolean;
    /**
     * E3 — este checkout PODE oferecer boleto: cobrança feita pelo admin ou fatura/parcela de contrato já
     * ativo. Padrão false: os fluxos com reserva de 10 minutos (avulso do cliente, contratação nova,
     * serviço, personalizado do cliente, renovação) nunca oferecem boleto. Mesmo true, a aba só aparece
     * com `boleto.available` (chave-mestra "Aceitar pagamento por boleto" + Cora ativa).
     */
    offerBoleto?: boolean;
    /** Checkout context for per-method visibility: avulso | contract | invoice */
    context?: string;
    /**
     * Admin cobrando um CLIENTE: o gate de CPF (PIX/Boleto) e a coleta usam o CPF do CLIENTE
     * selecionado, não o do admin logado (useAuth). O backend já cobra o payment.userId (cliente).
     * Com o pagamento já criado, o pagador devolvido pelo servidor (for-payment) tem precedência.
     */
    chargeClient?: { id: string; name?: string | null; cpfCnpj?: string | null };
    /**
     * Cria o Payment sob demanda (ex.: reserva avulsa criada só na 1ª escolha de método).
     * Basta devolver `{ paymentId }`: a cobrança em si (QR PIX, PaymentIntent do cartão) é SEMPRE
     * emitida aqui via /stripe/create-payment. Os demais campos são legado: `clientSecret`
     * (PaymentIntent já criado) e `boletoUrl/barcode` ainda são aceitos; `pixString/qrCodeBase64`
     * são ignorados (o PIX vem do create-payment, com validade e reaproveitamento da cobrança viva).
     */
    createPaymentFn?: (method: 'CARTAO' | 'PIX' | 'BOLETO') => Promise<{
        paymentId: string;
        clientSecret?: string;
        pixString?: string;
        qrCodeBase64?: string;
        boletoUrl?: string;
        barcode?: string;
        paymentIntentId?: string;
    }>;
}

type ActiveTab = 'CARTAO' | 'PIX' | 'BOLETO';

/** Cobrança PIX exibida (resposta do /stripe/create-payment). */
interface PixCharge {
    pixString: string;
    qrCodeDataUrl: string | null;
    expiresAt: string | null;
    amount: number | null;
}

type InstallmentPlan = { count: number; perInstallment: number; total: number; feePercent: number; freeOfCharge: boolean };

/** Preços por forma de pagamento (E2) — /stripe/installment-plans. Centavos. */
interface PriceQuote { cardAmount: number; pixAmount: number }

// Referência estável (um `= [...]` no destructuring criaria um array novo a cada render).
const DEFAULT_ALLOWED_METHODS: PaymentMethodKey[] = ['PIX', 'CARTAO', 'BOLETO'];

const FUNDING_LABEL: Record<string, string> = { credit: 'Crédito', debit: 'Débito', prepaid: 'Pré-pago' };

const apiCode = (err: unknown): string | undefined => (err instanceof ApiError ? err.code : undefined);

const MAX_POLL_ATTEMPTS = 180; // 15 min (180 × 5s) — boleto e PIX sem validade conhecida
const MAX_CONSECUTIVE_ERRORS = 5; // ~25s de falhas seguidas → avisa em vez de pollar calado
/** PIX pago no limite da validade: ainda confere o status uma vez depois de expirar. */
const PIX_FINAL_CHECK_MS = 4000;

// ─── Component ──────────────────────────────────────────

export default function InlineCheckout({
    amount,
    paymentId: externalPaymentId,
    description,
    contractDuration,
    initialInstallments,
    onSuccess,
    onError,
    onCancel,
    allowedMethods = DEFAULT_ALLOWED_METHODS,
    initialMethod,
    isAdmin = false,
    offerBoleto = false,
    context,
    chargeClient,
    createPaymentFn,
}: InlineCheckoutProps) {
    // Re-renderiza quando o cache de métodos/boleto muda (chave-mestra ligada/desligada, revalidação).
    usePaymentMethodsVersion();
    // Admin cobrando um cliente: cartões e CPF são SEMPRE os do dono do pagamento (E1).
    const adminCharge = isAdmin || !!chargeClient;
    // Equipe (D2): debitar o cartão SALVO do cliente exige `cobrancas.cartao_salvo`. Sem ela o servidor já
    // devolve a lista vazia (`canUseSavedCards: false`) e recusa `savedPaymentMethodId` com 403 — aqui a
    // lista nem aparece e o cartão salvo nunca é enviado. O cliente pagando o próprio não passa por isto.
    const { can } = usePermission();
    const staffSavedCardsAllowed = !adminCharge || can('cobrancas.cartao_salvo');
    const [serverDeniedSavedCards, setServerDeniedSavedCards] = useState(false);
    const savedCardsLocked = adminCharge && (!staffSavedCardsAllowed || serverDeniedSavedCards);

    // Boleto state — o servidor recusou (400 BOLETO_UNAVAILABLE / BOLETO_NOT_ALLOWED_HERE): a aba some.
    const [boletoRefused, setBoletoRefused] = useState(false);
    const [boletoUrl, setBoletoUrl] = useState<string | null>(null);
    const [boletoBarcode, setBoletoBarcode] = useState<string | null>(null);
    const [boletoAmount, setBoletoAmount] = useState<number | null>(null);
    const [boletoCopied, setBoletoCopied] = useState(false);

    // PIX e Cartão: os métodos ativos (no contexto). O BOLETO nunca vem desta lista — segue só a regra E3.
    const baseMethods = (isAdmin ? getPaymentMethods() : getClientPaymentMethods()).filter(m => m.key !== 'BOLETO');
    const ctxMethods = baseMethods.filter(m =>
        allowedMethods.includes(m.key) && (!context || methodInContext(m, context))
    );
    // Safety: never leave the checkout with zero methods (e.g. admin hid all from this context,
    // or um chamador antigo que restringia a um método que não existe mais aqui).
    const listedMethods = baseMethods.filter(m => allowedMethods.includes(m.key));
    let availableMethods = ctxMethods.length > 0 ? ctxMethods : listedMethods.length > 0 ? listedMethods : baseMethods;
    // E3 — Boleto: chave-mestra + Cora (isBoletoAvailable) E checkout elegível (offerBoleto), nunca em
    // cobrança criada sob demanda (fluxos de 10 min). Um boleto já emitido continua visível.
    const boletoConfig = getBoletoMethodConfig();
    const boletoOffered = offerBoleto && !createPaymentFn && !boletoRefused && isBoletoAvailable()
        && allowedMethods.includes('BOLETO') && (!context || methodInContext(boletoConfig, context));
    if (boletoOffered || boletoUrl) availableMethods = [...availableMethods, boletoConfig];
    const availableKeys = availableMethods.map(m => m.key).join(',');

    const [activeTab, setActiveTab] = useState<ActiveTab>(() => {
        const preferred = initialMethod ? availableMethods.find(m => m.key === initialMethod) : undefined;
        return ((preferred ?? availableMethods[0])?.key as ActiveTab) || 'CARTAO';
    });
    // O usuário já escolheu uma aba: a partir daí o `initialMethod` não troca mais a aba sozinho.
    const tabTouchedRef = useRef(false);

    // Shared state
    const [processing, setProcessing] = useState(false);
    const [error, setError] = useState('');

    // Card state
    const [clientSecret, setClientSecret] = useState<string | null>(null);
    // Valor do PaymentIntent do cartão novo (create-payment devolve `amount` = chargedAmount): com o PI
    // criado, é ESTE o valor exibido no formulário — valor exibido = valor cobrado (D1).
    const [cardChargedAmount, setCardChargedAmount] = useState<number | null>(null);
    const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
    const [paymentId, setPaymentId] = useState<string | null>(externalPaymentId || null);
    const [paymentType, setPaymentType] = useState<'CREDIT' | 'DEBIT'>('CREDIT');
    const [installments, setInstallments] = useState(() =>
        initialInstallments && initialInstallments > 1 ? Math.min(12, Math.floor(initialInstallments)) : 1);
    const [installmentPlans, setInstallmentPlans] = useState<InstallmentPlan[]>([]);
    // E2: preço de cada forma (PIX × cartão/boleto) — vem junto das parcelas, do mesmo endpoint.
    const [quote, setQuote] = useState<PriceQuote | null>(null);
    // Parcelas em carregamento: o botão do cartão espera — senão um N pré-selecionado (initialInstallments)
    // ainda não conferido com a política/gateway iria ao servidor e seria recusado.
    const cardAvailable = availableMethods.some(m => m.key === 'CARTAO');
    // A cotação é pedida com o cartão disponível (parcelas) OU com a cobrança já criada (preço do PIX).
    const wantsQuote = amount > 0 && (cardAvailable || !!paymentId);
    const [plansLoading, setPlansLoading] = useState(() => amount > 0 && (cardAvailable || !!externalPaymentId));
    // CHK-2: a cotação falhou (rede/5xx). Sem ela não se conhece o preço do CARTÃO de uma cobrança já
    // criada (o `amount` pode ser o preço do PIX do à vista) — `quoteNonce` refaz a consulta ("Tentar de novo").
    const [quoteFailed, setQuoteFailed] = useState(false);
    const [quoteNonce, setQuoteNonce] = useState(0);
    // CHK-1: a escolha vale ANTES de o PaymentIntent existir (é ele que leva setup_future_usage) — a caixa
    // fica acima do "Continuar com novo cartão", nunca dentro do formulário do Stripe.
    const [wantSaveCard, setWantSaveCard] = useState(true);
    // O PaymentIntent do cartão novo foi criado COM (true) ou SEM (false) salvar o cartão; null = PI criado
    // pelo chamador (legado) — não se sabe.
    const [intentSavesCard, setIntentSavesCard] = useState<boolean | null>(null);

    // Saved cards state
    const [savedCards, setSavedCards] = useState<SavedCard[]>([]);
    const [selectedCard, setSelectedCard] = useState<string | null>('new');
    const [loadingCards, setLoadingCards] = useState(true);
    const [payingSavedCard, setPayingSavedCard] = useState(false);
    const [cardsNonce, setCardsNonce] = useState(0);
    // O usuário já mexeu na escolha do cartão: um recarregamento da lista não troca a escolha dele.
    const cardChoiceTouchedRef = useRef(false);
    // Admin cobrando: o pagador (cliente dono do pagamento) devolvido pelo servidor.
    const [payer, setPayer] = useState<PaymentPayer | null>(null);

    // PIX state
    const [pix, setPix] = useState<PixCharge | null>(null);
    const [pixExpired, setPixExpired] = useState(false);
    const [pixRegenerating, setPixRegenerating] = useState(false);
    const pollIntervalRef = useRef<number | null>(null);
    const finalCheckRef = useRef<number | null>(null);
    // PAY-H1 FIX: Prevent double-init from rapid clicks (trava por requisição em voo, nunca por tempo)
    const initGuardRef = useRef(false);
    const regenInFlightRef = useRef(false);
    const pixExpiredRef = useRef(false);
    // onSuccess dispara UMA vez (polling, simulação e "já pago" podem concorrer).
    const succeededRef = useRef(false);
    const mountedRef = useRef(true);
    // Callbacks do pai em ref: o polling (setInterval) e os fluxos assíncronos sempre chamam a versão
    // ATUAL — ex.: o onSuccess do avulso lê o bookingId criado depois que o polling começou.
    const onSuccessRef = useRef(onSuccess);
    onSuccessRef.current = onSuccess;
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;
    /** Erro do polling: aparece no próprio checkout E vai ao pai (toast/alerta de quem usa). */
    const reportError = useCallback((msg: string) => {
        if (mountedRef.current) setError(msg);
        onErrorRef.current(msg);
    }, []);
    // PIX requires a CPF/CNPJ on file (Cora invoice). Gate the charge behind an
    // inline collection step when the user has no valid document.
    const { user } = useAuth();
    // Documento salvo AGORA pelo prompt (o prop `chargeClient` vem da lista de users e não é
    // recarregado após salvar) — assim o gate/coleta não re-perguntam num retry na mesma cobrança.
    const [savedClientDoc, setSavedClientDoc] = useState<string | null>(null);
    // O servidor recusou com CPF_CNPJ_REQUIRED e disse de quem é o documento (`payerUserId`).
    const [cpfPayerId, setCpfPayerId] = useState<string | null>(null);
    // Quem paga é OUTRA pessoa (o cliente): modo admin, ou o servidor apontou um pagador diferente de quem
    // está logado. Nesses casos o documento é SEMPRE o do cliente — nunca o de quem está logado.
    const payerIsOther = !!cpfPayerId && !!user?.id && cpfPayerId !== user.id;
    const chargingOther = adminCharge || payerIsOther;
    // Documento do pagador: o do CLIENTE (devolvido pelo servidor, ou o cliente selecionado) quando se
    // cobra outra pessoa; senão, o do próprio usuário logado (cliente pagando o seu).
    const cpfOwnerDoc = savedClientDoc ?? (chargingOther ? (payer ? payer.cpfCnpj : chargeClient?.cpfCnpj) : user?.cpfCnpj);
    // Cobrando outra pessoa só dá para conferir o CPF aqui quando já sabemos quem é o pagador; sem isso,
    // o servidor confere (400 CPF_CNPJ_REQUIRED + payerUserId) e a coleta abre em seguida.
    const cpfOwnerKnown = !chargingOther || !!payer || !!chargeClient || savedClientDoc != null;
    // De quem a coleta grava o documento: cobrando o cliente, SEMPRE no perfil DELE (PATCH /users/:id).
    const cpfClientId = chargingOther ? (payer?.id ?? chargeClient?.id ?? cpfPayerId ?? null) : null;
    const cpfPromptClient = cpfClientId
        ? { id: cpfClientId, name: payer?.name ?? chargeClient?.name ?? null, cpfCnpj: cpfOwnerDoc ?? null }
        : undefined;
    // Coleta possível: cliente pagando o próprio (grava no próprio perfil) ou admin com o cliente identificado.
    const canCollectCpf = !chargingOther || !!cpfPromptClient;
    const [needsCpf, setNeedsCpf] = useState(false);
    // Sandbox testing: when PIX is in sandbox, offer a "simulate payment" button
    const [pixSandbox, setPixSandbox] = useState(false);
    const [simulating, setSimulating] = useState(false);

    // O pai pode passar o paymentId depois da montagem (ex.: criado num passo anterior).
    useEffect(() => {
        if (externalPaymentId) setPaymentId(externalPaymentId);
    }, [externalPaymentId]);

    useEffect(() => {
        paymentsApi.getSandboxMode().then(m => setPixSandbox(!!m.pix)).catch(() => {});
    }, []);

    const stopPolling = useCallback(() => {
        if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
        }
    }, []);

    const clearFinalCheck = useCallback(() => {
        if (finalCheckRef.current) {
            clearTimeout(finalCheckRef.current);
            finalCheckRef.current = null;
        }
    }, []);

    // Cleanup polling on unmount
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            stopPolling();
            clearFinalCheck();
        };
    }, [stopPolling, clearFinalCheck]);

    const fireSuccess = useCallback(() => {
        if (succeededRef.current) return;
        succeededRef.current = true;
        stopPolling();
        clearFinalCheck();
        onSuccessRef.current();
    }, [stopPolling, clearFinalCheck]);

    /** Depois de um erro, confere se a cobrança já consta PAGA (ex.: PIX pago antes de trocar de método). */
    const isAlreadyPaid = useCallback(async (pid: string | null | undefined) => {
        if (!pid) return false;
        try {
            const s = await paymentsApi.getStatus(pid);
            return s.status === 'PAID';
        } catch {
            return false;
        }
    }, []);

    const simulatePayment = useCallback(async () => {
        if (!paymentId || simulating) return;
        setSimulating(true);
        try {
            const res = await paymentsApi.simulate(paymentId);
            if (res.status === 'PAID') {
                fireSuccess();
            } else {
                setSimulating(false);
            }
        } catch {
            setSimulating(false);
        }
    }, [paymentId, simulating, fireSuccess]);

    // F5: the per-installment figure shown in the summary/pay button must match the chosen
    // plan (which already includes juros). The naive `amount / installments` understates it
    // whenever the selected plan carries interest — use the backend plan's perInstallment.
    const selectedPlan = installmentPlans.find(p => p.count === installments);
    // D1: o cartão cobra o valor do plano 1x que o SERVIDOR calcula (sem o desconto PIX do à vista);
    // sem a política ainda (carregando/falhou), a melhor prévia é o próprio `amount`.
    const oneXPlan = installmentPlans.find(p => p.count === 1);
    const cardBaseAmount = oneXPlan ? oneXPlan.total : (quote?.cardAmount ?? amount);
    const newCardCharged = selectedCard === 'new' && clientSecret && cardChargedAmount != null ? cardChargedAmount : null;
    const cardTotal = newCardCharged ?? (installments > 1 && selectedPlan ? selectedPlan.total : cardBaseAmount);
    const cardPriceLoading = plansLoading && !oneXPlan;
    // CHK-2: cobrança já criada e sem cotação → o preço do cartão é DESCONHECIDO (o `amount` pode ser o
    // preço do PIX; o servidor cobraria o preço de cartão). Nunca se mostra `amount` como preço do cartão
    // nem se cobra o cartão salvo (débito imediato) nesse estado. Sem `paymentId` (wizard com
    // createPaymentFn) o `amount` é a prévia do próprio wizard e segue valendo.
    const cardPriceUnknown = quoteFailed && !!paymentId && !oneXPlan && !quote;
    const savedCardSelected = !!selectedCard && selectedCard !== 'new';
    // Rótulos dos botões do cartão (1x): nunca o valor do PIX enquanto a política carrega.
    const cardAmountText = cardPriceLoading ? 'calculando…'
        : cardPriceUnknown && newCardCharged == null ? 'valor a confirmar'
            : formatBRL(newCardCharged ?? cardBaseAmount);
    const pixAvailable = availableMethods.some(m => m.key === 'PIX');
    const boletoAvailable = availableMethods.some(m => m.key === 'BOLETO');
    // E2 — preço de cada aba ANTES de gerar: o PIX cobra `pixAmount` (com o desconto do à vista quando a
    // cobrança tem a marca); cartão e boleto cobram o preço de cartão. Depois de gerar, vale o valor que
    // o servidor devolveu (o `amount` da cobrança muda no banco ao emitir o PIX com desconto).
    const quoteLoading = plansLoading && !quote;
    const pixPrice = pix?.amount ?? quote?.pixAmount ?? amount;
    const boletoPrice = boletoAmount ?? quote?.cardAmount ?? cardBaseAmount;
    const pixAmountText = quoteLoading && !pix ? 'calculando…' : formatBRL(pixPrice);
    // O boleto cobra o preço de cartão: sem cotação (CHK-2) o valor só é conhecido depois de emitido.
    const boletoPriceUnknown = cardPriceUnknown && boletoAmount == null;
    const boletoAmountText = quoteLoading && boletoAmount == null ? 'calculando…'
        : boletoPriceUnknown ? 'valor a confirmar'
            : formatBRL(boletoPrice);
    /** Preço das formas que não têm o desconto do à vista (cartão; boleto cobra o mesmo). */
    const nonPixPrice = cardAvailable ? cardBaseAmount : boletoPrice;
    const nonPixLabel = cardAvailable && boletoAvailable ? 'cartão ou no boleto' : cardAvailable ? 'cartão' : 'boleto';
    /** Os valores diferem entre as formas (desconto do à vista só no PIX): avisar antes de pagar. */
    const pricesDiffer = (cardAvailable || boletoAvailable) && !quoteLoading && !cardPriceLoading
        && (pixAvailable ? pixPrice < nonPixPrice : nonPixPrice > amount);
    const perInstallmentValue = selectedPlan ? selectedPlan.perInstallment : Math.ceil(cardBaseAmount / installments);
    const headerAmount = activeTab === 'CARTAO' ? cardTotal : activeTab === 'BOLETO' ? boletoPrice : pixPrice;
    const headerLoading = activeTab === 'CARTAO' ? cardPriceLoading
        : activeTab === 'BOLETO' ? quoteLoading && boletoAmount == null
            : quoteLoading && !pix;
    // CHK-2: na aba Cartão/Boleto sem cotação, o cabeçalho não afirma um valor que pode não ser o cobrado.
    const headerUnknown = activeTab === 'CARTAO' ? cardPriceUnknown && newCardCharged == null
        : activeTab === 'BOLETO' ? boletoPriceUnknown
            : false;
    const showInstallmentSelect = paymentType === 'CREDIT' && installmentPlans.length > 1;
    // O pai pediu N× (ex.: serviço "parcelar o total em até N×"), mas a política/gateway oferece menos
    // (conta Stripe BR não parcela): avisa em vez de trocar o nº de parcelas em silêncio.
    const maxPlanCount = installmentPlans.reduce((max, p) => Math.max(max, p.count), 0);
    const requestedInstallmentsUnavailable = paymentType === 'CREDIT' && !plansLoading
        && !!initialInstallments && initialInstallments > 1 && maxPlanCount > 0 && maxPlanCount < initialInstallments;

    // Saved cards: carregados ao abrir a aba Cartão. (Separado das parcelas: antes, a chegada do
    // paymentId — ex.: reserva avulsa criada no "Continuar" — recarregava a lista e trocava o cartão
    // escolhido pelo padrão, escondendo o formulário do cartão novo no meio do fluxo.)
    // Cliente pagando o próprio: os cartões de quem está logado (GET /stripe/payment-methods).
    useEffect(() => {
        if (adminCharge || activeTab !== 'CARTAO') return;
        let alive = true;
        setLoadingCards(true);
        stripeApi.listPaymentMethods()
            .then(res => {
                if (!alive) return;
                const methods = res.paymentMethods || [];
                setSavedCards(methods);
                // Auto-select the default card, or 'new' if none
                const defaultCard = methods.find(c => c.isDefault);
                setSelectedCard(defaultCard ? defaultCard.stripePaymentMethodId : 'new');
            })
            .catch(() => { if (alive) setSavedCards([]); })
            .finally(() => { if (alive) setLoadingCards(false); });
        return () => { alive = false; };
    }, [adminCharge, activeTab, cardsNonce]);

    // E1 — admin cobrando um cliente: cartões salvos e CPF do CLIENTE dono do pagamento
    // (GET /stripe/payment-methods/for-payment/:paymentId) — NUNCA os do admin logado. Carrega em
    // qualquer aba: o pagador devolvido também alimenta o gate de CPF do PIX/Boleto.
    // Nenhum cartão salvo vem pré-selecionado: cobrar o cartão salvo do cliente é uma escolha explícita.
    useEffect(() => {
        if (!adminCharge) return;
        if (!paymentId) {
            // Cobrança ainda não criada: não há de quem listar (e os cartões do admin nunca servem).
            setSavedCards([]);
            setLoadingCards(false);
            return;
        }
        let alive = true;
        setLoadingCards(true);
        stripeApi.paymentMethodsForPayment(paymentId)
            .then(res => {
                if (!alive) return;
                // `canUseSavedCards` (B3): false quando o servidor não liberou o cartão salvo para quem cobra.
                const serverDenied = (res as { canUseSavedCards?: boolean }).canUseSavedCards === false;
                setServerDeniedSavedCards(serverDenied);
                const methods = staffSavedCardsAllowed && !serverDenied ? (res.paymentMethods || []) : [];
                setSavedCards(methods);
                setPayer(res.payer ?? null);
                // Mantém a escolha do admin se o cartão ainda existe; senão, volta para "novo cartão".
                setSelectedCard(prev => (cardChoiceTouchedRef.current && prev && prev !== 'new'
                    && methods.some(c => c.stripePaymentMethodId === prev) ? prev : 'new'));
            })
            .catch(() => { if (alive) { setSavedCards([]); setSelectedCard('new'); } })
            .finally(() => { if (alive) setLoadingCards(false); });
        return () => { alive = false; };
    }, [adminCharge, paymentId, cardsNonce, staffSavedCardsAllowed]);

    // Parcelas: a política REAL vem do backend (/stripe/installment-plans com o paymentId — inclui o
    // teto do serviço: mensal parcelado = 1..N sem juros, à vista = só 1x; avulso/à vista de contrato
    // = regra própria). Sem paymentId ainda (rascunho), usa o valor + a duração como prévia.
    // Sem parcelamento no gateway (conta Stripe BR) o backend devolve só 1x — o N pré-selecionado cai para 1.
    // Carrega sempre que o cartão está disponível (não só na aba Cartão): o plano 1x é o valor do cartão.
    // E2: a mesma resposta traz `cardAmount` e `pixAmount` — o preço de cada aba ANTES de gerar. Por isso
    // também carrega sem cartão quando a cobrança já existe (o PIX do à vista pode ter desconto).
    useEffect(() => {
        if (!wantsQuote) { setPlansLoading(false); return; }
        let alive = true;
        setPlansLoading(true);
        setQuoteFailed(false);
        // Cotação anterior descartada: melhor "calculando…" do que um preço que pode não valer mais.
        setQuote(null);
        stripeApi.getInstallmentPlans({ paymentId: paymentId || undefined, amount, contractDurationMonths: contractDuration })
            .then(res => {
                if (!alive) return;
                setInstallmentPlans(res.plans || []);
                setQuote(Number.isFinite(res.cardAmount) && Number.isFinite(res.pixAmount)
                    ? { cardAmount: res.cardAmount, pixAmount: res.pixAmount }
                    : null);
            })
            // Sem a política (falha de rede): 1x, que toda política aceita — um N pré-selecionado sem seletor
            // para trocá-lo seria recusado pelo servidor a cada tentativa. O preço exibido cai no `amount`
            // só na prévia de um wizard; com a cobrança já criada o cartão fica "valor a confirmar" (CHK-2).
            .catch(() => { if (alive) { setQuoteFailed(true); setInstallments(1); } })
            .finally(() => { if (alive) setPlansLoading(false); });
        return () => { alive = false; setPlansLoading(false); };
    }, [wantsQuote, amount, contractDuration, paymentId, quoteNonce]);

    // E3 — revalida a chave-mestra do boleto ao abrir um checkout que pode oferecê-lo (o cache é
    // carregado uma vez por sessão; o admin pode ter ligado/desligado o boleto depois).
    useEffect(() => {
        if (offerBoleto) void loadPaymentMethods();
    }, [offerBoleto]);

    // A escolha precisa existir na política atual (ex.: teto do serviço chegou com o paymentId).
    useEffect(() => {
        if (installmentPlans.length === 0) return;
        if (installmentPlans.some(p => p.count === installments)) return;
        const fallback = installmentPlans.filter(p => p.count <= installments).pop()?.count ?? 1;
        setInstallments(fallback);
        setClientSecret(null);
        setPaymentIntentId(null);
    }, [installmentPlans, installments]);

    // ─── Polling ─────────────────────────────────────────

    /**
     * Consulta o status a cada 5s. PIX: FAILED (cobrança expirada/cancelada no provedor) vira o
     * estado "QR expirado — gerar novo" (sem onError, que derrubaria o wizard do pai); com validade
     * conhecida o polling acompanha a contagem (pausa ao expirar). Boleto mantém o limite de 15 min.
     */
    const startPolling = useCallback((pid: string, kind: 'PIX' | 'BOLETO', pixDeadlineMs?: number | null) => {
        stopPolling();
        let attempts = 0;
        let consecutiveErrors = 0;
        pollIntervalRef.current = window.setInterval(async () => {
            attempts++;
            if (kind === 'PIX' && pixDeadlineMs) {
                // Rede de segurança: a pausa normal vem do onExpire do PixQrCode.
                if (Date.now() > pixDeadlineMs + PIX_FINAL_CHECK_MS * 2) {
                    stopPolling();
                    pixExpiredRef.current = true;
                    setPixExpired(true);
                    return;
                }
            } else if (attempts >= MAX_POLL_ATTEMPTS) {
                stopPolling();
                if (kind === 'PIX') {
                    pixExpiredRef.current = true;
                    setPixExpired(true);
                } else {
                    reportError('Tempo de espera expirado. Verifique o status do seu pagamento.');
                }
                return;
            }
            try {
                const res = await paymentsApi.getStatus(pid);
                consecutiveErrors = 0; // a successful read clears the error streak
                if (res.status === 'PAID') {
                    fireSuccess();
                } else if (res.status === 'FAILED') {
                    stopPolling();
                    if (kind === 'PIX') {
                        pixExpiredRef.current = true;
                        setPixExpired(true);
                    } else {
                        reportError('Pagamento falhou. Tente novamente.');
                    }
                } else if (res.status === 'CANCELLED') {
                    // The installment was voided (e.g. its contract was cancelled) — stop polling
                    // instead of waiting out the full 15 min for a payment that can never land.
                    stopPolling();
                    reportError('Esta cobrança foi cancelada (contrato encerrado).');
                }
            } catch (err) {
                // Don't swallow status-check failures silently: after a few consecutive errors
                // (e.g. the user's connection dropped) stop and tell them, instead of polling
                // uselessly for 15 minutes.
                consecutiveErrors++;
                console.error('[Payment Polling] status check failed:', err);
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    stopPolling();
                    reportError('Não foi possível verificar o pagamento (conexão instável). Verifique em "Meus Pagamentos".');
                }
            }
        }, 5000);
    }, [stopPolling, fireSuccess, reportError]);

    // ─── CARD ───────────────────────────────────────────

    const initCardPayment = async () => {
        if (initGuardRef.current) return;
        initGuardRef.current = true;
        setProcessing(true);
        setError('');
        let pid = paymentId;
        try {
            // Saved card: charge directly (equipe só com cobrancas.cartao_salvo — sem ela a lista nem aparece)
            if (selectedCard && selectedCard !== 'new' && !savedCardsLocked) {
                setPayingSavedCard(true);
                if (createPaymentFn) {
                    const result = await createPaymentFn('CARTAO');
                    pid = result.paymentId;
                    setPaymentId(pid);
                }
                if (pid) {
                    const result = await stripeApi.createPayment({
                        paymentId: pid,
                        installments,
                        paymentMethod: 'cartao',
                        savedPaymentMethodId: selectedCard,
                    });
                    setPaymentIntentId(result.paymentIntentId || null);
                    // Verify payment was actually processed by Stripe
                    if (result.paymentIntentId && pid) {
                        const verifyResult = await stripeApi.verifyPayment({ paymentId: pid, paymentIntentId: result.paymentIntentId });
                        if (verifyResult.status !== 'PAID') {
                            throw new Error('Pagamento não confirmado pelo Stripe.');
                        }
                    }
                    setPayingSavedCard(false);
                    fireSuccess();
                    return;
                }
                setPayingSavedCard(false);
            }

            // New card flow: get clientSecret to show PaymentElement
            if (createPaymentFn) {
                const result = await createPaymentFn('CARTAO');
                pid = result.paymentId;
                setPaymentId(pid);
                if (result.clientSecret) {
                    // Legacy: the caller already created a PaymentIntent.
                    setCardChargedAmount(null);
                    setIntentSavesCard(null);
                    setClientSecret(result.clientSecret);
                    setPaymentIntentId(result.paymentIntentId || null);
                } else if (pid) {
                    // createPaymentFn só criou o Payment — cria o PaymentIntent AGORA com as parcelas
                    // escolhidas (a política única aplica o teto/juros).
                    const card = await stripeApi.createPayment({
                        paymentId: pid,
                        installments,
                        paymentMethod: 'cartao',
                        savePaymentMethod: wantSaveCard,
                    });
                    setCardChargedAmount(typeof card.amount === 'number' ? card.amount : null);
                    setIntentSavesCard(wantSaveCard);
                    setClientSecret(card.clientSecret || null);
                    setPaymentIntentId(card.paymentIntentId || null);
                }
            } else if (pid) {
                const result = await stripeApi.createPayment({
                    paymentId: pid,
                    installments,
                    paymentMethod: 'cartao',
                    savePaymentMethod: wantSaveCard,
                });
                setCardChargedAmount(typeof result.amount === 'number' ? result.amount : null);
                setIntentSavesCard(wantSaveCard);
                setClientSecret(result.clientSecret || null);
                setPaymentIntentId(result.paymentIntentId || null);
            }
        } catch (err: unknown) {
            setPayingSavedCard(false);
            // Ex.: "Este pagamento já foi confirmado via PIX." — a cobrança já está paga: é sucesso.
            if (await isAlreadyPaid(pid)) {
                fireSuccess();
                return;
            }
            // E1: o cartão salvo informado não é (mais) do dono do pagamento — recarrega a lista do
            // cliente e volta para "novo cartão". Fica no checkout (sem onError do pai).
            if (apiCode(err) === 'CARD_NOT_FOUND') {
                cardChoiceTouchedRef.current = false;
                setSelectedCard('new');
                setCardsNonce(n => n + 1);
                if (mountedRef.current) {
                    setError(adminCharge
                        ? 'Este cartão salvo não está mais disponível para este cliente. Escolha outro cartão ou cadastre um novo.'
                        : 'Este cartão salvo não está mais disponível. Escolha outro cartão ou cadastre um novo.');
                }
                return;
            }
            const msg = getErrorMessage(err) || 'Erro ao iniciar pagamento com cartão.';
            setError(msg);
            onErrorRef.current(msg);
        } finally {
            if (mountedRef.current) setProcessing(false);
            initGuardRef.current = false;
        }
    };

    const handleCardSuccess = async () => {
        try {
            if (paymentId && paymentIntentId) {
                await stripeApi.verifyPayment({ paymentId, paymentIntentId });
            }
            fireSuccess();
        } catch (err: unknown) {
            // Verify failed — payment may not have been processed. CHK-4: o aviso aparece no próprio
            // checkout (era o único caminho que avisava só o pai) e também vai ao pai (toast do cliente).
            // Recusa da própria rota (400/404/409 com `error` — ex.: 409 PAYMENT_NOT_SETTLED, "aprovado no
            // cartão… fale com o estúdio") → a mensagem do servidor. Rede, sessão e 5xx → texto genérico.
            const serverMsg = err instanceof ApiError && [400, 404, 409].includes(err.status) && typeof err.body?.error === 'string'
                ? err.body.error : '';
            const msg = serverMsg || 'Pagamento não pôde ser verificado. Verifique seu extrato antes de tentar novamente.';
            if (mountedRef.current) setError(msg);
            onErrorRef.current(msg);
        }
    };

    // ─── PIX ────────────────────────────────────────────

    /**
     * Emite (ou reaproveita) a cobrança PIX pelo /stripe/create-payment — fonte única (D15).
     * O backend devolve o QR pronto, a validade e o valor; `alreadyPaid` (a cobrança anterior já
     * constava paga no provedor) é sucesso.
     */
    const emitPix = async (pid: string) => {
        const r = await stripeApi.createPayment({ paymentId: pid, paymentMethod: 'pix' });
        if (r.alreadyPaid || r.status === 'PAID') {
            fireSuccess();
            return;
        }
        if (!r.pixString) {
            throw new Error('Não foi possível gerar o código PIX. Tente novamente ou use outro método.');
        }
        if (!mountedRef.current) return;
        clearFinalCheck();
        pixExpiredRef.current = false;
        setPixExpired(false);
        setPix({
            pixString: r.pixString,
            qrCodeDataUrl: r.qrCodeDataUrl || r.qrCodeBase64 || null,
            expiresAt: r.expiresAt ?? null,
            amount: typeof r.amount === 'number' ? r.amount : null,
        });
        const deadline = r.expiresAt ? new Date(r.expiresAt).getTime() : NaN;
        startPolling(pid, 'PIX', Number.isFinite(deadline) ? deadline : null);
    };

    /**
     * 400 CPF_CNPJ_REQUIRED (PIX/Boleto): o DONO do pagamento não tem CPF/CNPJ válido. Abre a coleta
     * — em modo admin ela grava no perfil do CLIENTE (`payerUserId`), nunca no do admin. Fica no
     * checkout (sem onError do pai). Devolve false quando não há de quem coletar (erro genérico).
     */
    const handleCpfRequired = (err: unknown): boolean => {
        if (apiCode(err) !== 'CPF_CNPJ_REQUIRED') return false;
        const body = err instanceof ApiError ? err.body : undefined;
        const payerUserId = typeof body?.payerUserId === 'string' ? body.payerUserId : null;
        const isOther = !!payerUserId && !!user?.id && payerUserId !== user.id;
        const clientId = adminCharge || isOther ? (payer?.id ?? chargeClient?.id ?? payerUserId) : null;
        if ((adminCharge || isOther) && !clientId) return false;
        if (!mountedRef.current) return true;
        if (payerUserId) setCpfPayerId(payerUserId);
        setError('');
        setNeedsCpf(true);
        return true;
    };

    // Gate: PIX needs a valid CPF/CNPJ. If absent, show the inline collection
    // step instead of round-tripping to the server only to fail. Em modo admin sem o pagador
    // identificado ainda, segue para o servidor (que devolve CPF_CNPJ_REQUIRED + payerUserId).
    const initPixPayment = () => {
        if (cpfOwnerKnown && canCollectCpf && !isValidCpfCnpj(cpfOwnerDoc)) {
            setNeedsCpf(true);
            return;
        }
        proceedPix();
    };

    const proceedPix = async () => {
        if (initGuardRef.current) return;
        initGuardRef.current = true;
        setProcessing(true);
        setError('');
        let pid = paymentId;
        try {
            // createPaymentFn (ex.: avulso) só cria o Payment e devolve { paymentId }.
            if (createPaymentFn) {
                const result = await createPaymentFn('PIX');
                pid = result.paymentId;
                setPaymentId(pid);
            }
            if (!pid) throw new Error('Não foi possível gerar o código PIX. Tente novamente ou use outro método.');
            await emitPix(pid);
        } catch (err: unknown) {
            if (await isAlreadyPaid(pid)) {
                fireSuccess();
                return;
            }
            if (handleCpfRequired(err)) return;
            const msg = getErrorMessage(err) || 'Erro ao gerar PIX.';
            setError(msg);
            onErrorRef.current(msg);
        } finally {
            if (mountedRef.current) setProcessing(false);
            initGuardRef.current = false;
        }
    };

    /** "Gerar novo QR": nova chamada ao create-payment (concilia/cancela a antiga) + polling do zero. */
    const regeneratePix = async () => {
        const pid = paymentId;
        if (!pid || regenInFlightRef.current) return;
        regenInFlightRef.current = true;
        setPixRegenerating(true);
        setError('');
        try {
            await emitPix(pid);
        } catch (err: unknown) {
            if (await isAlreadyPaid(pid)) {
                fireSuccess();
                return;
            }
            // Erro fica no checkout (sem onError): o QR continua "expirado" e dá para tentar de novo.
            if (mountedRef.current) setError(getErrorMessage(err) || 'Não foi possível gerar um novo QR. Tente novamente.');
        } finally {
            regenInFlightRef.current = false;
            if (mountedRef.current) setPixRegenerating(false);
        }
    };

    /** A contagem do QR zerou: pausa o polling e faz uma última conferência (pago no limite). */
    const handlePixExpire = useCallback(() => {
        stopPolling();
        if (pixExpiredRef.current) return;
        pixExpiredRef.current = true;
        setPixExpired(true);
        const pid = paymentId;
        if (!pid) return;
        clearFinalCheck();
        finalCheckRef.current = window.setTimeout(async () => {
            finalCheckRef.current = null;
            try {
                const s = await paymentsApi.getStatus(pid);
                if (s.status === 'PAID') fireSuccess();
            } catch { /* sem rede: o "Gerar novo QR" concilia a cobrança anterior */ }
        }, PIX_FINAL_CHECK_MS);
    }, [paymentId, stopPolling, clearFinalCheck, fireSuccess]);

    // ─── BOLETO ─────────────────────────────────────────

    /**
     * E3 — o servidor recusou o boleto: 400 BOLETO_UNAVAILABLE (chave desligada ou Cora inativa) ou
     * BOLETO_NOT_ALLOWED_HERE (cobrança com prazo de pagamento). A aba some (o efeito das abas leva para
     * PIX/Cartão) e o aviso fica no checkout — sem onError do pai.
     */
    const handleBoletoRefused = (err: unknown): boolean => {
        const code = apiCode(err);
        if (code !== 'BOLETO_UNAVAILABLE' && code !== 'BOLETO_NOT_ALLOWED_HERE') return false;
        // A chave-mestra mudou desde que o cache foi carregado: revalida para o resto do app.
        if (code === 'BOLETO_UNAVAILABLE') void loadPaymentMethods();
        if (!mountedRef.current) return true;
        setBoletoRefused(true);
        setNeedsCpf(false);
        setError(getErrorMessage(err) || (code === 'BOLETO_UNAVAILABLE'
            ? 'O pagamento por boleto não está disponível. Use PIX ou cartão.'
            : 'O boleto não está disponível para esta cobrança. Use PIX ou cartão.'));
        return true;
    };

    // Boleto (Cora) also needs a CPF/CNPJ on file — same gate as PIX.
    const initBoletoPayment = () => {
        if (cpfOwnerKnown && canCollectCpf && !isValidCpfCnpj(cpfOwnerDoc)) {
            setNeedsCpf(true);
            return;
        }
        proceedBoleto();
    };

    const proceedBoleto = async () => {
        if (initGuardRef.current) return;
        initGuardRef.current = true;
        setProcessing(true);
        setError('');
        let pid = paymentId;
        try {
            if (createPaymentFn) {
                const result = await createPaymentFn('BOLETO');
                pid = result.paymentId;
                setPaymentId(pid);
                if (result.boletoUrl) {
                    setBoletoUrl(result.boletoUrl);
                    if (result.barcode) setBoletoBarcode(result.barcode);
                    startPolling(pid, 'BOLETO');
                    return;
                }
            }
            if (!pid) throw new Error('Não foi possível gerar o boleto. Tente novamente ou use outro método.');
            const result = await stripeApi.createPayment({ paymentId: pid, paymentMethod: 'boleto' });
            // Guard: without a boleto URL there is nothing to pay — surface an error
            // instead of polling silently in the background.
            if (!result.boletoUrl) {
                throw new Error('Não foi possível gerar o boleto. Tente novamente ou use outro método.');
            }
            setBoletoUrl(result.boletoUrl);
            if (result.barcode) setBoletoBarcode(result.barcode);
            // E2: o boleto cobra o preço de cartão — reflete o valor que o servidor emitiu.
            if (typeof result.amount === 'number') setBoletoAmount(result.amount);
            startPolling(pid, 'BOLETO');
        } catch (err: unknown) {
            if (await isAlreadyPaid(pid)) {
                fireSuccess();
                return;
            }
            if (handleBoletoRefused(err)) return;
            if (handleCpfRequired(err)) return;
            const msg = getErrorMessage(err) || 'Erro ao gerar boleto.';
            setError(msg);
            onErrorRef.current(msg);
        } finally {
            if (mountedRef.current) setProcessing(false);
            initGuardRef.current = false;
        }
    };

    const copyBoletoBarcode = () => {
        if (boletoBarcode) {
            navigator.clipboard.writeText(boletoBarcode);
            setBoletoCopied(true);
            setTimeout(() => setBoletoCopied(false), 3000);
        }
    };

    // ─── Tabs ───────────────────────────────────────────

    /** Troca de aba. `keepError`: a troca foi automática (a aba atual sumiu) e o aviso continua visível. */
    const switchTab = (key: ActiveTab, keepError = false) => {
        if (key === activeTab) return;
        setActiveTab(key);
        if (!keepError) setError('');
        setNeedsCpf(false);
        stopPolling();
        clearFinalCheck();
        // Saiu do PIX: descarta o QR exibido (a troca para cartão aposenta a cobrança no backend).
        // Voltando, "Gerar PIX" reaproveita a cobrança viva ou emite outra — nunca mostra QR morto.
        setPix(null);
        pixExpiredRef.current = false;
        setPixExpired(false);
        if (key !== 'CARTAO') {
            setClientSecret(null);
            setPaymentIntentId(null);
        }
        // Boleto já emitido: volta a acompanhar a compensação.
        if (key === 'BOLETO' && boletoUrl && paymentId) startPolling(paymentId, 'BOLETO');
    };

    // As abas disponíveis mudaram (o boleto entrou/saiu: chave-mestra revalidada ou recusa do servidor):
    //  - a aba atual sumiu → vai para a 1ª disponível, mantendo o aviso na tela;
    //  - a forma escolhida no wizard (initialMethod) ficou disponível e ninguém mexeu ainda → abre nela.
    useEffect(() => {
        const keys = availableKeys ? availableKeys.split(',') as ActiveTab[] : [];
        if (keys.length === 0) return;
        if (!keys.includes(activeTab)) {
            switchTab(keys[0], true);
            return;
        }
        if (!tabTouchedRef.current && initialMethod && initialMethod !== activeTab && keys.includes(initialMethod)
            && !processing && !pix && !clientSecret && !boletoUrl) {
            switchTab(initialMethod);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reage só à mudança do conjunto de abas
    }, [availableKeys]);

    // ─── Render ──────────────────────────────────────────

    return (
        <div style={{ width: '100%' }}>
            {/* Security Badge */}
            <div className="checkout-security-top">
                <ShieldCheck size={14} />
                Pagamento seguro - Criptografia SSL
            </div>

            {/* Amount Header */}
            <div className="checkout-amount">
                <div className="checkout-amount-label">
                    {!pricesDiffer ? 'Total a Pagar'
                        : activeTab === 'CARTAO' ? 'Total no Cartão'
                            : activeTab === 'BOLETO' ? 'Total no Boleto'
                                : 'Total no PIX'}
                </div>
                <div className="checkout-amount-value" aria-busy={headerLoading ? true : undefined}>
                    {headerLoading ? 'Calculando…' : headerUnknown ? 'A confirmar' : formatBRL(headerAmount)}
                </div>
                <div className="checkout-amount-desc">{description}</div>
            </div>

            {/* E2/D1: o desconto do à vista vale só no PIX — cada aba mostra o SEU preço antes de gerar, e
                este aviso deixa a diferença explícita (nunca se cobra mais que o preço de cartão). */}
            {pricesDiffer && (
                <p className="checkout-installment-hint" role="note">
                    <Info size={14} aria-hidden="true" />
                    <span>
                        {pixAvailable
                            ? <>O desconto à vista vale só no PIX: <strong>{formatBRL(pixPrice)} no PIX</strong>. No {nonPixLabel}, o valor é <strong>{formatBRL(nonPixPrice)}</strong>.</>
                            : <>No {nonPixLabel}, o valor é <strong>{formatBRL(nonPixPrice)}</strong> (o desconto à vista vale só no PIX).</>}
                    </span>
                </p>
            )}

            {/* Tab Navigation */}
            {availableMethods.length > 1 && (
                <div className="checkout-tabs">
                    {availableMethods.filter(m => m.key === 'CARTAO' || m.key === 'PIX' || m.key === 'BOLETO').map(pm => {
                        const isActive = activeTab === pm.key;
                        const tabClass = pm.key === 'PIX' ? 'checkout-tab--pix' : pm.key === 'BOLETO' ? 'checkout-tab--boleto' : 'checkout-tab--card';
                        return (
                            <button
                                key={pm.key}
                                type="button"
                                onClick={() => { tabTouchedRef.current = true; switchTab(pm.key as ActiveTab); }}
                                aria-pressed={isActive}
                                className={`checkout-tab ${tabClass} ${isActive ? 'checkout-tab--active' : ''}`}
                            >
                                {pm.key === 'CARTAO' ? <CreditCard size={16} /> : pm.key === 'BOLETO' ? <FileText size={16} /> : <QrCode size={16} />}
                                {pm.key === 'CARTAO' ? 'Cartão' : pm.key === 'BOLETO' ? 'Boleto' : 'PIX'}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Error */}
            {error && <div className="checkout-error" role="alert">{error}</div>}

            {/* CHK-2: a cotação falhou — o valor no cartão/boleto não é conhecido. Nunca se mostra o preço do
                PIX como preço do cartão; o cartão salvo (débito imediato) fica bloqueado até a nova consulta. */}
            {headerUnknown && (
                <div className="checkout-quote-failed" role="alert">
                    <AlertTriangle size={15} aria-hidden="true" />
                    <span>
                        {activeTab === 'BOLETO'
                            ? 'Não foi possível calcular o valor no boleto. Ele aparece assim que o boleto for gerado.'
                            : 'Não foi possível calcular o valor no cartão. Os cartões salvos ficam indisponíveis até o valor ser confirmado.'}
                    </span>
                    <button
                        key="quote-retry"
                        type="button"
                        className="checkout-quote-failed__retry"
                        onClick={(e) => { if (e.detail > 1) return; setQuoteNonce(n => n + 1); }}
                    >
                        Tentar de novo
                    </button>
                </div>
            )}

            {/* ═══════ TAB: CARTAO ═══════ */}
            {activeTab === 'CARTAO' && (
                <div>
                    {/* Step 1: Card Type */}
                    <div className="checkout-section-label">Tipo de cartão</div>
                    <div className="checkout-type-toggle">
                        {(['CREDIT', 'DEBIT'] as const).map(type => (
                            <button
                                key={type}
                                type="button"
                                aria-pressed={paymentType === type}
                                onClick={() => {
                                    setPaymentType(type);
                                    if (type === 'DEBIT') setInstallments(1);
                                    setSelectedCard('new');
                                    setClientSecret(null);
                                }}
                                className={`checkout-type-btn ${paymentType === type ? 'checkout-type-btn--active' : ''}`}
                            >
                                <CreditCard size={16} />
                                {type === 'CREDIT' ? 'Crédito' : 'Débito'}
                            </button>
                        ))}
                    </div>

                    {/* Step 2: Installments (credit only, dropdown) — só quando a política oferece mais de 1x */}
                    {showInstallmentSelect && (
                        <>
                            <div className="checkout-section-label">Parcelamento</div>
                            <select
                                aria-label="Parcelamento"
                                value={installments}
                                onChange={(e) => {
                                    setInstallments(Number(e.target.value));
                                    // O PaymentIntent do cartão novo foi criado com o nº anterior: refaz no próximo "Continuar".
                                    setClientSecret(null);
                                    setPaymentIntentId(null);
                                }}
                                className="checkout-installment-select"
                            >
                                {installmentPlans.map(plan => (
                                    <option key={plan.count} value={plan.count}>
                                        {plan.count}x de {formatBRL(plan.perInstallment)}
                                        {plan.freeOfCharge ? ' (sem juros)' : plan.feePercent > 0 ? ` (${plan.feePercent}% juros)` : ''}
                                        {' — Total: '}{formatBRL(plan.total)}
                                    </option>
                                ))}
                            </select>
                        </>
                    )}
                    {requestedInstallmentsUnavailable && (
                        <p className="checkout-installment-hint" role="note">
                            <Info size={14} aria-hidden="true" />
                            <span>
                                O parcelamento em <strong>{initialInstallments}x</strong> não está disponível no cartão no momento:
                                {maxPlanCount > 1
                                    ? <> escolha até <strong>{maxPlanCount}x</strong>.</>
                                    : <> o total é cobrado em <strong>1x</strong>.</>}
                            </span>
                        </p>
                    )}

                    {/* Step 3: Filtered Saved Cards + New Card */}
                    {loadingCards ? (
                        <div className="checkout-cards-loading">
                            <BrandLoader size="inline" label="Carregando cartões…" />
                        </div>
                    ) : (() => {
                        // Show all saved cards in both tabs — Brazilian cards often report 'credit'
                        // funding even when they support both credit and debit transactions
                        const filteredCards = savedCards;
                        return (
                            <>
                                {filteredCards.length > 0 && (
                                    <>
                                        <div className="checkout-section-label">
                                            {adminCharge
                                                ? `Cartões salvos ${payer?.name || chargeClient?.name ? `de ${payer?.name || chargeClient?.name}` : 'do cliente'}`
                                                : paymentType === 'CREDIT' ? 'Cartões de crédito' : 'Cartões de débito'}
                                        </div>
                                        <div className="checkout-saved-cards">
                                            {filteredCards.map(card => (
                                                <button
                                                    key={card.stripePaymentMethodId}
                                                    type="button"
                                                    aria-pressed={selectedCard === card.stripePaymentMethodId}
                                                    onClick={() => { cardChoiceTouchedRef.current = true; setSelectedCard(card.stripePaymentMethodId); setClientSecret(null); }}
                                                    className={`checkout-saved-card ${selectedCard === card.stripePaymentMethodId ? 'checkout-saved-card--active' : ''}`}
                                                    style={card.isDefault ? { borderColor: 'rgba(16, 185, 129, 0.5)', background: 'rgba(16, 185, 129, 0.06)' } : undefined}
                                                >
                                                    <div className="checkout-saved-card-info">
                                                        <span className="checkout-saved-card-brand">{getBrandIcon(card.brand)}</span>
                                                        <span className="checkout-saved-card-number">{'****'} {card.last4}</span>
                                                        <span className="checkout-saved-card-exp">{String(card.expMonth).padStart(2, '0')}/{String(card.expYear).slice(-2)}</span>
                                                        {card.isDefault ? (
                                                            <span style={{
                                                                fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.04em',
                                                                background: 'linear-gradient(135deg, #10b981, #059669)',
                                                                color: '#fff', padding: '2px 7px', borderRadius: '6px',
                                                            }}>PADRÃO</span>
                                                        ) : FUNDING_LABEL[card.funding] ? (
                                                            <span className={`checkout-saved-card-funding checkout-saved-card-funding--${card.funding === 'credit' ? 'credit' : 'debit'}`}>
                                                                {FUNDING_LABEL[card.funding]}
                                                            </span>
                                                        ) : null}
                                                    </div>
                                                    <div className={`checkout-saved-card-radio ${selectedCard === card.stripePaymentMethodId ? 'checkout-saved-card-radio--active' : ''}`}>
                                                        {selectedCard === card.stripePaymentMethodId && <Check size={12} />}
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </>
                                )}

                                {/* New Card Option */}
                                <div className="checkout-saved-cards" style={filteredCards.length > 0 ? { marginTop: 0 } : undefined}>
                                    <button
                                        type="button"
                                        aria-pressed={selectedCard === 'new'}
                                        onClick={() => { cardChoiceTouchedRef.current = true; setSelectedCard('new'); setClientSecret(null); setError(''); initGuardRef.current = false; }}
                                        className={`checkout-saved-card checkout-saved-card--new ${selectedCard === 'new' ? 'checkout-saved-card--active' : ''}`}
                                    >
                                        <div className="checkout-saved-card-info">
                                            <span className="checkout-saved-card-brand"><Plus size={16} /></span>
                                            <span className="checkout-saved-card-number">
                                                {filteredCards.length > 0
                                                    ? (adminCharge ? 'Usar um cartão novo' : 'Usar outro cartão')
                                                    : `Cadastrar cartão de ${paymentType === 'CREDIT' ? 'crédito' : 'débito'}`}
                                            </span>
                                        </div>
                                        <div className={`checkout-saved-card-radio ${selectedCard === 'new' ? 'checkout-saved-card-radio--active' : ''}`}>
                                            {selectedCard === 'new' && <Check size={12} />}
                                        </div>
                                    </button>
                                </div>
                                {/* Equipe sem "Debitar o cartão salvo do cliente": explica por que a lista não aparece. */}
                                {savedCardsLocked && (
                                    <p className="checkout-save-note" role="note" style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                                        <Lock size={13} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
                                        <span>Os cartões salvos do cliente não aparecem para você: debitá-los exige a permissão “Debitar o cartão salvo do cliente”. Use um cartão novo, com o cliente presente, ou o PIX.</span>
                                    </p>
                                )}
                            </>
                        );
                    })()}

                    {/* Inline Stripe Form (when "new" selected and clientSecret ready) */}
                    {selectedCard === 'new' && clientSecret && (
                        <div className="checkout-inline-form">
                            <div className="checkout-stripe-summary">
                                <span className="checkout-stripe-summary-label">
                                    <CreditCard size={14} />
                                    {paymentType === 'DEBIT' ? 'Débito' : `Crédito ${installments > 1 ? `${installments}x` : ''}`}
                                </span>
                                <span className="checkout-stripe-summary-value">
                                    {installments > 1 ? `${installments}x ${formatBRL(perInstallmentValue)}` : cardAmountText}
                                </span>
                            </div>
                            {/* CHK-1: o PaymentIntent já foi criado com (ou sem) salvar o cartão — aqui só se informa
                                o que vai acontecer; para mudar, "Voltar" devolve a caixa de escolha. */}
                            {intentSavesCard != null && (
                                <p className="checkout-save-note">
                                    {intentSavesCard
                                        ? (adminCharge ? 'O cartão do cliente ficará salvo para futuras cobranças.' : 'Este cartão ficará salvo para futuras compras.')
                                        : (adminCharge ? 'O cartão do cliente não será salvo.' : 'Este cartão não será salvo.')}
                                    {' '}Para mudar, toque em “Voltar”.
                                </p>
                            )}
                            {/* Cartão NOVO sai sempre em 1x: o backend recusa N > 1 sem plano fixado no servidor
                                (pagamentos-1) e o PaymentIntent não habilita o seletor de parcelas do Stripe. */}
                            <StripeCardForm
                                mode="payment"
                                clientSecret={clientSecret}
                                onSuccess={handleCardSuccess}
                                onError={(msg) => { setError(msg); setClientSecret(null); }}
                                onCancel={() => setClientSecret(null)}
                                submitLabel={installments > 1
                                    ? `Pagar ${installments}x ${formatBRL(perInstallmentValue)}`
                                    : `Pagar ${cardAmountText}`
                                }
                                // CHK-1: a caixa "Salvar cartão" fica ANTES do "Continuar com novo cartão" (acima):
                                // dentro do formulário o PaymentIntent já existe e desmarcar não teria efeito.
                                showSaveCard={false}
                            />
                        </div>
                    )}

                    {/* CHK-1: salvar o cartão é decidido ANTES de criar o PaymentIntent (savePaymentMethod →
                        setup_future_usage). Marcado por padrão, como antes. */}
                    {selectedCard === 'new' && !clientSecret && (
                        <label className="stripe-save-card">
                            <input
                                type="checkbox"
                                checked={wantSaveCard}
                                disabled={processing}
                                onChange={(e) => setWantSaveCard(e.target.checked)}
                            />
                            <span>{adminCharge ? 'Salvar o cartão do cliente para futuras cobranças' : 'Salvar cartão para futuras compras'}</span>
                        </label>
                    )}

                    {/* Pay Button (saved card or initiate new card flow) */}
                    {!(selectedCard === 'new' && clientSecret) && (
                        <button
                            key="card-go"
                            type="button"
                            // 2º clique de um clique duplo ignorado (teclado: detail 0 segue funcionando).
                            onClick={(e) => { if (e.detail > 1) return; initCardPayment(); }}
                            // CHK-2: sem cotação, o cartão SALVO não é cobrado (seria debitado na hora por um
                            // valor que a tela não conhece); o cartão novo segue (o formulário mostra o valor).
                            disabled={processing || payingSavedCard || (paymentType === 'CREDIT' && plansLoading)
                                || (cardPriceUnknown && savedCardSelected)}
                            className="checkout-pay-btn checkout-pay-btn--card"
                        >
                            {processing || payingSavedCard ? (
                                <><span className="spinner" style={{ width: 16, height: 16 }} /> {payingSavedCard ? 'Processando...' : 'Preparando...'}</>
                            ) : (
                                <>
                                    <Lock size={14} />
                                    {selectedCard && selectedCard !== 'new'
                                        ? `Pagar com **** ${savedCards.find(c => c.stripePaymentMethodId === selectedCard)?.last4 || ''} - ${
                                            installments > 1 ? `${installments}x ${formatBRL(perInstallmentValue)}` : cardAmountText
                                        }`
                                        : selectedCard === 'new'
                                            ? 'Continuar com novo cartão'
                                            : `Pagar ${cardAmountText}`
                                    }
                                </>
                            )}
                        </button>
                    )}
                </div>
            )}

            {/* ═══════ TAB: PIX ═══════ */}
            {activeTab === 'PIX' && (
                <div>
                    {!pix ? (
                        needsCpf && canCollectCpf ? (
                            <CpfCnpjPrompt
                                // key: o pagador pode ser identificado depois (for-payment / payerUserId do 400).
                                key={`cpf-pix-${cpfPromptClient?.id ?? 'self'}`}
                                client={cpfPromptClient}
                                saveLabel={`Salvar e gerar PIX - ${pixAmountText}`}
                                onSaved={(doc) => { if (doc) setSavedClientDoc(doc); setNeedsCpf(false); proceedPix(); }}
                                onCancel={() => setNeedsCpf(false)}
                            />
                        ) : (
                        <div className="checkout-pix-intro">
                            <div className="checkout-pix-icon">
                                <QrCode size={24} />
                            </div>
                            <p>Gere o QR Code PIX para pagamento instantâneo.</p>
                            <button
                                key="pix-go"
                                type="button"
                                onClick={(e) => { if (e.detail > 1) return; initPixPayment(); }}
                                // E2: espera o preço do PIX (pode ter o desconto do à vista) antes de gerar.
                                disabled={processing || quoteLoading}
                                className="checkout-pay-btn checkout-pay-btn--pix"
                            >
                                {processing ? (
                                    <><span className="spinner" style={{ width: 16, height: 16 }} /> Gerando PIX...</>
                                ) : (
                                    <>
                                        <QrCode size={16} />
                                        Gerar PIX - {pixAmountText}
                                    </>
                                )}
                            </button>
                        </div>
                        )
                    ) : (
                        <div className="checkout-pix-result">
                            <PixQrCode
                                pixString={pix.pixString}
                                qrCodeDataUrl={pix.qrCodeDataUrl}
                                // FAILED no polling força o estado "QR expirado" (validade no passado).
                                expiresAt={pixExpired ? 1 : pix.expiresAt}
                                amount={pix.amount}
                                onRegenerate={regeneratePix}
                                regenerating={pixRegenerating}
                                onExpire={handlePixExpire}
                            />

                            {!pixExpired && (
                                <div className="checkout-polling checkout-polling--pix">
                                    <span className="spinner" style={{ width: 14, height: 14, borderColor: '#22c55e', borderTopColor: 'transparent' }} />
                                    Aguardando pagamento...
                                </div>
                            )}

                            {/* Sandbox testing only: no real bank can pay a homologação QR,
                                so offer a button that simulates the confirmed payment. */}
                            {pixSandbox && paymentId && !pixExpired && (
                                <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px dashed var(--border, rgba(255,255,255,0.12))', textAlign: 'center' }}>
                                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 8 }}>
                                        🧪 Modo teste (sandbox) — nenhum valor real é cobrado
                                    </div>
                                    <button
                                        type="button"
                                        onClick={(e) => { if (e.detail > 1) return; simulatePayment(); }}
                                        disabled={simulating}
                                        style={{
                                            width: '100%', padding: '10px 16px', borderRadius: 10,
                                            border: '1px solid #f59e0b', background: 'rgba(245,158,11,0.12)',
                                            color: '#f59e0b', fontWeight: 600, fontSize: '0.8rem',
                                            cursor: simulating ? 'default' : 'pointer',
                                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                                        }}
                                    >
                                        {simulating
                                            ? <><span className="spinner" style={{ width: 14, height: 14, borderColor: '#f59e0b', borderTopColor: 'transparent' }} /> Simulando...</>
                                            : <>🧪 Simular pagamento PIX</>}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* ═══════ TAB: BOLETO (E3: chave-mestra + Cora; nunca em fluxo de 10 min) ═══════ */}
            {activeTab === 'BOLETO' && (
                <div>
                    {!boletoUrl ? (
                        needsCpf && canCollectCpf ? (
                            <CpfCnpjPrompt
                                key={`cpf-boleto-${cpfPromptClient?.id ?? 'self'}`}
                                client={cpfPromptClient}
                                saveLabel={`Salvar e gerar Boleto - ${boletoAmountText}`}
                                onSaved={(doc) => { if (doc) setSavedClientDoc(doc); setNeedsCpf(false); proceedBoleto(); }}
                                onCancel={() => setNeedsCpf(false)}
                            />
                        ) : (
                        <div className="checkout-pix-intro">
                            <div className="checkout-pix-icon" style={{ color: '#f59e0b' }}>
                                <FileText size={24} />
                            </div>
                            <p>Gere o boleto bancário. A compensação leva até 3 dias úteis.</p>
                            <button
                                key="boleto-go"
                                type="button"
                                onClick={(e) => { if (e.detail > 1) return; initBoletoPayment(); }}
                                disabled={processing || quoteLoading}
                                className="checkout-pay-btn checkout-pay-btn--card"
                            >
                                {processing ? (
                                    <><span className="spinner" style={{ width: 16, height: 16 }} /> Gerando boleto...</>
                                ) : (
                                    <>
                                        <FileText size={16} />
                                        Gerar Boleto - {boletoAmountText}
                                    </>
                                )}
                            </button>
                        </div>
                        )
                    ) : (
                        <div className="checkout-pix-result">
                            <a
                                href={boletoUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="checkout-pay-btn checkout-pay-btn--card"
                                style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 12 }}
                            >
                                <FileText size={16} /> Abrir / Imprimir Boleto (PDF)
                            </a>

                            {boletoBarcode && (
                                <>
                                    <div className="checkout-pix-code">{boletoBarcode}</div>
                                    <button
                                        type="button"
                                        onClick={copyBoletoBarcode}
                                        className={`checkout-copy-btn ${boletoCopied ? 'checkout-copy-btn--copied' : ''}`}
                                    >
                                        {boletoCopied ? <><Check size={14} /> Copiado!</> : <><Copy size={14} /> Copiar Linha Digitável</>}
                                    </button>
                                </>
                            )}

                            <div className="checkout-polling checkout-polling--pix">
                                <span className="spinner" style={{ width: 14, height: 14, borderColor: '#f59e0b', borderTopColor: 'transparent' }} />
                                Aguardando compensação...
                            </div>

                            {/* Sandbox testing only: boleto shares the Cora provider with PIX. */}
                            {pixSandbox && paymentId && (
                                <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px dashed var(--border-default, rgba(255,255,255,0.12))', textAlign: 'center' }}>
                                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 8 }}>
                                        🧪 Modo teste (sandbox) — nenhum valor real é cobrado
                                    </div>
                                    <button
                                        type="button"
                                        onClick={(e) => { if (e.detail > 1) return; simulatePayment(); }}
                                        disabled={simulating}
                                        style={{
                                            width: '100%', padding: '10px 16px', borderRadius: 10,
                                            border: '1px solid #f59e0b', background: 'rgba(245,158,11,0.12)',
                                            color: '#f59e0b', fontWeight: 600, fontSize: '0.8rem',
                                            cursor: simulating ? 'default' : 'pointer',
                                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                                        }}
                                    >
                                        {simulating
                                            ? <><span className="spinner" style={{ width: 14, height: 14, borderColor: '#f59e0b', borderTopColor: 'transparent' }} /> Simulando...</>
                                            : <>🧪 Simular pagamento do Boleto</>}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Cancel */}
            {onCancel && (
                <button key="checkout-cancel" type="button" onClick={(e) => { if (e.detail > 1) return; onCancel(); }} className="checkout-cancel-btn">
                    Cancelar
                </button>
            )}
        </div>
    );
}
