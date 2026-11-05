// FRENTE T — apoio dos testes da matriz de permissões da EQUIPE (DECISOES-EQUIPE D2/D4, proposta §6.3).
//
// O que fica aqui (e não num arquivo de teste):
//  • MOUNTS: os MESMOS routers e prefixos do src/index.ts (eq-route-invariants confere que não divergem),
//    para a matriz rodar sobre a composição real da API (sub-routers, router.use, ordem de montagem);
//  • buildApp / startServer / call / cookieFor: sessão por JWT no cookie, como as rotas leem;
//  • datas no calendário de São Paulo e fixtures reais (factories.ts) para as rotas que dependem de estado;
//  • MATRIX: a TABELA DA VERDADE — uma linha por rota administrativa ou mista (e variantes de corpo das
//    rotas multiuso), com a permissão que libera. Executada em eq-permissions-matrix.test.ts e cruzada com
//    a pilha real do Express em eq-route-invariants.test.ts (toda rota guardada precisa de uma linha, e a
//    chave declarada precisa bater com a guarda da rota);
//  • MATRIX_ALL_OF: as rotas que exigem DUAS (ou mais) chaves ao mesmo tempo (requireAllPermissions). Ficam
//    numa tabela própria porque na MATRIX `need` é "qualquer uma" e o laço concede uma chave por vez.
//    Executada em eq-x3-renew-avisos.test.ts e cruzada com a pilha real em eq-route-invariants.test.ts.
//  • R4e (QT-01/QT-02): as linhas MISTAS declaram o status EXATO de quem passa (`ok`, e `ownerOk` quando o
//    dono tem outro) — um 404 da equipe autorizada não conta mais como "passou" — e a sonda de um CLIENTE
//    que NÃO é o dono (`stranger`), conferindo também que o estado das fixtures (`Probe.state`) não mudou.

import express, { type Router } from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { config } from '../../src/config/index';
import { prisma } from '../../src/lib/prisma';
import { errorHandler } from '../../src/middleware/errorHandler';
import { saoPauloParts } from '../../src/lib/spTime';
import { addDaysYmd } from '../../src/lib/avulsoMakeup';
import { allPermissionKeys, type PermissionKey } from '../../src/config/staffPermissions';
import authRoutes from '../../src/modules/auth/routes';
import bookingRoutes from '../../src/modules/bookings/routes';
import contractRoutes from '../../src/modules/contracts/routes';
import userRoutes from '../../src/modules/users/routes';
import blockedSlotRoutes from '../../src/modules/blocked-slots/routes';
import pricingRoutes from '../../src/modules/pricing/routes';
import ambientRoutes from '../../src/modules/ambient/routes';
import paymentRoutes from '../../src/modules/payments/routes';
import { financeRouter } from '../../src/modules/finance/routes';
import notificationRoutes from '../../src/modules/notifications/routes';
import reportRoutes from '../../src/modules/reports/routes';
import integrationRoutes from '../../src/modules/integrations/routes';
import webhookRoutes from '../../src/modules/webhooks/routes';
import stripeRoutes from '../../src/modules/stripe/routes';
import pushRoutes from '../../src/modules/push/routes';
import couponRoutes from '../../src/modules/coupons/routes';
import staffRoutes from '../../src/modules/staff/routes';
import { mkUser, mkStaff, mkContract, mkBooking, mkPayment, mkCoupon, mkBlockedSlot, mkCpf } from './factories';

// ─── App com a composição do src/index.ts ───────────────

/** Mesma ordem e prefixos do index.ts. `module` = o caminho do import lá (o teste de invariantes compara). */
export const MOUNTS: ReadonlyArray<{ path: string; module: string; router: Router }> = [
    { path: '/api/auth', module: './modules/auth/routes.js', router: authRoutes },
    { path: '/api/bookings', module: './modules/bookings/routes.js', router: bookingRoutes },
    { path: '/api/contracts', module: './modules/contracts/routes.js', router: contractRoutes },
    { path: '/api/users', module: './modules/users/routes.js', router: userRoutes },
    { path: '/api/blocked-slots', module: './modules/blocked-slots/routes.js', router: blockedSlotRoutes },
    { path: '/api/pricing', module: './modules/pricing/routes.js', router: pricingRoutes },
    { path: '/api/ambient', module: './modules/ambient/routes.js', router: ambientRoutes },
    { path: '/api/payments', module: './modules/payments/routes.js', router: paymentRoutes },
    { path: '/api/finance', module: './modules/finance/routes.js', router: financeRouter },
    { path: '/api/notifications', module: './modules/notifications/routes.js', router: notificationRoutes },
    { path: '/api/reports', module: './modules/reports/routes.js', router: reportRoutes },
    { path: '/api/integrations', module: './modules/integrations/routes.js', router: integrationRoutes },
    { path: '/api/webhooks', module: './modules/webhooks/routes.js', router: webhookRoutes },
    { path: '/api/stripe', module: './modules/stripe/routes.js', router: stripeRoutes },
    { path: '/api/push', module: './modules/push/routes.js', router: pushRoutes },
    { path: '/api/coupons', module: './modules/coupons/routes.js', router: couponRoutes },
    { path: '/api/staff', module: './modules/staff/routes.js', router: staffRoutes },
];

/** A API sem os rate limits (os testes fazem muitas chamadas seguidas do mesmo IP). */
export function buildApp(): express.Express {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    for (const m of MOUNTS) app.use(m.path, m.router);
    app.use(errorHandler);
    return app;
}

export async function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
    const app = buildApp();
    let server!: Server;
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

// ─── Sessão e chamadas ──────────────────────────────────

export type Who = { id: string; email: string | null; role: string };
export interface Res { status: number; body: any }

/** Cookie de sessão como o login emite. `role` = o papel que o TOKEN carrega (pode divergir do banco). */
export function cookieFor(u: Who, opts: { role?: string; iat?: number } = {}): string {
    const payload = { userId: u.id, email: u.email ?? '', role: opts.role ?? u.role, ...(opts.iat ? { iat: opts.iat } : {}) };
    return `accessToken=${jwt.sign(payload, config.jwt.secret, { expiresIn: '1h' })}`;
}

export function refreshCookieFor(u: Who): string {
    return `refreshToken=${jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.refreshSecret, { expiresIn: '1d' })}`;
}

/** Chamada HTTP. `who` = usuário (cookie gerado) ou um cookie pronto (string). Timeout para não pendurar a suíte. */
export async function call(base: string, method: string, path: string, who?: Who | string, body?: unknown): Promise<Res> {
    const cookie = typeof who === 'string' ? who : who ? cookieFor(who) : undefined;
    const res = await fetch(`${base}${path}`, {
        method,
        headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

/** 403 da matriz (o 403 sem `code`, como o do sandbox do /simulate, não é recusa de permissão). */
export const isPermissionDenied = (r: Res) => r.status === 403 && r.body?.code === 'PERMISSION_DENIED';

// ─── Chaves ─────────────────────────────────────────────

export const ALL_KEYS: PermissionKey[] = allPermissionKeys();
export const CONFIG_KEYS: PermissionKey[] = ALL_KEYS.filter(k => k.startsWith('config.'));
export const allExcept = (...keys: readonly string[]): PermissionKey[] => ALL_KEYS.filter(k => !keys.includes(k));

/** Perfil "Recepção / Atendimento" (DECISOES D2). */
export const RECEPCAO: PermissionKey[] = [
    'agendamentos.ver', 'agendamentos.criar', 'agendamentos.editar', 'agendamentos.faltas', 'agendamentos.cancelar',
    'hoje.ver', 'hoje.presenca', 'clientes.ver', 'clientes.criar', 'clientes.editar', 'contratos.ver', 'contratos.criar',
    'cobrancas.cobrar', 'cupons.ver',
];

// ─── Datas (relógio real, calendário de São Paulo) ──────

export const todaySp = saoPauloParts(new Date()).dateStr;
export const dbDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const dow = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
const isWeekday = (ymd: string) => dow(ymd) >= 1 && dow(ymd) <= 5;
/** n-ésimo dia útil (seg–sex, faixa COMERCIAL) a partir de hoje + 3 dias (n = 0, 1, 2…). */
export function weekdayN(n: number): string {
    let found = -1;
    for (let d = addDaysYmd(todaySp, 3); ; d = addDaysYmd(d, 1)) {
        if (isWeekday(d) && ++found === n) return d;
    }
}
/** Próxima data (≥ hoje + minDays) no dia da semana `wd` (0..6). */
export function nextDow(wd: number, minDays: number): string {
    let d = addDaysYmd(todaySp, minDays);
    while (dow(d) !== wd) d = addDaysYmd(d, 1);
    return d;
}
const SLOT_TIMES = ['10:00', '13:00', '15:30'];
const plus2h = (time: string) => {
    const [h, m] = time.split(':').map(Number);
    return `${String(h! + 2).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
/** Horário distinto por sondagem para gravações de HOJE (não disputa índice de data+hora+status). */
const todayTime = (k: number) => `${String(6 + (k % 14)).padStart(2, '0')}:${k >= 14 ? '30' : '00'}`;

// ─── Fixtures (sempre do DONO informado) ────────────────

/** FLEX ativo + gravação futura (dia útil `k`, 10:00) do dono. */
export async function seedFlexBooking(owner: Who, k: number, over: Record<string, unknown> = {}) {
    const contract = await mkContract(owner.id, { type: 'FLEX', flexCreditsTotal: 12, flexCreditsRemaining: 5 });
    const date = weekdayN(k);
    const booking = await mkBooking(owner.id, contract.id, {
        date: dbDate(date), startTime: '10:00', endTime: '12:00', status: 'CONFIRMED', price: 12345, ...over,
    });
    return { contract, booking, date };
}

/**
 * R5 (UXT-08): FIXO ativo + gravação futura (dia útil `k`, 10:00) do dono, SEM cobrança nenhuma. Serve para
 * reabrir uma sessão CANCELADA de verdade: o FLEX e o Personalizado não saem de CANCELLED → aberto (DIN-01,
 * 409 PLAN_SESSION_CANCELLED para todos), o FIXO sim.
 */
export async function seedFixoBooking(owner: Who, k: number, over: Record<string, unknown> = {}) {
    const contract = await mkContract(owner.id, { type: 'FIXO' });
    const date = weekdayN(k);
    const booking = await mkBooking(owner.id, contract.id, {
        date: dbDate(date), startTime: '10:00', endTime: '12:00', status: 'CONFIRMED', price: 12345, ...over,
    });
    return { contract, booking, date };
}

/**
 * R5: gravação FLEX futura (CONFIRMED) com uma cobrança EM ABERTO dela (extra, `bookingId` + `contractId`).
 * Cancelar anularia essa cobrança (voidExtrasOfCancelledBooking) — "anular" é da baixa (cobrancas.baixa).
 */
export async function seedFlexBookingWithOpenCharge(owner: Who, k: number, chargeStatus: 'PENDING' | 'FAILED' = 'PENDING') {
    const seeded = await seedFlexBooking(owner, k);
    const charge = await mkPayment(owner.id, {
        contractId: seeded.contract.id, bookingId: seeded.booking.id, status: chargeStatus, amount: 5000,
    });
    return { ...seeded, charge };
}

/** A sessão foi cancelada DE VERDADE e a cobrança em aberto dela, anulada (efeito de quem passa da permissão). */
export const cancelledWithChargeVoided = (bookingId: string, paymentId: string) => async () => {
    const [b, p] = await Promise.all([
        prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { status: true } }),
        prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true } }),
    ]);
    return b.status === 'CANCELLED' && p.status === 'CANCELLED';
};

/** A sessão está no status `want` (ex.: reaberta de verdade). */
export const bookingStatusIs = (bookingId: string, want: string) => async () =>
    (await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { status: true } })).status === want;

/** Sessão (null depois da exclusão definitiva) e a cobrança dela — o estado que sobrevive ao hard-delete. */
export const bookingAndChargeState = (bookingId: string, paymentId: string) => async () => ({
    booking: await prisma.booking.findUnique({ where: { id: bookingId }, select: { status: true, date: true, startTime: true } }),
    charge: await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true, bookingId: true } }),
});

/** A sessão foi excluída DE VERDADE e a cobrança em aberto dela, anulada antes. */
export const deletedWithChargeVoided = (bookingId: string, paymentId: string) => async () => {
    const { booking, charge } = await bookingAndChargeState(bookingId, paymentId)();
    return booking === null && charge.status === 'CANCELLED';
};

/**
 * Conserto 5: avulso do dono (micro-contrato ACTIVE + gravação futura RESERVED) com a cobrança da sessão EM ABERTO
 * (marcada) — o que o POST /bookings/admin da Recepção cria. Cancelar o contrato ou excluir o cliente a anularia.
 */
export async function seedAvulsoWithOpenCharge(owner: Who, k: number) {
    const date = weekdayN(k);
    const contract = await mkContract(owner.id, {
        type: 'AVULSO', durationMonths: 1, discountPct: 0, startDate: dbDate(date), endDate: dbDate(date),
        paymentPlan: 'FULL', flexCreditsTotal: 1, flexCreditsRemaining: 0,
    });
    const booking = await mkBooking(owner.id, contract.id, {
        date: dbDate(date), startTime: '10:00', endTime: '12:00', status: 'RESERVED', price: 30000,
    });
    const charge = await mkPayment(owner.id, {
        contractId: contract.id, bookingId: booking.id, status: 'PENDING', amount: 30000, metadata: { sessionCharge: true },
    });
    return { contract, booking, charge };
}

/** Contrato, sessão e cobrança — o estado que uma sonda recusada não pode mudar (pausa / cancelamento do contrato). */
export const contractBookingChargeState = (contractId: string, bookingId: string, paymentId: string) => async () => ({
    contract: await prisma.contract.findUniqueOrThrow({ where: { id: contractId }, select: { status: true } }),
    booking: await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { status: true } }),
    charge: await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true } }),
});

/** O contrato chegou a `contractStatus`, a sessão foi cancelada e a cobrança em aberto dela, anulada. */
export const contractMovedWithChargeVoided = (contractId: string, bookingId: string, paymentId: string, contractStatus: string) => async () => {
    const s = await contractBookingChargeState(contractId, bookingId, paymentId)();
    return s.contract.status === contractStatus && s.booking.status === 'CANCELLED' && s.charge.status === 'CANCELLED';
};

/** Cliente (excluído ou não) + contratos/cobranças/sessões dele. */
const clientAndDeletionState = (userId: string) => async () => ({
    user: await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { deletedAt: true, email: true } }),
    ...(await clientState(userId)),
});

/** Gravação de HOJE do dono (para Hoje: iniciar/desfazer/finalizar). */
export async function seedTodayBooking(owner: Who, k: number, over: Record<string, unknown> = {}) {
    const contract = await mkContract(owner.id, { type: 'FLEX', flexCreditsTotal: 12, flexCreditsRemaining: 5 });
    const time = todayTime(k);
    const booking = await mkBooking(owner.id, contract.id, {
        date: dbDate(todaySp), startTime: time, endTime: plus2h(time), status: 'CONFIRMED', price: 12345, ...over,
    });
    return { contract, booking };
}

/**
 * Avulso ATIVO de ontem, pago, NÃO REALIZADO, com a janela de remarcação ABERTA (D5) — o dono remarca pelo
 * ramo dele e a equipe (agendamentos.faltas) também: os dois chegam ao sucesso real (200).
 */
export async function seedAvulsoMissed(owner: Who) {
    const yesterday = addDaysYmd(todaySp, -1);
    const contract = await mkContract(owner.id, {
        type: 'AVULSO', durationMonths: 1, discountPct: 0, startDate: dbDate(yesterday), endDate: dbDate(yesterday),
        paymentPlan: 'FULL', flexCreditsTotal: 1, flexCreditsRemaining: 1,
    });
    const booking = await mkBooking(owner.id, contract.id, {
        date: dbDate(yesterday), startTime: '10:00', endTime: '12:00', tierApplied: 'COMERCIAL', status: 'NAO_REALIZADO',
        missedDate: dbDate(yesterday), makeupStatus: 'OPEN', makeupDeadline: new Date(Date.now() + 30 * 86_400_000),
    });
    await mkPayment(owner.id, { contractId: contract.id, bookingId: booking.id, status: 'PAID', amount: 30000, paidAt: new Date() });
    return { contract, booking };
}

const sicoobPayment = (owner: Who) => mkPayment(owner.id, { provider: 'SICOOB', amount: 84000, dueDate: new Date('2026-09-20T00:00:00Z') });

// ─── Estado que a sonda do CLIENTE estranho não pode mudar (QT-02) ──

/** A cobrança inteira que um efeito mudaria (baixa, emissão de PIX/boleto/PI, troca de provedor, valor). */
export const paymentState = (id: string) => prisma.payment.findUniqueOrThrow({
    where: { id },
    select: {
        status: true, provider: true, providerRef: true, pixString: true, pixExpiresAt: true, boletoUrl: true,
        amount: true, chargedAmount: true, installments: true, paidAt: true, metadata: true,
    },
});

/** A sessão (status, horário, janela de remarcação), o saldo do contrato e as cobranças ligadas à sessão. */
export async function bookingState(bookingId: string) {
    const booking = await prisma.booking.findUniqueOrThrow({
        where: { id: bookingId },
        select: { status: true, date: true, startTime: true, endTime: true, makeupStatus: true, makeupDeadline: true, addOns: true, contractId: true },
    });
    const contract = booking.contractId
        ? await prisma.contract.findUniqueOrThrow({ where: { id: booking.contractId }, select: { status: true, flexCreditsRemaining: true } })
        : null;
    const payments = await prisma.payment.findMany({ where: { bookingId }, orderBy: { id: 'asc' }, select: { id: true, status: true, amount: true } });
    return { booking, contract, payments };
}

/** Contratos e cobranças do cliente (o estranho não cria nem descarta nada em nome dele). */
export async function clientState(userId: string) {
    const contracts = await prisma.contract.findMany({ where: { userId }, orderBy: { id: 'asc' }, select: { id: true, status: true, type: true } });
    const payments = await prisma.payment.findMany({ where: { userId }, orderBy: { id: 'asc' }, select: { id: true, status: true } });
    const bookings = await prisma.booking.findMany({ where: { userId }, orderBy: { id: 'asc' }, select: { id: true, status: true } });
    return { contracts, payments, bookings };
}

/** Sandbox do PIX (Sicoob habilitado em 'sandbox'): o /simulate chega ao sucesso real. Idempotente. */
export async function enablePixSandbox() {
    await prisma.integrationConfig.upsert({
        where: { provider: 'SICOOB' },
        create: { provider: 'SICOOB', enabled: true, environment: 'sandbox', config: '{}' },
        update: { enabled: true, environment: 'sandbox' },
    });
}
let emailSeq = 0;
export const uniqueEmail = (tag: string) => `eq-t-${tag}-${Date.now().toString(36)}-${++emailSeq}@example.com`;

// ─── Tabela da verdade ──────────────────────────────────

export interface Probe {
    method: string;
    path: string;
    body?: unknown;
    /**
     * Estado das fixtures lido antes e depois de cada sonda: a do CLIENTE estranho (QT-02) e toda sonda
     * RECUSADA (sem login, 403) não podem mudá-lo (R5 — UXT-08).
     */
    state?: () => Promise<unknown>;
    /**
     * R5 (UXT-08): a ação aconteceu DE VERDADE? Lido depois da chamada. Quem passa da permissão (a equipe com a
     * chave, o ADMIN e, nas mistas, o dono) precisa devolver true; toda sonda recusada, false. Sem isto uma
     * linha "passava" com um 409 de outra regra (ex.: DIN-01) sem nunca executar a ação.
     */
    applied?: () => Promise<boolean>;
}
export interface BuildCtx {
    /** Índice da sondagem (varia data/horário/e-mail quando a rota cria algo). */
    k: number;
    /** Cliente DONO das fixtures. Nas rotas mistas, o ramo do cliente é testado com ele. */
    owner: Who;
}

/**
 * `need`: QUALQUER UMA das chaves libera ('ADMIN' = só o administrador; 'CLIENTE' = autoatendimento, a
 * equipe inteira é recusada). `mixed`: rota de cliente e equipe (o dono segue o ramo dele). `bodyRule`:
 * a permissão sai do corpo/estado (lib/permissionRules), não só da guarda da rota.
 *
 * Rota MISTA (QT-01/QT-02) — toda linha `mixed` declara `ok` e `stranger`:
 *  • `ok`: status EXATO de quem passa da permissão — COLABORADOR só com cada chave de `need` e o ADMIN — e
 *    também do DONO (salvo `ownerOk`). Sem isso um 404 (o filtro do cliente aplicado à equipe) "passava";
 *  • `stranger`: status EXATO de um CLIENTE que NÃO é o dono das fixtures (404 nas rotas com id de recurso;
 *    o ramo do cliente nas que ignoram o `userId` do corpo), com `Probe.state` igual antes e depois.
 */
export interface MatrixRow {
    method: string;
    path: string;
    label?: string;
    need: readonly PermissionKey[] | 'ADMIN' | 'CLIENTE';
    mixed?: boolean;
    bodyRule?: boolean;
    /**
     * Chaves exigidas JUNTO com a de `need` (regra de corpo/estado "E"): a sonda "só com <chave>" recebe
     * também estas, e "com <chave> sem uma delas" → 403 citando exatamente a que falta.
     */
    alsoNeed?: readonly PermissionKey[];
    /** Status exato de sucesso da equipe autorizada (e do dono, nas mistas, salvo `ownerOk`). */
    ok?: number;
    /** Rota mista: status exato do DONO quando difere de `ok`. */
    ownerOk?: number;
    /** Rota mista: status exato do CLIENTE estranho (não dono das fixtures). */
    stranger?: number;
    /** `code` exato da resposta do estranho, quando a recusa tem um. */
    strangerCode?: string;
    build: (ctx: BuildCtx) => Promise<Probe>;
}

/**
 * Rota que exige TODAS as chaves de `needAll` (requireAllPermissions; ADMIN passa sempre). Semântica da
 * execução: sem login → 401; CLIENTE → 403; COLABORADOR sem chaves → 403; COLABORADOR com TODAS as chaves
 * do catálogo MENOS uma delas → 403 citando exatamente a que falta (cada chave é obrigatória); COLABORADOR
 * só com `needAll` → passa; ADMIN → passa.
 */
export interface MatrixAllOfRow {
    method: string;
    path: string;
    label?: string;
    needAll: readonly PermissionKey[];
    build: (ctx: BuildCtx) => Promise<Probe>;
}

export const matrixRouteKey = (row: Pick<MatrixRow, 'method' | 'path'>) => `${row.method} ${row.path}`;
export const matrixRowName = (row: Pick<MatrixRow, 'method' | 'path' | 'label'>) => `${matrixRouteKey(row)}${row.label ? ` [${row.label}]` : ''}`;

const at = (method: string, path: string, body?: unknown, state?: () => Promise<unknown>, applied?: () => Promise<boolean>): Probe =>
    ({ method, path, body, state, applied });
/** Amanhã no calendário de SP: o personalizado do CLIENTE só começa amanhã (D7) — assim o dono chega ao sucesso. */
const tomorrowSp = addDaysYmd(todaySp, 1);
const newAdmin = () => mkUser({ role: 'ADMIN' });
const RANGE = '?from=2026-09-01&to=2026-09-30';
const EVENT = 'payment_confirmed';
/** Aviso da EQUIPE (audiência "admin"): o modelo só o ADMIN altera, restaura ou testa (MAT-02/NS-1). */
const TEAM_EVENT = 'admin_card_double_charge';

export const MATRIX: MatrixRow[] = [
    // ══ Agenda e Agendamentos / Hoje (bookings) ══
    { method: 'GET', path: '/api/bookings', need: ['agendamentos.ver', 'hoje.ver'],
        build: async ({ owner, k }) => { await seedFlexBooking(owner, k); return at('GET', '/api/bookings'); } },
    { method: 'POST', path: '/api/bookings/admin', need: ['agendamentos.criar'],
        build: async ({ owner, k }) => at('POST', '/api/bookings/admin', { userId: owner.id, date: weekdayN(k), startTime: '10:00', status: 'RESERVED' }) },
    // Cancelar sessão SEM cobrança em aberto: só agendamentos.cancelar (seedFlexBooking não cria cobrança).
    { method: 'PATCH', path: '/api/bookings/:id', label: 'status → CANCELLED', need: ['agendamentos.cancelar'], bodyRule: true, ok: 200,
        build: async ({ owner, k }) => {
            const { booking } = await seedFlexBooking(owner, k);
            return at('PATCH', `/api/bookings/${booking.id}`, { status: 'CANCELLED' }, () => bookingState(booking.id), bookingStatusIs(booking.id, 'CANCELLED'));
        } },
    { method: 'PATCH', path: '/api/bookings/:id', label: 'modal completo só cancelando (date/startTime iguais)', need: ['agendamentos.cancelar'], bodyRule: true,
        build: async ({ owner, k }) => {
            const { booking, date } = await seedFlexBooking(owner, k);
            return at('PATCH', `/api/bookings/${booking.id}`, { date, startTime: '10:00', status: 'CANCELLED' });
        } },
    // R5 (anular cobrança em aberto é da baixa): cancelar sessão com cobrança PENDING/FAILED — qualquer status,
    // não só a que "já aconteceu" — exige também cobrancas.baixa; sem ela, 403 citando a baixa e NADA muda
    // (sessão e cobrança). Quem tem as duas (e o ADMIN) cancela e a cobrança é anulada.
    { method: 'PATCH', path: '/api/bookings/:id', label: 'status → CANCELLED com cobrança em aberto (exige também a baixa)', need: ['agendamentos.cancelar'],
        alsoNeed: ['cobrancas.baixa'], bodyRule: true, ok: 200,
        build: async ({ owner, k }) => {
            const { booking, charge } = await seedFlexBookingWithOpenCharge(owner, k, 'PENDING');
            return at('PATCH', `/api/bookings/${booking.id}`, { status: 'CANCELLED' }, () => bookingState(booking.id), cancelledWithChargeVoided(booking.id, charge.id));
        } },
    { method: 'PATCH', path: '/api/bookings/:id', label: 'status → FALTA com motivo', need: ['agendamentos.faltas'], bodyRule: true,
        build: async ({ owner, k }) => {
            const { booking } = await seedFlexBooking(owner, k);
            return at('PATCH', `/api/bookings/${booking.id}`, { status: 'FALTA', statusReason: 'Cliente não compareceu.' });
        } },
    { method: 'PATCH', path: '/api/bookings/:id', label: 'RESERVED → CONFIRMED', need: ['hoje.presenca', 'agendamentos.editar'], bodyRule: true,
        build: async ({ owner, k }) => {
            const { booking } = await seedFlexBooking(owner, k, { status: 'RESERVED' });
            return at('PATCH', `/api/bookings/${booking.id}`, { status: 'CONFIRMED' });
        } },
    // R4 (ATK-02/FIN-01): sair de CANCELLED exige agendamentos.editar E cobrancas.baixa (a cobrança da sessão
    // foi anulada no cancelamento). R5 (UXT-08): sessão FIXO sem cobrança — fora da trava DIN-01 (o FLEX dava
    // 409 PLAN_SESSION_CANCELLED a todos e a sonda nunca reabria). Editar + baixa e o ADMIN reabrem DE VERDADE
    // (200 e status CONFIRMED); só com editar → 403 citando a baixa, sessão intacta.
    { method: 'PATCH', path: '/api/bookings/:id', label: 'reabrir CANCELLED (hoje.presenca não basta; exige também a baixa)', need: ['agendamentos.editar'],
        alsoNeed: ['cobrancas.baixa'], bodyRule: true, ok: 200,
        build: async ({ owner, k }) => {
            const { booking } = await seedFixoBooking(owner, k, { status: 'CANCELLED' });
            return at('PATCH', `/api/bookings/${booking.id}`, { status: 'CONFIRMED' }, () => bookingState(booking.id), bookingStatusIs(booking.id, 'CONFIRMED'));
        } },
    { method: 'PATCH', path: '/api/bookings/:id', label: 'reabrir FALTA (hoje.presenca não basta)', need: ['agendamentos.editar'], bodyRule: true,
        build: async ({ owner, k }) => {
            const { booking } = await seedFlexBooking(owner, k, { status: 'FALTA' });
            return at('PATCH', `/api/bookings/${booking.id}`, { status: 'CONFIRMED' });
        } },
    { method: 'PATCH', path: '/api/bookings/:id', label: 'gravação iniciada → COMPLETED', need: ['hoje.gravacao', 'agendamentos.editar'], bodyRule: true,
        build: async ({ owner, k }) => {
            const { booking } = await seedTodayBooking(owner, k, { recordingStartedAt: new Date(Date.now() - 30 * 60_000) });
            return at('PATCH', `/api/bookings/${booking.id}`, { status: 'COMPLETED' });
        } },
    { method: 'PATCH', path: '/api/bookings/:id', label: 'mudar data e horário', need: ['agendamentos.editar'], bodyRule: true,
        build: async ({ owner, k }) => {
            const { booking } = await seedFlexBooking(owner, k);
            return at('PATCH', `/api/bookings/${booking.id}`, { date: weekdayN(k + 20), startTime: '13:00' });
        } },
    { method: 'PATCH', path: '/api/bookings/:id', label: 'notas da gravação', need: ['hoje.gravacao', 'agendamentos.editar'], bodyRule: true,
        build: async ({ owner, k }) => {
            const { booking } = await seedFlexBooking(owner, k);
            return at('PATCH', `/api/bookings/${booking.id}`, { adminNotes: 'Trazer microfone extra.' });
        } },
    // Dono: > 24 h, sessão CONFIRMED → 200 (devolve o crédito). Estranho: 404, sessão e saldo intactos.
    // Sessão SEM cobrança em aberto: a equipe cancela só com agendamentos.cancelar.
    { method: 'DELETE', path: '/api/bookings/:id', label: 'cancelar (mista)', need: ['agendamentos.cancelar'], mixed: true, ok: 200, stranger: 404,
        build: async ({ owner, k }) => {
            const { booking } = await seedFlexBooking(owner, k);
            return at('DELETE', `/api/bookings/${booking.id}`, undefined, () => bookingState(booking.id), bookingStatusIs(booking.id, 'CANCELLED'));
        } },
    // R5: com cobrança em aberto (aqui FAILED), a EQUIPE precisa também da baixa — sem ela, 403 citando a baixa e
    // nada muda. O dono segue o ramo dele (> 24 h → 200, a cobrança da gravação cancelada é anulada); estranho: 404.
    { method: 'DELETE', path: '/api/bookings/:id', label: 'cancelar com cobrança em aberto (mista; a equipe precisa também da baixa)', need: ['agendamentos.cancelar'],
        alsoNeed: ['cobrancas.baixa'], bodyRule: true, mixed: true, ok: 200, stranger: 404,
        build: async ({ owner, k }) => {
            const { booking, charge } = await seedFlexBookingWithOpenCharge(owner, k, 'FAILED');
            return at('DELETE', `/api/bookings/${booking.id}`, undefined, () => bookingState(booking.id), cancelledWithChargeVoided(booking.id, charge.id));
        } },
    { method: 'DELETE', path: '/api/bookings/:id/hard-delete', need: ['agendamentos.excluir'],
        build: async ({ owner, k }) => { const { booking } = await seedFlexBooking(owner, k); return at('DELETE', `/api/bookings/${booking.id}/hard-delete`); } },
    // R5: excluir também anula a cobrança em aberto da gravação → sem a baixa, 403 citando a baixa e nada muda
    // (a sessão continua lá e a cobrança, em aberto). Com as duas chaves (e o ADMIN), exclui e anula.
    { method: 'DELETE', path: '/api/bookings/:id/hard-delete', label: 'com cobrança em aberto (exige também a baixa)', need: ['agendamentos.excluir'],
        alsoNeed: ['cobrancas.baixa'], bodyRule: true, ok: 200,
        build: async ({ owner, k }) => {
            const { booking, charge } = await seedFlexBookingWithOpenCharge(owner, k, 'PENDING');
            return at('DELETE', `/api/bookings/${booking.id}/hard-delete`, undefined,
                bookingAndChargeState(booking.id, charge.id), deletedWithChargeVoided(booking.id, charge.id));
        } },
    // Janela aberta: dono e equipe remarcam (200). Estranho: 404, a gravação perdida continua onde estava.
    { method: 'PATCH', path: '/api/bookings/:id/makeup', label: 'remarcar avulso perdido (mista)', need: ['agendamentos.faltas'], mixed: true, ok: 200, stranger: 404,
        build: async ({ owner, k }) => {
            const { booking } = await seedAvulsoMissed(owner);
            return at('PATCH', `/api/bookings/${booking.id}/makeup`, { date: weekdayN(k), startTime: SLOT_TIMES[k % 3] }, () => bookingState(booking.id));
        } },
    { method: 'POST', path: '/api/bookings/cleanup-orphan-addons', need: 'ADMIN',
        build: async () => at('POST', '/api/bookings/cleanup-orphan-addons') },
    { method: 'PUT', path: '/api/bookings/:id/check-in', need: ['hoje.presenca'],
        build: async ({ owner, k }) => { const { booking } = await seedFlexBooking(owner, k, { status: 'RESERVED' }); return at('PUT', `/api/bookings/${booking.id}/check-in`); } },
    { method: 'PUT', path: '/api/bookings/:id/start-recording', need: ['hoje.gravacao'],
        build: async ({ owner, k }) => { const { booking } = await seedTodayBooking(owner, k); return at('PUT', `/api/bookings/${booking.id}/start-recording`); } },
    { method: 'PUT', path: '/api/bookings/:id/undo-start-recording', need: ['hoje.gravacao'],
        build: async ({ owner, k }) => {
            const { booking } = await seedTodayBooking(owner, k, { recordingStartedAt: new Date(Date.now() - 10 * 60_000) });
            return at('PUT', `/api/bookings/${booking.id}/undo-start-recording`);
        } },
    { method: 'PUT', path: '/api/bookings/:id/complete', need: ['hoje.gravacao'],
        build: async ({ owner, k }) => {
            const { booking } = await seedTodayBooking(owner, k, { recordingStartedAt: new Date(Date.now() - 30 * 60_000) });
            return at('PUT', `/api/bookings/${booking.id}/complete`, {});
        } },
    { method: 'POST', path: '/api/bookings', need: 'CLIENTE', build: async () => at('POST', '/api/bookings', {}) },
    { method: 'POST', path: '/api/bookings/bulk', need: 'CLIENTE', build: async () => at('POST', '/api/bookings/bulk', {}) },

    // ══ Bloqueios de horário ══
    { method: 'POST', path: '/api/blocked-slots', need: ['agendamentos.editar'],
        build: async ({ k }) => at('POST', '/api/blocked-slots', { date: weekdayN(k + 30), startTime: '10:00', endTime: '12:00', reason: 'Manutenção' }) },
    { method: 'GET', path: '/api/blocked-slots', need: ['agendamentos.ver'], build: async () => at('GET', '/api/blocked-slots') },
    { method: 'DELETE', path: '/api/blocked-slots/:id', need: ['agendamentos.editar'],
        build: async ({ k }) => {
            const creator = await newAdmin();
            const slot = await mkBlockedSlot(creator.id, { date: dbDate(weekdayN(k + 30)) });
            return at('DELETE', `/api/blocked-slots/${slot.id}`);
        } },

    // ══ Contratos ══
    { method: 'POST', path: '/api/contracts', need: ['contratos.criar'],
        build: async ({ owner, k }) => at('POST', '/api/contracts', {
            userId: owner.id, name: `Plano ${k}`, type: 'FLEX', tier: 'COMERCIAL', durationMonths: 3, startDate: weekdayN(k), paymentMethod: 'PIX',
        }) },
    { method: 'POST', path: '/api/contracts/self', need: 'CLIENTE', build: async () => at('POST', '/api/contracts/self', {}) },
    { method: 'POST', path: '/api/contracts/service', need: 'CLIENTE', build: async () => at('POST', '/api/contracts/service', {}) },
    // Início amanhã (o único que o cliente pode escolher — D7): dono e equipe criam (201). O estranho manda o
    // `userId` do dono no corpo, mas o ramo do cliente o ignora: cria para SI (201) e nada muda no dono.
    { method: 'POST', path: '/api/contracts/custom', label: 'personalizado (mista)', need: ['contratos.criar'], mixed: true, ok: 201, stranger: 201,
        build: async ({ owner, k }) => {
            const wd = 1 + (k % 5); // seg..sex: criações no mesmo teste não disputam o mesmo horário
            return at('POST', '/api/contracts/custom', {
                userId: owner.id, name: 'Personalizado', tier: 'COMERCIAL', durationMonths: 1, paymentMethod: 'CARTAO',
                paymentPlan: 'MONTHLY', schedule: [{ day: wd, time: SLOT_TIMES[Math.floor(k / 5) % 3] }], startDate: tomorrowSp,
            }, () => clientState(owner.id));
        } },
    // Simulação (sem gravar nada). O `userId` do corpo só vale para a equipe; o estranho simula para si (200).
    { method: 'POST', path: '/api/contracts/custom/check', label: 'mista', need: ['contratos.criar'], mixed: true, ok: 200, stranger: 200,
        build: async ({ owner }) => at('POST', '/api/contracts/custom/check', {
            userId: owner.id, tier: 'COMERCIAL', durationMonths: 1, startDate: tomorrowSp, schedule: [{ day: 2, time: '10:00' }],
        }, () => clientState(owner.id)) },
    { method: 'GET', path: '/api/contracts', need: ['contratos.ver', 'agendamentos.criar'],
        build: async ({ owner }) => { await mkContract(owner.id); return at('GET', '/api/contracts'); } },
    { method: 'GET', path: '/api/contracts/:id', label: 'mista', need: ['contratos.ver'], mixed: true, ok: 200, stranger: 404,
        build: async ({ owner }) => { const c = await mkContract(owner.id); return at('GET', `/api/contracts/${c.id}`); } },
    { method: 'PATCH', path: '/api/contracts/:id', label: 'link do contrato', need: ['contratos.editar'], bodyRule: true,
        build: async ({ owner }) => { const c = await mkContract(owner.id); return at('PATCH', `/api/contracts/${c.id}`, { contractUrl: 'https://exemplo.com/contrato.pdf' }); } },
    { method: 'PATCH', path: '/api/contracts/:id', label: '"Editar" reenviando endDate e créditos atuais', need: ['contratos.editar'], bodyRule: true,
        build: async ({ owner }) => {
            const c = await mkContract(owner.id, { flexCreditsTotal: 12, flexCreditsRemaining: 5 });
            return at('PATCH', `/api/contracts/${c.id}`, {
                endDate: c.endDate.toISOString().slice(0, 10), flexCreditsRemaining: 5, contractUrl: 'https://exemplo.com/novo.pdf',
            });
        } },
    { method: 'PATCH', path: '/api/contracts/:id', label: 'status → EXPIRED', need: ['contratos.editar'], bodyRule: true,
        build: async ({ owner }) => { const c = await mkContract(owner.id); return at('PATCH', `/api/contracts/${c.id}`, { status: 'EXPIRED' }); } },
    { method: 'PATCH', path: '/api/contracts/:id', label: 'status → CANCELLED', need: ['contratos.cancelar'], bodyRule: true,
        build: async ({ owner }) => { const c = await mkContract(owner.id); return at('PATCH', `/api/contracts/${c.id}`, { status: 'CANCELLED' }); } },
    { method: 'PATCH', path: '/api/contracts/:id', label: 'créditos FLEX', need: ['contratos.condicoes'], bodyRule: true,
        build: async ({ owner }) => {
            const c = await mkContract(owner.id, { flexCreditsTotal: 12, flexCreditsRemaining: 5 });
            return at('PATCH', `/api/contracts/${c.id}`, { flexCreditsRemaining: 7 });
        } },
    { method: 'PATCH', path: '/api/contracts/:id', label: 'liberar boleto no contrato', need: ['contratos.condicoes'], bodyRule: true,
        build: async ({ owner }) => { const c = await mkContract(owner.id, { boletoAllowed: false }); return at('PATCH', `/api/contracts/${c.id}`, { boletoAllowed: true }); } },
    { method: 'DELETE', path: '/api/contracts/:id', need: ['contratos.cancelar'],
        build: async ({ owner }) => { const c = await mkContract(owner.id); return at('DELETE', `/api/contracts/${c.id}`); } },
    // Conserto 5 (ATU5-03): no avulso o contrato é a própria sessão — cancelar anula a cobrança dela → também a baixa.
    { method: 'DELETE', path: '/api/contracts/:id', label: 'avulso com cobrança em aberto (exige também a baixa)', need: ['contratos.cancelar'],
        alsoNeed: ['cobrancas.baixa'], bodyRule: true, ok: 200,
        build: async ({ owner, k }) => {
            const { contract, booking, charge } = await seedAvulsoWithOpenCharge(owner, k);
            return at('DELETE', `/api/contracts/${contract.id}`, undefined,
                contractBookingChargeState(contract.id, booking.id, charge.id), contractMovedWithChargeVoided(contract.id, booking.id, charge.id, 'CANCELLED'));
        } },
    { method: 'POST', path: '/api/contracts/:id/resolve-cancellation', need: ['contratos.multa'],
        build: async ({ owner }) => {
            const c = await mkContract(owner.id, { status: 'PENDING_CANCELLATION' });
            return at('POST', `/api/contracts/${c.id}/resolve-cancellation`, { action: 'WAIVE_FEE' });
        } },
    // POST /api/contracts/:id/renew exige contratos.criar E cobrancas.baixa → MATRIX_ALL_OF (abaixo).
    { method: 'PATCH', path: '/api/contracts/:id/pause', need: ['contratos.editar'],
        build: async ({ owner }) => { const c = await mkContract(owner.id); return at('PATCH', `/api/contracts/${c.id}/pause`, { reason: 'Férias' }); } },
    // Conserto 5 (AUDFIN-03): pausar o FIXO cancela as gravações futuras do plano — uma com cobrança em aberto (extra
    // contratado nela) seria anulada → sem a baixa, 403 citando a baixa e nada muda; com as duas (e o ADMIN), pausa e anula.
    { method: 'PATCH', path: '/api/contracts/:id/pause', label: 'FIXO com cobrança em aberto numa gravação futura (exige também a baixa)', need: ['contratos.editar'],
        alsoNeed: ['cobrancas.baixa'], bodyRule: true, ok: 200,
        build: async ({ owner, k }) => {
            const { contract, booking } = await seedFixoBooking(owner, k, { status: 'RESERVED' });
            const charge = await mkPayment(owner.id, {
                contractId: contract.id, bookingId: booking.id, status: 'PENDING', amount: 5000, paymentUrl: JSON.stringify({ addonKeys: ['CORTES_IA'] }),
            });
            return at('PATCH', `/api/contracts/${contract.id}/pause`, { reason: 'Férias' },
                contractBookingChargeState(contract.id, booking.id, charge.id), contractMovedWithChargeVoided(contract.id, booking.id, charge.id, 'PAUSED'));
        } },
    { method: 'PATCH', path: '/api/contracts/:id/resume', need: ['contratos.editar'],
        build: async ({ owner }) => {
            const c = await mkContract(owner.id, { status: 'PAUSED', pausedAt: new Date(Date.now() - 3 * 86_400_000) });
            return at('PATCH', `/api/contracts/${c.id}/resume`);
        } },

    // ══ Clientes (/api/users só trata de CLIENTE) ══
    { method: 'GET', path: '/api/users', need: ['clientes.ver', 'agendamentos.ver', 'contratos.ver', 'cupons.ver', 'avisos.enviar'],
        build: async () => at('GET', '/api/users') },
    { method: 'GET', path: '/api/users/:id', need: ['clientes.ver'], build: async ({ owner }) => at('GET', `/api/users/${owner.id}`) },
    { method: 'POST', path: '/api/users', need: ['clientes.criar'],
        build: async ({ k }) => at('POST', '/api/users', { name: `Cliente Novo ${k}`, email: uniqueEmail('novo') }) },
    { method: 'PATCH', path: '/api/users/:id', label: 'cadastro (nome)', need: ['clientes.editar'], bodyRule: true,
        build: async ({ owner }) => at('PATCH', `/api/users/${owner.id}`, { name: 'Nome Corrigido' }) },
    { method: 'PATCH', path: '/api/users/:id', label: 'e-mail de login', need: ['clientes.acesso'], bodyRule: true,
        build: async ({ owner }) => at('PATCH', `/api/users/${owner.id}`, { email: uniqueEmail('login') }) },
    { method: 'PATCH', path: '/api/users/:id', label: 'bloquear acesso', need: ['clientes.acesso'], bodyRule: true,
        build: async ({ owner }) => at('PATCH', `/api/users/${owner.id}`, { clientStatus: 'BLOCKED' }) },
    { method: 'PATCH', path: '/api/users/:id', label: 'CPF ainda vazio (checkout)', need: ['clientes.editar', 'cobrancas.cobrar'], bodyRule: true,
        build: async ({ owner }) => at('PATCH', `/api/users/${owner.id}`, { cpfCnpj: mkCpf() }) },
    { method: 'PATCH', path: '/api/users/:id', label: 'senha do cliente (só ADMIN)', need: 'ADMIN', bodyRule: true,
        build: async ({ owner }) => at('PATCH', `/api/users/${owner.id}`, { password: 'senha-nova-123' }) },
    { method: 'GET', path: '/api/users/:id/deletion-preview', need: ['clientes.excluir'],
        build: async ({ owner }) => at('GET', `/api/users/${owner.id}/deletion-preview`) },
    { method: 'DELETE', path: '/api/users/:id', need: ['clientes.excluir'], build: async ({ owner }) => at('DELETE', `/api/users/${owner.id}`) },
    // Conserto 5 (AUDFIN-04): excluir o cliente cancela o contrato em andamento e anula a cobrança da sessão — cada coisa
    // pede a chave dela (contratos.cancelar, cobrancas.baixa). Sem uma delas, 403 citando a que falta e NADA muda.
    { method: 'DELETE', path: '/api/users/:id', label: 'cliente com avulso em aberto (exige também cancelar contrato e a baixa)', need: ['clientes.excluir'],
        alsoNeed: ['contratos.cancelar', 'cobrancas.baixa'], bodyRule: true, ok: 200,
        build: async ({ owner, k }) => {
            const { charge } = await seedAvulsoWithOpenCharge(owner, k);
            return at('DELETE', `/api/users/${owner.id}`, undefined, clientAndDeletionState(owner.id), async () => {
                const u = await prisma.user.findUniqueOrThrow({ where: { id: owner.id }, select: { deletedAt: true } });
                const p = await prisma.payment.findUniqueOrThrow({ where: { id: charge.id }, select: { status: true } });
                return u.deletedAt !== null && p.status === 'CANCELLED';
            });
        } },
    // DECISOES resposta 3 (EQ-REQ-05): o card "Pagamento" do perfil não é receita consolidada — abre com o perfil.
    { method: 'GET', path: '/api/users/:id/payment-overview', need: ['clientes.ver', 'financeiro.ver', 'cobrancas.automatica'],
        build: async ({ owner }) => { await sicoobPayment(owner); return at('GET', `/api/users/${owner.id}/payment-overview`); } },
    { method: 'PATCH', path: '/api/users/:id/auto-charge', need: ['cobrancas.automatica'],
        build: async ({ owner }) => at('PATCH', `/api/users/${owner.id}/auto-charge`, { enabled: false }) },

    // ══ Equipe (/api/staff: só ADMIN) ══
    { method: 'GET', path: '/api/staff/catalog', need: 'ADMIN', build: async () => at('GET', '/api/staff/catalog') },
    { method: 'GET', path: '/api/staff', need: 'ADMIN', build: async () => at('GET', '/api/staff') },
    { method: 'POST', path: '/api/staff', need: 'ADMIN',
        build: async () => at('POST', '/api/staff', { name: 'Novo Membro', email: uniqueEmail('staff'), role: 'COLABORADOR', permissions: ['agendamentos.ver'], sendAccessEmail: false }) },
    { method: 'PATCH', path: '/api/staff/:id', need: 'ADMIN',
        build: async () => { const t = await mkStaff({ permissions: ['hoje.ver'] }); return at('PATCH', `/api/staff/${t.id}`, { title: 'Recepção' }); } },
    { method: 'POST', path: '/api/staff/:id/password', need: 'ADMIN',
        build: async () => { const t = await mkStaff(); return at('POST', `/api/staff/${t.id}/password`, { password: 'senha-forte-123' }); } },
    { method: 'POST', path: '/api/staff/:id/send-access', need: 'ADMIN',
        build: async () => { const t = await mkStaff(); return at('POST', `/api/staff/${t.id}/send-access`); } },
    { method: 'POST', path: '/api/staff/:id/deactivate', need: 'ADMIN',
        build: async () => { const t = await mkStaff(); return at('POST', `/api/staff/${t.id}/deactivate`); } },
    { method: 'POST', path: '/api/staff/:id/reactivate', need: 'ADMIN',
        build: async () => { const t = await mkStaff({ overrides: { clientStatus: 'BLOCKED' } }); return at('POST', `/api/staff/${t.id}/reactivate`); } },

    // ══ Cobranças e financeiro ══
    { method: 'GET', path: '/api/payments', need: ['financeiro.ver'], build: async () => at('GET', '/api/payments') },
    { method: 'GET', path: '/api/payments/summary', need: ['financeiro.ver'], build: async () => at('GET', '/api/payments/summary') },
    { method: 'PATCH', path: '/api/payments/:id', label: 'baixa manual', need: ['cobrancas.baixa'],
        build: async ({ owner }) => { const p = await sicoobPayment(owner); return at('PATCH', `/api/payments/${p.id}`, { status: 'CANCELLED' }); } },
    // Cobranças: a equipe autorizada recebe o sucesso REAL na cobrança do dono (nunca o 404 do filtro do
    // cliente — QT-01); o estranho, 404 e a cobrança intacta (QT-02).
    { method: 'GET', path: '/api/payments/:id/status', label: 'mista', need: ['cobrancas.cobrar', 'financeiro.ver', 'cobrancas.baixa'], mixed: true, ok: 200, stranger: 404,
        build: async ({ owner }) => { const p = await sicoobPayment(owner); return at('GET', `/api/payments/${p.id}/status`, undefined, () => paymentState(p.id)); } },
    // Sicoob em sandbox: o "Simular" chega à baixa (200 PAID) para o dono e para a equipe.
    { method: 'POST', path: '/api/payments/:id/simulate', label: 'mista; só sandbox', need: ['cobrancas.cobrar'], mixed: true, ok: 200, stranger: 404,
        build: async ({ owner }) => {
            await enablePixSandbox();
            const p = await sicoobPayment(owner);
            return at('POST', `/api/payments/${p.id}/simulate`, undefined, () => paymentState(p.id));
        } },
    { method: 'GET', path: '/api/finance/closing/:year/:month', need: ['financeiro.ver'], build: async () => at('GET', '/api/finance/closing/2026/9') },
    { method: 'GET', path: '/api/stripe/payment-methods/for-payment/:paymentId', need: ['cobrancas.cobrar'],
        build: async ({ owner }) => { const p = await sicoobPayment(owner); return at('GET', `/api/stripe/payment-methods/for-payment/${p.id}`); } },
    // Cartão novo (o PaymentIntent é mockado): nada barra antes da busca da cobrança (o boleto parava no
    // BOLETO_UNAVAILABLE, antes do findFirst) — o dono e a equipe abrem o PI no Customer do dono (200).
    { method: 'POST', path: '/api/stripe/create-payment', label: 'mista', need: ['cobrancas.cobrar'], mixed: true, ok: 200, stranger: 404,
        build: async ({ owner }) => {
            const p = await sicoobPayment(owner);
            return at('POST', '/api/stripe/create-payment', { paymentId: p.id, paymentMethod: 'cartao' }, () => paymentState(p.id));
        } },
    { method: 'POST', path: '/api/stripe/installment-plans', label: 'com paymentId (mista)', need: ['cobrancas.cobrar'], mixed: true, ok: 200, stranger: 404,
        build: async ({ owner }) => {
            const p = await sicoobPayment(owner);
            return at('POST', '/api/stripe/installment-plans', { paymentId: p.id }, () => paymentState(p.id));
        } },
    // PI mockado ainda não aprovado: 200 "Ainda não confirmado" (o caminho com o PI aprovado está em eq-r4-matriz-mistas).
    { method: 'POST', path: '/api/stripe/verify-payment', label: 'mista', need: ['cobrancas.cobrar'], mixed: true, ok: 200, stranger: 404,
        build: async ({ owner }) => {
            const p = await sicoobPayment(owner);
            return at('POST', '/api/stripe/verify-payment', { paymentId: p.id, paymentIntentId: 'pi_x' }, () => paymentState(p.id));
        } },
    { method: 'POST', path: '/api/stripe/setup-intent', need: 'CLIENTE', build: async () => at('POST', '/api/stripe/setup-intent') },
    { method: 'PUT', path: '/api/stripe/auto-charge', need: 'CLIENTE', build: async () => at('PUT', '/api/stripe/auto-charge', { enabled: false }) },

    // ══ Relatórios ══
    { method: 'GET', path: '/api/reports/summary', need: ['relatorios.ver'], build: async () => at('GET', `/api/reports/summary${RANGE}`) },
    { method: 'GET', path: '/api/reports/occupancy', need: ['relatorios.ver'], build: async () => at('GET', `/api/reports/occupancy${RANGE}`) },
    { method: 'GET', path: '/api/reports/tiers', need: ['relatorios.ver'], build: async () => at('GET', `/api/reports/tiers${RANGE}`) },
    { method: 'GET', path: '/api/reports/audience', need: ['relatorios.ver'], build: async () => at('GET', `/api/reports/audience${RANGE}`) },
    { method: 'GET', path: '/api/reports/ranking', need: ['relatorios.ver'], build: async () => at('GET', `/api/reports/ranking${RANGE}`) },

    // ══ Cupons ══
    { method: 'GET', path: '/api/coupons', need: ['cupons.ver'], build: async () => at('GET', '/api/coupons') },
    { method: 'GET', path: '/api/coupons/:id', need: ['cupons.ver'],
        build: async () => { const c = await mkCoupon((await newAdmin()).id, { active: true }); return at('GET', `/api/coupons/${c.id}`); } },
    { method: 'POST', path: '/api/coupons', need: ['cupons.editar'],
        build: async ({ k }) => at('POST', '/api/coupons', { code: `EQT${k}X${Date.now().toString(36).toUpperCase()}`, discountType: 'PERCENTUAL', discountValue: 10 }) },
    { method: 'PATCH', path: '/api/coupons/:id', need: ['cupons.editar'],
        build: async () => { const c = await mkCoupon((await newAdmin()).id, { active: true }); return at('PATCH', `/api/coupons/${c.id}`, { active: false }); } },
    { method: 'DELETE', path: '/api/coupons/:id', need: ['cupons.editar'],
        build: async () => { const c = await mkCoupon((await newAdmin()).id, { active: true }); return at('DELETE', `/api/coupons/${c.id}`); } },
    // Cupom EXCLUSIVO do dono: o dono e a equipe (alvo = dono) validam (200). O estranho manda o `userId` do
    // dono, mas o cliente é sempre avaliado como ele mesmo → 403 NOT_ELIGIBLE (não sonda a conta alheia).
    { method: 'POST', path: '/api/coupons/validate', label: 'com userId alvo (mista)', need: ['agendamentos.criar', 'contratos.criar', 'cobrancas.cobrar'], mixed: true,
        ok: 200, stranger: 403, strangerCode: 'NOT_ELIGIBLE',
        build: async ({ owner }) => {
            const c = await mkCoupon((await newAdmin()).id, { active: true, eligibleUsers: { create: [{ userId: owner.id }] } });
            return at('POST', '/api/coupons/validate', { code: c.code, amount: 10000, userId: owner.id });
        } },

    // ══ Avisos e modelos de mensagem ══
    { method: 'GET', path: '/api/notifications/admin/events', need: ['avisos.modelos', 'avisos.enviar'], build: async () => at('GET', '/api/notifications/admin/events') },
    { method: 'PUT', path: '/api/notifications/admin/templates/:eventKey', need: ['avisos.modelos'],
        build: async () => at('PUT', `/api/notifications/admin/templates/${EVENT}`, { enabled: true }) },
    { method: 'DELETE', path: '/api/notifications/admin/templates/:eventKey', need: ['avisos.modelos'],
        build: async () => at('DELETE', `/api/notifications/admin/templates/${EVENT}`) },
    { method: 'POST', path: '/api/notifications/admin/templates/:eventKey/test', need: ['avisos.modelos'],
        build: async () => at('POST', `/api/notifications/admin/templates/${EVENT}/test`, { nonce: 1 }) },
    // Avisos da equipe (audiência "admin"): mesma guarda de rota (avisos.modelos), mas o handler exige o ADMIN.
    { method: 'PUT', path: '/api/notifications/admin/templates/:eventKey', label: 'modelo de aviso da equipe', need: 'ADMIN', bodyRule: true,
        build: async () => at('PUT', `/api/notifications/admin/templates/${TEAM_EVENT}`, { enabled: false }) },
    { method: 'DELETE', path: '/api/notifications/admin/templates/:eventKey', label: 'modelo de aviso da equipe', need: 'ADMIN', bodyRule: true,
        build: async () => at('DELETE', `/api/notifications/admin/templates/${TEAM_EVENT}`) },
    { method: 'POST', path: '/api/notifications/admin/templates/:eventKey/test', label: 'modelo de aviso da equipe', need: 'ADMIN', bodyRule: true,
        build: async () => at('POST', `/api/notifications/admin/templates/${TEAM_EVENT}/test`, { nonce: 2 }) },
    { method: 'POST', path: '/api/notifications/admin/broadcast', need: ['avisos.enviar'],
        build: async ({ owner }) => at('POST', '/api/notifications/admin/broadcast', { title: 'Aviso de teste', message: 'Mensagem de teste', target: [owner.id], sendPush: false }) },
    { method: 'GET', path: '/api/notifications/admin/broadcasts', need: ['avisos.enviar', 'avisos.modelos'], build: async () => at('GET', '/api/notifications/admin/broadcasts') },

    // ══ Configurações ══
    { method: 'GET', path: '/api/pricing/business-config', label: 'qualquer config.*', need: CONFIG_KEYS, build: async () => at('GET', '/api/pricing/business-config') },
    { method: 'PUT', path: '/api/pricing/business-config', label: 'grupo policies', need: ['config.politicas'], bodyRule: true,
        build: async () => at('PUT', '/api/pricing/business-config', { configs: [{ key: 'cancellation_fine_pct', value: '20' }] }) },
    { method: 'PUT', path: '/api/pricing/business-config', label: 'grupo email (SMTP)', need: 'ADMIN', bodyRule: true,
        build: async () => at('PUT', '/api/pricing/business-config', { configs: [{ key: 'email_smtp_host', value: 'smtp.exemplo.test' }] }) },
    { method: 'GET', path: '/api/pricing/business-config/fee-history', need: 'ADMIN', build: async () => at('GET', '/api/pricing/business-config/fee-history') },
    { method: 'POST', path: '/api/pricing/business-config/email/test', need: 'ADMIN', build: async () => at('POST', '/api/pricing/business-config/email/test', {}) },
    { method: 'PUT', path: '/api/pricing', label: 'faixas', need: ['config.precos'],
        build: async () => at('PUT', '/api/pricing', { pricing: [{ tier: 'COMERCIAL', price: 30000, label: 'Comercial' }] }) },
    { method: 'GET', path: '/api/pricing/addons/all', need: ['config.servicos'], build: async () => at('GET', '/api/pricing/addons/all') },
    { method: 'PUT', path: '/api/pricing/addons', need: ['config.servicos'], build: async () => at('PUT', '/api/pricing/addons', { addons: [] }) },
    { method: 'DELETE', path: '/api/pricing/addons/:key', need: ['config.servicos'], build: async () => at('DELETE', '/api/pricing/addons/NAO_EXISTE') },
    { method: 'GET', path: '/api/pricing/payment-methods/all', need: ['config.pagamentos'], build: async () => at('GET', '/api/pricing/payment-methods/all') },
    { method: 'PUT', path: '/api/pricing/payment-methods', need: ['config.pagamentos'], build: async () => at('PUT', '/api/pricing/payment-methods', { methods: [] }) },
    { method: 'PUT', path: '/api/pricing/payment-methods/boleto', need: ['config.pagamentos'], build: async () => at('PUT', '/api/pricing/payment-methods/boleto', { enabled: false }) },

    // ══ Integrações (só ADMIN) ══
    { method: 'GET', path: '/api/integrations', need: 'ADMIN', build: async () => at('GET', '/api/integrations') },
    { method: 'GET', path: '/api/integrations/:provider', need: 'ADMIN', build: async () => at('GET', '/api/integrations/STRIPE') },
    { method: 'PUT', path: '/api/integrations/:provider', need: 'ADMIN', build: async () => at('PUT', '/api/integrations/NAO_EXISTE', { config: {} }) },
    { method: 'POST', path: '/api/integrations/:provider/test', need: 'ADMIN', build: async () => at('POST', '/api/integrations/NAO_EXISTE/test') },
    { method: 'POST', path: '/api/integrations/:provider/toggle', need: 'ADMIN', build: async () => at('POST', '/api/integrations/NAO_EXISTE/toggle', { enabled: false }) },
    { method: 'GET', path: '/api/integrations/cora/webhooks', need: 'ADMIN', build: async () => at('GET', '/api/integrations/cora/webhooks') },
    { method: 'POST', path: '/api/integrations/cora/webhooks', need: 'ADMIN', build: async () => at('POST', '/api/integrations/cora/webhooks', {}) },
    { method: 'DELETE', path: '/api/integrations/cora/webhooks/:id', need: 'ADMIN', build: async () => at('DELETE', '/api/integrations/cora/webhooks/wh_test') },
    { method: 'GET', path: '/api/integrations/sicoob/webhook', need: 'ADMIN', build: async () => at('GET', '/api/integrations/sicoob/webhook') },
    { method: 'POST', path: '/api/integrations/sicoob/webhook', need: 'ADMIN',
        build: async () => at('POST', '/api/integrations/sicoob/webhook', { url: 'https://exemplo.test/api/webhooks/sicoob' }) },
    { method: 'DELETE', path: '/api/integrations/sicoob/webhook', need: 'ADMIN', build: async () => at('DELETE', '/api/integrations/sicoob/webhook') },
];

/** Rotas com DUAS chaves obrigatórias (requireAllPermissions). Ver MatrixAllOfRow. */
export const MATRIX_ALL_OF: MatrixAllOfRow[] = [
    // Renovar cria o plano ATIVO sem parcelas (serviço sem cobrança): além de "Criar e renovar contratos",
    // exige "Marcar como pago, anular ou estornar" (DECISOES D3/resposta 2 — MAT-01/DIN-02/EQ-REQ-01).
    { method: 'POST', path: '/api/contracts/:id/renew', label: 'renovação não gera parcelas', needAll: ['contratos.criar', 'cobrancas.baixa'],
        build: async ({ owner }) => { const c = await mkContract(owner.id); return at('POST', `/api/contracts/${c.id}/renew`, {}); } },
];
