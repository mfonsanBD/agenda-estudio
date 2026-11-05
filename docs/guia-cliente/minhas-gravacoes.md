# Minhas Gravações

> Rota: **`/minhas-gravacoes`** · Menu: **Minhas Gravações**

Veja a gravação que está acontecendo agora e as que já passaram, com as **métricas** de cada uma. (As sessões futuras ficam em [Agenda → Agendados](agenda-e-agendamento.md#seus-agendamentos).)

## Lista de gravações

Uma galeria de cartões (arraste com o dedo ou com o mouse): a gravação **em andamento** vem primeiro, depois as que ainda dá para remarcar e, em seguida, as mais recentes — cada uma com o selo de status (**Gravando agora**, **Concluída**, **Falta**, **Não realizada**). Os totais do topo (realizadas, visualizações, pico, curtidas) contam só as gravações concluídas.

![Lista de gravações](../images/cliente/gravacoes-01-lista.png)
<!-- TODO screenshot: /minhas-gravacoes lista -->

## Selo "AO VIVO"

O selo **AO VIVO** (vermelho, pulsando) aparece no card **somente enquanto a gravação está acontecendo**: ele liga quando o estúdio clica em **Iniciar gravação** e some assim que o estúdio **finaliza** a gravação. A tela se atualiza sozinha (a cada meio minuto e quando você volta para o app) enquanto houver uma sessão sua **reservada ou confirmada** para hoje — não é preciso recarregar. O mesmo selo aparece no **Início** e em **Agenda → Agendados**.

Uma gravação já concluída **nunca** mostra "AO VIVO". Se ela foi transmitida, o card traz apenas o selo discreto **Transmitida ao vivo**.

## Detalhe de uma gravação

Toque (ou clique) numa gravação para abrir o detalhe. Você encontra:

- **Resultados da gravação** — depois que o estúdio finaliza: **duração, início e fim, visualizações, pico de espectadores, inscritos, curtidas, comentários e mensagens no chat**, no total e **por rede**, com o link **Abrir** de cada transmissão (ou **Assistir gravação**, quando não foi ao vivo) e a **origem da audiência**.
- **Recado do estúdio** — o feedback que a equipe deixa para você ao finalizar a gravação.
- **Informações do episódio** — título, descrição, **capa** e as **redes** onde pretende transmitir (YouTube, TikTok, Instagram, Facebook).
- **Serviços** — os serviços daquela gravação. **Adicionar serviço** gera uma cobrança só do serviço. Numa reserva avulsa que ainda está no prazo de pagamento (o contador de 10 minutos), o botão não aparece: os serviços entram no próprio pagamento da reserva. Pagar um serviço extra não confirma a gravação quando o pagamento da própria sessão ainda está em aberto: pague a fatura da sessão em **Pagamentos**.

Durante a gravação o detalhe mostra **AO VIVO** e "Gravação em andamento desde HH:MM"; quando o estúdio finaliza, os resultados aparecem ali mesmo.

### Até quando posso editar as informações?

Você pode salvar e alterar título, descrição, capa e redes **enquanto a gravação não foi finalizada nem cancelada** — inclusive com o pagamento ainda pendente e durante a própria gravação. Toque em **Salvar** para gravar título, descrição e redes (a capa é gravada assim que você a envia); o cartão passa a mostrar o título e a capa salvos. Se algo não puder ser salvo, o motivo aparece no próprio detalhe.

Depois que o estúdio finaliza (ou se o agendamento foi cancelado, ou marcado como falta / não realizada), os campos ficam **desabilitados**, com um aviso dizendo o motivo. Se uma gravação avulsa perdida for remarcada, ela volta a poder ser editada.

- Título: até 140 caracteres. Descrição: até 4000 caracteres.
- Capa: JPG, PNG, WEBP, AVIF ou HEIC, até 12 MB (ela é ajustada para 1280×720).

![Detalhe com métricas](../images/cliente/gravacoes-02-detalhe-metricas.png)
<!-- TODO screenshot: detalhe expandido com aba de métricas -->

## Remarcar uma gravação avulsa perdida

Se você comprou uma gravação **avulsa** e:

- **faltou, mas o estúdio aceitou a justificativa** (falta justificada), ou
- a gravação **não foi realizada por um problema do estúdio**,

a gravação mostra **Remarcar** com o prazo. Você pode escolher uma nova data **sem pagar de novo**, até o fim do **7º dia** depois da gravação perdida (horário de Brasília), respeitando a antecedência mínima para agendar e o mesmo tipo de horário (faixa) que você comprou. A remarcação é **única**. Você recebe um aviso quando a remarcação é liberada e lembretes nos 2 últimos dias.

- **Falta justificada:** se o prazo acabar sem remarcar, o valor pago é perdido.
- **Não realizada pelo estúdio:** se o prazo acabar, você **não perde** o valor — o estúdio entra em contato para combinar a nova data.
- Uma falta **sem** justificativa (inclusive cancelar com menos de 24h de antecedência) não dá direito a remarcar.
- A remarcação sem novo pagamento só vale para gravação **paga**: o pagamento da própria gravação, não o de um serviço extra.

**Como remarcar:**

1. No **Início** aparece o aviso *"Remarque sua gravação de DD/MM até DD/MM — sem novo pagamento"*; ele fica em destaque nos 2 últimos dias. Toque em **Remarcar**. Em **Minhas Gravações**, a gravação mostra o selo **Remarcar até DD/MM**.
2. No detalhe da gravação, toque em **Escolher nova data** (ou em **Remarcar**, no rodapé).
3. Escolha um dos dias dentro do prazo e um horário **Livre** da mesma faixa. Horários ocupados ou em cima da hora aparecem desativados.
4. Toque em **Remarcar para DD/MM às HH:MM**. A gravação volta para a sua agenda como **Confirmada**, sem nova cobrança. Se alguém ocupar o horário antes de você, aparece um aviso e a lista é atualizada para você escolher outro.

## Gráfico de desempenho

Quando há métricas registradas, um **gráfico por rede** resume o desempenho da transmissão.

![Gráfico de métricas](../images/cliente/gravacoes-03-grafico.png)
<!-- TODO screenshot: gráfico (recharts) de métricas por rede -->

## Dicas

- As métricas aparecem **depois** que o estúdio finaliza a gravação (ver, no lado do admin, [Hoje → Finalizar gravação](../guia-admin/hoje.md#finalizar-gravação-métricas-de-transmissão)).
- Você pode **remarcar** uma sessão futura dentro da janela permitida (ver [Agenda](agenda-e-agendamento.md)).

## Ver também

- [Agenda e agendamento](agenda-e-agendamento.md) · [Contratos](contratos.md)
