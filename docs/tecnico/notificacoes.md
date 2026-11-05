# Notificações

O sistema combina notificações **computadas** (calculadas em tempo real a partir dos dados) e **persistidas** (gravadas na tabela `notifications` por jobs/efeitos). Endpoint principal: `GET /api/notifications` ([routes](../../backend/src/modules/notifications/routes.ts)).

## Dois tipos

### Computadas (tempo real)
Geradas a cada requisição de `GET /api/notifications`, sem persistir. Filtram por papel: a equipe vê os alertas de todos os clientes, cada bloco conforme a permissão do evento (o ADMIN vê todos; o COLABORADOR só os de `STAFF_EVENT_PERMISSIONS` que ele tem — ver [Avisos para a equipe](#avisos-para-a-equipe-nov2026)); o cliente vê só os seus:

| Origem | Tipo | Severidade |
| --- | --- | --- |
| Contratos expirando (≤7d admin / ≤15d cliente) — `ACTIVE` ou `COMPLETED` (lembrete de renovação), **nunca AVULSO** | `CONTRACT_EXPIRING` | warning / critical (≤2d) |
| Pagamentos vencidos (`PENDING` com `dueDate` no passado) — para o cliente, sem as parcelas bloqueadas por cancelamento em análise (abaixo) | `PAYMENT_OVERDUE` | warning / critical (>7d) |
| Pagamentos com cartão recusados (`FAILED`, provider Stripe) — mesma exceção | `PAYMENT_OVERDUE` | critical |
| Sessões não confirmadas **de hoje** (`RESERVED`) | `BOOKING_UNCONFIRMED` | critical |
| Contratos em cancelamento pendente | `CANCELLATION_PENDING` | warning |
| Contratos aguardando pagamento | `CONTRACT_AWAITING_PAYMENT` | warning / critical (prazo curto) |

### Persistidas (DB)
Gravadas por jobs e por `paymentEffects` (ex.: `PAYMENT_CONFIRMED`, `CONTRACT_ACTIVATED`, `BOOKING_REMINDER`, sinais de crédito Flex). São lidas junto com as computadas; há **deduplicação** por `(type, entityId)` para não repetir uma computada que também exista persistida.

## Severidades e ordenação

Severidade é `critical` | `warning` | `info`. A lista é ordenada por **não lidas primeiro** e depois por severidade (critical → warning → info). O resumo retorna contagens por severidade e total de não lidas (usado no badge do sino).

## Web Push

- Chave pública via `GET /api/push/vapid-key`; inscrição em `POST /api/push/subscribe` (guarda `endpoint`/`p256dh`/`auth` em `PushSubscription`).
- O job `pushNotificationJob` (a cada 5 min) envia as notificações persistidas ainda não enviadas (`pushSent=false`) via `web-push` (VAPID). Ver [jobs-e-crons.md](jobs-e-crons.md). Contas BLOCKED ou excluídas (de qualquer papel) ficam fora da rodada; para a equipe, os alertas calculados seguem a mesma regra de permissão do sino.
- Desativar um membro na tela Equipe apaga as `push_subscriptions` dele; o logout do app cancela a inscrição do aparelho (`DELETE /api/push/unsubscribe`), e um fim de sessão forçado desliga o push só no aparelho (localmente).
- O service worker ([`frontend/src/sw.ts`](../../frontend/src/sw.ts)) exibe a notificação nativa e, ao clicar, abre a `actionUrl`.
- Usuários com `essentialNotificationsOnly=true` recebem **apenas** notificações críticas.

## Poda (jun/2026)

Para reduzir ruído com o sistema já maduro:

- **Removidos** os blocos computados `FLEX_CREDITS_LOW` (variante *info*, ≤2 créditos) e `CLIENT_INACTIVE`. Os sinais Flex relevantes (crédito perdido = critical; "grave esta semana" = warning) continuam vindo dos jobs como linhas persistidas.
- `BOOKING_UNCONFIRMED` passou a considerar **apenas o dia de hoje** — a véspera já é coberta pelo lembrete de 24h (`BOOKING_REMINDER`), evitando notificação dupla. Ressalva: sessões marcadas com menos de 24h de antecedência não recebem o lembrete de véspera (ver abaixo).
- Os valores de enum `CONTRACT_RENEWED` e `CLIENT_INACTIVE` **não são mais produzidos**, mas permanecem no enum do Postgres (remover exigiria migração com `--accept-data-loss`). Ver [modelo-de-dados.md](modelo-de-dados.md). `SYSTEM` voltou a ser usado em set/2026 pelos alertas `admin_payment_on_cancelled_charge` e `admin_card_double_charge` (abaixo).

## Lembretes de sessão (24h / 2h)

Decisão do dono (set/2026), que reverte o "nunca amanhã" anterior:

- **24h:** enviado **exatamente** 24h antes (mesmo horário, na véspera), com `{diaLabel}` = `amanhã (DD/MM)`.
- **2h:** enviado **exatamente** 2h antes, com `{diaLabel}` = `hoje (DD/MM)`.
- O rótulo vem de `spDayLabel` (`lib/spTime.ts`), sempre no **calendário SP** (entre 21h e meia-noite SP o dia UTC já virou): 0 dia → `hoje`, 1 dia → `amanhã`, outros → `<dia da semana> (DD/MM)` (fallback; o job não envia nesses casos). O job só envia o 24h se a sessão for "amanhã" no SP e o 2h se for "hoje".
- **Marcações tardias:** sessão criada depois do vencimento (com <24h de antecedência — possível, `booking_min_advance_hours` = 12) **não** recebe o de 24h (nunca sai atrasado); recebe o aviso das 7h do dia e o de 2h (se marcada com ≥2h). Vale também para reagendamentos que caiam a <24h.
- A "Prévia" e o "Enviar teste" do admin usam o exemplo **por evento** do catálogo: 24h → `amanhã (16/09)`, 2h → `hoje (16/09)`, `computed_booking_unconfirmed_admin` → `hoje` (valor usado em runtime).
- Overrides de template (`notification_templates`) não devem escrever "amanhã"/"hoje" literal ao lado de `{diaLabel}` (ficaria "amanhã amanhã (16/09)").
- Detalhes do agendamento (1 min alinhado, last-run, catch-up ≤60 min, dedup) em [jobs-e-crons.md](jobs-e-crons.md).

## Aviso das 7h (confirmação do dia)

O `dailyConfirmationJob` roda a cada 30 min e só age às 7h de São Paulo (uma vez por dia, com dedup por sessão). Para cada sessão do dia em `RESERVED` ou `CONFIRMED`, avisa o cliente: `daily_confirmation_paid` ("Gravação confirmada") se a sessão está paga, senão `daily_confirmation_unpaid` ("Pague para confirmar", link `/meus-pagamentos`).

"Paga" (`isBookingPaid`; nov/2026, a mesma regra do `/confirm`, em `modules/bookings/sessionPayment.ts`):
1. **Sessão com cobrança própria** (Payment com a marca `metadata.sessionCharge`: SERVIÇO, FIXO extra, avulso ou sessão cobrada pela equipe) **em aberto ou paga**: só quando essa cobrança está paga (nenhuma marcada PENDING/FAILED e uma marcada PAID). Nem um extra pago nem o contrato em dia a substituem. Com a marcada só anulada ou estornada (por quem tem a baixa), não há nada a pagar: valem as regras 3 e 4 (conserto 5 — antes o aviso dizia "Pague para confirmar" e levava a uma tela sem cobrança).
2. Sem a marca: o pagamento **da gravação** PAID (o avulso pago pelo cliente). A compra de um serviço extra não conta.
3. Avulso sem pagamento da gravação: só se a reserva está `CONFIRMED` ou se a cobrança marcada dela foi só anulada ou estornada (nada a pagar; rodada 7 — TELA6-02: o avulso Reservado do balcão perdoado por quem tem a baixa recebia "Pague para confirmar" com "Meus pagamentos" vazio). Sem a marca (avulso do próprio cliente), só `CONFIRMED`.
4. Sessão de plano: contrato `ACTIVE` sem parcela PENDING vencida (cobranças do contrato sem `bookingId`).

## Remarcação do avulso (set/2026)

Eventos persistidos da janela de remarcação sem novo pagamento (FALTA justificada / NÃO REALIZADO — `lib/avulsoMakeup.ts` e `jobs/avulsoMakeupExpiryJob.ts`). Reusam `NotificationType` existentes (sem migration). Variáveis novas: `{prazo}` (último dia, DD/MM) e `{novaData}`.

| eventKey | Público | Tipo | Severidade | Quando |
| --- | --- | --- | --- | --- |
| `avulso_makeup_opened` | cliente | `BOOKING_REMINDER` | warning | Admin justifica a falta ou marca "Não realizado" (janela abre; só com a cobrança da gravação paga — um extra pago não conta) |
| `avulso_makeup_reminder` | cliente | `BOOKING_REMINDER` | critical | Nos 2 últimos dias da janela, no máximo 1 por dia SP |
| `avulso_makeup_expired` | cliente | `BOOKING_CANCELLED` | critical | Janela de FALTA expirou: valor perdido, contrato concluído |
| `avulso_makeup_expired_studio` | cliente | `BOOKING_REMINDER` | critical | Janela de NÃO REALIZADO expirou: valor garantido, o estúdio entra em contato |
| `admin_makeup_expired_studio` | equipe (`agendamentos.faltas`) | `BOOKING_UNCONFIRMED` | critical | Idem, para a equipe resolver. Link por destinatário: `/admin/contracts/:id` para quem vê contratos (inclusive o ADMIN), `/admin/bookings` para quem só registra faltas |
| `admin_makeup_rescheduled` | equipe (`hoje.ver`) | `BOOKING_CONFIRMED` | info | A gravação perdida foi remarcada (pelo cliente ou pela equipe; quem remarcou não recebe) |

Lembrete e expirações são `critical` para chegar também a quem escolheu "só essenciais". A dedup usa `dedupKey` com o id do booking (e o do destinatário nos eventos da equipe); o lembrete diário tem ainda uma marca Redis própria (`makeup:reminded:<booking>:<dia SP>`, TTL 36h), porque a dedup de 6h dos `critical` sozinha deixaria sair até 4 lembretes no mesmo dia com o job de hora em hora.

## Cancelamento de contrato e multa (set/2026)

Eventos persistidos do cancelamento (E13 — `contract.lifecycle.ts`, `lib/cancellationFine.ts`, `lib/paymentEffects.ts`). Sem migration: os três primeiros reusam o tipo `CANCELLATION_PENDING`; o quarto usa `SYSTEM`. Todos saem com push por padrão e são editáveis em **Avisos** (os dois da equipe, só pelo ADMIN). Variáveis novas: `{percentual}` (% da multa) e `{base}` (o que faltava pagar do plano).

| eventKey | Público | Tipo | Severidade | Link | Quando |
| --- | --- | --- | --- | --- | --- |
| `contract_cancellation_fine` | cliente | `CANCELLATION_PENDING` | critical | `/meus-pagamentos` | O admin conclui o pedido com "Cobrar multa": informa `{valor}`, `{percentual}` e `{base}` da cobrança criada (`metadata.kind = 'CANCELLATION_FINE'`) |
| `contract_cancelled_no_fine` | cliente | `CANCELLATION_PENDING` | critical | `/meus-contratos` | Contrato cancelado sem multa: isenção, pedido sem saldo a pagar, ou cancelamento feito pelo estúdio (DELETE / PATCH `CANCELLED`) |
| `admin_cancellation_requested` | equipe (`contratos.multa`) | `CANCELLATION_PENDING` | warning | `/admin/contracts` | O cliente pede o cancelamento: aviso imediato com a multa prevista, um por destinatário |
| `admin_payment_on_cancelled_charge` | equipe (`financeiro.ver`) | `SYSTEM` | critical | `/admin/finance` | O provedor confirma o pagamento de uma cobrança já `CANCELLED` (parcela anulada): o dinheiro entrou e precisa de estorno ou baixa manual |

- **Cliente**: os dois avisos são `critical` para chegar também a quem escolheu "só essenciais" (é cobrança nova ou fim do contrato). O da multa aponta para a cobrança (`entityType PAYMENT`); o sem multa, para o contrato e usa a dedup padrão (usuário + tipo + contrato, 6 h) — cancelar, reabrir e cancelar de novo nesse intervalo não reenvia.
- **`admin_cancellation_requested`** tem o mesmo tipo e entidade do alerta computado "Cancelamento pendente": no sino aparece uma linha só enquanto o pedido está em análise (a computada sombreia a persistida); a persistida existe para o push imediato. `dedupKey` = `cancel-request:<contrato>:<momento do pedido>:<destinatário>` (um aviso por pedido). As linhas são removidas (de ADMIN e COLABORADOR) quando o pedido é resolvido ou o contrato é reaberto.
- **`admin_payment_on_cancelled_charge`** sai uma vez por cobrança: marca `PAID_AFTER_CANCELLED` em `audit_logs` (entidade `PAYMENT`) + `dedupKey` `paid-on-cancelled:<pagamento>:<admin>`. Origens: webhook e conciliação do Sicoob, varredura do cron de 2 min (só produção), webhooks do Stripe e da Cora, e a anulação de parcelas quando o provedor já tinha recebido.
- Enquanto o pedido está em análise, o cliente não consegue pagar parcelas do plano (409 `CANCELLATION_PENDING` — ver [pagamentos.md](pagamentos.md) e [api.md](api.md)); não há notificação para esse bloqueio.
- **Sem lembrete de parcela que não dá para pagar**: em `GET /api/notifications`, os alertas computados do **cliente** "Você tem faturas vencidas" e "Pagamento com cartão falhou" ignoram as parcelas do plano de um contrato em `PENDING_CANCELLATION` — a mesma regra das rotas de pagamento (`planPaymentBlockedByPendingCancellation`, em `lib/cancellationPending.ts`). Extras de gravação (`bookingId`) e a multa de cancelamento continuam avisando, e parcelas de outros contratos do mesmo cliente também. O alerta da **equipe** não muda (ela pode cobrar). Se o admin reabrir o contrato, o aviso volta. O **push** de faturas vencidas (`pushNotificationJob.computeUserEvents`) aplica o mesmo filtro. Os extras das gravações que o próprio pedido cancelou são anulados no pedido (ver [pagamentos.md](pagamentos.md)) e, portanto, também não avisam.
- **"Cobrança expirada"** (`payment_expired`): o texto padrão ao cliente não cita a forma de pagamento ("Sua cobrança foi cancelada ou expirou. Gere uma nova em Meus Pagamentos.") — com o boleto desligado (E3) ele não aparece em lugar nenhum. Um modelo já personalizado no painel continua valendo até "restaurar padrão".

## Cobrança em dobro no cartão (set/2026)

Rede de segurança da cobrança automática (Z1-c — `alertDoubleCardCharge` em `jobs/autoChargeJob.ts`). Tipo `SYSTEM`, sem migration; push por padrão; editável em **Avisos** (só pelo ADMIN: é aviso da equipe). Variáveis novas: `{piPago}` (PaymentIntent que deu a baixa) e `{piExtra}` (o PaymentIntent a estornar).

| eventKey | Público | Tipo | Severidade | Link | Quando |
| --- | --- | --- | --- | --- | --- |
| `admin_card_double_charge` | equipe (`financeiro.ver`) | `SYSTEM` | critical | `/admin/finance` | Um segundo PaymentIntent foi aprovado para uma cobrança que já estava `PAID` por outro (ex.: a cobrança automática quitou a parcela e o cliente confirmou depois um checkout de cartão que tinha ficado aberto): o cliente foi debitado duas vezes; a mensagem traz cliente, valor, contrato e os dois PIs e manda estornar `{piExtra}` no painel do Stripe |

- Sai **uma vez por PaymentIntent excedente**: marca `DOUBLE_CARD_CHARGE` em `audit_logs` (entidade `PAYMENT`, `changes` com os dois PIs e o valor) + `dedupKey` `double-card-charge:<PI excedente>:<destinatário>`. Webhook reentregue, ou o job e o webhook do mesmo PI, não repetem o aviso; um terceiro PI aprovado é outro débito e avisa de novo.
- Origens: webhook `payment_intent.succeeded` de uma cobrança já `PAID` cujo `providerRef` é **outro** PaymentIntent (o mesmo PI da baixa não avisa), e o `autoChargeJob` quando, ao cancelar o PaymentIntent anterior da parcela recém-quitada, o Stripe responde que ele já tinha aprovado. Recebem os ADMIN e os COLABORADOR com `financeiro.ver` ativos (nunca BLOCKED nem excluídos); o cliente não é avisado.
- A cobrança continua `PAID` pelo PI da baixa: o estorno é manual no Stripe. Cobrança paga por outro meio (PIX/boleto) com um cartão aprovado depois não gera este aviso — só log `[Webhook:Stripe][SECURITY]`.

## Avisos para a equipe (nov/2026)

Com o papel COLABORADOR, os eventos de audiência `admin` passaram a ser **avisos da equipe**. Tabela completa (evento → permissão → link) em [permissoes-equipe.md](permissoes-equipe.md#avisos-para-a-equipe).

- **Quem recebe**: os fan-outs persistidos usam `getStaffRecipientIds('<evento>')` (`lib/staffRecipients.ts`) no lugar de `findMany({ role: 'ADMIN' })`: ADMIN ativos + COLABORADOR ativos com **qualquer uma** das permissões do evento (`STAFF_EVENT_PERMISSIONS`). Conta BLOCKED ou excluída nunca recebe (antes um ADMIN bloqueado recebia). Evento sem mapeamento → só ADMIN. Se a leitura de `staff_profiles` falhar, segue só para os ADMIN.
- **Sino**: `GET /api/notifications` e `PATCH /read-all` leem o ator do banco (`actorOrReply`). Cada bloco calculado da equipe só roda se o ator vê o evento (sem a permissão, nem consulta o banco). O COLABORADOR deixa de ver o aviso **guardado** cujo `actionUrl` aponta para uma tela que ele não abre mais (`/admin/today` → `hoje.ver`, `/admin/bookings` → `agendamentos.ver`, `/admin/clients` → `clientes.ver`, `/admin/contracts` → `contratos.ver`, `/admin/finance` → `financeiro.ver`); o `read-all` marca só os calculados que ele vê.
- **Links**: contrato expirando e contrato aguardando pagamento → `/admin/contracts/:id` (antes `/admin/clients/:id`, que exigia `clientes.ver`), no sino e no push; `admin_makeup_expired_studio` → link por destinatário (tabela acima).
- **Push job**: ignora BLOCKED/excluídos de qualquer papel; para o COLABORADOR lê as permissões do banco (falha → sem push para ele naquela rodada) e aplica a mesma regra do sino.
- **Catálogo**: os 13 eventos da equipe se chamam "Equipe — …" e a descrição diz quem recebe ("Avisa os administradores e quem da equipe …"). Na tela Avisos, o grupo aparece como "Equipe".
- **Modelos**: `avisos.modelos` vale só para os avisos dos **clientes**. Os modelos dos avisos da equipe só o ADMIN edita, desliga, restaura e testa (`PUT`/`DELETE /admin/templates/:eventKey` e `POST …/test` → 403 `permission: 'ADMIN'` para o colaborador), e o `GET /admin/events` não os devolve ao colaborador.
- **Aviso manual (broadcast)**: lista de ids só de CLIENTES não excluídos (400 `INVALID_RECIPIENTS` com `invalidIds`, nada é enviado — vale também para o ADMIN).

## UI

No frontend, o sino ([`frontend/src/components/NotificationBell.tsx`](../../frontend/src/components/NotificationBell.tsx)) renderiza a lista como **dropdown no desktop** e como **bottom-sheet no mobile** (≤768px). Detalhes de uso em [guia-cliente/notificacoes-e-pwa.md](../guia-cliente/notificacoes-e-pwa.md).

## Relacionado

- [Jobs e crons](jobs-e-crons.md) · [Modelo de dados](modelo-de-dados.md) · [API](api.md)
