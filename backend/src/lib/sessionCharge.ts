// ─── Cobrança da SESSÃO (marca no Payment) ─────────────
// Módulo PURO (sem banco, sem Redis): as constantes e os filtros saem daqui para as rotas de agendamento
// (re-exportados por modules/bookings/booking.service), os efeitos do pagamento (lib/paymentEffects), a
// varredura dos holds (jobs/cleanExpiredHolds) e os testes de paridade com o front (UXT-03).
import type { PaymentStatus, Prisma } from '../generated/prisma/client.js';

/**
 * Planos cujas parcelas já cobrem as sessões. O avulso e o contrato de SERVIÇO não cobrem gravação.
 * Espelho no front: SESSION_PLAN_TYPES de frontend/src/components/admin/bookings/tierAccess.ts.
 */
export const SESSION_PLAN_TYPES: readonly string[] = ['FIXO', 'FLEX', 'CUSTOM'];

/**
 * Marca `metadata.sessionCharge = true` no Payment que cobra o valor da PRÓPRIA sessão — avulso, contrato de
 * SERVIÇO, FIXO acima do teto, sessão vinculada criada por quem tem a baixa (POST /bookings/admin quando a
 * sessão não é coberta pelo plano). A cobrança só dos EXTRAS de uma sessão de plano não leva a marca. As
 * reemissões (PIX/boleto/cartão, reabertura de FAILED) mesclam o metadata, então a marca sobrevive.
 *  - PATCH /:id/confirm do cliente: cobrança da sessão PENDING/FAILED → 402 (ATK-03/FIN-05);
 *  - pagar OUTRA cobrança da reserva (um extra) não a confirma enquanto a da sessão estiver em aberto
 *    (ATU-02/FIN-08: confirmBookingAndActivateContract, complete-payment, varredura dos holds);
 *  - PATCH /:id com troca de faixa sem a baixa: "sessão de plano" é a que NÃO tem a marca (FIN-03).
 * O teto do FIXO NÃO olha esta marca: só a FIXO_EXTRA_METADATA (abaixo) tira a sessão do teto (ATU5-02).
 */
export const SESSION_CHARGE_METADATA = { sessionCharge: true } as const;

/**
 * ATU5-02/TELA5-02 (conserto 5): marca `metadata.fixoExtra = true` — junto da sessionCharge — na cobrança da sessão
 * FIXO criada com o teto do plano (meses × sessões/mês) JÁ CHEIO (POST /bookings/admin, por qualquer pessoa da equipe,
 * conferido sob a trava do contrato). É a sessão EXTRA: cobrada à parte, não ocupa vaga do plano, não conclui o
 * contrato, sai de Não realizado sem conferir o teto e fica viva na pausa do FIXO. A sessão FIXO que quem tem a baixa
 * cria DENTRO do teto leva só a sessionCharge (é cobrada, como antes) e OCUPA a vaga — sem isto, um "Confirmado" do
 * ADMIN (que grava PAID sem dinheiro) liberava uma sessão a mais para o cliente agendar de graça.
 */
export const FIXO_EXTRA_METADATA = { fixoExtra: true } as const;

/** Filtro do Payment de uma reserva que cobra a própria sessão (marca acima), opcionalmente por status. */
export function sessionChargeWhere(bookingId: string, statuses?: PaymentStatus[]): Prisma.PaymentWhereInput {
    return {
        bookingId,
        ...(statuses ? { status: { in: statuses } } : {}),
        metadata: { path: ['sessionCharge'], equals: true },
    };
}

/**
 * Cobrança da sessão ainda EM ABERTO (PENDING/FAILED) — opcionalmente sem contar um Payment (o que acabou de
 * ser pago). Enquanto ela existir, a reserva não vira Confirmada por pagamento de outra cobrança dela.
 */
export function openSessionChargeWhere(bookingId: string, exceptPaymentId?: string): Prisma.PaymentWhereInput {
    return {
        ...sessionChargeWhere(bookingId, ['PENDING', 'FAILED']),
        ...(exceptPaymentId ? { id: { not: exceptPaymentId } } : {}),
    };
}
