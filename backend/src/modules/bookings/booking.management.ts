import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireAdmin, enforceRuleResult, can, missingRequirement } from '../../middleware/permissions.js';
import { requiredForBookingPatch } from '../../lib/permissionRules.js';
import { logAudit } from '../../lib/audit.js';
import { requirePermissionIfStaff, routeActor } from './permissionGuards.js';
import { releaseMultiSlotLock, acquireMutexBlocking, releaseMutex } from '../../lib/redis.js';
import { getProviderForMethod } from '../../lib/paymentGateway.js';
import {
    getSlotTier,
    getBasePriceDynamic,
    applyDiscount,
    canAccessTier,
    getPackageSlots,
    calculateEndTime,
    studioDateTime,
} from '../../utils/pricing.js';
import { BookingStatus, Prisma } from '../../generated/prisma/client.js';
import { getConfig } from '../../lib/businessConfig.js';
import { deriveStreamAggregates } from '../../lib/streamMetrics.js';
import {
    adminUpdateBookingSchema,
    clientUpdateBookingSchema,
    rescheduleSchema,
    makeupSchema,
    addOnPurchaseSchema,
} from './validators.js';
import {
    restoreCredit, deductCredit, reconcileFlexCredits, checkMoveSlotTier, withMovableSlot, SlotUnavailableError,
    syncAvulsoContractSchedule, voidExtrasOfCancelledBooking, voidedExtrasNote,
    fixoCapReached, fixoCapLockKey, sessionChargeWhere, tierNotAllowedBody, SESSION_PLAN_TYPES,
    hasOpenCharge, NO_OPEN_CHARGE_BOOKING_WHERE, OPEN_CHARGE_CANCEL_NEEDS_BAIXA, OPEN_CHARGE_DELETE_NEEDS_BAIXA,
    reopenCancelledNeedsBaixaText, ownChargeState, REOPEN_OPEN_STATUSES, SESSION_CHARGE_VOIDED_REOPEN,
    REOPENED_WITHOUT_CHARGE_NOTE, FIXO_EXTRA_MARK_WHERE,
    withOpenChargeCount, withOpenChargeCountOne,
} from './booking.service.js';
import { syncContractCompletion } from '../../lib/contractCompletion.js';
import {
    CLIENT_BOOKING_SELECT,
    CLIENT_EDITABLE_STATUSES,
    clientEditBlockReason,
    toClientBooking,
} from './booking.clientView.js';
import {
    MakeupError,
    applyMakeupOnStatusChange,
    rescheduleAvulsoMakeup,
    validateNoShowJustification,
    loadMakeupOutcome,
} from '../../lib/avulsoMakeup.js';

// ─── Cover image upload (memory storage → optimized with sharp) ──────────────
const __dirname_bm = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.resolve(__dirname_bm, '../../../uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const COVER_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic'];
const coverUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024 }, // 12MB raw
    fileFilter: (_req, file, cb) => {
        // Raster allowlist only — reject SVG and other vector/unknown types.
        if (COVER_MIME.includes(file.mimetype)) cb(null, true);
        else cb(new Error('Formato inválido. Envie JPG, PNG, WEBP, AVIF ou HEIC.'));
    },
});
// Run multer and translate its errors into clean 4xx responses (instead of a generic 500).
function coverUploadMw(req: Request, res: Response, next: () => void) {
    coverUpload.single('cover')(req, res, (err: unknown) => {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') { res.status(413).json({ error: 'Imagem muito grande (máx. 12MB).' }); return; }
        if (err) { res.status(400).json({ error: err instanceof Error ? err.message : 'Falha no upload.' }); return; }
        next();
    });
}

/**
 * DIN-01: destinos recusados (409 PLAN_SESSION_CANCELLED) para uma sessão CANCELADA de plano FLEX — voltar a
 * ficar em aberto (uma sessão nova sem consumir crédito) ou ir para Não realizado (devolveria o crédito de
 * novo). Concluído passa (o saldo é reconciliado na hora); Falta já é 400 para todo tipo. O Personalizado
 * recusa qualquer saída de CANCELLED. Espelho no front: components/admin/bookings/bookingPermissions.ts.
 */
const FLEX_CANCELLED_BLOCKED_TARGETS: readonly string[] = ['RESERVED', 'HELD', 'CONFIRMED', 'NAO_REALIZADO'];

/**
 * R4 (ATK-02/FIN-01) — PATCH /:id: respostas da reabertura de uma sessão por quem NÃO tem cobrancas.baixa.
 *  • sair de CANCELLED exige a baixa (lib/permissionRules): o 403 explica por quê;
 *  • sair de NAO_REALIZADO (para qualquer status menos Cancelado) só se o plano ainda comporta a sessão: o
 *    crédito devolvido no "Não realizado" é descontado DE VERDADE antes (FLEX/Personalizado/avulso) e o teto
 *    do FIXO é conferido sob a trava do contrato. ADMIN e quem tem a baixa seguem como antes.
 */
// Textos do 403 de reabrir uma sessão CANCELADA sem a baixa: booking.service.reopenCancelledNeedsBaixaText (FIN-07/R5 —
// cobrança própria viva / cobrança anulada / nenhuma cobrança).
/** UXT-04: o crédito devolvido no "Não realizado" pode ter sido usado OU vencido (confisco semanal do FLEX). */
const REOPEN_NO_CREDITS = 'O plano não tem crédito disponível para reabrir esta sessão: o crédito devolvido no “Não realizado” já foi usado ou venceu. Crie um novo agendamento ou peça a quem pode dar baixa.';
const REOPEN_FIXO_LIMIT = 'O plano fixo já usou todas as sessões: reabrir esta sessão passaria do limite. Crie um novo agendamento (cobrado) ou peça a quem pode dar baixa.';
/** Contratos cujo crédito o "Não realizado" devolve (restoreCredit) — e que, ao reabrir, precisam tê-lo de volta. */
const CREDIT_CONTRACT_TYPES: readonly string[] = ['FLEX', 'CUSTOM', 'AVULSO'];

// Minimal per-network metrics parse (backend mirror of the frontend helper).
function parseMetrics(json: string | null | undefined): Record<string, { views?: number; peak?: number; likes?: number; comments?: number; subscribers?: number }> {
    if (!json) return {};
    try { const v = JSON.parse(json); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

export function registerManagementRoutes(router: Router) {

// ─── DELETE /api/bookings/:id ───────────────────────────
// Rota MISTA: o cliente cancela a própria reserva (política de 24h); a equipe cancela qualquer uma com
// `agendamentos.cancelar` (sem ela, 403 — nunca o ramo do cliente).

router.delete('/:id', authenticate, requirePermissionIfStaff('agendamentos.cancelar'), async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const userId = req.user!.userId;
    const actor = await routeActor(req, res);
    if (!actor) return;
    const isStaff = actor.isStaff; // equipe já conferida pela guarda (agendamentos.cancelar)

    const booking = await prisma.booking.findFirst({
        where: {
            id,
            ...(isStaff ? {} : { userId }),
            status: { not: BookingStatus.CANCELLED },
        },
    });

    if (!booking) {
        res.status(404).json({ error: 'Reserva não encontrada.' });
        return;
    }

    // Sessões que já aconteceram/foram consumidas NUNCA devolvem crédito ao cancelar
    // (evita reaver crédito de gravação concluída/falta e reagendar de graça).
    const cancelableStatuses: BookingStatus[] = [BookingStatus.RESERVED, BookingStatus.HELD, BookingStatus.CONFIRMED];

    // ── Cliente: aplica a política de cancelamento (paridade com PUT /:id/client-cancel) ──
    // Sem isto, o DELETE do cliente burlava a janela de 24h e restaurava crédito de qualquer status.
    if (!isStaff) {
        if (!cancelableStatuses.includes(booking.status)) {
            res.status(400).json({ error: 'Este agendamento não pode ser cancelado.' });
            return;
        }
        if (booking.status === BookingStatus.CONFIRMED) {
            const now = new Date();
            const bookingDateTime = new Date(`${booking.date.toISOString().split('T')[0]}T${booking.startTime}:00-03:00`);
            const diffHours = (bookingDateTime.getTime() - now.getTime()) / (1000 * 60 * 60);
            if (diffHours < 24) {
                // Aviso < 24h: consome a sessão (FALTA), sem devolver crédito.
                await prisma.booking.update({ where: { id }, data: { status: BookingStatus.FALTA } });
                // D6: FALTA sem justificativa encerra o avulso (e pode concluir um plano sem sessões restantes).
                await syncContractCompletion(booking.contractId, userId);
                res.json({ message: 'Agendamento desmarcado. Aviso menor que 24h: o crédito desta sessão foi consumido.' });
                return;
            }
        }
    }

    // R5: anular cobrança em aberto é da baixa. A equipe sem cobrancas.baixa não cancela uma sessão com cobrança em
    // aberto (PENDING/FAILED), seja qual for o status, a data ou a gravação — antes de qualquer escrita (a guarda da
    // rota já deu o 403 de agendamentos.cancelar a quem não o tem). Sem cobrança em aberto, segue como antes.
    const staffWithoutBaixa = isStaff && !can(actor, 'cobrancas.baixa');
    if (staffWithoutBaixa && cancelableStatuses.includes(booking.status) && await hasOpenCharge(id)) {
        res.status(403).json(OPEN_CHARGE_CANCEL_NEEDS_BAIXA);
        return;
    }

    // B3: transição atômica guardada — só UMA requisição concorrente vence o CANCELLED e, portanto,
    // restaura o crédito. Antes, duplo-clique fazia 2 updates por id + 2 restoreCredit sobre o mesmo
    // snapshot (RESERVED/CONFIRMED), devolvendo +2 créditos por 1 gravação cancelada.
    // R5 (corrida): sem a baixa, a transição só vale se a reserva continua SEM cobrança em aberto — uma cobrança
    // criada entre a conferência acima e esta escrita (ex.: o cliente comprando um extra) barra o cancelamento.
    const cancelled = await prisma.booking.updateMany({
        where: { id, status: { in: cancelableStatuses }, ...(staffWithoutBaixa ? NO_OPEN_CHARGE_BOOKING_WHERE : {}) },
        data: { status: BookingStatus.CANCELLED },
    });
    if (cancelled.count === 0) {
        if (staffWithoutBaixa && await hasOpenCharge(id)) {
            const current = await prisma.booking.findUnique({ where: { id }, select: { status: true } });
            if (current && cancelableStatuses.includes(current.status)) {
                res.status(403).json(OPEN_CHARGE_CANCEL_NEEDS_BAIXA);
                return;
            }
        }
        res.json({ message: 'Reserva já estava cancelada.' });
        return;
    }
    // R5 (corrida): reconfere DEPOIS da transição. Se uma cobrança em aberto apareceu no meio (gravada antes da
    // nossa escrita, fora do retrato dela), desfaz a transição — nada mais foi escrito ainda — e responde o 403.
    if (staffWithoutBaixa && await hasOpenCharge(id)) {
        await prisma.booking.updateMany({ where: { id, status: BookingStatus.CANCELLED }, data: { status: booking.status } });
        res.status(403).json(OPEN_CHARGE_CANCEL_NEEDS_BAIXA);
        return;
    }

    // Release Redis locks if the booking was holding a slot (RESERVED/HELD)
    if (booking.status === BookingStatus.RESERVED || booking.status === BookingStatus.HELD) {
        const dateStr = booking.date.toISOString().split('T')[0];
        const packageSlots = getPackageSlots(booking.startTime);
        await releaseMultiSlotLock(dateStr, packageSlots, booking.userId);
    }

    // Restaura crédito de Flex/Custom/Avulso — só porque ESTA requisição venceu a transição atômica
    // acima (o filtro status:{in:cancelableStatuses} já garante que era sessão não-realizada).
    if (booking.contractId) {
        await restoreCredit(booking.contractId);
    }
    await syncContractCompletion(booking.contractId, userId);

    // Gravação cancelada: a cobrança em aberto dela (extras e a da própria sessão — SERVIÇO, FIXO extra, avulso)
    // deixa de ser devida (best-effort — ver voidExtrasOfCancelledBooking). A equipe SEM a baixa só chega aqui sem
    // cobrança em aberto (conferido acima e depois da transição) e nunca anula: uma cobrança que surja depois
    // disso não é dela para anular.
    const voidedExtras = staffWithoutBaixa ? 0 : await voidExtrasOfCancelledBooking(id, booking.contractId);

    res.json({ message: `Reserva cancelada com sucesso.${voidedExtrasNote(voidedExtras)}`, voidedExtras });
});

// ─── DELETE /api/bookings/:id/hard-delete (equipe — remoção definitiva) ─────

router.delete('/:id/hard-delete', authenticate, requirePermission('agendamentos.excluir'), async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;

        const booking = await prisma.booking.findUnique({
            where: { id },
            include: { contract: true },
        });

        if (!booking) {
            res.status(404).json({ error: 'Agendamento não encontrado.' });
            return;
        }

        // R5: excluir também anula as cobranças em aberto da gravação (abaixo, antes de apagar) — sem a baixa, 403
        // antes de qualquer escrita quando há Payment PENDING/FAILED dela (o mesmo princípio do cancelamento).
        const actor = await routeActor(req, res);
        if (!actor) return;
        const withoutBaixa = !can(actor, 'cobrancas.baixa');
        if (withoutBaixa && await hasOpenCharge(id)) {
            res.status(403).json(OPEN_CHARGE_DELETE_NEEDS_BAIXA); // TELA5-05: texto da exclusão
            return;
        }

        // R5 (corrida): sem a baixa, a exclusão vem PRIMEIRO e só vale se a reserva continua sem cobrança em aberto
        // (uma criada depois da conferência acima barra a exclusão) — nada é anulado por quem não tem a baixa.
        if (withoutBaixa) {
            const removed = await prisma.booking.deleteMany({ where: { id, ...NO_OPEN_CHARGE_BOOKING_WHERE } });
            if (removed.count === 0) {
                if (await hasOpenCharge(id)) res.status(403).json(OPEN_CHARGE_DELETE_NEEDS_BAIXA);
                else res.status(404).json({ error: 'Agendamento não encontrado.' });
                return;
            }
        }

        // Release Redis locks if applicable
        if (booking.status === BookingStatus.RESERVED) {
            const dateStr = booking.date.toISOString().split('T')[0];
            const packageSlots = getPackageSlots(booking.startTime);
            await releaseMultiSlotLock(dateStr, packageSlots, booking.userId);
        }

        // B5: só devolve crédito para sessões AINDA NÃO REALIZADAS (RESERVED/HELD/CONFIRMED), igual ao
        // DELETE /:id. Antes restaurava para qualquer status != CANCELLED — devolvendo crédito indevido
        // de COMPLETED/FALTA e dupla-restaurando NAO_REALIZADO (que já teve o crédito devolvido ao ser marcado).
        const hardDeleteCancelable: BookingStatus[] = [BookingStatus.RESERVED, BookingStatus.HELD, BookingStatus.CONFIRMED];
        let creditRestored = false;
        if (booking.contractId && hardDeleteCancelable.includes(booking.status)) {
            creditRestored = await restoreCredit(booking.contractId);
        }

        let voidedExtras = 0;
        if (!withoutBaixa) {
            // Gravação excluída: anula a cobrança em aberto dela (extras e a da própria sessão, inclusive a do
            // avulso) ANTES de apagar — a FK zera o bookingId do pagamento, e uma cobrança pendente sem bookingId
            // passaria a parecer uma parcela do plano (entraria na multa e na cobrança automática). Best-effort.
            voidedExtras = await voidExtrasOfCancelledBooking(id, booking.contractId);

            // Hard delete from database
            await prisma.booking.delete({ where: { id } });
        }
        // Ação irreversível feita pela equipe: fica na auditoria quem excluiu e o que era (nunca lança).
        await logAudit('BOOKING', id, 'HARD_DELETED', req.user!.userId, {
            userId: booking.userId,
            contractId: booking.contractId,
            date: booking.date.toISOString().slice(0, 10),
            startTime: booking.startTime,
            status: booking.status,
            price: booking.price,
            creditRestored,
            voidedExtras,
        });
        // D6: sem esta sessão o contrato pode ter virado (ou deixado de ser) "concluído".
        await syncContractCompletion(booking.contractId, req.user!.userId);

        res.json({
            message: (creditRestored
                ? 'Agendamento removido permanentemente. Crédito devolvido ao contrato.'
                : 'Agendamento removido permanentemente.') + voidedExtrasNote(voidedExtras),
            creditRestored,
            voidedExtras,
        });
    } catch (err) {
        console.error('Hard delete booking error:', err);
        res.status(500).json({ error: 'Erro ao remover agendamento.' });
    }
});

// ─── GET /api/bookings/my ───────────────────────────────

router.get('/my', authenticate, async (req: Request, res: Response) => {
    // Auto-complete removed: only admin can change booking status to COMPLETED

    // Visão do cliente (booking.clientView): sem adminNotes; com clientNotes, métricas, início da
    // gravação e os derivados isRecordingNow / canEditEpisode.
    const rows = await prisma.booking.findMany({
        where: {
            userId: req.user!.userId,
            status: { not: BookingStatus.CANCELLED },
        },
        orderBy: [{ date: 'desc' }, { startTime: 'asc' }],
        select: CLIENT_BOOKING_SELECT,
    });

    const now = new Date();
    res.json({ bookings: rows.map(b => toClientBooking(b, now)) });
});

// ─── GET /api/bookings/my/results (Client analytics) ────
// Aggregates the client's COMPLETED recordings over a period: overall timeline + totals
// and a per-contract breakdown, for the "Resultados" charts. Registered before /:id routes.
router.get('/my/results', authenticate, async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const days = Math.min(730, Math.max(1, Number(req.query.days) || 90));
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - days + 1);

    const bookings = await prisma.booking.findMany({
        where: { userId, status: 'COMPLETED', date: { gte: since } },
        orderBy: { date: 'asc' },
        select: {
            id: true, date: true, streamMetrics: true, isLivestream: true,
            contract: { select: { id: true, name: true } },
        },
    });

    const totals = { sessions: 0, live: 0, views: 0, likes: 0, comments: 0, peakSum: 0, peakCount: 0 };
    // "subscribers" é snapshot acumulado (total de inscritos do canal), NÃO aditivo entre
    // sessões. Guardamos o valor MAIS RECENTE por rede (bookings vêm em ordem asc) e somamos
    // as redes uma vez → "inscritos atuais" (alcance combinado), sem inflar.
    const latestSubs = new Map<string, number>();
    const timelineMap = new Map<string, { date: string; views: number; peak: number; likes: number; comments: number }>();
    const contractMap = new Map<string, { contractId: string; contractName: string; sessions: number; views: number; likes: number; comments: number; latestSubs: Map<string, number>; peakSum: number; peakCount: number; series: { date: string; views: number; peak: number }[] }>();

    for (const b of bookings) {
        const m = parseMetrics(b.streamMetrics);
        const cid = b.contract?.id || 'avulso';
        const c = contractMap.get(cid) || { contractId: cid, contractName: b.contract?.name || 'Avulso', sessions: 0, views: 0, likes: 0, comments: 0, latestSubs: new Map<string, number>(), peakSum: 0, peakCount: 0, series: [] };

        let views = 0, likes = 0, comments = 0, peak = 0;
        for (const [net, pm] of Object.entries(m)) {
            views += Number(pm.views) || 0;
            likes += Number(pm.likes) || 0;
            comments += Number(pm.comments) || 0;
            peak = Math.max(peak, Number(pm.peak) || 0);
            const subs = Number(pm.subscribers) || 0;
            if (subs > 0) { latestSubs.set(net, subs); c.latestSubs.set(net, subs); } // asc → último vence
        }
        const dateStr = b.date.toISOString().split('T')[0];
        totals.sessions++; totals.views += views; totals.likes += likes; totals.comments += comments;
        if (b.isLivestream) totals.live++;
        if (peak > 0) { totals.peakSum += peak; totals.peakCount++; }

        const t = timelineMap.get(dateStr) || { date: dateStr, views: 0, peak: 0, likes: 0, comments: 0 };
        t.views += views; t.peak = Math.max(t.peak, peak); t.likes += likes; t.comments += comments;
        timelineMap.set(dateStr, t);

        c.sessions++; c.views += views; c.likes += likes; c.comments += comments;
        if (peak > 0) { c.peakSum += peak; c.peakCount++; }
        c.series.push({ date: dateStr, views, peak });
        contractMap.set(cid, c);
    }

    const sumMap = (mp: Map<string, number>) => Array.from(mp.values()).reduce((s, v) => s + v, 0);

    res.json({
        overall: {
            sessions: totals.sessions, live: totals.live, views: totals.views, likes: totals.likes, comments: totals.comments, subscribers: sumMap(latestSubs),
            avgPeak: totals.peakCount ? Math.round(totals.peakSum / totals.peakCount) : 0,
            timeline: Array.from(timelineMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
        },
        byContract: Array.from(contractMap.values()).map(c => ({
            contractId: c.contractId, contractName: c.contractName, sessions: c.sessions,
            views: c.views, likes: c.likes, comments: c.comments, subscribers: sumMap(c.latestSubs),
            avgPeak: c.peakCount ? Math.round(c.peakSum / c.peakCount) : 0, series: c.series,
        })),
    });
});

// ─── GET /api/bookings/:id (Client, owner) ──────────────
// Full single booking (with source contract incl. discount/addons) to hydrate the detail
// modal regardless of which list opened it. Registered AFTER /my and /my/results.
router.get('/:id', authenticate, async (req: Request, res: Response) => {
    const booking = await prisma.booking.findFirst({
        where: { id: req.params.id as string, userId: req.user!.userId },
        select: CLIENT_BOOKING_SELECT, // nunca adminNotes — ver booking.clientView
    });
    if (!booking) { res.status(404).json({ error: 'Agendamento não encontrado.' }); return; }
    res.json({ booking: toClientBooking(booking) });
});

// ─── GET /api/bookings (equipe) ─────────────────────────
// Agenda/Agendamentos (`agendamentos.ver`) e Hoje (`hoje.ver`, sem forçar a data — crítica C2 opção 1).

router.get('/', authenticate, requirePermission('agendamentos.ver', 'hoje.ver'), async (req: Request, res: Response) => {
    const { date, status } = req.query;

    const where: Prisma.BookingWhereInput = {};

    if (status && typeof status === 'string') {
        where.status = status as BookingStatus;
    } else {
        where.status = { not: BookingStatus.CANCELLED };
    }

    if (date && typeof date === 'string') {
        where.date = new Date(date + 'T00:00:00');
    }

    const bookings = await prisma.booking.findMany({
        where,
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
        include: {
            user: {
                select: { id: true, name: true, email: true, role: true },
            },
            contract: {
                select: { id: true, name: true, type: true, tier: true },
            },
        },
    });

    // R5: openChargeCount = cobranças EM ABERTO (PENDING/FAILED) da reserva, em lote (groupBy, sem N+1) — a tela
    // da equipe sabe que cancelar essa sessão pede a baixa (OPEN_CHARGE_CANCEL_NEEDS_BAIXA).
    res.json({ bookings: await withOpenChargeCount(bookings) });
});

// ─── PATCH /api/bookings/:id (equipe) ───────────────────
// Rota multiuso: a permissão depende da TRANSIÇÃO de status (de → para) e só dos campos cujo VALOR muda
// (DECISÕES D3 / crítica F2 — o EditBookingModal sempre reenvia date/startTime/status). Regras em
// lib/permissionRules.requiredForBookingPatch, aplicadas ANTES de qualquer escrita (crédito, contrato,
// remarcação). A guarda da rota só exige alguma ação de agendamento/Hoje (um corpo vazio não serve para
// ler agendamento de quem não opera a agenda).

router.patch('/:id', authenticate, requirePermission(
    'agendamentos.editar', 'agendamentos.faltas', 'agendamentos.cancelar', 'hoje.presenca', 'hoje.gravacao',
), async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const data = adminUpdateBookingSchema.parse(req.body);

        const booking = await prisma.booking.findUnique({
            where: { id },
            include: { contract: { select: { type: true, tier: true, durationMonths: true } }, user: { select: { deletedAt: true } } },
        });
        if (!booking) {
            res.status(404).json({ error: 'Agendamento não encontrado.' });
            return;
        }

        // Permissão por transição e valor alterado (a linha completa do Prisma é o "registro atual").
        const patchRule = requiredForBookingPatch(data, booking);
        // R4 (ATK-02/FIN-01): reabrir uma sessão CANCELADA exige também cobrancas.baixa (a única regra do PATCH
        // que a pede) — o 403 diz o motivo em vez do texto genérico. Quem não tem nem agendamentos.editar recebe
        // o 403 dele primeiro (a ordem dos requisitos é a da regra).
        if (booking.status === 'CANCELLED' && data.status && data.status !== 'CANCELLED') {
            const actor = await routeActor(req, res);
            if (!actor) return;
            if (missingRequirement(actor, patchRule.requirements) === 'cobrancas.baixa') {
                // FIN-07/R5: o texto diz a verdade sobre a cobrança desta sessão — cobrança própria viva (paga ou
                // em aberto: "não crie outro agendamento", cobraria de novo), cobrança anulada no cancelamento, ou
                // nenhuma cobrança (sessão de plano).
                res.status(403).json({
                    error: await reopenCancelledNeedsBaixaText(booking),
                    code: 'PERMISSION_DENIED',
                    permission: 'cobrancas.baixa',
                });
                return;
            }
        }
        if (!(await enforceRuleResult(req, res, patchRule))) return;

        // R5: anular cobrança em aberto é da baixa. Cancelar anula as cobranças em aberto da sessão
        // (voidExtrasOfCancelledBooking), então, sem cobrancas.baixa, uma sessão com Payment PENDING/FAILED não é
        // cancelada — seja qual for o status, a data ou a gravação (reabrir/remarcar antes não muda nada). 403
        // antes de qualquer escrita; quem não tem nem agendamentos.cancelar já recebeu o 403 dele acima.
        let cancelWithoutBaixa = false;
        if (data.status === 'CANCELLED' && booking.status !== 'CANCELLED') {
            const actor = await routeActor(req, res);
            if (!actor) return;
            cancelWithoutBaixa = !can(actor, 'cobrancas.baixa');
            if (cancelWithoutBaixa && await hasOpenCharge(id)) {
                res.status(403).json(OPEN_CHARGE_CANCEL_NEEDS_BAIXA);
                return;
            }
        }

        // D3: cliente EXCLUÍDO (soft delete) não ganha obrigação nova. Recusa reabrir a gravação
        // (→ Reservado/Em espera/Confirmado vindo de outro status), mudar data/horário de uma gravação
        // que fica ativa e justificar falta (abre remarcação). Finalizar, marcar falta/não realizado,
        // cancelar e editar notas/métricas continuam permitidos (o histórico é do operador).
        if (booking.user?.deletedAt) {
            const OPEN: string[] = ['RESERVED', 'HELD', 'CONFIRMED'];
            const target = data.status || booking.status;
            const reopening = !!data.status && OPEN.includes(data.status) && !OPEN.includes(booking.status);
            const moving = (!!data.date && data.date !== booking.date.toISOString().slice(0, 10))
                || (!!data.startTime && data.startTime !== booking.startTime);
            if (reopening || (moving && OPEN.includes(target)) || data.noShowJustified === true) {
                res.status(409).json({
                    error: 'Este cliente foi excluído. Não é possível reabrir, remarcar ou justificar a falta desta gravação.',
                    code: 'CLIENT_DELETED',
                });
                return;
            }
        }

        // Não se marca FALTA em uma sessão já concluída ou cancelada (replica o guard da antiga
        // rota /mark-falta, agora que a falta é registrada por este PATCH com motivo).
        if (data.status === 'FALTA' && (booking.status === 'COMPLETED' || booking.status === 'CANCELLED')) {
            res.status(400).json({ error: `Não é possível marcar falta em um agendamento ${booking.status}.` });
            return;
        }

        // DIN-01: sessão CANCELADA de plano com crédito (vale para todos, inclusive o ADMIN). O crédito dela já
        // foi acertado no cancelamento, de um jeito que daqui não se sabe: o DELETE da sessão aberta DEVOLVE o
        // crédito; o PATCH → CANCELLED (de concluída/falta/não realizado) não mexe.
        //   • Personalizado: não sai de CANCELLED pelo PATCH. Não há reconciliador do saldo: reabrir sem
        //     descontar criava crédito do nada (DELETE + reabrir = +1; CANCELLED → NAO_REALIZADO devolvia de
        //     novo) e descontar às cegas cobraria duas vezes quem veio pelo PATCH.
        //   • FLEX: o flexCreditExpiryJob é a fonte canônica do saldo. Voltar a CONCLUÍDA (desfazer o "Cancelar"
        //     de uma sessão que aconteceu) é permitido — o saldo é reconciliado na hora com a conta do cron (no
        //     ajuste de crédito abaixo). Voltar a ficar em aberto (Reservado/Em espera/Confirmado: uma sessão
        //     nova sem consumir crédito) ou ir para Não realizado (devolveria o crédito de novo) segue recusado.
        //     (Cancelado → Falta já é 400 pela regra acima, para todo tipo de contrato.)
        // Para uma sessão nova, o caminho é um novo agendamento, que consome 1 crédito (POST /admin ou o do cliente).
        const cancelledPlanType = booking.status === 'CANCELLED' && data.status && data.status !== 'CANCELLED'
            ? booking.contract?.type
            : undefined;
        if (cancelledPlanType === 'CUSTOM'
            || (cancelledPlanType === 'FLEX' && FLEX_CANCELLED_BLOCKED_TARGETS.includes(data.status!))) {
            res.status(409).json({
                error: cancelledPlanType === 'CUSTOM'
                    ? 'Sessão cancelada de plano Personalizado não pode ser reaberta: o crédito dela já foi acertado no cancelamento. Crie um novo agendamento (consome 1 crédito do plano).'
                    : 'Sessão cancelada de plano Flex não volta a ficar em aberto nem como Não Realizado: o crédito dela já foi acertado no cancelamento. Crie um novo agendamento (consome 1 crédito do plano) ou, se a sessão aconteceu, marque como Concluído.',
                code: 'PLAN_SESSION_CANCELLED',
            });
            return;
        }

        // AUDFIN-01/ATU5-01/TELA5-01 (conserto 5; vale para todos, inclusive o ADMIN): a sessão cuja cobrança PRÓPRIA foi
        // anulada (o cancelamento anula a em aberto, também a do avulso; ou o perdão pelo PATCH /payments) não a recupera
        // ao reabrir — CANCELLED é terminal e nenhuma rota reemite a cobrança de uma sessão. Voltar a ficar EM ABERTO
        // (Reservado/Em espera/Confirmado) deixaria a gravação "aguardando" uma cobrança que não existe (de graça no
        // check-in) → 409 antes de qualquer escrita; para gravar, um novo agendamento gera a cobrança.
        // AUDFIN6-02: vale para a volta a "em aberto" a partir de QUALQUER status fechado — Cancelado, Concluído, Falta,
        // Não realizado —, não só de Cancelado: antes, Cancelado → Concluído (quem tem a baixa) e depois Concluído →
        // Confirmado (só agendamentos.editar) deixavam a gravação em aberto sem cobrança. Entre status em aberto (ex.:
        // Reservado → Confirmado) nada muda. Cancelado → Concluído/Não realizado (registrar o que aconteceu) passam, e a
        // resposta avisa que a sessão fica sem cobrança.
        let reopenedWithoutCharge = false;
        const toOpen = !!data.status && REOPEN_OPEN_STATUSES.includes(data.status) && !REOPEN_OPEN_STATUSES.includes(booking.status);
        const leavingCancelled = booking.status === 'CANCELLED' && !!data.status && data.status !== 'CANCELLED';
        if ((toOpen || leavingCancelled) && (await ownChargeState(booking)) === 'voided') {
            if (toOpen) {
                res.status(409).json(SESSION_CHARGE_VOIDED_REOPEN);
                return;
            }
            reopenedWithoutCharge = true;
        }

        // D4: "falta justificada" (só avulso) — valida ANTES de qualquer escrita, para um 400 não deixar
        // o status trocado sem a janela de remarcação.
        if (data.noShowJustified === true) {
            const justifyError = await validateNoShowJustification({
                finalStatus: data.status || booking.status,
                contractType: booking.contract?.type,
                makeupStatus: booking.makeupStatus,
                bookingDate: data.date ? new Date(data.date + 'T00:00:00Z') : booking.date,
                bookingId: booking.id, // contrato cancelado / pagamento estornado ou não pago → 400
            });
            if (justifyError) {
                res.status(400).json({ error: justifyError });
                return;
            }
        }

        const updateData: Prisma.BookingUncheckedUpdateInput = {};

        if (data.status) {
            updateData.status = data.status;
        }
        // B17/B3: os ajustes de crédito (restore/deduct de NAO_REALIZADO) foram MOVIDOS para depois de
        // TODAS as validações e são feitos sob transição atômica de status — ver o bloco antes do update final.

        if (data.adminNotes !== undefined) updateData.adminNotes = data.adminNotes;
        if (data.clientNotes !== undefined) updateData.clientNotes = data.clientNotes;
        // Motivo de FALTA / NÃO REALIZADO (informado pelo operador no modal).
        if (data.statusReason !== undefined) updateData.statusReason = data.statusReason;
        if (data.platforms !== undefined) updateData.platforms = data.platforms;
        if (data.platformLinks !== undefined) updateData.platformLinks = data.platformLinks;

        // Phase 2 Metrics Logic (incl. livestream flag + per-network streamMetrics)
        const hasMetricsPayload = data.durationMinutes !== undefined || data.peakViewers !== undefined || data.chatMessages !== undefined || data.audienceOrigin !== undefined || data.isLivestream !== undefined || data.streamMetrics !== undefined;
        const targetStatus = data.status || booking.status;

        if (hasMetricsPayload) {
            if (targetStatus !== 'COMPLETED') {
                // Os forms de notas mandam os campos de métrica como null junto do
                // texto — isso NÃO é edição de métrica. Só bloqueia quando algum
                // campo traz valor real; senão salvar observação de um agendamento
                // futuro levava 400 e o PATCH inteiro era rejeitado.
                const hasRealMetricValues = data.durationMinutes != null || data.peakViewers != null
                    || data.chatMessages != null || data.audienceOrigin != null
                    || data.isLivestream != null || data.streamMetrics != null;
                if (hasRealMetricValues) {
                    res.status(400).json({ error: 'Métricas de evento só podem ser editadas quando a gravação estiver como REALIZADA (COMPLETED).' });
                    return;
                }
                // Só nulls: ignora as métricas e deixa notas/plataformas passarem.
            } else {
                if (data.durationMinutes !== undefined) updateData.durationMinutes = data.durationMinutes;
                if (data.audienceOrigin !== undefined) updateData.audienceOrigin = data.audienceOrigin;
                if (data.isLivestream !== undefined) updateData.isLivestream = data.isLivestream;
                if (data.streamMetrics !== undefined) updateData.streamMetrics = data.streamMetrics;
                // Legacy aggregates: explicit value wins, else derived from the per-network metrics.
                const agg = deriveStreamAggregates(data.streamMetrics !== undefined ? data.streamMetrics : booking.streamMetrics);
                const peak = data.peakViewers != null ? data.peakViewers : agg.peakViewers;
                const comments = data.chatMessages != null ? data.chatMessages : agg.chatMessages;
                if (peak != null) updateData.peakViewers = peak;
                if (comments != null) updateData.chatMessages = comments;
            }
        }

        if (data.date) {
            updateData.date = new Date(data.date + 'T00:00:00');
        }

        // Compara VALORES: o EditBookingModal sempre reenvia date/startTime. Reenviar o MESMO horário não
        // pode recalcular a faixa/preço — antes isso sobrescrevia o preço personalizado ou com desconto pelo
        // preço cheio da faixa (e um operador que só registrava a falta mudava o valor da sessão).
        const slotMoved = (!!data.date && data.date !== booking.date.toISOString().slice(0, 10))
            || (!!data.startTime && data.startTime !== booking.startTime);

        if (slotMoved) {
            const newDate = data.date ? new Date(data.date + 'T00:00:00') : booking.date;
            const dayOfWeek = newDate.getUTCDay();
            const slotTier = await getSlotTier(dayOfWeek, data.startTime ?? booking.startTime);
            if (data.startTime && !slotTier) {
                res.status(400).json({ error: 'Horário fora da grade de operação.' });
                return;
            }
            // DIN-03: mudar para OUTRA faixa de preço muda o valor da sessão, mas a cobrança já emitida
            // (PENDING do avulso, extras) não é reprecificada — o cliente pagaria o valor da faixa antiga. É o
            // mesmo efeito do preço personalizado (D3) → exige a baixa manual. Conferido também quando só a
            // data muda (o mesmo horário num sábado é outra faixa). Antes de qualquer escrita.
            // R4 (FIN-03): a SESSÃO DE PLANO não tem cobrança da sessão a reprecificar — contrato FIXO/FLEX/
            // Personalizado e nenhuma cobrança dela com a marca metadata.sessionCharge (qualquer status: FIXO
            // acima do teto, sessão vinculada criada por quem tem a baixa). Ela muda de faixa sem a baixa dentro
            // da faixa do plano (canAccessTier, a mesma regra da criação); acima dela → 403 TIER_NOT_ALLOWED.
            // As demais (avulso, SERVIÇO, sem contrato, sessão cobrada) seguem exigindo a baixa.
            if (slotTier && slotTier !== booking.tierApplied) {
                const actor = await routeActor(req, res);
                if (!actor) return;
                if (!can(actor, 'cobrancas.baixa')) {
                    const planContract = booking.contract && SESSION_PLAN_TYPES.includes(booking.contract.type)
                        ? booking.contract
                        : null;
                    const isPlanSession = !!planContract
                        && (await prisma.payment.count({ where: sessionChargeWhere(id) })) === 0;
                    if (!isPlanSession) {
                        res.status(403).json({
                            error: 'Mudar a sessão para outra faixa de preço muda o valor cobrado — isso exige a permissão “Marcar como pago, anular ou estornar”.',
                            code: 'PERMISSION_DENIED',
                            permission: 'cobrancas.baixa',
                        });
                        return;
                    }
                    if (!canAccessTier(planContract!.tier, slotTier)) {
                        res.status(403).json(tierNotAllowedBody(planContract!.tier, slotTier));
                        return;
                    }
                }
            }
            if (data.startTime && slotTier) {
                updateData.startTime = data.startTime;
                updateData.endTime = calculateEndTime(data.startTime);
                updateData.tierApplied = slotTier;
                updateData.price = await getBasePriceDynamic(slotTier);
            }
        }

        // E11: sessão ABERTA que mudou de dia/horário é uma nova sessão — o "Iniciar Gravação" anterior
        // deixa de valer (mesmo critério da remarcação do avulso). Sem isto o cliente veria "gravando
        // agora" numa gravação remarcada, e o start-recording seguinte (idempotente) manteria o início
        // antigo. Sessão que fica finalizada (COMPLETED/FALTA/…) preserva o registro do operador.
        if (slotMoved && booking.recordingStartedAt && (CLIENT_EDITABLE_STATUSES as string[]).includes(targetStatus)) {
            updateData.recordingStartedAt = null;
            updateData.recordingStartedById = null;
            updateData.recordingStartedByName = null;
        }

        // B17/B3: aplica a transição de status ATOMICAMENTE (updateMany guardado pelo status atual) e
        // ajusta o crédito só se ESTA requisição venceu — e só aqui, DEPOIS de todas as validações.
        // Antes, restoreCredit/deductCredit rodavam no topo: um 400 posterior deixava o crédito
        // alterado sem a mudança de status, e um duplo-clique dupla-restaurava (mesmo snapshot).
        let statusMoved = false;
        if (data.status && data.status !== booking.status) {
            const newStatus = data.status;
            // R5 (corrida): sem a baixa, o cancelamento só vale se a reserva continua SEM cobrança em aberto — uma
            // cobrança criada entre a conferência lá de cima e esta escrita barra a transição (ver abaixo).
            const moveStatus = async () => (await prisma.booking.updateMany({
                where: { id, status: booking.status, ...(cancelWithoutBaixa ? NO_OPEN_CHARGE_BOOKING_WHERE : {}) },
                data: { status: newStatus },
            })).count > 0;

            // R4 (ATK-02/FIN-01): Não realizado → volta a valer (qualquer destino menos Cancelado), por quem NÃO tem
            // a baixa. O "Não realizado" devolveu o crédito (e tirou a sessão do teto do FIXO); se esse crédito/vaga
            // já foi usado por outra sessão, reabrir criaria uma sessão sem cobrança. Então, ANTES de a sessão voltar
            // a valer: FLEX/Personalizado/avulso descontam o crédito com o desconto guardado (> 0) — sem crédito,
            // 409 NO_CREDITS sem escrever nada; o FIXO confere o teto sob a mesma trava da criação — cheio, 409
            // FIXO_LIMIT_REACHED. ADMIN e quem tem a baixa: como antes (desconto sem conferir o retorno, sem teto).
            // FIN-07/R5 + ATU5-02: a sessão EXTRA do FIXO (criada com o teto já cheio; marca fixoExtra, em qualquer status)
            // não ocupa vaga do plano (sessionPayment.occupiesFixoCap) — o teto não se aplica a ela. A sessão cobrada por
            // quem tem a baixa DENTRO do teto (só sessionCharge) ocupa: o teto é conferido.
            let reopenGuard: 'credit' | 'fixo' | null = null;
            if (booking.status === 'NAO_REALIZADO' && newStatus !== 'CANCELLED' && booking.contractId && booking.contract) {
                const actor = await routeActor(req, res);
                if (!actor) return;
                if (!can(actor, 'cobrancas.baixa')) {
                    if (CREDIT_CONTRACT_TYPES.includes(booking.contract.type)) reopenGuard = 'credit';
                    else if (booking.contract.type === 'FIXO'
                        && (await prisma.payment.count({ where: { bookingId: id, ...FIXO_EXTRA_MARK_WHERE } })) === 0) {
                        reopenGuard = 'fixo';
                    }
                }
            }

            if (reopenGuard === 'credit') {
                const contractId = booking.contractId!;
                if (!(await deductCredit(contractId))) {
                    res.status(409).json({ code: 'NO_CREDITS', error: REOPEN_NO_CREDITS });
                    return;
                }
                statusMoved = await moveStatus();
                // Perdeu a corrida (outra requisição mudou o status no meio): devolve o crédito descontado acima.
                if (!statusMoved) await restoreCredit(contractId);
            } else if (reopenGuard === 'fixo') {
                const lockKey = fixoCapLockKey(booking.contractId!);
                if (!(await acquireMutexBlocking(lockKey, 20))) {
                    res.status(409).json({ error: 'Muitas reservas simultâneas neste contrato. Tente novamente.' });
                    return;
                }
                try {
                    if (await fixoCapReached({ id: booking.contractId!, durationMonths: booking.contract!.durationMonths })) {
                        res.status(409).json({ code: 'FIXO_LIMIT_REACHED', error: REOPEN_FIXO_LIMIT });
                        return;
                    }
                    statusMoved = await moveStatus();
                } finally {
                    await releaseMutex(lockKey);
                }
            } else {
                statusMoved = await moveStatus();
                if (cancelWithoutBaixa) {
                    // R5 (corrida): a transição não passou porque apareceu cobrança em aberto → 403 antes de escrever
                    // o resto; passou, mas uma cobrança gravada no meio (fora do retrato da escrita) aparece agora →
                    // desfaz a transição (nada mais foi escrito) e 403.
                    if (await hasOpenCharge(id)) {
                        if (statusMoved) {
                            await prisma.booking.updateMany({ where: { id, status: BookingStatus.CANCELLED }, data: { status: booking.status } });
                        }
                        if (statusMoved || (await prisma.booking.findUnique({ where: { id }, select: { status: true } }))?.status === booking.status) {
                            res.status(403).json(OPEN_CHARGE_CANCEL_NEEDS_BAIXA);
                            return;
                        }
                    }
                }
                if (statusMoved && booking.contractId) {
                    if (newStatus === 'NAO_REALIZADO') {
                        await restoreCredit(booking.contractId);
                    } else if (booking.status === 'NAO_REALIZADO' && newStatus !== 'CANCELLED') {
                        await deductCredit(booking.contractId);
                    } else if (booking.status === 'CANCELLED' && booking.contract?.type === 'FLEX') {
                        // DIN-01: FLEX Cancelado → Concluído (o único destino que a trava acima deixa passar). O
                        // incremental não sabe se o cancelamento devolveu o crédito (DELETE) ou não (PATCH) nem se o
                        // cron já rodou no meio → acerta o saldo canônico na hora (mesma conta do cron).
                        await reconcileFlexCredits(booking.contractId);
                    }
                }
            }
        }
        delete updateData.status; // já aplicado atomicamente acima

        // D4/D5: janela de remarcação do avulso (FALTA justificada abre; NAO_REALIZADO abre sozinho;
        // saindo de FALTA/NAO_REALIZADO pelo admin a janela vira USED ou é retirada).
        let makeupChanged = false;
        if (statusMoved || data.noShowJustified !== undefined) {
            // Compara VALORES (o EditBookingModal sempre manda date e startTime): voltar Falta →
            // Confirmado no MESMO dia/horário desfaz a justificativa; só mudança real gasta a remarcação.
            const slotChanged = (!!data.date && data.date !== booking.date.toISOString().slice(0, 10))
                || (!!data.startTime && data.startTime !== booking.startTime);
            makeupChanged = await applyMakeupOnStatusChange({
                booking: {
                    id,
                    date: booking.date,
                    originalDate: booking.originalDate,
                    missedDate: booking.missedDate,
                    makeupStatus: booking.makeupStatus,
                    contractType: booking.contract?.type,
                },
                from: booking.status,
                to: statusMoved ? data.status! : booking.status,
                statusChanged: statusMoved,
                noShowJustified: data.noShowJustified,
                slotChanged,
                actorId: req.user!.userId,
            });
        }
        // D6: o status do contrato acompanha as sessões (conclui / reabre).
        if (statusMoved || makeupChanged) {
            await syncContractCompletion(booking.contractId, req.user!.userId);
        }

        const updated = await prisma.booking.update({
            where: { id },
            data: updateData,
            include: {
                user: { select: { id: true, name: true, email: true, role: true } },
            },
        });

        // Avulso: a vigência e o nome do micro-contrato acompanham a nova data/horário da gravação.
        if ((data.date || data.startTime) && booking.contract?.type === 'AVULSO') {
            await syncAvulsoContractSchedule(updated.contractId, { date: updated.date, startTime: updated.startTime });
        }

        // Troca de status para CANCELADO (só se ESTA requisição venceu a transição): a cobrança em aberto
        // da gravação (a dos EXTRAS e a da própria sessão — SERVIÇO, FIXO extra, avulso) deixa de ser devida.
        // Só com a baixa (R5, acima): sem ela a sessão chegou aqui sem cobrança em aberto e nada é anulado.
        // Best-effort. Mudar só data/horário (remarcar) nunca passa por aqui.
        const voidedExtras = statusMoved && data.status === 'CANCELLED' && !cancelWithoutBaixa
            ? await voidExtrasOfCancelledBooking(id, booking.contractId)
            : 0;

        // AUDFIN-01: reabriu (Concluído/Não realizado) uma sessão cuja cobrança própria foi anulada — a resposta avisa.
        const withoutChargeNote = statusMoved && reopenedWithoutCharge;
        // AUDFIN6-03/TELA6-01: → Não realizado no AVULSO — a resposta diz se a janela de remarcação sem novo pagamento
        // abriu (makeupOpened, makeupDeadline) e, se não, por quê (makeupBlockReason: não paga, cobrança anulada, contrato
        // cancelado/encerrado, prazo vencido…). A tela usa isto no aviso em vez de prever pela data.
        const makeup = statusMoved && data.status === 'NAO_REALIZADO' && booking.contract?.type === 'AVULSO'
            ? await loadMakeupOutcome(updated)
            : null;
        res.json({
            booking: await withOpenChargeCountOne(updated),
            message: `Agendamento atualizado com sucesso.${voidedExtrasNote(voidedExtras)}${withoutChargeNote ? REOPENED_WITHOUT_CHARGE_NOTE : ''}`,
            ...(voidedExtras > 0 && { voidedExtras }),
            ...(withoutChargeNote && { reopenedWithoutCharge: true }),
            ...(makeup ?? {}),
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── PATCH /api/bookings/:id/client-update (Client) ─────

router.patch('/:id/client-update', authenticate, async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const userId = req.user!.userId;
        const data = clientUpdateBookingSchema.parse(req.body);

        const booking = await prisma.booking.findFirst({
            where: { id, userId },
            select: { id: true, status: true },
        });

        if (!booking) {
            res.status(404).json({ error: 'Agendamento não encontrado.' });
            return;
        }

        // E12: o cliente edita o episódio só enquanto a gravação não foi finalizada/cancelada.
        const blocked = clientEditBlockReason(booking.status);
        if (blocked) {
            res.status(409).json({ error: blocked, code: 'BOOKING_NOT_EDITABLE' });
            return;
        }

        // Só os campos do episódio. clientNotes (feedback do estúdio), links e métricas da transmissão
        // são do estúdio — o schema nem os aceita.
        const updateData: Prisma.BookingUncheckedUpdateManyInput = {};
        if (data.episodeTitle !== undefined) updateData.episodeTitle = data.episodeTitle;
        if (data.episodeDescription !== undefined) updateData.episodeDescription = data.episodeDescription;
        // Redes PLANEJADAS pelo cliente. As redes/links efetivos são gravados pelo estúdio ao finalizar.
        if (data.platforms !== undefined) updateData.platforms = data.platforms;

        if (Object.keys(updateData).length > 0) {
            // Guarda atômica: se o estúdio finalizar/cancelar entre a leitura e a escrita, não grava.
            const written = await prisma.booking.updateMany({
                where: { id, userId, status: { in: CLIENT_EDITABLE_STATUSES } },
                data: updateData,
            });
            if (written.count === 0) {
                const current = await prisma.booking.findFirst({ where: { id, userId }, select: { status: true } });
                res.status(409).json({
                    error: (current && clientEditBlockReason(current.status)) || 'Esta gravação não pode mais ser editada.',
                    code: 'BOOKING_NOT_EDITABLE',
                });
                return;
            }
        }

        const updated = await prisma.booking.findFirstOrThrow({ where: { id, userId }, select: CLIENT_BOOKING_SELECT });
        res.json({ booking: toClientBooking(updated), message: 'Gravação atualizada com sucesso.' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            // Todas as mensagens do schema do cliente são em pt-BR — a 1ª vai direto para a tela.
            res.status(400).json({ error: err.errors[0]?.message || 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── POST /api/bookings/:id/cover-image (Client) ────────
// Upload + optimize (sharp) the episode cover. Stored under /uploads and shown in recordings.
router.post('/:id/cover-image', authenticate, coverUploadMw, async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const userId = req.user!.userId;
        const file = req.file;
        if (!file) { res.status(400).json({ error: 'Nenhuma imagem enviada.' }); return; }

        const booking = await prisma.booking.findFirst({
            where: { id, userId },
            select: { id: true, status: true, coverImageUrl: true },
        });
        if (!booking) { res.status(404).json({ error: 'Agendamento não encontrado.' }); return; }

        // E12: mesma regra do client-update — capa só enquanto a gravação não foi finalizada/cancelada.
        const blocked = clientEditBlockReason(booking.status);
        if (blocked) { res.status(409).json({ error: blocked, code: 'BOOKING_NOT_EDITABLE' }); return; }

        const safeId = id.replace(/[^a-zA-Z0-9\-_]/g, '');
        const filename = `cover_${safeId}_${Date.now()}.jpg`;
        const filePath = path.join(UPLOADS_DIR, filename);
        let optimized: Buffer;
        try {
            optimized = await sharp(file.buffer)
                .resize(1280, 720, { fit: 'cover', position: 'centre' })
                .jpeg({ quality: 82 })
                .toBuffer();
        } catch {
            // Mimetype de imagem mas conteúdo ilegível: erro do envio (400), não do servidor (500).
            res.status(400).json({ error: 'Não foi possível ler a imagem. Envie um JPG, PNG, WEBP, AVIF ou HEIC válido.' });
            return;
        }
        await fs.promises.writeFile(filePath, optimized); // falha de disco continua sendo 500 (catch externo)

        const coverImageUrl = `/uploads/${filename}`;
        // Guarda atômica (finalização/cancelamento concorrente): se não gravou, descarta o arquivo novo.
        const written = await prisma.booking.updateMany({
            where: { id, userId, status: { in: CLIENT_EDITABLE_STATUSES } },
            data: { coverImageUrl },
        });
        if (written.count === 0) {
            fs.promises.unlink(filePath).catch(() => {});
            const current = await prisma.booking.findFirst({ where: { id, userId }, select: { status: true } });
            res.status(409).json({
                error: (current && clientEditBlockReason(current.status)) || 'Esta gravação não pode mais ser editada.',
                code: 'BOOKING_NOT_EDITABLE',
            });
            return;
        }

        // Best-effort cleanup of the previous cover file (avoid orphan accumulation).
        if (booking.coverImageUrl && booking.coverImageUrl.startsWith('/uploads/')) {
            const oldName = path.basename(booking.coverImageUrl);
            fs.promises.unlink(path.join(UPLOADS_DIR, oldName)).catch(() => {});
        }
        const updated = await prisma.booking.findFirstOrThrow({ where: { id, userId }, select: CLIENT_BOOKING_SELECT });
        res.json({ coverImageUrl, booking: toClientBooking(updated), message: 'Capa atualizada com sucesso.' });
    } catch (err: unknown) {
        console.error('Cover upload error:', err);
        res.status(500).json({ error: 'Erro ao processar a imagem.' });
    }
});

// ─── PATCH /api/bookings/:id/reschedule (Client) ────────

router.patch('/:id/reschedule', authenticate, async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const data = rescheduleSchema.parse(req.body);

        const booking = await prisma.booking.findFirst({
            where: { id, userId: req.user!.userId, status: { in: [BookingStatus.RESERVED, BookingStatus.CONFIRMED] } },
        });

        if (!booking) {
            res.status(404).json({ error: 'Agendamento não encontrado ou não pode ser reagendado.' });
            return;
        }

        // Rule 1: Must be at least configured hours before the original booking
        // (studio timezone, consistent with the 24h cancellation check)
        const originalDateTime = studioDateTime(booking.date.toISOString().split('T')[0], booking.startTime);
        const now = new Date();
        const rescheduleMinHours = await getConfig('reschedule_min_hours');
        const hoursUntilOriginal = (originalDateTime.getTime() - now.getTime()) / (1000 * 60 * 60);

        if (hoursUntilOriginal < rescheduleMinHours) {
            res.status(400).json({ error: `O reagendamento deve ser feito com pelo menos ${rescheduleMinHours} horas de antecedência.` });
            return;
        }

        // Rule 2: New date must be within configured days from the ORIGINAL booking date (anchor)
        const rescheduleMaxDays = await getConfig('reschedule_max_days');
        const anchorDate = booking.originalDate || booking.date;
        const anchorMs = new Date(anchorDate).setUTCHours(0, 0, 0, 0);
        const newDate = new Date(data.date + 'T00:00:00');
        const newDateMs = newDate.setUTCHours(0, 0, 0, 0);
        const daysFromAnchor = (newDateMs - anchorMs) / (1000 * 60 * 60 * 24);

        if (daysFromAnchor > rescheduleMaxDays || daysFromAnchor < 0) {
            const anchorStr = new Date(anchorDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
            res.status(400).json({ error: `A nova data deve estar dentro de ${rescheduleMaxDays} dias da data original (${anchorStr}).` });
            return;
        }

        // Rules 3 + 4: operating day, slot in the grid and SAME tier as the original (shared helper,
        // also used by PATCH /:id/makeup).
        const tierError = await checkMoveSlotTier(data.date, data.startTime, booking.tierApplied);
        if (tierError) {
            res.status(400).json({ error: tierError });
            return;
        }

        // Rule 5: Check availability. FIX (B3): tranca o slot NOVO durante a checagem+escrita
        // (mesmo acquireMultiSlotLock do POST /) para fechar a janela TOCTOU entre a leitura do
        // conflito e a gravação — sem isto, duas remarcações/criações concorrentes no mesmo slot
        // passavam ambas na findFirst e gravavam (double-booking). Ver withMovableSlot.
        const updated = await withMovableSlot(
            { date: data.date, startTime: data.startTime, lockOwner: req.user!.userId, excludeBookingId: id },
            async ({ dateObj, endTime }) => {
                // Set originalDate if not already set (anchor for future reschedules)
                const updateData: Prisma.BookingUncheckedUpdateInput = {
                    date: dateObj,
                    startTime: data.startTime,
                    endTime,
                };
                if (!booking.originalDate) {
                    updateData.originalDate = booking.date; // store the initial date as anchor
                }
                // E11: nova data/horário = nova sessão; um "Iniciar Gravação" anterior não vale mais.
                if (booking.recordingStartedAt) {
                    updateData.recordingStartedAt = null;
                    updateData.recordingStartedById = null;
                    updateData.recordingStartedByName = null;
                }
                return prisma.booking.update({
                    where: { id },
                    data: updateData,
                    select: { id: true, date: true, startTime: true, contractId: true },
                });
            },
        );

        // Avulso: a vigência e o nome do micro-contrato acompanham a nova data (no-op p/ outros tipos).
        await syncAvulsoContractSchedule(updated.contractId, { date: updated.date, startTime: updated.startTime });

        // Resposta na visão do cliente (lida DEPOIS do sync, para o nome do avulso já vir atualizado).
        const view = await prisma.booking.findUniqueOrThrow({ where: { id }, select: CLIENT_BOOKING_SELECT });
        res.json({ booking: toClientBooking(view), message: 'Agendamento reagendado com sucesso!' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        if (err instanceof SlotUnavailableError) {
            res.status(err.httpStatus).json({ error: err.message });
            return;
        }
        throw err;
    }
});

// ─── PATCH /api/bookings/:id/makeup (cliente dono ou equipe) ─────
// D4/D5: remarca a gravação perdida do AVULSO (FALTA justificada / NÃO REALIZADO) sem novo
// pagamento, reabrindo a MESMA reserva (mesmo Payment). Regras em lib/avulsoMakeup.ts.
// Rota MISTA: a equipe precisa de `agendamentos.faltas` (sem ela, 403 — nunca o ramo do cliente).

router.patch('/:id/makeup', authenticate, requirePermissionIfStaff('agendamentos.faltas'), async (req: Request, res: Response) => {
    try {
        const data = makeupSchema.parse(req.body);
        const actor = await routeActor(req, res);
        if (!actor) return;
        const isStaff = actor.isStaff; // equipe já conferida pela guarda (agendamentos.faltas)
        const result = await rescheduleAvulsoMakeup({
            bookingId: req.params.id as string,
            actor: { userId: req.user!.userId, isStaff },
            date: data.date,
            startTime: data.startTime,
        });
        if (isStaff) {
            res.json(result);
            return;
        }
        // Cliente: mesma forma das outras rotas dele (superconjunto do que o makeup já devolvia).
        const view = await prisma.booking.findFirst({
            where: { id: req.params.id as string, userId: req.user!.userId },
            select: CLIENT_BOOKING_SELECT,
        });
        res.json({ ...result, booking: view ? toClientBooking(view) : result.booking });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        if (err instanceof MakeupError) {
            res.status(err.httpStatus).json({ error: err.message });
            return;
        }
        throw err;
    }
});

// ─── POST /api/bookings/cleanup-orphan-addons (só ADMIN — sistema.manutencao) ────
// Remove addons from bookings that were added before payment was confirmed (legacy bug)
router.post('/cleanup-orphan-addons', authenticate, requireAdmin(), async (_req: Request, res: Response) => {
    try {
        // Find all bookings with addons
        const bookingsWithAddons = await prisma.booking.findMany({
            where: { addOns: { isEmpty: false } },
            include: { contract: true },
        });

        let cleaned = 0;
        let paymentsDeleted = 0;

        for (const booking of bookingsWithAddons) {
            const contractAddons = booking.contract?.addOns || [];

            // Avulso addons = addons on booking that are NOT in the contract
            const avulsoAddons = booking.addOns.filter(a => !contractAddons.includes(a));
            if (avulsoAddons.length === 0) continue;

            // Check which avulso addons have a PAID payment
            const paidPayments = await prisma.payment.findMany({
                where: { bookingId: booking.id, status: 'PAID', paymentUrl: { not: null } },
            });

            const paidAddonKeys = new Set<string>();
            for (const p of paidPayments) {
                try {
                    const meta = JSON.parse(p.paymentUrl!);
                    const keys: string[] = meta.addonKeys || (meta.addonKey ? [meta.addonKey] : []);
                    keys.forEach(k => paidAddonKeys.add(k));
                } catch {}
            }

            // Remove unpaid avulso addons from booking
            const unpaidAddons = avulsoAddons.filter(a => !paidAddonKeys.has(a));
            if (unpaidAddons.length > 0) {
                const cleanedAddons = booking.addOns.filter(a => !unpaidAddons.includes(a));
                await prisma.booking.update({
                    where: { id: booking.id },
                    data: { addOns: cleanedAddons },
                });
                cleaned++;
                console.log(`[Cleanup] Removed orphan addons ${unpaidAddons.join(', ')} from booking ${booking.id}`);
            }
        }

        // Also delete orphan PENDING addon payments — but only ones older than 1h so we
        // never remove an in-flight payment the user is still completing.
        const orphanCutoff = new Date(Date.now() - 60 * 60 * 1000);
        const orphanPayments = await prisma.payment.findMany({
            where: { status: 'PENDING', paymentUrl: { not: null }, createdAt: { lt: orphanCutoff } },
        });

        for (const p of orphanPayments) {
            try {
                const meta = JSON.parse(p.paymentUrl!);
                if (meta.addonKey || meta.addonKeys) {
                    await prisma.payment.delete({ where: { id: p.id } });
                    paymentsDeleted++;
                }
            } catch {}
        }

        res.json({
            message: `Limpeza concluída: ${cleaned} booking(s) corrigido(s), ${paymentsDeleted} pagamento(s) órfão(s) removido(s).`,
            bookingsCleaned: cleaned,
            paymentsDeleted,
        });
    } catch (err) {
        console.error('[Cleanup] Error:', err);
        res.status(500).json({ error: 'Erro na limpeza.' });
    }
});

// ─── POST /api/bookings/:id/addons (Purchase Addon) ─────

router.post('/:id/addons', authenticate, async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const data = addOnPurchaseSchema.parse(req.body);
        const userId = req.user!.userId;

        // Normalize: accept single addonKey or array of addonKeys
        const keys: string[] = data.addonKeys || (data.addonKey ? [data.addonKey] : []);

        // Services can be hired for upcoming sessions AND for completed recordings
        // (post-production add-ons like cortes/capa). Only FALTA/NAO_REALIZADO/CANCELLED are blocked.
        const booking = await prisma.booking.findFirst({
            where: { id, userId, status: { in: ['RESERVED', 'CONFIRMED', 'COMPLETED'] } },
            include: { contract: true }
        });

        if (!booking) {
            res.status(404).json({ error: 'Agendamento não encontrado ou não disponível para edição.' });
            return;
        }

        // FIN-08: reserva avulsa do próprio cliente ainda no prazo de pagamento (hold) — os extras vão no mesmo
        // checkout da reserva. Uma cobrança só de extra paga aqui confirmaria a reserva e ativaria o avulso com o
        // pagamento da sessão em aberto (confirmBookingAndActivateContract / varredura dos holds).
        if (booking.holdExpiresAt) {
            res.status(409).json({
                error: 'Conclua o pagamento da reserva antes de contratar serviços extras.',
                code: 'BOOKING_AWAITING_PAYMENT',
            });
            return;
        }

        // Filter out already-active addons
        const newKeys = keys.filter(k => !booking.addOns.includes(k));
        if (newKeys.length === 0) {
            res.status(400).json({ error: 'Todos os serviços selecionados já estão ativos neste episódio.' });
            return;
        }

        // Validate all addon keys exist
        const addonConfigs = await prisma.addOnConfig.findMany({
            where: { key: { in: newKeys } }
        });
        if (addonConfigs.length !== newKeys.length) {
            const found = addonConfigs.map(a => a.key);
            const missing = newKeys.filter(k => !found.includes(k));
            res.status(404).json({ error: `Serviço(s) não encontrado(s): ${missing.join(', ')}` });
            return;
        }

        // Split: contract addons (free) vs paid addons
        const contractKeys = newKeys.filter(k => booking.contract?.addOns?.includes(k));
        const paidKeys = newKeys.filter(k => !booking.contract?.addOns?.includes(k));

        // Activate contract addons immediately (no payment needed)
        if (contractKeys.length > 0) {
            await prisma.booking.update({
                where: { id },
                data: { addOns: { push: contractKeys } }
            });
        }

        // For paid addons: create ONE combined payment
        if (paidKeys.length > 0) {
            let totalPrice = 0;
            for (const key of paidKeys) {
                const config = addonConfigs.find(a => a.key === key)!;
                let price = config.price;
                if (booking.contract) {
                    price = applyDiscount(price, booking.contract.discountPct);
                }
                totalPrice += price;
            }

            const payment = await prisma.payment.create({
                data: {
                    userId,
                    contractId: booking.contract?.id || null,
                    bookingId: id,
                    provider: getProviderForMethod('CARTAO'),
                    amount: totalPrice,
                    status: 'PENDING',
                    dueDate: new Date(),
                    // Store ALL addon keys in metadata for post-payment activation
                    paymentUrl: JSON.stringify({ addonKeys: paidKeys }),
                }
            });

            // R5 (corrida com o cancelamento/exclusão pela equipe): a reserva foi lida antes; se ela deixou de aceitar
            // extras no meio (cancelada, excluída, falta…), esta cobrança recém-criada — ainda sem emissão no provedor —
            // é retirada aqui mesmo, em vez de ficar presa a uma gravação cancelada.
            const still = await prisma.booking.findFirst({
                where: { id, userId, status: { in: ['RESERVED', 'CONFIRMED', 'COMPLETED'] } },
                select: { id: true },
            });
            if (!still) {
                await prisma.payment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
                res.status(409).json({ error: 'Esta gravação não aceita mais serviços extras (foi cancelada ou alterada). Atualize a tela.', code: 'BOOKING_NOT_EDITABLE' });
                return;
            }

            res.status(200).json({
                message: contractKeys.length > 0
                    ? `${contractKeys.length} serviço(s) do plano ativado(s). Cobrança gerada para ${paidKeys.length} serviço(s) avulso(s).`
                    : 'Cobrança gerada. O serviço será ativado após a confirmação do pagamento.',
                paymentId: payment.id,
                amount: totalPrice,
                activatedKeys: contractKeys,
                pendingKeys: paidKeys,
            });
            return;
        }

        // All were contract addons (no payment needed)
        res.status(200).json({
            message: 'Serviço(s) incluso(s) no plano ativado(s) com sucesso.',
            paymentId: '',
            amount: 0,
            activatedKeys: contractKeys,
            pendingKeys: [],
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Erro interno ao processar compra do serviço.' });
    }
});

} // end registerManagementRoutes
