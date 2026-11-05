# Equipe

> Rota: **`/admin/equipe`** · Menu: **Sistema → Equipe** · Acesso: só **Administrador**

Quem entra na área administrativa e o que cada pessoa pode fazer. Clientes **não** aparecem aqui (eles ficam em [Clientes](clientes.md)), e a equipe não aparece em Clientes.

## Os dois tipos de acesso

- **Administrador**: acesso total, inclusive esta tela, as Integrações (Stripe, Sicoob e Cora), o E-mail (SMTP), as taxas de gateway, a senha dos clientes, os avisos da equipe e a manutenção do sistema. Só um administrador cria, edita ou desativa pessoas da equipe.
- **Colaborador**: acessa **só os módulos e as ações que você marcar**. O menu dele mostra apenas as áreas liberadas, os botões das ações não marcadas não aparecem (ou aparecem desabilitados, com a explicação), e o servidor recusa qualquer ação fora do que foi marcado.

O sistema nunca fica sem administrador ativo: a tela não deixa tornar colaborador nem desativar o último, e o servidor confere de novo.

> **Primeiro uso:** confira na lista quem está como **Administrador**. Antes desta tela, toda conta da equipe tinha acesso total; quem não precisa de tudo deve virar **Colaborador** com só os módulos de que precisa.

## Lista da equipe

- **Indicadores** no topo (clique para filtrar; clique de novo para limpar): **Total**, **Administradores**, **Colaboradores** e **Desativados**.
- **Busca** por nome, e-mail ou cargo.
- Cada linha mostra a pessoa (com o selo **você** na sua própria linha), o e-mail, o tipo (**Administrador** ou **Colaborador**), o cargo, o acesso e a situação (**Ativo** ou **Desativado**). No celular, cada pessoa vira um cartão.
- **Acesso**: administrador mostra **Acesso total**; colaborador mostra **N módulos**. Passe o mouse para ver quais, e clique para abrir direto a etapa **Permissões**.

### Ações de cada linha

| Ação | Quando aparece | O que faz |
|---|---|---|
| **Editar** (lápis) | Sempre | Abre o assistente da pessoa. Na sua própria linha é **Editar meus dados** (nome, telefone e cargo). |
| **Enviar acesso** (envelope) | Pessoa ativa, com e-mail, que não é você | Pede confirmação e envia o e-mail "Você foi adicionado à equipe…" com o link de login. **O e-mail não leva senha**: a pessoa entra com o código que chega no e-mail. Há um limite de 10 envios a cada 15 minutos. |
| **Definir senha** (chave) | Colaborador que não é você e **nunca foi administrador** | Define uma senha nova (mínimo de 8 caracteres, digitada duas vezes). As sessões abertas da pessoa são encerradas em todos os aparelhos. Para quem já foi administrador o botão não aparece (use **Enviar acesso**); se a lista estiver desatualizada, o sistema recusa e a folha explica a regra. |
| **Desativar acesso** | Pessoa ativa que não é você | Pede confirmação. A pessoa sai na hora de todas as sessões, não consegue mais entrar (senha, código e Google), e as notificações no celular param. O histórico fica; as permissões ficam guardadas. Para o único administrador ativo, o botão fica desabilitado com a explicação. |
| **Reativar acesso** | Pessoa desativada | Pede confirmação. A pessoa volta a entrar com o mesmo e-mail e recupera as permissões que tinha. |
| **Excluir definitivamente** (lixeira) | Qualquer pessoa que não é você (inclusive outro administrador) | Mostra o que vai sumir e pede para digitar **EXCLUIR**. A conta é apagada de vez e a pessoa perde o acesso na hora; os bloqueios de agenda que ela criou continuam, em seu nome. Não é possível desfazer. Para afastar alguém sem apagar, use **Desativar acesso**. |

### Proteções

- **Na sua própria linha só existe Editar**: ninguém muda o próprio tipo de acesso nem se desativa (peça a outro administrador).
- O **e-mail e a senha de um administrador não se alteram por aqui**, nem os de quem **já foi administrador** e virou colaborador. Para essas pessoas, use **Enviar acesso** (o código de entrada vai para o e-mail delas). No **Editar**, o e-mail delas já vem travado: o seu, com "O seu e-mail de administrador não se altera por aqui, por segurança."; o de um administrador, com "O e-mail de um administrador não se altera por aqui, por segurança."; o de quem já foi, com "Esta pessoa já foi administradora: o e-mail e a senha não se alteram por aqui, por segurança.". Se a lista estiver desatualizada e o sistema recusar a troca, o assistente volta à etapa **Dados** com "Por segurança, o e-mail de quem é ou já foi administrador não se altera pela tela Equipe. O e-mail voltou ao anterior: salve de novo para gravar as outras alterações.".
- **Excluir definitivamente** apaga a conta de vez; para só afastar a pessoa (e poder trazê-la de volta), use **Desativar**. Ninguém exclui a própria conta, e o sistema nunca fica sem um administrador ativo.
- O e-mail da equipe **não pode ser de um cliente**: a mesma pessoa que é cliente usa outro e-mail para a conta da equipe.
- Toda mudança fica registrada na auditoria do sistema (quem fez, quando e o que mudou).

## Novo membro e edição (assistente em 3 etapas)

Clique em **Novo membro** (ou em **Editar** numa linha). O assistente tem três etapas:

1. **Dados**: nome (obrigatório), cargo (opcional, ex.: "Recepção"; o do colaborador aparece abaixo do nome no menu — o administrador aparece sempre como "Administrador"), e-mail (obrigatório, é o login) e telefone.
   - **Trocar o e-mail de um colaborador** (ex.: e-mail digitado errado): as sessões dele são encerradas, o e-mail antigo recebe um aviso, o vínculo com o Google é desfeito e **a senha é apagada**. A dica do campo já avisa isso antes de salvar, e a etapa **Acesso** mostra "O e-mail mudou na etapa Dados: ao salvar, a senha atual é apagada e o vínculo com o Google é desfeito." A pessoa certa entra pelo código no e-mail novo (o Google volta a valer com a conta do e-mail novo); se ela precisar de senha, use **Definir senha** ou **Enviar acesso** depois de salvar (a mensagem ao salvar lembra disso quando havia senha).
2. **Acesso**: **Colaborador** ou **Administrador**.
   - Ao **criar**: senha provisória opcional (mínimo de 8 caracteres) e a caixa **Enviar o e-mail de acesso agora** (ligada por padrão). Sem senha, a pessoa entra com um código enviado ao e-mail. Se o e-mail não puder ser enviado, a pessoa é cadastrada mesmo assim e a mensagem pede para usar **Enviar acesso** depois.
   - Ao **editar**, mudar o tipo pede uma confirmação e encerra as sessões abertas da pessoa (ela entra de novo e já vê o menu novo).
3. **Permissões** (só para colaborador; para administrador a etapa só avisa que o acesso é total). Veja abaixo.

Regras do assistente:
- **Próximo** só é liberado quando a etapa está válida; o botão de salvar (**Adicionar à equipe** / **Salvar alterações**) fica só na última etapa.
- Na **edição**, clique numa etapa no topo para ir direto a ela. Ao salvar, todas as etapas são conferidas, e só o que mudou é enviado (sem mudança, aparece "Nada mudou").
- Se o servidor recusar, o assistente volta para a etapa do problema com a mensagem no topo: e-mail já usado, de cliente ou de administrador → **Dados**; "único administrador" ou mudança do próprio acesso → **Acesso**; permissão que não existe mais → **Permissões** (ela é desmarcada sozinha; confira e salve de novo).

### Quando a mudança vale

- **Permissões**: valem **na hora**, sem deslogar o colaborador. O servidor já aplica na próxima ação dele; o menu se atualiza quando ele tenta algo que perdeu, quando volta para a aba do app ou ao recarregar a página.
- **Tipo de acesso, e-mail, senha e desativar**: encerram as sessões abertas da pessoa em **todos os aparelhos**; ela precisa entrar de novo (a sessão antiga não volta a valer).
- **Instabilidade do sistema**: se o servidor não conseguir ler as permissões de um colaborador, ele **não** entra sem módulos e a sessão dele não é encerrada; se tentar entrar nesse momento, o login mostra "Não foi possível entrar agora: as permissões do seu acesso não puderam ser carregadas…". Basta tentar de novo em instantes.

## Etapa Permissões

### Perfis modelo

No topo, escolha um ponto de partida (isso só **preenche as caixas**; depois ajuste à vontade):

- **Recepção / Atendimento**: agenda, recebe o cliente, fecha plano novo e cobra no balcão. Não vê a receita, **não renova plano**, não reabre sessão cancelada nem cancela sessão com cobrança em aberto (ex.: avulso ainda não pago) — tudo isso exige também "Marcar como pago, anular ou estornar" —, não debita cartão salvo, não dá baixa e não exclui nada. As descrições das ações na etapa Permissões dizem quando a baixa também é exigida.
- **Operador de estúdio**: opera a gravação (presença, iniciar, finalizar, métricas), registra falta e vê a audiência. Sem dinheiro.
- **Financeiro**: cobranças, baixas, multas, contratos e relatórios com receita. As configurações de preço ficam desmarcadas.
- **Começar do zero**: desmarca tudo.

### Um nível por módulo

Cada módulo (os mesmos nomes do menu) tem um seletor de nível:

- **Sem acesso** · **Ver** · **Ver e editar** · **Tudo, inclusive cancelar e excluir** (só aparecem os níveis que fazem diferença naquele módulo).
- Em **Cobranças** as opções são **Cobrar o cliente** e **Tudo**; em **Avisos e modelos de mensagem**, só **Tudo**.
- Quando as caixas marcadas não batem com um nível, o seletor mostra **Personalizado**.
- **Escolher ação por ação** abre as caixas de cada ação do módulo, com a explicação de cada uma.

O que "Ver" inclui: em Agenda, o **preço de cada sessão**; em Contratos, as **parcelas e valores**; em Clientes, o perfil completo, inclusive o card **Pagamento** (parcelas, cartões e cobrança automática). A **receita consolidada** só aparece com **Financeiro e receita → Ver**: a tela Financeiro; a **Receita do Mês** no painel, para quem também vê a Agenda; e a receita dos **Relatórios**, para quem também vê Relatórios.

### Selos

- **$ mexe com dinheiro**: registra, cobra ou muda valores (baixa manual, cartão salvo, cobrança automática, créditos e condições do contrato, multa, cupons, preços, serviços, formas de pagamento).
- **não tem volta**: o que for apagado não volta (excluir agendamento, excluir cliente).
- **ação sensível**: efeito direto no cliente ou no estúdio (cancelar sessão ou contrato, acesso ao app do cliente, avisos).
- **o cliente vê isto**: o que for alterado aparece para os clientes (Configurações → Gerais, avisos e modelos de mensagem).

### Dependências travadas

Marcar uma ação marca também o que ela precisa, e essa caixa fica **travada** (com a explicação) enquanto a outra estiver marcada. Exemplos: qualquer ação de um módulo marca o **Ver** dele; **Debitar o cartão salvo** marca **Cobrar o cliente**; **Cobrança automática** marca **Ver clientes** (por isso "Sem acesso" em Clientes deixa "Ver clientes" marcado enquanto a cobrança automática estiver marcada, e o card avisa).

### Configurações

Uma caixa por seção (Gerais, Horários & Grade, Preços e regras, Políticas, Serviços, Formas de pagamento, Ambiente, Gravações) e **Marcar todas**. **E-mail**, **Integrações** e **taxas de gateway** aparecem em cinza com "Só o administrador": não dá para liberar para colaborador. **Equipe** e **Manutenção do sistema** também são sempre só do administrador.

### Resumo e avisos

No fim da etapa, o **Resumo do acesso** lista cada módulo liberado (ex.: "Agenda e Agendamentos: tudo menos: Excluir agendamento definitivamente") e destaca as ações que **mexem com dinheiro**, que **não têm volta** e que **o cliente vê**. Avisos que não impedem salvar:
- sem nenhum módulo: a pessoa só vê o painel vazio ("Seu acesso ainda não tem módulos liberados.");
- permissões que **não abrem nenhuma tela** (ex.: só Cobranças): a pessoa só verá o painel vazio;
- cobrança de balcão (**Cobrar o cliente**, **Debitar o cartão salvo do cliente** ou **Marcar como pago, anular ou estornar**) sem "Criar agendamento para cliente" nem "Ver contratos": os botões de cobrança ficam em Agendamentos e Contratos, então a pessoa não consegue cobrar no balcão. Só a **cobrança automática** não gera esse aviso (o interruptor fica no perfil do cliente); quando ela também está marcada, o aviso lembra que ela funciona assim mesmo.

## O que cada permissão muda na prática

O detalhe de cada botão está na seção **Colaboradores** de cada guia ([Hoje](hoje.md#colaboradores), [Agendamentos](agendamentos.md#colaboradores), [Clientes](clientes.md#colaboradores), [Contratos](contratos.md#colaboradores), [Configurações](configuracoes.md#acesso-da-equipe), [Financeiro](financeiro.md#colaboradores), [Relatórios](relatorios.md#colaboradores)). As regras que mais surpreendem:

**Sem "Marcar como pago, anular ou estornar"** — nada criado pela pessoa nasce pago:
- o **agendamento** nasce **Reservado**: o avulso fica aguardando pagamento; a sessão de um plano **Fixo, Flex ou Personalizado** não gera cobrança da sessão (o plano já cobre; só os serviços extras, se houver), fica com a presença a confirmar e só pode ser num horário da **faixa do plano** (ex.: plano Comercial não agenda horário de Audiência ou Sábado);
- a sessão ligada a um **contrato de serviço** ou a um **plano Fixo que já usou todas as sessões** é cobrada (fica aguardando pagamento, e a mensagem explica por quê). No Fixo isso é o comum, porque as sessões do plano nascem geradas na contratação: o Novo agendamento avisa antes de agendar;
- não dá para escolher "Confirmado" nem mudar o preço do agendamento, nem usar cupom de 100%;
- não dá para mudar uma sessão avulsa, de serviço ou cobrada à parte (ex.: a extra do Fixo) para um horário de **outra faixa de preço** (isso muda o valor cobrado); a sessão de plano muda de faixa, mas só dentro das faixas que o plano cobre;
- não dá para **reabrir uma sessão cancelada** (o cancelamento anulou a cobrança em aberto dela e liberou o crédito ou a vaga do plano): peça a quem tem a permissão. Crie um novo agendamento só se a sessão cancelada não foi paga (se foi, o cliente seria cobrado de novo); ao tentar reabrir, a mensagem diz se a cobrança dela está paga, foi anulada ou não existe;
- não dá para **cancelar** (nem excluir) uma sessão que tem **cobrança em aberto**, em qualquer situação: antes ou depois da gravação, e também depois de reabri-la ou remarcá-la. Cancelar anularia a cobrança, e anular é desta permissão. A tela mostra **Cancelar indisponível** com o motivo. Se o cliente faltou, use **Falta**, e a cobrança continua devida;
- tirar uma sessão de **Não realizado** só funciona se o plano ainda tiver o crédito (ou, no Fixo, a vaga) que o "Não realizado" devolveu. No Flex, esse crédito também pode ter vencido no confisco semanal. A sessão extra do Fixo (criada quando o plano já tinha usado todas as sessões) não depende da vaga;
- não dá para **pausar um Fixo** quando uma gravação que a pausa cancelaria tem cobrança em aberto (ex.: um serviço extra contratado nela), nem **cancelar um contrato** ou **decidir o pedido de cancelamento** dele com cobrança de gravação em aberto (no avulso, qualquer cobrança em aberto; nos outros tipos, a de uma gravação cobrada à parte, mesmo já feita): essas ações anulariam a cobrança. Na lista de Contratos, cancelar e decidir aparecem com um cadeado e o motivo; a pausa é recusada ao confirmar. As parcelas do plano continuam anuladas só com **Cancelar contrato**;
- **excluir um cliente** pede também a permissão de tudo o que a exclusão anula: **Cancelar contrato** (contrato em andamento), **Decidir pedido de cancelamento** (pedido em análise ou multa em aberto) e esta (cobrança em aberto de sessão, avulsa ou de contrato encerrado). Sem alguma delas, a tela explica e nada é excluído;
- o **contrato** nasce **ativo com as parcelas em aberto**; cupom de 100% é recusado;
- **Renovar** não aparece (a renovação cria o plano sem parcelas).

**Sem "Cobrar o cliente"** — a pessoa cria, mas não cobra: não aparece "Cobrar o cliente agora" no agendamento (PIX, cartão ou boleto) nem a folha de cobrança do contrato; o contrato termina com "1ª cobrança pendente: o cliente paga pelo app".

**Contratos:**
- reabrir um contrato **cancelado** exige **Cancelar contrato** e **Mudar créditos, serviços e condições de pagamento**;
- tudo que muda o status de um contrato com **pedido de cancelamento em análise** exige **Decidir pedido de cancelamento**.

**Agendamento ligado a um contrato** (vale para todos, inclusive o administrador):
- só em contrato **ativo** ou **concluído**: cancelado, expirado, pausado, aguardando pagamento ou com cancelamento pedido é recusado;
- em **Flex** e **Personalizado**, o agendamento criado pela equipe **consome 1 crédito** do plano;
- uma sessão **cancelada** de **Flex** só volta a **Concluído** (se ela aconteceu; o saldo de créditos se acerta sozinho; reabrir exige **Marcar como pago, anular ou estornar**); a de **Personalizado** não é reaberta, e o painel não tem campo para o saldo do Personalizado (para acertá-lo, peça ao suporte técnico). Para uma sessão nova, crie um novo agendamento.
- a sessão cuja **cobrança própria foi anulada** não volta a **Reservado** ou **Confirmado** a partir de nenhum status fechado (Cancelado, Concluído, Falta, Não realizado): para gravar, crie um novo agendamento, que gera a cobrança de novo.

**Clientes:**
- **senha de cliente** só o administrador define (o cliente cadastrado sem senha entra pelo código no e-mail);
- trocar o **e-mail de login** e **bloquear** exigem **Alterar o acesso ao app do cliente**.

**Avisos e modelos de mensagem:**
- **Editar os textos das mensagens automáticas** vale só para as mensagens que os **clientes** recebem;
- os **avisos da equipe** ("Equipe — …", como cobrança em dobro ou pedido de cancelamento) só o administrador edita, desliga e testa — o colaborador nem os vê na lista;
- **Enviar aviso aos clientes** só aceita clientes como destinatários.

## Avisos que cada pessoa recebe

O administrador recebe todos os avisos da equipe. O colaborador recebe só os ligados ao que ele pode fazer, e nunca depois de desativado:

| Aviso | Recebe o colaborador com |
|---|---|
| Pedido de cancelamento / cancelamento pendente | **Decidir pedido de cancelamento** |
| Faturas vencidas, pagamento com cartão recusado, pagamento em cobrança cancelada, cobrança em dobro no cartão | **Ver o financeiro e a receita** |
| Sessão confirmada ou cancelada pelo cliente, gravação avulsa remarcada | **Ver a operação do dia** |
| Sessão de hoje não confirmada | **Confirmar presença** |
| Gravação não realizada sem remarcação | **Registrar falta ou não realizado** |
| Contrato expirando / aguardando pagamento | **Ver contratos** |

Se uma permissão for retirada, os avisos antigos que levam a uma tela que a pessoa não abre mais somem do sino dela.

## Relacionado

- Matriz completa de permissões, regras do servidor e runbook (inclusive o "sistema sem administrador"): [tecnico/permissoes-equipe.md](../tecnico/permissoes-equipe.md).
