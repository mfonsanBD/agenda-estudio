import { useMemo } from 'react';
import { usePermission } from '../../../hooks/usePermission';
import type { PermissionKey } from '../../../constants/permissions';

// ─── Permissões das ações de agendamento (Agenda, Agendamentos, Hoje, Painel) ───
// O servidor é a autoridade (403 PERMISSION_DENIED); aqui só se decide o que MOSTRAR.
//
// `bookingStatusRequirements` é o ESPELHO de `requiredForBookingStatusChange`
// (backend/src/lib/permissionRules.ts — tabela de transições do PATCH /bookings/:id, DECISÕES D3/F2).
// Mudou lá → mude aqui (mesma tabela, mesma ordem):
//   • mesmo status ................................ nada
//   • RESERVED/HELD → CONFIRMED ................... hoje.presenca OU agendamentos.editar
//   • sair de COMPLETED/FALTA/NAO_REALIZADO/CANCELLED (reabrir ou trocar o desfecho)
//                                                 agendamentos.editar (+ agendamentos.faltas se envolve NAO_REALIZADO)
//   • sair de CANCELLED (para qualquer status) .... + cobrancas.baixa (FIN-01/ATK-02)
//   • CONFIRMED com gravação iniciada → COMPLETED hoje.gravacao OU agendamentos.editar
//   • outros → COMPLETED .......................... agendamentos.editar
//   • → FALTA / NAO_REALIZADO ..................... agendamentos.faltas
//   • → CANCELLED ................................. agendamentos.cancelar
//   • → RESERVED / HELD ........................... agendamentos.editar
//   • status desconhecido ......................... só o ADMIN
// Fora da tabela (por DADO ou regra de negócio, no hook): → CANCELLED de sessão com cobrança em aberto exige também
// cobrancas.baixa (R5 — cancelBlockedByOpenCharge), e a exclusão definitiva também, em qualquer status
// (hardDeleteBlockedByOpenCharge — TELA5-05); Concluído/Cancelado → FALTA é 400 para todos (isFaltaRefused);
// a reabertura de Cancelado no FLEX/Personalizado é 409 para todos (isCancelledPlanReopenBlocked); a volta ao "em
// aberto" da sessão cuja cobrança foi anulada é 409 para todos (isVoidedChargeReopenBlocked — quando o servidor disse).

/** Status "abertos" (a sessão ainda vai acontecer). */
const OPEN_STATUSES = ['RESERVED', 'HELD', 'CONFIRMED'] as const;
/** Status de desfecho: sair deles reabre ou troca o desfecho (mexe em crédito, contrato, remarcação). */
const CLOSED_STATUSES = ['COMPLETED', 'FALTA', 'NAO_REALIZADO', 'CANCELLED'] as const;
const KNOWN_STATUSES: readonly string[] = [...OPEN_STATUSES, ...CLOSED_STATUSES];

/** Requisitos (todos precisam passar; cada grupo é "qualquer uma de"). `'ADMIN'` = só o administrador. */
export type BookingStatusRequirements = readonly (readonly PermissionKey[])[] | 'ADMIN';

export function bookingStatusRequirements(from: string, to: string, opts: { recordingStarted: boolean }): BookingStatusRequirements {
    if (from === to) return [];
    if (!KNOWN_STATUSES.includes(from) || !KNOWN_STATUSES.includes(to)) return 'ADMIN';
    const out: PermissionKey[][] = [];
    const add = (anyOf: PermissionKey[]) => {
        const sig = [...anyOf].sort().join('|');
        if (!out.some(g => [...g].sort().join('|') === sig)) out.push(anyOf);
    };
    if ((CLOSED_STATUSES as readonly string[]).includes(from)) {
        add(['agendamentos.editar']);
        // FIN-01/ATK-02: reabrir uma sessão CANCELADA é decisão de dinheiro — o cancelamento anulou a cobrança
        // dela (sessão, extras) e liberou a vaga/o crédito do plano; voltar sem a baixa entregaria a sessão sem cobrança.
        if (from === 'CANCELLED') add(['cobrancas.baixa']);
        if (from === 'NAO_REALIZADO' || to === 'NAO_REALIZADO') add(['agendamentos.faltas']);
    }
    switch (to) {
        case 'CONFIRMED':
            if (from === 'RESERVED' || from === 'HELD') add(['hoje.presenca', 'agendamentos.editar']);
            break;
        case 'COMPLETED':
            if (from === 'CONFIRMED' && opts.recordingStarted) add(['hoje.gravacao', 'agendamentos.editar']);
            else add(['agendamentos.editar']);
            break;
        case 'FALTA':
        case 'NAO_REALIZADO':
            add(['agendamentos.faltas']);
            break;
        case 'CANCELLED':
            add(['agendamentos.cancelar']);
            break;
        default: // RESERVED, HELD
            add(['agendamentos.editar']);
    }
    return out;
}

/** Agendamento mínimo para decidir as ações (BookingWithUser, Booking e o item do detalhe do contrato servem). */
export interface BookingPermissionTarget {
    status: string;
    recordingStartedAt?: string | null;
    /** Contrato da sessão (o tipo decide a regra de reabertura — DIN-01). */
    contract?: { type: string } | null;
    /** R5: cobranças em aberto da gravação (rotas da equipe). Ausente = desconhecido — ver cancelBlockedByOpenCharge. */
    openChargeCount?: number | null;
    /** R7: o servidor disse que a cobrança própria foi anulada (ver isVoidedChargeReopenBlocked). Ausente = desconhecido. */
    ownChargeVoided?: boolean | null;
}

/**
 * R7 (espelho do AUDFIN6-02 — 409 SESSION_CHARGE_VOIDED, regra para todos, inclusive o ADMIN): a sessão cuja cobrança
 * própria foi anulada não volta a ficar EM ABERTO (Reservado, Em espera, Confirmado) a partir de nenhum status
 * fechado (Concluído, Falta, Não realizado, Cancelado) — para gravar, um novo agendamento gera a cobrança. A tela só
 * sabe disso quando o servidor disse (`ownChargeVoided`); desconhecido não trava e o 409 do servidor aparece.
 */
export const VOIDED_CHARGE_REOPEN_HINT = 'A cobrança desta sessão foi anulada, então ela não volta a ficar em aberto (Reservado, Em espera ou Confirmado). Para gravar, crie um novo agendamento: ele gera a cobrança de novo.';
export function isVoidedChargeReopenBlocked(b: Pick<BookingPermissionTarget, 'status' | 'ownChargeVoided'>, to: string): boolean {
    return b.ownChargeVoided === true
        && (CLOSED_STATUSES as readonly string[]).includes(b.status)
        && (OPEN_STATUSES as readonly string[]).includes(to);
}

/**
 * Pendência do r4-conserto3: marcar FALTA numa sessão Concluída ou Cancelada é 400 no servidor para todos, inclusive o
 * ADMIN e qualquer tipo de contrato (PATCH /bookings/:id: "Não é possível marcar falta em um agendamento …"). A tela
 * não oferece essa troca. Regra de negócio, não de acesso: por isso fica fora de bookingStatusRequirements (o
 * espelho da tabela de permissões).
 */
const FALTA_REFUSED_FROM: readonly string[] = ['COMPLETED', 'CANCELLED'];
export function isFaltaRefused(b: Pick<BookingPermissionTarget, 'status'>, to: string): boolean {
    return to === 'FALTA' && FALTA_REFUSED_FROM.includes(b.status);
}

/**
 * R5 (espelho do critério estrutural do servidor): cancelar anula as cobranças em aberto da gravação (a da própria
 * sessão e a dos extras) — e anular é da baixa (cobrancas.baixa: “Marcar como pago, anular ou estornar”). Sem ela,
 * o servidor recusa com 403 cancelar QUALQUER sessão com cobrança em aberto (não importa se já aconteceu).
 */
export const CANCEL_OPEN_CHARGE_NEEDS_BAIXA = 'Esta sessão tem cobrança em aberto: cancelar anula a cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa ou, se o cliente faltou, use Falta (a cobrança continua devida).';

/** Cobranças em aberto que o servidor informou (`openChargeCount`), ou null quando a resposta não trouxe o campo. */
export function knownOpenChargeCount(b: Pick<BookingPermissionTarget, 'openChargeCount'>): number | null {
    const n = b.openChargeCount;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * A tela NÃO oferece o Cancelar: a sessão tem cobrança em aberto (contagem conhecida > 0) e o acesso não tem a baixa.
 * Contagem desconhecida (campo ausente) não trava — o servidor continua sendo a trava, e o diálogo mostra a
 * mensagem do 403 dele. Sessão já cancelada: nada a cancelar.
 */
export function cancelBlockedByOpenCharge(b: Pick<BookingPermissionTarget, 'status' | 'openChargeCount'>, canSettleCharges: boolean): boolean {
    if (canSettleCharges || b.status === 'CANCELLED') return false;
    const n = knownOpenChargeCount(b);
    return n != null && n > 0;
}

/**
 * TELA5-05 (espelho do DELETE /bookings/:id/hard-delete): excluir anula as cobranças em aberto da gravação, então,
 * sem a baixa, o servidor recusa excluir sessão com cobrança em aberto — em QUALQUER status (inclusive Cancelada: o
 * legado de avulsos cancelados antes da R5 ainda tem PENDING). Mesmo texto do 403 do servidor.
 */
export const HARD_DELETE_OPEN_CHARGE_NEEDS_BAIXA = 'Esta sessão tem cobrança em aberto: excluir anula a cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa.';

/** A tela NÃO oferece a Lixeira: cobrança em aberto (contagem conhecida > 0, qualquer status) e o acesso sem a baixa. */
export function hardDeleteBlockedByOpenCharge(b: Pick<BookingPermissionTarget, 'openChargeCount'>, canSettleCharges: boolean): boolean {
    if (canSettleCharges) return false;
    const n = knownOpenChargeCount(b);
    return n != null && n > 0;
}

/**
 * DIN-01 (regra de negócio, vale também para o ADMIN — espelho do PATCH /bookings/:id, 409
 * `PLAN_SESSION_CANCELLED`): sessão CANCELADA de plano com crédito. O crédito dela já foi acertado no
 * cancelamento; uma sessão nova é um novo agendamento (consome 1 crédito).
 *   • Personalizado: não sai de Cancelado para NENHUM outro status (não há reconciliador do saldo).
 *   • FLEX: só volta a Concluído (desfazer o "Cancelar" de uma sessão que aconteceu — o servidor reconcilia o
 *     saldo na hora). Reservado/Em espera/Confirmado/Não Realizado → 409. (Falta sai por outra regra, de todo
 *     tipo de contrato: isFaltaRefused.)
 */
export function isCancelledPlanReopenBlocked(b: BookingPermissionTarget, to: string): boolean {
    if (b.status !== 'CANCELLED' || to === 'CANCELLED' || !b.contract) return false;
    if (b.contract.type === 'CUSTOM') return true;
    return b.contract.type === 'FLEX' && to !== 'COMPLETED';
}

/** Dica da UI para a reabertura bloqueada (DIN-01), conforme o plano da sessão. */
export function cancelledPlanReopenHint(contractType: string | undefined): string {
    return contractType === 'FLEX'
        ? 'Sessão cancelada de plano Flex só volta a Concluído (se a sessão aconteceu). Para uma sessão nova, crie um novo agendamento (consome 1 crédito do plano).'
        : 'Sessão cancelada de plano Personalizado não é reaberta: crie um novo agendamento (consome 1 crédito do plano).';
}

/**
 * FIN-01/ATK-02: dica da sessão cancelada que o acesso não reabre por faltar a baixa (cobrancas.baixa) — vale
 * para todo status de destino (a mesma tabela do servidor).
 * FIN-07: a tela não sabe se a cobrança da sessão foi paga ou anulada (openChargeCount 0 vale para as duas), então o
 * texto não afirma que ela foi anulada nem manda criar um novo agendamento sem ressalva — numa sessão paga, isso
 * cobraria a mesma gravação de novo. O 403 do servidor escolhe o texto pelo caso (REOPEN_CANCELLED_*,
 * booking.service.ts).
 */
export const CANCELLED_REOPEN_NEEDS_BAIXA = 'Reabrir uma sessão cancelada exige a permissão “Marcar como pago, anular ou estornar”: peça a quem a tem. Crie um novo agendamento só se esta sessão não foi paga — senão o cliente seria cobrado de novo.';
/**
 * Avulso cancelado com cobrança AINDA EM ABERTO (openChargeCount > 0): só o legado de antes da R5 — desde a R5 o
 * cancelamento anula a cobrança em aberto do avulso. Aí ela continua valendo, e um novo agendamento cobraria de novo.
 */
export const CANCELLED_AVULSO_REOPEN_NEEDS_BAIXA = 'Reabrir uma sessão avulsa cancelada exige a permissão “Marcar como pago, anular ou estornar”: peça a quem a tem. Não crie um novo agendamento — a cobrança desta sessão continua valendo e o cliente seria cobrado de novo.';

/**
 * Texto da dica de `cancelledReopenNeedsBaixa` para a sessão. TELA5-03: o texto do avulso ("a cobrança continua
 * valendo") só quando a tela SABE que há cobrança em aberto (openChargeCount > 0, o legado). Contagem 0 (paga ou
 * anulada — a tela não distingue) ou desconhecida → o texto neutro, verdadeiro nos dois casos.
 */
export function cancelledReopenNeedsBaixaHint(b: BookingPermissionTarget): string {
    const open = knownOpenChargeCount(b);
    return b.contract?.type === 'AVULSO' && open != null && open > 0
        ? CANCELLED_AVULSO_REOPEN_NEEDS_BAIXA
        : CANCELLED_REOPEN_NEEDS_BAIXA;
}

export interface BookingActionPermissions {
    /**
     * Pode mudar o status de `booking.status` para `to` (mesma tabela do servidor). Também recusa a saída
     * de Cancelado em sessão de Personalizado e, no FLEX, para tudo menos Concluído (DIN-01 — regra do
     * plano, vale para o ADMIN), a Falta a partir de Concluído/Cancelado (isFaltaRefused — 400 para todos) e o
     * Cancelado de sessão com cobrança em aberto sem a baixa (cancelBlockedByOpenCharge — R5).
     */
    canChangeStatus: (booking: BookingPermissionTarget, to: string) => boolean;
    /**
     * A troca para `to` não aparece só por causa do ACESSO (falta alguma permissão da tabela) — não por uma regra de
     * negócio que vale para todos (DIN-01, isFaltaRefused) nem pela cobrança em aberto (que tem dica própria,
     * cancelNeedsBaixa). É o critério do aviso "aparecem só os status que o seu acesso permite".
     */
    hiddenByAccess: (booking: BookingPermissionTarget, to: string) => boolean;
    /**
     * R5: o acesso cancelaria a sessão (a tabela permite → Cancelado), mas ela tem cobrança em aberto e falta a
     * baixa — o Cancelar fica indisponível com CANCEL_OPEN_CHARGE_NEEDS_BAIXA (Agendamentos, Editar, Hoje).
     */
    cancelNeedsBaixa: (booking: BookingPermissionTarget) => boolean;
    /**
     * TELA5-05: o acesso exclui (agendamentos.excluir), mas a sessão tem cobrança em aberto e falta a baixa — a Lixeira
     * fica indisponível com HARD_DELETE_OPEN_CHARGE_NEEDS_BAIXA (qualquer status).
     */
    hardDeleteNeedsBaixa: (booking: BookingPermissionTarget) => boolean;
    /** Opções de status para um seletor: o status atual + as transições permitidas (na ordem de `all`). */
    statusOptions: (booking: BookingPermissionTarget, all: readonly string[]) => string[];
    /**
     * FIN-01/ATK-02: sessão Cancelada que o plano deixaria reabrir (não é Personalizado) e à qual só falta a baixa
     * — o acesso tem agendamentos.editar, mas não cobrancas.baixa. Todas as opções de status ficam travadas e a
     * tela mostra cancelledReopenNeedsBaixaHint. UXT-01: sem agendamentos.editar (ex.: Operador de estúdio) a baixa
     * sozinha não reabriria nada (a regra é editar E baixa) → false, e a lista mostra o selo simples.
     */
    cancelledReopenNeedsBaixa: (booking: BookingPermissionTarget) => boolean;
    /** Dá baixa (cobrancas.baixa) — cancelar uma sessão com cobrança em aberto exige (R5; FIN-06). */
    canSettleCharges: boolean;
    /** "Novo agendamento" e clique em horário livre da Agenda (agendamentos.criar). */
    canCreate: boolean;
    /** Mudar data e horário (agendamentos.editar). */
    canEditSlot: boolean;
    /** Registrar falta / não realizado, justificar e remarcar avulso perdido (agendamentos.faltas). */
    canFaltas: boolean;
    /** Cancelar sessão (agendamentos.cancelar). */
    canCancel: boolean;
    /** Excluir definitivamente (agendamentos.excluir). */
    canHardDelete: boolean;
    /** Confirmar presença pelo check-in (PUT /check-in exige hoje.presenca). */
    canCheckIn: boolean;
    /** Confirmar presença por qualquer caminho (check-in ou PATCH RESERVED→CONFIRMED). */
    canConfirmPresence: boolean;
    /** Iniciar, desfazer e finalizar gravação; dados da transmissão (PUT /start-recording, /complete…). */
    canOperateRecording: boolean;
    /** Notas, links e métricas da sessão pelo PATCH (hoje.gravacao OU agendamentos.editar). */
    canEditNotes: boolean;
    /** Abrir o perfil do cliente (/admin/clients/:id exige clientes.ver). */
    canOpenClient: boolean;
}

/**
 * Permissões das ações de agendamento do usuário logado.
 *   const bp = useBookingPermissions();
 *   {bp.canCancel && <button …>Cancelar</button>}
 *   bp.statusOptions(booking, ['RESERVED', 'CONFIRMED', …])
 */
export function useBookingPermissions(): BookingActionPermissions {
    const { isAdmin, can, canAny } = usePermission();
    return useMemo(() => {
        const canSettleCharges = can('cobrancas.baixa');
        /** Só a tabela de permissões (espelho do servidor). */
        const accessAllows = (b: BookingPermissionTarget, to: string) => {
            if (isAdmin) return true;
            const req = bookingStatusRequirements(b.status, to, { recordingStarted: !!b.recordingStartedAt });
            if (req === 'ADMIN') return false;
            return req.every(group => group.some(k => can(k)));
        };
        /** Regras de negócio que valem para todos, inclusive o ADMIN (o servidor recusa com 409/400). */
        const ruleRefuses = (b: BookingPermissionTarget, to: string) => isCancelledPlanReopenBlocked(b, to) || isFaltaRefused(b, to)
            || isVoidedChargeReopenBlocked(b, to);
        const chargeBlocks = (b: BookingPermissionTarget, to: string) => to === 'CANCELLED' && cancelBlockedByOpenCharge(b, canSettleCharges);
        const canChangeStatus = (b: BookingPermissionTarget, to: string) => {
            if (to === b.status) return true;
            // DIN-01 e Falta: regras de negócio, não de acesso — valem também para o ADMIN (antes do atalho dele).
            if (ruleRefuses(b, to)) return false;
            if (chargeBlocks(b, to)) return false;
            return accessAllows(b, to);
        };
        return {
            canChangeStatus,
            statusOptions: (b, all) => all.filter(to => to === b.status || canChangeStatus(b, to)),
            hiddenByAccess: (b, to) => to !== b.status && !ruleRefuses(b, to) && !accessAllows(b, to),
            cancelNeedsBaixa: b => chargeBlocks(b, 'CANCELLED') && !ruleRefuses(b, 'CANCELLED') && accessAllows(b, 'CANCELLED'),
            hardDeleteNeedsBaixa: b => can('agendamentos.excluir') && hardDeleteBlockedByOpenCharge(b, canSettleCharges),
            // Concluído é o destino que a regra do plano menos trava (o FLEX volta a ele; o Personalizado não
            // sai de Cancelado de jeito nenhum — aí vale a dica do plano, não a da baixa). UXT-01: a dica só vale
            // quando a baixa é o ÚNICO requisito que falta (mesmo critério do 403 do servidor).
            cancelledReopenNeedsBaixa: b => b.status === 'CANCELLED' && can('agendamentos.editar') && !can('cobrancas.baixa')
                && !isCancelledPlanReopenBlocked(b, 'COMPLETED'),
            canSettleCharges,
            canCreate: can('agendamentos.criar'),
            canEditSlot: can('agendamentos.editar'),
            canFaltas: can('agendamentos.faltas'),
            canCancel: can('agendamentos.cancelar'),
            canHardDelete: can('agendamentos.excluir'),
            canCheckIn: can('hoje.presenca'),
            canConfirmPresence: canAny('hoje.presenca', 'agendamentos.editar'),
            canOperateRecording: can('hoje.gravacao'),
            canEditNotes: canAny('hoje.gravacao', 'agendamentos.editar'),
            canOpenClient: can('clientes.ver'),
        };
    }, [isAdmin, can, canAny]);
}
