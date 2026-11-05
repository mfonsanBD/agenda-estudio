// ─── Admin metadata — single source of truth ────────────
// Consolidates the status/tier/type maps that were duplicated (and divergent)
// inline across AdminBookingsPage, AdminContractsPage, AdminFinancePage,
// AdminReportsPage, AdminTodayPage and AdminClientsPage. Colors reconciled to a
// single canonical value per concept; emoji replaced by lucide icons.
import {
    Building2, Mic, Star,
    Clock, CheckCircle, CheckCircle2, Ban, XCircle, AlertCircle,
    Lock, Pause, Undo2, ShieldCheck, Pin, RefreshCw, Ticket, Circle, Hourglass,
    Sparkles, Wand2, CalendarClock, CalendarCheck, CalendarX, UserCog,
    type LucideIcon,
} from 'lucide-react';

export interface MetaEntry {
    label: string;
    color: string;
    bg: string;
    icon: LucideIcon;
}

/** Contract tiers (used by bookings, today, reports, contracts). */
export const TIER_META: Record<string, MetaEntry> = {
    COMERCIAL: { label: 'Comercial', color: '#10b981', bg: 'rgba(16,185,129,0.12)', icon: Building2 },
    AUDIENCIA: { label: 'Audiência', color: '#2dd4bf', bg: 'rgba(45,212,191,0.12)', icon: Mic },
    SABADO:    { label: 'Sábado',    color: '#fbbf24', bg: 'rgba(245,158,11,0.12)', icon: Star },
};

/** Booking statuses (cancelled reconciled to neutral gray, matching StatusBadge). */
export const BOOKING_STATUS_META: Record<string, MetaEntry> = {
    HELD:          { label: 'Em espera',     color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', icon: Hourglass },
    RESERVED:      { label: 'Reservado',     color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', icon: Clock },
    CONFIRMED:     { label: 'Confirmado',    color: '#3b82f6', bg: 'rgba(59,130,246,0.12)', icon: CheckCircle },
    COMPLETED:     { label: 'Concluído',     color: '#10b981', bg: 'rgba(16,185,129,0.12)', icon: CheckCircle2 },
    CANCELLED:     { label: 'Cancelado',     color: '#6b7280', bg: 'rgba(107,114,128,0.12)', icon: Ban },
    FALTA:         { label: 'Falta',         color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  icon: XCircle },
    NAO_REALIZADO: { label: 'Não Realizado', color: '#14b8a6', bg: 'rgba(20,184,166,0.12)', icon: AlertCircle },
};

/** Contract lifecycle statuses.
 *  COMPLETED ("Concluído", D6): tudo consumido, nada pendente — teal da marca (--accent-text),
 *  distinto do verde de ACTIVE e do teal-500 de PAUSED. AWAITING_PAYMENT: pendência → âmbar. */
export const CONTRACT_STATUS_META: Record<string, MetaEntry> = {
    ACTIVE:               { label: 'Ativo',             color: '#10b981', bg: 'rgba(16,185,129,0.12)',  icon: CheckCircle2 },
    AWAITING_PAYMENT:     { label: 'Aguard. pagamento', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  icon: Hourglass },
    COMPLETED:            { label: 'Concluído',         color: '#2FA8C2', bg: 'rgba(47,168,194,0.12)',  icon: CheckCircle2 },
    EXPIRED:              { label: 'Expirado',          color: '#6b7280', bg: 'rgba(107,114,128,0.12)', icon: Lock },
    CANCELLED:            { label: 'Cancelado',         color: '#ef4444', bg: 'rgba(239,68,68,0.12)',   icon: Ban },
    PENDING_CANCELLATION: { label: 'Pend. Cancel',      color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  icon: Clock },
    PAUSED:               { label: 'Pausado',           color: '#14b8a6', bg: 'rgba(20,184,166,0.12)',  icon: Pause },
};

/** Payment statuses — FONTE ÚNICA dos rótulos de status de PAGAMENTO (Payment.status).
 *  Nunca usar BOOKING_STATUS_META para parcelas (mostrava "PAID" cru). */
export const PAYMENT_STATUS_META: Record<string, MetaEntry> = {
    PAID:      { label: 'Pago',      color: '#10b981', bg: 'rgba(16,185,129,0.12)', icon: CheckCircle2 },
    PENDING:   { label: 'Pendente',  color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', icon: Clock },
    FAILED:    { label: 'Falhou',    color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  icon: XCircle },
    REFUNDED:  { label: 'Estornado', color: '#14b8a6', bg: 'rgba(20,184,166,0.12)', icon: Undo2 },
    CANCELLED: { label: 'Cancelado', color: '#6b7280', bg: 'rgba(107,114,128,0.12)', icon: Ban },
};

/** Janela de remarcação do avulso (Booking.makeupStatus — D4/D5). */
export const MAKEUP_STATUS_META: Record<string, MetaEntry> = {
    OPEN:    { label: 'Remarcação liberada', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  icon: CalendarClock },
    USED:    { label: 'Remarcada',           color: '#3b82f6', bg: 'rgba(59,130,246,0.12)',  icon: CalendarCheck },
    EXPIRED: { label: 'Prazo encerrado',     color: '#6b7280', bg: 'rgba(107,114,128,0.12)', icon: CalendarX },
};

/** Client/contract "type" (role-derived ADMIN + the 5 ContractType values).
 *  Used for the client-type badge (AdminClientsPage) and contract-type badges. */
export const USER_TYPE_META: Record<string, MetaEntry> = {
    ADMIN:   { label: 'Admin',         color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  icon: ShieldCheck },
    FIXO:    { label: 'Fixo',          color: '#818cf8', bg: 'rgba(129,140,248,0.12)', icon: Pin },
    FLEX:    { label: 'Flex',          color: '#34d399', bg: 'rgba(52,211,153,0.12)',  icon: RefreshCw },
    AVULSO:  { label: 'Avulso',        color: '#f97316', bg: 'rgba(249,115,22,0.12)',  icon: Ticket },
    SERVICO: { label: 'Serviço',       color: '#22d3ee', bg: 'rgba(34,211,238,0.12)',  icon: Sparkles },
    CUSTOM:  { label: 'Personalizado', color: '#a78bfa', bg: 'rgba(167,139,250,0.12)', icon: Wand2 },
};

/** Contract type → label/color/icon (FIXO/FLEX/AVULSO/SERVICO/CUSTOM).
 *  Alias of USER_TYPE_META minus ADMIN — use for contract-type badges so AVULSO
 *  is never collapsed into "Flex". */
export const CONTRACT_TYPE_META = USER_TYPE_META;

/** Equipe (tela `/admin/equipe`): tipo de acesso do membro (StaffMember.role).
 *  Administrador = âmbar (mesmo tom do antigo selo "Admin"); Colaborador = teal da marca (--accent-text). */
export const STAFF_ROLE_META: Record<string, MetaEntry> = {
    ADMIN:       { label: 'Administrador', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', icon: ShieldCheck },
    COLABORADOR: { label: 'Colaborador',   color: '#2FA8C2', bg: 'rgba(47,168,194,0.12)', icon: UserCog },
};

/** Equipe: situação do acesso (StaffMember.active → 'ACTIVE' | 'INACTIVE'). Desativado = cinza neutro. */
export const STAFF_STATUS_META: Record<string, MetaEntry> = {
    ACTIVE:   { label: 'Ativo',      color: '#10b981', bg: 'rgba(16,185,129,0.12)',  icon: CheckCircle2 },
    INACTIVE: { label: 'Desativado', color: '#6b7280', bg: 'rgba(107,114,128,0.12)', icon: Ban },
};

const FALLBACK: MetaEntry = { label: '—', color: 'var(--text-muted)', bg: 'rgba(148,163,184,0.12)', icon: Circle };

/** Mapas de STATUS consultados (nesta ordem) quando a chave não está no mapa pedido. */
const STATUS_MAPS: Record<string, MetaEntry>[] = [BOOKING_STATUS_META, CONTRACT_STATUS_META, PAYMENT_STATUS_META];

/** Procura um status em todos os mapas de status (reserva → contrato → pagamento).
 *  Devolve undefined se nenhum conhecer a chave. */
export function findStatusMeta(key: string | null | undefined): MetaEntry | undefined {
    if (!key) return undefined;
    for (const m of STATUS_MAPS) if (m[key]) return m[key];
    return undefined;
}

/** Rótulo em português de qualquer status conhecido (reserva/contrato/pagamento); '—' se desconhecido.
 *  Nunca devolve a chave crua em inglês. */
export function getStatusLabel(key: string | null | undefined): string {
    return findStatusMeta(key)?.label ?? FALLBACK.label;
}

/** Safe lookup: returns the entry; if the key is missing from `map` but is a known STATUS in
 *  another status map (e.g. a payment status looked up in BOOKING_STATUS_META), returns that
 *  entry instead of the raw key; otherwise a neutral fallback (label defaults to the key). */
export function getMeta(map: Record<string, MetaEntry>, key: string | null | undefined): MetaEntry {
    if (key && map[key]) return map[key];
    const cross = findStatusMeta(key);
    if (cross) return cross;
    return { ...FALLBACK, label: key || FALLBACK.label };
}
