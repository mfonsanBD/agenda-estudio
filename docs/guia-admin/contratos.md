# Contratos

> Rotas: **`/admin/contracts`** (lista) e **`/admin/contracts/:id`** (detalhe) · Menu: **Contratos** · Acesso: administrador e colaborador com **Ver contratos** (os botões seguem as permissões — ver [Colaboradores](#colaboradores))

Gestão dos contratos: criar, editar, cobrar parcelas, editar serviços e resolver cancelamentos.

## Lista de contratos

- **Filtros** por status: Todos, Ativos, Aguard. pagamento, Pausados, Concluídos, Expirados, Cancelados. Depois de uma ação (editar, renovar, criar), a lista recarrega sem sumir e mostra um discreto "Atualizando…".
- **Busca** por cliente ou nome do contrato.
- Colunas: cliente/projeto, tipo e tier, gravações (com duração e desconto), pagamento (forma e plano), vigência, status e ações. No **avulso** aparecem "Sessão única", "Pagamento único" e a data da gravação.
- **Vence em Nd** aparece na vigência dos planos ativos ou concluídos que vencem em até 30 dias (o KPI "Vencendo (30d)" conta os mesmos). No último dia aparece "Vence hoje"; depois, "Vigência encerrada". O avulso nunca "vence".
- O contrato **cancelado** mostra "Cancelado em DD/MM/AAAA" na vigência. Abaixo do status aparece a situação da multa: **Multa prevista** (pedido em análise), **Multa pendente** ou **Multa paga**, com o valor.

![Lista de contratos](../images/admin/contratos-01-lista.png)
<!-- TODO screenshot: /admin/contracts lista com filtros -->

### Ações na lista

- **Criar contrato** → assistente em 4 etapas (ver [Novo contrato Fixo/Flex](#novo-contrato-fixoflex-em-4-etapas)).
- **Editar** → status (Ativo, Expirado, Concluído, Cancelado), data de fim, créditos Flex restantes, link do contrato e forma de pagamento. **Boleto** só aparece como forma quando "Aceitar pagamento por boleto" está ligado em Configurações e a Cora está ativa; não existe mais liberação de boleto por contrato. "Aguardando cancelamento" não é escolhido aqui: ele vem do pedido do cliente. Num contrato pausado, aguardando pagamento ou em cancelamento, o status atual aparece como "(atual)" e só muda se você escolher outro. Escolher **Cancelado** pede a mesma confirmação vermelha do botão **Cancelar**, faz o mesmo cancelamento e mostra o **mesmo aviso do banco/cartão** (cobrança que já estava paga ou que não pôde ser cancelada), que fica na tela até você fechar.
- **Ver detalhe** → `/admin/contracts/:id`.
- **Cancelar** → cancela e devolve créditos quando aplicável. Com o cadeado, falta ao seu acesso a permissão de baixa para a cobrança de gravação em aberto (veja [Dicas](#dicas-e-erros-comuns)).
- **Renovar (+3 meses)** → só aparece quando faz sentido renovar: plano ativo ou concluído a **30 dias ou menos** do fim da vigência (ou já encerrada), ou plano expirado — e só se o contrato **ainda não foi renovado** (cada contrato renova uma única vez). Nunca aparece no avulso, em serviços nem para cliente excluído. O mesmo botão existe no detalhe do contrato. Contrato **já renovado** mostra o atalho **abrir contrato novo** (lista e detalhe).
- **Cobrar multa agora** → aparece no contrato cancelado com multa pendente; abre a folha de cobrança (PIX ou cartão do cliente presente). Ver [Resolver cancelamento](#resolver-cancelamento).

### Novo contrato (Fixo/Flex) em 4 etapas

1. **Plano:** cliente, nome do projeto, tipo (Fixo ou Flex), faixa e pacote (3 ou 6 meses).
2. **Agenda:** data de início e link do contrato (opcional; se preenchido, precisa ser um endereço completo `https://…`). No **Fixo**, os dias e horários vêm da grade da faixa (ver [Horários válidos de contrato](#horários-válidos-de-contrato)): não há horário pré-preenchido, e ao trocar a faixa ou o dia o que deixou de valer é limpo. Sem dia e horário válidos (ou se a grade não carregar), o **Próximo** fica bloqueado.
3. **Serviços:** serviços por gravação (opcional).
4. **Resumo:** confira os dados, escolha plano de cobrança, forma de pagamento e cupom, e clique em **Criar Contrato**. A forma escolhida (**PIX** ou **Cartão**) é a do contrato e a aba que abre na cobrança; na hora de cobrar dá para trocar. **Boleto** não é mais liberado por contrato: ele só aparece como 3ª opção (aqui e na cobrança) quando "Aceitar pagamento por boleto" está ligado em [Configurações → Pagamentos](configuracoes.md) **e** a integração Cora está ativa.

Ao criar um **Fixo**, a agenda é verificada antes:

- **Horário inválido** (fora da grade): o assistente volta à etapa **Agenda** com a mensagem e o campo de horário destacado. Não é conflito.
- **Dia da semana lotado no período inteiro:** o assistente volta à **Agenda** com o aviso "Sem vaga às …", a **previsão** da próxima data com vaga (botão **Começar em DD/MM**) e os **outros dias da semana** com o mesmo horário livre (botão para trocar o dia).
- **Conflitos em algumas datas:** abre o modal **Conflitos de Agenda** com as substituições automáticas.

Depois de criado, abre a folha **Cobrar 1ª parcela** (PIX/cartão do cliente presente ou **Deixar pendente**). A lista só é atualizada quando essa folha é fechada.

## Detalhe do contrato

Em `/admin/contracts/:id`:

- **Vigência, duração e plano** seguem o tipo. No **avulso**: data e horário da gravação, "Sessão única" e "Pagamento único" (mais "cartão em Nx" se foi parcelado). Nos planos: início – fim, "N meses · X% fidelidade" (ou "sem desconto") e "Mensal (Nx)" ou "Integral".
- **Financeiro:** valor total, pago, pendente, % de cobrança e tabela por parcela (com cobrança inline das pendentes). O status da parcela aparece em português (Pago, Pendente, Falhou, Estornado, Cancelado) e a forma vem do provedor da cobrança (Sicoob → PIX, Stripe → Cartão, com "em Nx" quando parcelado).
- **Cobrar** (parcela pendente) abre a mesma folha de cobrança da criação do contrato, já com o **cliente do contrato**: o CPF do PIX e os cartões salvos são os dele. Ao fechar, a cobrança continua pendente.
- **Multa de cancelamento:** aparece como uma linha própria, "Multa de cancelamento (N%)", com a base ("N% de R$ Y que faltavam pagar") e sem número de parcela; não entra no "Valor do contrato". Enquanto estiver pendente, tem o botão **Cobrar agora**.
- **Cancelamento:** o contrato cancelado mostra "Cancelado em" e a situação da multa; com o pedido em análise, mostra a data do pedido e a multa prevista.
- **Renovar (+3 meses)** e **abrir contrato novo** seguem a mesma regra da lista.
- **Remarcação do avulso:** a gravação em falta justificada ou "Não realizado" mostra o selo "Remarcação liberada até DD/MM", "Remarcada" ou "Prazo encerrado". Enquanto a remarcação estiver liberada, o contrato não fica Concluído.
- **Agendamentos:** sessões do contrato (concluir/editar). **Iniciar gravação** só funciona **no dia da sessão ou depois**: o botão não aparece em sessões de data futura e, se a tentativa vier de uma tela desatualizada, o sistema recusa com "Só é possível iniciar a gravação no dia da sessão." (ver [Hoje](hoje.md#ações-rápidas-por-sessão)).
- **Serviços:** serviços por episódio e mensais do contrato.

![Detalhe do contrato](../images/admin/contratos-02-detalhe.png)
<!-- TODO screenshot: /admin/contracts/:id financeiro + bookings -->

### Editar serviços

Adicione/remova serviços do contrato pelo seletor. As mudanças valem **para o futuro** (não recobram gravações passadas).

![Editar serviços do contrato](../images/admin/contratos-03-servicos.png)
<!-- TODO screenshot: edição de serviços no detalhe do contrato -->

## Status "Concluído"

O contrato vira **Concluído** automaticamente quando não resta nada a fazer nele, e volta a **Ativo** sozinho se isso mudar (por exemplo, ao reabrir uma gravação finalizada ou devolver um crédito):

- **Avulso:** quando a gravação é finalizada, ou quando fica em **falta sem direito a remarcar** (sem justificativa, prazo de remarcação vencido ou nova falta depois de remarcar). Enquanto houver remarcação liberada, ou se a gravação foi marcada como **Não realizado**, ele continua **Ativo**.
- **Fixo, Flex e Personalizado:** quando a última gravação é finalizada e não sobra sessão agendada nem crédito. No **Fixo**, a sessão **extra** (cobrada à parte) não conta entre as sessões do plano: ela não conclui o contrato antes da hora.
- Um plano concluído **continua renovável** quando está a **30 dias ou menos** do fim da vigência (ou com ela já encerrada) e **ainda não foi renovado** — é quando o botão **Renovar** aparece (ver [Ações na lista](#ações-na-lista)). O aviso de "contrato expirando" e a cobrança das parcelas pendentes continuam normalmente.
- Contratos **pausados, aguardando pagamento, em cancelamento, cancelados ou expirados** nunca mudam sozinhos. **Serviços** não entram nessa regra.
- O **avulso** tem vigência de um dia (a data da gravação), é pagamento único e **não** aparece no aviso de "contrato expirando".

## Resolver cancelamento

Quando um cliente solicita cancelamento, o contrato fica em **Cancelamento pendente** e as gravações dele que **ainda não aconteceram** são canceladas na hora (os horários ficam livres). Gravações já feitas — inclusive as de hoje, concluídas ou com falta — e a que estiver em andamento **não** são alteradas. As cobranças em aberto de **serviços extras** dessas gravações canceladas são canceladas junto (a cobrança emitida é cancelada no banco/cartão antes; se já estava paga, fica **Paga**); extras de gravações já realizadas continuam a pagar. Os administradores e quem tem **Decidir pedido de cancelamento** recebem o aviso na hora (notificação e push), já com o valor da multa prevista.

**Como a multa é calculada**

- Multa = *X*% (Configurações → Políticas → "Multa por Quebra de Contrato", padrão 20%) sobre **o que falta pagar do plano**: a soma das parcelas ainda não pagas. Extras de gravação não entram na conta.
- O **percentual fica congelado no momento do pedido**: mudar a configuração depois não altera a multa desse pedido. Uma parcela **paga durante a análise sai da base** (não se cobra multa sobre o que já foi quitado), então a multa pode diminuir — mas **nunca aumenta** em relação à do pedido.
- Plano pago **à vista e quitado** (nada a pagar) → **sem multa**. Nada do que já foi pago é devolvido automaticamente.
- Exemplo: Plano Fixo de 3 parcelas de R$ 840,00, com a 1ª paga. Faltam R$ 1.680,00 → multa de 20% = **R$ 336,00**.

**Na lista, resolva:**

- **Cobrar multa** — a confirmação mostra o valor em reais antes de você decidir. É criada uma cobrança **"Multa de cancelamento"**, que fica **pendente**:
  - o cliente é avisado (notificação e push) e paga em **Meus Pagamentos**, por PIX ou cartão;
  - quem tem **Cobrar o cliente** pode usar **Cobrar agora** (PIX ou cartão, com o cliente presente); sem essa permissão, a confirmação avisa: "A multa fica pendente para o cliente pagar pelo app (cobrar no balcão exige “Cobrar o cliente”). …";
  - ela **não** é cobrada sozinha no cartão salvo, mesmo com a cobrança automática ligada;
  - se o cliente não pagar, ela entra nos avisos de fatura vencida a partir do dia seguinte. Pagamento por fora → dê baixa manual no Financeiro.
- **Isentar** — cancela sem multa; o cliente é avisado de que o contrato foi cancelado sem multa.
- Nos dois casos o contrato vira **Cancelado** (o card passa a mostrar a **data do cancelamento**) e as cobranças pendentes do contrato são anuladas: as parcelas e, se houver, a cobrança ainda em aberto de uma gravação dele (por exemplo, a de uma gravação já feita). Com cobrança de gravação em aberto, decidir exige também **Marcar como pago, anular ou estornar** (veja [Dicas](#dicas-e-erros-comuns)).
- **Contrato reaberto e cancelado de novo:** a multa em aberto de um cancelamento anterior **não é apagada** ao cancelar de novo — ela continua devida e a mensagem da ação avisa, com o valor. Só quando a nova decisão gera multa (**Cobrar multa**) a anterior é anulada e **substituída** pela nova: nunca ficam duas multas em aberto.

**O que acontece com as cobranças já emitidas**

- Antes de anular uma parcela, o sistema cancela no banco/cartão a cobrança que estava emitida (QR PIX, boleto ou pagamento no cartão em aberto), para ela não continuar pagável.
- Se o banco informar que aquele PIX **já foi pago**, a parcela fica como **Paga** (não é anulada) e a mensagem da ação avisa.
- Se não for possível cancelar a cobrança no banco naquele momento, o cancelamento do contrato segue normalmente e a mensagem avisa. Caso o cliente pague essa cobrança depois, você recebe o alerta **"Pagamento recebido em cobrança cancelada"** (notificação e push) para estornar ou dar baixa manual.

## Confirmações das ações do contrato

Toda ação que muda o contrato abre uma confirmação que lista o que vai acontecer. As **vermelhas** (com o selo "Irreversível") não têm volta; as **âmbar** podem ser desfeitas.

| Ação | Tom | O que acontece |
|---|---|---|
| **Cancelar contrato** (ícone 🚫) | vermelho | Contrato → Cancelado; gravações que ainda não aconteceram canceladas (horários liberados; as já feitas ou em andamento ficam como estão; no **serviço**, as gravações vinculadas a ele); parcelas pendentes anuladas (a cobrança emitida é cancelada no banco antes) e, com a permissão de baixa, também a cobrança própria em aberto das gravações cobradas à parte, mesmo de gravação já feita; o cliente é avisado; **sem multa e sem estorno** do que já foi pago. |
| **Cobrar multa** | vermelho | Ver "Resolver cancelamento". |
| **Isentar multa** | âmbar | Ver "Resolver cancelamento". |
| **Pausar** | âmbar | **Fixo:** gravações do plano daqui em diante canceladas, inclusive as cobradas à parte criadas enquanto o plano ainda tinha vaga (o que já foi pago por elas não é estornado); a **sessão extra** (criada com o plano já cheio) é mantida. A cobrança em aberto das gravações canceladas (a da própria sessão, quando cobrada à parte, ou a de serviços extras contratados nelas) é anulada, e por isso pausar com cobrança em aberto exige **Marcar como pago, anular ou estornar** (sem ela, a pausa é recusada e nada muda). Ao **Retomar**, a vigência é estendida pelos dias em pausa e só as gravações do dia/horário fixos são recriadas (uma gravação cancelada em outra data ou horário não volta). **Flex/Personalizado:** as gravações agendadas são mantidas. Parcelas pendentes não são cobradas automaticamente durante a pausa. |
| **Marcar pago** (detalhe do contrato) | âmbar | Parcela → Pago com a data de hoje; o sistema confirma gravação/contrato, o cupom e avisa o cliente, como num pagamento online. Depois disso ela só pode virar "Estornado". Se já havia PIX/boleto emitido, oriente o cliente a não pagá-lo. |
| **Renovar / Retomar** | neutro | Confirmação simples. |

Se a ação falhar, a mensagem aparece dentro da própria confirmação, que continua aberta.

![Resolver cancelamento](../images/admin/contratos-04-cancelamento.png)
<!-- TODO screenshot: ação de resolução de cancelamento (multa/isenção) -->

## Horários válidos de contrato

Os horários de um contrato (Fixo, primeira gravação do Flex e Personalizado) vêm da **grade de horários** configurada em **Configurações** (horários, faixas e dias de funcionamento). Nada é digitado à mão:

- **Sábado** grava só aos sábados, nos horários da grade.
- **Comercial** e **Audiência** gravam só de **segunda a sexta**.
- A faixa superior pode usar os horários da inferior: **Audiência** oferece 10:00, 13:00 e 15:30 (comerciais) além de 18:00 e 20:30. **Comercial** só oferece os comerciais.
- Um horário fora da grade é recusado com a mensagem **"Horário inválido: … Horários válidos: …"**. Isso não é conflito de agenda: basta escolher um dos horários listados.
- Ao mudar a grade em Configurações, os contratos novos passam a usar a grade nova. Os contratos que já existem não mudam.

## Contrato personalizado: cobrança

- **Criado pelo admin** (em nome do cliente): o contrato já nasce **Ativo**, com as sessões confirmadas e todas as parcelas pendentes. **Nenhuma cobrança é gerada na criação.** Em seguida abre a folha de cobrança (cartão ou QR PIX, que pede o CPF do cliente se faltar). Você também pode escolher **Deixar pendente** para o cliente pagar depois. Se algum horário já estiver ocupado, essa sessão é pulada e aparece no retorno.
- **Criado pelo cliente**: o contrato fica em **Aguardando pagamento** por **10 minutos**, com os horários reservados. Só a 1ª parcela é cobrada na hora. Se o pagamento não for feito no prazo, o contrato e as sessões são apagados automaticamente e os horários voltam a ficar livres.

### Contrato personalizado: o assistente

Admin e cliente usam o **mesmo assistente** (Plano → Agenda → Serviços → Resumo); o admin tem todas as opções:

1. **Plano:** cliente, nome do contrato, faixa, duração de **1 a 12 ciclos** (1 ciclo = 4 semanas) e data de início.
2. **Agenda:** frequência **Semanal**, **Quinzenal** (semanas 1 e 3 ou 2 e 4), **Mensal** (semanas do mês) ou **Datas livres** (calendário). Os dias e horários vêm da grade da faixa: **Sábado** só aos sábados; no calendário, dias sem gravação na faixa aparecem riscados e não podem ser escolhidos. O quadro de desconto mostra a regra que é cobrada: por **nº de gravações** do plano (a partir de 12 → desconto de 3 meses; a partir de 24 → desconto de 6 meses, valores de Configurações).
3. **Serviços:** só os serviços **por gravação** (os mensais ficam de fora), em todas as gravações ou como créditos por ciclo.
4. **Resumo:** plano de cobrança **Mensal** ou **Integral**, forma de pagamento e cupom (validado para o cliente escolhido).

Ao clicar em **Criar contrato**, a agenda é verificada: se houver horários ocupados, aparece a tela de **conflitos** com a sugestão de outro horário no mesmo dia (**Aceitar sugestões**) ou **Ajustar a agenda**. Dia lotado sem sugestão = a ocorrência é pulada. Um horário fora da grade volta para a etapa **Agenda** com a mensagem "Horário inválido". Depois de criado abre a folha de cobrança (ver acima); a lista só atualiza quando ela fecha.

## Dicas e erros comuns

- **Boleto** segue só a chave "Aceitar pagamento por boleto" (Configurações) com a Cora ativa. A liberação por contrato (`boletoAllowed`) não é mais usada. Se o boleto for desligado enquanto você edita um contrato, salvar com Boleto devolve o aviso e nada é gravado.
- **Cobrar multa** ou **Isentar** num pedido que já foi resolvido (por outro administrador, em outra aba ou com a lista aberta há algum tempo): aparece "Este pedido de cancelamento já foi resolvido", a confirmação fecha e a lista é recarregada — nada é cobrado em dobro. O mesmo vale para **Cancelar** um contrato que já estava cancelado: a lista é recarregada e o motivo aparece na confirmação.
- Se, ao cancelar (pelo botão **Cancelar contrato**, por **Editar → Cancelado** ou ao decidir a multa), o banco informar que uma cobrança **já estava paga** ou **não pôde ser cancelada**, o aviso fica na tela até você fechar (não é só um aviso rápido).
- Cobrança de parcela usa o mesmo fluxo de pagamento do cliente (ver [Pagamentos técnico](../tecnico/pagamentos.md)).
- O ciclo de vida completo (estados) está em [modelo-de-dados.md](../tecnico/modelo-de-dados.md#ciclo-de-vida-do-contrato).
- **"O contrato mudou em outra tela…"** ao salvar o **Editar**: o status mudou enquanto o formulário estava aberto (por exemplo, o cliente pediu o cancelamento). Nada foi gravado; o formulário fecha e a lista recarrega.
- **Reabrir um contrato cancelado** (Editar → outro status) devolve o uso das sessões e dos créditos sem parcela em aberto: para quem não é administrador, exige **Cancelar contrato** e **Mudar créditos, serviços e condições de pagamento**.
- **Agendar uma sessão num contrato** (em [Agendamentos](agendamentos.md#criar-um-agendamento)) só vale em contrato **ativo** ou **concluído**; nos outros status o sistema recusa, inclusive para o administrador. Criada por quem não tem **Marcar como pago, anular ou estornar**, a sessão de um **Fixo que já usou todas as sessões** (sessão extra) e a de um **contrato de serviço** são cobradas; nos planos, só vale a faixa do plano. Como o Fixo nasce com todas as sessões geradas, a sessão a mais nele quase sempre é extra, e o Novo agendamento avisa antes de agendar. A sessão extra (criada quando o plano já tinha usado todas as sessões, por qualquer pessoa da equipe) não ocupa vaga do plano. A sessão do Fixo que quem tem essa permissão cria enquanto ainda há vaga continua cobrada, mas ocupa uma vaga do plano.
- **Cancelar um contrato com cobrança de gravação em aberto** anula essa cobrança. Isso vale para o **avulso** (o contrato é a própria sessão: qualquer cobrança em aberto) e, nos outros tipos, para a cobrança própria de uma gravação cobrada à parte (gravação vinculada a um serviço, sessão extra do Fixo, sessão cobrada dentro do plano), mesmo de gravação já feita. Por isso, para quem não é administrador, cancelar o contrato e **decidir o pedido de cancelamento** (Cobrar multa ou Isentar) exigem também **Marcar como pago, anular ou estornar**. Sem ela, os botões **Cancelar contrato** e de decisão aparecem com um cadeado (passar o mouse ou clicar mostra o motivo), o status **Cancelado** some do **Editar** e o Editar explica. As parcelas do plano e os serviços extras das sessões continuam anulados só com **Cancelar contrato** (ou **Decidir pedido de cancelamento**).
- **Sessão cancelada por engano:** no **Flex**, volte-a para **Concluído** em Agendamentos (o saldo de créditos se acerta sozinho); reabrir uma sessão cancelada exige **Marcar como pago, anular ou estornar**. No **Personalizado** ela não volta, e o **Editar** só tem os créditos Flex: se precisar acertar o saldo do Personalizado, peça ao suporte técnico.

## Colaboradores

| Na tela | Permissão |
|---|---|
| Abrir Contratos e o detalhe (parcelas e valores) | **Ver contratos** |
| **Novo Contrato** e **Contrato Personalizado** | **Criar e renovar contratos** |
| **Renovar** | **Criar e renovar contratos** e **Marcar como pago, anular ou estornar** (a renovação cria o plano ativo sem nenhuma parcela) |
| **Editar**: término, link e forma de pagamento; status Ativo, Concluído ou Expirado; **Pausar** e **Retomar** | **Editar, pausar e retomar contratos** (pausar um Fixo com cobrança em aberto numa gravação a cancelar: também **Marcar como pago, anular ou estornar**) |
| **Editar**: créditos Flex; **Editar serviços** no detalhe | **Mudar créditos, serviços e condições de pagamento** |
| **Cancelar contrato** e **Editar → Cancelado** | **Cancelar contrato** (com cobrança de gravação em aberto: também **Marcar como pago, anular ou estornar**) |
| Reabrir um contrato cancelado | **Cancelar contrato** e **Mudar créditos, serviços e condições de pagamento** |
| **Cobrar multa** / **Isentar** (e qualquer mudança de status de um contrato em cancelamento pendente) | **Decidir pedido de cancelamento** (cobrar ou isentar com cobrança de gravação em aberto: também **Marcar como pago, anular ou estornar**) |
| **Cobrar**, **Cobrar agora** (parcela e multa) e **Cobrar 1ª parcela** | **Cobrar o cliente** (cartão salvo do cliente: **Debitar o cartão salvo do cliente**) |
| **Marcar pago** | **Marcar como pago, anular ou estornar** |
| Confirmar presença, iniciar/finalizar gravação no detalhe | as mesmas de [Hoje](hoje.md#colaboradores) |
| Nome do cliente como link para o perfil | **Ver clientes** |

- O **Editar** mostra só os status e campos que a pessoa pode mudar (os outros ficam em cinza, com um aviso no topo) e envia só o que mudou.
- Contrato criado por quem não tem **Cobrar o cliente** termina com "1ª cobrança pendente: o cliente paga pelo app" (a folha de cobrança não abre). Com cupom de 100%, quem não tem **Marcar como pago, anular ou estornar** recebe a recusa do sistema (a parcela de R$ 0 seria registrada como paga).
- Sem **Decidir pedido de cancelamento**, um contrato em cancelamento pendente mostra "pedido em análise" e o status fica travado no Editar.

## Ver também

- [Clientes](clientes.md) · [Financeiro](financeiro.md) · [Contratos (cliente)](../guia-cliente/contratos.md)
