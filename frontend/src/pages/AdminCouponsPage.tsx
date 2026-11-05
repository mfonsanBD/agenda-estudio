import { getErrorMessage } from '../utils/errors';
import { useState, useMemo } from 'react';
import { TicketPercent, CheckCircle, Clock, XCircle, Ban, TrendingUp, FilterX, Sparkles, Target, Users, Pencil, Pause, Play, Trash2 } from 'lucide-react';
import { couponsApi, Coupon } from '../api/client';
import { useUI } from '../context/UIContext';
import { useAdminCoupons, CouponStatusFilter } from '../hooks/useAdminCoupons';
import { usePermission } from '../hooks/usePermission';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import CouponModal from '../components/admin/coupons/CouponModal';
import { HeroSkeleton, TableSkeleton } from '../components/ui/SkeletonLoader';
import StatusBadge from '../components/ui/StatusBadge';
import Tooltip from '../components/ui/Tooltip';

import { formatBRL } from '../utils/format';

type CouponStatus = 'ACTIVE' | 'INACTIVE' | 'EXPIRED' | 'EXHAUSTED';

const COUPON_STATUS_META: Record<CouponStatus, { label: string; color: string; bg: string; icon: typeof CheckCircle }> = {
    ACTIVE:    { label: 'Ativo',    color: '#10b981', bg: 'rgba(16,185,129,0.1)',  icon: CheckCircle },
    INACTIVE:  { label: 'Inativo',  color: '#6b7280', bg: 'rgba(107,114,128,0.1)', icon: Ban },
    EXPIRED:   { label: 'Expirado', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)',  icon: Clock },
    EXHAUSTED: { label: 'Esgotado', color: '#ef4444', bg: 'rgba(239,68,68,0.1)',   icon: XCircle },
};

/** Data-calendário de HOJE em São Paulo, como 'YYYY-MM-DD' (en-CA formata nesse padrão). */
function todaySP(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

/** 'YYYY-MM-DD...' → 'dd/mm/aaaa' sem passar por new Date (evita fuso). */
function formatDateBR(iso: string): string {
    const [y, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
}

export default function AdminCouponsPage() {
    const { showToast, showConfirm, showAlert } = useUI();
    const { coupons, loading, statusFilter, setStatusFilter, reload } = useAdminCoupons();
    // Equipe (D2): a página abre com cupons.ver; Novo, Editar, Ativar/Desativar e Excluir = cupons.editar.
    const { can } = usePermission();
    const canEditCoupons = can('cupons.editar');

    const [showCreate, setShowCreate] = useState(false);
    const [editCoupon, setEditCoupon] = useState<Coupon | null>(null);

    // --- Derivação de status (client-side) ---
    const today = todaySP();
    const isExpired = (c: Coupon) => !!c.expiresAt && c.expiresAt.slice(0, 10) < today;
    const isExhausted = (c: Coupon) => c.maxUses != null && c.usedCount >= c.maxUses;
    const isActive = (c: Coupon) => c.active && !isExpired(c) && !isExhausted(c);
    const statusOf = (c: Coupon): CouponStatus =>
        isExhausted(c) ? 'EXHAUSTED' : isExpired(c) ? 'EXPIRED' : c.active ? 'ACTIVE' : 'INACTIVE';

    const activeCount = coupons.filter(isActive).length;
    const expiredCount = coupons.filter(isExpired).length;
    const exhaustedCount = coupons.filter(isExhausted).length;
    const totalUses = coupons.reduce((sum, c) => sum + c.usedCount, 0);

    const filtered = useMemo(() => {
        if (statusFilter === 'ACTIVE') return coupons.filter(isActive);
        if (statusFilter === 'EXPIRED') return coupons.filter(isExpired);
        if (statusFilter === 'EXHAUSTED') return coupons.filter(isExhausted);
        return coupons;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [coupons, statusFilter, today]);

    // --- Ações ---
    const handleToggle = async (c: Coupon) => {
        try {
            await couponsApi.update(c.id, { active: !c.active });
            await reload();
            showToast(c.active ? 'Cupom desativado.' : 'Cupom ativado.');
        } catch (err: unknown) {
            showToast({ message: getErrorMessage(err) || 'Erro ao atualizar cupom', type: 'error' });
        }
    };

    // D3: excluir é irreversível (danger). O backend só exclui cupom SEM uso consumido
    // (resgate RESERVED/CONFIRMED → 409 "desative-o em vez de excluir"); usedCount conta
    // exatamente esses usos, então um cupom já usado vai direto para a alternativa reversível.
    const confirmDelete = (c: Coupon) => {
        const code = c.code.toUpperCase();
        if (c.usedCount > 0) {
            const uses = `${c.usedCount} ${c.usedCount === 1 ? 'vez' : 'vezes'}`;
            if (!c.active) {
                showAlert({
                    title: 'Cupom já utilizado',
                    message: `O cupom ${code} já foi usado ${uses} e não pode ser excluído, para preservar o histórico dos pagamentos. Ele já está desativado: nenhum cliente consegue usá-lo.`,
                    type: 'info',
                });
                return;
            }
            showConfirm({
                tone: 'warning',
                icon: Pause,
                title: 'Este cupom não pode ser excluído',
                message: `O cupom ${code} já foi usado ${uses}. Para preservar o histórico dos pagamentos, cupons usados não são excluídos — você pode desativá-lo.`,
                consequences: [
                    `O código ${code} deixa de ser aceito em novos pagamentos, na hora.`,
                    'Os pagamentos que já tiveram o desconto não mudam.',
                    'Dá para reativar depois pelo mesmo botão.',
                ],
                confirmLabel: 'Desativar cupom',
                onConfirm: async () => {
                    await couponsApi.update(c.id, { active: false });
                    showToast('Cupom desativado.');
                    await reload();
                },
            });
            return;
        }
        const eligibles = c.eligibleUsers.length;
        showConfirm({
            tone: 'danger',
            icon: Trash2,
            title: `Excluir o cupom ${code}?`,
            message: 'O cupom será apagado de vez. Se quiser só pausar o uso, desative-o em vez de excluir.',
            consequences: [
                `O código ${code} deixa de ser aceito imediatamente e não pode ser recuperado.`,
                ...(eligibles > 0 ? [`A lista de ${eligibles} ${eligibles === 1 ? 'cliente elegível' : 'clientes elegíveis'} é apagada junto.`] : []),
                'Nenhum pagamento é afetado: o cupom ainda não foi usado.',
            ],
            confirmLabel: 'Excluir cupom',
            // Sem try/catch: um erro (ex.: 409 se o cupom foi usado nesse meio-tempo) aparece dentro do diálogo.
            onConfirm: async () => {
                const res = await couponsApi.remove(c.id);
                showToast(res.message || 'Cupom excluído.');
                await reload();
            },
        });
    };

    if (loading) return <div><HeroSkeleton /><TableSkeleton rows={6} cols={7} /></div>;

    return (
        <div>
            {/* --- HEADER --- */}
            <AdminPageHeader
                icon={TicketPercent}
                title="Cupons"
                subtitle="Cupons de desconto para pagamentos"
                actions={canEditCoupons ? (
                    <button className="btn-admin-go" onClick={() => setShowCreate(true)}>
                        <span style={{ fontSize: '1.1rem' }} aria-hidden="true">+</span> Novo Cupom
                    </button>
                ) : undefined}
            />

            {/* --- KPI CARDS --- */}
            <div className="admin-kpi-grid" style={{ marginBottom: '24px' }}>
                {([
                    { key: 'ALL' as CouponStatusFilter, label: 'Total', count: coupons.length, desc: 'cupons cadastrados', icon: TicketPercent, color: '#11819B', gradient: 'rgba(17,129,155,0.10)', clickable: true },
                    { key: 'ACTIVE' as CouponStatusFilter, label: 'Ativos', count: activeCount, desc: 'prontos para uso', icon: CheckCircle, color: '#10b981', gradient: 'rgba(16,185,129,0.08)', clickable: true },
                    { key: 'EXPIRED' as CouponStatusFilter, label: 'Expirados', count: expiredCount, desc: 'validade vencida', icon: Clock, color: '#f59e0b', gradient: 'rgba(245,158,11,0.08)', clickable: true },
                    { key: 'EXHAUSTED' as CouponStatusFilter, label: 'Esgotados', count: exhaustedCount, desc: 'limite de usos atingido', icon: Ban, color: '#94a3b8', gradient: 'rgba(148,163,184,0.08)', clickable: true },
                    { key: 'USES' as const, label: 'Usos', count: totalUses, desc: 'usos registrados', icon: TrendingUp, color: '#2dd4bf', gradient: 'rgba(45,212,191,0.08)', clickable: false },
                ]).map(card => {
                    const isSelected = card.clickable && statusFilter === card.key;
                    const Tag = card.clickable ? 'button' : 'div';
                    const Icon = card.icon;
                    return (
                        <Tag key={card.key} {...(card.clickable ? { type: 'button' as const, 'aria-pressed': isSelected } : {})}
                            className="admin-kpi-card"
                            onClick={card.clickable ? () => setStatusFilter(isSelected ? 'ALL' : card.key as CouponStatusFilter) : undefined}
                            style={{
                                padding: '18px 16px', cursor: card.clickable ? 'pointer' : 'default',
                                background: isSelected ? `linear-gradient(135deg, ${card.gradient}, ${card.gradient.replace(/0\.(08|10)/, '0.02')})` : undefined,
                                borderColor: isSelected ? card.color + '44' : undefined,
                                position: 'relative', overflow: 'hidden',
                            }}
                        >
                            {/* Top row: icon + label */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                                <Icon size={15} aria-hidden="true" style={{ color: isSelected ? card.color : 'var(--text-muted)', transition: 'color 0.2s' }} />
                                <span style={{
                                    fontSize: '0.6875rem', fontWeight: 700, color: isSelected ? card.color : 'var(--text-muted)',
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
                            {isSelected && (
                                <div style={{
                                    position: 'absolute', bottom: 0, left: '16px', right: '16px', height: '2px',
                                    background: `linear-gradient(90deg, ${card.color}, transparent)`,
                                    borderRadius: '2px',
                                }} />
                            )}
                        </Tag>
                    );
                })}
            </div>

            {/* --- FILTER INFO BAR --- */}
            {statusFilter !== 'ALL' && (
                <div style={{
                    padding: '12px 16px', borderRadius: '12px', marginBottom: '16px',
                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                    display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap'
                }}>
                    <button className="admin-filter-clear" onClick={() => setStatusFilter('ALL')}>
                        <FilterX size={14} aria-hidden="true" /> Limpar filtro
                    </button>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '4px 10px', background: 'var(--bg-elevated)', borderRadius: '8px' }}>
                        {filtered.length} resultado{filtered.length !== 1 ? 's' : ''}
                    </span>
                </div>
            )}

            {/* --- COUPONS TABLE --- */}
            <div style={{ borderRadius: '16px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
                {filtered.length === 0 ? (
                    <div className="admin-empty">
                        <TicketPercent size={44} className="admin-empty__icon" aria-hidden="true" />
                        <div className="admin-empty__title">Nenhum cupom encontrado</div>
                        <div className="admin-empty__hint">
                            {coupons.length > 0 ? 'Tente ajustar os filtros'
                                : canEditCoupons ? 'Crie seu primeiro cupom de desconto' : 'Ainda não há cupons cadastrados'}
                        </div>
                    </div>
                ) : (
                    <div className="table-container" style={{ margin: 0 }}>
                        <div className="admin-table-wrap">
                        <table className="admin-table--cards">
                            <thead>
                                <tr>
                                    <th style={{ paddingLeft: '20px' }}>Código</th>
                                    <th>Desconto</th>
                                    <th>Elegibilidade</th>
                                    <th>Validade</th>
                                    <th style={{ textAlign: 'center' }}>Usos</th>
                                    <th>Status</th>
                                    {canEditCoupons && <th style={{ textAlign: 'center' }}>Ações</th>}
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.map((c) => {
                                    const status = statusOf(c);
                                    const meta = COUPON_STATUS_META[status];
                                    const expired = isExpired(c);
                                    return (
                                        <tr key={c.id} className="admin-zebra-row">
                                            {/* Código */}
                                            <td className="admin-card-title" style={{ paddingLeft: '20px' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                                    <div style={{
                                                        width: '40px', height: '40px', borderRadius: '12px',
                                                        background: meta.bg,
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        fontSize: '1rem', flexShrink: 0,
                                                        border: `1px solid ${meta.color}22`,
                                                    }}><TicketPercent size={18} aria-hidden="true" style={{ color: meta.color }} /></div>
                                                    <div style={{ minWidth: 0 }}>
                                                        <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.875rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-primary)' }}>
                                                            {c.code}
                                                        </div>
                                                        {c.description && (
                                                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '220px' }}>
                                                                {c.description}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </td>

                                            {/* Desconto */}
                                            <td data-label="Desconto">
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                                    <span style={{ fontWeight: 700, fontSize: '0.875rem', color: 'var(--accent-text)', fontVariantNumeric: 'tabular-nums' }}>
                                                        {c.discountType === 'VALOR' ? formatBRL(c.discountValue) : `${c.discountValue}%`}
                                                    </span>
                                                    {c.scope === 'ALL_INSTALLMENTS' && (
                                                        <span style={{
                                                            fontSize: '0.5625rem', fontWeight: 700, padding: '2px 8px', borderRadius: '999px',
                                                            background: 'rgba(17,129,155,0.12)', border: '1px solid rgba(17,129,155,0.3)', color: 'var(--accent-text)',
                                                            textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                                                        }}>
                                                            todas as parcelas
                                                        </span>
                                                    )}
                                                </div>
                                                {c.minAmount != null && c.minAmount > 0 && (
                                                    <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                                                        mín. {formatBRL(c.minAmount)}
                                                    </div>
                                                )}
                                            </td>

                                            {/* Elegibilidade */}
                                            <td data-label="Elegibilidade">
                                                {c.onlyNewClients ? (
                                                    <span style={{
                                                        fontSize: '0.6875rem', fontWeight: 600, padding: '3px 10px', borderRadius: '999px',
                                                        background: 'var(--warning-bg)', border: '1px solid rgba(245,158,11,0.3)', color: 'var(--warning)',
                                                        whiteSpace: 'nowrap',
                                                    }}>
                                                        <Sparkles size={11} aria-hidden="true" style={{ verticalAlign: '-1px' }} /> Só novos clientes
                                                    </span>
                                                ) : c.eligibleUsers.length > 0 ? (
                                                    <span
                                                        title={c.eligibleUsers.map(u => u.name).join(', ')}
                                                        style={{
                                                            fontSize: '0.6875rem', fontWeight: 600, padding: '3px 10px', borderRadius: '999px',
                                                            background: 'var(--info-bg)', border: '1px solid rgba(59,130,246,0.3)', color: 'var(--info)',
                                                            whiteSpace: 'nowrap', cursor: 'help',
                                                        }}>
                                                        <Target size={11} aria-hidden="true" style={{ verticalAlign: '-1px' }} /> {c.eligibleUsers.length} cliente{c.eligibleUsers.length !== 1 ? 's' : ''}
                                                    </span>
                                                ) : (
                                                    <span style={{
                                                        fontSize: '0.6875rem', fontWeight: 600, padding: '3px 10px', borderRadius: '999px',
                                                        background: 'rgba(148,163,184,0.1)', border: '1px solid rgba(148,163,184,0.2)', color: 'var(--text-secondary)',
                                                        whiteSpace: 'nowrap',
                                                    }}>
                                                        <Users size={11} aria-hidden="true" style={{ verticalAlign: '-1px' }} /> Todos
                                                    </span>
                                                )}
                                            </td>

                                            {/* Validade */}
                                            <td data-label="Validade">
                                                {c.expiresAt ? (
                                                    <div style={{ fontSize: '0.75rem', fontWeight: expired ? 700 : 400, color: expired ? 'var(--warning)' : 'var(--text-secondary)' }}>
                                                        {formatDateBR(c.expiresAt)}
                                                        {expired && <div style={{ fontSize: '0.625rem', fontWeight: 600 }}>vencido</div>}
                                                    </div>
                                                ) : (
                                                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Sem validade</span>
                                                )}
                                            </td>

                                            {/* Usos */}
                                            <td data-label="Usos" style={{ textAlign: 'center' }}>
                                                <div style={{ fontWeight: 700, fontSize: '0.875rem', fontVariantNumeric: 'tabular-nums' }}>
                                                    {c.usedCount}/{c.maxUses != null ? c.maxUses : '∞'}
                                                </div>
                                                {c.maxUsesPerUser != null && (
                                                    <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)' }}>
                                                        máx. {c.maxUsesPerUser}/cliente
                                                    </div>
                                                )}
                                            </td>

                                            {/* Status */}
                                            <td data-label="Status">
                                                <StatusBadge meta={meta} />
                                            </td>

                                            {/* Ações (só com "Criar, editar, ativar e excluir cupons") */}
                                            {canEditCoupons && (
                                            <td data-label="" style={{ textAlign: 'center' }}>
                                                <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                                                    <Tooltip content="Editar cupom" describe={false}>
                                                        <button type="button" className="admin-icon-btn admin-icon-btn--success"
                                                        aria-label={`Editar cupom ${c.code}`}
                                                        onClick={() => setEditCoupon(c)}><Pencil size={16} aria-hidden="true" /></button>
                                                    </Tooltip>

                                                    <Tooltip content={c.active ? 'Desativar cupom' : 'Ativar cupom'} describe={false}>
                                                        <button type="button" className="admin-icon-btn"
                                                        aria-label={c.active ? `Desativar cupom ${c.code}` : `Ativar cupom ${c.code}`}
                                                        onClick={() => handleToggle(c)}>{c.active ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}</button>
                                                    </Tooltip>

                                                    <Tooltip content="Excluir cupom" describe={false}>
                                                        <button type="button" className="admin-icon-btn admin-icon-btn--danger"
                                                        aria-label={`Excluir cupom ${c.code}`}
                                                        onClick={() => confirmDelete(c)}><Trash2 size={16} aria-hidden="true" /></button>
                                                    </Tooltip>
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

            {/* --- MODALS --- */}
            {canEditCoupons && showCreate && (
                <CouponModal
                    onClose={() => setShowCreate(false)}
                    onSaved={reload}
                />
            )}

            {canEditCoupons && editCoupon && (
                <CouponModal
                    coupon={editCoupon}
                    onClose={() => setEditCoupon(null)}
                    onSaved={reload}
                />
            )}
        </div>
    );
}
