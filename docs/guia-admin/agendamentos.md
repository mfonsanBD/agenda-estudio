# Agendamentos

> Rota: **`/admin/bookings`** · Menu: **Agendamentos** · Acesso: administrador e colaborador com **Ver agenda e agendamentos** (os botões seguem as permissões — ver [Colaboradores](#colaboradores))

Gestão completa (CRUD) de todos os agendamentos do estúdio, com filtros, busca e cobrança.

## Visão geral

- KPIs no topo: total, confirmados, concluídos, cancelados e receita (a receita só para quem vê o Financeiro).
- **Filtros** por período e status; **busca** por nome/e-mail do cliente (agendamentos de cliente excluído aparecem só com o nome).
- Tabela com data, horário, cliente, tier, status, preço, contrato e ações.

![Tabela de agendamentos](../images/admin/agendamentos-01-tabela.png)
<!-- TODO screenshot: /admin/bookings tabela com filtros -->

## Criar um agendamento

1. Clique em **Criar/Novo agendamento** (ou, na **Agenda**, clique num horário livre: o mesmo assistente abre com a data e o horário preenchidos).
2. Selecione o **cliente** e, se houver, o **contrato**.
3. Escolha **data** e **horário**.
4. (Opcional) ajuste o **preço** e decida **cobrar agora** (PIX/cartão) ou criar **sem cobrança** (offline).
5. **Salvar**.

- O contrato precisa estar **ativo** ou **concluído** (o seletor só mostra esses). Um contrato cancelado, expirado, pausado, aguardando pagamento ou com cancelamento pedido é recusado com "Não é possível agendar neste contrato: ele está …" (vale também para o administrador).
- Com um contrato escolhido, o assistente mostra só os horários da **faixa do plano**.
- Num plano **Flex** ou **Personalizado**, o agendamento criado aqui **consome 1 crédito** do plano (como quando o cliente agenda). Sem crédito, aparece "Créditos esgotados neste plano." e nada é criado.
- Sem a permissão **Marcar como pago, anular ou estornar**, a pessoa não escolhe "Confirmado" nem muda o preço (vale o preço da faixa) e o agendamento nasce **Reservado**:
  - **avulso**: fica **aguardando pagamento** ("Agendamento criado como Reservado, aguardando pagamento."); cupom de 100% é recusado, porque registraria a sessão como paga;
  - **sessão de plano Flex ou Personalizado** (e de **Fixo** com sessão livre): o plano já cobre a sessão, então **nenhuma cobrança da sessão** é gerada (só dos serviços extras, se houver) e ela fica com a **presença a confirmar**. Só vale num horário da faixa do plano; fora dela, "O plano Comercial não permite agendar horários Audiência." (por exemplo);
  - **contrato de serviço** ou **Fixo que já usou todas as sessões**: a sessão é **cobrada** (aguardando pagamento), e a mensagem explica o motivo. Se o Fixo encher enquanto você salva, aparece "O plano fixo acabou de usar todas as sessões. Tente de novo: …" e, na nova tentativa, a sessão sai cobrada.
  - **Fixo**: as sessões do plano já nascem geradas na contratação, então quase sempre a sessão a mais é extra. Na etapa **Confirmar** aparece o aviso "No plano fixo, as sessões do plano já são geradas na contratação; uma sessão a mais é extra e será cobrada (aguardando pagamento), a não ser que alguma sessão do plano tenha sido cancelada ou marcada como Não realizado."; no Fixo **Concluído**, "Sessão extra: o plano fixo já usou todas as sessões, então esta será cobrada (aguardando pagamento).".
- Enquanto a cobrança da própria sessão (avulso, serviço, Fixo extra) estiver em aberto, o cliente não consegue confirmar a sessão; pagar a cobrança já a confirma. Pagar só um serviço extra não confirma.
- A sessão **extra** do Fixo, a criada quando o plano já usou todas as sessões (cobrada à parte), não ocupa vaga do plano: ela não conta para "usou todas as sessões" nem para concluir o contrato. A sessão do Fixo que quem tem **Marcar como pago, anular ou estornar** cria enquanto ainda há vaga também é cobrada, mas ocupa uma vaga do plano, como as demais.
- O agendamento Reservado criado pela equipe **não expira** (não tem os 10 minutos do cliente).

![Criar agendamento](../images/admin/agendamentos-02-criar.png)
<!-- TODO screenshot: modal de criação de agendamento -->

## Editar um agendamento

Na linha desejada, use **Editar** para alterar data, horário, preço, status e notas. Você também pode mudar o status direto (ex.: `CONFIRMED` → `COMPLETED`/`CANCELLED`/`FALTA`). **Falta** e **Não realizado** pedem o motivo antes de gravar; **Cancelado** pede a confirmação de perigo (veja [Cancelar e excluir](#cancelar-e-excluir)).

- Só aparecem os status que o seu acesso permite a partir do status atual.
- Mudar a sessão para um horário de **outra faixa de preço** (ex.: um dia de semana para sábado, ou um horário comercial para 18:00/20:30), sem **Marcar como pago, anular ou estornar**:
  - **sessão de plano** (Fixo, Flex ou Personalizado): pode, dentro das faixas que o plano cobre (o Editar mostra, por exemplo, "Sessão do plano Audiência: só horários que o plano permite (Comercial e Audiência)."); acima delas aparece "O plano Comercial não permite agendar horários Audiência. Escolha um horário que o plano permita." e não salva. Sessão **cobrada à parte** (ex.: a extra do Fixo, ou a sessão do plano criada com cobrança por quem tem a permissão) só muda de faixa com a permissão; o sistema recusa ao salvar;
  - **avulso** ou **serviço**: muda o valor cobrado, então o Editar avisa e não salva.
- **Reabrir uma sessão cancelada** (para qualquer status) exige **Marcar como pago, anular ou estornar** além de **Mudar data, horário e status**: o cancelamento anulou a cobrança em aberto da sessão e dos extras e liberou o crédito ou a vaga do plano. Para quem tem **Mudar data, horário e status** mas não tem a baixa, a sessão cancelada fica só com "Cancelado" e a tela explica (no Personalizado, a dica é a de que ele não reabre): "Reabrir uma sessão cancelada exige a permissão “Marcar como pago, anular ou estornar”: peça a quem a tem. Crie um novo agendamento só se esta sessão não foi paga — senão o cliente seria cobrado de novo." Na lista, passe o mouse ou foque o selo do status. Quem não tem nem **Mudar data, horário e status** (ex.: Operador de estúdio) vê só o selo, sem a dica: a baixa sozinha não reabriria a sessão. No **avulso**, a dica só diz para não criar outro agendamento quando a sessão ainda tem cobrança em aberto (avulso cancelado antes desta regra); nos outros casos é o texto acima.
  - Se a pessoa tentar mesmo assim, a mensagem do servidor diz o caso. Com a cobrança da gravação **paga** (ou ainda em aberto): "Reabrir uma sessão cancelada exige a permissão “Marcar como pago, anular ou estornar”. Esta sessão já tem cobrança própria: peça a quem tem essa permissão para reabri-la. Não crie um novo agendamento — o cliente seria cobrado de novo.". Com a cobrança **anulada** no cancelamento: "…: a cobrança dela foi anulada no cancelamento. Para uma nova sessão, crie um novo agendamento.". Sem cobrança (sessão de plano): "Reabrir uma sessão cancelada exige a permissão “Marcar como pago, anular ou estornar”. Para uma nova sessão, crie um novo agendamento.".
- **A cobrança anulada no cancelamento não volta com a reabertura**, nem para o administrador. Isso vale para a sessão que tinha cobrança própria em aberto ao ser cancelada (avulso, serviço ou sessão extra do Fixo ainda não pagos) e para a sessão cuja cobrança foi anulada por quem tem a permissão. Ela não pode voltar a **Reservado** ou **Confirmado** a partir de nenhum status fechado (Cancelado, Concluído, Falta ou Não realizado): aparece "A cobrança desta sessão foi anulada e não volta com a reabertura, então ela não pode voltar a ficar em aberto (Reservado, Em espera ou Confirmado) sem cobrança. Para gravar, crie um novo agendamento: ele gera a cobrança de novo." e nada muda. Para registrar o que aconteceu, a sessão cancelada pode ir para **Concluído** ou **Não realizado**; ela fica sem cobrança e a tela avisa ("Sessão reaberta sem cobrança"), também quando o Não realizado passa pelo modal de motivo. Quando o aviso (ou a recusa) vem pelo status da linha, a linha deixa de oferecer Reservado e Confirmado e o **Editar** explica; depois de a lista recarregar, a tela volta a oferecê-los e a recusa aparece se você escolher. A sessão já paga e a sessão de plano sem cobrança própria reabrem normalmente.
- **Cancelar uma sessão que tem cobrança em aberto** (a da própria sessão ou a de serviços extras) exige **Marcar como pago, anular ou estornar**, em qualquer status: antes ou depois da gravação, e também depois de reabrir ou remarcar a sessão. Cancelar anula essa cobrança. Sem a permissão, "Cancelado" não aparece no status da linha nem no **Editar** (que mostra a explicação abaixo dos status), a lista mostra o selo **Cancelar indisponível** e o botão **Cancelar** do Hoje fica indisponível. No selo e no botão, passar o mouse ou clicar mostra: "Esta sessão tem cobrança em aberto: cancelar anula a cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa ou, se o cliente faltou, use Falta (a cobrança continua devida)." O servidor recusa com o mesmo texto e nada muda. Sem cobrança em aberto (paga, ou sessão de plano sem extras), o cancelamento segue normal.
- **Falta** não aparece para uma sessão **Concluída** ou **Cancelada** (o sistema recusa para todos).
- Mesmo com essa permissão, a sessão cancelada de plano **Flex** só volta a **Concluído** (quando ela aconteceu de fato; o saldo de créditos é acertado na hora), e a de plano **Personalizado não pode ser reaberta** (nem pelo administrador): o crédito dela já foi acertado no cancelamento, e o painel não tem campo para o saldo do Personalizado (se precisar acertá-lo, peça ao suporte técnico). Para uma sessão nova, crie um novo agendamento (consome 1 crédito do plano).
- **Tirar uma sessão de "Não realizado"** (para qualquer status menos Cancelado) sem **Marcar como pago, anular ou estornar** só funciona se o plano ainda comporta a sessão: o "Não realizado" devolveu o crédito, e ele pode já ter sido usado em outro agendamento. No Flex, Personalizado e avulso, o crédito é descontado de novo; sem crédito aparece "O plano não tem crédito disponível para reabrir esta sessão: o crédito devolvido no “Não realizado” já foi usado ou venceu. …" (no Flex, o crédito devolvido também pode **vencer** no confisco semanal, por exemplo quando a sessão foi marcada depois do fim do ciclo). No Fixo com todas as sessões usadas, "O plano fixo já usou todas as sessões: reabrir esta sessão passaria do limite. …". Nos dois casos nada muda. A sessão extra do Fixo (a criada quando o plano já tinha usado todas as sessões; paga, em aberto ou anulada) não usa vaga do plano: sai de "Não realizado" sem essa conferência. A sessão do Fixo criada com cobrança dentro do limite do plano usa vaga e passa pela conferência.

### Remarcar a falta do avulso

Numa gravação **avulsa** em **Falta justificada** ou **Não realizado**, use **Remarcar** (em vez de editar a data à mão): o sistema confere horário livre, bloqueios e a mesma faixa, e reaproveita o pagamento já feito. Só vale para gravação **paga** (a cobrança da própria gravação; um serviço extra pago não conta): sem ela, o "Não realizado" não libera a remarcação, e justificar a falta ou remarcar mostra "O pagamento desta gravação não está confirmado; a remarcação sem novo pagamento só vale para gravação paga.". O prazo é até o fim do 7º dia após a gravação perdida; em **Não realizado** o admin pode remarcar mesmo depois do prazo. Ao salvar **Não realizado** num avulso (lista, Hoje, Painel ou Editar), a tela diz o que o sistema fez: "remarcação sem custo liberada ao cliente até DD/MM" (o prazo gravado), que o prazo de remarcação já passou (use **Remarcar**), ou um aviso "A remarcação sem custo não foi liberada ao cliente." com o motivo (por exemplo, gravação não paga ou com a cobrança anulada, ou contrato cancelado). Se você editar o status de uma falta com remarcação liberada para "Confirmado"/"Concluído", o direito conta como **usado**; se cancelar a reserva, o direito é retirado.

![Editar agendamento](../images/admin/agendamentos-03-editar.png)
<!-- TODO screenshot: modal de edição de agendamento -->

## Cancelar e excluir

As duas ações abrem um diálogo vermelho de confirmação com a lista do que vai acontecer de fato. Nada é gravado antes de você clicar em **Cancelar agendamento** / **Excluir agendamento**; se a API recusar, o erro aparece dentro do próprio diálogo.

- **Cancelar** (escolher **Cancelado** no status da linha, no **Editar** ou o botão **Cancelar** da tela [Hoje](hoje.md)) mantém o registro com status cancelado.
  - Sessão ainda não realizada (Reservado/Confirmado): o horário volta a ficar livre. No **Personalizado** com créditos, **1 crédito volta**. No **Flex**, 1 crédito volta na hora, mas a conferência automática do saldo pode tirá-lo: se a semana da sessão já fechou (ou fechar sem outra gravação) e o cliente está em dia no ritmo, o crédito é perdido. No **avulso**, nada vira crédito para outro agendamento.
  - Sessão já concluída, em falta ou não realizada: o status muda e a remarcação liberada de um avulso é retirada. No **Flex**, nada volta na hora: a conferência automática tira a sessão do consumo e do ritmo semanal, e o crédito só volta se a semana dela ainda não fechou ou se o cliente está adiantado no ritmo; senão ele é perdido e o cliente recebe o aviso de crédito perdido. No **Não realizado** do Flex (o crédito já voltou ao marcar), cancelar tira a sessão do ritmo, e a conferência pode confiscar 1 crédito. No **Personalizado**, o crédito já usado **não volta**.
  - Nenhum pagamento já feito é estornado. A cobrança **em aberto** da sessão (inclusive a do avulso) e dos serviços extras é anulada: a cobrança emitida no banco ou no cartão é cancelada antes, e a que já estava paga fica **Paga**. Por isso cancelar uma sessão com cobrança em aberto, e reabrir uma sessão cancelada, exigem **Marcar como pago, anular ou estornar** (veja [Editar](#editar-um-agendamento)). Para quem não tem a permissão, quando a tela não sabe se há cobrança em aberto, o diálogo avisa que o cancelamento pode ser recusado.
  - Cobranças em aberto de avulsos cancelados **antes desta regra** continuam pendentes (aparecem como devidas), mas não podem mais ser pagas pelo app. O painel não tem botão para anular uma cobrança: peça ao suporte técnico.
- **Excluir definitivo** (lixeira) apaga a linha como se nunca tivesse existido: some da agenda, do histórico do cliente e das métricas. Em sessão ainda não realizada, libera o horário e **devolve o crédito** (Flex e Personalizado com créditos; no Flex, sujeito à conferência automática). A cobrança em aberto dela é anulada antes de apagar (o diálogo de quem tem a permissão avisa), e um pagamento ligado a ela continua no Financeiro, sem o vínculo. Com cobrança em aberto, excluir também exige **Marcar como pago, anular ou estornar**: sem ela, a lixeira da linha fica com um cadeado e, ao passar o mouse ou clicar, mostra "Esta sessão tem cobrança em aberto: excluir anula a cobrança, e isso exige a permissão “Marcar como pago, anular ou estornar”. Peça a quem pode dar baixa." (o servidor recusa com o mesmo texto). Para manter o histórico, prefira **Cancelado**.
- No select de status da linha, navegar com as setas do teclado só pré-seleciona (antes cada passo gravava um status). Aperte **Enter** (ou saia do campo) para aplicar e **Esc** para desistir. Com o mouse, escolher na lista aplica na hora.

## Dicas e erros comuns

- Para **finalizar com métricas**, use a tela [Hoje](hoje.md) (modal de finalização) — é o caminho pensado para o pós-gravação.
- Mudanças de status que afetam crédito Flex (não realizado/cancelamento) são refletidas no contrato do cliente. A **falta** consome a sessão (não devolve crédito).
- Toda mudança de status recalcula o status do contrato: ele fica **Concluído** quando não resta nada a fazer e volta a **Ativo** se uma gravação for reaberta (ver [Contratos](contratos.md)).

## Colaboradores

| Na tela | Permissão |
|---|---|
| Abrir Agendamentos e a Agenda (com o preço de cada sessão) | **Ver agenda e agendamentos** (a Agenda também abre com **Ver a operação do dia**) |
| **+ Novo Agendamento** e clique no horário livre da Agenda | **Criar agendamento para cliente** |
| "Confirmado" na criação, preço diferente do da faixa, cupom de 100%, mudar de faixa de preço no Editar (avulso, serviço ou sessão extra; a sessão de plano muda sem ela dentro das faixas do plano) | **Marcar como pago, anular ou estornar** |
| **Cobrar o cliente agora** (avulso; PIX, cartão ou boleto) | **Cobrar o cliente** |
| Data e horário no Editar; reabrir sessão concluída, em falta ou não realizada (a de cobrança anulada não volta a Reservado ou Confirmado); concluir | **Mudar data, horário e status** (a não realizada também com **Registrar falta ou não realizado**) |
| Reabrir sessão **cancelada** | **Mudar data, horário e status** e **Marcar como pago, anular ou estornar** |
| Confirmar (Reservado → Confirmado) | **Confirmar presença** ou **Mudar data, horário e status** |
| **Falta**, **Não realizado**, **Justificar falta**, **Remarcar** do avulso | **Registrar falta ou não realizado** |
| **Cancelado** | **Cancelar sessão** (sessão com cobrança em aberto: também **Marcar como pago, anular ou estornar**) |
| Lixeira (excluir definitivo) | **Excluir agendamento definitivamente** (sessão com cobrança em aberto: também **Marcar como pago, anular ou estornar**) |
| KPI **Receita** | **Ver o financeiro e a receita** |
| Nome do cliente como link para o perfil | **Ver clientes** |

Sem nenhuma ação, a coluna "Ações" some e o status vira só um selo.

## Ver também

- [Hoje](hoje.md) · [Contratos](contratos.md) · [Clientes](clientes.md)
