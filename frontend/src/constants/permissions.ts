// ─── Chaves de permissão da EQUIPE (só para tipagem) ────
// FONTE ÚNICA: backend/src/config/staffPermissions.ts. Rótulos em pt-BR, níveis ("Ver" / "Ver e editar" /
// "Tudo, inclusive cancelar e excluir"), selos, dependências e perfis modelo chegam do servidor
// (GET /api/staff/catalog → staffApi.getCatalog). Aqui fica SÓ a união das chaves, para o TypeScript
// pegar erro de digitação em can('...'), mais o mapa seção de Configurações → chave (espelho de
// STAFF_SETTINGS_SECTIONS). Um teste de sincronia do backend compara estas listas com o catálogo:
// ao mudar uma chave lá, mude aqui também (mesma ordem).
//
// Como o front recebe as permissões: `user.permissions` do /api/auth/me (e login/refresh):
//   ADMIN       = todas as chaves do catálogo + as exclusivas do ADMIN;
//   COLABORADOR = as dele;
//   CLIENTE     = [].
// O servidor é a autoridade (403 PERMISSION_DENIED); o front só esconde o que não pode.

/** Chaves DELEGÁVEIS (podem ser marcadas para um colaborador), na ordem do catálogo. */
export const PERMISSION_KEYS = [
    'agendamentos.ver',
    'agendamentos.criar',
    'agendamentos.editar',
    'agendamentos.faltas',
    'agendamentos.cancelar',
    'agendamentos.excluir',
    'hoje.ver',
    'hoje.presenca',
    'hoje.gravacao',
    'clientes.ver',
    'clientes.criar',
    'clientes.editar',
    'clientes.acesso',
    'clientes.excluir',
    'contratos.ver',
    'contratos.criar',
    'contratos.editar',
    'contratos.condicoes',
    'contratos.cancelar',
    'contratos.multa',
    'cobrancas.cobrar',
    'cobrancas.cartao_salvo',
    'cobrancas.baixa',
    'cobrancas.automatica',
    'financeiro.ver',
    'cupons.ver',
    'cupons.editar',
    'relatorios.ver',
    'avisos.enviar',
    'avisos.modelos',
    'config.gerais',
    'config.horarios',
    'config.precos',
    'config.politicas',
    'config.servicos',
    'config.pagamentos',
    'config.ambiente',
    'config.gravacoes',
] as const;

/** Chaves exclusivas do ADMIN: nunca se delegam (a tela Equipe mostra em cinza, "só o administrador"). */
export const ADMIN_ONLY_PERMISSION_KEYS = [
    'equipe.gerenciar',
    'config.email',
    'config.integracoes',
    'config.taxas',
    'sistema.manutencao',
] as const;

/** Chave delegável. */
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
/** Chave exclusiva do ADMIN. */
export type AdminOnlyPermissionKey = (typeof ADMIN_ONLY_PERMISSION_KEYS)[number];
/** Qualquer chave que `can()` aceita. */
export type Permission = PermissionKey | AdminOnlyPermissionKey;

/** Módulo (linha da etapa Permissões e grupo do menu), na ordem do menu. */
export type PermissionModuleKey =
    | 'agendamentos' | 'hoje' | 'clientes' | 'contratos' | 'cobrancas'
    | 'financeiro' | 'cupons' | 'relatorios' | 'avisos' | 'config';

const DELEGABLE_SET: ReadonlySet<string> = new Set<string>(PERMISSION_KEYS);
const ADMIN_ONLY_SET: ReadonlySet<string> = new Set<string>(ADMIN_ONLY_PERMISSION_KEYS);

export function isPermissionKey(key: unknown): key is PermissionKey {
    return typeof key === 'string' && DELEGABLE_SET.has(key);
}

export function isAdminOnlyPermission(key: unknown): key is AdminOnlyPermissionKey {
    return typeof key === 'string' && ADMIN_ONLY_SET.has(key);
}

/** Todas as caixas de Configurações (o item "Configurações" do menu aparece com QUALQUER uma). */
export const CONFIG_PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_KEYS.filter(k => k.startsWith('config.'));

/**
 * Seção da tela Configurações (`/admin/configuracoes?sec=`) → chave que a abre. Espelho de
 * STAFF_SETTINGS_SECTIONS (backend). `email` e `integracoes` são exclusivas do ADMIN.
 * Ordem = ordem das seções em AdminSettingsPage.
 */
export const SETTINGS_SECTION_PERMISSIONS = {
    gerais: 'config.gerais',
    horarios: 'config.horarios',
    financeiro: 'config.precos',
    politicas: 'config.politicas',
    servicos: 'config.servicos',
    pagamentos: 'config.pagamentos',
    ambiente: 'config.ambiente',
    gravacoes: 'config.gravacoes',
    email: 'config.email',
    integracoes: 'config.integracoes',
} as const satisfies Record<string, Permission>;

export type SettingsSectionId = keyof typeof SETTINGS_SECTION_PERMISSIONS;

/** Chave que abre a seção (undefined = seção desconhecida). */
export function settingsSectionPermission(sec: string | null | undefined): Permission | undefined {
    return sec && Object.prototype.hasOwnProperty.call(SETTINGS_SECTION_PERMISSIONS, sec)
        ? SETTINGS_SECTION_PERMISSIONS[sec as SettingsSectionId]
        : undefined;
}

/**
 * Permissões que alimentam algum bloco do Painel (Dashboard da equipe). Sem nenhuma delas, o Painel
 * mostra o estado vazio em vez de carregar dados que dariam 403.
 */
export const DASHBOARD_PERMISSIONS: readonly PermissionKey[] = [
    'hoje.ver', 'agendamentos.ver', 'contratos.ver', 'clientes.ver', 'financeiro.ver',
];
