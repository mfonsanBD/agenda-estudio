# Documentação técnica

Referência para desenvolvedores que vão rodar, manter ou estender o sistema.

## Trilha sugerida

1. **[Arquitetura](arquitetura.md)** — visão geral, stack, monorepo e diagrama de contexto.
2. **[Setup de desenvolvimento](setup-dev.md)** — rodar local com Docker, variáveis de ambiente, portas e scripts.
3. **[Modelo de dados](modelo-de-dados.md)** — schema Prisma, modelos, enums, diagrama ER e ciclos de vida.
4. **[Referência da API](api.md)** — todos os endpoints por módulo.
5. **[Autenticação](autenticacao.md)** — JWT em cookies, OTP, Google, refresh e rate limits.
6. **[Pagamentos](pagamentos.md)** — Stripe (cartão) + Cora (PIX/boleto), efeitos de pagamento, reconciliação e webhooks.
7. **[Notificações](notificacoes.md)** — notificações computadas e persistidas, Web Push.
8. **[Jobs e tarefas agendadas](jobs-e-crons.md)** — os cronjobs e os locks distribuídos no Redis.
9. **[Deploy](deploy.md)** — build Docker multi-stage, Railway, variáveis de produção e limpeza de dados de teste.
10. **[Design system](design-system.md)** — tokens, paleta, modais (BottomSheetModal + size), utilities admin, regras de animação/acessibilidade e o checklist de padronização.
11. **[Equipe e permissões](permissoes-equipe.md)** — papel COLABORADOR, catálogo de permissões, regras por rota e por corpo, revogação de sessão, testes da matriz, deploy e runbook.

## Resumo da stack

| Camada | Tecnologia |
| --- | --- |
| Frontend | React 19, Vite 6, React Router 7, framer-motion, recharts, vite-plugin-pwa |
| Backend | Node 22, Express 4, TypeScript 5.7 (ESM) |
| ORM/DB | Prisma 7 (cliente gerado e versionado) + PostgreSQL |
| Cache/locks | Redis (ioredis) |
| Pagamentos | Stripe (cartão) · Cora (PIX/boleto, mTLS) |
| Auth | JWT (cookies httpOnly) + OTP + Google OAuth |
| Push | web-push (VAPID) |
| Infra | Docker (multi-stage) · Railway |

## Convenções do código

- **Monorepo** npm workspaces: `backend/` e `frontend/`.
- **ESM** no backend — imports usam sufixo `.js` mesmo apontando para `.ts` (ex.: `import { config } from './config/index.js'`).
- **Cliente Prisma gerado** fica versionado em `backend/src/generated/prisma` (ver [modelo-de-dados.md](modelo-de-dados.md) para o motivo e o gotcha no Windows).
- **Dinheiro em centavos** em todo o backend (R$ 300,00 = `30000`).
