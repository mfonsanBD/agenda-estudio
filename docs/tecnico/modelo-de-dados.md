# Modelo de dados

Fonte de verdade: [`backend/prisma/schema.prisma`](../../backend/prisma/schema.prisma). Provider PostgreSQL; cliente gerado em `backend/src/generated/prisma` (versionado).

> **Dinheiro em centavos.** Todos os campos `Int` de valor (preço, amount) são em centavos: R$ 300,00 = `30000`.

## Diagrama ER (modelos centrais)

```mermaid
erDiagram
    User ||--o{ Contract : tem
    User ||--o{ Booking : tem
    User ||--o{ Payment : tem
    User ||--o{ SavedPaymentMethod : tem
    User ||--o{ PushSubscription : tem
    User ||--o{ Notification : tem
    Contract ||--o{ Booking : agrupa
    Contract ||--o{ Payment : gera
    Booking ||--o{ Payment : pode_ter
    Contract ||--o| Contract : renovado_de

    User {
        string id PK
        string email UK
        string name
        Role role
        string cpfCnpj UK
        string stripeCustomerId UK
        boolean autoChargeEnabled
        boolean essentialNotificationsOnly
        datetime deletedAt
    }
    Contract {
        string id PK
        string userId FK
        ContractType type
        Tier tier
        int durationMonths
        ContractStatus status
        int flexCreditsRemaining
        PaymentMethod paymentMethod
        string paymentPlan
    }
    Booking {
        string id PK
        string userId FK
        string contractId FK
        date date
        string startTime
        BookingStatus status
        Tier tierApplied
        int price
        boolean isLivestream
        string streamMetrics
        string statusReason
        MakeupStatus makeupStatus
        datetime makeupDeadline
        date missedDate
    }
    Payment {
        string id PK
        string userId FK
        string contractId FK
        string bookingId FK
        PaymentProvider provider
        int amount
        PaymentStatus status
        datetime dueDate
        datetime pixExpiresAt
    }
```

## Enums

| Enum | Valores |
| --- | --- |
| `Role` | `ADMIN`, `CLIENTE`, `COLABORADOR` (nov/2026 — equipe com permissões por módulo; ver [permissoes-equipe.md](permissoes-equipe.md)) |
| `ContractType` | `FIXO`, `FLEX`, `SERVICO`, `CUSTOM`, `AVULSO` |
| `Tier` | `COMERCIAL`, `AUDIENCIA`, `SABADO` |
| `BookingStatus` | `RESERVED`, `CONFIRMED`, `HELD`, `COMPLETED`, `FALTA`, `NAO_REALIZADO`, `CANCELLED` |
| `ContractStatus` | `ACTIVE`, `AWAITING_PAYMENT`, `EXPIRED`, `CANCELLED`, `PENDING_CANCELLATION`, `PAUSED`, `COMPLETED` |
| `MakeupStatus` | `OPEN`, `USED`, `EXPIRED` (janela de remarcação do avulso — ver Booking) |
| `PaymentProvider` | `STRIPE`, `CORA`, `SICOOB` |
| `PaymentStatus` | `PENDING`, `PAID`, `FAILED`, `REFUNDED`, `CANCELLED` |
| `PaymentMethod` | `CARTAO`, `PIX`, `BOLETO` |
| `NotificationType` | `CONTRACT_EXPIRING`, `PAYMENT_OVERDUE`, `PAYMENT_CONFIRMED`, `PAYMENT_FAILED`, `BOOKING_UNCONFIRMED`, `BOOKING_REMINDER`, `BOOKING_CONFIRMED`, `BOOKING_CANCELLED`, `CONTRACT_ACTIVATED`, `CONTRACT_RENEWED`*, `CANCELLATION_PENDING`, `FLEX_CREDITS_LOW`, `CLIENT_INACTIVE`*, `CONTRACT_AWAITING_PAYMENT`, `SYSTEM`* |

> *`CONTRACT_RENEWED`, `CLIENT_INACTIVE` e `SYSTEM` foram **podados em jun/2026** — não são mais emitidos, mas seguem no enum para casar com o tipo no Postgres (remover exigiria migração com `--accept-data-loss`). Ver [notificacoes.md](notificacoes.md).

> `PaymentStatus.CANCELLED` ≠ `FAILED`: representa uma **parcela anulada** porque o contrato dela foi cancelado (não uma cobrança recusada).

> `ContractStatus.COMPLETED` ("Concluído", set/2026): não resta nada a fazer no contrato. É **automático** (`lib/contractCompletion.ts` → `syncContractCompletion`, chamado após toda transição de status de booking) e reversível: volta sozinho para `ACTIVE` quando a regra deixa de valer. Só alterna `ACTIVE ↔ COMPLETED`; nunca toca `PAUSED`/`PENDING_CANCELLATION`/`CANCELLED`/`AWAITING_PAYMENT`/`EXPIRED`, e `SERVICO` não entra. Regra: **AVULSO** — sessão `COMPLETED`, ou `FALTA` sem janela de remarcação aberta (sem justificativa, prazo `EXPIRED` ou 2ª falta); nunca com janela `OPEN` nem em `NAO_REALIZADO`. **FIXO/FLEX/CUSTOM** — nenhuma sessão `HELD`/`RESERVED`/`CONFIRMED`, houve consumo (`COMPLETED`/`FALTA`) e não resta crédito (`flexCreditsRemaining` / `customCreditsRemaining` / teto `durationMonths × sessions_per_month` do FIXO). Um plano concluído continua renovável pelo admin, recebe o aviso de "contrato expirando" e as parcelas pendentes seguem cobráveis (inclusive no auto-charge).

## Modelos

### User (`users`)
Conta de cliente ou da equipe (ADMIN/COLABORADOR; em equipe, `clientStatus = BLOCKED` = acesso desativado). O que é só da equipe fica em `StaffProfile` (abaixo). Campos principais: `email`/`phone`/`googleId` (todos únicos e opcionais — login por e-mail, telefone ou Google), `passwordHash`, `role`, `cpfCnpj` (necessário para PIX), `address`/`city`/`state`, `tags[]`, `socialLinks` (JSON), `clientStatus` (`ACTIVE`/`INACTIVE`/`BLOCKED`), `stripeCustomerId`, `autoChargeEnabled` (cobrança automática no cartão), `essentialNotificationsOnly` (só notificações críticas), `notes` (observações internas do admin), `deletedAt` (soft delete com anonimização do cliente que tem vínculos; `null` = conta ativa — os dados pessoais viram `null`, o que libera e-mail/CPF para um novo cadastro).

### Contract (`contracts`)
Plano contratado. Campos comuns: `name`, `type`, `tier`, `durationMonths` (3 ou 6), `discountPct` (30 ou 40), `startDate`/`endDate`, `status`, `addOns[]`, `paymentMethod`, `paymentPlan` (`MONTHLY` ou `FULL`), `boletoAllowed`.

- **FIXO:** `fixedDayOfWeek` (1=Seg…6=Sáb), `fixedTime` (`"14:00"`), `contractUrl`.
- **FLEX:** `flexCreditsTotal` (12 ou 24), `flexCreditsRemaining`, `flexCycleStart`, `flexWeeksCompensated` (adiantamento), `flexCreditsForfeited` (perdidos por atraso, monotônico), `flexForfeitFloor` (baseline para não punir retroativamente).
- **CUSTOM ("Monte Seu Plano"):** `customSchedule` (JSON de dias/horários), `sessionsPerWeek`/`sessionsPerCycle`/`totalSessions`, `addonCredits` (JSON), `accessMode` (`FULL`/`PROGRESSIVE`), `customCreditsRemaining`.
- **AVULSO:** micro-contrato de uma sessão, criado junto com o agendamento avulso: `durationMonths` 1, `discountPct` 0, `flexCreditsTotal` 1 / `flexCreditsRemaining` 0, `startDate` = `endDate` = dia da gravação e `paymentPlan` `FULL` (pagamento único). Avulsos antigos têm `endDate` = gravação + 30 dias e `MONTHLY`; as telas derivam vigência e plano do tipo, não desses campos.
- **Pausa/renovação:** `pausedAt`, `pauseReason`, `resumeDate`, `paymentDeadline`, `renewedFromId` (auto-relação para o contrato anterior).

Índices: `userId`, `endDate`.

### Booking (`bookings`)
Sessão de gravação. `date` (DATE), `startTime`/`endTime`, `status`, `tierApplied`, `price`, `adminNotes`/`clientNotes`, `originalDate` (âncora da janela de 7 dias para remarcação), `platforms`/`platformLinks` (JSON), `addOns[]`, `holdExpiresAt` (auto-cancelamento da reserva).

Métricas de transmissão (Fase 2): `durationMinutes`, `peakViewers`, `chatMessages`, `audienceOrigin`, `isLivestream`, `streamMetrics` (JSON por rede: `{"YOUTUBE":{"views","peak","likes","comments"},...}`; `peakViewers`/`chatMessages` são agregados derivados).

Operação da gravação: `recordingStartedAt`/`recordingStartedById`/`recordingStartedByName` (quem clicou "Iniciar Gravação") e `statusReason` (motivo de `FALTA`/`NAO_REALIZADO`).

Remarcação do avulso (set/2026 — `lib/avulsoMakeup.ts`): `makeupStatus` (`MakeupStatus`; `null` = sem janela, o que inclui FALTA sem justificativa e todo o legado), `makeupDeadline` (fim do dia D+N em São Paulo; N = `avulso_makeup_days`, padrão 7) e `missedDate` (D, a data da sessão perdida). A janela abre quando o admin justifica a FALTA, ou sozinha em `NAO_REALIZADO`. Vira `USED` quando a mesma reserva é remarcada (mesmo Payment) e `EXPIRED` pelo job quando o prazo passa. A remarcação é única.

Índices: `(date, startTime, status)`, `userId`, `contractId`, `date`, `status`, `(makeupStatus, makeupDeadline)`.

### Payment (`payments`)
Cobrança. `provider` (`STRIPE`/`CORA`/`SICOOB`), `providerRef` (id da transação no gateway), `amount`, `status`, `dueDate`, `pixString`/`boletoUrl`/`paymentUrl`, `pixExpiresAt` (validade do QR/cobrança PIX atual; `null` = registro antigo ou sem PIX), `installments`, `paymentType` (`DEBIT`/`CREDIT`), `stripeSubscriptionId`, `metadata` (JSON — guarda dados do contrato pendente, add-ons, etc.; `sessionCharge: true` marca a cobrança da própria sessão criada pelo `POST /bookings/admin`, e `fixoExtra: true`, junto dela, a sessão FIXO criada com o teto do plano já cheio — a única que não ocupa vaga do plano; ver [permissoes-equipe.md](permissoes-equipe.md#pagamento-da-sessão-e-teto-do-fixo)), `paidAt`. Na compra de serviço extra, `paymentUrl` guarda as chaves em JSON (`{ addonKeys: [...] }`); é por elas que o sistema distingue o extra da cobrança da gravação ([Pagamento da sessão](permissoes-equipe.md#pagamento-da-sessão-e-teto-do-fixo)). Relaciona-se a `user` e, opcionalmente, a `contract` e `booking`.

Índices: `userId`, `contractId`, `bookingId`, `providerRef`, `status`, `stripeSubscriptionId`, `dueDate`.

### Configuração e apoio
- **StaffProfile (`staff_profiles`, nov/2026):** 1:1 com `users` (`user_id` PK/FK, `ON DELETE CASCADE`), `title` (cargo, opcional) e `permissions` (`TEXT[]`, as chaves do COLABORADOR; o ADMIN grava `[]`). Migrations `20261104000000_add_role_colaborador` (só o `ALTER TYPE`) e `20261104000100_add_staff_profiles`.
- **SavedPaymentMethod (`saved_payment_methods`):** cartões salvos na Stripe (`stripePaymentMethodId`, `brand`, `last4`, `expMonth/Year`, `isDefault`).
- **BlockedSlot (`blocked_slots`):** horários bloqueados pelo admin (`date`, `startTime`, `endTime`, `reason`).
- **PricingConfig (`pricing_config`):** preço por `tier` (chave única), `label`, `description`.
- **AddOnConfig (`addon_config`):** serviços extras por `key` (`CORTES_IA`, `YOUTUBE_SEO`, ...), `price`, `monthly` (mensal vs. por gravação).
- **BusinessConfig (`business_config`):** parâmetros do negócio por `key` (`value`/`type`/`label`/`group`: `plans`/`policies`/`payments`).
- **PaymentMethodConfig (`payment_method_config`):** habilita/estiliza métodos (`PIX`/`CARTAO`/`BOLETO`), `active`, `sortOrder`, `accessMode`, `contexts` (CSV: `avulso,contract,invoice`).
- **IntegrationConfig (`integration_configs`):** credenciais (criptografadas) de `CORA`/`STRIPE`, `environment` (sandbox/production), `enabled`, status do último teste.
- **Notification (`notifications`):** `type`, `severity` (`critical`/`warning`/`info`), `title`/`message`, `entityType`/`entityId`, `actionUrl`, `read`, `pushSent`.
- **PushSubscription (`push_subscriptions`):** inscrição Web Push (`endpoint` único, `p256dh`, `auth`).
- **AuditLog (`audit_logs`):** trilha de auditoria (`entityType`, `entityId`, `action`, `changes` JSON, `performedBy`).

## Ciclo de vida do contrato

```mermaid
stateDiagram-v2
    [*] --> AWAITING_PAYMENT: criado (aguarda 1º pagamento)
    AWAITING_PAYMENT --> ACTIVE: pagamento confirmado
    AWAITING_PAYMENT --> CANCELLED: prazo de pagamento expirou
    ACTIVE --> PAUSED: pausado pelo admin
    PAUSED --> ACTIVE: retomado
    ACTIVE --> PENDING_CANCELLATION: cliente solicita cancelamento
    PENDING_CANCELLATION --> CANCELLED: admin resolve (multa/isenção)
    PENDING_CANCELLATION --> ACTIVE: cancelamento recusado
    ACTIVE --> COMPLETED: nada mais a fazer (automático)
    COMPLETED --> ACTIVE: sessão reaberta ou crédito devolvido (automático)
    ACTIVE --> EXPIRED: manual (admin)
    ACTIVE --> CANCELLED: cancelado pelo admin
    COMPLETED --> [*]
    EXPIRED --> [*]
    CANCELLED --> [*]
```

`EXPIRED` **não** é aplicado automaticamente ao chegar no `endDate`: hoje só o admin marca (PATCH `/api/contracts/:id`). O admin também pode marcar ou desmarcar `COMPLETED` à mão; a próxima transição de sessão recalcula.

## Ciclo de vida do agendamento

```mermaid
stateDiagram-v2
    [*] --> HELD: reservado aguardando pagamento (hold 10 min)
    HELD --> RESERVED: pago / criado pelo admin
    HELD --> CANCELLED: hold expirou
    RESERVED --> CONFIRMED: admin confirma (check-in)
    CONFIRMED --> COMPLETED: gravação concluída (métricas)
    RESERVED --> FALTA: cliente não compareceu
    CONFIRMED --> FALTA: cliente não compareceu
    CONFIRMED --> NAO_REALIZADO: estúdio não realizou
    FALTA --> CONFIRMED: avulso, falta justificada remarcada (mesma reserva)
    NAO_REALIZADO --> CONFIRMED: avulso, remarcada sem novo pagamento
    RESERVED --> CANCELLED: cancelado
    COMPLETED --> [*]
    FALTA --> [*]
    CANCELLED --> [*]
```

## Migrations e cliente gerado

- Migrations: `backend/prisma/migrations/`. Em dev: `npm run db:migrate` (`prisma migrate dev`). Em produção: `prisma migrate deploy` roda no start do container (ver [deploy.md](deploy.md)).
- Após mudar o `schema.prisma`, **regenere** o cliente: `npm run db:generate -w backend`. No Windows/monorepo, use `cd backend && node ../node_modules/prisma/build/index.js generate` (ver [setup-dev.md](setup-dev.md)).
- O cliente em `backend/src/generated/prisma` é **versionado** para builds reprodutíveis (Docker copia-o do estágio de build).
- Lote de 23/09/2026 (todas aditivas e idempotentes): `20260923000000_add_contract_completed_status` (enum `COMPLETED`), `20260923000100_add_user_deleted_at`, `20260923000200_add_booking_makeup_window` (enum `MakeupStatus`, 3 colunas e índice), `20260923000300_add_payment_pix_expires_at` e `20260923000400_backfill_avulso_completed`. Esta última é migration de **dados**: passa para `COMPLETED` os avulsos `ACTIVE` já gravados ou perdidos, com a mesma regra do `syncContractCompletion`. Fica separada da do enum porque o Postgres não deixa usar um valor de enum novo na mesma transação.

## Relacionado

- [API](api.md) · [Pagamentos](pagamentos.md) · [Notificações](notificacoes.md)
