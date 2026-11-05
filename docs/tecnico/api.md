# Referência da API

API REST sob o prefixo **`/api`**, registrada em [`backend/src/index.ts`](../../backend/src/index.ts). Respostas em JSON. Autenticação por **cookies httpOnly** (`accessToken`/`refreshToken`) — ver [autenticacao.md](autenticacao.md).

**Níveis de acesso** (a fonte autoritativa é a pilha de middlewares de cada rota: `authenticate` + `requirePermission`/`requireAllPermissions`/`requireStaff`/`requireAdmin`/`requireRole`/`requirePermissionIfStaff`; o `authorize` legado não é mais usado). Matriz completa, regras por corpo e códigos de erro em [permissoes-equipe.md](permissoes-equipe.md):
- **Público** — sem autenticação.
- **Autenticado** / **Dono** — qualquer usuário logado; o handler filtra pelo próprio usuário (a equipe recebe 404 ou lista vazia).
- **Cliente** — só o papel CLIENTE (`requireRole('CLIENTE')`, autoatendimento): ADMIN e COLABORADOR recebem 403 `permission: 'CLIENTE'`.
- **`chave`** — equipe com a permissão (`requirePermission`): o ADMIN sempre passa; o COLABORADOR precisa de **qualquer uma** das chaves separadas por `|`; `+` = todas obrigatórias (`requireAllPermissions`). Papel e permissões vêm do banco a cada requisição.
- **Só ADMIN** — `requireAdmin()` (papel do banco); o colaborador recebe 403 `permission: 'ADMIN'` mesmo com todas as chaves.
- **Misto** — o cliente dono segue o ramo dele; a equipe precisa da chave indicada (sem ela, 403 — nunca o ramo do cliente).

Respostas comuns da equipe: 403 `{ error, code: 'PERMISSION_DENIED', permission }`; 401 `{ code: 'ACCOUNT_DISABLED', error }` (membro desativado ou excluído); 503 `{ code: 'PERMISSIONS_UNAVAILABLE', error }` (banco fora; falha fechada). Nas notas de cada módulo escritas antes da rodada Equipe, "(admin)" quer dizer a equipe com a permissão indicada na tabela (o ADMIN ou o COLABORADOR que a tem), e "403 para não-admin" é o 403 `PERMISSION_DENIED` dessa permissão.

> `GET /api/health` (fora de `/api/*` de negócio) retorna `{ status: "ok" }` para health check.

## auth — `/api/auth` ([routes](../../backend/src/modules/auth/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| POST | `/register/send-code` | Público | Envia código (OTP) para cadastro |
| POST | `/register` | Público | Cria conta validando o OTP |
| POST | `/login` | Público | Login por e-mail + senha |
| POST | `/google` | Público | Login com Google (ID token / access token) |
| POST | `/login/send-code` | Público | Envia o código de login (OTP) para o e-mail |
| POST | `/login/verify-code` | Público | Verifica o código e entra na conta |
| POST | `/refresh` | Cookie | Renova o par de tokens a partir do refresh cookie e devolve `{ message, user }`. 401 só quando a sessão acabou (sem cookie, token inválido ou expirado, usuário inexistente; revogada → `code: 'SESSION_REVOKED'`); erro de banco → **503** `SESSION_REFRESH_UNAVAILABLE`, sem Set-Cookie (o cookie fica) — ver [autenticacao.md](autenticacao.md#respostas-do-post-authrefresh) |
| POST | `/logout` | Público | Limpa os cookies |
| GET | `/me` | Autenticado | Dados do usuário atual |
| PATCH | `/profile` | Autenticado | Atualiza nome, telefone, CPF/CNPJ, endereço, preferências e a própria senha |
| POST | `/profile/photo` | Autenticado | Envia foto (redimensionada para 256×256) |

- **Usuário nas respostas** (login, código, Google, cadastro, refresh, `/me`, perfil, foto): os campos de antes + `permissions: string[]` (ADMIN = todas as chaves do catálogo + as exclusivas; COLABORADOR = as dele; CLIENTE = `[]`) e `staffTitle` (cargo ou `null`).
- **Conta bloqueada/desativada**: login, código, Google e refresh → **403** `{ code: 'ACCOUNT_DISABLED', error }`; `GET /me`, `PATCH /profile` e `POST /profile/photo` → **401** com o mesmo corpo. Para a equipe, `error` = "Seu acesso foi desativado. Fale com o administrador."; o cliente mantém "Sua conta está bloqueada…". Conta excluída: 401 "Conta não encontrada." (login/refresh) ou 404 (`/me`, perfil, foto).
- **COLABORADOR com `staff_profiles` ilegível** (tabela ausente, banco fora): login por senha, código e Google e `GET /me` → **503** `PERMISSIONS_UNAVAILABLE` (o do código pede um novo código); refresh → 503 `SESSION_REFRESH_UNAVAILABLE`; nenhum Set-Cookie. `PATCH /profile` e `POST /profile/photo` gravam e respondem 200 sem `permissions`/`staffTitle`. O ADMIN segue com acesso total e `staffTitle: null`.
- **`PATCH /profile`**: `role` no corpo → 400 `ROLE_NOT_ALLOWED`, sem gravar nada. Senha: cliente ≥ 6; equipe ≥ 8 (400 `PASSWORD_TOO_SHORT`). A equipe que troca a própria senha encerra as **outras** sessões e recebe cookies novos nesta (a conta é relida antes de emitir: desativada durante a troca → 401 `ACCOUNT_DISABLED`, sem cookie).
- **Erro inesperado** (ex.: banco fora) em `POST /login` e `PATCH /profile` → **500** `{ error: 'Não foi possível concluir agora. Tente novamente em instantes.' }` (o do login sem Set-Cookie). Antes a requisição ficava sem resposta. No `POST /google`, o mesmo 500 vale para erro **depois** de o token ser aceito (conta no banco, sessão), sem Set-Cookie; falha na verificação do token (inclusive a rede do Google) continua 401 "Falha na autenticação via Google.", e corpo sem `idToken` é 400 "Dados inválidos.". No `PATCH /profile`, se a senha nova já foi gravada e algo falha depois (ex.: a releitura da conta antes de reemitir os cookies da equipe), a resposta é 500 `{ code: 'PASSWORD_CHANGED', error: 'Sua senha foi alterada, mas não foi possível renovar o seu acesso agora. Se você for desconectado, entre com a nova senha.' }`, sem Set-Cookie.
- **Google**: o vínculo a uma conta existente procura o e-mail sem diferenciar maiúsculas; conta com senha → 409 `requiresPasswordAuth`; conta sem senha só é vinculada com `email_verified` do Google (senão 409 `GOOGLE_EMAIL_NOT_VERIFIED`).
- **Cadastro público** (`/register*`) cria sempre CLIENTE.

## bookings — `/api/bookings` ([routes](../../backend/src/modules/bookings/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| GET | `/public-availability` | Público | Disponibilidade de horários (landing) |
| GET | `/availability` | Autenticado | Disponibilidade para o usuário |
| POST | `/` | Cliente | Cria um agendamento |
| POST | `/bulk` | Cliente | Cria vários agendamentos (Flex) |
| POST | `/admin` | `agendamentos.criar` + regras do corpo | Cria agendamento para um cliente (ver abaixo) |
| GET | `/my` | Dono | Lista os agendamentos do usuário (visão do cliente) |
| GET | `/my/results` | Dono | Resultados (métricas) das gravações do usuário |
| GET | `/:id` | Dono | Um agendamento do próprio usuário (visão do cliente) |
| GET | `/` | `agendamentos.ver` \| `hoje.ver` | Lista agendamentos (equipe vê todos); cada um traz `openChargeCount` (cobranças PENDING/FAILED da reserva) |
| PATCH | `/:id` | `agendamentos.editar` \| `agendamentos.faltas` \| `agendamentos.cancelar` \| `hoje.presenca` \| `hoje.gravacao` + regra por transição/valor | Atualiza (remarcar, notas, status; Falta/Não Realizado exigem motivo) |
| PATCH | `/:id/client-update` | Dono | Cliente edita o episódio (título, descrição, redes) enquanto a gravação não foi finalizada/cancelada |
| POST | `/:id/cover-image` | Dono | Envia a capa do episódio (multipart `cover`; mesma regra de edição) |
| PATCH | `/:id/reschedule` | Dono | Remarcação (janela de 7 dias) |
| PATCH | `/:id/makeup` | Misto: dono ou `agendamentos.faltas` | Remarca a gravação avulsa perdida (falta justificada / não realizada) sem novo pagamento |
| POST | `/:id/addons` | Dono | Adiciona serviços ao agendamento (cobrança só dos extras; reserva ainda no prazo de pagamento → 409 `BOOKING_AWAITING_PAYMENT`; reserva cancelada ou excluída enquanto a cobrança era criada → a cobrança nova vira CANCELLED e 409 `BOOKING_NOT_EDITABLE`). Pagar o extra não confirma a sessão cuja cobrança própria está em aberto |
| POST | `/:id/complete-payment` | Dono | Conclui o pagamento de avulso (se a cobrança da gravação não fica paga, por exemplo quando o pago é um extra, registra o pagamento e a sessão segue RESERVED) |
| DELETE | `/:id` | Misto: dono ou `agendamentos.cancelar` | Cancela (soft delete); a equipe sem `cobrancas.baixa` não cancela sessão com cobrança em aberto (403, abaixo) |
| DELETE | `/:id/hard-delete` | `agendamentos.excluir` (com cobrança em aberto, também `cobrancas.baixa`) | Remoção definitiva (devolve crédito Flex); auditoria `BOOKING/HARD_DELETED` |
| POST | `/cleanup-orphan-addons` | Só ADMIN | Limpeza de add-ons órfãos |
| PATCH | `/:id/confirm` | Dono | Cliente confirma a própria reserva (RESERVED→CONFIRMED); a sessão com cobrança própria (marcada `sessionCharge`, avulso ou em hold) só com a **cobrança da gravação** paga, nunca um extra (402 "Pagamento obrigatório para confirmar agendamento avulso." ou "…esta sessão."). Com a marca, só a cobrança marcada **em aberto** segura: marcada só anulada ou estornada não deixa nada a pagar e a reserva confirma (conserto 5). Regra em [permissoes-equipe.md](permissoes-equipe.md#pagamento-da-sessão-e-teto-do-fixo) |
| PUT | `/:id/client-cancel` | Dono | Cliente cancela a própria sessão |
| PUT | `/:id/check-in` | `hoje.presenca` | Check-in da sessão |
| PUT | `/:id/complete` | `hoje.gravacao` | Conclui a sessão (registra métricas) |
| PUT | `/:id/start-recording` | `hoje.gravacao` | Inicia a gravação (registra o operador; obrigatório antes de finalizar) |
| PUT | `/:id/undo-start-recording` | `hoje.gravacao` | Desfaz um "Iniciar gravação" clicado por engano (zera início e operador) |

**Equipe criando e editando agendamentos (nov/2026 — regras completas em [permissoes-equipe.md](permissoes-equipe.md#regras-que-dependem-do-corpo-libpermissionrulests))**

- `POST /admin`: o alvo precisa ser CLIENTE (404 "Cliente não encontrado.") e o `contractId`, um contrato **dele** (404) e **ACTIVE ou COMPLETED** (senão 400 `CONTRACT_NOT_ACTIVE`, inclusive para o ADMIN). Sem `cobrancas.baixa`: `status: 'CONFIRMED'` vira RESERVED (resposta com `downgraded: true` e `notice`); `customPrice` ≠ preço padrão (inclusive 0) e valor final zero → 403 `cobrancas.baixa`. Sessão de **plano** (contrato FIXO, FLEX ou Personalizado; no FIXO, dentro do teto) sem a baixa: nenhuma cobrança da sessão, só dos serviços extras (PENDING; sem extras, `paymentId: null`), com `coveredByPlan: true` e `message` própria; só na faixa do plano ou abaixo (senão 403 `{ code: 'TIER_NOT_ALLOWED', error: 'O plano X não permite agendar horários Y.' }`). Contrato de SERVIÇO, AVULSO existente e FIXO com o teto usado são **cobrados** como antes (PENDING da sessão com o desconto; `notice` explica); o teto do FIXO que enche durante a criação → 409 `FIXO_LIMIT_REACHED`. O teto do FIXO é conferido para **todos**, sob a trava do contrato (conserto 5): a sessão criada com o teto já cheio leva também `metadata.fixoExtra: true` (a sessão **extra**, que não ocupa vaga do plano); a que quem tem a baixa cria dentro do teto continua cobrada, mas ocupa a vaga. `paymentMethod: 'BOLETO'` exige `cobrancas.cobrar` (403 antes do `BOLETO_UNAVAILABLE`). Contrato FLEX ou Personalizado desconta 1 crédito; sem crédito → 400 `{ error: 'Créditos esgotados neste plano.', code: 'NO_CREDITS' }` (vale também para o ADMIN). Sem rebaixamento, `message` = "Agendamento criado pela equipe.". O RESERVED criado aqui não expira. A cobrança que inclui o valor da **própria sessão** (avulso, SERVIÇO, FIXO extra e toda sessão vinculada criada por quem tem a baixa) grava `metadata.sessionCharge: true` (a marca sobrevive às reemissões de PIX/cartão); a cobrança só dos extras de uma sessão de plano não leva a marca.
- `PATCH /:id`, troca de **faixa de preço** (novo horário ou só a data, ex.: o mesmo horário num sábado) sem `cobrancas.baixa`: a **sessão de plano** (contrato FIXO, FLEX ou Personalizado e nenhuma cobrança dela com a marca `sessionCharge`, em qualquer status) muda dentro da faixa do plano ou abaixo, sem criar cobrança; acima dela → 403 `TIER_NOT_ALLOWED` ("O plano X não permite agendar horários Y."). As demais (avulso, SERVIÇO, sessão cobrada) → 403 `cobrancas.baixa` com mensagem própria. Reenviar o mesmo horário não recalcula faixa nem preço.
- `PATCH /:id`, **sair de CANCELLED** exige `agendamentos.editar` **e** `cobrancas.baixa` (o cancelamento anulou a cobrança em aberto da sessão e dos extras e liberou crédito ou vaga): sem a baixa, 403 `permission: 'cobrancas.baixa'` com o texto do caso (`reopenCancelledNeedsBaixaText`): cobrança da gravação viva (paga ou em aberto) → "… Esta sessão já tem cobrança própria: peça a quem tem essa permissão para reabri-la. Não crie um novo agendamento — o cliente seria cobrado de novo."; alguma cobrança anulada → "Reabrir uma sessão cancelada exige a permissão “Marcar como pago, anular ou estornar”: a cobrança dela foi anulada no cancelamento. Para uma nova sessão, crie um novo agendamento."; nenhuma cobrança → "Reabrir uma sessão cancelada exige a permissão “Marcar como pago, anular ou estornar”. Para uma nova sessão, crie um novo agendamento.". Com ela, a sessão de contrato CUSTOM não sai de CANCELLED e a de FLEX só volta a COMPLETED (saldo recalculado na hora com a conta do cron) → os outros destinos dão **409** `PLAN_SESSION_CANCELLED` (inclusive para o ADMIN; CANCELLED → FALTA dá 400).
- `PATCH /:id`, **voltar a ficar em aberto com a cobrança própria anulada** (conserto 5 e rodada 7; vale para todos, inclusive o ADMIN): cobrança própria = a marcada `sessionCharge` ou, no avulso sem a marca, a que não é compra de extra; "anulada" = nenhuma própria PAID/PENDING/FAILED e alguma CANCELLED (o cancelamento anula a em aberto, também a do avulso; ou o perdão pelo `PATCH /payments`; CANCELLED é terminal). Destino RESERVED/HELD/CONFIRMED a partir de **qualquer status fechado** (CANCELLED, COMPLETED, FALTA, NAO_REALIZADO; entre status em aberto nada muda) → **409** `{ code: 'SESSION_CHARGE_VOIDED', error: 'A cobrança desta sessão foi anulada e não volta com a reabertura, então ela não pode voltar a ficar em aberto (Reservado, Em espera ou Confirmado) sem cobrança. Para gravar, crie um novo agendamento: ele gera a cobrança de novo.' }`, antes de qualquer escrita (e antes do desconto de crédito da saída de NAO_REALIZADO). CANCELLED → COMPLETED/NAO_REALIZADO → 200 com `reopenedWithoutCharge: true` e a `message` terminando em "A cobrança desta sessão foi anulada e não volta com a reabertura: a sessão fica sem cobrança.". Sessão com a cobrança própria paga ou sem cobrança própria (plano) reabre como antes.
- `PATCH /:id`, **sair de NAO_REALIZADO** (para qualquer status menos CANCELLED) sem `cobrancas.baixa`: FLEX, Personalizado e AVULSO descontam **antes** o crédito que o "Não realizado" devolveu; sem crédito (já usado em outro agendamento ou, no FLEX, vencido no confisco) → 409 `{ code: 'NO_CREDITS', error: 'O plano não tem crédito disponível para reabrir esta sessão: o crédito devolvido no “Não realizado” já foi usado ou venceu. …' }` e nada muda. O FIXO confere o teto sob a trava do contrato (menos a sessão extra — cobrança com `metadata.fixoExtra`, criada com o teto já cheio, em qualquer status —, que não ocupa vaga do plano): cheio → 409 `FIXO_LIMIT_REACHED` ("O plano fixo já usou todas as sessões: reabrir esta sessão passaria do limite. …"); trava ocupada → 409 "Muitas reservas simultâneas neste contrato. Tente novamente.". O ADMIN e quem tem a baixa seguem como antes.
- `PATCH /:id` → CANCELLED, `DELETE /:id` (equipe) e `DELETE /:id/hard-delete`, **sessão com cobrança em aberto** (algum Payment PENDING/FAILED da reserva, em qualquer status, data ou gravação), sem `cobrancas.baixa` → 403 `{ code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa', error: 'Esta sessão tem cobrança em aberto: cancelar anula a cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa ou, se o cliente faltou, use Falta (a cobrança continua devida).' }` e nada muda. Na exclusão (`hard-delete`), o mesmo `code`/`permission` com o texto da exclusão: "Esta sessão tem cobrança em aberto: excluir anula a cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa.". A regra da tabela responde antes; a conferência vem antes de qualquer escrita e é refeita depois da transição (cobrança criada no meio → desfaz e 403). Reabrir ou remarcar antes não muda nada. Sem cobrança em aberto, segue 200. Detalhes em [permissoes-equipe.md](permissoes-equipe.md#regras-que-dependem-do-corpo-libpermissionrulests).
- `openChargeCount` (número de Payments PENDING/FAILED da reserva, contados numa consulta só) vem em cada item do `GET /` e no `booking` das respostas de `PATCH /:id`, `PUT /:id/check-in`, `/complete`, `/start-recording` e `/undo-start-recording`. As rotas do cliente (`GET /my`, `GET /:id`…) não o trazem. A tela da equipe usa o campo para não oferecer o Cancelar a quem não tem a baixa.
- `POST /`, `/bulk` (autoatendimento) recusam ADMIN e COLABORADOR com 403 `permission: 'CLIENTE'`; a exceção de antecedência do admin saiu.
- `POST /` (cliente): contrato de SERVIÇO → 400 "Contrato de serviço não inclui gravação."; contrato AVULSO → 400 "Gravação avulsa não se agenda pelo contrato. Para remarcar, use a remarcação da própria reserva." (o crédito que o cancelamento devolve ao avulso não vira sessão nova; remarcar é pelo `/:id/reschedule` ou `/:id/makeup`); Personalizado sem crédito → 400 "Créditos esgotados neste plano."; o desconto do crédito (FLEX/Personalizado) é guardado por `> 0` e, se outra reserva zerou o saldo no meio, responde 400 "Créditos esgotados (concorrência). Tente novamente." sem gravar nada. `/bulk` só aceita FLEX ("Apenas contratos Flex suportam marcação em lote."). No horário de uma reserva do próprio cliente **sem prazo de pagamento** (`holdExpiresAt` nulo: feita pela equipe ou de plano) → 409 `BOOKING_ALREADY_RESERVED` ("Você já tem uma reserva neste horário. Se ela tiver cobrança em aberto, pague em Meus pagamentos."), sem renovar hold nem criar cobrança; só o hold do avulso do próprio cliente é retomado (troca PIX → cartão).

**Falta justificada / remarcação do avulso (D4/D5, [lib/avulsoMakeup.ts](../../backend/src/lib/avulsoMakeup.ts))**

- `PATCH /:id` (admin) aceita `noShowJustified?: boolean`. `{ status: 'FALTA', statusReason, noShowJustified: true }` em reserva de contrato **AVULSO** abre a janela (`makeupStatus: 'OPEN'`, `makeupDeadline` = fim do dia D+7 em SP, `missedDate` = D). 400 (sem trocar nada) se o status final não for FALTA, se o contrato não for avulso, se a remarcação já foi usada ou se o prazo já passou. `noShowJustified: false` retira a janela aberta. Marcar `NAO_REALIZADO` em avulso abre a janela **sozinho**. A janela (e a justificativa, e o `/makeup`) só vale com a **cobrança da gravação paga** — um serviço extra pago não conta (`makeupBlockReason`, R5): sem ela, o Não realizado não abre a janela e a justificativa e o `/makeup` dão 400 "O pagamento desta gravação não está confirmado; a remarcação sem novo pagamento só vale para gravação paga.". Saindo de FALTA/NAO_REALIZADO pelo admin: para CONFIRMED/RESERVED/COMPLETED a janela vira `USED`; para CANCELLED é retirada. A resposta (`booking`) já traz `makeupStatus`/`makeupDeadline`/`missedDate`. Quando **esta** requisição leva um AVULSO a NAO_REALIZADO, a resposta traz também (rodada 7, `loadMakeupOutcome`): `makeupOpened` (janela OPEN e no prazo), `makeupDeadline` (ISO do prazo gravado, com a janela OPEN ou EXPIRED; senão `null`) e `makeupBlockReason` (por que não está aberta, ou `null`): prazo vencido → "O prazo da remarcação sem novo pagamento terminou em DD/MM: o cliente não remarca pelo app, mas a equipe ainda pode remarcar (Remarcar)."; sem janela → o texto de `makeupBlockReason` (não paga, inclusive a cobrança anulada; estornada; contrato cancelado ou encerrado), o de cliente excluído ou "Não há janela de remarcação aberta para esta gravação.". Fora do avulso esses campos não vêm.
- `PATCH /:id/makeup` body `{ date: 'YYYY-MM-DD', startTime: 'HH:MM' }` → `{ booking: { id, date, startTime, endTime, status: 'CONFIRMED', tierApplied, price, contractId, originalDate, statusReason, makeupStatus: 'USED', makeupDeadline, missedDate, holdExpiresAt, contract: { id, name, type, tier } }, message }`. Exige janela `OPEN` e dentro do prazo, nova data ≤ D+7, antecedência mínima `booking_min_advance_hours` (cliente) ou só "não no passado" (admin), dia de funcionamento e horário da grade na **mesma faixa**. Mesma trava/conflito/bloqueio do `/reschedule`. Reabre a MESMA reserva (mesmo Payment, sem cobrança). Exceção D5: o admin remarca um NAO_REALIZADO mesmo sem janela/depois do prazo e sem o teto D+7. Erros: 400 (regra), 404 (não é o dono), 409 (horário ocupado/bloqueado/em reserva, ou outra remarcação venceu).
- `GET /my` e `GET /:id` (cliente) incluem `originalDate`, `statusReason`, `makeupStatus`, `makeupDeadline`, `missedDate`.

**Desfazer o início da gravação (lote 2)**

- **`PUT /:id/undo-start-recording`** (admin) — desfaz um "Iniciar gravação" clicado por engano: zera `recordingStartedAt`, `recordingStartedById` e `recordingStartedByName`. O cliente deixa de ver "AO VIVO" (`isRecordingNow` volta a `false`) e a sessão volta a exigir "Iniciar gravação" antes de finalizar. Sem corpo.
  - 200 `{ booking, message: 'Início da gravação desfeito.' }`; gravação que não estava iniciada → 200 `{ booking, message: 'A gravação não estava iniciada.' }` (idempotente, nada é gravado).
  - Só em `CONFIRMED`: qualquer outro status (inclusive `COMPLETED`, já finalizada) → **409** `{ error, code: 'RECORDING_UNDO_NOT_ALLOWED' }`. A escrita é guardada pelo status, então uma finalização concorrente cai no 409 e o início não se perde. 404 se o agendamento não existe; 403 para não-admin.
  - O início desfeito (quando, quem) fica em `audit_logs` (`entityType BOOKING`, `action RECORDING_START_UNDONE`).
- **`PUT /:id/start-recording`** (admin) — só em `CONFIRMED` e **só no dia da sessão ou depois**: sessão FUTURA (data posterior a hoje no calendário de São Paulo) → **400** `{ error: 'Só é possível iniciar a gravação no dia da sessão.', code: 'RECORDING_START_FUTURE' }`, nada é gravado. Sessão de hoje ou passada segue permitida (Iniciar → Finalizar retroativo). Já iniciada → 200 idempotente (mantém o início original).
- **`PUT /:id/complete`** (admin) — a 1ª finalização é **condicional** ao estado lido (mesmo status + `recordingStartedAt` ainda preenchido):
  - o início foi desfeito ou o status mudou em outra tela entre a leitura e a escrita → **409** `{ error, code: 'RECORDING_STATE_CHANGED' }`, nada é gravado e o contrato não é concluído;
  - outro operador (ou um duplo clique) já finalizou → **200** `{ booking, message }` com a reserva atual, sem regravar;
  - regravar métricas de uma gravação já `COMPLETED` continua incondicional.
  - `durationMinutes` omitido → derivado de Iniciar → Finalizar; se o intervalo passar de **12 h** (início antigo esquecido), a derivação é ignorada e a duração fica vazia até o operador informar.

**Visão do cliente sobre a gravação (lote 2 — E11/E12, [booking.clientView.ts](../../backend/src/modules/bookings/booking.clientView.ts))**

Toda rota em que o **cliente** recebe uma reserva devolve o MESMO objeto (`CLIENT_BOOKING_SELECT` + `toClientBooking`): `GET /my` (`bookings[]`), `GET /:id` (`booking`), `GET /availability` (`myBookings[]`) e as respostas de `PATCH /:id/client-update`, `POST /:id/cover-image`, `PATCH /:id/reschedule` e `PATCH /:id/makeup` feito pelo cliente (`booking`).

- **Nunca** traz `adminNotes` (nota interna do estúdio) nem quem operou a gravação (`recordingStartedById`/`recordingStartedByName`). As rotas exclusivas do admin (`GET /`, `PATCH /:id`, `PUT /:id/complete`, `PUT /:id/start-recording`…) continuam devolvendo `adminNotes`.
- Campos: `id`, `date`, `startTime`, `endTime`, `status`, `tierApplied`, `price`, `contractId`, `clientNotes` (feedback do estúdio ao cliente — só leitura), `episodeTitle`, `episodeDescription`, `coverImageUrl`, `platforms` (string JSON, array de redes), `platformLinks` (string JSON `{ REDE: url }`; `GRAVACAO` = link da gravação não transmitida), `durationMinutes`, `peakViewers`, `chatMessages`, `audienceOrigin`, `isLivestream`, `streamMetrics` (string JSON `{ REDE: { views, peak, subscribers, likes, comments } }`), `recordingStartedAt`, `addOns`, `holdExpiresAt`, `originalDate`, `statusReason`, `makeupStatus`, `makeupDeadline`, `missedDate`, `contract: { id, name, type, tier, discountPct, addOns }`.
- Derivados (calculados na resposta):
  - `isRecordingNow` — **"gravando agora"**: `status === 'CONFIRMED'` + `recordingStartedAt` preenchido (o admin clicou "Iniciar Gravação") e ainda não finalizada. É o único critério do selo "AO VIVO" do cliente; `isLivestream` ("foi transmitida ao vivo") é um atributo permanente e **não** indica gravação em andamento. Teto de segurança: deixa de valer `RECORDING_LIVE_MAX_HOURS` (6 h) depois do início, para um "Finalizar" esquecido não prender o selo.
  - `recordingFinishedAt` — fim da gravação = `recordingStartedAt` + `durationMinutes`, só em `COMPLETED` (não há coluna própria; `null` se faltar início ou duração).
  - `canEditEpisode` / `editBlockedReason` — se o cliente ainda pode editar o episódio e, quando não pode, a mensagem (a mesma do 409 abaixo).
- `PATCH /:id/client-update` body `{ episodeTitle?, episodeDescription?, platforms? }` → `{ booking, message }`.
  - Só o **dono** (404 para qualquer outro usuário, inclusive admin) e só com a reserva em `RESERVED`, `HELD` ou `CONFIRMED` (inclusive durante a gravação). `COMPLETED`, `CANCELLED`, `FALTA` e `NAO_REALIZADO` → **409 `{ error, code: 'BOOKING_NOT_EDITABLE' }`**, sem gravar nada (a escrita é um `updateMany` guardado pelo status: finalização/cancelamento concorrente também cai no 409).
  - `episodeTitle`: texto de uma linha (espaços/quebras colapsados), máx. 140; `episodeDescription`: máx. 4000; `''` ou `null` limpam o campo. `platforms`: string JSON com array de `YOUTUBE`/`INSTAGRAM`/`FACEBOOK`/`TIKTOK` (normalizado, sem repetição). Inválido → 400 com a mensagem do campo em `error` (pt-BR) e `details`.
  - Campos fora dessa lista são **ignorados** (não dão erro): `clientNotes` (feedback do estúdio), `platformLinks`, métricas, status, preço.
- `POST /:id/cover-image` (multipart, campo `cover`; JPG/PNG/WEBP/AVIF/HEIC até 12 MB) → `{ coverImageUrl, booking, message }`. Mesma regra de dono/status (404 / 409 `BOOKING_NOT_EDITABLE`). 400 sem arquivo, formato não aceito ou imagem ilegível; 413 acima de 12 MB.
- `PATCH /:id/reschedule` → `{ booking, message }` com `booking` na visão do cliente (superconjunto do retorno anterior).
- **"Iniciar Gravação" vale para a sessão daquele dia/horário:** remarcar uma sessão aberta (`PATCH /:id` do admin mudando `date`/`startTime` com status final `RESERVED`/`HELD`/`CONFIRMED`, `PATCH /:id/reschedule` e `PATCH /:id/makeup`) zera `recordingStartedAt`/`recordingStartedById`/`recordingStartedByName` — o operador inicia de novo na nova data. Corrigir a data de uma gravação já finalizada preserva o registro.
- Toda transição de status (complete, client-cancel, DELETE, hard-delete, PATCH, makeup, job) chama `syncContractCompletion`: o contrato vira `COMPLETED`/volta a `ACTIVE` automaticamente (ver [modelo-de-dados.md](modelo-de-dados.md)).
- **Cobranças da gravação cancelada (lote 2; R5):** quando a gravação passa a `CANCELLED` — `PUT /:id/client-cancel` e `DELETE /:id` (pelo admin; pelo cliente, reserva `RESERVED`/`HELD` a qualquer tempo ou `CONFIRMED` com 24 h ou mais — abaixo disso vira `FALTA` e nada é anulado), `PATCH /:id` do admin com `status: 'CANCELLED'` — ou é apagada por `DELETE /:id/hard-delete`, as cobranças `PENDING`/`FAILED` dela (`Payment` com `contractId` + `bookingId`: extras e a da própria sessão, de qualquer tipo de contrato, **inclusive o avulso**) são anuladas pela mesma sequência do cancelamento do contrato (`voidContractPendingPaymentsDetailed(contractId, { bookingIds: [id] })`, via `voidExtrasOfCancelledBooking` em `booking.service.ts`): a cobrança viva é aposentada no provedor antes; PIX/cartão já pago vira `PAID` (não é anulado); cobrança já `PAID` fica intocada, sem estorno automático; o cupom reservado nela é devolvido. A equipe sem `cobrancas.baixa` não chega a anular nada: com cobrança em aberto ela recebe o 403 (ver o `PATCH /:id` acima).
  - Resposta: `voidedExtras` (número) em `client-cancel`, `DELETE /:id` e `hard-delete`; no `PATCH /:id` só quando > 0. Quando > 0 a `message` ganha " N cobrança(s) em aberto desta gravação foi/foram cancelada(s)." (a contagem inclui a cobrança da própria sessão, além dos extras).
  - Best-effort: uma falha na anulação vai para o log e não desfaz o cancelamento (`voidedExtras: 0`).
  - No `hard-delete` a anulação roda **antes** de apagar (a FK zera o `bookingId` do pagamento; uma cobrança pendente sem `bookingId` passaria a parecer parcela do plano).
  - **Não** anula: remarcação (`PATCH /:id` só com data/horário, `/reschedule`, `/makeup`), aviso com menos de 24 h (vira `FALTA`) e o hold vencido do avulso do cliente (segue na varredura `cleanExpiredHolds`).
- `POST /admin` sem `contractId` cria o avulso com `endDate` = dia da gravação e `paymentPlan: 'FULL'`; PIX grava o provedor resolvido (Sicoob ou Cora), não mais `CORA` fixo.
- **Cliente excluído (D3)** → **409 `{ error: 'Este cliente foi excluído…', code: 'CLIENT_DELETED' }`** (ou 409 `MakeupError`) em: `POST /admin` (`userId` excluído); `PATCH /:id` que reabre a gravação (→ RESERVED/HELD/CONFIRMED vindo de outro status), muda data/horário de uma gravação que fica ativa ou manda `noShowJustified: true`; `PATCH /:id/makeup` (inclusive o override D5 do admin). Marcar NAO_REALIZADO não abre janela para cliente excluído. Finalizar, marcar falta/não realizado, cancelar e editar notas/métricas continuam permitidos.
- **Avulso acompanha a gravação:** quando a reserva de um contrato **AVULSO** muda de data/horário (`PATCH /:id` com `date`/`startTime`, `PATCH /:id/reschedule` e `PATCH /:id/makeup`), o contrato passa a ter `startDate` = `endDate` = dia da nova gravação e o nome gerado vira `Avulso DD/MM/AAAA às HH:MM` (mantém o conector do nome atual, "às" ou "as"; nome fora desse padrão não muda). Outros tipos (inclusive o FLEX-1 legado) não são tocados (`syncAvulsoContractSchedule` em `booking.service.ts`).

## contracts — `/api/contracts` ([routes](../../backend/src/modules/contracts/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| GET | `/slot-options?tier=` | Autenticado | Grade de horários válidos de contrato da faixa (D8) |
| POST | `/check-fixo` | Autenticado | Pré-valida dia/horário de contrato FIXO |
| POST | `/custom/check` | Misto: cliente ou `contratos.criar` | Pré-valida agenda personalizada |
| POST | `/` | `contratos.criar` | Cria contrato (FIXO/FLEX/CUSTOM/AVULSO) para um cliente |
| POST | `/self` | Cliente | Contratação pelo próprio cliente |
| POST | `/custom` | Misto: cliente ou `contratos.criar` | Cria contrato personalizado (a equipe informa `userId`) |
| POST | `/service` | Cliente | Contrata um serviço mensal (SERVICO) com pagamento inline |
| GET | `/` | `contratos.ver` \| `agendamentos.criar` | Lista contratos (equipe vê todos; `agendamentos.criar` usa no seletor de plano) |
| GET | `/my` | Dono | Contratos do usuário (paginado) |
| GET | `/:id` | Misto: dono ou `contratos.ver` | Detalhe do contrato |
| PATCH | `/:id` | `contratos.editar` \| `contratos.cancelar` \| `contratos.condicoes` + regra por valor | Atualiza contrato |
| DELETE | `/:id` | `contratos.cancelar` (+ `contratos.multa` em `PENDING_CANCELLATION`; com cobrança de sessão em aberto: + `cobrancas.baixa`) | Cancela contrato |
| POST | `/:id/request-cancellation` | Dono | Solicita cancelamento antecipado |
| POST | `/:id/resolve-cancellation` | `contratos.multa` (com cobrança de sessão em aberto: + `cobrancas.baixa`) | Resolve o cancelamento (multa/isenção) |
| POST | `/:id/renew` | `contratos.criar` + `cobrancas.baixa` | Renova (mesmos termos), sem gerar parcelas |
| PATCH | `/:id/pause` | `contratos.editar` (FIXO com cobrança em aberto numa gravação que a pausa cancela: + `cobrancas.baixa`) | Pausa o contrato |
| PATCH | `/:id/resume` | `contratos.editar` | Retoma o contrato |
| POST | `/:id/pay` | Dono | Gera o pagamento da 1ª parcela |
| POST | `/:id/confirm-payment` | Dono | Ativa o contrato `AWAITING_PAYMENT` do próprio cliente depois do pagamento no Stripe |
| POST | `/:id/subscribe` | Dono | Ativa a cobrança automática do cliente com o cartão informado (E9 — sem assinatura Stripe) |
| POST | `/:id/client-renew` | Dono | Cliente inicia a renovação |

- **Equipe (nov/2026)**: `POST /` e `POST /custom` da equipe exigem alvo CLIENTE (404 "Cliente não encontrado."); o `/custom` da equipe sem `userId` → 400 `CLIENT_REQUIRED`. Parcela de valor zero (cupom 100%), que nasceria PAGA, sem `cobrancas.baixa` → 403 `{ code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa' }` (o `POST /` desfaz o que gravou; o `/custom` recusa antes de criar). `PATCH /:id` por valor alterado: CANCELLED → `contratos.cancelar`; ACTIVE/COMPLETED/EXPIRED, `endDate`, `contractUrl`, `paymentMethod` → `contratos.editar`; `flexCreditsRemaining`, `boletoAllowed`, `addOns` → `contratos.condicoes`; contrato em `PENDING_CANCELLATION` + mudança de status → também `contratos.multa`; contrato **CANCELLED** + mudança de status (reabrir) → também `contratos.cancelar` **e** `contratos.condicoes`. O status só é gravado se não mudou desde a leitura; senão **409** `CONTRACT_STATUS_CHANGED`, sem efeito. `GET /:id`: `user.cpfCnpj`, `bookings[].adminNotes` e `recordingStartedByName` só para a equipe.
- **Anular cobrança de sessão em aberto é da baixa, também pelo contrato (conserto 5 e rodada 7)**:
  - `DELETE /:id`, `PATCH /:id` → CANCELLED e `POST /:id/resolve-cancellation` (as duas ações), sem `cobrancas.baixa`, com cobrança de sessão em aberto → 403 relido sob a trava do cancelamento e antes de qualquer escrita (no `resolve-cancellation`, o contrato continua em `PENDING_CANCELLATION`). "Cobrança de sessão" (`contractCancelBaixaChargeWhere`): no **AVULSO** (o contrato é a própria sessão), qualquer Payment PENDING/FAILED do contrato → `{ code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa', error: 'Este avulso tem cobrança em aberto: cancelar o contrato anula a cobrança da sessão, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa.' }`; nos **outros tipos** (SERVIÇO, FIXO, FLEX, Personalizado), Payment PENDING/FAILED com `bookingId` e a marca `sessionCharge` (gravação vinculada a um SERVIÇO, sessão extra do FIXO, sessão cobrada à parte), mesmo de gravação já feita → o mesmo `code`/`permission` com `error: 'Uma gravação deste contrato tem cobrança própria em aberto (a da sessão, cobrada à parte): cancelar o contrato anula essa cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa.'`. Parcelas (sem `bookingId`) e serviços extras sem a marca continuam anulados só com `contratos.cancelar`/`contratos.multa` (D2).
  - `GET /` traz em cada contrato `openChargeCount` (Payments PENDING/FAILED do contrato) e `openSessionChargeCount` (a conta do 403: no avulso, igual a `openChargeCount`; nos outros tipos, as marcadas com `bookingId` em aberto). Dois `groupBy`. A tela trava "Cancelar contrato" e a decisão do pedido para quem não tem a baixa quando `openSessionChargeCount` > 0.
  - **Pausa do FIXO** (`PATCH /:id/pause`): cancela as gravações futuras (RESERVED/CONFIRMED) **do plano** — a sessão extra (`metadata.fixoExtra`) fica viva. Se alguma gravação a cancelar tem Payment PENDING/FAILED (ex.: extra contratado nela), sem `cobrancas.baixa` → 403 `{ code: 'PERMISSION_DENIED', permission: 'cobrancas.baixa', error: 'Uma gravação que a pausa cancelaria tem cobrança em aberto: cancelar anula a cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa.' }` e nada muda. Com a baixa (ou o ADMIN), as cobranças em aberto das gravações canceladas são anuladas (`voidContractPendingPaymentsDetailed` com `bookingIds`; aposentadas no provedor antes) e a resposta ganha `voidedCount` e " N cobrança(s) em aberto das gravações canceladas foi/foram anulada(s).".
- `GET /my`: no FIXO, `planSessionsUsed` = sessões que ocupam o teto pela mesma conta do servidor (`fixoCapUsageWhere`: COMPLETED/CONFIRMED/FALTA/RESERVED sem a marca `fixoExtra`). O app do cliente decide o saldo do FIXO por ele; `completedBookings` não mudou.

- `PATCH /:id` (admin): `status` aceita `ACTIVE`, `EXPIRED`, `CANCELLED` e `COMPLETED` (concluir/reabrir à mão). `PENDING_CANCELLATION` **não** é aceito: esse estado vem do `POST /:id/request-cancellation`, que também cancela as sessões futuras. Ajustar `flexCreditsRemaining` sem `status` recalcula a conclusão.
  - `paymentMethod: 'BOLETO'` (E3): trocar a forma do contrato para boleto exige o boleto **efetivo** (chave-mestra ligada **e** Cora habilitada) → senão **400** `{ error, code: 'BOLETO_UNAVAILABLE', reason: 'SWITCH_OFF'|'PROVIDER_DISABLED' }`, antes de qualquer efeito e sem gravar nada do PATCH. Reenviar `BOLETO` num contrato que já era boleto não é troca e não bloqueia. `boletoAllowed` no corpo é **ignorado** (não é gravado).
  - `addOns` (troca de serviços, FIXO/FLEX ativos): repreça só as parcelas `PENDING` do plano (nunca extras de gravação nem a multa de cancelamento). No à vista, a marca `metadata.pixDiscount = { pct, cardAmount, pixAmount }` é regravada com os dois preços do total **novo**, seja qual for a forma do contrato (E2): criado no PIX, `amount` = `pixAmount`; criado no cartão/boleto, `amount` = `cardAmount` e o PIX continua saindo com o desconto. Parcela repreçada com **PaymentIntent** já emitido pelo valor antigo: o PI pagável é cancelado e `providerRef`/`chargedAmount` são zerados; PI aprovado/em processamento ou não consultável → a parcela fica no valor antigo (como o QR PIX que não pôde ser cancelado).
  - Troca de `paymentMethod`: **os valores das cobranças não mudam** e nenhuma cobrança é regravada. O cartão cobra a base marcada na criação (`metadata.pixDiscount`) ou, sem a marca, o próprio `amount`, nunca a mais. Ver [pagamentos.md](pagamentos.md) › Desconto PIX só no PIX.
- **Toda** cobrança à vista (`POST /`, `/self`, `/custom`, `/service`, `/:id/pay` do serviço à vista), seja qual for a forma de pagamento (E2), grava `metadata.pixDiscount = { pct, cardAmount, pixAmount }`: `cardAmount` = preço de cartão/boleto, `pixAmount` = preço PIX, os dois com o mesmo cupom em R$. Criada no PIX, `amount` = `pixAmount`; criada no Cartão/Boleto, `amount` = `cardAmount` (o PIX ganha o desconto ao emitir o QR). Cobrança de R$ 0, ou cujo preço PIX zeraria, nunca recebe a marca.
- **Boleto (E3)**: `POST /` (admin) e `POST /custom` (admin) com `paymentMethod: 'BOLETO'` exigem o boleto **efetivo** (chave-mestra ligada **e** Cora habilitada) → senão **400** `{ error, code: 'BOLETO_UNAVAILABLE', reason: 'SWITCH_OFF'|'PROVIDER_DISABLED' }` antes de criar qualquer coisa. `POST /self`, `POST /service`, `POST /custom` do **cliente** e `POST /:id/client-renew` **nunca** aceitam boleto (contratação com prazo de pagamento) → **400** `{ error, code: 'BOLETO_NOT_ALLOWED_HERE' }`. `boletoAllowed` (no corpo e na coluna `Contract.boletoAllowed`) não é mais autoridade — é ignorado.
- `POST /` (admin) com cupom que zera parcelas (100% ou VALOR ≥ total): as parcelas de R$ 0 nascem `PAID` (`paidAt` = agora) e a resposta traz `payments[].status: 'PAID'`. A 1ª passa por `onPaymentConfirmed` (uso do cupom `CONFIRMED`). Nada vai ao gateway nem ao auto-charge. Só com `cobrancas.baixa`: sem ela, 403 `permission: 'cobrancas.baixa'` e o contrato e as sessões gravados pelo pedido são desfeitos.
- **Cancelamento e multa (E13)** — regra completa em [pagamentos.md](pagamentos.md#cancelamento-de-contrato-e-multa-e13). Valores em centavos.
  - `POST /:id/request-cancellation` (dono, contrato `ACTIVE`): congela a multa (% vigente × o que falta pagar do plano) e cancela só as gravações que ainda não começaram. Resposta: `{ contract, message, cancelledBookings, fine: { finePct, baseAmount, amount } }`; `contract` já traz `cancellationRequestedAt`, `finePct`, `fineBaseAmount`, `fineAmountPreview`. Contrato não ativo → 400. As cobranças `PENDING`/`FAILED` de **extras** (`bookingId`) das gravações que o próprio pedido cancelou são anuladas na hora (`voidedExtras` na resposta), aposentando antes a cobrança viva no provedor — PIX/cartão já pago fica `PAID`; extras de gravações já realizadas continuam pagáveis. A `message` diz o motivo verdadeiro do "sem multa": nada em aberto ("Não há parcelas do plano em aberto…") ou percentual zerado ("O cancelamento não tem multa.").
  - `POST /:id/resolve-cancellation` `{ action: 'CHARGE_FEE' | 'WAIVE_FEE' }` (admin): `CHARGE_FEE` cria a multa (`metadata.kind = 'CANCELLATION_FINE'`, `PENDING`) sobre a **base efetiva** = mínimo entre a congelada no pedido e o que ainda falta pagar (parcela da base paga durante a análise sai dela; `fine.baseAmount` e `metadata.baseAmount` trazem essa base); base 0 ou `WAIVE_FEE` → sem cobrança. Resposta: `{ contract, message, fine: { id, amount, status, dueDate, finePct, baseAmount } | null, voidedCount, paidAtProvider, liveAtProvider }`. Contrato que não está (mais) em `PENDING_CANCELLATION` — lista defasada, outro admin, duplo clique — → **409** `{ error, code: 'CANCELLATION_NOT_PENDING' }` ("Este pedido de cancelamento já foi resolvido." quando `CANCELLED`; "O contrato não está mais aguardando cancelamento." nos demais), sem nenhum efeito. A decisão é serializada por contrato (trava Redis, com o status relido dentro dela): outra requisição de cancelamento do mesmo contrato ainda em andamento depois de ~15 s → **409** `{ error, code: 'CANCELLATION_IN_PROGRESS' }`. Se o contrato já tinha uma multa em aberto de um cancelamento anterior (reaberto e cancelado de novo) e a decisão gera multa nova, a anterior é anulada antes (nunca duas em aberto); sem multa nova ela continua devida e a `message` avisa.
  - `DELETE /:id` (admin): `{ message, voidedCount, cancelledBookings, paidAtProvider, liveAtProvider }`. `paidAtProvider` = cobranças que o provedor confirmou como pagas na anulação (ficaram `PAID`); `liveAtProvider` = cobranças anuladas que não puderam ser canceladas no provedor agora. O `PATCH /:id` que **cancela** (`status: 'CANCELLED'` num contrato ainda não cancelado) responde igual: `{ contract, message, voidedCount, cancelledBookings, paidAtProvider, liveAtProvider }`, com a nota do provedor na `message`; os demais `PATCH` seguem com `{ contract, message }`. `DELETE` e esse `PATCH` usam a mesma trava da decisão (→ 409 `CANCELLATION_IN_PROGRESS` se ocupada) e **nunca** anulam a multa de cancelamento.
  - Pedido, `DELETE` e `PATCH` com `status: 'CANCELLED'` avisam o cliente e só cancelam gravações `RESERVED`/`CONFIRMED`/`HELD` com início futuro (relógio de SP).
- **Campos de cancelamento/multa** em cada contrato de `GET /` (admin), `GET /:id` e `GET /my`:
  - `paidTotal` — total efetivamente pago no contrato; `remainingTotal` — o que falta pagar do plano agora;
  - `finePct`, `fineBaseAmount`, `fineAmountPreview` — a multa: a do pedido em análise (% congelado × base efetiva — cai se uma parcela da base for paga, nunca aumenta), a gerada (cancelado) ou a prévia de hoje (demais status);
  - `cancellationRequestedAt`, `cancelledAt` (ISO ou `null`; `cancelledAt` só com status `CANCELLED` — contratos antigos usam a última atualização);
  - `cancellationFine` — `{ id, amount, status, dueDate, paidAt, finePct, baseAmount }` ou `null`.
- **Renovação (E4)** — `GET /` (admin) e `GET /:id` trazem `alreadyRenewed` (existe renovação não cancelada), `renewedToId`, `daysToEnd` (dias no calendário de SP até o fim da vigência; negativo = encerrada) e `canRenew`: plano (nunca `AVULSO`/`SERVICO`), cliente não excluído, ainda não renovado e (`ACTIVE`/`COMPLETED` com `daysToEnd` ≤ 30, ou `EXPIRED`). `GET /my` traz só `alreadyRenewed`.
- `GET /my`: cada `payments[]` traz `chargedAmount` e `providerRef` (o "total pago" soma o valor efetivamente cobrado), `paidAt`, `pixExpiresAt`, `bookingId` e **`kind`** (`'CANCELLATION_FINE'` ou `null`) — o `metadata` não sai. Os `bookings` **não** trazem `adminNotes` (nota interna); trazem `clientNotes`, `recordingStartedAt`, `episodeTitle`, `coverImageUrl` e as métricas (`durationMinutes`, `peakViewers`, `chatMessages`, `audienceOrigin`, `isLivestream`, `streamMetrics`).
- `GET /:id`: `payments[]` com `kind`; `user.cpfCnpj`, `bookings[].adminNotes` e `bookings[].recordingStartedByName` **só para a equipe** (o dono do contrato não os recebe).
- `POST /:id/renew` (equipe com `contratos.criar` **e** `cobrancas.baixa` — a renovação cria o contrato ATIVO sem nenhuma parcela; quem só tem `contratos.criar` recebe 403 `permission: 'cobrancas.baixa'`) aceita `ACTIVE`, `EXPIRED` e `COMPLETED`; **`AVULSO` e `SERVICO` → 400** (não são renováveis por aqui). A janela de 30 dias do botão não é imposta pela rota. Corpo validado por zod (`renewContractSchema`) antes de qualquer leitura: `durationMonths` 3 ou 6 (padrão 3), `type` FIXO|FLEX, `tier` do enum, `startDate` texto ou `null` → senão 400 "Dados inválidos."; `startDate` fora de `YYYY-MM-DD` → 400 com a mensagem própria. As datas sem hora (`startDate`/`endDate`, meia-noite UTC) viram dia pelo ISO — nunca por `saoPauloParts`, que com o servidor em UTC dava o dia anterior; o `/resume` usa o dia de hoje em SP como início e o novo `endDate` pelo ISO como fim.
- **Cliente excluído (D3)** → 409 `code: 'CLIENT_DELETED'` em `POST /`, `POST /custom`, `POST /:id/renew`, `PATCH /:id/resume` e no `PATCH /:id` que reativa (`status: 'ACTIVE'`), muda `flexCreditsRemaining` ou `addOns`. `GET /` e `GET /:id` trazem `user.deletedAt` (a lista do admin mostra o selo "Cliente excluído" e esconde Renovar/Pausar/Retomar/Cobrar multa).
- `GET /my` e `GET /:id`: os `bookings` trazem `statusReason`, `makeupStatus`, `makeupDeadline`, `missedDate` (e `originalDate`).
- **Grade de horários de contrato (D8)** — fonte única em `utils/pricing.ts` (`getContractSlotGrid`, `checkSlotInGrid`), lida da BusinessConfig (`time_slots`, `comercial_slots`, `audiencia_slots`, `operating_days`, `slot_duration_hours`, `close_time`). SÁBADO só aos sábados; COMERCIAL/AUDIÊNCIA só seg–sex; a faixa superior usa os horários da inferior (AUDIÊNCIA = 10:00/13:00/15:30 + 18:00/20:30); o pacote precisa terminar até `close_time`.
  - `GET /slot-options?tier=COMERCIAL|AUDIENCIA|SABADO` → `{ tier, slotDurationHours, days: [{ dayOfWeek, slots: [{ time, end, tier }] }] }` na raiz (`dayOfWeek` 0=dom..6=sáb; `tier` do slot = faixa do horário). Faixa inválida → 400.
  - Horário/dia fora da grade → **400 `{ error: 'Horário inválido: … Horários válidos: …', code: 'INVALID_SLOT' }`** (nunca "conflito") em `check-fixo`, `custom/check`, `POST /` (FIXO + `resolvedConflicts[].newTime`), `/self` (1ª gravação, fixo e trocas) e `/custom` (`schedule`, `customDates`, trocas).
  - `check-fixo`: horários livres/sugestões seguem a hierarquia (não mais faixa idêntica) e os dias alternativos ficam só entre os dias permitidos da faixa.
  - `custom/check`: aceita também `frequency` (`WEEKLY` padrão, `BIWEEKLY`, `MONTHLY`, `CUSTOM`), `weekPattern` e `customDates`, e gera as **mesmas** ocorrências do `POST /custom` (`planCustomOccurrences`, com o teto de sessões). Conflito = pacote inteiro sobreposto a reserva/bloqueio; sugestão = outro horário válido da grade no mesmo dia. Resposta inalterada: `{ available, conflicts (≤20), totalConflicts, totalSessions }`.
- **`POST /custom` (D7/D9)**:
  - **Admin** (em nome do cliente via `userId`): contrato `ACTIVE`, sessões `CONFIRMED` (PROGRESSIVE: ciclos 2+ `RESERVED`), todas as parcelas `PENDING` (as de R$ 0, de cupom 100%, nascem `PAID`) e **nenhuma chamada ao gateway** — a cobrança sai pelo ChargeNowSheet (`/stripe/create-payment`) ou fica pendente. Todas as opções (frequências, início, 1–12 meses, cupom).
  - **Cliente**: só `frequency: WEEKLY`, `startDate` ≥ amanhã (SP; padrão = amanhã) e `durationMonths` ∈ {1, 3, 6, 9, 12} (senão 400). Contrato `AWAITING_PAYMENT` com `paymentDeadline` = agora + `config.studio.lockTtlSeconds` (10 min), sessões `RESERVED` (sem `holdExpiresAt`; ocupam a agenda) e **só a 1ª parcela** cobrada no gateway (PIX/boleto; cartão segue pelo checkout inline). PIX/boleto com CPF/CNPJ inválido → **400 `code: 'CPF_CNPJ_REQUIRED'` antes de criar qualquer coisa**; falha real do provedor → 502 com a mensagem (rollback total). Não pagou no prazo → a varredura `cleanExpiredHolds` apaga contrato, sessões e parcelas.
  - Anti-overbooking: ocorrência cujo pacote já está ocupado é **pulada** (como no FIXO do admin) e listada em `skipped: [{ date, time }]`; se todas estiverem ocupadas → 409 `ALL_SLOTS_TAKEN`.
  - Resposta 201: `{ contract, status, paymentDeadline (ISO|null), payments: [{ id, amount, dueDate, status }], summary: { …, totalBookingsGenerated, skippedOccurrences }, skipped, message, firstPaymentId, clientSecret?, firstPixString?, qrCodeDataUrl?, expiresAt? }`. `qrCodeDataUrl` (PNG em data URL) e `expiresAt` (ISO) só vêm no PIX do **cliente**: a validade do QR da 1ª parcela é o próprio `paymentDeadline` (10 min), e o checkout (`/stripe/create-payment` → `issuePixCharge`) reaproveita esse mesmo QR sem estender o prazo.
  - Desconto por **volume** (nº total de gravações), lido da BusinessConfig: ≥ `episodes_6months` → `discount_6months`; ≥ `episodes_3months` → `discount_3months`; abaixo → 0 (padrão 12/24 → 30%/40%). É a mesma régua exibida pelo assistente.
  - Antes de gerar as sessões (e antes do cupom), os personalizados `AWAITING_PAYMENT` **vencidos** (`paymentDeadline` < agora) do mesmo cliente são descartados pela rotina segura da varredura (`purgeAwaitingContract`: pago → ativa; em andamento → mantém; senão cancela a cobrança, libera o cupom e apaga). O mesmo vale para o `custom/check`, que aceita `userId?` (admin: cliente-alvo; sem ele o admin não descarta nada). Assim as sessões `RESERVED` de uma tentativa vencida não viram conflito nem prendem o cupom até a varredura passar.
  - Ao pagar a 1ª parcela, o contrato vira `ACTIVE` e as sessões `RESERVED` são promovidas a `CONFIRMED` (`paymentEffects.activateAwaitingContract`: FULL → todas; PROGRESSIVE → só o 1º ciclo). Com PAID encontrado pela varredura, idem.
- **`POST /service` (D1/D2)** — body `{ serviceKey, paymentMethod: 'PIX'|'CARTAO'|'BOLETO', durationMonths?, paymentPlan?: 'MONTHLY'|'FULL', couponCode?, cardSplit?: boolean }`.
  - `cardSplit: true` só com plano **MONTHLY + CARTAO** (senão **400**): cobra o **total** agora, parcelado em até N× **sem juros** (N = meses da fidelidade) — grava `paymentPlan: 'FULL'` e `Payment.metadata.installmentCap = N`. `FULL` → `installmentCap = 1` (PIX com desconto ou cartão 1×). MONTHLY sem `cardSplit` → mensalidade 1×/mês (como antes). Toda cobrança única (`FULL`, inclusive o `cardSplit`) leva a marca `pixDiscount` dos dois preços (E2): no cartão cobra o total; se o cliente trocar para o PIX no checkout, o QR sai com o desconto PIX. `paymentMethod: 'BOLETO'` → **400** `BOLETO_NOT_ALLOWED_HERE`.
  - Contrato `AWAITING_PAYMENT` com `paymentDeadline` = agora + `config.studio.lockTtlSeconds` (**10 min**); o QR PIX expira junto. Antes de criar, uma contratação anterior **não paga** do mesmo usuário + serviço é descartada pela rotina segura da varredura (`purgeAwaitingContract`); se ela estiver paga → **409** ("já está ativo"); com pagamento em processamento → **409**.
  - Resposta 201: `{ contractId, firstPaymentId, amount, paymentDeadline (ISO), paymentPlan: 'MONTHLY'|'FULL', installmentCap?, couponDiscount?, clientSecret?, pixString?, expiresAt? (ISO, PIX), message }`. Cupom 100%: `{ contractId, firstPaymentId, amount: 0, alreadyPaid: true, couponDiscount, message }`.
- **`POST /:id/pay`** (contrato `AWAITING_PAYMENT` do próprio cliente) — `{ paymentMethod?: 'CARTAO'|'PIX' (padrão CARTAO), couponCode? }`.
  - Contrato do cliente em `PENDING_CANCELLATION` → **409** `{ error: 'Este contrato está com cancelamento em análise. Aguarde a decisão do estúdio.', code: 'CANCELLATION_PENDING' }` (em vez do 404 dos demais status).
  - PIX: usa `issuePixCharge` (reusa só a cobrança viva e com o mesmo valor; senão concilia/cancela e emite nova). Resposta `{ provider: 'SICOOB'|'CORA', paymentId, pixString, qrCodeDataUrl, qrCodeBase64, expiresAt (ISO), amount, reused, couponDiscount?, message }`; se a conciliação achar a cobrança já paga: `{ provider, paymentId, amount, alreadyPaid: true, message }`.
  - Cartão numa linha que tinha PIX: aposenta o PIX vivo antes (se já pago → `{ …, alreadyPaid: true }`) e limpa `pixString/pixExpiresAt`.
  - Cobrança reaproveitada (PIX e cartão): a `PENDING` do **plano** (`bookingId: null`) que vence primeiro — nunca um extra de gravação do contrato (Z1-d); sem nenhuma, cria a do plano.
- **`POST /:id/client-renew`**: aceita `ACTIVE`, `EXPIRED` e **`COMPLETED`** (D6; exceto avulso). `COMPLETED` é tratado como `ACTIVE`: janela dos últimos 7 dias e início no fim do contrato atual. Prazo de pagamento da renovação continua 3 dias. `paymentMethod: 'BOLETO'` (ou contrato original em boleto sem informar outra forma) → **400** `BOLETO_NOT_ALLOWED_HERE` (a renovação é paga por PIX ou cartão).
- **`POST /:id/subscribe` (E9 — "Ativar cobrança automática")** — body `{ paymentMethodId }` (id do `SavedPaymentMethod` **ou** o `pm_…` do Stripe, ex.: o cartão recém-cadastrado por SetupIntent; `durationMonths` é aceito e ignorado). **Não cria assinatura Stripe nem `Payment`** (a assinatura paralela cobrava em dobro). Liga `User.autoChargeEnabled` (por **cliente** — vale para todos os contratos dele) e torna o cartão o padrão; quem cobra é o `autoChargeJob`, as parcelas que já existem. Idempotente.
  - 200: `{ success: true, autoChargeEnabled: true, alreadyEnabled, scope: 'USER', defaultCard: { id, stripePaymentMethodId, brand, last4, expMonth, expYear, funding, isDefault: true }, message }`.
  - Erros: contrato de outro cliente → **404**; `CANCELLED` → **400** `CONTRACT_CANCELLED`; à vista sem cobrança pendente **do plano** (extras de gravação, com `bookingId`, não contam) → **400** `NOTHING_TO_CHARGE`; cartão que não é do cliente (ou não existe mais no Stripe) → **404** `CARD_NOT_FOUND`; débito/pré-pago → **400** `CARD_NOT_CREDIT`; Stripe desligado → **503**; falha ao conferir o cartão/definir o padrão no Stripe → **502** (nada muda).

## users — `/api/users` ([routes](../../backend/src/modules/users/routes.ts)) · Equipe (só clientes)

Trata **só de CLIENTE**: a equipe é gerenciada em [`/api/staff`](#staff--apistaff-routes--só-admin).

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| GET | `/` | `clientes.ver` \| `agendamentos.ver` \| `contratos.ver` \| `cupons.ver` \| `avisos.enviar` | Lista os clientes (`role = 'CLIENTE'`, `deletedAt: null`; `?role` ≠ CLIENTE → 400 `ROLE_NOT_ALLOWED`); `contracts[]` = `{ type, status, addOns, endDate, durationMonths }` (plano Concluído vigente — `isPlanInForce`); `totalPaid` = soma do valor **efetivamente cobrado** das pagas, `totalPending` = soma do `amount` das pendentes. Sem `clientes.ver`, `agendamentos.criar`, `contratos.criar` ou `cobrancas.cobrar`, devolve só o diretório `{ id, name, email, role }` |
| GET | `/:id` | `clientes.ver` | Detalhe do cliente (inclui `deletedAt` — perfil histórico de cliente excluído); `payments[]` traz `chargedAmount`, `provider` e `providerRef` |
| POST | `/` | `clientes.criar` + regras | Cria cliente (sempre CLIENTE; e-mail em minúsculas; duplicado sem diferenciar maiúsculas → 409 `EMAIL_TAKEN`). `password` opcional e só ADMIN; nascer BLOCKED exige `clientes.acesso` |
| PATCH | `/:id` | Equipe + regra por valor alterado | Atualiza cliente (409 se excluído). Regras em [permissoes-equipe.md](permissoes-equipe.md#regras-que-dependem-do-corpo-libpermissionrulests): e-mail de login e bloqueio → `clientes.acesso`; senha → só ADMIN; cadastro → `clientes.editar` |
| GET | `/:id/deletion-preview` | `clientes.excluir` | Consequências reais da exclusão (para o modal) |
| DELETE | `/:id` | `clientes.excluir` (+ a chave de tudo que a exclusão anularia — ver abaixo) | Exclui o cliente: físico sem vínculos, soft delete + anonimização com vínculos |
| GET | `/:id/purge-preview` | **só ADMIN** | Prévia da exclusão definitiva de QUALQUER conta: `{ preview: { id, name, role, alreadyDeleted, contracts, bookings, payments, paidPayments, paidAmount, blockedSlots } }` |
| DELETE | `/:id/permanent` | **só ADMIN** | Exclusão DEFINITIVA de qualquer conta (cliente, já excluído ou não, colaborador, outro administrador): concilia e cancela no provedor o que estiver vivo (pagamento em processamento → 409) e apaga a conta com contratos, gravações, cobranças (inclusive as pagas) e resgates de cupom (o uso volta ao cupom); bloqueios de agenda que a pessoa criou passam para quem exclui. A própria conta → 400; inexistente → 404; último administrador ativo → 409 `LAST_ADMIN`. Auditoria `PURGED` (sem dados pessoais). Resposta `{ message, removed }` |
| GET | `/:id/payment-overview` | `clientes.ver` \| `financeiro.ver` \| `cobrancas.automatica` | Resumo de pagamento do cliente (parcelas, cartões e estado da cobrança automática) — o card "Pagamento" do perfil |
| PATCH | `/:id/auto-charge` | `cobrancas.automatica` | Liga/desliga cobrança automática (409 se excluído). Ligar exige cartão de **crédito** conferido no Stripe: mesmos status/códigos do `PUT /stripe/auto-charge` (400 sem cartão, 400 `CARD_NOT_CREDIT`, 404 `CARD_NOT_FOUND`, 502/503), com mensagens sobre o cartão do cliente; ligado, o cartão conferido vira o padrão do cliente (Z1-a). Auditoria `AUTO_CHARGE_TOGGLED_BY_STAFF` |

- Alvo que não é CLIENTE → 404 "Cliente não encontrado." (em `GET /:id`, `PATCH`, `payment-overview`, `auto-charge`); em `DELETE` e `deletion-preview`, 400 "Contas da equipe não são excluídas por aqui…".
- `role: 'CLIENTE'` no corpo é aceito e ignorado (bundle antigo da PWA); outro papel → 400 `ROLE_NOT_ALLOWED`.
- `PATCH`: diferença só de maiúsculas no e-mail é normalização (sem `clientes.acesso` e sem revogar). Trocar o e-mail de login de fato zera o `googleId`, encerra as sessões do cliente e avisa o e-mail antigo; bloquear e definir senha também encerram as sessões. Corpo sem nenhuma mudança exige `clientes.editar`, `clientes.acesso` ou `cobrancas.cobrar`. Auditoria `CLIENT_CREATED`, `CLIENT_UPDATED { fields }` e `CLIENT_ACCESS_CHANGED` (sem valores).

**Exclusão de cliente (D3, [lib/userDeletion.ts](../../backend/src/lib/userDeletion.ts))**

- Vínculo de negócio = contratos, agendamentos, pagamentos, resgates de cupom, bloqueios de agenda criados.
  Notificações, push, cartões salvos e elegibilidade de cupom são acessórios (apagados em qualquer modo).
- Sem vínculo → `user.delete` físico (acessórios por CASCADE). Um vínculo criado em corrida (P2003) cai no soft.
- Com vínculo → soft delete, sem bloquear por pendências: contratos ACTIVE/PAUSED/AWAITING_PAYMENT/
  PENDING_CANCELLATION → CANCELLED com parcelas PENDING anuladas (`voidContractPendingPayments`); demais
  PENDING do cliente (inclusive sem contrato) → CANCELLED com o cupom reservado devolvido; gravações futuras
  RESERVED/HELD/CONFIRMED → CANCELLED (travas Redis liberadas); janelas de remarcação OPEN → EXPIRED;
  `autoChargeEnabled=false`; cartões desvinculados no Stripe (best-effort). Numa transação: `deletedAt`,
  e-mail/googleId/senha/CPF/telefone/endereço/foto/redes/notas → null, `tags=[]` (ficam `name` e
  `stripeCustomerId`); apaga push, cartões, elegibilidade de cupom e notificações. AuditLog `USER`
  `SOFT_DELETED`/`DELETED` só com contagens (sem dados pessoais). Pagamentos PAID ficam intactos.
- Antes de anular, cada cobrança PENDING com `providerRef` é conciliada e cancelada no provedor (contrato:
  `settleContractCharges`; sem contrato: `retirePixCharge` / PaymentIntent). Pago no provedor → fica PAID
  (entra em `paidDuringDeletion`). Em andamento — cartão `processing` ou 3DS < 30 min, provedor fora do ar,
  PIX que continua pagável (`retirePixCharge` → `live`, com ou sem contrato) — → **409** `Há um pagamento
  deste cliente em processamento no provedor…` sem anular nada (cobrança automática e sessão restauradas).
- Gravações canceladas = RESERVED/HELD/CONFIRMED sem `recordingStartedAt` cujo início (data + hora SP) ainda
  não chegou; as de hoje já iniciadas ficam para o operador.
- Recusas (mesmas no preview e no DELETE): 400 auto-exclusão ou conta da equipe · 404 inexistente ·
  409 já excluído ou exclusão em andamento.
- **Permissões do que a exclusão anula (conserto 5)**: para a EQUIPE (o ADMIN não confere), `DELETE /:id` exige
  também `contratos.cancelar` com contrato ACTIVE/PAUSED/AWAITING_PAYMENT/PENDING_CANCELLATION, `contratos.multa`
  com contrato em PENDING_CANCELLATION ou multa de cancelamento que a exclusão anularia, e `cobrancas.baixa` com
  cobrança que ela anularia de sessão (`bookingId`), sem contrato (PENDING) ou de contrato já encerrado (o que ainda tem
  PENDING) — a mesma conta da anulação (`deletionSettleRequirements`). Faltando alguma → **403**
  `{ code: 'PERMISSION_DENIED', permission: <a 1ª que falta>, missingPermissions: [...], error: 'Excluir este
  cliente anula o que ele tem em aberto, e isso exige também … Nada foi excluído: peça a quem tem …' }`, antes de
  cancelar ou anular qualquer coisa. Ordem: `contratos.cancelar`,
  `contratos.multa`, `cobrancas.baixa`. O `deletion-preview` traz `missingPermissions` e `blockedMessage` (o mesmo
  texto do 403, ou `null`): o modal não abre o diálogo de perigo quando falta alguma. As conferências que só leem
  (o 403 e os 400/404/409 da validação) rodam **antes** do mutex e da revogação da sessão (rodada 7): a exclusão
  recusada não desloga o cliente nem trava o login dele. Elas se repetem sob o mutex, depois da revogação provisória
  (algo aberto no meio do caminho); uma recusa nesse ponto desfaz a revogação provisória.
- `GET /:id/deletion-preview` → `{ preview: { userId, name, mode: 'hard'|'soft',
  links: { contracts, bookings, payments, couponRedemptions, blockedSlots },
  pending: { activeContracts, futureBookings, pendingPayments, pendingAmount },
  preserved: { paidPayments, paidAmount }, accessories: { savedCards, pushSubscriptions, notifications,
  couponEligibilities, autoChargeEnabled } } }` (valores em centavos; `paidAmount` = valor efetivamente
  cobrado das pagas — no cartão, o do PaymentIntent).
- `DELETE /:id` → `{ message, softDeleted, cancelled: { contracts, bookings, payments }, paidDuringDeletion: { payments, amount } }`
  (no front, `usersApi.remove` tipa `paidDuringDeletion?`; hard delete devolve `{ payments: 0, amount: 0 }`).
  `paidDuringDeletion` = cobranças PENDING na abertura que foram confirmadas no provedor durante a exclusão
  (centavos); ficam PAID, sem estorno automático, e a `message` ganha `Atenção: N pagamento(s) (R$ X) …`.
- Conta excluída: login (senha/OTP/Google) e `POST /api/auth/refresh` → 401 `Conta não encontrada.`;
  `GET /api/auth/me`, `PATCH /api/auth/profile` e `POST /api/auth/profile/photo` → 404. `createNotification`
  ignora contas excluídas.
- Sessão encerrada **na hora** (excluir ou bloquear): `revokeUserSessions` grava `auth:revoked:<userId>` no
  Redis (instante da revogação; TTL = validade do **refresh** token, 30 dias, + 60 s — antes era só a do
  access token, e o refresh antigo voltava a valer uma hora depois). O `authenticate` responde 401
  `Sessão encerrada. Faça login novamente.` a todo access token com `iat` ≤ esse instante, e o
  `POST /api/auth/refresh` recusa (401 `SESSION_REVOKED`, mesma mensagem) refresh token anterior a ele — fecha a corrida de um
  refresh no meio da exclusão (o `deletedAt` só é gravado no fim). Com a exclusão em andamento (mutex
  `mutex:user-delete:<userId>`), o login por senha/OTP/Google responde **409** `Não foi possível entrar
  agora…` sem emitir sessão. A exclusão revoga no início e de novo **depois do commit** (soft e hard), com
  folga de 60 s para login/refresh que leram o usuário antes. Redis fora/lento (> 500 ms) → fail-open (as
  guardas do banco continuam valendo).
- Exclusão que **falha** (ex.: 409) com o cliente ainda existente e não bloqueado: a revogação provisória do
  início é desfeita **restaurando a anterior** (valor e validade restante; sem revogação anterior → a chave
  é apagada; revogação feita no meio da exclusão → mantida; Redis ilegível antes → a provisória fica).

## pricing — `/api/pricing` ([routes](../../backend/src/modules/pricing/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| GET | `/` | Público | Lista os tiers e preços |
| PUT | `/` | `config.precos` | Atualiza preços dos tiers |
| GET | `/addons` | Público | Lista serviços (add-ons) |
| GET | `/addons/all` | `config.servicos` | Todos os serviços (inclui inativos) |
| PUT | `/addons` | `config.servicos` | Atualiza serviços |
| DELETE | `/addons/:key` | `config.servicos` | Remove (ou inativa, se já usado) um serviço |
| GET | `/payment-methods` | Público | Métodos de pagamento ativos + estado do boleto |
| GET | `/payment-methods/all` | `config.pagamentos` | Todos os métodos (inclui inativos) + estado do boleto |
| PUT | `/payment-methods` | `config.pagamentos` | Atualiza configuração dos métodos |
| PUT | `/payment-methods/boleto` | `config.pagamentos` | Chave-mestra "Aceitar pagamento por boleto" (E3) |
| GET | `/business-config/public` | Público | Configuração pública do negócio |
| GET | `/business-config` | qualquer `config.*` | Configuração, só dos grupos que a pessoa pode ver (ADMIN: todos) |
| PUT | `/business-config` | Equipe + regra por grupo | Atualiza configuração (tudo ou nada) |
| GET | `/business-config/fee-history` | Só ADMIN | Linha do tempo das taxas de gateway (`config.taxas`) |
| POST | `/business-config/email/test` | Só ADMIN | Teste de SMTP (`config.email`) |
| POST | `/checkout-quote` | Autenticado | Cotação autoritativa (valor + parcelas) |

- **Business-config por grupo (equipe)**: cada linha vale pelo grupo (`studio` → `config.gerais`, `schedule` → `config.horarios`, `plans`/`payments` → `config.precos`, `policies` → `config.politicas`, `ambient` → `config.ambiente`, `recordings` → `config.gravacoes`; `email` e `gateway` e qualquer grupo sem mapeamento → só ADMIN). O `GET` filtra `configs` e `grouped`; o `PUT` exige a permissão de **todos** os grupos tocados, senão **403** `{ error, code: 'PERMISSION_DENIED', permission: <primeira que falta>, deniedGroups: string[] }` antes de qualquer escrita. Chaves aposentadas (`DEPRECATED_CONFIG_KEYS`) não contam.

- **Boleto (E3)** — fonte única `getBoletoStatus()` (`lib/paymentGateway.ts`): `boleto = { enabled, providerEnabled, available, reason, message }`. `enabled` = chave-mestra (`PaymentMethodConfig BOLETO.active`); `providerEnabled` = integração Cora habilitada com credenciais do ambiente ativo; `available` = os dois; `reason` = `'PROVIDER_DISABLED'` (Cora inativa — tem precedência), `'SWITCH_OFF'` ou `null`; `message` = texto pronto para a tela (ou `null`).
  - `GET /payment-methods` → `{ methods, boleto }`. `BOLETO` só vem em `methods` quando `boleto.available`. Sem nenhum método configurado, os padrões devolvidos são só PIX e Cartão. **A rota é pública, então `boleto` vem saneado**: só `available` informa (`enabled` e `providerEnabled` repetem `available`; `reason` e `message` são sempre `null`). A posição da chave, o estado da integração Cora e o texto de administração **não** saem aqui.
  - `GET /payment-methods/all` (ADMIN) → `{ methods (todos), boleto }` com o `boleto` **completo** (`enabled`, `providerEnabled`, `available`, `reason`, `message`) — é de onde as telas do admin leem o motivo do boleto indisponível. Na 1ª leitura o boleto é semeado **desligado**.
  - `PUT /payment-methods/boleto` — `{ enabled: boolean }` → `{ boleto, message }`. Ligar com a Cora inativa → **400** `{ error, code: 'BOLETO_PROVIDER_DISABLED', boleto }`; desligar é sempre permitido.
  - `PUT /payment-methods` (lote) → `{ methods, boleto, message }`. Ligar o boleto no lote (`active` de `false` para `true`) com a Cora inativa → **400** `BOLETO_PROVIDER_DISABLED` e **nada** do lote é gravado; um boleto que já estava ligado não bloqueia salvar os demais (ele só não fica efetivo).

## payments — `/api/payments` ([routes](../../backend/src/modules/payments/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| GET | `/` | `financeiro.ver` | Lista pagamentos |
| GET | `/summary` | `financeiro.ver` | Resumo financeiro (receita paga pelo valor efetivamente cobrado — `paidChargedAmount`) |
| PATCH | `/:id` | `cobrancas.baixa` | Atualiza um pagamento (baixa manual, anular, estornar) |
| GET | `/sandbox-mode` | Autenticado | Indica se o gateway está em sandbox |
| GET | `/:id/status` | Misto: dono ou `cobrancas.cobrar` \| `financeiro.ver` \| `cobrancas.baixa` | Status de um pagamento |
| POST | `/:id/simulate` | Misto: dono ou `cobrancas.cobrar` | Simula confirmação — só com o provedor efetivo em sandbox |

- **Sandbox efetivo** — `GET /sandbox-mode` → `{ pix, card }` e `POST /:id/simulate` usam o **mesmo** critério (`isProviderSandbox`, em `payments.client.ts`): a integração do provedor precisa estar **habilitada** e no ambiente `sandbox`; no Sicoob, também precisa ser o ambiente que o deploy pode operar (`sicoobAllowedEnvironment`: num servidor com `NODE_ENV=production` o Sicoob em sandbox não conta). `pix` = o provedor de PIX ativo (`resolvePixProvider`: Sicoob, senão Cora); `card` = Stripe.
- **`POST /:id/simulate`** — 404 se o pagamento não é de quem chama (o admin alcança qualquer um); **403** `{ error }` se o provedor **efetivo** da cobrança não está em sandbox; senão `PENDING → PAID` + `onPaymentConfirmed` → `{ status: 'PAID', message }`. Provedor efetivo: `STRIPE` para cartão; para PIX/boleto, quem **emitiu** a cobrança (linha com `providerRef`) ou, se a linha ainda é um placeholder sem cobrança emitida (ex.: o `CORA` gravado na criação do avulso), o provedor de PIX ativo. Uma integração desligada nunca habilita a simulação, mesmo com `environment = 'sandbox'`.

## stripe — `/api/stripe` ([routes](../../backend/src/modules/stripe/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| GET | `/publishable-key` | Autenticado | Chave pública da Stripe |
| POST | `/setup-intent` | Cliente | Cria SetupIntent (salvar cartão) |
| POST | `/setup-intent/confirm` | Autenticado | Persiste o cartão do SetupIntent confirmado (uso imediato) |
| GET | `/payment-methods` | Autenticado | Lista cartões salvos de quem está logado |
| GET | `/payment-methods/for-payment/:paymentId` | `cobrancas.cobrar` | Cartões salvos e CPF do **cliente** dono do pagamento (E1); cartões só com `cobrancas.cartao_salvo` |
| DELETE | `/payment-methods/:pmId` | Autenticado | Remove cartão |
| PUT | `/payment-methods/:pmId/default` | Autenticado | Define cartão padrão |
| POST | `/create-payment` | Misto: dono ou `cobrancas.cobrar` (+ `cobrancas.cartao_salvo` com cartão salvo) | Cria PaymentIntent (cartão/PIX/boleto) |
| POST | `/installment-plans` | Autenticado (com `paymentId`, equipe: `cobrancas.cobrar`) | Planos de parcelamento (1–12x com taxas) |
| GET | `/auto-charge` | Autenticado | Estado da cobrança automática + cartão que será cobrado |
| PUT | `/auto-charge` | Cliente | Liga/desliga a própria cobrança automática (a equipe usa `PATCH /users/:id/auto-charge`) |
| POST | `/verify-payment` | Misto: dono ou `cobrancas.cobrar` | Recuperação manual de webhook (verifica PI) |

- **Equipe cobrando (nov/2026)**: em `create-payment`, a equipe sem `cobrancas.cobrar` recebe 403 antes de tudo (inclusive do zod); com `savedPaymentMethodId` preenchido, também `cobrancas.cartao_salvo` (403 antes de qualquer efeito). Onde o texto abaixo diz "admin", leia "equipe com `cobrancas.cobrar`" (o 2º argumento de `planPaymentBlockedByPendingCancellation` passou a ser essa condição). Os nomes de auditoria `ADMIN_CHARGED_SAVED_CARD`/`ADMIN_CHARGE_STARTED` foram mantidos; `performedBy` = quem cobrou.
- **`POST /create-payment`** — `{ paymentId, paymentMethod?: 'cartao'|'pix'|'boleto', installments?, savedPaymentMethodId?, savePaymentMethod? }`. O admin pode cobrar qualquer pagamento; o **pagador é sempre o dono do pagamento** (Customer Stripe, cartão salvo e CPF/CNPJ do cliente — E1). Não olha o status do contrato (exceto o cancelamento em análise, abaixo): a multa de cancelamento (`metadata.kind = 'CANCELLATION_FINE'`) é pagável com o contrato `CANCELLED`.
  - **Cancelamento em análise (E13)**: com o contrato em `PENDING_CANCELLATION`, o **cliente** não paga parcelas do plano (cobrança sem `bookingId` que não é a multa) → **409** `{ error: 'Este contrato está com cancelamento em análise. Aguarde a decisão do estúdio.', code: 'CANCELLATION_PENDING' }`, antes de qualquer efeito (não reabre `FAILED`, não emite QR nem PaymentIntent). O **admin** continua podendo cobrar; extras de uma gravação (`bookingId`) e a multa seguem pagáveis. Só a emissão é bloqueada: um pagamento já feito (webhook, conciliação, `verify-payment`) é sempre registrado. Regra em `lib/cancellationPending.ts`.
  - **Gravação cancelada (CLI-2)**: cobrança com `bookingId` cuja gravação está `CANCELLED` → **400** `{ error: 'A gravação desta cobrança foi cancelada. Esta cobrança não pode mais ser paga.', code: 'BOOKING_CANCELLED' }`, para cliente **e** admin, antes de qualquer efeito (não reabre `FAILED`, não emite QR nem PaymentIntent). O `POST /contracts/:id/pay` segue a mesma regra: nunca reaproveita a cobrança de uma gravação cancelada (cobra a parcela do plano).
  - **Trilha do admin (SEC-4)**: quando o admin cobra o **cartão** de um cliente, fica um registro em `audit_logs` (entidade `PAYMENT`, `performedBy` = o admin): `ADMIN_CHARGED_SAVED_CARD` (cartão salvo, debitado na hora) ou `ADMIN_CHARGE_STARTED` (cartão novo), com `{ payerUserId, paymentIntentId, amount, installments, method }`. Marca o início da cobrança; a aprovação continua vindo do webhook/`verify-payment`. O metadata do PaymentIntent não muda.
  - **E2 (desconto PIX bidirecional)**: no PIX, uma cobrança à vista que está no preço de cartão da marca (`amount === pixDiscount.cardAmount` e `pixAmount < amount`) passa a valer `pixAmount` (update condicional atômico) antes de o QR sair — `amount` da resposta = preço PIX. Com um PaymentIntent de cartão em andamento → **400** e o valor não muda. No cartão, cobra-se `cardAmount` (nunca mais). Sem a marca, os dois cobram o `amount`.
  - **Cartão salvo** (`savedPaymentMethodId` = id do `SavedPaymentMethod` **ou** `pm_…`): tem de ser do dono do pagamento (linha dele no banco ou cartão anexado ao Customer dele). Cartão de outra pessoa — inclusive o do próprio admin — → **400** `{ error, code: 'CARD_NOT_FOUND' }` antes de qualquer efeito.
  - **CPF/CNPJ** (PIX e boleto): pagador sem documento válido → **400** `{ error, code: 'CPF_CNPJ_REQUIRED', payerUserId }` (para o admin, a mensagem fala do cliente).
  - **Boleto (E3)**: exige o boleto efetivo (senão **400** `{ code: 'BOLETO_UNAVAILABLE', reason }`) e uma cobrança sem prazo de pagamento — contrato `AWAITING_PAYMENT`, contratação `/self` ainda sem contrato ou reserva em espera → **400** `{ code: 'BOLETO_NOT_ALLOWED_HERE' }` (vale também para o admin). `Contract.boletoAllowed` é ignorado. O boleto cobra o **preço de cartão** (uma cobrança que estava no preço PIX volta a `cardAmount`). Resposta: `{ provider: 'CORA', boletoUrl, barcode, amount, paymentId }`.
  - **PIX** (D15, `issuePixCharge`): `{ provider: 'SICOOB'|'CORA', pixString, qrCodeDataUrl ('data:image/png;base64,…'), qrCodeBase64 (compat, sem prefixo), expiresAt (ISO), amount (centavos), reused, alreadyPaid: false, paymentId }`. Reusa só a cobrança viva, com BR Code válido e o mesmo valor; senão concilia a anterior, cancela e emite nova (txid com sufixo de tentativa). Se a conciliação achar a cobrança paga: `{ provider, status: 'PAID', alreadyPaid: true, amount, paymentId }`. Erros (CPF ausente, provedor desligado, falha) → 400 `{ error }`.
  - **Cartão**: `installments` limitado pela política (inclui `metadata.installmentCap` do serviço); juros só acima de `freeUpTo`. Parcelamento só é habilitado no PI quando `installments > 1`; com **cartão salvo** o plano `fixed_count` vai de fato ao Stripe (se o cartão não oferece N× → erro, nada é cobrado). Se a linha tinha PIX vivo, ele é aposentado antes (já pago → **400** `{ error, status: 'PAID', alreadyPaid: true }`). Resposta: `{ provider: 'STRIPE', clientSecret, paymentIntentId, amount, installments }` — `amount` = valor do PI (= `chargedAmount`: a base do cartão, sem o desconto PIX do à vista, com juros quando parcelado); o checkout exibe este valor.
  - Valor base do cartão = `cardChargeBaseAmount`: `metadata.pixDiscount.cardAmount` quando a cobrança tem a marca (e ela não caducou); senão o próprio `amount`. Não há fallback legado: cobrança antiga sem a marca sai pelo `amount`, abaixo do preço de cartão e nunca acima (ver pagamentos.md). Valor 0 → 0 (nunca vai ao cartão).
  - **Linha `FAILED` com PaymentIntent (Z1-e)**: antes de reabrir, o PI do `providerRef` é consultado (só leitura); `succeeded`/`processing`/`requires_capture` → **409** `{ error, code: 'CARD_PAYMENT_IN_FLIGHT' }` para **qualquer** `paymentMethod` (cartão, PIX, boleto) e a linha **não** é reaberta (segue `FAILED` apontando para o PI; o webhook/verify a baixam — PAY-6). Stripe desligado, PI inexistente ou falha na consulta → reabre como antes.
  - **PI anterior da mesma cobrança** (`providerRef` pi_…, inclusive de uma linha `FAILED` reaberta): `succeeded`/`processing`/`requires_capture` → **409** `{ error, code: 'CARD_PAYMENT_IN_FLIGHT' }` e nenhum PI novo; pagável com **outro valor** → cancelado antes de criar o novo; não foi possível consultar/cancelar → **503**. O mesmo vale no cartão do `POST /contracts/:id/pay` (que reaproveita o PI pagável de mesmo valor).
  - Pagamento `FAILED` é reaberto (`PENDING`) limpando `providerRef/pixString/pixExpiresAt/boletoUrl/chargedAmount`.
- **`POST /installment-plans`** — `{ paymentId? , amount?, contractDurationMonths?, installmentCap? (1–12) }` → `{ plans: [{ count, perInstallment, total, feePercent, freeOfCharge }], cardAmount, pixAmount }`. `cardAmount` = o que o cartão cobra em 1x; `pixAmount` = o que o PIX cobra (com o desconto do à vista quando a cobrança tem a marca — E2) — o checkout mostra o preço certo em cada aba **antes** de gerar. Sem `paymentId`, os dois são o `amount` informado. Com `paymentId`, a política vem do pagamento (serviço com teto → só 1..N, todas sem juros). Sem `paymentId`, `installmentCap` permite a prévia do serviço (ex.: `installmentCap: 3` → 1x–3x sem juros; `1` → só 1x). Com `paymentId`, o valor é `cardChargeBaseAmount` (a base marcada ou o `amount`); valor 0 → **400** `{ error: 'Valor inválido.' }`.

- **`POST /setup-intent/confirm` (E9)** — `{ setupIntentId, makeDefault?: boolean }` → `{ card: { id, stripePaymentMethodId, brand, last4, expMonth, expYear, funding, isDefault }, message }`. Chame depois de `stripe.confirmSetup` (Stripe Elements): grava o cartão no banco sem esperar o webhook `setup_intent.succeeded` (idempotente; não duplica a linha do webhook). O SetupIntent tem de ser do Customer do usuário (**404** `SETUP_INTENT_NOT_FOUND`) e estar `succeeded` (**409** `SETUP_INTENT_NOT_CONFIRMED`). Não liga a cobrança automática (isso é o `POST /contracts/:id/subscribe` ou o `PUT /auto-charge`). Com a cobrança automática **ligada**, `makeDefault` de um cartão de débito/pré-pago salva o cartão mas **não** o torna padrão: a resposta traz `card.isDefault: false` e `defaultNotApplied: { code: 'CARD_NOT_CREDIT', error }`.
- **`GET /payment-methods/for-payment/:paymentId` (equipe com `cobrancas.cobrar`, E1)** → `{ paymentMethods: [{ id, stripePaymentMethodId, brand, last4, expMonth, expYear, funding, isDefault }], canUseSavedCards, autoChargeEnabled, payer: { id, name, cpfCnpj, hasValidCpfCnpj, deleted } }` — os cartões e o CPF do **cliente** dono do pagamento (nunca os de quem cobra). Sem `cobrancas.cartao_salvo`: `paymentMethods: []` e `canUseSavedCards: false`, sem consultar o Stripe nem os cartões do banco. Nunca cria Customer; Stripe desligado/fora do ar → cartões do banco com `funding: 'unknown'`.
- **`GET /auto-charge` (E9)** → `{ autoChargeEnabled, scope: 'USER', hasSavedCard, savedCards, defaultCard: { id, stripePaymentMethodId, brand, last4, expMonth, expYear, isDefault } | null }`. `defaultCard` = o cartão que o `autoChargeJob` usaria (o padrão ou, sem padrão, o mais recente).
- **`PUT /auto-charge` (E9)** — body `{ enabled: boolean }` → `{ message }`. **Desligar** é sempre aceito e não consulta o Stripe. **Ligar** exige que o cartão que o job cobraria (o mesmo `defaultCard` do `GET`) seja de **crédito**, conferido no Stripe como no `POST /contracts/:id/subscribe`:
  - débito ou pré-pago → **400** `{ error: 'A cobrança automática aceita apenas cartão de crédito.', code: 'CARD_NOT_CREDIT' }` (novo; mesmo corpo do `/subscribe`). `funding` `unknown` é aceito;
  - nenhum cartão salvo → **400** `{ error: 'Adicione pelo menos um cartão antes de ativar a cobrança automática.' }` (sem `code`, como antes);
  - cartão que não pôde ser conferido: Stripe desligado → **503**; falha na consulta → **502**; cartão que não existe mais no Stripe ou não é do Customer do usuário → **404** `CARD_NOT_FOUND`. Em todas as recusas `autoChargeEnabled` fica como estava.
  - A conferência é única (`lib/savedCards.checkAutoChargeCard`) e vale também no `POST /contracts/:id/subscribe` e no `PATCH /users/:id/auto-charge` do admin (mesmos status/códigos; mensagens na 3ª pessoa).
  - Ligado com sucesso, o cartão conferido **vira o padrão** (Z1-a — banco + padrão no Stripe em best-effort; também no `PATCH` do admin): um cartão salvo depois não assume a cobrança sem conferência. Corpo da resposta inalterado.
- **`PUT /payment-methods/:pmId/default`** → `{ message }`. Com a cobrança automática **ligada**, o novo padrão passa pela mesma conferência antes de qualquer efeito: débito/pré-pago → **400** `{ error: 'Com a cobrança automática ligada, o cartão padrão precisa ser de crédito. Desligue a cobrança automática ou escolha um cartão de crédito.', code: 'CARD_NOT_CREDIT' }`; cartão que não é do cliente → **404** `CARD_NOT_FOUND`; Stripe não respondeu → **502**. Com ela desligada, a troca segue livre.
- **`DELETE /payment-methods/:pmId`** → `{ message }`. Se o cartão removido era o que a cobrança automática cobra (o padrão ou, sem padrão, o mais recente) e ela está **ligada**, o substituto (o salvo mais recente) passa pela mesma conferência — aprovado, **vira o padrão** (Z1-a; resposta de sempre); sem substituto ou reprovado, a cobrança automática é **desligada** e a resposta vira `{ message, autoChargeEnabled: false, autoChargeDisabled: true, autoChargeDisabledReason: 'NO_CARD' | 'CARD_NOT_CREDIT' | 'CARD_NOT_FOUND' | 'CARD_NOT_VERIFIED' }` (auditoria `AUTO_CHARGE_DISABLED` na entidade `USER`). O cartão é removido de qualquer forma.
- **`POST /verify-payment`** — `{ paymentId, paymentIntentId }`. Só responde `{ status: 'PAID' }` quando a linha está `PAID`: baixa uma linha `PENDING` ou uma `FAILED` de cartão cujo `providerRef` é o **mesmo** PaymentIntent aprovado (PAY-6). PI aprovado mas a linha não pôde ser baixada (ex.: `FAILED` de outra tentativa) → **409** `{ error, code: 'PAYMENT_NOT_SETTLED', paymentStatus }` e nada muda. PI ainda não aprovado → 200 com o status atual da linha.

## webhooks — `/api/webhooks` ([routes](../../backend/src/modules/webhooks/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| POST | `/cora` | Assinatura | Webhook da Cora (PIX/boleto) |
| POST | `/stripe` | Assinatura | Webhook da Stripe (precisa do corpo bruto) |

- **`payment_intent.succeeded` numa cobrança já `PAID` (Z1-c)**: se a baixa foi por **outro** PaymentIntent, o cliente foi cobrado duas vezes — a linha não muda, os admins recebem `admin_card_double_charge` (1 aviso por PI excedente; auditoria `DOUBLE_CARD_CHARGE`) para estornar no painel do Stripe. Mesmo PI da baixa → nada; paga por outro meio (PIX/boleto) → só log `[Webhook:Stripe][SECURITY]`. Ver [pagamentos.md](pagamentos.md#cobrança-automática-e9).

## notifications — `/api/notifications` ([routes](../../backend/src/modules/notifications/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| GET | `/` | Autenticado | Notificações (computadas + persistidas) |
| PATCH | `/read-all` | Autenticado | Marca todas como lidas |
| PATCH | `/:id/read` | Autenticado | Marca uma como lida |
| DELETE | `/:id` | Autenticado | Remove uma notificação |
| GET | `/admin/events` | `avisos.modelos` \| `avisos.enviar` | Catálogo de eventos com os textos efetivos; o colaborador **não** recebe os eventos da equipe (audiência `admin`) |
| PUT | `/admin/templates/:eventKey` | `avisos.modelos` (evento da equipe: só ADMIN) | Personaliza texto, severidade, push e liga/desliga |
| DELETE | `/admin/templates/:eventKey` | `avisos.modelos` (evento da equipe: só ADMIN) | Volta ao texto padrão |
| POST | `/admin/templates/:eventKey/test` | `avisos.modelos` (evento da equipe: só ADMIN) | Envia o aviso de teste para quem pediu |
| POST | `/admin/broadcast` | `avisos.enviar` | Aviso manual para todos os clientes ou uma lista de clientes |
| GET | `/admin/broadcasts` | `avisos.enviar` \| `avisos.modelos` | Histórico de avisos enviados |

- **Equipe (nov/2026)**: para a equipe, `GET /` e `PATCH /read-all` leem papel e permissões do banco (401 `ACCOUNT_DISABLED` / 503 `PERMISSIONS_UNAVAILABLE`). O COLABORADOR só vê os alertas calculados da equipe cuja permissão tem (`STAFF_EVENT_PERMISSIONS`) e deixa de ver o aviso guardado cujo link abre uma tela que ele não acessa mais. Links: contrato expirando e aguardando pagamento → `/admin/contracts/:id`. Ver [notificacoes.md](notificacoes.md#avisos-para-a-equipe-nov2026).
- **Modelos dos avisos da equipe** (`audience: 'admin'`): `PUT`/`DELETE`/`POST …/test` pelo colaborador → **403** `permission: 'ADMIN'`, mesmo com `avisos.modelos`.
- **`POST /admin/broadcast`**: com `target` em lista de ids, todos precisam ser CLIENTE não excluído; senão **400** `{ error, code: 'INVALID_RECIPIENTS', invalidIds }` e nada é enviado (vale também para o ADMIN). Ids repetidos são removidos.

- `GET /` — os alertas computados "faturas vencidas" e "pagamento com cartão falhou" (cliente e admin) não contam a cobrança ligada a uma gravação `CANCELLED` (`payment.booking.status`): ela não é mais pagável (`create-payment` → 400 `BOOKING_CANCELLED`). O push de faturas vencidas (`pushNotificationJob`) aplica o mesmo filtro. Cobre o dado legado; hoje o cancelamento da gravação de plano já anula esses extras (ver bookings).

## reports — `/api/reports` ([routes](../../backend/src/modules/reports/routes.ts)) · `relatorios.ver`

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/summary` | KPIs (sessões, concluídas, faltas, receita, taxas) |
| GET | `/occupancy` | Ocupação por horário e por dia da semana |
| GET | `/tiers` | Distribuição por tier (quantidade + receita) |
| GET | `/audience` | Métricas de audiência (views, pico, chat, duração) |
| GET | `/ranking` | Ranking de clientes por receita |

- **Sem `financeiro.ver`** a receita não é enviada: `summary.totalRevenue` some; `tierBreakdown[]` vem só com `{ tier, count, pct }`; `ranking[]` vem sem `revenue` e ordenado por sessões (depois concluídas, depois nome).

- `GET /ranking?from&to&limit` — sem `limit` (ou com `limit` inválido/0) devolve só os **10** primeiros; não há teto no servidor. A tela de Relatórios pede `limit=10` para o card e um `limit` alto (`FULL_RANKING_LIMIT` = 100000, em `AdminReportsPage.tsx`) para exportar o ranking inteiro no CSV (E6).

## finance — `/api/finance` ([routes](../../backend/src/modules/finance/routes.ts)) · `financeiro.ver`

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/closing/:year/:month` | Fechamento mensal (bruto, taxas por provedor, líquido, pendente) — bruto do pago = valor efetivamente cobrado (`chargedAmount` quando a cobrança paga foi a do cartão; senão `amount`); pendente pelo `amount` |

## integrations — `/api/integrations` ([routes](../../backend/src/modules/integrations/routes.ts)) · Só ADMIN

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/` | Lista as integrações |
| GET | `/:provider` | Configuração de um provedor (`CORA`/`STRIPE`) |
| PUT | `/:provider` | Salva/atualiza credenciais (criptografadas) |
| POST | `/:provider/test` | Testa a conexão |
| POST | `/:provider/toggle` | Habilita/desabilita |
| GET | `/cora/webhooks` | Lista webhooks na Cora |
| POST | `/cora/webhooks` | Registra webhook na Cora |
| DELETE | `/cora/webhooks/:id` | Remove webhook |
| GET | `/sicoob/webhook` | Webhook cadastrado no Sicoob |
| POST | `/sicoob/webhook` | Registra o webhook no Sicoob |
| DELETE | `/sicoob/webhook` | Remove o webhook do Sicoob |

O router tem `router.use(authenticate, requireStaff())` e cada rota `requireAdmin()`: o colaborador recebe 403 `permission: 'ADMIN'`.

## blocked-slots — `/api/blocked-slots` ([routes](../../backend/src/modules/blocked-slots/routes.ts)) · Equipe

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| POST | `/` | `agendamentos.editar` | Cria bloqueio de horário (auditoria `BLOCKED_SLOT/CREATED`) |
| GET | `/?date=YYYY-MM-DD` | `agendamentos.ver` | Lista bloqueios de uma data |
| DELETE | `/:id` | `agendamentos.editar` | Remove um bloqueio (404 se não existe; auditoria `BLOCKED_SLOT/DELETED`) |

O router tem `router.use(authenticate, requireStaff())`: o cliente recebe 403 `permission: 'STAFF'`.

## coupons — `/api/coupons` ([admin](../../backend/src/modules/coupons/coupons.admin.ts), [cliente](../../backend/src/modules/coupons/coupons.client.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| POST | `/validate` | Autenticado (equipe com `userId`: `agendamentos.criar` \| `contratos.criar` \| `cobrancas.cobrar`) | Valida um cupom para um valor; o cliente sempre avalia a si mesmo (`userId` ignorado) |
| GET | `/` | `cupons.ver` | Lista cupons |
| GET | `/:id` | `cupons.ver` | Detalhe do cupom |
| POST | `/` | `cupons.editar` | Cria cupom |
| PATCH | `/:id` | `cupons.editar` | Edita, ativa ou desativa |
| DELETE | `/:id` | `cupons.editar` | Exclui cupom |

## staff — `/api/staff` ([routes](../../backend/src/modules/staff/routes.ts)) · Só ADMIN

Tela Equipe. `router.use(authenticate, requireAdmin())` (papel lido do banco; o colaborador recebe 403 `permission: 'ADMIN'`). Todo `/:id` exige alvo ADMIN ou COLABORADOR não excluído, senão 404 `STAFF_NOT_FOUND`. Regras completas em [permissoes-equipe.md](permissoes-equipe.md#proteções-da-tela-equipe-apistaff).

| Método | Rota | Corpo | Resposta / erros |
| --- | --- | --- | --- |
| GET | `/catalog` | — | `{ modules: [{ key, label, description, levels: { ver, editar, tudo }, actions: [{ key, label, description, level, badges, requires }] }], adminOnly: [{ key, label }], presets: [{ key, label, description, permissions }] }` |
| GET | `/` | — | `{ members: StaffMember[] }` (ADMIN primeiro, depois por nome) |
| POST | `/` | `{ name, email, phone?, title?, role: 'ADMIN'\|'COLABORADOR', permissions?, password?, sendAccessEmail? }` | 201 `{ member, message, accessEmailSent }`; 400 zod; 400 `INVALID_PERMISSION` `{ invalid }`; 409 `EMAIL_IS_CLIENT` \| `EMAIL_TAKEN`. Falha no e-mail de acesso não desfaz o cadastro (`accessEmailSent: false`) |
| PATCH | `/:id` | `{ name?, email?, phone?, title?, role?, permissions? }` | `{ member, message }`; 400 `PASSWORD_NOT_ALLOWED` (com `password`); 400 `SELF_CHANGE_FORBIDDEN`; 403 `ADMIN_TARGET_FORBIDDEN` (troca de e-mail de alvo que é ou já foi ADMIN); 409 `LAST_ADMIN`, `EMAIL_IS_CLIENT`, `EMAIL_TAKEN`; 400 `INVALID_PERMISSION` |
| POST | `/:id/password` | `{ password }` (8 a 128) | `{ message }`; 403 `ADMIN_TARGET_FORBIDDEN` (alvo que é ou já foi ADMIN, inclusive o próprio) |
| POST | `/:id/send-access` | — | `{ message }`; 409 `STAFF_INACTIVE`; 500 `EMAIL_SEND_FAILED`; 429 (10 por 15 min por IP) |
| POST | `/:id/deactivate` | — | `{ member, message }` (idempotente); 400 `SELF_CHANGE_FORBIDDEN`; 409 `LAST_ADMIN` |
| POST | `/:id/reactivate` | — | `{ member, message }` (idempotente); 400 `SELF_CHANGE_FORBIDDEN` |

- `StaffMember` = `{ id, name, email, phone, photoUrl, role, title, permissions, active, isSelf, credentialsLocked, createdAt, updatedAt }`. `permissions`: do COLABORADOR, lidas do banco e sanitizadas; do ADMIN, sempre `[]` (acesso total implícito). `active` = `clientStatus !== 'BLOCKED'`. `credentialsLocked` = e-mail e senha não se alteram por aqui (ADMIN, ou COLABORADOR que já foi ADMIN: o mesmo critério do 403 `ADMIN_TARGET_FORBIDDEN`); vem em todo membro devolvido (lista, `POST`, `PATCH`, `deactivate`, `reactivate`), com no máximo uma consulta à auditoria por resposta, e o `PATCH` que rebaixa um ADMIN já responde `true`.
- E-mail sempre em minúsculas; a checagem ignora maiúsculas. Diferença só de maiúsculas é normalização (sem revogar, em qualquer papel).
- `PATCH` com troca real de e-mail (só alvo COLABORADOR que nunca foi ADMIN): zera `googleId` **e a senha** (a `message` avisa quando havia senha), avisa o e-mail antigo e encerra as sessões. Mudar o papel também encerra as sessões; rebaixar ADMIN → COLABORADOR sem lista grava `[]`; promover grava `[]`. Mudar só as permissões não encerra sessão.
- `password` revoga as sessões do alvo; `deactivate` grava BLOCKED, apaga as `push_subscriptions` e revoga as sessões (as permissões ficam guardadas); `reactivate` volta a ACTIVE.
- O e-mail de "Enviar acesso" não leva senha: "Você foi adicionado à equipe do {studio}. Entre em {FRONTEND_URL}/login com este e-mail ({email}); você receberá um código.".
- Toda mutação roda numa transação com `pg_advisory_xact_lock` (nunca fica sem ADMIN ativo) e grava auditoria `STAFF_*`.

## push — `/api/push` ([routes](../../backend/src/modules/push/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| GET | `/vapid-key` | Público | Chave pública VAPID |
| POST | `/subscribe` | Autenticado | Registra inscrição Web Push |
| DELETE | `/unsubscribe` | Autenticado | Remove inscrição |
| POST | `/test` | Autenticado | Envia push de teste |

## Rate limits

Aplicados via Redis (globais entre instâncias) em `index.ts`:

| Escopo | Janela | Limite |
| --- | --- | --- |
| `/api/auth/login` (inclui `/login/send-code` e `/login/verify-code`), `/api/auth/register` | 15 min | 15 |
| `/api/auth/refresh` | 15 min | 60 |
| `/api/auth/register/send-code`, `/api/auth/login/send-code`, `/api/pricing/business-config/email/test` | 15 min | 5 |
| Endpoints financeiros (`stripe/create-payment`, `verify-payment`, `contracts/:id/pay`, `confirm-payment`, `subscribe`, `client-renew`, `bookings/:id/complete-payment`) | 15 min | 20 |
| `/api/coupons/validate` | 15 min | 15 |
| `/api/notifications/admin/broadcast` | 1 h | 10 |
| `/api/staff/:id/send-access` | 15 min | 10 |
| `/api` (geral) | 1 min | 300 |

## Relacionado

- [Autenticação](autenticacao.md) · [Permissões da equipe](permissoes-equipe.md) · [Pagamentos](pagamentos.md) · [Modelo de dados](modelo-de-dados.md)
