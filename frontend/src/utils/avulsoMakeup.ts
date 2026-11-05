// ─── Remarcação do avulso (D4/D5) — helpers puros do front ───────────────
// Espelham backend/src/lib/avulsoMakeup.ts. Janela ÚNICA de remarcação sem novo pagamento até o
// fim do dia D+N no fuso de São Paulo (D = data da gravação perdida, N = `avulso_makeup_days`).
//  • FALTA justificada: só o admin concede (PATCH /bookings/:id { noShowJustified: true }).
//  • NAO_REALIZADO (culpa do estúdio): a janela abre sozinha; expirar NÃO faz perder o valor e o
//    admin pode remarcar mesmo depois do prazo.
// Datas de reserva (`date`, `missedDate`) são datas-calendário (@db.Date, 00:00Z): usar o YYYY-MM-DD
// cru. Instantes (`makeupDeadline`) são convertidos para o calendário de SP.

import type { MakeupStatus } from '../api/client';

const SP_YMD = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
});

/** "YYYY-MM-DD" (calendário de São Paulo) de um instante. */
export function spYmd(at: Date | string | number = new Date()): string {
    return SP_YMD.format(new Date(at));
}

/** "YYYY-MM-DD" de uma data-calendário vinda da API (@db.Date → '2026-09-15T00:00:00.000Z'). */
export function calendarYmd(iso: string): string {
    return iso.slice(0, 10);
}

/** Soma dias a um "YYYY-MM-DD" (aritmética de calendário, sem fuso). */
export function addDaysYmd(ymd: string, days: number): string {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** "DD/MM" de um "YYYY-MM-DD". */
export function ddmmOfYmd(ymd: string): string {
    return `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
}

/** Dia da semana (0=dom … 6=sáb) de um "YYYY-MM-DD". */
export function dowOfYmd(ymd: string): number {
    return new Date(`${ymd}T12:00:00Z`).getUTCDay();
}

/** Fim do dia (23:59:59.999) de um "YYYY-MM-DD" no fuso de SP (sem horário de verão desde 2019). */
export function endOfSpDay(ymd: string): Date {
    return new Date(`${ymd}T23:59:59.999-03:00`);
}

/** Último dia (calendário SP) da janela gravada — a nova gravação precisa ser até ele. */
export function makeupLastYmd(makeupDeadline: string): string {
    return spYmd(makeupDeadline);
}

/** "DD/MM" do último dia da janela gravada. */
export function makeupDeadlineDdmm(makeupDeadline: string): string {
    return ddmmOfYmd(makeupLastYmd(makeupDeadline));
}

/**
 * Prévia da janela que SERIA aberta para uma gravação da data `bookingDate` (antes de gravar):
 * último dia = D + days; prazo = fim desse dia em SP. `expired` = o prazo já passou (não dá mais para
 * justificar a falta; no NAO_REALIZADO o backend grava a janela já encerrada).
 */
export function previewMakeupWindow(bookingDate: string, days: number, now: Date = new Date()) {
    const lastYmd = addDaysYmd(calendarYmd(bookingDate), Math.max(0, Math.floor(days)));
    const deadline = endOfSpDay(lastYmd);
    return { lastYmd, ddmm: ddmmOfYmd(lastYmd), deadline, expired: deadline.getTime() <= now.getTime() };
}

/** Dias de calendário SP que restam na janela, CONTANDO hoje (último dia = 1; ≤ 0 = já passou). */
export function makeupDaysLeft(makeupDeadline: string, now: Date = new Date()): number {
    const last = makeupLastYmd(makeupDeadline);
    const today = spYmd(now);
    return Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Gravação perdida (falta ou não realizada). */
export function isMissedStatus(status: string | null | undefined): boolean {
    return status === 'FALTA' || status === 'NAO_REALIZADO';
}

/**
 * Dias da semana em que uma reserva da faixa pode ser remarcada (mesma faixa ESTRITA do backend):
 * SABADO → só sábado; COMERCIAL/AUDIÊNCIA → segunda a sexta; sempre ∩ operating_days.
 */
export function allowedDaysForTier(tier: string, operatingDaysCsv: string): number[] {
    const op = operatingDaysCsv.split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
    const base = tier === 'SABADO' ? [6] : [1, 2, 3, 4, 5];
    return base.filter(d => op.includes(d));
}

// ─── Visão do admin (Hoje, Detalhe do Contrato, Agendamentos) ────────────

export interface MakeupBookingLike {
    status: string;
    date: string;
    makeupStatus?: MakeupStatus | string | null;
    makeupDeadline?: string | null;
    missedDate?: string | null;
}

export type MakeupTone = 'warning' | 'info' | 'muted' | 'danger';

export interface MakeupAdminView {
    /** Rótulo (badge do bloco). */
    label: string;
    /** Rótulo compacto (chip de tabela/lista). */
    short: string;
    tone: MakeupTone;
    /** Frase de contexto para o bloco. */
    description: string;
    /** Mostra "Justificar falta" (FALTA avulsa sem janela, antes do fim de D+N). */
    canJustify: boolean;
    /** Mostra "Remarcar" (janela aberta; ou NAO_REALIZADO para o admin mesmo expirado/sem janela — D5). */
    canReschedule: boolean;
    /** "DD/MM" do último dia da janela (aberta, prevista ou encerrada). */
    lastDdmm: string | null;
}

/**
 * Estado da remarcação de uma reserva AVULSA do ponto de vista do ADMIN, ou null quando não há
 * nada a mostrar (não é avulso / não é falta nem remarcada).
 */
export function describeMakeupForAdmin(
    b: MakeupBookingLike,
    opts: { contractType?: string | null; makeupDays: number; now?: Date },
): MakeupAdminView | null {
    if (opts.contractType !== 'AVULSO') return null;
    const now = opts.now ?? new Date();
    const ms = b.makeupStatus ?? null;
    const recorded = b.makeupDeadline ? makeupDeadlineDdmm(b.makeupDeadline) : null;
    const openNow = ms === 'OPEN' && !!b.makeupDeadline && new Date(b.makeupDeadline).getTime() > now.getTime();

    if (b.status === 'FALTA') {
        if (openNow) {
            return {
                label: `Remarcação liberada até ${recorded}`, short: `Remarcar até ${recorded}`, tone: 'warning', lastDdmm: recorded,
                description: `Falta justificada: o cliente pode remarcar uma única vez, sem novo pagamento, para uma data até ${recorded}. Se não remarcar, perde o valor.`,
                canJustify: false, canReschedule: true,
            };
        }
        if (ms === 'OPEN' || ms === 'EXPIRED') {
            return {
                label: 'Prazo encerrado — valor retido', short: 'Prazo encerrado', tone: 'muted', lastDdmm: recorded,
                description: `O prazo para remarcar terminou${recorded ? ` em ${recorded}` : ''} sem remarcação: o valor foi perdido e o contrato avulso fica Concluído.`,
                canJustify: false, canReschedule: false,
            };
        }
        if (ms === 'USED') {
            return {
                label: 'Remarcação já usada — valor retido', short: 'Remarcação já usada', tone: 'muted', lastDdmm: recorded,
                description: 'Esta gravação já tinha sido remarcada uma vez (a remarcação é única): a nova falta não dá direito a outra.',
                canJustify: false, canReschedule: false,
            };
        }
        const preview = previewMakeupWindow(b.date, opts.makeupDays, now);
        if (preview.expired) {
            return {
                label: 'Falta sem justificativa — valor retido', short: 'Sem justificativa', tone: 'muted', lastDdmm: preview.ddmm,
                description: `O prazo para justificar esta falta terminou em ${preview.ddmm} (${opts.makeupDays} dias após a gravação): o valor foi perdido.`,
                canJustify: false, canReschedule: false,
            };
        }
        return {
            label: 'Falta sem justificativa', short: 'Justificar falta', tone: 'danger', lastDdmm: preview.ddmm,
            description: `O cliente perde o valor desta gravação. Se o estúdio aceitar o motivo, justifique a falta até ${preview.ddmm} para liberar uma remarcação sem novo pagamento.`,
            canJustify: true, canReschedule: false,
        };
    }

    if (b.status === 'NAO_REALIZADO') {
        if (openNow) {
            return {
                label: `Remarcação liberada até ${recorded}`, short: `Remarcar até ${recorded}`, tone: 'warning', lastDdmm: recorded,
                description: `Não realizada pelo estúdio: o cliente remarca sem custo até ${recorded}. Se ele não remarcar, o valor NÃO é perdido e você é avisado para combinar a nova data.`,
                canJustify: false, canReschedule: true,
            };
        }
        if (ms === 'OPEN' || ms === 'EXPIRED') {
            return {
                label: 'Prazo encerrado — resolver com o cliente', short: 'Prazo encerrado · Remarcar', tone: 'danger', lastDdmm: recorded,
                description: `O prazo terminou${recorded ? ` em ${recorded}` : ''} sem remarcação. O cliente não perde o valor: combine a nova data com ele e remarque aqui (sem limite de data).`,
                canJustify: false, canReschedule: true,
            };
        }
        return {
            label: 'Não realizada — remarcar com o cliente', short: 'Remarcar sem custo', tone: 'warning', lastDdmm: null,
            description: 'Gravação não realizada pelo estúdio. O cliente não perde o valor: combine a nova data com ele e remarque aqui, sem novo pagamento.',
            canJustify: false, canReschedule: true,
        };
    }

    if (ms === 'USED') {
        const missed = b.missedDate ? ddmmOfYmd(calendarYmd(b.missedDate)) : null;
        return {
            label: missed ? `Remarcada (falta em ${missed})` : 'Remarcada', short: missed ? `Remarcada (falta em ${missed})` : 'Remarcada', tone: 'info', lastDdmm: recorded,
            description: missed
                ? `Gravação perdida em ${missed} e remarcada para esta data, sem novo pagamento (remarcação única já usada).`
                : 'Gravação remarcada sem novo pagamento (remarcação única já usada).',
            canJustify: false, canReschedule: false,
        };
    }
    return null;
}

// ─── Falta / Não Realizado pelo StatusReasonModal (Hoje, Centro de Comando, Agendamentos, Editar) ──

/**
 * Corpo do PATCH /bookings/:id ao confirmar o StatusReasonModal. `noShowJustified` só vai na FALTA de
 * reserva AVULSA (true abre a janela de remarcação; false não mexe numa reserva sem janela).
 */
export function buildReasonUpdate(
    kind: 'FALTA' | 'NAO_REALIZADO',
    reason: string,
    opts: { isAvulso: boolean; justified: boolean },
): { status: 'FALTA' | 'NAO_REALIZADO'; statusReason: string; noShowJustified?: boolean } {
    return {
        status: kind,
        statusReason: reason,
        ...(kind === 'FALTA' && opts.isAvulso ? { noShowJustified: opts.justified } : {}),
    };
}

/**
 * Resposta do PATCH /bookings/:id que decide o retorno da tela depois do modal de motivo. O servidor é a fonte:
 *  • `booking.makeupStatus`/`makeupDeadline` = a janela GRAVADA depois da troca (null = sem janela);
 *  • `makeupOpened`/`makeupDeadline`/`makeupBlockReason` (R7a) = se a troca abriu a janela e, se não abriu, o motivo;
 *  • `reopenedWithoutCharge` (AUDFIN-01) = a sessão saiu de Cancelado com a cobrança anulada e ficou sem cobrança.
 * Campo ausente = a tela não sabe → não afirma nada sobre a remarcação.
 */
export interface ReasonSaveResponse {
    message?: string;
    reopenedWithoutCharge?: boolean;
    makeupOpened?: boolean;
    makeupDeadline?: string | null;
    makeupBlockReason?: string | null;
    booking?: { makeupStatus?: MakeupStatus | string | null; makeupDeadline?: string | null } | null;
}

/** Janela de remarcação do avulso segundo a resposta do servidor (nunca pela prévia local). */
export type ServerMakeupWindow =
    | { state: 'OPEN'; lastDdmm: string }
    | { state: 'EXPIRED' }
    | { state: 'NONE'; reason: string | null }
    | { state: 'UNKNOWN' };

export function serverMakeupWindow(res: ReasonSaveResponse | null | undefined, now: Date = new Date()): ServerMakeupWindow {
    if (!res) return { state: 'UNKNOWN' };
    const recorded = res.booking ? (res.booking.makeupStatus ?? null) : undefined;
    const deadline = res.makeupDeadline ?? res.booking?.makeupDeadline ?? null;
    if (res.makeupOpened === true || recorded === 'OPEN') {
        if (!deadline) return { state: 'UNKNOWN' };
        return new Date(deadline).getTime() > now.getTime()
            ? { state: 'OPEN', lastDdmm: makeupDeadlineDdmm(deadline) }
            : { state: 'EXPIRED' };
    }
    if (recorded === 'EXPIRED') return { state: 'EXPIRED' };
    const reason = typeof res.makeupBlockReason === 'string' && res.makeupBlockReason.trim() ? res.makeupBlockReason.trim() : null;
    // Sem janela gravada (null ou a remarcação única já usada) ou o servidor disse que não abriu.
    if (res.makeupOpened === false || recorded === null || recorded === 'USED') return { state: 'NONE', reason };
    return { state: 'UNKNOWN' };
}

/** Retorno da tela ao salvar Falta / Não Realizado: toast (sucesso simples) ou alerta (o que a pessoa precisa ler). */
export type ReasonSaveFeedback =
    | { kind: 'toast'; message: string }
    | { kind: 'alert'; type: 'info' | 'warning'; title: string; message: string };

export const REOPENED_WITHOUT_CHARGE_TITLE = 'Sessão reaberta sem cobrança';
export const MAKEUP_NOT_OPENED = 'A remarcação sem custo não foi liberada ao cliente.';

/**
 * AUDFIN6-03/TELA6-01 — o que a tela diz depois do PATCH de Falta / Não Realizado (Hoje, Painel, lista e Editar).
 * A promessa de remarcação sem custo ("liberada até DD/MM") só sai quando o SERVIDOR diz que a janela está aberta;
 * a data é a do prazo gravado. Sem a informação, não promete. A sessão reaberta sem cobrança mostra o aviso do
 * servidor (e nenhuma promessa).
 */
export function reasonSaveFeedback(
    kind: 'FALTA' | 'NAO_REALIZADO',
    opts: { isAvulso: boolean; justified: boolean; now?: Date },
    res: ReasonSaveResponse | null | undefined,
): ReasonSaveFeedback {
    if (res?.reopenedWithoutCharge) {
        return { kind: 'alert', type: 'warning', title: REOPENED_WITHOUT_CHARGE_TITLE, message: res.message || 'A sessão fica sem cobrança.' };
    }
    if (kind === 'FALTA') {
        if (!(opts.isAvulso && opts.justified)) return { kind: 'toast', message: 'Falta registrada.' };
        const w = serverMakeupWindow(res, opts.now);
        return w.state === 'OPEN'
            ? { kind: 'toast', message: `Falta justificada — o cliente pode remarcar sem novo pagamento até ${w.lastDdmm}.` }
            : { kind: 'toast', message: 'Falta registrada.' };
    }
    if (!opts.isAvulso) return { kind: 'toast', message: 'Marcado como não realizado — crédito liberado.' };
    const w = serverMakeupWindow(res, opts.now);
    switch (w.state) {
        case 'OPEN':
            return { kind: 'toast', message: `Marcado como não realizado — remarcação sem custo liberada ao cliente até ${w.lastDdmm}.` };
        case 'EXPIRED':
            return { kind: 'toast', message: 'Marcado como não realizado — o prazo de remarcação já passou; use "Remarcar" para combinar a nova data.' };
        case 'NONE':
            return { kind: 'alert', type: 'info', title: 'Marcado como não realizado', message: w.reason ? `${MAKEUP_NOT_OPENED} ${w.reason}` : MAKEUP_NOT_OPENED };
        default:
            return { kind: 'toast', message: 'Marcado como não realizado.' };
    }
}

/** Mostra o retorno de reasonSaveFeedback com o toast/alerta da página (useUI). */
export function showReasonFeedback(
    fb: ReasonSaveFeedback,
    ui: { showToast: (message: string) => void; showAlert: (o: { type: 'info' | 'warning'; title: string; message: string }) => void },
): void {
    if (fb.kind === 'toast') ui.showToast(fb.message);
    else ui.showAlert({ type: fb.type, title: fb.title, message: fb.message });
}

/**
 * Dica do modal de motivo para o Não Realizado do avulso (antes de salvar): a janela só abre para gravação paga
 * (makeupBlockReason no servidor), então a tela não promete a remarcação sem saber do pagamento.
 */
export function naoRealizadoAvulsoHint(preview: { ddmm: string; expired: boolean }, makeupDays: number): string {
    return preview.expired
        ? 'A gravação não aconteceu por um motivo do estúdio. O prazo de remarcação automática já passou: se a gravação estiver paga, combine a nova data com o cliente e use "Remarcar" nesta gravação. Descreva o motivo.'
        : `A gravação não aconteceu por um motivo do estúdio. Se a gravação estiver paga, o cliente NÃO perde o valor: a remarcação sem custo abre automaticamente até ${preview.ddmm} (${makeupDays} dias); se ele não remarcar, o contrato continua ativo e você é avisado para combinar a nova data. Sem o pagamento confirmado, a remarcação sem custo não é liberada. Descreva o motivo.`;
}
