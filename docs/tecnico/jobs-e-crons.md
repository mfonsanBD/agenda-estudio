# Jobs e tarefas agendadas

Os cronjobs são registrados no boot do servidor em [`backend/src/index.ts`](../../backend/src/index.ts) via `setInterval` e ficam em [`backend/src/jobs/`](../../backend/src/jobs/) (a reconciliação Cora vive em `lib/`).

## Locks distribuídos (Redis)

Cada execução tenta adquirir um lock no Redis com `SET <chave> running EX <ttl> NX`. Se o lock já existe, a execução é pulada. Isso evita que **múltiplas instâncias** (ou execuções sobrepostas) rodem o mesmo job em paralelo. O lock é liberado no `finally`.

## Jobs registrados

| Job | Arquivo | Intervalo | Lock (chave / TTL) | Função |
| --- | --- | --- | --- | --- |
| Limpeza de holds | `cleanExpiredHolds.ts` | 60s | `cron:hold-cleanup:lock` / 50s | Remove bookings `HELD` e contratos `AWAITING_PAYMENT` cuja reserva expirou (concilia/cancela a cobrança no provedor antes) |
| Push de notificações | `pushNotificationJob.ts` | 5 min | `cron:push-notif:lock` / 280s | Envia notificações pendentes via Web Push |
| Lembretes de sessão | `bookingReminderJob.ts` | 1 min, alinhado ao minuto (+1x no boot) | `cron:booking-reminder:lock` / 55s | Lembra exatamente 24h ("amanhã (DD/MM)") e 2h ("hoje (DD/MM)") antes; catch-up ≤60 min; sem 24h para sessões marcadas com <24h |
| Aviso das 7h | `dailyConfirmationJob.ts` | 30 min (+1x no boot); só age às 7h SP | `cron:daily-confirm:lock` / 280s | Avisa o cliente de cada sessão do dia: "Gravação confirmada" ou "Pague para confirmar" (regras de "paga" em [notificacoes.md](notificacoes.md#aviso-das-7h-confirmação-do-dia)) |
| Expiração de crédito Flex | `flexCreditExpiryJob.ts` | 6h (+1x no boot) | `cron:flex-credit-expiry:lock` / 1500s | Perde crédito semanal quando a janela fecha atrasada |
| Remarcação do avulso | `avulsoMakeupExpiryJob.ts` | 1h (+1x no boot) | `cron:avulso-makeup:lock` / 1500s | Expira janelas de remarcação vencidas (falta justificada / não realizada) e lembra nos 2 últimos dias |
| Limpeza de notificações | `notificationCleanupJob.ts` | diário (+1x no boot) | `cron:notif-cleanup:lock` / 3600s | Remove notificações antigas |
| Reconciliação Cora | `lib/coraReconciliation.ts` | 2 min (+1x no boot) | `cron:cora-reconcile:lock` / 110s | Confirma PIX/boleto pagos cujo webhook não chegou |
| Cobrança automática | `autoChargeJob.ts` | diário (+1x no boot) | `cron:auto-charge:lock` / 1800s | Cobra cartões salvos (off-session) para parcelas vencidas |

## Detalhes

- **Limpeza de holds (60s):** garante que reservas não pagas em 10 min liberem o horário. É a contrapartida do `holdExpiresAt`/`paymentDeadline`.
  - Prazos (`paymentDeadline`): avulso e **serviço = 10 min**, personalizado do cliente = 10 min, renovação de plano = 3 dias.
  - **Antes de apagar** (set/2026, D2): PIX com cobrança → concilia no provedor (pago → promove, não apaga) e cancela a cob; cartão → consulta o PaymentIntent (`succeeded` → marca PAID + efeitos; `processing`/3DS recente → pula a rodada; senão cancela o PI). Rotina exportada: `purgeAwaitingContract` / `settleContractCharges`.
  - Contrato de várias sessões aguardando pagamento (personalizado do cliente) é apagado inteiro pela seção de órfãos; com PAID, é ativado e as sessões promovidas (FULL: todas; PROGRESSIVE: 1º ciclo).
  - **Cobrança da sessão em aberto (nov/2026, ATU-02/R5):** ao achar um PAID da reserva ou do contrato, a varredura só promove a reserva a CONFIRMED se a **cobrança da gravação** está paga (`sessionAwaitsOwnPayment`, a regra do `/confirm` — ver [permissoes-equipe.md](permissoes-equipe.md#pagamento-da-sessão-e-teto-do-fixo)); um PAID que é de outra cobrança (um extra, uma parcela) só limpa o `holdExpiresAt` e mantém a reserva RESERVED. Vale nas duas promoções (a do PAID achado e a restauração depois do cancelamento por corrida). O `POST /bookings/:id/complete-payment` usa a mesma regra; o `confirmBookingAndActivateContract` (efeitos do pagamento) olha só a cobrança marcada `metadata.sessionCharge` em aberto.
  - Sem esperar a varredura: `POST /contracts/custom` e `/custom/check` rodam `purgeAwaitingContract` nos personalizados **vencidos** do mesmo cliente antes de checar/criar (como o `/service` faz com a contratação anterior do serviço).
- **Lembretes (24h/2h):** o lembrete de 24h cobre a véspera, por isso a notificação computada `BOOKING_UNCONFIRMED` foi enxugada para **apenas o dia de hoje** (ver [notificacoes.md](notificacoes.md)).
  - **Disparo exato (set/2026):** o job roda a cada minuto em `hh:mm:01` (setTimeout recursivo realinhado a cada tick) e cobre os vencimentos em `(last-run, agora]`, onde vencimento = início da sessão − 24h/2h. Sessão de 16/09 às 10:00 → lembrete de 24h em 15/09 às 10:00 SP. A decisão pura (janela, dia SP, marcação tardia) está em `lib/bookingReminderSchedule.ts` (testes em `test/booking-reminder-schedule.test.ts`).
  - **`cron:booking-reminder:last-run`** (Redis, ms epoch, TTL 2h): até onde a última execução **sem falhas** cobriu. Com falha, não avança e o próximo tick reprocessa. Após queda, recupera no máximo **60 min**; sem a chave (primeiro deploy/flush do Redis) cobre só o último minuto — nunca reenvia em massa.
  - Dedup `notif:dedup:reminder:<24h|2h>:<bookingId>:<YYYY-MM-DD>` (mesmo formato do job antigo, para o deploy não reenviar). Sessão criada depois do vencimento (marcada com <24h / <2h de antecedência) não recebe aquele lembrete; ela ainda tem o aviso das 7h (`dailyConfirmationJob`) e o de 2h.
  - Sessões de contrato `AWAITING_PAYMENT` (personalizado/serviço do cliente ou avulso ainda não pagos) **não** recebem lembrete (filtro `contract.status ≠ AWAITING_PAYMENT`). Pagou depois do vencimento de um lembrete → aquele lembrete não sai (o job não volta no tempo); os seguintes saem normalmente.
- **Crédito Flex:** o motor de "janela semanal" perde 1 crédito quando a semana fecha e o cliente está atrás do ritmo. Usa `flexForfeitFloor` como baseline para **não** punir retroativamente contratos antigos.
  - Depois de gravar o confisco (ou o ajuste de créditos restantes), o job chama `syncContractCompletion(contractId)`: um FLEX que fica com 0 crédito e sem sessão pendente vira `COMPLETED` na hora (idempotente, com auditoria).
- **Remarcação do avulso (1h, set/2026):** `runAvulsoMakeupExpiryJob(now)` (o `now` injetável permite testes de viagem no tempo em `test/integration/avulso-makeup.test.ts`).
  - Expira as reservas com `makeupStatus = OPEN` e `makeupDeadline < now` (índice `(makeup_status, makeup_deadline)`) com `updateMany` guardado por `OPEN`: uma remarcação no último segundo e o job nunca vencem os dois.
  - FALTA justificada → `EXPIRED`, sem estorno (o Payment continua `PAID`), contrato avulso `COMPLETED` e aviso `avulso_makeup_expired` ao cliente.
  - NAO_REALIZADO → `EXPIRED`, contrato continua `ACTIVE`, avisos `avulso_makeup_expired_studio` (cliente) e `admin_makeup_expired_studio` (cada admin). O admin ainda pode remarcar depois do prazo.
  - Lembrete `avulso_makeup_reminder` quando faltam 2 ou 1 dia(s) no calendário SP. Marca Redis `makeup:reminded:<booking>:<YYYY-MM-DD>` (TTL 36h) garante 1 por dia.
- **Reconciliação Cora (2 min):** rede de segurança para webhooks perdidos. Converge para `paymentEffects` (mesmos efeitos do webhook). Ver [pagamentos.md](pagamentos.md).
- **Cobrança automática (diária):** para clientes com `autoChargeEnabled`, cobra a próxima parcela no cartão salvo padrão. Nunca cobra parcelas de contratos `AWAITING_PAYMENT` (o 1º pagamento de uma contratação parte do cliente, D2); `COMPLETED` segue cobrável (D6).
- **Reconciliação Sicoob (2 min):** em **sandbox** não marca `FAILED` a partir do `GET /cob` (mock aleatório); a expiração do QR é controlada por `Payment.pixExpiresAt` e o QR é reemitido sob demanda.

## Relacionado

- [Pagamentos](pagamentos.md) · [Notificações](notificacoes.md) · [Arquitetura](arquitetura.md)
