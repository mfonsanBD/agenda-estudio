# Documentação — Estúdio Búzios Digital

Bem-vindo à documentação do sistema de agendamento do Estúdio Búzios Digital. Ela está dividida em três trilhas por público:

## 🧑‍💻 Guia do cliente
Para quem usa o app como cliente do estúdio: agendar gravações, contratar planos, pagar e acompanhar transmissões.

- [Visão geral da área do cliente](guia-cliente/README.md)
- [Primeiros passos (cadastro, login, instalar o app)](guia-cliente/primeiros-passos.md)
- [Painel (Dashboard)](guia-cliente/dashboard.md)
- [Agenda e agendamento](guia-cliente/agenda-e-agendamento.md)
- [Contratos](guia-cliente/contratos.md)
- [Minhas Gravações](guia-cliente/minhas-gravacoes.md)
- [Pagamentos](guia-cliente/pagamentos.md)
- [Notificações e PWA](guia-cliente/notificacoes-e-pwa.md)

## 🛠️ Guia do admin
Para a operação do estúdio: agenda do dia, finanças, contratos, relatórios e configuração.

- [Visão geral da área do admin](guia-admin/README.md)
- [Hoje (agenda do dia)](guia-admin/hoje.md)
- [Agendamentos](guia-admin/agendamentos.md)
- [Clientes](guia-admin/clientes.md)
- [Contratos](guia-admin/contratos.md)
- [Financeiro](guia-admin/financeiro.md)
- [Relatórios](guia-admin/relatorios.md)
- [Configurações](guia-admin/configuracoes.md)
- [Equipe (administradores e colaboradores)](guia-admin/equipe.md)

## ⚙️ Documentação técnica
Para desenvolvedores: arquitetura, setup, modelo de dados, API, deploy.

- [Visão geral técnica](tecnico/README.md)
- [Arquitetura](tecnico/arquitetura.md)
- [Setup de desenvolvimento](tecnico/setup-dev.md)
- [Modelo de dados](tecnico/modelo-de-dados.md)
- [Referência da API](tecnico/api.md)
- [Autenticação](tecnico/autenticacao.md)
- [Equipe e permissões](tecnico/permissoes-equipe.md)
- [Pagamentos (Stripe + Cora)](tecnico/pagamentos.md)
- [Notificações](tecnico/notificacoes.md)
- [Jobs e tarefas agendadas](tecnico/jobs-e-crons.md)
- [Deploy](tecnico/deploy.md)

## Sobre as imagens

Os guias de uso seguem um padrão **passo a passo** e referenciam capturas de tela em `docs/images/`. As imagens ainda a serem capturadas estão catalogadas em **[SCREENSHOTS.md](SCREENSHOTS.md)** (o roteiro de captura). Onde você vir um comentário `<!-- TODO screenshot -->`, a imagem correspondente ainda será adicionada — o texto já descreve o passo por completo.

Os diagramas (arquitetura, modelo de dados, fluxos) são escritos em [Mermaid](https://mermaid.js.org/) diretamente nos arquivos `.md` e renderizam automaticamente no GitHub e no VS Code.

## Convenções

- **Idioma:** português (PT-BR).
- **Links:** relativos entre documentos; referências a arquivos de código apontam para o caminho no repositório.
- **Valores monetários:** o backend armazena tudo em **centavos** (R$ 300,00 = `30000`).
- **Segredos:** a documentação cita apenas **nomes** de variáveis de ambiente, nunca valores.
