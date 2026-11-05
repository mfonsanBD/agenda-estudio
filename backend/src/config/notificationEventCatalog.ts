// ─── Notification Event Catalog ─────────────────────────
// SINGLE source of truth for every notification EVENT the system can emit:
// default title/message (NO emoji — the frontend renders a lucide icon per
// type), severity, push default, actionUrl and the interpolation variables.
// Consumed by:
//   - modules/notifications/templateStore.ts (merges DB overrides over defaults)
//   - notifyEvent() (persisted call sites) + routes.ts computed rules
//   - admin API (GET events) + admin UI (edit templates)
// The admin edits only OVERRIDES (notification_templates table); defaults here
// keep propagating unless explicitly overridden.

import { NotificationType } from '../generated/prisma/client.js';

export interface NotificationEventVariable {
    name: string;    // used as {name} in title/message
    label: string;   // PT label for the admin UI chip
    example: string; // sample value for preview + test send
}

export interface NotificationEventDef {
    eventKey: string;
    label: string;
    description: string;
    group: 'pagamentos' | 'sessoes' | 'contratos' | 'creditos' | 'admin';
    audience: 'client' | 'admin';
    kind: 'persisted' | 'computed';
    type: NotificationType;
    // 'dynamic' = severity is decided by the caller at runtime (an admin override
    // to a fixed value flattens it — the UI labels a null override as "automática").
    severity: 'critical' | 'warning' | 'info' | 'dynamic';
    pushDefault: boolean;
    actionUrl: string;
    defaultTitle: string;
    defaultMessage: string;
    variables: NotificationEventVariable[];
}

const V = {
    valor: { name: 'valor', label: 'Valor', example: 'R$ 250,00' },
    hora: { name: 'hora', label: 'Hora', example: '20:30' },
    data: { name: 'data', label: 'Data', example: '12/07' },
    // Rótulo do dia no fuso SP (spDayLabel). O valor real depende do evento, então cada evento que usa
    // diaLabel sobrescreve o exemplo (Prévia/Enviar teste do admin): 24h → 'amanhã (16/09)', 2h → 'hoje (16/09)'.
    diaLabel: { name: 'diaLabel', label: 'Dia (rótulo)', example: 'hoje (16/09)' },
    contrato: { name: 'contrato', label: 'Nome do contrato', example: 'Plano Fixo 3 meses' },
    servico: { name: 'servico', label: 'Nome do serviço', example: 'Gestão de Redes Sociais' },
    quantidade: { name: 'quantidade', label: 'Quantidade', example: '2' },
    restantes: { name: 'restantes', label: 'Créditos restantes', example: '3' },
    dias: { name: 'dias', label: 'Dias', example: '3' },
    total: { name: 'total', label: 'Total (R$)', example: 'R$ 480,00' },
    diasMax: { name: 'diasMax', label: 'Dias em atraso (máx.)', example: '12' },
    cliente: { name: 'cliente', label: 'Nome do cliente', example: 'Maria Silva' },
    // Remarcação do avulso (D4/D5): último dia da janela e a nova data escolhida.
    prazo: { name: 'prazo', label: 'Prazo para remarcar (DD/MM)', example: '22/09' },
    novaData: { name: 'novaData', label: 'Nova data (DD/MM)', example: '19/09' },
    // Multa de cancelamento (E13): % aplicado e base (o que faltava pagar do plano no pedido).
    percentual: { name: 'percentual', label: 'Percentual da multa', example: '20' },
    base: { name: 'base', label: 'Saldo a pagar do plano (R$)', example: 'R$ 1.680,00' },
    // Cobrança em dobro no cartão (Z1-c): o PaymentIntent que deu a baixa e o excedente (a estornar).
    piPago: { name: 'piPago', label: 'PaymentIntent que deu a baixa', example: 'pi_3QxA…baixa' },
    piExtra: { name: 'piExtra', label: 'PaymentIntent a estornar', example: 'pi_3QxB…extra' },
} as const;

export const NOTIFICATION_EVENT_CATALOG: NotificationEventDef[] = [
    // ── Pagamentos (cliente) ──────────────────────────────
    {
        eventKey: 'payment_confirmed', label: 'Pagamento confirmado',
        description: 'Enviada quando um pagamento do cliente é confirmado (PIX, boleto ou cartão).',
        group: 'pagamentos', audience: 'client', kind: 'persisted',
        type: 'PAYMENT_CONFIRMED', severity: 'info', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Pagamento confirmado',
        defaultMessage: 'Seu pagamento de {valor} foi confirmado!',
        variables: [V.valor],
    },
    {
        eventKey: 'payment_failed', label: 'Pagamento recusado',
        description: 'Enviada quando um pagamento é recusado (webhook do provedor).',
        group: 'pagamentos', audience: 'client', kind: 'persisted',
        type: 'PAYMENT_FAILED', severity: 'critical', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Pagamento não concluído',
        defaultMessage: 'Seu pagamento foi recusado. Tente novamente em Meus Pagamentos.',
        variables: [],
    },
    {
        eventKey: 'payment_expired', label: 'Cobrança expirada',
        description: 'Enviada quando um PIX ou boleto é cancelado ou expira antes do pagamento.',
        group: 'pagamentos', audience: 'client', kind: 'persisted',
        type: 'PAYMENT_FAILED', severity: 'critical', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Cobrança expirada',
        // Sem citar a forma de pagamento: com o boleto desligado (E3) ele não aparece em lugar nenhum.
        defaultMessage: 'Sua cobrança foi cancelada ou expirou. Gere uma nova em Meus Pagamentos.',
        variables: [],
    },
    {
        eventKey: 'auto_charge_authentication', label: 'Cobrança automática — autenticação',
        description: 'Cobrança automática exige autenticação do banco (3DS).',
        group: 'pagamentos', audience: 'client', kind: 'persisted',
        type: 'PAYMENT_FAILED', severity: 'warning', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Cobrança automática requer sua confirmação',
        defaultMessage: 'Seu banco pediu autenticação para a cobrança automática. Pague manualmente na aba Pagamentos para concluir.',
        variables: [],
    },
    {
        eventKey: 'auto_charge_failed', label: 'Cobrança automática — falha',
        description: 'A cobrança automática no cartão salvo não foi concluída.',
        group: 'pagamentos', audience: 'client', kind: 'persisted',
        type: 'PAYMENT_FAILED', severity: 'critical', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Cobrança automática não concluída',
        defaultMessage: 'Não conseguimos cobrar sua parcela no cartão cadastrado. Pague manualmente na aba Pagamentos ou atualize seu cartão.',
        variables: [],
    },
    // ── Sessões (cliente) ─────────────────────────────────
    {
        eventKey: 'booking_reminder_24h', label: 'Lembrete de sessão (24h antes)',
        description: 'Enviado exatamente 24 horas antes da gravação (mesmo horário, na véspera). Sessões marcadas com menos de 24h de antecedência não recebem este lembrete.',
        group: 'sessoes', audience: 'client', kind: 'persisted',
        type: 'BOOKING_REMINDER', severity: 'warning', pushDefault: true, actionUrl: '/minhas-gravacoes',
        defaultTitle: 'Sessão {diaLabel}',
        defaultMessage: 'Lembrete: você tem uma gravação {diaLabel} às {hora}.',
        variables: [{ ...V.diaLabel, example: 'amanhã (16/09)' }, V.data, V.hora],
    },
    {
        eventKey: 'booking_reminder_2h', label: 'Lembrete de sessão (2h antes)',
        description: 'Enviado exatamente 2 horas antes da gravação.',
        group: 'sessoes', audience: 'client', kind: 'persisted',
        type: 'BOOKING_REMINDER', severity: 'critical', pushDefault: true, actionUrl: '/minhas-gravacoes',
        defaultTitle: 'Sessão em 2 horas',
        defaultMessage: 'Sua gravação é {diaLabel} às {hora} — prepare-se!',
        variables: [{ ...V.diaLabel, example: 'hoje (16/09)' }, V.hora],
    },
    {
        eventKey: 'daily_confirmation_paid', label: 'Confirmação do dia (paga)',
        description: 'Aviso matinal (7h) confirmando a gravação do dia já paga.',
        group: 'sessoes', audience: 'client', kind: 'persisted',
        type: 'BOOKING_CONFIRMED', severity: 'info', pushDefault: true, actionUrl: '/minhas-gravacoes',
        defaultTitle: 'Gravação confirmada',
        defaultMessage: 'Sua gravação de hoje às {hora} está confirmada. Até logo!',
        variables: [V.hora],
    },
    {
        eventKey: 'daily_confirmation_unpaid', label: 'Confirmação do dia (pague para confirmar)',
        description: 'Aviso matinal (7h) de gravação do dia ainda não paga.',
        group: 'sessoes', audience: 'client', kind: 'persisted',
        type: 'BOOKING_UNCONFIRMED', severity: 'warning', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Pague para confirmar',
        defaultMessage: 'Sua gravação de hoje às {hora} ainda não está paga. Pague para confirmar.',
        variables: [V.hora],
    },
    // ── Remarcação do avulso (cliente) — D4/D5 ────────────
    // Tipos NÃO efêmeros de propósito (BOOKING_CANCELLED / SYSTEM): a limpeza diária apaga os tipos
    // efêmeros (BOOKING_REMINDER, BOOKING_CONFIRMED, BOOKING_UNCONFIRMED…) em 48h, e estes avisos valem
    // pela janela inteira (7 dias) ou pedem ação do estúdio. Abertura/lembrete/expiração dividem a tag
    // de push `BOOKING_CANCELLED-<booking>`: o mais recente substitui o anterior na bandeja.
    {
        eventKey: 'avulso_makeup_opened', label: 'Remarcação liberada (avulso)',
        description: 'Enviada quando o estúdio justifica a falta de uma gravação avulsa ou marca a gravação como não realizada: o cliente pode remarcar sem novo pagamento até o prazo.',
        group: 'sessoes', audience: 'client', kind: 'persisted',
        type: 'BOOKING_CANCELLED', severity: 'critical', pushDefault: true, actionUrl: '/minhas-gravacoes',
        defaultTitle: 'Você pode remarcar sua gravação',
        defaultMessage: 'A gravação de {data} pode ser remarcada sem novo pagamento até {prazo}. Escolha o novo horário em Minhas Gravações.',
        variables: [V.data, V.prazo],
    },
    {
        eventKey: 'avulso_makeup_reminder', label: 'Lembrete de remarcação (avulso)',
        description: 'Lembrete nos 2 últimos dias da janela de remarcação sem novo pagamento (no máximo 1 por dia).',
        group: 'sessoes', audience: 'client', kind: 'persisted',
        type: 'BOOKING_CANCELLED', severity: 'critical', pushDefault: true, actionUrl: '/minhas-gravacoes',
        defaultTitle: 'Remarque sua gravação: {dias} dia(s) restante(s)',
        defaultMessage: 'A gravação de {data} pode ser remarcada sem novo pagamento até {prazo}, às 23h59. Escolha o novo horário em Minhas Gravações.',
        variables: [{ ...V.dias, example: '2' }, V.data, V.prazo],
    },
    {
        eventKey: 'avulso_makeup_expired', label: 'Prazo de remarcação encerrado — falta',
        description: 'Enviada quando termina, sem remarcação, a janela de uma falta justificada: o valor pago é perdido.',
        group: 'sessoes', audience: 'client', kind: 'persisted',
        type: 'BOOKING_CANCELLED', severity: 'critical', pushDefault: true, actionUrl: '/minhas-gravacoes',
        defaultTitle: 'Prazo de remarcação encerrado',
        defaultMessage: 'O prazo para remarcar a gravação de {data} terminou em {prazo}. Como ela não foi remarcada, o valor pago não é reembolsável.',
        variables: [V.data, V.prazo],
    },
    {
        eventKey: 'avulso_makeup_expired_studio', label: 'Prazo de remarcação encerrado — não realizada',
        description: 'Enviada quando termina, sem remarcação, a janela de uma gravação que o estúdio não realizou: o valor continua garantido e o estúdio entra em contato.',
        group: 'sessoes', audience: 'client', kind: 'persisted',
        type: 'BOOKING_CANCELLED', severity: 'critical', pushDefault: true, actionUrl: '/minhas-gravacoes',
        defaultTitle: 'Vamos combinar sua gravação',
        defaultMessage: 'O prazo para remarcar a gravação de {data} terminou em {prazo}. Seu valor continua garantido: o estúdio vai entrar em contato para combinar a nova data.',
        variables: [V.data, V.prazo],
    },
    {
        eventKey: 'avulso_makeup_rescheduled', label: 'Gravação remarcada pelo estúdio (avulso)',
        description: 'Enviada ao cliente quando o estúdio remarca a gravação avulsa perdida (falta justificada ou não realizada), sem novo pagamento. Não é enviada quando o próprio cliente remarca.',
        group: 'sessoes', audience: 'client', kind: 'persisted',
        type: 'SYSTEM', severity: 'warning', pushDefault: true, actionUrl: '/minhas-gravacoes',
        defaultTitle: 'Gravação remarcada',
        defaultMessage: 'O estúdio remarcou sua gravação de {data} para {novaData} às {hora}, sem novo pagamento.',
        variables: [V.data, V.novaData, V.hora],
    },
    // ── Créditos FLEX (cliente) ───────────────────────────
    {
        eventKey: 'flex_credit_lost', label: 'Crédito FLEX perdido',
        description: 'Enviada quando um crédito de gravação FLEX é perdido por não uso.',
        group: 'creditos', audience: 'client', kind: 'persisted',
        type: 'FLEX_CREDITS_LOW', severity: 'critical', pushDefault: true, actionUrl: '/meus-contratos',
        defaultTitle: 'Crédito de gravação perdido',
        defaultMessage: 'Você perdeu {quantidade} crédito(s) do contrato "{contrato}" por não usar a tempo. Restam {restantes}.',
        variables: [V.quantidade, V.contrato, V.restantes],
    },
    {
        eventKey: 'flex_credit_at_risk', label: 'Crédito FLEX em risco',
        description: 'Aviso de que há crédito FLEX a expirar nesta janela.',
        group: 'creditos', audience: 'client', kind: 'persisted',
        type: 'FLEX_CREDITS_LOW', severity: 'warning', pushDefault: true, actionUrl: '/meus-contratos',
        defaultTitle: 'Grave esta semana para não perder o crédito',
        defaultMessage: 'Faltam {dias} dia(s) para você usar o crédito da semana do contrato "{contrato}".',
        variables: [V.dias, V.contrato],
    },
    // ── Contratos (cliente) ───────────────────────────────
    {
        eventKey: 'contract_activated', label: 'Contrato ativado',
        description: 'Enviada quando um contrato (Fixo/Flex/Custom) é ativado.',
        group: 'contratos', audience: 'client', kind: 'persisted',
        type: 'CONTRACT_ACTIVATED', severity: 'info', pushDefault: false, actionUrl: '/meus-contratos',
        defaultTitle: 'Contrato ativado',
        defaultMessage: 'Seu contrato "{contrato}" foi ativado! Seus agendamentos já estão confirmados.',
        variables: [V.contrato],
    },
    {
        eventKey: 'service_activated', label: 'Serviço ativado',
        description: 'Enviada quando um serviço avulso (ex.: Gestão de Redes) é ativado.',
        group: 'contratos', audience: 'client', kind: 'persisted',
        type: 'CONTRACT_ACTIVATED', severity: 'info', pushDefault: false, actionUrl: '/meus-contratos',
        defaultTitle: 'Serviço ativado',
        defaultMessage: 'Seu serviço "{servico}" foi ativado com sucesso!',
        variables: [V.servico],
    },
    // ── Cancelamento do contrato (cliente) — E13 ──────────
    // Tipo CANCELLATION_PENDING (sem migration de enum; não é efêmero — fica no sino). `critical` para
    // chegar também a quem escolheu "só essenciais": é cobrança nova / fim do contrato.
    {
        eventKey: 'contract_cancellation_fine', label: 'Cancelamento concluído com multa',
        description: 'Enviada ao cliente quando o estúdio conclui o pedido de cancelamento cobrando a multa: informa o valor e leva a Meus Pagamentos.',
        group: 'contratos', audience: 'client', kind: 'persisted',
        type: 'CANCELLATION_PENDING', severity: 'critical', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Multa de cancelamento: {valor}',
        defaultMessage: 'O contrato "{contrato}" foi cancelado com multa de {valor} ({percentual}% de {base} que faltavam pagar). Pague em Meus Pagamentos.',
        variables: [V.contrato, V.valor, V.percentual, V.base],
    },
    {
        eventKey: 'contract_cancelled_no_fine', label: 'Contrato cancelado sem multa',
        description: 'Enviada ao cliente quando o contrato é cancelado sem multa: isenção do pedido de cancelamento, pedido sem saldo a pagar ou cancelamento feito pelo estúdio.',
        group: 'contratos', audience: 'client', kind: 'persisted',
        type: 'CANCELLATION_PENDING', severity: 'critical', pushDefault: true, actionUrl: '/meus-contratos',
        defaultTitle: 'Contrato cancelado',
        defaultMessage: 'O contrato "{contrato}" foi cancelado, sem multa. As parcelas que estavam pendentes foram anuladas.',
        variables: [V.contrato],
    },
    // ── Equipe (audiência "admin", persisted) ─────────────
    // Avisos da EQUIPE: vão para os administradores e para o colaborador que tem a permissão do evento
    // (STAFF_EVENT_PERMISSIONS em config/staffPermissions.ts). Por isso o rótulo é "Equipe — …" e a
    // descrição diz quem da equipe recebe, sem citar a chave (NS-5). Só o ADMIN edita estes modelos.
    {
        // Mesmo tipo + entidade do alerta computado "Cancelamento pendente": no sino aparece uma vez só
        // (a computada sombreia esta enquanto o pedido está em análise); esta existe para o PUSH imediato.
        eventKey: 'admin_cancellation_requested', label: 'Equipe — pedido de cancelamento (push)',
        description: 'Avisa os administradores e quem da equipe decide pedidos de cancelamento, na hora e com push, que um cliente pediu o cancelamento de um contrato, com a multa prevista. É removida quando o pedido é resolvido.',
        group: 'admin', audience: 'admin', kind: 'persisted',
        type: 'CANCELLATION_PENDING', severity: 'warning', pushDefault: true, actionUrl: '/admin/contracts',
        defaultTitle: 'Pedido de cancelamento',
        defaultMessage: '{cliente} pediu o cancelamento do contrato "{contrato}". Multa prevista: {valor}. Decida entre cobrar ou isentar.',
        variables: [V.cliente, V.contrato, V.valor],
    },
    {
        eventKey: 'admin_payment_on_cancelled_charge', label: 'Equipe — pagamento em cobrança cancelada',
        description: 'Avisa os administradores e quem da equipe vê o Financeiro quando o banco/cartão confirma um pagamento de uma cobrança que já estava cancelada (parcela anulada de contrato cancelado): o dinheiro entrou e precisa de estorno ou baixa manual.',
        group: 'admin', audience: 'admin', kind: 'persisted',
        type: 'SYSTEM', severity: 'critical', pushDefault: true, actionUrl: '/admin/finance',
        defaultTitle: 'Pagamento recebido em cobrança cancelada',
        defaultMessage: '{cliente} pagou {valor} em uma cobrança já cancelada do contrato "{contrato}". O valor não foi baixado: confira no extrato e estorne ou dê baixa manual.',
        variables: [V.cliente, V.valor, V.contrato],
    },
    {
        // Z1-c: rede de segurança da cobrança em dobro (cobrança automática + checkout de cartão aberto).
        eventKey: 'admin_card_double_charge', label: 'Equipe — cobrança em dobro no cartão',
        description: 'Avisa os administradores e quem da equipe vê o Financeiro quando um segundo pagamento no cartão (PaymentIntent) é aprovado para uma cobrança que já estava paga por outro — por exemplo, a cobrança automática quitou a parcela e o cliente confirmou um checkout de cartão que tinha ficado aberto. O cliente foi debitado duas vezes: o pagamento excedente precisa ser estornado no painel do Stripe.',
        group: 'admin', audience: 'admin', kind: 'persisted',
        type: 'SYSTEM', severity: 'critical', pushDefault: true, actionUrl: '/admin/finance',
        defaultTitle: 'Cobrança em dobro no cartão',
        defaultMessage: '{cliente} foi debitado duas vezes no cartão: a cobrança do contrato "{contrato}" já estava paga ({piPago}) e outro pagamento de {valor} também foi aprovado ({piExtra}). Estorne {piExtra} no painel do Stripe.',
        variables: [V.cliente, V.valor, V.contrato, V.piPago, V.piExtra],
    },
    {
        eventKey: 'admin_booking_confirmed', label: 'Equipe — sessão confirmada',
        description: 'Avisa os administradores e quem da equipe vê a operação do dia quando um cliente confirma uma sessão.',
        group: 'admin', audience: 'admin', kind: 'persisted',
        type: 'BOOKING_CONFIRMED', severity: 'info', pushDefault: false, actionUrl: '/admin/today',
        defaultTitle: 'Sessão confirmada',
        defaultMessage: '{cliente} confirmou a sessão de {data} às {hora}.',
        variables: [V.cliente, V.data, V.hora],
    },
    {
        eventKey: 'admin_booking_cancelled', label: 'Equipe — sessão cancelada',
        description: 'Avisa os administradores e quem da equipe vê a operação do dia quando um cliente cancela uma sessão.',
        group: 'admin', audience: 'admin', kind: 'persisted',
        type: 'BOOKING_CANCELLED', severity: 'warning', pushDefault: false, actionUrl: '/admin/today',
        defaultTitle: 'Sessão cancelada',
        defaultMessage: '{cliente} cancelou a sessão de {data} às {hora}.',
        variables: [V.cliente, V.data, V.hora],
    },
    {
        eventKey: 'admin_makeup_rescheduled', label: 'Equipe — gravação avulsa remarcada',
        description: 'Avisa os administradores e quem da equipe vê a operação do dia quando uma gravação avulsa perdida (falta justificada ou não realizada) é remarcada sem novo pagamento (quem remarcou não é avisado).',
        group: 'admin', audience: 'admin', kind: 'persisted',
        type: 'SYSTEM', severity: 'info', pushDefault: false, actionUrl: '/admin/today',
        defaultTitle: 'Gravação remarcada',
        defaultMessage: 'A gravação de {cliente} de {data} foi remarcada para {novaData} às {hora}.',
        variables: [V.cliente, V.data, V.novaData, V.hora],
    },
    {
        // Link padrão = lista de Agendamentos (abre com agendamentos.faltas, a permissão do evento — I3).
        // O job manda o detalhe do contrato (/admin/contracts/:id) para quem também vê contratos.
        eventKey: 'admin_makeup_expired_studio', label: 'Equipe — não realizada sem remarcação',
        description: 'Avisa os administradores e quem da equipe registra faltas quando termina a janela de uma gravação avulsa que o estúdio não realizou e o cliente não remarcou: resolver com o cliente (a equipe ainda pode remarcar).',
        group: 'admin', audience: 'admin', kind: 'persisted',
        type: 'BOOKING_CANCELLED', severity: 'critical', pushDefault: true, actionUrl: '/admin/bookings',
        defaultTitle: 'Gravação não realizada sem remarcação',
        defaultMessage: '{cliente} não remarcou a gravação de {data} (não realizada pelo estúdio) até {prazo}. Entre em contato para combinar a nova data.',
        variables: [V.cliente, V.data, V.prazo],
    },
    // ── Computed (cliente) ────────────────────────────────
    {
        eventKey: 'computed_contract_expiring', label: 'Contrato expirando',
        description: 'Alerta recorrente enquanto um contrato do cliente está perto do fim.',
        group: 'contratos', audience: 'client', kind: 'computed',
        type: 'CONTRACT_EXPIRING', severity: 'dynamic', pushDefault: true, actionUrl: '/meus-contratos',
        defaultTitle: 'Contrato expirando',
        defaultMessage: 'Seu contrato "{contrato}" expira em {dias} dia(s).',
        variables: [V.contrato, V.dias],
    },
    {
        eventKey: 'computed_payment_overdue', label: 'Faturas vencidas (agregada)',
        description: 'Resumo das faturas vencidas do cliente (uma notificação com o total).',
        group: 'pagamentos', audience: 'client', kind: 'computed',
        type: 'PAYMENT_OVERDUE', severity: 'dynamic', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Você tem faturas vencidas',
        defaultMessage: 'Você tem {quantidade} fatura(s) vencida(s) totalizando {total}.',
        variables: [V.quantidade, V.total, V.diasMax],
    },
    {
        eventKey: 'computed_payment_failed', label: 'Pagamento com cartão falhou (recorrente)',
        description: 'Alerta recorrente enquanto houver um pagamento com cartão em falha.',
        group: 'pagamentos', audience: 'client', kind: 'computed',
        type: 'PAYMENT_OVERDUE', severity: 'critical', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Pagamento com cartão falhou',
        defaultMessage: 'Seu último pagamento com cartão falhou. Atualize o cartão ou tente novamente.',
        variables: [],
    },
    {
        eventKey: 'computed_cancellation_pending', label: 'Cancelamento em análise',
        description: 'Alerta enquanto um pedido de cancelamento do cliente está em análise.',
        group: 'contratos', audience: 'client', kind: 'computed',
        type: 'CANCELLATION_PENDING', severity: 'warning', pushDefault: true, actionUrl: '/meus-contratos',
        defaultTitle: 'Cancelamento em análise',
        defaultMessage: 'Seu pedido de cancelamento do contrato "{contrato}" está em análise.',
        variables: [V.contrato],
    },
    {
        eventKey: 'computed_contract_awaiting', label: 'Contrato aguardando pagamento',
        description: 'Alerta enquanto um contrato aguarda o pagamento inicial (com prazo).',
        group: 'contratos', audience: 'client', kind: 'computed',
        type: 'CONTRACT_AWAITING_PAYMENT', severity: 'dynamic', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Contrato aguardando pagamento',
        defaultMessage: 'Seu contrato "{contrato}" aguarda o pagamento para ser ativado.',
        variables: [V.contrato],
    },
    // ── Equipe (audiência "admin", computed) ──────────────
    {
        eventKey: 'computed_contract_expiring_admin', label: 'Equipe — contrato de cliente expirando',
        description: 'Alerta para os administradores e quem da equipe vê os Contratos sobre contratos de clientes perto do fim.',
        group: 'admin', audience: 'admin', kind: 'computed',
        type: 'CONTRACT_EXPIRING', severity: 'dynamic', pushDefault: false, actionUrl: '/admin/contracts',
        defaultTitle: 'Contrato expirando',
        defaultMessage: 'O contrato "{contrato}" de {cliente} expira em {dias} dia(s).',
        variables: [V.cliente, V.contrato, V.dias],
    },
    {
        eventKey: 'computed_payment_overdue_admin', label: 'Equipe — cliente com faturas vencidas',
        description: 'Resumo por cliente das faturas vencidas (uma por cliente), para os administradores e quem da equipe vê o Financeiro.',
        group: 'admin', audience: 'admin', kind: 'computed',
        type: 'PAYMENT_OVERDUE', severity: 'dynamic', pushDefault: false, actionUrl: '/admin/finance',
        defaultTitle: 'Cliente com faturas vencidas',
        defaultMessage: '{cliente} tem {quantidade} fatura(s) vencida(s) totalizando {total}.',
        variables: [V.cliente, V.quantidade, V.total, V.diasMax],
    },
    {
        eventKey: 'computed_payment_failed_admin', label: 'Equipe — pagamento de cliente falhou',
        description: 'Alerta para os administradores e quem da equipe vê o Financeiro sobre pagamento com cartão de cliente em falha.',
        group: 'admin', audience: 'admin', kind: 'computed',
        type: 'PAYMENT_OVERDUE', severity: 'critical', pushDefault: false, actionUrl: '/admin/finance',
        defaultTitle: 'Pagamento de cliente falhou',
        defaultMessage: 'O pagamento de {valor} de {cliente} falhou.',
        variables: [V.cliente, V.valor],
    },
    {
        eventKey: 'computed_booking_unconfirmed_admin', label: 'Equipe — sessão não confirmada',
        description: 'Alerta para os administradores e quem da equipe confirma presença sobre sessão do dia ainda não confirmada.',
        group: 'admin', audience: 'admin', kind: 'computed',
        type: 'BOOKING_UNCONFIRMED', severity: 'critical', pushDefault: false, actionUrl: '/admin/today',
        defaultTitle: 'Sessão não confirmada',
        defaultMessage: '{cliente} tem uma sessão {diaLabel} às {hora} ainda não confirmada.',
        variables: [V.cliente, V.hora, { ...V.diaLabel, example: 'hoje' }], // em runtime recebe 'hoje'
    },
    {
        eventKey: 'computed_cancellation_pending_admin', label: 'Equipe — cancelamento pendente',
        description: 'Alerta para os administradores e quem da equipe decide pedidos de cancelamento sobre pedido de cancelamento a resolver.',
        group: 'admin', audience: 'admin', kind: 'computed',
        type: 'CANCELLATION_PENDING', severity: 'warning', pushDefault: false, actionUrl: '/admin/contracts',
        defaultTitle: 'Cancelamento pendente',
        defaultMessage: '{cliente} solicitou o cancelamento do contrato "{contrato}".',
        variables: [V.cliente, V.contrato],
    },
    {
        eventKey: 'computed_contract_awaiting_admin', label: 'Equipe — contrato aguardando pagamento',
        description: 'Alerta para os administradores e quem da equipe vê os Contratos sobre contrato de cliente aguardando pagamento.',
        group: 'admin', audience: 'admin', kind: 'computed',
        type: 'CONTRACT_AWAITING_PAYMENT', severity: 'dynamic', pushDefault: false, actionUrl: '/admin/contracts',
        defaultTitle: 'Contrato aguardando pagamento',
        defaultMessage: 'O contrato "{contrato}" de {cliente} aguarda pagamento.',
        variables: [V.cliente, V.contrato],
    },
];

export const NOTIFICATION_EVENT_BY_KEY: Record<string, NotificationEventDef> = Object.fromEntries(
    NOTIFICATION_EVENT_CATALOG.map(e => [e.eventKey, e]),
);

/** Extract the {placeholder} names referenced in a text. */
export function extractPlaceholders(text: string): string[] {
    return Array.from(text.matchAll(/\{(\w+)\}/g), m => m[1]!);
}
