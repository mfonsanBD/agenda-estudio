// ─── Catálogo de permissões da EQUIPE (fonte única) ─────
// Tudo o que define o que um COLABORADOR pode fazer mora aqui: chaves, rótulos em pt-BR, nível
// ("Ver" / "Ver e editar" / "Tudo"), selos, dependências, módulos na ordem do menu, seções de
// Configurações, chaves exclusivas do ADMIN, perfis modelo, mapa grupo de business-config →
// permissão e quem recebe cada aviso da equipe. Consumido por:
//   - middleware/permissions.ts       (getActor / requirePermission / can)
//   - lib/permissionRules.ts          (regras que dependem do corpo/estado)
//   - lib/staffRecipients.ts          (destinatários dos avisos da equipe)
//   - modules/staff (GET /api/staff/catalog → buildStaffCatalog())
//   - /api/auth/me                    (permissionsForRole)
// O front só tem a UNIÃO das chaves para tipagem (frontend/src/constants/permissions.ts) + teste de
// sincronia; rótulos, níveis e perfis chegam do servidor. SEM imports: módulo puro, seguro para o
// seed, para testes unitários e para leitura por script.
//
// O banco guarda SÓ a lista de chaves (staff_profiles.permissions). O nível é derivado na tela, então
// mudar a definição de um nível ou de um perfil aqui nunca altera em silêncio quem já foi cadastrado.
// ADMIN é papel próprio: tem acesso total (inclusive às chaves exclusivas) e ignora a lista.

/** Nível em que a ação entra: V = "Ver", E = "Ver e editar", T = "Tudo, inclusive cancelar e excluir". */
export type PermissionLevel = 'ver' | 'editar' | 'tudo';

/**
 * Selos exibidos ao lado da ação: `dinheiro` ($), `irreversivel` (⚠⚠, não tem volta),
 * `sensivel` (⚠) e `clienteVe` ("o cliente vê isto").
 */
export type PermissionBadge = 'dinheiro' | 'irreversivel' | 'sensivel' | 'clienteVe';

export const PERMISSION_LEVEL_LABELS: Readonly<Record<PermissionLevel, string>> = {
    ver: 'Ver',
    editar: 'Ver e editar',
    tudo: 'Tudo, inclusive cancelar e excluir',
};

export const PERMISSION_BADGE_LABELS: Readonly<Record<PermissionBadge, string>> = {
    dinheiro: 'Mexe com dinheiro',
    irreversivel: 'Não tem volta',
    sensivel: 'Ação sensível',
    clienteVe: 'O cliente vê isto',
};

interface ActionDef {
    readonly key: string;
    readonly label: string;
    readonly description: string;
    /** null = caixa sem nível (Configurações). */
    readonly level: PermissionLevel | null;
    readonly badges: readonly PermissionBadge[];
    /** Chaves marcadas e travadas junto (normalizePermissions aplica no servidor). */
    readonly requires: readonly string[];
}

interface ModuleDef {
    readonly key: string;
    readonly label: string;
    readonly description: string;
    readonly actions: readonly ActionDef[];
}

// Ordem = ordem do menu da área administrativa. Rótulos = tabela D2 (DECISOES-EQUIPE.md).
const MODULES = [
    {
        key: 'agendamentos',
        label: 'Agenda e Agendamentos',
        description: 'Agenda, lista de agendamentos e bloqueios de horário.',
        actions: [
            {
                key: 'agendamentos.ver', level: 'ver', badges: [], requires: [],
                label: 'Ver agenda e agendamentos (inclui o preço de cada sessão)',
                description: 'Abre a Agenda e a lista de Agendamentos, com cliente, horário, status e preço de cada sessão.',
            },
            {
                key: 'agendamentos.criar', level: 'editar', badges: [], requires: ['agendamentos.ver'],
                label: 'Criar agendamento para cliente',
                description: 'Marca uma sessão para um cliente pelo painel. Sem “Marcar como pago”, a sessão nasce reservada e aguardando pagamento.',
            },
            {
                key: 'agendamentos.editar', level: 'editar', badges: [], requires: ['agendamentos.ver'],
                label: 'Mudar data, horário e status',
                description: 'Remarca a sessão, muda o status (reservado, confirmado, concluído, reabrir) e edita as notas da gravação. Reabrir sessão cancelada exige também “Marcar como pago, anular ou estornar”.',
            },
            {
                key: 'agendamentos.faltas', level: 'editar', badges: [], requires: ['agendamentos.ver'],
                label: 'Registrar falta ou não realizado (e remarcar avulso perdido)',
                description: 'Marca falta ou não realizado com o motivo, justifica a falta do avulso e remarca a gravação perdida.',
            },
            {
                key: 'agendamentos.cancelar', level: 'tudo', badges: ['sensivel'], requires: ['agendamentos.ver'],
                label: 'Cancelar sessão',
                description: 'Cancela a sessão e libera o horário. Com cobrança em aberto (da sessão ou de extras, ex.: avulso não pago), só com “Marcar como pago, anular ou estornar”: cancelar anula a cobrança.',
            },
            {
                key: 'agendamentos.excluir', level: 'tudo', badges: ['irreversivel'], requires: ['agendamentos.ver'],
                label: 'Excluir agendamento definitivamente',
                description: 'Apaga o agendamento do sistema, sem deixar histórico. Sessão com cobrança em aberto só com “Marcar como pago, anular ou estornar”, porque excluir anula a cobrança.',
            },
        ],
    },
    {
        key: 'hoje',
        label: 'Hoje',
        description: 'Operação das gravações do dia.',
        actions: [
            {
                key: 'hoje.ver', level: 'ver', badges: [], requires: [],
                label: 'Ver a operação do dia',
                description: 'Abre a tela Hoje com as sessões do dia (também permite consultar a agenda).',
            },
            {
                key: 'hoje.presenca', level: 'editar', badges: [], requires: ['hoje.ver'],
                label: 'Confirmar presença (check-in)',
                description: 'Marca que o cliente chegou e confirma a sessão reservada.',
            },
            {
                key: 'hoje.gravacao', level: 'editar', badges: [], requires: ['hoje.ver'],
                label: 'Operar a gravação (iniciar, desfazer, finalizar, métricas)',
                description: 'Inicia e finaliza a gravação e registra links, métricas e notas da sessão.',
            },
        ],
    },
    {
        key: 'clientes',
        label: 'Clientes',
        description: 'Cadastro e perfil dos clientes.',
        actions: [
            {
                key: 'clientes.ver', level: 'ver', badges: [], requires: [],
                label: 'Ver clientes',
                description: 'Abre a lista e o perfil dos clientes, com contato, CPF/CNPJ, endereço e histórico.',
            },
            {
                key: 'clientes.criar', level: 'editar', badges: [], requires: ['clientes.ver'],
                label: 'Cadastrar cliente',
                description: 'Cria a conta de um cliente novo.',
            },
            {
                key: 'clientes.editar', level: 'editar', badges: [], requires: ['clientes.ver'],
                label: 'Editar o cadastro do cliente',
                description: 'Altera nome, telefone, CPF/CNPJ, endereço, redes, etiquetas, observações e a situação Ativo/Inativo.',
            },
            {
                key: 'clientes.acesso', level: 'tudo', badges: ['sensivel'], requires: ['clientes.ver'],
                label: 'Alterar o acesso ao app do cliente (e-mail de login e bloqueio)',
                description: 'Troca o e-mail de login do cliente e bloqueia ou desbloqueia o acesso ao app. Definir a senha de um cliente continua só com o administrador.',
            },
            {
                key: 'clientes.excluir', level: 'tudo', badges: ['irreversivel'], requires: ['clientes.ver'],
                label: 'Excluir cliente',
                description: 'Exclui o cliente: cancela o que está em aberto e apaga os dados pessoais. Com contrato, pedido de cancelamento ou cobrança em aberto, exige também a chave de cada um (contrato, multa, baixa).',
            },
        ],
    },
    {
        key: 'contratos',
        label: 'Contratos',
        description: 'Planos e contratos dos clientes.',
        actions: [
            {
                key: 'contratos.ver', level: 'ver', badges: [], requires: [],
                label: 'Ver contratos (inclui parcelas e valores)',
                description: 'Abre a lista e o detalhe dos contratos, com as parcelas pagas e em aberto.',
            },
            {
                key: 'contratos.criar', level: 'editar', badges: [], requires: ['contratos.ver'],
                label: 'Criar e renovar contratos',
                description: 'Cria contratos (inclusive personalizados), com as parcelas em aberto. Renovar exige também “Marcar como pago, anular ou estornar”, porque a renovação não gera parcelas.',
            },
            {
                key: 'contratos.editar', level: 'editar', badges: [], requires: ['contratos.ver'],
                label: 'Editar, pausar e retomar contratos',
                description: 'Altera vigência, link e forma de pagamento, conclui, pausa e retoma contratos. Pausar um Fixo com gravação futura que tem cobrança em aberto exige também “Marcar como pago, anular ou estornar”.',
            },
            {
                key: 'contratos.condicoes', level: 'tudo', badges: ['dinheiro'], requires: ['contratos.ver'],
                label: 'Mudar créditos, serviços e condições de pagamento',
                description: 'Ajusta os créditos FLEX e os serviços do contrato (recalcula as parcelas futuras).',
            },
            {
                key: 'contratos.cancelar', level: 'tudo', badges: ['sensivel'], requires: ['contratos.ver'],
                label: 'Cancelar contrato',
                description: 'Cancela o contrato, anula as parcelas em aberto e as sessões futuras. No avulso ou em gravação cobrada à parte, com cobrança em aberto, exige também “Marcar como pago, anular ou estornar”.',
            },
            {
                key: 'contratos.multa', level: 'tudo', badges: ['dinheiro'], requires: ['contratos.ver'],
                label: 'Decidir pedido de cancelamento (cobrar ou isentar multa)',
                description: 'Resolve o pedido de cancelamento do cliente: cobra a multa ou isenta. No avulso ou em gravação cobrada à parte, com cobrança em aberto, exige também “Marcar como pago, anular ou estornar”.',
            },
        ],
    },
    {
        key: 'cobrancas',
        label: 'Cobranças',
        description: 'Cobrar no balcão e mexer em pagamentos.',
        actions: [
            {
                key: 'cobrancas.cobrar', level: 'editar', badges: [], requires: [],
                label: 'Cobrar o cliente (PIX, boleto ou cartão digitado)',
                description: 'Gera a cobrança e mostra o PIX, o boleto ou o checkout de cartão para o cliente pagar na hora.',
            },
            {
                key: 'cobrancas.cartao_salvo', level: 'tudo', badges: ['dinheiro'], requires: ['cobrancas.cobrar'],
                label: 'Debitar o cartão salvo do cliente',
                description: 'Cobra no cartão que o cliente deixou salvo, sem ele digitar os dados.',
            },
            {
                key: 'cobrancas.baixa', level: 'tudo', badges: ['dinheiro'], requires: [],
                label: 'Marcar como pago, anular ou estornar (baixa manual)',
                description: 'Registra pagamento feito fora do sistema, anula ou estorna cobranças e cria sessão já paga ou com outro preço. Exigida também ao cancelar sessão com cobrança em aberto e ao reabrir sessão cancelada.',
            },
            {
                key: 'cobrancas.automatica', level: 'tudo', badges: ['dinheiro'], requires: ['clientes.ver'],
                label: 'Ligar ou desligar a cobrança automática do cliente',
                description: 'Liga ou desliga o débito automático das parcelas no cartão salvo do cliente.',
            },
        ],
    },
    {
        key: 'financeiro',
        label: 'Financeiro e receita',
        description: 'Tela Financeiro e receita consolidada.',
        actions: [
            {
                key: 'financeiro.ver', level: 'ver', badges: [], requires: [],
                label: 'Ver o financeiro e a receita',
                description: 'Abre a tela Financeiro. A receita do mês aparece no painel para quem também vê a Agenda, e a receita dos relatórios para quem também vê Relatórios.',
            },
        ],
    },
    {
        key: 'cupons',
        label: 'Cupons',
        description: 'Cupons de desconto.',
        actions: [
            {
                key: 'cupons.ver', level: 'ver', badges: [], requires: [],
                label: 'Ver cupons',
                description: 'Abre a lista de cupons e o uso de cada um.',
            },
            {
                key: 'cupons.editar', level: 'editar', badges: ['dinheiro'], requires: ['cupons.ver'],
                label: 'Criar, editar, ativar e excluir cupons',
                description: 'Cria e altera cupons de desconto, ativa, desativa e exclui.',
            },
        ],
    },
    {
        key: 'relatorios',
        label: 'Relatórios',
        description: 'Relatórios de ocupação, faixas, audiência e ranking.',
        actions: [
            {
                key: 'relatorios.ver', level: 'ver', badges: [], requires: [],
                label: 'Ver relatórios (receita só com “Financeiro e receita”)',
                description: 'Abre os relatórios de ocupação, faixas, audiência e ranking. A receita só aparece com “Ver o financeiro e a receita”.',
            },
        ],
    },
    {
        key: 'avisos',
        label: 'Avisos e modelos de mensagem',
        description: 'Aviso aos clientes e textos das mensagens automáticas.',
        actions: [
            {
                key: 'avisos.enviar', level: 'tudo', badges: ['sensivel', 'clienteVe'], requires: [],
                label: 'Enviar aviso aos clientes',
                description: 'Envia um aviso no sino e por push para todos os clientes ou para os escolhidos.',
            },
            {
                key: 'avisos.modelos', level: 'tudo', badges: ['sensivel', 'clienteVe'], requires: [],
                label: 'Editar os textos das mensagens automáticas',
                description: 'Muda o texto e liga ou desliga os avisos automáticos que os clientes recebem, inclusive os de cobrança e vencimento. Os avisos da equipe só o administrador altera.',
            },
        ],
    },
    {
        key: 'config',
        label: 'Configurações',
        description: 'Uma caixa por seção da tela Configurações (ver e alterar).',
        actions: [
            {
                key: 'config.gerais', level: null, badges: ['sensivel', 'clienteVe'], requires: [],
                label: 'Gerais (aparece no site para os clientes)',
                description: 'Nome do estúdio, telefone, e-mail de contato, logo e imagem do site.',
            },
            {
                key: 'config.horarios', level: null, badges: [], requires: [],
                label: 'Horários & Grade',
                description: 'Dias de funcionamento, horários dos blocos e faixas.',
            },
            {
                key: 'config.precos', level: null, badges: ['dinheiro'], requires: [],
                label: 'Preços e regras (planos e pagamentos; sem taxas de gateway)',
                description: 'Preço das faixas, descontos de fidelidade e regras de planos e de pagamento.',
            },
            {
                key: 'config.politicas', level: null, badges: [], requires: [],
                label: 'Políticas',
                description: 'Multa de cancelamento, antecedência mínima e janelas de remarcação.',
            },
            {
                key: 'config.servicos', level: null, badges: ['dinheiro'], requires: [],
                label: 'Serviços',
                description: 'Serviços extras e mensais: preço, descrição e se aparecem no site.',
            },
            {
                key: 'config.pagamentos', level: null, badges: ['dinheiro'], requires: [],
                label: 'Formas de pagamento',
                description: 'Liga e desliga PIX, cartão e boleto e define onde cada um aparece.',
            },
            {
                key: 'config.ambiente', level: null, badges: [], requires: [],
                label: 'Ambiente',
                description: 'Animação do topo do site e clima.',
            },
            {
                key: 'config.gravacoes', level: null, badges: [], requires: [],
                label: 'Gravações (plataformas)',
                description: 'Plataformas de transmissão habilitadas nas gravações.',
            },
        ],
    },
] as const satisfies readonly ModuleDef[];

/** Chave de módulo (linha da etapa Permissões), na ordem do menu. */
export type PermissionModuleKey = (typeof MODULES)[number]['key'];
/** Chave DELEGÁVEL (pode ser marcada para um colaborador). */
export type PermissionKey = (typeof MODULES)[number]['actions'][number]['key'];

/** Chaves exclusivas do ADMIN: nunca aparecem para marcar (a UI mostra em cinza, "só o administrador"). */
const ADMIN_ONLY = [
    { key: 'equipe.gerenciar', label: 'Equipe (adicionar pessoas e definir o que cada uma pode fazer)' },
    { key: 'config.email', label: 'Configurações: E-mail (servidor de envio e código de login)' },
    { key: 'config.integracoes', label: 'Configurações: Integrações (Stripe, Sicoob e Cora)' },
    { key: 'config.taxas', label: 'Configurações: taxas de gateway e histórico' },
    { key: 'sistema.manutencao', label: 'Manutenção do sistema (limpeza de cobranças órfãs)' },
] as const;

export type AdminOnlyKey = (typeof ADMIN_ONLY)[number]['key'];

/**
 * Requisito "só o ADMIN": usado quando nenhuma chave cobre o caso (ex.: campo de corpo sem mapeamento
 * em lib/permissionRules.ts, grupo de business-config fora do catálogo). Nunca é uma permissão
 * delegável — COLABORADOR nunca o tem; ADMIN passa sempre.
 */
export const ADMIN_REQUIREMENT = 'ADMIN' as const;

/** O que uma regra pode exigir: chave delegável, chave exclusiva do ADMIN ou o próprio papel ADMIN. */
export type RequirementKey = PermissionKey | AdminOnlyKey | typeof ADMIN_REQUIREMENT;

/** Todas as chaves exclusivas do ADMIN (equipe, e-mail, integrações, taxas, manutenção). */
export const ADMIN_ONLY_KEYS: readonly AdminOnlyKey[] = Object.freeze(ADMIN_ONLY.map(a => a.key));

const ALL_KEYS: readonly PermissionKey[] = Object.freeze(
    MODULES.flatMap(m => m.actions.map(a => a.key as PermissionKey)),
);
const ALL_KEY_SET: ReadonlySet<string> = new Set<string>(ALL_KEYS);
const ADMIN_ONLY_SET: ReadonlySet<string> = new Set<string>(ADMIN_ONLY_KEYS);

type AnyAction = (typeof MODULES)[number]['actions'][number];
const ACTION_BY_KEY: ReadonlyMap<string, AnyAction> = new Map(
    MODULES.flatMap(m => m.actions.map(a => [a.key, a] as const)),
);
const MODULE_OF_KEY: ReadonlyMap<string, PermissionModuleKey> = new Map(
    MODULES.flatMap(m => m.actions.map(a => [a.key, m.key as PermissionModuleKey] as const)),
);
/** Posição de cada chave no catálogo (ordena listas de permissões de forma estável). */
const KEY_ORDER: ReadonlyMap<string, number> = new Map(ALL_KEYS.map((k, i) => [k, i]));

/** Todas as chaves delegáveis, na ordem do catálogo (menu → ações). */
export function allPermissionKeys(): PermissionKey[] {
    return [...ALL_KEYS];
}

/** Chaves de módulo na ordem do menu. */
export function allModuleKeys(): PermissionModuleKey[] {
    return MODULES.map(m => m.key);
}

export function isPermissionKey(key: unknown): key is PermissionKey {
    return typeof key === 'string' && ALL_KEY_SET.has(key);
}

export function isAdminOnlyKey(key: unknown): key is AdminOnlyKey {
    return typeof key === 'string' && ADMIN_ONLY_SET.has(key);
}

/** Módulo dono da chave (undefined para chave desconhecida ou exclusiva do ADMIN). */
export function moduleOf(key: string): PermissionModuleKey | undefined {
    return MODULE_OF_KEY.get(key);
}

/** Chaves (ações) de um módulo, na ordem do catálogo. */
export function moduleKeys(module: PermissionModuleKey): PermissionKey[] {
    const m = MODULES.find(x => x.key === module);
    return m ? m.actions.map(a => a.key as PermissionKey) : [];
}

function sortByCatalog<T extends string>(keys: Iterable<T>): T[] {
    return [...new Set(keys)].sort((a, b) => (KEY_ORDER.get(a) ?? 1e9) - (KEY_ORDER.get(b) ?? 1e9));
}

// ─── Normalização ───────────────────────────────────────

export interface NormalizedPermissions {
    /** Chaves válidas, sem duplicatas, com as dependências aplicadas, na ordem do catálogo. É o que se grava. */
    permissions: PermissionKey[];
    /** Chaves desconhecidas (ou não-texto) — o /api/staff responde 400 INVALID_PERMISSION se houver alguma. */
    invalid: string[];
    /** Chaves exclusivas do ADMIN enviadas na lista: descartadas (nunca se delegam). */
    removedAdminOnly: AdminOnlyKey[];
    /** Chaves acrescentadas pelas dependências (ex.: agendamentos.ver ao marcar agendamentos.criar). */
    added: PermissionKey[];
}

/**
 * Valida e normaliza uma lista de permissões para GRAVAR: tira duplicatas, descarta as exclusivas do
 * ADMIN, separa as desconhecidas em `invalid` e aplica as dependências (fecho transitivo: toda ação
 * de módulo exige o `.ver` dele; `cobrancas.cartao_salvo` exige `cobrancas.cobrar`;
 * `cobrancas.automatica` exige `clientes.ver`). Ordena pelo catálogo.
 */
export function normalizePermissions(keys: readonly unknown[] | null | undefined): NormalizedPermissions {
    const invalid: string[] = [];
    const removedAdminOnly: AdminOnlyKey[] = [];
    const chosen = new Set<PermissionKey>();
    for (const raw of keys ?? []) {
        if (isPermissionKey(raw)) chosen.add(raw);
        else if (isAdminOnlyKey(raw)) { if (!removedAdminOnly.includes(raw)) removedAdminOnly.push(raw); }
        else { const s = typeof raw === 'string' ? raw : String(raw); if (!invalid.includes(s)) invalid.push(s); }
    }
    const result = new Set<PermissionKey>(chosen);
    const queue = [...chosen];
    while (queue.length > 0) {
        const k = queue.pop()!;
        for (const dep of ACTION_BY_KEY.get(k)?.requires ?? []) {
            if (!result.has(dep as PermissionKey)) {
                result.add(dep as PermissionKey);
                queue.push(dep as PermissionKey);
            }
        }
    }
    return {
        permissions: sortByCatalog(result),
        invalid,
        removedAdminOnly,
        added: sortByCatalog([...result].filter(k => !chosen.has(k))),
    };
}

/**
 * Lista LIDA do banco → conjunto efetivo: só chaves que ainda existem no catálogo (o catálogo pode
 * encolher sem quebrar nada), sem exclusivas do ADMIN, sem duplicatas. Não acrescenta dependências:
 * nunca concede em silêncio mais do que foi gravado.
 */
export function sanitizeStoredPermissions(keys: readonly unknown[] | null | undefined): PermissionKey[] {
    return sortByCatalog((keys ?? []).filter(isPermissionKey));
}

/**
 * Permissões efetivas de um papel, no formato do `/api/auth/me` (`user.permissions`):
 * ADMIN = todas as chaves do catálogo + as exclusivas (o front usa um `can()` único);
 * COLABORADOR = as dele (sanitizadas); CLIENTE (ou papel desconhecido) = [].
 */
export function permissionsForRole(role: string | null | undefined, keys?: readonly unknown[] | null): Array<PermissionKey | AdminOnlyKey> {
    if (role === 'ADMIN') return [...ALL_KEYS, ...ADMIN_ONLY_KEYS];
    if (role === 'COLABORADOR') return sanitizeStoredPermissions(keys);
    return [];
}

/** Papel de equipe (área administrativa). */
export function isStaffRole(role: string | null | undefined): role is 'ADMIN' | 'COLABORADOR' {
    return role === 'ADMIN' || role === 'COLABORADOR';
}

// ─── Níveis ─────────────────────────────────────────────

/** Nível exibido no seletor de um módulo. `personalizado` = as caixas não batem com nenhum nível. */
export type ModuleLevel = 'nenhum' | PermissionLevel | 'personalizado';

/** Conjunto de chaves de cada nível de um módulo (cumulativo: "Ver e editar" inclui "Ver"). */
export function moduleLevels(module: PermissionModuleKey): Record<PermissionLevel, PermissionKey[]> {
    const actions = MODULES.find(m => m.key === module)?.actions ?? [];
    const upTo = (levels: PermissionLevel[]) =>
        actions.filter(a => a.level !== null && levels.includes(a.level)).map(a => a.key as PermissionKey);
    return { ver: upTo(['ver']), editar: upTo(['ver', 'editar']), tudo: upTo(['ver', 'editar', 'tudo']) };
}

/**
 * Nível de um módulo para uma lista de chaves. Quando dois níveis coincidem (ex.: "Hoje", em que
 * "Ver e editar" = "Tudo"), devolve o MENOR. Configurações (caixas, sem nível): `nenhum`, `tudo`
 * (todas marcadas) ou `personalizado`.
 */
export function levelOf(module: PermissionModuleKey, keys: readonly unknown[] | null | undefined): ModuleLevel {
    const mine = moduleKeys(module);
    const have = new Set((keys ?? []).filter((k): k is PermissionKey => isPermissionKey(k) && mine.includes(k)));
    if (have.size === 0) return 'nenhum';
    const same = (set: readonly PermissionKey[]) => set.length === have.size && set.every(k => have.has(k));
    if (module === 'config') return same(mine) ? 'tudo' : 'personalizado';
    const levels = moduleLevels(module);
    for (const lvl of ['ver', 'editar', 'tudo'] as const) {
        if (levels[lvl].length > 0 && same(levels[lvl])) return lvl;
    }
    return 'personalizado';
}

/** Módulos em que a lista dá algum acesso (para "N módulos" na tela Equipe), na ordem do menu. */
export function modulesWithAccess(keys: readonly unknown[] | null | undefined): PermissionModuleKey[] {
    const set = new Set(sanitizeStoredPermissions(keys));
    return MODULES.filter(m => m.actions.some(a => set.has(a.key as PermissionKey))).map(m => m.key);
}

// ─── Perfis modelo ──────────────────────────────────────
// Escolher um perfil só PREENCHE as caixas; o banco guarda só as chaves. `avisos.modelos` não entra em
// nenhum perfil (o texto que todos os clientes recebem). Todos já vêm normalizados (teste unitário).

export interface StaffPreset {
    key: 'recepcao' | 'operador' | 'financeiro';
    label: string;
    description: string;
    permissions: readonly PermissionKey[];
}

export const STAFF_PRESETS: readonly StaffPreset[] = [
    {
        key: 'recepcao',
        label: 'Recepção / Atendimento',
        description: 'Agenda, recebe o cliente, fecha plano novo e cobra no balcão. Não vê a receita, não renova plano, não reabre sessão cancelada nem cancela sessão com cobrança em aberto (exigem a baixa), não debita cartão salvo e não exclui nada.',
        permissions: [
            'agendamentos.ver', 'agendamentos.criar', 'agendamentos.editar', 'agendamentos.faltas', 'agendamentos.cancelar',
            'hoje.ver', 'hoje.presenca',
            'clientes.ver', 'clientes.criar', 'clientes.editar',
            'contratos.ver', 'contratos.criar',
            'cobrancas.cobrar',
            'cupons.ver',
        ],
    },
    {
        key: 'operador',
        label: 'Operador de estúdio',
        description: 'Opera a gravação (presença, iniciar, finalizar, métricas), registra falta e vê a audiência. Sem dinheiro.',
        permissions: [
            'agendamentos.ver', 'agendamentos.faltas',
            'hoje.ver', 'hoje.presenca', 'hoje.gravacao',
            'clientes.ver',
            'relatorios.ver',
            'config.gravacoes',
        ],
    },
    {
        key: 'financeiro',
        label: 'Financeiro',
        description: 'Cobranças, baixas, multas, contratos e relatórios com receita. Configurações de preço ficam desmarcadas.',
        permissions: [
            'agendamentos.ver',
            'clientes.ver', 'clientes.editar',
            'contratos.ver', 'contratos.editar', 'contratos.condicoes', 'contratos.cancelar', 'contratos.multa',
            'cobrancas.cobrar', 'cobrancas.cartao_salvo', 'cobrancas.baixa', 'cobrancas.automatica',
            'financeiro.ver',
            'cupons.ver', 'cupons.editar',
            'relatorios.ver',
        ],
    },
];

// ─── Configurações: seções e grupos de business-config ──

/** Seções da tela Configurações (`?sec=`) → permissão que as abre. email/integracoes: só ADMIN. */
export const STAFF_SETTINGS_SECTIONS: ReadonlyArray<{ sec: string; label: string; permission: PermissionKey | AdminOnlyKey }> = [
    { sec: 'gerais', label: 'Gerais', permission: 'config.gerais' },
    { sec: 'horarios', label: 'Horários & Grade', permission: 'config.horarios' },
    { sec: 'financeiro', label: 'Preços e regras', permission: 'config.precos' },
    { sec: 'politicas', label: 'Políticas', permission: 'config.politicas' },
    { sec: 'servicos', label: 'Serviços', permission: 'config.servicos' },
    { sec: 'pagamentos', label: 'Formas de pagamento', permission: 'config.pagamentos' },
    { sec: 'ambiente', label: 'Ambiente', permission: 'config.ambiente' },
    { sec: 'gravacoes', label: 'Gravações', permission: 'config.gravacoes' },
    { sec: 'email', label: 'E-mail', permission: 'config.email' },
    { sec: 'integracoes', label: 'Integrações', permission: 'config.integracoes' },
];

/**
 * Grupo de business-config (coluna `group`, ver config/businessConfigCatalog.ts) → permissão que o
 * vê e altera. `email` e `gateway` são exclusivos do ADMIN (config.email / config.taxas); qualquer
 * outro grupo (inclusive "outros", chave fora do catálogo) → só ADMIN.
 */
export const BUSINESS_CONFIG_GROUP_PERMISSION: Readonly<Record<string, PermissionKey | AdminOnlyKey>> = {
    studio: 'config.gerais',
    schedule: 'config.horarios',
    plans: 'config.precos',
    payments: 'config.precos',
    policies: 'config.politicas',
    ambient: 'config.ambiente',
    recordings: 'config.gravacoes',
    email: 'config.email',
    gateway: 'config.taxas',
};

/** Permissão exigida para ver/alterar um grupo de business-config (grupo sem mapeamento → só ADMIN). */
export function permissionForConfigGroup(group: string | null | undefined): PermissionKey | AdminOnlyKey | typeof ADMIN_REQUIREMENT {
    return (group && Object.prototype.hasOwnProperty.call(BUSINESS_CONFIG_GROUP_PERMISSION, group))
        ? BUSINESS_CONFIG_GROUP_PERMISSION[group]
        : ADMIN_REQUIREMENT;
}

// ─── Avisos da equipe (notificações de audiência "admin") ──
// Evento → permissões (QUALQUER uma) que fazem o COLABORADOR recebê-lo; o ADMIN recebe todos.
// Cada lista só tem permissões que ABREM a tela do link do aviso (crítica I3) — com o actionUrl atual:
//   /admin/today → hoje.ver · /admin/finance → financeiro.ver · /admin/contracts → contratos.ver
// Três eventos dependem de o link ser ajustado pela frente de notificações (ver o relatório da B0):
//   computed_contract_expiring_admin e computed_contract_awaiting_admin hoje apontam para
//   /admin/clients/:id (exige clientes.ver) → apontar para /admin/contracts/:id;
//   admin_makeup_expired_studio aponta para /admin/contracts → apontar para /admin/bookings
//   (agendamentos.faltas implica agendamentos.ver).
// Evento ausente deste mapa → só ADMIN (nega por padrão).
export const STAFF_EVENT_PERMISSIONS: Readonly<Record<string, readonly PermissionKey[]>> = {
    // persistidos
    admin_cancellation_requested: ['contratos.multa'],
    admin_payment_on_cancelled_charge: ['financeiro.ver'],
    admin_card_double_charge: ['financeiro.ver'],
    admin_booking_confirmed: ['hoje.ver'],
    admin_booking_cancelled: ['hoje.ver'],
    admin_makeup_rescheduled: ['hoje.ver'],
    admin_makeup_expired_studio: ['agendamentos.faltas'],
    // calculados (sino + push job)
    computed_contract_expiring_admin: ['contratos.ver'],
    computed_contract_awaiting_admin: ['contratos.ver'],
    computed_cancellation_pending_admin: ['contratos.multa'],
    computed_payment_overdue_admin: ['financeiro.ver'],
    computed_payment_failed_admin: ['financeiro.ver'],
    computed_booking_unconfirmed_admin: ['hoje.presenca'],
};

/** Permissões que fazem um COLABORADOR receber o evento ([] = só ADMIN). */
export function staffEventPermissions(eventKey: string): readonly PermissionKey[] {
    return Object.prototype.hasOwnProperty.call(STAFF_EVENT_PERMISSIONS, eventKey) ? STAFF_EVENT_PERMISSIONS[eventKey] : [];
}

// ─── GET /api/staff/catalog ─────────────────────────────

export interface StaffCatalogAction {
    key: PermissionKey;
    label: string;
    description: string;
    level: PermissionLevel | null;
    badges: PermissionBadge[];
    requires: PermissionKey[];
}

export interface StaffCatalogModule {
    key: PermissionModuleKey;
    label: string;
    description: string;
    /** Conjunto de chaves de cada nível (cumulativo). Configurações: todos vazios (caixas, sem nível). */
    levels: Record<PermissionLevel, PermissionKey[]>;
    actions: StaffCatalogAction[];
}

export interface StaffCatalog {
    modules: StaffCatalogModule[];
    adminOnly: Array<{ key: AdminOnlyKey; label: string }>;
    presets: Array<{ key: string; label: string; description: string; permissions: PermissionKey[] }>;
}

/** Corpo de `GET /api/staff/catalog` (contrato D5). Objetos novos a cada chamada (seguro para mutar). */
export function buildStaffCatalog(): StaffCatalog {
    return {
        modules: MODULES.map(m => ({
            key: m.key,
            label: m.label,
            description: m.description,
            levels: moduleLevels(m.key),
            actions: m.actions.map(a => ({
                key: a.key as PermissionKey,
                label: a.label,
                description: a.description,
                level: a.level,
                badges: [...a.badges],
                requires: [...a.requires] as PermissionKey[],
            })),
        })),
        adminOnly: ADMIN_ONLY.map(a => ({ key: a.key, label: a.label })),
        presets: STAFF_PRESETS.map(p => ({ key: p.key, label: p.label, description: p.description, permissions: [...p.permissions] })),
    };
}
