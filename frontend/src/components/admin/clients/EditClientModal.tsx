import { useEffect, useRef, useState } from 'react';
import { usersApi, UserSummary } from '../../../api/client';
import { useUI } from '../../../context/UIContext';
import BottomSheetModal from '../../BottomSheetModal';
import DangerConfirmDialog from '../../ui/DangerConfirmDialog';
import BrandLoader from '../../ui/BrandLoader';
import WizardSteps from '../WizardSteps';
import { useWizardStep, ignoreMultiClick, wizardStepBodyStyle, wizardStepContentStyle } from '../../../hooks/useWizardStep';
import { Ban, Pencil, Save } from 'lucide-react';
import { maskPhone, maskCpfCnpj } from '../../../utils/mask';
import { parseSocialLinks, serializeSocialLinks, SOCIAL_NETWORKS } from './SocialLinksEditor';
import {
    CLIENT_WIZARD_STEPS, CLIENT_WIZARD_TOTAL, EMPTY_CLIENT_FORM, ADDRESS_KEYS,
    ClientWizardStepFields, findFirstInvalidClientStep, mapClientApiError, useClientForm, useStepViewReset, isSocialLinksJson,
    useClientWizardAccess,
} from './ClientWizardFields';

interface EditClientModalProps {
    user: UserSummary;
    onClose: () => void;
    onSaved: () => void;
}

/**
 * "Editar cliente" — wizard de 3 etapas (D11), mesma estrutura do "Novo cliente". Em modo edição o
 * stepper permite pular para qualquer etapa (allowJump); o salvar fica na última etapa e valida
 * TODAS as etapas. Anti-submit espúrio: sem <form>, type="button", keys distintas, avanço adiado,
 * guard de etapa, botões do rodapé ignoram o 2º clique de um clique duplo (ignoreMultiClick) e
 * nenhuma trava por tempo. A etapa abraça o conteúdo; no desktop o dialog fica ancorado no topo
 * (desktopAnchor="top") e o cabeçalho não pula entre as etapas.
 */
export default function EditClientModal({ user, onClose, onSaved }: EditClientModalProps) {
    const { showToast } = useUI();
    const { step, back, goTo, isLast } = useWizardStep(CLIENT_WIZARD_TOTAL);
    const form = useClientForm({
        ...EMPTY_CLIENT_FORM,
        name: user.name, email: user.email || '', phone: maskPhone(user.phone || ''),
        clientStatus: user.clientStatus || 'ACTIVE',
    }, 'edit');
    const { values, setValues } = form;
    const [editError, setEditError] = useState('');
    // Campos a que o banner se refere: some sozinho quando todos forem corrigidos.
    const [errorFields, setErrorFields] = useState<string[]>([]);
    const [editLoading, setEditLoading] = useState(false);
    // Começa true para o 1º paint já mostrar o carregamento (dados completos vêm do GET /users/:id).
    const [editFetching, setEditFetching] = useState(true);
    const [loadFailed, setLoadFailed] = useState(false);
    // Redes sociais como vieram do banco: base para preservar chaves extras (ex.: linkedin) e
    // para não reescrever o campo quando o admin não mexe nele.
    const [socialRaw, setSocialRaw] = useState<string | null>(null);
    const [socialTouched, setSocialTouched] = useState(false);
    const inFlightRef = useRef(false);
    const stepRef = useStepViewReset(step);
    // D3: mudar o status para "Bloqueado" é ação de perigo → confirmação antes de salvar.
    // Base = status que está salvo no banco (atualizado quando o GET /users/:id chega).
    const savedStatusRef = useRef<string>(user.clientStatus || 'ACTIVE');
    const [savedStatus, setSavedStatus] = useState<string>(user.clientStatus || 'ACTIVE');
    const [confirmBlock, setConfirmBlock] = useState(false);
    // D9 (Fase 1): cadastro = clientes.editar; e-mail de login, bloquear e desbloquear = clientes.acesso;
    // senha = só o ADMIN. Os campos que o acesso não permite ficam travados (com o motivo), e o servidor
    // recusa o resto com 403 (regra por valor alterado: reenviar o mesmo valor não exige nada).
    const access = useClientWizardAccess('edit', savedStatus);

    useEffect(() => {
        let cancelled = false;
        // Semente com os dados do resumo (lista); o restante chega do GET /users/:id.
        setValues({
            ...EMPTY_CLIENT_FORM,
            name: user.name, email: user.email || '', phone: maskPhone(user.phone || ''),
            clientStatus: user.clientStatus || 'ACTIVE',
        });
        setEditError('');
        setEditFetching(true);
        setLoadFailed(false);
        (async () => {
            try {
                const res = await usersApi.getById(user.id);
                const d = res.user;
                if (cancelled) return;
                const social = parseSocialLinks(d.socialLinks);
                setSocialRaw(d.socialLinks || null);
                setSocialTouched(false);
                savedStatusRef.current = d.clientStatus || 'ACTIVE';
                setSavedStatus(d.clientStatus || 'ACTIVE');
                setValues(prev => ({
                    ...prev,
                    notes: d.notes || '',
                    cpfCnpj: d.cpfCnpj ? maskCpfCnpj(d.cpfCnpj) : '',
                    address: d.address || '',
                    city: d.city || '',
                    state: d.state || '',
                    zipCode: d.zipCode || '',
                    addressNumber: d.addressNumber || '',
                    complement: d.complement || '',
                    neighborhood: d.neighborhood || '',
                    social: Object.fromEntries(SOCIAL_NETWORKS.map(s => [s.key, social[s.key] || ''])),
                    clientStatus: d.clientStatus || 'ACTIVE',
                }));
            } catch (err) {
                console.error('Failed to fetch user detail:', err);
                // Sem os dados completos, salvar apagaria CPF/endereço/notas: bloqueia a edição.
                if (!cancelled) setLoadFailed(true);
            } finally { if (!cancelled) setEditFetching(false); }
        })();
        return () => { cancelled = true; };
    }, [user, setValues]);

    const patch: typeof form.patch = p => {
        if ('social' in p) setSocialTouched(true);
        form.patch(p);
    };

    // Avanço adiado 1 tick (anti-submit espúrio) e com destino fixo: um clique duplo no
    // "Próximo" enfileira dois avanços para a MESMA etapa, sem pular a seguinte.
    const goNext = () => {
        if (editFetching || loadFailed || !form.isStepValid(step)) return;
        const target = step + 1;
        setTimeout(() => goTo(target), 0);
    };

    const handleEdit = async (blockConfirmed = false) => {
        if (!isLast || inFlightRef.current || editFetching || loadFailed) return; // rede de segurança
        setEditError('');
        // allowJump permite chegar aqui sem passar pelas etapas anteriores: valida todas.
        const invalid = findFirstInvalidClientStep(values, 'edit');
        if (invalid) {
            form.setFieldErrors(invalid.errors);
            form.touchMany(Object.keys(invalid.errors));
            setErrorFields(Object.keys(invalid.errors));
            setEditError('Revise os campos destacados antes de salvar.');
            goTo(invalid.step);
            return;
        }
        if (values.clientStatus === 'BLOCKED' && savedStatusRef.current !== 'BLOCKED' && !blockConfirmed) {
            setConfirmBlock(true); // o diálogo chama handleEdit(true) ao confirmar
            return;
        }
        inFlightRef.current = true;
        setEditLoading(true);
        try {
            const data: Parameters<typeof usersApi.update>[1] = {};
            const name = values.name.trim();
            const email = values.email.trim();
            // E-mail de login só com clientes.acesso (o campo fica travado sem ela).
            if (access.canEditLoginEmail && email && email !== user.email) data.email = email;
            // Sem `role` (D9). Senha de cliente: só o ADMIN.
            if (access.canSetPassword && values.password) data.password = values.password;
            if (values.clientStatus) data.clientStatus = values.clientStatus;
            // Campos do cadastro só com clientes.editar (travados sem ela — nem vão no corpo).
            if (access.canEditProfile) {
                if (name && name !== user.name) data.name = name;
                const phone = values.phone.replace(/\D/g, '');
                if (phone !== (user.phone || '')) data.phone = phone;
                // Notas: SEMPRE string ('' limpa). O backend não aceita null aqui (z.string().optional()).
                data.notes = values.notes;
                data.cpfCnpj = values.cpfCnpj.replace(/\D/g, '') || null;
                ADDRESS_KEYS.forEach(k => { data[k] = values[k].trim() || null; });
                if (socialTouched) {
                    const base = parseSocialLinks(socialRaw);
                    const edited = Object.fromEntries(Object.entries(values.social).map(([k, v]) => [k, v.trim()]));
                    data.socialLinks = serializeSocialLinks({ ...base, ...edited });
                }
            }
            await usersApi.update(user.id, data);
            showToast('Dados do cliente atualizados.');
            onClose();
            onSaved();
        } catch (err: unknown) {
            const mapped = mapClientApiError(err);
            form.setFieldErrors(mapped.fieldErrors);
            setErrorFields(Object.keys(mapped.fieldErrors));
            setEditError(mapped.message);
            if (mapped.step) goTo(mapped.step);
        } finally {
            inFlightRef.current = false;
            setEditLoading(false);
        }
    };

    const ready = !editFetching && !loadFailed;
    const stepValid = ready && form.isStepValid(step);
    const showError = !!editError && (errorFields.length === 0 || errorFields.some(f => f in form.fieldErrors));
    const legacySocialText = socialRaw && !isSocialLinksJson(socialRaw) ? socialRaw : null;

    return (
        <BottomSheetModal isOpen onClose={onClose} hideHeader size="md" desktopAnchor="top" floatingClose className="admin-sheet" title="Editar Cliente" preventClose={confirmBlock || editLoading}>
            <div className="admin-modal-head">
                <h2 className="admin-modal-title">
                    <span className="admin-modal-title__icon"><Pencil size={18} aria-hidden="true" /></span>
                    Editar Cliente
                </h2>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>
                    Atualize as informações de <strong style={{ color: 'var(--text-primary)' }}>{user.name}</strong>
                </p>
                <WizardSteps steps={CLIENT_WIZARD_STEPS} current={step} onStepClick={goTo} allowJump />
            </div>

            <div className="admin-modal-body">
                {showError && <div className="admin-alert admin-alert--danger" role="alert">{editError}</div>}

                {editFetching ? (
                    // Bloco de carregamento com respiro; o dialog (ancorado no topo) cresce para baixo quando
                    // os dados chegam. (role="status"/aria-live ficam no próprio BrandLoader.)
                    <div style={{ ...wizardStepBodyStyle, justifyContent: 'center', alignItems: 'center', padding: 'var(--space-10) 0' }}>
                        <BrandLoader size="inline" label="Carregando dados do cliente…" />
                    </div>
                ) : loadFailed ? (
                    <>
                        <div className="admin-alert admin-alert--danger" role="alert">
                            Não foi possível carregar os dados completos do cliente. Feche e tente de novo.
                        </div>
                        <div className="admin-actions-row">
                            <button key="cancel" type="button" className="btn-admin-ghost" onClick={onClose}>Fechar</button>
                        </div>
                    </>
                ) : (
                    <div ref={stepRef} tabIndex={-1} role="group" aria-label={`Etapa ${step} de ${CLIENT_WIZARD_TOTAL}: ${CLIENT_WIZARD_STEPS[step - 1]}`} style={{ outline: 'none', ...wizardStepBodyStyle }}>
                        <div style={wizardStepContentStyle}>
                            <ClientWizardStepFields
                                key={step}
                                step={step}
                                mode="edit"
                                values={values}
                                errors={form.visibleErrors(step)}
                                onPatch={patch}
                                onTouch={form.touch}
                                legacySocialText={legacySocialText}
                                access={access}
                            />
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
                                <button key="back" type="button" className="btn-admin-ghost" onClick={back} disabled={editLoading}>
                                    ← Voltar
                                </button>
                                {/* ignoreMultiClick: o 2º clique de um duplo clique no "Próximo" da etapa 2 pode cair
                                    aqui e NÃO pode salvar sem o admin ver Segurança e notas. */}
                                <button key="submit" type="button" className="btn-admin-go" disabled={!stepValid || editLoading} aria-busy={editLoading || undefined} onClick={ignoreMultiClick(() => handleEdit())}>
                                    {editLoading ? 'Salvando…' : <><Save size={16} aria-hidden="true" /> Salvar alterações</>}
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Bloquear cliente (D3: danger). Tem volta (status → Ativo): vermelho, mas sem o selo
                "Irreversível" — mesmo diálogo do ClientDataCard. O salvar roda dentro do diálogo
                (spinner); erros de campo continuam indo para o formulário, que reaparece se falhar. */}
            <DangerConfirmDialog
                isOpen={confirmBlock}
                tone="danger"
                irreversible={false}
                icon={Ban}
                title={`Bloquear ${values.name.trim() || user.name}?`}
                description="O cliente não conseguirá entrar no app. O status passa a Bloqueado junto com as demais alterações deste formulário."
                consequences={[
                    'O login por senha, por código no e-mail e pelo Google passa a ser recusado ("Sua conta está bloqueada").',
                    'Uma sessão já aberta é encerrada na hora.',
                    'Contratos, gravações e cobranças (inclusive a cobrança automática) continuam como estão.',
                    'Para liberar o acesso de novo, volte o status para Ativo.',
                ]}
                confirmLabel="Bloquear cliente"
                loadingLabel="Salvando…"
                zIndex={1100}
                onConfirm={() => handleEdit(true)}
                onClose={() => setConfirmBlock(false)}
            />
        </BottomSheetModal>
    );
}
