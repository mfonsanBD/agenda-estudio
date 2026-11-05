import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import {
    authApi, User, ApiError, AUTH_ACCOUNT_GONE_EVENT, AUTH_ACCOUNT_DISABLED_EVENT, AUTH_PERMISSIONS_STALE_EVENT,
    AUTH_SESSION_ENDED_EVENT, ACCOUNT_DISABLED_DEFAULT_MESSAGE, clearApiCaches,
    type AccountDisabledDetail, type PermissionsStaleDetail, type SessionEndedDetail,
} from '../api/client';
import { clearPendingIntent } from '../utils/pendingIntent';
import { unregisterPushOnThisDevice } from '../utils/pushDevice';
import { useUI } from './UIContext';

interface AuthContextType {
    user: User | null;
    loading: boolean;
    login: (email: string, password: string) => Promise<void>;
    register: (data: { email: string; password: string; name: string; code: string }) => Promise<void>;
    sendRegistrationCode: (data: { email: string; password: string; name: string }) => Promise<void>;
    sendLoginCode: (email: string) => Promise<void>;
    loginWithCode: (email: string, code: string) => Promise<void>;
    googleLogin: (idToken: string) => Promise<void>;
    logout: () => Promise<void>;


    updateUser: (user: User) => void;
    /** Carga da sessão (boot): qualquer falha zera o usuário (vai ao login). Não use para recarregar permissões. */
    fetchUser: () => Promise<void>;
    /**
     * Recarrega papel e permissões (GET /auth/me) SEM derrubar a sessão: erro de rede, 503 ou 5xx são
     * ignorados (o usuário continua como estava). Só um 401 (sessão realmente encerrada: o refresh já
     * falhou) leva ao login. Usado no 403 PERMISSION_DENIED, ao voltar para a aba e pelas telas da
     * equipe depois de mudar o próprio acesso.
     */
    refreshPermissions: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

/** Aviso que sobrevive ao recarregamento do logout forçado (ex.: "Seu acesso foi desativado…"). */
const AUTH_NOTICE_KEY = 'auth:notice';
/** No máximo 1 recarga de permissões por 403 a cada 10 s (rajada de 403 = 1 GET /me). */
const STALE_REFRESH_MIN_INTERVAL_MS = 10_000;
/** Ao voltar para a aba: no máximo 1 recarga por minuto. */
const VISIBILITY_REFRESH_MIN_INTERVAL_MS = 60_000;
/** O mesmo aviso de "sem permissão" não se repete em menos de 3 s. */
const DENIED_TOAST_MIN_INTERVAL_MS = 3_000;
export const PERMISSION_DENIED_TOAST = 'Você não tem permissão para esta ação.';
/** Aviso no /login quando o servidor encerrou a sessão (revogada, expirada ou recusada no refresh). */
const SESSION_ENDED_MESSAGE = 'Sua sessão terminou. Entre novamente.';

function readAuthNotice(): string | null {
    try {
        const msg = sessionStorage.getItem(AUTH_NOTICE_KEY);
        if (msg) sessionStorage.removeItem(AUTH_NOTICE_KEY);
        return msg;
    } catch { return null; }
}

function writeAuthNotice(message: string): void {
    try { sessionStorage.setItem(AUTH_NOTICE_KEY, message); } catch { /* ignore */ }
}

/** Uma resposta parcial (sem `permissions`) não apaga as permissões do mesmo usuário (menu sumindo após trocar a foto). */
function mergeUser(prev: User | null, next: User): User {
    if (!prev || prev.id !== next.id) return next;
    return {
        ...next,
        permissions: Array.isArray(next.permissions) ? next.permissions : (prev.permissions ?? []),
        staffTitle: next.staffTitle !== undefined ? next.staffTitle : prev.staffTitle,
    };
}

function isStaffRole(role: string | null | undefined): boolean {
    return role === 'ADMIN' || role === 'COLABORADOR';
}

// Accessibility: placeholder and aria-label attributes are used on interactive elements
export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const { showToast } = useUI();


    const [loading, setLoading] = useState(true);
    const userRef = useRef<User | null>(null);
    userRef.current = user;
    const accountGoneHandled = useRef(false);
    const accountDisabledHandled = useRef(false);
    /** Sessão encerrada já tratada (ou logout em andamento): os 401 seguintes não repetem o fluxo. */
    const sessionEndedHandled = useRef(false);
    const permRefreshInFlight = useRef<Promise<void> | null>(null);
    /** Última carga de permissões bem-sucedida ou tentada (boot, 403, aba) — throttle da aba. */
    const lastPermRefreshAt = useRef(0);
    /** Última recarga disparada por 403 — throttle próprio (a carga do boot não pode segurar o 1º 403). */
    const lastStaleRefreshAt = useRef(0);
    const lastDeniedToastAt = useRef(0);

    // Aviso deixado pelo logout forçado antes do recarregamento (conta desativada).
    useEffect(() => {
        const notice = readAuthNotice();
        if (notice) showToast({ message: notice, type: 'error' });
    }, [showToast]);

    // D3: conta excluída (GET /me 404 ou refresh 401 'Conta não encontrada.') = logout limpo:
    // apaga os cookies no servidor (best-effort), descarta a intenção da landing e zera a sessão.
    // Com sessão ativa na tela, recarrega em '/' como o logout normal; no carregamento inicial
    // (visitante com cookie residual) só limpa, sem recarregar.
    const handleAccountGone = useCallback(async () => {
        if (accountGoneHandled.current) return;
        accountGoneHandled.current = true;
        const hadSession = !!userRef.current;
        clearPendingIntent();
        // NS-4: a sessão já não vale (o DELETE do push levaria 401) — só desliga a inscrição no navegador.
        await unregisterPushOnThisDevice({ server: false });
        try { await authApi.logout(); } catch { /* cookies expiram sozinhos */ }
        await clearApiCaches();
        if (hadSession) {
            window.location.href = '/';
            return;
        }
        setUser(null);
        accountGoneHandled.current = false;
    }, []);

    // S3: conta desativada/bloqueada (`code: 'ACCOUNT_DISABLED'` numa rota ou no refresh — NS-3: só o code) = logout
    // forçado com o aviso. Com sessão na tela, recarrega em /login (zera TODO o estado em memória —
    // computador de recepção compartilhado) e o aviso aparece depois do recarregamento; no boot só limpa.
    const handleAccountDisabled = useCallback(async (message: string) => {
        if (accountDisabledHandled.current) return;
        accountDisabledHandled.current = true;
        const hadSession = !!userRef.current;
        clearPendingIntent();
        // NS-4: a sessão já não vale (o DELETE do push levaria 401) — só desliga a inscrição no navegador.
        await unregisterPushOnThisDevice({ server: false });
        try { await authApi.logout(); } catch { /* cookies expiram sozinhos */ }
        await clearApiCaches();
        if (hadSession) {
            writeAuthNotice(message);
            window.location.href = '/login';
            return;
        }
        setUser(null);
        showToast({ message, type: 'error' });
        accountDisabledHandled.current = false;
    }, [showToast]);

    // AUTH-01 / NS-2: o servidor recusou renovar a sessão (refresh 401 que não é conta desativada nem
    // excluída — sessão revogada ao trocar papel, e-mail ou senha, token inválido, cookie ausente).
    //  - Com sessão na tela: apaga o cookie de refresh (logout — senão ele ficava 30 dias no navegador da
    //    recepção), desliga o push deste aparelho, limpa os caches e recarrega em /login com o aviso.
    //    Antes o membro levava 401 a cada clique e nunca ia ao login.
    //  - Sem sessão (boot de visitante, cookie residual): só apaga o cookie recusado, em silêncio.
    // Falha passageira (rede, 5xx) não chega aqui: o client.ts a trata como 'unavailable' (NS-3).
    const handleSessionEnded = useCallback(async (detail?: SessionEndedDetail | null) => {
        if (sessionEndedHandled.current || accountDisabledHandled.current || accountGoneHandled.current) return;
        if (!userRef.current) {
            if (detail?.hadRefreshCookie) {
                try { await authApi.logout(); } catch { /* cookies expiram sozinhos */ }
            }
            return;
        }
        sessionEndedHandled.current = true;
        clearPendingIntent();
        await unregisterPushOnThisDevice({ server: false });
        try { await authApi.logout(); } catch { /* cookies expiram sozinhos */ }
        await clearApiCaches();
        writeAuthNotice(SESSION_ENDED_MESSAGE);
        window.location.href = '/login';
    }, []);

    // Check if user is already logged in
    const fetchUser = useCallback(async () => {
        try {
            const { user } = await authApi.me();
            lastPermRefreshAt.current = Date.now();
            setUser(user);
        } catch (err) {
            setUser(null);
            if (err instanceof ApiError && err.status === 404) void handleAccountGone();
        } finally {
            setLoading(false);
        }
    }, [handleAccountGone]);

    const refreshPermissions = useCallback((): Promise<void> => {
        if (permRefreshInFlight.current) return permRefreshInFlight.current;
        lastPermRefreshAt.current = Date.now();
        const run = (async () => {
            try {
                const { user: fresh } = await authApi.me();
                const current = userRef.current;
                if (current && fresh && current.id !== fresh.id) {
                    // Outra conta entrou neste navegador (outra aba): recarrega para não misturar dados.
                    await clearApiCaches();
                    window.location.href = '/';
                    return;
                }
                // Nada mudou → mantém o MESMO objeto (sem re-render do app nem efeitos que dependem de `user`).
                setUser(prev => {
                    const next = mergeUser(prev, fresh);
                    return prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
                });
            } catch (err) {
                if (err instanceof ApiError && err.status === 404) { void handleAccountGone(); return; }
                // 401 ACCOUNT_DISABLED já virou evento (request); 401 comum = o refresh RECUSOU → sessão
                // encerrada (ex.: papel alterado pelo administrador revoga as sessões). Normalmente o
                // evento auth:session-ended já tratou; aqui cobre o 401 que veio depois de um refresh ok.
                if (err instanceof ApiError && err.status === 401 && err.code !== 'ACCOUNT_DISABLED') {
                    void handleSessionEnded({ code: err.code ?? null, hadRefreshCookie: true });
                }
                // Rede, 503 (permissões indisponíveis ou refresh indisponível — NS-3), 5xx: mantém o que já
                // tinha — nunca desloga à toa.
            } finally {
                permRefreshInFlight.current = null;
            }
        })();
        permRefreshInFlight.current = run;
        return run;
    }, [handleAccountGone, handleSessionEnded]);

    useEffect(() => {
        fetchUser();
    }, [fetchUser]);

    useEffect(() => {
        const onGone = () => { void handleAccountGone(); };
        window.addEventListener(AUTH_ACCOUNT_GONE_EVENT, onGone);
        return () => window.removeEventListener(AUTH_ACCOUNT_GONE_EVENT, onGone);
    }, [handleAccountGone]);

    useEffect(() => {
        const onDisabled = (e: Event) => {
            const detail = (e as CustomEvent<AccountDisabledDetail>).detail;
            void handleAccountDisabled(detail?.message || ACCOUNT_DISABLED_DEFAULT_MESSAGE);
        };
        window.addEventListener(AUTH_ACCOUNT_DISABLED_EVENT, onDisabled);
        return () => window.removeEventListener(AUTH_ACCOUNT_DISABLED_EVENT, onDisabled);
    }, [handleAccountDisabled]);

    useEffect(() => {
        const onSessionEnded = (e: Event) => {
            void handleSessionEnded((e as CustomEvent<SessionEndedDetail>).detail);
        };
        window.addEventListener(AUTH_SESSION_ENDED_EVENT, onSessionEnded);
        return () => window.removeEventListener(AUTH_SESSION_ENDED_EVENT, onSessionEnded);
    }, [handleSessionEnded]);

    // D6: 403 PERMISSION_DENIED = permissões defasadas → recarrega (no máx. 1×/10 s) e avisa quando foi
    // uma AÇÃO do usuário (POST/PUT/PATCH/DELETE). Leituras de fundo (GET) só recarregam, em silêncio:
    // a tela trata o próprio erro. Se a rota atual deixou de ser permitida, o StaffRoute redireciona.
    useEffect(() => {
        const onStale = (e: Event) => {
            if (!isStaffRole(userRef.current?.role)) return;
            const detail = (e as CustomEvent<PermissionsStaleDetail>).detail;
            const now = Date.now();
            if (detail && detail.method !== 'GET' && now - lastDeniedToastAt.current > DENIED_TOAST_MIN_INTERVAL_MS) {
                lastDeniedToastAt.current = now;
                showToast({ message: PERMISSION_DENIED_TOAST, type: 'error' });
            }
            if (now - lastStaleRefreshAt.current >= STALE_REFRESH_MIN_INTERVAL_MS) {
                lastStaleRefreshAt.current = now;
                void refreshPermissions();
            }
        };
        window.addEventListener(AUTH_PERMISSIONS_STALE_EVENT, onStale);
        return () => window.removeEventListener(AUTH_PERMISSIONS_STALE_EVENT, onStale);
    }, [refreshPermissions, showToast]);

    // Voltou para a aba: a equipe recarrega as permissões (no máx. 1×/min) — mudanças feitas pelo
    // administrador valem sem novo login. Cliente não tem permissões: nada a recarregar.
    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState !== 'visible') return;
            if (!isStaffRole(userRef.current?.role)) return;
            if (Date.now() - lastPermRefreshAt.current < VISIBILITY_REFRESH_MIN_INTERVAL_MS) return;
            void refreshPermissions();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [refreshPermissions]);

    // Sessão nova: o api-cache do service worker pode ter respostas de quem usou o navegador antes (S2).
    const startSession = useCallback(async (fresh: User) => {
        await clearApiCaches();
        accountDisabledHandled.current = false;
        sessionEndedHandled.current = false;
        lastPermRefreshAt.current = Date.now();
        setUser(fresh);
    }, []);

    const login = useCallback(async (email: string, password: string) => {
        const { user } = await authApi.login(email, password);
        await startSession(user);
    }, [startSession]);

    const register = useCallback(async (data: { email: string; password: string; name: string; code: string }) => {
        const { user } = await authApi.register(data);
        await startSession(user);
    }, [startSession]);

    const sendRegistrationCode = useCallback(async (data: { email: string; password: string; name: string }) => {
        await authApi.sendRegistrationCode(data);
    }, []);

    const sendLoginCode = useCallback(async (email: string) => {
        await authApi.loginSendCode(email);
    }, []);

    const loginWithCode = useCallback(async (email: string, code: string) => {
        const { user } = await authApi.loginVerifyCode(email, code);
        await startSession(user);
    }, [startSession]);



    const googleLogin = useCallback(async (idToken: string) => {
        const { user } = await authApi.googleLogin(idToken);
        await startSession(user);
    }, [startSession]);


    const logout = useCallback(async () => {
        // Saindo: um 401 de fundo (sino) durante a saída não vira "Sua sessão terminou" — a recarga abaixo zera tudo.
        sessionEndedHandled.current = true;
        // D16: a escolha feita na landing não sobrevive ao logout (outro usuário na mesma aba).
        clearPendingIntent();
        // NS-4: desvincula o push DESTE aparelho (servidor + navegador) ANTES do /auth/logout — a rota de
        // push exige a sessão. Sem isto, os avisos do ADMIN (cliente e valores) seguiam aparecendo na
        // tela da recepção depois que ele saía. Best-effort, no máximo ~1,5 s.
        await unregisterPushOnThisDevice({ server: true });
        try {
            await authApi.logout();
        } catch (err) {
            console.error('Erro no logout API:', err);
        } finally {
            // S2: o próximo usuário deste navegador não lê do cache o que este carregou.
            await clearApiCaches();
            // We skip setUser(null) here to prevent ProtectedRoute from flashing /login.
            // The hard redirect below will clear all state by reloading the app.
            window.location.href = '/';
        }
    }, []);





    const updateUser = useCallback((user: User) => {
        setUser(prev => mergeUser(prev, user));
    }, []);

    return (
        <AuthContext.Provider value={{ user, loading, login, register, sendRegistrationCode, sendLoginCode, loginWithCode, googleLogin, logout, updateUser, fetchUser, refreshPermissions }}>
            {children}
        </AuthContext.Provider>
    );

}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within AuthProvider');
    return ctx;
}
