# Clientes

> Rotas: **`/admin/clients`** (lista) e **`/admin/clients/:id`** (perfil) · Menu: **Clientes** · Acesso: administrador e colaborador com **Ver clientes** (os botões seguem as permissões — ver [Colaboradores](#colaboradores))

Cadastro e segmentação da base de clientes, com um perfil detalhado por pessoa.

## Lista de clientes

- **Abas/filtros** por segmento: com contrato ativo, ex-clientes, sem contrato, sem serviço (add-on).
- **Busca** por nome, e-mail ou telefone.
- Cada linha mostra nome, contato, contagem de agendamentos/contratos e última interação.

![Lista de clientes](../images/admin/clientes-01-lista.png)
<!-- TODO screenshot: /admin/clients lista com filtros por segmento -->

### Ações

- **Ver perfil** → abre `/admin/clients/:id`.
- **Novo cliente** → assistente em 3 etapas (veja abaixo).
- **Editar** / **Excluir** — veja [Excluir um cliente](#excluir-um-cliente).

### Cadastro e edição em 3 etapas

> Este cadastro cria só **clientes**. Administradores e colaboradores são criados e gerenciados na tela **[Equipe](equipe.md)** (menu Sistema → Equipe, só administrador); o antigo campo "Tipo de conta" saiu daqui.

**Novo cliente** e **Editar cliente** são assistentes em 3 etapas:

1. **Dados pessoais**: nome (obrigatório), CPF/CNPJ (opcional, mas precisa ser válido; é exigido para cobrar por PIX) e status (Ativo/Inativo/Bloqueado).
2. **Contato e endereço**: e-mail (obrigatório), telefone, redes sociais (YouTube, Instagram, Spotify e Site, os mesmos links do perfil) e endereço. Ao digitar o CEP, rua, bairro, cidade e UF são preenchidos sozinhos.
3. **Segurança e notas**: senha e notas internas. A **senha é opcional** e **só o administrador** vê o campo (mínimo de 6 caracteres; na edição, deixe vazio para manter a atual; ao definir, as sessões abertas do cliente são encerradas). Sem senha, o cliente entra no app com um **código enviado ao e-mail**; para quem não é administrador, a etapa mostra o quadro "Acesso ao app" explicando isso.

- O botão **Próximo** só é liberado quando a etapa está válida. O botão de salvar (**Cadastrar cliente** / **Salvar alterações**) fica só na última etapa.
- Na **edição**, clique numa etapa no topo para ir direto a ela. Ao salvar, todas as etapas são conferidas. Se algo estiver errado, o assistente volta para a etapa do problema.
- E-mail já cadastrado leva à etapa 2. CPF/CNPJ já cadastrado em outra conta leva à etapa 1. A mensagem aparece no topo e no campo.
- Apagar as **notas** e salvar funciona (antes a edição falhava em silêncio com as notas vazias).
- Redes sociais antigas gravadas como texto livre aparecem como "Anotação antiga" na etapa 2. Esse texto só é substituído se você preencher os campos de redes.
- **Trocar o e-mail de login** de um cliente encerra as sessões abertas dele, desfaz o vínculo com o login pelo Google (ele entra de novo pelo e-mail novo) e manda um aviso ao e-mail antigo. A senha, se houver, continua a mesma; o código de entrada passa a ir para o e-mail novo. A dica do campo avisa isso antes de salvar. Diferença só de maiúsculas não conta como troca.
- O e-mail não pode ser de outra conta (cliente ou equipe), sem diferenciar maiúsculas.

## Perfil do cliente

Em `/admin/clients/:id` você vê tudo do cliente em abas:

1. **Contratos** — ativos, arquivados e cancelados.
2. **Agendamentos** — sessões com tier, data, status e preço.
3. **Pagamentos** — histórico (pago/pendente/vencido), com possibilidade de cobrar parcelas.
4. **Notas** — observações internas do admin.

![Perfil do cliente](../images/admin/clientes-02-perfil.png)
<!-- TODO screenshot: /admin/clients/:id com abas de contratos/pagamentos/notas -->

### A partir do perfil você pode

- Criar **novo contrato** ou **agendamento** para o cliente.
- Editar os **dados** do cliente.
- Ver o card **Pagamento** (parcelas, cartões salvos e o estado da cobrança automática).
- Ligar/desligar **cobrança automática** no cartão salvo. Só funciona com cartão de **crédito**: se o cartão do cliente for de débito ou pré-pago (ou não puder ser conferido), o sistema recusa, mostra o motivo e a chave continua desligada. Ela cobra só as parcelas do plano — nunca extras de gravação nem a multa de cancelamento.
- Mudar o **status**. Escolher **Bloqueado** (no perfil ou no assistente **Editar cliente**) abre uma confirmação vermelha, sem o selo "Irreversível" porque tem volta: o cliente não consegue mais entrar no app (senha, código e Google são recusados) e uma sessão já aberta é **encerrada na hora**. Contratos, gravações e cobranças continuam como estão. Para liberar de novo, volte o status para **Ativo** (o cliente entra de novo com login).
- **Excluir** o cliente, na **Zona de perigo** no fim da página (veja abaixo).
- **Excluir definitivamente** (só o administrador), também na **Zona de perigo** — inclusive no perfil de um cliente já excluído: apaga de vez o cadastro e tudo o que está ligado a ele (contratos, gravações e cobranças, inclusive as pagas, que somem do financeiro e dos relatórios). O diálogo mostra o que vai sumir e pede para digitar **EXCLUIR**. Não é possível desfazer.

### Perfil de cliente excluído

Um cliente excluído com histórico continua acessível pelo link do perfil (por exemplo, a partir de um agendamento antigo), com o aviso **"Cliente excluído em dd/mm/aaaa — somente histórico"**. Os dados pessoais aparecem como removidos e o selo é **Excluído**. Dados do cliente, observações e cobrança automática ficam ocultos, e a Zona de perigo mostra só **Excluir definitivamente** (para o administrador): o cadastro não pode mais ser alterado. Contratos (o avulso mostra a data e o horário reais da gravação), gravações e pagamentos ficam só para consulta. Na lista de **Contratos**, os dele aparecem com o selo **Cliente excluído** e sem **Renovar**, **Pausar**, **Retomar** ou **Cobrar multa**; o **Editar** não os reativa. Também não é possível criar agendamento, remarcar (inclusive a remarcação do avulso) ou justificar falta de um cliente excluído: o sistema responde "Este cliente foi excluído."

## Excluir um cliente

Disponível na lista de clientes (lixeira) e na **Zona de perigo** do perfil. Ao clicar, o sistema calcula
as consequências reais daquele cliente e abre um diálogo vermelho com a lista "O que vai acontecer"
(quantos contratos, gravações futuras e cobranças pendentes, com o valor, cartões salvos, cobrança automática
e o histórico pago que fica). O botão **Excluir cliente** só é liberado depois de digitar **EXCLUIR**. Se a
exclusão não for permitida (conta da equipe, cliente já excluído, ou falta ao seu acesso uma permissão do que
ela anularia — veja abaixo) ou a API recusar, a mensagem aparece num diálogo, sem excluir nada. Depois de excluir, o cliente some da lista (do perfil, você volta
para a lista).

- **Cliente sem nada vinculado** (nenhum contrato, agendamento, pagamento ou cupom usado): o cadastro é
  apagado definitivamente.
- **Cliente com histórico**: o cadastro vira "excluído" e os dados pessoais são apagados (e-mail, CPF/CNPJ,
  telefone, endereço, login Google, senha, foto, redes sociais e notas). O **nome** fica para o histórico.
  A exclusão **não é bloqueada por pendências**; ela as encerra:
  - contratos ativos, pausados, aguardando pagamento ou com cancelamento solicitado são **cancelados**;
  - gravações futuras são **canceladas** e os horários voltam a ficar livres;
  - antes de anular, cada cobrança já emitida é **conferida e cancelada no provedor** (QR PIX, cartão). O que
    foi pago no último instante fica **Pago** e o aviso final mostra o valor, para você avaliar a devolução;
  - cobranças **pendentes** são **anuladas** (deixam de ser cobradas) e a cobrança automática é desligada;
  - gravações de **hoje** que já começaram (ou com "Iniciar gravação") ficam como estão, para você finalizar
    ou marcar falta;
  - cartões salvos são removidos.
- Se um pagamento estiver **em processamento no provedor** (cartão em autenticação, PIX que não pôde ser
  cancelado), a exclusão é recusada sem mexer em nada. Tente de novo em alguns minutos.
- **Colaboradores**: além de **Excluir cliente**, a exclusão pede a permissão de cada coisa que ela anula —
  **Cancelar contrato** (contrato em andamento), **Decidir pedido de cancelamento** (pedido em análise ou multa em
  aberto) e **Marcar como pago, anular ou estornar** (cobrança em aberto de sessão, avulsa ou de contrato
  encerrado). Faltando alguma, o diálogo de exclusão nem abre: aparece "Excluir este cliente anula o que ele tem em
  aberto, e isso exige também …" com o que falta, e nada é excluído. Cliente sem nada em aberto: basta **Excluir
  cliente**. O administrador não tem essa restrição.
- A sessão aberta do cliente é **encerrada na hora**, assim que a exclusão começa (durante ela, ele não consegue
  entrar de novo, renovar o acesso nem criar reserva ou cobrança). Uma exclusão recusada antes de começar (falta de
  permissão, conta da equipe, cliente já excluído) não mexe na sessão nem no login do cliente.
- O que já foi **pago** continua nos relatórios e no financeiro, sem dados pessoais.
- O e-mail e o CPF ficam livres: a pessoa pode se cadastrar de novo como cliente novo.
- O cliente excluído perde o acesso ao app e some da lista e dos seletores de cliente. O perfil antigo
  continua aberto só para consulta.
- Não é possível excluir a própria conta nem uma conta da equipe (administrador ou colaborador: ela é desativada na tela [Equipe](equipe.md)). A exclusão **não pode ser desfeita**.

## Dicas e erros comuns

- A **exclusão** é irreversível. Se a ideia é só impedir o acesso por um tempo, use o status **Bloqueado**.
- O resumo financeiro do cliente vem de `GET /api/users/:id/payment-overview` (ver [API](../tecnico/api.md)).
- **"A Receber"** soma as cobranças pendentes do cliente. Cancelar uma sessão anula a cobrança em aberto dela (inclusive a do avulso), então ela sai dessa soma. A cobrança de um avulso cancelado **antes** dessa regra continua contando, sem poder ser paga pelo app: para anulá-la, peça ao suporte técnico (veja [Agendamentos](agendamentos.md#cancelar-e-excluir)).

## Colaboradores

| Na tela | Permissão |
|---|---|
| Abrir Clientes e o perfil (contato, CPF/CNPJ, endereço, histórico, o card **Pagamento**, "Valor Pago"/"A Receber") | **Ver clientes** |
| **Novo Cliente** | **Cadastrar cliente** (cria sem senha; o cliente entra pelo código no e-mail) |
| Lápis e campos do cadastro (nome, telefone, CPF/CNPJ, endereço, redes, etiquetas, observações), situação Ativo ↔ Inativo | **Editar o cadastro do cliente** |
| E-mail de login (na edição) e **Bloqueado** / desbloquear | **Alterar o acesso ao app do cliente** |
| Senha do cliente | só o administrador |
| Lixeira e **Zona de perigo** | **Excluir cliente** |
| Interruptor da **cobrança automática** | **Ligar ou desligar a cobrança automática do cliente** |
| CPF/CNPJ de quem ainda não tem, na hora de cobrar por PIX | **Cobrar o cliente** (ou **Editar o cadastro do cliente**); trocar um CPF já gravado exige **Editar o cadastro do cliente** |
| **Abrir contrato** no perfil | **Ver contratos** |
| Notas e métricas das sessões no histórico | **Operar a gravação** ou **Mudar data, horário e status** |

Sem a permissão, o campo fica só para leitura ou a opção aparece desabilitada com a explicação (por exemplo, "Bloqueado" sem **Alterar o acesso ao app do cliente**).

## Ver também

- [Contratos](contratos.md) · [Financeiro](financeiro.md)
