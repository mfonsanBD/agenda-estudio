import React, { useState, useEffect, useCallback, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { UIProvider, useUI } from './context/UIContext';
import { NavigationProvider } from './context/NavigationContext';
import LoginPage from './pages/LoginPage';
import LandingPage from './pages/LandingPage';
import AmbientBackground from './components/AmbientBackground';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';
import BottomTabBar from './components/BottomTabBar';
import { PageTransitionLoader } from './components/PageTransitionLoader';
import BrandLoader from './components/ui/BrandLoader';
import OfflineIndicator from './components/OfflineIndicator';
import UpdateBanner from './components/UpdateBanner';
import ErrorBoundary from './components/ErrorBoundary';
import { usePushSubscription } from './hooks/usePushSubscription';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { loadPaymentMethods } from './constants/paymentMethods';
import { clearPendingIntent, getPostLoginPath } from './utils/pendingIntent';
import { usePermission, userCan, isStaffUser } from './hooks/usePermission';
import { canAccess, STAFF_ROUTE_ACCESS, type StaffAccess, type StaffRoutePath } from './config/nav';
import { SETTINGS_SECTION_PERMISSIONS, settingsSectionPermission, type SettingsSectionId } from './constants/permissions';
import type { User } from './api/client';

// Lazy-loaded pages (code-split for faster navigation)
const DashboardPage = React.lazy(() => import('./pages/DashboardPage'));
const CalendarPage = React.lazy(() => import('./pages/CalendarPage'));
const MyBookingsPage = React.lazy(() => import('./pages/MyBookingsPage'));
const MyResultsPage = React.lazy(() => import('./pages/MyResultsPage'));
const MyContractsPage = React.lazy(() => import('./pages/MyContractsPage'));
const MyPaymentsPage = React.lazy(() => import('./pages/MyPaymentsPage'));
const MyProfilePage = React.lazy(() => import('./pages/MyProfilePage'));
const NotificationsPage = React.lazy(() => import('./pages/NotificationsPage'));
const AdminClientsPage = React.lazy(() => import('./pages/AdminClientsPage'));
const AdminBookingsPage = React.lazy(() => import('./pages/AdminBookingsPage'));
const AdminContractsPage = React.lazy(() => import('./pages/AdminContractsPage'));
const AdminContractDetailPage = React.lazy(() => import('./pages/AdminContractDetailPage'));
const AdminTodayPage = React.lazy(() => import('./pages/AdminTodayPage'));
const AdminFinancePage = React.lazy(() => import('./pages/AdminFinancePage'));
const AdminCouponsPage = React.lazy(() => import('./pages/AdminCouponsPage'));
const AdminReportsPage = React.lazy(() => import('./pages/AdminReportsPage'));
const AdminSettingsPage = React.lazy(() => import('./pages/AdminSettingsPage'));
const AdminNotificationsPage = React.lazy(() => import('./pages/AdminNotificationsPage'));
const ClientProfilePage = React.lazy(() => import('./pages/ClientProfilePage'));
const AdminTeamPage = React.lazy(() => import('./pages/AdminTeamPage'));

type PageLoader = () => Promise<unknown>;
/** Páginas da área do cliente (só CLIENTE). */
const CLIENT_PAGE_LOADERS: PageLoader[] = [
    () => import('./pages/MyBookingsPage'),
    () => import('./pages/MyContractsPage'),
    () => import('./pages/MyPaymentsPage'),
];
/** Páginas da equipe → acesso da rota (as mesmas regras do menu e do StaffRoute). */
const STAFF_PAGE_LOADERS: { path: StaffRoutePath; load: PageLoader }[] = [
    { path: '/admin/today', load: () => import('./pages/AdminTodayPage') },
    { path: '/admin/bookings', load: () => import('./pages/AdminBookingsPage') },
    { path: '/admin/clients', load: () => import('./pages/AdminClientsPage') },
    { path: '/admin/clients', load: () => import('./pages/ClientProfilePage') },
    { path: '/admin/contracts', load: () => import('./pages/AdminContractsPage') },
    { path: '/admin/contracts', load: () => import('./pages/AdminContractDetailPage') },
    { path: '/admin/finance', load: () => import('./pages/AdminFinancePage') },
    { path: '/admin/cupons', load: () => import('./pages/AdminCouponsPage') },
    { path: '/admin/reports', load: () => import('./pages/AdminReportsPage') },
    { path: '/admin/configuracoes', load: () => import('./pages/AdminSettingsPage') },
    { path: '/admin/notificacoes', load: () => import('./pages/AdminNotificationsPage') },
    { path: '/admin/equipe', load: () => import('./pages/AdminTeamPage') },
];

// Preload the page chunks while the browser is idle so navigation is instant
// (avoids the first-visit "download the chunk" delay / flicker). Só as páginas que este usuário
// pode abrir: cliente → área do cliente; equipe → as telas que as permissões dele liberam.
let pagesPreloaded = false;
function preloadPages(user: User) {
    if (pagesPreloaded) return;
    pagesPreloaded = true;
    const staff = isStaffUser(user);
    const isAdmin = user.role === 'ADMIN';
    const can = (key: Parameters<typeof userCan>[1]) => userCan(user, key);
    const loaders: PageLoader[] = [
        () => import('./pages/DashboardPage'),
        ...(!staff || canAccess(STAFF_ROUTE_ACCESS['/calendar'], can, isAdmin) ? [() => import('./pages/CalendarPage')] : []),
        ...(staff ? [] : CLIENT_PAGE_LOADERS),
        () => import('./pages/MyProfilePage'),
        () => import('./pages/NotificationsPage'),
        ...(staff
            ? STAFF_PAGE_LOADERS.filter(p => canAccess(STAFF_ROUTE_ACCESS[p.path], can, isAdmin)).map(p => p.load)
            : []),
    ];
    // Stagger so we don't compete with the initial render's network/CPU.
    loaders.forEach((load, i) => setTimeout(() => { load().catch(() => {}); }, i * 120));
}

// ─── Layout ─────────────────────────────────────────────

function Layout({ children }: { children: React.ReactNode }) {
    usePushSubscription();
    const location = useLocation();
    const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
        try { return localStorage.getItem('sidebar-collapsed') === 'true'; } catch { return false; }
    });

    const toggleSidebar = useCallback(() => {
        setSidebarCollapsed(prev => {
            const next = !prev;
            try { localStorage.setItem('sidebar-collapsed', String(next)); } catch {}
            return next;
        });
    }, []);

    // Ctrl+B shortcut
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
                e.preventDefault();
                toggleSidebar();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [toggleSidebar]);

    return (
        <div className={`app-layout ${sidebarCollapsed ? 'app-layout--sidebar-collapsed' : ''}`}>
            <OfflineIndicator />
            <AmbientBackground />
            <Topbar onToggleSidebar={toggleSidebar} />
            <Sidebar collapsed={sidebarCollapsed} />

            <main className="main-content">
                {/* Barreira por página: um crash na tela mantém o shell (sidebar/topbar)
                    vivo. key={pathname} REMONTA a barreira ao navegar — sem isso o
                    fallback ficava preso mesmo trocando de página pela sidebar. */}
                <ErrorBoundary key={location.pathname}>
                    <Suspense fallback={<PageTransitionLoader />}>
                        {children}
                    </Suspense>
                </ErrorBoundary>
            </main>

            <UpdateBanner />
            <BottomTabBar />
        </div>
    );
}

// ─── Route Guards ───────────────────────────────────────

/**
 * Loading de tela inteira (boot do app e checagem de sessão): a marca do sistema centralizada na
 * janela. Aqui ainda NÃO existe Topbar/Sidebar — por isso não é o `PageTransitionLoader`, cujo overlay
 * desconta a casca; a marca é a mesma (`BrandLoader size="page"`).
 */
function FullScreenLoader() {
    return (
        <div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <BrandLoader size="page" label="Carregando" labelHidden />
        </div>
    );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
    const { user, loading } = useAuth();

    if (loading) {
        return <FullScreenLoader />;
    }

    if (!user) {
        return <Navigate to="/login" replace />;
    }

    return <Layout>{children}</Layout>;
}

/** Aviso padrão ao barrar uma rota da equipe sem permissão (D6). */
const STAFF_ROUTE_DENIED = 'Você não tem acesso a essa área. Voltamos para o painel.';

/**
 * Redireciona (replace) mostrando um aviso. O aviso sai num efeito (nunca durante o render); o
 * destino é sempre permitido (Painel / primeira seção liberada), então não há laço.
 */
function RedirectWithNotice({ to, message }: { to: string; message?: string }) {
    const { showToast } = useUI();
    useEffect(() => {
        if (message) showToast({ message, type: 'error' });
    }, [message, showToast]);
    return <Navigate to={to} replace />;
}

/**
 * Rota da área administrativa: ADMIN e COLABORADOR. `access` vem de STAFF_ROUTE_ACCESS (a MESMA
 * tabela do menu): `perm` = qualquer uma destas permissões; `adminOnly` = só o papel ADMIN.
 * Cliente → Painel (sem aviso, como sempre foi); equipe sem a permissão → Painel com aviso. Se as
 * permissões mudarem com a tela aberta (403 → refreshPermissions), esta guarda re-renderiza e tira
 * a pessoa daqui na hora.
 */
function StaffRoute({ access, children }: { access?: StaffAccess; children: React.ReactNode }) {
    const { isStaff, isAdmin, can } = usePermission();
    if (!isStaff) return <Navigate to="/dashboard" replace />;
    if (!canAccess(access, can, isAdmin)) return <RedirectWithNotice to="/dashboard" message={STAFF_ROUTE_DENIED} />;
    return <>{children}</>;
}

/** Área do cliente (`/minhas-gravacoes`, `/meus-*`): só CLIENTE; a equipe volta ao Painel. */
function ClientRoute({ children }: { children: React.ReactNode }) {
    const { isClient } = usePermission();
    if (!isClient) return <RedirectWithNotice to="/dashboard" message="Essa página é da área do cliente." />;
    return <>{children}</>;
}

/** `/calendar` é de todos os clientes; para a equipe exige a permissão da Agenda. */
function CalendarRoute({ children }: { children: React.ReactNode }) {
    const { isStaff } = usePermission();
    if (!isStaff) return <>{children}</>;
    return <StaffRoute access={STAFF_ROUTE_ACCESS['/calendar']}>{children}</StaffRoute>;
}

const SETTINGS_SECTION_ORDER = Object.keys(SETTINGS_SECTION_PERMISSIONS) as SettingsSectionId[];

/**
 * Configurações por seção (`?sec=`): cada seção exige a sua caixa (config.gerais…; E-mail e
 * Integrações só ADMIN). Seção proibida → primeira seção liberada, com aviso; sem `?sec=` (ou seção
 * desconhecida — a página cai em Gerais) e sem acesso a Gerais → primeira liberada, sem aviso.
 * O acesso à rota em si (qualquer config.*) é do StaffRoute.
 */
function SettingsSectionGuard({ children }: { children: React.ReactNode }) {
    const [searchParams] = useSearchParams();
    const { can } = usePermission();
    const sec = searchParams.get('sec');
    const allowed = SETTINGS_SECTION_ORDER.filter(id => can(SETTINGS_SECTION_PERMISSIONS[id]));
    const first = allowed[0];
    if (!first) return <>{children}</>; // sem seção liberada: o StaffRoute já barrou a rota
    const explicit = settingsSectionPermission(sec);
    const required = explicit ?? SETTINGS_SECTION_PERMISSIONS[SETTINGS_SECTION_ORDER[0]];
    if (can(required)) return <>{children}</>;
    const next = new URLSearchParams(searchParams);
    next.set('sec', first);
    return (
        <RedirectWithNotice
            to={`/admin/configuracoes?${next.toString()}`}
            message={explicit ? 'Você não tem acesso a essa seção das Configurações.' : undefined}
        />
    );
}

function AppRoutes() {
    const { user, loading } = useAuth();

    // Load payment methods + preload page chunks (on idle) once authenticated,
    // so navigating between tabs is instant instead of downloading on first click.
    useEffect(() => {
        if (!user) return;
        // D16: intenção da landing é só do CLIENTE — a equipe nunca retoma (e não a deixa para o próximo login da aba).
        if (user.role !== 'CLIENTE') clearPendingIntent();
        loadPaymentMethods();
        const ric: (cb: () => void) => void =
            (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback
            || ((cb) => window.setTimeout(cb, 1500));
        ric(() => preloadPages(user));
    }, [user]);

    if (loading) {
        return <FullScreenLoader />;
    }

    return (
        <Routes>
            {/* Logged-in users (incl. installed PWA launching at start_url '/') go straight to the app.
                D16: este guard é a FONTE ÚNICA do destino pós-login (o LoginModal só fecha): cliente com
                horário escolhido na landing (pendingIntent válido) vai para a agenda; o resto, painel. */}
            <Route path="/" element={user ? <Navigate to={getPostLoginPath(user)} replace /> : <LandingPage />} />
            <Route path="/login" element={user ? <Navigate to={getPostLoginPath(user)} replace /> : <LoginPage />} />
            {/* Todos os logados: o Painel (destino seguro dos redirecionamentos), perfil e notificações. */}
            <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
            <Route path="/calendar" element={<ProtectedRoute><CalendarRoute><CalendarPage /></CalendarRoute></ProtectedRoute>} />
            <Route path="/perfil" element={<ProtectedRoute><MyProfilePage /></ProtectedRoute>} />
            <Route path="/notificacoes" element={<ProtectedRoute><NotificationsPage /></ProtectedRoute>} />

            {/* Área do cliente: só CLIENTE (a equipe volta ao Painel). */}
            <Route path="/minhas-gravacoes" element={<ProtectedRoute><ClientRoute><MyBookingsPage /></ClientRoute></ProtectedRoute>} />
            <Route path="/meus-resultados" element={<ProtectedRoute><ClientRoute><MyResultsPage /></ClientRoute></ProtectedRoute>} />
            <Route path="/meus-contratos" element={<ProtectedRoute><ClientRoute><MyContractsPage /></ClientRoute></ProtectedRoute>} />
            <Route path="/meus-pagamentos" element={<ProtectedRoute><ClientRoute><MyPaymentsPage /></ClientRoute></ProtectedRoute>} />

            {/* Área administrativa: ADMIN + COLABORADOR, cada rota com a permissão do módulo (STAFF_ROUTE_ACCESS,
                a mesma tabela do menu). As rotas de detalhe herdam o acesso da lista. */}
            <Route path="/admin/today" element={<ProtectedRoute><StaffRoute access={STAFF_ROUTE_ACCESS['/admin/today']}><AdminTodayPage /></StaffRoute></ProtectedRoute>} />
            <Route path="/admin/bookings" element={<ProtectedRoute><StaffRoute access={STAFF_ROUTE_ACCESS['/admin/bookings']}><AdminBookingsPage /></StaffRoute></ProtectedRoute>} />
            <Route path="/admin/clients" element={<ProtectedRoute><StaffRoute access={STAFF_ROUTE_ACCESS['/admin/clients']}><AdminClientsPage /></StaffRoute></ProtectedRoute>} />
            <Route path="/admin/clients/:id" element={<ProtectedRoute><StaffRoute access={STAFF_ROUTE_ACCESS['/admin/clients']}><ClientProfilePage /></StaffRoute></ProtectedRoute>} />
            <Route path="/admin/contracts" element={<ProtectedRoute><StaffRoute access={STAFF_ROUTE_ACCESS['/admin/contracts']}><AdminContractsPage /></StaffRoute></ProtectedRoute>} />
            <Route path="/admin/contracts/:id" element={<ProtectedRoute><StaffRoute access={STAFF_ROUTE_ACCESS['/admin/contracts']}><AdminContractDetailPage /></StaffRoute></ProtectedRoute>} />
            <Route path="/admin/finance" element={<ProtectedRoute><StaffRoute access={STAFF_ROUTE_ACCESS['/admin/finance']}><AdminFinancePage /></StaffRoute></ProtectedRoute>} />
            <Route path="/admin/cupons" element={<ProtectedRoute><StaffRoute access={STAFF_ROUTE_ACCESS['/admin/cupons']}><AdminCouponsPage /></StaffRoute></ProtectedRoute>} />
            <Route path="/admin/reports" element={<ProtectedRoute><StaffRoute access={STAFF_ROUTE_ACCESS['/admin/reports']}><AdminReportsPage /></StaffRoute></ProtectedRoute>} />
            <Route path="/admin/configuracoes" element={<ProtectedRoute><StaffRoute access={STAFF_ROUTE_ACCESS['/admin/configuracoes']}><SettingsSectionGuard><AdminSettingsPage /></SettingsSectionGuard></StaffRoute></ProtectedRoute>} />
            <Route path="/admin/notificacoes" element={<ProtectedRoute><StaffRoute access={STAFF_ROUTE_ACCESS['/admin/notificacoes']}><AdminNotificationsPage /></StaffRoute></ProtectedRoute>} />
            {/* Equipe: só o ADMIN (papel conferido no banco também no servidor — /api/staff). */}
            <Route path="/admin/equipe" element={<ProtectedRoute><StaffRoute access={STAFF_ROUTE_ACCESS['/admin/equipe']}><AdminTeamPage /></StaffRoute></ProtectedRoute>} />

            {/* Legacy redirects */}
            {/* Rotas antigas em inglês (R4): bookmarks, atalhos da PWA instalada e
                actionUrls de notificações persistidas continuam funcionando. */}
            <Route path="/my-bookings" element={<Navigate to="/minhas-gravacoes" replace />} />
            <Route path="/my-contracts" element={<Navigate to="/meus-contratos" replace />} />
            <Route path="/clients" element={<Navigate to="/admin/clients" replace />} />
            <Route path="/admin/pricing" element={<Navigate to="/admin/configuracoes?sec=financeiro" replace />} />
            <Route path="/admin/services" element={<Navigate to="/admin/configuracoes?sec=servicos" replace />} />
            <Route path="/admin/integrations" element={<Navigate to="/admin/configuracoes?sec=integracoes" replace />} />

            <Route path="*" element={<Navigate to={user ? '/dashboard' : '/login'} replace />} />
        </Routes>
    );
}

// Guardas exportadas para reuso/teste (o roteamento continua todo aqui, em AppRoutes).
export { StaffRoute, ClientRoute, CalendarRoute, SettingsSectionGuard, RedirectWithNotice };

export default function App() {
    const clientId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || "mock-client-id";
    return (
        <GoogleOAuthProvider clientId={clientId}>
            <UIProvider>
                <BrowserRouter>
                    <AuthProvider>
                        <NavigationProvider>
                            {/* Barreira global: última linha de defesa contra tela branca */}
                            <ErrorBoundary>
                                <AppRoutes />
                            </ErrorBoundary>
                        </NavigationProvider>
                    </AuthProvider>
                </BrowserRouter>
            </UIProvider>
        </GoogleOAuthProvider>
    );
}
