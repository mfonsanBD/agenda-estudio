import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Check, CheckCheck, CheckCircle } from 'lucide-react';
import { usePermission } from '../hooks/usePermission';
import { useNotifications } from '../hooks/useNotifications';
import { resolveNotifMeta, formatTimeAgo } from '../utils/notificationMeta';
import { NotificationItem } from '../api/client';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import HeroAmbient from '../components/client/HeroAmbient';
import { DashboardSkeleton } from '../components/ui/SkeletonLoader';
import Tooltip from '../components/ui/Tooltip';

type SeverityFilter = 'all' | 'critical' | 'warning' | 'info';

const FILTERS: { key: SeverityFilter; label: string }[] = [
    { key: 'all', label: 'Todas' },
    { key: 'critical', label: 'Críticas' },
    { key: 'warning', label: 'Avisos' },
    { key: 'info', label: 'Info' },
];

/** "Hoje" / "Ontem" / "12/07/2026" for grouping — local calendar day. */
function dayLabel(iso: string): string {
    const d = new Date(iso);
    const today = new Date();
    const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diffDays = Math.round((startOf(today) - startOf(d)) / 86400000);
    if (diffDays <= 0) return 'Hoje';
    if (diffDays === 1) return 'Ontem';
    return d.toLocaleDateString('pt-BR');
}

export default function NotificationsPage() {
    const navigate = useNavigate();
    // Equipe (ADMIN ou COLABORADOR) vê a página no visual da área administrativa.
    const { isStaff } = usePermission();
    const { notifications, summary, loading, markRead, markAllRead } = useNotifications();
    const [filter, setFilter] = useState<SeverityFilter>('all');

    const filtered = useMemo(
        () => notifications.filter(n => filter === 'all' || n.severity === filter),
        [notifications, filter],
    );

    // Group by day (items keep the incoming severity/unread order within a group),
    // then order the groups newest-day-first — the API sorts by severity/unread, not
    // date, so insertion order alone could render "Ontem" above "Hoje".
    const groups = useMemo(() => {
        const map = new Map<string, NotificationItem[]>();
        for (const n of filtered) {
            const label = dayLabel(n.createdAt);
            (map.get(label) ?? map.set(label, []).get(label)!).push(n);
        }
        const dayStart = (iso: string) => { const d = new Date(iso); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
        return Array.from(map.entries()).sort((a, b) => dayStart(b[1][0].createdAt) - dayStart(a[1][0].createdAt));
    }, [filtered]);

    const onItemClick = (n: NotificationItem) => {
        if (!n.read) markRead(n.id);
        if (n.actionUrl) navigate(n.actionUrl);
    };

    if (loading) return <DashboardSkeleton />;

    return (
        <div>
            {isStaff ? (
                <AdminPageHeader
                    icon={Bell}
                    title="Notificações"
                    subtitle="Alertas do sistema e da operação"
                    actions={summary.unread > 0 ? (
                        <button className="btn-admin-ghost" onClick={markAllRead}>
                            <CheckCheck size={16} /> Ler todas
                        </button>
                    ) : undefined}
                />
            ) : (
                <div className="client-hero client-hero--default animate-card-enter">
                    <HeroAmbient variant="inicio" />
                    <div className="client-hero__header">
                        <div className={`client-hero__icon-wrapper ${summary.critical > 0 ? 'client-hero__icon-wrapper--danger' : 'client-hero__icon-wrapper--cyan'}`}>
                            <Bell size={22} />
                        </div>
                        <div>
                            <h2 className="client-hero__greeting">Notificações</h2>
                            <p className="client-hero__message">
                                {summary.unread > 0 ? `Você tem ${summary.unread} não lida${summary.unread !== 1 ? 's' : ''}` : 'Tudo em dia por aqui'}
                            </p>
                        </div>
                    </div>
                    {summary.unread > 0 && (
                        <div className="client-cta-stack">
                            <button className="btn btn-secondary" onClick={markAllRead}>
                                <CheckCheck size={16} /> Marcar todas como lidas
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Severity filter */}
            <div className="notif-filter-chips" role="tablist" aria-label="Filtrar por severidade">
                {FILTERS.map(f => (
                    <button
                        key={f.key}
                        role="tab"
                        aria-selected={filter === f.key}
                        className={`notif-filter-chip ${filter === f.key ? 'notif-filter-chip--active' : ''}`}
                        onClick={() => setFilter(f.key)}
                    >
                        {f.label}
                    </button>
                ))}
            </div>

            {filtered.length === 0 ? (
                <div className={isStaff ? 'admin-empty' : 'client-empty'}>
                    <CheckCircle size={40} className={isStaff ? 'admin-empty__icon' : 'client-empty__icon'} />
                    <div className={isStaff ? 'admin-empty__title' : 'client-empty__text'}>
                        {filter === 'all' ? 'Nenhuma notificação' : 'Nada neste filtro'}
                    </div>
                </div>
            ) : (
                groups.map(([label, items]) => (
                    <div key={label} className="notif-group">
                        <div className="notif-group__label">{label}</div>
                        {items.map(n => {
                            const { Icon, tone } = resolveNotifMeta(n.type, n.severity);
                            return (
                                <button
                                    key={n.id}
                                    type="button"
                                    className={`notif-item notif-tone--${tone} ${n.read ? 'notif-item--read' : 'notif-item--unread'}`}
                                    onClick={() => onItemClick(n)}
                                >
                                    <span className="notif-item__icon"><Icon size={18} aria-hidden="true" /></span>
                                    <span className="notif-item__body">
                                        <span className="notif-item__title">{n.title}</span>
                                        <span className="notif-item__msg">{n.message}</span>
                                        {n.source === 'persisted' && n.createdAt && (
                                            <span className="notif-item__time">{formatTimeAgo(n.createdAt)}</span>
                                        )}
                                    </span>
                                    {!n.read && (
                                        <Tooltip content="Marcar como lida" describe={false}>
                                            <span
                                                role="button" tabIndex={0}
                                                className="notif-item__read-btn"
                                                onClick={(e) => { e.stopPropagation(); markRead(n.id); }}
                                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); markRead(n.id); } }}
                                                aria-label="Marcar como lida"
                                            ><Check size={16} /></span>
                                        </Tooltip>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                ))
            )}
        </div>
    );
}
