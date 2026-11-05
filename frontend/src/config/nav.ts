import {
    LayoutDashboard,
    CalendarDays,
    Clapperboard,
    FileText,
    Wallet,
    MapPin,
    ClipboardList,
    Users,
    FileSignature,
    CreditCard,
    TicketPercent,
    BarChart3,
    BellRing,
    Settings,
    ShieldCheck,
    type LucideIcon,
} from 'lucide-react';
import {
    CONFIG_PERMISSION_KEYS,
    SETTINGS_SECTION_PERMISSIONS,
    type Permission,
    type SettingsSectionId,
} from '../constants/permissions';

/**
 * Single source of truth for the app navigation.
 *
 * Both consumers read from the same lists so a new page never has to be added
 * in two places (which is exactly how Cupons/Notificações drifted before):
 *   - Sidebar (desktop) renders `label`/`icon`, groups by `section`, and expands
 *     items that carry `subItems`.
 *   - BottomTabBar (PWA/mobile) renders at most MOBILE_BAR_SLOTS (5) equal slots
 *     using `shortLabel ?? label` and `mobileIcon ?? icon`. A list that fits shows
 *     every item; a longer list shows only the `mobilePrimary` items (max 4) plus a
 *     "Mais" tab whose sheet lists the rest grouped by `section`.
 *
 * To add a destination to both navs, add ONE entry here (it lands in the "Mais"
 * sheet on mobile unless it is marked `mobilePrimary`).
 *
 * Equipe (ADMIN + COLABORADOR): o menu administrativo é FILTRADO por permissão (`filterNav`) —
 * cada item declara o acesso que a rota exige (`perm`, mesma tabela que o App.tsx usa nas rotas:
 * STAFF_ROUTE_ACCESS) e `adminOnly` para o que é só do administrador (Equipe).
 */
export interface NavItem {
    to: string;
    /** Desktop / sidebar label. */
    label: string;
    /** Shorter label for the mobile bottom bar (falls back to `label`). */
    shortLabel?: string;
    /** Sidebar / default icon. */
    icon: LucideIcon;
    /** Bottom-bar icon override (falls back to `icon`). */
    mobileIcon?: LucideIcon;
    /** Sidebar group header this item belongs to (admin only). */
    section?: string;
    /** If present, the sidebar renders this item as an expandable parent. */
    subItems?: NavSubItem[];
    /**
     * Fica fixo na barra inferior (mobile) quando a lista não cabe em
     * MOBILE_BAR_SLOTS; os demais itens vão para o sheet "Mais".
     */
    mobilePrimary?: boolean;
    /** Equipe: aparece com QUALQUER uma destas permissões (sem `perm` = toda a equipe). */
    perm?: readonly Permission[];
    /** Equipe: só o papel ADMIN (ex.: Equipe). */
    adminOnly?: boolean;
}

/** Sub-seção de um item expansível (Configurações → `?sec=`). */
export interface NavSubItem {
    sec: string;
    label: string;
    /** Equipe: aparece com QUALQUER uma destas permissões. */
    perm?: readonly Permission[];
}

/** Acesso exigido por uma rota da área administrativa (menu e guarda de rota usam a MESMA tabela). */
export interface StaffAccess {
    /** QUALQUER uma destas permissões (ausente = toda a equipe). */
    perm?: readonly Permission[];
    /** Só o papel ADMIN. */
    adminOnly?: boolean;
}

/**
 * Rotas da área administrativa → acesso exigido. Fonte única para o menu (ADMIN_NAV) e para os
 * guardas de rota (App.tsx → StaffRoute). As rotas de detalhe herdam o acesso da lista
 * (/admin/clients/:id = clientes.ver; /admin/contracts/:id = contratos.ver).
 * `/calendar` vale para a equipe (o cliente usa a mesma rota com a agenda dele).
 */
export const STAFF_ROUTE_ACCESS = {
    '/dashboard': {},
    '/calendar': { perm: ['agendamentos.ver', 'hoje.ver'] },
    '/admin/today': { perm: ['hoje.ver'] },
    '/admin/bookings': { perm: ['agendamentos.ver'] },
    '/admin/clients': { perm: ['clientes.ver'] },
    '/admin/contracts': { perm: ['contratos.ver'] },
    '/admin/finance': { perm: ['financeiro.ver'] },
    '/admin/cupons': { perm: ['cupons.ver'] },
    '/admin/reports': { perm: ['relatorios.ver'] },
    // A página de avisos abre com QUALQUER uma das duas (D2).
    '/admin/notificacoes': { perm: ['avisos.enviar', 'avisos.modelos'] },
    // Configurações aparece com qualquer caixa config.* (ADMIN tem todas, inclusive E-mail/Integrações).
    '/admin/configuracoes': { perm: CONFIG_PERMISSION_KEYS },
    '/admin/equipe': { adminOnly: true },
} as const satisfies Record<string, StaffAccess>;

export type StaffRoutePath = keyof typeof STAFF_ROUTE_ACCESS;

/** A equipe pode abrir algo com este acesso? (`can` = usePermission().can) */
export function canAccess(access: StaffAccess | undefined, can: (key: Permission) => boolean, isAdmin: boolean): boolean {
    if (!access) return true;
    if (access.adminOnly && !isAdmin) return false;
    if (access.perm && access.perm.length > 0 && !access.perm.some(can)) return false;
    return true;
}

/**
 * Menu da equipe filtrado por permissão: tira os itens sem acesso e, nos expansíveis, as
 * sub-seções sem acesso (o pai some se não sobrar nenhuma). Devolve objetos novos (não muta ADMIN_NAV).
 */
export function filterNav(items: readonly NavItem[], can: (key: Permission) => boolean, isAdmin: boolean): NavItem[] {
    const out: NavItem[] = [];
    for (const item of items) {
        if (!canAccess(item, can, isAdmin)) continue;
        if (item.subItems) {
            const subItems = item.subItems.filter(si => canAccess(si, can, isAdmin));
            if (subItems.length === 0) continue;
            out.push({ ...item, subItems });
        } else {
            out.push(item);
        }
    }
    return out;
}

/** Máximo de slots da barra inferior (mobile), contando a aba "Mais". */
export const MOBILE_BAR_SLOTS = 5;

/** Item ativo na rota exata OU em rota aninhada (ex.: /admin/contracts/:id → Contratos). */
export function isNavItemActive(pathname: string, to: string): boolean {
    return pathname === to || pathname.startsWith(`${to}/`);
}

/**
 * Divide a lista entre a barra inferior e o sheet "Mais": se cabe em
 * MOBILE_BAR_SLOTS, tudo fica na barra; senão, os `mobilePrimary` (até 4)
 * ficam na barra e o resto vai para o "Mais". Com o menu filtrado por permissão
 * podem sobrar menos de 4 `mobilePrimary`: as vagas livres são preenchidas pelos
 * próximos itens, na ordem do menu (a barra nunca fica só com "Início" + "Mais").
 */
export function splitMobileNav(items: NavItem[]): { primary: NavItem[]; overflow: NavItem[] } {
    if (items.length <= MOBILE_BAR_SLOTS) return { primary: items, overflow: [] };
    const slots = MOBILE_BAR_SLOTS - 1;
    const chosen = new Set(items.filter(i => i.mobilePrimary).slice(0, slots));
    for (const item of items) {
        if (chosen.size >= slots) break;
        chosen.add(item);
    }
    const primary = items.filter(i => chosen.has(i));
    return { primary, overflow: items.filter(i => !chosen.has(i)) };
}

/**
 * Sub-sections of the Settings page, mirrored from AdminSettingsPage's SECTIONS (mesma ordem; inclui
 * Ambiente e Gravações, que antes só abriam pela URL). Cada uma aparece com a permissão da seção
 * (constants/permissions.ts → SETTINGS_SECTION_PERMISSIONS; E-mail e Integrações = só ADMIN).
 */
const settingsSub = (sec: SettingsSectionId, label: string): NavSubItem => ({ sec, label, perm: [SETTINGS_SECTION_PERMISSIONS[sec]] });
export const SETTINGS_SUBITEMS: NavSubItem[] = [
    settingsSub('gerais', 'Gerais'),
    settingsSub('horarios', 'Horários & Grade'),
    settingsSub('financeiro', 'Preços e regras'),
    settingsSub('politicas', 'Políticas'),
    settingsSub('servicos', 'Serviços'),
    settingsSub('pagamentos', 'Formas de pagamento'),
    settingsSub('ambiente', 'Ambiente'),
    settingsSub('gravacoes', 'Gravações'),
    settingsSub('email', 'E-mail'),
    settingsSub('integracoes', 'Integrações'),
];

export const CLIENT_NAV: NavItem[] = [
    { to: '/dashboard', label: 'Dashboard', shortLabel: 'Início', icon: LayoutDashboard },
    { to: '/calendar', label: 'Agenda', icon: CalendarDays },
    { to: '/minhas-gravacoes', label: 'Minhas Gravações', shortLabel: 'Gravações', icon: Clapperboard },
    { to: '/meus-contratos', label: 'Meus Contratos', shortLabel: 'Contratos', icon: FileText },
    { to: '/meus-pagamentos', label: 'Pagamentos', shortLabel: 'Pagar', icon: Wallet },
];

/**
 * Menu da EQUIPE (ADMIN e COLABORADOR). Sempre consumido via `filterNav(ADMIN_NAV, can, isAdmin)`:
 * o ADMIN vê tudo; o colaborador só o que as permissões dele abrem (o Painel aparece para todos).
 */
export const ADMIN_NAV: NavItem[] = [
    { to: '/dashboard', label: 'Dashboard', shortLabel: 'Início', icon: LayoutDashboard, mobilePrimary: true, ...STAFF_ROUTE_ACCESS['/dashboard'] },
    { to: '/calendar', label: 'Agenda', icon: CalendarDays, mobilePrimary: true, ...STAFF_ROUTE_ACCESS['/calendar'] },

    { to: '/admin/today', label: 'Hoje', icon: MapPin, section: 'Operação', mobilePrimary: true, ...STAFF_ROUTE_ACCESS['/admin/today'] },
    { to: '/admin/bookings', label: 'Agendamentos', shortLabel: 'Sessões', icon: ClipboardList, mobileIcon: Clapperboard, section: 'Operação', mobilePrimary: true, ...STAFF_ROUTE_ACCESS['/admin/bookings'] },
    { to: '/admin/clients', label: 'Clientes', icon: Users, section: 'Operação', ...STAFF_ROUTE_ACCESS['/admin/clients'] },

    { to: '/admin/contracts', label: 'Contratos', icon: FileSignature, mobileIcon: FileText, section: 'Gestão', ...STAFF_ROUTE_ACCESS['/admin/contracts'] },
    { to: '/admin/finance', label: 'Financeiro', icon: CreditCard, section: 'Gestão', ...STAFF_ROUTE_ACCESS['/admin/finance'] },
    { to: '/admin/cupons', label: 'Cupons', icon: TicketPercent, section: 'Gestão', ...STAFF_ROUTE_ACCESS['/admin/cupons'] },
    { to: '/admin/reports', label: 'Relatórios', icon: BarChart3, section: 'Gestão', ...STAFF_ROUTE_ACCESS['/admin/reports'] },

    { to: '/admin/notificacoes', label: 'Avisos', icon: BellRing, section: 'Sistema', ...STAFF_ROUTE_ACCESS['/admin/notificacoes'] },
    { to: '/admin/configuracoes', label: 'Configurações', shortLabel: 'Config', icon: Settings, section: 'Sistema', subItems: SETTINGS_SUBITEMS, ...STAFF_ROUTE_ACCESS['/admin/configuracoes'] },
    { to: '/admin/equipe', label: 'Equipe', icon: ShieldCheck, section: 'Sistema', ...STAFF_ROUTE_ACCESS['/admin/equipe'] },
];
