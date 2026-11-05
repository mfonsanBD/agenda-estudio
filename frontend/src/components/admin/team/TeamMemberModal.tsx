import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
    AlertTriangle, CheckCircle2, Eye, EyeOff, Info, Lock, Mail, Pencil, Save, ShieldCheck, Smartphone, UserCog, UserPlus, UserRound,
    BriefcaseBusiness, type LucideIcon,
} from 'lucide-react';
import {
    ApiError, staffApi,
    type StaffCatalog, type StaffCreateInput, type StaffMember, type StaffRole, type StaffUpdateInput,
} from '../../../api/client';
import { isPermissionKey, type PermissionKey } from '../../../constants/permissions';
import { useUI } from '../../../context/UIContext';
import { useWizardStep, ignoreMultiClick, wizardStepBodyStyle, wizardStepContentStyle } from '../../../hooks/useWizardStep';
import { getErrorMessage } from '../../../utils/errors';
import { maskEmail, maskPhone, translateError } from '../../../utils/mask';
import BottomSheetModal from '../../BottomSheetModal';
import BrandLoader from '../../ui/BrandLoader';
import DangerConfirmDialog from '../../ui/DangerConfirmDialog';
import Tooltip from '../../ui/Tooltip';
import WizardSteps from '../WizardSteps';
import TeamPermissionsStep from './TeamPermissionsStep';
import { closePermissions, memberCredentialsLocked, indexCatalog, modulesCountLabel, modulesWithAccess } from './teamPermissions';
import '../../../styles/team.css';

export const TEAM_WIZARD_STEPS = ['Dados', 'Acesso', 'Permissões'];
const TOTAL = TEAM_WIZARD_STEPS.length;

/** Etapa onde cada campo vive (erros da API e validação levam o admin até ela). */
const FIELD_STEP: Record<string, number> = {
    name: 1, email: 1, phone: 1, title: 1,
    role: 2, password: 2, sendAccessEmail: 2,
    permissions: 3,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const digits = (s: string) => s.replace(/\D/g, '');

interface TeamFormValues {
    name: string;
    email: string;
    phone: string;
    title: string;
    role: StaffRole;
    password: string;
    sendAccessEmail: boolean;
    permissions: PermissionKey[];
}

interface ValidationCtx {
    isEdit: boolean;
    emailEditable: boolean;
}

/** Erros de UMA etapa (vazio = válida). Mesmas regras do servidor (modules/staff/routes.ts). */
function validateStep(step: number, v: TeamFormValues, ctx: ValidationCtx): Record<string, string> {
    const e: Record<string, string> = {};
    if (step === 1) {
        const name = v.name.trim();
        if (name.length < 2) e.name = 'Informe o nome (mínimo de 2 caracteres).';
        else if (name.length > 120) e.name = 'O nome pode ter no máximo 120 caracteres.';
        if (ctx.emailEditable && !EMAIL_RE.test(v.email.trim())) e.email = 'Informe um e-mail válido.';
        const phone = digits(v.phone);
        if (phone.length > 0 && phone.length < 10) e.phone = 'Telefone incompleto: informe o DDD e o número.';
        if (v.title.trim().length > 60) e.title = 'O cargo pode ter no máximo 60 caracteres.';
    } else if (step === 2) {
        if (!ctx.isEdit && v.password.length > 0 && v.password.length < 8) e.password = 'A senha provisória precisa de pelo menos 8 caracteres.';
        else if (!ctx.isEdit && v.password.length > 128) e.password = 'A senha pode ter no máximo 128 caracteres.';
    }
    return e;
}

function firstInvalidStep(v: TeamFormValues, ctx: ValidationCtx): { step: number; errors: Record<string, string> } | null {
    let first = 0;
    const all: Record<string, string> = {};
    for (let s = 1; s <= TOTAL; s++) {
        const errs = validateStep(s, v, ctx);
        if (Object.keys(errs).length > 0) {
            if (!first) first = s;
            Object.assign(all, errs);
        }
    }
    return first ? { step: first, errors: all } : null;
}

interface MappedError {
    message: string;
    fieldErrors: Record<string, string>;
    step: number | null;
    /** INVALID_PERMISSION: chaves que o servidor não aceitou (são tiradas da seleção). */
    invalid?: string[];
    /** ADMIN_TARGET_FORBIDDEN: o e-mail volta ao anterior e trava (lista desatualizada: a pessoa já foi ADMIN). */
    lockCredentials?: boolean;
}

/** Erro da API → banner + campo + etapa (códigos estáveis do /api/staff). */
export function mapStaffApiError(err: unknown): MappedError {
    if (!(err instanceof ApiError) && !(err instanceof Error && err.name === 'ApiError')) {
        return { message: getErrorMessage(err), fieldErrors: {}, step: null };
    }
    const api = err as ApiError;
    const msg = api.message || 'Não foi possível salvar.';
    switch (api.code) {
        case 'EMAIL_TAKEN':
            return { message: 'Este e-mail já é usado por outra conta. Use outro e-mail.', fieldErrors: { email: 'Este e-mail já está em uso.' }, step: 1 };
        case 'EMAIL_IS_CLIENT':
            return { message: 'Este e-mail já é de um cliente. Use outro e-mail para a conta da equipe.', fieldErrors: { email: 'E-mail de um cliente: use outro.' }, step: 1 };
        case 'ADMIN_TARGET_FORBIDDEN':
            // TELA-1: vale também para quem HOJE é colaborador — o texto não o chama de "administrador".
            return {
                message: 'Por segurança, o e-mail de quem é ou já foi administrador não se altera pela tela Equipe. '
                    + 'O e-mail voltou ao anterior: salve de novo para gravar as outras alterações.',
                fieldErrors: {}, step: 1, lockCredentials: true,
            };
        case 'SELF_CHANGE_FORBIDDEN':
            return { message: msg, fieldErrors: { role: 'Ninguém altera o próprio tipo de acesso.' }, step: 2 };
        case 'LAST_ADMIN':
            return { message: msg, fieldErrors: { role: 'O sistema precisa de pelo menos um administrador ativo.' }, step: 2 };
        case 'INVALID_PERMISSION': {
            const invalid = Array.isArray(api.body?.invalid) ? (api.body!.invalid as unknown[]).map(String) : [];
            return {
                message: 'Algumas permissões não existem mais e foram desmarcadas. Confira a etapa Permissões e salve de novo.',
                fieldErrors: {}, step: 3, invalid,
            };
        }
        case 'STAFF_NOT_FOUND':
            return { message: 'Esta pessoa não está mais na equipe. Feche e atualize a lista.', fieldErrors: {}, step: null };
        default:
            break;
    }
    if (Array.isArray(api.details) && api.details.length > 0) {
        const fieldErrors: Record<string, string> = {};
        (api.details as { path?: (string | number)[]; message?: string }[]).forEach(issue => {
            const key = String((issue.path || [])[0] ?? '');
            if (key && !fieldErrors[key]) fieldErrors[key] = translateError(issue.message || 'Valor inválido.');
        });
        const steps = Object.keys(fieldErrors).map(k => FIELD_STEP[k]).filter((s): s is number => !!s);
        return { message: 'Dados inválidos — confira os campos destacados.', fieldErrors, step: steps.length ? Math.min(...steps) : null };
    }
    return { message: msg, fieldErrors: {}, step: null };
}

/**
 * Na troca de etapa: rola o sheet para o topo e põe o foco no contêiner da etapa (o botão clicado
 * some; sem isso o foco cairia no <body>). Não roda na montagem.
 */
function useStepFocus(step: number) {
    const ref = useRef<HTMLDivElement>(null);
    const prev = useRef(step);
    useEffect(() => {
        if (prev.current === step) return;
        prev.current = step;
        const el = ref.current;
        if (!el) return;
        const body = el.closest('.bottom-sheet-body');
        if (body) body.scrollTop = 0;
        el.focus({ preventScroll: true });
    }, [step]);
    return ref;
}

const hintStyle: CSSProperties = { fontSize: '0.6875rem', color: 'var(--text-muted)', lineHeight: 1.4 };

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
    inputMode?: 'text' | 'email' | 'tel';
    autoComplete?: string;
    autoFocus?: boolean;
    hint?: React.ReactNode;
    required?: boolean;
    readOnly?: boolean;
    maxLength?: number;
}

function TextField({ id, label, icon: Icon, value, onChange, onBlur, error, placeholder, type = 'text', inputMode, autoComplete, autoFocus, hint, required, readOnly, maxLength }: TextFieldProps) {
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
                    readOnly={readOnly}
                    maxLength={maxLength}
                    aria-required={required || undefined}
                    aria-invalid={!!error}
                    aria-describedby={describedBy}
                    aria-readonly={readOnly || undefined}
                    className={`form-input form-input--raised${error ? ' error' : ''}${readOnly ? ' team-input-locked' : ''}`}
                />
            </div>
            {hint && <div id={`${id}-hint`} style={hintStyle}>{hint}</div>}
            {error && <div id={`${id}-err`} className="field-error-message">{error}</div>}
        </div>
    );
}

const ROLE_OPTIONS: { key: StaffRole; icon: LucideIcon; label: string; desc: string }[] = [
    { key: 'COLABORADOR', icon: UserCog, label: 'Colaborador', desc: 'Acessa só o que você marcar na próxima etapa.' },
    { key: 'ADMIN', icon: ShieldCheck, label: 'Administrador', desc: 'Acesso total, inclusive Equipe, Integrações e E-mail.' },
];

export interface TeamMemberModalProps {
    /** null = novo membro. */
    member: StaffMember | null;
    catalog: StaffCatalog | null;
    catalogLoading: boolean;
    catalogError: string | null;
    onRetryCatalog: () => void;
    /** Administradores ATIVOS na lista (trava do "último administrador"). */
    activeAdmins: number;
    /** Etapa inicial (ex.: 3 ao abrir pelo "N módulos" da lista). */
    initialStep?: number;
    onClose: () => void;
    /** Salvou: o `member` que o servidor devolveu e a mensagem dele. */
    onSaved: (member: StaffMember, message: string) => void;
}

/**
 * "Novo membro" / "Editar membro" da Equipe — wizard canônico (design-system §3b) em 3 etapas:
 * Dados → Acesso → Permissões (para Administrador a etapa 3 vira um aviso de acesso total).
 * Anti-submit espúrio: sem <form>, todo botão type="button", keys distintas no rodapé, avanço adiado
 * 1 tick (`next()` do useWizardStep), guard `if (!isLast) return` no salvar, ignoreMultiClick no rodapé
 * e trava SÓ de requisição em voo (inFlightRef) — nunca trava por tempo. Na edição (allowJump) o
 * salvar valida TODAS as etapas. Casca: desktopAnchor="top" + floatingClose + preventClose ao salvar.
 * Erros da API levam à etapa certa: EMAIL_TAKEN/EMAIL_IS_CLIENT → Dados; ADMIN_TARGET_FORBIDDEN → Dados (o
 * e-mail volta ao salvo e trava); SELF_CHANGE_FORBIDDEN/LAST_ADMIN → Acesso; INVALID_PERMISSION → Permissões.
 * E-mail travado (`credentialsLocked` do servidor): quem é ou já foi administrador (E2/TELA-1).
 */
export default function TeamMemberModal({
    member, catalog, catalogLoading, catalogError, onRetryCatalog, activeAdmins, initialStep, onClose, onSaved,
}: TeamMemberModalProps) {
    const uid = useId();
    const { showToast } = useUI();
    const isEdit = !!member;
    const isSelf = !!member?.isSelf;
    const { step, next, back, goTo, isLast } = useWizardStep(TOTAL, { initialStep: initialStep ?? 1 });
    const stepRef = useStepFocus(step);
    const idx = useMemo(() => (catalog ? indexCatalog(catalog) : null), [catalog]);

    const initialPermissions = useMemo<PermissionKey[]>(
        () => (member && member.role === 'COLABORADOR' ? member.permissions.filter(isPermissionKey) : []),
        [member],
    );
    const [values, setValues] = useState<TeamFormValues>(() => ({
        name: member?.name ?? '',
        email: member?.email ?? '',
        phone: maskPhone(member?.phone ?? ''),
        title: member?.title ?? '',
        role: member?.role ?? 'COLABORADOR',
        password: '',
        sendAccessEmail: true,
        permissions: initialPermissions,
    }));
    // Catálogo chegou: aplica as dependências na seleção (o servidor faria o mesmo ao salvar).
    useEffect(() => {
        if (!idx) return;
        setValues(v => {
            const closed = closePermissions(v.permissions, idx);
            return closed.length === v.permissions.length && closed.every((k, i) => k === v.permissions[i]) ? v : { ...v, permissions: closed };
        });
    }, [idx]);

    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [touched, setTouched] = useState<Set<string>>(() => new Set());
    const [banner, setBanner] = useState('');
    // Campos a que o banner se refere: ele some sozinho quando todos forem corrigidos.
    const [bannerFields, setBannerFields] = useState<string[]>([]);
    // A cada erro novo o banner (topo do corpo) volta a ficar visível, mesmo se o salvar foi lá embaixo.
    const [bannerSeq, setBannerSeq] = useState(0);
    const bannerRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (bannerSeq > 0) bannerRef.current?.scrollIntoView({ block: 'nearest' });
    }, [bannerSeq]);
    const [saving, setSaving] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [confirmRole, setConfirmRole] = useState(false);
    const inFlightRef = useRef(false);

    // E2/TELA-1: e-mail (e senha) de quem é ou JÁ FOI administrador não se alteram pela tela Equipe (o servidor
    // responde 403 ADMIN_TARGET_FORBIDDEN). `serverLocked`: o servidor recusou com a lista desatualizada.
    const [serverLocked, setServerLocked] = useState(false);
    // UXT-08: decisão pura em teamPermissions (memberCredentialsLocked, com teste no eq-r5-front).
    const credsLocked = memberCredentialsLocked(member, { serverLocked });
    const emailEditable = !credsLocked;
    const ctx: ValidationCtx = { isEdit, emailEditable };
    // Mesmo critério da linha de "Enviar acesso" na TeamTable (ativo, com e-mail, não é a própria linha).
    const canSendAccess = isEdit && !isSelf && member!.active && !!member!.email;
    // Troca de e-mail de fato (sem diferenciar maiúsculas, como o servidor): apaga a senha e o vínculo com o Google.
    const emailChanged = isEdit && emailEditable
        && values.email.trim().toLowerCase() !== (member!.email ?? '').trim().toLowerCase();
    const lastActiveAdmin = isEdit && member!.role === 'ADMIN' && member!.active && activeAdmins <= 1;
    const roleLocked = isSelf;
    const roleChanged = isEdit && values.role !== member!.role;
    const needsCatalog = values.role === 'COLABORADOR';
    const catalogReady = !needsCatalog || !!catalog;

    const patch = (p: Partial<TeamFormValues>) => {
        setValues(v => ({ ...v, ...p }));
        const keys = Object.keys(p);
        setFieldErrors(fe => {
            if (!keys.some(k => k in fe)) return fe;
            const n = { ...fe };
            keys.forEach(k => { delete n[k]; });
            return n;
        });
    };
    const touch = (f: string) => setTouched(t => (t.has(f) ? t : new Set(t).add(f)));

    const visibleErrors = (s: number): Record<string, string> => {
        const live = validateStep(s, values, ctx);
        const out: Record<string, string> = {};
        Object.entries(live).forEach(([k, m]) => { if (touched.has(k)) out[k] = m; });
        return { ...out, ...fieldErrors };
    };
    const isStepValid = (s: number) => Object.keys(validateStep(s, values, ctx)).length === 0;
    const errors = visibleErrors(step);

    const goNext = () => {
        if (!isStepValid(step)) {
            const errs = validateStep(step, values, ctx);
            setTouched(t => { const n = new Set(t); Object.keys(errs).forEach(k => n.add(k)); return n; });
            return;
        }
        next(); // adiado 1 tick (setTimeout 0) e idempotente por etapa
    };

    /** Envia de fato. Erros vão para o banner/etapa (não lança: o diálogo de papel fecha e o form mostra). */
    const performSave = async () => {
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        setSaving(true);
        setBanner('');
        try {
            const name = values.name.trim();
            const email = values.email.trim().toLowerCase();
            const phone = digits(values.phone);
            const title = values.title.trim();
            const permissions = values.role === 'COLABORADOR' && idx ? closePermissions(values.permissions, idx) : [];

            if (!isEdit) {
                const payload: StaffCreateInput = { name, email, role: values.role, sendAccessEmail: values.sendAccessEmail };
                if (phone) payload.phone = phone;
                if (title) payload.title = title;
                if (values.role === 'COLABORADOR') payload.permissions = permissions;
                if (values.password) payload.password = values.password;
                const res = await staffApi.create(payload);
                onSaved(res.member, res.message || `${res.member.name} foi adicionado à equipe.`);
                return;
            }

            const m = member!;
            const payload: StaffUpdateInput = {};
            if (name !== m.name) payload.name = name;
            if (emailEditable && email !== (m.email ?? '').trim().toLowerCase()) payload.email = email;
            if (phone !== digits(m.phone ?? '')) payload.phone = phone || null;
            if (title !== (m.title ?? '')) payload.title = title || null;
            if (!roleLocked && values.role !== m.role) payload.role = values.role;
            if (values.role === 'COLABORADOR') {
                // Compara já com as dependências aplicadas: uma lista antiga gravada sem o fecho não vira "mudança".
                const before = m.role === 'COLABORADOR' && idx ? closePermissions(m.permissions, idx) : [];
                const same = before.length === permissions.length && before.every(k => permissions.includes(k));
                if (payload.role || !same) payload.permissions = permissions;
            }
            if (Object.keys(payload).length === 0) {
                showToast('Nada mudou: não havia alterações para salvar.');
                onClose();
                return;
            }
            const res = await staffApi.update(m.id, payload);
            onSaved(res.member, res.message || `Dados de ${res.member.name} atualizados.`);
        } catch (err) {
            const mapped = mapStaffApiError(err);
            if (mapped.lockCredentials) {
                // A transação foi desfeita inteira: o e-mail volta ao salvo e trava; o resto fica para salvar de novo.
                setServerLocked(true);
                setValues(v => ({ ...v, email: member?.email ?? '' }));
            }
            if (mapped.invalid && mapped.invalid.length > 0) {
                const bad = new Set(mapped.invalid);
                setValues(v => ({ ...v, permissions: v.permissions.filter(k => !bad.has(k)) }));
            }
            setFieldErrors(mapped.fieldErrors);
            setTouched(t => { const n = new Set(t); Object.keys(mapped.fieldErrors).forEach(k => n.add(k)); return n; });
            setBanner(mapped.message);
            setBannerFields(Object.keys(mapped.fieldErrors));
            setBannerSeq(n => n + 1);
            if (mapped.step) goTo(mapped.step);
        } finally {
            inFlightRef.current = false;
            setSaving(false);
        }
    };

    const handleSave = async () => {
        if (!isLast || inFlightRef.current) return; // rede de segurança: só salva na última etapa
        setBanner('');
        // allowJump (edição) permite chegar aqui sem passar pelas etapas anteriores: valida todas.
        const invalid = firstInvalidStep(values, ctx);
        if (invalid) {
            setFieldErrors(invalid.errors);
            setTouched(t => { const n = new Set(t); Object.keys(invalid.errors).forEach(k => n.add(k)); return n; });
            setBanner('Revise os campos destacados antes de salvar.');
            setBannerFields(Object.keys(invalid.errors));
            setBannerSeq(n => n + 1);
            goTo(invalid.step);
            return;
        }
        if (!catalogReady) {
            setBanner('As permissões ainda não carregaram. Tente de novo em instantes.');
            setBannerFields([]);
            setBannerSeq(n => n + 1);
            return;
        }
        if (roleChanged && !roleLocked) {
            setConfirmRole(true); // o diálogo chama performSave ao confirmar
            return;
        }
        await performSave();
    };

    const permCount = idx && catalog ? modulesWithAccess(catalog, values.permissions).length : 0;
    const displayName = values.name.trim() || member?.name || 'esta pessoa';
    const firstName = displayName.split(/\s+/)[0];

    // ─── Etapas ─────────────────────────────────────────
    const renderStep1 = () => (
        <div style={{ display: 'grid', gap: '16px' }}>
            <div className="admin-grid-2" style={{ gap: '12px' }}>
                <TextField id={`${uid}-name`} label="Nome" required icon={UserRound}
                    value={values.name} onChange={v => patch({ name: v })} onBlur={() => touch('name')}
                    error={errors.name} placeholder="Nome completo" autoComplete="off" autoFocus={!isEdit} maxLength={120} />
                <TextField id={`${uid}-title`} label="Cargo" icon={BriefcaseBusiness}
                    value={values.title} onChange={v => patch({ title: v })} onBlur={() => touch('title')}
                    error={errors.title} placeholder="Ex.: Recepção" autoComplete="off" maxLength={60}
                    hint={values.role === 'ADMIN'
                        // EQ-REQ-07: o menu mostra "Administrador" para o ADMIN (roleLabelOf ignora o cargo dele).
                        ? 'Opcional. Aparece na lista da equipe (no menu, o administrador aparece como “Administrador”).'
                        : 'Opcional. Aparece abaixo do nome no menu e na lista da equipe.'} />
            </div>
            <div className="admin-grid-2" style={{ gap: '12px' }}>
                <TextField id={`${uid}-email`} label="E-mail" required={emailEditable} icon={Mail} type="email" inputMode="email"
                    value={values.email} onChange={v => patch({ email: maskEmail(v) })} onBlur={() => touch('email')}
                    error={errors.email} placeholder="email@exemplo.com" autoComplete="off" readOnly={!emailEditable}
                    hint={!emailEditable
                        // EQ-REQ-07: a própria linha da lista não tem "Enviar acesso" — o texto não manda para ele.
                        // TELA-1: quem HOJE é colaborador mas já foi administrador tem texto próprio; "Enviar acesso"
                        // só é citado quando a linha da lista o mostra (ativo e com e-mail).
                        ? isSelf
                            ? <><Lock size={11} aria-hidden="true" style={{ verticalAlign: '-1px' }} /> O seu e-mail de administrador não se altera por aqui, por segurança.</>
                            : member!.role === 'ADMIN'
                                ? <><Lock size={11} aria-hidden="true" style={{ verticalAlign: '-1px' }} /> O e-mail de um administrador não se altera por aqui, por segurança.{canSendAccess && ' Use “Enviar acesso” na lista: o código de entrada vai para o e-mail dele.'}</>
                                : <><Lock size={11} aria-hidden="true" style={{ verticalAlign: '-1px' }} /> Esta pessoa já foi administradora: o e-mail e a senha não se alteram por aqui, por segurança.{canSendAccess && ' Use “Enviar acesso” na lista: o código de entrada vai para o e-mail dela.'}</>
                        : isEdit
                            // TELA-2: o servidor apaga a senha e o googleId junto com a troca (AUTH-03).
                            ? `Ao trocar o e-mail, as sessões abertas são encerradas, o e-mail antigo recebe um aviso, a senha é apagada e o vínculo com o Google é desfeito: a pessoa entra pelo código enviado ao e-mail novo${values.role === 'COLABORADOR' ? ' (ou use “Definir senha” depois de salvar)' : ''}.`
                            : 'É o login da pessoa. Não pode ser o e-mail de um cliente.'} />
                <TextField id={`${uid}-phone`} label="Telefone" icon={Smartphone} inputMode="tel"
                    value={values.phone} onChange={v => patch({ phone: maskPhone(v) })} onBlur={() => touch('phone')}
                    error={errors.phone} placeholder="(21) 99999-9999" autoComplete="off" hint="Opcional." />
            </div>
        </div>
    );

    const renderStep2 = () => (
        <div style={{ display: 'grid', gap: '16px' }}>
            <div className="admin-field">
                <span className="admin-field__label" id={`${uid}-role-label`}>Tipo de acesso</span>
                <div className="team-role-options" role="group" aria-labelledby={`${uid}-role-label`} aria-describedby={errors.role ? `${uid}-role-err` : undefined}>
                    {ROLE_OPTIONS.map(r => {
                        const on = values.role === r.key;
                        const RI = r.icon;
                        const blockedLast = !roleLocked && lastActiveAdmin && r.key === 'COLABORADOR';
                        const disabled = roleLocked || blockedLast;
                        const btn = (
                            <button key={r.key} type="button" className="team-role-option" aria-pressed={on} disabled={disabled}
                                onClick={() => patch({ role: r.key })}>
                                <span className="team-role-option__title"><RI size={15} aria-hidden="true" /> {r.label}</span>
                                {on && <CheckCircle2 size={16} className="team-role-option__check" aria-hidden="true" />}
                                <span className="team-role-option__desc">{r.desc}</span>
                            </button>
                        );
                        // Botão desabilitado não dispara eventos de ponteiro: a dica vai no <span> em volta.
                        return blockedLast ? (
                            <Tooltip key={r.key} content="É o único administrador ativo. Promova outra pessoa antes.">
                                <span className="team-disabled-wrap" tabIndex={0}>{btn}</span>
                            </Tooltip>
                        ) : btn;
                    })}
                </div>
                {errors.role && <div id={`${uid}-role-err`} className="field-error-message">{errors.role}</div>}
            </div>

            {roleLocked && (
                <div className="team-note">
                    <Lock size={14} aria-hidden="true" />
                    <span>Você não pode alterar o seu próprio acesso. Peça a outro administrador.</span>
                </div>
            )}
            {!roleLocked && lastActiveAdmin && (
                <div className="team-note">
                    <Info size={14} aria-hidden="true" />
                    <span>É o único administrador ativo: para torná-lo colaborador, promova outra pessoa a administrador antes.</span>
                </div>
            )}
            {roleChanged && (
                <div className="team-note team-note--warning">
                    <AlertTriangle size={14} aria-hidden="true" />
                    <span>
                        {values.role === 'ADMIN'
                            ? `${firstName} passará a ter acesso total, inclusive Equipe, Integrações e E-mail.`
                            : `${firstName} passará a acessar só os módulos marcados na etapa Permissões.`}
                        {' '}Ao salvar, as sessões abertas são encerradas e será preciso entrar de novo.
                    </span>
                </div>
            )}

            {!isEdit && (
                <>
                    <div className="admin-field">
                        <label className="admin-field__label" htmlFor={`${uid}-password`}>Senha provisória</label>
                        <div className="team-pass-row">
                            <div className="admin-input-icon">
                                <Lock size={14} aria-hidden="true" />
                                <input
                                    id={`${uid}-password`}
                                    type={showPassword ? 'text' : 'password'}
                                    value={values.password}
                                    onChange={e => patch({ password: e.target.value })}
                                    onBlur={() => touch('password')}
                                    placeholder="Mínimo de 8 caracteres"
                                    autoComplete="new-password"
                                    maxLength={128}
                                    aria-invalid={!!errors.password}
                                    aria-describedby={`${uid}-password-hint${errors.password ? ` ${uid}-password-err` : ''}`}
                                    className={`form-input form-input--raised${errors.password ? ' error' : ''}`}
                                />
                            </div>
                            <Tooltip content={showPassword ? 'Ocultar senha' : 'Mostrar senha'} describe={false}>
                                <button type="button" className="admin-icon-btn" aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                                    aria-pressed={showPassword} onClick={() => setShowPassword(s => !s)}>
                                    {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                                </button>
                            </Tooltip>
                        </div>
                        <div id={`${uid}-password-hint`} style={hintStyle}>Opcional. Sem senha, a pessoa entra com um código enviado ao e-mail.</div>
                        {errors.password && <div id={`${uid}-password-err`} className="field-error-message">{errors.password}</div>}
                    </div>

                    <label className="team-check">
                        <input type="checkbox" checked={values.sendAccessEmail} onChange={e => patch({ sendAccessEmail: e.target.checked })} />
                        <span className="team-check__text">
                            Enviar o e-mail de acesso agora
                            <small>Avisa que a pessoa entrou para a equipe e explica como entrar. O e-mail não leva senha.</small>
                        </span>
                    </label>
                </>
            )}

            {/* TELA-2: trocar o e-mail na etapa Dados apaga a senha — a nota da senha não pode dizer o contrário. */}
            {emailChanged && (
                <div className="team-note team-note--warning">
                    <AlertTriangle size={14} aria-hidden="true" />
                    <span>
                        O e-mail mudou na etapa Dados: ao salvar, a senha atual é apagada e o vínculo com o Google é desfeito.
                        {' '}{firstName} entra pelo código enviado ao e-mail novo
                        {values.role === 'COLABORADOR' ? '; para dar uma senha nova, use “Definir senha” na lista da equipe depois de salvar.' : '.'}
                    </span>
                </div>
            )}
            {!emailChanged && isEdit && member!.role === 'COLABORADOR' && values.role === 'COLABORADOR' && (
                <div className="team-note">
                    <Info size={14} aria-hidden="true" />
                    {credsLocked ? (
                        <span>
                            A senha de quem já foi administrador não se altera pela tela Equipe, por segurança.
                            {canSendAccess && ' Use “Enviar acesso” na lista: a pessoa entra pelo código enviado ao e-mail.'}
                        </span>
                    ) : (
                        <span>A senha não se altera aqui: use “Definir senha” ou “Enviar acesso” na lista da equipe.</span>
                    )}
                </div>
            )}
        </div>
    );

    const renderStep3 = () => {
        if (values.role === 'ADMIN') {
            return (
                <div style={{ display: 'grid', gap: '12px' }}>
                    <div className="team-note team-note--warning">
                        <ShieldCheck size={14} aria-hidden="true" />
                        {isSelf ? (
                            <span>
                                <strong>Você é administrador e tem acesso total</strong>, inclusive Equipe, Integrações e E-mail.
                                Não há o que marcar nesta etapa.
                            </span>
                        ) : (
                            <span>
                                <strong>Administrador tem acesso total</strong>, inclusive Equipe, Integrações e E-mail. Não há o que marcar
                                nesta etapa. Para limitar o acesso, volte à etapa Acesso e escolha Colaborador.
                            </span>
                        )}
                    </div>
                    {catalog && catalog.adminOnly.length > 0 && (
                        <div className="team-perm-summary">
                            <div className="team-perm-summary__title"><ShieldCheck size={16} aria-hidden="true" /> Só o administrador pode</div>
                            <ul>{catalog.adminOnly.map(a => <li key={a.key}>{a.label}</li>)}</ul>
                        </div>
                    )}
                </div>
            );
        }
        if (!catalog) {
            return catalogLoading ? (
                <div style={{ ...wizardStepBodyStyle, alignItems: 'center', padding: 'var(--space-8) 0' }}>
                    <BrandLoader size="inline" label="Carregando as permissões…" />
                </div>
            ) : (
                <div style={{ display: 'grid', gap: '10px' }}>
                    <div className="admin-alert admin-alert--danger" role="alert">
                        Não foi possível carregar a lista de permissões{catalogError ? `: ${catalogError}` : '.'}
                    </div>
                    <div><button type="button" className="btn-admin-ghost" onClick={onRetryCatalog}>Tentar de novo</button></div>
                </div>
            );
        }
        return (
            <TeamPermissionsStep
                catalog={catalog}
                value={values.permissions}
                onChange={p => patch({ permissions: p })}
                personName={values.name}
            />
        );
    };

    const stepValid = isStepValid(step);
    const showBanner = !!banner && (bannerFields.length === 0 || bannerFields.some(f => f in fieldErrors));
    const title = isEdit ? (isSelf ? 'Editar meus dados' : 'Editar membro da equipe') : 'Novo membro da equipe';
    const TitleIcon = isEdit ? Pencil : UserPlus;
    const submitLabel = isEdit ? 'Salvar alterações' : 'Adicionar à equipe';

    return (
        <BottomSheetModal isOpen onClose={onClose} hideHeader size="lg" desktopAnchor="top" floatingClose className="admin-sheet"
            title={title} preventClose={saving || confirmRole}>
            <div className="admin-modal-head">
                <h2 className="admin-modal-title">
                    <span className="admin-modal-title__icon"><TitleIcon size={18} aria-hidden="true" /></span>
                    {title}
                </h2>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>
                    {isEdit
                        ? <>Atualize os dados e o acesso de <strong style={{ color: 'var(--text-primary)' }}>{member!.name}</strong></>
                        : 'Quem é a pessoa, como ela entra e o que pode fazer na área administrativa'}
                </p>
                <WizardSteps steps={TEAM_WIZARD_STEPS} current={step} onStepClick={goTo} allowJump={isEdit} />
            </div>

            <div className="admin-modal-body">
                {showBanner && <div ref={bannerRef} className="admin-alert admin-alert--danger" role="alert">{banner}</div>}

                <div ref={stepRef} tabIndex={-1} role="group" aria-label={`Etapa ${step} de ${TOTAL}: ${TEAM_WIZARD_STEPS[step - 1]}`}
                    style={{ outline: 'none', ...wizardStepBodyStyle }}>
                    <div style={wizardStepContentStyle}>
                        {step === 1 && renderStep1()}
                        {step === 2 && renderStep2()}
                        {step === 3 && renderStep3()}
                    </div>

                    {step === 1 && (
                        <div className="admin-actions-row">
                            <button key="cancel" type="button" className="btn-admin-ghost" onClick={ignoreMultiClick(onClose)}>
                                Cancelar
                            </button>
                            <button key="next" type="button" className="btn-admin-go" disabled={!stepValid} onClick={ignoreMultiClick(goNext)}>
                                Próximo →
                            </button>
                        </div>
                    )}

                    {step === 2 && (
                        <div className="admin-actions-row admin-actions-row--between">
                            <button key="back" type="button" className="btn-admin-ghost" onClick={back}>
                                ← Voltar
                            </button>
                            <button key="next" type="button" className="btn-admin-go" disabled={!stepValid} onClick={ignoreMultiClick(goNext)}>
                                Próximo →
                            </button>
                        </div>
                    )}

                    {step === 3 && (
                        <div className="admin-actions-row admin-actions-row--between">
                            <button key="back" type="button" className="btn-admin-ghost" onClick={back} disabled={saving}>
                                ← Voltar
                            </button>
                            {/* ignoreMultiClick: o 2º clique de um duplo clique no "Próximo" da etapa 2 pode cair aqui
                                e NÃO pode salvar sem o admin ver as permissões. */}
                            <button key="submit" type="button" className="btn-admin-go" disabled={saving || !catalogReady}
                                aria-busy={saving || undefined} onClick={ignoreMultiClick(handleSave)}>
                                {saving ? 'Salvando…' : <>{isEdit ? <Save size={16} aria-hidden="true" /> : <UserPlus size={16} aria-hidden="true" />} {submitLabel}</>}
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* Mudar o tipo de acesso (D5: revoga as sessões). Reversível, com impacto → tom warning.
                O salvar roda dentro do diálogo; erros de campo voltam para a etapa certa do wizard. */}
            <DangerConfirmDialog
                isOpen={confirmRole}
                tone="warning"
                icon={values.role === 'ADMIN' ? ShieldCheck : UserCog}
                title={values.role === 'ADMIN' ? `Tornar ${displayName} administrador?` : `Tornar ${displayName} colaborador?`}
                description={values.role === 'ADMIN'
                    ? 'A pessoa passa a ter o mesmo acesso que você.'
                    : 'A pessoa deixa de ter acesso total.'}
                consequences={values.role === 'ADMIN'
                    ? [
                        'Passa a ter acesso total, inclusive Equipe, Integrações e E-mail.',
                        'As sessões abertas são encerradas: será preciso entrar de novo.',
                    ]
                    : [
                        `Passa a acessar só o que foi marcado na etapa Permissões (${modulesCountLabel(permCount).toLowerCase()}).`,
                        'Deixa de gerenciar a Equipe, Integrações e E-mail.',
                        'As sessões abertas são encerradas: será preciso entrar de novo.',
                    ]}
                confirmLabel={values.role === 'ADMIN' ? 'Tornar administrador' : 'Tornar colaborador'}
                loadingLabel="Salvando…"
                zIndex={1100}
                onConfirm={performSave}
                onClose={() => setConfirmRole(false)}
            />
        </BottomSheetModal>
    );
}
