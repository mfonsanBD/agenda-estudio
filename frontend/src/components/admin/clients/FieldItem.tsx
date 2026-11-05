import { useState, useEffect } from 'react';
import { usersApi } from '../../../api/client';
import { useUI } from '../../../context/UIContext';
import { maskCpfCnpj, isValidCpfCnpj } from '../../../utils/mask';

const SAVE_ERROR = { message: 'Não foi possível salvar. Tente novamente.', type: 'error' as const };
const CPF_ERROR = { message: 'CPF/CNPJ inválido — confira os números.', type: 'error' as const };

interface FieldItemProps {
    label: string;
    value: string | null;
    field: string;
    userId: string;
    onSaved: () => void;
    /** Somente leitura (sem a permissão de editar o cadastro): mostra o valor, sem edição. */
    readOnly?: boolean;
}

/** Campo com edição inline (clique para editar, salva no blur/Enter). */
export default function FieldItem({ label, value, field, userId, onSaved, readOnly = false }: FieldItemProps) {
    const { showToast } = useUI();
    const [editing, setEditing] = useState(false);
    const [val, setVal] = useState(value || '');
    useEffect(() => setVal(value || ''), [value]);

    // O campo de CPF/CNPJ valida os dígitos verificadores da Receita antes de salvar (é opcional → vazio ok).
    const isCpf = field === 'cpfCnpj';
    const cpfDigits = isCpf ? val.replace(/\D/g, '') : '';
    const cpfInvalid = isCpf && cpfDigits.length > 0 && !isValidCpfCnpj(cpfDigits); // bloqueia salvar (qualquer inválido)
    const cpfShowError = isCpf && (cpfDigits.length === 11 || cpfDigits.length === 14) && !isValidCpfCnpj(cpfDigits); // vermelho só em tamanho completo

    const cancelEdit = () => { setVal(value || ''); setEditing(false); }; // saída não destrutiva: descarta a edição
    const save = async () => {
        if (cpfInvalid) { showToast(CPF_ERROR); return; } // Enter com inválido: mantém em edição para corrigir
        setEditing(false);
        const next = isCpf ? cpfDigits : val; // grava só os dígitos do documento
        if (next !== (value || '')) { try { await usersApi.update(userId, { [field]: next || null } as any); onSaved(); } catch { showToast(SAVE_ERROR); } }
    };
    // Clicar fora (blur) com documento inválido: descarta a edição e volta ao valor anterior (não trava o campo).
    const handleBlur = () => { if (cpfInvalid) { showToast(CPF_ERROR); cancelEdit(); } else save(); };
    return (
        <div>
            <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '4px' }}>{label}</div>
            {readOnly ? (
                <div style={{ fontSize: '0.8125rem', padding: '6px 8px', minHeight: '32px', color: val ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    {val ? (isCpf ? maskCpfCnpj(val) : val) : '—'}
                </div>
            ) : editing ? (
                <>
                    <input className="form-input" value={val}
                        onChange={e => setVal(isCpf ? maskCpfCnpj(e.target.value) : e.target.value)}
                        onBlur={handleBlur}
                        onKeyDown={e => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') cancelEdit(); }} autoFocus
                        aria-invalid={cpfShowError} inputMode={isCpf ? 'numeric' : undefined}
                        placeholder={isCpf ? '000.000.000-00' : undefined}
                        style={{ fontSize: '0.8125rem', padding: '6px 8px', borderColor: cpfShowError ? 'rgba(239,68,68,0.7)' : undefined }} />
                    {cpfShowError && <div style={{ fontSize: '0.6875rem', color: 'var(--danger)', fontWeight: 600, marginTop: '4px' }}>CPF/CNPJ inválido — confira os números.</div>}
                </>
            ) : (
                <div role="button" tabIndex={0} aria-label={`Editar ${label}`}
                    onClick={() => setEditing(true)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(true); } }}
                    style={{ cursor: 'pointer', fontSize: '0.8125rem', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px dashed var(--border-color)', minHeight: '32px', color: val ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    {val ? (isCpf ? maskCpfCnpj(val) : val) : 'Clique para editar'}
                </div>
            )}
        </div>
    );
}
