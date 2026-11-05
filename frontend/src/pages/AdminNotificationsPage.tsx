import { useState, useEffect, useMemo } from 'react';
import { notificationsAdminApi, NotificationEventDef } from '../api/client';
import { useUI } from '../context/UIContext';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import ToggleSwitch from '../components/ui/ToggleSwitch';
import EventTemplateModal from '../components/admin/notifications/EventTemplateModal';
import BroadcastComposer from '../components/admin/notifications/BroadcastComposer';
import { resolveNotifMeta } from '../utils/notificationMeta';
import { Bell, Pencil, Megaphone, SlidersHorizontal } from 'lucide-react';
import BrandLoader from '../components/ui/BrandLoader';
import { usePermission } from '../hooks/usePermission';

const GROUP_LABELS: Record<string, string> = {
    pagamentos: 'Pagamentos',
    sessoes: 'Sessões',
    contratos: 'Contratos',
    creditos: 'Créditos FLEX',
    // Avisos para a equipe (rótulos "Equipe — …" no catálogo; só o ADMIN os edita — o colaborador nem os recebe).
    admin: 'Equipe',
};

export default function AdminNotificationsPage() {
    const { showToast } = useUI();
    // Equipe (D2): a página abre com avisos.enviar OU avisos.modelos (guarda da rota). Aba "Eventos"
    // (textos das mensagens automáticas, ligar/desligar, testar) = avisos.modelos; "Enviar aviso" = avisos.enviar.
    const { can } = usePermission();
    const canTemplates = can('avisos.modelos');
    const canBroadcast = can('avisos.enviar');
    const [tabChoice, setTab] = useState<'eventos' | 'broadcast'>(canTemplates ? 'eventos' : 'broadcast');
    // A aba exibida é sempre uma permitida (a permissão pode mudar com a tela aberta).
    const tab: 'eventos' | 'broadcast' = !canTemplates ? 'broadcast' : !canBroadcast ? 'eventos' : tabChoice;
    const [events, setEvents] = useState<NotificationEventDef[]>([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState<NotificationEventDef | null>(null);

    const load = () => notificationsAdminApi.getEvents().then(r => { setEvents(r.events); setLoading(false); }).catch(() => setLoading(false));
    // Os modelos só carregam para quem pode editá-los (quem só envia avisos não precisa da lista).
    useEffect(() => { if (canTemplates) load(); }, [canTemplates]);

    const grouped = useMemo(() => {
        const map = new Map<string, NotificationEventDef[]>();
        for (const e of events) (map.get(e.group) ?? map.set(e.group, []).get(e.group)!).push(e);
        return Array.from(map.entries());
    }, [events]);

    const toggleEnabled = async (e: NotificationEventDef, enabled: boolean) => {
        // Optimistic
        setEvents(prev => prev.map(x => x.eventKey === e.eventKey ? { ...x, effective: { ...x.effective, enabled }, isCustomized: true } : x));
        try {
            await notificationsAdminApi.updateTemplate(e.eventKey, { enabled });
        } catch {
            showToast({ message: 'Não foi possível salvar.', type: 'error' });
            load();
        }
    };

    return (
        <div>
            {/* EQ-REQ-03: "Avisos" = o módulo do catálogo ("Avisos e modelos de mensagem"); "Notificações"
                é a página do sino (/notificacoes), que toda a equipe tem. */}
            <AdminPageHeader
                icon={Bell}
                title="Avisos"
                subtitle={canTemplates && canBroadcast
                    ? 'Edite os textos por evento e envie avisos aos clientes'
                    : canTemplates
                        ? 'Edite os textos das mensagens automáticas que os clientes recebem'
                        : 'Envie avisos aos clientes pelo sino e pelo push'}
            />

            {/* Abas só quando a pessoa tem as duas permissões; com uma só, a página mostra direto o conteúdo dela. */}
            {canTemplates && canBroadcast && (
                <div className="payments-tabs" role="tablist" style={{ marginBottom: 20 }}>
                    <button role="tab" aria-selected={tab === 'eventos'} className={`payments-tab ${tab === 'eventos' ? 'payments-tab--active' : ''}`} onClick={() => setTab('eventos')}>
                        <SlidersHorizontal size={15} /> <span className="payments-tab__label">Eventos</span>
                    </button>
                    <button role="tab" aria-selected={tab === 'broadcast'} className={`payments-tab ${tab === 'broadcast' ? 'payments-tab--active' : ''}`} onClick={() => setTab('broadcast')}>
                        <Megaphone size={15} /> <span className="payments-tab__label">Enviar aviso</span>
                    </button>
                </div>
            )}

            {tab === 'broadcast' ? (
                <BroadcastComposer />
            ) : loading ? (
                <BrandLoader size="section" label="Carregando eventos…" />
            ) : (
                grouped.map(([group, list]) => (
                    <div key={group} className="notif-event-group">
                        <h3 className="notif-group__label">{GROUP_LABELS[group] || group}</h3>
                        <div className="notif-event-grid">
                            {list.map(e => {
                                const { Icon, tone } = resolveNotifMeta(e.type, e.effective.severity === 'dynamic' ? 'warning' : e.effective.severity as 'critical' | 'warning' | 'info');
                                return (
                                    <div key={e.eventKey} className={`notif-event-card notif-tone--${tone} ${!e.effective.enabled ? 'notif-event-card--off' : ''}`}>
                                        <div className="notif-event-card__head">
                                            <span className="notif-item__icon"><Icon size={16} aria-hidden="true" /></span>
                                            <div className="notif-event-card__titles">
                                                <div className="notif-event-card__label">{e.label}</div>
                                                <div className="notif-event-card__desc">{e.description}</div>
                                            </div>
                                            <ToggleSwitch checked={e.effective.enabled} onChange={(v) => toggleEnabled(e, v)} label="" />
                                        </div>
                                        <div className="notif-event-card__preview">
                                            <div className="notif-event-card__prev-title">{e.effective.title}</div>
                                            <div className="notif-event-card__prev-msg">{e.effective.message}</div>
                                        </div>
                                        <div className="notif-event-card__foot">
                                            <div className="notif-event-card__badges">
                                                {e.effective.pushEnabled && <span className="notif-event-badge">push</span>}
                                                {e.isCustomized && <span className="notif-event-badge notif-event-badge--custom">personalizado</span>}
                                            </div>
                                            <button className="btn-admin-ghost btn-sm" onClick={() => setEditing(e)}>
                                                <Pencil size={14} /> Editar
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))
            )}

            {canTemplates && editing && (
                <EventTemplateModal
                    event={editing}
                    onClose={() => setEditing(null)}
                    onSaved={() => { setEditing(null); load(); }}
                />
            )}
        </div>
    );
}
