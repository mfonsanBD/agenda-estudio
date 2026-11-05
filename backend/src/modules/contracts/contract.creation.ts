import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireRole, actorOrReply, can, type Actor } from '../../middleware/permissions.js';
import { requirePermissionIfStaff, routeActor } from '../bookings/permissionGuards.js';
import { ContractStatus, BookingStatus } from '../../generated/prisma/client.js';
import {
    getBasePriceDynamic, applyDiscount, calculateEndTime, studioDateTime, getPackageSlots, getSlotDuration,
    getContractSlotGrid, checkSlotInGrid, checkDateSlotInGrid, checkCustomScheduleInGrid, checkResolvedConflictsInGrid,
    computeCustomVolume, planCustomOccurrences,
} from '../../utils/pricing.js';
import { buildOccupiedSet } from '../bookings/availability.service.js';
import { getConfig } from '../../lib/businessConfig.js';
import { config } from '../../config/index.js';
import { saoPauloParts } from '../../lib/spTime.js';
import { cleanDocument, isValidCpfCnpj } from '../../utils/document.js';
import { createPayment as gatewayCreatePayment, updatePaymentWithGatewayResult, validatePaymentMethod, getProviderForMethod, PaymentMethodDisabledError, getBoletoStatus } from '../../lib/paymentGateway.js';
import { pixExpirySecondsFor, pixQrDataUrl, pixDiscountMetaForFullCharge } from '../../lib/pixGateway.js';
import { createContractSchema, selfContractSchema, customContractSchema } from './validators.js';
import { computeAddonsCost, computeFullContractTotals } from '../../lib/contractPricing.js';
import { resolvePlanAmounts } from '../../lib/paymentPolicy.js';
import { CouponError, validateCoupon, reserveCouponUse, computeCouponDiscount, releaseAndPurgeCouponsForPayments, type CouponQuote } from '../../lib/couponService.js';
import { purgeAwaitingContract } from '../../jobs/cleanExpiredHolds.js';
import { acquireMultiSlotLock, releaseMultiSlotLock, acquireMutex, releaseMutex } from '../../lib/redis.js';

/** 409 padrão de cliente com soft delete (D3): nada novo é criado para uma conta excluída/anonimizada. */
export const DELETED_CLIENT_ERROR = 'Este cliente foi excluído.';

// ─── Reserva de horários COM TRAVA (anti-overbooking concorrente) ─────────────
/** TTL (s) das travas de slot enquanto um contrato gera as sessões. Liberadas no fim do pedido; o TTL só cobre queda do processo. */
const SLOT_CLAIM_TTL_SECONDS = 120;

/**
 * Guard anti-overbooking com trava para geração de sessões de contrato (POST /custom, POST / do FIXO,
 * renovação e retomada). Para cada ocorrência: (1) pacote já planejado NESTE pedido → ocupado;
 * (2) tranca o pacote no Redis (o MESMO acquireMultiSlotLock do avulso/admin — serializa contra
 * POST /bookings e contra outro contrato sendo gerado agora); (3) SÓ ENTÃO relê a ocupação da data no
 * banco (reservas não canceladas + bloqueios). Assim dois pedidos simultâneos nunca gravam o mesmo
 * horário. O dono da trava é ÚNICO por pedido (acquireLock é reentrante para o mesmo dono).
 * `releaseAll()` precisa rodar DEPOIS do createMany (finally), inclusive nos caminhos de erro.
 */
export function createSlotClaimer(lockOwner: string, ttlSeconds: number = SLOT_CLAIM_TTL_SECONDS) {
    const held: { date: string; slots: string[] }[] = [];
    const planned = new Map<string, Set<string>>();
    return {
        /** true = horário livre, trancado e marcado como planejado; false = ocupado (pular/recusar). */
        async claim(dateStr: string, pkg: string[]): Promise<boolean> {
            const mine = planned.get(dateStr);
            if (mine && pkg.some(s => mine.has(s))) return false;
            if (!(await acquireMultiSlotLock(dateStr, pkg, lockOwner, ttlSeconds))) return false;
            held.push({ date: dateStr, slots: pkg });
            const occupied = await buildOccupiedSet(new Date(dateStr + 'T00:00:00Z'));
            if (pkg.some(s => occupied.has(s))) return false;
            const set = mine ?? new Set<string>();
            pkg.forEach(s => set.add(s));
            planned.set(dateStr, set);
            return true;
        },
        /** Só consulta (sem trancar nem marcar): o pacote está livre agora? Para listar conflitos. */
        async isFree(dateStr: string, pkg: string[]): Promise<boolean> {
            const mine = planned.get(dateStr);
            if (mine && pkg.some(s => mine.has(s))) return false;
            const occupied = await buildOccupiedSet(new Date(dateStr + 'T00:00:00Z'));
            return !pkg.some(s => occupied.has(s));
        },
        async releaseAll(): Promise<void> {
            for (const h of held.splice(0)) {
                await releaseMultiSlotLock(h.date, h.slots, lockOwner).catch(() => {});
            }
        },
    };
}

// ─── Personalizado: uma tentativa por vez por cliente ─────────────────────────
/** Trava por cliente-alvo do personalizado: descarte da tentativa anterior + criação nunca rodam em paralelo. */
export const customUserLockKey = (userId: string) => `lock:custom-contract:${userId}`;
/** Maior que a duração de um POST /custom (inclui a chamada ao provedor PIX); liberada no finally. */
export const CUSTOM_USER_LOCK_TTL_SECONDS = 120;
export const CUSTOM_IN_PROGRESS_ERROR = {
    code: 'CUSTOM_IN_PROGRESS',
    error: 'Já existe uma contratação de plano personalizado sendo processada. Aguarde alguns segundos e tente novamente.',
};

export type PreviousCustomAttemptResult = 'ok' | 'paid' | 'inflight';

/** Corpo do 409 quando a tentativa anterior não pôde ser descartada (pagou / pagamento em andamento). */
export function previousCustomAttemptError(r: Exclude<PreviousCustomAttemptResult, 'ok'>): { code: string; error: string } {
    return r === 'paid'
        ? { code: 'CUSTOM_PREVIOUS_PAID', error: 'O pagamento da sua contratação anterior de plano personalizado foi confirmado — o plano já está ativo em Meus Contratos.' }
        : { code: 'CUSTOM_PREVIOUS_INFLIGHT', error: 'Há um pagamento em processamento para a sua contratação anterior de plano personalizado. Aguarde alguns instantes e confira em Meus Contratos.' };
}

/**
 * CLIENTE (D9/D2): uma nova tentativa de personalizado SUBSTITUI a anterior ainda não paga — viva ou
 * vencida — pela rotina segura da varredura (`purgeAwaitingContract`: concilia no provedor; pagou →
 * ativa e NÃO apaga; cobrança em andamento → mantém; senão cancela a cobrança, libera o cupom e apaga).
 * Sem isso, as sessões RESERVED da tentativa viva viravam conflito da nova (e um cliente podia segurar
 * várias agendas ao mesmo tempo). Renovações (renewedFromId) não entram: têm prazo próprio de 3 dias.
 * 'paid' / 'inflight' → o chamador recusa com 409 (previousCustomAttemptError).
 */
export async function discardClientCustomAttempts(userId: string): Promise<PreviousCustomAttemptResult> {
    const previous = await prisma.contract.findMany({
        where: { userId, type: 'CUSTOM', status: ContractStatus.AWAITING_PAYMENT, renewedFromId: null },
        select: { id: true },
    });
    let result: PreviousCustomAttemptResult = 'ok';
    for (const c of previous) {
        let r: Awaited<ReturnType<typeof purgeAwaitingContract>>;
        try {
            r = await purgeAwaitingContract(c.id);
        } catch (err) {
            console.error(`[CUSTOM] Falha ao descartar a tentativa anterior ${c.id} (usuário ${userId}):`, err);
            r = 'inflight';
        }
        if (r !== 'skipped') console.log(`[CUSTOM] Tentativa anterior ${c.id} (usuário ${userId}): ${r}`);
        if (r === 'paid') return 'paid';
        if (r === 'inflight') result = 'inflight';
    }
    return result;
}

/** 'YYYY-MM-DD' + n meses-calendário (UTC) — mesmo `end` de planCustomOccurrences. */
function addMonthsYmd(ds: string, n: number): string {
    const d = new Date(ds + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + n);
    return d.toISOString().slice(0, 10);
}
const ddmmOf = (ds: string) => `${ds.slice(8, 10)}/${ds.slice(5, 7)}`;

/** 'YYYY-MM-DD' de amanhã no calendário de São Paulo. */
export function tomorrowInSaoPaulo(): string {
    const sp = saoPauloParts(new Date());
    return new Date(Date.UTC(sp.y, sp.m - 1, sp.day + 1)).toISOString().slice(0, 10);
}

/**
 * 400 do CLIENTE com início do personalizado diferente de amanhã (D7). `details.startDate` traz o
 * "amanhã" do servidor para o assistente se atualizar (ex.: aberto antes da meia-noite) e reenviar.
 */
export function clientStartDateError(tomorrowSp: string) {
    return {
        error: `O plano personalizado começa amanhã (${ddmmOf(tomorrowSp)}). Confira o resumo e envie de novo.`,
        code: 'START_DATE_TOMORROW',
        details: { startDate: tomorrowSp },
    };
}

/**
 * Desconto do personalizado por VOLUME de gravações (D7): total ≥ `episodes_6months` →
 * `discount_6months`; ≥ `episodes_3months` → `discount_3months`; abaixo → 0. Tudo lido da
 * BusinessConfig (padrão 12/24 gravações → 30%/40%) — a MESMA régua que o assistente
 * (CustomContractFlow) exibe, então o desconto mostrado é o cobrado.
 */
export async function customVolumeDiscountPct(totalSessions: number): Promise<number> {
    const [ep3, ep6, d3, d6] = await Promise.all([
        getConfig('episodes_3months'),
        getConfig('episodes_6months'),
        getConfig('discount_3months'),
        getConfig('discount_6months'),
    ]);
    if (totalSessions >= ep6) return d6;
    if (totalSessions >= ep3) return d3;
    return 0;
}

/**
 * Descarta os personalizados AWAITING_PAYMENT já VENCIDOS (paymentDeadline < agora) de um usuário
 * antes de um novo /custom/check ou POST /custom — pela rotina segura da varredura
 * (`purgeAwaitingContract`: pago no provedor → ativa em vez de apagar; cobrança em andamento →
 * mantém; senão cancela a cobrança abandonada, libera o cupom e apaga). Sem isso, até a varredura
 * (60 s) passar, as sessões RESERVED da tentativa vencida apareciam como conflito do próprio cliente
 * e o uso do cupom continuava preso. Nunca lança: numa falha a varredura tenta de novo.
 */
export async function purgeExpiredCustomAwaiting(userId: string, now: Date = new Date()): Promise<void> {
    let stale: { id: string }[] = [];
    try {
        stale = await prisma.contract.findMany({
            where: { userId, type: 'CUSTOM', status: ContractStatus.AWAITING_PAYMENT, paymentDeadline: { lt: now } },
            select: { id: true },
        });
    } catch (err) {
        console.error('[CUSTOM] Falha ao buscar personalizados vencidos:', err);
        return;
    }
    for (const c of stale) {
        try {
            const r = await purgeAwaitingContract(c.id);
            if (r !== 'skipped') console.log(`[CUSTOM] Personalizado vencido ${c.id} (usuário ${userId}): ${r}`);
        } catch (err) {
            console.error(`[CUSTOM] Falha ao descartar o personalizado vencido ${c.id}:`, err);
        }
    }
}

/**
 * Apply a coupon quote to a schedule of installment amounts.
 * FIRST_PAYMENT → only installment 0 is discounted; ALL_INSTALLMENTS → each
 * installment gets the coupon's discount computed on its own base amount.
 * Returns per-installment {amount, discountAmount} pairs.
 */
function discountSchedule(quote: CouponQuote | null, amounts: number[]): { amount: number; discountAmount: number }[] {
    return amounts.map((base, i) => {
        if (!quote) return { amount: base, discountAmount: 0 };
        if (quote.coupon.scope === 'FIRST_PAYMENT' && i > 0) return { amount: base, discountAmount: 0 };
        const d = i === 0 ? quote.discountAmount : computeCouponDiscount(quote.coupon, base);
        return { amount: base - d, discountAmount: d };
    });
}

/** E3: corpo do 400 quando o boleto é pedido numa contratação do CLIENTE com prazo de pagamento (10 min). */
const CLIENT_BOLETO_ERROR = {
    error: 'O boleto compensa em até 3 dias úteis e não está disponível nesta contratação. Escolha PIX ou cartão.',
    code: 'BOLETO_NOT_ALLOWED_HERE',
};

/**
 * 403 quando a equipe criaria um contrato com parcela de valor ZERO (cupom 100% / valor ≥ total): essa
 * parcela é liquidada como PAGA na hora, e nada criado por quem não tem a baixa manual nasce pago
 * (DECISÕES D3/D7). Mesmo formato do 403 padrão (code/permission), com o motivo no texto.
 */
export const STAFF_ZERO_INSTALLMENT_DENIED = Object.freeze({
    error: 'Este contrato teria parcela com valor zero, que seria registrada como paga — isso exige a permissão “Marcar como pago, anular ou estornar”.',
    code: 'PERMISSION_DENIED',
    permission: 'cobrancas.baixa',
});

/** O alvo de uma criação pela equipe precisa ser um CLIENTE (S5) — conta da equipe ficaria órfã (fora de Clientes). */
async function loadClientTarget(userId: string) {
    const target = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true, deletedAt: true },
    });
    return target && target.role === 'CLIENTE' ? target : null;
}

export function registerCreationRoutes(router: Router) {

// ─── POST /api/contracts (equipe — contratos.criar) ────────────────────────
// Nasce ATIVO com as parcelas EM ABERTO (nunca AWAITING_PAYMENT, que expira em 10 min). Parcela de valor
// zero (liquidada como PAGA) só com cobrancas.baixa (D3).

router.post('/', authenticate, requirePermission('contratos.criar'), async (req: Request, res: Response) => {
    try {
        const data = createContractSchema.parse(req.body);
        const actor = await actorOrReply(req, res);
        if (!actor) return;
        const canMarkPaid = can(actor, 'cobrancas.baixa');

        // Validate Fixo requires day and time
        if (data.type === 'FIXO' && (!data.fixedDayOfWeek || !data.fixedTime)) {
            res.status(400).json({ error: 'Plano Fixo requer dia da semana e horário.' });
            return;
        }

        // E3: boleto só com a chave-mestra "Aceitar pagamento por boleto" ligada E a Cora habilitada
        // (fonte única getBoletoStatus). `boletoAllowed` por contrato não é mais autoridade.
        if (data.paymentMethod === 'BOLETO') {
            const boleto = await getBoletoStatus();
            if (!boleto.available) {
                res.status(400).json({
                    error: boleto.message ?? 'O pagamento por boleto não está disponível.',
                    code: 'BOLETO_UNAVAILABLE',
                    reason: boleto.reason,
                });
                return;
            }
        }

        // D3: nada novo para um cliente excluído (soft delete / anonimizado). Alvo que não é CLIENTE
        // (conta da equipe) → 404, como o inexistente (S5).
        const target = await loadClientTarget(data.userId);
        if (!target) {
            res.status(404).json({ error: 'Cliente não encontrado.' });
            return;
        }
        if (target.deletedAt) {
            res.status(409).json({ error: DELETED_CLIENT_ERROR, code: 'CLIENT_DELETED' });
            return;
        }

        // D8: dia/horário do FIXO (e o novo horário de cada troca aceita no modal de conflitos)
        // precisam estar na grade de contrato da faixa → 400 "Horário inválido".
        if (data.type === 'FIXO') {
            const grid = await getContractSlotGrid(data.tier);
            const slotErr = checkSlotInGrid(grid, data.fixedDayOfWeek!, data.fixedTime!)
                ?? checkResolvedConflictsInGrid(grid, data.resolvedConflicts);
            if (slotErr) {
                res.status(400).json({ error: slotErr, code: 'INVALID_SLOT' });
                return;
            }
        }

        // Calculate discount (dynamic from BusinessConfig)
        const discount3 = await getConfig('discount_3months');
        const discount6 = await getConfig('discount_6months');
        const discountPct = data.durationMonths === 3 ? discount3 : discount6;

        // Calculate dates
        const startDate = new Date(data.startDate + 'T00:00:00');
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + data.durationMonths);

        // Episode-based credits (dynamic from BusinessConfig)
        const ep3 = await getConfig('episodes_3months');
        const ep6 = await getConfig('episodes_6months');
        const totalEpisodes = data.durationMonths === 3 ? ep3 : ep6;

        // Create contract
        const contract = await prisma.contract.create({
            data: {
                userId: data.userId,
                name: data.name,
                type: data.type,
                tier: data.tier,
                durationMonths: data.durationMonths,
                discountPct,
                startDate,
                endDate,
                status: ContractStatus.ACTIVE,
                contractUrl: data.contractUrl || null,
                fixedDayOfWeek: data.type === 'FIXO' ? data.fixedDayOfWeek : null,
                fixedTime: data.type === 'FIXO' ? data.fixedTime : null,
                flexCreditsTotal: data.type === 'FLEX' ? totalEpisodes : null,
                flexCreditsRemaining: data.type === 'FLEX' ? totalEpisodes : null,
                // FLEX clock starts on the 1st recording (set when the 1st booking is made).
                flexCycleStart: null,
                flexWeeksCompensated: data.type === 'FLEX' ? 0 : null,
                flexForfeitFloor: data.type === 'FLEX' ? 0 : null,
                addOns: data.addOns || [],
                boletoAllowed: data.boletoAllowed ?? false,
                paymentMethod: data.paymentMethod ?? null,
                paymentPlan: data.paymentPlan ?? 'MONTHLY',
            },
        });

        // For FIXO contracts: auto-generate bookings for every occurrence
        if (data.type === 'FIXO' && data.fixedDayOfWeek && data.fixedTime) {
            const bookings = [];
            const current = new Date(startDate);

            // Find the first occurrence of the fixed day (UTC — casa com o check-fixo).
            while (current.getUTCDay() !== (data.fixedDayOfWeek % 7)) {
                current.setUTCDate(current.getUTCDate() + 1);
            }

            // Generate weekly bookings until end date
            // Contract is based on 4-week periods, not calendar months
            const sessionsPerMonth = await getConfig('sessions_per_month');
            const totalWeeks = data.durationMonths * sessionsPerMonth;
            const endTime = calculateEndTime(data.fixedTime);
            const basePrice = await getBasePriceDynamic(data.tier);
            const discountedPrice = applyDiscount(basePrice, discountPct);
            const slotDuration = await getSlotDuration();
            let skipped = 0;
            // Trava por slot durante a checagem + gravação (dois pedidos simultâneos nunca gravam o mesmo horário).
            const claimer = createSlotClaimer(`contract:${contract.id}`);

            try {
                for (let week = 0; week < totalWeeks; week++) {
                    const bookingDate = new Date(current);
                    bookingDate.setUTCDate(current.getUTCDate() + week * 7);

                    if (bookingDate > endDate) break;

                    const bookingDateStr = bookingDate.toISOString().split('T')[0];
                    const fixedTime = data.fixedTime!;
                    let finalDateStr = bookingDateStr;
                    let finalTime = fixedTime;

                    // Check override resolutions from validation checks
                    const resolution = data.resolvedConflicts?.find(c =>
                        c.originalDate === bookingDateStr && c.originalTime === fixedTime
                    );

                    if (resolution) {
                        finalDateStr = resolution.newDate;
                        finalTime = resolution.newTime;
                    }

                    // Guard anti-overbooking: nunca gravar por cima de horário ocupado (pula a ocorrência).
                    if (!(await claimer.claim(finalDateStr, getPackageSlots(finalTime, slotDuration)))) {
                        skipped++;
                        console.warn(`[FIXO-admin] slot ocupado — ocorrência pulada (contrato ${contract.id}): ${finalDateStr} ${finalTime}`);
                        continue;
                    }

                    bookings.push({
                        userId: data.userId,
                        contractId: contract.id,
                        date: new Date(finalDateStr + 'T00:00:00Z'),
                        startTime: finalTime,
                        endTime: calculateEndTime(finalTime),
                        status: BookingStatus.CONFIRMED,
                        tierApplied: data.tier,
                        price: discountedPrice,
                        addOns: data.addOns ? data.addOns.filter(a => a !== 'GESTAO_SOCIAL') : [],
                    });
                }

                if (skipped > 0) {
                    console.warn(`[FIXO-admin] ${skipped} ocorrência(s) puladas por conflito no contrato ${contract.id}.`);
                }
                if (bookings.length > 0) {
                    await prisma.booking.createMany({ data: bookings });
                }
            } finally {
                await claimer.releaseAll();
            }
        }

        // Generate payment installments — centralized pricing (add-ons + card surcharge +
        // PIX à-vista discount), identical to the client /self path so the creation endpoint
        // can never under-charge relative to it.
        const basePrice = await getBasePriceDynamic(data.tier);
        const discountedPrice = applyDiscount(basePrice, discountPct);
        const sessionsPerMonthAdmin = await getConfig('sessions_per_month');
        const adminAddonsCost = await computeAddonsCost(data.addOns, discountPct, sessionsPerMonthAdmin);
        const baseMonthly = (sessionsPerMonthAdmin * discountedPrice) + adminAddonsCost;
        const adminProvider = getProviderForMethod(data.paymentMethod || contract.paymentMethod || 'CARTAO');
        const adminIsFull = data.paymentPlan === 'FULL';
        // Centralized: FULL → single à-vista invoice; MONTHLY → durationMonths charges of the
        // plain base (no surcharge) on a 28-day cadence. Same rule as self/custom.
        const adminPlan = await resolvePlanAmounts({
            baseMonthly,
            durationMonths: data.durationMonths,
            plan: (data.paymentPlan || 'MONTHLY') as 'MONTHLY' | 'FULL',
            paymentMethod: data.paymentMethod,
            startDate,
        });
        // Coupon (admin applies on behalf of the client — eligibility is the CLIENT's).
        // The contract/bookings were already created above, so a coupon rejection or an
        // exhausted-cap race must roll them back — never leave an ACTIVE contract with
        // no installments.
        const perInstallmentBase = adminIsFull ? adminPlan.fullAmount : adminPlan.monthlyAmount;
        let adminCoupon: CouponQuote | null = null;
        if (data.couponCode) {
            try {
                adminCoupon = await validateCoupon({ code: data.couponCode, userId: data.userId, baseAmount: perInstallmentBase });
            } catch (err) {
                await prisma.booking.deleteMany({ where: { contractId: contract.id } }).catch(() => {});
                await prisma.contract.delete({ where: { id: contract.id } }).catch(() => {});
                throw err;
            }
        }
        const schedule = discountSchedule(adminCoupon, adminPlan.scheduleDueDates.map(() => perInstallmentBase));
        // D3/D7: parcela de valor zero é liquidada como PAGA logo abaixo — só com cobrancas.baixa. Sem ela,
        // desfaz o que este pedido gravou (mesma reversão do cupom recusado) e responde 403.
        if (!canMarkPaid && schedule.some(s => s.amount <= 0)) {
            await prisma.booking.deleteMany({ where: { contractId: contract.id } }).catch(() => {});
            await prisma.contract.delete({ where: { id: contract.id } }).catch(() => {});
            res.status(403).json(STAFF_ZERO_INSTALLMENT_DENIED);
            return;
        }
        // E2: TODA cobrança à vista (PIX, Cartão ou Boleto) leva a marca `pixDiscount` com os DOIS preços
        // (cartão e PIX, mesmo cupom em R$): criada no PIX o amount já é o preço PIX; criada no
        // Cartão/Boleto o amount é o de cartão e o PIX ganha o desconto na emissão do QR (issuePixCharge).
        const adminFullTotals = adminIsFull
            ? await computeFullContractTotals(baseMonthly, data.durationMonths, data.paymentMethod)
            : null;
        const payments = adminPlan.scheduleDueDates.map((dueDate, i) => {
            const pixDiscount = adminFullTotals
                ? pixDiscountMetaForFullCharge({
                    cardTotal: adminFullTotals.cardTotal,
                    pixTotal: adminFullTotals.pixTotal,
                    couponDiscount: schedule[i]!.discountAmount,
                    pct: adminFullTotals.pixPct,
                })
                : undefined;
            return {
                userId: data.userId,
                contractId: contract.id,
                provider: adminProvider,
                amount: schedule[i]!.amount,
                status: 'PENDING' as const,
                dueDate,
                ...(adminCoupon && schedule[i]!.discountAmount > 0 ? {
                    couponId: adminCoupon.coupon.id,
                    couponCode: adminCoupon.coupon.code,
                    discountAmount: schedule[i]!.discountAmount,
                } : {}),
                ...(pixDiscount ? { metadata: { pixDiscount } } : {}),
            };
        });

        if (payments.length > 0) {
            if (adminCoupon) {
                // Atomic: create the first payment individually (the redemption anchors on
                // its id), reserve the coupon use, then bulk-create the rest — all-or-nothing.
                const quote = adminCoupon;
                try {
                    await prisma.$transaction(async (tx) => {
                        const first = await tx.payment.create({ data: payments[0]! });
                        await reserveCouponUse(tx, {
                            couponId: quote.coupon.id,
                            userId: data.userId,
                            paymentId: first.id,
                            originalAmount: perInstallmentBase,
                            discountAmount: quote.discountAmount,
                            maxUsesPerUser: quote.coupon.maxUsesPerUser,
                        });
                        if (payments.length > 1) {
                            await tx.payment.createMany({ data: payments.slice(1) });
                        }
                    });
                } catch (err) {
                    // Lost the maxUses race (or tx failure) — roll the contract back.
                    await prisma.booking.deleteMany({ where: { contractId: contract.id } }).catch(() => {});
                    await prisma.contract.delete({ where: { id: contract.id } }).catch(() => {});
                    throw err;
                }
            } else {
                await prisma.payment.createMany({ data: payments });
            }
        }

        // Cupom que zera parcelas (100% / VALOR ≥ total): cobrança de R$ 0 nunca vai ao gateway nem ao
        // auto-charge — liquida como PAID na hora, como o /custom faz. A 1ª passa pelos efeitos de
        // confirmação (mesmo caminho de um webhook); as demais só viram PAID (o uso do cupom já está
        // reservado na 1ª).
        const zeroRows = await prisma.payment.findMany({
            where: { contractId: contract.id, amount: 0, status: 'PENDING' },
            orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
            select: { id: true },
        });
        if (zeroRows.length > 0) {
            await prisma.payment.updateMany({
                where: { id: { in: zeroRows.map(r => r.id) }, status: 'PENDING' },
                data: { status: 'PAID', paidAt: new Date() },
            });
            const { onPaymentConfirmed } = await import('../../lib/paymentEffects.js');
            await onPaymentConfirmed(zeroRows[0]!.id);
        }

        const createdPayments = await prisma.payment.findMany({
            where: { contractId: contract.id },
            orderBy: { dueDate: 'asc' },
        });

        res.status(201).json({
            contract: {
                id: contract.id,
                name: contract.name,
                type: contract.type,
                tier: contract.tier,
                durationMonths: contract.durationMonths,
                discountPct: contract.discountPct,
                startDate: data.startDate,
                endDate: endDate.toISOString().split('T')[0],
                status: contract.status,
            },
            payments: createdPayments.map(p => ({
                id: p.id,
                amount: p.amount,
                dueDate: p.dueDate?.toISOString().split('T')[0],
                status: p.status,
            })),
            // First (earliest) payment so the admin can optionally charge it inline on the spot.
            firstPaymentId: createdPayments[0]?.id ?? null,
            message: `Contrato ${data.type} criado com sucesso! ${createdPayments.length} parcelas geradas.`,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        if (err instanceof CouponError) {
            res.status(err.httpStatus).json({ error: err.message, code: err.code });
            return;
        }
        console.error('Erro ao criar contrato (Admin):', err);
        const errMsg = err instanceof Error ? err.message : 'Erro interno ao processar criação do contrato';
        res.status(500).json({ error: errMsg });
    }
});

// ─── POST /api/contracts/self (CLIENT) ──────────────────
// Phase 1: Creates ONLY the first payment with contract data in metadata.
// Contract + bookings are created AFTER payment is confirmed (via webhook/verify).
// Autoatendimento: só CLIENTE (crítica S5) — a equipe cria contratos para clientes pelo POST /.

router.post('/self', authenticate, requireRole('CLIENTE'), async (req: Request, res: Response) => {
    try {
        const data = selfContractSchema.parse(req.body);
        const userId = req.user!.userId;

        // E3: contratação com reserva de 10 minutos → boleto nunca entra (compensa em dias).
        if (data.paymentMethod === 'BOLETO') {
            res.status(400).json(CLIENT_BOLETO_ERROR);
            return;
        }

        // Global guard: reject disabled payment methods
        try {
            await validatePaymentMethod(data.paymentMethod);
        } catch (err) {
            if (err instanceof PaymentMethodDisabledError) {
                res.status(400).json({ error: err.message });
                return;
            }
            throw err;
        }

        // Validate first booking date is within configured window
        const firstBookingMinDays = await getConfig('first_booking_min_days');
        const firstBookingMaxDays = await getConfig('first_booking_max_days');
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const firstDate = new Date(data.firstBookingDate + 'T00:00:00');
        const diffDays = Math.ceil((firstDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays < firstBookingMinDays || diffDays > firstBookingMaxDays) {
            res.status(400).json({ error: `A primeira gravação deve ser agendada para os próximos ${firstBookingMinDays} a ${firstBookingMaxDays} dias.` });
            return;
        }

        // Minimum advance notice (studio timezone). Same rule as avulso; a criação pela equipe usa
        // outra rota (POST /) — aqui é sempre o cliente.
        {
            const minAdvanceHours = await getConfig('booking_min_advance_hours');
            const firstSlotDateTime = studioDateTime(data.firstBookingDate, data.firstBookingTime);
            const diffHours = (firstSlotDateTime.getTime() - Date.now()) / (1000 * 60 * 60);
            if (diffHours < minAdvanceHours) {
                res.status(400).json({ error: `A primeira gravação deve ser agendada com pelo menos ${minAdvanceHours} horas de antecedência.` });
                return;
            }
        }

        // Infer fixedDayOfWeek for FIXO
        if (data.type === 'FIXO' && (!data.fixedDayOfWeek || !data.fixedTime)) {
            const dayOfWeek = firstDate.getDay() === 0 ? 7 : firstDate.getDay();
            data.fixedDayOfWeek = dayOfWeek;
            data.fixedTime = data.firstBookingTime;
        }

        // D8: a 1ª gravação (FIXO e FLEX), o dia/horário fixo (FIXO) e as trocas aceitas no modal de
        // conflitos precisam estar na grade de contrato da faixa → 400 "Horário inválido".
        {
            const grid = await getContractSlotGrid(data.tier);
            const slotErr = checkDateSlotInGrid(grid, data.firstBookingDate, data.firstBookingTime)
                ?? (data.type === 'FIXO' ? checkSlotInGrid(grid, data.fixedDayOfWeek!, data.fixedTime!) : null)
                ?? checkResolvedConflictsInGrid(grid, data.resolvedConflicts);
            if (slotErr) {
                res.status(400).json({ error: slotErr, code: 'INVALID_SLOT' });
                return;
            }
        }

        // Trocas aceitas no modal de conflitos (check-fixo): o check só sugere outro horário no mesmo dia
        // ou o dia livre mais próximo (até ±7 dias, nunca antes do início). Uma troca para o passado, para
        // hoje ou para longe da ocorrência original só chega por chamada direta à API → 400.
        if (data.resolvedConflicts?.length) {
            const tomorrowSp = tomorrowInSaoPaulo();
            const WEEK_MS = 7 * 86_400_000;
            const bad = data.resolvedConflicts.find(rc => {
                const o = Date.parse(rc.originalDate + 'T00:00:00Z');
                const n = Date.parse(rc.newDate + 'T00:00:00Z');
                return !Number.isFinite(o) || !Number.isFinite(n) || rc.newDate < tomorrowSp || Math.abs(n - o) > WEEK_MS;
            });
            if (bad) {
                res.status(400).json({
                    error: `Troca inválida para a gravação de ${ddmmOf(bad.originalDate)}: escolha uma das alternativas sugeridas.`,
                    code: 'INVALID_RESOLUTION',
                });
                return;
            }
        }

        // Calculate first month's amount
        const discountPct = data.durationMonths === 3 ? await getConfig('discount_3months') : await getConfig('discount_6months');
        const basePrice = await getBasePriceDynamic(data.tier);
        const discountedPrice = applyDiscount(basePrice, discountPct);
        const sessionsPerMonth = await getConfig('sessions_per_month');

        const addonsCost = await computeAddonsCost(data.addOns, discountPct, sessionsPerMonth);
        const baseMonthly = (sessionsPerMonth * discountedPrice) + addonsCost;
        // Centralized plan rules (single source of truth): monthly = base (no card
        // surcharge); FULL = à-vista total with PIX discount. Schedule = 28-day cadence.
        const planAmounts = await resolvePlanAmounts({
            baseMonthly,
            durationMonths: data.durationMonths,
            plan: (data.paymentPlan || 'MONTHLY') as 'MONTHLY' | 'FULL',
            paymentMethod: data.paymentMethod,
            startDate: firstDate,
        });
        const monthlyAmount = planAmounts.monthlyAmount;
        const firstAmount = planAmounts.firstAmount;

        // Coupon: discount the FIRST charge here; months 2..N are materialized by
        // contractFulfillment, which applies the per-installment discount itself when
        // the coupon's scope is ALL_INSTALLMENTS (couponForInstallments below).
        let couponQuote: CouponQuote | null = null;
        if (data.couponCode) {
            couponQuote = await validateCoupon({ code: data.couponCode, userId, baseAmount: firstAmount });
        }
        const chargeAmount = couponQuote ? couponQuote.finalAmount : firstAmount;
        // E2: à vista (qualquer forma) → marca `pixDiscount` com os dois preços (cartão e PIX, mesmo cupom
        // em R$). Viaja junto com o contractData no metadata desta cobrança.
        const selfPixDiscount = data.paymentPlan === 'FULL'
            ? await (async () => {
                const totals = await computeFullContractTotals(baseMonthly, data.durationMonths, data.paymentMethod);
                return pixDiscountMetaForFullCharge({
                    cardTotal: totals.cardTotal,
                    pixTotal: totals.pixTotal,
                    couponDiscount: couponQuote?.discountAmount,
                    pct: totals.pixPct,
                });
            })()
            : undefined;

        // Store contract creation data in payment metadata
        const contractData = {
            name: data.name,
            type: data.type,
            tier: data.tier,
            durationMonths: data.durationMonths,
            firstBookingDate: data.firstBookingDate,
            firstBookingTime: data.firstBookingTime,
            paymentMethod: data.paymentMethod,
            addOns: data.addOns || [],
            fixedDayOfWeek: data.fixedDayOfWeek,
            fixedTime: data.fixedTime,
            paymentPlan: data.paymentPlan,
            resolvedConflicts: data.resolvedConflicts,
            // Persist the resolved per-month amount so fulfillment of months 2..N uses the
            // SAME figure even if the surcharge config changes before the payment confirms.
            // NOTE: intentionally WITHOUT the coupon discount — FIRST_PAYMENT coupons must
            // not leak into later installments; ALL scope is handled via couponForInstallments.
            monthlyAmountResolved: monthlyAmount,
            ...(couponQuote && couponQuote.coupon.scope === 'ALL_INSTALLMENTS' ? {
                couponForInstallments: {
                    couponId: couponQuote.coupon.id,
                    couponCode: couponQuote.coupon.code,
                    discountType: couponQuote.coupon.discountType,
                    discountValue: couponQuote.coupon.discountValue,
                },
            } : {}),
        };

        // Create ONLY the first payment (no contract yet) + reserve the coupon use
        // in the SAME transaction (atomic maxUses guard).
        const firstPayment = await prisma.$transaction(async (tx) => {
            const p = await tx.payment.create({
                data: {
                    userId,
                    provider: getProviderForMethod(data.paymentMethod),
                    amount: chargeAmount,
                    status: 'PENDING',
                    dueDate: firstDate,
                    metadata: { contractData, ...(selfPixDiscount ? { pixDiscount: selfPixDiscount } : {}) },
                    ...(couponQuote ? {
                        couponId: couponQuote.coupon.id,
                        couponCode: couponQuote.coupon.code,
                        discountAmount: couponQuote.discountAmount,
                    } : {}),
                },
            });
            if (couponQuote) {
                await reserveCouponUse(tx, {
                    couponId: couponQuote.coupon.id,
                    userId,
                    paymentId: p.id,
                    originalAmount: firstAmount,
                    discountAmount: couponQuote.discountAmount,
                    maxUsesPerUser: couponQuote.coupon.maxUsesPerUser,
                });
            }
            return p;
        });

        // 100% coupon → zero charge: skip the gateway entirely (Stripe rejects <R$0,50
        // PaymentIntents and Cora can't issue a zero invoice). Flip to PAID atomically
        // and run the exact same confirmation effects as a webhook would.
        if (chargeAmount === 0) {
            await prisma.payment.updateMany({
                where: { id: firstPayment.id, status: 'PENDING' },
                data: { status: 'PAID', paidAt: new Date() },
            });
            const { onPaymentConfirmed } = await import('../../lib/paymentEffects.js');
            await onPaymentConfirmed(firstPayment.id);
            res.status(201).json({
                message: 'Cupom aplicado — contrato ativado sem cobrança!',
                firstPaymentId: firstPayment.id,
                amount: 0,
                duration: data.durationMonths,
                alreadyPaid: true,
                ...(couponQuote && { couponDiscount: couponQuote.discountAmount }),
            });
            return;
        }

        // Enrich with gateway data. PIX/BOLETO generate the QR/boleto up-front so the client
        // can pay immediately. CARTÃO does NOT pre-create the PaymentIntent here — the inline
        // checkout creates it with the chosen installments (matching idempotency key + juros
        // policy); pre-creating it would collide with that second call.
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true, cpfCnpj: true } });
        let clientSecret: string | null = null;
        let pixString: string | null = null;

        if (data.paymentMethod !== 'CARTAO') {
            try {
                const result = await gatewayCreatePayment({
                    paymentMethod: data.paymentMethod as 'PIX' | 'BOLETO' | 'CARTAO',
                    amount: chargeAmount,
                    description: `${data.name} - 1ª Parcela`,
                    customer: { name: user?.name || 'Cliente', email: user?.email || '', cpf: user?.cpfCnpj?.replace(/\D/g, '') || undefined },
                    dueDate: firstDate,
                    paymentId: firstPayment.id,
                    userId,
                });
                await updatePaymentWithGatewayResult(firstPayment.id, result);

                if (result.clientSecret) clientSecret = result.clientSecret;
                if (result.pixString) pixString = result.pixString;
            } catch (err) {
                // Gateway failed (e.g. invalid CPF, Cora down). Do NOT return a misleading
                // 201 — the payment would linger as PENDING with no QR/secret to pay it.
                // Give the coupon use back, then delete the orphan pre-contract payment.
                console.error(`[Contract:Self] Failed to create gateway payment:`, err);
                await releaseAndPurgeCouponsForPayments([firstPayment.id]);
                await prisma.payment.delete({ where: { id: firstPayment.id } }).catch(() => {});
                const msg = err instanceof Error ? err.message : 'Erro ao gerar o pagamento. Tente novamente ou use outro método.';
                res.status(502).json({ error: msg });
                return;
            }
        }

        const duration = data.durationMonths;
        console.log(`CONTRACT PAYMENT ${firstPayment.id} created for user ${userId}, amount: ${chargeAmount}, plan: ${data.paymentPlan}, method: ${data.paymentMethod}`);

        res.status(201).json({
            message: data.paymentPlan === 'FULL'
                ? `Pagamento integral gerado. Efetue o pagamento para ativar seu contrato.`
                : `Pagamento da 1ª parcela gerado. Efetue o pagamento para ativar seu contrato.`,
            firstPaymentId: firstPayment.id,
            amount: chargeAmount,
            duration,
            ...(couponQuote && { couponDiscount: couponQuote.discountAmount }),
            ...(clientSecret && { clientSecret }),
            ...(pixString && { firstPixString: pixString }),
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        if (err instanceof CouponError) {
            res.status(err.httpStatus).json({ error: err.message, code: err.code });
            return;
        }
        console.error('Erro ao criar pagamento do contrato (Cliente):', err);
        const errMsg = err instanceof Error ? err.message : 'Erro interno ao processar criação do contrato';
        res.status(500).json({ error: errMsg });
    }
});

// ─── POST /api/contracts/custom (CLIENTE + equipe) ────────
// "Monte Seu Plano" — multi-day custom contract
// Rota MISTA: a equipe precisa de `contratos.criar` (sem ela, 403 — nunca o ramo do cliente) e SEMPRE
// informa o cliente em `userId` (S5: nunca para a própria conta; alvo que não é CLIENTE → 404).
//
// D9 — pagamento:
//  - EQUIPE: o contrato nasce ACTIVE (como FIXO/FLEX da equipe), sessões CONFIRMED (PROGRESSIVE:
//    ciclos 2+ RESERVED) e TODAS as parcelas PENDING, SEM chamar o gateway — a cobrança sai pelo
//    ChargeNowSheet (/stripe/create-payment, com o gate de CPF do cliente) ou fica pendente. Parcela
//    de valor zero (liquidada como PAGA) só com cobrancas.baixa (D3/D7).
//  - CLIENTE: contrato AWAITING_PAYMENT com paymentDeadline = agora + lockTtlSeconds (10 min),
//    sessões RESERVED (ocupam a agenda), parcelas PENDING e SÓ a 1ª cobrada no gateway agora
//    (PIX/boleto; cartão segue pelo checkout inline). Pagou → paymentEffects ativa o contrato e
//    promove as sessões; não pagou → cleanExpiredHolds (bloco AWAITING_PAYMENT) apaga contrato,
//    sessões e parcelas.
// D7 — o CLIENTE só contrata semanal, com início = amanhã (fuso SP) e 1/3/6/9/12 ciclos; trocas de
//      conflito só de horário, no mesmo dia.
// D8 — schedule, customDates e trocas aceitas precisam estar na grade de contrato (400 INVALID_SLOT).
// Nenhuma ocorrência fica de fora: horário ocupado na gravação → 409 SLOTS_TAKEN (nada é criado).

const CLIENT_CUSTOM_DURATIONS = [1, 3, 6, 9, 12];

// Uma criação de personalizado por cliente-alvo por vez (trava Redis por usuário, sem espera): o descarte
// da tentativa anterior e a gravação nunca rodam em paralelo para o mesmo cliente (clique duplo, duas abas,
// admin e cliente ao mesmo tempo). As travas por SLOT (createSlotClaimer) cuidam de clientes diferentes.
router.post('/custom', authenticate, requirePermissionIfStaff('contratos.criar'), async (req: Request, res: Response) => {
    const actor = await routeActor(req, res);
    if (!actor) return;
    const bodyUserId = req.body && typeof req.body.userId === 'string' ? req.body.userId : undefined;
    const lockUserId = actor.isStaff && bodyUserId ? bodyUserId : req.user!.userId;
    const lockKey = customUserLockKey(lockUserId);
    try {
        if (!(await acquireMutex(lockKey, CUSTOM_USER_LOCK_TTL_SECONDS))) {
            res.status(409).json(CUSTOM_IN_PROGRESS_ERROR);
            return;
        }
    } catch (err) {
        console.error('[CUSTOM] Falha ao obter a trava do cliente:', err);
        res.status(503).json({ error: 'Serviço temporariamente indisponível. Tente novamente em instantes.' });
        return;
    }
    try {
        await createCustomContract(req, res, actor);
    } finally {
        await releaseMutex(lockKey).catch(() => {});
    }
});

async function createCustomContract(req: Request, res: Response, actor: Actor): Promise<void> {
    try {
        const data = customContractSchema.parse(req.body);
        // Equipe (ADMIN ou COLABORADOR com contratos.criar — conferido pela guarda da rota). Papel do BANCO.
        const isStaff = actor.isStaff;
        // S5: a equipe cria SEMPRE para um cliente — nunca para a própria conta (ficaria órfão).
        if (isStaff && !data.userId) {
            res.status(400).json({ error: 'Informe o cliente do contrato.', code: 'CLIENT_REQUIRED' });
            return;
        }
        const userId = isStaff ? data.userId! : req.user!.userId;

        // E3: o personalizado do CLIENTE tem prazo de 10 minutos para pagar → boleto nunca entra. O do
        // admin (contrato já ativo, cobrança pelo painel) aceita boleto quando ele está EFETIVO — a
        // validatePaymentMethod abaixo usa a fonte única (chave-mestra + Cora).
        if (!isStaff && data.paymentMethod === 'BOLETO') {
            res.status(400).json(CLIENT_BOLETO_ERROR);
            return;
        }

        // Global guard: reject disabled payment methods
        try {
            await validatePaymentMethod(data.paymentMethod);
        } catch (err) {
            if (err instanceof PaymentMethodDisabledError) {
                res.status(400).json({ error: err.message });
                return;
            }
            throw err;
        }

        const frequency = data.frequency || 'WEEKLY';

        // ─── Restrições do CLIENTE (D7) — o admin mantém todas as opções ──
        const tomorrowSp = tomorrowInSaoPaulo();
        if (!isStaff) {
            if (frequency !== 'WEEKLY') {
                res.status(400).json({ error: 'No plano personalizado a frequência disponível é semanal.' });
                return;
            }
            if (!CLIENT_CUSTOM_DURATIONS.includes(data.durationMonths)) {
                res.status(400).json({ error: `Duração inválida: escolha ${CLIENT_CUSTOM_DURATIONS.slice(0, -1).join(', ')} ou ${CLIENT_CUSTOM_DURATIONS[CLIENT_CUSTOM_DURATIONS.length - 1]} ciclos.` });
                return;
            }
            // D7: início FIXO = amanhã (SP). Nem antes, nem depois — datas livres de início são do admin.
            if (data.startDate && data.startDate !== tomorrowSp) {
                res.status(400).json(clientStartDateError(tomorrowSp));
                return;
            }
        }
        const startDateStr = isStaff ? (data.startDate ?? tomorrowSp) : tomorrowSp;

        // ─── Estrutura + grade de horários (D8) ─────────────
        if (frequency === 'CUSTOM' ? !(data.customDates && data.customDates.length > 0) : data.schedule.length === 0) {
            res.status(400).json({ error: frequency === 'CUSTOM' ? 'Selecione pelo menos uma data.' : 'Selecione pelo menos um dia e horário.' });
            return;
        }
        const grid = await getContractSlotGrid(data.tier);
        const slotErr = checkCustomScheduleInGrid(grid, { frequency, schedule: data.schedule, customDates: data.customDates })
            ?? checkResolvedConflictsInGrid(grid, data.resolvedConflicts);
        if (slotErr) {
            res.status(400).json({ error: slotErr, code: 'INVALID_SLOT' });
            return;
        }

        // D7: no CLIENTE a troca aceita no modal de conflitos só muda o HORÁRIO, no MESMO dia (é o que o
        // /custom/check sugere), dentro do período e a partir de amanhã — nunca passado, hoje ou fora da vigência.
        if (!isStaff && data.resolvedConflicts?.length) {
            const endStr = addMonthsYmd(startDateStr, data.durationMonths);
            const bad = data.resolvedConflicts.find(rc =>
                rc.newDate !== rc.originalDate || rc.newDate < tomorrowSp || rc.newDate >= endStr);
            if (bad) {
                res.status(400).json({
                    error: `Troca de horário inválida para a gravação de ${ddmmOf(bad.originalDate)}: a sugestão só pode mudar o horário no mesmo dia, dentro do período do plano.`,
                    code: 'INVALID_RESOLUTION',
                });
                return;
            }
        }

        // D3: cliente-alvo existe e não foi excluído (soft delete) — antes de descartar/criar qualquer coisa.
        // S5: pela equipe, o alvo precisa ser um CLIENTE (conta da equipe → 404, como a inexistente).
        const userInfo = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true, cpfCnpj: true, deletedAt: true, role: true } });
        if (!userInfo || (isStaff && userInfo.role !== 'CLIENTE')) {
            res.status(404).json({ error: 'Cliente não encontrado.' });
            return;
        }
        if (userInfo.deletedAt) {
            res.status(409).json({ error: DELETED_CLIENT_ERROR, code: 'CLIENT_DELETED' });
            return;
        }

        // Tentativas anteriores não pagas saem ANTES do cupom (libera um uso preso) e do anti-overbooking
        // (as sessões RESERVED delas não viram conflito da nova):
        //  - CLIENTE: a nova tentativa substitui a anterior, viva ou vencida (D2/D9). Se a anterior foi paga
        //    ou tem pagamento em andamento → 409 (nada é criado).
        //  - ADMIN: só as VENCIDAS do cliente-alvo — nunca apaga uma tentativa viva do cliente.
        if (!isStaff) {
            const prev = await discardClientCustomAttempts(userId);
            if (prev !== 'ok') {
                res.status(409).json(previousCustomAttemptError(prev));
                return;
            }
        } else {
            await purgeExpiredCustomAwaiting(userId);
        }

        // ─── Volume calculations (mode-aware) ────────────────
        const { totalSessions, sessionsPerWeek, sessionsPerCycle } = computeCustomVolume({
            frequency,
            durationMonths: data.durationMonths,
            schedule: data.schedule,
            weekPattern: data.weekPattern,
            customDates: data.customDates,
        });

        // ─── Discount logic (volume-based from BusinessConfig) ──────
        // Régua por nº de gravações lida da config (episodes_3/6months → discount_3/6months).
        const discountPct = await customVolumeDiscountPct(totalSessions);

        // ─── Dates ──────────────────────────────────────────
        const startDate = new Date(startDateStr + 'T00:00:00');
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + data.durationMonths);

        // ─── Access mode (from admin config) ─────────────────
        const pmConfig = await prisma.paymentMethodConfig.findUnique({ where: { key: data.paymentMethod } });
        const accessMode = pmConfig?.accessMode === 'PROGRESSIVE' ? 'PROGRESSIVE' : 'FULL';

        // ─── Pricing (calculado ANTES de gravar qualquer coisa) ──
        const basePrice = await getBasePriceDynamic(data.tier);
        const discountedPrice = applyDiscount(basePrice, discountPct);

        // Calculate addons cost per cycle
        let addonsCostPerCycle = 0;
        if (data.addOns && data.addOns.length > 0) {
            const addonConfigs = await prisma.addOnConfig.findMany({
                where: { key: { in: data.addOns } },
            });

            for (const addon of addonConfigs) {
                const addonCfg = data.addonConfig?.[addon.key];
                if (addonCfg?.mode === 'credits' && addonCfg.perCycle) {
                    // Credits: charge per-credit price × credits per cycle
                    addonsCostPerCycle += applyDiscount(addon.price * addonCfg.perCycle, discountPct);
                } else {
                    // All: charge per-session price × sessions per cycle
                    addonsCostPerCycle += applyDiscount(addon.price * sessionsPerCycle, discountPct);
                }
            }
        }

        const cycleBaseAmount = sessionsPerCycle * discountedPrice;
        const cycleAmount = cycleBaseAmount + addonsCostPerCycle;

        // Centralized: same plan rules as FIXO/FLEX — FULL → single à-vista invoice (PIX
        // discount); MONTHLY → durationMonths charges of the plain cycle amount (no card
        // surcharge) on a 28-day cadence.
        const customIsFull = data.paymentPlan === 'FULL';
        const customPlan = await resolvePlanAmounts({
            baseMonthly: cycleAmount,
            durationMonths: data.durationMonths,
            plan: (data.paymentPlan || 'MONTHLY') as 'MONTHLY' | 'FULL',
            paymentMethod: data.paymentMethod,
            startDate,
        });
        const customProvider = getProviderForMethod(data.paymentMethod);

        // B23: "Datas Livres" (frequency CUSTOM) cobra o total EXATO por totalSessions (as N datas
        // agendadas), distribuído pelas parcelas com o RESTO na última. O modelo por-ciclo
        // (sessionsPerCycle = round(N/durationMonths)) divergia da contagem real de datas quando N não é
        // múltiplo de durationMonths (over/undercharge). Demais frequências mantêm o cálculo uniforme.
        let perInstallmentBases: number[];
        // E2: à vista → totais nos dois meios (a marca `pixDiscount` guarda o preço de cartão e o de PIX).
        let customFullTotals: Awaited<ReturnType<typeof computeFullContractTotals>> | null = null;
        if (frequency === 'CUSTOM') {
            let addonsCostExact = 0;
            if (data.addOns && data.addOns.length > 0) {
                const addonCfgs = await prisma.addOnConfig.findMany({ where: { key: { in: data.addOns } } });
                for (const addon of addonCfgs) {
                    const cfg = data.addonConfig?.[addon.key];
                    addonsCostExact += (cfg?.mode === 'credits' && cfg.perCycle)
                        ? applyDiscount(addon.price * cfg.perCycle * data.durationMonths, discountPct)
                        : applyDiscount(addon.price * totalSessions, discountPct);
                }
            }
            const exactTotal = (discountedPrice * totalSessions) + addonsCostExact;
            if (customIsFull) {
                customFullTotals = await computeFullContractTotals(exactTotal, 1, data.paymentMethod);
                perInstallmentBases = [customFullTotals.total];
            } else {
                const m = customPlan.scheduleDueDates.length;
                const per = Math.floor(exactTotal / m);
                perInstallmentBases = Array.from({ length: m }, (_, i) => (i === m - 1 ? exactTotal - per * (m - 1) : per));
            }
        } else {
            if (customIsFull) customFullTotals = await computeFullContractTotals(cycleAmount, data.durationMonths, data.paymentMethod);
            const uniformBase = customIsFull ? customPlan.fullAmount : customPlan.monthlyAmount;
            perInstallmentBases = customPlan.scheduleDueDates.map(() => uniformBase);
        }

        // Coupon (client self-serve or admin on behalf — eligibility is the target user's).
        // Quote validated BEFORE anything is created; the use is reserved atomically together
        // with the 1st installment below.
        const customBase = perInstallmentBases[0]!;
        let customCoupon: CouponQuote | null = null;
        if (data.couponCode) {
            customCoupon = await validateCoupon({ code: data.couponCode, userId, baseAmount: customBase });
        }
        const customSchedule2 = discountSchedule(customCoupon, perInstallmentBases);

        // D3/D7: pela equipe, parcela de valor zero é liquidada como PAGA (abaixo) — só com cobrancas.baixa.
        // Recusa ANTES de gravar qualquer coisa. (O cliente com cupom 100% segue como sempre.)
        if (isStaff && !can(actor, 'cobrancas.baixa') && customSchedule2.some(s => s.amount <= 0)) {
            res.status(403).json(STAFF_ZERO_INSTALLMENT_DENIED);
            return;
        }

        // D9: o CLIENTE paga a 1ª parcela agora; por PIX/boleto o gateway exige CPF/CNPJ válido →
        // 400 claro ANTES de criar contrato/sessões (antes virava 502 com rollback).
        const awaitingPayment = !isStaff;
        const firstChargeAmount = customSchedule2[0]?.amount ?? 0;
        const chargesGatewayNow = awaitingPayment && data.paymentMethod !== 'CARTAO' && firstChargeAmount > 0;
        if (chargesGatewayNow && !isValidCpfCnpj(userInfo.cpfCnpj)) {
            res.status(400).json({
                error: 'Para pagar via PIX ou boleto, cadastre um CPF/CNPJ válido no seu perfil antes de contratar.',
                code: 'CPF_CNPJ_REQUIRED',
            });
            return;
        }

        // ─── Create contract ────────────────────────────────
        const paymentDeadline = awaitingPayment ? new Date(Date.now() + config.studio.lockTtlSeconds * 1000) : null;
        const contract = await prisma.contract.create({
            data: {
                userId,
                name: data.name,
                type: 'CUSTOM' as any,
                tier: data.tier,
                durationMonths: data.durationMonths,
                discountPct,
                startDate,
                endDate,
                status: awaitingPayment ? ContractStatus.AWAITING_PAYMENT : ContractStatus.ACTIVE,
                paymentDeadline,
                paymentMethod: data.paymentMethod,
                addOns: data.addOns || [],
                customSchedule: JSON.stringify({
                    frequency,
                    schedule: data.schedule,
                    weekPattern: data.weekPattern,
                    customDates: data.customDates,
                }),
                sessionsPerWeek,
                sessionsPerCycle,
                totalSessions,
                addonCredits: data.addonConfig ? JSON.stringify(data.addonConfig) : null,
                accessMode,
                paymentPlan: data.paymentPlan ?? 'MONTHLY',
            },
        });

        // Desfaz tudo o que este pedido gravou (cupom → parcelas → sessões → contrato; FK-safe).
        const rollback = async () => {
            const doomed = await prisma.payment.findMany({ where: { contractId: contract.id }, select: { id: true } });
            if (doomed.length > 0) await releaseAndPurgeCouponsForPayments(doomed.map(d => d.id));
            await prisma.payment.deleteMany({ where: { contractId: contract.id } }).catch(() => {});
            await prisma.booking.deleteMany({ where: { contractId: contract.id } }).catch(() => {});
            await prisma.contract.delete({ where: { id: contract.id } }).catch(() => {});
        };

        // ─── Generate bookings (mode-aware + anti-overbooking) ──
        // Mesmas ocorrências do /custom/check (planCustomOccurrences). Cada ocorrência é TRANCADA (Redis,
        // por slot) e só então conferida no banco — dois pedidos simultâneos nunca gravam o mesmo horário.
        // O preço foi calculado pelo volume planejado, então NENHUMA ocorrência pode ficar de fora: se
        // alguma cair em horário ocupado (sem troca aceita, ou ocupado entre o check e o envio), nada é
        // criado → 409 SLOTS_TAKEN com a lista, para o cliente/admin ajustar a agenda. Assim o valor
        // cobrado sempre corresponde às sessões agendadas.
        const slotDuration = grid.slotDurationHours;
        const perEpisodeAddOns = data.addOns ? data.addOns.filter(a => a !== 'GESTAO_SOCIAL') : [];
        const bookings: any[] = [];
        const skipped: { date: string; time: string }[] = [];
        const claimer = createSlotClaimer(`custom:${contract.id}`);
        try {
            const occurrences = planCustomOccurrences({
                frequency,
                durationMonths: data.durationMonths,
                schedule: data.schedule,
                weekPattern: data.weekPattern,
                customDates: data.customDates,
                startDate: startDateStr,
            });
            for (const occ of occurrences) {
                let finalDateStr = occ.date;
                let finalTime = occ.time;
                const resolution = data.resolvedConflicts?.find(c =>
                    c.originalDate === occ.date && c.originalTime === occ.time
                );
                if (resolution) {
                    finalDateStr = resolution.newDate;
                    finalTime = resolution.newTime;
                }

                const pkg = getPackageSlots(finalTime, slotDuration);
                // Depois da 1ª ocorrência ocupada o pedido já vai ser recusado (409): as demais só são
                // CONSULTADAS (sem trancar), para listar os conflitos sem segurar horários. Trancar em ordem
                // cronológica e parar na 1ª falha garante que, entre dois pedidos simultâneos, um sempre vence.
                if (skipped.length > 0) {
                    if (!(await claimer.isFree(finalDateStr, pkg))) skipped.push({ date: finalDateStr, time: finalTime });
                    continue;
                }
                if (!(await claimer.claim(finalDateStr, pkg))) {
                    skipped.push({ date: finalDateStr, time: finalTime });
                    continue;
                }

                // Cliente: tudo RESERVED até pagar (D9). Admin: CONFIRMED; PROGRESSIVE deixa os ciclos
                // 2+ RESERVED (liberados a cada parcela paga). Datas Livres: sempre CONFIRMED no admin.
                const status = awaitingPayment
                    ? BookingStatus.RESERVED
                    : (frequency !== 'CUSTOM' && accessMode === 'PROGRESSIVE' && Math.floor(occ.weekIndex / 4) > 0)
                        ? BookingStatus.RESERVED
                        : BookingStatus.CONFIRMED;

                bookings.push({
                    userId,
                    contractId: contract.id,
                    date: new Date(finalDateStr + 'T00:00:00Z'),
                    startTime: finalTime,
                    endTime: calculateEndTime(finalTime, slotDuration),
                    status,
                    tierApplied: data.tier,
                    price: discountedPrice,
                    addOns: perEpisodeAddOns,
                });
            }
            if (skipped.length > 0) {
                console.warn(`[CUSTOM] ${skipped.length} ocorrência(s) em horário ocupado — contrato ${contract.id} desfeito (409).`);
                await rollback();
                const all = skipped.length >= occurrences.length;
                const list = skipped.slice(0, 6).map(s => `${ddmmOf(s.date)} ${s.time}`).join(', ') + (skipped.length > 6 ? '…' : '');
                res.status(409).json({
                    error: all
                        ? 'Todos os horários escolhidos já estão ocupados no período. Escolha outros dias ou horários.'
                        : `${skipped.length === 1 ? 'Um horário ficou indisponível' : `${skipped.length} horários ficaram indisponíveis`} (${list}). Ajuste a agenda e tente de novo — nenhuma gravação é cobrada sem data.`,
                    code: all ? 'ALL_SLOTS_TAKEN' : 'SLOTS_TAKEN',
                    skipped,
                    details: { skipped },
                });
                return;
            }
            await prisma.booking.createMany({ data: bookings });
        } catch (err) {
            await rollback();
            throw err;
        } finally {
            await claimer.releaseAll();
        }

        // ─── Generate payments per cycle (4 weeks) ──────────
        const payments: any[] = customPlan.scheduleDueDates.map((dueDate, i) => {
            // E2: à vista (qualquer forma) → marca `pixDiscount` com os dois preços (mesmo cupom em R$).
            const pixDiscount = customFullTotals
                ? pixDiscountMetaForFullCharge({
                    cardTotal: customFullTotals.cardTotal,
                    pixTotal: customFullTotals.pixTotal,
                    couponDiscount: customSchedule2[i]!.discountAmount,
                    pct: customFullTotals.pixPct,
                })
                : undefined;
            return {
                userId,
                contractId: contract.id,
                provider: customProvider,
                amount: customSchedule2[i]!.amount,
                status: 'PENDING' as const,
                dueDate,
                ...(customCoupon && customSchedule2[i]!.discountAmount > 0 ? {
                    couponId: customCoupon.coupon.id,
                    couponCode: customCoupon.coupon.code,
                    discountAmount: customSchedule2[i]!.discountAmount,
                } : {}),
                ...(pixDiscount ? { metadata: { pixDiscount } } : {}),
            };
        });

        if (payments.length > 0) {
            try {
                if (customCoupon) {
                    const quote = customCoupon;
                    await prisma.$transaction(async (tx) => {
                        const first = await tx.payment.create({ data: payments[0]! });
                        await reserveCouponUse(tx, {
                            couponId: quote.coupon.id,
                            userId,
                            paymentId: first.id,
                            originalAmount: customBase,
                            discountAmount: quote.discountAmount,
                            maxUsesPerUser: quote.coupon.maxUsesPerUser,
                        });
                        if (payments.length > 1) {
                            await tx.payment.createMany({ data: payments.slice(1) });
                        }
                    });
                } else {
                    await prisma.payment.createMany({ data: payments });
                }
            } catch (err) {
                // Lost the maxUses race (or tx failure) — roll the contract back.
                await rollback();
                throw err;
            }
        }

        const allPayments = await prisma.payment.findMany({
            where: { contractId: contract.id },
            orderBy: { dueDate: 'asc' },
        });

        let firstClientSecret: string | null = null;
        const firstPaymentId: string | null = allPayments[0]?.id ?? null;
        let firstPixString: string | null = null;

        // 100% coupon → zero first charge: skip the gateway (it can't process R$0) and
        // confirm immediately with the same effects a webhook would run (activates an
        // AWAITING_PAYMENT contract).
        if (allPayments.length > 0 && allPayments[0]!.amount === 0) {
            await prisma.payment.updateMany({
                where: { id: allPayments[0]!.id, status: 'PENDING' },
                data: { status: 'PAID', paidAt: new Date() },
            });
            const { onPaymentConfirmed } = await import('../../lib/paymentEffects.js');
            await onPaymentConfirmed(allPayments[0]!.id);
        }

        // Remaining zero-amount installments (100% ALL-scope coupon): settle them as PAID directly
        // (no gateway, no separate redemption — the use was reserved on the first payment)
        // instead of leaving them PENDING forever.
        const otherZeroIds = allPayments.filter((p, i) => i > 0 && p.amount === 0).map(p => p.id);
        if (otherZeroIds.length > 0) {
            await prisma.payment.updateMany({
                where: { id: { in: otherZeroIds }, status: 'PENDING' },
                data: { status: 'PAID', paidAt: new Date() },
            });
        }

        // D9: só o CLIENTE gera cobrança agora, e só da 1ª parcela (PIX/boleto). CARTÃO não pré-cria
        // PaymentIntent (o checkout inline cria com as parcelas escolhidas). Parcelas 2..N ficam
        // PENDING sem cobrança — geradas sob demanda ao pagar (Meus Pagamentos / auto-charge).
        // D2/D15: o QR PIX da 1ª parcela expira JUNTO com o paymentDeadline do contrato (10 min) —
        // nunca fica pagável depois que a varredura apaga a contratação. Mesma regra do
        // issuePixCharge (pixExpirySecondsFor), então uma reemissão pelo checkout mantém o prazo.
        const first = allPayments[0];
        let firstPixExpiresAt: Date | null = null;
        let firstQrCodeDataUrl: string | null = null;
        if (chargesGatewayNow && first && first.amount > 0) {
            try {
                const result = await gatewayCreatePayment({
                    paymentMethod: data.paymentMethod as 'PIX' | 'BOLETO' | 'CARTAO',
                    amount: first.amount,
                    description: `${data.name} - 1ª Parcela`,
                    customer: { name: userInfo.name || 'Cliente', email: userInfo.email || '', cpf: cleanDocument(userInfo.cpfCnpj) || undefined },
                    dueDate: first.dueDate || new Date(),
                    paymentId: first.id,
                    contractId: contract.id,
                    userId,
                    expiresSeconds: pixExpirySecondsFor({ contract: { status: ContractStatus.AWAITING_PAYMENT, paymentDeadline } }),
                });
                await updatePaymentWithGatewayResult(first.id, result);
                if (result.pixString) {
                    firstPixString = result.pixString;
                    firstPixExpiresAt = result.expiresAt ?? null;
                    firstQrCodeDataUrl = await pixQrDataUrl(result.pixString);
                }
                if (result.clientSecret) firstClientSecret = result.clientSecret;
            } catch (err) {
                // A 1ª parcela é o que o cliente paga AGORA. Falha real do provedor → desfaz tudo
                // (nada de contrato fantasma segurando horários) e responde 502 com a mensagem.
                console.error(`[Gateway] Failed to create payment for ${first.id}:`, err);
                await rollback();
                const msg = err instanceof Error ? err.message : 'Erro ao gerar o pagamento. Tente novamente ou use outro método.';
                res.status(502).json({ error: msg });
                return;
            }
        }

        const [createdPayments, freshContract] = await Promise.all([
            prisma.payment.findMany({ where: { contractId: contract.id }, orderBy: { dueDate: 'asc' } }),
            prisma.contract.findUnique({ where: { id: contract.id } }),
        ]);
        const finalContract = freshContract ?? contract;
        const stillAwaiting = finalContract.status === ContractStatus.AWAITING_PAYMENT;
        const deadlineMin = Math.round(config.studio.lockTtlSeconds / 60);

        res.status(201).json({
            contract: {
                ...finalContract,
                customSchedule: data.schedule,
            },
            status: finalContract.status,
            paymentDeadline: finalContract.paymentDeadline ? finalContract.paymentDeadline.toISOString() : null,
            payments: createdPayments.map(p => ({
                id: p.id,
                amount: p.amount,
                dueDate: p.dueDate?.toISOString().split('T')[0],
                status: p.status,
            })),
            summary: {
                sessionsPerWeek,
                sessionsPerCycle,
                totalSessions,
                discountPct,
                accessMode,
                cycleAmount,
                totalBookingsGenerated: bookings.length,
                skippedOccurrences: skipped.length,
            },
            skipped,
            message: stillAwaiting
                ? `Plano Personalizado reservado! ${bookings.length} sessões seguras por ${deadlineMin} minutos até o pagamento da 1ª parcela.`
                : `Plano Personalizado criado! ${bookings.length} sessões reservadas com ${discountPct}% de desconto.`,
            firstPaymentId,
            ...(firstClientSecret && { clientSecret: firstClientSecret }),
            ...(firstPixString && { firstPixString }),
            // PIX da 1ª parcela: imagem do QR e fim da validade (= paymentDeadline), no mesmo
            // formato de /stripe/create-payment.
            ...(firstPixString && firstQrCodeDataUrl && { qrCodeDataUrl: firstQrCodeDataUrl }),
            ...(firstPixString && firstPixExpiresAt && { expiresAt: firstPixExpiresAt.toISOString() }),
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        if (err instanceof CouponError) {
            res.status(err.httpStatus).json({ error: err.message, code: err.code });
            return;
        }
        console.error('Erro ao criar contrato custom:', err);
        const errMsg = err instanceof Error ? err.message : 'Erro interno';
        res.status(500).json({ error: errMsg });
    }
}

} // end registerCreationRoutes
