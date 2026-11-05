// ─── Etapa "Permissões" da tela Equipe: lógica pura ─────
// Tudo aqui trabalha sobre o catálogo que o SERVIDOR manda (GET /api/staff/catalog → staffApi.getCatalog):
// rótulos, níveis, selos, dependências e perfis modelo vêm de lá (fonte única:
// backend/src/config/staffPermissions.ts). Este arquivo só calcula o que a tela mostra:
//   - fecho das dependências (marcar uma ação marca e TRAVA o que ela exige — o servidor repete ao salvar);
//   - o nível de cada módulo (Sem acesso / Ver / Ver e editar / Tudo… / Personalizado);
//   - aplicar um nível ou um perfil modelo;
//   - o resumo final e o "N módulos" da lista.
// O banco guarda só a lista de chaves: o nível é sempre derivado, nunca gravado.

import type {
    StaffCatalog, StaffCatalogAction, StaffCatalogModule, StaffMember, StaffPermissionBadge, StaffPermissionLevel,
} from '../../../api/client';
import { isPermissionKey, type PermissionKey } from '../../../constants/permissions';

/** Nível exibido no seletor do módulo. `personalizado` = as caixas não batem com nenhum nível. */
export type ModuleLevel = 'nenhum' | StaffPermissionLevel | 'personalizado';

/** Níveis na ordem do seletor. */
export const LEVEL_ORDER: readonly StaffPermissionLevel[] = ['ver', 'editar', 'tudo'];

/** Rótulos do seletor de nível (mesmos termos do catálogo do servidor). */
export const LEVEL_LABELS: Readonly<Record<ModuleLevel, string>> = {
    nenhum: 'Sem acesso',
    ver: 'Ver',
    editar: 'Ver e editar',
    tudo: 'Tudo, inclusive cancelar e excluir',
    personalizado: 'Personalizado',
};

/** Módulo de Configurações: caixas por seção, sem nível ("marcar todas"). */
export const CONFIG_MODULE_KEY = 'config';

/** Rótulo curto de cada selo (o texto que aparece na caixa). */
export const BADGE_LABELS: Readonly<Record<StaffPermissionBadge, string>> = {
    dinheiro: 'mexe com dinheiro',
    irreversivel: 'não tem volta',
    sensivel: 'ação sensível',
    clienteVe: 'o cliente vê isto',
};

/** Explicação do selo (dica no foco/hover). */
export const BADGE_HINTS: Readonly<Record<StaffPermissionBadge, string>> = {
    dinheiro: 'Registra, cobra ou muda valores. Marque só para quem cuida do dinheiro do estúdio.',
    irreversivel: 'O que for apagado por aqui não volta.',
    sensivel: 'Tem efeito direto no cliente ou no estúdio. Marque com cuidado.',
    clienteVe: 'O que for alterado aparece para os clientes (site, avisos ou mensagens).',
};

export interface CatalogIndex {
    /** Ação → módulo dono. */
    moduleOf: ReadonlyMap<string, StaffCatalogModule>;
    /** Ação por chave. */
    actionOf: ReadonlyMap<string, StaffCatalogAction>;
    /** Posição de cada chave no catálogo (ordena listas). */
    order: ReadonlyMap<string, number>;
}

/** Índices do catálogo (monte uma vez por catálogo, com useMemo). */
export function indexCatalog(catalog: StaffCatalog): CatalogIndex {
    const moduleOf = new Map<string, StaffCatalogModule>();
    const actionOf = new Map<string, StaffCatalogAction>();
    const order = new Map<string, number>();
    let i = 0;
    for (const m of catalog.modules) {
        for (const a of m.actions) {
            moduleOf.set(a.key, m);
            actionOf.set(a.key, a);
            order.set(a.key, i++);
        }
    }
    return { moduleOf, actionOf, order };
}

/** Ordena e tira duplicatas pela ordem do catálogo (chave fora do catálogo vai para o fim). */
export function sortByCatalog(keys: Iterable<string>, idx: CatalogIndex): PermissionKey[] {
    return [...new Set(keys)]
        .filter(isPermissionKey)
        .sort((a, b) => (idx.order.get(a) ?? 1e9) - (idx.order.get(b) ?? 1e9));
}

/**
 * Fecho das dependências (mesma regra do servidor): toda chave marcada acrescenta o que ela exige,
 * de forma transitiva. Chave que não está no catálogo é descartada (o catálogo pode ter encolhido).
 */
export function closePermissions(keys: Iterable<string>, idx: CatalogIndex): PermissionKey[] {
    const result = new Set<string>();
    const queue: string[] = [];
    for (const k of keys) {
        if (idx.actionOf.has(k) && !result.has(k)) { result.add(k); queue.push(k); }
    }
    while (queue.length > 0) {
        const k = queue.pop()!;
        for (const dep of idx.actionOf.get(k)?.requires ?? []) {
            if (idx.actionOf.has(dep) && !result.has(dep)) { result.add(dep); queue.push(dep); }
        }
    }
    return sortByCatalog(result, idx);
}

/**
 * Chaves TRAVADAS: marcadas porque outra ação marcada exige (não dá para desmarcar enquanto a outra
 * estiver marcada). Valor = as ações que exigem a chave.
 */
export function lockedKeys(selected: ReadonlySet<string>, idx: CatalogIndex): Map<string, StaffCatalogAction[]> {
    const locked = new Map<string, StaffCatalogAction[]>();
    for (const k of selected) {
        const action = idx.actionOf.get(k);
        if (!action) continue;
        for (const dep of action.requires) {
            if (!selected.has(dep)) continue;
            const list = locked.get(dep) ?? [];
            list.push(action);
            locked.set(dep, list);
        }
    }
    return locked;
}

/** Módulo de caixas (Configurações) — não tem seletor de nível. */
export function isBoxModule(module: StaffCatalogModule): boolean {
    return module.key === CONFIG_MODULE_KEY || LEVEL_ORDER.every(l => module.levels[l].length === 0);
}

const sameSet = (a: readonly string[], b: ReadonlySet<string>) => a.length === b.size && a.every(k => b.has(k));

/**
 * Níveis que fazem sentido no módulo, sem repetir: nível vazio some (Cobranças não tem "Ver") e nível
 * igual ao anterior também (em "Hoje", "Tudo" = "Ver e editar"; fica o menor).
 */
export function availableLevels(module: StaffCatalogModule): StaffPermissionLevel[] {
    const out: StaffPermissionLevel[] = [];
    let prev: string[] | null = null;
    for (const lvl of LEVEL_ORDER) {
        const keys = module.levels[lvl];
        if (keys.length === 0) continue;
        if (prev && keys.length === prev.length && keys.every(k => prev!.includes(k))) continue;
        out.push(lvl);
        prev = keys;
    }
    return out;
}

/**
 * Rótulo da opção de nível NO MÓDULO. Os termos padrão valem para quase todos; módulo sem nível "Ver"
 * (Cobranças, Avisos) não pode dizer "Ver e editar": a opção de uma ação só leva o nome dela
 * ("Cobrar o cliente") e a de "Tudo" vira só "Tudo" (ali não há o que cancelar ou excluir).
 */
export function levelOptionLabel(module: StaffCatalogModule, level: ModuleLevel): string {
    if (level === 'editar' && module.levels.ver.length === 0 && module.levels.editar.length === 1) {
        const action = module.actions.find(a => a.key === module.levels.editar[0]);
        if (action) return shortActionLabel(action);
    }
    if (level === 'tudo' && module.levels.ver.length === 0) return 'Tudo';
    return LEVEL_LABELS[level];
}

/** Chaves do módulo que estão marcadas. */
export function moduleSelection(module: StaffCatalogModule, selected: ReadonlySet<string>): Set<string> {
    return new Set(module.actions.map(a => a.key).filter(k => selected.has(k)));
}

/** Nível atual do módulo (níveis iguais → o menor). Configurações: nenhum / tudo / personalizado. */
export function moduleLevel(module: StaffCatalogModule, selected: ReadonlySet<string>): ModuleLevel {
    const mine = moduleSelection(module, selected);
    if (mine.size === 0) return 'nenhum';
    if (isBoxModule(module)) return mine.size === module.actions.length ? 'tudo' : 'personalizado';
    for (const lvl of availableLevels(module)) {
        if (sameSet(module.levels[lvl], mine)) return lvl;
    }
    return 'personalizado';
}

/**
 * Aplica um nível ao módulo: tira as chaves dele e põe as do nível; depois o fecho das dependências.
 * Uma chave do módulo exigida por ação de OUTRO módulo (ex.: "Ver clientes", exigida por "cobrança
 * automática") continua marcada — o seletor então mostra o nível real e a caixa explica a trava.
 */
export function applyLevel(selected: readonly string[], module: StaffCatalogModule, level: 'nenhum' | StaffPermissionLevel, idx: CatalogIndex): PermissionKey[] {
    const mine = new Set<string>(module.actions.map(a => a.key));
    const kept = selected.filter(k => !mine.has(k));
    const add = level === 'nenhum' ? [] : module.levels[level];
    return closePermissions([...kept, ...add], idx);
}

/** Marca ou desmarca TODAS as caixas do módulo (Configurações: "marcar todas"). */
export function applyAll(selected: readonly string[], module: StaffCatalogModule, on: boolean, idx: CatalogIndex): PermissionKey[] {
    const mine = new Set<string>(module.actions.map(a => a.key));
    const kept = selected.filter(k => !mine.has(k));
    return closePermissions(on ? [...kept, ...mine] : kept, idx);
}

/**
 * Liga/desliga uma caixa. Ligar marca também o que ela exige. Desligar uma chave TRAVADA (exigida por
 * outra marcada) não faz nada — a caixa fica desabilitada na tela, com a explicação.
 */
export function toggleAction(selected: readonly string[], key: string, on: boolean, idx: CatalogIndex): PermissionKey[] {
    if (on) return closePermissions([...selected, key], idx);
    const set = new Set(selected);
    if (lockedKeys(set, idx).has(key)) return closePermissions(selected, idx);
    set.delete(key);
    return closePermissions(set, idx);
}

/** O perfil modelo que bate EXATAMENTE com a seleção (para destacar o chip), ou null. */
export function matchingPreset(catalog: StaffCatalog, selected: readonly string[], idx: CatalogIndex): string | null {
    const set = new Set(closePermissions(selected, idx));
    for (const p of catalog.presets) {
        const preset = closePermissions(p.permissions, idx);
        if (sameSet(preset, set)) return p.key;
    }
    return null;
}

/** Módulos em que a lista dá algum acesso, na ordem do menu (para "N módulos"). */
export function modulesWithAccess(catalog: StaffCatalog, keys: readonly string[]): StaffCatalogModule[] {
    const set = new Set(keys);
    return catalog.modules.filter(m => m.actions.some(a => set.has(a.key)));
}

/** Rótulo curto de uma ação no resumo: sem o parêntese explicativo ("Cobrar o cliente (PIX…)" → "Cobrar o cliente"). */
export function shortActionLabel(action: StaffCatalogAction): string {
    return action.label.replace(/\s*\(.*\)\s*$/, '');
}

/**
 * Texto do nível no resumo ("Ver e editar", "tudo menos: Excluir agendamento definitivamente",
 * "só: Cobrar o cliente"…). Módulo sem nível "Ver" (Cobranças, Avisos) é descrito pelas ações — "Ver e
 * editar" ali confundiria. Configurações: "todas as seções" ou as seções marcadas.
 */
export function levelText(module: StaffCatalogModule, selected: ReadonlySet<string>): string {
    const level = moduleLevel(module, selected);
    const on = module.actions.filter(a => selected.has(a.key));
    const off = module.actions.filter(a => !selected.has(a.key));
    const list = (xs: StaffCatalogAction[]) => xs.map(shortActionLabel).join('; ');
    if (isBoxModule(module)) return level === 'tudo' ? 'todas as seções' : list(on);
    if (level === 'tudo') return module.levels.ver.length === 0 ? 'todas as ações' : LEVEL_LABELS.tudo;
    if (level === 'personalizado' || module.levels.ver.length === 0) {
        return off.length > 0 && off.length < on.length ? `tudo menos: ${list(off)}` : `só: ${list(on)}`;
    }
    return LEVEL_LABELS[level];
}

export interface SummaryLine {
    module: StaffCatalogModule;
    text: string;
    /** Ações marcadas do módulo (rótulos), na ordem do catálogo. */
    actions: StaffCatalogAction[];
}

export interface PermissionSummary {
    lines: SummaryLine[];
    /** Ações marcadas com cada selo de risco (para o "confira antes de salvar"). */
    money: StaffCatalogAction[];
    irreversible: StaffCatalogAction[];
    clientSees: StaffCatalogAction[];
}

/** Resumo final da etapa Permissões. */
export function summarize(catalog: StaffCatalog, keys: readonly string[]): PermissionSummary {
    const set = new Set(keys);
    const lines: SummaryLine[] = [];
    const money: StaffCatalogAction[] = [];
    const irreversible: StaffCatalogAction[] = [];
    const clientSees: StaffCatalogAction[] = [];
    for (const m of catalog.modules) {
        const actions = m.actions.filter(a => set.has(a.key));
        if (actions.length === 0) continue;
        lines.push({ module: m, text: levelText(m, set), actions });
        for (const a of actions) {
            if (a.badges.includes('dinheiro')) money.push(a);
            if (a.badges.includes('irreversivel')) irreversible.push(a);
            if (a.badges.includes('clienteVe')) clientSees.push(a);
        }
    }
    return { lines, money, irreversible, clientSees };
}

/** "1 módulo" / "N módulos". */
export function modulesCountLabel(n: number): string {
    if (n === 0) return 'Nenhum módulo';
    return n === 1 ? '1 módulo' : `${n} módulos`;
}

/**
 * Cobrança de BALCÃO: os botões ficam em Agendamentos (criar) e Contratos (ver). Fica de fora a cobrança
 * automática (`cobrancas.automatica`): o interruptor fica no perfil do cliente, que a dependência
 * `clientes.ver` sempre abre (TELA-5).
 */
export const COUNTER_CHARGE_KEYS: readonly PermissionKey[] = ['cobrancas.cobrar', 'cobrancas.cartao_salvo', 'cobrancas.baixa'];

/** Aviso da etapa Permissões: marcou cobrança de balcão sem nenhuma tela de onde cobrar. */
export function chargesWithoutScreen(selected: ReadonlySet<string>): boolean {
    return COUNTER_CHARGE_KEYS.some(k => selected.has(k))
        && !selected.has('agendamentos.criar') && !selected.has('contratos.ver');
}

// ─── Credenciais (E2) ───────────────────────────────────

/**
 * E-mail e senha travados na tela Equipe: quem é ou JÁ FOI administrador (o servidor recusa com 403
 * ADMIN_TARGET_FORBIDDEN). Resposta antiga sem `credentialsLocked` → trava só quem não é colaborador.
 */
export function credentialsLocked(member: Pick<StaffMember, 'role' | 'credentialsLocked'>): boolean {
    return member.credentialsLocked ?? member.role !== 'COLABORADOR';
}

/**
 * TELA-1 (UXT-08) — "Definir senha" na linha da TeamTable: nunca na própria linha e só para quem a tela pode mexer
 * nas credenciais (colaborador que nunca foi administrador; senão o servidor recusa com 403 ADMIN_TARGET_FORBIDDEN).
 */
export function canSetPasswordFor(member: Pick<StaffMember, 'isSelf' | 'role' | 'credentialsLocked'>): boolean {
    return !member.isSelf && !credentialsLocked(member);
}

/**
 * TELA-1 (UXT-08) — credenciais travadas no TeamMemberModal: só na EDIÇÃO (cadastro novo sempre informa o
 * e-mail), quando o servidor já recusou com a lista desatualizada (`serverLocked`) ou pela regra de credentialsLocked.
 * O e-mail fica editável quando não está travado.
 */
export function memberCredentialsLocked(
    member: Pick<StaffMember, 'role' | 'credentialsLocked'> | null | undefined,
    opts: { serverLocked: boolean },
): boolean {
    return !!member && (opts.serverLocked || credentialsLocked(member));
}

/** Texto do 403 ADMIN_TARGET_FORBIDDEN: vale também para quem hoje é colaborador (não o chama de "administrador"). */
export const CREDENTIALS_LOCKED_MESSAGE =
    'Por segurança, o e-mail e a senha de quem é ou já foi administrador não se alteram pela tela Equipe. Para a pessoa entrar, use “Enviar acesso” na lista: o código vai para o e-mail atual dela.';
