import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { requirePermissionIfStaff, routeActor } from '../bookings/permissionGuards.js';
import {
    getContractSlotGrid, checkSlotInGrid, checkCustomScheduleInGrid, slotAllowedForContract,
    planCustomOccurrences, getPackageSlots, weekdayOfDateStr,
} from '../../utils/pricing.js';
import { getConfig } from '../../lib/businessConfig.js';
import { getPublicDayAvailability, buildOccupiedSet } from '../bookings/availability.service.js';
import { checkFixoSchema, customCheckSchema, slotOptionsQuerySchema } from './validators.js';
import {
    purgeExpiredCustomAwaiting, discardClientCustomAttempts, previousCustomAttemptError, tomorrowInSaoPaulo,
    clientStartDateError, customUserLockKey, CUSTOM_USER_LOCK_TTL_SECONDS, CUSTOM_IN_PROGRESS_ERROR,
} from './contract.creation.js';
import { acquireMutex, releaseMutex } from '../../lib/redis.js';

/** `userId` opcional do /custom/check da equipe (cliente-alvo), fora do customCheckSchema. */
const checkTargetUserSchema = z.string().uuid().optional();

export function registerCheckRoutes(router: Router) {

// ─── GET /api/contracts/slot-options?tier= (grade de horários de CONTRATO — D8) ──
// Fonte única da grade para as telas de contrato (FIXO do admin, /self, personalizado):
// { tier, slotDurationHours, days: [{ dayOfWeek, slots: [{ time, end, tier }] }] } na raiz.
// Registrada antes das rotas /:id (routes.ts monta registerCheckRoutes antes do lifecycle).

router.get('/slot-options', authenticate, async (req: Request, res: Response) => {
    try {
        const { tier } = slotOptionsQuerySchema.parse(req.query);
        res.json(await getContractSlotGrid(tier));
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Faixa inválida. Use COMERCIAL, AUDIENCIA ou SABADO.', details: err.errors });
            return;
        }
        console.error('[slot-options]', err);
        res.status(500).json({ error: 'Erro interno ao carregar os horários' });
    }
});

// ─── POST /api/contracts/check-fixo (Dry-Run Validation) ──

router.post('/check-fixo', authenticate, async (req: Request, res: Response) => {
    try {
        const data = checkFixoSchema.parse(req.body);

        // D8: horário/dia fora da grade de contrato da faixa → 400 "Horário inválido" (nunca "conflito").
        const grid = await getContractSlotGrid(data.tier);
        const slotErr = checkSlotInGrid(grid, data.fixedDayOfWeek, data.fixedTime);
        if (slotErr) {
            res.status(400).json({ error: slotErr, code: 'INVALID_SLOT' });
            return;
        }
        const allowedDays = grid.days.map(d => d.dayOfWeek);

        // Datas em UTC (determinístico; casa com bookings @db.Date = meia-noite UTC).
        const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
        const addDays = (ds: string, n: number) => {
            const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
            return d.toISOString().split('T')[0];
        };
        const weekdayOf = (ds: string) => new Date(ds + 'T00:00:00Z').getUTCDay();

        // Alinha a 1ª ocorrência ao dia-da-semana escolhido.
        let startStr = data.startDate;
        while (weekdayOf(startStr) !== (data.fixedDayOfWeek % 7)) startStr = addDays(startStr, 1);

        const sessionsPerMonth = await getConfig('sessions_per_month');
        const totalWeeks = data.durationMonths * sessionsPerMonth;

        const expected: string[] = [];
        for (let i = 0, ds = startStr; i < totalWeeks; i++, ds = addDays(ds, 7)) expected.push(ds);

        // Disponibilidade por dia (memoizada) reusando o serviço canônico (respeita dia de
        // operação, tier por horário e ocupação — bookings não-cancelados + blocked slots).
        const availCache = new Map<string, Awaited<ReturnType<typeof getPublicDayAvailability>>>();
        const dayAvail = async (ds: string) => {
            let av = availCache.get(ds);
            if (!av) { av = await getPublicDayAvailability(ds); availCache.set(ds, av); }
            return av;
        };
        // Horários livres que o contrato pode usar num dia (hierarquia de faixas — D8 — e só nos
        // dias permitidos da faixa), ordenados por proximidade ao horário fixo.
        const freeTierSlots = async (ds: string): Promise<string[]> => {
            if (!allowedDays.includes(weekdayOf(ds))) return [];
            const av = await dayAvail(ds);
            if (av.closed) return [];
            return av.slots.filter(s => s.available && slotAllowedForContract(data.tier, s.tier)).map(s => s.time)
                .sort((a, b) => Math.abs(toMin(a) - toMin(data.fixedTime)) - Math.abs(toMin(b) - toMin(data.fixedTime)));
        };
        // Dia livre mais próximo ANTES (-1) ou DEPOIS (+1) de uma data, mesmo tier (até ±7 dias).
        const nearestFreeDay = async (aroundStr: string, dir: -1 | 1): Promise<{ date: string; time: string } | null> => {
            for (let off = 1; off <= 7; off++) {
                const ds = addDays(aroundStr, dir * off);
                // Nunca sugerir data ANTERIOR ao início do contrato (nem no passado — startDate >= hoje).
                if (dir === -1 && ds < data.startDate) break;
                const free = await freeTierSlots(ds);
                if (free.length) return { date: ds, time: free.includes(data.fixedTime) ? data.fixedTime : free[0] };
            }
            return null;
        };

        type Alt = { date: string; time: string; kind: 'SAME_DAY' | 'OTHER_DAY' };
        const conflicts: { date: string; originalTime: string; dayFull: boolean; alternatives: Alt[]; suggestedReplacement?: { date: string; time: string } }[] = [];
        let occurrencesWithFreeDay = 0;

        for (const ds of expected) {
            const free = await freeTierSlots(ds);
            if (free.length > 0) occurrencesWithFreeDay++;
            if (free.includes(data.fixedTime)) continue; // horário fixo livre → sem conflito

            if (free.length > 0) {
                // Só o horário fixo está ocupado → troca de HORÁRIO no mesmo dia.
                const alternatives: Alt[] = free.map(t => ({ date: ds, time: t, kind: 'SAME_DAY' }));
                conflicts.push({ date: ds, originalTime: data.fixedTime, dayFull: false, alternatives, suggestedReplacement: alternatives[0] });
            } else {
                // Dia inteiro cheio → oferece OUTRO DIA (antes/depois).
                const [before, after] = await Promise.all([nearestFreeDay(ds, -1), nearestFreeDay(ds, 1)]);
                const alternatives: Alt[] = [
                    ...(before ? [{ ...before, kind: 'OTHER_DAY' as const }] : []),
                    ...(after ? [{ ...after, kind: 'OTHER_DAY' as const }] : []),
                ];
                conflicts.push({ date: ds, originalTime: data.fixedTime, dayFull: true, alternatives, ...(alternatives[0] && { suggestedReplacement: alternatives[0] }) });
            }
        }

        // ── Alternativa de DIA-DA-SEMANA inteiro (ex.: trocar todas as segundas por terças) ──
        // Quando o dia escolhido dá conflito, oferece os OUTROS dias-da-semana (válidos p/ o tier)
        // que tenham o MESMO horário livre ao longo do período — o cliente troca o plano de dia.
        let alternativeWeekdays: { dayOfWeek: number; conflictCount: number; conflictFree: boolean }[] | undefined;
        if (conflicts.length > 0 || (expected.length > 0 && occurrencesWithFreeDay === 0)) {
            const chosenConflicts = conflicts.length || totalWeeks;
            const alts: { dayOfWeek: number; conflictCount: number; conflictFree: boolean }[] = [];
            for (const dow of allowedDays) {
                if (dow === (data.fixedDayOfWeek % 7)) continue;
                // O horário fixo precisa EXISTIR na grade de contrato desse dia-da-semana (senão não serve).
                if (checkSlotInGrid(grid, dow, data.fixedTime)) continue;
                // Alinha ao dia-da-semana candidato.
                let s = data.startDate;
                while (weekdayOf(s) !== (dow % 7)) s = addDays(s, 1);
                const probe = await dayAvail(s);
                if (probe.closed || !probe.slots.some(sl => sl.time === data.fixedTime && slotAllowedForContract(data.tier, sl.tier))) continue;
                let cc = 0;
                for (let i = 0, ds = s; i < totalWeeks; i++, ds = addDays(ds, 7)) {
                    if (!(await freeTierSlots(ds)).includes(data.fixedTime)) cc++;
                }
                if (cc < chosenConflicts) alts.push({ dayOfWeek: dow, conflictCount: cc, conflictFree: cc === 0 });
            }
            alts.sort((a, b) => a.conflictCount - b.conflictCount);
            if (alts.length > 0) alternativeWeekdays = alts;
        }

        // TODAS as ocorrências com o dia cheio → o dia-da-semana em si não tem vaga.
        if (expected.length > 0 && occurrencesWithFreeDay === 0) {
            // Previsão: 1ª data futura NESSE dia-da-semana com horário do tier livre (até 26 semanas).
            let forecast: string | null = null;
            for (let i = 0, ds = startStr; i < 26; i++, ds = addDays(ds, 7)) {
                if ((await freeTierSlots(ds)).length) { forecast = ds; break; }
            }
            res.json({ available: false, weekdayUnavailable: true, forecast, conflicts: [], ...(alternativeWeekdays && { alternativeWeekdays }) });
            return;
        }

        if (conflicts.length > 0) {
            res.json({ available: false, conflicts, ...(alternativeWeekdays && { alternativeWeekdays }) });
            return;
        }

        res.json({ available: true, conflicts: [] });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Parâmetros inválidos', details: err.errors });
            return;
        }
        console.error('[check-fixo]', err);
        res.status(500).json({ error: 'Erro interno ao validar agenda' });
    }
});

// ─── POST /api/contracts/custom/check (Dry-Run multi-day) ──
// Gera as MESMAS ocorrências do POST /custom (planCustomOccurrences: frequência, padrão de
// semanas, datas livres e teto C8) e aponta as que caem em horário ocupado (pacote inteiro vs.
// reservas não canceladas + bloqueios), sugerindo outro horário VÁLIDO da grade no mesmo dia.
// Devolve TODOS os conflitos: o POST /custom recusa (409) qualquer ocorrência sem resolução, então
// a tela precisa ver cada uma para decidir (aceitar só quando todas têm sugestão).

// Rota MISTA: a equipe precisa de `contratos.criar` (sem ela, 403 — nunca o ramo do cliente).
router.post('/custom/check', authenticate, requirePermissionIfStaff('contratos.criar'), async (req: Request, res: Response) => {
    try {
        const actor = await routeActor(req, res);
        if (!actor) return;
        const data = customCheckSchema.parse(req.body);
        const frequency = data.frequency ?? 'WEEKLY';
        // Equipe com contratos.criar (conferido pela guarda): início livre e só descarta tentativas VENCIDAS.
        const isStaff = actor.isStaff;

        // D8: cada item precisa estar na grade de contrato da faixa → 400 "Horário inválido".
        const grid = await getContractSlotGrid(data.tier);
        const slotErr = checkCustomScheduleInGrid(grid, { frequency, schedule: data.schedule, customDates: data.customDates });
        if (slotErr) {
            res.status(400).json({ error: slotErr, code: 'INVALID_SLOT' });
            return;
        }

        // D7: o CLIENTE simula com o mesmo início fixo que a criação exige (amanhã, SP).
        if (!isStaff) {
            const tomorrowSp = tomorrowInSaoPaulo();
            if (data.startDate !== tomorrowSp) {
                res.status(400).json(clientStartDateError(tomorrowSp));
                return;
            }
        }

        // Tentativas anteriores não pagas saem antes (mesma rotina segura da varredura), para as sessões
        // RESERVED delas não aparecerem como conflito:
        //  - CLIENTE: o check vem logo antes da criação ("Ir para pagamento") → a nova tentativa substitui a
        //    anterior, viva ou vencida. Paga / pagamento em andamento → 409 (igual ao POST /custom).
        //  - EQUIPE: só as VENCIDAS do cliente-alvo (`userId`, se informado; sem ele, nada é descartado).
        if (!isStaff) {
            const userId = req.user!.userId;
            const lockKey = customUserLockKey(userId);
            // Nunca descartar a tentativa que um POST /custom deste cliente está gravando agora.
            if (!(await acquireMutex(lockKey, CUSTOM_USER_LOCK_TTL_SECONDS))) {
                res.status(409).json(CUSTOM_IN_PROGRESS_ERROR);
                return;
            }
            let prev: Awaited<ReturnType<typeof discardClientCustomAttempts>>;
            try {
                prev = await discardClientCustomAttempts(userId);
            } finally {
                await releaseMutex(lockKey).catch(() => {});
            }
            if (prev !== 'ok') {
                res.status(409).json(previousCustomAttemptError(prev));
                return;
            }
        } else {
            const targetParsed = checkTargetUserSchema.safeParse(req.body?.userId);
            if (targetParsed.success && targetParsed.data) await purgeExpiredCustomAwaiting(targetParsed.data);
        }

        const occurrences = planCustomOccurrences({
            frequency,
            durationMonths: data.durationMonths,
            schedule: data.schedule,
            weekPattern: data.weekPattern,
            customDates: data.customDates,
            startDate: data.startDate,
        });

        const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
        const slotDuration = grid.slotDurationHours;
        // Ocupação por dia (memoizada). As ocorrências já aceitas nesta simulação também ocupam
        // (duas ocorrências do próprio pedido nunca podem se sobrepor).
        const occupiedByDay = new Map<string, Set<string>>();
        const occupiedOn = async (ds: string): Promise<Set<string>> => {
            let set = occupiedByDay.get(ds);
            if (!set) { set = await buildOccupiedSet(new Date(ds + 'T00:00:00Z')); occupiedByDay.set(ds, set); }
            return set;
        };
        const overlaps = (time: string, occupied: Set<string>) => getPackageSlots(time, slotDuration).some(s => occupied.has(s));
        // Pacotes das ocorrências do PRÓPRIO plano por dia: a sugestão nunca cai num horário que o plano já
        // usa mais tarde no mesmo dia (senão a criação trocaria um conflito por outro).
        const ownByDay = new Map<string, Set<string>>();
        for (const occ of occurrences) {
            const set = ownByDay.get(occ.date) ?? new Set<string>();
            getPackageSlots(occ.time, slotDuration).forEach(s => set.add(s));
            ownByDay.set(occ.date, set);
        }

        const conflicts: { date: string; originalTime: string; day: number; suggestedReplacement?: { date: string; time: string } }[] = [];

        for (const occ of occurrences) {
            const occupied = await occupiedOn(occ.date);
            if (!overlaps(occ.time, occupied)) {
                getPackageSlots(occ.time, slotDuration).forEach(s => occupied.add(s));
                continue;
            }
            const own = ownByDay.get(occ.date) ?? new Set<string>();
            const daySlots = grid.days.find(d => d.dayOfWeek === weekdayOfDateStr(occ.date))?.slots ?? [];
            const alternative = daySlots
                .map(s => s.time)
                .filter(t => t !== occ.time && !overlaps(t, occupied) && !overlaps(t, own))
                .sort((a, b) => Math.abs(toMin(a) - toMin(occ.time)) - Math.abs(toMin(b) - toMin(occ.time)))[0];
            // A sugestão passa a ocupar o dia (a criação a aplica nesta mesma ordem): duas ocorrências em
            // conflito no mesmo dia nunca recebem o mesmo horário substituto.
            if (alternative) getPackageSlots(alternative, slotDuration).forEach(s => occupied.add(s));
            conflicts.push({
                date: occ.date,
                originalTime: occ.time,
                day: occ.day,
                ...(alternative && { suggestedReplacement: { date: occ.date, time: alternative } }),
            });
        }

        // TODOS os conflitos (o teto do schema — 14 itens × 12 ciclos / 366 datas — limita o payload).
        res.json({
            available: conflicts.length === 0,
            conflicts,
            totalConflicts: conflicts.length,
            totalSessions: occurrences.length,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Parâmetros inválidos', details: err.errors });
            return;
        }
        console.error('Erro ao validar agenda custom:', err);
        res.status(500).json({ error: 'Erro interno ao validar agenda' });
    }
});

} // end registerCheckRoutes
