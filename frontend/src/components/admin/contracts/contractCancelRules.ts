import type { Contract } from '../../../api/client';

// ─── Contratos: cancelar, decidir o pedido de cancelamento e pausar — o que a tela oferece e o que o diálogo diz ───
// O servidor é a autoridade (contract.lifecycle.ts — 403 PERMISSION_DENIED cobrancas.baixa); aqui só se decide o que
// MOSTRAR, com a mesma conta. Funções puras (testadas pelo vitest do backend: eq-r7-front*).

/** Contrato mínimo para as decisões de cobrança (o item de GET /contracts serve). */
export type ContractChargeTarget = Pick<Contract, 'type'> & {
    openChargeCount?: number | null;
    openSessionChargeCount?: number | null;
};

/** ATU5-03: por que o avulso com cobrança em aberto não é cancelado sem a baixa (o 403 do servidor diz o mesmo). */
export const AVULSO_CANCEL_NEEDS_BAIXA = 'Este avulso tem cobrança em aberto: cancelar o contrato anula a cobrança da sessão, e isso exige a permissão “Marcar como pago, anular ou estornar”.';
/** AUDFIN6-01 (espelho): nos outros tipos, a cobrança PRÓPRIA de uma gravação (sessão cobrada à parte) — mesmo texto do 403. */
export const SESSION_CHARGE_CANCEL_NEEDS_BAIXA = 'Uma gravação deste contrato tem cobrança própria em aberto (a da sessão, cobrada à parte): cancelar o contrato anula essa cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”.';
/** ATU6-02/AUDFIN6-01 (espelho): decidir o pedido (cobrar ou isentar a multa) cancela o contrato e anula o mesmo. */
export const AVULSO_DECIDE_NEEDS_BAIXA = 'Este avulso tem cobrança em aberto: decidir o pedido de cancelamento (cobrar ou isentar a multa) cancela o contrato e anula a cobrança da sessão, e isso exige a permissão “Marcar como pago, anular ou estornar”.';
export const SESSION_CHARGE_DECIDE_NEEDS_BAIXA = 'Uma gravação deste contrato tem cobrança própria em aberto (a da sessão, cobrada à parte): decidir o pedido de cancelamento (cobrar ou isentar a multa) cancela o contrato e anula essa cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”.';

const finiteCount = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);

/**
 * Cobranças em aberto que cancelar o contrato (ou decidir o pedido) só anula COM a baixa — a conta do 403 do servidor
 * (`openSessionChargeCount`). Servidor sem o campo: no avulso, `openChargeCount` é a mesma conta; nos outros tipos, a
 * tela não sabe (null).
 */
export function knownBaixaChargeCount(c: ContractChargeTarget): number | null {
    const n = finiteCount(c.openSessionChargeCount);
    if (n != null) return n;
    return c.type === 'AVULSO' ? finiteCount(c.openChargeCount) : null;
}

/**
 * Sem a baixa e com essa cobrança em aberto (contagem conhecida > 0), o servidor recusa cancelar o contrato (DELETE e
 * PATCH status=CANCELLED): devolve o texto que explica, ou null quando a tela oferece a ação. Contagem desconhecida não
 * trava — o 403 do servidor aparece no diálogo.
 */
export function contractCancelBlockReason(c: ContractChargeTarget, canSettleCharges: boolean): string | null {
    if (canSettleCharges) return null;
    const n = knownBaixaChargeCount(c);
    if (n == null || n <= 0) return null;
    return c.type === 'AVULSO' ? AVULSO_CANCEL_NEEDS_BAIXA : SESSION_CHARGE_CANCEL_NEEDS_BAIXA;
}

/** O mesmo para decidir o pedido de cancelamento (POST /contracts/:id/resolve-cancellation). */
export function contractDecideBlockReason(c: ContractChargeTarget, canSettleCharges: boolean): string | null {
    if (!contractCancelBlockReason(c, canSettleCharges)) return null;
    return c.type === 'AVULSO' ? AVULSO_DECIDE_NEEDS_BAIXA : SESSION_CHARGE_DECIDE_NEEDS_BAIXA;
}

/**
 * Linha do diálogo sobre a cobrança própria das gravações (fora do avulso, em que a "parcela" já é a sessão):
 * com a baixa e cobrança conhecida, ela é anulada (inclusive a de gravação já feita — a anulação do contrato não olha o
 * status da sessão); sem a baixa e sem a contagem, o servidor pode recusar.
 */
export function sessionChargeLines(c: ContractChargeTarget, canSettleCharges: boolean, action: 'cancel' | 'decide'): string[] {
    if (c.type === 'AVULSO') return [];
    const n = knownBaixaChargeCount(c);
    if (canSettleCharges) {
        return n != null && n > 0
            ? ['Também é anulada a cobrança própria em aberto das gravações deste contrato cobradas à parte, mesmo a de uma gravação já feita.']
            : [];
    }
    if (n != null) return [];
    return [`Se alguma gravação deste contrato tiver cobrança própria em aberto (sessão cobrada à parte), ${action === 'cancel' ? 'o cancelamento' : 'a decisão'} é recusad${action === 'cancel' ? 'o' : 'a'}: anular essa cobrança exige a permissão “Marcar como pago, anular ou estornar”.`];
}

/** O que o cancelamento faz (DELETE /contracts/:id e PATCH status CANCELLED fazem o mesmo — contract.lifecycle.ts). */
export function cancelContractConsequences(c: ContractChargeTarget, opts: { canSettleCharges: boolean }): string[] {
    return [
        'O contrato passa a Cancelado.',
        // O servidor cancela as gravações futuras de QUALQUER contrato (upcomingContractBookingsWhere) — também as
        // vinculadas a um serviço.
        c.type === 'SERVICO'
            ? 'As gravações vinculadas a este serviço que ainda não aconteceram são canceladas e os horários ficam livres para outros clientes (as já feitas ou em andamento ficam como estão).'
            : 'As gravações que ainda não aconteceram são canceladas e os horários ficam livres para outros clientes (as já feitas ou em andamento ficam como estão).',
        'As parcelas pendentes são anuladas: a cobrança já emitida (QR PIX, boleto ou cartão em aberto) é cancelada no banco antes.',
        ...sessionChargeLines(c, opts.canSettleCharges, 'cancel'),
        'O cliente é avisado do cancelamento.',
        'Nenhuma multa é gerada e nada do que já foi pago é estornado.',
    ];
}

/**
 * TELA6-04 — o que a pausa faz (PATCH /contracts/:id/pause, conserto 5): no FIXO cancela as gravações do plano daqui em
 * diante — inclusive a cobrada à parte criada com o plano ainda com vaga, que é do plano — e mantém só a sessão EXTRA
 * (marca fixoExtra, criada com o teto cheio); sem a baixa, recusa se alguma delas tiver cobrança em aberto; com a
 * baixa, anula essa cobrança. A retomada recria só as gravações do dia e horário fixos. Nos outros tipos nada é
 * cancelado.
 */
export function pauseContractConsequences(c: Pick<Contract, 'type'>, opts: { canSettleCharges: boolean }): string[] {
    if (c.type !== 'FIXO') {
        return [
            'As gravações já agendadas são mantidas.',
            'Ao retomar, a vigência é estendida pelos dias em pausa.',
            'Parcelas pendentes não são cobradas automaticamente enquanto o contrato estiver pausado.',
        ];
    }
    return [
        'As gravações do plano agendadas daqui em diante são canceladas e os horários ficam livres para outros clientes. Isso inclui as cobradas à parte criadas enquanto o plano ainda tinha vaga: elas contam como gravações do plano, e o que já foi pago por elas não é estornado.',
        'A sessão extra (criada com o plano já cheio) é mantida.',
        // AUDFIN-03: cancelar anula a cobrança em aberto da gravação — anular é da baixa (o servidor recusa sem ela).
        opts.canSettleCharges
            ? 'A cobrança em aberto das gravações canceladas é anulada: a da própria sessão, quando ela foi cobrada à parte, e a de serviços extras contratados nelas.'
            : 'Se alguma dessas gravações tiver cobrança em aberto, a pausa é recusada: anular a cobrança exige a permissão “Marcar como pago, anular ou estornar”.',
        'Ao retomar, a vigência é estendida pelos dias em pausa e as gravações do dia e horário fixos são recriadas (só essas: uma gravação cancelada em outra data ou horário não volta).',
        'Parcelas pendentes não são cobradas automaticamente enquanto o contrato estiver pausado.',
    ];
}
