import { useId, useRef, useState } from 'react';
import { ShieldCheck, Check, CreditCard } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { authApi, usersApi, ApiError } from '../api/client';
import { usePermission } from '../hooks/usePermission';
import { maskCpfCnpj, isValidCpfCnpj } from '../utils/mask';
import { getErrorMessage } from '../utils/errors';

interface CpfCnpjPromptProps {
    /** Called after the document is successfully saved — re-run the payment here.
     *  Recebe os dígitos salvos para o chamador refletir localmente (evita re-perguntar em retry). */
    onSaved: (savedDoc?: string) => void;
    onCancel?: () => void;
    title?: string;
    subtitle?: string;
    /** Label of the primary button (e.g. "Salvar e gerar PIX"). */
    saveLabel?: string;
    /**
     * Admin cobrando um CLIENTE: coleta/salva o CPF do CLIENTE selecionado (não do admin logado).
     * Sem isto, o gate usava o CPF do usuário autenticado (o admin) e gravava no perfil dele.
     */
    client?: { id: string; name?: string | null; cpfCnpj?: string | null };
}

/**
 * Inline CPF/CNPJ collection card shown before a PIX charge when the user has no
 * valid document on file. Validates the check digits client-side, persists via
 * PATCH /auth/profile, refreshes the auth context, then calls onSaved().
 */
export default function CpfCnpjPrompt({ onSaved, onCancel, title, subtitle, saveLabel, client }: CpfCnpjPromptProps) {
    const uid = useId();
    const { user, updateUser } = useAuth();
    // Equipe cobrando (D3): gravar o CPF de um cliente que AINDA NÃO TEM documento vale com "Cobrar o
    // cliente" ou "Editar o cadastro"; TROCAR um documento já gravado (mesmo inválido) só com "Editar o
    // cadastro do cliente" (clientes.editar) — o servidor responde 403 PERMISSION_DENIED.
    const { can } = usePermission();
    // Quando `client` está presente (admin cobrando um cliente), o documento é do CLIENTE.
    const docOwnerCpf = client ? client.cpfCnpj : user?.cpfCnpj;
    const replacingClientDoc = !!client && !!(client.cpfCnpj || '').replace(/\D/g, '');
    const cannotReplaceDoc = replacingClientDoc && !can('clientes.editar');
    const [value, setValue] = useState(docOwnerCpf ? maskCpfCnpj(docOwnerCpf) : '');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [touched, setTouched] = useState(false);
    // Trava por requisição em voo (nunca por tempo): um 2º clique antes do re-render não salva duas vezes.
    const savingRef = useRef(false);

    const digits = value.replace(/\D/g, '');
    const valid = isValidCpfCnpj(value);
    const docType = digits.length > 11 ? 'CNPJ' : 'CPF';
    const showError = touched && digits.length >= 11 && !valid;

    const handleSave = async () => {
        if (!valid || saving || savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        setError('');
        try {
            if (client) {
                // Admin salvando o CPF do CLIENTE cobrado (PATCH /users/:id) — NUNCA toca no perfil do admin.
                await usersApi.update(client.id, { cpfCnpj: digits });
            } else {
                const res = await authApi.updateProfile({ cpfCnpj: digits });
                updateUser(res.user);
            }
            onSaved(digits);
        } catch (err: unknown) {
            const denied = !!client && err instanceof ApiError && err.status === 403 && err.code === 'PERMISSION_DENIED';
            setError(denied
                ? (replacingClientDoc
                    ? 'Este cliente já tem um CPF/CNPJ no cadastro. Para trocá-lo é preciso a permissão “Editar o cadastro do cliente”.'
                    : 'Você não tem permissão para salvar o CPF/CNPJ deste cliente.')
                : (getErrorMessage(err) || 'Não foi possível salvar. Tente novamente.'));
            setSaving(false);
        } finally {
            savingRef.current = false;
        }
    };

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center',
            padding: '8px 4px',
        }}>
            <div style={{
                width: 56, height: 56, borderRadius: 16, marginBottom: 14,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(34,197,94,0.12)', color: '#22c55e',
            }}>
                <CreditCard size={26} />
            </div>

            <h3 style={{ fontSize: '1.05rem', fontWeight: 700, margin: '0 0 6px' }}>
                {title || (client ? 'Confirme o CPF ou CNPJ do cliente' : 'Confirme seu CPF ou CNPJ')}
            </h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5, margin: '0 0 18px', maxWidth: 340 }}>
                {subtitle || (client
                    ? `A cobrança é emitida no nome ${client.name ? `de ${client.name}` : 'do cliente'} — informe o CPF ou CNPJ dele. Fica salvo no perfil do cliente para as próximas vezes.`
                    : 'Esta cobrança é emitida no seu nome — por isso precisamos do seu CPF ou CNPJ. É rápido, e fica salvo no seu perfil para as próximas vezes.')}
            </p>

            <div className="form-group" style={{ width: '100%', textAlign: 'left', marginBottom: showError || error ? 6 : 14 }}>
                <label className="form-label" htmlFor={`${uid}-cpfcnpj`}>CPF / CNPJ</label>
                <div style={{ position: 'relative' }}>
                    <input
                        id={`${uid}-cpfcnpj`}
                        className="form-input"
                        value={value}
                        onChange={e => { setValue(maskCpfCnpj(e.target.value)); if (error) setError(''); }}
                        onBlur={() => setTouched(true)}
                        inputMode="numeric"
                        autoComplete="off"
                        placeholder="000.000.000-00"
                        style={{
                            paddingRight: 40,
                            borderColor: showError ? '#ef4444' : valid ? '#22c55e' : undefined,
                        }}
                    />
                    {valid && (
                        <Check size={18} style={{
                            position: 'absolute', right: 13, top: '50%', transform: 'translateY(-50%)', color: '#22c55e',
                        }} />
                    )}
                </div>
            </div>

            {showError && (
                <div style={{ width: '100%', textAlign: 'left', fontSize: '0.75rem', color: '#ef4444', marginBottom: 12 }}>
                    {docType} inválido — confira os números.
                </div>
            )}
            {/* Equipe sem "Editar o cadastro do cliente" e o cliente já tem um documento (inválido) gravado:
                avisa antes de tentar — o servidor recusaria a troca. */}
            {cannotReplaceDoc && !error && (
                <div role="note" style={{ width: '100%', textAlign: 'left', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
                    O cadastro deste cliente já tem um CPF/CNPJ. Para corrigi-lo é preciso a permissão “Editar o cadastro do cliente” — peça a quem tem esse acesso.
                </div>
            )}
            {error && <div className="checkout-error" style={{ width: '100%', marginBottom: 12 }}>{error}</div>}

            <button
                key="cpf-save"
                type="button"
                // 2º clique de um clique duplo ignorado (teclado: detail 0 segue funcionando).
                onClick={(e) => { if (e.detail > 1) return; handleSave(); }}
                disabled={!valid || saving}
                className="checkout-pay-btn checkout-pay-btn--pix"
                style={{ width: '100%', opacity: !valid || saving ? 0.55 : 1, cursor: !valid || saving ? 'default' : 'pointer' }}
            >
                {saving
                    ? <><span className="spinner" style={{ width: 16, height: 16 }} /> Salvando...</>
                    : <><ShieldCheck size={16} /> {saveLabel || 'Salvar e continuar'}</>}
            </button>

            {onCancel && (
                <button key="cpf-cancel" type="button" onClick={(e) => { if (e.detail > 1) return; onCancel(); }} disabled={saving} className="checkout-cancel-btn" style={{ marginTop: 4 }}>
                    Cancelar
                </button>
            )}
        </div>
    );
}
