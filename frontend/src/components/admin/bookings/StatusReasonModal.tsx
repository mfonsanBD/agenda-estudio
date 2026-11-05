import { useState, useEffect, useId } from 'react';
import BottomSheetModal from '../../BottomSheetModal';
import { AlertTriangle, XCircle, NotebookPen } from 'lucide-react';
import type { MakeupStatus } from '../../../api/client';
import { useBusinessConfig } from '../../../hooks/useBusinessConfig';
import { previewMakeupWindow, naoRealizadoAvulsoHint } from '../../../utils/avulsoMakeup';
import '../../../styles/makeup.css';

export type ReasonKind = 'FALTA' | 'NAO_REALIZADO';

/** Opções escolhidas no modal além do motivo. `justified` = falta justificada (só avulso, D4). */
export interface ReasonConfirmOptions { justified: boolean }

interface Props {
    isOpen: boolean;
    kind: ReasonKind | null;
    /** Nome do cliente/gravação, só para contexto no cabeçalho. */
    subtitle?: string;
    /**
     * Gravação AVULSA (contrato AVULSO): na FALTA habilita a opção "Falta justificada" (remarcação
     * sem novo pagamento até o fim de D+N — D4) e, no NAO_REALIZADO, explica a janela automática (D5).
     */
    isAvulso?: boolean;
    /** Data da gravação (ISO/YYYY-MM-DD) — base do prazo D+N (`avulso_makeup_days`, fuso SP). */
    bookingDate?: string;
    /** Janela atual da reserva: USED = remarcação já usada (é única) → não dá para justificar de novo. */
    makeupStatus?: MakeupStatus | null;
    onConfirm: (reason: string, opts: ReasonConfirmOptions) => void | Promise<void>;
    onClose: () => void;
    saving?: boolean;
    /** Empilhar sobre outro sheet (ex.: aberto de dentro do EditBookingModal). */
    zIndex?: number;
}

const META: Record<ReasonKind, { title: string; icon: typeof AlertTriangle; color: string; placeholder: string; confirmLabel: string }> = {
    FALTA: {
        title: 'Marcar Falta',
        icon: XCircle,
        color: 'var(--danger)',
        placeholder: 'Ex.: cliente não compareceu e não avisou.',
        confirmLabel: 'Confirmar Falta',
    },
    NAO_REALIZADO: {
        title: 'Marcar Não Realizado',
        icon: AlertTriangle,
        color: 'var(--warning)',
        placeholder: 'Ex.: queda de energia no estúdio / falha de equipamento.',
        confirmLabel: 'Confirmar Não Realizado',
    },
};

export default function StatusReasonModal({
    isOpen, kind, subtitle, isAvulso = false, bookingDate, makeupStatus = null,
    onConfirm, onClose, saving, zIndex,
}: Props) {
    const uid = useId();
    const { get: getRule } = useBusinessConfig();
    const [reason, setReason] = useState('');
    const [justified, setJustified] = useState(false);

    // Cada abertura começa limpa: sem motivo e SEM justificativa (padrão = falta perde o valor).
    useEffect(() => { if (isOpen) { setReason(''); setJustified(false); } }, [isOpen, kind]);

    if (!isOpen || !kind) return null;
    const meta = META[kind];
    const Icon = meta.icon;

    const makeupDays = getRule('avulso_makeup_days');
    const preview = isAvulso && bookingDate ? previewMakeupWindow(bookingDate, makeupDays) : null;
    // Falta justificada só vale para avulso, uma única vez (USED = já remarcada), e até o fim de D+N.
    const showJustify = kind === 'FALTA' && isAvulso && !!preview;
    const justifyBlockedReason = !showJustify ? null
        : makeupStatus === 'USED' ? 'Esta gravação já foi remarcada uma vez — a remarcação é única, então esta falta não pode ser justificada.'
        : makeupStatus === 'EXPIRED' ? 'O prazo de remarcação desta gravação já terminou.'
        : preview!.expired ? `O prazo para justificar terminou em ${preview!.ddmm} (${makeupDays} dias após a gravação). A falta perde o valor.`
        : null;
    const effectiveJustified = showJustify && !justifyBlockedReason && justified;

    let hint: string;
    let hintColor = meta.color;
    if (kind === 'FALTA') {
        if (effectiveJustified) {
            hintColor = 'var(--warning)';
            hint = `Falta justificada: o cliente pode remarcar uma única vez, sem novo pagamento, para uma data até ${preview!.ddmm} (fim do dia). Ele recebe um aviso agora. Se não remarcar até lá, perde o valor.`;
        } else if (isAvulso) {
            hint = 'O cliente faltou e PERDE o valor pago desta gravação avulsa (o contrato fica Concluído). Descreva o que aconteceu.';
        } else {
            hint = 'O cliente faltou. A sessão é consumida: ele PERDE o valor/crédito desta gravação. Descreva o que aconteceu.';
        }
    } else if (isAvulso && preview) {
        // AUDFIN6-03: a janela só abre para gravação paga (o servidor decide) — a dica não promete sem saber.
        hint = naoRealizadoAvulsoHint(preview, makeupDays);
    } else {
        hint = 'A gravação não aconteceu por um motivo alheio ao cliente. Nos planos com créditos (Flex/Personalizado) o crédito volta; nos demais a vaga é liberada. Descreva o motivo.';
    }

    const canConfirm = reason.trim().length >= 3 && !saving;
    const confirmLabel = effectiveJustified ? 'Confirmar falta justificada' : meta.confirmLabel;

    return (
        <BottomSheetModal isOpen onClose={onClose} hideHeader size="sm" className="admin-sheet" title={meta.title} preventClose={saving} zIndex={zIndex}>
            <div style={{ padding: '24px 28px 28px' }}>
                <h2 style={{ fontSize: '1.0625rem', fontWeight: 800, margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icon size={18} style={{ color: meta.color }} aria-hidden="true" /> {meta.title}
                </h2>
                {subtitle && <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0 0 12px' }}>{subtitle}</p>}

                <div id={`${uid}-hint`} aria-live="polite" style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 16, background: `color-mix(in srgb, ${hintColor} 8%, transparent)`, border: `1px solid color-mix(in srgb, ${hintColor} 20%, transparent)`, fontSize: '0.75rem', color: hintColor, fontWeight: 600, lineHeight: 1.5 }}>
                    {hint}
                </div>

                <label htmlFor={`${uid}-reason`} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                    <NotebookPen size={13} aria-hidden="true" /> Motivo (obrigatório)
                </label>
                <textarea
                    id={`${uid}-reason`}
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    rows={3}
                    autoFocus
                    placeholder={meta.placeholder}
                    aria-describedby={`${uid}-hint`}
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 10, fontSize: '0.8125rem', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit', resize: 'vertical' }}
                />

                {/* Depois do motivo: o foco inicial fica no campo obrigatório (1º focável do sheet). */}
                {showJustify && (
                    <label className={`mkp-check${effectiveJustified ? ' mkp-check--on' : ''}${justifyBlockedReason ? ' mkp-check--disabled' : ''}`} htmlFor={`${uid}-justified`} style={{ margin: '14px 0 0' }}>
                        <input
                            id={`${uid}-justified`}
                            type="checkbox"
                            checked={effectiveJustified}
                            disabled={!!justifyBlockedReason || saving}
                            onChange={e => setJustified(e.target.checked)}
                            aria-describedby={`${uid}-justified-hint`}
                        />
                        <span>
                            <span className="mkp-check__title">
                                {justifyBlockedReason
                                    ? 'Falta justificada — indisponível'
                                    : `Falta justificada — o cliente pode remarcar sem novo pagamento até ${preview!.ddmm}`}
                            </span>
                            <span id={`${uid}-justified-hint`} className="mkp-check__hint">
                                {justifyBlockedReason ?? 'Marque só se o estúdio aceitar o motivo. Sem justificativa, o valor é perdido na hora.'}
                            </span>
                        </span>
                    </label>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
                    <button key="cancel" type="button" onClick={onClose} disabled={saving} className="btn-admin-ghost">Cancelar</button>
                    <button
                        key="confirm"
                        type="button"
                        onClick={() => { if (canConfirm) onConfirm(reason.trim(), { justified: effectiveJustified }); }}
                        disabled={!canConfirm}
                        aria-busy={saving || undefined}
                        // Sólido no tom (classes globais de danger-dialog.css, contraste AA); desabilitado
                        // cai no cinza do .btn-admin-go:disabled.
                        className={`btn-admin-go ${kind === 'FALTA' && !effectiveJustified ? 'btn-danger-solid' : 'btn-warning-solid'}`}
                    >
                        {saving ? 'Salvando…' : <><Icon size={15} aria-hidden="true" /> {confirmLabel}</>}
                    </button>
                </div>
            </div>
        </BottomSheetModal>
    );
}
