import type { AdminOnlyPermissionKey, PermissionKey, PermissionModuleKey } from '../constants/permissions';

const API_BASE = '/api';

export class ApiError extends Error {
    status: number;
    details?: any;
    /**
     * Código de erro de máquina enviado pelo backend (ex.: 'INVALID_SLOT', 'CPF_CNPJ_REQUIRED', 'ALL_SLOTS_TAKEN').
     * Códigos acrescentados na revisão do lote 2:
     *  - BOOKING_CANCELLED (400, POST /stripe/create-payment): a gravação desta cobrança foi cancelada — não pode mais ser paga;
     *  - RECORDING_START_FUTURE (400, PUT /bookings/:id/start-recording): só dá para iniciar no dia da sessão (ou depois);
     *  - RECORDING_STATE_CHANGED (409, PUT /bookings/:id/complete): o início foi desfeito ou o status mudou em outra tela — recarregue;
     *  - CANCELLATION_NOT_PENDING (409, POST /contracts/:id/resolve-cancellation): o pedido já foi resolvido — recarregue a lista.
     */
    code?: string;
    /**
     * Corpo JSON completo da resposta de erro — campos extras que acompanham alguns códigos:
     * `payerUserId` (CPF_CNPJ_REQUIRED), `reason` (BOLETO_UNAVAILABLE), `boleto` (BOLETO_PROVIDER_DISABLED),
     * `status` (SETUP_INTENT_NOT_CONFIRMED). Objeto vazio quando a resposta não era JSON.
     */
    body?: Record<string, unknown>;

    constructor(message: string, status: number, details?: any, code?: string, body?: Record<string, unknown>) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.details = details;
        this.code = code;
        this.body = body;
    }
}

/**
 * Resultado da renovação da sessão (POST /auth/refresh):
 *  - 'ok'          → tokens novos; a requisição original é repetida;
 *  - 'refused'     → o servidor RECUSOU (401/403 em JSON: sessão encerrada, token inválido ou ausente,
 *                    conta desativada/excluída) — a sessão acabou de verdade;
 *  - 'unavailable' → falha passageira (rede caiu, 5xx/503, 429 do limitador, resposta que não é do
 *                    servidor): NÃO é fim de sessão; nada desloga (NS-3 — "não desloga em erro de rede/503").
 */
type RefreshOutcome = 'ok' | 'refused' | 'unavailable';

let refreshPromise: Promise<RefreshOutcome> | null = null;

/** Mensagem do erro lançado quando a sessão não pôde ser renovada por falha passageira (NS-3). */
export const SESSION_REFRESH_UNAVAILABLE_MESSAGE = 'Não foi possível renovar a sessão agora. Tente novamente em instantes.';

/**
 * D3: disparado em `window` quando o refresh responde 401 de conta inexistente/excluída
 * ('Conta não encontrada.' / 'Usuário não encontrado.'). O AuthContext escuta e faz logout limpo.
 */
export const AUTH_ACCOUNT_GONE_EVENT = 'auth:account-gone';
const ACCOUNT_GONE_ERRORS = new Set(['Conta não encontrada.', 'Usuário não encontrado.']);

/**
 * AUTH-01 / NS-2: a sessão TERMINOU — o refresh recusou com 401 que não é conta desativada nem
 * excluída (sessão revogada pelo administrador ao trocar papel/e-mail/senha, troca da própria senha
 * em outro aparelho, `code: 'SESSION_REVOKED'`, token inválido ou cookie ausente). CustomEvent com
 * `detail: SessionEndedDetail`. O AuthContext escuta: com sessão na tela, apaga o cookie de refresh
 * (logout), limpa os caches e leva ao /login com "Sua sessão terminou…"; sem sessão (boot de visitante
 * ou cookie residual) só apaga o cookie, em silêncio. Sem isto o membro levava 401 a cada clique e
 * nunca ia ao login, e o cookie de refresh ficava no navegador da recepção.
 */
export const AUTH_SESSION_ENDED_EVENT = 'auth:session-ended';
export interface SessionEndedDetail {
    /** `code` do servidor (ex.: 'SESSION_REVOKED'), quando veio. */
    code: string | null;
    /** false = o navegador nem tinha cookie de refresh ('Refresh token não encontrado.'): nada a apagar. */
    hadRefreshCookie: boolean;
}
const REFRESH_COOKIE_MISSING_ERROR = 'Refresh token não encontrado.';

/**
 * Equipe (S3): conta DESATIVADA ou bloqueada. Disparado em `window` (CustomEvent com
 * `detail: AccountDisabledDetail`) quando:
 *  - qualquer rota responde 401 `code: 'ACCOUNT_DISABLED'` (getActor do backend: membro desativado/excluído);
 *  - o refresh responde 401/403 com `code: 'ACCOUNT_DISABLED'` (conta bloqueada — `assertNotBlocked`).
 *    Só o `code` decide (NS-3): um 403 sem ele (proxy, página HTML) não vira "acesso desativado".
 * O AuthContext escuta: encerra a sessão e mostra a mensagem ("Seu acesso foi desativado…").
 * Não dispara nas rotas de login/cadastro (lá o erro aparece no próprio formulário).
 */
export const AUTH_ACCOUNT_DISABLED_EVENT = 'auth:account-disabled';
export interface AccountDisabledDetail {
    /** Mensagem do servidor (pt-BR), ou o texto padrão quando o corpo não trouxe nenhuma. */
    message: string;
}
export const ACCOUNT_DISABLED_DEFAULT_MESSAGE = 'Seu acesso foi desativado. Fale com o administrador.';

/**
 * Equipe (D6): o servidor recusou uma ação com 403 `code: 'PERMISSION_DENIED'` — as permissões que o
 * front tem estão defasadas (o administrador mudou o acesso). CustomEvent com
 * `detail: PermissionsStaleDetail`; o AuthContext recarrega as permissões (refreshPermissions) e avisa.
 */
export const AUTH_PERMISSIONS_STALE_EVENT = 'auth:permissions-stale';
export interface PermissionsStaleDetail {
    /** Chave exigida (`agendamentos.criar`…), ou 'ADMIN' / 'STAFF' / 'CLIENTE' quando é o papel. */
    permission: string | null;
    /** Método HTTP da requisição recusada (GET = leitura de fundo; os demais = ação do usuário). */
    method: string;
    path: string;
}

function emitWindowEvent<T>(name: string, detail: T): void {
    try { window.dispatchEvent(new CustomEvent<T>(name, { detail })); } catch { /* ignore */ }
}

function emitAccountDisabled(message: unknown): void {
    emitWindowEvent<AccountDisabledDetail>(AUTH_ACCOUNT_DISABLED_EVENT, {
        message: typeof message === 'string' && message.trim() ? message : ACCOUNT_DISABLED_DEFAULT_MESSAGE,
    });
}

async function tryRefresh(): Promise<RefreshOutcome> {
    // Deduplicate: all callers share the same in-flight refresh
    if (refreshPromise) return refreshPromise;

    refreshPromise = fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
    })
        .then(async (r): Promise<RefreshOutcome> => {
            if (r.ok) return 'ok';
            if (r.status !== 401 && r.status !== 403) {
                // 5xx/503 (banco fora no refresh), 429 (limitador), 404 de proxy…: passageiro (NS-3).
                return 'unavailable';
            }
            const body = await r.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
            if (!body) return 'unavailable'; // 401/403 sem JSON não veio do nosso servidor (proxy, página HTML).
            if (body.code === 'ACCOUNT_DISABLED') {
                // S3: conta BLOQUEADA (assertNotBlocked) — sem isto o desativado levava 401 a cada clique
                // e nunca ia para o login.
                emitAccountDisabled(body.error);
                return 'refused';
            }
            if (typeof body.error === 'string' && ACCOUNT_GONE_ERRORS.has(body.error)) {
                try { window.dispatchEvent(new Event(AUTH_ACCOUNT_GONE_EVENT)); } catch { /* ignore */ }
                return 'refused';
            }
            if (r.status === 403) return 'unavailable'; // 403 sem ACCOUNT_DISABLED: não é recusa de sessão.
            emitWindowEvent<SessionEndedDetail>(AUTH_SESSION_ENDED_EVENT, {
                code: typeof body.code === 'string' ? body.code : null,
                hadRefreshCookie: body.error !== REFRESH_COOKIE_MISSING_ERROR,
            });
            return 'refused';
        })
        .catch((): RefreshOutcome => 'unavailable') // rede caiu / fetch rejeitado
        .finally(() => { refreshPromise = null; });

    return refreshPromise;
}

/** Corpo de erro como objeto simples (para ApiError.body); qualquer outra coisa vira undefined. */
function errorBodyOf(body: unknown): Record<string, unknown> | undefined {
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
}

/** Lê o `code` do corpo JSON sem consumir a resposta (clone). */
async function peekErrorCode(res: Response): Promise<string | undefined> {
    try {
        const body = await res.clone().json() as { code?: unknown };
        return typeof body?.code === 'string' ? body.code : undefined;
    } catch {
        return undefined;
    }
}

/** Rotas de entrada (login/OTP/Google/cadastro): o erro aparece no formulário, sem eventos globais. */
function isSignInEndpoint(path: string): boolean {
    return /^\/auth\/(login|google|register)(\/|$|\?)/.test(path);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const doFetch = () =>
        fetch(`${API_BASE}${path}`, {
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...options.headers },
            ...options,
        });

    let res = await doFetch();

    // Auto-refresh on 401 (skip auth endpoints to avoid infinite loop).
    // 401 ACCOUNT_DISABLED (membro desativado/excluído) não tenta refresh: a conta não volta renovando o token.
    const isAuthEndpoint = path.includes('/auth/refresh') || path.includes('/auth/login');
    if (res.status === 401 && !isAuthEndpoint && (await peekErrorCode(res)) !== 'ACCOUNT_DISABLED') {
        const outcome = await tryRefresh();
        if (outcome === 'ok') {
            // Retry the original request with the new access token
            res = await doFetch();
        } else if (outcome === 'unavailable') {
            // NS-3: falha passageira ao renovar NÃO é sessão encerrada — lança 503 (quem trata 401 como
            // "sessão terminou", como o refreshPermissions, mantém o usuário) em vez do 401 original.
            throw new ApiError(SESSION_REFRESH_UNAVAILABLE_MESSAGE, 503, undefined, 'SESSION_REFRESH_UNAVAILABLE');
        }
    }

    if (!res.ok) {
        // Fallback vazio (não truthy): quando o corpo não é JSON (proxy 502, rate-limit
        // em texto), a mensagem cai no status HTTP real em vez de "Erro desconhecido".
        const body = await res.json().catch(() => ({} as { error?: string; details?: unknown; code?: string; permission?: unknown }));
        const code = typeof body.code === 'string' ? body.code : undefined;
        if (!isSignInEndpoint(path)) {
            if (res.status === 401 && code === 'ACCOUNT_DISABLED') {
                emitAccountDisabled(body.error);
            } else if (res.status === 403 && code === 'PERMISSION_DENIED') {
                emitWindowEvent<PermissionsStaleDetail>(AUTH_PERMISSIONS_STALE_EVENT, {
                    permission: typeof body.permission === 'string' ? body.permission : null,
                    method: (options.method || 'GET').toUpperCase(),
                    path,
                });
            }
        }
        throw new ApiError(
            body.error || `Erro ${res.status} do servidor`, res.status, body.details,
            code,
            errorBodyOf(body),
        );
    }

    return res.json();
}

/**
 * Caches de respostas da API no navegador (Cache Storage do service worker). `api-cache` é o legado —
 * guardava QUALQUER GET /api/* por 1 h, inclusive de outro usuário no mesmo computador (S2);
 * `api-public-cache` é o atual (só GETs públicos de preços/formas de pagamento, ver sw.ts).
 */
export const API_CACHE_NAMES = ['api-cache', 'api-public-cache'] as const;

/**
 * S2: apaga as respostas da API guardadas pelo service worker. O AuthContext chama no login e no
 * logout (computador de recepção compartilhado). Nunca lança; sem Cache Storage (http, navegador
 * antigo) não faz nada.
 */
export async function clearApiCaches(): Promise<void> {
    try {
        if (typeof caches === 'undefined') return;
        await Promise.all(API_CACHE_NAMES.map(name => caches.delete(name).catch(() => false)));
    } catch { /* ignore */ }
}


// ─── Auth ───────────────────────────────────────────────
export const authApi = {
    login: (email: string, password: string) => request<{ user: User }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    register: (data: { email: string; password: string; name: string; code: string; }) => request<{ user: User }>('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
    googleLogin: (idToken: string) => request<{ user: User }>('/auth/google', { method: 'POST', body: JSON.stringify({ idToken }) }),
    sendRegistrationCode: (data: { email: string, password: string, name: string }) => request<{ message: string }>('/auth/register/send-code', { method: 'POST', body: JSON.stringify(data) }),
    // Passwordless e-mail login (OTP): request a code (existing accounts only), then verify it.
    loginSendCode: (email: string) => request<{ message: string }>('/auth/login/send-code', { method: 'POST', body: JSON.stringify({ email }) }),
    loginVerifyCode: (email: string, code: string) => request<{ user: User }>('/auth/login/verify-code', { method: 'POST', body: JSON.stringify({ email, code }) }),
    me: () => request<{ user: User }>('/auth/me'),

    refresh: () => request<{ message: string }>('/auth/refresh', { method: 'POST' }),
    logout: () => request<{ message: string }>('/auth/logout', { method: 'POST' }),
    updateProfile: (data: { name?: string; phone?: string; password?: string; cpfCnpj?: string; address?: string; addressNumber?: string; complement?: string; neighborhood?: string; zipCode?: string; city?: string; state?: string; socialLinks?: any; essentialNotificationsOnly?: boolean }) => request<{ user: User; message: string }>('/auth/profile', { method: 'PATCH', body: JSON.stringify(data) }),
    uploadPhoto: async (file: File): Promise<{ user: User; message: string }> => {
        // Falhas de rede transitórias ("Failed to fetch") apareciam cruas em inglês no
        // 1º envio. Timeout de 30s + 1 retry automático + mensagens sempre em pt-BR.
        const attempt = async (): Promise<Response> => {
            const formData = new FormData();
            formData.append('photo', file);
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 30_000);
            try {
                return await fetch(`${API_BASE}/auth/profile/photo`, {
                    method: 'POST', credentials: 'include', body: formData, signal: ctrl.signal,
                });
            } finally {
                clearTimeout(t);
            }
        };
        let res: Response;
        try {
            res = await attempt();
        } catch {
            // Erro de rede/timeout — espera breve e tenta 1 vez de novo.
            await new Promise(r => setTimeout(r, 1500));
            try {
                res = await attempt();
            } catch {
                throw new Error('Falha de conexão ao enviar a foto. Verifique sua internet e tente novamente.');
            }
        }
        if (!res.ok) {
            const body = await res.json().catch(() => ({ error: 'Não foi possível enviar a foto. Tente novamente.' }));
            throw new Error(body.error || 'Não foi possível enviar a foto. Tente novamente.');
        }
        return res.json();
    },
};

// ─── Bookings ───────────────────────────────────────────
export const bookingsApi = {
    // myBookings: as reservas do cliente no dia, na MESMA forma do GET /my (ClientBooking — E11/E12), por startTime.
    getAvailability: (date: string) => request<{ date: string; dayOfWeek: number; closed: boolean; slots: Slot[]; myBookings: MyBookingSlot[] }>(`/bookings/availability?date=${date}`),
    create: (data: { date: string; startTime: string; contractId?: string; addOns?: string[]; paymentMethod?: 'CARTAO' | 'PIX'; installments?: number; paymentType?: 'CREDIT' | 'DEBIT'; couponCode?: string }) => request<{ booking: Booking & { holdExpiresAt?: string | null }; paymentId?: string | null; paymentAmount?: number; couponDiscount?: number; alreadyPaid?: boolean; clientSecret?: string | null; lockExpiresIn: number; message: string }>('/bookings', { method: 'POST', body: JSON.stringify(data) }),
    completePayment: (id: string, data: { paymentIntentId?: string }) => request<{ booking: Booking; message: string }>(`/bookings/${id}/complete-payment`, { method: 'POST', body: JSON.stringify(data) }),
    createBulk: (data: { contractId: string; slots: { date: string; startTime: string }[] }) => request<{ message: string }>('/bookings/bulk', { method: 'POST', body: JSON.stringify(data) }),
    adminCreate: (data: { userId: string; date: string; startTime: string; status?: string; addOns?: string[]; adminNotes?: string; customPrice?: number; paymentMethod?: 'CARTAO' | 'PIX' | 'BOLETO'; couponCode?: string }) => request<{ booking: Booking; message: string; paymentId?: string; paymentAmount?: number; couponDiscount?: number; boletoUrl?: string; boletoError?: string }>('/bookings/admin', { method: 'POST', body: JSON.stringify(data) }),
    // noShowJustified (admin, D4): ao marcar FALTA num contrato AVULSO, true abre a janela de
    // remarcação (makeupStatus OPEN até o fim do dia D+N em SP); false com OPEN desfaz a justificativa.
    // R7 (AUDFIN6-03): makeupOpened/makeupDeadline/makeupBlockReason dizem se a troca abriu a janela do avulso e, se
    // não abriu, o motivo — ausentes = a tela não afirma (utils/avulsoMakeup.reasonSaveFeedback).
    update: (id: string, data: { date?: string; startTime?: string; status?: string; statusReason?: string | null; noShowJustified?: boolean; adminNotes?: string; clientNotes?: string; platforms?: string; platformLinks?: string, durationMinutes?: number | null, peakViewers?: number | null, chatMessages?: number | null, audienceOrigin?: string | null, isLivestream?: boolean | null, streamMetrics?: string | null }) => request<{ booking: BookingWithUser; message: string; reopenedWithoutCharge?: boolean; makeupOpened?: boolean; makeupDeadline?: string | null; makeupBlockReason?: string | null }>(`/bookings/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    // 400 `code: 'RECORDING_START_FUTURE'` = sessão de data FUTURA (só dá para iniciar no dia da sessão ou depois — mostre `message`).
    startRecording: (id: string) => request<{ booking: BookingWithUser; message: string }>(`/bookings/${id}/start-recording`, { method: 'PUT' }),
    /**
     * ADMIN: desfaz um "Iniciar Gravação" clicado por engano (zera início/operador) — o "AO VIVO" do cliente some e
     * a sessão volta a exigir "Iniciar Gravação" antes de finalizar. Idempotente (nada iniciado → 200).
     * `booking` é a linha da reserva SEM `user` (mescle no item da lista em vez de substituí-lo).
     * 409 `code: 'RECORDING_UNDO_NOT_ALLOWED'` = não está CONFIRMED (ex.: já finalizada); 404 = não existe.
     */
    undoStartRecording: (id: string) => request<{ booking: Booking; message: string }>(`/bookings/${id}/undo-start-recording`, { method: 'PUT' }),
    confirm: (id: string) => request<{ booking: Booking; message: string }>(`/bookings/${id}/confirm`, { method: 'PATCH' }),
    cancel: (id: string) => request<{ message: string }>(`/bookings/${id}`, { method: 'DELETE' }),
    hardDelete: (id: string) => request<{ message: string; creditRestored: boolean }>(`/bookings/${id}/hard-delete`, { method: 'DELETE' }),
    clientCancel: (id: string) => request<{ message: string }>(`/bookings/${id}/client-cancel`, { method: 'PUT' }),
    checkIn: (id: string) => request<{ booking: Booking; message: string }>(`/bookings/${id}/check-in`, { method: 'PUT' }),
    // 409 `code: 'RECORDING_STATE_CHANGED'` = o início foi desfeito ou o status mudou em outra tela: nada é gravado — recarregue e tente de novo.
    complete: (id: string, data?: { durationMinutes?: number | null; isLivestream?: boolean | null; platforms?: string | null; platformLinks?: string | null; streamMetrics?: string | null; audienceOrigin?: string | null; adminNotes?: string | null; clientNotes?: string | null; peakViewers?: number | null; chatMessages?: number | null }) => request<{ booking: Booking; message: string }>(`/bookings/${id}/complete`, { method: 'PUT', body: JSON.stringify(data || {}) }),
    // Rotas do CLIENTE (dono): devolvem ClientBooking — sem adminNotes, com clientNotes, métricas e os
    // derivados isRecordingNow / recordingFinishedAt / canEditEpisode / editBlockedReason (E11/E12).
    getMy: () => request<{ bookings: ClientBooking[] }>('/bookings/my'),
    /** Só o dono da reserva (um admin que não é o dono recebe 404). */
    getOne: (id: string) => request<{ booking: ClientBooking }>(`/bookings/${id}`),
    getAll: (date?: string, status?: string) => {
        const params = new URLSearchParams();
        if (date) params.set('date', date);
        if (status) params.set('status', status);
        const qs = params.toString();
        return request<{ bookings: BookingWithUser[] }>(`/bookings${qs ? `?${qs}` : ''}`);
    },
    /**
     * Informações do episódio (E12) — só o dono e só em RESERVED/HELD/CONFIRMED.
     * `episodeTitle`/`episodeDescription`: '' ou null limpam o campo; `platforms`: JSON string[] de
     * YOUTUBE/INSTAGRAM/FACEBOOK/TIKTOK. 400 = `error` já com a mensagem do campo; 404 = não é o dono;
     * 409 `code: 'BOOKING_NOT_EDITABLE'` = gravação finalizada/cancelada/não realizada (mesmo texto de `editBlockedReason`).
     * `clientNotes` NÃO é mais gravável pelo cliente (é o recado do estúdio): o campo é aceito só para não
     * quebrar chamadores antigos e é descartado aqui, sem ir para o servidor.
     */
    clientUpdate: (id: string, data: {
        episodeTitle?: string | null; episodeDescription?: string | null; platforms?: string;
        /** @deprecated Ignorado — o cliente não escreve mais `clientNotes`. Remova do chamador. */
        clientNotes?: string;
    }) => {
        const { clientNotes: _ignored, ...payload } = data;
        return request<{ booking: ClientBooking; message: string }>(`/bookings/${id}/client-update`, { method: 'PATCH', body: JSON.stringify(payload) });
    },
    /** Capa do episódio (multipart `cover`). Mesmas regras de edição do clientUpdate (409 BOOKING_NOT_EDITABLE); 413 acima de 12 MB. */
    uploadCover: async (id: string, file: File): Promise<{ coverImageUrl: string; booking: ClientBooking; message: string }> => {
        const formData = new FormData();
        formData.append('cover', file);
        const res = await fetch(`${API_BASE}/bookings/${id}/cover-image`, { method: 'POST', credentials: 'include', body: formData });
        if (!res.ok) {
            const body = await res.json().catch(() => ({ error: 'Erro' }));
            throw new ApiError(body.error || 'Erro ao enviar capa', res.status, body.details, typeof body.code === 'string' ? body.code : undefined, errorBodyOf(body));
        }
        return res.json();
    },
    getMyResults: (days = 90) => request<BookingResults>(`/bookings/my/results?days=${days}`),
    reschedule: (id: string, data: { date: string; startTime: string }) =>
        request<{ booking: ClientBooking; message: string }>(`/bookings/${id}/reschedule`, { method: 'PATCH', body: JSON.stringify(data) }),
    /**
     * Remarcação ÚNICA de falta justificada / "Não Realizado" do avulso (D4/D5): reabre a MESMA
     * reserva (mesmo Payment, sem nova cobrança) na nova data/horário. Cliente dono ou ADMIN.
     * Exige makeupStatus 'OPEN' e data ≤ D+N (o admin pode remarcar NAO_REALIZADO após o prazo).
     * Chamado pelo CLIENTE, `booking` vem na forma ClientBooking (com os derivados); pelo admin, a reserva crua.
     */
    makeup: (id: string, data: { date: string; startTime: string }) =>
        request<{ booking: Booking; message: string }>(`/bookings/${id}/makeup`, { method: 'PATCH', body: JSON.stringify(data) }),
    purchaseAddon: (id: string, addonKeyOrKeys: string | string[]) =>
        request<{ paymentId: string; message: string; amount: number; activatedKeys: string[]; pendingKeys: string[] }>(
            `/bookings/${id}/addons`,
            { method: 'POST', body: JSON.stringify(Array.isArray(addonKeyOrKeys) ? { addonKeys: addonKeyOrKeys } : { addonKey: addonKeyOrKeys }) }
        ),
};

// Client analytics ("Resultados") — overall timeline + per-contract breakdown.
export interface ResultsContract {
    contractId: string; contractName: string; sessions: number;
    views: number; likes: number; comments: number; subscribers: number; avgPeak: number;
    series: { date: string; views: number; peak: number }[];
}
export interface BookingResults {
    overall: {
        sessions: number; live: number; views: number; likes: number; comments: number; subscribers: number; avgPeak: number;
        timeline: { date: string; views: number; peak: number; likes: number; comments: number }[];
    };
    byContract: ResultsContract[];
}

// ─── Contracts ──────────────────────────────────────────
export const contractsApi = {
    checkFixo: (data: { tier: string; durationMonths: number; startDate: string; fixedDayOfWeek: number; fixedTime: string }) =>
        request<{
            available: boolean;
            weekdayUnavailable?: boolean;
            forecast?: string | null;
            conflicts: {
                date: string;
                originalTime: string;
                dayFull?: boolean;
                suggestedReplacement?: { date: string; time: string };
                alternatives?: { date: string; time: string; kind?: 'SAME_DAY' | 'OTHER_DAY' }[];
            }[];
            alternativeWeekdays?: { dayOfWeek: number; conflictCount: number; conflictFree: boolean }[];
        }>('/contracts/check-fixo', { method: 'POST', body: JSON.stringify(data) }),
    create: (data: CreateContractData) => request<{ contract: Contract; payments: PaymentSummary[]; message: string; firstPaymentId?: string }>('/contracts', { method: 'POST', body: JSON.stringify(data) }),
    createSelf: (data: SelfContractData) => request<{ message: string; firstPaymentId: string; amount: number; duration: number; alreadyPaid?: boolean; couponDiscount?: number; clientSecret?: string; firstPixString?: string }>('/contracts/self', { method: 'POST', body: JSON.stringify(data) }),    // Standalone services (e.g. Social Media Management)
    // D1/D2: `cardSplit` só vale com paymentPlan MONTHLY + CARTAO (total agora em até N× sem juros, N = meses);
    // a resposta traz `paymentDeadline` (agora + 10 min) e `installmentCap` (cardSplit = duração; FULL = 1).
    // 409 { error } quando a contratação anterior do mesmo serviço já foi paga ou está em processamento.
    createService: (opts: { serviceKey: string, paymentMethod: 'CARTAO' | 'PIX' | 'BOLETO', durationMonths?: number, paymentPlan?: 'FULL' | 'MONTHLY', couponCode?: string, cardSplit?: boolean }) => request<{ contract?: Contract; contractId?: string; firstPaymentId: string; amount: number; alreadyPaid?: boolean; couponDiscount?: number; clientSecret?: string; pixString?: string; qrCodeBase64?: string; expiresAt?: string | null; boletoUrl?: string; barcode?: string; checkoutUrl?: string; paymentDeadline?: string | null; paymentPlan?: 'MONTHLY' | 'FULL'; installmentCap?: number; message: string }>('/contracts/service', { method: 'POST', body: JSON.stringify(opts) }),
    // D7/D9: ADMIN → status ACTIVE, paymentDeadline null, sem cobrança no gateway (cobrança pelo ChargeNowSheet).
    // CLIENTE → AWAITING_PAYMENT (10 min), só a 1ª parcela cobrada; ocorrências ocupadas voltam em `skipped`.
    // Erros com `code`: INVALID_SLOT (400), CPF_CNPJ_REQUIRED (400), ALL_SLOTS_TAKEN (409); 502 = falha do provedor.
    createCustom: (data: CustomContractData) => request<{ contract: Contract; status?: 'ACTIVE' | 'AWAITING_PAYMENT'; paymentDeadline?: string | null; payments: PaymentSummary[]; summary: CustomContractSummary; skipped?: { date: string; time: string }[]; message: string; clientSecret?: string; firstPaymentId?: string; firstPixString?: string; qrCodeDataUrl?: string; expiresAt?: string }>('/contracts/custom', { method: 'POST', body: JSON.stringify(data) }),
    // frequency/weekPattern/customDates opcionais (padrão WEEKLY) — mesmo gerador de ocorrências do POST /custom.
    // userId (só ADMIN): cliente-alvo, para o backend descartar as tentativas vencidas dele antes do check.
    checkCustom: (data: { tier: string; durationMonths: number; schedule: { day: number; time: string }[]; startDate: string; frequency?: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'CUSTOM'; weekPattern?: number[]; customDates?: { date: string; time: string }[]; userId?: string }) =>
        request<{ available: boolean; conflicts: CustomConflict[]; totalConflicts: number; totalSessions: number }>('/contracts/custom/check', { method: 'POST', body: JSON.stringify(data) }),
    /**
     * Grade de horários válidos para CONTRATO de uma faixa (D8), vinda da BusinessConfig:
     * SABADO → só sábados; COMERCIAL/AUDIENCIA → seg–sex; faixa superior inclui os horários
     * da inferior. Fonte única para FIXO do admin, /self e personalizado (sem listas fixas no front).
     */
    slotOptions: (tier: ContractTier) =>
        request<ContractSlotGrid>(`/contracts/slot-options?tier=${encodeURIComponent(tier)}`),
    // ADMIN: cada contrato traz os dados de cancelamento/multa (E13) e de renovação (E4: canRenew/daysToEnd/…).
    getAll: () => request<{ contracts: AdminContract[]; pagination?: { page: number; limit: number; total: number; pages: number } }>('/contracts'),
    getMy: () => request<{ contracts: ContractWithStats[] }>('/contracts/my'),
    getById: (id: string) => request<{ contract: ContractDetail }>(`/contracts/${id}`),
    // Com `status: 'CANCELLED'` (Editar → Cancelado) a resposta traz também o resultado da anulação no provedor,
    // como o DELETE: `voidedCount` (parcelas anuladas), `paidAtProvider` (cobranças que o provedor confirmou como
    // pagas — ficaram PAID) e `liveAtProvider` (anuladas que não puderam ser canceladas no provedor agora); a
    // `message` já traz esses avisos em texto. Nos demais PATCH esses campos não vêm.
    update: (id: string, data: { status?: string; endDate?: string; flexCreditsRemaining?: number; contractUrl?: string; paymentMethod?: 'CARTAO' | 'PIX' | 'BOLETO'; boletoAllowed?: boolean; addOns?: string[] }) => request<{ contract: Contract; message: string; voidedCount?: number; paidAtProvider?: number; liveAtProvider?: number }>(`/contracts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    /**
     * ADMIN: cancela o contrato (sem multa). `paidAtProvider` = cobranças que o provedor confirmou como pagas
     * durante a anulação (ficaram PAID); `liveAtProvider` = anuladas que não puderam ser canceladas no provedor
     * agora. A `message` já traz esses avisos em texto.
     */
    cancel: (id: string) => request<CancelContractResponse>(`/contracts/${id}`, { method: 'DELETE' }),
    /** CLIENTE (dono, contrato ACTIVE): pede o cancelamento e CONGELA o % e o teto da base da multa (E13; a base efetiva só diminui). 400 = contrato não ativo ou pedido repetido. */
    requestCancellation: (id: string) => request<RequestCancellationResponse>(`/contracts/${id}/request-cancellation`, { method: 'POST' }),
    /**
     * ADMIN: decide o pedido. CHARGE_FEE gera a multa PENDENTE (`fine`; null quando não havia saldo a pagar);
     * WAIVE_FEE isenta (`fine: null`). 409 = o contrato não está mais aguardando a decisão: pedido já resolvido
     * (lista defasada, outra aba/admin, corrida ou duplo clique) — vem com `code: 'CANCELLATION_NOT_PENDING'` quando
     * barrado na checagem de status; recarregue a lista e mostre `message`. 400 = requisição inválida (ex.: `action`).
     */
    resolveCancellation: (id: string, action: 'CHARGE_FEE' | 'WAIVE_FEE') => request<ResolveCancellationResponse>(`/contracts/${id}/resolve-cancellation`, { method: 'POST', body: JSON.stringify({ action }) }),
    renew: (id: string, data?: { durationMonths?: number; tier?: string; type?: string; startDate?: string }) => request<{ contract: Contract; message: string }>(`/contracts/${id}/renew`, { method: 'POST', body: JSON.stringify(data || {}) }),
    clientRenew: (id: string, data: { durationMonths: number; paymentMethod?: 'PIX' | 'CARTAO' | 'BOLETO'; installments?: number }) => request<{ contract: Contract; message: string }>(`/contracts/${id}/client-renew`, { method: 'POST', body: JSON.stringify(data) }),
    /**
     * E9 — "Ativar cobrança automática": NÃO cria assinatura nem cobrança. Liga a cobrança automática do CLIENTE
     * (vale para todos os contratos dele) e torna o cartão informado o padrão. `paymentMethodId` = id do cartão
     * salvo (SavedCard.id) ou o `pm_…` do Stripe; só crédito. Idempotente. `durationMonths` é aceito e ignorado.
     * Erros (ApiError.code): CONTRACT_CANCELLED (400), NOTHING_TO_CHARGE (400, à vista quitado), CARD_NOT_FOUND (404),
     * CARD_NOT_CREDIT (400, débito/pré-pago); 503 = cartão indisponível; 502 = falha ao conferir/definir o cartão.
     */
    subscribe: (id: string, data: { paymentMethodId: string; /** @deprecated ignorado pelo backend */ durationMonths?: number }) =>
        request<AutoChargeActivation>(`/contracts/${id}/subscribe`, { method: 'POST', body: JSON.stringify(data) })
            .then(res => { invalidatePmCache(); return res; }),
    // paymentMethod: o validator do backend (contractPaySchema) aceita só CARTAO | PIX (default CARTAO).
    // Envie sempre o método do contrato numa renovação PIX — sem ele o backend cria PaymentIntent de cartão.
    pay: (id: string, data?: { paymentMethod?: 'CARTAO' | 'PIX'; paymentType?: 'CREDIT' | 'DEBIT'; installments?: number; couponCode?: string }) => request<{ provider?: PaymentProvider; clientSecret?: string; paymentId: string; amount: number; alreadyPaid?: boolean; couponDiscount?: number; maxInstallments?: number; pixString?: string; qrCodeBase64?: string; qrCodeDataUrl?: string | null; expiresAt?: string | null; reused?: boolean; message: string }>(`/contracts/${id}/pay`, { method: 'POST', body: JSON.stringify(data || {}) }),
    confirmPayment: (id: string, data: { paymentIntentId?: string }) => request<{ contract: { id: string; status: string }; message: string }>(`/contracts/${id}/confirm-payment`, { method: 'POST', body: JSON.stringify(data) }),
    pause: (id: string, data?: { reason?: string; resumeDate?: string }) => request<{ contract: Contract; message: string }>(`/contracts/${id}/pause`, { method: 'PATCH', body: JSON.stringify(data || {}) }),
    resume: (id: string) => request<{ contract: Contract; message: string }>(`/contracts/${id}/resume`, { method: 'PATCH' }),
};

// ─── Users (SÓ clientes) ────────────────────────────────
// `/api/users` trata SÓ de CLIENTE (D1): a listagem nunca traz a equipe e alvo que não é cliente → 404.
// A equipe (ADMIN/COLABORADOR) vive em `staffApi` (/api/staff, só ADMIN).
/** Campos do cadastro de cliente aceitos por POST/PATCH /users (sem papel: o papel é da tela Equipe). */
interface ClientWriteFields {
    name?: string; email?: string; phone?: string; notes?: string;
    cpfCnpj?: string | null; address?: string | null; addressNumber?: string | null; complement?: string | null;
    neighborhood?: string | null; city?: string | null; state?: string | null; zipCode?: string | null;
    tags?: string[]; socialLinks?: string | null; clientStatus?: string;
    /**
     * Senha do CLIENTE — SÓ o ADMIN define (F8/D9: o colaborador recebe 403; sem senha o cliente entra
     * pelo código enviado ao e-mail). Trocar e-mail de login e bloquear exigem `clientes.acesso`.
     */
    password?: string;
}
/**
 * Tira o papel do corpo (D1/D9): o cadastro de cliente nunca envia `role` (o servidor recusa `role` ≠
 * 'CLIENTE' com 400). O tipo já não aceita `role`; a remoção em tempo de execução fica como defesa.
 */
function withoutRole<T extends object>(data: T): Omit<T, 'role'> {
    const { role: _ignored, ...rest } = data as T & { role?: unknown };
    return rest;
}
export const usersApi = {
    /** `role` só aceita 'CLIENTE' (o servidor recusa outro valor com 400); sem filtro também lista só clientes. */
    getAll: (role?: 'CLIENTE') => request<{ users: UserSummary[] }>(`/users${role ? `?role=${role}` : ''}`),
    getById: (id: string) => request<{ user: UserDetail }>(`/users/${id}`),
    create: (data: ClientWriteFields & { email: string; name: string }) => request<{ user: UserSummary; message: string }>('/users', { method: 'POST', body: JSON.stringify(withoutRole(data)) }),
    update: (id: string, data: ClientWriteFields) => request<{ user: UserSummary; message: string }>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(withoutRole(data)) }),
    // D3: sem nenhum vínculo → exclusão física (softDeleted false); com qualquer vínculo → soft delete
    // com anonimização (softDeleted true). `message` já vem pronta para o toast.
    /** paidDuringDeletion: cobranças PENDING que o provedor confirmou como pagas DURANTE a exclusão (ficam PAID, sem estorno automático). */
    remove: (id: string) => request<{ message: string; softDeleted: boolean; cancelled?: { contracts: number; bookings: number; payments: number }; paidDuringDeletion?: { payments: number; amount: number } }>(`/users/${id}`, { method: 'DELETE' }),
    // Consequências reais da exclusão, para o modal de perigo montar a lista antes de confirmar.
    deletionPreview: (id: string) => request<{ preview: UserDeletionPreview }>(`/users/${id}/deletion-preview`),
    paymentOverview: (id: string) => request<{
        autoChargeEnabled: boolean; hasSavedCard: boolean;
        cards: { id: string; brand: string; last4: string; expMonth: number; expYear: number; isDefault: boolean }[];
        duePayments: { id: string; amount: number; dueDate: string | null; overdue: boolean; contractName: string }[];
    }>(`/users/${id}/payment-overview`),
    setAutoCharge: (id: string, enabled: boolean) => request<{ autoChargeEnabled: boolean }>(`/users/${id}/auto-charge`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
};

// ─── Equipe (/api/staff — só ADMIN, papel lido do banco) ─
// Contrato D5 (DECISOES-EQUIPE.md). Todo `/api/staff/:id` com alvo que não é da equipe (CLIENTE ou
// excluído) → 404. Códigos de erro estáveis (ApiError.code): ver StaffErrorCode.
/** Papel que a tela Equipe atribui (nunca transforma ninguém em CLIENTE). */
export type StaffRole = 'ADMIN' | 'COLABORADOR';
/** Nível de uma ação no catálogo: "Ver" / "Ver e editar" / "Tudo, inclusive cancelar e excluir". */
export type StaffPermissionLevel = 'ver' | 'editar' | 'tudo';
/** Selos da ação: dinheiro ($), irreversivel (⚠⚠ não tem volta), sensivel (⚠), clienteVe ("o cliente vê isto"). */
export type StaffPermissionBadge = 'dinheiro' | 'irreversivel' | 'sensivel' | 'clienteVe';
/**
 * Códigos de erro do /api/staff:
 *  - EMAIL_TAKEN (409): e-mail já usado por outro membro da equipe;
 *  - EMAIL_IS_CLIENT (409): e-mail já é de um cliente (sem diferenciar maiúsculas) — use outro e-mail;
 *  - SELF_CHANGE_FORBIDDEN (400): ninguém altera o próprio papel, permissões ou situação;
 *  - LAST_ADMIN (409): a mudança deixaria o sistema sem administrador ativo;
 *  - INVALID_PERMISSION (400): chave desconhecida ou exclusiva do ADMIN na lista (`ApiError.body.invalid`);
 *  - STAFF_NOT_FOUND (404): alvo não é da equipe (cliente ou excluído);
 *  - ADMIN_TARGET_FORBIDDEN (403): e-mail/senha de um ADMIN não se alteram por aqui (use "Enviar acesso");
 *  - STAFF_INACTIVE (409): acesso desativado — reative antes de enviar o e-mail de acesso;
 *  - PERMISSION_DENIED (403): quem chamou deixou de ser ADMIN.
 */
export type StaffErrorCode =
    | 'EMAIL_TAKEN' | 'EMAIL_IS_CLIENT' | 'SELF_CHANGE_FORBIDDEN' | 'LAST_ADMIN' | 'INVALID_PERMISSION'
    | 'STAFF_NOT_FOUND' | 'ADMIN_TARGET_FORBIDDEN' | 'STAFF_INACTIVE' | 'PERMISSION_DENIED';
export interface StaffCatalogAction {
    key: PermissionKey;
    label: string;
    description: string;
    /** null = caixa sem nível (Configurações). */
    level: StaffPermissionLevel | null;
    badges: StaffPermissionBadge[];
    /** Chaves marcadas e travadas junto (o servidor normaliza ao salvar). */
    requires: PermissionKey[];
}
export interface StaffCatalogModule {
    key: PermissionModuleKey;
    label: string;
    description: string;
    /** Chaves de cada nível (cumulativo: "editar" inclui "ver"). Configurações: os três vazios. */
    levels: Record<StaffPermissionLevel, PermissionKey[]>;
    actions: StaffCatalogAction[];
}
/** GET /api/staff/catalog — rótulos em pt-BR, níveis, selos, dependências e perfis modelo (fonte: servidor). */
export interface StaffCatalog {
    modules: StaffCatalogModule[];
    /** Exclusivas do ADMIN: aparecem em cinza ("só o administrador"), nunca para marcar. */
    adminOnly: { key: AdminOnlyPermissionKey; label: string }[];
    /** Perfis modelo: escolher só PREENCHE as caixas (o banco guarda só as chaves). */
    presets: { key: string; label: string; description: string; permissions: PermissionKey[] }[];
}
/** Membro da equipe (GET /api/staff). */
export interface StaffMember {
    id: string;
    name: string;
    /** Sempre preenchido para quem foi criado pela tela Equipe; contas antigas podem vir null. */
    email: string | null;
    phone: string | null;
    photoUrl: string | null;
    role: StaffRole;
    /** Cargo ("Recepção"). */
    title: string | null;
    /** Chaves marcadas (COLABORADOR). ADMIN: acesso total — a lista não vale. */
    permissions: PermissionKey[];
    /** false = desativado (não entra; as permissões ficam guardadas e voltam ao reativar). */
    active: boolean;
    /** É quem está logado (as ações de risco não aparecem na própria linha). */
    isSelf: boolean;
    /**
     * E-mail e senha travados na tela Equipe (E2): a pessoa é ou já foi ADMIN (o servidor recusa com 403
     * ADMIN_TARGET_FORBIDDEN). Opcional só para tolerar resposta antiga: ausente = `role !== 'COLABORADOR'`
     * (use `credentialsLocked()` de components/admin/team/teamPermissions).
     */
    credentialsLocked?: boolean;
    createdAt: string;
    updatedAt: string;
}
/** POST /api/staff. Sem senha, a pessoa entra com o código enviado ao e-mail. */
export interface StaffCreateInput {
    name: string;
    email: string;
    phone?: string | null;
    title?: string | null;
    role: StaffRole;
    /** Só COLABORADOR (ADMIN ignora). O servidor normaliza as dependências. */
    permissions?: PermissionKey[];
    /** Senha provisória (≥ 8). */
    password?: string;
    /** Envia o e-mail "Você foi adicionado à equipe…" com o link de login. */
    sendAccessEmail?: boolean;
}
/** PATCH /api/staff/:id — campos opcionais, SEM senha (senha: setPassword). E-mail só de alvo sem `credentialsLocked`. */
export interface StaffUpdateInput {
    name?: string;
    email?: string;
    phone?: string | null;
    title?: string | null;
    role?: StaffRole;
    permissions?: PermissionKey[];
}
export const staffApi = {
    getCatalog: () => request<StaffCatalog>('/staff/catalog'),
    list: () => request<{ members: StaffMember[] }>('/staff'),
    /** 201 `{ member, message, accessEmailSent? }`; 409 EMAIL_TAKEN | EMAIL_IS_CLIENT. */
    create: (data: StaffCreateInput) =>
        request<{ member: StaffMember; message: string; accessEmailSent?: boolean }>('/staff', { method: 'POST', body: JSON.stringify(data) }),
    /** Revoga as sessões do membro se o papel ou o e-mail mudar. 400 SELF_CHANGE_FORBIDDEN; 409 LAST_ADMIN. */
    update: (id: string, data: StaffUpdateInput) =>
        request<{ member: StaffMember; message: string }>(`/staff/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
    /** Só alvo sem `credentialsLocked` (COLABORADOR que nunca foi ADMIN — E2). Senha ≥ 8; revoga as sessões. */
    setPassword: (id: string, password: string) =>
        request<{ message: string }>(`/staff/${encodeURIComponent(id)}/password`, { method: 'POST', body: JSON.stringify({ password }) }),
    /** E-mail de acesso (entra por código). Rate limit leve. */
    sendAccess: (id: string) =>
        request<{ message: string }>(`/staff/${encodeURIComponent(id)}/send-access`, { method: 'POST' }),
    /** BLOCKED + revoga sessões + apaga as push subscriptions. 400 SELF_CHANGE_FORBIDDEN; 409 LAST_ADMIN. */
    deactivate: (id: string) =>
        request<{ member: StaffMember; message: string }>(`/staff/${encodeURIComponent(id)}/deactivate`, { method: 'POST' }),
    reactivate: (id: string) =>
        request<{ member: StaffMember; message: string }>(`/staff/${encodeURIComponent(id)}/reactivate`, { method: 'POST' }),
};

// ─── Coupons ────────────────────────────────────────────
export interface CouponUserRef { id: string; name: string; email: string | null }
export interface Coupon {
    id: string;
    code: string;                        // sempre UPPERCASE
    description: string | null;
    discountType: 'VALOR' | 'PERCENTUAL';
    discountValue: number;               // VALOR: centavos | PERCENTUAL: 1–100
    scope: 'FIRST_PAYMENT' | 'ALL_INSTALLMENTS';
    expiresAt: string | null;            // ISO (@db.Date — data-calendário SP)
    maxUses: number | null;              // null = ilimitado
    usedCount: number;                   // reservados + confirmados
    maxUsesPerUser: number | null;       // null = ilimitado por cliente
    minAmount: number | null;            // centavos
    onlyNewClients: boolean;
    active: boolean;
    createdAt: string;
    updatedAt: string;
    eligibleUsers: CouponUserRef[];      // vazio = todos os clientes
    confirmedUses?: number;
    reservedUses?: number;
}
export interface CouponValidation {
    valid: boolean;
    code: string;
    discountType: 'VALOR' | 'PERCENTUAL';
    discountValue: number;
    scope: 'FIRST_PAYMENT' | 'ALL_INSTALLMENTS';
    discountAmount: number;              // desconto efetivo em centavos
    finalAmount: number;                 // total após desconto (>= 0)
}
export interface CouponInput {
    code: string;
    description?: string | null;
    discountType: 'VALOR' | 'PERCENTUAL';
    discountValue: number;
    scope?: 'FIRST_PAYMENT' | 'ALL_INSTALLMENTS';
    expiresAt?: string | null;           // 'YYYY-MM-DD'
    maxUses?: number | null;
    maxUsesPerUser?: number | null;
    minAmount?: number | null;
    onlyNewClients?: boolean;
    eligibleUserIds?: string[];
    active?: boolean;
}
export const couponsApi = {
    getAll: () => request<{ coupons: Coupon[] }>('/coupons'),
    getById: (id: string) => request<{ coupon: Coupon & { redemptions: { id: string; status: string; discountAmount: number; createdAt: string; user: CouponUserRef; payment: { id: string; amount: number; status: string; createdAt: string } }[] } }>(`/coupons/${id}`),
    create: (data: CouponInput) => request<{ coupon: Coupon; message: string }>('/coupons', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Omit<CouponInput, 'code'>>) => request<{ coupon: Coupon; message: string }>(`/coupons/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    remove: (id: string) => request<{ message: string }>(`/coupons/${id}`, { method: 'DELETE' }),
    // Preview do desconto (não consome uso). Admin pode passar userId do cliente-alvo.
    validate: (data: { code: string; amount: number; userId?: string }) =>
        request<CouponValidation>('/coupons/validate', { method: 'POST', body: JSON.stringify(data) }),
};

// ─── Blocked Slots ──────────────────────────────────────
export const blockedSlotsApi = {
    create: (data: { date: string; startTime: string; endTime: string; reason?: string }) => request<{ blockedSlot: BlockedSlot; message: string }>('/blocked-slots', { method: 'POST', body: JSON.stringify(data) }),
    getAll: (date?: string) => request<{ blockedSlots: BlockedSlot[] }>(`/blocked-slots${date ? `?date=${date}` : ''}`),
    remove: (id: string) => request<{ message: string }>(`/blocked-slots/${id}`, { method: 'DELETE' }),
};

// ─── Pricing ────────────────────────────────────────────
export const pricingApi = {
    get: () => request<{ pricing: PricingConfig[] }>('/pricing'),
    update: (pricing: PricingConfig[]) => request<{ pricing: PricingConfig[]; message: string }>('/pricing', { method: 'PUT', body: JSON.stringify({ pricing }) }),
    getAddons: () => request<{ addons: AddOnConfig[] }>('/pricing/addons'),
    getAddonsAll: () => request<{ addons: AddOnConfig[] }>('/pricing/addons/all'),
    updateAddons: (addons: AddOnConfig[]) => request<{ addons: AddOnConfig[]; message: string }>('/pricing/addons', { method: 'PUT', body: JSON.stringify({ addons }) }),
    removeAddon: (key: string) => request<{ softDeleted: boolean; addon?: AddOnConfig; message: string }>(`/pricing/addons/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    getBusinessConfig: () => request<{ configs: BusinessConfigItem[]; grouped: Record<string, BusinessConfigItem[]> }>('/pricing/business-config'),
    updateBusinessConfig: (configs: { key: string; value: string }[]) => request<{ message: string }>('/pricing/business-config', { method: 'PUT', body: JSON.stringify({ configs }) }),
    getBusinessConfigPublic: () => request<{ config: Record<string, string | number> }>('/pricing/business-config/public'),
    getFeeHistory: () => request<{
        history: Record<string, { effectiveFrom: string; feePct: number; feeFixedCents: number }[]>;
        current: Record<string, { pct: number; fixedCents: number }>;
    }>('/pricing/business-config/fee-history'),
    testEmail: (to: string) => request<{ success: boolean; message?: string; error?: string }>('/pricing/business-config/email/test', { method: 'POST', body: JSON.stringify({ to }) }),
    // E3 — `boleto` é a fonte ÚNICA de "o boleto aparece?": chave-mestra das Configurações + Cora habilitada.
    // Público: BOLETO só vem em `methods` quando `boleto.available`. /all (ADMIN): todos os métodos, inclusive inativos.
    getPaymentMethods: () => request<{ methods: PaymentMethodConfigItem[]; boleto: BoletoStatus }>('/pricing/payment-methods'),
    getPaymentMethodsAll: () => request<{ methods: PaymentMethodConfigItem[]; boleto: BoletoStatus }>('/pricing/payment-methods/all'),
    // Ligar o boleto (false→true) sem a Cora ativa → 400 code 'BOLETO_PROVIDER_DISABLED' e nada do lote é gravado.
    updatePaymentMethods: (methods: PaymentMethodConfigItem[]) => request<{ methods: PaymentMethodConfigItem[]; boleto: BoletoStatus; message: string }>('/pricing/payment-methods', { method: 'PUT', body: JSON.stringify({ methods }) }),
    /**
     * ADMIN — chave-mestra "Aceitar pagamento por boleto" (salva na hora, sem reenviar a lista de métodos).
     * Ligar sem a Cora ativa → 400 `code: 'BOLETO_PROVIDER_DISABLED'` (ApiError.body.boleto traz o estado atual).
     * Desligar é sempre permitido.
     */
    setBoletoEnabled: (enabled: boolean) => request<{ boleto: BoletoStatus; message: string }>('/pricing/payment-methods/boleto', { method: 'PUT', body: JSON.stringify({ enabled }) }),
    // Authoritative checkout numbers (mirrors the client) — same payment rules everywhere.
    checkoutQuote: (body: { durationMonths: number; contractType?: string; tier?: string; addOns?: string[]; baseMonthlyCents?: number; sessionsPerPeriod?: number; discountPct?: number }) =>
        request<{ durationMonths: number; monthlyAmount: number; monthlyTotal: number; fullPix: number; fullCard: number; maxInstallments: number; freeUpTo: number; installmentPlans: InstallmentPlan[]; services: ServiceBreakdownItem[]; servicesPerRecordingCents: number }>('/pricing/checkout-quote', { method: 'POST', body: JSON.stringify(body) }),
};

// ─── Ambient (hero weather + day/night) ─────────────────
export interface AmbientWeather {
    isDay: boolean;
    condition: 'clear' | 'clouds' | 'rain' | 'storm' | 'fog' | 'snow' | string;
    label: string;
    tempC: number | null;
    city: string;
    updatedAt: string;
}
export const ambientApi = {
    getWeather: () => request<{ enabled: boolean; weather: AmbientWeather | null }>('/ambient/weather'),
};

// ─── Public (No Auth) ───────────────────────────────────
export const publicApi = {
    getWeekAvailability: (startDate: string, days: number = 7) =>
        request<PublicWeekResponse>(`/bookings/public-availability?startDate=${startDate}&days=${days}`),
};

// ─── Types ──────────────────────────────────────────────
/**
 * Papel da conta. CLIENTE = área do cliente; COLABORADOR = área administrativa limitada às `permissions`;
 * ADMIN = acesso total (único que gerencia a Equipe).
 */
export type UserRole = 'ADMIN' | 'COLABORADOR' | 'CLIENTE';
/**
 * Usuário logado — formato ÚNICO de /auth/me, login, OTP, Google, register, PATCH /auth/profile e foto.
 * Use `usePermission()` (hooks/usePermission.ts) em vez de ler `role`/`permissions` direto.
 */
export interface User {
    id: string; email: string; name: string; role: UserRole; phone?: string | null; photoUrl?: string | null;
    cpfCnpj?: string | null; address?: string | null; city?: string | null; state?: string | null; socialLinks?: string | null;
    addressNumber?: string | null; complement?: string | null; neighborhood?: string | null; zipCode?: string | null;
    essentialNotificationsOnly?: boolean;
    /**
     * Permissões efetivas (chaves de constants/permissions.ts): ADMIN = todas (inclusive as exclusivas);
     * COLABORADOR = as marcadas na tela Equipe; CLIENTE = []. Uma resposta antiga/parcial pode vir sem o
     * campo em tempo de execução — trate como [] (o usePermission já faz isso; o ADMIN passa sempre).
     */
    permissions: string[];
    /** Cargo do membro da equipe ("Recepção"); null para cliente/sem cargo. */
    staffTitle?: string | null;
}
export interface Slot {
    time: string; available: boolean; tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO' | null; price: number | null;
}
/** Status de uma reserva (Prisma enum BookingStatus). */
export type BookingStatus = 'RESERVED' | 'CONFIRMED' | 'HELD' | 'COMPLETED' | 'FALTA' | 'NAO_REALIZADO' | 'CANCELLED';
/**
 * Reserva na forma AMPLA — a das rotas do ADMIN (GET /bookings, PATCH /bookings/:id, start-recording, check-in,
 * complete…) e dos `bookings[]` de GET /contracts/:id e GET /users/:id. Além do núcleo, tudo é opcional porque
 * cada rota seleciona um subconjunto. `adminNotes` e `recordingStartedByName` SÓ existem nas rotas do admin.
 * As rotas do CLIENTE devolvem ClientBooking (forma exata, atribuível a Booking).
 */
export interface Booking {
    id: string; date: string; originalDate?: string | null; startTime: string; endTime: string;
    status: BookingStatus;
    tierApplied: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO';
    price: number; contractId?: string | null; userId?: string | null;
    /** Nota INTERNA do admin — só nas rotas do admin (E11: nunca é enviada ao cliente). */
    adminNotes?: string | null;
    /** Recado do estúdio para o cliente (escrito pelo admin na finalização). */
    clientNotes?: string | null;
    platforms?: string | null;       // JSON: string[]
    platformLinks?: string | null;   // JSON: { REDE: url }; GRAVACAO = link da gravação não transmitida
    durationMinutes?: number | null;
    peakViewers?: number | null;
    chatMessages?: number | null;
    audienceOrigin?: string | null;
    isLivestream?: boolean | null;
    streamMetrics?: string | null; // JSON: { [platform]: { views, peak, likes, comments } }
    episodeTitle?: string | null;
    episodeDescription?: string | null;
    coverImageUrl?: string | null;
    /** ISO do "Iniciar Gravação". */
    recordingStartedAt?: string | null;
    /** Nome do operador que iniciou a gravação — só nas rotas do admin. */
    recordingStartedByName?: string | null;
    statusReason?: string | null;
    // Janela de remarcação do avulso (D4/D5). null = sem janela (FALTA sem justificativa ou não se aplica).
    makeupStatus?: MakeupStatus | null;
    makeupDeadline?: string | null; // ISO — fim do dia D+N em SP (23:59:59 -03:00)
    missedDate?: string | null;     // ISO (@db.Date) — data da gravação perdida (histórico)
    addOns?: string[];
    holdExpiresAt?: string | null;
    /**
     * R5 — só nas rotas da equipe: quantas cobranças desta gravação estão em aberto (PENDING/FAILED com o
     * bookingId — a da própria sessão e a dos extras). Cancelar a sessão anula essas cobranças, o que exige
     * cobrancas.baixa (403 sem ela). Ausente = desconhecido (servidor antigo/rota do cliente): a tela não trava
     * e a mensagem do 403 do servidor aparece (cancelBlockedByOpenCharge, bookingPermissions).
     */
    openChargeCount?: number;
    /**
     * R7 (espelho do AUDFIN6-02) — a cobrança própria desta sessão foi anulada e ela não volta a ficar em aberto (409
     * SESSION_CHARGE_VOIDED). A lista de Agendamentos marca a linha quando o servidor disse isso (reopenedWithoutCharge
     * ou o 409). Ausente = desconhecido: a tela oferece e a mensagem do servidor aparece (isVoidedChargeReopenBlocked).
     */
    ownChargeVoided?: boolean;
    contract?: {
        id: string;
        name: string;
        type: 'FIXO' | 'FLEX' | 'AVULSO' | 'SERVICO' | 'CUSTOM';
        tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO';
        discountPct?: number;
        addOns?: string[];
    } | null;
    paymentIntentId?: string | null;
    // Derivados da visão do cliente (E11/E12) — sempre presentes em ClientBooking; AUSENTES nas rotas do admin.
    /** Único critério do selo "AO VIVO": CONFIRMED + gravação iniciada e ainda não finalizada (teto de 6 h). */
    isRecordingNow?: boolean;
    /** ISO do fim da gravação (início + duração) — só em COMPLETED; senão null. */
    recordingFinishedAt?: string | null;
    /** O cliente ainda pode editar título/descrição/capa/redes (só RESERVED/HELD/CONFIRMED). */
    canEditEpisode?: boolean;
    /** Por que não pode editar (mesma mensagem do 409 BOOKING_NOT_EDITABLE); null quando pode. */
    editBlockedReason?: string | null;
    /** Só nas rotas que devolvem a linha inteira (admin); as rotas do cliente não enviam. */
    createdAt?: string;
    updatedAt?: string;
}
/** Contrato de origem embutido na reserva do cliente. */
export interface ClientBookingContract {
    id: string; name: string;
    type: 'FIXO' | 'FLEX' | 'SERVICO' | 'CUSTOM' | 'AVULSO';
    tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO';
    discountPct: number; addOns: string[];
}
/**
 * Reserva na visão do CLIENTE (E11/E12) — a MESMA forma em GET /bookings/my (`bookings[]`), GET /bookings/:id,
 * GET /bookings/availability (`myBookings[]`) e nas respostas de client-update, cover-image, reschedule e makeup
 * (quando chamado pelo cliente). Nunca traz adminNotes, operador da gravação nem userId.
 */
export interface ClientBooking {
    id: string;
    date: string;                       // ISO
    startTime: string; endTime: string; // 'HH:MM'
    status: BookingStatus;
    tierApplied: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO';
    price: number;                      // centavos
    contractId: string;
    /** Recado do estúdio para o cliente (escrito pelo admin) — só leitura para o cliente. */
    clientNotes: string | null;
    // Episódio — editável pelo cliente enquanto `canEditEpisode`.
    episodeTitle: string | null;
    episodeDescription: string | null;
    coverImageUrl: string | null;
    platforms: string | null;           // JSON: string[] (YOUTUBE/INSTAGRAM/FACEBOOK/TIKTOK)
    // Resultado da gravação (preenchido pelo estúdio ao finalizar).
    platformLinks: string | null;       // JSON: { REDE: url }; GRAVACAO = link da gravação não transmitida
    durationMinutes: number | null;
    peakViewers: number | null;
    chatMessages: number | null;
    audienceOrigin: string | null;
    /** "Foi transmitida ao vivo" (atributo permanente) — NÃO é o selo "AO VIVO"; para isso use `isRecordingNow`. */
    isLivestream: boolean | null;
    streamMetrics: string | null;       // JSON: { REDE: { views, peak, subscribers, likes, comments } }
    /** ISO do "Iniciar Gravação" pelo estúdio. */
    recordingStartedAt: string | null;
    addOns: string[];
    holdExpiresAt: string | null;
    originalDate: string | null;
    statusReason: string | null;
    makeupStatus: MakeupStatus | null;
    makeupDeadline: string | null;
    missedDate: string | null;
    contract: ClientBookingContract;
    // ── Derivados (calculados na resposta — recarregue para atualizar) ──
    /** ÚNICO critério do selo "AO VIVO": CONFIRMED + gravação iniciada e ainda não finalizada (teto de 6 h). */
    isRecordingNow: boolean;
    /** ISO do fim da gravação (início + duração) — só em COMPLETED; senão null. */
    recordingFinishedAt: string | null;
    /** true só em RESERVED/HELD/CONFIRMED. false → esconder "Salvar"/upload e mostrar `editBlockedReason`. */
    canEditEpisode: boolean;
    /** Motivo do bloqueio (mesma mensagem do 409 BOOKING_NOT_EDITABLE); null quando pode editar. */
    editBlockedReason: string | null;
    /**
     * @deprecated A nota interna do admin NUNCA vem nas rotas do cliente (E11). A chave só existe (como
     * `never`) para os chamadores antigos que ainda a leem continuarem compilando — use `clientNotes`.
     */
    adminNotes?: never;
}
/** Reserva do cliente no dia (GET /bookings/availability → myBookings) — hoje a mesma forma do GET /my. */
export type MyBookingSlot = ClientBooking;
export interface BookingWithUser extends Booking {
    user: { id: string; name: string; email: string; role: string };
}
/** Faixa de horário (Prisma enum Tier). */
export type ContractTier = 'COMERCIAL' | 'AUDIENCIA' | 'SABADO';
/** Status do ciclo de vida do contrato (Prisma enum ContractStatus). COMPLETED = "Concluído" (D6). */
export type ContractStatus = 'ACTIVE' | 'AWAITING_PAYMENT' | 'EXPIRED' | 'CANCELLED' | 'PENDING_CANCELLATION' | 'PAUSED' | 'COMPLETED';
/** Janela de remarcação de falta justificada / Não Realizado do avulso (Prisma enum MakeupStatus). */
export type MakeupStatus = 'OPEN' | 'USED' | 'EXPIRED';
/** Provedor que emitiu a cobrança (Payment.provider). SICOOB/CORA = PIX; CORA também emite boleto. */
export type PaymentProvider = 'STRIPE' | 'CORA' | 'SICOOB';
/** Um horário válido de contrato na grade (GET /contracts/slot-options). */
export interface ContractSlotOption { time: string; end: string; tier: string; }
/** Horários válidos de um dia da semana (0=dom … 6=sáb) para a faixa pedida. */
export interface ContractSlotDay { dayOfWeek: number; slots: ContractSlotOption[]; }
/** Resposta de GET /contracts/slot-options?tier= — grade de contrato vinda da BusinessConfig (D8). */
export interface ContractSlotGrid { tier: string; slotDurationHours: number; days: ContractSlotDay[]; }
/** Status de uma cobrança (Prisma enum PaymentStatus). */
export type PaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED' | 'CANCELLED';
/** `kind` de uma cobrança especial (derivado de Payment.metadata.kind). null/ausente = parcela ou extra comum. */
export type PaymentKind = 'CANCELLATION_FINE';
/** Multa de cancelamento gerada para o contrato (E13) — a mais recente não anulada. Valores em centavos. */
export interface CancellationFine {
    /** id do Payment da multa — use como `paymentId` no checkout ("Cobrar agora" / pagar em Meus Pagamentos). */
    id: string;
    amount: number;
    status: PaymentStatus;
    dueDate: string | null;   // ISO — a multa vence na data da decisão
    paidAt: string | null;    // ISO
    /** % e base gravados na cobrança (null em multas geradas antes desta regra). */
    finePct: number | null;
    baseAmount: number | null;
}
/**
 * Dados de cancelamento/multa (E13) — presentes em CADA contrato de GET /contracts (admin), GET /contracts/:id
 * e GET /contracts/my. Valores em centavos; datas em ISO.
 */
export interface ContractCancellationInfo {
    /** Total efetivamente pago no contrato (cartão: valor do PaymentIntent) — parcelas, extras e multa. */
    paidTotal: number;
    /** O que falta pagar do PLANO agora (parcelas PENDING/FAILED; sem extras de gravação e sem a multa). */
    remainingTotal: number;
    /** % da multa: o congelado no pedido (PENDING_CANCELLATION), o da multa gerada (CANCELLED) ou o vigente. */
    finePct: number;
    /**
     * Base da multa. PENDING_CANCELLATION: a base EFETIVA — só as parcelas que compunham a base do pedido e ainda
     * NÃO foram pagas (parcela paga durante a análise sai; nunca passa da base congelada no pedido, ou seja, a multa
     * nunca aumenta). CANCELLED: a gravada na multa gerada. Demais: `remainingTotal` (prévia de hoje).
     */
    fineBaseAmount: number;
    /**
     * Multa em centavos conforme o status — PENDING_CANCELLATION: % congelado no pedido × base efetiva (o que
     * "Cobrar multa" vai gerar agora); CANCELLED: a multa gerada (0 se não houve); demais: a prévia de hoje
     * (remainingTotal × %). 0 = não haverá multa.
     */
    fineAmountPreview: number;
    /** ISO do pedido de cancelamento — só com status PENDING_CANCELLATION ou CANCELLED; senão null. */
    cancellationRequestedAt: string | null;
    /** ISO do cancelamento — só com status CANCELLED (é o que o card cancelado mostra); senão null. */
    cancelledAt: string | null;
    /** Multa gerada (a mais recente não anulada; só anuladas → a mais recente), ou null. `status === 'PENDING'` → o admin pode "Cobrar agora". */
    cancellationFine: CancellationFine | null;
}
/** Dados de renovação (E4). GET /contracts (admin) e GET /contracts/:id trazem todos; GET /contracts/my só `alreadyRenewed`. */
export interface ContractRenewalInfo {
    /** Já existe uma renovação não cancelada deste contrato (o backend permite 1). */
    alreadyRenewed: boolean;
    /** id do contrato novo (link "abrir contrato novo"), ou null. */
    renewedToId: string | null;
    /** Dias de calendário (SP) até o fim da vigência; negativo = vigência encerrada. */
    daysToEnd: number;
    /**
     * Botão "Renovar contrato" do admin — fonte única (lista e detalhe): tipo ≠ AVULSO/SERVICO, cliente não
     * excluído, ainda não renovado e (ACTIVE/COMPLETED com daysToEnd ≤ 30, ou EXPIRED).
     */
    canRenew: boolean;
}
/**
 * Contrato (forma base). Os campos de cancelamento/multa e de renovação são OPCIONAIS aqui porque as respostas
 * de criação/edição/renovação devolvem só a linha do contrato; nas leituras eles vêm sempre — use AdminContract
 * (GET /contracts), ContractDetail (GET /contracts/:id) ou ContractWithStats (GET /contracts/my).
 */
export interface Contract extends Partial<ContractCancellationInfo>, Partial<ContractRenewalInfo> {
    id: string; name: string; type: 'FIXO' | 'FLEX' | 'SERVICO' | 'CUSTOM' | 'AVULSO'; tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO';
    durationMonths: number; discountPct: number; startDate: string; endDate: string;
    status: ContractStatus;
    fixedDayOfWeek?: number | null; fixedTime?: string | null;
    contractUrl?: string | null;
    flexCreditsTotal?: number | null; flexCreditsRemaining?: number | null;
    flexCreditsForfeited?: number | null;
    flexCycleStart?: string | null;
    paymentPlan?: 'MONTHLY' | 'FULL';
    paymentMethod?: 'CARTAO' | 'PIX' | 'BOLETO' | null;
    /** @deprecated E3: não é mais autoridade — o boleto segue só a chave-mestra (pricingApi.getPaymentMethods().boleto). */
    boletoAllowed?: boolean;
    paymentDeadline?: string | null;
    addOns?: string[];
    /**
     * `deletedAt` (cliente excluído/anonimizado — D3) vem em GET /contracts e GET /contracts/:id.
     * `cpfCnpj` SÓ em GET /contracts/:id chamado pelo ADMIN (E1: o PIX usa o CPF do CLIENTE, nunca o do admin).
     */
    user?: { id: string; name: string; email: string; deletedAt?: string | null; cpfCnpj?: string | null };
    pausedAt?: string | null;
    pauseReason?: string | null;
    resumeDate?: string | null;
    // Custom-specific
    customSchedule?: { day: number; time: string }[] | string | null;
    sessionsPerWeek?: number | null;
    sessionsPerCycle?: number | null;
    totalSessions?: number | null;
    addonCredits?: string | null;
    accessMode?: 'FULL' | 'PROGRESSIVE' | null;
    customCreditsRemaining?: number | null;
    addonUsage?: Record<string, { limit: number, used: number }>;
    /**
     * ATU5-03 — só em GET /contracts (equipe): cobranças em aberto (PENDING/FAILED) do contrato. No avulso são as da
     * própria sessão: sem a baixa, cancelar o contrato com cobrança em aberto é recusado (403).
     */
    openChargeCount?: number;
    /**
     * R7 (AUDFIN6-01/ATU6-02) — só em GET /contracts (equipe): as cobranças em aberto que cancelar o contrato (ou decidir o
     * pedido de cancelamento) só anula COM a baixa — no avulso, todas (= openChargeCount); nos outros tipos, a cobrança
     * própria de uma gravação (cobrada à parte). > 0 sem a baixa → 403. Ausente = desconhecido (contractCancelRules).
     */
    openSessionChargeCount?: number;
}
/** Payment.metadata (só GET /contracts/:id devolve o objeto inteiro; as telas do cliente recebem apenas `kind`). */
export interface PaymentMetadata {
    kind?: PaymentKind | string;
    /** Multa de cancelamento: % congelado no pedido e a base EFETIVA usada na decisão (centavos; só as parcelas da base ainda não pagas). */
    finePct?: number;
    baseAmount?: number;
    /** E2 — marca do à vista: preço de cartão e preço PIX da MESMA cobrança (centavos). */
    pixDiscount?: { pct: number; cardAmount: number; pixAmount?: number };
    [key: string]: unknown;
}
export interface PaymentSummary {
    id: string; amount: number; status: PaymentStatus;
    dueDate: string;
    /** ISO do pagamento (null/ausente = não pago). */
    paidAt?: string | null;
    provider?: string;
    pixString?: string | null; boletoUrl?: string | null; paymentUrl?: string | null;
    /**
     * 'CANCELLATION_FINE' = multa de cancelamento (E13): rotular "Multa de cancelamento" e tirar da contagem
     * "Parcela N/Total" (junto com as CANCELLED). null = parcela/extra comum. Vem em GET /contracts/my e /contracts/:id.
     */
    kind?: PaymentKind | null;
    /** Preenchido = extra de uma gravação (não é parcela do plano). */
    bookingId?: string | null;
    /** Objeto completo — só em GET /contracts/:id (GET /contracts/my NÃO envia o metadata, só `kind`). */
    metadata?: PaymentMetadata | null;
    /** Nº de parcelas no cartão (1 = à vista). Presente no detalhe do contrato (GET /contracts/:id). */
    installments?: number | null;
    /** Total efetivamente cobrado no cartão (com juros de parcelamento); null = igual a `amount`. */
    chargedAmount?: number | null;
    /** Referência no provedor (pi_… = PaymentIntent do cartão). Com `provider`, decide se o `chargedAmount` vale para "pago". */
    providerRef?: string | null;
    /** Validade da cobrança PIX viva (D15); null/ausente = sem cobrança ou legado. */
    pixExpiresAt?: string | null;
}
/** T com as chaves K obrigatórias (sem `?`). */
type WithRequired<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;
/** Contrato da lista do ADMIN (GET /contracts): dados de cancelamento/multa (E13) e de renovação (E4) sempre presentes. */
export type AdminContract = WithRequired<Contract, keyof ContractCancellationInfo | keyof ContractRenewalInfo>;
/**
 * Contrato do CLIENTE (GET /contracts/my): dados de cancelamento/multa e `alreadyRenewed` sempre presentes
 * (renewedToId/daysToEnd/canRenew NÃO vêm aqui). `payments[]` traz `kind`, `bookingId`, `paidAt` e `pixExpiresAt`.
 */
export interface ContractWithStats extends WithRequired<Contract, keyof ContractCancellationInfo | 'alreadyRenewed'> {
    completedBookings: number;
    totalBookings: number;
    /**
     * AUDFIN-05 — só no FIXO: vagas do plano usadas pela MESMA regra do servidor (Reservado conta; a sessão EXTRA,
     * criada com o teto já cheio, não). É o que decide se o cliente ainda agenda pelo plano.
     */
    planSessionsUsed?: number;
    _count: { bookings: number };
    payments: PaymentSummary[];
    bookings: ContractBooking[];
}
/**
 * Gravação dentro de GET /contracts/my (`bookings[]`, sem as CANCELLED). NÃO é o ClientBooking: aqui não vêm
 * os derivados (isRecordingNow/canEditEpisode/…), `episodeDescription`, `holdExpiresAt` nem `contract` — para
 * eles use bookingsApi.getOne/getMy. "Gravando agora" aqui = status 'CONFIRMED' + `recordingStartedAt`.
 */
export interface ContractBooking {
    id: string; status: string; date: string; originalDate?: string | null;
    startTime: string; endTime: string; tierApplied: string; price: number;
    /** Recado do estúdio para o cliente. */
    clientNotes?: string | null;
    /** @deprecated A nota interna do admin não vem mais (E11). Chave mantida (`never`) só para os chamadores antigos compilarem. */
    adminNotes?: never;
    platforms?: string | null; platformLinks?: string | null;
    /** ISO do "Iniciar Gravação". */
    recordingStartedAt?: string | null;
    episodeTitle?: string | null;
    coverImageUrl?: string | null;
    durationMinutes?: number | null;
    peakViewers?: number | null;
    chatMessages?: number | null;
    audienceOrigin?: string | null;
    isLivestream?: boolean | null;
    streamMetrics?: string | null; // JSON: { REDE: { views, peak, subscribers, likes, comments } }
    addOns?: string[];
    statusReason?: string | null;
    makeupStatus?: MakeupStatus | null;
    makeupDeadline?: string | null;
    missedDate?: string | null;
}
/**
 * GET /contracts/:id (admin ou dono): mesmos dados de cancelamento/multa e renovação da lista. `payments[]` vem
 * por `dueDate` com `kind` e o `metadata` completo — a multa pode aparecer entre a parcela paga e as anuladas.
 * `bookings[].adminNotes`, `bookings[].recordingStartedByName` e `user.cpfCnpj` só quando quem chama é ADMIN.
 */
export interface ContractDetail extends AdminContract { bookings: Booking[]; payments: PaymentSummary[]; }

// ─── Cancelamento / multa (E13) — respostas ─────────────
/** POST /contracts/:id/request-cancellation (cliente). */
export interface RequestCancellationResponse {
    /**
     * Contrato já em PENDING_CANCELLATION. O pedido congela o PERCENTUAL e o teto da base; a multa cobrada na
     * decisão usa a base efetiva (parcela paga durante a análise sai) — pode diminuir, nunca aumentar.
     */
    contract: Contract & { cancellationRequestedAt: string; finePct: number; fineBaseAmount: number; fineAmountPreview: number };
    /** Gravações futuras liberadas (as já realizadas e a de hoje já iniciada ficam intactas). */
    cancelledBookings: number;
    /** Multa prevista (centavos): amount = baseAmount × finePct%. amount 0 = sem multa. */
    fine: { finePct: number; baseAmount: number; amount: number };
    message: string;
}
/** POST /contracts/:id/resolve-cancellation (admin). */
export interface ResolveCancellationResponse {
    contract: Contract;
    message: string;
    /** Multa gerada (PENDING) — null em WAIVE_FEE ou quando não havia saldo a pagar do plano. */
    fine: { id: string; amount: number; status: PaymentStatus; dueDate: string | null; finePct: number; baseAmount: number } | null;
    /** Parcelas pendentes anuladas. */
    voidedCount: number;
    /** Cobranças que o provedor confirmou como pagas durante a anulação (ficaram PAID). */
    paidAtProvider: number;
    /** Cobranças anuladas que não puderam ser canceladas no provedor agora. */
    liveAtProvider: number;
}
/** DELETE /contracts/:id (admin). */
export interface CancelContractResponse {
    message: string;
    voidedCount: number;
    cancelledBookings: number;
    paidAtProvider: number;
    liveAtProvider: number;
}
export interface CreateContractData {
    userId: string; name: string; type: 'FIXO' | 'FLEX' | 'SERVICO'; tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO';
    durationMonths: 3 | 6; startDate: string;
    fixedDayOfWeek?: number; fixedTime?: string; contractUrl?: string;
    /** @deprecated E3: ignorado pelo backend (o boleto segue só a chave-mestra + Cora). */
    boletoAllowed?: boolean;
    paymentPlan?: 'MONTHLY' | 'FULL';
    paymentMethod?: 'CARTAO' | 'PIX' | 'BOLETO';
    addOns?: string[];
    resolvedConflicts?: { originalDate: string; originalTime: string; newDate: string; newTime: string }[];
    couponCode?: string;
}
export interface SelfContractData {
    name: string; type: 'FIXO' | 'FLEX' | 'SERVICO'; tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO';
    durationMonths: 3 | 6;
    firstBookingDate: string; firstBookingTime: string;
    fixedDayOfWeek?: number; fixedTime?: string;
    paymentMethod: 'CARTAO' | 'PIX' | 'BOLETO';
    paymentPlan?: 'MONTHLY' | 'FULL';
    addOns?: string[];
    resolvedConflicts?: { originalDate: string; originalTime: string; newDate: string; newTime: string }[];
    couponCode?: string;
}
export interface CustomContractData {
    name: string;
    tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO';
    durationMonths: number;
    schedule: { day: number; time: string }[];
    paymentMethod: 'CARTAO' | 'PIX' | 'BOLETO';
    paymentPlan?: 'MONTHLY' | 'FULL';
    addOns?: string[];
    addonConfig?: Record<string, { mode: 'all' | 'credits'; perCycle?: number }>;
    resolvedConflicts?: { originalDate: string; originalTime: string; newDate: string; newTime: string }[];
    startDate?: string;
    userId?: string; // Admin-only: create on behalf of a client
    frequency?: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'CUSTOM';
    weekPattern?: number[];
    customDates?: { date: string; time: string }[];
    couponCode?: string;
}
export interface CustomContractSummary {
    sessionsPerWeek: number; sessionsPerCycle: number; totalSessions: number;
    discountPct: number; accessMode: string; cycleAmount: number; totalBookingsGenerated: number;
}
export interface CustomConflict {
    date: string; originalTime: string; day: number;
    suggestedReplacement?: { date: string; time: string };
}
// PaymentSummary is defined above (line ~247) — removed duplicate here
export interface UserSummary {
    id: string; email: string; name: string; phone: string | null; role: string;
    cpfCnpj: string | null; clientStatus: string; tags: string[];
    createdAt: string; _count: { bookings: number; contracts: number };
    contracts?: { type: 'FIXO' | 'FLEX' | 'SERVICO' | 'CUSTOM' | 'AVULSO'; status: string; addOns: string[]; endDate?: string | null; durationMonths?: number | null }[];
    /** Pago = valor efetivamente cobrado (cartão: o do PaymentIntent); pendente = amount. Centavos. */
    totalPaid: number; totalPending: number;
    /** Soft delete (D3): preenchido = cliente excluído/anonimizado (e-mail/CPF podem vir null). */
    deletedAt?: string | null;
}
/** GET /users/:id/deletion-preview — mode 'hard' = nada de negócio vinculado (apaga de vez); 'soft' = anonimiza e cancela pendências. Valores em centavos. */
export interface UserDeletionPreview {
    userId: string;
    name: string;
    mode: 'hard' | 'soft';
    links: { contracts: number; bookings: number; payments: number; couponRedemptions: number; blockedSlots: number };
    pending: { activeContracts: number; futureBookings: number; pendingPayments: number; pendingAmount: number };
    preserved: { paidPayments: number; paidAmount: number };
    accessories: { savedCards: number; pushSubscriptions: number; notifications: number; couponEligibilities: number; autoChargeEnabled: boolean };
    /**
     * AUDFIN-04: chaves que o acesso NÃO tem e que a exclusão exige (contratos.cancelar, contratos.multa, cobrancas.baixa
     * — pelo que ela anularia). Não vazio = o DELETE responde 403; `blockedMessage` é o mesmo texto do 403.
     */
    missingPermissions?: string[];
    blockedMessage?: string | null;
}
export interface UserDetail {
    id: string; email: string; name: string; phone: string | null; role: string;
    notes: string | null; photoUrl: string | null;
    cpfCnpj: string | null; address: string | null; city: string | null; state: string | null;
    addressNumber: string | null; complement: string | null; neighborhood: string | null; zipCode: string | null;
    tags: string[]; socialLinks: string | null; clientStatus: string;
    createdAt: string;
    /** Soft delete (D3): preenchido = perfil só-histórico (dados pessoais anonimizados). */
    deletedAt?: string | null;
    contracts: Contract[]; bookings: Booking[];
    /** chargedAmount/provider/providerRef: "pago" pelo valor efetivamente cobrado (utils/clientHealth.paidChargedAmount). */
    payments?: { id: string; amount: number; status: string; dueDate: string | null; createdAt: string; chargedAmount?: number | null; provider?: string | null; providerRef?: string | null }[];
}
export interface BlockedSlot { id: string; date: string; startTime: string; endTime: string; reason: string | null; creator?: { name: string }; }
export interface PricingConfig { tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO'; price: number; label: string; description?: string | null; }
export interface AddOnConfig {
    key: string;
    name: string;
    price: number;
    description?: string | null;
    monthly?: boolean;
    active?: boolean;
    sortOrder?: number;
    icon?: string | null;
    showOnLanding?: boolean;
    benefits?: string | null; // JSON string[]
    durationsOffered?: string; // CSV of months, e.g. "3,6"
    plansAllowed?: string; // CSV: "FULL" and/or "MONTHLY"
    billingCadence?: 'BILLING_CYCLE_28' | 'CALENDAR_MONTH';
}
/** Per-service pricing breakdown from checkout-quote — "valor por gravação" + agregados (centavos). */
export interface ServiceBreakdownItem { key: string; name: string; monthly: boolean; perRecordingCents: number; perMonthCents: number; totalCents: number; }
export interface BusinessConfigItem { key: string; value: string; type: string; label: string; group: string; }
export interface PaymentMethodConfigItem {
    key: string; label: string; shortLabel: string; emoji: string;
    description: string; color: string; active: boolean;
    sortOrder: number; accessMode: string;
    /** CSV of checkout contexts: avulso, contract, invoice */
    contexts?: string;
}
/** Por que o boleto não está disponível: chave-mestra desligada ou integração Cora inativa. */
export type BoletoUnavailableReason = 'SWITCH_OFF' | 'PROVIDER_DISABLED';
/**
 * E3 — estado do boleto (fonte única para mostrar/esconder o boleto e para o switch das Configurações).
 * Mostre a opção Boleto SÓ com `available` — e nunca em fluxos com prazo de 10 min (avulso do cliente,
 * contratação nova, serviço, personalizado do cliente, renovação): o backend recusa com BOLETO_NOT_ALLOWED_HERE.
 */
export interface BoletoStatus {
    /** Chave-mestra "Aceitar pagamento por boleto" (Configurações). */
    enabled: boolean;
    /** A integração Cora (provedor do boleto) está habilitada. false → switch bloqueado, com `message` como aviso. */
    providerEnabled: boolean;
    /** Boleto EFETIVO: chave ligada E Cora habilitada. */
    available: boolean;
    /** null quando disponível. */
    reason: BoletoUnavailableReason | null;
    /** Texto pronto para a tela (null quando disponível). */
    message: string | null;
}

// Public types (no auth)
export interface PublicSlot { time: string; available: boolean; tier: string | null; }
export interface PublicDayAvailability { date: string; dayOfWeek: number; closed: boolean; slots: PublicSlot[]; }
export interface PublicWeekResponse { days: PublicDayAvailability[]; }

// ─── Payments (Financial) ───────────────────────────────
export interface PaymentFull {
    id: string;
    userId: string;
    contractId: string | null;
    bookingId: string | null;
    provider: string;
    providerRef: string | null;
    amount: number;
    status: 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED' | 'CANCELLED';
    dueDate: string | null;
    createdAt: string;
    updatedAt: string;
    user: { id: string; name: string; email: string };
    contract: { id: string; name: string; type: string; tier: string; durationMonths: number } | null;
    booking: { id: string; date: string; startTime: string } | null;
}
export interface FinancialSummary {
    totalRevenue: number; paidRevenue: number; pendingRevenue: number;
    overdueCount: number; overdueAmount: number;
    failedCount: number; refundedAmount: number;
    totalCount: number; paidCount: number; pendingCount: number;
}
export interface MonthlyBreakdown {
    month: string; label: string; total: number; paid: number; pending: number;
}
export const paymentsApi = {
    getAll: (params?: { status?: string; userId?: string; from?: string; to?: string; search?: string }) => {
        const qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString() : '';
        return request<{ payments: PaymentFull[] }>(`/payments${qs}`);
    },
    getSummary: (params?: { from?: string; to?: string }) => {
        const qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString() : '';
        return request<{ summary: FinancialSummary; monthlyBreakdown: MonthlyBreakdown[] }>(`/payments/summary${qs}`);
    },
    update: (id: string, data: { status?: string; providerRef?: string }) =>
        request<{ payment: PaymentFull; message: string }>(`/payments/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    getStatus: (paymentId: string) =>
        request<{ status: string; provider: string; pixString?: string; boletoUrl?: string }>(`/payments/${paymentId}/status`),
    /** Whether PIX/card are running in sandbox (enables the test "simulate" affordance) */
    getSandboxMode: () =>
        request<{ pix: boolean; card: boolean }>(`/payments/sandbox-mode`),
    /** Sandbox-only: simulate a confirmed payment for end-to-end testing */
    simulate: (paymentId: string) =>
        request<{ status: string; message: string }>(`/payments/${paymentId}/simulate`, { method: 'POST' }),
};

// ─── Notifications ──────────────────────────────────────
export interface NotificationItem {
    id: string;
    type: string;
    severity: 'critical' | 'warning' | 'info';
    title: string;
    message: string;
    entityType: string;
    entityId: string;
    actionUrl?: string;
    createdAt: string;
    read: boolean;
    source: 'computed' | 'persisted';
}
export interface NotificationSummary {
    total: number; unread: number; critical: number; warning: number; info: number;
}
export const notificationsApi = {
    getAll: () => request<{ notifications: NotificationItem[]; summary: NotificationSummary }>('/notifications'),
    markAsRead: (id: string) => request<{ message: string }>(`/notifications/${id}/read`, { method: 'PATCH' }),
    markAllAsRead: () => request<{ message: string; count: number }>('/notifications/read-all', { method: 'PATCH' }),
    remove: (id: string) => request<{ message: string }>(`/notifications/${id}`, { method: 'DELETE' }),
};

// ─── Notifications Admin (event templates + broadcast) ──
export interface NotificationEventVariable { name: string; label: string; example: string; }
export interface NotificationEventDef {
    eventKey: string;
    label: string;
    description: string;
    group: 'pagamentos' | 'sessoes' | 'contratos' | 'creditos' | 'admin';
    audience: 'client' | 'admin';
    kind: 'persisted' | 'computed';
    type: string;
    variables: NotificationEventVariable[];
    defaults: { title: string; message: string; severity: string; pushDefault: boolean; actionUrl: string };
    effective: { enabled: boolean; title: string; message: string; severity: string; pushEnabled: boolean };
    overrides: { enabled: boolean; title: string | null; message: string | null; severity: string | null; pushEnabled: boolean | null } | null;
    isCustomized: boolean;
}
export interface TemplateUpdate {
    enabled?: boolean;
    title?: string | null;
    message?: string | null;
    severity?: 'critical' | 'warning' | 'info' | null;
    pushEnabled?: boolean | null;
}
export interface BroadcastBatch { batchId: string; title: string; message: string; severity: string; createdAt: string; recipients: number; readCount: number; }
export const notificationsAdminApi = {
    getEvents: () => request<{ events: NotificationEventDef[] }>('/notifications/admin/events'),
    updateTemplate: (eventKey: string, data: TemplateUpdate) =>
        request<{ message: string }>(`/notifications/admin/templates/${eventKey}`, { method: 'PUT', body: JSON.stringify(data) }),
    resetTemplate: (eventKey: string) =>
        request<{ message: string }>(`/notifications/admin/templates/${eventKey}`, { method: 'DELETE' }),
    test: (eventKey: string) =>
        request<{ message: string }>(`/notifications/admin/templates/${eventKey}/test`, { method: 'POST', body: JSON.stringify({ nonce: Date.now() }) }),
    broadcast: (data: { title: string; message: string; severity: 'critical' | 'warning' | 'info'; target: 'all' | string[]; sendPush: boolean }) =>
        request<{ batchId: string; sent: number; skipped: number; message: string }>('/notifications/admin/broadcast', { method: 'POST', body: JSON.stringify(data) }),
    getBroadcasts: () => request<{ broadcasts: BroadcastBatch[] }>('/notifications/admin/broadcasts'),
};

// ─── Reports ────────────────────────────────────────────
export interface ReportSummary {
    totalBookings: number; completedBookings: number; faltaBookings: number;
    cancelledBookings: number; totalRevenue: number;
    attendanceRate: number; cancellationRate: number;
}
export interface SlotOccupancy { slot: string; label: string; count: number; total: number; pct: number; }
export interface DayOccupancy { day: string; count: number; total: number; pct: number; }
export interface TierBreakdownItem { tier: string; count: number; revenue: number; pct: number; }
export interface AudienceMetrics { totalCompleted: number; avgViewers: number; maxViewers: number; avgChat: number; avgDuration: number; }
export interface ClientRankItem { name: string; id: string; sessions: number; revenue: number; completed: number; falta: number; avgViewers: number; }

export const reportsApi = {
    getSummary: (params?: { from?: string; to?: string }) => {
        const qs = buildQS(params);
        return request<{ summary: ReportSummary }>(`/reports/summary${qs}`);
    },
    getOccupancy: (params?: { from?: string; to?: string }) => {
        const qs = buildQS(params);
        return request<{ slotOccupancy: SlotOccupancy[]; dayOccupancy: DayOccupancy[] }>(`/reports/occupancy${qs}`);
    },
    getTiers: (params?: { from?: string; to?: string }) => {
        const qs = buildQS(params);
        return request<{ tierBreakdown: TierBreakdownItem[] }>(`/reports/tiers${qs}`);
    },
    getAudience: (params?: { from?: string; to?: string }) => {
        const qs = buildQS(params);
        return request<{ audience: AudienceMetrics }>(`/reports/audience${qs}`);
    },
    getRanking: (params?: { from?: string; to?: string; limit?: number }) => {
        const qs = buildQS(params as Record<string, string | number | undefined>);
        return request<{ ranking: ClientRankItem[] }>(`/reports/ranking${qs}`);
    },
};

export interface FinanceMetrics {
    grossRevenue: number;
    netRevenue: number;
    totalFees: number;
    pendingRevenue: number;
    paidCount: number;
    unpaidCount: number;
    breakdown: { stripe: number; cora: number; sicoob: number; };
}

export interface EnrichedPayment extends PaymentSummary {
    createdAt: string;
    methodLabel: string;
    methodEmoji: string;
    feeDeduced: number;
    netAmount: number;
    user?: { id: string; name: string; email: string; };
    contract?: { id: string; name: string; type: string; tier: string; paymentMethod: string; };
}

export interface FinanceClosingResponse {
    period: { year: number; month: number; };
    metrics: FinanceMetrics;
    payments: EnrichedPayment[];
}

export const financeApi = {
    getMonthlyClosing: (year: number, month: number) => request<FinanceClosingResponse>(`/finance/closing/${year}/${month}`),
};

// ─── Integrations API ────────────────────────────────────

export interface IntegrationSummary {
    provider: string;
    enabled: boolean;
    environment: string;
    config: Record<string, any>;
    configured: boolean;
    webhookUrl: string | null;
    lastTestedAt: string | null;
    testStatus: 'success' | 'error' | null;
    testMessage: string | null;
}

export const integrationsApi = {
    // deployEnvironment = ambiente permitido por este servidor (NODE_ENV): trava o seletor do Sicoob.
    list: () => request<{ integrations: IntegrationSummary[]; deployEnvironment?: 'sandbox' | 'production' }>('/integrations'),
    get: (provider: string) => request<{ integration: IntegrationSummary }>(`/integrations/${provider}`),
    save: (provider: string, data: { environment: string; enabled?: boolean; config: Record<string, any> }) =>
        request<{ integration: IntegrationSummary; message: string }>(`/integrations/${provider}`, { method: 'PUT', body: JSON.stringify(data) }),
    test: (provider: string) =>
        request<{ success: boolean; message: string }>(`/integrations/${provider}/test`, { method: 'POST' }),
    toggle: (provider: string, enabled: boolean) =>
        request<{ message: string }>(`/integrations/${provider}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) }),
    // Cora webhook management (via Cora API)
    listCoraWebhooks: () =>
        request<{ endpoints: { id: string; url: string; events?: string[]; created_at?: string }[] }>('/integrations/cora/webhooks'),
    registerCoraWebhook: (url: string) =>
        request<{ message: string; endpoint: any }>('/integrations/cora/webhooks', { method: 'POST', body: JSON.stringify({ url }) }),
    deleteCoraWebhook: (id: string) =>
        request<{ message: string }>(`/integrations/cora/webhooks/${id}`, { method: 'DELETE' }),
    // Sicoob webhook (1 por chave PIX; a URL é montada no servidor, sem /pix)
    getSicoobWebhook: () =>
        request<{ webhook: { webhookUrl?: string } | null }>('/integrations/sicoob/webhook'),
    // Envia a URL exibida no painel (origem pública real) — o servidor registra ESSA (não BACKEND_URL).
    registerSicoobWebhook: (url: string) =>
        request<{ message: string; url: string }>('/integrations/sicoob/webhook', { method: 'POST', body: JSON.stringify({ url }) }),
    deleteSicoobWebhook: () =>
        request<{ message: string }>('/integrations/sicoob/webhook', { method: 'DELETE' }),
};

function buildQS(params?: Record<string, string | number | undefined>): string {
    if (!params) return '';
    const entries = Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]);
    return entries.length > 0 ? '?' + new URLSearchParams(entries as [string, string][]).toString() : '';
}

// ─── Stripe API (Card Payments) ─────────────────────────

export interface SavedCard {
    id: string;
    stripePaymentMethodId: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    funding: string; // 'credit' | 'debit' | 'prepaid' | 'unknown'
    isDefault: boolean;
}

/**
 * Resposta de POST /stripe/create-payment — checkout único (cartão/PIX/boleto).
 * PIX (D15): `qrCodeDataUrl` é o PNG pronto (data:image/png;base64,…) e `expiresAt` a validade
 * da cobrança; `reused` = devolveu a cobrança viva já emitida; `alreadyPaid` = a cobrança anterior
 * já constava paga no provedor (tratar como sucesso). `amount` = valor da cobrança em centavos — no CARTÃO,
 * o valor do PaymentIntent (sem o desconto PIX do à vista, com juros quando parcelado), com `installments`.
 * `qrCodeBase64` (legado) pode vir null em runtime no reuso; fica tipado sem null para não quebrar
 * os `createPaymentFn` existentes (InlineCheckout/BookingModal) — trate como falsy.
 */
export interface CreatePaymentResponse {
    provider: PaymentProvider;
    clientSecret?: string;
    paymentIntentId?: string;
    pixString?: string;
    qrCodeBase64?: string;
    qrCodeDataUrl?: string | null;
    expiresAt?: string | null;
    amount?: number;
    /** Cartão: nº de parcelas do PaymentIntent criado (o `amount` do cartão é o valor do PI = chargedAmount). */
    installments?: number;
    reused?: boolean;
    alreadyPaid?: boolean;
    status?: string;
    boletoUrl?: string;
    barcode?: string;
    paymentId?: string;
}

export interface InstallmentPlan {
    count: number;
    perInstallment: number;
    total: number;
    feePercent: number;
    freeOfCharge: boolean;
}

/**
 * Resposta de POST /stripe/installment-plans (E2). `cardAmount` = o que o CARTÃO cobra em 1x (antes de juros);
 * `pixAmount` = o que o PIX cobra (com o desconto do à vista quando a cobrança tem a marca) — mostre cada um
 * na sua aba ANTES de gerar. Sem `paymentId` (prévia), os dois são o `amount` enviado. Centavos.
 */
export interface InstallmentPlansResponse {
    plans: InstallmentPlan[];
    cardAmount: number;
    pixAmount: number;
}

/**
 * Códigos (ApiError.code) de POST /stripe/create-payment:
 *  - CPF_CNPJ_REQUIRED (400, PIX/boleto): o DONO do pagamento não tem CPF/CNPJ válido — `ApiError.body.payerUserId`
 *    diz de quem (quando o admin cobra, é o cliente);
 *  - CARD_NOT_FOUND (400): o cartão salvo informado não é do dono do pagamento;
 *  - BOLETO_UNAVAILABLE (400): chave desligada ou Cora inativa — `ApiError.body.reason` = BoletoUnavailableReason;
 *  - BOLETO_NOT_ALLOWED_HERE (400): contratação com prazo (AWAITING_PAYMENT, sem contrato ou reserva em espera);
 *  - INSTALLMENTS_UNAVAILABLE (400): parcelamento pedido onde só há 1x;
 *  - CARD_PAYMENT_IN_FLIGHT (409): há um pagamento no cartão em processamento para esta cobrança.
 */
export type CreatePaymentErrorCode =
    | 'CPF_CNPJ_REQUIRED' | 'CARD_NOT_FOUND' | 'BOLETO_UNAVAILABLE' | 'BOLETO_NOT_ALLOWED_HERE'
    | 'INSTALLMENTS_UNAVAILABLE' | 'CARD_PAYMENT_IN_FLIGHT';

/** Pagador de uma cobrança (o CLIENTE dono do pagamento) — GET /stripe/payment-methods/for-payment/:paymentId. */
export interface PaymentPayer {
    id: string;
    name: string;
    cpfCnpj: string | null;
    /** false → peça o CPF/CNPJ do CLIENTE antes de gerar PIX/boleto. */
    hasValidCpfCnpj: boolean;
    /** Cliente excluído/anonimizado (D3). */
    deleted: boolean;
}
/** Cartões salvos e CPF do CLIENTE dono de um pagamento (E1 — admin cobrando o cliente). */
export interface PaymentMethodsForPaymentResponse {
    /** Cartões do CLIENTE (nunca os do admin). `id` = id do banco, ou o `pm_…` quando só existe no Stripe. */
    paymentMethods: SavedCard[];
    /** Cobrança automática do CLIENTE. */
    autoChargeEnabled: boolean;
    payer: PaymentPayer;
}

/** Cartão que a cobrança automática usa (o padrão ou, sem padrão, o mais recente) — sem `funding`. */
export type AutoChargeCard = Omit<SavedCard, 'funding'>;
/** GET /stripe/auto-charge — estado da cobrança automática de quem está logado (E9). */
export interface AutoChargeState {
    autoChargeEnabled: boolean;
    /** A cobrança automática é por CLIENTE: vale para todos os contratos dele. */
    scope: 'USER';
    hasSavedCard: boolean;
    /** Quantidade de cartões salvos. */
    savedCards: number;
    /** Cartão que o job cobraria; null = nenhum cartão salvo. */
    defaultCard: AutoChargeCard | null;
}
/** POST /contracts/:id/subscribe — cobrança automática ligada e cartão tornado padrão (E9). */
export interface AutoChargeActivation {
    success: true;
    autoChargeEnabled: true;
    /** Já estava ativa neste mesmo cartão (nada mudou). */
    alreadyEnabled: boolean;
    scope: 'USER';
    /** O cartão que passou a ser o padrão (isDefault sempre true). */
    defaultCard: SavedCard;
    message: string;
}

/**
 * DELETE /stripe/payment-methods/:pmId. Os três campos de cobrança automática só vêm quando o cartão removido
 * era o que ela cobrava e ela foi DESLIGADA: não sobrou cartão (NO_CARD), o substituto não é de crédito
 * (CARD_NOT_CREDIT) ou não pôde ser conferido no Stripe (CARD_NOT_FOUND / CARD_NOT_VERIFIED). A `message`
 * já traz o texto pronto para o cliente.
 */
export interface RemovePaymentMethodResponse {
    message: string;
    autoChargeEnabled?: false;
    autoChargeDisabled?: true;
    autoChargeDisabledReason?: 'NO_CARD' | 'CARD_NOT_CREDIT' | 'CARD_NOT_FOUND' | 'CARD_NOT_VERIFIED';
}

// Short-lived cache for listPaymentMethods (avoids hitting Stripe on every navigation)
const _pmCache: {
    data: { paymentMethods: SavedCard[]; autoChargeEnabled: boolean } | null;
    promise: Promise<{ paymentMethods: SavedCard[]; autoChargeEnabled: boolean }> | null;
    ts: number;
} = { data: null, promise: null, ts: 0 };
const PM_CACHE_TTL = 30_000; // 30 seconds

function invalidatePmCache() { _pmCache.data = null; _pmCache.promise = null; _pmCache.ts = 0; }

export const stripeApi = {
    getPublishableKey: () => request<{ publishableKey: string }>('/stripe/publishable-key'),
    createSetupIntent: () => request<{ clientSecret: string; setupIntentId: string }>('/stripe/setup-intent', { method: 'POST' }),
    /**
     * E9 — persiste o cartão logo após o `stripe.confirmSetup` (sem esperar o webhook); idempotente.
     * `makeDefault: true` também o torna o padrão. NÃO liga a cobrança automática (isso é contractsApi.subscribe
     * com `card.id`). Erros (ApiError.code): SETUP_INTENT_NOT_FOUND (400/404), SETUP_INTENT_NOT_CONFIRMED (409 —
     * ApiError.body.status), CARD_NOT_FOUND (404); 502 = falha no Stripe.
     */
    confirmSetupIntent: (data: { setupIntentId: string; makeDefault?: boolean }) =>
        request<{ card: SavedCard; message: string }>('/stripe/setup-intent/confirm', { method: 'POST', body: JSON.stringify(data) })
            .then(res => { invalidatePmCache(); return res; }),
    listPaymentMethods: (): Promise<{ paymentMethods: SavedCard[]; autoChargeEnabled: boolean }> => {
        const now = Date.now();
        // Return cached data if still fresh
        if (_pmCache.data && (now - _pmCache.ts) < PM_CACHE_TTL) return Promise.resolve(_pmCache.data);
        // Deduplicate in-flight requests
        if (_pmCache.promise) return _pmCache.promise;
        _pmCache.promise = request<{ paymentMethods: SavedCard[]; autoChargeEnabled: boolean }>('/stripe/payment-methods')
            .then(res => { _pmCache.data = res; _pmCache.ts = Date.now(); _pmCache.promise = null; return res; })
            .catch(err => { _pmCache.promise = null; throw err; });
        return _pmCache.promise;
    },
    invalidateCache: invalidatePmCache,
    /**
     * ADMIN (E1): cartões salvos e CPF do CLIENTE dono do pagamento — use no checkout quando o admin cobra o
     * cliente, no lugar de listPaymentMethods (que devolve os cartões de QUEM ESTÁ LOGADO). Sem cache.
     * 400 = id inválido; 404 = pagamento inexistente; 403 = não-admin.
     */
    paymentMethodsForPayment: (paymentId: string) =>
        request<PaymentMethodsForPaymentResponse>(`/stripe/payment-methods/for-payment/${encodeURIComponent(paymentId)}`),
    // Remover o cartão que a cobrança automática cobra pode DESLIGÁ-LA (ver RemovePaymentMethodResponse): mostre `message`.
    removePaymentMethod: (pmId: string) => { invalidatePmCache(); return request<RemovePaymentMethodResponse>(`/stripe/payment-methods/${pmId}`, { method: 'DELETE' }); },
    setDefaultPaymentMethod: (pmId: string) => { invalidatePmCache(); return request<{ message: string }>(`/stripe/payment-methods/${pmId}/default`, { method: 'PUT' }); },
    // O pagador é SEMPRE o dono do pagamento (mesmo quando o admin chama): CPF e cartões são os do cliente.
    // savedPaymentMethodId: SavedCard.id ou o pm_… — tem de ser do dono do pagamento. Erros: CreatePaymentErrorCode.
    // E2: no PIX, `amount` da resposta é o preço PIX e o Payment.amount MUDA no banco (recarregue a cobrança);
    // no cartão/boleto, `amount` é o preço de cartão.
    createPayment: (data: { paymentId: string; installments?: number; savedPaymentMethodId?: string; savePaymentMethod?: boolean; paymentMethod?: 'cartao' | 'pix' | 'boleto' }) =>
        request<CreatePaymentResponse>('/stripe/create-payment', { method: 'POST', body: JSON.stringify(data) }),
    verifyPayment: (data: { paymentId: string; paymentIntentId: string }) =>
        request<{ status: string; message: string }>('/stripe/verify-payment', { method: 'POST', body: JSON.stringify(data) }),
    // installmentCap (1..12): só para prévia sem paymentId; com paymentId o teto vem do próprio pagamento.
    getInstallmentPlans: (data: { paymentId?: string; amount?: number; contractDurationMonths?: number; installmentCap?: number }) =>
        request<InstallmentPlansResponse>('/stripe/installment-plans', { method: 'POST', body: JSON.stringify(data) }),
    /** E9 — estado da cobrança automática de quem está logado + o cartão que será cobrado. Sem cache. */
    getAutoCharge: () => request<AutoChargeState>('/stripe/auto-charge'),
    // Desligar (ou religar com cartão já salvo). Para ATIVAR escolhendo/cadastrando o cartão: contractsApi.subscribe.
    setAutoCharge: (enabled: boolean) => { invalidatePmCache(); return request<{ message: string }>('/stripe/auto-charge', { method: 'PUT', body: JSON.stringify({ enabled }) }); },
};


