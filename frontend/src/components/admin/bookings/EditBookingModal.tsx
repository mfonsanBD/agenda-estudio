import { getErrorMessage } from '../../../utils/errors';
import { useState, useEffect } from 'react';
import { bookingsApi, BookingWithUser } from '../../../api/client';
import BottomSheetModal from '../../BottomSheetModal';
import { formatBRL } from '../../../utils/format';
import { TIER_META, BOOKING_STATUS_META, getMeta } from '../../../constants/adminMeta';
import { Pencil, CalendarDays, Clock, Wallet, Ban } from 'lucide-react';
import StatusReasonModal, { type ReasonConfirmOptions } from './StatusReasonModal';
import { useBusinessConfig } from '../../../hooks/useBusinessConfig';
import { buildReasonUpdate, reasonSaveFeedback, showReasonFeedback } from '../../../utils/avulsoMakeup';
import { useUI } from '../../../context/UIContext';
import DangerConfirmDialog, { type DangerCloseReason } from '../../ui/DangerConfirmDialog';
import { bookingSummary, cancelBookingConsequences, cancelBookingRequest } from './bookingDanger';
import { useBookingPermissions, isCancelledPlanReopenBlocked, cancelledPlanReopenHint, cancelledReopenNeedsBaixaHint, isVoidedChargeReopenBlocked, CANCEL_OPEN_CHARGE_NEEDS_BAIXA, VOIDED_CHARGE_REOPEN_HINT } from './bookingPermissions';
import { accessibleTierLabels, planContractOf, tierChangeBlockedFor } from './tierAccess';
import { usePermission } from '../../../hooks/usePermission';

/** DIN-03: o servidor recusa (403 cobrancas.baixa) mover a sessão para outra faixa de preço sem a baixa manual. */
const TIER_CHANGE_NEEDS_BAIXA = 'Mudar a sessão para um horário de outra faixa de preço muda o valor cobrado e exige a permissão “Marcar como pago, anular ou estornar”.';

// Statuses selecionáveis neste modal — cores/labels/ícones vêm do adminMeta
// (source of truth); HELD é interno do fluxo de pagamento e fica de fora.
const EDITABLE_STATUS_KEYS = Object.keys(BOOKING_STATUS_META).filter(key => key !== 'HELD');

interface EditBookingModalProps {
    booking: BookingWithUser | null;
    onClose: () => void;
    onSaved: () => void;
}

export default function EditBookingModal({ booking, onClose, onSaved }: EditBookingModalProps) {
    const [editForm, setEditForm] = useState({ date: '', startTime: '', status: '' });
    const [editError, setEditError] = useState('');
    const [saving, setSaving] = useState(false);
    // FALTA / NAO_REALIZADO exigem o MOTIVO (e, no avulso, decidir a falta justificada — D4/D5).
    const [reasonKind, setReasonKind] = useState<'FALTA' | 'NAO_REALIZADO' | null>(null);
    // CANCELLED pede a confirmação de perigo (D3) antes de gravar.
    const [confirmCancel, setConfirmCancel] = useState(false);
    useBusinessConfig(); // pré-carrega as regras (prazo da remarcação) que o modal de motivo mostra
    const { showToast, showAlert } = useUI();
    // Data/horário só com agendamentos.editar; status só as transições permitidas (mesma tabela do
    // servidor). O servidor ignora data/horário reenviados sem mudança (regra por valor alterado).
    const bp = useBookingPermissions();
    const { can } = usePermission();
    const canMarkPaid = can('cobrancas.baixa');

    useEffect(() => {
        if (booking) {
            setEditForm({ date: booking.date.split('T')[0], startTime: booking.startTime, status: booking.status });
            setEditError('');
            setReasonKind(null);
            setConfirmCancel(false);
        }
    }, [booking]);

    // DIN-03/FIN-03: sem a baixa manual, descobre a faixa do NOVO horário (grade do dia) para avisar antes de
    // salvar — o que o servidor recusa depende do tipo da sessão (abaixo).
    const originalDate = booking ? booking.date.split('T')[0] : '';
    const slotChanged = !!booking && !!editForm.date && !!editForm.startTime
        && (editForm.date !== originalDate || editForm.startTime !== booking.startTime);
    const [targetTier, setTargetTier] = useState<string | null>(null);
    useEffect(() => {
        setTargetTier(null);
        if (canMarkPaid || !slotChanged) return;
        let alive = true;
        const t = setTimeout(() => {
            bookingsApi.getAvailability(editForm.date)
                .then(r => { if (alive) setTargetTier(r.slots.find(s => s.time === editForm.startTime)?.tier ?? null); })
                .catch(() => { /* sem a grade, o servidor continua sendo a trava */ });
        }, 300);
        return () => { alive = false; clearTimeout(t); };
    }, [canMarkPaid, slotChanged, editForm.date, editForm.startTime]);
    // FIN-03 (espelho do PATCH /bookings/:id): sessão de PLANO (Fixo, Flex, Personalizado) não muda de valor ao
    // mudar de faixa — o servidor só confere a faixa do PLANO (403 TIER_NOT_ALLOWED acima dela). Avulso e serviço:
    // outra faixa muda o valor cobrado (403 cobrancas.baixa). UXT-08: a decisão é a função pura tierChangeBlockedFor
    // (tierAccess.ts, com teste no eq-r5-front) — não reescreva a conta aqui.
    const planContract = planContractOf(booking?.contract);
    const tierChangeBlocked = !!booking && tierChangeBlockedFor({
        canMarkPaid, slotChanged, targetTier, tierApplied: booking.tierApplied, contract: booking.contract,
    });

    const isAvulso = booking?.contract?.type === 'AVULSO';

    const save = async (reason?: { text: string; justified: boolean }) => {
        if (!booking || saving) return;
        setEditError('');
        setSaving(true);
        try {
            const data: Parameters<typeof bookingsApi.update>[1] = {};
            if (editForm.date) data.date = editForm.date;
            if (editForm.startTime) data.startTime = editForm.startTime;
            if (editForm.status) data.status = editForm.status;
            if (reason && (editForm.status === 'FALTA' || editForm.status === 'NAO_REALIZADO')) {
                Object.assign(data, buildReasonUpdate(editForm.status, reason.text, { isAvulso, justified: reason.justified }));
            }
            const res = await bookingsApi.update(booking.id, data);
            if (reason && (editForm.status === 'FALTA' || editForm.status === 'NAO_REALIZADO')) {
                // AUDFIN6-03/TELA6-01: pela RESPOSTA — a remarcação só é prometida se a janela abriu; a sessão reaberta
                // sem cobrança mostra só o aviso do servidor (nunca as duas mensagens contraditórias).
                showReasonFeedback(reasonSaveFeedback(editForm.status, { isAvulso, justified: reason.justified }, res), { showToast, showAlert });
            }
            // AUDFIN-01: reabriu (Concluído) uma sessão cuja cobrança foi anulada — o servidor avisa.
            else if (res.reopenedWithoutCharge) showAlert({ type: 'warning', title: 'Sessão reaberta sem cobrança', message: res.message });
            setReasonKind(null);
            onSaved();
            onClose();
        } catch (err: unknown) {
            setReasonKind(null);
            setEditError(getErrorMessage(err));
        } finally { setSaving(false); }
    };

    const handleEdit = () => {
        if (!booking || saving) return;
        // Rede de segurança: os botões só oferecem as transições permitidas.
        // (canChangeStatus também recusa reabrir sessão cancelada de Personalizado e, no FLEX, tudo menos
        // Concluído — DIN-01.)
        if (editForm.status !== booking.status && !bp.canChangeStatus(booking, editForm.status)) return;
        if (tierChangeBlocked) return;
        // Mudou PARA Falta/Não Realizado → primeiro o modal de motivo; o save sai de lá.
        if ((editForm.status === 'FALTA' || editForm.status === 'NAO_REALIZADO') && editForm.status !== booking.status) {
            setReasonKind(editForm.status);
            return;
        }
        // Mudou PARA Cancelado → confirmação de perigo; nada é gravado até confirmar.
        if (editForm.status === 'CANCELLED' && booking.status !== 'CANCELLED') {
            setEditError('');
            setConfirmCancel(true);
            return;
        }
        save();
    };

    const handleConfirmReason = (reason: string, { justified }: ReasonConfirmOptions) => save({ text: reason, justified });

    // Cancelamento pela rota certa (bookingDanger): sessão não realizada → cancelamento canônico
    // (libera o horário e devolve o crédito); demais → PATCH só do status (data/horário editados
    // não se aplicam a uma reserva cancelada). Sem try/catch: o erro aparece dentro do diálogo.
    const performCancel = async () => {
        if (!booking) return;
        await cancelBookingRequest(booking);
        showToast('Agendamento cancelado.');
    };

    const handleCancelDialogClose = (reason: DangerCloseReason) => {
        setConfirmCancel(false);
        if (reason === 'confirmed') { onSaved(); onClose(); }
    };

    if (!booking) return null;

    const allStatusKeys = EDITABLE_STATUS_KEYS.includes(booking.status) ? EDITABLE_STATUS_KEYS : [booking.status, ...EDITABLE_STATUS_KEYS];
    const statusKeys = bp.statusOptions(booking, allStatusKeys);
    // DIN-01: sessão cancelada de Personalizado (todas) ou FLEX (todas menos Concluído) — as opções de reabrir
    // somem (regra do plano, não do acesso), com a explicação própria; o aviso de acesso só fala do que o
    // acesso esconde.
    const reopenBlocked = isCancelledPlanReopenBlocked(booking, 'CONFIRMED');
    // R7 (espelho do AUDFIN6-02): a cobrança da sessão foi anulada (o servidor disse) — não volta a ficar em aberto.
    const voidedReopenBlocked = isVoidedChargeReopenBlocked(booking, 'CONFIRMED');
    // FIN-01/ATK-02: sem a baixa, a sessão cancelada não sai de Cancelado para nenhum status — a explicação
    // própria (pedir a quem tem a baixa; avulso/sessão paga: não criar outro agendamento — FIN-07) substitui a
    // dica do plano e o aviso genérico de acesso.
    const reopenNeedsBaixa = bp.cancelledReopenNeedsBaixa(booking);
    // R5: o Cancelado some porque a sessão tem cobrança em aberto e falta a baixa — explicação própria abaixo.
    const cancelNeedsBaixa = bp.cancelNeedsBaixa(booking);
    // O aviso genérico só fala do que o ACESSO esconde (não das regras do plano/da Falta, nem da cobrança em aberto).
    const someStatusHidden = !reopenNeedsBaixa && allStatusKeys.some(to => bp.hiddenByAccess(booking, to));
    const tierLabelOf = (tier: string | null | undefined) => getMeta(TIER_META, tier).label;

    return (
        // preventClose com o modal de motivo / a confirmação de cancelamento aberta: o Esc fecha só o de
        // cima (os sheets escutam o mesmo keydown).
        <BottomSheetModal isOpen onClose={onClose} hideHeader size="md" className="admin-sheet" title="Editar Agendamento" preventClose={saving || !!reasonKind || confirmCancel}>
                {/* Header */}
                <div className="admin-modal-head">
                    <h2 className="admin-modal-title">
                        <span className="admin-modal-title__icon"><Pencil size={16} aria-hidden="true" /></span>
                        Editar Agendamento
                    </h2>
                    {/* Client info bar */}
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: '10px', marginTop: '16px',
                        padding: '10px 14px', borderRadius: '10px',
                        background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                    }}>
                        <div style={{
                            width: 30, height: 30, borderRadius: '50%',
                            background: 'var(--accent-gradient-go)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '0.75rem', fontWeight: 700, color: '#fff', flexShrink: 0,
                        }}>{booking.user.name.charAt(0).toUpperCase()}</div>
                        <div>
                            <div style={{ fontWeight: 700, fontSize: '0.8125rem' }}>{booking.user.name}</div>
                            {/* e-mail null-safe: cliente excluído (D3) tem os dados pessoais anonimizados. */}
                            {booking.user.email && <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>{booking.user.email}</div>}
                        </div>
                        {booking.contract && (
                            <span style={{
                                marginLeft: 'auto', fontSize: '0.625rem', fontWeight: 700,
                                padding: '2px 8px', borderRadius: '6px',
                                background: TIER_META[booking.contract.tier]?.bg || 'var(--bg-elevated)',
                                color: TIER_META[booking.contract.tier]?.color || 'var(--text-muted)',
                            }}>
                                {(() => { const TI = TIER_META[booking.contract!.tier]?.icon; return TI ? <TI size={11} style={{ verticalAlign: '-1px', marginRight: 3 }} aria-hidden="true" /> : null; })()}{booking.contract.name}
                            </span>
                        )}
                    </div>
                </div>

                {/* Form */}
                <div className="admin-modal-body">
                    {editError && <div className="admin-alert admin-alert--danger" role="alert">{editError}</div>}

                    <div className="admin-grid-2" style={{ marginBottom: '16px' }}>
                        {/* Date */}
                        <div className="admin-field">
                            <label className="admin-field__label" htmlFor="edit-booking-date" style={{ display: 'flex', alignItems: 'center', gap: 4 }}><CalendarDays size={13} aria-hidden="true" /> Data</label>
                            <input id="edit-booking-date" type="date" value={editForm.date}
                                min={new Date().toISOString().split('T')[0]}
                                onChange={e => setEditForm({ ...editForm, date: e.target.value })}
                                disabled={!bp.canEditSlot}
                                aria-describedby={!bp.canEditSlot ? 'edit-booking-slot-locked' : undefined}
                                className="form-input form-input--raised"
                            />
                        </div>
                        {/* Time */}
                        <div className="admin-field">
                            <label className="admin-field__label" htmlFor="edit-booking-time" style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Clock size={13} aria-hidden="true" /> Horário</label>
                            <input id="edit-booking-time" type="time" step="1800" value={editForm.startTime}
                                onChange={e => setEditForm({ ...editForm, startTime: e.target.value })}
                                disabled={!bp.canEditSlot}
                                aria-describedby={!bp.canEditSlot ? 'edit-booking-slot-locked' : undefined}
                                className="form-input form-input--raised"
                            />
                        </div>
                    </div>
                    {!bp.canEditSlot && (
                        <p id="edit-booking-slot-locked" style={{ margin: '-8px 0 16px', fontSize: '0.6875rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                            Mudar a data ou o horário exige a permissão “Mudar data, horário e status”.
                        </p>
                    )}
                    {/* Sem a baixa manual: sessão de plano só nas faixas do plano (FIN-03); avulso e serviço só na
                        MESMA faixa de preço (DIN-03). */}
                    {bp.canEditSlot && !canMarkPaid && (tierChangeBlocked ? (
                        <div id="edit-booking-tier-locked" className="admin-alert admin-alert--warning" role="status" style={{ margin: '-8px 0 16px', fontSize: '0.75rem', lineHeight: 1.45 }}>
                            {planContract
                                ? <>O plano {tierLabelOf(planContract.tier)} não permite agendar horários {tierLabelOf(targetTier)}. Escolha um horário que o plano permita.</>
                                : <>Este horário é da faixa {tierLabelOf(targetTier)}, e a sessão é {tierLabelOf(booking.tierApplied)}. {TIER_CHANGE_NEEDS_BAIXA} Escolha um horário da mesma faixa.</>}
                        </div>
                    ) : (
                        <p style={{ margin: '-8px 0 16px', fontSize: '0.6875rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                            {planContract
                                ? <>Sessão do plano {tierLabelOf(planContract.tier)}: só horários que o plano permite ({accessibleTierLabels(planContract.tier)}). Sessão cobrada à parte (ex.: a extra do Fixo) só muda de faixa com a permissão “Marcar como pago, anular ou estornar”.</>
                                : <>Só horários da mesma faixa de preço ({tierLabelOf(booking.tierApplied)}): outra faixa muda o valor cobrado e exige a permissão “Marcar como pago, anular ou estornar”.</>}
                        </p>
                    ))}

                    {/* Status (só as transições que o acesso permite) */}
                    <div className="admin-field" style={{ marginBottom: '16px' }}>
                        <span className="admin-field__label">Status</span>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }} role="group" aria-label="Status do agendamento"
                            aria-describedby={reopenNeedsBaixa ? 'edit-booking-reopen-locked' : cancelNeedsBaixa ? 'edit-booking-cancel-locked' : undefined}>
                            {statusKeys.map(key => {
                                const cfg = getMeta(BOOKING_STATUS_META, key);
                                const Icon = cfg.icon;
                                return (
                                    <button key={key} type="button"
                                        onClick={() => setEditForm({ ...editForm, status: key })}
                                        aria-pressed={editForm.status === key}
                                        style={{
                                            padding: '8px 12px', borderRadius: '8px', fontSize: '0.6875rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                                            display: 'inline-flex', alignItems: 'center', gap: '6px',
                                            background: editForm.status === key ? cfg.bg : 'var(--bg-elevated)',
                                            border: `1px solid ${editForm.status === key ? cfg.color + '44' : 'var(--border-default)'}`,
                                            color: editForm.status === key ? cfg.color : 'var(--text-muted)',
                                            transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
                                        }}
                                    >
                                        <Icon size={12} aria-hidden="true" /> {cfg.label}
                                    </button>
                                );
                            })}
                        </div>
                        {reopenNeedsBaixa ? (
                            <div id="edit-booking-reopen-locked" style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                                {cancelledReopenNeedsBaixaHint(booking)}
                            </div>
                        ) : reopenBlocked ? (
                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                                {cancelledPlanReopenHint(booking.contract?.type)}
                            </div>
                        ) : voidedReopenBlocked && (
                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                                {VOIDED_CHARGE_REOPEN_HINT}
                            </div>
                        )}
                        {cancelNeedsBaixa && (
                            <div id="edit-booking-cancel-locked" style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                                {CANCEL_OPEN_CHARGE_NEEDS_BAIXA}
                            </div>
                        )}
                        {someStatusHidden && (
                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                                {statusKeys.length <= 1
                                    ? 'O seu acesso não permite mudar o status deste agendamento.'
                                    : 'Aparecem só os status que o seu acesso permite a partir do status atual.'}
                            </div>
                        )}
                    </div>

                    {/* Info summary */}
                    <div style={{
                        padding: '10px 14px', borderRadius: '10px', marginBottom: '16px',
                        background: 'rgba(16,185,129,0.04)', border: '1px solid rgba(16,185,129,0.1)',
                        fontSize: '0.75rem', color: 'var(--text-muted)',
                        display: 'flex', justifyContent: 'space-between',
                    }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Wallet size={12} aria-hidden="true" /> Valor: <strong style={{ color: 'var(--success)' }}>{formatBRL(booking.price)}</strong></span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{(() => { const TI = TIER_META[booking.tierApplied]?.icon; return TI ? <TI size={12} aria-hidden="true" /> : null; })()} {getMeta(TIER_META, booking.tierApplied).label}</span>
                    </div>

                    {/* Actions */}
                    <div className="admin-actions-row">
                        <button key="cancel" type="button" onClick={onClose} className="btn-admin-ghost" disabled={saving}>
                            Cancelar
                        </button>
                        <button key="save" type="button" onClick={handleEdit} className="btn-admin-go" disabled={saving || tierChangeBlocked} aria-busy={saving || undefined}
                            aria-describedby={tierChangeBlocked ? 'edit-booking-tier-locked' : undefined}>
                            {saving && !reasonKind ? 'Salvando…' : 'Salvar Alterações'}
                        </button>
                    </div>
                </div>

                <StatusReasonModal
                    isOpen={!!reasonKind}
                    kind={reasonKind}
                    subtitle={`${booking.user.name} · ${new Date((editForm.date || booking.date.split('T')[0]) + 'T12:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' })} às ${editForm.startTime || booking.startTime}`}
                    isAvulso={isAvulso}
                    // D = data ATUAL da reserva: o backend abre a janela antes de aplicar uma data nova.
                    bookingDate={booking.date}
                    makeupStatus={booking.makeupStatus ?? null}
                    onConfirm={handleConfirmReason}
                    onClose={() => setReasonKind(null)}
                    saving={saving}
                    zIndex={1100}
                />

                <DangerConfirmDialog
                    isOpen={confirmCancel}
                    tone="danger"
                    icon={Ban}
                    title="Cancelar agendamento?"
                    description={bookingSummary(booking)}
                    consequences={cancelBookingConsequences(booking, { canSettleCharges: bp.canSettleCharges })}
                    confirmLabel="Cancelar agendamento"
                    loadingLabel="Cancelando…"
                    onConfirm={performCancel}
                    onClose={handleCancelDialogClose}
                    zIndex={1100}
                />
        </BottomSheetModal>
    );
}
