import { useState, useRef, useId, type CSSProperties } from 'react';
import { maskCep, lookupCep } from '../../../utils/cep';
import { MapPin, Search, Loader2 } from 'lucide-react';

export interface AddressValues {
    zipCode: string; address: string; addressNumber: string;
    complement: string; neighborhood: string; city: string; state: string;
}

interface AddressFieldsProps {
    values: AddressValues;
    onChange: (patch: Partial<AddressValues>) => void;
    /** Blur de um campo — usado p/ persistência inline no perfil. Ausente nos modais (salvam no submit). */
    onFieldBlur?: (field: keyof AddressValues) => void;
    /** Disparado após o ViaCEP preencher (com o patch já aplicado) — o perfil persiste o grupo. */
    onCepFilled?: (patch: Partial<AddressValues>) => void;
    /** Mostra o cabeçalho "Endereço" com ícone (default true). */
    heading?: boolean;
    /** Somente leitura (ex.: sem a permissão de editar o cadastro do cliente). */
    disabled?: boolean;
}

const labelStyle: CSSProperties = { fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '4px', display: 'block' };
const inputStyle: CSSProperties = { fontSize: '0.8125rem', padding: '8px 10px' };

/**
 * Campos de endereço estruturado controlados (CEP, rua, número, complemento, bairro,
 * cidade, UF). Digitar o CEP consulta o ViaCEP e autopreenche rua/bairro/cidade/UF.
 * Componente puramente controlado — quem salva é o pai (perfil: inline; modais: no submit).
 */
export default function AddressFields({ values, onChange, onFieldBlur, onCepFilled, heading = true, disabled = false }: AddressFieldsProps) {
    const [cepLoading, setCepLoading] = useState(false);
    const uid = useId();
    // Último CEP já consultado — evita refetch e reverter edições manuais ao re-blurar sem mudar.
    const lastCepRef = useRef('');

    const handleCepBlur = async () => {
        const digits = values.zipCode.replace(/\D/g, '');
        if (digits.length !== 8) { onFieldBlur?.('zipCode'); return; }
        if (digits === lastCepRef.current) return; // mesmo CEP → não refaz nem sobrescreve edições
        lastCepRef.current = digits;
        setCepLoading(true);
        const res = await lookupCep(digits);
        setCepLoading(false);
        if (!res) { lastCepRef.current = ''; onFieldBlur?.('zipCode'); return; }
        // Preserva o que o admin já digitou; só preenche o que veio do ViaCEP.
        const patch: Partial<AddressValues> = {
            address: res.street || values.address,
            neighborhood: res.neighborhood || values.neighborhood,
            city: res.city || values.city,
            state: res.state || values.state,
        };
        onChange(patch);
        onCepFilled?.({ zipCode: values.zipCode, ...patch });
    };

    const field = (f: keyof AddressValues, label: string, placeholder: string) => (
        <div>
            <label htmlFor={`${uid}-${f}`} style={labelStyle}>{label}</label>
            <input id={`${uid}-${f}`} className="form-input" value={values[f]} placeholder={placeholder}
                onChange={e => onChange({ [f]: e.target.value } as Partial<AddressValues>)}
                onBlur={() => onFieldBlur?.(f)}
                disabled={disabled}
                style={inputStyle} />
        </div>
    );

    return (
        <div>
            {heading && (
                <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.04em', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <MapPin size={13} aria-hidden="true" /> Endereço
                </div>
            )}
            <div style={{ display: 'grid', gap: '10px' }}>
                {/* CEP com autopreenchimento (ViaCEP) */}
                <div style={{ maxWidth: 220 }}>
                    <label htmlFor={`${uid}-zipCode`} style={labelStyle}>CEP</label>
                    <div style={{ position: 'relative' }}>
                        <input id={`${uid}-zipCode`} className="form-input" value={values.zipCode} inputMode="numeric" placeholder="00000-000"
                            aria-label="CEP (preenche o endereço automaticamente)"
                            onChange={e => onChange({ zipCode: maskCep(e.target.value) })}
                            onBlur={handleCepBlur}
                            disabled={disabled}
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLInputElement).blur(); } }}
                            style={{ ...inputStyle, paddingRight: 30 }} />
                        <span style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', display: 'inline-flex', color: 'var(--text-muted)', pointerEvents: 'none' }}>
                            {cepLoading ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} aria-hidden="true" /> : <Search size={14} aria-hidden="true" />}
                        </span>
                    </div>
                </div>
                {field('address', 'Rua / Logradouro', 'Ex: Rua das Flores')}
                <div className="admin-grid-2" style={{ gap: '10px' }}>
                    {field('addressNumber', 'Número', '123')}
                    {field('complement', 'Complemento', 'Apto, bloco…')}
                </div>
                {field('neighborhood', 'Bairro', 'Centro')}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 76px', gap: '10px' }}>
                    {field('city', 'Cidade', 'Rio de Janeiro')}
                    <div>
                        <label htmlFor={`${uid}-state`} style={labelStyle}>UF</label>
                        <input id={`${uid}-state`} className="form-input" value={values.state} placeholder="RJ" maxLength={2}
                            onChange={e => onChange({ state: e.target.value.toUpperCase() })}
                            onBlur={() => onFieldBlur?.('state')}
                            disabled={disabled}
                            style={{ ...inputStyle, textTransform: 'uppercase' }} />
                    </div>
                </div>
            </div>
        </div>
    );
}
