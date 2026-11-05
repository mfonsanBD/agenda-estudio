import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';

// Permissões (equipe): serviços (GET /addons/all, PUT /addons, DELETE /addons/:key) → config.servicos;
// formas de pagamento (GET /payment-methods/all, PUT /payment-methods, PUT /payment-methods/boleto) →
// config.pagamentos. As leituras públicas (GET /addons, GET /payment-methods) seguem sem login.

export function registerMethodsRoutes(router: Router) {
    // ─── GET /api/pricing/addons (public — active only) ─────

    router.get('/addons', async (_req: Request, res: Response) => {
        const addons = await prisma.addOnConfig.findMany({
            where: { active: true },
            orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        });
        res.json({ addons });
    });

    // ─── GET /api/pricing/addons/all (config.servicos — includes inactive) ───

    router.get('/addons/all', authenticate, requirePermission('config.servicos'), async (_req: Request, res: Response) => {
        const addons = await prisma.addOnConfig.findMany({
            orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        });
        res.json({ addons });
    });

    // ─── PUT /api/pricing/addons (config.servicos) — batch upsert (create + edit) ──

    const addonItemSchema = z.object({
        key: z.string().min(1).regex(/^[A-Z0-9_]+$/, 'Use apenas MAIÚSCULAS, números e _'),
        name: z.string().min(1),
        price: z.number().int().min(0),
        // These columns are nullable in the DB and come back as `null` from GET /addons/all
        // (e.g. per-episode services have benefits=null). Accept null so a round-trip save
        // doesn't 400 — that was the "salvar não funciona" bug.
        description: z.string().nullable().optional(),
        monthly: z.boolean().optional().default(false),
        active: z.boolean().optional().default(true),
        sortOrder: z.number().int().min(0).optional().default(0),
        icon: z.string().nullable().optional(),
        showOnLanding: z.boolean().optional().default(true),
        benefits: z.string().nullable().optional(), // JSON string[]
        durationsOffered: z.string().optional().default('3,6'),
        plansAllowed: z.string().optional().default('FULL'),
        billingCadence: z.enum(['BILLING_CYCLE_28', 'CALENDAR_MONTH']).optional().default('BILLING_CYCLE_28'),
    });
    const updateAddonsSchema = z.object({ addons: z.array(addonItemSchema) });

    router.put('/addons', authenticate, requirePermission('config.servicos'), async (req: Request, res: Response) => {
        try {
            const { addons } = updateAddonsSchema.parse(req.body);

            // All-or-nothing: a mid-batch failure must not leave the catalog half-applied.
            const results = await prisma.$transaction(
                addons.map(({ key, ...data }) =>
                    prisma.addOnConfig.upsert({ where: { key }, create: { key, ...data }, update: data })
                )
            );

            res.json({
                addons: results,
                message: 'Serviços atualizados com sucesso!',
            });
        } catch (err) {
            if (err instanceof z.ZodError) {
                res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
                return;
            }
            throw err;
        }
    });

    // ─── DELETE /api/pricing/addons/:key (config.servicos) — soft-delete if referenced ──
    // Contract.addOns / Booking.addOns store keys by reference (no FK). Hard-deleting a
    // referenced service would orphan pricing/display lookups, so we soft-delete
    // (active=false) when anything points at it and only hard-delete when truly unused.

    router.delete('/addons/:key', authenticate, requirePermission('config.servicos'), async (req: Request, res: Response) => {
        const key = req.params.key as string;
        const existing = await prisma.addOnConfig.findUnique({ where: { key } });
        if (!existing) {
            res.status(404).json({ error: 'Serviço não encontrado.' });
            return;
        }

        const [contractRefs, bookingRefs] = await Promise.all([
            prisma.contract.count({ where: { addOns: { has: key } } }),
            prisma.booking.count({ where: { addOns: { has: key } } }),
        ]);

        if (contractRefs > 0 || bookingRefs > 0) {
            const config = await prisma.addOnConfig.update({ where: { key }, data: { active: false } });
            res.json({
                addon: config,
                softDeleted: true,
                message: 'Serviço desativado — há contratos/agendamentos vinculados, então ele não foi removido permanentemente.',
            });
            return;
        }

        await prisma.addOnConfig.delete({ where: { key } });
        res.json({ softDeleted: false, message: 'Serviço removido com sucesso.' });
    });

    // ─── GET /api/pricing/payment-methods (public) ──────────
    // Returns ONLY methods that are active AND whose provider (Stripe/Sicoob/Cora) is enabled.
    // E3: o BOLETO só vem em `methods` quando EFETIVO (chave-mestra ligada E Cora habilitada) e a
    // resposta traz também `boleto` — o que as telas usam para mostrar/esconder o boleto.
    // SEC-3: esta rota é PÚBLICA (sem login), então `boleto` vem SANEADO: só `available` diz algo
    // (`enabled`/`providerEnabled` = available; `reason`/`message` = null). A posição da chave, o estado
    // da integração Cora e o texto de administração ficam só em GET /payment-methods/all e nos PUT (config.pagamentos).

    router.get('/payment-methods', async (_req: Request, res: Response) => {
        try {
            const { getAvailablePaymentMethods, getBoletoStatus } = await import('../../lib/paymentGateway.js');
            const [methods, status] = await Promise.all([getAvailablePaymentMethods(), getBoletoStatus()]);
            const boleto = { enabled: status.available, providerEnabled: status.available, available: status.available, reason: null, message: null };

            // If no configs exist yet, return hardcoded defaults (sem boleto: ele só existe com a chave
            // ligada nas Configurações e a Cora ativa).
            if (methods.length === 0) {
                res.json({
                    methods: [
                        { key: 'PIX', label: 'PIX', shortLabel: 'PIX', emoji: '⚡', description: 'Pagamento instantâneo', color: '#22c55e', active: true, sortOrder: 0, accessMode: 'FULL' },
                        { key: 'CARTAO', label: 'Cartão de Crédito', shortLabel: 'Cartão', emoji: '💳', description: 'Crédito ou débito', color: '#8b5cf6', active: true, sortOrder: 1, accessMode: 'FULL' },
                    ],
                    boleto,
                });
                return;
            }

            res.json({ methods, boleto });
        } catch (err) {
            res.status(500).json({ error: 'Erro ao carregar métodos de pagamento.' });
        }
    });

    // ─── GET /api/pricing/payment-methods/all (config.pagamentos — includes inactive) ───

    // E3: devolve também `boleto` (estado COMPLETO da chave-mestra + Cora — getBoletoStatus) para o switch
    // "Aceitar pagamento por boleto" das Configurações e para as telas do admin: `enabled` = chave,
    // `providerEnabled` = Cora ativa, `available` = efetivo, `reason`/`message` = por que não. (SEC-3: a
    // rota pública devolve só a versão saneada.)

    router.get('/payment-methods/all', authenticate, requirePermission('config.pagamentos'), async (_req: Request, res: Response) => {
        try {
            const { getBoletoStatus } = await import('../../lib/paymentGateway.js');
            const methods = await prisma.paymentMethodConfig.findMany({
                orderBy: { sortOrder: 'asc' },
            });

            // If no configs exist, seed defaults and return them
            if (methods.length === 0) {
                // E3: o boleto nasce DESLIGADO (a chave-mestra só liga com a Cora ativa).
                const defaults = [
                    { key: 'PIX', label: 'PIX', shortLabel: 'PIX', emoji: '⚡', description: 'Pagamento instantâneo', color: '#22c55e', active: true, sortOrder: 0, accessMode: 'FULL' },
                    { key: 'CARTAO', label: 'Cartão de Crédito', shortLabel: 'Cartão', emoji: '💳', description: 'Crédito ou débito', color: '#8b5cf6', active: true, sortOrder: 1, accessMode: 'FULL' },
                    { key: 'BOLETO', label: 'Boleto Bancário', shortLabel: 'Boleto', emoji: '📄', description: 'Compensação em até 3 dias úteis', color: '#f59e0b', active: false, sortOrder: 2, accessMode: 'PROGRESSIVE' },
                ];
                for (const d of defaults) {
                    await prisma.paymentMethodConfig.create({ data: d });
                }
                res.json({ methods: defaults, boleto: await getBoletoStatus() });
                return;
            }

            res.json({ methods, boleto: await getBoletoStatus() });
        } catch (err) {
            res.status(500).json({ error: 'Erro ao carregar métodos de pagamento.' });
        }
    });

    // ─── PUT /api/pricing/payment-methods (config.pagamentos) ─

    const updatePaymentMethodsSchema = z.object({
        methods: z.array(z.object({
            key: z.string().min(1),
            label: z.string().min(1).max(100),
            shortLabel: z.string().min(1).max(50),
            emoji: z.string().min(1).max(10),
            description: z.string().max(300).optional().default(''),
            color: z.string().min(1).max(30),
            active: z.boolean(),
            sortOrder: z.number().int().min(0),
            accessMode: z.enum(['FULL', 'PROGRESSIVE']),
            contexts: z.string().optional().default('avulso,contract,invoice'),
        })),
    });

    // E3: LIGAR a chave do boleto (BOLETO.active false → true) sem a Cora ativa → 400
    // BOLETO_PROVIDER_DISABLED, e NADA do lote é gravado. Desligar é sempre permitido; um boleto que já
    // estava ligado e segue ligado não bloqueia o salvamento dos outros métodos (ele só não fica efetivo).

    router.put('/payment-methods', authenticate, requirePermission('config.pagamentos'), async (req: Request, res: Response) => {
        try {
            const { methods } = updatePaymentMethodsSchema.parse(req.body);
            const { getBoletoStatus, BOLETO_PROVIDER_DISABLED_MESSAGE } = await import('../../lib/paymentGateway.js');

            const boletoItem = methods.find(m => m.key.toUpperCase() === 'BOLETO');
            if (boletoItem?.active) {
                const current = await getBoletoStatus();
                if (!current.enabled && !current.providerEnabled) {
                    res.status(400).json({
                        error: BOLETO_PROVIDER_DISABLED_MESSAGE,
                        code: 'BOLETO_PROVIDER_DISABLED',
                        boleto: current,
                    });
                    return;
                }
            }

            const results = [];
            for (const item of methods) {
                const config = await prisma.paymentMethodConfig.upsert({
                    where: { key: item.key },
                    create: item,
                    update: {
                        label: item.label,
                        shortLabel: item.shortLabel,
                        emoji: item.emoji,
                        description: item.description,
                        color: item.color,
                        active: item.active,
                        sortOrder: item.sortOrder,
                        accessMode: item.accessMode,
                        contexts: item.contexts,
                    },
                });
                results.push(config);
            }

            res.json({
                methods: results,
                boleto: await getBoletoStatus(),
                message: 'Métodos de pagamento atualizados com sucesso!',
            });
        } catch (err) {
            if (err instanceof z.ZodError) {
                res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
                return;
            }
            res.status(500).json({ error: 'Erro ao salvar métodos de pagamento.' });
        }
    });

    // ─── PUT /api/pricing/payment-methods/boleto (config.pagamentos) ─
    // E3: chave-mestra "Aceitar pagamento por boleto" (salva na hora, sem reenviar a lista de métodos).
    // Ligar exige a integração Cora ativa (400 BOLETO_PROVIDER_DISABLED); desligar é sempre permitido.

    const boletoSwitchSchema = z.object({ enabled: z.boolean() });

    router.put('/payment-methods/boleto', authenticate, requirePermission('config.pagamentos'), async (req: Request, res: Response) => {
        try {
            const { enabled } = boletoSwitchSchema.parse(req.body);
            const { getBoletoStatus, BOLETO_PROVIDER_DISABLED_MESSAGE } = await import('../../lib/paymentGateway.js');

            if (enabled) {
                const current = await getBoletoStatus();
                if (!current.providerEnabled) {
                    res.status(400).json({
                        error: BOLETO_PROVIDER_DISABLED_MESSAGE,
                        code: 'BOLETO_PROVIDER_DISABLED',
                        boleto: current,
                    });
                    return;
                }
            }

            await prisma.paymentMethodConfig.upsert({
                where: { key: 'BOLETO' },
                create: {
                    key: 'BOLETO', label: 'Boleto Bancário', shortLabel: 'Boleto', emoji: '📄',
                    description: 'Compensação em até 3 dias úteis', color: '#f59e0b',
                    active: enabled, sortOrder: 2, accessMode: 'PROGRESSIVE',
                },
                update: { active: enabled },
            });

            res.json({
                boleto: await getBoletoStatus(),
                message: enabled
                    ? 'Pagamento por boleto ativado.'
                    : 'Pagamento por boleto desativado. Boletos já emitidos continuam válidos no banco.',
            });
        } catch (err) {
            if (err instanceof z.ZodError) {
                res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
                return;
            }
            res.status(500).json({ error: 'Erro ao salvar a configuração do boleto.' });
        }
    });
}
