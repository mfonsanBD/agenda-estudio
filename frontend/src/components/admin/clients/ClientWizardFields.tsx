import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { UserRound, Mail, Lock, Smartphone, IdCard, NotebookPen, KeyRound, Youtube, Instagram, Music2, Globe, type LucideIcon } from 'lucide-react';
import AddressFields, { type AddressValues } from './AddressFields';
import { SOCIAL_NETWORKS, type SocialNetworkKey } from './SocialLinksEditor';
import { ApiError } from '../../../api/client';
import { getErrorMessage } from '../../../utils/errors';
import { maskPhone, maskEmail, maskCpfCnpj, translateError, isValidCpfCnpj } from '../../../utils/mask';
import { usePermission } from '../../../hooks/usePermission';
import Tooltip from '../../ui/Tooltip';

/**
 * Peças compartilhadas pelos wizards "Novo cliente" e "Editar cliente" (D11):
 * etapas, validação por etapa, mapeamento campo→etapa dos erros da API e os campos
 * de cada etapa. A casca (BottomSheetModal + WizardSteps + rodapé) fica em cada modal.
 */

export const CLIENT_WIZARD_STEPS = ['Dados pessoais', 'Contato e endereço', 'Segurança e notas'];
export const CLIENT_WIZARD_TOTAL = CLIENT_WIZARD_STEPS.length;

export type ClientWizardMode = 'create' | 'edit';

// O "Tipo de conta" saiu daqui (D9): este wizard só cadastra CLIENTE. A equipe (ADMIN/COLABORADOR) é
// criada na tela Equipe (/admin/equipe, só ADMIN), e o `role` nunca vai no corpo de /api/users.
export interface ClientFormValues extends AddressValues {
    name: string;
    cpfCnpj: string;
    clientStatus: string;
    email: string;
    phone: string;
    /** Redes do perfil: youtube/instagram/spotify/website (+ chaves extras preservadas na edição). */
    social: Record<string, string>;
    password: string;
    notes: string;
}

export const EMPTY_CLIENT_FORM: ClientFormValues = {
    name: '', cpfCnpj: '', clientStatus: 'ACTIVE',
    email: '', phone: '', social: {},
    zipCode: '', address: '', addressNumber: '', complement: '', neighborhood: '', city: '', state: '',
    password: '', notes: '',
};

export const ADDRESS_KEYS: (keyof AddressValues)[] = ['zipCode', 'address', 'addressNumber', 'complement', 'neighborhood', 'city', 'state'];

/** Etapa onde cada campo vive — usado para levar o admin ao campo com erro (validação local ou API). */
export const CLIENT_FIELD_STEP: Record<string, number> = {
    name: 1, cpfCnpj: 1, clientStatus: 1,
    email: 2, phone: 2, socialLinks: 2,
    zipCode: 2, address: 2, addressNumber: 2, complement: 2, neighborhood: 2, city: 2, state: 2,
    password: 3, notes: 3,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const onlyDigits = (s: string) => s.replace(/\D/g, '');

/** Erros de UMA etapa (vazio = etapa válida). Mesmas regras do backend (users.crud.ts). */
export function validateClientStep(step: number, v: ClientFormValues, mode: ClientWizardMode): Record<string, string> {
    const errs: Record<string, string> = {};
    if (step === 1) {
        if (v.name.trim().length < 2) errs.name = 'Informe o nome (mínimo de 2 caracteres).';
        const doc = onlyDigits(v.cpfCnpj);
        if (doc.length > 0 && !isValidCpfCnpj(doc)) errs.cpfCnpj = 'CPF/CNPJ inválido — confira os números.';
    } else if (step === 2) {
        if (!EMAIL_RE.test(v.email.trim())) errs.email = 'Informe um e-mail válido.';
    } else if (step === 3) {
        // Senha opcional também no cadastro (F8/D9): sem senha, o cliente entra com um código no e-mail.
        // Só o ADMIN vê o campo (o servidor recusa senha de cliente vinda de colaborador).
        void mode;
        if (v.password.length > 0 && v.password.length < 6) errs.password = 'A senha precisa de pelo menos 6 caracteres.';
    }
    return errs;
}

/** Primeira etapa inválida (com os erros de todas as etapas), ou null se tudo está válido. */
export function findFirstInvalidClientStep(v: ClientFormValues, mode: ClientWizardMode): { step: number; errors: Record<string, string> } | null {
    let first = 0;
    const all: Record<string, string> = {};
    for (let s = 1; s <= CLIENT_WIZARD_TOTAL; s++) {
        const e = validateClientStep(s, v, mode);
        if (Object.keys(e).length > 0) {
            if (!first) first = s;
            Object.assign(all, e);
        }
    }
    return first ? { step: first, errors: all } : null;
}

/**
 * Traduz um erro da API de usuários em { mensagem do banner, erros por campo, etapa do erro }.
 * - details do zod → cada `path` vira campo; etapa = menor etapa entre os campos.
 * - mensagem que cita CPF/CNPJ (409 duplicado ou 400 inválido) → campo CPF, etapa 1.
 * - demais 409 (e-mail já cadastrado/em uso) → campo e-mail, etapa 2.
 */
export function mapClientApiError(err: unknown): { message: string; fieldErrors: Record<string, string>; step: number | null } {
    if (!(err instanceof ApiError) && !(err instanceof Error && err.name === 'ApiError')) {
        return { message: getErrorMessage(err), fieldErrors: {}, step: null };
    }
    const apiErr = err as ApiError;
    const fieldErrors: Record<string, string> = {};
    let message = apiErr.message;
    if (Array.isArray(apiErr.details) && apiErr.details.length > 0) {
        (apiErr.details as { path?: (string | number)[]; message?: string }[]).forEach(issue => {
            const key = (issue.path || []).join('.');
            if (key) fieldErrors[key] = translateError(issue.message || 'Valor inválido.');
        });
        message = 'Dados inválidos — confira os campos destacados.';
    } else if (/cpf|cnpj/i.test(apiErr.message)) {
        fieldErrors.cpfCnpj = apiErr.message;
    } else if (apiErr.status === 409) {
        fieldErrors.email = apiErr.message;
    }
    const steps = Object.keys(fieldErrors).map(k => CLIENT_FIELD_STEP[k]).filter((s): s is number => !!s);
    return { message, fieldErrors, step: steps.length ? Math.min(...steps) : null };
}

/**
 * Estado do formulário do wizard de cliente: valores, erros vindos do salvar/API (limpos ao editar
 * o campo) e erros "ao vivo" dos campos já tocados.
 */
export function useClientForm(initial: ClientFormValues, mode: ClientWizardMode) {
    const [values, setValues] = useState<ClientFormValues>(initial);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [touched, setTouched] = useState<Set<string>>(() => new Set());

    const patch = useCallback((p: Partial<ClientFormValues>) => {
        setValues(v => ({ ...v, ...p }));
        const keys = Object.keys(p).map(k => (k === 'social' ? 'socialLinks' : k));
        setFieldErrors(fe => {
            if (!keys.some(k => k in fe)) return fe;
            const next = { ...fe };
            keys.forEach(k => { delete next[k]; });
            return next;
        });
    }, []);

    const touch = useCallback((field: string) => {
        setTouched(t => (t.has(field) ? t : new Set(t).add(field)));
    }, []);

    const touchMany = useCallback((fields: string[]) => {
        setTouched(t => { const n = new Set(t); fields.forEach(f => n.add(f)); return n; });
    }, []);

    /** Erros visíveis na etapa: API/salvar + validação ao vivo só dos campos já tocados. */
    const visibleErrors = (step: number): Record<string, string> => {
        const live = validateClientStep(step, values, mode);
        const out: Record<string, string> = {};
        const docLen = onlyDigits(values.cpfCnpj).length;
        Object.entries(live).forEach(([k, msg]) => {
            // CPF/CNPJ completo (11/14) e inválido aparece já durante a digitação.
            if (touched.has(k) || (k === 'cpfCnpj' && (docLen === 11 || docLen === 14))) out[k] = msg;
        });
        return { ...out, ...fieldErrors };
    };

    const isStepValid = (step: number) => Object.keys(validateClientStep(step, values, mode)).length === 0;

    return { values, setValues, patch, touch, touchMany, fieldErrors, setFieldErrors, visibleErrors, isStepValid };
}

/**
 * Na troca de etapa: rola o sheet para o topo e põe o foco no contêiner da etapa
 * (o botão clicado some; sem isso o foco cairia no <body>). Não roda na montagem.
 */
export function useStepViewReset(step: number) {
    const ref = useRef<HTMLDivElement>(null);
    // Compara com a etapa anterior (não com uma flag de montagem): no StrictMode (dev) o efeito roda 2x na
    // montagem e a flag tratava a 2ª como troca de etapa — o foco saía do 1º campo e o blur já mostrava erro.
    const prevStep = useRef(step);
    useEffect(() => {
        if (prevStep.current === step) return;
        prevStep.current = step;
        const el = ref.current;
        if (!el) return;
        const body = el.closest('.bottom-sheet-body');
        if (body) body.scrollTop = 0;
        el.focus({ preventScroll: true });
    }, [step]);
    return ref;
}

/** `true` quando o texto é um objeto JSON (formato do perfil); texto livre antigo → false. */
export function isSocialLinksJson(raw: string | null | undefined): boolean {
    if (!raw) return true;
    try {
        const obj: unknown = JSON.parse(raw);
        return !!obj && typeof obj === 'object' && !Array.isArray(obj);
    } catch { return false; }
}

// ─── Acesso de quem edita (permissões) ──────────────────

/**
 * O que quem está no wizard pode mexer (DECISÕES D9 — Fase 1: o wizard NÃO é reorganizado em blocos;
 * os campos de acesso só ficam travados). O servidor é a autoridade (403 PERMISSION_DENIED).
 */
export interface ClientWizardAccess {
    /** Cadastro: nome, CPF/CNPJ, telefone, redes, endereço, notas e situação Ativo/Inativo. */
    canEditProfile: boolean;
    /** E-mail de login (só na edição): clientes.acesso. No cadastro novo o e-mail é livre. */
    canEditLoginEmail: boolean;
    /** Senha do cliente: só o ADMIN (F8). Sem senha, o cliente entra com um código enviado ao e-mail. */
    canSetPassword: boolean;
    /** Motivo de cada opção de situação estar travada (null = liberada). */
    statusLock: (key: string) => string | null;
}

/** Acesso total (ADMIN) — padrão quando o modal não informa. */
export const FULL_CLIENT_WIZARD_ACCESS: ClientWizardAccess = {
    canEditProfile: true, canEditLoginEmail: true, canSetPassword: true, statusLock: () => null,
};

const LOCK_ACCESS_HINT = 'exige a permissão “Alterar o acesso ao app do cliente”.';
const LOCK_PROFILE_HINT = 'exige a permissão “Editar o cadastro do cliente”.';

/**
 * Acesso do usuário logado ao wizard de cliente.
 *   • create: cadastrar já exige clientes.criar (guarda da tela) — nascer Bloqueado exige clientes.acesso;
 *   • edit: cadastro = clientes.editar; e-mail de login, bloquear e desbloquear = clientes.acesso
 *     (`savedStatus` = situação gravada no banco, base da transição);
 *   • senha: só o ADMIN.
 */
export function useClientWizardAccess(mode: ClientWizardMode, savedStatus?: string | null): ClientWizardAccess {
    const { isAdmin, can } = usePermission();
    const canAccess = can('clientes.acesso');
    const canProfile = mode === 'create' || can('clientes.editar');
    return useMemo<ClientWizardAccess>(() => ({
        canEditProfile: canProfile,
        canEditLoginEmail: mode === 'create' || canAccess,
        canSetPassword: isAdmin,
        statusLock: (key: string) => {
            const saved = mode === 'create' ? 'ACTIVE' : (savedStatus || 'ACTIVE');
            if (key === saved) return null;
            if (key === 'BLOCKED' && !canAccess) return `Bloquear o acesso ao app ${LOCK_ACCESS_HINT}`;
            if (saved === 'BLOCKED' && !canAccess) return `Desbloquear ${LOCK_ACCESS_HINT}`;
            if (key !== 'BLOCKED' && saved !== 'BLOCKED' && !canProfile) return `Mudar a situação ${LOCK_PROFILE_HINT}`;
            return null;
        },
    }), [mode, savedStatus, canAccess, canProfile, isAdmin]);
}

// ─── Campos ─────────────────────────────────────────────

const hintStyle: CSSProperties = { fontSize: '0.6875rem', color: 'var(--text-muted)', lineHeight: 1.4 };

const STATUS_OPTIONS = [
    { key: 'ACTIVE', label: 'Ativo', color: 'var(--success)', bg: 'var(--success-bg)' },
    { key: 'INACTIVE', label: 'Inativo', color: 'var(--text-secondary)', bg: 'var(--neutral-bg)' },
    { key: 'BLOCKED', label: 'Bloqueado', color: 'var(--danger)', bg: 'var(--danger-bg)' },
];

const SOCIAL_UI: Record<SocialNetworkKey, { icon: LucideIcon; placeholder: string }> = {
    youtube: { icon: Youtube, placeholder: 'https://youtube.com/@canal' },
    instagram: { icon: Instagram, placeholder: 'https://instagram.com/perfil' },
    spotify: { icon: Music2, placeholder: 'https://open.spotify.com/show/…' },
    website: { icon: Globe, placeholder: 'https://seusite.com.br' },
};

interface TextFieldProps {
    id: string;
    label: string;
    icon: LucideIcon;
    value: string;
    onChange: (v: string) => void;
    onBlur?: () => void;
    error?: string;
    placeholder?: string;
    type?: string;
    inputMode?: 'text' | 'numeric' | 'email' | 'tel' | 'url';
    autoComplete?: string;
    autoFocus?: boolean;
    hint?: string;
    required?: boolean;
    /** Campo travado pela permissão (o hint explica o motivo). */
    disabled?: boolean;
}

function TextField({ id, label, icon: Icon, value, onChange, onBlur, error, placeholder, type = 'text', inputMode, autoComplete, autoFocus, hint, required, disabled }: TextFieldProps) {
    const describedBy = [error ? `${id}-err` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined;
    return (
        <div className="admin-field">
            <label className="admin-field__label" htmlFor={id}>{label}{required ? ' *' : ''}</label>
            <div className="admin-input-icon">
                <Icon size={14} aria-hidden="true" />
                <input
                    id={id}
                    type={type}
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    onBlur={onBlur}
                    placeholder={placeholder}
                    inputMode={inputMode}
                    autoComplete={autoComplete}
                    autoFocus={autoFocus}
                    disabled={disabled}
                    aria-required={required || undefined}
                    aria-invalid={!!error}
                    aria-describedby={describedBy}
                    className={`form-input form-input--raised${error ? ' error' : ''}`}
                />
            </div>
            {hint && <div id={`${id}-hint`} style={hintStyle}>{hint}</div>}
            {error && <div id={`${id}-err`} className="field-error-message">{error}</div>}
        </div>
    );
}

interface ClientWizardStepFieldsProps {
    step: number;
    mode: ClientWizardMode;
    values: ClientFormValues;
    errors: Record<string, string>;
    onPatch: (patch: Partial<ClientFormValues>) => void;
    onTouch: (field: string) => void;
    /** Edição: texto livre antigo do campo redes sociais (não-JSON), mostrado como aviso. */
    legacySocialText?: string | null;
    /** O que quem edita pode mexer (padrão: tudo). Ver `useClientWizardAccess`. */
    access?: ClientWizardAccess;
}

/** Campos da etapa `step` do wizard de cliente (sem rodapé — ele fica no modal). */
export function ClientWizardStepFields({ step, mode, values, errors, onPatch, onTouch, legacySocialText, access = FULL_CLIENT_WIZARD_ACCESS }: ClientWizardStepFieldsProps) {
    const uid = useId();
    const addressErrors = ADDRESS_KEYS.map(k => errors[k]).filter(Boolean);
    const lockProfile = !access.canEditProfile;
    const profileHint = lockProfile ? `Somente leitura: editar ${LOCK_PROFILE_HINT}` : undefined;

    if (step === 1) {
        return (
            <div style={{ display: 'grid', gap: '16px' }}>
                <div className="admin-grid-2" style={{ gap: '12px' }}>
                    <TextField id={`${uid}-name`} label="Nome" required icon={UserRound}
                        value={values.name} onChange={v => onPatch({ name: v })} onBlur={() => onTouch('name')}
                        error={errors.name ? translateError(errors.name) : undefined}
                        placeholder="Nome completo" autoComplete="off" autoFocus={mode === 'create'}
                        disabled={lockProfile} hint={profileHint} />
                    <TextField id={`${uid}-cpfCnpj`} label="CPF / CNPJ" icon={IdCard}
                        value={values.cpfCnpj} onChange={v => onPatch({ cpfCnpj: maskCpfCnpj(v) })} onBlur={() => onTouch('cpfCnpj')}
                        error={errors.cpfCnpj} placeholder="000.000.000-00" inputMode="numeric" autoComplete="off"
                        disabled={lockProfile}
                        hint="Opcional. Necessário para cobranças PIX." />
                </div>

                <div className="admin-field">
                    <span className="admin-field__label" id={`${uid}-status-label`}>Status</span>
                    <div role="group" aria-labelledby={`${uid}-status-label`} style={{ display: 'flex', gap: '6px' }}>
                        {STATUS_OPTIONS.map(s => {
                            const on = values.clientStatus === s.key;
                            // Bloquear/desbloquear = acesso ao app (clientes.acesso); Ativo/Inativo = cadastro.
                            const lock = on ? null : access.statusLock(s.key);
                            const btn = (
                                <button key={s.key} type="button" aria-pressed={on}
                                    onClick={() => { if (!lock) onPatch({ clientStatus: s.key }); }}
                                    disabled={!!lock}
                                    style={{
                                        flex: 1, width: '100%', minHeight: 40, padding: '8px 6px', borderRadius: '10px', cursor: lock ? 'not-allowed' : 'pointer',
                                        fontSize: '0.75rem', fontWeight: 700, fontFamily: 'inherit',
                                        background: on ? s.bg : 'var(--bg-elevated)',
                                        border: `1px solid ${on ? s.color : 'var(--border-default)'}`,
                                        color: on ? s.color : 'var(--text-secondary)',
                                        opacity: lock ? 0.5 : 1,
                                        transition: 'background-color 0.15s, border-color 0.15s, color 0.15s',
                                    }}>
                                    {s.label}
                                </button>
                            );
                            // Botão desabilitado não dispara eventos de ponteiro: a dica vai no span.
                            return lock ? (
                                <Tooltip key={s.key} content={lock}>
                                    <span style={{ flex: 1, display: 'flex' }} tabIndex={0}>{btn}</span>
                                </Tooltip>
                            ) : btn;
                        })}
                    </div>
                    {values.clientStatus === 'BLOCKED' && <div style={hintStyle}>Cliente bloqueado não consegue entrar no app.</div>}
                </div>
            </div>
        );
    }

    if (step === 2) {
        return (
            <div style={{ display: 'grid', gap: '18px' }}>
                <div className="admin-grid-2" style={{ gap: '12px' }}>
                    <TextField id={`${uid}-email`} label="E-mail" required icon={Mail} type="email" inputMode="email"
                        value={values.email} onChange={v => onPatch({ email: maskEmail(v) })} onBlur={() => onTouch('email')}
                        error={errors.email ? translateError(errors.email) : undefined}
                        placeholder="email@exemplo.com" autoComplete="off"
                        disabled={!access.canEditLoginEmail}
                        hint={!access.canEditLoginEmail
                            ? `É o e-mail de login do cliente: trocar ${LOCK_ACCESS_HINT}`
                            // TELA-2 (users.crud PATCH): troca de fato encerra as sessões, avisa o e-mail antigo e
                            // zera o googleId; a senha NÃO é apagada (só a da equipe é).
                            : mode === 'edit' ? 'É o e-mail de login do cliente: ao trocar, as sessões abertas dele são encerradas, o e-mail antigo recebe um aviso e o vínculo com o Google é desfeito. A senha, se houver, continua a mesma; o código de entrada passa a ir para o e-mail novo.' : undefined} />
                    <TextField id={`${uid}-phone`} label="Telefone" icon={Smartphone} inputMode="tel"
                        value={values.phone} onChange={v => onPatch({ phone: maskPhone(v) })}
                        error={errors.phone ? translateError(errors.phone) : undefined}
                        placeholder="(21) 99999-9999" autoComplete="off"
                        disabled={lockProfile} hint={profileHint} />
                </div>

                <div>
                    <div className="admin-section-header">Redes sociais</div>
                    <div className="admin-grid-2" style={{ gap: '12px' }}>
                        {SOCIAL_NETWORKS.map(s => (
                            <TextField key={s.key} id={`${uid}-social-${s.key}`} label={s.label} icon={SOCIAL_UI[s.key].icon}
                                type="url" inputMode="url" autoComplete="off"
                                value={values.social[s.key] || ''}
                                onChange={v => onPatch({ social: { ...values.social, [s.key]: v } })}
                                placeholder={SOCIAL_UI[s.key].placeholder}
                                disabled={lockProfile} />
                        ))}
                    </div>
                    {legacySocialText && (
                        <div style={{ ...hintStyle, marginTop: '8px' }}>
                            Anotação antiga (texto livre): <strong style={{ color: 'var(--text-secondary)', wordBreak: 'break-word' }}>{legacySocialText}</strong>. Ao preencher os campos acima, ela é substituída.
                        </div>
                    )}
                    {errors.socialLinks && <div className="field-error-message">{translateError(errors.socialLinks)}</div>}
                </div>

                <div>
                    <AddressFields
                        values={{ zipCode: values.zipCode, address: values.address, addressNumber: values.addressNumber, complement: values.complement, neighborhood: values.neighborhood, city: values.city, state: values.state }}
                        onChange={p => onPatch(p)}
                        disabled={lockProfile}
                    />
                    {addressErrors.length > 0 && <div className="field-error-message">Endereço: {addressErrors.map(e => translateError(e)).join(' ')}</div>}
                </div>
            </div>
        );
    }

    return (
        <div style={{ display: 'grid', gap: '16px' }}>
            {/* Senha de cliente: só o ADMIN define (F8). Para os demais, o cliente entra pelo código no e-mail. */}
            {access.canSetPassword ? (
                <TextField id={`${uid}-password`} label={mode === 'create' ? 'Senha (opcional)' : 'Nova senha'} icon={Lock} type="password"
                    value={values.password} onChange={v => onPatch({ password: v })} onBlur={() => onTouch('password')}
                    error={errors.password ? translateError(errors.password) : undefined}
                    placeholder="Mínimo 6 caracteres" autoComplete="new-password"
                    hint={mode === 'create' ? 'Sem senha, o cliente entra no app com um código enviado ao e-mail.' : 'Deixe vazio para manter a senha atual. Ao definir, as sessões abertas do cliente são encerradas.'} />
            ) : (
                <div className="admin-field">
                    <span className="admin-field__label" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <KeyRound size={13} aria-hidden="true" /> Acesso ao app
                    </span>
                    <div style={{ ...hintStyle, fontSize: '0.75rem', padding: '10px 12px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
                        O cliente entra no app com um código enviado ao e-mail de login. Só o administrador define senha de cliente.
                    </div>
                </div>
            )}

            <div className="admin-field">
                <label className="admin-field__label" htmlFor={`${uid}-notes`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <NotebookPen size={13} aria-hidden="true" /> Notas internas
                </label>
                <textarea
                    id={`${uid}-notes`}
                    value={values.notes}
                    onChange={e => onPatch({ notes: e.target.value })}
                    placeholder="Observações sobre o cliente (visíveis só para o estúdio)..."
                    disabled={lockProfile}
                    rows={3}
                    aria-invalid={!!errors.notes}
                    aria-describedby={errors.notes ? `${uid}-notes-err` : undefined}
                    className={`form-input form-input--raised${errors.notes ? ' error' : ''}`}
                    style={{ resize: 'vertical' }}
                />
                {errors.notes && <div id={`${uid}-notes-err`} className="field-error-message">{translateError(errors.notes)}</div>}
            </div>
        </div>
    );
}
