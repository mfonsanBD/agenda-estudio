import { KeyRound, Loader2, Mail, Pencil, Power, PowerOff, ShieldCheck, Trash2 } from 'lucide-react';
import type { StaffCatalog, StaffMember } from '../../../api/client';
import { STAFF_ROLE_META, STAFF_STATUS_META, getMeta } from '../../../constants/adminMeta';
import { maskPhone } from '../../../utils/mask';
import StatusBadge from '../../ui/StatusBadge';
import Tooltip from '../../ui/Tooltip';
import { canSetPasswordFor, modulesCountLabel, modulesWithAccess } from './teamPermissions';
import '../../../styles/team.css';

export interface TeamTableProps {
    members: StaffMember[];
    /** Catálogo (rótulos dos módulos na dica do "N módulos"). Sem ele, conta pelos prefixos das chaves. */
    catalog: StaffCatalog | null;
    /** Administradores ATIVOS (trava do "último administrador"). */
    activeAdmins: number;
    /** Linha com "Enviar acesso" em andamento (ícone vira spinner). */
    sendingId: string | null;
    /** Abre o editor; `step` 3 = direto nas permissões (clique no "N módulos"). */
    onEdit: (member: StaffMember, step?: number) => void;
    onSendAccess: (member: StaffMember) => void;
    onSetPassword: (member: StaffMember) => void;
    onDeactivate: (member: StaffMember) => void;
    onReactivate: (member: StaffMember) => void;
    /** Exclusão definitiva (prévia → digitar EXCLUIR). */
    onPurge: (member: StaffMember) => void;
    /** Linha com a prévia da exclusão em andamento (ícone vira spinner). */
    purgingId: string | null;
}

function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    const first = parts[0].charAt(0);
    const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return (first + last).toUpperCase();
}

/** Módulos com acesso de um colaborador (rótulos do catálogo; sem catálogo, os prefixos das chaves). */
function accessModules(member: StaffMember, catalog: StaffCatalog | null): string[] {
    if (catalog) return modulesWithAccess(catalog, member.permissions).map(m => m.label);
    return [...new Set(member.permissions.map(k => k.split('.')[0]))];
}

/**
 * Lista da Equipe: tabela no desktop, cards abaixo de 768px (`admin-table--cards` + `data-label`).
 * Ações com aria-label + Tooltip (regra E7). Proteções: na PRÓPRIA linha só "Editar" (sem ações de risco);
 * "Definir senha" só para colaborador que nunca foi administrador (`canSetPasswordFor`: a senha/e-mail de quem
 * é ou já foi administrador não se alteram por aqui — E2);
 * "Desativar" do único administrador ativo fica desabilitado com a explicação.
 */
export default function TeamTable({
    members, catalog, activeAdmins, sendingId, onEdit, onSendAccess, onSetPassword, onDeactivate, onReactivate, onPurge, purgingId,
}: TeamTableProps) {
    return (
        <div className="table-container" style={{ margin: 0 }}>
            <div className="admin-table-wrap">
                <table className="admin-table--cards team-table">
                    <thead>
                        <tr>
                            <th style={{ paddingLeft: '20px' }}>Pessoa</th>
                            <th>E-mail</th>
                            <th>Tipo</th>
                            <th>Cargo</th>
                            <th>Acesso</th>
                            <th>Situação</th>
                            <th style={{ textAlign: 'center' }}>Ações</th>
                        </tr>
                    </thead>
                    <tbody>
                        {members.map(m => {
                            const isAdmin = m.role === 'ADMIN';
                            const lastAdmin = isAdmin && m.active && activeAdmins <= 1;
                            const modules = isAdmin ? [] : accessModules(m, catalog);
                            const accessLabel = modulesCountLabel(modules.length);
                            const avatarClass = !m.active ? ' team-avatar--inactive' : isAdmin ? ' team-avatar--admin' : '';
                            const sending = sendingId === m.id;
                            return (
                                <tr key={m.id} className={`admin-zebra-row${m.active ? '' : ' team-row--inactive'}`}>
                                    <td className="admin-card-title" style={{ paddingLeft: '20px' }}>
                                        <div className="team-person">
                                            <div className={`team-avatar${avatarClass}`} aria-hidden="true">
                                                {m.photoUrl ? <img src={m.photoUrl} alt="" loading="lazy" /> : initials(m.name)}
                                            </div>
                                            <div className="team-person__text">
                                                <div className="team-person__name-row">
                                                    <span className="team-person__name">{m.name}</span>
                                                    {m.isSelf && <span className="team-you-chip">você</span>}
                                                </div>
                                                {m.phone && <div className="team-person__sub">{maskPhone(m.phone)}</div>}
                                            </div>
                                        </div>
                                    </td>
                                    <td data-label="E-mail">
                                        {m.email ? <span className="team-cell-text team-cell-text--nowrap">{m.email}</span> : <span className="team-cell-muted">—</span>}
                                    </td>
                                    <td data-label="Tipo">
                                        <StatusBadge meta={getMeta(STAFF_ROLE_META, m.role)} />
                                    </td>
                                    <td data-label="Cargo">
                                        {m.title ? <span className="team-cell-text">{m.title}</span> : <span className="team-cell-muted">—</span>}
                                    </td>
                                    <td data-label="Acesso">
                                        {isAdmin ? (
                                            <span className="team-access-total"><ShieldCheck size={14} aria-hidden="true" /> Acesso total</span>
                                        ) : (
                                            <Tooltip content={modules.length > 0 ? modules.join(' · ') : 'Nenhum módulo liberado: a pessoa só vê o painel vazio.'}>
                                                <button type="button"
                                                    className={`team-access-btn${modules.length === 0 ? ' team-access-btn--none' : ''}`}
                                                    aria-label={`Permissões de ${m.name}: ${accessLabel}. Abrir para ajustar.`}
                                                    onClick={() => onEdit(m, 3)}>
                                                    {accessLabel}
                                                </button>
                                            </Tooltip>
                                        )}
                                    </td>
                                    <td data-label="Situação">
                                        <StatusBadge meta={getMeta(STAFF_STATUS_META, m.active ? 'ACTIVE' : 'INACTIVE')} />
                                    </td>
                                    <td data-label="" style={{ textAlign: 'center' }}>
                                        <div className="team-actions">
                                            <Tooltip content={m.isSelf ? 'Editar meus dados' : 'Editar'} describe={false}>
                                                <button type="button" className="admin-icon-btn admin-icon-btn--success"
                                                    aria-label={m.isSelf ? 'Editar meus dados' : `Editar ${m.name}`}
                                                    onClick={() => onEdit(m)}>
                                                    <Pencil size={16} aria-hidden="true" />
                                                </button>
                                            </Tooltip>

                                            {!m.isSelf && m.active && m.email && (
                                                // Fica desabilitado durante o envio: a dica vai no <span> (botão disabled não
                                                // dispara eventos de ponteiro).
                                                <Tooltip content="Enviar acesso (e-mail com o link de entrada)" describe={false}>
                                                    <span style={{ display: 'inline-flex' }}>
                                                        <button type="button" className="admin-icon-btn"
                                                            aria-label={`Enviar acesso para ${m.name}`}
                                                            aria-busy={sending || undefined}
                                                            disabled={sending}
                                                            onClick={() => onSendAccess(m)}>
                                                            {sending
                                                                ? <Loader2 size={16} className="danger-dialog__spinner" aria-hidden="true" />
                                                                : <Mail size={16} aria-hidden="true" />}
                                                        </button>
                                                    </span>
                                                </Tooltip>
                                            )}

                                            {/* TELA-1: quem já foi administrador também não tem a senha trocada por aqui (E2).
                                                UXT-08: a decisão é canSetPasswordFor (teamPermissions, com teste). */}
                                            {canSetPasswordFor(m) && (
                                                <Tooltip content="Definir senha" describe={false}>
                                                    <button type="button" className="admin-icon-btn"
                                                        aria-label={`Definir senha de ${m.name}`}
                                                        onClick={() => onSetPassword(m)}>
                                                        <KeyRound size={16} aria-hidden="true" />
                                                    </button>
                                                </Tooltip>
                                            )}

                                            {!m.isSelf && m.active && (
                                                lastAdmin ? (
                                                    <Tooltip content="É o único administrador ativo. Promova outra pessoa antes de desativar.">
                                                        <span style={{ display: 'inline-flex' }} tabIndex={0}>
                                                            <button type="button" className="admin-icon-btn admin-icon-btn--danger"
                                                                aria-label={`Desativar ${m.name} (indisponível: único administrador ativo)`}
                                                                disabled>
                                                                <PowerOff size={16} aria-hidden="true" />
                                                            </button>
                                                        </span>
                                                    </Tooltip>
                                                ) : (
                                                    <Tooltip content="Desativar acesso" describe={false}>
                                                        <button type="button" className="admin-icon-btn admin-icon-btn--danger"
                                                            aria-label={`Desativar o acesso de ${m.name}`}
                                                            onClick={() => onDeactivate(m)}>
                                                            <PowerOff size={16} aria-hidden="true" />
                                                        </button>
                                                    </Tooltip>
                                                )
                                            )}

                                            {!m.isSelf && !m.active && (
                                                <Tooltip content="Reativar acesso" describe={false}>
                                                    <button type="button" className="admin-icon-btn admin-icon-btn--success"
                                                        aria-label={`Reativar o acesso de ${m.name}`}
                                                        onClick={() => onReactivate(m)}>
                                                        <Power size={16} aria-hidden="true" />
                                                    </button>
                                                </Tooltip>
                                            )}

                                            {!m.isSelf && (
                                                <Tooltip content="Excluir definitivamente" describe={false}>
                                                    <span style={{ display: 'inline-flex' }}>
                                                        <button type="button" className="admin-icon-btn admin-icon-btn--danger"
                                                            aria-label={`Excluir ${m.name} definitivamente`}
                                                            aria-busy={purgingId === m.id || undefined}
                                                            disabled={purgingId !== null}
                                                            onClick={() => onPurge(m)}>
                                                            {purgingId === m.id
                                                                ? <Loader2 size={16} className="danger-dialog__spinner" aria-hidden="true" />
                                                                : <Trash2 size={16} aria-hidden="true" />}
                                                        </button>
                                                    </span>
                                                </Tooltip>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
