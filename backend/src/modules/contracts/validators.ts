import { z } from 'zod';
import { ContractType, Tier, PaymentMethod } from '../../generated/prisma/client.js';

// ─── CREATE (Admin) ─────────────────────────────────────

export const createContractSchema = z.object({
    userId: z.string().uuid('ID de usuário inválido'),
    name: z.string().min(1, 'Nome do projeto é obrigatório'),
    type: z.nativeEnum(ContractType),
    tier: z.nativeEnum(Tier),
    durationMonths: z.number().refine(v => v === 3 || v === 6, 'Duração deve ser 3 ou 6 meses'),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido'),
    // Fixo-specific
    fixedDayOfWeek: z.number().min(1).max(6).optional(), // 1=Mon, 6=Sat
    fixedTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    contractUrl: z.string().url().optional().or(z.literal('')),
    addOns: z.array(z.string()).optional(),
    boletoAllowed: z.boolean().optional(),
    paymentMethod: z.nativeEnum(PaymentMethod).optional(),
    paymentPlan: z.enum(['MONTHLY', 'FULL']).optional().default('MONTHLY'),
    couponCode: z.string().trim().min(1).max(64).optional(),
    resolvedConflicts: z.array(z.object({
        originalDate: z.string(),
        originalTime: z.string(),
        newDate: z.string(),
        newTime: z.string(),
    })).optional(),
});

// ─── CHECK FIXO ─────────────────────────────────────────

export const checkFixoSchema = z.object({
    tier: z.nativeEnum(Tier),
    durationMonths: z.number().refine(v => v === 3 || v === 6, 'Duração deve ser 3 ou 6 meses'),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido'),
    fixedDayOfWeek: z.number().min(1).max(6),
    fixedTime: z.string().regex(/^\d{2}:\d{2}$/, 'Formato de hora inválido (HH:MM)'),
});

// ─── SELF (Client) ──────────────────────────────────────

export const selfContractSchema = z.object({
    name: z.string().min(1, 'Nome do projeto é obrigatório'),
    // O hire self-serve (ContractWizard) só suporta FIXO e FLEX — o fulfillment só gera bookings
    // para esses dois. Aceitar SERVICO/CUSTOM/AVULSO aqui criava contrato pago sem sessões/créditos.
    type: z.enum([ContractType.FIXO, ContractType.FLEX]),
    tier: z.nativeEnum(Tier),
    durationMonths: z.number().refine(v => v === 3 || v === 6, 'Duração deve ser 3 ou 6 meses'),
    firstBookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido'),
    firstBookingTime: z.string().regex(/^\d{2}:\d{2}$/, 'Formato de horário inválido'),
    fixedDayOfWeek: z.number().min(1).max(6).optional(),
    fixedTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    paymentMethod: z.nativeEnum(PaymentMethod),
    addOns: z.array(z.string()).optional(),
    paymentPlan: z.enum(['MONTHLY', 'FULL']).optional().default('MONTHLY'),
    couponCode: z.string().trim().min(1).max(64).optional(),
    resolvedConflicts: z.array(z.object({
        originalDate: z.string(),
        originalTime: z.string(),
        newDate: z.string(),
        newTime: z.string()
    })).optional(),
});

// ─── CUSTOM CHECK ───────────────────────────────────────

export const customCheckSchema = z.object({
    tier: z.nativeEnum(Tier),
    durationMonths: z.number().min(1).max(12),
    schedule: z.array(z.object({
        day: z.number().min(1).max(6), // 1=Mon..6=Sat
        time: z.string().regex(/^\d{2}:\d{2}$/),
    })).max(14).optional().default([]),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    // Opcionais (retrocompatível: sem eles = semanal). Mesmas opções do POST /custom, para o
    // check do admin simular Quinzenal/Mensal/Datas Livres com as ocorrências reais (D7).
    frequency: z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM']).optional().default('WEEKLY'),
    weekPattern: z.array(z.number().int().min(1).max(5)).max(5).optional(),
    customDates: z.array(z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        time: z.string().regex(/^\d{2}:\d{2}$/),
    })).max(366).optional(),
}).superRefine((d, ctx) => {
    if (d.frequency === 'CUSTOM' && !(d.customDates && d.customDates.length > 0)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['customDates'], message: 'Selecione pelo menos uma data' });
    } else if (d.frequency !== 'CUSTOM' && d.schedule.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['schedule'], message: 'Selecione pelo menos um dia' });
    }
});

// ─── SLOT OPTIONS (grade de horários de contrato — D8) ──

export const slotOptionsQuerySchema = z.object({
    tier: z.nativeEnum(Tier),
});

// ─── CUSTOM CONTRACT ────────────────────────────────────

export const customContractSchema = z.object({
    name: z.string().min(1, 'Nome do projeto é obrigatório'),
    tier: z.nativeEnum(Tier),
    durationMonths: z.number().int().min(1).max(12), // B19: .int() — fracionário estourava a coluna Int (500 → agora 400)
    schedule: z.array(z.object({
        day: z.number().int().min(0).max(6),
        time: z.string().regex(/^\d{2}:\d{2}$/),
    })).max(14).optional().default([]), // B9: teto (evita geração massiva de bookings / DoS)
    paymentMethod: z.nativeEnum(PaymentMethod),
    addOns: z.array(z.string()).max(20).optional(),
    paymentPlan: z.enum(['MONTHLY', 'FULL']).optional().default('MONTHLY'),
    couponCode: z.string().trim().min(1).max(64).optional(),
    addonConfig: z.record(z.string(), z.object({
        mode: z.enum(['all', 'credits']),
        perCycle: z.number().int().min(0).optional(), // B2: sem piso, perCycle negativo virava dinheiro grátis
    })).optional(),
    // Teto = nº máximo de ocorrências (14 itens × 48 semanas); cada troca é conferida por ocorrência.
    resolvedConflicts: z.array(z.object({
        originalDate: z.string(),
        originalTime: z.string(),
        newDate: z.string(),
        newTime: z.string(),
    })).max(700).optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    userId: z.string().uuid().optional(),
    // Enhanced scheduling
    frequency: z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM']).default('WEEKLY'),
    weekPattern: z.array(z.number().int().min(1).max(5)).max(5).optional(), // e.g. [1,3] = weeks 1 & 3
    customDates: z.array(z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        time: z.string().regex(/^\d{2}:\d{2}$/),
    })).max(366).optional(), // B9: teto (máx ~1 ano de datas)
});

// ─── UPDATE (Admin) ─────────────────────────────────────

export const updateContractSchema = z.object({
    // D6: COMPLETED permite concluir/reabrir manualmente. PENDING_CANCELLATION fica de fora de propósito: o
    // PATCH não cancela as sessões futuras como o /request-cancellation, e o /resolve-cancellation conta com isso.
    status: z.enum(['ACTIVE', 'EXPIRED', 'CANCELLED', 'COMPLETED']).optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    flexCreditsRemaining: z.number().int().min(0).optional(),
    contractUrl: z.string().url().optional().or(z.literal('')),
    paymentMethod: z.nativeEnum(PaymentMethod).optional(),
    boletoAllowed: z.boolean().optional(),
    // Recurring services edit (FIXO/FLEX ACTIVE only) — recomputes future installments/bookings.
    addOns: z.array(z.string()).optional(),
});

// ─── RENEW (equipe) ─────────────────────────────────────
// POST /contracts/:id/renew. Antes o corpo entrava cru: `durationMonths: 24` gerava 24 × sessions_per_month
// sessões, e `type`/`tier` fora do enum davam 500 (ou um tipo sem renovação passava). Agora: duração 3 ou 6,
// tipo só FIXO/FLEX, faixa pelo enum. `startDate` segue com a checagem AAAA-MM-DD da rota (mensagem própria).

export const renewContractSchema = z.object({
    durationMonths: z.union([z.literal(3), z.literal(6)]).default(3),
    type: z.enum([ContractType.FIXO, ContractType.FLEX]).optional(),
    tier: z.nativeEnum(Tier).optional(),
    startDate: z.string().nullable().optional(),
});

// ─── RESOLVE CANCELLATION ───────────────────────────────

export const resolveCancellationSchema = z.object({
    action: z.enum(['CHARGE_FEE', 'WAIVE_FEE']),
});

// ─── SERVICE ────────────────────────────────────────────

export const serviceContractSchema = z.object({
    serviceKey: z.string(),
    paymentMethod: z.nativeEnum(PaymentMethod),
    durationMonths: z.number().int().optional(),
    // Inline self-serve plan choice. Defaults to FULL (à vista) for back-compat with
    // any legacy caller; the route still validates it against the addon's plansAllowed.
    paymentPlan: z.enum(['FULL', 'MONTHLY']).optional(),
    couponCode: z.string().trim().min(1).max(64).optional(),
    // D1: "Mensal + Cartão" com o TOTAL cobrado agora, parcelado em até N× sem juros (N = meses da
    // fidelidade). Só vale com paymentPlan MONTHLY + CARTAO (senão 400); omitido = mensalidade 1×/mês.
    cardSplit: z.boolean().optional(),
});

// ─── PAY ────────────────────────────────────────────────

export const contractPaySchema = z.object({
    paymentMethod: z.enum(['CARTAO', 'PIX']).optional().default('CARTAO'),
    paymentType: z.enum(['CREDIT', 'DEBIT']).optional(),
    installments: z.number().int().min(1).max(12).optional(),
    couponCode: z.string().trim().min(1).max(64).optional(),
});

// ─── SUBSCRIBE ──────────────────────────────────────────

export const subscribeSchema = z.object({
    paymentMethodId: z.string().min(1, 'Payment Method ID obrigatório'),
    durationMonths: z.number().int().min(1).max(12).optional(),
});

// ─── CLIENT RENEW ───────────────────────────────────────

export const clientRenewSchema = z.object({
    durationMonths: z.number().int().min(1).max(12),
    paymentMethod: z.enum(['PIX', 'CARTAO', 'BOLETO']).optional(),
    installments: z.number().int().min(1).max(12).optional(),
});
