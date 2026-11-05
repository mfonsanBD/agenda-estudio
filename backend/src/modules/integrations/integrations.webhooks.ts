// ─── Cora Webhook Management Routes (ADMIN) ─────────────
// Register/list/delete Cora webhook endpoints

import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireAdmin } from '../../middleware/permissions.js';
import { coraListWebhookEndpoints, coraRegisterWebhookEndpoint, coraDeleteWebhookEndpoint } from '../../lib/coraService.js';
import { sicoobRegisterWebhook, sicoobGetWebhook, sicoobDeleteWebhook, sicoobAllowedEnvironment } from '../../lib/sicoobService.js';

export function registerIntegrationWebhookRoutes(router: Router) {

/** GET /api/integrations/cora/webhooks — list registered webhooks */
router.get('/cora/webhooks', requireAdmin(), async (_req: Request, res: Response) => {
    try {
        const endpoints = await coraListWebhookEndpoints();
        res.json({ endpoints });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Erro desconhecido';
        res.status(500).json({ error: `Falha ao listar webhooks Cora: ${msg}` });
    }
});

/** POST /api/integrations/cora/webhooks — register a webhook */
router.post('/cora/webhooks', requireAdmin(), async (req: Request, res: Response) => {
    try {
        const { url } = req.body;
        if (!url || typeof url !== 'string') {
            res.status(400).json({ error: 'Campo "url" é obrigatório.' });
            return;
        }
        const endpoint = await coraRegisterWebhookEndpoint(url);
        res.json({ message: 'Webhook registrado com sucesso na Cora!', endpoint });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Erro desconhecido';
        res.status(500).json({ error: `Falha ao registrar webhook Cora: ${msg}` });
    }
});

/** DELETE /api/integrations/cora/webhooks/:id — delete a webhook */
router.delete('/cora/webhooks/:id', requireAdmin(), async (req: Request, res: Response) => {
    try {
        await coraDeleteWebhookEndpoint(req.params.id as string);
        res.json({ message: 'Webhook removido da Cora.' });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Erro desconhecido';
        res.status(500).json({ error: `Falha ao remover webhook Cora: ${msg}` });
    }
});

// ─── Sicoob Webhook (ADMIN) — 1 webhook por chave PIX ────
// A URL de registro vem do PAINEL (window.location.origin — a origem PÚBLICA real que o admin está
// usando), NÃO de BACKEND_URL, para (a) bater com o que a caixa exibe e (b) evitar registrar um host
// interno/dev inalcançável pelo Sicoob. Enviamos SEM o path /pix — o Sicoob acrescenta /pix ao notificar.
// Registrar exige mTLS autenticado → feito pelo backend.

/** Trava por deploy: bloqueia com mensagem CLARA se o ambiente ativo != o permitido por este servidor
 *  (senão a rota daria só "não configurada"). Retorna true se já respondeu (bloqueado). */
async function sicoobWebhookBlockedByEnv(res: Response): Promise<boolean> {
    const integration = await prisma.integrationConfig.findUnique({ where: { provider: 'SICOOB' } });
    if (!integration) { res.status(400).json({ error: 'Integração Sicoob não configurada. Salve as credenciais primeiro.' }); return true; }
    const stored = integration.environment === 'production' ? 'production' : 'sandbox';
    const allowed = sicoobAllowedEnvironment();
    if (stored !== allowed) {
        res.status(400).json({ error: `Ambiente ativo "${stored}" não é permitido neste servidor (${allowed === 'production' ? 'produção' : 'desenvolvimento/homologação'}). Ajuste o ambiente ativo do Sicoob para "${allowed}" e salve antes de registrar o webhook.` });
        return true;
    }
    return false;
}

/** GET /api/integrations/sicoob/webhook — consulta o webhook registrado na chave PIX */
router.get('/sicoob/webhook', requireAdmin(), async (_req: Request, res: Response) => {
    if (await sicoobWebhookBlockedByEnv(res)) return;
    try {
        const webhook = await sicoobGetWebhook();
        res.json({ webhook });
    } catch (err: unknown) {
        res.status(500).json({ error: `Falha ao consultar webhook Sicoob: ${err instanceof Error ? err.message : 'Erro desconhecido'}` });
    }
});

/** POST /api/integrations/sicoob/webhook — registra a URL (a origem pública, sem /pix) enviada pelo painel */
router.post('/sicoob/webhook', requireAdmin(), async (req: Request, res: Response) => {
    if (await sicoobWebhookBlockedByEnv(res)) return;
    const { url } = req.body ?? {};
    let parsed: URL;
    try { parsed = new URL(String(url)); } catch { res.status(400).json({ error: 'URL do webhook inválida.' }); return; }
    // Aceita só http(s) e o path esperado — evita registrar um endpoint arbitrário por engano.
    if (!/^https?:$/.test(parsed.protocol) || !parsed.pathname.replace(/\/$/, '').endsWith('/api/webhooks/sicoob')) {
        res.status(400).json({ error: 'A URL do webhook deve ser http(s) e terminar em /api/webhooks/sicoob.' });
        return;
    }
    const cleanUrl = `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
    try {
        await sicoobRegisterWebhook(cleanUrl);
        res.json({ message: 'Webhook registrado no Sicoob!', url: `${cleanUrl}/pix` });
    } catch (err: unknown) {
        res.status(500).json({ error: `Falha ao registrar webhook Sicoob: ${err instanceof Error ? err.message : 'Erro desconhecido'}` });
    }
});

/** DELETE /api/integrations/sicoob/webhook — remove o webhook da chave PIX */
router.delete('/sicoob/webhook', requireAdmin(), async (_req: Request, res: Response) => {
    if (await sicoobWebhookBlockedByEnv(res)) return;
    try {
        await sicoobDeleteWebhook();
        res.json({ message: 'Webhook removido do Sicoob.' });
    } catch (err: unknown) {
        res.status(500).json({ error: `Falha ao remover webhook Sicoob: ${err instanceof Error ? err.message : 'Erro desconhecido'}` });
    }
});

}
