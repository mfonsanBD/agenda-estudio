# Hoje (agenda do dia)

> Rota: **`/admin/today`** · Menu: **Hoje** · Acesso: administrador e colaborador com **Ver a operação do dia** (os botões seguem as permissões — ver [Colaboradores](#colaboradores))

A tela do dia a dia da operação. Mostra as sessões da semana em uma grade e dá as ações rápidas para conduzir cada gravação: confirmar presença, concluir e registrar as métricas, ou marcar falta.

## Visão geral

- Um **relógio ao vivo** e o resumo do horário atual no topo.
- Grade de **segunda a sábado × faixas de horário**, com cada sessão exibindo cliente, tier, status e preço.

![Grade do dia](../images/admin/hoje-01-grade.png)
<!-- TODO screenshot: /admin/today com sessões na grade -->

## Ações rápidas por sessão

Clique em uma sessão para abrir as ações:

1. **Check-in** — confirma que o cliente chegou (status → `CONFIRMED`).
2. **Iniciar gravação** — registra quem está operando e a hora do início. A partir daí o cliente vê o selo **AO VIVO** na gravação dele, e o botão vira **Finalizar gravação**.
   - **Clicou por engano?** Use **Desfazer início** (o ícone de seta ao lado de Finalizar, ou o botão dentro do aviso "Em gravação" ao abrir a sessão). O sistema pede confirmação, apaga o registro de início, o cliente deixa de ver "AO VIVO" e a sessão volta a pedir **Iniciar gravação**. Nada é cancelado nem cobrado. Depois que a gravação foi finalizada não dá mais para desfazer. O mesmo ícone **Desfazer início** existe no **Centro de Comando** (Agenda de Hoje), ao lado de **Finalizar**, com a mesma confirmação, e como botão **Desfazer início** em cada gravação do **Detalhe do Contrato**.
   - **Só no dia da sessão (ou depois):** uma gravação de data futura não pode ser iniciada. No Detalhe do Contrato o botão **Iniciar gravação** só aparece em sessões de hoje ou de dias anteriores; se ainda assim a tentativa for de uma data futura, o sistema recusa com "Só é possível iniciar a gravação no dia da sessão."
3. **Concluir** — finaliza a sessão e abre o modal de **Finalizar gravação** (abaixo).
   - **Depois que o horário termina, o Finalizar continua disponível** para a sessão já iniciada: na linha da sessão (ícones **Desfazer início** e **Finalizar gravação**), no aviso **"Em gravação"** ao abrir a sessão (botão **Finalizar gravação**, ao lado de **Desfazer início**) e no **Centro de Comando**. Finalize assim que a gravação acabar: enquanto ela não é finalizada, o cliente continua vendo **AO VIVO**. As demais ações (iniciar, falta, não realizado, cancelar) saem da tela Hoje quando o horário passa — use [Agendamentos](agendamentos.md) ou o Detalhe do Contrato para esses casos.
4. **Falta** — registra que o cliente não compareceu (motivo obrigatório). A falta **consome** a sessão: o crédito Flex/Personalizado **não** volta.
5. **Não realizado** — a gravação não aconteceu por causa do estúdio (motivo obrigatório). Em planos Flex/Personalizado o crédito **volta** para o cliente.

![Ações rápidas](../images/admin/hoje-02-acoes-rapidas.png)
<!-- TODO screenshot: sessão expandida com botões check-in/concluir/falta -->

## Falta justificada e "Não realizado" no avulso

Na gravação **avulsa** (paga à parte), o estúdio decide se a falta dá direito a remarcar:

- **Falta sem justificativa** (padrão): o cliente perde o valor na hora e o contrato avulso fica **Concluído**.
- **Falta justificada** (marque a opção no modal de Falta): o cliente pode **remarcar uma única vez, sem pagar de novo**, para uma data até o fim do **7º dia** após a gravação perdida (dia D+7, horário de Brasília; o prazo é a configuração *Prazo para Remarcar Falta Justificada — Avulso*). Ele recebe um aviso na hora e lembretes nos 2 últimos dias. Se o prazo passar sem remarcar, o valor é perdido e o contrato fica **Concluído**. Só dá para justificar enquanto o prazo não venceu; desmarcar a justificativa (enquanto a janela estiver aberta) retira o direito.
- **Não realizado** (culpa do estúdio): a mesma janela de 7 dias abre **automaticamente**, desde que a gravação esteja **paga** (a cobrança da própria gravação; um serviço extra pago não conta) e o contrato esteja ativo ou concluído. Se o cliente não remarcar, ele **não perde** o valor: o contrato continua ativo e a equipe (os administradores e quem tem **Registrar falta ou não realizado**) recebe um aviso para combinar com o cliente. O admin pode remarcar essa gravação **mesmo depois do prazo**. Sem a gravação paga, a janela não abre e a remarcação sem custo não vale (nem para o admin).
- A remarcação reaproveita a **mesma reserva e o mesmo pagamento** (sem nova cobrança), no mesmo tipo de horário (faixa) da gravação original. Quando a gravação é remarcada, a equipe (os administradores e quem vê a operação do dia) é avisada; quem remarcou não recebe o aviso.

**Na tela:**

- **Modal de Falta** (Hoje, Centro de Comando, Agendamentos e Editar agendamento): na gravação avulsa aparece a opção **"Falta justificada — o cliente pode remarcar sem novo pagamento até DD/MM"**, desmarcada por padrão. Ela fica desativada, com o motivo, quando o prazo já venceu ou a gravação já usou a remarcação. O modal de **Não realizado** avisa que a remarcação sem custo abre sozinha **se a gravação estiver paga**. Depois de salvar, a tela diz o que o sistema fez: "remarcação sem custo liberada ao cliente até DD/MM", que o prazo já passou (use **Remarcar**) ou, num aviso que fica na tela, "A remarcação sem custo não foi liberada ao cliente." com o motivo (gravação não paga, cobrança anulada ou estornada, contrato cancelado ou encerrado).
- **Bloco "Remarcação"** no painel da gravação (Hoje) e em cada gravação do **Detalhe do Contrato**: mostra *Remarcação liberada até DD/MM*, *Remarcada (falta em DD/MM)*, *Prazo encerrado — valor retido* (falta) ou *Prazo encerrado — resolver com o cliente* (não realizado), com os botões:
  - **Justificar falta** — para falta avulsa ainda sem justificativa, dentro do prazo (pede confirmação);
  - **Remarcar** — abre a escolha de dia e horário livre da mesma faixa. Num **não realizado**, o admin pode remarcar mesmo depois do prazo e sem limite de data (há o campo **Outra data**).
- **Agendamentos**: o mesmo status aparece como um selo abaixo do status (ex.: **Remarcar até DD/MM**, que abre a remarcação). Escolher **Falta** ou **Não realizado** no seletor de status abre o modal de motivo em vez de gravar direto.
- **Centro de Comando**: na agenda do dia, a falta justificada aparece como **Falta · remarcável até DD/MM**.

## Finalizar gravação (métricas de transmissão)

Ao concluir uma sessão, registre os dados da gravação:

1. Informe a **duração** (minutos).
   - Na 1ª finalização de uma gravação iniciada, a duração é registrada **automaticamente** (do **Iniciar** até o **Finalizar**); **Informar manualmente** troca para o valor digitado.
   - Gravação iniciada há **mais de 12 horas** (início esquecido de outro dia): não há duração automática. O campo abre para digitar, com o aviso; se ficar vazio, a gravação é finalizada **sem duração**.
2. Marque se foi **transmissão ao vivo (livestream)**.
3. Se foi ao vivo, selecione as **redes** (YouTube, TikTok, Instagram, Facebook) e preencha, por rede: **visualizações, pico de audiência, curtidas e comentários**, além do **link** da transmissão. Se não foi ao vivo, informe o **link de acesso à gravação**.
   - **Links:** pode colar sem o `https://` (ex.: `youtu.be/abc`) — o sistema completa ao salvar. Um endereço que não seja da web (ex.: `ftp:…`) é recusado com aviso e nada é salvo, porque o cliente só recebe links `http(s)`.
4. Adicione notas (internas e/ou visíveis ao cliente).
5. **Salvar** — os dados aparecem para o cliente em [Minhas Gravações](../guia-cliente/minhas-gravacoes.md) (inclusive no gráfico), e o pagamento é liberado se estava em espera.

![Finalizar gravação](../images/admin/hoje-03-finalizar-gravacao.png)
<!-- TODO screenshot: modal Finalizar gravação com métricas por rede -->

## Dicas e erros comuns

- **No celular**, cada sessão mostra horário e status em cima e o cliente embaixo; toque na sessão para abrir as ações (os atalhos em ícone aparecem só em telas largas).
- Depois de uma ação a agenda continua na tela e mostra "Atualizando…" no topo enquanto recarrega.
- **"A gravação foi alterada em outra tela…"** ao finalizar: outro operador desfez o início ou mudou o status enquanto você finalizava. Nada foi gravado; a agenda (Hoje, Centro de Comando ou Detalhe do Contrato) recarrega sozinha por trás — confira a sessão e, se for o caso, inicie de novo antes de finalizar.
- **Marcar falta por engano:** corrija pela tela de [Agendamentos](agendamentos.md) (editar status). Voltar para "Confirmado" reabre o contrato; "Não realizado" devolve o crédito Flex/Personalizado.
- **Cancelou ou marcou "Não realizado" por engano:** corrija também em [Agendamentos](agendamentos.md#editar-um-agendamento). Reabrir uma sessão **cancelada** exige **Marcar como pago, anular ou estornar** (o cancelamento anulou a cobrança em aberto dela e liberou crédito ou vaga). Se o cancelamento anulou a cobrança da própria sessão (avulso ou serviço ainda não pago), ela não volta com a reabertura: a sessão não pode voltar a Reservado ou Confirmado, nem pelo administrador. Para gravar, crie um novo agendamento no mesmo horário, que gera a cobrança de novo; se a sessão aconteceu, ela pode ir para **Concluído**, sem cobrança (e de lá também não volta a Reservado ou Confirmado). Tirar de **Não realizado** sem essa permissão só funciona se o plano ainda tiver o crédito (Flex, Personalizado, avulso) ou a vaga (Fixo) que o "Não realizado" devolveu.
- **Cancelar indisponível:** a sessão tem cobrança em aberto (da sessão ou de um serviço extra) e o seu acesso não tem **Marcar como pago, anular ou estornar**, porque cancelar anularia essa cobrança. O botão **Cancelar** aparece apagado; passar o mouse ou tocar mostra o motivo. Se o cliente não veio, use **Falta**: a cobrança continua devida.
- **Contrato "Concluído":** ao finalizar a última gravação (ou quando o avulso fica em falta sem direito a remarcar), o contrato vira **Concluído** sozinho. Reabrir a gravação o devolve para **Ativo**.
- **Métricas por rede só aparecem** se "transmissão ao vivo" estiver marcado.
- O cliente só vê o gráfico quando houver `streamMetrics` salvos.

## Colaboradores

O colaborador abre esta tela com **Ver a operação do dia** (a mesma permissão abre a Agenda). Cada botão aparece só com a permissão dele; se não sobrar nenhum, a barra de ações some e a sessão fica só para consulta.

| Na tela | Permissão |
|---|---|
| **Check-in** / **Confirmar presença** | **Confirmar presença (check-in)** ou **Mudar data, horário e status** |
| **Iniciar gravação**, **Desfazer início**, **Finalizar gravação**, **Dados da transmissão** | **Operar a gravação** |
| **Falta**, **Não realizado**, **Justificar falta** e **Remarcar** (avulso) | **Registrar falta ou não realizado** |
| **Cancelar** | **Cancelar sessão** (sessão com cobrança em aberto: também **Marcar como pago, anular ou estornar**) |
| Editar notas e métricas | **Operar a gravação** ou **Mudar data, horário e status** (sem elas: "Somente leitura") |
| Nome do cliente e **Ver Perfil** | **Ver clientes** (sem ela, o nome aparece como texto) |

Os mesmos botões no **Centro de Comando** (painel) e no **Detalhe do Contrato** seguem as mesmas permissões. Avisos do dia (sessão confirmada ou cancelada pelo cliente, gravação remarcada) chegam a quem vê a operação do dia; "sessão não confirmada" chega a quem confirma presença.

## Ver também

- [Agendamentos](agendamentos.md) — para edições mais completas.
- [Minhas Gravações (cliente)](../guia-cliente/minhas-gravacoes.md) — o que o cliente vê.
