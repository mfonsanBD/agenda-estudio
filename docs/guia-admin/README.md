# Guia do admin

Esta trilha cobre a **operação do estúdio**: conduzir a agenda do dia, gerenciar clientes e contratos, acompanhar finanças e relatórios, e configurar as regras do negócio.

> A área administrativa (rotas `/admin/*`, mais o Painel e a Agenda no modo da equipe) é da **equipe**: o **Administrador** vê tudo; o **Colaborador** vê no menu e abre só as áreas que o administrador liberou na tela [Equipe](equipe.md), e dentro delas só os botões das ações marcadas. Abrir pelo endereço uma área não liberada volta para o Painel com o aviso "Você não tem acesso a essa área.". Clientes nunca entram aqui. Onde um guia fala em "admin", leia "quem tem a permissão daquela ação"; cada guia tem uma seção **Colaboradores** (em Configurações, **Acesso da equipe**) com as permissões de cada botão.

## Mapa da operação

1. **[Hoje](hoje.md)** — a tela do dia a dia: confirmar presença, concluir sessões e **finalizar gravações** (registrar métricas de transmissão).
2. **[Agendamentos](agendamentos.md)** — CRUD completo de agendamentos, com filtros e cobrança.
3. **[Clientes](clientes.md)** — lista segmentada de clientes e o perfil detalhado de cada um.
4. **[Contratos](contratos.md)** — gerenciar contratos, editar serviços, cobrar parcelas e resolver cancelamentos.
5. **[Financeiro](financeiro.md)** — fechamento mensal (bruto, taxas, líquido, inadimplência).
6. **[Relatórios](relatorios.md)** — ocupação, receita por tier, audiência e ranking de clientes.
7. **[Configurações](configuracoes.md)** — as 10 seções que controlam preços, horários, políticas, serviços, formas de pagamento, ambiente, gravações, e-mail e integrações.
8. **[Equipe](equipe.md)** — quem acessa a área administrativa: administradores (acesso total) e colaboradores (só os módulos marcados). Só o administrador vê esta tela.

## Ações da equipe (o que exige permissão)

O administrador faz tudo abaixo; o colaborador, só o que foi marcado para ele (entre parênteses, a permissão na tela Equipe):

- Confirmar presença (**Confirmar presença**), operar a gravação (**Operar a gravação**) e marcar **Falta** (o cliente não veio: consome o crédito Flex) ou **Não Realizado** (a sessão não aconteceu por causa do estúdio: devolve o crédito Flex; no avulso, abre a remarcação sem novo pagamento) — **Registrar falta ou não realizado**. No avulso, a mesma permissão marca a falta como **justificada**, liberando uma remarcação em até 7 dias.
- Criar agendamentos e contratos (**Criar agendamento para cliente**, **Criar e renovar contratos**). Sem **Marcar como pago, anular ou estornar**, o que a pessoa cria nunca nasce pago: o agendamento nasce Reservado e o contrato nasce com as parcelas em aberto.
- Resolver pedidos de cancelamento, **cobrar multa** ou **isentar** (**Decidir pedido de cancelamento**).
- Editar **preços, descontos, horários e políticas** do negócio (as caixas de **Configurações**).
- Ligar/desligar o **pagamento por boleto** para todo o sistema (**Formas de pagamento**; chave única em Configurações → Pagamentos, exige a Cora ativa). Não existe liberação de boleto por contrato.

## Só o administrador

- A tela **Equipe** (criar, editar, desativar pessoas e definir permissões).
- **Integrações** de pagamento (Stripe, Sicoob e Cora), **E-mail (SMTP)** e as **taxas de gateway**.
- Definir a **senha de um cliente**.
- Editar, desligar e testar os **avisos da equipe** ("Equipe — …") em Avisos.

## Relacionado

- Como o sistema cobra, reconcilia e aplica efeitos de pagamento: [tecnico/pagamentos.md](../tecnico/pagamentos.md).
- Quais notificações o sistema gera: [tecnico/notificacoes.md](../tecnico/notificacoes.md).
- Permissões da equipe (matriz completa e regras do servidor): [tecnico/permissoes-equipe.md](../tecnico/permissoes-equipe.md).
