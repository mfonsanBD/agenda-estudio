import { useRef, useState } from 'react';
import { Ban, Info, Power, PowerOff, Search, ShieldCheck, UserCog, UserPlus, UsersRound, X, FilterX, type LucideIcon } from 'lucide-react';
import { staffApi, type StaffMember } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useUI } from '../context/UIContext';
import { useAdminTeam, type TeamFilter } from '../hooks/useAdminTeam';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import TeamTable from '../components/admin/team/TeamTable';
import TeamMemberModal from '../components/admin/team/TeamMemberModal';
import TeamPasswordSheet from '../components/admin/team/TeamPasswordSheet';
import BrandLoader from '../components/ui/BrandLoader';
import DangerConfirmDialog from '../components/ui/DangerConfirmDialog';
import { HeroSkeleton, TableSkeleton } from '../components/ui/SkeletonLoader';
import Tooltip from '../components/ui/Tooltip';
import { getErrorMessage } from '../utils/errors';
import '../styles/team.css';

interface KpiDef {
    key: TeamFilter;
    label: string;
    count: number;
    desc: string;
    icon: LucideIcon;
    mod: string;
}

/**
 * Tela Equipe (`/admin/equipe`, só ADMIN — guarda em App.tsx; a API `/api/staff` confere o papel no banco).
 * Quem acessa a área administrativa e o que cada pessoa pode fazer:
 * - KPIs clicáveis (Total, Administradores, Colaboradores, Desativados) que filtram a lista, mais a busca;
 * - tabela/cards (TeamTable) com Editar, Enviar acesso, Definir senha (só colaborador que nunca foi
 *   administrador — `credentialsLocked`) e Desativar/Reativar;
 * - wizard TeamMemberModal (Dados → Acesso → Permissões) para criar e editar.
 * O que o servidor devolve (`member`) é aplicado na lista sem recarregar (diálogos não desmontam no meio).
 */
export default function AdminTeamPage() {
    const team = useAdminTeam();
    const { showToast, showConfirm } = useUI();
    const { refreshPermissions } = useAuth();

    const [editor, setEditor] = useState<{ member: StaffMember | null; step?: number } | null>(null);
    const [passwordFor, setPasswordFor] = useState<StaffMember | null>(null);
    const [confirm, setConfirm] = useState<{ kind: 'deactivate' | 'reactivate'; member: StaffMember } | null>(null);
    const [sendingId, setSendingId] = useState<string | null>(null);
    // Último pedido de confirmação: mantém os textos do diálogo durante a animação de saída.
    const lastConfirmRef = useRef(confirm);
    if (confirm) lastConfirmRef.current = confirm;

    const { counts } = team;

    const handleSaved = (member: StaffMember, message: string) => {
        team.upsertMember(member);
        setEditor(null);
        showToast(message);
        // Mudou o próprio nome/cargo: o rótulo da Sidebar vem do /me.
        if (member.isSelf) void refreshPermissions();
    };

    const sendAccess = (member: StaffMember) => {
        if (!member.email) return;
        showConfirm({
            title: 'Enviar o e-mail de acesso?',
            message: `Enviaremos para ${member.email} o aviso de que ${member.name} faz parte da equipe e como entrar (com um código no e-mail). O e-mail não leva senha.`,
            confirmLabel: 'Enviar e-mail',
            onConfirm: async () => {
                setSendingId(member.id);
                try {
                    const res = await staffApi.sendAccess(member.id);
                    showToast(res.message || `E-mail de acesso enviado para ${member.email}.`);
                } catch (err) {
                    showToast({ message: getErrorMessage(err), type: 'error' });
                } finally {
                    setSendingId(null);
                }
            },
        });
    };

    const runStatusChange = async () => {
        if (!confirm) return;
        const { kind, member } = confirm;
        // Lança em erro: o DangerConfirmDialog mostra a mensagem dentro dele (LAST_ADMIN, SELF_CHANGE_FORBIDDEN…).
        const res = kind === 'deactivate' ? await staffApi.deactivate(member.id) : await staffApi.reactivate(member.id);
        team.upsertMember(res.member);
        showToast(res.message);
    };

    if (team.loading) return <div><HeroSkeleton /><TableSkeleton rows={4} cols={7} /></div>;

    const kpis: KpiDef[] = [
        { key: 'ALL', label: 'Total', count: counts.total, desc: 'pessoas na equipe', icon: UsersRound, mod: '' },
        { key: 'ADMIN', label: 'Administradores', count: counts.admins, desc: 'acesso total', icon: ShieldCheck, mod: ' team-kpi--admin' },
        { key: 'COLABORADOR', label: 'Colaboradores', count: counts.colaboradores, desc: 'acesso por módulo', icon: UserCog, mod: ' team-kpi--colab' },
        { key: 'INACTIVE', label: 'Desativados', count: counts.inactive, desc: 'sem acesso no momento', icon: Ban, mod: ' team-kpi--inactive' },
    ];

    const onlyMe = team.members.length <= 1 && team.members.every(m => m.isSelf);
    const filtering = team.filter !== 'ALL' || team.search.trim() !== '';
    const shownConfirm = confirm ?? lastConfirmRef.current;
    const confirmMember = shownConfirm?.member;
    const reactivating = shownConfirm?.kind === 'reactivate';
    const confirmFirst = confirmMember ? (confirmMember.name.trim().split(/\s+/)[0] || confirmMember.name) : '';

    return (
        <div>
            <AdminPageHeader
                icon={ShieldCheck}
                title="Equipe"
                subtitle="Quem acessa a área administrativa e o que cada pessoa pode fazer"
                actions={
                    <button type="button" className="btn-admin-go" onClick={() => setEditor({ member: null })}>
                        <UserPlus size={16} aria-hidden="true" /> Novo membro
                    </button>
                }
            />

            {team.error && team.members.length === 0 ? (
                <div className="admin-empty" role="alert">
                    <UsersRound size={44} className="admin-empty__icon" aria-hidden="true" />
                    <div className="admin-empty__title">Não foi possível carregar a equipe</div>
                    <div className="admin-empty__hint">{team.error}</div>
                    <button type="button" className="btn-admin-ghost" onClick={() => void team.reload()}>Tentar de novo</button>
                </div>
            ) : (
                <>
                    {team.error && (
                        <div className="admin-alert admin-alert--warning" role="alert">
                            Não foi possível atualizar a lista agora ({team.error}). Os dados abaixo podem estar desatualizados.
                        </div>
                    )}
                    <div className="admin-kpi-grid team-kpi-grid" style={{ marginBottom: '16px' }}>
                        {kpis.map(card => {
                            const active = team.filter === card.key;
                            const Icon = card.icon;
                            return (
                                <button key={card.key} type="button" className={`admin-kpi-card team-kpi${card.mod}`} aria-pressed={active}
                                    onClick={() => team.setFilter(active ? 'ALL' : card.key)}>
                                    <div className="team-kpi__top">
                                        <Icon size={15} aria-hidden="true" />
                                        <span className="team-kpi__label">{card.label}</span>
                                    </div>
                                    <div className="team-kpi__value">{card.count}</div>
                                    <div className="team-kpi__desc">{card.desc}</div>
                                </button>
                            );
                        })}
                    </div>

                    <div className="admin-info-banner" style={{ marginBottom: '16px' }}>
                        <Info size={16} className="admin-info-banner__icon" aria-hidden="true" style={{ color: 'var(--info)' }} />
                        <span>
                            <strong style={{ color: 'var(--text-primary)' }}>Administradores</strong> têm acesso total, inclusive esta tela.{' '}
                            <strong style={{ color: 'var(--text-primary)' }}>Colaboradores</strong> acessam só os módulos que você marcar.
                            Clientes não aparecem aqui: eles ficam em Clientes.
                        </span>
                    </div>

                    <div className="admin-filter-bar admin-filter-bar--panel">
                        <div className="admin-search">
                            <input type="text" placeholder="Buscar por nome, e-mail ou cargo..." aria-label="Buscar por nome, e-mail ou cargo"
                                value={team.search} onChange={e => team.setSearch(e.target.value)} />
                            <Search size={14} className="admin-search__icon" aria-hidden="true" />
                        </div>
                        {team.search && (
                            <Tooltip content="Limpar busca" describe={false}>
                                <button type="button" onClick={() => team.setSearch('')} aria-label="Limpar busca"
                                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 36, minHeight: 36 }}>
                                    <X size={16} aria-hidden="true" />
                                </button>
                            </Tooltip>
                        )}
                        {team.filter !== 'ALL' && (
                            <button type="button" className="admin-filter-clear" onClick={() => team.setFilter('ALL')}>
                                <FilterX size={14} aria-hidden="true" /> Limpar filtro
                            </button>
                        )}
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '4px 10px', background: 'var(--bg-elevated)', borderRadius: '8px' }} aria-live="polite">
                            {team.filtered.length} {team.filtered.length === 1 ? 'pessoa' : 'pessoas'}
                        </span>
                        {team.refreshing && <BrandLoader size="inline" label="Atualizando…" />}
                    </div>

                    <div className="team-table-shell">
                        {team.filtered.length === 0 ? (
                            filtering ? (
                                <div className="admin-empty">
                                    <Search size={44} className="admin-empty__icon" aria-hidden="true" />
                                    <div className="admin-empty__title">Ninguém encontrado</div>
                                    <div className="admin-empty__hint">Tente ajustar a busca ou o filtro.</div>
                                </div>
                            ) : (
                                <div className="admin-empty">
                                    <UsersRound size={44} className="admin-empty__icon" aria-hidden="true" />
                                    <div className="admin-empty__title">Ninguém na equipe ainda</div>
                                    <div className="admin-empty__hint">Adicione pessoas e escolha o que cada uma pode fazer.</div>
                                    <button type="button" className="btn-admin-go" onClick={() => setEditor({ member: null })}>
                                        <UserPlus size={16} aria-hidden="true" /> Adicionar pessoa
                                    </button>
                                </div>
                            )
                        ) : (
                            <>
                                <TeamTable
                                    members={team.filtered}
                                    catalog={team.catalog}
                                    activeAdmins={counts.activeAdmins}
                                    sendingId={sendingId}
                                    onEdit={(member, step) => setEditor({ member, step })}
                                    onSendAccess={sendAccess}
                                    onSetPassword={setPasswordFor}
                                    onDeactivate={member => setConfirm({ kind: 'deactivate', member })}
                                    onReactivate={member => setConfirm({ kind: 'reactivate', member })}
                                />
                                {onlyMe && !filtering && (
                                    <div className="admin-empty" style={{ paddingTop: '24px' }}>
                                        <div className="admin-empty__title">Só você na equipe por enquanto</div>
                                        <div className="admin-empty__hint">Adicione colaboradores e escolha o que cada um pode fazer.</div>
                                        <button type="button" className="btn-admin-go" onClick={() => setEditor({ member: null })}>
                                            <UserPlus size={16} aria-hidden="true" /> Adicionar pessoa
                                        </button>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </>
            )}

            {editor && (
                <TeamMemberModal
                    key={editor.member?.id ?? 'new'}
                    member={editor.member}
                    initialStep={editor.step}
                    catalog={team.catalog}
                    catalogLoading={team.catalogLoading}
                    catalogError={team.catalogError}
                    onRetryCatalog={() => void team.reloadCatalog()}
                    activeAdmins={counts.activeAdmins}
                    onClose={() => setEditor(null)}
                    onSaved={handleSaved}
                />
            )}

            {passwordFor && (
                <TeamPasswordSheet
                    member={passwordFor}
                    onClose={() => setPasswordFor(null)}
                    onDone={message => { setPasswordFor(null); showToast(message); }}
                />
            )}

            <DangerConfirmDialog
                isOpen={!!confirm}
                tone={reactivating ? 'warning' : 'danger'}
                irreversible={false}
                icon={reactivating ? Power : PowerOff}
                title={reactivating
                    ? `Reativar o acesso de ${confirmMember?.name ?? ''}?`
                    : `Desativar o acesso de ${confirmMember?.name ?? ''}?`}
                description={reactivating
                    ? `${confirmFirst} volta a entrar com o mesmo e-mail.`
                    : `${confirmFirst} deixa de acessar a área administrativa. Dá para reativar depois.`}
                consequences={reactivating
                    ? [
                        'Volta a entrar com senha ou com o código enviado ao e-mail.',
                        confirmMember?.role === 'ADMIN'
                            ? 'Volta a ter acesso total (administrador).'
                            : 'Recupera as mesmas permissões que tinha antes de ser desativado.',
                    ]
                    : [
                        'Sai na hora de todas as sessões abertas.',
                        'Não consegue mais entrar (senha, código e Google são recusados).',
                        'As notificações no celular param de chegar.',
                        'O histórico do que fez fica preservado; as permissões ficam guardadas para uma reativação.',
                    ]}
                confirmLabel={reactivating ? 'Reativar acesso' : 'Desativar acesso'}
                loadingLabel={reactivating ? 'Reativando…' : 'Desativando…'}
                onConfirm={runStatusChange}
                onClose={() => setConfirm(null)}
            />
        </div>
    );
}
