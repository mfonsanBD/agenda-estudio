import { useId, useMemo, useState } from 'react';
import { AlertTriangle, CheckCheck, ChevronDown, ListChecks, Lock, ShieldCheck } from 'lucide-react';
import type { StaffCatalog, StaffCatalogAction, StaffCatalogModule, StaffPermissionBadge } from '../../../api/client';
import type { PermissionKey } from '../../../constants/permissions';
import { ADMIN_NAV, filterNav } from '../../../config/nav';
import {
    BADGE_HINTS, BADGE_LABELS, LEVEL_LABELS,
    applyAll, applyLevel, availableLevels, chargesWithoutScreen, closePermissions, indexCatalog, isBoxModule, levelOptionLabel, lockedKeys,
    matchingPreset, moduleLevel, moduleSelection, summarize, toggleAction,
    type CatalogIndex,
} from './teamPermissions';

interface TeamPermissionsStepProps {
    catalog: StaffCatalog;
    /** Chaves marcadas (sempre com as dependências aplicadas). */
    value: PermissionKey[];
    onChange: (next: PermissionKey[]) => void;
    /** Nome de quem recebe o acesso (textos do resumo). */
    personName?: string;
}

/** Selo de uma ação ("mexe com dinheiro", "não tem volta"…). Informativo: dica no `title` (design-system §4b). */
export function PermissionBadge({ badge }: { badge: StaffPermissionBadge }) {
    return (
        <span className={`team-badge team-badge--${badge}`} title={BADGE_HINTS[badge]}>
            {badge === 'dinheiro' && <span aria-hidden="true">$</span>}
            {(badge === 'irreversivel' || badge === 'sensivel') && <AlertTriangle size={10} aria-hidden="true" />}
            {BADGE_LABELS[badge]}
        </span>
    );
}

interface ActionRowProps {
    action: StaffCatalogAction;
    checked: boolean;
    /** Ações marcadas que exigem esta (caixa travada). */
    lockedBy: StaffCatalogAction[] | undefined;
    requiresLabels: string[];
    /** Todas as ações que travam esta são do mesmo módulo (texto mais curto). */
    sameModuleOnly: boolean;
    onToggle: (on: boolean) => void;
}

function ActionRow({ action, checked, lockedBy, requiresLabels, sameModuleOnly, onToggle }: ActionRowProps) {
    const uid = useId();
    const isLocked = checked && !!lockedBy && lockedBy.length > 0;
    // Quem trava a caixa: do mesmo módulo ("as outras ações marcadas aqui") ou de outro (cita o nome).
    let lockText = '';
    if (isLocked) {
        const names = lockedBy!.map(a => `“${a.label}”`);
        lockText = lockedBy!.length === 1
            ? `Marcada porque ${names[0]} precisa dela.`
            : sameModuleOnly
                ? 'Marcada porque as outras ações marcadas aqui precisam dela. Para tirar, desmarque-as antes.'
                : `Marcada porque estas ações precisam dela: ${names.join(', ')}.`;
    }
    return (
        <label className={`team-perm-action${checked ? ' team-perm-action--on' : ''}${isLocked ? ' team-perm-action--locked' : ''}`}>
            <input
                type="checkbox"
                checked={checked}
                disabled={isLocked}
                onChange={e => onToggle(e.target.checked)}
                aria-describedby={`${uid}-desc${isLocked ? ` ${uid}-lock` : ''}`}
            />
            <span className="team-perm-action__body">
                <span className="team-perm-action__label">{action.label}</span>
                <span className="team-perm-action__desc" id={`${uid}-desc`}>
                    {action.description}
                    {!checked && requiresLabels.length > 0 && ` Marca junto: ${requiresLabels.join(', ')}.`}
                </span>
                {isLocked && (
                    <span className="team-perm-action__lock" id={`${uid}-lock`}>
                        <Lock size={11} aria-hidden="true" /> {lockText}
                    </span>
                )}
                {action.badges.length > 0 && (
                    <span className="team-perm-action__badges">
                        {action.badges.map(b => <PermissionBadge key={b} badge={b} />)}
                    </span>
                )}
            </span>
        </label>
    );
}

interface ModuleCardProps {
    module: StaffCatalogModule;
    value: PermissionKey[];
    selected: ReadonlySet<string>;
    locked: Map<string, StaffCatalogAction[]>;
    idx: CatalogIndex;
    expanded: boolean;
    onExpand: (open: boolean) => void;
    onChange: (next: PermissionKey[]) => void;
    adminOnly: { key: string; label: string }[];
}

function requiresLabelsOf(action: StaffCatalogAction, idx: CatalogIndex): string[] {
    return action.requires.map(k => idx.actionOf.get(k)?.label).filter((l): l is string => !!l);
}

/** Linha de um módulo com seletor de nível (Sem acesso / Ver / Ver e editar / Tudo… / Personalizado). */
function LevelModuleCard({ module, value, selected, locked, idx, expanded, onExpand, onChange }: ModuleCardProps) {
    const uid = useId();
    const levels = availableLevels(module);
    const level = moduleLevel(module, selected);
    const count = moduleSelection(module, selected).size;
    const options = ['nenhum' as const, ...levels];
    // Caixas deste módulo travadas por ação de OUTRO módulo (ex.: "Ver clientes", exigida pela cobrança
    // automática): o nível não desce abaixo delas — a nota explica por que o "Sem acesso" não as tira.
    const crossLocks = module.actions.flatMap(a => {
        const by = (locked.get(a.key) ?? []).filter(x => idx.moduleOf.get(x.key)?.key !== module.key);
        return by.length > 0 ? [{ action: a, by }] : [];
    });
    return (
        <section className={`team-perm-module${count > 0 ? ' team-perm-module--on' : ''}`} aria-labelledby={`${uid}-title`}>
            <div className="team-perm-module__head">
                <div style={{ minWidth: 0 }}>
                    <div className="team-perm-module__title" id={`${uid}-title`}>{module.label}</div>
                    <div className="team-perm-module__desc">{module.description}</div>
                </div>
                <span className="team-perm-module__count">{count} de {module.actions.length} {module.actions.length === 1 ? 'ação' : 'ações'}</span>
            </div>

            <div className="admin-pills team-perm-module__levels" role="radiogroup" aria-label={`Nível de acesso em ${module.label}`}>
                {options.map(l => (
                    <button
                        key={l}
                        type="button"
                        role="radio"
                        aria-checked={level === l}
                        className={`admin-pill${level === l ? ' admin-pill--active' : ''}`}
                        onClick={() => onChange(applyLevel(value, module, l, idx))}
                    >
                        {levelOptionLabel(module, l)}
                    </button>
                ))}
                {level === 'personalizado' && (
                    <button
                        key="personalizado"
                        type="button"
                        role="radio"
                        aria-checked="true"
                        className="admin-pill admin-pill--custom"
                        onClick={() => onExpand(true)}
                    >
                        {LEVEL_LABELS.personalizado}
                    </button>
                )}
            </div>

            {crossLocks.map(({ action, by }) => (
                <div key={action.key} className="team-perm-cross-lock">
                    <Lock size={11} aria-hidden="true" />
                    <span>
                        “{action.label}” continua marcada porque {by.map(x => `“${x.label}” (${idx.moduleOf.get(x.key)?.label ?? ''})`).join(', ')} precisa dela.
                    </span>
                </div>
            ))}

            <button
                type="button"
                className="team-perm-module__toggle"
                aria-expanded={expanded}
                aria-controls={`${uid}-actions`}
                onClick={() => onExpand(!expanded)}
            >
                {expanded ? 'Esconder as ações' : 'Escolher ação por ação'}
                <ChevronDown size={14} aria-hidden="true" />
            </button>

            {expanded && (
                <div className="team-perm-actions" id={`${uid}-actions`}>
                    {module.actions.map(a => (
                        <ActionRow
                            key={a.key}
                            action={a}
                            checked={selected.has(a.key)}
                            lockedBy={locked.get(a.key)}
                            requiresLabels={requiresLabelsOf(a, idx)}
                            sameModuleOnly={(locked.get(a.key) ?? []).every(x => idx.moduleOf.get(x.key)?.key === module.key)}
                            onToggle={on => onChange(toggleAction(value, a.key, on, idx))}
                        />
                    ))}
                </div>
            )}
        </section>
    );
}

/** Configurações: uma caixa por seção (sem nível), "marcar todas" e as seções exclusivas do admin em cinza. */
function BoxModuleCard({ module, value, selected, locked, idx, onChange, adminOnly }: ModuleCardProps) {
    const uid = useId();
    const count = moduleSelection(module, selected).size;
    const all = count === module.actions.length;
    return (
        <section className={`team-perm-module${count > 0 ? ' team-perm-module--on' : ''}`} aria-labelledby={`${uid}-title`}>
            <div className="team-perm-module__head">
                <div style={{ minWidth: 0 }}>
                    <div className="team-perm-module__title" id={`${uid}-title`}>{module.label}</div>
                    <div className="team-perm-module__desc">{module.description}</div>
                </div>
                <button
                    type="button"
                    className="team-perm-module__all"
                    aria-pressed={all}
                    onClick={() => onChange(applyAll(value, module, !all, idx))}
                >
                    <CheckCheck size={14} aria-hidden="true" />
                    {all ? 'Desmarcar todas' : 'Marcar todas'}
                </button>
            </div>
            <div className="team-perm-actions" id={`${uid}-actions`}>
                {module.actions.map(a => (
                    <ActionRow
                        key={a.key}
                        action={a}
                        checked={selected.has(a.key)}
                        lockedBy={locked.get(a.key)}
                        requiresLabels={requiresLabelsOf(a, idx)}
                        sameModuleOnly={(locked.get(a.key) ?? []).every(x => idx.moduleOf.get(x.key)?.key === module.key)}
                        onToggle={on => onChange(toggleAction(value, a.key, on, idx))}
                    />
                ))}
                {adminOnly.length > 0 && (
                    <>
                        <div className="team-perm-admin-title">Só o administrador</div>
                        {adminOnly.map(a => (
                            <div key={a.key} className="team-perm-action team-perm-action--admin">
                                <Lock size={14} aria-hidden="true" />
                                <span className="team-perm-action__body">
                                    <span className="team-perm-action__label">{stripConfigPrefix(a.label)}</span>
                                    <span className="team-perm-action__desc">Só o administrador — não dá para liberar para colaborador.</span>
                                </span>
                            </div>
                        ))}
                    </>
                )}
            </div>
        </section>
    );
}

/** "Configurações: E-mail (…)" → "E-mail (…)" dentro do card de Configurações. */
function stripConfigPrefix(label: string): string {
    const s = label.replace(/^Configurações:\s*/i, '');
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Etapa "Permissões" do TeamMemberModal (só para Colaborador). Tudo vem do catálogo do servidor:
 * - chips de perfil modelo (escolher só PREENCHE as caixas; "Começar do zero" limpa);
 * - uma linha por módulo com o seletor de nível e as ações em caixas, com os selos
 *   ("mexe com dinheiro", "não tem volta", "ação sensível", "o cliente vê isto");
 * - Configurações em caixas + "Marcar todas"; as seções exclusivas do admin em cinza;
 * - dependências travadas (marcar "Criar agendamento" marca e trava "Ver agenda…");
 * - resumo final com o que mexe com dinheiro, o que não tem volta e o que o cliente vê.
 */
export default function TeamPermissionsStep({ catalog, value, onChange, personName }: TeamPermissionsStepProps) {
    const uid = useId();
    const idx = useMemo(() => indexCatalog(catalog), [catalog]);
    const selected = useMemo(() => new Set<string>(value), [value]);
    const locked = useMemo(() => lockedKeys(selected, idx), [selected, idx]);
    // Módulos com as caixas abertas: começa com os "Personalizado" (a seleção não bate com um nível).
    const [expanded, setExpanded] = useState<Set<string>>(
        () => new Set(catalog.modules.filter(m => !isBoxModule(m) && moduleLevel(m, selected) === 'personalizado').map(m => m.key)),
    );
    const activePreset = matchingPreset(catalog, value, idx);
    const presetInfo = catalog.presets.find(p => p.key === activePreset);
    const summary = useMemo(() => summarize(catalog, value), [catalog, value]);

    const configAdminOnly = catalog.adminOnly.filter(a => a.key.startsWith('config.'));
    const otherAdminOnly = catalog.adminOnly.filter(a => !a.key.startsWith('config.'));

    const setExpand = (key: string, open: boolean) => setExpanded(prev => {
        const next = new Set(prev);
        if (open) next.add(key); else next.delete(key);
        return next;
    });

    const who = personName?.trim() ? personName.trim().split(/\s+/)[0] : 'a pessoa';

    // FE-4 (avisos não bloqueantes; o D2 permite salvar assim):
    //  - nenhuma tela abre com esta seleção (o mesmo filtro do menu, sem o Painel) → painel vazio;
    //  - cobrança de BALCÃO sem um módulo de onde cobrar: os botões ficam em Agendamentos (criar) e Contratos
    //    (ver). A cobrança automática sozinha não conta (TELA-5): o interruptor fica no perfil do cliente.
    const opensNoScreen = useMemo(
        () => value.length > 0 && filterNav(ADMIN_NAV, k => selected.has(k), false).every(item => item.to === '/dashboard'),
        [value.length, selected],
    );
    const chargesNoScreen = chargesWithoutScreen(selected);
    const autoChargeToo = chargesNoScreen && selected.has('cobrancas.automatica');

    return (
        <div className="team-perm">
            <div>
                <span className="admin-field__label" id={`${uid}-presets`}>Começar de um perfil modelo</span>
                <div className="team-presets" role="group" aria-labelledby={`${uid}-presets`}>
                    {catalog.presets.map(p => (
                        <button
                            key={p.key}
                            type="button"
                            className={`admin-pill${activePreset === p.key ? ' admin-pill--active' : ''}`}
                            aria-pressed={activePreset === p.key}
                            onClick={() => onChange(closePermissions(p.permissions, idx))}
                        >
                            {p.label}
                        </button>
                    ))}
                    <button
                        key="zero"
                        type="button"
                        className={`admin-pill${value.length === 0 ? ' admin-pill--active' : ''}`}
                        aria-pressed={value.length === 0}
                        onClick={() => onChange([])}
                    >
                        Começar do zero
                    </button>
                </div>
                <p className="team-preset-desc">
                    {presetInfo
                        ? presetInfo.description
                        : 'Escolher um perfil só preenche as caixas abaixo (troca o que estiver marcado). Depois ajuste o que quiser.'}
                </p>
            </div>

            {catalog.modules.map(m => {
                const props: ModuleCardProps = {
                    module: m, value, selected, locked, idx,
                    expanded: expanded.has(m.key),
                    onExpand: open => setExpand(m.key, open),
                    onChange,
                    adminOnly: configAdminOnly,
                };
                return isBoxModule(m)
                    ? <BoxModuleCard key={m.key} {...props} />
                    : <LevelModuleCard key={m.key} {...props} />;
            })}

            {otherAdminOnly.length > 0 && (
                <section className="team-perm-module" aria-labelledby={`${uid}-admin-only`}>
                    <div className="team-perm-module__title" id={`${uid}-admin-only`}>Sempre só do administrador</div>
                    <div className="team-perm-module__desc">Estas áreas não aparecem para nenhum colaborador.</div>
                    <div className="team-perm-actions">
                        {otherAdminOnly.map(a => (
                            <div key={a.key} className="team-perm-action team-perm-action--admin">
                                <ShieldCheck size={14} aria-hidden="true" />
                                <span className="team-perm-action__body">
                                    <span className="team-perm-action__label">{a.label}</span>
                                </span>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            <section className="team-perm-summary" aria-labelledby={`${uid}-summary`}>
                <div className="team-perm-summary__title" id={`${uid}-summary`}>
                    <ListChecks size={16} aria-hidden="true" /> Resumo do acesso
                </div>
                {summary.lines.length === 0 ? (
                    <div className="team-note team-note--warning">
                        <AlertTriangle size={14} aria-hidden="true" />
                        <span>Sem nenhum módulo, {who} só verá o painel vazio. Dá para salvar assim e liberar depois.</span>
                    </div>
                ) : (
                    <ul>
                        {summary.lines.map(l => (
                            <li key={l.module.key}><strong>{l.module.label}:</strong> {l.text}</li>
                        ))}
                    </ul>
                )}
                {(opensNoScreen || chargesNoScreen) && (
                    <div className="team-note team-note--warning">
                        <AlertTriangle size={14} aria-hidden="true" />
                        <span>
                            {opensNoScreen && <>Estas permissões não abrem nenhuma tela: {who} só verá o painel vazio. </>}
                            {chargesNoScreen && <>Os botões de cobrança ficam em Agendamentos e Contratos. Sem “Criar agendamento para cliente” ou “Ver contratos”, {who} não consegue cobrar no balcão. </>}
                            {autoChargeToo && <>A cobrança automática funciona assim mesmo: o interruptor fica no perfil do cliente. </>}
                            Dá para salvar assim e liberar depois.
                        </span>
                    </div>
                )}
                {(summary.money.length > 0 || summary.irreversible.length > 0 || summary.clientSees.length > 0) && (
                    <div className="team-perm-summary__risk">
                        {summary.money.length > 0 && (
                            <div className="team-perm-summary__risk-row">
                                <PermissionBadge badge="dinheiro" />
                                <span>{summary.money.map(a => a.label).join('; ')}</span>
                            </div>
                        )}
                        {summary.irreversible.length > 0 && (
                            <div className="team-perm-summary__risk-row">
                                <PermissionBadge badge="irreversivel" />
                                <span>{summary.irreversible.map(a => a.label).join('; ')}</span>
                            </div>
                        )}
                        {summary.clientSees.length > 0 && (
                            <div className="team-perm-summary__risk-row">
                                <PermissionBadge badge="clienteVe" />
                                <span>{summary.clientSees.map(a => a.label).join('; ')}</span>
                            </div>
                        )}
                    </div>
                )}
            </section>
        </div>
    );
}
