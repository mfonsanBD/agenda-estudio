import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, CheckCircle2, UserMinus, Inbox, Puzzle, Search, FilterX, X, Pencil, Trash2, Loader2 } from 'lucide-react';
import { UserSummary } from '../api/client';
import { useAdminClients } from '../hooks/useAdminClients';
import { useDeleteClient } from '../hooks/useDeleteClient';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import CreateClientModal from '../components/admin/clients/CreateClientModal';
import EditClientModal from '../components/admin/clients/EditClientModal';
import { HeroSkeleton, TableSkeleton } from '../components/ui/SkeletonLoader';
import StatusBadge from '../components/ui/StatusBadge';
import Tooltip from '../components/ui/Tooltip';
import { USER_TYPE_META, getMeta } from '../constants/adminMeta';
import { maskPhone } from '../utils/mask';
import { isPlanInForce } from '../utils/clientHealth';
import { usePermission } from '../hooks/usePermission';

import { formatBRL } from '../utils/format';

/** Selo do tipo de cliente (plano mais recente). A equipe não aparece aqui: /api/users só lista CLIENTE (D1). */
function getUserType(u: UserSummary): string {
    if (u.contracts && u.contracts.length > 0) {
        return u.contracts[0].type; // FIXO | FLEX | AVULSO | SERVICO | CUSTOM
    }
    return 'AVULSO';
}

export default function AdminClientsPage() {
    const navigate = useNavigate();
    const { users, setUsers, loading, search, setSearch, typeFilter, setTypeFilter, reload } = useAdminClients();
    const { requestDelete, previewingId } = useDeleteClient();
    // Botões por permissão (o servidor recusa o resto com 403). "Editar" abre com o cadastro OU o acesso
    // ao app (o wizard trava o que o acesso não permite).
    const { can, canAny } = usePermission();
    const canCreate = can('clientes.criar');
    const canEdit = canAny('clientes.editar', 'clientes.acesso');
    const canDelete = can('clientes.excluir');

    const [showCreate, setShowCreate] = useState(false);
    const [editUser, setEditUser] = useState<UserSummary | null>(null);

    // D3: prévia real do backend → diálogo de perigo (digitar EXCLUIR) → DELETE. Excluído (hard ou
    // soft) sai da lista na hora — o GET /users já não lista cliente excluído, então não há refetch.
    const confirmDelete = (u: UserSummary) => {
        void requestDelete({ id: u.id, name: u.name }, () => {
            setUsers(prev => prev.filter(x => x.id !== u.id));
        });
    };

    // --- Computed --- (filtro positivo: só CLIENTE, nunca a equipe — a API já filtra; esta é a 2ª trava)
    const clientUsers = useMemo(() => users.filter(u => u.role === 'CLIENTE'), [users]);
    // Plano "Concluído" (D6) recente continua contando como ativo (não vira Ex-cliente) — isPlanInForce.
    const hasActiveContract = (u: UserSummary) => u.contracts?.some(c => isPlanInForce(c)) ?? false;
    const hadAnyContract = (u: UserSummary) => (u._count?.contracts ?? 0) > 0;
    const hasActiveAddon = (u: UserSummary) => u.contracts?.some(c => isPlanInForce(c) && c.addOns && c.addOns.length > 0) ?? false;

    const activeCount = clientUsers.filter(hasActiveContract).length;
    const exClientCount = clientUsers.filter(u => hadAnyContract(u) && !hasActiveContract(u)).length;
    const noContractCount = clientUsers.filter(u => !hadAnyContract(u)).length;
    const noAddonCount = clientUsers.filter(u => hasActiveContract(u) && !hasActiveAddon(u)).length;

    const filtered = useMemo(() => {
        let result = clientUsers;
        if (typeFilter === 'ACTIVE') result = result.filter(u => hasActiveContract(u));
        else if (typeFilter === 'EX_CLIENT') result = result.filter(u => hadAnyContract(u) && !hasActiveContract(u));
        else if (typeFilter === 'NO_CONTRACT') result = result.filter(u => !hadAnyContract(u));
        else if (typeFilter === 'NO_ADDON') result = result.filter(u => hasActiveContract(u) && !hasActiveAddon(u));
        const q = search.trim().toLowerCase();
        if (q.length >= 3) {
            const digits = q.replace(/\D/g, '');
            result = result.filter(u =>
                u.name.toLowerCase().includes(q) ||
                (u.email ?? '').toLowerCase().includes(q) ||
                (digits.length > 0 && u.phone && u.phone.includes(digits))
            );
        }
        return result;
    }, [clientUsers, typeFilter, search]);

    if (loading) return <div><HeroSkeleton /><TableSkeleton rows={6} cols={7} /></div>;

    return (
        <div>
            {/* --- HEADER --- */}
            <AdminPageHeader
                icon={Users}
                title="Clientes"
                subtitle="Diretório de clientes e contratos"
                actions={canCreate ? (
                    <button className="btn-admin-go" onClick={() => { setShowCreate(true); }}>
                        <span style={{ fontSize: '1.1rem' }} aria-hidden="true">+</span> Novo Cliente
                    </button>
                ) : undefined}
            />

            {/* --- KPI CARDS (clicáveis = filtro) --- */}
            <div className="admin-kpi-grid" style={{ marginBottom: '24px' }}>
                {([
                    { key: 'ALL' as const, label: 'Total', count: clientUsers.length, desc: 'clientes cadastrados', icon: Users, color: '#11819B', gradient: 'rgba(17,129,155,0.10)' },
                    { key: 'ACTIVE' as const, label: 'Ativos', count: activeCount, desc: 'com contrato ativo', icon: CheckCircle2, color: '#10b981', gradient: 'rgba(16,185,129,0.08)' },
                    { key: 'EX_CLIENT' as const, label: 'Ex-clientes', count: exClientCount, desc: 'sem contrato vigente', icon: UserMinus, color: '#f59e0b', gradient: 'rgba(245,158,11,0.08)' },
                    { key: 'NO_CONTRACT' as const, label: 'Sem Contrato', count: noContractCount, desc: 'nunca contrataram', icon: Inbox, color: '#94a3b8', gradient: 'rgba(148,163,184,0.08)' },
                    { key: 'NO_ADDON' as const, label: 'Sem Add-on', count: noAddonCount, desc: 'sem serviço extra', icon: Puzzle, color: '#2dd4bf', gradient: 'rgba(45,212,191,0.08)' },
                ] as const).map(card => {
                    const isActive = typeFilter === card.key;
                    const Icon = card.icon;
                    return (
                        <button key={card.key} type="button"
                            className="admin-kpi-card"
                            aria-pressed={isActive}
                            onClick={() => setTypeFilter(isActive ? 'ALL' : card.key)}
                            style={{
                                padding: '18px 16px',
                                background: isActive ? `linear-gradient(135deg, ${card.gradient}, ${card.gradient.replace(/0\.(08|10)/, '0.02')})` : undefined,
                                borderColor: isActive ? card.color + '44' : undefined,
                                position: 'relative', overflow: 'hidden',
                            }}
                        >
                            {/* Top row: icon + label */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                                <Icon size={15} aria-hidden="true" style={{ color: isActive ? card.color : 'var(--text-muted)', transition: 'color 0.2s' }} />
                                <span style={{
                                    fontSize: '0.6875rem', fontWeight: 700, color: isActive ? card.color : 'var(--text-muted)',
                                    textTransform: 'uppercase', letterSpacing: '0.08em',
                                    transition: 'color 0.2s',
                                }}>{card.label}</span>
                            </div>
                            {/* Count */}
                            <div style={{
                                fontSize: '1.75rem', fontWeight: 800, color: 'var(--text-primary)',
                                fontVariantNumeric: 'tabular-nums', lineHeight: 1, marginBottom: '4px',
                            }}>{card.count}</div>
                            {/* Description */}
                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', lineHeight: 1.3 }}>{card.desc}</div>
                            {/* Active indicator bar */}
                            {isActive && (
                                <div style={{
                                    position: 'absolute', bottom: 0, left: '16px', right: '16px', height: '2px',
                                    background: `linear-gradient(90deg, ${card.color}, transparent)`,
                                    borderRadius: '2px',
                                }} />
                            )}
                        </button>
                    );
                })}
            </div>

            {/* --- SEARCH BAR --- */}
            <div className="admin-filter-bar admin-filter-bar--panel">
                <div className="admin-search">
                    <input
                        type="text" placeholder="Buscar por nome, e-mail ou telefone..."
                        aria-label="Buscar por nome, e-mail ou telefone"
                        value={search} onChange={e => setSearch(e.target.value)}
                    />
                    <Search size={14} className="admin-search__icon" aria-hidden="true" />
                </div>
                {search && (
                    <Tooltip content="Limpar busca" describe={false}>
                        <button type="button" onClick={() => setSearch('')} aria-label="Limpar busca"
                            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 36, minHeight: 36 }}>
                            <X size={16} aria-hidden="true" />
                        </button>
                    </Tooltip>
                )}

                {typeFilter !== 'ALL' && (
                    <button className="admin-filter-clear" onClick={() => setTypeFilter('ALL')}>
                        <FilterX size={14} aria-hidden="true" /> Limpar filtro
                    </button>
                )}

                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '4px 10px', background: 'var(--bg-elevated)', borderRadius: '8px' }} aria-live="polite">
                    {filtered.length} resultado{filtered.length !== 1 ? 's' : ''}
                </span>
            </div>

            {/* --- CLIENTS TABLE --- */}
            <div style={{ borderRadius: '16px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
                {filtered.length === 0 ? (
                    <div className="admin-empty">
                        <Search size={44} className="admin-empty__icon" aria-hidden="true" />
                        <div className="admin-empty__title">Nenhum cliente encontrado</div>
                        <div className="admin-empty__hint">Tente ajustar busca ou filtros</div>
                    </div>
                ) : (
                    <div className="table-container" style={{ margin: 0 }}>
                        <div className="admin-table-wrap">
                        <table className="admin-table--cards">
                            <thead>
                                <tr>
                                    <th style={{ paddingLeft: '20px' }}>Cliente</th>
                                    <th style={{ textAlign: 'center' }}>Sessões</th>
                                    <th style={{ textAlign: 'center' }}>Contratos</th>
                                    <th style={{ textAlign: 'right' }}>Valor Pago</th>
                                    <th style={{ textAlign: 'right' }}>A Receber</th>
                                    <th>Desde</th>
                                    {(canEdit || canDelete) && <th style={{ textAlign: 'center' }}>Ações</th>}
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.map((u) => {
                                    const hasActive = u.contracts?.some(c => c.status === 'ACTIVE');
                                    const avatarColor = hasActive ? '#10b981' : '#64748b';
                                    const avatarBg = hasActive ? 'rgba(16,185,129,0.12)' : 'rgba(100,116,139,0.12)';
                                    return (
                                        <tr key={u.id} className="admin-zebra-row">
                                            {/* Client info merged: Name + Email + Phone */}
                                            <td className="admin-card-title" style={{ paddingLeft: '20px' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                                    {/* Avatar */}
                                                    <div style={{
                                                        width: '40px', height: '40px', borderRadius: '12px',
                                                        background: avatarBg,
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        fontSize: '1.125rem', flexShrink: 0,
                                                        border: `1px solid ${avatarColor}22`,
                                                        color: avatarColor, fontWeight: 700,
                                                    }}>
                                                        {u.name.charAt(0).toUpperCase()}
                                                    </div>
                                                    <div>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                                            <Tooltip content={`Abrir perfil de ${u.name}`}>
                                                                <button type="button"
                                                                    style={{ fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', color: 'var(--accent-text)', background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', textAlign: 'left' }}
                                                                    onClick={() => navigate(`/admin/clients/${u.id}`)}>
                                                                    {u.name}
                                                                </button>
                                                            </Tooltip>
                                                            <StatusBadge meta={getMeta(USER_TYPE_META, getUserType(u))} />
                                                        </div>
                                                        <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                                            {u.email && <span>{u.email}</span>}
                                                            {u.phone && (
                                                                <>
                                                                    {u.email && <span style={{ opacity: 0.3 }}>•</span>}
                                                                    <span>{maskPhone(u.phone)}</span>
                                                                </>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </td>

                                            {/* Sessions count */}
                                            <td data-label="Sessões" style={{ textAlign: 'center' }}>
                                                <div style={{ fontWeight: 700, fontSize: '1rem' }}>{u._count.bookings}</div>
                                                <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)' }}>sessões</div>
                                            </td>

                                            {/* Contracts count */}
                                            <td data-label="Contratos" style={{ textAlign: 'center' }}>
                                                <div style={{ fontWeight: 700, fontSize: '1rem' }}>{u._count.contracts}</div>
                                                <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)' }}>contratos</div>
                                            </td>

                                            {/* Valor Pago */}
                                            <td data-label="Pago" style={{ textAlign: 'right' }}>
                                                {u.totalPaid > 0 ? (
                                                    <span style={{ fontWeight: 700, fontSize: '0.8125rem', color: 'var(--success)', fontVariantNumeric: 'tabular-nums' }}>
                                                        {formatBRL(u.totalPaid)}
                                                    </span>
                                                ) : (
                                                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>—</span>
                                                )}
                                            </td>

                                            {/* A Receber */}
                                            <td data-label="A Receber" style={{ textAlign: 'right' }}>
                                                {u.totalPending > 0 ? (
                                                    <span style={{ fontWeight: 700, fontSize: '0.8125rem', color: 'var(--warning)', fontVariantNumeric: 'tabular-nums' }}>
                                                        {formatBRL(u.totalPending)}
                                                    </span>
                                                ) : (
                                                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>—</span>
                                                )}
                                            </td>

                                            {/* Registration date */}
                                            <td data-label="Desde">
                                                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                                    {new Date(u.createdAt).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                                                </div>
                                            </td>

                                            {/* Actions (coluna some quando o acesso não tem nenhuma) */}
                                            {(canEdit || canDelete) && (
                                            <td data-label="" style={{ textAlign: 'center' }}>
                                                <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                                                    {canEdit && (
                                                        <Tooltip content="Editar cliente" describe={false}>
                                                            <button type="button" className="admin-icon-btn admin-icon-btn--success"
                                                                aria-label={`Editar ${u.name}`}
                                                                onClick={() => setEditUser(u)}><Pencil size={16} aria-hidden="true" /></button>
                                                        </Tooltip>
                                                    )}

                                                    {canDelete && (
                                                        // O botão fica disabled durante a prévia da exclusão (e botão disabled não
                                                        // dispara eventos de ponteiro): a dica vai no span para continuar aparecendo.
                                                        <Tooltip content="Excluir cliente" describe={false}>
                                                            <span style={{ display: 'inline-flex' }}>
                                                                <button type="button" className="admin-icon-btn admin-icon-btn--danger"
                                                                    aria-label={`Excluir ${u.name}`}
                                                                    aria-busy={previewingId === u.id || undefined}
                                                                    disabled={previewingId !== null}
                                                                    onClick={() => confirmDelete(u)}>
                                                                    {previewingId === u.id
                                                                        ? <Loader2 size={16} className="danger-dialog__spinner" aria-hidden="true" />
                                                                        : <Trash2 size={16} aria-hidden="true" />}
                                                                </button>
                                                            </span>
                                                        </Tooltip>
                                                    )}
                                                </div>
                                            </td>
                                            )}
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                        </div>
                    </div>
                )}
            </div>

            {/* -------------------------------------------------------
               MODALS (preserved from original)
            ------------------------------------------------------- */}

            {/* Create Modal */}
            {showCreate && canCreate && (
                <CreateClientModal
                    isOpen={showCreate}
                    onClose={() => setShowCreate(false)}
                    onCreated={reload}
                />
            )}

            {/* Edit Modal */}
            {editUser && canEdit && (
                <EditClientModal
                    user={editUser}
                    onClose={() => setEditUser(null)}
                    onSaved={reload}
                />
            )}

        </div>
    );
}
