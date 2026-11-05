import { getMeta, TIER_META } from '../../../constants/adminMeta';

// ─── Hierarquia das faixas (espelho de canAccessTier — backend/src/utils/pricing.ts) ───
// Um plano vale na faixa dele e nas de baixo: Sábado ⊃ Audiência ⊃ Comercial. É a regra do POST / do cliente,
// do POST /bookings/admin (R3b — 403 TIER_NOT_ALLOWED) e da troca de faixa da sessão de plano no
// PATCH /bookings/:id (FIN-03). O servidor é a trava; aqui só se decide o aviso antes de salvar.

const TIER_ORDER = ['COMERCIAL', 'AUDIENCIA', 'SABADO'] as const;

/**
 * FIN-03: planos cujas parcelas já cobrem a sessão — mudar de faixa só confere a faixa do PLANO (EditBookingModal).
 * Espelho de SESSION_PLAN_TYPES (backend/src/lib/sessionCharge.ts; o teste eq-r4-conserto3-front confere).
 */
export const SESSION_PLAN_TYPES: readonly string[] = ['FIXO', 'FLEX', 'CUSTOM'];

/** O plano da faixa `contractTier` cobre um horário da faixa `slotTier`? Faixa desconhecida → não. */
export function canAccessTier(contractTier: string, slotTier: string): boolean {
    const plan = (TIER_ORDER as readonly string[]).indexOf(contractTier);
    const slot = (TIER_ORDER as readonly string[]).indexOf(slotTier);
    return plan >= 0 && slot >= 0 && plan >= slot;
}

/** Entrada da decisão do EditBookingModal ao mover a sessão (FIN-03/DIN-03). */
export interface TierChangeInput {
    /** O acesso tem cobrancas.baixa (ou é ADMIN): o servidor não trava a troca de faixa. */
    canMarkPaid: boolean;
    /** Data ou horário mudou em relação ao salvo. */
    slotChanged: boolean;
    /** Faixa do NOVO horário (grade do dia); null = ainda não se sabe (o servidor continua sendo a trava). */
    targetTier: string | null;
    /** Faixa em que a sessão foi cobrada (booking.tierApplied). */
    tierApplied: string;
    /** Contrato da sessão (o tipo e a faixa do plano). */
    contract?: { type: string; tier: string } | null;
}

/** Contrato de PLANO (Fixo, Flex, Personalizado) da sessão, ou null (avulso, serviço, sem contrato). */
export function planContractOf<C extends { type: string }>(contract: C | null | undefined): C | null {
    return contract && SESSION_PLAN_TYPES.includes(contract.type) ? contract : null;
}

/**
 * UXT-08 — decisão pura do aviso "não salva" ao mover a sessão sem a baixa (espelho do PATCH /bookings/:id):
 *  - mesma faixa, sem mudança de horário, faixa nova desconhecida ou com a baixa → não trava;
 *  - sessão de PLANO (FIN-03): só a faixa do PLANO conta — trava apenas acima dela (403 TIER_NOT_ALLOWED);
 *  - avulso, serviço e sem contrato (DIN-03): outra faixa muda o valor cobrado → trava (403 cobrancas.baixa).
 * O front não sabe se a sessão de plano é EXTRA (cobrada à parte): aí o servidor recusa e a mensagem dele aparece.
 */
export function tierChangeBlockedFor(input: TierChangeInput): boolean {
    const { canMarkPaid, slotChanged, targetTier, tierApplied, contract } = input;
    const tierDiffers = !canMarkPaid && slotChanged && !!targetTier && targetTier !== tierApplied;
    if (!tierDiffers) return false;
    const plan = planContractOf(contract);
    return plan ? !canAccessTier(plan.tier, targetTier!) : true;
}

/** Rótulos das faixas que o plano cobre, em ordem ("Comercial e Audiência"). */
export function accessibleTierLabels(contractTier: string): string {
    const labels = TIER_ORDER.filter(t => canAccessTier(contractTier, t)).map(t => getMeta(TIER_META, t).label);
    if (labels.length <= 1) return labels.join('');
    return `${labels.slice(0, -1).join(', ')} e ${labels[labels.length - 1]}`;
}
