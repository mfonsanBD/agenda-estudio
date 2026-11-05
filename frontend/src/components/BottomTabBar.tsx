import { useId, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { LayoutGrid } from 'lucide-react';
import { usePermission } from '../hooks/usePermission';
import { useNavigation } from '../context/NavigationContext';
import BottomSheetModal from './BottomSheetModal';
// Nav items come from a single shared source so desktop (Sidebar) and mobile
// (this bar) never drift. The bar has at most MOBILE_BAR_SLOTS equal slots and
// never scrolls: a list that fits shows every item; a longer one (admin) keeps
// the `mobilePrimary` items on the bar and moves the rest to the "Mais" sheet,
// grouped by `section`. Labels/icons use the mobile-specific overrides.
// Equipe: o menu administrativo vem filtrado pelas permissões (filterNav), igual ao da Sidebar.
import { CLIENT_NAV, ADMIN_NAV, filterNav, isNavItemActive, splitMobileNav, type NavItem } from '../config/nav';

interface NavGroup {
    section: string | null;
    items: NavItem[];
}

/** Agrupa os itens do sheet "Mais" por `section`, na ordem em que aparecem. */
function groupBySection(items: NavItem[]): NavGroup[] {
    const groups: NavGroup[] = [];
    for (const item of items) {
        const section = item.section ?? null;
        const group = groups.find(g => g.section === section);
        if (group) group.items.push(item);
        else groups.push({ section, items: [item] });
    }
    return groups;
}

export default function BottomTabBar() {
    const { isAdmin, isStaff, can } = usePermission();
    const { navigateTo, isTransitioning, pendingPath } = useNavigation();
    const { pathname } = useLocation();
    const uid = useId();
    const { primary, overflow } = useMemo(
        () => splitMobileNav(isStaff ? filterNav(ADMIN_NAV, can, isAdmin) : CLIENT_NAV),
        [isStaff, isAdmin, can],
    );

    // O sheet "Mais" lembra a rota em que foi aberto: se a rota muda (por ele, pela
    // barra ou por qualquer outro link), ele fecha sozinho — sem efeito extra.
    const [moreOpenAt, setMoreOpenAt] = useState<string | null>(null);
    const moreOpen = moreOpenAt === pathname;
    const closeMore = () => setMoreOpenAt(null);

    // Active state stays bound to the committed location so the highlight and the
    // on-screen page switch together (no blink). A separate "pending" class gives
    // immediate tap feedback on the target while the transition resolves.
    const isPending = (to: string) => isTransitioning && !!pendingPath && isNavItemActive(pendingPath, to);
    const moreActive = overflow.some(i => isNavItemActive(pathname, i.to));
    const morePending = overflow.some(i => isPending(i.to));

    const go = (to: string) => {
        closeMore();
        navigateTo(to);
    };

    const tabClass = (active: boolean, pending: boolean, extra?: string) =>
        ['btb-tab', active && 'btb-tab--active', pending && 'btb-tab--pending', extra].filter(Boolean).join(' ');

    return (
        <div className="bottom-tab-bar-wrap">
            <nav className="bottom-tab-bar" aria-label="Navegação principal">
                {primary.map(item => {
                    const label = item.shortLabel ?? item.label;
                    const Icon = item.mobileIcon ?? item.icon;
                    const isActive = isNavItemActive(pathname, item.to);
                    return (
                        <button
                            key={item.to}
                            type="button"
                            className={tabClass(isActive, isPending(item.to))}
                            aria-current={isActive ? 'page' : undefined}
                            onClick={() => go(item.to)}
                        >
                            <Icon size={22} strokeWidth={1.8} className="btb-tab-icon" aria-hidden="true" />
                            <span className="btb-tab-label">{label}</span>
                        </button>
                    );
                })}
                {overflow.length > 0 && (
                    <button
                        key="more"
                        type="button"
                        className={tabClass(moreActive, morePending, moreOpen ? 'btb-tab--open' : undefined)}
                        aria-label="Mais opções"
                        aria-haspopup="dialog"
                        aria-expanded={moreOpen}
                        aria-current={moreActive ? 'true' : undefined}
                        onClick={() => setMoreOpenAt(prev => (prev === pathname ? null : pathname))}
                    >
                        <LayoutGrid size={22} strokeWidth={1.8} className="btb-tab-icon" aria-hidden="true" />
                        <span className="btb-tab-label">Mais</span>
                    </button>
                )}
            </nav>

            {overflow.length > 0 && (
                <BottomSheetModal isOpen={moreOpen} onClose={closeMore} title="Mais opções" size="sm">
                    <div className="btb-more">
                        {groupBySection(overflow).map((group, gi) => {
                            const headingId = `${uid}-sec-${gi}`;
                            return (
                                <section
                                    key={group.section ?? `grupo-${gi}`}
                                    className="btb-more-section"
                                    aria-labelledby={group.section ? headingId : undefined}
                                >
                                    {group.section && (
                                        <h3 id={headingId} className="btb-more-section-title">{group.section}</h3>
                                    )}
                                    <ul className="btb-more-grid">
                                        {group.items.map(item => {
                                            const Icon = item.icon;
                                            const isActive = isNavItemActive(pathname, item.to);
                                            return (
                                                <li key={item.to}>
                                                    <button
                                                        type="button"
                                                        className={`btb-more-item${isActive ? ' btb-more-item--active' : ''}`}
                                                        aria-current={isActive ? 'page' : undefined}
                                                        onClick={() => go(item.to)}
                                                    >
                                                        <Icon size={22} strokeWidth={1.8} aria-hidden="true" />
                                                        <span className="btb-more-item-label">{item.label}</span>
                                                    </button>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </section>
                            );
                        })}
                    </div>
                </BottomSheetModal>
            )}
        </div>
    );
}
