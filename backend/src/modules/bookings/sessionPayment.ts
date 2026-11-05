// ─── Pagamento DA SESSÃO e teto do FIXO (regras puras) ─────
// Módulo PURO (sem banco, sem Redis): o que conta como "a cobrança da sessão está paga", o que é a compra de um
// serviço EXTRA e quais sessões ocupam o teto do FIXO. As versões com banco (isSessionPaid, fixoCapReached,
// hasOpenCharge…) ficam em booking.service; o /confirm, a remarcação do avulso (lib/avulsoMakeup), o aviso das
// 7h (jobs/dailyConfirmationJob), a varredura dos holds e a conclusão do contrato (lib/contractCompletion)
// aplicam estas MESMAS regras sobre o que já carregaram — a conta é uma só (R5).
import type { BookingStatus, PaymentStatus, Prisma } from '../../generated/prisma/client.js';
import { SESSION_CHARGE_METADATA, FIXO_EXTRA_METADATA } from '../../lib/sessionCharge.js';

/** Cobrança ainda devida (em aberto): PENDING ou FAILED (recusada/expirada, que o cliente ainda pode pagar). */
export const OPEN_CHARGE_STATUSES: PaymentStatus[] = ['PENDING', 'FAILED'];

/** O que as regras abaixo leem de um Payment. */
export type SessionPaymentLike = { status: string; metadata?: unknown; paymentUrl?: string | null };

/** Select do Payment com o que as regras abaixo precisam. */
export const SESSION_PAYMENT_SELECT = { status: true, metadata: true, paymentUrl: true } as const;

/** Filtro (Prisma) do Payment com a marca da cobrança da PRÓPRIA sessão — metadata.sessionCharge (lib/sessionCharge). */
export const SESSION_CHARGE_MARK_WHERE: Prisma.PaymentWhereInput = { metadata: { path: ['sessionCharge'], equals: true } };

/** O Payment leva a marca da cobrança da PRÓPRIA sessão (avulso/SERVIÇO/FIXO extra/sessão cobrada pela equipe)? */
export function hasSessionChargeMark(p: { metadata?: unknown }): boolean {
    const m = p.metadata;
    return !!m && typeof m === 'object' && !Array.isArray(m)
        && (m as Record<string, unknown>).sessionCharge === SESSION_CHARGE_METADATA.sessionCharge;
}

/**
 * Compra de serviço(s) EXTRA(S) de uma gravação. O POST /bookings/:id/addons e os extras pagos do POST /bookings
 * gravam as chaves no `paymentUrl` como JSON `{ addonKeys: [...] }` (o legado: `{ addonKey }`) — o mesmo formato
 * que paymentEffects.activateAddonIfNeeded lê para ativar o serviço depois do pagamento. Nenhuma outra cobrança
 * grava JSON nesse campo (o do provedor é a URL do checkout), e as reemissões (PIX/cartão) não o reescrevem.
 * A cobrança da GRAVAÇÃO nunca tem essas chaves (o avulso do cliente leva os extras dentro dela, sem chaves).
 */
export function isAddonPurchase(p: { paymentUrl?: string | null }): boolean {
    const raw = p.paymentUrl;
    if (!raw || raw.trimStart()[0] !== '{') return false;
    try {
        const meta = JSON.parse(raw) as { addonKeys?: unknown; addonKey?: unknown } | null;
        const keys = meta?.addonKeys || (meta?.addonKey ? [meta.addonKey] : []);
        return Array.isArray(keys) && keys.length > 0;
    } catch {
        return false;
    }
}

export interface SessionPaymentState {
    /** A reserva tem cobrança MARCADA (metadata.sessionCharge): a cobrança da sessão é essa (ou essas). */
    marked: boolean;
    /** A cobrança da GRAVAÇÃO está paga (regra de sessionPaymentState). */
    paid: boolean;
    /**
     * AUDFIN-02: com a marca, alguma cobrança MARCADA ainda está em aberto (PENDING/FAILED) — há o que pagar. Marcada
     * só ANULADA ou ESTORNADA dá `paid: false` e `open: false`: não está paga, mas também não há nada a pagar. Sem a
     * marca: false (a regra sem a marca não usa este campo).
     */
    open: boolean;
}

/**
 * R5 (ATU4-02/ATU4-04/UXT-07): a cobrança da GRAVAÇÃO está paga? `payments` = os Payments da reserva.
 *  • Com a marca sessionCharge: paga só se NENHUMA cobrança marcada está PENDING/FAILED e há ao menos uma
 *    marcada PAID — um extra pago nunca a substitui.
 *  • Sem a marca (legado, avulso do próprio cliente): exige um PAID que seja a cobrança da gravação, não a compra
 *    de um extra (isAddonPurchase).
 * Sessão de plano sem cobrança própria dá `paid: false` — quem chama decide se a sessão PRECISA de pagamento
 * próprio (sessionAwaitsOwnPayment em booking.service).
 */
export function sessionPaymentState(payments: readonly SessionPaymentLike[]): SessionPaymentState {
    const marked = payments.filter(hasSessionChargeMark);
    if (marked.length > 0) {
        const open = marked.some(p => (OPEN_CHARGE_STATUSES as string[]).includes(p.status));
        return { marked: true, paid: !open && marked.some(p => p.status === 'PAID'), open };
    }
    return { marked: false, paid: payments.some(p => p.status === 'PAID' && !isAddonPurchase(p)), open: false };
}

/**
 * A reserva PRECISA da cobrança própria paga para valer como Confirmada, e ela não está paga?
 *  • Com a marca: só enquanto há cobrança marcada EM ABERTO (PENDING/FAILED) — a mesma regra de
 *    paymentEffects.confirmBookingAndActivateContract (openSessionChargeWhere). AUDFIN-02: a marcada só ANULADA ou
 *    ESTORNADA (por quem tem a baixa) não deixa nada a pagar; esperar por ela dava 402 eterno no /confirm. Uma sessão
 *    FECHADA (Cancelado, Concluído, Falta, Não realizado) cuja cobrança própria foi anulada não volta a ficar em aberto
 *    (PATCH /:id, 409 SESSION_CHARGE_VOIDED — AUDFIN6-02), então esta regra não a torna "confirmável sem cobrança"; só
 *    a sessão que JÁ estava em aberto quando quem tem a baixa a perdoou fica confirmável (nada a pagar).
 *  • Sem a marca: precisa quando é avulso ou ainda está no prazo de pagamento (hold do avulso do cliente).
 * A sessão de PLANO sem cobrança própria nunca espera (só extras em aberto não a seguram).
 */
export function awaitsOwnPayment(
    state: SessionPaymentState,
    b: { holdExpiresAt?: Date | null; contractType?: string | null },
): boolean {
    return (state.marked ? state.open : (!!b.holdExpiresAt || b.contractType === 'AVULSO')) && !state.paid;
}

/** Estado da cobrança PRÓPRIA (a da gravação) de uma reserva — ver ownSessionChargeState. */
export type OwnChargeState = 'live' | 'voided' | 'none';

/**
 * A cobrança PRÓPRIA da sessão (a da gravação): a marcada (sessionCharge) ou, no avulso sem a marca (do cliente,
 * legado), a que não é compra de extra. Extras de sessão de plano nunca contam.
 *  • 'live'   — alguma própria PAGA ou em aberto (PAID/PENDING/FAILED);
 *  • 'voided' — nenhuma viva e alguma própria ANULADA (CANCELLED): a sessão esperava cobrança e ela deixou de valer;
 *  • 'none'   — a sessão não tem cobrança própria (plano sem extras, só extras) ou só estornada (REFUNDED).
 * Usado pela reabertura de sessão cancelada (PATCH /:id: texto do 403 sem a baixa; 409 SESSION_CHARGE_VOIDED e o aviso
 * "sem cobrança" de quem tem a baixa — AUDFIN-01/ATU5-01/TELA5-01).
 */
export function ownSessionChargeState(payments: readonly SessionPaymentLike[], contractType: string | null | undefined): OwnChargeState {
    const marked = payments.some(hasSessionChargeMark);
    const own = payments.filter(p => (marked ? hasSessionChargeMark(p) : contractType === 'AVULSO' && !isAddonPurchase(p)));
    if (own.some(p => p.status === 'PAID' || (OPEN_CHARGE_STATUSES as string[]).includes(p.status))) return 'live';
    if (own.some(p => p.status === 'CANCELLED')) return 'voided';
    return 'none';
}

// ─── Teto do FIXO ──────────────────────────────────────

/** Status que ocupam o teto do FIXO (meses × sessões/mês). CANCELLED e NAO_REALIZADO não ocupam. */
export const FIXO_CAP_STATUSES: BookingStatus[] = ['COMPLETED', 'CONFIRMED', 'FALTA', 'RESERVED'];

/** Filtro (Prisma) do Payment com a marca da sessão EXTRA do FIXO — metadata.fixoExtra (lib/sessionCharge). */
export const FIXO_EXTRA_MARK_WHERE: Prisma.PaymentWhereInput = { metadata: { path: ['fixoExtra'], equals: true } };

/** O Payment leva a marca da sessão EXTRA do FIXO (criada com o teto do plano já cheio)? */
export function hasFixoExtraMark(p: { metadata?: unknown }): boolean {
    const m = p.metadata;
    return !!m && typeof m === 'object' && !Array.isArray(m)
        && (m as Record<string, unknown>).fixoExtra === FIXO_EXTRA_METADATA.fixoExtra;
}

/**
 * A sessão ocupa uma vaga do teto do FIXO? A sessão EXTRA — criada com o teto já cheio, cobrança com a marca
 * fixoExtra, em qualquer status — não ocupa: ela não é do plano. ATU5-02/TELA5-02 (conserto 5): a sessão FIXO
 * cobrada por quem tem a baixa DENTRO do teto (só a marca sessionCharge) OCUPA a vaga, como antes da R5. `fixoExtra`
 * = a reserva tem esse Payment. Versão de banco: fixoCapUsageWhere (a mesma regra).
 */
export function occupiesFixoCap(b: { status: string; fixoExtra?: boolean }): boolean {
    return (FIXO_CAP_STATUSES as string[]).includes(b.status) && !b.fixoExtra;
}

/** Filtro (Prisma) das sessões que ocupam o teto do FIXO do contrato — occupiesFixoCap no banco. */
export function fixoCapUsageWhere(contractId: string): Prisma.BookingWhereInput {
    return { contractId, status: { in: FIXO_CAP_STATUSES }, payments: { none: FIXO_EXTRA_MARK_WHERE } };
}
