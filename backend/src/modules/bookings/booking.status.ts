import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { getStaffRecipientIds } from '../../lib/staffRecipients.js';
import { releaseMultiSlotLock } from '../../lib/redis.js';
import { stripeGetPaymentIntent } from '../../lib/stripeService.js';
import { getPackageSlots } from '../../utils/pricing.js';
import { BookingStatus } from '../../generated/prisma/client.js';
import {
    restoreCredit, voidExtrasOfCancelledBooking, voidedExtrasNote, sessionChargeState, sessionAwaitsOwnPayment, awaitsOwnPayment,
    withOpenChargeCountOne,
} from './booking.service.js';
import { syncContractCompletion } from '../../lib/contractCompletion.js';
import { notifyEvent } from '../notifications/notificationService.js';
import { completeBookingSchema } from './validators.js';
import { deriveStreamAggregates } from '../../lib/streamMetrics.js';
import { logAudit } from '../../lib/audit.js';
import { spDaysFromToday } from '../../lib/spTime.js';

/**
 * Teto da duração derivada automaticamente (Iniciar → Finalizar). Um início antigo esquecido (ex.: de
 * outro dia) não pode virar uma "duração" de dias: acima disso a derivação é ignorada e a duração só é
 * gravada se o operador informar o valor.
 */
const AUTO_DURATION_MAX_MINUTES = 12 * 60;

export function registerStatusRoutes(router: Router) {

// ─── POST /api/bookings/:id/complete-payment ─────────────
// Called after successful Stripe payment to confirm a HELD booking

router.post('/:id/complete-payment', authenticate, async (req: Request, res: Response) => {
    try {
        const bookingId = req.params.id as string;
        const userId = req.user!.userId;
        const { paymentIntentId } = req.body;

        const booking = await prisma.booking.findFirst({
            where: { id: bookingId, userId },
            include: { contract: true },
        });

        if (!booking) {
            res.status(404).json({ error: 'Agendamento não encontrado.' });
            return;
        }

        if (booking.status !== 'HELD' && booking.status !== 'RESERVED') {
            res.status(400).json({ error: `Agendamento já está com status ${booking.status}.` });
            return;
        }

        // Check if hold has expired
        if (booking.holdExpiresAt && new Date(booking.holdExpiresAt) < new Date()) {
            res.status(410).json({ error: 'A reserva temporária expirou. O horário foi liberado.' });
            return;
        }

        // PAY-02 FIX: paymentIntentId is REQUIRED — never allow free confirmations
        if (!paymentIntentId) {
            res.status(400).json({ error: 'paymentIntentId é obrigatório para confirmar pagamento.' });
            return;
        }

        // Security: verify the PaymentIntent with Stripe BEFORE updating booking
        let bookingPaymentId: string;
        try {
            const pi = await stripeGetPaymentIntent(paymentIntentId);
            if (pi.status !== 'succeeded') {
                res.status(400).json({ error: 'Pagamento ainda não confirmado pelo Stripe.' });
                return;
            }

            // SEC FIX (S1): exigir o VÍNCULO forte do PaymentIntent a um pagamento PENDING DESTE
            // agendamento. Antes, quando não havia esse pagamento, a checagem de valor era pulada e
            // QUALQUER PI 'succeeded' (ex.: um avulso anterior do próprio cliente) confirmava o
            // agendamento e ativava o contrato SEM pagar. Agora: sem pagamento vinculado → recusa.
            const bookingPayment = await prisma.payment.findFirst({
                where: { bookingId, providerRef: paymentIntentId, status: 'PENDING' },
            });
            if (!bookingPayment) {
                res.status(400).json({ error: 'Nenhum pagamento pendente vinculado a este agendamento e a este PaymentIntent.' });
                return;
            }
            // Posse forte: o PI de cartão de um Payment sempre grava metadata.paymentId = payment.id.
            if (pi.metadata?.paymentId && pi.metadata.paymentId !== bookingPayment.id) {
                console.error(`[BOOKING] PI ownership mismatch: PI.meta=${pi.metadata?.paymentId}, payment=${bookingPayment.id}`);
                res.status(400).json({ error: 'PaymentIntent não pertence a este pagamento.' });
                return;
            }
            // B12: cartão parcelado guarda o total com juros em chargedAmount (fix A1) — comparar
            // contra (chargedAmount ?? amount), como verify-payment/webhook. Antes rejeitava (400) um
            // PI de cartão legitimamente sobretaxado neste caminho.
            const expectedAmount = bookingPayment.chargedAmount ?? bookingPayment.amount;
            if (pi.amount !== expectedAmount) {
                console.error(`[BOOKING] Amount mismatch: PI=${pi.amount}, DB=${expectedAmount}`);
                res.status(400).json({ error: 'Valor do pagamento não confere.' });
                return;
            }
            bookingPaymentId = bookingPayment.id;
        } catch {
            res.status(400).json({ error: 'Não foi possível verificar o pagamento no Stripe.' });
            return;
        }

        // ATU-02/R5: o PaymentIntent pago é de OUTRA cobrança da reserva (um serviço extra) e a cobrança da PRÓPRIA
        // sessão segue sem pagar → o pagamento é registrado (e os efeitos rodam), mas a sessão não vira Confirmada —
        // a mesma regra do /confirm (402): sessionAwaitsOwnPayment, contando como PAGO o Payment deste PaymentIntent.
        const sessionChargeOpen = await sessionAwaitsOwnPayment(booking, { assumePaidId: bookingPaymentId });

        // Update booking to CONFIRMED (AFTER payment verification)
        const updated = sessionChargeOpen
            ? booking
            : await prisma.booking.update({
                where: { id: bookingId },
                data: {
                    status: 'CONFIRMED' as BookingStatus,
                    holdExpiresAt: null,
                },
            });

        // Update Payment record to PAID (atomic — only if still PENDING)
        const paid = await prisma.payment.updateMany({
            where: {
                bookingId,
                providerRef: paymentIntentId,
                status: 'PENDING',
            },
            data: { status: 'PAID', paidAt: new Date() },
        });

        // If avulso micro-contract, activate it (PAY-07 FIX: atomic guard)
        if (booking.contract?.status === 'AWAITING_PAYMENT') {
            await prisma.contract.updateMany({
                where: { id: booking.contractId!, status: 'AWAITING_PAYMENT' },
                data: { status: 'ACTIVE', paymentDeadline: null },
            });
        }

        // Run the centralized confirmation effects only if THIS call won the PENDING→PAID race.
        // The booking/contract were already confirmed above (idempotent no-ops inside), but this
        // adds the effects this path was missing — notably the "payment confirmed" push.
        if (paid.count > 0) {
            const paidPayment = await prisma.payment.findFirst({
                where: { bookingId, providerRef: paymentIntentId },
                select: { id: true },
            });
            if (paidPayment) {
                const { onPaymentConfirmed } = await import('../../lib/paymentEffects.js');
                await onPaymentConfirmed(paidPayment.id);
            }
        }

        // Release Redis locks (booking is now confirmed in DB)
        const dateStr = booking.date.toISOString().split('T')[0];
        const packageSlots = getPackageSlots(booking.startTime);
        await releaseMultiSlotLock(dateStr, packageSlots, userId);

        res.json({
            booking: {
                id: updated.id,
                date: dateStr,
                startTime: updated.startTime,
                endTime: updated.endTime,
                status: updated.status,
                price: updated.price,
            },
            message: sessionChargeOpen
                ? 'Pagamento confirmado. A sessão continua aguardando o pagamento da cobrança dela (em Meus pagamentos).'
                : '✅ Pagamento confirmado! Seu horário está reservado.',
        });
    } catch (err) {
        console.error('[BOOKING] complete-payment error:', err);
        res.status(500).json({ error: 'Erro ao confirmar pagamento.' });
    }
});

// ─── PATCH /api/bookings/:id/confirm ────────────────────

router.patch('/:id/confirm', authenticate, async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const userId = req.user!.userId;

    const booking = await prisma.booking.findFirst({
        where: { id, userId, status: BookingStatus.RESERVED },
        include: { contract: { select: { type: true } } },
    });

    if (!booking) {
        res.status(404).json({ error: 'Reserva não encontrada ou já confirmada/cancelada.' });
        return;
    }

    // R5 (pagamento DA SESSÃO — booking.service.sessionAwaitsOwnPayment):
    //  • sessão com cobrança MARCADA (metadata.sessionCharge: SERVIÇO, FIXO acima do teto, avulso/sessão cobrada
    //    pela equipe — R4 ATK-03/FIN-05): só confirma com essa cobrança paga (nenhuma marcada em aberto);
    //  • avulso sem a marca (do próprio cliente, com ou sem hold — VULN-C2/DIN-05): exige o PAGAMENTO DA GRAVAÇÃO
    //    pago — a compra de um extra paga não conta;
    //  • sessão de plano sem cobrança própria: confirma (extras em aberto não a seguram).
    const ownCharge = await sessionChargeState(id);
    if (awaitsOwnPayment(ownCharge, { holdExpiresAt: booking.holdExpiresAt, contractType: booking.contract?.type })) {
        res.status(402).json({
            error: booking.contract?.type === 'AVULSO' || (!!booking.holdExpiresAt && !ownCharge.marked)
                ? 'Pagamento obrigatório para confirmar agendamento avulso.'
                : 'Pagamento obrigatório para confirmar esta sessão.',
        });
        return;
    }

    // Confirm booking
    const updated = await prisma.booking.update({
        where: { id },
        data: { status: BookingStatus.CONFIRMED, holdExpiresAt: null },
    });

    // Release Redis locks (booking is now persisted in DB)
    const dateStr = booking.date.toISOString().split('T')[0];
    const packageSlots = getPackageSlots(booking.startTime);
    await releaseMultiSlotLock(dateStr, packageSlots, userId);

    res.json({
        booking: {
            id: updated.id,
            date: dateStr,
            startTime: updated.startTime,
            endTime: updated.endTime,
            status: updated.status,
            price: updated.price,
        },
        message: 'Agendamento confirmado com sucesso!',
    });

    // Aviso instantâneo à equipe (ADMIN + COLABORADOR com a permissão do evento; nunca BLOCKED nem
    // excluído — staffRecipients). A resposta já foi enviada: falha aqui só perde o aviso.
    try {
        const staffIds = await getStaffRecipientIds('admin_booking_confirmed');
        const clientName = (await prisma.user.findUnique({ where: { id: booking.userId }, select: { name: true } }))?.name || 'Cliente';
        const bookingDate = booking.date.toISOString().split('T')[0];
        const [dd, mm] = [bookingDate.slice(8, 10), bookingDate.slice(5, 7)];
        for (const staffId of staffIds) {
            notifyEvent('admin_booking_confirmed', {
                userId: staffId,
                vars: { cliente: clientName, data: `${dd}/${mm}`, hora: booking.startTime },
                entityType: 'BOOKING',
                entityId: booking.id,
            }).catch(() => {});
        }
    } catch (err) {
        console.error('[BOOKING] Falha ao avisar a equipe da confirmação:', err);
    }
});

// ─── PUT /api/bookings/:id/client-cancel ────────────────

router.put('/:id/client-cancel', authenticate, async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const userId = req.user!.userId;

    const booking = await prisma.booking.findFirst({
        where: { id, userId, status: BookingStatus.CONFIRMED },
    });

    if (!booking) {
        res.status(404).json({ error: 'Reserva não encontrada ou já cancelada/concluída.' });
        return;
    }

    const now = new Date();
    // Use proper calculation for 24h before (assume UTC-3 for timezone consistency with fixed slots)
    const bookingDateTime = new Date(`${booking.date.toISOString().split('T')[0]}T${booking.startTime}:00-03:00`);
    const diffMs = bookingDateTime.getTime() - now.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    if (diffHours >= 24) {
        // Cancel with refund. B3: transição atômica guardada — só a requisição que efetivamente move
        // CONFIRMED→CANCELLED restaura o crédito (duplo-clique não dupla-restaura).
        const cancelled = await prisma.booking.updateMany({
            where: { id, status: BookingStatus.CONFIRMED },
            data: { status: BookingStatus.CANCELLED },
        });
        if (cancelled.count === 0) {
            res.json({ message: 'Agendamento já cancelado.' });
            return;
        }

        if (booking.contractId) {
            await restoreCredit(booking.contractId);
        }
        await syncContractCompletion(booking.contractId, userId);

        // Gravação cancelada pelo cliente: a cobrança em aberto dela (a dos EXTRAS e a da própria sessão, inclusive a do
        // avulso desde a R5) deixa de ser devida (best-effort — ver voidExtrasOfCancelledBooking).
        const voidedExtras = await voidExtrasOfCancelledBooking(id, booking.contractId);

        // Aviso instantâneo à equipe (ADMIN + COLABORADOR com a permissão do evento; nunca BLOCKED nem
        // excluído — staffRecipients). O cancelamento já foi gravado: falha aqui só perde o aviso.
        try {
            const staffIds = await getStaffRecipientIds('admin_booking_cancelled');
            const clientName = (await prisma.user.findUnique({ where: { id: booking.userId }, select: { name: true } }))?.name || 'Cliente';
            const cancelDate = booking.date.toISOString().split('T')[0];
            const [cdd, cmm] = [cancelDate.slice(8, 10), cancelDate.slice(5, 7)];
            for (const staffId of staffIds) {
                notifyEvent('admin_booking_cancelled', {
                    userId: staffId,
                    vars: { cliente: clientName, data: `${cdd}/${cmm}`, hora: booking.startTime },
                    entityType: 'BOOKING',
                    entityId: booking.id,
                }).catch(() => {});
            }
        } catch (err) {
            console.error('[BOOKING] Falha ao avisar a equipe do cancelamento:', err);
        }

        res.json({ message: `Agendamento cancelado com sucesso. O crédito retornou ao seu plano.${voidedExtrasNote(voidedExtras)}`, voidedExtras });
    } else {
        // Cancel without refund (Late cancellation)
        await prisma.booking.update({
            where: { id },
            data: { status: BookingStatus.FALTA },
        });
        // D6: FALTA sem justificativa encerra o avulso (e pode concluir um plano sem sessões restantes).
        await syncContractCompletion(booking.contractId, userId);
        res.json({ message: 'Agendamento desmarcado. Por causa do aviso prévio menor que 24h, o crédito desta sessão foi consumido.' });
    }
});

// ─── PUT /api/bookings/:id/check-in (equipe — Hoje: confirmar presença) ─────────────

router.put('/:id/check-in', authenticate, requirePermission('hoje.presenca'), async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) { res.status(404).json({ error: 'Agendamento não encontrado.' }); return; }
    if (booking.status !== 'RESERVED' && booking.status !== 'CONFIRMED') {
        res.status(400).json({ error: `Não é possível fazer check-in de um agendamento com status ${booking.status}.` }); return;
    }
    // Limpa o hold ao promover para CONFIRMED (evita que o cleanup varra uma reserva já com check-in).
    const updated = await prisma.booking.update({ where: { id }, data: { status: BookingStatus.CONFIRMED, holdExpiresAt: null } });
    res.json({ booking: await withOpenChargeCountOne(updated), message: '✅ Check-in realizado! Cliente presente.' });
});

// ─── PUT /api/bookings/:id/complete (equipe — Hoje: operar a gravação) ──────────────

router.put('/:id/complete', authenticate, requirePermission('hoje.gravacao'), async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const data = completeBookingSchema.parse(req.body || {});
        const booking = await prisma.booking.findUnique({ where: { id } });
        if (!booking) { res.status(404).json({ error: 'Agendamento não encontrado.' }); return; }
        // Allow finalizing an in-progress booking, or re-saving metrics on an already-finalized one.
        if (!['CONFIRMED', 'RESERVED', 'COMPLETED'].includes(booking.status)) {
            res.status(400).json({ error: `Não é possível finalizar um agendamento com status ${booking.status}.` }); return;
        }
        // "Iniciar Gravação" é obrigatório antes da 1ª finalização (marca que houve um operador presente).
        // Re-salvar métricas de uma gravação já COMPLETED não re-exige (o início já ficou registrado).
        if (booking.status !== 'COMPLETED' && !booking.recordingStartedAt) {
            res.status(400).json({ error: 'Inicie a gravação antes de finalizar (clique em "Iniciar Gravação").' }); return;
        }
        // Legacy aggregates: explicit value wins, else derive from per-network streamMetrics.
        const agg = deriveStreamAggregates(data.streamMetrics);
        const peakViewers = data.peakViewers != null ? data.peakViewers : agg.peakViewers;
        const chatMessages = data.chatMessages != null ? data.chatMessages : agg.chatMessages;
        // Duração da sessão: quando o operador não informa um valor, deriva do intervalo entre
        // "Iniciar Gravação" e agora (a finalização). Só na 1ª finalização com gravação iniciada —
        // re-salvar métricas de um COMPLETED preserva a duração já registrada (não recalcula do início).
        let durationMinutes = data.durationMinutes;
        if (durationMinutes == null && booking.status !== 'COMPLETED' && booking.recordingStartedAt) {
            const derived = Math.max(1, Math.round((Date.now() - booking.recordingStartedAt.getTime()) / 60000));
            // Início antigo (esquecido de outro dia) → não grava uma duração absurda; fica sem duração.
            if (derived <= AUTO_DURATION_MAX_MINUTES) durationMinutes = derived;
        }
        const completeData = {
            status: BookingStatus.COMPLETED,
            ...(durationMinutes != null && { durationMinutes }),
            ...(data.isLivestream !== undefined && { isLivestream: data.isLivestream }),
            ...(data.platforms !== undefined && { platforms: data.platforms }),
            ...(data.platformLinks !== undefined && { platformLinks: data.platformLinks }),
            ...(data.streamMetrics !== undefined && { streamMetrics: data.streamMetrics }),
            ...(data.audienceOrigin !== undefined && { audienceOrigin: data.audienceOrigin }),
            ...(data.adminNotes !== undefined && { adminNotes: data.adminNotes }),
            ...(data.clientNotes !== undefined && { clientNotes: data.clientNotes }),
            ...(peakViewers != null && { peakViewers }),
            ...(chatMessages != null && { chatMessages }),
        };
        let updated;
        if (booking.status === 'COMPLETED') {
            // Re-salvar métricas de uma gravação já finalizada: escrita direta, como sempre foi.
            updated = await prisma.booking.update({ where: { id }, data: completeData });
        } else {
            // 1ª finalização: escrita guardada pelo estado LIDO (mesmo status + início ainda registrado).
            // Se outra tela desfez o início (ou mudou o status/horário) entre a leitura e a escrita, nada é
            // gravado — sem isso a gravação ficava COMPLETED sem registro de início.
            const finalized = await prisma.booking.updateMany({
                where: { id, status: booking.status, recordingStartedAt: { not: null } },
                data: completeData,
            });
            if (finalized.count === 0) {
                const current = await prisma.booking.findUnique({ where: { id } });
                if (!current) { res.status(404).json({ error: 'Agendamento não encontrado.' }); return; }
                // Duplo clique / outro operador já finalizou: idempotente, sem regravar nada.
                if (current.status === BookingStatus.COMPLETED) {
                    res.json({ booking: await withOpenChargeCountOne(current), message: '🏁 Sessão finalizada com sucesso!' });
                    return;
                }
                res.status(409).json({
                    error: 'A gravação foi alterada em outra tela (o início foi desfeito ou o status mudou). Atualize e tente de novo.',
                    code: 'RECORDING_STATE_CHANGED',
                });
                return;
            }
            updated = await prisma.booking.findUniqueOrThrow({ where: { id } });
        }
        // D6: gravação finalizada → o contrato pode estar concluído (avulso sempre; plano se não resta nada).
        await syncContractCompletion(booking.contractId, req.user!.userId);
        res.json({ booking: await withOpenChargeCountOne(updated), message: '🏁 Sessão finalizada com sucesso!' });
    } catch (err) {
        if (err instanceof z.ZodError) { res.status(400).json({ error: 'Dados inválidos.', details: err.errors }); return; }
        throw err;
    }
});

// Falta é registrada via PATCH /:id (status=FALTA + statusReason) — todo no-show carrega um motivo.
// A antiga rota reason-less /mark-falta foi removida para não abrir uma porta lateral sem motivo.

// ─── PUT /api/bookings/:id/start-recording (equipe — Hoje: operar a gravação) ──────
// O operador clica em "Iniciar Gravação" — registra QUEM operou e QUANDO. Marca que houve alguém
// presente e é pré-requisito para finalizar (ver o guard em /:id/complete).

router.put('/:id/start-recording', authenticate, requirePermission('hoje.gravacao'), async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) { res.status(404).json({ error: 'Agendamento não encontrado.' }); return; }
    // Só faz sentido iniciar uma gravação confirmada (paga) e ainda não finalizada.
    if (booking.status !== 'CONFIRMED') {
        res.status(400).json({ error: `Só é possível iniciar uma gravação confirmada (status atual: ${booking.status}).` });
        return;
    }
    // Sessão FUTURA (dia de São Paulo posterior a hoje) não pode ser iniciada: um clique por engano na
    // sessão da semana que vem acenderia "AO VIVO" para o cliente. Só o futuro é recusado — sessão de
    // hoje ou passada segue permitida (Iniciar → Finalizar retroativo de quem esqueceu de iniciar).
    if (spDaysFromToday(booking.date) > 0) {
        res.status(400).json({
            error: 'Só é possível iniciar a gravação no dia da sessão.',
            code: 'RECORDING_START_FUTURE',
        });
        return;
    }
    // Idempotente: se já foi iniciada, mantém o operador/horário original (não sobrescreve).
    if (booking.recordingStartedAt) {
        res.json({ booking: await withOpenChargeCountOne(booking), message: 'Gravação já iniciada.' });
        return;
    }
    const operator = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { name: true } });
    const updated = await prisma.booking.update({
        where: { id },
        data: {
            recordingStartedAt: new Date(),
            recordingStartedById: req.user!.userId,
            recordingStartedByName: operator?.name ?? null,
        },
    });
    res.json({ booking: await withOpenChargeCountOne(updated), message: '🔴 Gravação iniciada.' });
});

// ─── PUT /api/bookings/:id/undo-start-recording (equipe — Hoje: operar a gravação) ─
// Desfaz um "Iniciar Gravação" clicado por engano: zera QUEM/QUANDO iniciou. O cliente deixa de ver o
// selo "AO VIVO" (isRecordingNow) e a sessão volta a exigir "Iniciar Gravação" antes de finalizar.
// Só em gravação CONFIRMED (iniciada e ainda NÃO finalizada); o registro anterior fica na auditoria.

router.put('/:id/undo-start-recording', authenticate, requirePermission('hoje.gravacao'), async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) { res.status(404).json({ error: 'Agendamento não encontrado.' }); return; }
    const notUndoable = (status: BookingStatus) => res.status(409).json({
        error: status === BookingStatus.COMPLETED
            ? 'Esta gravação já foi finalizada. O início não pode mais ser desfeito.'
            : `Só é possível desfazer o início de uma gravação confirmada e ainda não finalizada (status atual: ${status}).`,
        code: 'RECORDING_UNDO_NOT_ALLOWED',
    });
    if (booking.status !== BookingStatus.CONFIRMED) { notUndoable(booking.status); return; }
    // Idempotente: nada iniciado → nada a desfazer (dois cliques, ou duas abas do painel).
    if (!booking.recordingStartedAt) {
        res.json({ booking: await withOpenChargeCountOne(booking), message: 'A gravação não estava iniciada.' });
        return;
    }
    // Escrita guardada pelo estado: se a finalização gravou ANTES (status → COMPLETED), o início não é
    // zerado (cai no 409 abaixo). A ordem inversa (finalização leu antes, grava depois deste undo) é
    // barrada do outro lado: o /complete só grava se o início ainda estiver registrado (409
    // RECORDING_STATE_CHANGED), então o 200 daqui é sempre verdadeiro.
    const undone = await prisma.booking.updateMany({
        where: { id, status: BookingStatus.CONFIRMED, recordingStartedAt: { not: null } },
        data: { recordingStartedAt: null, recordingStartedById: null, recordingStartedByName: null },
    });
    const current = await prisma.booking.findUnique({ where: { id } });
    if (!current) { res.status(404).json({ error: 'Agendamento não encontrado.' }); return; }
    if (undone.count === 0) {
        if (current.status !== BookingStatus.CONFIRMED) { notUndoable(current.status); return; }
        res.json({ booking: await withOpenChargeCountOne(current), message: 'A gravação não estava iniciada.' });
        return;
    }
    await logAudit('BOOKING', id, 'RECORDING_START_UNDONE', req.user!.userId, {
        recordingStartedAt: booking.recordingStartedAt.toISOString(),
        recordingStartedById: booking.recordingStartedById,
        recordingStartedByName: booking.recordingStartedByName,
    });
    res.json({ booking: await withOpenChargeCountOne(current), message: 'Início da gravação desfeito.' });
});

} // end registerStatusRoutes
