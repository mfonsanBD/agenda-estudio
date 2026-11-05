// ─── Integration Management Routes (ADMIN) ─────────────
// CRUD for payment provider configurations (Cora, Stripe)
// Stores credentials in IntegrationConfig table

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireAdmin } from '../../middleware/permissions.js';
import { coraTestConnection } from '../../lib/coraService.js';
import { sicoobTestConnection, sicoobAllowedEnvironment } from '../../lib/sicoobService.js';
import { stripeTestConnection } from '../../lib/stripeService.js';
import { encryptCredentials, decryptConfigSafe } from '../../utils/crypto.js';
import { maskConfig } from './integrations.masking.js';

// ─── Schemas ─────────────────────────────────────────────

const VALID_PROVIDERS = ['CORA', 'STRIPE', 'SICOOB'] as const;

const saveIntegrationSchema = z.object({
    environment: z.enum(['sandbox', 'production']).default('sandbox'),
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.any()),
});

/** Um sub-config de ambiente tem as credenciais obrigatórias do provider? */
function envCredsComplete(provider: string, envCfg: Record<string, any> | undefined, environment?: string): boolean {
    if (provider === 'SICOOB') {
        // Sandbox usa credenciais PÚBLICAS de teste do Sicoob → sempre "completo" (permite testar sem cert).
        // Produção exige client_id + certificado mTLS + chave privada + chave PIX do estúdio.
        if (environment === 'production') {
            return !!(envCfg && envCfg.clientId && envCfg.certificatePem && envCfg.privateKeyPem && envCfg.pixKey);
        }
        return true;
    }
    if (!envCfg) return false;
    return provider === 'CORA'
        ? !!(envCfg.clientId && envCfg.certificatePem && envCfg.privateKeyPem)
        : !!(envCfg.secretKey && envCfg.publishableKey);
}

const envLabel = (env: string) => (env === 'production' ? 'produção' : 'sandbox');

export function registerIntegrationRoutes(router: Router) {

// ─── GET /api/integrations ──────────────────────────────
// List all integrations (masked credentials)

router.get('/', requireAdmin(), async (_req: Request, res: Response) => {
    try {
        const integrations = await prisma.integrationConfig.findMany({
            orderBy: { provider: 'asc' },
        });

        // Build response with defaults for unconfigured providers
        const result = VALID_PROVIDERS.map(provider => {
            const existing = integrations.find((i: any) => i.provider === provider);

            if (existing) {
                let parsedConfig: Record<string, any> = {};
                try {
                    const decrypted = decryptConfigSafe(existing.config);
                    parsedConfig = JSON.parse(decrypted);
                } catch { /* empty */ }

                return {
                    provider: existing.provider,
                    enabled: existing.enabled,
                    environment: existing.environment,
                    config: maskConfig(existing.provider, parsedConfig),
                    configured: true,
                    webhookUrl: existing.webhookUrl,
                    lastTestedAt: existing.lastTestedAt?.toISOString() || null,
                    testStatus: existing.testStatus,
                    testMessage: existing.testMessage,
                };
            }

            return {
                provider,
                enabled: false,
                environment: 'sandbox',
                config: {},
                configured: false,
                webhookUrl: null,
                lastTestedAt: null,
                testStatus: null,
                testMessage: null,
            };
        });

        // Ambiente permitido por ESTE deploy (NODE_ENV) — a UI usa para travar o seletor do Sicoob
        // (produção só em deploy de produção; qualquer outro deploy só sandbox).
        res.json({ integrations: result, deployEnvironment: sicoobAllowedEnvironment() });
    } catch (err) {
        console.error('Error listing integrations:', err);
        res.status(500).json({ error: 'Erro ao listar integrações.' });
    }
});

// ─── GET /api/integrations/:provider ────────────────────

router.get('/:provider', requireAdmin(), async (req: Request, res: Response) => {
    const provider = (req.params.provider as string)?.toUpperCase();
    if (!VALID_PROVIDERS.includes(provider as any)) {
        res.status(400).json({ error: 'Provider inválido. Use CORA, SICOOB ou STRIPE.' });
        return;
    }

    const integration = await prisma.integrationConfig.findUnique({
        where: { provider },
    });

    if (!integration) {
        res.json({
            integration: {
                provider,
                enabled: false,
                environment: 'sandbox',
                config: {},
                configured: false,
                webhookUrl: null,
                lastTestedAt: null,
                testStatus: null,
                testMessage: null,
            },
        });
        return;
    }

    let parsedConfig: Record<string, any> = {};
    try {
        const decrypted = decryptConfigSafe(integration.config);
        parsedConfig = JSON.parse(decrypted);
    } catch { /* empty */ }

    res.json({
        integration: {
            provider: integration.provider,
            enabled: integration.enabled,
            environment: integration.environment,
            config: maskConfig(integration.provider, parsedConfig),
            configured: true,
            webhookUrl: integration.webhookUrl,
            lastTestedAt: integration.lastTestedAt?.toISOString() || null,
            testStatus: integration.testStatus,
            testMessage: integration.testMessage,
        },
    });
});

// ─── PUT /api/integrations/:provider ────────────────────
// Save/update integration credentials

router.put('/:provider', requireAdmin(), async (req: Request, res: Response) => {
    try {
        const provider = (req.params.provider as string)?.toUpperCase();
        if (!VALID_PROVIDERS.includes(provider as any)) {
            res.status(400).json({ error: 'Provider inválido.' });
            return;
        }

        const data = saveIntegrationSchema.parse(req.body);

        // Trava por deploy (só Sicoob): o ambiente ATIVO tem de ser o permitido por este servidor
        // (NODE_ENV) — produção só em deploy de produção; qualquer outro deploy só sandbox. Impede
        // ativar por engano a API real fora de produção (ou o mock em produção). Defesa em
        // profundidade: a UI já desabilita a opção proibida; aqui protege chamadas diretas à API.
        if (provider === 'SICOOB') {
            const allowedEnv = sicoobAllowedEnvironment();
            if (data.environment !== allowedEnv) {
                res.status(400).json({
                    error: `Neste servidor (${allowedEnv === 'production' ? 'produção' : 'desenvolvimento/homologação'}) o Sicoob só opera em ${envLabel(allowedEnv)}. Selecione "${envLabel(allowedEnv)}" como ambiente ativo. A ${envLabel(allowedEnv === 'production' ? 'sandbox' : 'production')} é configurada no deploy correspondente.`,
                });
                return;
            }
        }

        // Stripe key sanity: reject swapped/empty keys early with a clear message
        // so the client checkout never ends up with a broken publishable key.
        if (provider === 'STRIPE') {
            const isReal = (v: any) => typeof v === 'string' && v && !v.includes('...') && !v.startsWith('***');
            const checkSub = (sub: any, envLabel: string): string | null => {
                if (!sub) return null;
                if (isReal(sub.secretKey) && !/^(sk|rk)_/.test(sub.secretKey)) {
                    return `A Secret Key (${envLabel}) deve começar com "sk_" (ou "rk_" para chave restrita). Verifique se você não inverteu os campos.`;
                }
                if (isReal(sub.publishableKey) && !sub.publishableKey.startsWith('pk_')) {
                    return `A Publishable Key (${envLabel}) deve começar com "pk_" (não a sk_). Verifique se você não inverteu os campos.`;
                }
                return null;
            };
            let keyErr: string | null = null;
            if ((data.config as any).sandbox || (data.config as any).production) {
                keyErr = checkSub((data.config as any).sandbox, 'sandbox') || checkSub((data.config as any).production, 'produção');
            } else {
                keyErr = checkSub(data.config, 'atual');
            }
            if (keyErr) {
                res.status(400).json({ error: keyErr });
                return;
            }
        }

        // Generate webhook URL
        const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3001}`;
        const webhookUrl = `${baseUrl}/api/webhooks/${provider.toLowerCase()}`;

        // Merge with existing config to preserve omitted sensitive fields
        const existing = await prisma.integrationConfig.findUnique({ where: { provider } });
        let mergedConfig = data.config;
        if (existing) {
            try {
                const decryptedExisting = decryptConfigSafe(existing.config);
                const existingConfig = JSON.parse(decryptedExisting);

                const hasDualFormat = data.config.sandbox || data.config.production;
                if (hasDualFormat) {
                    // Dual format (Cora or Stripe): merge each environment sub-object individually.
                    // Se o existente ainda é FLAT (legado), migra as credenciais para o ambiente que
                    // estava ativo — senão o topo flat viraria lixo e o runtime dual leria um
                    // sub-objeto vazio (quebrando PIX/Boleto/Cartão silenciosamente).
                    const existingIsFlat = !existingConfig.sandbox && !existingConfig.production;
                    let base: Record<string, any> = existingConfig;
                    if (existingIsFlat && Object.keys(existingConfig).length > 0) {
                        const activeEnv = existing.environment === 'production' ? 'production' : 'sandbox';
                        base = { [activeEnv]: existingConfig };
                    }
                    mergedConfig = {};
                    for (const env of ['sandbox', 'production'] as const) {
                        const existingSub = (base[env] || {}) as Record<string, any>;
                        const incoming = data.config[env] as Record<string, any> | undefined;
                        const merged: Record<string, any> = { ...existingSub };
                        for (const [key, value] of Object.entries(incoming || {})) {
                            // Skip empty, null, undefined values
                            if (value === undefined || value === null || value === '') continue;
                            // Skip masked values sent back from the frontend (e.g. 'int-1bk...bsHJ', '***CERTIFICATE_CONFIGURED***')
                            if (typeof value === 'string' && (value.includes('...') || value.startsWith('***'))) continue;
                            merged[key] = value;
                        }
                        mergedConfig[env] = merged;
                    }
                } else {
                    // Flat format (legacy)
                    mergedConfig = { ...existingConfig };
                    for (const [key, value] of Object.entries(data.config)) {
                        if (value === undefined || value === null || value === '') continue;
                        if (typeof value === 'string' && (value.includes('...') || value.startsWith('***'))) continue;
                        mergedConfig[key] = value;
                    }
                }
            } catch { /* existing config parse failed, use new config */ }
        }

        // Guarda: não persistir um estado que deixaria a integração LIGADA apontando para um
        // ambiente ativo SEM credenciais (o checkout ofereceria o método mas falharia ao cobrar).
        // O fluxo legítimo "seleciono produção e colo as chaves no mesmo Salvar" passa, pois aqui
        // já checamos o config MESCLADO (com o que acabou de ser digitado).
        const willBeEnabled = data.enabled ?? existing?.enabled ?? false;
        const isDualMerged = !!((mergedConfig as any).sandbox || (mergedConfig as any).production);
        if (willBeEnabled && isDualMerged) {
            const activeEnv = data.environment === 'production' ? 'production' : 'sandbox';
            if (!envCredsComplete(provider, (mergedConfig as any)[activeEnv], activeEnv)) {
                res.status(400).json({ error: `Não é possível ativar o ambiente de ${envLabel(activeEnv)} sem as credenciais. Preencha-as ou desligue a integração antes de trocar de ambiente.` });
                return;
            }
        }

        const encryptedConfig = encryptCredentials(JSON.stringify(mergedConfig));

        const result = await prisma.integrationConfig.upsert({
            where: { provider },
            create: {
                provider,
                enabled: data.enabled ?? false,
                environment: data.environment,
                config: encryptedConfig,
                webhookUrl,
            },
            update: {
                enabled: data.enabled ?? undefined,
                environment: data.environment,
                config: encryptedConfig,
                webhookUrl,
                // Reset test status when config changes
                testStatus: null,
                testMessage: null,
                lastTestedAt: null,
            },
        });

        let parsedConfig: Record<string, any> = {};
        try {
            const decrypted = decryptConfigSafe(result.config);
            parsedConfig = JSON.parse(decrypted);
        } catch { /* empty */ }

        res.json({
            integration: {
                provider: result.provider,
                enabled: result.enabled,
                environment: result.environment,
                config: maskConfig(result.provider, parsedConfig),
                configured: true,
                webhookUrl: result.webhookUrl,
                lastTestedAt: result.lastTestedAt?.toISOString() || null,
                testStatus: result.testStatus,
                testMessage: result.testMessage,
            },
            message: `Integração ${provider} salva com sucesso!`,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        console.error('Error saving integration:', err);
        res.status(500).json({ error: 'Erro ao salvar integração.' });
    }
});

// ─── POST /api/integrations/:provider/test ──────────────
// Test connectivity for a provider

router.post('/:provider/test', requireAdmin(), async (req: Request, res: Response) => {
    const provider = (req.params.provider as string)?.toUpperCase();
    if (!VALID_PROVIDERS.includes(provider as any)) {
        res.status(400).json({ error: 'Provider inválido.' });
        return;
    }

    const integration = await prisma.integrationConfig.findUnique({ where: { provider } });
    if (!integration) {
        res.status(400).json({ error: `Integração ${provider} não configurada. Salve as credenciais primeiro.` });
        return;
    }

    let result: { success: boolean; message: string };

    if (provider === 'CORA') {
        result = await coraTestConnection();
    } else if (provider === 'SICOOB') {
        result = await sicoobTestConnection();
    } else if (provider === 'STRIPE') {
        result = await stripeTestConnection();
    } else {
        result = { success: false, message: 'Provider desconhecido' };
    }

    // Update test status in DB
    await prisma.integrationConfig.update({
        where: { provider },
        data: {
            lastTestedAt: new Date(),
            testStatus: result.success ? 'success' : 'error',
            testMessage: result.message,
        },
    });

    res.json(result);
});

// ─── POST /api/integrations/:provider/toggle ────────────
// Enable/disable a provider

router.post('/:provider/toggle', requireAdmin(), async (req: Request, res: Response) => {
    const provider = (req.params.provider as string)?.toUpperCase();
    if (!VALID_PROVIDERS.includes(provider as any)) {
        res.status(400).json({ error: 'Provider inválido.' });
        return;
    }

    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'Campo "enabled" (boolean) é obrigatório.' });
        return;
    }

    const integration = await prisma.integrationConfig.findUnique({ where: { provider } });
    if (!integration) {
        res.status(400).json({ error: `Integração ${provider} não configurada.` });
        return;
    }

    // Trava por deploy (só Sicoob): não deixar ATIVAR o Sicoob num ambiente proibido por este
    // servidor (NODE_ENV) — senão o admin veria "Ativa · Produção" com toast de sucesso enquanto
    // o runtime bloqueia (fail-closed). Espelha a mesma trava do PUT /:provider.
    if (enabled && provider === 'SICOOB') {
        const allowedEnv = sicoobAllowedEnvironment();
        const stored = integration.environment === 'production' ? 'production' : 'sandbox';
        if (stored !== allowedEnv) {
            res.status(400).json({
                error: `Neste servidor (${allowedEnv === 'production' ? 'produção' : 'desenvolvimento/homologação'}) o Sicoob só opera em ${envLabel(allowedEnv)}. Selecione "${envLabel(allowedEnv)}" como ambiente ativo e salve antes de ativar.`,
            });
            return;
        }
    }

    // Guarda: só liga se o AMBIENTE ATIVO tiver as credenciais obrigatórias —
    // ligar sem elas ofereceria o método no checkout mas falharia ao cobrar.
    if (enabled) {
        let cfg: Record<string, any> | null = null;
        let readable = true;
        try { cfg = JSON.parse(decryptConfigSafe(integration.config)); } catch { readable = false; }
        // Config ilegível (ex.: ENCRYPTION_KEY rotacionada) → fail-closed: o runtime também
        // rejeitaria a cobrança, então não deixamos ligar mostrando um estado saudável.
        if (!readable) {
            res.status(400).json({ error: 'Não foi possível ler as credenciais salvas. Salve-as novamente antes de ativar.' });
            return;
        }
        const env = integration.environment === 'production' ? 'production' : 'sandbox';
        const isDual = !!(cfg && (cfg.sandbox || cfg.production));
        // Config flat legado fica isento (espelha o fallback do runtime).
        if (isDual && !envCredsComplete(provider, cfg?.[env], env)) {
            res.status(400).json({ error: `Ative somente após configurar as credenciais de ${envLabel(env)} (ambiente ativo).` });
            return;
        }
    }

    await prisma.integrationConfig.update({
        where: { provider },
        data: { enabled },
    });

    res.json({ message: `Integração ${provider} ${enabled ? 'ativada' : 'desativada'}.` });
});

}
