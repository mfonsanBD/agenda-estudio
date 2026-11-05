import { usersApi } from '../../../api/client';
import SavedCardItem from '../../ui/SavedCardItem';
import { formatBRL } from '../../../utils/format';
import { CreditCard, RefreshCw, AlertTriangle } from 'lucide-react';

type PaymentOverview = Awaited<ReturnType<typeof usersApi.paymentOverview>>;

interface PaymentOverviewCardProps {
    overview: PaymentOverview;
    autoSaving: boolean;
    onToggleAutoCharge: (enabled: boolean) => void;
    /** Ligar/desligar a cobrança automática exige `cobrancas.automatica` (sem ela, só o estado). */
    canToggleAutoCharge?: boolean;
}

/** Visão de pagamento do admin: cobrança automática, cartões salvos e parcelas a vencer. */
export default function PaymentOverviewCard({ overview, autoSaving, onToggleAutoCharge, canToggleAutoCharge = true }: PaymentOverviewCardProps) {
    const toggleEnabled = canToggleAutoCharge && overview.hasSavedCard;
    return (
        <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
            <h2 style={{ fontSize: '1.0625rem', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: 8 }}><CreditCard size={17} aria-hidden="true" /> Pagamento</h2>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '12px 14px', borderRadius: 'var(--radius-md)', background: overview.autoChargeEnabled ? 'rgba(16,185,129,0.06)' : 'var(--bg-elevated)', border: `1px solid ${overview.autoChargeEnabled ? 'rgba(16,185,129,0.25)' : 'var(--border-default)'}`, cursor: toggleEnabled ? 'pointer' : 'not-allowed', opacity: toggleEnabled ? 1 : 0.6 }}>
                <div>
                    <div style={{ fontSize: '0.875rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}><RefreshCw size={14} aria-hidden="true" /> Cobrança automática</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {!overview.hasSavedCard ? 'Requer um cartão salvo do cliente.'
                            : !canToggleAutoCharge ? `${overview.autoChargeEnabled ? 'Ligada' : 'Desligada'}. Ligar ou desligar exige a permissão “Ligar ou desligar a cobrança automática do cliente”.`
                                : 'Cobra o cartão de crédito salvo na data de vencimento.'}
                    </div>
                </div>
                <input type="checkbox" checked={overview.autoChargeEnabled} disabled={!toggleEnabled || autoSaving} onChange={e => { if (canToggleAutoCharge) onToggleAutoCharge(e.target.checked); }} style={{ width: 20, height: 20, accentColor: 'var(--success)', cursor: toggleEnabled ? 'pointer' : 'not-allowed' }} />
            </label>

            <div style={{ marginTop: '14px' }}>
                <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>Cartões salvos</div>
                {overview.cards.length === 0 ? (
                    <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Nenhum cartão salvo</div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {overview.cards.map(c => (
                            <SavedCardItem key={c.id} card={c} />
                        ))}
                    </div>
                )}
            </div>

            <div style={{ marginTop: '14px' }}>
                <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>Parcelas a vencer ({overview.duePayments.length})</div>
                {overview.duePayments.length === 0 ? (
                    <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Nenhuma parcela pendente</div>
                ) : overview.duePayments.slice(0, 8).map(p => (
                    <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '8px 12px', borderRadius: 'var(--radius-sm)', background: p.overdue ? 'rgba(220,38,38,0.06)' : 'var(--bg-elevated)', border: p.overdue ? '1px solid rgba(220,38,38,0.2)' : '1px solid transparent', marginBottom: '6px' }}>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '0.8125rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.contractName}</div>
                            <div style={{ fontSize: '0.6875rem', color: p.overdue ? 'var(--danger)' : 'var(--text-muted)' }}>{p.overdue ? <><AlertTriangle size={11} style={{ verticalAlign: '-1px' }} aria-hidden="true" /> Vencida · </> : ''}{p.dueDate ? new Date(p.dueDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—'}</div>
                        </div>
                        <span style={{ fontSize: '0.875rem', fontWeight: 700, color: p.overdue ? 'var(--danger)' : 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{formatBRL(p.amount)}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
