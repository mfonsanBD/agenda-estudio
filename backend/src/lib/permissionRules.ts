// ─── Regras de permissão que dependem do CORPO / ESTADO ─
// Funções PURAS (sem banco, sem Express) consumidas pelos handlers das rotas multiuso. Cada uma
// devolve um RuleResult:
//   • requirements → TODOS precisam passar; cada requisito é "qualquer uma de" (anyOf);
//   • rejected     → campos recusados para TODOS, inclusive o ADMIN (o handler responde 400).
// O handler aplica com `enforceRuleResult(req, res, result)` (middleware/permissions.ts).
//
// NEGAR POR PADRÃO: todo campo presente no corpo sem regra mapeada exige o ADMIN (ADMIN_REQUIREMENT).
// Acrescentar um campo num schema zod sem acrescentar a regra aqui faz o teste unitário
// test/eq-staff-permissions.test.ts quebrar ("toda chave dos schemas tem regra").
//
// Regra por VALOR ALTERADO: só conta o campo cujo valor muda em relação ao registro atual (o
// EditBookingModal sempre manda date/startTime/status; o "Editar" de contratos reenvia endDate e
// flexCreditsRemaining). Exceções conscientes — o efeito do handler acontece pela PRESENÇA do campo:
//   • booking.noShowJustified (o handler reaplica a janela de remarcação sempre que vem no corpo);
//   • contract.addOns (applyContractServiceChange reprecifica as parcelas futuras mesmo com a mesma lista);
//   • user.password (não dá para comparar com o hash — e senha de cliente é só do ADMIN).
// Para isso, o registro atual (`target`) precisa vir COMPLETO (a linha do Prisma serve): campo AUSENTE
// no target conta como alterado sempre que o corpo traz um valor não vazio.

import {
    ADMIN_REQUIREMENT,
    permissionForConfigGroup,
    type RequirementKey,
} from '../config/staffPermissions.js';
import { CONFIG_CATALOG_BY_KEY } from '../config/businessConfigCatalog.js';

/** Um requisito: basta UMA das chaves (anyOf). `field` = campo do corpo que o gerou (diagnóstico). */
export interface Requirement {
    anyOf: readonly RequirementKey[];
    field: string;
}

/** Campo recusado para qualquer papel (400). */
export interface RejectedField {
    field: string;
    code: string;
    error: string;
}

export interface RuleResult {
    requirements: Requirement[];
    rejected: RejectedField[];
}

// ─── Utilitários ────────────────────────────────────────

const ADMIN_ONLY_REQ: readonly RequirementKey[] = [ADMIN_REQUIREMENT];

/** Acrescenta o requisito sem repetir (mesmo conjunto anyOf). */
function push(list: Requirement[], anyOf: readonly RequirementKey[], field: string): void {
    const sig = [...anyOf].sort().join('|');
    if (list.some(r => [...r.anyOf].sort().join('|') === sig)) return;
    list.push({ anyOf: [...anyOf], field });
}

/** Chaves presentes no corpo (valor !== undefined), na ordem do objeto. */
function presentKeys(data: object): string[] {
    return Object.keys(data).filter(k => (data as Record<string, unknown>)[k] !== undefined);
}

function has(obj: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(obj, key) && (obj as Record<string, unknown>)[key] !== undefined;
}

/** Texto: null, undefined e '' são o mesmo "vazio". */
function sameText(a: unknown, b: unknown): boolean {
    const norm = (v: unknown) => (v === null || v === undefined ? '' : String(v));
    return norm(a) === norm(b);
}

/** Valor escalar (número/booleano/null). */
function sameScalar(a: unknown, b: unknown): boolean {
    return (a ?? null) === (b ?? null);
}

/** Data de calendário 'YYYY-MM-DD' de uma coluna DATE/DateTime (UTC, como o handler compara). */
function isoDateUTC(v: unknown): string | null {
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
    return null;
}

/** Data de calendário no fuso LOCAL do servidor (o PATCH de contrato grava `new Date(d + 'T00:00:00')`). */
function isoDateLocal(v: unknown): string | null {
    if (!(v instanceof Date) || Number.isNaN(v.getTime())) return null;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
}

function sameStringArray(a: unknown, b: unknown): boolean {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ─── Agendamentos: PATCH /api/bookings/:id ──────────────

/** Status "abertos" (a sessão ainda vai acontecer). */
const OPEN_BOOKING_STATUSES = ['RESERVED', 'HELD', 'CONFIRMED'] as const;
/** Status de desfecho: sair deles reabre ou troca o desfecho (mexe em crédito, contrato, remarcação). */
const CLOSED_BOOKING_STATUSES = ['COMPLETED', 'FALTA', 'NAO_REALIZADO', 'CANCELLED'] as const;
const KNOWN_BOOKING_STATUSES: readonly string[] = [...OPEN_BOOKING_STATUSES, ...CLOSED_BOOKING_STATUSES];

/**
 * Requisitos de uma TRANSIÇÃO de status (de → para), na mesma tabela que o front usa para filtrar as
 * opções (status inline e EditBookingModal). Mesmo status → []. Status desconhecido → só ADMIN.
 *   • RESERVED/HELD → CONFIRMED ................ hoje.presenca OU agendamentos.editar
 *   • sair de COMPLETED/FALTA/NAO_REALIZADO/CANCELLED (reabrir ou trocar o desfecho)
 *                                               agendamentos.editar (+ agendamentos.faltas se envolve NAO_REALIZADO)
 *   • sair de CANCELLED (para qualquer status) .. agendamentos.editar E cobrancas.baixa (+ agendamentos.faltas
 *                                               se envolve NAO_REALIZADO) — R4 (ATK-02/FIN-01): o cancelamento
 *                                               anulou a cobrança da sessão e dos extras e liberou crédito/teto;
 *                                               reabrir revive a sessão sem cobrança. Para uma sessão nova, um
 *                                               novo agendamento. (A trava PLAN_SESSION_CANCELLED do handler —
 *                                               FLEX/Personalizado — continua valendo até para o ADMIN.)
 *   • CONFIRMED com gravação iniciada → COMPLETED hoje.gravacao OU agendamentos.editar
 *   • outros → COMPLETED ........................ agendamentos.editar
 *   • → FALTA / NAO_REALIZADO ................... agendamentos.faltas
 *   • → CANCELLED ............................... agendamentos.cancelar
 *   • → RESERVED (ex.: CONFIRMED → RESERVED) .... agendamentos.editar
 */
export function requiredForBookingStatusChange(
    from: string,
    to: string,
    opts: { recordingStarted: boolean },
): RequirementKey[][] {
    if (from === to) return [];
    if (!KNOWN_BOOKING_STATUSES.includes(from) || !KNOWN_BOOKING_STATUSES.includes(to)) return [[ADMIN_REQUIREMENT]];
    const out: Requirement[] = [];
    const closedFrom = (CLOSED_BOOKING_STATUSES as readonly string[]).includes(from);
    if (closedFrom) {
        push(out, ['agendamentos.editar'], 'status');
        // Reabrir uma sessão CANCELADA é mexer em dinheiro: a cobrança dela foi anulada no cancelamento.
        if (from === 'CANCELLED') push(out, ['cobrancas.baixa'], 'status');
        if (from === 'NAO_REALIZADO' || to === 'NAO_REALIZADO') push(out, ['agendamentos.faltas'], 'status');
    }
    switch (to) {
        case 'CONFIRMED':
            if (from === 'RESERVED' || from === 'HELD') push(out, ['hoje.presenca', 'agendamentos.editar'], 'status');
            break;
        case 'COMPLETED':
            if (from === 'CONFIRMED' && opts.recordingStarted) push(out, ['hoje.gravacao', 'agendamentos.editar'], 'status');
            else push(out, ['agendamentos.editar'], 'status');
            break;
        case 'FALTA':
        case 'NAO_REALIZADO':
            push(out, ['agendamentos.faltas'], 'status');
            break;
        case 'CANCELLED':
            push(out, ['agendamentos.cancelar'], 'status');
            break;
        default: // RESERVED, HELD
            push(out, ['agendamentos.editar'], 'status');
    }
    return out.map(r => [...r.anyOf]);
}

/** Registro atual do agendamento (a linha do Prisma serve). Campo ausente conta como alterado (valor não vazio no corpo). */
export interface BookingPatchTarget {
    status: string;
    date: Date | string;
    startTime: string;
    recordingStartedAt?: Date | string | null;
    statusReason?: string | null;
    adminNotes?: string | null;
    clientNotes?: string | null;
    platforms?: string | null;
    platformLinks?: string | null;
    durationMinutes?: number | null;
    peakViewers?: number | null;
    chatMessages?: number | null;
    audienceOrigin?: string | null;
    isLivestream?: boolean | null;
    streamMetrics?: string | null;
}

type BookingFieldRule = 'status' | 'slot' | 'faltas' | 'faltasPresenca' | 'notas';

/** Campos do `adminUpdateBookingSchema` (bookings/validators.ts) → regra. Campo fora daqui → só ADMIN. */
export const BOOKING_PATCH_FIELD_RULES: Readonly<Record<string, BookingFieldRule>> = {
    status: 'status',
    date: 'slot',
    startTime: 'slot',
    statusReason: 'faltas',
    noShowJustified: 'faltasPresenca',
    adminNotes: 'notas',
    clientNotes: 'notas',
    platforms: 'notas',
    platformLinks: 'notas',
    durationMinutes: 'notas',
    peakViewers: 'notas',
    chatMessages: 'notas',
    audienceOrigin: 'notas',
    isLivestream: 'notas',
    streamMetrics: 'notas',
};

const BOOKING_TEXT_FIELDS = new Set(['statusReason', 'adminNotes', 'clientNotes', 'platforms', 'platformLinks', 'audienceOrigin', 'streamMetrics']);

/**
 * PATCH /api/bookings/:id — requisitos por TRANSIÇÃO de status e por VALOR alterado (crítica F2):
 *   • status → requiredForBookingStatusChange(booking.status, data.status, gravação iniciada?)
 *   • date / startTime alterados → agendamentos.editar
 *   • statusReason alterado, noShowJustified presente → agendamentos.faltas
 *   • notas, links e métricas alterados → hoje.gravacao OU agendamentos.editar
 *   • qualquer outro campo → só ADMIN
 */
export function requiredForBookingPatch(data: object, booking: BookingPatchTarget): RuleResult {
    const requirements: Requirement[] = [];
    const d = data as Record<string, unknown>;
    const b = booking as unknown as Record<string, unknown>;
    for (const field of presentKeys(data)) {
        const rule = Object.prototype.hasOwnProperty.call(BOOKING_PATCH_FIELD_RULES, field) ? BOOKING_PATCH_FIELD_RULES[field] : undefined;
        const value = d[field];
        switch (rule) {
            case 'status': {
                const to = String(value);
                const groups = requiredForBookingStatusChange(String(booking.status), to, { recordingStarted: !!booking.recordingStartedAt });
                for (const g of groups) push(requirements, g, 'status');
                break;
            }
            case 'slot': {
                const changed = field === 'date'
                    ? String(value) !== isoDateUTC(booking.date)
                    : !has(booking, 'startTime') || String(value) !== booking.startTime;
                if (changed) push(requirements, ['agendamentos.editar'], field);
                break;
            }
            case 'faltas': {
                const changed = !(field in booking) ? !sameText(value, null) : !sameText(value, b[field]);
                if (changed) push(requirements, ['agendamentos.faltas'], field);
                break;
            }
            case 'faltasPresenca':
                push(requirements, ['agendamentos.faltas'], field);
                break;
            case 'notas': {
                const current = b[field];
                const changed = !(field in booking)
                    ? (BOOKING_TEXT_FIELDS.has(field) ? !sameText(value, null) : value !== null)
                    : BOOKING_TEXT_FIELDS.has(field) ? !sameText(value, current) : !sameScalar(value, current);
                if (changed) push(requirements, ['hoje.gravacao', 'agendamentos.editar'], field);
                break;
            }
            default:
                push(requirements, ADMIN_ONLY_REQ, field);
        }
    }
    return { requirements, rejected: [] };
}

// ─── Agendamentos: POST /api/bookings/admin ─────────────

/** Campos do `adminCreateBookingSchema` (bookings/validators.ts) → regra. Campo fora daqui → só ADMIN. */
export const ADMIN_BOOKING_CREATE_FIELDS: readonly string[] = [
    'userId', 'contractId', 'date', 'startTime', 'status', 'addOns', 'adminNotes', 'customPrice', 'paymentMethod', 'couponCode',
];

export interface AdminBookingCreateContext {
    /**
     * Preço que o servidor usaria SEM customPrice (base da faixa; com contrato, já com o desconto de
     * fidelidade — antes dos serviços). null = desconhecido (então todo customPrice exige a baixa).
     */
    standardPrice: number | null;
    /** O ator tem `cobrancas.baixa` (ADMIN sempre tem). */
    canMarkPaid: boolean;
}

export interface AdminBookingCreatePlan extends RuleResult {
    /** Status a gravar: CONFIRMED (pagamento PAID na hora) só com cobrancas.baixa. */
    status: 'RESERVED' | 'CONFIRMED';
    /** true = o corpo pediu CONFIRMED e foi rebaixado para RESERVED (pagamento PENDING). A resposta informa. */
    downgraded: boolean;
}

/** Mensagem para a resposta quando o "Confirmado" foi rebaixado (D7: nasce aguardando pagamento). */
export const ADMIN_BOOKING_DOWNGRADE_MESSAGE =
    'Agendamento criado como Reservado, aguardando pagamento: marcar como pago exige a permissão “Marcar como pago, anular ou estornar”.';

/**
 * Sessão de PLANO (FIXO, FLEX ou Personalizado) criada por quem não tem a baixa manual (REG-1): nasce
 * Reservada, mas o plano já cobre a sessão — nada fica "aguardando pagamento" além dos serviços extras.
 */
export function adminPlanBookingReservedMessage(extrasCharged: boolean): string {
    return extrasCharged
        ? 'Agendamento criado como Reservado (presença a confirmar). A sessão já é coberta pelo plano: só os serviços extras ficam aguardando pagamento.'
        : 'Agendamento criado como Reservado (presença a confirmar). A sessão já é coberta pelo plano: nenhuma cobrança foi gerada.';
}

/**
 * POST /api/bookings/admin (crítica F1 / D7):
 *   • sempre agendamentos.criar;
 *   • status CONFIRMED sem cobrancas.baixa → NÃO é 403: vira RESERVED (downgraded) — avulso com pagamento
 *     PENDING; sessão de plano sem cobrança da sessão (o plano já cobre; só os extras ficam PENDING);
 *   • customPrice diferente do preço padrão (inclusive 0) → cobrancas.baixa (403 se faltar);
 *   • paymentMethod BOLETO (o servidor emite o boleto no banco na hora) → cobrancas.cobrar
 *     ("Cobrar o cliente (PIX, boleto ou cartão digitado)", D2). PIX e CARTAO só criam a cobrança
 *     PENDING, que o agendamentos.criar já cria — o PIX/cartão em si sai pelo checkout (cobrancas.cobrar);
 *   • qualquer outro campo → só ADMIN.
 */
export function requiredForAdminBookingCreate(data: object, ctx: AdminBookingCreateContext): AdminBookingCreatePlan {
    const requirements: Requirement[] = [];
    push(requirements, ['agendamentos.criar'], 'userId');
    const d = data as Record<string, unknown>;
    for (const field of presentKeys(data)) {
        if (!ADMIN_BOOKING_CREATE_FIELDS.includes(field)) { push(requirements, ADMIN_ONLY_REQ, field); continue; }
        if (field === 'customPrice' && d.customPrice !== null) {
            if (ctx.standardPrice === null || ctx.standardPrice === undefined || d.customPrice !== ctx.standardPrice) {
                push(requirements, ['cobrancas.baixa'], 'customPrice');
            }
        }
        if (field === 'paymentMethod' && d.paymentMethod === 'BOLETO') push(requirements, ['cobrancas.cobrar'], field);
    }
    const wantsConfirmed = (d.status ?? 'CONFIRMED') === 'CONFIRMED'; // o schema tem default CONFIRMED
    const status: 'RESERVED' | 'CONFIRMED' = wantsConfirmed && ctx.canMarkPaid ? 'CONFIRMED' : 'RESERVED';
    return { requirements, rejected: [], status, downgraded: wantsConfirmed && !ctx.canMarkPaid };
}

// ─── Contratos: PATCH e DELETE /api/contracts/:id ───────

/** Registro atual do contrato (a linha do Prisma serve). Campo ausente conta como alterado. */
export interface ContractPatchTarget {
    status: string;
    endDate?: Date | string | null;
    flexCreditsRemaining?: number | null;
    contractUrl?: string | null;
    paymentMethod?: string | null;
    boletoAllowed?: boolean | null;
}

/** Campos do `updateContractSchema` (contracts/validators.ts). Campo fora daqui → só ADMIN. */
export const CONTRACT_PATCH_FIELDS: readonly string[] = [
    'status', 'endDate', 'flexCreditsRemaining', 'contractUrl', 'paymentMethod', 'boletoAllowed', 'addOns',
];

/**
 * PATCH /api/contracts/:id por VALOR alterado (crítica F3/F4):
 *   • status → CANCELLED: contratos.cancelar · ACTIVE/COMPLETED/EXPIRED: contratos.editar;
 *     contrato em PENDING_CANCELLATION + qualquer mudança de status (cancelar = isentar a multa;
 *     reabrir = recusar o pedido) → também contratos.multa;
 *     contrato CANCELLED + qualquer mudança de status (reabrir) → também contratos.cancelar E
 *     contratos.condicoes: desfaz a decisão de cancelar e devolve o uso dos créditos/sessões com as
 *     parcelas já anuladas (CANCELLED é terminal — nada volta a ser cobrável) (MAT-03 / DIN-04);
 *   • endDate, contractUrl, paymentMethod alterados → contratos.editar;
 *   • flexCreditsRemaining, boletoAllowed alterados → contratos.condicoes;
 *   • addOns presente → contratos.condicoes (reprecifica as parcelas futuras mesmo sem mudar a lista);
 *   • qualquer outro campo → só ADMIN.
 */
export function requiredForContractPatch(data: object, contract: ContractPatchTarget): RuleResult {
    const requirements: Requirement[] = [];
    const d = data as Record<string, unknown>;
    for (const field of presentKeys(data)) {
        const value = d[field];
        switch (field) {
            case 'status': {
                if (String(value) === contract.status) break;
                if (value === 'CANCELLED') push(requirements, ['contratos.cancelar'], field);
                else if (value === 'ACTIVE' || value === 'COMPLETED' || value === 'EXPIRED') push(requirements, ['contratos.editar'], field);
                else push(requirements, ADMIN_ONLY_REQ, field);
                if (contract.status === 'PENDING_CANCELLATION') push(requirements, ['contratos.multa'], field);
                if (contract.status === 'CANCELLED') {
                    push(requirements, ['contratos.cancelar'], field);
                    push(requirements, ['contratos.condicoes'], field);
                }
                break;
            }
            case 'endDate': {
                const v = String(value);
                const unchanged = has(contract, 'endDate') && (v === isoDateUTC(contract.endDate) || v === isoDateLocal(contract.endDate));
                if (!unchanged) push(requirements, ['contratos.editar'], field);
                break;
            }
            case 'contractUrl':
            case 'paymentMethod':
                if (!(field in contract) || !sameText(value, (contract as unknown as Record<string, unknown>)[field])) {
                    push(requirements, ['contratos.editar'], field);
                }
                break;
            case 'flexCreditsRemaining':
                if (!(field in contract) || !sameScalar(value, contract.flexCreditsRemaining)) push(requirements, ['contratos.condicoes'], field);
                break;
            case 'boletoAllowed':
                if (!(field in contract) || !sameScalar(value === true, contract.boletoAllowed === true)) push(requirements, ['contratos.condicoes'], field);
                break;
            case 'addOns':
                push(requirements, ['contratos.condicoes'], field);
                break;
            default:
                push(requirements, ADMIN_ONLY_REQ, field);
        }
    }
    return { requirements, rejected: [] };
}

/**
 * DELETE /api/contracts/:id (cancelar): contratos.cancelar; com pedido de cancelamento em análise
 * (PENDING_CANCELLATION) cancelar equivale a isentar a multa → também contratos.multa (crítica F3).
 */
export function requiredForContractCancel(contract: { status: string }): RuleResult {
    const requirements: Requirement[] = [];
    push(requirements, ['contratos.cancelar'], 'status');
    if (contract.status === 'PENDING_CANCELLATION') push(requirements, ['contratos.multa'], 'status');
    return { requirements, rejected: [] };
}

// ─── Clientes: POST e PATCH /api/users ──────────────────

/** Recusa (400) de `role` diferente de CLIENTE em /api/users — o papel se altera na tela Equipe. */
const ROLE_REJECTION: RejectedField = {
    field: 'role',
    code: 'ROLE_NOT_ALLOWED',
    error: 'O tipo de acesso não se altera aqui. Contas da equipe são gerenciadas na tela Equipe.',
};

/** Campos de cadastro do cliente (clientes.editar), comparados como texto. */
const USER_PROFILE_TEXT_FIELDS = [
    'name', 'phone', 'notes', 'address', 'addressNumber', 'complement', 'neighborhood', 'city', 'state', 'zipCode', 'socialLinks',
] as const;

/** Campos do `updateUserSchema` (users/users.crud.ts). Campo fora daqui → só ADMIN. */
export const USER_PATCH_FIELDS: readonly string[] = [
    ...USER_PROFILE_TEXT_FIELDS, 'email', 'role', 'password', 'cpfCnpj', 'tags', 'clientStatus',
];

/** Campos do `createUserSchema` (users/users.crud.ts). Campo fora daqui → só ADMIN. */
export const USER_CREATE_FIELDS: readonly string[] = USER_PATCH_FIELDS;

/** Registro atual do cliente (a linha do Prisma serve). Campo ausente conta como alterado. */
export interface UserPatchTarget {
    email?: string | null;
    cpfCnpj?: string | null;
    clientStatus?: string | null;
    name?: string | null;
    phone?: string | null;
    notes?: string | null;
    address?: string | null;
    addressNumber?: string | null;
    complement?: string | null;
    neighborhood?: string | null;
    city?: string | null;
    state?: string | null;
    zipCode?: string | null;
    tags?: string[] | null;
    socialLinks?: string | null;
}

const digits = (v: unknown): string => (v === null || v === undefined ? '' : String(v).replace(/\D/g, ''));
const emailNorm = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim().toLowerCase());

/**
 * PATCH /api/users/:id (alvo já conferido como CLIENTE) — por VALOR alterado (D3/D9, crítica F8):
 *   • role: 'CLIENTE' é aceito e ignorado (PWA antiga); qualquer outro valor → rejected (400);
 *   • password presente → só ADMIN (colaborador nunca define senha de cliente);
 *   • email alterado (sem diferenciar maiúsculas) → clientes.acesso;
 *   • clientStatus entrando ou saindo de BLOCKED → clientes.acesso; ACTIVE↔INACTIVE → clientes.editar;
 *   • cpfCnpj alterado → clientes.editar; se o cliente ainda NÃO tinha CPF/CNPJ → clientes.editar OU
 *     cobrancas.cobrar (CpfCnpjPrompt do checkout);
 *   • demais campos de cadastro alterados → clientes.editar;
 *   • qualquer outro campo → só ADMIN.
 */
export function requiredForUserPatch(data: object, target: UserPatchTarget): RuleResult {
    const requirements: Requirement[] = [];
    const rejected: RejectedField[] = [];
    const d = data as Record<string, unknown>;
    const t = target as Record<string, unknown>;
    for (const field of presentKeys(data)) {
        const value = d[field];
        if ((USER_PROFILE_TEXT_FIELDS as readonly string[]).includes(field)) {
            if (!(field in target) || !sameText(value, t[field])) push(requirements, ['clientes.editar'], field);
            continue;
        }
        switch (field) {
            case 'role':
                if (value !== 'CLIENTE') rejected.push({ ...ROLE_REJECTION });
                break;
            case 'password':
                push(requirements, ADMIN_ONLY_REQ, field);
                break;
            case 'email':
                if (!(field in target) || emailNorm(value) !== emailNorm(target.email)) push(requirements, ['clientes.acesso'], field);
                break;
            case 'clientStatus': {
                const from = field in target ? String(target.clientStatus ?? '') : '';
                const to = String(value);
                if (from === to) break;
                if (from === 'BLOCKED' || to === 'BLOCKED' || !(field in target)) push(requirements, ['clientes.acesso'], field);
                else push(requirements, ['clientes.editar'], field);
                break;
            }
            case 'cpfCnpj': {
                const before = field in target ? digits(target.cpfCnpj) : null;
                const after = digits(value);
                if (before === after) break;
                if (before === '') push(requirements, ['clientes.editar', 'cobrancas.cobrar'], field);
                else push(requirements, ['clientes.editar'], field);
                break;
            }
            case 'tags':
                if (!(field in target) || !sameStringArray(value, target.tags ?? [])) push(requirements, ['clientes.editar'], field);
                break;
            default:
                push(requirements, ADMIN_ONLY_REQ, field);
        }
    }
    return { requirements, rejected };
}

/**
 * POST /api/users (sempre cria CLIENTE):
 *   • sempre clientes.criar;
 *   • role: 'CLIENTE' aceito e ignorado; outro valor → rejected (400);
 *   • password presente → só ADMIN (sem senha, o cliente entra pelo código no e-mail);
 *   • clientStatus BLOCKED → clientes.acesso (nascer bloqueado é decisão de acesso);
 *   • demais campos do schema → nada além de clientes.criar; campo fora do schema → só ADMIN.
 */
export function requiredForUserCreate(data: object): RuleResult {
    const requirements: Requirement[] = [];
    const rejected: RejectedField[] = [];
    push(requirements, ['clientes.criar'], 'email');
    const d = data as Record<string, unknown>;
    for (const field of presentKeys(data)) {
        if (!USER_CREATE_FIELDS.includes(field)) { push(requirements, ADMIN_ONLY_REQ, field); continue; }
        if (field === 'role' && d.role !== 'CLIENTE') rejected.push({ ...ROLE_REJECTION });
        if (field === 'password') push(requirements, ADMIN_ONLY_REQ, field);
        if (field === 'clientStatus' && d.clientStatus === 'BLOCKED') push(requirements, ['clientes.acesso'], field);
    }
    return { requirements, rejected };
}

// ─── Pagamentos: PATCH /api/payments/:id ────────────────

/** Campos do `updatePaymentSchema` (payments/payments.admin.ts). Campo fora daqui → só ADMIN. */
export const PAYMENT_PATCH_FIELDS: readonly string[] = ['status', 'paymentMethod', 'providerRef', 'notes'];

/** PATCH /api/payments/:id: toda transição manual é baixa → cobrancas.baixa; campo desconhecido → só ADMIN. */
export function requiredForPaymentPatch(data: object): RuleResult {
    const requirements: Requirement[] = [];
    push(requirements, ['cobrancas.baixa'], 'status');
    for (const field of presentKeys(data)) {
        if (!PAYMENT_PATCH_FIELDS.includes(field)) push(requirements, ADMIN_ONLY_REQ, field);
    }
    return { requirements, rejected: [] };
}

// ─── Configurações: PUT /api/pricing/business-config ────

/**
 * Grupo de uma chave de business-config: o do catálogo (businessConfigCatalog.ts); se a chave não
 * estiver lá, o da linha no banco (`dbGroups`, ex.: as chaves `schedule` do seed); senão "outros".
 */
export function businessConfigGroupOf(key: string, dbGroups: Readonly<Record<string, string>> = {}): string {
    const fromCatalog = Object.prototype.hasOwnProperty.call(CONFIG_CATALOG_BY_KEY, key) ? CONFIG_CATALOG_BY_KEY[key]?.group : undefined;
    if (fromCatalog) return fromCatalog;
    const fromDb = Object.prototype.hasOwnProperty.call(dbGroups, key) ? dbGroups[key] : undefined;
    return fromDb || 'outros';
}

export interface BusinessConfigRuleResult extends RuleResult {
    /** Grupo → permissão exigida (para o 403 listar os grupos negados e para filtrar o GET). */
    groups: Record<string, RequirementKey>;
}

/**
 * PUT /api/pricing/business-config — TUDO OU NADA: cada grupo tocado exige a sua permissão
 * (studio→config.gerais, schedule→config.horarios, plans/payments→config.precos,
 * policies→config.politicas, ambient→config.ambiente, recordings→config.gravacoes;
 * email→config.email, gateway→config.taxas e qualquer outro grupo → só ADMIN).
 */
export function requiredForBusinessConfig(keys: readonly string[], dbGroups: Readonly<Record<string, string>> = {}): BusinessConfigRuleResult {
    const requirements: Requirement[] = [];
    const groups: Record<string, RequirementKey> = {};
    for (const key of keys) {
        const group = businessConfigGroupOf(key, dbGroups);
        const perm = permissionForConfigGroup(group);
        groups[group] = perm;
        push(requirements, [perm], key);
    }
    return { requirements, rejected: [], groups };
}
