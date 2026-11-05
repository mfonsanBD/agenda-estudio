# Relatórios

> Rota: **`/admin/reports`** · Menu: **Relatórios** · Acesso: administrador e colaborador com **Ver relatórios**

Análises de uso e desempenho do estúdio.

## Visão geral

Selecione o período (últimos 7/30/90/365 dias). Os cartões de resumo mostram total de sessões, concluídas (com % de presença), faltas, cancelamentos e receita.

![Resumo](../images/admin/relatorios-01-resumo.png)
<!-- TODO screenshot: /admin/reports cartões de resumo -->

## Seções

- **Ocupação por horário e por dia** — quais faixas e dias da semana são mais cheios.

  ![Ocupação](../images/admin/relatorios-02-ocupacao.png)
  <!-- TODO screenshot: gráficos de ocupação por horário/dia -->

- **Por tier** — distribuição de receita/sessões entre Comercial, Audiência e Sábado.
- **Audiência** — métricas das transmissões finalizadas (views, pico, chat, duração).

  ![Audiência](../images/admin/relatorios-03-audiencia.png)
  <!-- TODO screenshot: métricas de audiência -->

- **Ranking de clientes** — os 10 primeiros por receita (o ranking completo sai no CSV).

## Exportar CSV

O botão **Exportar CSV** (no cabeçalho, ao lado do período) baixa a **página inteira do período escolhido** em um arquivo
que abre direto no Excel:

- cabeçalho com o nome do estúdio, o título, o **período em datas** (ex.: `31/08/2026 a 30/09/2026`) e a data e hora em que foi gerado;
- um bloco para cada seção da tela — **Resumo**, **Ocupação por horário**, **Ocupação por dia da semana**,
  **Distribuição por faixa**, **Métricas de audiência** — cada um com título e colunas. A linha de **TOTAL** sai
  só nos blocos em que somar faz sentido: ocupação por horário, ocupação por dia da semana e distribuição por faixa
  (Resumo e Métricas de audiência são listas de indicadores, sem total);
- o **ranking de clientes completo** (todos os clientes do período, não só os 10 da tela), com a linha de **TOTAL** no fim.

Valores em reais (`R$ 1.234,56`), percentuais e datas no formato brasileiro. O nome do arquivo traz o período
(ex.: `relatorio-estudio_2026-08-31_a_2026-09-30.csv`). Enquanto o arquivo é montado o botão mostra "Exportando…".
Por enquanto a exportação é só em CSV (sem PDF/Excel com cores).

Os dados vêm dos endpoints `GET /api/reports/{summary,occupancy,tiers,audience,ranking}` (ver [API](../tecnico/api.md)).

## Dicas

- **"Receita" aqui é o valor das sessões agendadas** (não canceladas) no período — não é o que entrou no caixa. O recebido de fato está em [Financeiro](financeiro.md).
- As métricas de **audiência** dependem das gravações finalizadas com dados de transmissão (ver [Hoje → Finalizar gravação](hoje.md#finalizar-gravação-métricas-de-transmissão)).

## Colaboradores

- A tela abre com **Ver relatórios**. A **receita** só aparece para quem também tem **Ver o financeiro e a receita**. Sem ela: some o cartão "Receita", o "· R$" das faixas e a coluna "Receita" do ranking, que passa a se chamar **Top 10 por Sessões** (ordenado por sessões); o CSV sai sem as colunas e a linha de receita.
- O nome do cliente no ranking só vira link para o perfil com **Ver clientes**.

## Ver também

- [Financeiro](financeiro.md) · [Hoje](hoje.md)
