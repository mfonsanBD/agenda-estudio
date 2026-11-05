# Financeiro

> Rota: **`/admin/finance`** · Menu: **Financeiro** · Acesso: administrador e colaborador com **Ver o financeiro e a receita**

Fechamento mensal e acompanhamento de pagamentos.

## Visão geral

1. Selecione **ano** e **mês**.
2. Veja os KPIs do período: **bruto**, **taxas** (por provedor), **líquido** e **% de cobrança**.
3. A tabela lista cada pagamento: cliente, contrato, valor, status (`PAID`/`PENDING`/`FAILED`), taxa, líquido e vencimento.
4. **Filtre** por status e **busque** por cliente/contrato; os totais acompanham o filtro.

![Fechamento mensal](../images/admin/financeiro-01-fechamento.png)
<!-- TODO screenshot: /admin/finance com KPIs e tabela do mês -->

Os dados vêm de `GET /api/finance/closing/:year/:month` e `GET /api/payments/summary` (ver [API](../tecnico/api.md)).

## Dicas e erros comuns

- **Valores em centavos** no backend são exibidos formatados (R$) na tela.
- Pagamentos `PENDING` vencidos geram notificação de **pagamento vencido** (ver [notificacoes.md](../tecnico/notificacoes.md)).
- A reconciliação da Cora pode confirmar PIX/boleto cujo webhook falhou — então o status pode atualizar sozinho em alguns minutos (ver [pagamentos.md](../tecnico/pagamentos.md)).

## Colaboradores

- A tela e os números dela só abrem com **Ver o financeiro e a receita**. A mesma permissão mostra a **Receita do Mês** no painel (para quem também vê a Agenda), o KPI **Receita** de Agendamentos e a receita dos [Relatórios](relatorios.md) (para quem também vê Relatórios).
- Sem ela, a pessoa continua vendo o preço de cada sessão e as parcelas de cada contrato: some só a receita consolidada.
- Os avisos de dinheiro (faturas vencidas, pagamento com cartão recusado, pagamento em cobrança cancelada, cobrança em dobro no cartão) vão para os administradores e para quem tem esta permissão.

## Ver também

- [Contratos](contratos.md) · [Relatórios](relatorios.md) · [Pagamentos (técnico)](../tecnico/pagamentos.md)
