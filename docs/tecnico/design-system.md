# Design System — Admin (e base compartilhada)

> Referência consultada pelos "loops de melhoria" por página do admin.
> Regra de ouro: **mudança aditiva** em arquivo compartilhado com a área cliente
> (`index.css`, `modals.css`, `bottom-sheet.css`, `BottomSheetModal.tsx`) — nunca
> alterar valor de token/classe existente. Zona livre: `admin-area.css`.

## 1. Paleta e tokens

Tokens em `frontend/src/styles/index.css` (`:root`). **Nunca escrever hex novo em
TSX/CSS do admin** — usar token ou `constants/adminMeta.ts`.

| Papel | Token | Valor | Quando usar |
|---|---|---|---|
| Fundo da página | `--bg-primary` | `#001e26` | body |
| Card/superfície | `--bg-secondary` / `--bg-card` | `#00252d` / `#002e38` | cards, tabelas |
| Elevação/inputs raised | `--bg-elevated` | `#004250` | inputs dentro de sheet/card |
| Fundo de modal (sheet) | `--sheet-bg` | `#091E24` | só via BottomSheetModal |
| Acento (marca) | `--accent-primary` | `#11819B` | bordas, ícones, fundos de destaque |
| **Acento como TEXTO pequeno** | `--accent-text` | `#2FA8C2` | links/labels teal (accent-primary reprova 4.5:1) |
| Sucesso | `--success` / `--success-bg` | `#10b981` | confirmações, disponível |
| Aviso | `--warning` / `--warning-bg` | `#f59e0b` | pendências |
| Perigo | `--danger` / `--danger-bg` | `#ef4444` | erros, destrutivo |
| Info | `--info` / `--info-bg` | `#3b82f6` | neutro-informativo |
| CTA admin | `--accent-gradient-go` | verde→teal | botão primário (`.btn-admin-go`) |

Regras:
- `--status-*` (`available/reserved/confirmed/blocked/cancelled`) é vocabulário do
  **calendário de slots** — não reutilizar como "urgência" genérica; para isso use
  `--danger`/`--warning`.
- `adminMeta.ts` é o source of truth de cor/label/ícone de status e tier em
  componentes (StatusBadge). Os hex de lá são idênticos aos tokens semânticos.
  Status de PAGAMENTO → `PAYMENT_STATUS_META` (nunca `BOOKING_STATUS_META`); contrato
  inclui `AWAITING_PAYMENT` ("Aguard. pagamento") e `COMPLETED` ("Concluído", teal da marca);
  remarcação do avulso → `MAKEUP_STATUS_META`. `getMeta` e o fallback do `StatusBadge`
  procuram a chave em todos os mapas de status (`findStatusMeta`/`getStatusLabel`) —
  **nunca exibir chave crua em inglês** (desconhecida → "—", chave só no `title`).
- Provedor de cobrança exibido como forma de pagamento: `providerToMethod()` /
  `getPaymentBadge()` de `constants/paymentMethods.ts` (SICOOB/CORA → PIX, STRIPE → Cartão).
- Vigência/duração/plano de contrato: `describeContractTerms()` de `utils/contractStatus.ts`
  (avulso = data da gravação + "Sessão única" + "Pagamento único"; plural "mês/meses").
- Indigo/violeta (`#6366f1`, `#818cf8`, `#4f46e5`) e gradientes azul-violeta são
  **proibidos** — substituir por `--accent-gradient-go` ou tokens teal.
- Contraste: nunca `--text-muted` sobre `--bg-elevated` em texto pequeno (4.3:1).

## 2. Superfícies e inputs

Profundidade: página (`--bg-primary`) → card (`--bg-secondary`/`--bg-card`) →
modal (`--sheet-bg`) → input raised (`--bg-elevated`).

- Input em página: `.form-input` (fundo `--input-bg`).
- Input dentro de sheet/card: `.form-input form-input--raised`.
- Label pequeno uppercase de modal: `.admin-field__label` dentro de `.admin-field`.
- **Dinheiro (R$)**: sempre `components/ui/fields/CurrencyInput` (modo "banco": dígitos
  entram da direita — 3-0-0-0-0 = "300,00"; valor em **centavos**; colar "R$ 1.500,00",
  "1.500,00", "450.00" funciona). Props: `value: number|null`, `onChange(cents|null)`,
  `allowEmpty` (opcional → `null`), `max` (padrão R$ 9.999.999,99), `prefix` ('R$' |
  `false`), `id`, `className` (ex.: `form-input--raised`). Nunca reimplementar parse de
  moeda na tela — funções puras em `utils/currency.ts` (`parseBRLToCents`,
  `formatCentsInput`). CSS `.sf-money*` em `settings-fields.css`.

## 3. Modais

**Único componente: `BottomSheetModal`** (sheet com drag no mobile, dialog
centralizado no desktop, focus trap, portal). `ModalOverlay` e o par CSS
`.modal-overlay`/`.modal` estão **@deprecated**.

Prop `size` (desktop; mobile é sempre sheet full-width):

| size | max-width | Uso |
|---|---|---|
| `sm` (default) | 480px | confirmações, forms de 1-2 campos, sheets de cobrança |
| `md` | 640px | forms padrão (editar cliente/agendamento/contrato/cupom) |
| `lg` | 820px | wizards (CreateBooking, CreateContract, Coupon) |
| `xl` | 1000px | wizard denso (CustomContract) |

- `maxWidth` (string) está deprecated — remover ao tocar cada modal; vence `size`
  enquanto existir (retrocompat).
- **2 colunas só em `lg`/`xl` e apenas ≥768px**, via `.admin-grid-2`.
- Estrutura interna admin: `hideHeader` + `.admin-modal-head` → `.admin-modal-body`
  → ações em `.admin-actions-row`; título `.admin-modal-title` com `__icon`.
- Piloto de referência: `components/admin/bookings/EditBookingModal.tsx`.
- `desktopAnchor` (`'center'` padrão | `'top'`): no desktop (≥640px) `'top'` ancora o dialog a 20px do
  topo (mesma respiração do `max-height`) em vez de centralizá-lo — classe `.bottom-sheet-card--top`
  (`align-self: flex-start`). Uso: **wizards** (o dialog muda de altura entre as etapas e só cresce/encolhe
  para baixo; o cabeçalho não pula). Com a barra inferior visível (640–768px) reserva 20px acima dela.
  No mobile não tem efeito (sempre sheet embaixo). Os demais modais continuam centralizados.
  Com `'top'` no desktop **o fundo não fecha** (o dialog encolhe entre as etapas e um 2º clique no lugar do
  "Próximo" cairia no fundo, perdendo o preenchido): fecha por X, "Cancelar" ou Esc.
- `floatingClose` (com `hideHeader`): X flutuante no canto superior direito do card, só no desktop
  (`.bottom-sheet-close-btn--floating`, com Tooltip "Fechar"). Obrigatório nos wizards ancorados no topo
  cujo cabeçalho próprio não tem X (o "Cancelar" costuma existir só na 1ª etapa).
- `preventClose` (requisição em andamento) trava fundo, arrastar, X e **Esc** — o Esc lê o valor
  ATUAL na hora da tecla (ref), então vale desde o clique em "Salvar". O X do cabeçalho embutido
  é `type="button"` e já vem com `aria-label="Fechar"` + `<Tooltip>`.

### 3a. Confirmação de ação destrutiva — `DangerConfirmDialog`

`components/ui/DangerConfirmDialog.tsx` (sobre `BottomSheetModal size="sm"`; CSS em
`danger-dialog.css`). **Todo** diálogo de exclusão/ação destrutiva usa este componente
(direto ou via `showConfirm({ tone })` do `UIContext`). Regra de tom:

| tone | Quando | Visual |
|---|---|---|
| `danger` | **irreversível** (excluir, cancelar contrato, aplicar multa, remover cartão) | vermelho: ícone em círculo `--danger-bg`, borda/acento vermelho, selo "Irreversível", botão `.btn-danger-solid` |
| `warning` | **reversível**, mas com impacto (pausar, isentar multa, marcar pago, desativar gateway) | âmbar, botão `.btn-warning-solid`, sem selo |

- `confirmLabel` sempre verbo explícito ("Excluir cliente", nunca "Confirmar");
  `consequences` lista o que acontece de fato; `requireText="EXCLUIR"` para exclusões
  de alto impacto (sem diferenciar maiúsculas).
- `onConfirm` assíncrono: o diálogo aguarda com spinner e bloqueia Esc/fundo/Voltar;
  se lançar, a mensagem aparece **dentro** do diálogo (lance o erro em vez de só dar toast).
- Foco inicial no "Voltar"; botões `type="button"`; sem `<form>` (Enter no campo de
  digitação confirma só quando o texto confere).
- `showConfirm` **sem** `tone` mantém o diálogo genérico legado (fecha na hora) — só
  para confirmações neutras (renovar, retomar, enviar aviso).
- **Empilhado sobre outro sheet** (ex.: "Padrão" no `EventTemplateModal`, "Bloquear" no
  `EditClientModal`): renderize o `DangerConfirmDialog` com `zIndex={1100}` e ponha
  `preventClose` no sheet de baixo enquanto ele estiver aberto — o Esc do `BottomSheetModal`
  é global e fecharia os dois.
- Quando a lista recarrega com spinner (desmonta a tela), atualize o estado local no
  `onConfirm` em vez de recarregar, para não desmontar o diálogo no meio (ex.: Serviços).

### 3b. Padrão de wizard admin

Casca canônica do `CreateBookingModal`: `BottomSheetModal hideHeader desktopAnchor="top" floatingClose` →
`.admin-modal-head` (título + `<WizardSteps>`) → `.admin-modal-body` (erro em
`.admin-alert--danger` no topo, **sempre visível**) → blocos `{step === N && (…)}` com o
rodapé `.admin-actions-row` DENTRO de cada bloco (`btn-admin-ghost`/`btn-admin-go`).

**Altura (regra nova, out/2026)**: a etapa **abraça o conteúdo** — nada de altura mínima pela tela
(`wizardStepBodyStyle` não tem mais `minHeight`; `.ccf-step`/`.scw-step` também não), então não sobra
espaço vazio entre o conteúdo e o rodapé. Todo wizard usa `desktopAnchor="top"` no `BottomSheetModal`:
no desktop o dialog fica no topo e só o rodapé sobe/desce entre as etapas (o cabeçalho não pula). Etapa
maior que a tela rola no corpo do sheet (no Plano Personalizado e na contratação de serviço o rodapé é
sticky). O 2º clique de um clique duplo em "Próximo" que cair FORA de um sheet que encolheu é ignorado
pelo overlay (`e.detail > 1`); o que cair num botão do rodapé, por `ignoreMultiClick`. Wizards que seguem
a regra: CreateBooking, CreateClient, EditClient, CreateContract, Coupon, CustomContractFlow (admin e
cliente), ContractWizard e ServiceContractWizard.

Estado com `hooks/useWizardStep(total)` → `{ step, next, back, goTo, reset, isFirst, isLast }`.
**Regras anti-submit espúrio (obrigatórias)**:
1. Sem `<form>`; todo `<button>` com `type="button"`.
2. Keys distintas nos botões do rodapé (`key="cancel|back|next|submit"`).
3. Avançar SEMPRE com `next()` (adia 1 tick com `setTimeout 0`); `back`/`goTo` são síncronos.
4. Guard no salvar: `if (!isLast) return;` — e validar TODAS as etapas (com `allowJump`
   é possível chegar ao fim sem passar pelas anteriores); erro de campo da API → `goTo(etapa do campo)`.
5. **Nunca** trava por tempo (ignorar cliques por N ms engole o salvar legítimo).
6. Testar com clique REAL de mouse (clique sintético não reproduz o bug).

`<WizardSteps steps current onStepClick={goTo} allowJump={isEdit} />`: sem `allowJump`,
só passos concluídos são clicáveis (voltar); com `allowJump` (modo edição), qualquer
passo diferente do atual ("Ir ao passo N: …").

**Horário de contrato — `components/contracts/ContractSlotPicker`** (grade do backend via
`useContractSlotGrid`; estados carregando com `BrandLoader`, erro com "Tentar novamente", dia sem
horários; `disabledTimes` = ocupado/desabilitado). Variantes:
- `buttons` (padrão) — grade `.csp-slot` (CreateContractModal);
- `pills` — pílulas `.ccf-pill`/`.ccf-pill--active` (o MESMO visual de "Dias da semana" do Plano
  Personalizado) com o rótulo e a cor da faixa do horário (`.csp-pill__tier`); "Horário de cada dia"
  do `CustomContractFlow`, um grupo por dia (`.ccf-day-slots__group`);
- `select` — select compacto; só nas linhas das datas livres (`.ccf-date-row`).
Todos os botões `type="button"` com `aria-pressed` e `aria-label` "HH:MM – HH:MM, faixa X[, ocupado]".

## 4. Utilities admin (`admin-area.css`)

| Classe | Uso |
|---|---|
| `.admin-card` (`--lg`, `--interactive`, `--active`, `--accent`) | cards/seções |
| `.admin-kpi-grid` (`--compact`) | grid de KPIs auto-fit |
| `.admin-grid-2` / `.admin-grid-3` | grids que colapsam no mobile |
| `.admin-table--cards` + `data-label` em cada `<td>` | tabela→cards <768px |
| `.admin-field` + `.admin-field__label` | campo empilhado com label uppercase |
| `.admin-form-row` | campos lado a lado com wrap automático |
| `.admin-filter-bar` (+`__search`) | barra de busca/filtros da página |
| `.admin-pills` + `.admin-pill(--active)` | pills de filtro/segmento |
| `.admin-actions-row` | rodapé de ações (column-reverse + full-width ≤640px) |
| `.btn-admin-go` / `.btn-admin-ghost` | CTA primário / secundário (≥44px) |
| `.admin-icon-btn` (`--danger`) | ação ícone-só com touch target garantido |
| `.admin-status-select` | select compacto de status em linha de tabela |
| `.admin-alert--danger/--warning` | erro/aviso inline em modal |
| `.admin-modal-head/body/foot`, `.admin-modal-title(+__icon)` | estrutura de modal |
| `.admin-save-bar` (`--stacked`) | barra flutuante de salvar |
| `.admin-hover-bg` | hover de linha sem JS |
| `.admin-wizard-steps` (via componente `WizardSteps`) | passos de wizard (dots + conector, aria-current) |
| `.admin-section-header` (via componente `SectionHeader`) | cabeçalho numerado de seção de form |
| `.admin-avatar` (`--sm/--lg`) | círculo de iniciais (gradiente por tier segue inline) |
| `.admin-input-icon` | ícone lucide dentro de input (padding-left 36px) |
| `.admin-empty` (`__icon/__title/__hint` + CTA opcional) | empty state padrão |
| `.dash-kpi-grid/.dash-kpi-card`, `.dash-card-head` | dashboard (Centro de Comando) |

Componentes compartilhados do admin (`components/admin/`): `AdminPageHeader`,
`WizardSteps`, `SectionHeader`, `ChargeNowSheet` (sheet de cobrança imediata —
embrulha o InlineCheckout; nunca alterar as props repassadas a ele).

Regra: **inline style só para valor verdadeiramente dinâmico** (cor vinda de
adminMeta, width %). Estrutura repetida = classe.

## 4b. Componentes base (`components/ui/`, compartilhados admin + cliente)

- **`Tooltip`** (`ui/Tooltip.tsx`, CSS `tooltip.css`): `<Tooltip content placement?
  ('top'|'bottom'|'left'|'right') disabled? delay?=250 describe?=true>{um elemento focável}</Tooltip>`.
  Bolha em portal no `<body>` com `position: fixed` (não é cortada por `overflow`),
  inverte/limita às bordas, z-index `--z-tooltip` (10100: acima de TUDO, inclusive dos modais
  empilhados com `zIndex` 1100/10000 e do `VideoModal`). Abre no hover de mouse/caneta e no foco
  por **navegação de teclado** (Tab/setas + `:focus-visible`); **nunca no toque** nem em foco
  programático (o foco inicial de um modal caindo no "Fechar", o foco devolvido ao fechar).
  O `useFocusTrap` marca esses dois focos com `focusProgrammatically(el)` (`utils/focus.ts`) e o
  Tooltip consulta `isProgrammaticFocus()` — vale mesmo quando a última tecla foi Tab/seta (modal
  aberto por blur ou de forma assíncrona). O wrap do Tab/Shift+Tab dentro do trap é navegação do
  usuário e continua abrindo a dica. Foco por script em gatilho com Tooltip fora do trap: use
  `focusProgrammatically`.
  Fecha em pointerdown, Escape (só a dica — o modal por trás não fecha), scroll e resize.
  Compõe os handlers do filho (o filho precisa repassar `onPointer*`/`onFocus`/`onBlur`
  ao DOM). `describe={false}` quando o `aria-label` do gatilho já diz o mesmo.
  Substitui `title=` nativo e tooltips feitos só com CSS.
  **Regra E7**: todo botão/link de ação cujo conteúdo visível é só ícone (ou só um símbolo como
  × − +) leva `aria-label` específico em português + `<Tooltip>` com texto curto ("Editar cupom",
  "Mês anterior"); `title=` nativo não é usado em ação (nem em botão com texto — a dica extra também
  vai em `<Tooltip>`; ex.: os links "Abrir perfil de X" do admin, com o nome no conteúdo porque a
  dica também revela o nome cortado por reticências). O que ainda usa `title=`: elementos só
  informativos (células da grade da agenda, selos, o código PIX) e dois gatilhos conhecidos — o
  segmento de ambiente bloqueado de `IntegrationHelpers` (botão `disabled`; precisaria do `<span>` em
  volta) e o Avatar clicável de `MyProfilePage` (o `Avatar` não repassa `onPointer*`/`onFocus`).
  Botão que pode ficar `disabled` não dispara eventos de ponteiro: o Tooltip vai
  num `<span style={{ display: 'inline-flex' }}>` em volta (ex.: `fields/StepperField`), e o botão
  `:disabled` leva `pointer-events: none` no CSS para o `<span>` receber o ponteiro em todo navegador
  (ex.: `.ccf-cal__navbtn`, `.ccf-stepper__btn`, `.ccf-accept-btn` em `custom-contract-flow.css`). Não se
  aplica a controles só de toque (hambúrguer da landing, `BottomTabBar`) nem a switches.
  Anti-regressão: `npm run check:tooltips` (em `frontend/`; `scripts/check-icon-buttons.cjs` varre
  os `.tsx` e sai com código 1 se houver gatilho só-ícone fora de `<Tooltip>`; exceções comentadas
  no próprio script). Gatilho = `<button>`, `<a>`, `<Link>`, `<NavLink>`, `<motion.button>`,
  `<motion.a>` e qualquer elemento com `role="button"`; "só-ícone" inclui emoji/símbolo curto e
  expressão com nome de ícone (`{icon}`, `{cfg.icon}`); `<Tooltip>` sem `content` (ou com
  `null`/`''` literal) não conta. Não verifica `div`/`span` com `onClick` sem `role="button"` nem
  `title=` em botão com texto. Não roda no build (é manual). Autoteste do verificador:
  `node scripts/check-icon-buttons.cjs scripts/__fixtures__` tem de sair com código 1 listando os
  7 casos da fixture.
- **`BrandLoader`** (`ui/BrandLoader.tsx`, CSS `brand-loader.css`): o **loading de marca** — o microfone
  com os círculos girando (o mesmo visual da troca de página; o `PageTransitionLoader` é só o overlay
  fixo + barra de progresso em volta dele). `<BrandLoader size? ('page'|'section'|'compact'|'inline') label?
  labelHidden? className? />`:
  - `page` (marca 80px, bloco alto) — a tela inteira esperando: o boot do app e a checagem de
    sessão em `App.tsx` (`FullScreenLoader`, centralizado na janela, ainda sem Topbar/Sidebar) e o
    overlay de troca de página;
  - `section` (64px, padrão) — um bloco/seção (seções de Configurações, agenda de Hoje, eventos de notificação);
  - `compact` (40px, **sem** `min-height` nem padding próprios; o `label` fica logo abaixo da marca e faz
    as vezes de título) — telas de "processando" dentro de modal/wizard, onde o container já tem o seu
    espaçamento: "Criando o contrato…" (`CustomContractFlow`), "Gerando pagamento…" (`ContractWizard`),
    "Processando seu agendamento…" (`BookingModal`), "Salvando o cartão e ativando…" (`SubscribeModal`).
    Um texto de apoio ("Aguarde um instante.") vai num `<p>` logo depois, fora do loader;
  - `inline` (22px, sem brilho/anéis) — ao lado de um texto: "Atualizando…" em recarga silenciosa, bloco
    pequeno que chega depois da página (histórico de taxas, pagamento no perfil do cliente).
  `role="status"` + `aria-live="polite"`; sem `label`, "Carregando…" vai só para o leitor de tela
  (`labelHidden` esconde um rótulo próprio). Em `prefers-reduced-motion` a marca fica parada. Dois
  `section` vizinhos mostram uma marca só. `LoadingSpinner` virou atalho de `<BrandLoader size="section">`.
  **Quando usar (E5)**: só onde não há esqueleto com a forma do conteúdo — no lugar do anel genérico
  `.spinner`/`.loading-spinner` ou de um carregamento sem aviso. **Esqueletos (`SkeletonLoader`) ficam**
  e botões em andamento ("Salvando…") continuam com o spinner pequeno. Nunca dentro do
  `DangerConfirmDialog` (tem spinner próprio) nem como overlay dentro de modal.
- **`DangerConfirmDialog`**: ver §3a.
- **`StatusBadge`** (`.status-badge`, `index.css`): o selo tem a largura do conteúdo
  (`width: fit-content`) — não estica quando é item de flex em coluna ou de grid — e nunca passa do espaço
  disponível (`max-width: 100%`, `overflow: clip`): o texto fica em `.status-badge__text` e ganha reticências
  dentro da pílula, com o texto inteiro num `title` no hover só quando foi cortado. Quem usa a classe
  `.status-badge` direto põe o texto em `.status-badge__text`. Pai flex de um selo precisa de `min-width: 0`
  (senão cresce até o texto inteiro). Selos lado a lado em card estreito: `.admin-badge-row` /
  `.admin-badge-row__group` (`admin-area.css`) — quebram linha e o status desce para a linha de baixo.
- **Sino de notificações** (`NotificationBell`, só no `Topbar`): o selo de não lidas (`.notif-badge`) fica
  sobreposto ao canto superior direito do ícone (`.notif-bell__icon`, anel na cor `--bg-primary`), mostra
  `99+` acima de 99 e é `aria-hidden` (a contagem exata está no `aria-label` e no Tooltip).
- **`fields/CurrencyInput`**: ver §2.
- **`PixQrCode`** (`components/PixQrCode.tsx`, CSS `pix-qrcode.css` + classes
  `.checkout-*` de `checkout.css`): bloco PIX presentacional — valor, QR (usa
  `qrCodeDataUrl` do backend ou gera localmente com `qrcode`), contagem "Expira em mm:ss"
  (`useCountdown`, cores canônicas dos timers), copia-e-cola com feedback e, ao expirar,
  "QR expirado" + "Gerar novo QR" (`onRegenerate`). Sem imagem possível → orientação
  para usar o copia-e-cola (nunca spinner eterno). Não chama API nem faz polling.

## 4c. Navegação (Sidebar + barra inferior)

Fonte única: `config/nav.ts` (`CLIENT_NAV`/`ADMIN_NAV`). Página nova = UMA entrada lá.
Página nova da equipe = também UMA entrada em `STAFF_ROUTE_ACCESS` (`perm: [...]` = qualquer uma
destas chaves; `adminOnly: true` = só o ADMIN), espalhada no item do menu e usada pelo `StaffRoute`
da rota: o menu da equipe é `filterNav(ADMIN_NAV, can, isAdmin)` (itens e subitens; o pai some sem
filho liberado). Subitem de Configurações = `settingsSub(sec, label)`, com a permissão da seção e o
rótulo igual ao `STAFF_SETTINGS_SECTIONS` do backend (o `eq-permissions-sync` confere).

- **Sidebar recolhida** (desktop, Ctrl+B): cada item (inclusive o expansível
  Configurações e o bloco do usuário) usa `<Tooltip placement="right"
  disabled={!collapsed} describe={false}>` + `aria-label` quando recolhida. Não recriar
  tooltip em CSS dentro da `.sidebar-nav` (o `overflow` corta).
- **Barra inferior** (mobile ≤768px, `BottomTabBar`): **no máximo 5 slots iguais**
  (`MOBILE_BAR_SLOTS`, `flex: 1 1 0`), **sem rolagem horizontal nem setas**. Lista com até
  5 itens (cliente) → todos na barra. Lista maior (admin) → só os itens `mobilePrimary: true`
  (máx. 4: Início, Agenda, Hoje, Sessões) + aba **"Mais"**, que abre um `BottomSheetModal`
  com o excedente agrupado por `section` (item ativo destacado; fecha ao navegar). Item novo
  sem `mobilePrimary` cai sozinho no "Mais". Rótulo da barra = `shortLabel ?? label`
  (curto: slot de ~72px a 360px). Colaborador com menos de 4 `mobilePrimary` liberados:
  `splitMobileNav` completa as vagas com os próximos itens do menu filtrado.
- **Rótulo do usuário** (Sidebar e barra): "Administrador", o cargo do colaborador (ou
  "Colaborador") ou "Cliente" — `roleLabelOf(user)` de `hooks/usePermission.ts`.
- Item ativo = rota exata **ou aninhada** (`isNavItemActive`: `/admin/contracts/:id` ativa
  Contratos; na barra, a aba "Mais" fica ativa quando a rota pertence ao excedente).
- Contrato: manter a classe `.bottom-tab-bar-wrap` e a altura de 64px (`--bottom-tab-h`) —
  o `BottomSheetModal` mede o wrap para abrir acima da barra, e a save bar/banner PWA se
  posicionam por essa altura. Tooltip não aparece no toque (barra não usa Tooltip).

## 4d. Permissões na interface (equipe)

Regras de negócio em [permissoes-equipe.md](permissoes-equipe.md). Esconder na tela é conforto:
quem protege é o servidor (403 `PERMISSION_DENIED`).

- **Guardas de rota** (`App.tsx`): `ProtectedRoute` (logado) envolve `StaffRoute
  access={STAFF_ROUTE_ACCESS['/admin/x']}` (equipe; cliente volta ao Painel sem aviso, equipe sem a
  chave volta com o toast "Você não tem acesso a essa área. Voltamos para o painel."), `ClientRoute`
  (`/minhas-gravacoes`, `/meus-*`), `CalendarRoute` (`/calendar`) e `SettingsSectionGuard` (`?sec=`
  de Configurações). O aviso sai por `RedirectWithNotice` (efeito, nunca no render). Nunca checar
  `role === 'ADMIN'` para "é equipe": use `isStaff`; para "é cliente", `role === 'CLIENTE'`.
- **No componente**: `const { can, canAny, canAll, isAdmin, isStaff, isClient, roleLabel } =
  usePermission()` (`hooks/usePermission.ts`) ou `<Can perm|anyOf|allOf|adminOnly|staffOnly
  fallback>` (`components/auth/Can.tsx`). Chaves tipadas por `constants/permissions.ts` (união das
  chaves do backend, sem rótulos — os rótulos vêm do `GET /api/staff/catalog`).
- **Esconder × desabilitar**: ação sem a chave some (botão, coluna "Ações" inteira quando não sobra
  nenhuma, link do nome do cliente vira texto sem `clientes.ver`). Quando esconder confundiria
  (opção de um grupo, campo de um formulário que a pessoa vê), fica **desabilitado com `<Tooltip>`
  dizendo a permissão** (padrão do botão `disabled`: Tooltip num `<span style={{ display:
  'inline-flex' }}>`), ou só leitura com uma nota curta ("Somente leitura: …"). Ex.: "Confirmado" no
  Novo agendamento sem `cobrancas.baixa`; opções de status do `EditBookingModal` e do status inline
  filtradas pelo espelho `bookingPermissions.ts`; campos travados do Editar contrato (opacidade
  inline, porque `.form-input:disabled` ainda não tem estilo global).
- **Cargas condicionais**: a tela só pede o que a pessoa pode ler (um 403 não pode derrubar a
  tela): `Promise.allSettled`/cargas independentes por permissão, como no Painel.
- **Estados vazios do Painel**: sem nenhuma permissão, "Seu acesso ainda não tem módulos
  liberados." + "Fale com o administrador."; com permissões que não abrem tela, "Suas permissões
  atuais não abrem nenhuma tela."; com telas mas sem bloco do painel, "O painel não tem blocos para
  o seu acesso" com atalhos.
- **Tela Equipe** (`pages/AdminTeamPage.tsx`, `components/admin/team/*`): CSS em
  `styles/team.css` (só tokens, sem hex; importado pela página e pelos componentes da equipe).
  Selos de tipo e situação em `constants/adminMeta.ts`: `STAFF_ROLE_META` (ADMIN "Administrador",
  âmbar, `ShieldCheck`; COLABORADOR "Colaborador", teal, `UserCog`) e `STAFF_STATUS_META` (Ativo;
  Desativado em cinza). O `TeamMemberModal` segue o padrão de wizard (§3b) e a etapa Permissões
  mostra, por módulo, só os níveis **distintos** do catálogo (vazio ou repetido some; Cobranças =
  "Cobrar o cliente"/"Tudo"; Avisos = "Tudo") + "Personalizado" quando as caixas não batem;
  dependência travada = caixa desabilitada com o motivo; exclusivas do admin em cinza; selos com a
  dica no `title` (informativo, §4b).

## 5. Animação

- **Somente `transform` e `opacity`** em animações (+ `color`/`border-color` em
  transitions de estado). Proibido `transition: all` e animar
  `width`/`height`/`max-height`/`box-shadow`.
- Durações: `--transition-fast` (100ms) micro-feedback, `--transition-base`
  (200ms) hover/fade, `--transition-slow` (350ms) entrada de modal. Teto: 350ms.
- Keyframes canônicos: `fade-in`, `rise-in` (index.css). Efeito "pulso/ripple":
  `today-ripple` (::after com scale/opacity). **Não injetar `<style>` via JS.**
- Reduced-motion: catch-all global cobre tudo em stylesheet (mais um motivo para
  não animar via JS). Nenhuma informação pode depender só de animação.
- framer-motion: exclusivo do BottomSheetModal. GSAP: não usar (removido).
- Hover só sob `@media (hover: hover)`; feedback de toque via `:active`.

## 5b. Ícones

**Emoji como ícone estrutural é proibido no admin** (botões, títulos de seção,
labels, badges de estado). Usar lucide-react, com `aria-hidden` quando decorativo.
Tamanhos: 13px (label de campo), 14-16px (botão/badge), 16-18px (ícone-só/título
de seção/KPI), 40-48px (empty state, com opacity .35 via `.admin-empty__icon`).

Mapa canônico (emoji → lucide): 🏁 `Flag` · ❌ `XCircle` · ✏️ `Pencil` · 🗑️ `Trash2` ·
limpar filtro `FilterX` · 📋 `ClipboardCheck` · 🚨/⚠️/🟠 `AlertTriangle` · 🔴 `AlertCircle`
(ou `Radio` p/ ao-vivo) · 🟡 `Clock` · 📈 `TrendingUp` · 🔜 `CalendarClock` · ✅ `CheckCircle2` ·
✓ `Check` · 🎯 `Target` · 📅 `CalendarDays` · 🏖️/😴 `Moon` · 📭 `Inbox` · 🔎 `Search` ·
🎟️ `TicketPercent` · 💰 `Wallet` (`CircleDollarSign` p/ multa) · 🆓 `HandCoins` · 🚫 `Ban` ·
🔄 `RefreshCw` · ⏸️/▶️ `Pause`/`Play` · 📂 `FolderOpen` · 💾 `Save` · ➕ `Plus` · 📄 `FileText` ·
📌 `Pin` · ⚡ `Zap` · ✨ `Sparkles` (`Wand2` p/ CUSTOM) · 💳 `CreditCard` · 👤 `UserRound` ·
👥 `Users` · 👋 `UserMinus` · 🧩 `Puzzle` · 🔗 `Link2` · 🔒 `Lock` · ⏰ `Clock` · 🏦 `Landmark` ·
🏢🎤🌟 **`TIER_META[tier].icon`** (nunca redeclarar TIER_EMOJI) · 📊 `BarChart3` · 👁️ `Eye` ·
💬 `MessageCircle` · 🌎 `Globe` · 🏆 `Trophy` · 📥 `Download` · ✂️ `Scissors` · ✉️ `Mail` ·
📝 `NotebookPen` · 🪪 `IdCard` · 📱 `Smartphone` · ⏳ em CTAs → remover (texto basta).

**Ficam como emoji**: toasts e texto corrido, 🥇🥈🥉 do ranking, dados vindos da
API/config (paymentMethods `emoji`, ícones de serviço/`EmojiField`).

## 6. Acessibilidade (mínimo por página)

- Todo clicável é `<button>`/`<a>` (ou `role="button"` + `tabIndex` + Enter/Espaço).
- Botão ícone-só → `aria-label`. Touch target ≥44px no mobile.
- Botão ícone-só → `aria-label` **+ `<Tooltip>`** (dica visível no desktop/teclado; no
  toque ela não aparece, então o ícone precisa ser reconhecível no contexto). Regra completa (E7)
  e o verificador `npm run check:tooltips` em §4b.
- Ação destrutiva → `DangerConfirmDialog` com o tom certo (§3a).
- `:focus-visible` visível (as utilities novas já trazem outline `--accent-text`).
- Erro de form → `role="alert"` (`.admin-alert--danger`).

## 7. Checklist dos loops por página

1. Zero hex/rgba hardcoded no `.tsx` (tokens ou adminMeta)
2. Zero indigo/violet
3. Sem `<style>` injetado via JS
4. Animações só transform/opacity, 150–300ms, reduced-motion ok
5. Hover/focus 100% CSS (nada de onMouseEnter para estilo)
6. Clicáveis semânticos + teclado
7. `aria-label` + `<Tooltip>` em ícone-só (`npm run check:tooltips` limpo); dialog com título anunciado
8. Touch ≥44px no mobile
9. 375px sem scroll horizontal (tabelas `admin-table--cards`)
10. Loading inicial: skeleton quando a tela tem forma conhecida (herói/tabela); sem skeleton → `BrandLoader` (§4b), nunca o anel genérico nem tela vazia
11. Empty state em lista filtrável
12. Modais com `size` correto, sem `maxWidth` mágico
13. Console limpo em 375/768/1440
14. Diff só de apresentação (zero mudança em hooks/API/payloads)

## 7b. Relatórios exportados (CSV)

Hoje só existe **CSV** (decisão E6: sem PDF/XLSX e sem biblioteca nova). O texto do arquivo sai de uma
função **pura** em `frontend/src/utils/reportCsv.ts` (`buildReportCsv(input)` + `reportCsvFileName(from, to)`);
a tela só busca os dados e entrega o Blob. Padrão de todo CSV do sistema (Excel pt-BR):

- **BOM UTF-8** + separador **`;`** + quebra **CRLF**. Não usar a linha `sep=;` (faz o Excel ignorar o BOM).
- Campo com `;`, aspas, quebra de linha ou espaço nas pontas vai entre aspas, com as aspas internas
  duplicadas (`csvCell`). Texto livre do usuário (nome de cliente) passa por `csvText`: se começar com
  `= + - @` TAB ou CR, ganha um apóstrofo (o Excel não executa como fórmula).
- **Cabeçalho informativo**, uma informação por linha: estúdio · título · `Período;dd/mm/aaaa a dd/mm/aaaa;<filtro>` ·
  `Gerado em;dd/mm/aaaa hh:mm (horário de Brasília)`.
- **Uma seção por bloco**: linha em branco, título em linha própria (MAIÚSCULAS), cabeçalho de colunas,
  linhas e uma linha `TOTAL`. Nunca chave crua (faixa = "Audiência", não `AUDIENCIA`).
- Moeda `R$ 1.234,56` (espaço comum — `csvMoney`, centavos na entrada), percentual `85%`, contagem sem
  separador de milhar, datas `dd/mm/aaaa` (`csvDate`), "sem valor" = `—`.
- Nome do arquivo com o período real: `relatorio-estudio_AAAA-MM-DD_a_AAAA-MM-DD.csv`.
- Verificação por script (a função é pura): `npx tsx` num arquivo que importa `reportCsv.ts`, reabre o
  texto com um parser RFC 4180 e confere BOM/CRLF, escape, totais e o ranking inteiro.

## 8. Área do Cliente (rodada 4)

A área do cliente mantém **identidade colorida própria** (decisão de produto): tom por página — violeta em Gravações/Resultados, teal em Contratos, verde/vermelho em Pagamentos e Dashboard (estado), ciano no Perfil. NÃO alinhar ao padrão neutro do admin.

### Tokens de acento (`client-area.css`, zona livre do cliente)
`--client-accent-violet #8b5cf6 · --client-accent-teal #2dd4bf · --client-accent-blue #3b82f6 · --client-accent-pink #ec4899 · --client-accent-purple #a855f7 · --client-accent-cyan #33c4e0`

### Hero do cliente
`client-hero` + `client-hero__header` (ícone + título). O icon-wrapper usa **modifiers** em vez de style inline: `--success / --danger / --violet / --teal / --cyan` (valores exatos migrados 1:1 — conferir git blame antes de alterar). Margens de `__greeting/__message` dentro do `__header` vêm do CSS (não repetir `style={{margin}}`).

### Hooks compartilhados
- `hooks/useIsMobile(768)` — detecção de viewport; o `BottomSheetModal` usa 640 DE PROPÓSITO (sheet vs dialog), não migrar.
- `hooks/useCountdown(deadline, onExpire)` — contagem regressiva 1s com `onExpire` em ref (o interval NÃO recicla quando o caller passa arrow function nova). Usado por HoldCountdownCell, PendingPaymentCard, AwaitingPaymentBanner e HoldBanner. Cores canônicas dos timers: `--danger` (≤60s), `--warning` (≤180s), `--warning-strong`/`--success` (calmo).

- `hooks/useDragScroll()` — arraste com o mouse em trilhas horizontais (galeria de pôsteres, trilho de
  Configurações) + visibilidade das setas. A classe `is-dragging` (que deixa os cards inertes) só entra
  em arraste REAL (> 4px), nunca no mousedown — senão o clique simples não abre o card.

### Utilitários compartilhados (lote 2)
- **Boleto (E3)** — `constants/paymentMethods.ts`: `isBoletoAvailable()` é a fonte única de "o boleto pode
  ser oferecido" (chave-mestra das Configurações + Cora ativa) e `usePaymentMethodsVersion()` re-renderiza a
  tela quando esse cache muda. No `InlineCheckout`, a aba só existe com `offerBoleto` (cobrança do admin ou
  fatura/parcela de contrato já ativo; padrão `false` = fluxos com reserva de 10 minutos) **e**
  `isBoletoAvailable()`. `allowBoleto` é ignorado.
- **Gravação (E11/E12)** — `utils/recording.ts`: `isRecordingLive(b)` (= `isRecordingNow` do backend) é o
  ÚNICO critério do selo "AO VIVO"; `wasLivestreamed` vira só o selo discreto "Transmitida ao vivo";
  `useRecordingWatch` recarrega enquanto há sessão de hoje em aberto; `summarizeRecording` monta as métricas.
- **Cobranças do contrato (E13)** — `utils/paymentLabels.ts`: `chargeLabel`/`installmentPositions`
  ("Parcela N/Total" sem contar multa, extras e anuladas), `fineLabel`, `isCancellationFine`,
  `isBlockedByPendingCancellation`, `isFineOverdue`. Meus Contratos e Meus Pagamentos usam os mesmos.
- **Datas com fuso** — `utils/format.ts`: `formatDate(date, timeZone = 'UTC')`. O padrão `'UTC'` é para datas-calendário (gravadas como 00:00Z); um INSTANTE real pede `'America/Sao_Paulo'`. O vencimento da multa de cancelamento é um instante (a decisão do estúdio): use `formatDate(p.dueDate, dueDateTimeZone(p))` (`utils/paymentLabels.ts` → São Paulo na multa, UTC nas demais), o mesmo calendário de `isFineOverdue` — assim Meus Pagamentos, o Início (`dueDateTimeZone`) e Meus Contratos (`formatInstantDate`, também São Paulo) mostram a mesma data.
- **Abrir uma gravação em `/minhas-gravacoes`** — `navigate('/minhas-gravacoes', { state: { openBookingId: id } })` (cards e aviso "Remarcar" do Início): `MyBookingsPage` espera a lista carregar, abre o `BookingDetailModal` dessa gravação **uma vez** e limpa o `state` (`navigate(pathname, { replace: true, state: null })`), para não reabrir ao voltar/recarregar. Id que não está na lista do cliente → só limpa o state, sem erro.

### Agenda (compartilhada admin+cliente)
`CalendarPage` é orquestrador (estado/fetch/modais); o DOM vive em `components/calendar/CalendarMobileView` e `CalendarDesktopView`; constantes em `calendarShared.ts` (DAYS/TIER_COLORS/GRID_ROWS). Slots passados = "Encerrado"; bloqueados pelo estúdio = "Bloqueado"; ocupados = "Ocupado". Estilos novos da grade vão ADITIVOS em `index.css` (nunca em admin-area.css).

### ErrorBoundary
Dois níveis (página no Layout + AppRoutes). Crash de render mostra fallback pt-BR com "Recarregar" em vez de tela branca.

### Exceções documentadas (NÃO migrar para tokens)
- `TIER_COLORS` (calendarShared): paleta vívida da grade escura, compartilhada com o admin — difere dos `--tier-*` de propósito.
- Hex do **recharts** (ResultsChart): `var()` não é confiável em presentation attribute SVG passado como prop.
- **Cores de marca** de plataformas (YouTube/TikTok/Instagram/Facebook): são dados, não tema.
- `SEVERITY_META` do NotificationBell (`#dc2626/#d97706/#3b82f6`): red-600 não tem token equivalente (--danger é red-500).
- Estilos **dinâmicos** (width % de progresso, background de avatar com foto) ficam inline.

### Rotas
URLs do cliente em português: `/minhas-gravacoes`, `/meus-contratos`, `/meus-pagamentos`, `/meus-resultados`, `/perfil`, `/calendar`, `/dashboard`. As antigas `/my-bookings` e `/my-contracts` são redirects permanentes em App.tsx — NÃO remover (bookmarks/PWA/notificações persistidas).
