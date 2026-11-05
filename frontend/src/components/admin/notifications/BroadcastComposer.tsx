import { useState, useEffect, useId } from 'react';
import { notificationsAdminApi, usersApi, UserSummary, BroadcastBatch, ApiError } from '../../../api/client';
import { useUI } from '../../../context/UIContext';
import { getErrorMessage } from '../../../utils/errors';
import ToggleSwitch from '../../ui/ToggleSwitch';
import BrandLoader from '../../ui/BrandLoader';
import { Megaphone, Send, Search, Users, User as UserIcon } from 'lucide-react';

type Target = 'all' | 'specific';

export default function BroadcastComposer() {
    const uid = useId();
    const { showToast, showConfirm } = useUI();
    const [title, setTitle] = useState('');
    const [message, setMessage] = useState('');
    const [severity, setSeverity] = useState<'critical' | 'warning' | 'info'>('info');
    const [sendPush, setSendPush] = useState(true);
    const [target, setTarget] = useState<Target>('all');
    const [sending, setSending] = useState(false);

    // Client picker (lazy)
    const [clients, setClients] = useState<UserSummary[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [search, setSearch] = useState('');
    const [selected, setSelected] = useState<UserSummary | null>(null);
    // Falha ao buscar os clientes: o loading (E5) some e aparece "Tentar de novo" (nunca loader eterno).
    const [clientsFailed, setClientsFailed] = useState(false);
    const [clientsRetry, setClientsRetry] = useState(0);
    useEffect(() => {
        if (target !== 'specific' || loaded) return;
        setClientsFailed(false);
        usersApi.getAll('CLIENTE').then(r => { setClients(r.users); setLoaded(true); }).catch(() => setClientsFailed(true));
    }, [target, loaded, clientsRetry]);

    // History
    const [history, setHistory] = useState<BroadcastBatch[]>([]);
    // Só a 1ª carga mostra o loading de marca (E5); a recarga depois de um envio é silenciosa.
    const [historyLoaded, setHistoryLoaded] = useState(false);
    const loadHistory = () => notificationsAdminApi.getBroadcasts()
        .then(r => setHistory(r.broadcasts))
        .catch(() => {})
        .finally(() => setHistoryLoaded(true));
    useEffect(() => { loadHistory(); }, []);

    const canSend = title.trim().length >= 3 && message.trim().length >= 3 && (target === 'all' || !!selected);

    const filteredClients = clients.filter(c =>
        !search || c.name.toLowerCase().includes(search.toLowerCase()) || (c.email || '').toLowerCase().includes(search.toLowerCase())
    ).slice(0, 30);

    const handleSend = () => {
        // Snapshot the target now — onConfirm runs on a later tick, by when `selected`
        // could have been cleared (a re-render would then crash on selected!.id).
        const targetPayload: 'all' | string[] = target === 'all' ? 'all' : [selected!.id];
        const who = target === 'all' ? 'TODOS os clientes' : selected!.name;
        showConfirm({
            title: 'Enviar aviso?',
            message: `"${title.trim()}" será enviado para ${who}.`,
            confirmLabel: 'Enviar',
            onConfirm: async () => {
                setSending(true);
                try {
                    const res = await notificationsAdminApi.broadcast({
                        title: title.trim(),
                        message: message.trim(),
                        severity,
                        target: targetPayload,
                        sendPush,
                    });
                    showToast(`Enviado para ${res.sent} cliente(s)${res.skipped ? ` (${res.skipped} com "só essenciais" ignorados)` : ''}.`);
                    setTitle(''); setMessage(''); setSelected(null);
                    loadHistory();
                } catch (err) {
                    // 400 INVALID_RECIPIENTS (F5): o destinatário escolhido não é (mais) um cliente ativo no app
                    // (excluído, ou a lista estava velha) — nada foi enviado. Limpa a escolha e recarrega a lista.
                    if (err instanceof ApiError && err.code === 'INVALID_RECIPIENTS') {
                        setSelected(null);
                        setLoaded(false);
                        setClientsRetry(n => n + 1);
                        showToast({ message: `${getErrorMessage(err)} Nada foi enviado.`, type: 'error' });
                        return;
                    }
                    showToast({ message: getErrorMessage(err), type: 'error' });
                } finally { setSending(false); }
            },
        });
    };

    return (
        <div className="notif-broadcast">
            <div className="notif-broadcast__form card">
                <h3 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                    <Megaphone size={18} style={{ color: 'var(--accent-primary)' }} /> Novo aviso
                </h3>

                <div className="form-group">
                    <label className="form-label" htmlFor={`${uid}-titulo`}>Título</label>
                    <input id={`${uid}-titulo`} className="form-input" value={title} onChange={e => setTitle(e.target.value)} maxLength={120} placeholder="Ex.: Fechamento no feriado" />
                </div>
                <div className="form-group">
                    <label className="form-label" htmlFor={`${uid}-mensagem`}>Mensagem</label>
                    <textarea id={`${uid}-mensagem`} className="form-input" rows={3} value={message} onChange={e => setMessage(e.target.value)} maxLength={1000} style={{ resize: 'vertical' }} placeholder="Escreva o aviso…" />
                </div>

                <div className="form-group">
                    <label className="form-label">Severidade</label>
                    <div className="notif-seg">
                        {(['info', 'warning', 'critical'] as const).map(s => (
                            <button key={s} type="button" className={`notif-seg__btn ${severity === s ? 'notif-seg__btn--active' : ''}`} onClick={() => setSeverity(s)}>
                                {s === 'critical' ? 'Crítica' : s === 'warning' ? 'Aviso' : 'Info'}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="form-group">
                    <label className="form-label">Destino</label>
                    <div className="notif-seg">
                        <button type="button" className={`notif-seg__btn ${target === 'all' ? 'notif-seg__btn--active' : ''}`} onClick={() => setTarget('all')}>
                            <Users size={14} /> Todos os clientes
                        </button>
                        <button type="button" className={`notif-seg__btn ${target === 'specific' ? 'notif-seg__btn--active' : ''}`} onClick={() => setTarget('specific')}>
                            <UserIcon size={14} /> Um cliente
                        </button>
                    </div>
                </div>

                {target === 'specific' && (
                    <div className="form-group">
                        {selected ? (
                            <div className="notif-broadcast__selected">
                                <span>{selected.name}</span>
                                <button className="btn-admin-ghost btn-sm" onClick={() => setSelected(null)}>Trocar</button>
                            </div>
                        ) : (
                            <>
                                <div className="notif-broadcast__search">
                                    <Search size={15} />
                                    <input className="form-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar cliente por nome ou e-mail…" style={{ border: 'none', background: 'transparent' }} />
                                </div>
                                <div className="notif-broadcast__client-list">
                                    {!loaded && !clientsFailed && (
                                        <div style={{ padding: 8 }}><BrandLoader size="inline" label="Carregando clientes…" /></div>
                                    )}
                                    {!loaded && clientsFailed && (
                                        <div className="notif-template-row__hint" role="alert" style={{ padding: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                            Não foi possível carregar os clientes.
                                            <button type="button" className="btn-admin-ghost btn-admin-ghost--compact" onClick={() => setClientsRetry(n => n + 1)}>Tentar de novo</button>
                                        </div>
                                    )}
                                    {filteredClients.map(c => (
                                        <button key={c.id} type="button" className="notif-broadcast__client" onClick={() => setSelected(c)}>
                                            <span>{c.name}</span>
                                            <span className="notif-broadcast__client-email">{c.email}</span>
                                        </button>
                                    ))}
                                    {loaded && filteredClients.length === 0 && <div className="notif-template-row__hint" style={{ padding: 8 }}>Nenhum cliente encontrado.</div>}
                                </div>
                            </>
                        )}
                    </div>
                )}

                <div className="notif-template-row">
                    <div>
                        <div className="notif-template-row__label">Enviar push</div>
                        <div className="notif-template-row__hint">Além do sino, envia notificação no dispositivo.</div>
                    </div>
                    <ToggleSwitch checked={sendPush} onChange={setSendPush} label={sendPush ? 'Sim' : 'Não'} />
                </div>

                <button className="btn btn-primary" onClick={handleSend} disabled={!canSend || sending} style={{ width: '100%', marginTop: 8, gap: 8 }}>
                    <Send size={16} /> {sending ? 'Enviando…' : 'Enviar aviso'}
                </button>
            </div>

            {!historyLoaded && (
                <div className="notif-broadcast__history">
                    <BrandLoader size="inline" label="Carregando avisos enviados…" />
                </div>
            )}

            {history.length > 0 && (
                <div className="notif-broadcast__history">
                    <h3 className="notif-group__label">Enviados recentemente</h3>
                    {history.map(h => (
                        <div key={h.batchId} className="notif-broadcast__hist-item card">
                            <div className="notif-broadcast__hist-title">{h.title}</div>
                            <div className="notif-broadcast__hist-msg">{h.message}</div>
                            <div className="notif-broadcast__hist-meta">
                                {h.recipients} destinatário(s) · {h.readCount} lida(s) · {new Date(h.createdAt).toLocaleDateString('pt-BR')}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
