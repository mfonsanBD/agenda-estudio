import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import Avatar from './Avatar';
import { LucideIcon, ChevronRight, User, LogOut } from 'lucide-react';
import { ADMIN_NAV, CLIENT_NAV, filterNav, isNavItemActive, type NavSubItem } from '../config/nav';
import { usePermission } from '../hooks/usePermission';
import Tooltip from './ui/Tooltip';

interface NavItemProps {
    to: string;
    icon: LucideIcon;
    label: string;
    collapsed: boolean;
}

/**
 * Recolhida, a sidebar só mostra ícones: cada item ganha `aria-label` (o rótulo
 * visível some com display:none) e um <Tooltip> à direita — em portal, então não é
 * cortado pelo overflow da .sidebar-nav. Expandida, o Tooltip fica desligado.
 */
function NavItem({ to, icon: Icon, label, collapsed }: NavItemProps) {
    const { navigateTo } = useNavigation();
    const location = useLocation();
    const isActive = isNavItemActive(location.pathname, to);

    return (
        <Tooltip content={label} placement="right" disabled={!collapsed} describe={false}>
            <button
                type="button"
                className={`sidebar-link ${isActive ? 'active' : ''}`}
                onClick={() => navigateTo(to)}
                aria-label={collapsed ? label : undefined}
                aria-current={isActive ? 'page' : undefined}
            >
                <span className="sidebar-link-icon">
                    <Icon size={20} strokeWidth={1.8} aria-hidden="true" />
                </span>
                <span className="sidebar-link-label">{label}</span>
            </button>
        </Tooltip>
    );
}

/** Group header (reuses the existing divider markup; the label hides when collapsed via CSS). */
function SidebarSection({ label }: { label: string }) {
    return (
        <div className="sidebar-section-divider">
            <div className="sidebar-section-line" />
            <span className="sidebar-section-label">{label}</span>
            <div className="sidebar-section-line" />
        </div>
    );
}

interface ExpandableNavItemProps {
    to: string;
    icon: LucideIcon;
    label: string;
    collapsed: boolean;
    subItems: NavSubItem[];
}

/**
 * A parent nav item (e.g. Configurações) that reveals its `?sec=` sub-sections
 * indented below it. Expansion is derived from the route (auto-opens when on the
 * page) and can be toggled manually. `?sec=` is the single source of truth for the
 * active sub-item — read here and in AdminSettingsPage, so they never desync.
 */
function ExpandableNavItem({ to, icon: Icon, label, collapsed, subItems }: ExpandableNavItemProps) {
    const { navigateTo } = useNavigation();
    const location = useLocation();
    const [searchParams] = useSearchParams();
    const onPage = location.pathname === to;
    const activeSec = searchParams.get('sec') ?? subItems[0]?.sec;
    const [manualOpen, setManualOpen] = useState<boolean | null>(null);
    const expanded = collapsed ? false : (manualOpen ?? onPage);

    const handleParentClick = () => {
        if (!onPage) navigateTo(to);
        setManualOpen(prev => (prev === null ? !onPage : !prev));
    };

    return (
        <div className="sidebar-group">
            <Tooltip content={label} placement="right" disabled={!collapsed} describe={false}>
                <button
                    type="button"
                    className={`sidebar-link sidebar-link--parent ${onPage ? 'active' : ''}`}
                    onClick={handleParentClick}
                    // Recolhida, o submenu nunca abre: o botão só navega (sem aria-expanded).
                    aria-expanded={collapsed ? undefined : expanded}
                    aria-label={collapsed ? label : undefined}
                    aria-current={onPage ? 'page' : undefined}
                >
                    <span className="sidebar-link-icon">
                        <Icon size={20} strokeWidth={1.8} aria-hidden="true" />
                    </span>
                    <span className="sidebar-link-label">{label}</span>
                    {!collapsed && (
                        <ChevronRight
                            size={14}
                            className={`sidebar-link-caret ${expanded ? 'sidebar-link-caret--open' : ''}`}
                            aria-hidden="true"
                        />
                    )}
                </button>
            </Tooltip>

            {expanded && (
                <div className="sidebar-subnav" role="group" aria-label={label}>
                    {subItems.map(si => {
                        const isActive = onPage && activeSec === si.sec;
                        return (
                            <button
                                key={si.sec}
                                className={`sidebar-sublink ${isActive ? 'active' : ''}`}
                                onClick={() => navigateTo(`${to}?sec=${si.sec}`)}
                            >
                                <span className="sidebar-sublink-dot" aria-hidden />
                                <span className="sidebar-sublink-label">{si.label}</span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

interface SidebarProps {
    collapsed: boolean;
}

export default function Sidebar({ collapsed }: SidebarProps) {
    const { user, logout } = useAuth();
    const { navigateTo } = useNavigation();
    // Equipe (ADMIN/COLABORADOR): menu administrativo filtrado pelas permissões; cliente: menu do cliente.
    const { isAdmin, isStaff, can, roleLabel } = usePermission();
    const navItems = useMemo(
        () => (isStaff ? filterNav(ADMIN_NAV, can, isAdmin) : CLIENT_NAV),
        [isStaff, isAdmin, can],
    );
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    // Close on outside click
    useEffect(() => {
        if (!menuOpen) return;
        const handler = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [menuOpen]);

    const handleViewProfile = () => {
        setMenuOpen(false);
        navigateTo('/perfil');
    };

    const handleLogout = async () => {
        setMenuOpen(false);
        await logout();
    };

    return (
        <aside className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`}>
            {/* ─── User Profile Section (Top) ─── */}
            <div className="sidebar-user-section" ref={menuRef}>
                {/* Recolhida: dica com o nome (que some junto com o papel). Desligada com o
                    menu aberto — os dois abrem à direita e a dica cobriria o menu. */}
                <Tooltip
                    content={user?.name || 'Menu do usuário'}
                    placement="right"
                    disabled={!collapsed || menuOpen}
                    describe={false}
                >
                    <button
                        type="button"
                        className={`sidebar-user-block ${menuOpen ? 'sidebar-user-block--active' : ''}`}
                        onClick={() => setMenuOpen(prev => !prev)}
                        aria-label={collapsed ? (user?.name ? `Menu do usuário: ${user.name}` : 'Menu do usuário') : undefined}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                    >
                        <Avatar className="sidebar-user-avatar" photoUrl={user?.photoUrl} name={user?.name} />
                        <div className="sidebar-user-info">
                            <span className="sidebar-user-name">{user?.name}</span>
                            <span className="sidebar-user-role">
                                {roleLabel}
                            </span>
                        </div>
                        {!collapsed && (
                            <ChevronRight
                                size={14}
                                className={`sidebar-user-chevron ${menuOpen ? 'sidebar-user-chevron--rotated' : ''}`}
                                strokeWidth={2.5}
                                aria-hidden="true"
                            />
                        )}
                    </button>
                </Tooltip>

                {/* ─── Profile Dropdown Menu ─── */}
                {menuOpen && (
                    <div className="sidebar-profile-menu" role="menu">
                        <button
                            className="sidebar-profile-menu-item"
                            onClick={handleViewProfile}
                            role="menuitem"
                            aria-label="Meu Perfil"
                        >
                            <User size={15} strokeWidth={2} />
                            <span>Meu Perfil</span>
                        </button>
                        <div className="sidebar-profile-menu-divider" />
                        <button
                            className="sidebar-profile-menu-item sidebar-profile-menu-item--danger"
                            onClick={handleLogout}
                            role="menuitem"
                            aria-label="Sair"
                        >
                            <LogOut size={15} strokeWidth={2} />
                            <span>Sair</span>
                        </button>
                    </div>
                )}
            </div>

            <nav className="sidebar-nav">
                {navItems.map((item, i, arr) => {
                    const showDivider = !!item.section && item.section !== arr[i - 1]?.section;
                    return (
                        <React.Fragment key={item.to}>
                            {showDivider && <SidebarSection label={item.section!} />}
                            {item.subItems ? (
                                <ExpandableNavItem
                                    to={item.to}
                                    icon={item.icon}
                                    label={item.label}
                                    collapsed={collapsed}
                                    subItems={item.subItems}
                                />
                            ) : (
                                <NavItem to={item.to} icon={item.icon} label={item.label} collapsed={collapsed} />
                            )}
                        </React.Fragment>
                    );
                })}
            </nav>
        </aside>
    );
}
