import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import {
    actorOrReply, can, missingRequirement, requireAdmin, requirePermission, requireStaff,
    PERMISSION_DENIED_MESSAGE,
} from '../../middleware/permissions.js';
import { allPermissionKeys, moduleOf, permissionForConfigGroup, type PermissionKey } from '../../config/staffPermissions.js';
import { requiredForBusinessConfig } from '../../lib/permissionRules.js';
import { invalidateConfigCache, getConfig } from '../../lib/businessConfig.js';
import type { FeeRate } from '../../lib/gatewayFees.js';
import { BUSINESS_CONFIG_CATALOG, CONFIG_CATALOG_BY_KEY, DEPRECATED_CONFIG_KEYS, EMAIL_SECRET_KEYS } from '../../config/businessConfigCatalog.js';
import { encryptCredentials } from '../../utils/crypto.js';
import { deliverOtpEmail } from '../../lib/email.js';
import { getErrorMessage } from '../../utils/errors.js';

// Placeholder returned (instead of the real value) for secret keys, and detected on save
// so a re-save without retyping the secret keeps the stored value.
const SECRET_MASK = '••••••••';
const isBlankOrMasked = (v: string) => !v || v.trim() === '' || v.includes('•') || v.startsWith('***');

// Provedores com taxa versionada + as chaves de config que a compõem (Cora só tem taxa fixa).
const FEE_PROVIDERS: { provider: string; pctKey: string | null; fixedKey: string }[] = [
    { provider: 'STRIPE', pctKey: 'gateway_stripe_fee_pct', fixedKey: 'gateway_stripe_fee_cents' },
    { provider: 'CORA', pctKey: null, fixedKey: 'gateway_cora_fee_cents' },
];

async function currentFeeRate(fp: { pctKey: string | null; fixedKey: string }): Promise<FeeRate> {
    return { pct: fp.pctKey ? await getConfig(fp.pctKey) : 0, fixedCents: await getConfig(fp.fixedKey) };
}

// Caixas de Configurações (todas as chaves delegáveis do módulo `config`) — qualquer uma abre
// GET /business-config; a resposta vem filtrada por grupo. email (config.email) e gateway (config.taxas)
// são exclusivos do ADMIN; grupo sem mapeamento → só ADMIN.
const CONFIG_PERMISSIONS: readonly PermissionKey[] = allPermissionKeys().filter(k => moduleOf(k) === 'config');

// Número submetido no payload; se ausente ou inválido, mantém o valor anterior (não versiona lixo).
function submittedNumber(submitted: Map<string, string>, key: string | null, fallback: number): number {
    if (!key || !submitted.has(key)) return fallback;
    const n = parseFloat(submitted.get(key)!);
    return Number.isFinite(n) ? n : fallback;
}

export function registerConfigRoutes(router: Router) {
    // ─── GET /api/pricing/business-config/public (no auth, client-facing) ──────

    router.get('/business-config/public', async (_req: Request, res: Response) => {
        try {
            const rows = await prisma.businessConfig.findMany({ orderBy: { key: 'asc' } });
            // Return as a simple key→value map (string values preserved, numbers parsed, JSON parsed)
            const config: Record<string, string | number | Record<string, number>> = {};
            for (const row of rows) {
                if (DEPRECATED_CONFIG_KEYS.has(row.key)) continue; // retired keys never ship to clients
                if (row.group === 'email') continue; // e-mail config (incl. secrets) is admin-only — never public
                if (row.type === 'json') {
                    try { config[row.key] = JSON.parse(row.value); } catch { config[row.key] = row.value; }
                } else {
                    config[row.key] = row.type === 'string' ? row.value : parseFloat(row.value);
                }
            }
            res.json({ config });
        } catch (err) {
            res.status(500).json({ error: 'Erro ao carregar configurações.' });
        }
    });

    // ─── GET /api/pricing/business-config (equipe: qualquer config.*) ─
    // Devolve SÓ os grupos que o ator pode ver (permissionForConfigGroup): ADMIN vê tudo; o colaborador
    // nunca recebe `email` (segredos SMTP — quem controla recebe o código de login de qualquer conta),
    // `gateway` (taxas) nem grupos fora do mapeamento ("outros").

    router.get('/business-config', authenticate, requirePermission(...CONFIG_PERMISSIONS), async (req: Request, res: Response) => {
        try {
            const actor = await actorOrReply(req, res);
            if (!actor) return;
            const rows = await prisma.businessConfig.findMany({ orderBy: { group: 'asc' } });
            const byKey = new Map(rows.map(r => [r.key, r]));

            // Merge the catalog so the admin SEES & can EDIT every known key, even
            // ones not yet persisted (they show with their default value).
            const merged = [
                ...BUSINESS_CONFIG_CATALOG.map(c => {
                    const row = byKey.get(c.key);
                    // Secrets are NEVER returned in plaintext — send a mask when set, '' when not,
                    // so the admin can tell it's configured without exposing the value.
                    const value = EMAIL_SECRET_KEYS.has(c.key)
                        ? (row?.value ? SECRET_MASK : '')
                        : (row?.value ?? c.value); // DB value wins (admin edits persist)
                    return {
                        key: c.key,
                        value,
                        // Catalog is the single source for metadata — fixes keys whose
                        // persisted rows were seeded with a stale group/label/type.
                        type: c.type,
                        label: c.label,
                        group: c.group,
                    };
                }),
                // Any DB rows not described by the catalog (legacy keys), excluding
                // retired ones so they disappear from the admin UI even if still in the DB.
                ...rows.filter(r => !CONFIG_CATALOG_BY_KEY[r.key] && !DEPRECATED_CONFIG_KEYS.has(r.key)).map(r => ({
                    key: r.key,
                    value: EMAIL_SECRET_KEYS.has(r.key) ? (r.value ? SECRET_MASK : '') : r.value,
                    type: r.type, label: r.label, group: r.group,
                })),
            ];

            // Filtro por grupo (o ADMIN passa em todos).
            const visible = actor.isAdmin ? merged : merged.filter(row => can(actor, permissionForConfigGroup(row.group)));

            const grouped: Record<string, typeof visible> = {};
            for (const row of visible) {
                if (!grouped[row.group]) grouped[row.group] = [];
                grouped[row.group].push(row);
            }
            res.json({ configs: visible, grouped });
        } catch (err) {
            res.status(500).json({ error: 'Erro ao carregar configurações.' });
        }
    });

    // ─── PUT /api/pricing/business-config (ADMIN) ───────────

    const updateBusinessConfigSchema = z.object({
        configs: z.array(z.object({
            key: z.string().min(1),
            // A12: valor pode ser STRING VAZIA. Campos opcionais (SMTP: host/user/password/resend_api_key)
            // são legitimamente vazios; com `.min(1)` o PUT rejeitava o array inteiro ("Dados inválidos")
            // e NENHUMA seção de Configurações salvava no estado padrão (sem SMTP configurado).
            value: z.string(),
        })),
    });

    // Equipe: TUDO OU NADA por grupo (requiredForBusinessConfig) — se o lote tiver UMA chave de grupo não
    // permitido (ex.: email_smtp_host de quem só tem config.politicas), 403 com `deniedGroups` e NADA é
    // gravado. Chave fora do catálogo: vale o grupo da linha no banco (ex.: `schedule` do seed); sem linha →
    // "outros" → só ADMIN. Chaves aposentadas (DEPRECATED_CONFIG_KEYS) são ignoradas pelo handler e não contam.
    router.put('/business-config', authenticate, requireStaff(), async (req: Request, res: Response) => {
        try {
            const { configs } = updateBusinessConfigSchema.parse(req.body);

            const actor = await actorOrReply(req, res);
            if (!actor) return;
            if (!actor.isAdmin) {
                const keys = [...new Set(configs.map(c => c.key).filter(k => !DEPRECATED_CONFIG_KEYS.has(k)))];
                const outsideCatalog = keys.filter(k => !CONFIG_CATALOG_BY_KEY[k]);
                const dbGroups: Record<string, string> = {};
                if (outsideCatalog.length > 0) {
                    const dbRows = await prisma.businessConfig.findMany({
                        where: { key: { in: outsideCatalog } },
                        select: { key: true, group: true },
                    });
                    for (const r of dbRows) dbGroups[r.key] = r.group;
                }
                const rule = requiredForBusinessConfig(keys, dbGroups);
                const missing = missingRequirement(actor, rule.requirements);
                if (missing) {
                    const deniedGroups = Object.entries(rule.groups)
                        .filter(([, perm]) => !can(actor, perm))
                        .map(([group]) => group)
                        .sort();
                    res.status(403).json({
                        error: PERMISSION_DENIED_MESSAGE,
                        code: 'PERMISSION_DENIED',
                        permission: missing,
                        deniedGroups,
                    });
                    return;
                }
            }

            // Snapshot das taxas de gateway ANTES de aplicar (config atual no DB), para versionar mudanças.
            const feeBefore = new Map<string, FeeRate>();
            for (const fp of FEE_PROVIDERS) feeBefore.set(fp.provider, await currentFeeRate(fp));
            // O "depois" vem do próprio payload (dentro da transação o getConfig não veria escritas ainda
            // não commitadas). Fee keys não são secret nem deprecated, então o valor submetido é o que grava.
            const submitted = new Map(configs.map(c => [c.key, c.value]));

            // Config + histórico de taxas gravam JUNTOS (atômico): se o histórico falhar, a mudança de
            // config reverte também — o próximo retry recomeça com o "before" antigo intacto e versiona certo.
            await prisma.$transaction(async (tx) => {
                for (const { key, value } of configs) {
                    if (DEPRECATED_CONFIG_KEYS.has(key)) continue; // ignore retired keys

                    // Secrets: skip when the admin left the masked placeholder / blank (keep existing),
                    // otherwise encrypt at rest before persisting.
                    let storeValue = value;
                    if (EMAIL_SECRET_KEYS.has(key)) {
                        if (isBlankOrMasked(value)) continue;
                        storeValue = encryptCredentials(value);
                    }

                    // Upsert so editing a catalog key that isn't persisted yet creates it
                    // (with its catalog metadata) instead of failing.
                    const meta = CONFIG_CATALOG_BY_KEY[key];
                    await tx.businessConfig.upsert({
                        where: { key },
                        update: { value: storeValue },
                        create: {
                            key,
                            value: storeValue,
                            type: meta?.type ?? 'string',
                            label: meta?.label ?? key,
                            group: meta?.group ?? 'outros',
                        },
                    });
                }

                // Versiona na linha do tempo cada taxa de gateway que mudou. A taxa dos pagamentos passados
                // fica preservada: o relatório resolve pela data de pagamento (ver GatewayFeeHistory).
                for (const fp of FEE_PROVIDERS) {
                    const before = feeBefore.get(fp.provider)!;
                    const after: FeeRate = {
                        pct: submittedNumber(submitted, fp.pctKey, before.pct),
                        fixedCents: submittedNumber(submitted, fp.fixedKey, before.fixedCents),
                    };
                    if (after.pct === before.pct && after.fixedCents === before.fixedCents) continue;
                    const hasHistory = await tx.gatewayFeeHistory.findFirst({ where: { provider: fp.provider as any } });
                    if (!hasHistory) {
                        // 1ª mudança deste provider: grava o valor ANTIGO com vigência retroativa (epoch),
                        // para que os pagamentos já existentes continuem com a taxa que valia até agora.
                        await tx.gatewayFeeHistory.create({
                            data: { provider: fp.provider as any, feePct: before.pct, feeFixedCents: before.fixedCents, effectiveFrom: new Date(0) },
                        });
                    }
                    await tx.gatewayFeeHistory.create({
                        data: { provider: fp.provider as any, feePct: after.pct, feeFixedCents: after.fixedCents, effectiveFrom: new Date() },
                    });
                }
            });

            // Cache invalidado só APÓS o commit — se a transação falhar, a config não mudou e o cache velho vale.
            invalidateConfigCache();

            res.json({ message: 'Configurações atualizadas com sucesso!' });
        } catch (err) {
            if (err instanceof z.ZodError) {
                res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
                return;
            }
            res.status(500).json({ error: 'Erro ao salvar configurações.' });
        }
    });

    // ─── GET /api/pricing/business-config/fee-history (só ADMIN: config.taxas) ───
    // Linha do tempo das taxas de gateway: cada mudança com a data em que passou a valer.
    router.get('/business-config/fee-history', authenticate, requireAdmin(), async (_req: Request, res: Response) => {
        try {
            const rows = await prisma.gatewayFeeHistory.findMany({ orderBy: { effectiveFrom: 'asc' } });
            const history: Record<string, { effectiveFrom: string; feePct: number; feeFixedCents: number }[]> = {};
            const current: Record<string, FeeRate> = {};
            for (const fp of FEE_PROVIDERS) {
                history[fp.provider] = rows
                    .filter(r => r.provider === fp.provider)
                    .map(r => ({ effectiveFrom: r.effectiveFrom.toISOString(), feePct: r.feePct, feeFixedCents: r.feeFixedCents }));
                current[fp.provider] = await currentFeeRate(fp);
            }
            res.json({ history, current });
        } catch (err) {
            res.status(500).json({ error: 'Erro ao carregar o histórico de taxas.' });
        }
    });

    // ─── POST /api/pricing/business-config/email/test (só ADMIN: config.email) ──
    // Sends the configured OTP e-mail (code 123456) to validate the provider setup.
    const emailTestSchema = z.object({
        to: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail inválido'),
    });

    router.post('/business-config/email/test', authenticate, requireAdmin(), async (req: Request, res: Response) => {
        try {
            const { to } = emailTestSchema.parse(req.body);
            await deliverOtpEmail(to, 'Teste', '123456');
            res.json({ success: true, message: `E-mail de teste enviado para ${to}.` });
        } catch (err) {
            if (err instanceof z.ZodError) {
                res.status(400).json({ success: false, error: 'E-mail inválido.' });
                return;
            }
            console.error('[CONFIG] email test error:', err);
            res.status(500).json({ success: false, error: getErrorMessage(err) || 'Falha ao enviar e-mail de teste.' });
        }
    });
}
