import { useRef, useState } from 'react';
import { usersApi } from '../../../api/client';
import { useUI } from '../../../context/UIContext';
import BottomSheetModal from '../../BottomSheetModal';
import WizardSteps from '../WizardSteps';
import { useWizardStep, ignoreMultiClick, wizardStepBodyStyle, wizardStepContentStyle } from '../../../hooks/useWizardStep';
import { UserPlus } from 'lucide-react';
import { serializeSocialLinks } from './SocialLinksEditor';
import {
    CLIENT_WIZARD_STEPS, CLIENT_WIZARD_TOTAL, EMPTY_CLIENT_FORM, ADDRESS_KEYS,
    ClientWizardStepFields, findFirstInvalidClientStep, mapClientApiError, useClientForm, useStepViewReset,
    useClientWizardAccess,
} from './ClientWizardFields';

interface CreateClientModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreated: () => void;
}

/**
 * "Novo cliente" — wizard de 3 etapas (D11): Dados pessoais → Contato e endereço → Segurança e notas.
 * Anti-submit espúrio: sem <form>, botões type="button" com keys distintas, avanço adiado
 * 1 tick (setTimeout 0), guard de etapa no cadastrar, botões do rodapé ignoram o 2º clique de um
 * clique duplo (ignoreMultiClick) e nenhuma trava por tempo. A etapa abraça o conteúdo; no desktop o
 * dialog fica ancorado no topo (desktopAnchor="top") e o cabeçalho não pula entre as etapas.
 */
export default function CreateClientModal({ isOpen, onClose, onCreated }: CreateClientModalProps) {
    const { showToast } = useUI();
    const { step, back, goTo, isLast } = useWizardStep(CLIENT_WIZARD_TOTAL);
    const form = useClientForm(EMPTY_CLIENT_FORM, 'create');
    const { values } = form;
    const [createError, setCreateError] = useState('');
    // Campos a que o banner se refere: some sozinho quando todos forem corrigidos.
    const [errorFields, setErrorFields] = useState<string[]>([]);
    const [creating, setCreating] = useState(false);
    // Trava de requisição EM ANDAMENTO (não é trava por tempo): evita 2 POSTs num duplo clique.
    const inFlightRef = useRef(false);
    const stepRef = useStepViewReset(step);
    // Cadastrar exige clientes.criar (guarda da tela). Nascer Bloqueado exige clientes.acesso; senha
    // de cliente só o ADMIN define (sem senha, o cliente entra com um código no e-mail).
    const access = useClientWizardAccess('create');

    // Avanço adiado 1 tick (anti-submit espúrio) e com destino fixo: um clique duplo no
    // "Próximo" enfileira dois avanços para a MESMA etapa, sem pular a seguinte.
    const goNext = () => {
        if (!form.isStepValid(step)) return;
        const target = step + 1;
        setTimeout(() => goTo(target), 0);
    };

    const handleCreate = async () => {
        if (!isLast || inFlightRef.current) return; // rede de segurança: só cadastra na última etapa
        setCreateError('');
        const invalid = findFirstInvalidClientStep(values, 'create');
        if (invalid) {
            form.setFieldErrors(invalid.errors);
            form.touchMany(Object.keys(invalid.errors));
            setErrorFields(Object.keys(invalid.errors));
            setCreateError('Revise os campos destacados antes de cadastrar.');
            goTo(invalid.step);
            return;
        }
        inFlightRef.current = true;
        setCreating(true);
        try {
            // Sem `role` (D9): /api/users só cadastra CLIENTE.
            const payload: Parameters<typeof usersApi.create>[0] = {
                name: values.name.trim(),
                email: values.email.trim(),
            };
            if (access.canSetPassword && values.password) payload.password = values.password;
            const phone = values.phone.replace(/\D/g, '');
            if (phone) payload.phone = phone;
            const doc = values.cpfCnpj.replace(/\D/g, '');
            if (doc) payload.cpfCnpj = doc;
            if (values.clientStatus !== 'ACTIVE' && !access.statusLock(values.clientStatus)) payload.clientStatus = values.clientStatus;
            const social = serializeSocialLinks(Object.fromEntries(Object.entries(values.social).map(([k, v]) => [k, v.trim()])));
            if (social) payload.socialLinks = social;
            ADDRESS_KEYS.forEach(k => { const v = values[k].trim(); if (v) payload[k] = v; });
            if (values.notes.trim()) payload.notes = values.notes;
            await usersApi.create(payload);
            showToast('Cliente cadastrado.');
            onCreated();
            onClose();
        } catch (err: unknown) {
            const mapped = mapClientApiError(err);
            form.setFieldErrors(mapped.fieldErrors);
            setErrorFields(Object.keys(mapped.fieldErrors));
            setCreateError(mapped.message);
            if (mapped.step) goTo(mapped.step);
        } finally {
            inFlightRef.current = false;
            setCreating(false);
        }
    };

    if (!isOpen) return null;

    const stepValid = form.isStepValid(step);
    const showError = !!createError && (errorFields.length === 0 || errorFields.some(f => f in form.fieldErrors));

    return (
        <BottomSheetModal isOpen onClose={onClose} hideHeader size="md" desktopAnchor="top" floatingClose className="admin-sheet" title="Novo Cliente" preventClose={creating}>
            <div className="admin-modal-head">
                <h2 className="admin-modal-title">
                    <span className="admin-modal-title__icon"><UserPlus size={18} aria-hidden="true" /></span>
                    Novo Cliente
                </h2>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>
                    Cadastre um novo cliente no sistema do estúdio
                </p>
                <WizardSteps steps={CLIENT_WIZARD_STEPS} current={step} onStepClick={goTo} />
            </div>

            <div className="admin-modal-body">
                {showError && <div className="admin-alert admin-alert--danger" role="alert">{createError}</div>}

                <div ref={stepRef} tabIndex={-1} role="group" aria-label={`Etapa ${step} de ${CLIENT_WIZARD_TOTAL}: ${CLIENT_WIZARD_STEPS[step - 1]}`} style={{ outline: 'none', ...wizardStepBodyStyle }}>
                    <div style={wizardStepContentStyle}>
                        <ClientWizardStepFields
                            key={step}
                            step={step}
                            mode="create"
                            values={values}
                            errors={form.visibleErrors(step)}
                            onPatch={form.patch}
                            onTouch={form.touch}
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
                            <button key="back" type="button" className="btn-admin-ghost" onClick={back} disabled={creating}>
                                ← Voltar
                            </button>
                            <button key="submit" type="button" className="btn-admin-go" disabled={!stepValid || creating} aria-busy={creating || undefined} onClick={ignoreMultiClick(handleCreate)}>
                                {creating ? 'Cadastrando…' : <><UserPlus size={16} aria-hidden="true" /> Cadastrar cliente</>}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </BottomSheetModal>
    );
}
