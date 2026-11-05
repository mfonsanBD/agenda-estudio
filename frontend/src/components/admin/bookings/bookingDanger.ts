import { bookingsApi, BookingWithUser } from '../../../api/client';
import { BOOKING_STATUS_META, getMeta } from '../../../constants/adminMeta';
import { makeupDeadlineDdmm } from '../../../utils/avulsoMakeup';
import { CANCEL_OPEN_CHARGE_NEEDS_BAIXA, knownOpenChargeCount } from './bookingPermissions';

/**
 * Ações destrutivas de agendamento (D3) — textos de consequência e a chamada de cancelamento,
 * compartilhados por Agendamentos (select inline + excluir), Editar agendamento e Hoje.
 * As consequências espelham o que o backend faz de fato (booking.management.ts, booking.service.ts e, no Flex,
 * a conferência automática do saldo — flexCreditExpiryJob/lib/flexCredits).
 */

/** Sessão ainda não realizada: cancelar devolve o horário (e o crédito, quando o contrato tem). */
const PRE_SESSION = new Set(['RESERVED', 'HELD', 'CONFIRMED']);
export const isPreSessionStatus = (status: string) => PRE_SESSION.has(status);

type DangerBooking = Pick<BookingWithUser, 'date' | 'startTime' | 'endTime' | 'status' | 'contract' | 'makeupStatus' | 'makeupDeadline'> & {
    user: { name: string };
    /** Data-âncora da remarcação (o ritmo do Flex conta por ela — flexCreditExpiryJob). */
    originalDate?: string | null;
    /** R5: cobranças em aberto da gravação (rotas da equipe); ausente = desconhecido. */
    openChargeCount?: number | null;
};

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const ddmmyyyy = (iso: string) => `${ddmm(iso)}/${iso.slice(0, 4)}`;

/** "Ana Souza · 24/09/2026 às 10:00–12:00 · Plano Flex" (linha de identificação no diálogo). */
export function bookingSummary(b: DangerBooking): string {
    const when = `${ddmmyyyy(b.date)} às ${b.startTime}${b.endTime ? `–${b.endTime}` : ''}`;
    return [b.user.name, when, b.contract?.name].filter(Boolean).join(' · ');
}

/** Tipo do contrato como string (a união tipada do front não inclui CUSTOM, mas a API devolve). */
const contractType = (b: DangerBooking) => (b.contract?.type ?? null) as string | null;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * FLEX: a janela semanal da sessão com CERTEZA ainda não fechou. As janelas do ritmo têm 7 dias contados da 1ª
 * gravação, sempre à meia-noite UTC (computeFlexState), e a que contém a data-âncora D (originalDate ?? date, a
 * mesma do cron) só fecha a partir de D + 1 dia. Fora disso a tela não sabe (não vê o início do ciclo).
 */
export function flexSessionWeekSurelyOpen(b: Pick<DangerBooking, 'date' | 'originalDate'>, now: Date): boolean {
    const anchor = (b.originalDate || b.date).slice(0, 10);
    return Date.parse(`${anchor}T00:00:00.000Z`) + DAY_MS > now.getTime();
}

/**
 * Flex (ATU4-03/UXT-05): o saldo é refeito pela conferência automática (flexCreditExpiryJob), que tira a sessão
 * cancelada do consumo E do ritmo semanal. Numa semana já fechada, com o cliente em dia, a semana vira "sem
 * gravação" e o crédito é confiscado (o confisco é monotônico) — o saldo não muda. Por isso nada de promessa.
 */
const flexRecalcLine = (name: string) =>
    `No Flex, o saldo do contrato "${name}" é recalculado pela conferência automática: o crédito desta sessão só volta se a semana dela ainda não fechou ou se o cliente está adiantado no ritmo semanal; senão, ele é perdido.`;

/**
 * Linha do crédito do contrato (cancelar e excluir). Sessão não realizada: DELETE → restoreCredit (Flex,
 * Personalizado com créditos). Já realizada (PATCH → Cancelado): nada é devolvido na hora.
 *  - AVULSO (FIN-10): nenhuma linha de crédito — o "crédito" que o restoreCredit soma ao micro-contrato não tem
 *    uso (o POST / recusa contrato avulso e o agendamento da equipe vinculado a ele cobra de novo).
 *  - FIXO/SERVIÇO: sem crédito.
 */
function creditLine(b: DangerBooking, now: Date): string | null {
    if (!b.contract) return null;
    const t = contractType(b);
    const name = b.contract.name;
    if (isPreSessionStatus(b.status)) {
        if (t === 'FLEX') {
            return flexSessionWeekSurelyOpen(b, now)
                ? `1 crédito volta para o contrato "${name}" (no Flex, ele pode vencer se a semana desta sessão fechar sem outra gravação).`
                : flexRecalcLine(name);
        }
        if (t === 'CUSTOM') return `Se o contrato "${name}" controla créditos, 1 crédito volta para ele.`;
        return null;
    }
    // Não realizado: o crédito já voltou ao marcar (D5). No Flex ele ainda contava no ritmo (âncora da semana).
    if (b.status === 'NAO_REALIZADO') {
        return t === 'FLEX'
            ? `No Flex, esta sessão deixa de contar no ritmo semanal: se a semana dela já fechou, a conferência automática pode confiscar 1 crédito do contrato "${name}".`
            : null;
    }
    if (t === 'FLEX') return flexRecalcLine(name);
    // O Personalizado não tem conferência automática: o PATCH → Cancelado não devolve o crédito.
    if (t === 'CUSTOM') return `O crédito já usado por esta sessão não volta para o contrato "${name}".`;
    return null;
}

/** Linha do aviso de sessão sem contagem conhecida de cobranças, para quem não tem a baixa. */
export const CANCEL_UNKNOWN_CHARGE_NEEDS_BAIXA = 'Se esta sessão tiver cobrança em aberto, cancelar exige a permissão “Marcar como pago, anular ou estornar”: sem ela, o cancelamento é recusado e a cobrança continua devida.';

/**
 * Consequências de CANCELAR. Sessão não realizada (Reservado/Confirmado) vai pelo cancelamento
 * canônico (DELETE /bookings/:id: libera o horário e devolve o crédito); já realizada/falta/não
 * realizada vai pelo PATCH de status (retira a remarcação aberta do avulso). Nos dois caminhos a
 * cobrança EM ABERTO da gravação (a da própria sessão e a dos extras) deixa de ser devida.
 * `canSettleCharges` (obrigatório — UXT-08) = o acesso tem cobrancas.baixa: sem ela, o servidor recusa cancelar
 * sessão com cobrança em aberto (R5). Com a contagem conhecida > 0 a tela nem abre o diálogo (cancelNeedsBaixa);
 * desconhecida, o diálogo avisa. `now` só para teste.
 */
export function cancelBookingConsequences(b: DangerBooking, opts: { canSettleCharges: boolean; now?: Date }): string[] {
    const out: string[] = [];
    const t = contractType(b);
    const now = opts.now ?? new Date();
    if (isPreSessionStatus(b.status)) {
        out.push('O agendamento passa para "Cancelado" e continua no histórico.');
        out.push(`O horário de ${ddmm(b.date)} às ${b.startTime} volta a ficar livre na agenda.`);
    } else {
        out.push(`O agendamento passa de "${getMeta(BOOKING_STATUS_META, b.status).label}" para "Cancelado" (o registro continua no histórico).`);
        if (b.status === 'COMPLETED') out.push('A sessão deixa de contar como gravação realizada.');
        if (t === 'AVULSO' && b.makeupStatus === 'OPEN') {
            out.push(b.makeupDeadline
                ? `A remarcação liberada até ${makeupDeadlineDdmm(b.makeupDeadline)} é retirada.`
                : 'A remarcação liberada para o cliente é retirada.');
        }
    }
    const credit = creditLine(b, now);
    if (credit) out.push(credit);
    if (t === 'AVULSO') {
        out.push('Nenhum pagamento já feito é estornado nem vira crédito para outro agendamento. A cobrança em aberto desta gravação deixa de ser devida.');
    } else {
        out.push('Nenhum pagamento já feito é estornado. A cobrança ainda em aberto desta gravação (a da própria sessão, quando ela é cobrada à parte, e a dos serviços extras) é anulada.');
    }
    // R5: sem a baixa, o servidor recusa cancelar sessão com cobrança em aberto (qualquer status).
    if (!opts.canSettleCharges) {
        const open = knownOpenChargeCount(b);
        if (open == null) out.push(CANCEL_UNKNOWN_CHARGE_NEEDS_BAIXA);
        else if (open > 0) out.push(CANCEL_OPEN_CHARGE_NEEDS_BAIXA);
    }
    return out;
}

/** TELA5-05: com a baixa, o servidor ANULA a cobrança em aberto da gravação antes de apagar (contagem > 0 ou desconhecida). */
export const HARD_DELETE_VOIDS_OPEN_CHARGE = 'A cobrança ainda em aberto desta gravação (a da própria sessão e a dos serviços extras) é anulada antes de apagar; o registro dela continua no Financeiro, sem o vínculo.';

/**
 * Consequências da EXCLUSÃO PERMANENTE (DELETE /bookings/:id/hard-delete). `canSettleCharges` = o acesso tem a baixa:
 * com ela, a cobrança em aberto é anulada (a linha diz); sem ela, a tela nem abre o diálogo com a contagem conhecida
 * > 0 (hardDeleteNeedsBaixa), e com a contagem desconhecida o diálogo avisa que o servidor pode recusar. `now` só para
 * teste.
 */
export function hardDeleteConsequences(b: DangerBooking, opts: { canSettleCharges: boolean; now?: Date }): string[] {
    const now = opts.now ?? new Date();
    const out = ['O agendamento é apagado de vez: some da agenda, do histórico do cliente e das métricas, como se nunca tivesse existido.'];
    if (b.status === 'RESERVED' || b.status === 'CONFIRMED') {
        out.push(`O horário de ${ddmm(b.date)} às ${b.startTime} volta a ficar livre na agenda.`);
    }
    // O hard-delete só devolve crédito de sessão não realizada (B5) — a mesma linha do cancelar.
    const credit = isPreSessionStatus(b.status) ? creditLine(b, now) : null;
    if (credit) out.push(credit);
    const open = knownOpenChargeCount(b);
    if (opts.canSettleCharges) {
        if (open == null || open > 0) out.push(HARD_DELETE_VOIDS_OPEN_CHARGE);
        out.push('Pagamento já feito não é estornado: continua no Financeiro, sem o vínculo com a gravação.');
    } else {
        if (open == null) out.push(HARD_DELETE_UNKNOWN_CHARGE_NEEDS_BAIXA);
        out.push('Se houver pagamento ligado a ele, o pagamento continua no Financeiro, sem o vínculo com a gravação.');
    }
    return out;
}

/** Sem a baixa e sem a contagem: o servidor recusa se houver cobrança em aberto (o 403 aparece no diálogo). */
export const HARD_DELETE_UNKNOWN_CHARGE_NEEDS_BAIXA = 'Se esta sessão tiver cobrança em aberto, excluir exige a permissão “Marcar como pago, anular ou estornar”: sem ela, a exclusão é recusada e a cobrança continua devida.';

/**
 * Executa o cancelamento pela rota certa (ver cancelBookingConsequences). Lança o erro da API
 * (o DangerConfirmDialog mostra dentro dele — inclusive o 403 da cobrança em aberto, com o texto do servidor).
 * `booking` vem só do PATCH (campos de remarcação atualizados).
 */
export async function cancelBookingRequest(b: Pick<BookingWithUser, 'id' | 'status'>): Promise<{ booking?: BookingWithUser }> {
    if (isPreSessionStatus(b.status)) {
        await bookingsApi.cancel(b.id);
        return {};
    }
    const res = await bookingsApi.update(b.id, { status: 'CANCELLED' });
    return { booking: res.booking };
}
