import { useNavigate } from 'react-router-dom';
import { Contract } from '../../../api/client';
import { useBusinessConfig } from '../../../hooks/useBusinessConfig';
import { FolderOpen, FileText, ClipboardCheck } from 'lucide-react';
import StatusBadge from '../../ui/StatusBadge';
import { TIER_META, CONTRACT_STATUS_META, CONTRACT_TYPE_META, getMeta } from '../../../constants/adminMeta';
import { describeContractTerms, type TermsBooking } from '../../../utils/contractStatus';
import { usePermission } from '../../../hooks/usePermission';

/** Lista de contratos do cliente.
 *  `bookings` (opcional, ex.: `user.bookings` do perfil): com eles o AVULSO mostra a data/horário
 *  REAIS da gravação (a remarcação muda a reserva, não o contrato); sem eles, a data do contrato. */
export default function ClientContractsCard({ contracts, bookings }: {
    contracts: Contract[];
    bookings?: (TermsBooking & { contractId?: string | null })[];
}) {
    const navigate = useNavigate();
    const { get: getRule } = useBusinessConfig();
    // O detalhe do contrato exige contratos.ver (senão o link cairia no redirecionamento).
    const canOpenContract = usePermission().can('contratos.ver');

    return (
        <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
            <h2 style={{ fontSize: '1.0625rem', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: 8 }}><ClipboardCheck size={17} aria-hidden="true" /> Contratos ({contracts.length})</h2>
            {contracts.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Nenhum contrato</div>
            ) : (
                // min(300px, 100%): abaixo de ~375px de tela a coluna mínima de 300px passaria da largura do card.
                <div style={{ display: 'grid', gap: '12px', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))' }}>
                    {contracts.map((c: Contract) => {
                        const terms = describeContractTerms(c, bookings?.filter(b => b.contractId === c.id), null, { dateFormat: 'short' });
                        // L6: derivar por TIPO — AVULSO = 1 (era 24 pelo ramo "≠3m → episodes_6months"),
                        // CUSTOM = totalSessions real; demais = episódios do plano por duração.
                        const episodes = terms.isAvulso ? 1
                            : c.type === 'CUSTOM' ? (c.totalSessions ?? (c.durationMonths === 3 ? getRule('episodes_3months') : getRule('episodes_6months')))
                                : (c.durationMonths === 3 ? getRule('episodes_3months') : getRule('episodes_6months'));
                        return (
                        <div key={c.id} style={{
                            padding: '12px', borderRadius: 'var(--radius-sm)',
                            background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                        }}>
                            {/* Os selos quebram de linha em vez de vazar do card (ex.: "Personalizado" + "Audiência" +
                                "Aguard. pagamento" num card de 300px): o status desce para baixo quando não cabe. */}
                            <div className="admin-badge-row" style={{ marginBottom: '8px' }}>
                                <div className="admin-badge-row__group">
                                    <StatusBadge meta={getMeta(CONTRACT_TYPE_META, c.type)} />
                                    <StatusBadge meta={getMeta(TIER_META, c.tier)} />
                                </div>
                                <StatusBadge meta={getMeta(CONTRACT_STATUS_META, c.status)} />
                            </div>
                            <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                                <div>{terms.isAvulso ? terms.duracao : `${terms.duracao} · ${episodes} ${episodes === 1 ? 'gravação' : 'gravações'}`}</div>
                                <div>{terms.vigencia}</div>
                                {c.type === 'FLEX' && c.flexCreditsRemaining != null && (
                                    <div style={{ marginTop: '4px', fontWeight: 600, color: 'var(--accent-primary)' }}>
                                        Créditos restantes: {c.flexCreditsRemaining}/{c.flexCreditsTotal}
                                    </div>
                                )}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px', flexWrap: 'wrap' }}>
                                {canOpenContract && (
                                    <button onClick={() => navigate(`/admin/contracts/${c.id}`)}
                                        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--accent-text)' }}>
                                        <FolderOpen size={14} aria-hidden="true" /> Abrir contrato →
                                    </button>
                                )}
                                {c.contractUrl && (
                                    <a href={c.contractUrl} target="_blank" rel="noopener noreferrer"
                                        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '0.8125rem', color: 'var(--accent-text)', textDecoration: 'none' }}>
                                        <FileText size={14} aria-hidden="true" /> Ver contrato digital ↗
                                    </a>
                                )}
                            </div>
                        </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
