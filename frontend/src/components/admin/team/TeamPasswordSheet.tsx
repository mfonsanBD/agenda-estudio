import { useId, useRef, useState } from 'react';
import { AlertTriangle, Eye, EyeOff, KeyRound, Lock } from 'lucide-react';
import { ApiError, staffApi, type StaffMember } from '../../../api/client';
import { getErrorMessage } from '../../../utils/errors';
import { CREDENTIALS_LOCKED_MESSAGE } from './teamPermissions';
import BottomSheetModal from '../../BottomSheetModal';
import Tooltip from '../../ui/Tooltip';
import '../../../styles/team.css';

interface TeamPasswordSheetProps {
    /** Só colaborador que nunca foi ADMIN (`credentialsLocked`; senão o servidor recusa com 403 ADMIN_TARGET_FORBIDDEN). */
    member: StaffMember;
    onClose: () => void;
    /** Senha definida: mensagem do servidor (para o toast). */
    onDone: (message: string) => void;
}

/**
 * "Definir senha" de um colaborador (POST /api/staff/:id/password, ≥ 8 caracteres). O servidor encerra as
 * sessões abertas da pessoa e registra na auditoria. Sem <form>: botões type="button"; Enter num campo
 * salva quando tudo confere. Trava só de requisição em voo; preventClose enquanto salva.
 */
export default function TeamPasswordSheet({ member, onClose, onDone }: TeamPasswordSheetProps) {
    const uid = useId();
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [show, setShow] = useState(false);
    const [touched, setTouched] = useState({ password: false, confirm: false });
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const inFlightRef = useRef(false);

    const passwordError = password.length < 8
        ? 'A senha precisa de pelo menos 8 caracteres.'
        : password.length > 128 ? 'A senha pode ter no máximo 128 caracteres.' : '';
    const confirmError = confirm !== password ? 'As duas senhas não são iguais.' : '';
    const valid = !passwordError && !confirmError;
    const firstName = member.name.trim().split(/\s+/)[0] || member.name;

    const save = async () => {
        if (!valid || inFlightRef.current) {
            setTouched({ password: true, confirm: true });
            return;
        }
        inFlightRef.current = true;
        setSaving(true);
        setError('');
        try {
            const res = await staffApi.setPassword(member.id, password);
            onDone(res.message || `Senha definida. As sessões abertas de ${member.name} foram encerradas.`);
        } catch (err) {
            // Lista desatualizada (ex.: a pessoa já foi administradora e a linha ainda mostrava o botão).
            setError(err instanceof ApiError && err.code === 'ADMIN_TARGET_FORBIDDEN' ? CREDENTIALS_LOCKED_MESSAGE : getErrorMessage(err));
        } finally {
            inFlightRef.current = false;
            setSaving(false);
        }
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') { e.preventDefault(); void save(); }
    };

    const showPasswordErr = touched.password && !!passwordError;
    const showConfirmErr = touched.confirm && !!confirmError && !passwordError;

    return (
        <BottomSheetModal isOpen onClose={onClose} hideHeader size="sm" className="admin-sheet"
            title={`Definir senha de ${member.name}`} preventClose={saving}>
            <div className="admin-modal-head">
                <h2 className="admin-modal-title">
                    <span className="admin-modal-title__icon"><KeyRound size={18} aria-hidden="true" /></span>
                    Definir senha
                </h2>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>
                    Nova senha de <strong style={{ color: 'var(--text-primary)' }}>{member.name}</strong>
                </p>
            </div>
            <div className="admin-modal-body">
                {error && <div className="admin-alert admin-alert--danger" role="alert">{error}</div>}
                <div style={{ display: 'grid', gap: '14px' }}>
                    <div className="admin-field">
                        <label className="admin-field__label" htmlFor={`${uid}-pass`}>Nova senha *</label>
                        <div className="team-pass-row">
                            <div className="admin-input-icon">
                                <Lock size={14} aria-hidden="true" />
                                <input id={`${uid}-pass`} type={show ? 'text' : 'password'} value={password} autoFocus
                                    onChange={e => setPassword(e.target.value)} onBlur={() => setTouched(t => ({ ...t, password: true }))}
                                    onKeyDown={onKeyDown} autoComplete="new-password" maxLength={128} placeholder="Mínimo de 8 caracteres"
                                    aria-required="true" aria-invalid={showPasswordErr}
                                    aria-describedby={showPasswordErr ? `${uid}-pass-err` : undefined}
                                    className={`form-input form-input--raised${showPasswordErr ? ' error' : ''}`} />
                            </div>
                            <Tooltip content={show ? 'Ocultar senha' : 'Mostrar senha'} describe={false}>
                                <button type="button" className="admin-icon-btn" aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}
                                    aria-pressed={show} onClick={() => setShow(s => !s)}>
                                    {show ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                                </button>
                            </Tooltip>
                        </div>
                        {showPasswordErr && <div id={`${uid}-pass-err`} className="field-error-message">{passwordError}</div>}
                    </div>
                    <div className="admin-field">
                        <label className="admin-field__label" htmlFor={`${uid}-confirm`}>Repita a senha *</label>
                        <div className="admin-input-icon">
                            <Lock size={14} aria-hidden="true" />
                            <input id={`${uid}-confirm`} type={show ? 'text' : 'password'} value={confirm}
                                onChange={e => setConfirm(e.target.value)} onBlur={() => setTouched(t => ({ ...t, confirm: true }))}
                                onKeyDown={onKeyDown} autoComplete="new-password" maxLength={128}
                                aria-required="true" aria-invalid={showConfirmErr}
                                aria-describedby={showConfirmErr ? `${uid}-confirm-err` : undefined}
                                className={`form-input form-input--raised${showConfirmErr ? ' error' : ''}`} />
                        </div>
                        {showConfirmErr && <div id={`${uid}-confirm-err`} className="field-error-message">{confirmError}</div>}
                    </div>
                    <div className="team-note team-note--warning">
                        <AlertTriangle size={14} aria-hidden="true" />
                        <span>
                            As sessões abertas de {firstName} são encerradas em todos os aparelhos: será preciso entrar de novo.
                            Passe a senha por um canal seguro; {firstName} também
                            pode entrar com um código enviado ao e-mail.
                        </span>
                    </div>
                </div>
                <div className="admin-actions-row">
                    <button key="cancel" type="button" className="btn-admin-ghost" onClick={onClose} disabled={saving}>Cancelar</button>
                    <button key="submit" type="button" className="btn-admin-go" disabled={saving} aria-busy={saving || undefined} onClick={() => void save()}>
                        {saving ? 'Salvando…' : <><KeyRound size={16} aria-hidden="true" /> Definir senha</>}
                    </button>
                </div>
            </div>
        </BottomSheetModal>
    );
}
