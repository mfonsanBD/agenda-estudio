import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireRole, actorOrReply, can, enforceRuleResult } from '../../middleware/permissions.js';
import { requiredForAdminBookingCreate, ADMIN_BOOKING_DOWNGRADE_MESSAGE, adminPlanBookingReservedMessage } from '../../lib/permissionRules.js';
import { acquireMultiSlotLock, releaseMultiSlotLock, acquireMutexBlocking, releaseMutex } from '../../lib/redis.js';
import { stripeCreatePaymentIntent, stripeGetOrCreateCustomer, isStripeEnabled } from '../../lib/stripeService.js';
import {
    getSlotTier,
    getBasePriceDynamic,
    applyDiscount,
    canAccessTier,
    generateTimeSlots,
    getPackageSlots,
    calculateEndTime,
    getSlotDuration,
    fitsInOperatingHours,
    isOperatingDay,
    studioDateTime,
} from '../../utils/pricing.js';
import { BookingStatus, Prisma } from '../../generated/prisma/client.js';
import { getConfig } from '../../lib/businessConfig.js';
import { getErrorMessage } from '../../utils/errors.js';
import { createBookingSchema, bulkBookingSchema, adminCreateBookingSchema } from './validators.js';
import { CouponError, validateCoupon, reserveCouponUse, type CouponQuote } from '../../lib/couponService.js';
import {
    hasBlockedConflict, avulsoContractName, deductCredit, restoreCredit,
    fixoCapReached, fixoCapLockKey, tierNotAllowedBody, SESSION_CHARGE_METADATA, FIXO_EXTRA_METADATA, SESSION_PLAN_TYPES,
} from './booking.service.js';
// O teto do FIXO mora em booking.service.ts (também usado pelo PATCH /:id ao reabrir uma sessão); reexportado
// aqui para quem já importava deste módulo.
export { fixoCapReached, FIXO_CAP_STATUSES } from './booking.service.js';
import { syncContractCompletion } from '../../lib/contractCompletion.js';
import { resolvePixProvider } from '../../lib/pixGateway.js';
import { getProviderForMethod } from '../../lib/paymentGateway.js';

// ─── POST /admin: contrato vinculado (REG-1) ────────────
/** Status em que a equipe agenda num contrato existente: ativo, ou concluído (D6 — a sessão nova o reabre). */
const ADMIN_LINKABLE_CONTRACT_STATUSES: readonly string[] = ['ACTIVE', 'COMPLETED'];
/** Como o status recusado aparece na mensagem ("ele está …"). */
const CONTRACT_STATUS_PHRASE: Record<string, string> = {
    AWAITING_PAYMENT: 'aguardando pagamento',
    EXPIRED: 'expirado',
    CANCELLED: 'cancelado',
    PENDING_CANCELLATION: 'com o cancelamento solicitado',
    PAUSED: 'pausado',
};

/**
 * Sessão vinculada a um contrato que NÃO cobre a gravação, criada sem a baixa manual (REG-1): é cobrada como
 * antes (nasce Reservada, aguardando pagamento) e a resposta diz por quê — o modal da equipe olha só o tipo do
 * contrato e falaria em "coberta pelo plano".
 */
const ADMIN_LINKED_CHARGED_MESSAGE = {
    SERVICO: 'Agendamento criado como Reservado, aguardando pagamento: contrato de serviço não inclui gravação, então a sessão é cobrada.',
    FIXO_LIMIT: 'Agendamento criado como Reservado, aguardando pagamento: o plano fixo já usou todas as sessões, então esta sessão extra é cobrada.',
} as const;

export function registerCreationRoutes(router: Router) {

// ─── POST /api/bookings ─────────────────────────────────
// Autoatendimento: só CLIENTE (crítica S5). A equipe agenda para um cliente pelo POST /admin — uma
// gravação em nome da conta da equipe ficaria órfã (fora de Clientes).

router.post('/', authenticate, requireRole('CLIENTE'), async (req: Request, res: Response) => {
    try {
        const data = createBookingSchema.parse(req.body);
        const userId = req.user!.userId;

        const dateObj = new Date(data.date + 'T00:00:00');
        const dayOfWeek = dateObj.getUTCDay();

        // Validate: minimum advance notice (studio timezone, consistent across server TZs).
        // A equipe usa o POST /admin (só "não no passado"); aqui é sempre o cliente.
        {
            const slotDateTime = studioDateTime(data.date, data.startTime);
            const minAdvanceHours = await getConfig('booking_min_advance_hours');
            const diffHours = (slotDateTime.getTime() - Date.now()) / (1000 * 60 * 60);
            if (diffHours < minAdvanceHours) {
                res.status(400).json({ error: `Não é possível agendar um horário no passado ou com menos de ${minAdvanceHours} horas de antecedência.` });
                return;
            }
        }

        // Validate: operating day
        if (!(await isOperatingDay(dayOfWeek))) {
            res.status(400).json({ error: 'O estúdio não funciona neste dia da semana.' });
            return;
        }

        // Validate: valid slot
        const validSlots = await generateTimeSlots();
        if (!validSlots.includes(data.startTime)) {
            res.status(400).json({ error: `Horário deve ser um dos blocos oficiais: ${validSlots.join(', ')}.` });
            return;
        }

        // Validate: fits in operating hours
        if (!(await fitsInOperatingHours(data.startTime))) {
            res.status(400).json({ error: 'O pacote não cabe dentro do horário de funcionamento.' });
            return;
        }

        // Determine tier of the entry slot
        const slotTier = await getSlotTier(dayOfWeek, data.startTime);
        if (!slotTier) {
            res.status(400).json({ error: 'Horário fora da grade de operação.' });
            return;
        }

        // Calculate price
        let price = await getBasePriceDynamic(slotTier);
        let contractId: string | undefined = data.contractId;

        // If user has a contract, validate tier hierarchy and apply discount
        let contract: Prisma.ContractGetPayload<{ include: { bookings: true } }> | null = null;
        if (contractId) {
            contract = await prisma.contract.findFirst({
                where: {
                    id: contractId,
                    userId,
                    status: 'ACTIVE',
                },
                include: { bookings: true }
            });

            if (!contract) {
                res.status(404).json({ error: 'Contrato não encontrado ou inativo.' });
                return;
            }

            // R3b: contrato de SERVIÇO (Gestão de Redes etc.) não inclui gravação. A tela do cliente nem o
            // oferece, mas por chamada direta a sessão nascia sem cobrança (sem crédito, teto nem Payment).
            if (contract.type === 'SERVICO') {
                res.status(400).json({ error: 'Contrato de serviço não inclui gravação.' });
                return;
            }
            // R4 (ATK-01/FIN-02): o micro-contrato AVULSO é a cobrança de UMA gravação. O crédito que o
            // cancelamento (ou o Não realizado) devolve a ele não vira sessão nova por aqui: a sessão nascia sem
            // hold e sem Payment, e a cobrança original ficava presa à reserva cancelada (gravação de graça). A
            // tela do cliente nem oferece o avulso; remarcar o avulso é pela própria reserva (/:id/reschedule,
            // /:id/makeup). Antes de qualquer trava ou escrita.
            if (contract.type === 'AVULSO') {
                res.status(400).json({ error: 'Gravação avulsa não se agenda pelo contrato. Para remarcar, use a remarcação da própria reserva.' });
                return;
            }

            // Tier hierarchy check
            if (!canAccessTier(contract.tier, slotTier)) {
                res.status(403).json({
                    error: `Seu plano ${contract.tier} não permite agendar horários ${slotTier}.`,
                });
                return;
            }

            // For Flex: check remaining credits (o AVULSO já foi recusado acima)
            if (contract.type === 'FLEX') {
                if (!contract.flexCreditsRemaining || contract.flexCreditsRemaining <= 0) {
                    res.status(400).json({ error: 'Créditos esgotados neste ciclo.' });
                    return;
                }
            } else if (contract.type === 'FIXO') {
                // Teto do plano: a MESMA conta de fixoCapReached (R5 — a sessão EXTRA, criada com o teto cheio, não ocupa).
                // Reconferido sob a trava do contrato antes de criar (A8, abaixo).
                if (await fixoCapReached(contract)) {
                    res.status(400).json({ error: 'Limite de agendamentos do plano fixo atingido.' });
                    return;
                }
            } else if (contract.type === 'CUSTOM') {
                // R3b: as sessões do Personalizado já nascem geradas com o contrato; o cliente só agenda
                // aqui com crédito (sessão pulada). Sem crédito, a sessão saía de graça (nada a descontar).
                if ((contract.customCreditsRemaining ?? 0) <= 0) {
                    res.status(400).json({ error: 'Créditos esgotados neste plano.' });
                    return;
                }
            }

            price = applyDiscount(price, contract.discountPct);
        }

        // Add-ons Calculation.
        // SEMANTICS (intentional, do not "fix" to × sessions): a service added to ONE booking is
        // charged once (×1, with the contract loyalty discount if linked). This differs from a
        // CONTRACT recurring service (lib/contractPricing.computeAddonsCost), which is × sessions/mês
        // because it accompanies every recording of the month. Here it's a single episode = 1 unit.
        let extraDiscountPct = contractId && contract ? contract.discountPct : 0;
        let addonsTotal = 0;
        // A7: numa reserva por PLANO, add-ons NÃO inclusos no contrato são EXTRAS pagos — não podem
        // entrar em booking.price sem cobrança (a UI promete "Pagar Rxxx extras"). Eles viram um Payment
        // PENDING próprio (como POST /:id/addons), ativados só após o pagamento por onPaymentConfirmed.
        // Add-ons já inclusos no plano são grátis e ativados de imediato.
        const paidAddonKeys: string[] = [];
        const freeAddonKeys: string[] = [];
        let paidAddonsCost = 0;

        if (data.addOns && data.addOns.length > 0) {
            const allAddons = await prisma.addOnConfig.findMany({
                where: { key: { in: data.addOns } }
            });
            if (contractId && contract) {
                const included = new Set(contract.addOns || []);
                for (const add of allAddons) {
                    if (included.has(add.key)) {
                        freeAddonKeys.push(add.key);
                    } else {
                        paidAddonKeys.push(add.key);
                        paidAddonsCost += applyDiscount(add.price, extraDiscountPct);
                    }
                }
            } else {
                // Avulso: os extras são cobrados junto com a sessão no MESMO Payment.
                for (const add of allAddons) {
                    addonsTotal += add.price;
                }
                if (addonsTotal > 0) {
                    const discountedAddons = applyDiscount(addonsTotal, extraDiscountPct);
                    price += discountedAddons;
                }
            }
        }

        // Coupon (avulso only — plan-linked bookings have no charge at booking time).
        // Booking.price stays FULL; only the Payment.amount is discounted (reports/retries
        // keep the real session price). Validated here (fail fast, before locks); the
        // atomic reservation happens in the payment-creation transaction below.
        let couponQuote: CouponQuote | null = null;
        if (data.couponCode) {
            if (contractId) {
                res.status(400).json({ error: 'Cupom só está disponível para gravações avulsas.' });
                return;
            }
            couponQuote = await validateCoupon({ code: data.couponCode, userId, baseAmount: price });
        }

        // Duração do pacote da config (slot_duration_hours) — consistente com a disponibilidade.
        const slotDur = await getSlotDuration();
        const packageSlots = getPackageSlots(data.startTime, slotDur);
        const endTime = calculateEndTime(data.startTime, slotDur);

        // Acquire Redis locks for all slots
        const locked = await acquireMultiSlotLock(data.date, packageSlots, userId);
        if (!locked) {
            res.status(409).json({
                error: 'Um ou mais horários já estão sendo reservados por outro cliente. Tente novamente.',
            });
            return;
        }

        // A8: mutex por-contrato para o teto FIXO ser atômico (liberado no fim / no erro).
        let fixoLockKey: string | null = null;
        // B25: se o decremento de crédito (autocommit) for aplicado mas o booking.create falhar depois,
        // o crédito ficaria consumido sem reserva. Rastreamos para COMPENSAR (re-incrementar) no catch.
        let creditDecremented: { contractId: string; field: 'flex' | 'custom' } | null = null;
        let bookingCreatedOk = false;

        try {
            // Check for existing bookings (double-booking at DB level).
            // Exclude: (a) the user's own RESERVED holds (they may retry payment) and
            // (b) ANY expired RESERVED hold (no longer occupies the slot — the cron just
            // hasn't swept it yet). The Redis lock above already guards real races.
            const nowConflict = new Date();
            const conflicting = await prisma.booking.findFirst({
                where: {
                    date: dateObj,
                    status: { not: BookingStatus.CANCELLED },
                    NOT: {
                        OR: [
                            { userId, status: BookingStatus.RESERVED },
                            { status: BookingStatus.RESERVED, holdExpiresAt: { lt: nowConflict } },
                        ],
                    },
                    OR: packageSlots.map(slot => ({
                        startTime: { lte: slot },
                        endTime: { gt: slot },
                    })),
                },
            });

            if (conflicting) {
                await releaseMultiSlotLock(data.date, packageSlots, userId);
                res.status(409).json({ error: 'Horário já reservado. Escolha outro.' });
                return;
            }

            // Revalida bloqueios do admin no momento da reserva (a disponibilidade só os esconde na UI).
            if (await hasBlockedConflict(dateObj, packageSlots)) {
                await releaseMultiSlotLock(data.date, packageSlots, userId);
                res.status(409).json({ error: 'Este horário está bloqueado (indisponível). Escolha outro.' });
                return;
            }

            // Check if user already has a RESERVED booking for this exact slot (PIX→Card switch)
            const existingHold = await prisma.booking.findFirst({
                where: {
                    date: dateObj,
                    userId,
                    startTime: data.startTime,
                    status: BookingStatus.RESERVED,
                },
                include: { contract: true },
            });

            // If user already holds this slot, reuse it instead of creating a new booking
            if (existingHold) {
                await releaseMultiSlotLock(data.date, packageSlots, userId);

                // ATU-02: só o hold do avulso do próprio cliente (holdExpiresAt preenchido) é retomado aqui. Uma
                // reserva SEM prazo — feita pela equipe (que não expira) ou sessão de plano — não ganha um hold de
                // 10 min: a varredura dos holds a promoveria a Confirmada com qualquer parcela paga do contrato,
                // com a cobrança da sessão ainda em aberto. Nada é escrito.
                if (!existingHold.holdExpiresAt) {
                    res.status(409).json({
                        error: 'Você já tem uma reserva neste horário. Se ela tiver cobrança em aberto, pague em Meus pagamentos.',
                        code: 'BOOKING_ALREADY_RESERVED',
                    });
                    return;
                }

                // Find existing pending payment
                const existingPayment = await prisma.payment.findFirst({
                    where: { bookingId: existingHold.id, status: 'PENDING' },
                });

                let clientSecret: string | null = null;
                let paymentId = existingPayment?.id || null;
                // Charge what the pending payment says (coupon discount already baked in);
                // only a hold with NO pending payment falls back to the full booking price.
                let retryAmount = existingPayment?.amount ?? existingHold.price;

                // If switching to CARTAO and no Stripe intent exists, create one
                if (data.paymentMethod === 'CARTAO' && (await isStripeEnabled())) {
                    if (!paymentId) {
                        const payment = await prisma.payment.create({
                            data: {
                                userId,
                                contractId: existingHold.contractId,
                                bookingId: existingHold.id,
                                provider: 'STRIPE',
                                amount: existingHold.price,
                                status: 'PENDING',
                                dueDate: dateObj,
                                installments: data.installments || 1,
                                paymentType: data.paymentType || 'CREDIT',
                            },
                        });
                        paymentId = payment.id;
                        retryAmount = payment.amount;
                    }

                    // pagamentos-10: a cobrança anterior era PIX/CORA → reaproveita o MESMO Payment (nunca um
                    // 2º Payment com o PIX vivo pendurado). O PaymentIntent do cartão é criado em seguida pelo
                    // POST /stripe/create-payment (o checkout sempre chama), que antes APOSENTA o PIX —
                    // concilia (já pago → alreadyPaid) e cancela no provedor (não cancelável → 409).
                    const reuseForCheckout = !!existingPayment && existingPayment.provider !== 'STRIPE';
                    if (!reuseForCheckout) {
                        const customerId = await stripeGetOrCreateCustomer(userId);
                        const piResult = await stripeCreatePaymentIntent({
                            amount: retryAmount,
                            customerId,
                            description: `Avulso ${data.date} ${data.startTime} (retry)`,
                            paymentId: paymentId!,
                            userId,
                            contractId: existingHold.contractId!,
                            installmentsEnabled: (data.installments || 1) > 1,
                        });
                        clientSecret = piResult.clientSecret;

                        await prisma.payment.update({
                            where: { id: paymentId! },
                            data: { providerRef: piResult.paymentIntentId, provider: 'STRIPE' },
                        });
                    }
                }

                // Refresh hold timer — e o prazo do contrato avulso junto (senão a varredura de contratos
                // vencidos apagava a reserva pelo prazo antigo — pagamentos-10).
                const refreshedHold = new Date(Date.now() + 10 * 60 * 1000);
                await prisma.booking.update({
                    where: { id: existingHold.id },
                    data: { holdExpiresAt: refreshedHold },
                });
                if (existingHold.contractId && existingHold.contract?.type === 'AVULSO') {
                    await prisma.contract.updateMany({
                        where: { id: existingHold.contractId, type: 'AVULSO', status: 'AWAITING_PAYMENT' },
                        data: { paymentDeadline: refreshedHold },
                    });
                }

                res.status(200).json({
                    booking: {
                        id: existingHold.id,
                        date: data.date,
                        startTime: existingHold.startTime,
                        endTime: existingHold.endTime,
                        tier: existingHold.tierApplied,
                        tierApplied: existingHold.tierApplied,
                        price: existingHold.price,
                        status: existingHold.status,
                        contractId: existingHold.contractId,
                        holdExpiresAt: refreshedHold.toISOString(),
                    },
                    paymentId,
                    paymentAmount: retryAmount,
                    clientSecret,
                    creditWarning: false,
                    lockExpiresIn: 600,
                    message: 'Reserva existente reutilizada. Complete o pagamento.',
                });
                return;
            }

            // Determine booking status and payment flow
            const isAvulso = !contractId;
            const holdExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

            // A8: serializa reservas FIXO do MESMO contrato para tornar o teto atômico. O slot lock só
            // serializa o MESMO horário — requests concorrentes em horários DIFERENTES liam usedBookings
            // desatualizado e furavam o limite. Mutex por contrato + re-check ao vivo sob o mutex.
            if (contract?.type === 'FIXO') {
                fixoLockKey = fixoCapLockKey(contract.id);
                const gotFixoLock = await acquireMutexBlocking(fixoLockKey, 20);
                if (!gotFixoLock) {
                    fixoLockKey = null;
                    await releaseMultiSlotLock(data.date, packageSlots, userId);
                    res.status(409).json({ error: 'Muitas reservas simultâneas neste contrato. Tente novamente.' });
                    return;
                }
                if (await fixoCapReached(contract)) {
                    await releaseMutex(fixoLockKey); fixoLockKey = null;
                    await releaseMultiSlotLock(data.date, packageSlots, userId);
                    res.status(400).json({ error: 'Limite de agendamentos do plano fixo atingido.' });
                    return;
                }
            }

            // Create Avulso Contract if needed
            let isAvulsoCreated = false;
            let finalContractId = contractId;
            if (!finalContractId) {
                const avulsoStatus = 'AWAITING_PAYMENT';
                const newContract = await prisma.contract.create({
                    data: {
                        userId,
                        name: avulsoContractName(data.date, data.startTime),
                        type: 'AVULSO',
                        tier: slotTier,
                        durationMonths: 1,
                        discountPct: 0,
                        startDate: dateObj,
                        // D6: vigência = o próprio dia da gravação; avulso é pagamento único (FULL).
                        endDate: dateObj,
                        paymentPlan: 'FULL',
                        status: avulsoStatus as any,
                        paymentMethod: data.paymentMethod as any || null,
                        flexCreditsTotal: 1,
                        flexCreditsRemaining: 0, // Consumed immediately
                        paymentDeadline: holdExpiresAt,
                    }
                });
                finalContractId = newContract.id;
                isAvulsoCreated = true;
            } else {
                // Decrement credits based on contract type — VULN-M2 FIX: atomic operation.
                // R3b: o desconto guardado (> 0) decide sozinho, sem pré-filtro pelo saldo relido — se outra reserva
                // zerou o crédito depois da checagem lá de cima, é 400 (concorrência), nunca uma sessão sem desconto.
                const contract = await prisma.contract.findUnique({ where: { id: finalContractId } });
                if (contract?.type === 'FLEX') {
                    const decremented = await prisma.contract.updateMany({
                        where: { id: finalContractId, flexCreditsRemaining: { gt: 0 } },
                        data: { flexCreditsRemaining: { decrement: 1 } },
                    });
                    if (decremented.count === 0) {
                        await releaseMultiSlotLock(data.date, packageSlots, userId);
                        res.status(400).json({ error: 'Créditos esgotados (concorrência). Tente novamente.' });
                        return;
                    }
                    creditDecremented = { contractId: finalContractId, field: 'flex' }; // B25: compensar se o create falhar
                    // Anchor the FLEX weekly clock to the EARLIEST recording — persisted and
                    // only ever lowered on create (never moved forward on cancel), so the
                    // weekly pace can't be reset by cancelling/rebooking.
                    if (contract.type === 'FLEX') {
                        const bDate = new Date(data.date + 'T00:00:00');
                        if (contract.flexCycleStart == null || bDate < contract.flexCycleStart) {
                            await prisma.contract.update({
                                where: { id: finalContractId },
                                data: { flexCycleStart: bDate },
                            });
                        }
                    }
                } else if (contract?.type === 'CUSTOM') {
                    const decremented = await prisma.contract.updateMany({
                        where: { id: finalContractId, customCreditsRemaining: { gt: 0 } },
                        data: { customCreditsRemaining: { decrement: 1 } },
                    });
                    if (decremented.count === 0) {
                        await releaseMultiSlotLock(data.date, packageSlots, userId);
                        res.status(400).json({ error: 'Créditos esgotados (concorrência). Tente novamente.' });
                        return;
                    }
                    creditDecremented = { contractId: finalContractId, field: 'custom' }; // B25: compensar se o create falhar
                }
            }

            // Avulso: RESERVED with 10-min hold timer (payment required). Plan-based: RESERVED (no timer).
            const bookingStatus = BookingStatus.RESERVED;

            // Create booking
            const booking = await prisma.booking.create({
                data: {
                    userId,
                    contractId: finalContractId,
                    date: dateObj,
                    startTime: data.startTime,
                    endTime,
                    status: bookingStatus,
                    tierApplied: slotTier,
                    price,
                    // Plano: só os add-ons inclusos entram já ativados; os extras pagos são ativados
                    // após o pagamento (onPaymentConfirmed). Avulso: tudo (cobrado no mesmo Payment).
                    addOns: isAvulso ? (data.addOns || []) : freeAddonKeys,
                    holdExpiresAt: isAvulso ? holdExpiresAt : null,
                },
            });

            bookingCreatedOk = true; // B25: create OK — o crédito consumido está agora atrelado a uma reserva.

            // A8: teto FIXO já garantido pela criação sob o mutex — pode liberar o mutex do contrato.
            if (fixoLockKey) { await releaseMutex(fixoLockKey); fixoLockKey = null; }

            // Create payment record for ALL avulso bookings
            let clientSecret: string | null = null;
            let createdPaymentId: string | null = null;
            let createdPaymentAmount: number | null = null;
            // pixString/qrCodeBase64 are intentionally always null here: for avulso PIX the
            // client immediately calls POST /stripe/create-payment, which is the single source
            // of truth for PIX generation (and surfaces Cora errors as a 400). See the PIX note
            // below for why we no longer generate the invoice inline.
            const pixString: string | null = null;
            const qrCodeBase64: string | null = null;
            if (isAvulso) {
                const chargeAmount = couponQuote ? couponQuote.finalAmount : price;
                try {
                    // Create pending Payment record + reserve the coupon use in the SAME
                    // transaction (atomic maxUses guard).
                    const payment = await prisma.$transaction(async (tx) => {
                        const p = await tx.payment.create({
                            data: {
                                userId,
                                contractId: finalContractId,
                                bookingId: booking.id,
                                provider: data.paymentMethod === 'CARTAO' ? 'STRIPE' : 'CORA',
                                amount: chargeAmount,
                                status: 'PENDING',
                                dueDate: dateObj,
                                installments: data.installments || 1,
                                paymentType: data.paymentType || (data.paymentMethod === 'CARTAO' ? 'CREDIT' : null),
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
                                originalAmount: price,
                                discountAmount: couponQuote.discountAmount,
                                maxUsesPerUser: couponQuote.coupon.maxUsesPerUser,
                            });
                        }
                        return p;
                    });
                    createdPaymentId = payment.id;
                    createdPaymentAmount = chargeAmount;

                    // 100% coupon → zero charge: skip the gateway and confirm right away
                    // (confirms the booking + activates the avulso contract like a webhook).
                    if (chargeAmount === 0) {
                        await prisma.payment.updateMany({
                            where: { id: payment.id, status: 'PENDING' },
                            data: { status: 'PAID', paidAt: new Date() },
                        });
                        const { onPaymentConfirmed } = await import('../../lib/paymentEffects.js');
                        await onPaymentConfirmed(payment.id);
                        res.status(201).json({
                            booking: {
                                id: booking.id,
                                date: data.date,
                                startTime: booking.startTime,
                                endTime: booking.endTime,
                                tier: booking.tierApplied,
                                tierApplied: booking.tierApplied,
                                price: booking.price,
                                status: 'CONFIRMED',
                                contractId: booking.contractId,
                                holdExpiresAt: null,
                            },
                            paymentId: payment.id,
                            paymentAmount: 0,
                            couponDiscount: couponQuote?.discountAmount,
                            alreadyPaid: true,
                            clientSecret: null,
                            creditWarning: false,
                            lockExpiresIn: 0,
                            message: 'Cupom aplicado — gravação confirmada sem cobrança!',
                        });
                        return;
                    }

                    // For Card: create Stripe PaymentIntent
                    if (data.paymentMethod === 'CARTAO' && (await isStripeEnabled())) {
                        const customerId = await stripeGetOrCreateCustomer(userId);
                        const addOnDesc = data.addOns && data.addOns.length > 0 ? ` + ${data.addOns.length} extras` : '';
                        const piResult = await stripeCreatePaymentIntent({
                            amount: chargeAmount,
                            customerId,
                            description: `Avulso ${data.date} ${data.startTime}${addOnDesc}`,
                            paymentId: payment.id,
                            userId,
                            contractId: finalContractId!,
                            installmentsEnabled: (data.installments || 1) > 1,
                        });
                        clientSecret = piResult.clientSecret;

                        await prisma.payment.update({
                            where: { id: payment.id },
                            data: { providerRef: piResult.paymentIntentId },
                        });
                    }

                    // For PIX we deliberately do NOT generate the Cora invoice here. The client
                    // always calls POST /stripe/create-payment next, which is the single source of
                    // truth for PIX generation and surfaces Cora errors to the user as a 400.
                    // Generating it here as well created a second, orphaned Cora invoice AND (worse)
                    // swallowed transient failures silently — the response returned 201 with a null
                    // pixString that no caller reads. The payment row is left as CORA/PENDING and is
                    // enriched with providerRef + pixString by that call.
                } catch (payErr: unknown) {
                    if (payErr instanceof CouponError) {
                        // Lost the maxUses race between validate and reserve. Don't strand the
                        // booking — surface the coupon error so the client re-decides (the hold
                        // stays for 10 min; retrying without/with another coupon reuses it).
                        await releaseMultiSlotLock(data.date, packageSlots, userId);
                        res.status(payErr.httpStatus).json({ error: payErr.message, code: payErr.code });
                        return;
                    }
                    console.error('[BOOKING] Payment creation failed:', getErrorMessage(payErr));
                    // Still return the booking — client can retry payment
                }
            }

            // A7: reserva por PLANO com serviços extras PAGOS (não inclusos no contrato) → cria um
            // Payment PENDING para os extras, ativados após o pagamento por onPaymentConfirmed
            // (mesma máquina de POST /:id/addons). Sem isto os extras eram entregues sem cobrança.
            if (!isAvulso && paidAddonKeys.length > 0) {
                try {
                    const extrasPayment = await prisma.payment.create({
                        data: {
                            userId,
                            contractId: finalContractId,
                            bookingId: booking.id,
                            provider: data.paymentMethod === 'CARTAO' ? 'STRIPE' : 'CORA',
                            amount: paidAddonsCost,
                            status: 'PENDING',
                            dueDate: dateObj,
                            installments: 1,
                            // Chaves dos extras pagos p/ ativação pós-pagamento (formato de POST /:id/addons).
                            paymentUrl: JSON.stringify({ addonKeys: paidAddonKeys }),
                        },
                    });
                    createdPaymentId = extrasPayment.id;
                    createdPaymentAmount = paidAddonsCost;

                    if (data.paymentMethod === 'CARTAO' && (await isStripeEnabled())) {
                        const customerId = await stripeGetOrCreateCustomer(userId);
                        const piResult = await stripeCreatePaymentIntent({
                            amount: paidAddonsCost,
                            customerId,
                            description: `Serviços extras (${paidAddonKeys.length}) — ${data.date} ${data.startTime}`,
                            paymentId: extrasPayment.id,
                            userId,
                            contractId: finalContractId!,
                            installmentsEnabled: false,
                        });
                        clientSecret = piResult.clientSecret;
                        await prisma.payment.update({ where: { id: extrasPayment.id }, data: { providerRef: piResult.paymentIntentId } });
                    }
                    // PIX: a cobrança é gerada por POST /stripe/create-payment (fonte única), como no avulso.
                } catch (extraErr) {
                    console.error('[BOOKING] Extra-addon payment creation failed:', getErrorMessage(extraErr));
                    // Não estraga a reserva; o cliente pode gerar a cobrança dos extras depois.
                }
            }

            res.status(201).json({
                booking: {
                    id: booking.id,
                    date: data.date,
                    startTime: booking.startTime,
                    endTime: booking.endTime,
                    tier: booking.tierApplied,
                    tierApplied: booking.tierApplied,
                    price: booking.price,
                    status: booking.status,
                    contractId: booking.contractId,
                    holdExpiresAt: booking.holdExpiresAt?.toISOString() || null,
                },
                paymentId: createdPaymentId,
                ...(createdPaymentId ? {
                    paymentAmount: createdPaymentAmount ?? price,
                    ...(couponQuote ? { couponDiscount: couponQuote.discountAmount } : {}),
                } : {}),
                clientSecret,
                // PIX QR is generated by POST /stripe/create-payment, not here — so no
                // pixString/qrCodeBase64 in this response (nothing reads them from create).
                creditWarning: isAvulsoCreated,
                lockExpiresIn: 600, // 10 minutes
                message: isAvulso
                    ? 'Horário reservado por 10 minutos. Complete o pagamento para confirmar.'
                    : (paidAddonKeys.length > 0
                        ? 'Horário reservado! Conclua o pagamento dos serviços extras para ativá-los.'
                        : 'Horário reservado com sucesso!'),
            });
        } catch (err) {
            // Release locks on error
            await releaseMultiSlotLock(data.date, packageSlots, userId);
            if (fixoLockKey) { await releaseMutex(fixoLockKey).catch(() => {}); }
            // B25: compensar o crédito debitado se a reserva NÃO chegou a ser criada (senão o crédito
            // pago ficaria consumido sem nenhum booking, sem cron que o devolva).
            if (creditDecremented && !bookingCreatedOk) {
                const field = creditDecremented.field === 'flex' ? 'flexCreditsRemaining' : 'customCreditsRemaining';
                await prisma.contract.update({
                    where: { id: creditDecremented.contractId },
                    data: { [field]: { increment: 1 } },
                }).catch((e) => console.error('[BOOKING] Falha ao compensar crédito após erro de criação:', e));
            }
            throw err;
        }
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        if (err instanceof CouponError) {
            res.status(err.httpStatus).json({ error: err.message, code: err.code });
            return;
        }
        res.status(500).json({ error: 'Erro interno ao criar agendamento' });
    }
});

// ─── POST /api/bookings/bulk ────────────────────────────

// Autoatendimento (marcação em lote do FLEX do próprio cliente): só CLIENTE (crítica S5).
router.post('/bulk', authenticate, requireRole('CLIENTE'), async (req: Request, res: Response) => {
    try {
        const data = bulkBookingSchema.parse(req.body);
        const userId = req.user!.userId;

        const contract = await prisma.contract.findFirst({
            where: { id: data.contractId, userId, status: 'ACTIVE' }
        });

        if (!contract) {
            res.status(404).json({ error: 'Contrato não encontrado ou inativo.' });
            return;
        }
        if (contract.type !== 'FLEX') {
            res.status(400).json({ error: 'Apenas contratos Flex suportam marcação em lote.' });
            return;
        }
        if ((contract.flexCreditsRemaining || 0) < data.slots.length) {
            res.status(400).json({ error: `Saldo insuficiente. Selecionados: ${data.slots.length}, Disponíveis: ${contract.flexCreditsRemaining}` });
            return;
        }

        const validBookings: Prisma.BookingCreateManyInput[] = [];
        const locksAcquired: { date: string; slots: string[] }[] = [];
        const bulkMinHours = await getConfig('booking_min_advance_hours');
        const bulkSlotDur = await getSlotDuration(); // duração do pacote da config (consistente c/ disponibilidade)

        try {
            for (const slot of data.slots) {
                const dateObj = new Date(slot.date + 'T00:00:00');
                const dayOfWeek = dateObj.getUTCDay();

                // Validate: minimum advance notice (studio timezone). Rota só do cliente (sem exceção).
                {
                    const slotDateTime = studioDateTime(slot.date, slot.startTime);
                    const diffHours = (slotDateTime.getTime() - Date.now()) / (1000 * 60 * 60);
                    if (diffHours < bulkMinHours) {
                        throw new Error(`Não é possível agendar o horário ${slot.startTime} no dia ${slot.date} (antecedência mínima de ${bulkMinHours} horas não respeitada).`);
                    }
                }

                const slotTier = await getSlotTier(dayOfWeek, slot.startTime);
                if (!slotTier) throw new Error(`Horário inválido: ${slot.startTime} em ${slot.date}`);

                if (!canAccessTier(contract.tier, slotTier)) {
                    throw new Error(`Seu plano ${contract.tier} não engloba o horário ${slot.startTime} (${slotTier}).`);
                }

                const packageSlots = getPackageSlots(slot.startTime, bulkSlotDur);
                const endTime = calculateEndTime(slot.startTime, bulkSlotDur);

                const locked = await acquireMultiSlotLock(slot.date, packageSlots, userId);
                if (!locked) throw new Error(`Horário ${slot.startTime} no dia ${slot.date} já está sendo reservado. Tente novamente.`);
                locksAcquired.push({ date: slot.date, slots: packageSlots });

                const conflicting = await prisma.booking.findFirst({
                    where: {
                        date: dateObj, status: { not: BookingStatus.CANCELLED },
                        OR: packageSlots.map(s => ({ startTime: { lte: s }, endTime: { gt: s } }))
                    }
                });
                if (conflicting) throw new Error(`Conflito na grade para o dia ${slot.date} às ${slot.startTime}.`);
                if (await hasBlockedConflict(dateObj, packageSlots)) throw new Error(`O dia ${slot.date} às ${slot.startTime} está bloqueado (indisponível).`);

                let price = applyDiscount(await getBasePriceDynamic(slotTier), contract.discountPct);

                validBookings.push({
                    userId, contractId: contract.id, date: dateObj, startTime: slot.startTime, endTime,
                    status: BookingStatus.CONFIRMED, tierApplied: slotTier, price,
                    addOns: contract.addOns ? contract.addOns.filter(a => a !== 'GESTAO_SOCIAL') : []
                });
            }

            // FIX (C6): decremento ATÔMICO guardado (evita lost update entre /bulk concorrentes que
            // furava o saldo de créditos). O guard gte re-avaliado pelo banco no commit; se outra
            // transação consumiu os créditos, count===0 → throw → rollback (nenhum booking criado).
            await prisma.$transaction(async (tx) => {
                const dec = await tx.contract.updateMany({
                    where: { id: contract.id, flexCreditsRemaining: { gte: validBookings.length } },
                    data: { flexCreditsRemaining: { decrement: validBookings.length } },
                });
                if (dec.count === 0) {
                    throw new Error('Saldo de créditos insuficiente (outra reserva consumiu os créditos). Tente novamente.');
                }
                await tx.booking.createMany({ data: validBookings });
            });

            res.status(201).json({ message: `${validBookings.length} gravações agendadas com sucesso!` });
        } catch (err: unknown) {
            res.status(400).json({ error: getErrorMessage(err) });
            return;
        } finally {
            for (const l of locksAcquired) {
                await releaseMultiSlotLock(l.date, l.slots, userId);
            }
        }
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Erro interno ao salvar lote.' });
    }
});

// ─── POST /api/bookings/admin (equipe cria para um cliente) ─────
// Permissão: agendamentos.criar. Sem `cobrancas.baixa` nada criado aqui nasce PAGO (DECISÕES D3/D7 —
// "nasce aguardando pagamento"):
//   • "Confirmado" vira RESERVED com o pagamento PENDING (não é 403; a resposta traz `downgraded`);
//   • customPrice diferente do preço padrão da faixa (inclusive 0) → 403 cobrancas.baixa;
//   • valor final zero (cupom 100%), que seria liquidado como PAGO → 403 cobrancas.baixa;
//   • sessão de PLANO (FIXO/FLEX/Personalizado, ativo ou concluído, e no FIXO dentro do teto) sem a baixa: o
//     plano já cobre a sessão — nenhuma cobrança do valor da sessão; só os serviços extras viram cobrança
//     PENDING (REG-1, igual ao POST / do cliente). Contrato de SERVIÇO, avulso e FIXO com o teto já usado não
//     cobrem a sessão: ela é cobrada como antes — e essa cobrança da SESSÃO leva metadata.sessionCharge (R4:
//     o /confirm do cliente exige o pagamento dela; o PATCH de faixa a distingue da sessão de plano);
//   • essa sessão de plano (coberta, sem a baixa) num horário de faixa que o plano não cobre
//     (canAccessTier false) → 403 TIER_NOT_ALLOWED (R3b), antes de crédito ou escrita;
//   • boleto (emitido no banco na hora) → 403 cobrancas.cobrar (lib/permissionRules).
// Contrato vinculado fora de ACTIVE/COMPLETED (cancelado, expirado, aguardando pagamento, pausado, com o
// cancelamento solicitado) → 400 CONTRACT_NOT_ACTIVE para todos, como o POST / do cliente.
// Sessão de plano FLEX ou Personalizado consome 1 crédito na criação, como no POST / do cliente (DIN-01):
// o cancelamento pela equipe devolve esse crédito — sem o desconto aqui, cancelar criava crédito do nada.
// O RESERVED criado aqui NÃO expira como o hold de 10 min do cliente: não grava holdExpiresAt e o
// micro-contrato avulso nasce ACTIVE (o cleanExpiredHolds só varre holdExpiresAt / AWAITING_PAYMENT).

router.post('/admin', authenticate, requirePermission('agendamentos.criar'), async (req: Request, res: Response) => {
    try {
        const data = adminCreateBookingSchema.parse(req.body);
        const actor = await actorOrReply(req, res);
        if (!actor) return;
        const canMarkPaid = can(actor, 'cobrancas.baixa');
        const dateObj = new Date(data.date + 'T00:00:00');
        const dayOfWeek = dateObj.getUTCDay();

        // O alvo é sempre um CLIENTE (S5): gravação em nome de uma conta da equipe ficaria órfã (some de
        // Clientes). Conta inexistente ou da equipe → 404, sem revelar qual.
        // D3: cliente EXCLUÍDO (soft delete/anonimizado) não ganha gravação nem cobrança nova — o
        // seletor do modal já o esconde; a trava real é aqui (lista aberta/antiga, chamada direta).
        const targetClient = await prisma.user.findUnique({ where: { id: data.userId }, select: { deletedAt: true, role: true } });
        if (!targetClient || targetClient.role !== 'CLIENTE') {
            res.status(404).json({ error: 'Cliente não encontrado.' });
            return;
        }
        if (targetClient.deletedAt) {
            res.status(409).json({ error: 'Este cliente foi excluído.', code: 'CLIENT_DELETED' });
            return;
        }

        // O admin NÃO pode agendar em data/horário que já passou (fuso do estúdio). O caminho do
        // cliente (POST /) já bloqueia o passado, mas dispensa o admin (linha ~41); o /admin não
        // tinha nenhuma checagem, então dava para criar reservas retroativas. `min` no <input> do
        // front não cobre nem horário passado no mesmo dia nem data digitada — a trava real é aqui.
        const adminSlotStart = studioDateTime(data.date, data.startTime);
        if (Number.isNaN(adminSlotStart.getTime()) || adminSlotStart.getTime() < Date.now()) {
            res.status(400).json({ error: 'Não é possível agendar em uma data ou horário que já passou.' });
            return;
        }

        if (!(await isOperatingDay(dayOfWeek))) {
            res.status(400).json({ error: 'O estúdio não funciona neste dia da semana.' });
            return;
        }

        if (!(await fitsInOperatingHours(data.startTime))) {
            res.status(400).json({ error: 'O pacote não cabe dentro do horário de funcionamento.' });
            return;
        }

        const slotTier = await getSlotTier(dayOfWeek, data.startTime);
        if (!slotTier) {
            res.status(400).json({ error: 'Horário fora da grade de operação.' });
            return;
        }

        const adminSlotDur = await getSlotDuration();
        const endTime = calculateEndTime(data.startTime, adminSlotDur);
        const basePrice = await getBasePriceDynamic(slotTier);

        // Resolve the linked contract once — used for the base discount AND the add-on
        // discount inheritance below (avulso ⇒ no contract ⇒ 0%).
        const linkedContract = data.contractId
            ? await prisma.contract.findUnique({ where: { id: data.contractId } })
            : null;
        // O plano informado precisa ser DESTE cliente: senão o desconto de fidelidade de outro cliente
        // entraria no preço (e a sessão ficaria pendurada num contrato alheio).
        if (data.contractId && (!linkedContract || linkedContract.userId !== data.userId)) {
            res.status(404).json({ error: 'Contrato não encontrado para este cliente.' });
            return;
        }
        // REG-1: só se agenda num contrato ATIVO ou CONCLUÍDO (D6: a sessão nova reabre o concluído — é o que o
        // seletor do modal oferece). Fora disso → 400 para todos, inclusive o ADMIN, antes de qualquer crédito,
        // cobrança ou escrita (como o POST / do cliente, que só aceita ACTIVE). Antes, a sessão ia para um plano
        // sem parcela viva (sem a baixa, de graça) e, num FLEX cancelado, ainda comia o crédito que sobrou.
        if (linkedContract && !ADMIN_LINKABLE_CONTRACT_STATUSES.includes(linkedContract.status)) {
            res.status(400).json({
                error: `Não é possível agendar neste contrato: ele está ${CONTRACT_STATUS_PHRASE[linkedContract.status] ?? 'inativo'}. Escolha um contrato ativo ou agende como avulso.`,
                code: 'CONTRACT_NOT_ACTIVE',
            });
            return;
        }
        const contractDiscountPct = linkedContract?.discountPct || 0;

        // Permissões que dependem do corpo (lib/permissionRules): customPrice ≠ preço padrão exige
        // cobrancas.baixa; sem ela, "Confirmado" é rebaixado para RESERVED (pagamento PENDING).
        // Preço padrão = o que o servidor usaria sem customPrice (faixa; com plano, já com o desconto).
        const standardPrice = linkedContract ? applyDiscount(basePrice, contractDiscountPct) : basePrice;
        const createPlan = requiredForAdminBookingCreate(data, { standardPrice, canMarkPaid });
        if (!(await enforceRuleResult(req, res, createPlan))) return;
        const bookingStatus = createPlan.status;

        // E3: boleto só com a chave-mestra "Aceitar pagamento por boleto" ligada E a Cora habilitada
        // (fonte única getBoletoStatus) — recusa ANTES de criar o agendamento. Fica DEPOIS da permissão
        // (boleto exige cobrancas.cobrar): quem não pode cobrar recebe o 403, não o estado da integração.
        if (data.paymentMethod === 'BOLETO') {
            const { getBoletoStatus } = await import('../../lib/paymentGateway.js');
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

        // REG-1: sessão de PLANO criada por quem não tem a baixa manual. Nasce RESERVED (D7: nada é registrado
        // como pago), mas o valor da sessão NÃO vira cobrança — as parcelas do plano já o cobrem. Só os serviços
        // extras (com o desconto do plano) viram uma cobrança PENDING, como no POST / do cliente; sem extras,
        // nenhum Payment. Plano = FIXO, FLEX ou Personalizado (ativo ou concluído — conferido acima). NÃO cobrem
        // a sessão, que então é cobrada como antes (PENDING do valor da sessão, com o desconto do contrato):
        //   • o avulso e o contrato de SERVIÇO (Gestão de Redes etc. — não inclui gravação);
        //   • o FIXO com o teto (meses × sessões/mês) já usado — a sessão é EXTRA (o POST / do cliente recusa
        //     com "Limite atingido"; a equipe agenda, mas cobrando). Reconferido sob a trava do contrato abaixo.
        // FLEX e Personalizado são limitados pelo crédito (NO_CREDITS, abaixo). Quem tem a baixa (e o ADMIN)
        // segue como antes (Confirmado grava PAID; Reservado grava PENDING do valor da sessão).
        // ATU5-02/TELA5-02 (conserto 5): o teto do FIXO é conferido para TODOS. A sessão criada com o teto já cheio é
        // a EXTRA (marca fixoExtra, abaixo): não ocupa vaga do plano. A sessão que quem tem a baixa cria DENTRO do teto
        // continua cobrada (comportamento antigo), mas OCUPA a vaga — sem a conferência, o "Confirmado" (PAID sem
        // dinheiro) deixava a vaga livre para o cliente agendar de graça e o plano nunca concluía.
        const isPlanContract = !!linkedContract && SESSION_PLAN_TYPES.includes(linkedContract.type);
        const isFixoLinked = !!linkedContract && linkedContract.type === 'FIXO';
        const fixoOverCap = isFixoLinked && await fixoCapReached(linkedContract!);
        const planCovered = isPlanContract && !canMarkPaid && !fixoOverCap;
        // R3b: a sessão coberta pelo plano só vale na faixa que o plano paga (a mesma hierarquia do POST / do
        // cliente: canAccessTier). Sem a baixa, um horário de faixa acima do plano sairia de graça (e, no
        // FLEX/Personalizado, comendo um crédito da faixa de baixo) → 403 antes de crédito, trava ou escrita.
        // Quem tem a baixa (e o ADMIN) segue como antes: a sessão é cobrada pelo preço da faixa do horário.
        // O FIXO com o teto usado não entra aqui: a sessão extra já é cobrada pelo preço da faixa do horário.
        if (planCovered && !canAccessTier(linkedContract!.tier, slotTier)) {
            res.status(403).json(tierNotAllowedBody(linkedContract!.tier, slotTier));
            return;
        }
        // Vinculada a um contrato que não cobre a sessão, sem a baixa → a resposta explica a cobrança.
        const chargedReason: keyof typeof ADMIN_LINKED_CHARGED_MESSAGE | null = !canMarkPaid && linkedContract
            ? (linkedContract.type === 'SERVICO' ? 'SERVICO' : fixoOverCap ? 'FIXO_LIMIT' : null)
            : null;

        let price: number;
        if (data.customPrice != null) {
            // Admin explicitly set a custom price (base only — services are added below)
            price = data.customPrice;
        } else if (linkedContract) {
            // Contract-based: per-episode price = basePrice with the loyalty discount applied
            price = applyDiscount(basePrice, contractDiscountPct);
        } else {
            // Avulso: full tier price
            price = basePrice;
        }

        let addonsTotal = 0;
        let addonsCharge = 0; // serviços com o desconto do plano (avulso = 0%)
        if (data.addOns && data.addOns.length > 0) {
            const allAddons = await prisma.addOnConfig.findMany({
                where: { key: { in: data.addOns } }
            });
            for (const add of allAddons) {
                addonsTotal += add.price;
            }
            // Services inherit the contract loyalty discount (avulso = 0%), matching the client path.
            addonsCharge = applyDiscount(addonsTotal, contractDiscountPct);
            price += addonsCharge;
        }

        // Coupon (admin applies on behalf of the client — eligibility is the CLIENT's).
        // Same avulso-only rule as the client path: plan-linked bookings have no charge.
        let adminCouponQuote: CouponQuote | null = null;
        if (data.couponCode) {
            if (data.contractId) {
                res.status(400).json({ error: 'Cupom só está disponível para gravações avulsas.' });
                return;
            }
            adminCouponQuote = await validateCoupon({ code: data.couponCode, userId: data.userId, baseAmount: price });
        }

        // Valor final zero (cupom 100% / preço zerado) é liquidado como PAGO na hora (abaixo) — e nada
        // criado por quem não tem a baixa manual nasce pago (D7). Recusa ANTES de gravar qualquer coisa.
        // A sessão de plano sem a baixa (REG-1) não passa por aqui: ela nunca grava cobrança da sessão nem
        // liquida nada como PAGO (só os extras, PENDING, quando houver).
        const finalChargeAmount = adminCouponQuote ? adminCouponQuote.finalAmount : price;
        // Valor da cobrança desta gravação: sessão de plano sem a baixa → só os extras (0 = nenhuma cobrança).
        const adminChargeAmount = planCovered ? addonsCharge : finalChargeAmount;
        if (finalChargeAmount <= 0 && !canMarkPaid && !planCovered) {
            res.status(403).json({
                error: 'Este agendamento ficaria com valor zero e seria registrado como pago — isso exige a permissão “Marcar como pago, anular ou estornar”.',
                code: 'PERMISSION_DENIED',
                permission: 'cobrancas.baixa',
            });
            return;
        }

        // Check for conflicts. FIX (B3): tranca o slot durante a checagem+escrita (mesmo lock do
        // POST /) para evitar TOCTOU/double-booking entre admin-create e reserva de cliente concorrentes.
        // O lock tem TTL, então um erro entre acquire e o release final se auto-cura.
        const packageSlots = getPackageSlots(data.startTime, adminSlotDur);
        const adminLockOwner = req.user!.userId;
        const adminLocked = await acquireMultiSlotLock(data.date, packageSlots, adminLockOwner);
        if (!adminLocked) {
            res.status(409).json({ error: 'Este horário está sendo reservado. Tente novamente em instantes.' });
            return;
        }
        const conflicting = await prisma.booking.findFirst({
            where: {
                date: dateObj,
                status: { not: BookingStatus.CANCELLED },
                OR: packageSlots.map(slot => ({
                    startTime: { lte: slot },
                    endTime: { gt: slot },
                })),
            },
        });

        if (conflicting) {
            await releaseMultiSlotLock(data.date, packageSlots, adminLockOwner);
            res.status(409).json({ error: 'Horário já reservado.' });
            return;
        }

        // Não agendar por cima de um horário bloqueado (manutenção). Se for intencional, remova o bloqueio antes.
        if (await hasBlockedConflict(dateObj, packageSlots)) {
            await releaseMultiSlotLock(data.date, packageSlots, adminLockOwner);
            res.status(409).json({ error: 'Este horário está bloqueado. Remova o bloqueio antes de agendar aqui.' });
            return;
        }

        // REG-1: o teto do FIXO "coberto pelo plano" é reconferido sob a mesma trava por contrato do POST / do
        // cliente (A8): duas criações concorrentes no último lugar do plano não saem as duas sem cobrança. Se o
        // teto encheu entre a conta lá de cima e agora → 409; ao tentar de novo, a sessão sai cobrada como extra.
        // ATU5-02: a sessão FIXO cobrada por quem tem a baixa também passa pela trava — a marca fixoExtra (EXTRA, fora
        // do teto) é decidida com o teto relido aqui, e a reserva é gravada antes de a trava ser solta. Sem a baixa, a
        // sessão cobrada acima do teto segue extra (a decisão lá de cima, a mesma da mensagem e do valor).
        let fixoLockKey: string | null = null;
        let fixoExtra = fixoOverCap;
        if (isFixoLinked) {
            fixoLockKey = fixoCapLockKey(linkedContract!.id);
            if (!(await acquireMutexBlocking(fixoLockKey, 20))) {
                await releaseMultiSlotLock(data.date, packageSlots, adminLockOwner);
                res.status(409).json({ error: 'Muitas reservas simultâneas neste contrato. Tente novamente.' });
                return;
            }
            const capReachedNow = await fixoCapReached(linkedContract!);
            if (planCovered && capReachedNow) {
                await releaseMutex(fixoLockKey);
                await releaseMultiSlotLock(data.date, packageSlots, adminLockOwner);
                res.status(409).json({
                    error: 'O plano fixo acabou de usar todas as sessões. Tente de novo: esta sessão passa a ser cobrada como extra.',
                    code: 'FIXO_LIMIT_REACHED',
                });
                return;
            }
            if (canMarkPaid) fixoExtra = capReachedNow;
        }

        // DIN-01: sessão de plano FLEX ou Personalizado consome 1 crédito, como no POST / do cliente
        // (decremento atômico guardado por > 0, com o horário ainda trancado). O cancelamento devolve esse
        // crédito (DELETE /:id → restoreCredit); sem o desconto aqui, criar e cancelar gerava crédito do nada.
        // No FLEX o cron (flexCreditExpiryJob) já conta esta sessão como consumo — o desconto só antecipa o
        // saldo canônico, nunca desconta em dobro. FIXO e avulso não têm crédito a descontar.
        let creditDeducted = false;
        if (linkedContract && (linkedContract.type === 'FLEX' || linkedContract.type === 'CUSTOM')) {
            if (!(await deductCredit(linkedContract.id))) {
                await releaseMultiSlotLock(data.date, packageSlots, adminLockOwner);
                res.status(400).json({ error: 'Créditos esgotados neste plano.', code: 'NO_CREDITS' });
                return;
            }
            creditDeducted = true;
        }

        let finalContractId = data.contractId;
        let contract = linkedContract; // reuse the fetch from the pricing block above

        if (!finalContractId) {
            const newContract = await prisma.contract.create({
                data: {
                    userId: data.userId,
                    name: avulsoContractName(data.date, data.startTime),
                    type: 'AVULSO',
                    tier: slotTier,
                    durationMonths: 1,
                    discountPct: 0,
                    startDate: dateObj,
                    // D6: vigência = o próprio dia da gravação; avulso é pagamento único (FULL).
                    endDate: dateObj,
                    paymentPlan: 'FULL',
                    status: 'ACTIVE',
                    // Forma de pagamento escolhida pelo admin (default CARTAO do schema) — o detalhe do
                    // contrato mostrava "Forma de pagamento: —" (a parcela tinha PIX/Cartão).
                    paymentMethod: data.paymentMethod,
                    flexCreditsTotal: 1,
                    flexCreditsRemaining: 0,
                }
            });
            finalContractId = newContract.id;
        }

        let booking;
        try {
            booking = await prisma.booking.create({
                data: {
                    userId: data.userId,
                    contractId: finalContractId,
                    date: dateObj,
                    startTime: data.startTime,
                    endTime,
                    // Status já decidido pela regra de permissão (CONFIRMED só com cobrancas.baixa).
                    status: bookingStatus === 'CONFIRMED' ? BookingStatus.CONFIRMED : BookingStatus.RESERVED,
                    tierApplied: slotTier,
                    price,
                    addOns: contract ? Array.from(new Set([...(contract.addOns || []).filter(a => a !== 'GESTAO_SOCIAL'), ...(data.addOns || [])])) : (data.addOns || []),
                    ...(data.adminNotes ? { adminNotes: data.adminNotes } : {}),
                },
            });
        } catch (createErr) {
            // B25 (como no POST /): o crédito descontado acima não pode ficar consumido sem a gravação.
            if (creditDeducted && data.contractId) {
                await restoreCredit(data.contractId).catch((e) => console.error('[ADMIN-BOOKING] Falha ao devolver o crédito após erro de criação:', e));
            }
            if (fixoLockKey) await releaseMutex(fixoLockKey);
            await releaseMultiSlotLock(data.date, packageSlots, adminLockOwner);
            throw createErr;
        }

        // Slot já ocupado pela linha do booking — pode liberar o lock (o resto é pagamento/notif). O teto do FIXO
        // também já está garantido pela linha criada sob a trava do contrato.
        if (fixoLockKey) await releaseMutex(fixoLockKey);
        await releaseMultiSlotLock(data.date, packageSlots, adminLockOwner);

        // D6: nova sessão num contrato existente reabre um contrato "Concluído" (volta a ACTIVE).
        if (data.contractId) {
            await syncContractCompletion(data.contractId, req.user!.userId);
        }

        // Create Payment record for admin bookings (visible in financial reports)
        let createdPaymentId: string | null = null;
        let boletoUrl: string | null = null;
        let barcode: string | null = null;
        let boletoError: string | null = null;
        // REG-1: sessão de plano criada sem a baixa e SEM serviços extras → nenhum Payment (o plano já
        // cobre a sessão; nada "aguardando pagamento" para o cliente nem na lista de vencidas).
        if (!planCovered || adminChargeAmount > 0) {
            try {
                // PIX é dinâmico (Sicoob ou Cora, conforme o admin habilitou) — não mais 'CORA' fixo: o
                // provider decide a taxa de gateway versionada e a conciliação. Boleto é sempre Cora.
                const paymentProvider = data.paymentMethod === 'BOLETO'
                    ? 'CORA'
                    : (data.paymentMethod === 'PIX'
                        ? ((await resolvePixProvider()) ?? getProviderForMethod('PIX'))
                        : 'STRIPE');
                const paymentRecord = await prisma.$transaction(async (tx) => {
                    const p = await tx.payment.create({
                        data: {
                            userId: data.userId,
                            contractId: finalContractId,
                            bookingId: booking.id,
                            provider: paymentProvider as any,
                            amount: adminChargeAmount,
                            status: bookingStatus === 'CONFIRMED' ? 'PAID' : 'PENDING',
                            dueDate: dateObj,
                            installments: 1,
                            ...(bookingStatus === 'CONFIRMED' ? { paidAt: new Date() } : {}),
                            // R4 (ATK-03/FIN-05/FIN-03): a cobrança inclui o valor da PRÓPRIA sessão (avulso,
                            // SERVIÇO, FIXO acima do teto, ou criada por quem tem a baixa) → marca. Só os extras
                            // de uma sessão coberta pelo plano (planCovered) não levam a marca. ATU5-02: a sessão FIXO
                            // criada com o teto já cheio leva também a fixoExtra (não ocupa vaga do plano).
                            ...(!planCovered ? { metadata: { ...SESSION_CHARGE_METADATA, ...(fixoExtra ? FIXO_EXTRA_METADATA : {}) } } : {}),
                            ...(adminCouponQuote ? {
                                couponId: adminCouponQuote.coupon.id,
                                couponCode: adminCouponQuote.coupon.code,
                                discountAmount: adminCouponQuote.discountAmount,
                            } : {}),
                        },
                    });
                    if (adminCouponQuote) {
                        await reserveCouponUse(tx, {
                            couponId: adminCouponQuote.coupon.id,
                            userId: data.userId,
                            paymentId: p.id,
                            originalAmount: price,
                            discountAmount: adminCouponQuote.discountAmount,
                            maxUsesPerUser: adminCouponQuote.coupon.maxUsesPerUser,
                        });
                        // Booking created directly as CONFIRMED+PAID → confirm the use
                        // ATOMICALLY with the payment (same tx) so it can't be left RESERVED.
                        if (bookingStatus === 'CONFIRMED') {
                            await tx.couponRedemption.updateMany({
                                where: { paymentId: p.id, status: 'RESERVED' },
                                data: { status: 'CONFIRMED', confirmedAt: new Date() },
                            });
                        }
                    }
                    return p;
                });
                createdPaymentId = paymentRecord.id;

                // Cupom 100% / valor zero: nada a cobrar — liquida como PAID na hora (mesmos efeitos de um
                // webhook: confirma a reserva e o uso do cupom). Uma cobrança de R$ 0 PENDENTE iria ao gateway
                // (que recusa) e ao auto-charge (aviso de falha diário).
                // (Só chega aqui com cobrancas.baixa — sem ela o valor zero é recusado antes de gravar.)
                if (adminChargeAmount <= 0 && bookingStatus !== 'CONFIRMED') {
                    const settled = await prisma.payment.updateMany({
                        where: { id: paymentRecord.id, status: 'PENDING' },
                        data: { status: 'PAID', paidAt: new Date() },
                    });
                    if (settled.count > 0) {
                        const { onPaymentConfirmed } = await import('../../lib/paymentEffects.js');
                        await onPaymentConfirmed(paymentRecord.id);
                    }
                }

                // Admin-only: generate BOLETO via Cora
                if (data.paymentMethod === 'BOLETO' && bookingStatus !== 'CONFIRMED' && adminChargeAmount > 0) {
                    try {
                        const { createCoraPayment } = await import('../../lib/coraPaymentHelper.js');
                        const coraRes = await createCoraPayment({
                            userId: data.userId,
                            amount: adminChargeAmount,
                            description: `Boleto - ${data.startTime} ${data.date}`,
                            withPixQrCode: false,
                            dueDays: 3,
                            idempotencyKey: paymentRecord.id,
                        });
                        boletoUrl = coraRes.boletoUrl;
                        barcode = coraRes.barcode;
                        await prisma.payment.update({
                            where: { id: paymentRecord.id },
                            data: {
                                providerRef: coraRes.result.id,
                                provider: 'CORA',
                                boletoUrl: coraRes.boletoUrl,
                            },
                        });
                    } catch (bErr: unknown) {
                        // Surface the failure to the admin instead of silently returning a
                        // 201 with no boleto — the booking still exists, but the admin must
                        // know the boleto was NOT generated (e.g. client CPF inválido).
                        console.error('[ADMIN-BOOKING] Boleto generation failed:', bErr);
                        boletoError = bErr instanceof Error ? bErr.message : 'Falha ao gerar o boleto.';
                    }
                }
            } catch (payErr: unknown) {
                console.error('[ADMIN-BOOKING] Payment creation failed:', payErr);
            }
        }
        const planReservedMessage = adminPlanBookingReservedMessage(planCovered && createdPaymentId !== null);
        const chargedMessage = chargedReason ? ADMIN_LINKED_CHARGED_MESSAGE[chargedReason] : null;
        // Aviso que o modal mostra no lugar do texto dele: "Confirmado" rebaixado (D7) e, sempre, a sessão
        // vinculada que o contrato não cobre (REG-1 — senão o modal diria "coberta pelo plano").
        const notice = planCovered
            ? (createPlan.downgraded ? planReservedMessage : null)
            : (chargedMessage ?? (createPlan.downgraded ? ADMIN_BOOKING_DOWNGRADE_MESSAGE : null));

        res.status(201).json({
            booking: {
                id: booking.id,
                date: data.date,
                startTime: booking.startTime,
                endTime: booking.endTime,
                tier: booking.tierApplied,
                price: booking.price,
                status: booking.status,
            },
            paymentId: createdPaymentId,
            ...(createdPaymentId ? {
                paymentAmount: adminChargeAmount,
                ...(adminCouponQuote && { couponDiscount: adminCouponQuote.discountAmount }),
            } : {}),
            boletoUrl,
            barcode,
            ...(boletoError && { boletoError }),
            // REG-1: sessão de plano criada sem a baixa — o plano cobre a sessão (só os extras são cobrados).
            ...(planCovered && { coveredByPlan: true }),
            // D7: "Confirmado" pedido por quem não tem a baixa manual → RESERVED (avulso: aguardando pagamento;
            // plano: presença a confirmar).
            downgraded: createPlan.downgraded,
            ...(notice && { notice }),
            message: boletoError
                ? 'Agendamento criado, mas o boleto NÃO foi gerado. Verifique o CPF do cliente e gere o boleto novamente.'
                : planCovered
                    ? planReservedMessage
                    : (chargedMessage ?? (createPlan.downgraded ? ADMIN_BOOKING_DOWNGRADE_MESSAGE : 'Agendamento criado pela equipe.')),
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
        throw err;
    }
});

} // end registerCreationRoutes
