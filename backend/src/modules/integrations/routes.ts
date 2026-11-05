// ─── Integration Management Routes (ADMIN) ─────────────
// CRUD for payment provider configurations (Cora, Stripe)
// Stores credentials in IntegrationConfig table

import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireStaff } from '../../middleware/permissions.js';
import { registerIntegrationRoutes } from './integrations.crud.js';
import { registerIntegrationWebhookRoutes } from './integrations.webhooks.js';

const router = Router();

// Router 100% administrativo (crítica E4): login de EQUIPE em tudo que chega aqui. Cada rota exige
// ainda requireAdmin() — credenciais Stripe/Sicoob/Cora e webhooks são exclusivos do ADMIN
// (config.integracoes): quem mexe aqui redireciona recebimentos.
router.use(authenticate, requireStaff());

// CRUD routes first: GET / (static), then :provider param routes
registerIntegrationRoutes(router);

// Cora webhook management routes after (literal /cora/webhooks paths)
registerIntegrationWebhookRoutes(router);

export default router;
