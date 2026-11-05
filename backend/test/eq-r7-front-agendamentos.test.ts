import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// FRENTE R7b (revisão 6) — decisões de TELA dos agendamentos como funções puras do front, testadas aqui (o front não
// tem runner de componente), e a LIGAÇÃO das telas a elas (lendo o código-fonte sem comentários):
//  • AUDFIN6-03/TELA6-01: depois do modal de motivo (Hoje, Painel, seletor da lista, Editar), o retorno segue a
//    RESPOSTA do PATCH — a remarcação sem custo só é prometida quando o servidor diz que a janela está aberta; a sessão
//    reaberta sem cobrança mostra o aviso do servidor; o modal de motivo não promete a janela sem saber do pagamento.
//  • AUDFIN6-02 (espelho): a sessão cuja cobrança foi anulada não é oferecida de volta "em aberto" quando o servidor
//    disse (reopenedWithoutCharge ou o 409 SESSION_CHARGE_VOIDED).

const perms = vi.hoisted(() => ({ isAdmin: false, keys: new Set<string>() }));
vi.mock('react', () => ({ useMemo: (f: () => unknown) => f() }));
vi.mock('../../frontend/src/hooks/usePermission', () => ({
    usePermission: () => ({
        isAdmin: perms.isAdmin,
        can: (k: string) => perms.isAdmin || perms.keys.has(k),
        canAny: (...ks: string[]) => perms.isAdmin || ks.some(k => perms.keys.has(k)),
    }),
}));

import {
    reasonSaveFeedback,
    serverMakeupWindow,
    showReasonFeedback,
    naoRealizadoAvulsoHint,
    MAKEUP_NOT_OPENED,
    REOPENED_WITHOUT_CHARGE_TITLE,
} from '../../frontend/src/utils/avulsoMakeup';
import {
    useBookingPermissions,
    isVoidedChargeReopenBlocked,
    VOIDED_CHARGE_REOPEN_HINT,
} from '../../frontend/src/components/admin/bookings/bookingPermissions';
import { makeupOutcome } from '../src/lib/avulsoMakeup';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
/** Código sem comentários (um comentário não pode mascarar a conferência). */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
function between(src: string, from: string, to: string): string {
    const i = src.indexOf(from);
    if (i < 0) return '';
    const j = src.indexOf(to, i + from.length);
    return j < 0 ? '' : src.slice(i, j + to.length);
}

const NOW = new Date('2026-11-05T15:00:00.000Z');           // 12:00 em SP
const FUTURE_DEADLINE = '2026-11-12T02:59:59.999Z';         // fim do dia 11/11 em SP
const PAST_DEADLINE = '2026-11-01T02:59:59.999Z';           // fim do dia 31/10 em SP
const NOT_PAID = 'O pagamento desta gravação não está confirmado; a remarcação sem novo pagamento só vale para gravação paga.';
const AV = { isAvulso: true, justified: false, now: NOW };
const text = (fb: ReturnType<typeof reasonSaveFeedback>) => (fb.kind === 'toast' ? fb.message : `${fb.title} ${fb.message}`);
/** Qualquer promessa de remarcação ("liberada ao cliente até", "pode remarcar", "use Remarcar"). */
const PROMISE = /liberada ao cliente até|pode remarcar|"Remarcar"/;

describe('AUDFIN6-03 — reasonSaveFeedback: Não realizado do avulso pela resposta do servidor', () => {
    it('janela NÃO aberta (avulso não pago): sem promessa; alerta com o motivo do servidor', () => {
        const fb = reasonSaveFeedback('NAO_REALIZADO', AV, { makeupOpened: false, makeupDeadline: null, makeupBlockReason: NOT_PAID, booking: { makeupStatus: null, makeupDeadline: null } });
        expect(fb.kind).toBe('alert');
        expect(text(fb)).not.toMatch(PROMISE);
        expect(text(fb)).toContain(MAKEUP_NOT_OPENED);
        expect(text(fb)).toContain(NOT_PAID);
    });
    it('sem os campos novos, a janela gravada (makeupStatus null) basta para não prometer', () => {
        const fb = reasonSaveFeedback('NAO_REALIZADO', AV, { booking: { makeupStatus: null, makeupDeadline: null } });
        expect(fb.kind).toBe('alert');
        expect(text(fb)).toContain(MAKEUP_NOT_OPENED);
        expect(text(fb)).not.toMatch(PROMISE);
    });
    it('resposta sem nada sobre a janela (ou ausente): não afirma', () => {
        for (const res of [undefined, null, {}, { message: 'ok' }]) {
            const fb = reasonSaveFeedback('NAO_REALIZADO', AV, res as never);
            expect(fb, JSON.stringify(res)).toEqual({ kind: 'toast', message: 'Marcado como não realizado.' });
        }
    });
    it('janela aberta: promete com a data do PRAZO GRAVADO (não a prévia local)', () => {
        const opened = reasonSaveFeedback('NAO_REALIZADO', AV, { makeupOpened: true, makeupDeadline: FUTURE_DEADLINE, makeupBlockReason: null, booking: { makeupStatus: 'OPEN', makeupDeadline: FUTURE_DEADLINE } });
        expect(opened).toEqual({ kind: 'toast', message: 'Marcado como não realizado — remarcação sem custo liberada ao cliente até 11/11.' });
        // A janela já aberta (ex.: falta justificada antes) também vale — o estado gravado é do servidor.
        const kept = reasonSaveFeedback('NAO_REALIZADO', AV, { booking: { makeupStatus: 'OPEN', makeupDeadline: FUTURE_DEADLINE } });
        expect(text(kept)).toMatch(/liberada ao cliente até 11\/11/);
    });
    it('prazo vencido: "use Remarcar", sem "liberada"', () => {
        for (const res of [
            { makeupOpened: false, makeupDeadline: PAST_DEADLINE, makeupBlockReason: 'O prazo … terminou', booking: { makeupStatus: 'EXPIRED', makeupDeadline: PAST_DEADLINE } },
            { booking: { makeupStatus: 'OPEN', makeupDeadline: PAST_DEADLINE } },
        ]) {
            const fb = reasonSaveFeedback('NAO_REALIZADO', AV, res);
            expect(fb.kind).toBe('toast');
            expect(text(fb)).toMatch(/prazo de remarcação já passou; use "Remarcar"/);
            expect(text(fb)).not.toMatch(/liberada/);
        }
    });
    it('a remarcação única já usada e não reaberta (USED): sem promessa', () => {
        expect(text(reasonSaveFeedback('NAO_REALIZADO', AV, { booking: { makeupStatus: 'USED', makeupDeadline: PAST_DEADLINE } }))).not.toMatch(PROMISE);
    });
    it('TELA6-01: sessão reaberta sem cobrança → só o aviso do servidor (nenhuma promessa), em qualquer tipo', () => {
        const res = { reopenedWithoutCharge: true, message: 'Agendamento atualizado com sucesso. A cobrança desta sessão foi anulada e não volta com a reabertura: a sessão fica sem cobrança.', makeupOpened: false, booking: { makeupStatus: null } };
        for (const isAvulso of [true, false]) {
            const fb = reasonSaveFeedback('NAO_REALIZADO', { ...AV, isAvulso }, res);
            expect(fb).toEqual({ kind: 'alert', type: 'warning', title: REOPENED_WITHOUT_CHARGE_TITLE, message: res.message });
        }
        expect(REOPENED_WITHOUT_CHARGE_TITLE).toBe('Sessão reaberta sem cobrança');
    });
    it('plano (não avulso): o texto de sempre', () => {
        expect(reasonSaveFeedback('NAO_REALIZADO', { ...AV, isAvulso: false }, { booking: { makeupStatus: null } }))
            .toEqual({ kind: 'toast', message: 'Marcado como não realizado — crédito liberado.' });
    });
    it('Falta: justificada promete com o prazo gravado; sem janela gravada ou não justificada, "Falta registrada."', () => {
        const J = { isAvulso: true, justified: true, now: NOW };
        expect(reasonSaveFeedback('FALTA', J, { booking: { makeupStatus: 'OPEN', makeupDeadline: FUTURE_DEADLINE } }))
            .toEqual({ kind: 'toast', message: 'Falta justificada — o cliente pode remarcar sem novo pagamento até 11/11.' });
        expect(reasonSaveFeedback('FALTA', J, { booking: { makeupStatus: null } })).toEqual({ kind: 'toast', message: 'Falta registrada.' });
        expect(reasonSaveFeedback('FALTA', J, undefined)).toEqual({ kind: 'toast', message: 'Falta registrada.' });
        expect(reasonSaveFeedback('FALTA', { ...J, justified: false }, { booking: { makeupStatus: 'OPEN', makeupDeadline: FUTURE_DEADLINE } }))
            .toEqual({ kind: 'toast', message: 'Falta registrada.' });
    });
    it('contrato com o servidor (R7a): o que makeupOutcome devolve vira o retorno certo', () => {
        const dl = new Date(FUTURE_DEADLINE);
        const open = makeupOutcome({ status: 'NAO_REALIZADO', makeupStatus: 'OPEN', makeupDeadline: dl }, null, NOW);
        expect(serverMakeupWindow({ ...open, booking: { makeupStatus: 'OPEN', makeupDeadline: FUTURE_DEADLINE } }, NOW)).toEqual({ state: 'OPEN', lastDdmm: '11/11' });
        const none = makeupOutcome({ status: 'NAO_REALIZADO', makeupStatus: null, makeupDeadline: null }, NOT_PAID, NOW);
        const w = serverMakeupWindow({ ...none, booking: { makeupStatus: null, makeupDeadline: null } }, NOW);
        expect(w).toEqual({ state: 'NONE', reason: NOT_PAID });
        // Só os campos novos (sem o booking): o servidor dizer "não abriu" basta.
        expect(serverMakeupWindow({ ...none }, NOW)).toEqual({ state: 'NONE', reason: NOT_PAID });
        const expired = makeupOutcome({ status: 'NAO_REALIZADO', makeupStatus: 'EXPIRED', makeupDeadline: new Date(PAST_DEADLINE) }, null, NOW);
        expect(serverMakeupWindow({ ...expired, booking: { makeupStatus: 'EXPIRED', makeupDeadline: PAST_DEADLINE } }, NOW)).toEqual({ state: 'EXPIRED' });
    });
    it('showReasonFeedback: toast → showToast; alerta → showAlert com tipo, título e mensagem', () => {
        const ui = { showToast: vi.fn(), showAlert: vi.fn() };
        showReasonFeedback({ kind: 'toast', message: 'a' }, ui);
        showReasonFeedback({ kind: 'alert', type: 'info', title: 't', message: 'm' }, ui);
        expect(ui.showToast).toHaveBeenCalledWith('a');
        expect(ui.showAlert).toHaveBeenCalledWith({ type: 'info', title: 't', message: 'm' });
    });
});

describe('AUDFIN6-03 — o modal de motivo não promete a janela antes de salvar', () => {
    it('naoRealizadoAvulsoHint condiciona a remarcação ao pagamento (aberta e vencida)', () => {
        const open = naoRealizadoAvulsoHint({ ddmm: '11/11', expired: false }, 7);
        expect(open).toMatch(/Se a gravação estiver paga, o cliente NÃO perde o valor: a remarcação sem custo abre automaticamente até 11\/11 \(7 dias\)/);
        expect(open).toMatch(/Sem o pagamento confirmado, a remarcação sem custo não é liberada\./);
        const expired = naoRealizadoAvulsoHint({ ddmm: '31/10', expired: true }, 7);
        expect(expired).toMatch(/se a gravação estiver paga, combine a nova data com o cliente e use "Remarcar"/);
        expect(expired).not.toMatch(/NÃO perde o valor/);
    });
    it('StatusReasonModal usa a função (o texto incondicional antigo saiu)', () => {
        const src = code(read('frontend/src/components/admin/bookings/StatusReasonModal.tsx'));
        expect(src).toMatch(/hint = naoRealizadoAvulsoHint\(preview, makeupDays\);/);
        expect(src).not.toMatch(/e o cliente NÃO perde o valor: a remarcação sem custo abre automaticamente/);
    });
});

describe('AUDFIN6-03/TELA6-01 — ligação: os quatro caminhos passam a RESPOSTA do PATCH à decisão', () => {
    const CALL = 'showReasonFeedback(reasonSaveFeedback(kind, { isAvulso, justified }, res), { showToast, showAlert });';
    const PAGES = {
        lista: 'frontend/src/pages/AdminBookingsPage.tsx',
        hoje: 'frontend/src/pages/AdminTodayPage.tsx',
        painel: 'frontend/src/components/admin/dashboard/AdminDashboard.tsx',
    };
    for (const [nome, file] of Object.entries(PAGES)) {
        it(`${nome}: handleConfirmReason guarda a resposta e decide por ela`, () => {
            const src = code(read(file));
            const block = between(src, 'const handleConfirmReason = async', 'finally');
            expect(block).not.toBe('');
            expect(block).toMatch(/const res = await bookingsApi\.update\(booking\.id, buildReasonUpdate\(kind, reason, \{ isAvulso, justified \}\)\);/);
            expect(block.includes(CALL)).toBe(true);
            expect(block).not.toMatch(/reasonToastMessage|previewMakeupWindow|showToast\(reason/);
            expect(src).not.toMatch(/reasonToastMessage/);
        });
    }
    it('Editar: o save decide pela resposta no Falta/Não realizado e só mostra o aviso solto fora dele', () => {
        const src = code(read('frontend/src/components/admin/bookings/EditBookingModal.tsx'));
        const block = between(src, 'const save = async', 'finally');
        expect(block).toMatch(/const res = await bookingsApi\.update\(booking\.id, data\);/);
        expect(block.includes('showReasonFeedback(reasonSaveFeedback(editForm.status, { isAvulso, justified: reason.justified }, res), { showToast, showAlert });')).toBe(true);
        // O aviso solto fica no ramo "senão" (antes saíam o toast que promete e o aviso, contraditórios).
        expect(block).toMatch(/\}\s*else if \(res\.reopenedWithoutCharge\) showAlert\(/);
        expect(src).not.toMatch(/reasonToastMessage/);
    });
    it('a lista marca a linha como sessão sem cobrança quando o servidor diz (nos dois caminhos e no 409)', () => {
        const src = code(read('frontend/src/pages/AdminBookingsPage.tsx'));
        const reasonBlock = between(src, 'const handleConfirmReason = async', 'finally');
        expect(reasonBlock).toMatch(/\.\.\.\(res\?\.reopenedWithoutCharge \? \{ ownChargeVoided: true \} : \{\}\)/);
        const inline = between(src, 'const handleInlineStatusChange = async', 'const handleConfirmReason');
        expect(inline).toMatch(/const voided = res\?\.reopenedWithoutCharge \? \{ ownChargeVoided: true \} : \{\};/);
        expect(inline).toMatch(/\.\.\.mk, \.\.\.voided \}/);
        expect(inline).toMatch(/if \(err instanceof ApiError && err\.code === 'SESSION_CHARGE_VOIDED'\) \{\s*setBookings\(prev => prev\.map\(x => x\.id === id \? \{ \.\.\.x, ownChargeVoided: true \} : x\)\);/);
    });
});

describe('AUDFIN6-02 (espelho) — sessão com a cobrança anulada não volta a ficar em aberto', () => {
    const as = (keys: readonly string[], isAdmin = false) => {
        perms.isAdmin = isAdmin;
        perms.keys = new Set(keys);
        return useBookingPermissions();
    };
    const b = (status: string, ownChargeVoided?: boolean) => ({ status, recordingStartedAt: null, contract: { type: 'AVULSO' }, openChargeCount: 0, ownChargeVoided });
    beforeEach(() => { perms.isAdmin = false; perms.keys = new Set(); });

    it('regra pura: só com o sinal do servidor, de status fechado para em aberto', () => {
        for (const from of ['COMPLETED', 'FALTA', 'NAO_REALIZADO', 'CANCELLED']) {
            for (const to of ['RESERVED', 'HELD', 'CONFIRMED']) {
                expect(isVoidedChargeReopenBlocked(b(from, true), to), `${from}→${to}`).toBe(true);
                expect(isVoidedChargeReopenBlocked(b(from), to), `${from}→${to} sem sinal`).toBe(false);
                expect(isVoidedChargeReopenBlocked(b(from, false), to), `${from}→${to} false`).toBe(false);
            }
            for (const to of ['COMPLETED', 'NAO_REALIZADO', 'CANCELLED']) expect(isVoidedChargeReopenBlocked(b(from, true), to), `${from}→${to}`).toBe(false);
        }
        // Entre status em aberto nada muda (Reservado → Confirmado).
        expect(isVoidedChargeReopenBlocked(b('RESERVED', true), 'CONFIRMED')).toBe(false);
    });
    it('o seletor não oferece Reservado/Em espera/Confirmado — nem ao ADMIN (o 409 vale para todos); sem o sinal, oferece', () => {
        const admin = as([], true);
        const opts = admin.statusOptions(b('COMPLETED', true), ['RESERVED', 'HELD', 'CONFIRMED', 'COMPLETED', 'NAO_REALIZADO', 'CANCELLED']);
        expect(opts).toEqual(['COMPLETED', 'NAO_REALIZADO', 'CANCELLED']);
        expect(admin.canChangeStatus(b('COMPLETED'), 'CONFIRMED')).toBe(true);
        const recepcao = as(['agendamentos.ver', 'agendamentos.editar', 'agendamentos.faltas']);
        expect(recepcao.canChangeStatus(b('COMPLETED', true), 'CONFIRMED')).toBe(false);
        expect(recepcao.canChangeStatus(b('COMPLETED'), 'CONFIRMED')).toBe(true);
        // É regra de negócio, não de acesso: não aciona o aviso "aparecem só os status que o seu acesso permite".
        expect(admin.hiddenByAccess(b('COMPLETED', true), 'CONFIRMED')).toBe(false);
    });
    it('Editar explica com VOIDED_CHARGE_REOPEN_HINT; o 409 do servidor tem o code que a lista reconhece', () => {
        const src = code(read('frontend/src/components/admin/bookings/EditBookingModal.tsx'));
        expect(src).toMatch(/const voidedReopenBlocked = isVoidedChargeReopenBlocked\(booking, 'CONFIRMED'\);/);
        expect(src).toMatch(/: voidedReopenBlocked && \(\s*<div[^>]*>\s*\{VOIDED_CHARGE_REOPEN_HINT\}/);
        expect(VOIDED_CHARGE_REOPEN_HINT).toMatch(/não volta a ficar em aberto \(Reservado, Em espera ou Confirmado\)/);
        expect(read('backend/src/modules/bookings/booking.service.ts')).toMatch(/code: 'SESSION_CHARGE_VOIDED'/);
    });
});

describe('TELA6-04 — o Editar usa o termo da sessão cobrada à parte (não "Sessão extra" para toda sessão cobrada)', () => {
    it('texto da troca de faixa', () => {
        const src = read('frontend/src/components/admin/bookings/EditBookingModal.tsx');
        expect(src).toMatch(/Sessão cobrada à parte \(ex\.: a extra do Fixo\) só muda de faixa/);
        expect(src).not.toMatch(/Sessão extra, cobrada à parte/);
    });
});
