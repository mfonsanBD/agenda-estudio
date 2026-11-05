import { useMemo } from 'react';
import { LayoutDashboard, Lock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import { usePermission } from '../hooks/usePermission';
import { DASHBOARD_PERMISSIONS } from '../constants/permissions';
import { ADMIN_NAV, filterNav } from '../config/nav';
import AdminDashboard from '../components/admin/dashboard/AdminDashboard';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import ClientDashboard from '../components/client/ClientDashboard';

/**
 * Painel. Equipe (ADMIN e COLABORADOR) → painel administrativo, cujos blocos seguem a permissão do
 * módulo de origem; cliente → painel do cliente. O Painel é o destino seguro dos redirecionamentos
 * (rota sem permissão volta para cá), então nunca exige permissão.
 * Colaborador sem nenhuma permissão que alimente um bloco do painel → estado vazio (em vez de
 * disparar leituras que dariam 403).
 */
export default function DashboardPage() {
    const { isStaff, isAdmin, canAny } = usePermission();
    if (!isStaff) return <ClientDashboard />;
    if (!isAdmin && !canAny(...DASHBOARD_PERMISSIONS)) return <StaffEmptyDashboard />;
    return <AdminDashboard />;
}

/** Painel do colaborador sem blocos: explica o motivo e oferece atalhos para o que ele pode abrir. */
function StaffEmptyDashboard() {
    const { user } = useAuth();
    const { isAdmin, can } = usePermission();
    const { navigateTo } = useNavigation();
    const shortcuts = useMemo(
        () => filterNav(ADMIN_NAV, can, isAdmin).filter(item => item.to !== '/dashboard'),
        [can, isAdmin],
    );
    const hasPermissions = (user?.permissions?.length ?? 0) > 0;
    const hasAnyModule = hasPermissions && shortcuts.length > 0;
    // FE-4: tem permissões, mas nenhuma abre uma tela (ex.: só Cobranças — os botões de cobrança ficam em
    // Agendamentos e Contratos). A frase do D6 ("ainda não tem módulos") fica para quem não tem nenhuma.
    const noScreenForPermissions = hasPermissions && shortcuts.length === 0;
    const firstName = user?.name?.trim().split(/\s+/)[0];

    return (
        <div>
            <AdminPageHeader
                icon={LayoutDashboard}
                title={firstName ? `Olá, ${firstName}` : 'Painel'}
                subtitle="Área da equipe"
            />
            <div className="admin-empty" role="status">
                <Lock size={40} className="admin-empty__icon" aria-hidden="true" />
                {hasAnyModule ? (
                    <>
                        <div className="admin-empty__title">O painel não tem blocos para o seu acesso</div>
                        <div className="admin-empty__hint">Abra uma das áreas liberadas para você:</div>
                        {shortcuts.map(item => {
                            const Icon = item.icon;
                            return (
                                <button
                                    key={item.to}
                                    type="button"
                                    className="btn-admin-ghost"
                                    onClick={() => navigateTo(item.to)}
                                >
                                    <Icon size={16} aria-hidden="true" /> {item.label}
                                </button>
                            );
                        })}
                    </>
                ) : noScreenForPermissions ? (
                    <>
                        <div className="admin-empty__title">Suas permissões atuais não abrem nenhuma tela.</div>
                        <div className="admin-empty__hint">
                            Por exemplo, só Cobranças: os botões de cobrança ficam em Agendamentos e Contratos. Fale com o administrador.
                        </div>
                    </>
                ) : (
                    <>
                        <div className="admin-empty__title">Seu acesso ainda não tem módulos liberados.</div>
                        <div className="admin-empty__hint">Fale com o administrador.</div>
                    </>
                )}
            </div>
        </div>
    );
}
