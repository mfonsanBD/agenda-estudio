import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma.js';
import { logAudit } from '../../lib/audit.js';
import { authenticate, revokeUserSessions } from '../../middleware/auth.js';
import { enforceRuleResult, requirePermission, requireStaff, requireAdmin, can, type Actor } from '../../middleware/permissions.js';
import { routeActor } from '../bookings/permissionGuards.js';
import { requiredForUserCreate, requiredForUserPatch } from '../../lib/permissionRules.js';
import { cleanDocument, isValidCpfCnpj } from '../../utils/document.js';
import { formatBRL } from '../../utils/pricing.js';
import {
    deleteUser, getDeletionPreview, assertUserDeletable, UserDeletionError,
    deletionMissingPermissions, deletionMissingPermissionsMessage, type DeletionSettleKey,
    getPurgePreview, purgeUser,
} from '../../lib/userDeletion.js';
import { StaffError } from '../staff/staff.service.js';

/**
 * AUDFIN-04: o `can` da exclusão para o ator — ADMIN não confere nada (como antes); a equipe precisa também da chave
 * de tudo que a exclusão anularia (lib/userDeletion.deletionSettleRequirements).
 */
const deletionCan = (actor: Actor): ((key: DeletionSettleKey) => boolean) | undefined =>
    actor.isAdmin ? undefined : (key) => can(actor, key);
import { notifyLoginEmailChanged } from '../staff/staffMail.js';

// /api/users trata SÓ de CLIENTE (D1/D9). Permissões por rota (matriz da Equipe):
//   POST /              clientes.criar (+ regras do corpo: senha só ADMIN; nascer BLOCKED = clientes.acesso)
//   PATCH /:id          equipe + requiredForUserPatch (por VALOR alterado: cadastro = clientes.editar;
//                       e-mail de login e bloqueio = clientes.acesso; senha = só ADMIN; CPF ainda vazio
//                       também com cobrancas.cobrar)
//   deletion-preview e DELETE   clientes.excluir (alvo da equipe → 400 de assertUserDeletable, I1)
//   payment-overview    clientes.ver, financeiro.ver ou cobrancas.automatica (DECISOES resposta 3)
//   (trocar o e-mail de login zera o googleId — AUTH-03)
//   auto-charge         cobrancas.automatica
// `role` não se altera aqui: 'CLIENTE' é aceito e ignorado (PWA antiga); outro valor → 400.
// Alvo que não é CLIENTE → 404 (a equipe não é revelada por aqui).

const CLIENT_NOT_FOUND = { error: 'Cliente não encontrado.' } as const;
const EMAIL_TAKEN = { error: 'E-mail já cadastrado em outra conta.', code: 'EMAIL_TAKEN' } as const;

/** Conta com este e-mail sem diferenciar maiúsculas (crítica E6), opcionalmente ignorando `exceptId`. */
function findOtherByEmail(email: string, exceptId?: string) {
    return prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
        select: { id: true },
    });
}

/** P2002 (UNIQUE): e-mail ou CPF/CNPJ repetido numa corrida entre a checagem e a gravação. */
function uniqueViolationBody(err: unknown): { error: string; code?: string } | null {
    if (!err || typeof err !== 'object' || (err as { code?: string }).code !== 'P2002') return null;
    const meta = JSON.stringify((err as { meta?: unknown }).meta ?? '');
    return /email/i.test(meta) ? { ...EMAIL_TAKEN } : { error: 'Este CPF/CNPJ já está cadastrado em outra conta.' };
}

/**
 * Normalizes a CPF/CNPJ to digits-only and validates the check digits.
 * Returns { ok:false } when present-but-invalid so callers can 400.
 */
function normalizeCpfCnpj(value: string | null | undefined): { ok: true; value: string | null } | { ok: false } {
    if (value === undefined) return { ok: true, value: null };
    const digits = cleanDocument(value);
    if (digits && !isValidCpfCnpj(digits)) return { ok: false };
    return { ok: true, value: digits || null };
}

// ─── POST /api/users (equipe cria CLIENTE) ──────────────
// Toda chave daqui precisa de regra em lib/permissionRules.ts (USER_CREATE_FIELDS) — teste unitário.
// `password` é opcional: só o ADMIN define senha de cliente (crítica F8); sem senha, o cliente entra
// pelo código no e-mail ('' ou null contam como "sem senha", para o formulário que esconde o campo).
// `role` só existe para a PWA antiga: 'CLIENTE' é ignorado, outro valor → 400.

const createUserSchema = z.object({
    email: z.string().trim().toLowerCase().email(),
    password: z.preprocess(v => (v === '' || v === null ? undefined : v), z.string().min(6).optional()),
    name: z.string().min(2),
    phone: z.string().optional(),
    role: z.string().optional(),
    notes: z.string().optional(),
    cpfCnpj: z.string().optional().nullable(),
    address: z.string().optional().nullable(),
    addressNumber: z.string().optional().nullable(),
    complement: z.string().optional().nullable(),
    neighborhood: z.string().optional().nullable(),
    city: z.string().optional().nullable(),
    state: z.string().max(2).optional().nullable(),
    zipCode: z.string().max(9).optional().nullable(),
    tags: z.array(z.string()).optional(),
    socialLinks: z.string().optional().nullable(),
    clientStatus: z.enum(['ACTIVE', 'INACTIVE', 'BLOCKED']).optional(),
});

// ─── PATCH /api/users/:id (equipe edita CLIENTE) ────────
// Toda chave daqui precisa de regra em lib/permissionRules.ts (USER_PATCH_FIELDS) — teste unitário.

const updateUserSchema = z.object({
    name: z.string().min(2).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    phone: z.string().optional(),
    role: z.string().optional(),
    password: z.string().min(6).optional(),
    notes: z.string().optional(),
    cpfCnpj: z.string().optional().nullable(),
    address: z.string().optional().nullable(),
    addressNumber: z.string().optional().nullable(),
    complement: z.string().optional().nullable(),
    neighborhood: z.string().optional().nullable(),
    city: z.string().optional().nullable(),
    state: z.string().max(2).optional().nullable(),
    zipCode: z.string().max(9).optional().nullable(),
    tags: z.array(z.string()).optional(),
    socialLinks: z.string().optional().nullable(),
    clientStatus: z.enum(['ACTIVE', 'INACTIVE', 'BLOCKED']).optional(),
});

export function registerUserCrudRoutes(router: Router) {
    // ─── POST /api/users (equipe cria CLIENTE) ──────────────

    router.post('/', authenticate, requirePermission('clientes.criar'), async (req: Request, res: Response) => {
        try {
            const data = createUserSchema.parse(req.body);
            if (!(await enforceRuleResult(req, res, requiredForUserCreate(data)))) return;

            if (await findOtherByEmail(data.email)) {
                res.status(409).json({ ...EMAIL_TAKEN });
                return;
            }

            const cpf = normalizeCpfCnpj(data.cpfCnpj);
            if (!cpf.ok) {
                res.status(400).json({ error: 'CPF/CNPJ inválido. Confira os números.' });
                return;
            }

            const passwordHash = data.password ? await bcrypt.hash(data.password, 12) : null;

            const user = await prisma.user.create({
                data: {
                    email: data.email,
                    passwordHash,
                    name: data.name,
                    phone: data.phone,
                    role: 'CLIENTE', // sempre: a equipe se cria na tela Equipe (/api/staff)
                    ...(data.notes ? { notes: data.notes } : {}),
                    ...(cpf.value !== null ? { cpfCnpj: cpf.value } : {}),
                    ...(data.tags ? { tags: data.tags } : {}),
                    ...(data.socialLinks !== undefined ? { socialLinks: data.socialLinks } : {}),
                    ...(data.address !== undefined ? { address: data.address } : {}),
                    ...(data.addressNumber !== undefined ? { addressNumber: data.addressNumber } : {}),
                    ...(data.complement !== undefined ? { complement: data.complement } : {}),
                    ...(data.neighborhood !== undefined ? { neighborhood: data.neighborhood } : {}),
                    ...(data.city !== undefined ? { city: data.city } : {}),
                    ...(data.state !== undefined ? { state: data.state } : {}),
                    ...(data.zipCode !== undefined ? { zipCode: data.zipCode } : {}),
                    ...(data.clientStatus ? { clientStatus: data.clientStatus as any } : {}),
                },
                select: { id: true, email: true, name: true, phone: true, role: true, createdAt: true },
            });

            await logAudit('USER', user.id, 'CLIENT_CREATED', req.user!.userId, {
                withPassword: !!passwordHash,
                clientStatus: data.clientStatus ?? 'ACTIVE',
            });

            res.status(201).json({ user, message: `Cliente ${data.name} cadastrado com sucesso.` });
        } catch (err) {
            if (err instanceof z.ZodError) {
                res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
                return;
            }
            const unique = uniqueViolationBody(err);
            if (unique) {
                res.status(409).json(unique);
                return;
            }
            console.error('[USERS] create', err);
            if (!res.headersSent) res.status(500).json({ error: 'Erro ao cadastrar o cliente.' });
        }
    });

    // ─── PATCH /api/users/:id (equipe edita CLIENTE) ────────

    router.patch('/:id', authenticate, requireStaff(), async (req: Request, res: Response) => {
        try {
            const id = req.params.id as string;
            const data = updateUserSchema.parse(req.body);

            const existing = await prisma.user.findUnique({ where: { id } });
            if (!existing || existing.role !== 'CLIENTE') {
                res.status(404).json({ ...CLIENT_NOT_FOUND });
                return;
            }
            // D3: cadastro excluído (anonimizado) é só histórico — não pode ser reeditado.
            if (existing.deletedAt) {
                res.status(409).json({ error: 'Este cliente foi excluído. O cadastro não pode ser alterado.' });
                return;
            }

            // Permissão pelo que MUDA (registro completo como alvo). Corpo sem mudança nenhuma ainda exige
            // alguém que poderia editar algo do cliente (não vira leitura gratuita do cadastro).
            const rule = requiredForUserPatch(data, existing);
            if (rule.requirements.length === 0) {
                rule.requirements.push({ anyOf: ['clientes.editar', 'clientes.acesso', 'cobrancas.cobrar'], field: '*' });
            }
            if (!(await enforceRuleResult(req, res, rule))) return;

            // E-mail de login: comparado sem maiúsculas. Diferença só de caixa = normalização (sem revogar).
            const currentEmail = (existing.email ?? '').trim().toLowerCase();
            const emailChanged = data.email !== undefined && data.email !== currentEmail;
            const writeEmail = data.email !== undefined && data.email !== existing.email;
            if (writeEmail && (await findOtherByEmail(data.email!, id))) {
                res.status(409).json({ ...EMAIL_TAKEN });
                return;
            }

            const updateData: any = {};
            if (data.name) updateData.name = data.name;
            if (writeEmail) updateData.email = data.email;
            // E-mail de login trocado de fato (AUTH-03): desfaz o vínculo com o Google. O /auth/google acha a
            // conta pelo googleId ANTES do e-mail; sem isto, o dono do endereço antigo (ex.: e-mail digitado
            // errado) seguiria entrando na conta do cliente pelo Google. Só maiúsculas diferentes não desvincula.
            if (emailChanged) updateData.googleId = null;
            if (data.phone !== undefined) updateData.phone = data.phone;
            // `role` nunca é gravado aqui ('CLIENTE' aceito e ignorado; outro valor já foi recusado com 400).
            if (data.notes !== undefined) updateData.notes = data.notes;
            if (data.cpfCnpj !== undefined) {
                const cpf = normalizeCpfCnpj(data.cpfCnpj);
                if (!cpf.ok) {
                    res.status(400).json({ error: 'CPF/CNPJ inválido. Confira os números.' });
                    return;
                }
                updateData.cpfCnpj = cpf.value;
            }
            if (data.address !== undefined) updateData.address = data.address;
            if (data.addressNumber !== undefined) updateData.addressNumber = data.addressNumber;
            if (data.complement !== undefined) updateData.complement = data.complement;
            if (data.neighborhood !== undefined) updateData.neighborhood = data.neighborhood;
            if (data.city !== undefined) updateData.city = data.city;
            if (data.state !== undefined) updateData.state = data.state;
            if (data.zipCode !== undefined) updateData.zipCode = data.zipCode;
            if (data.tags !== undefined) updateData.tags = data.tags;
            if (data.socialLinks !== undefined) updateData.socialLinks = data.socialLinks;
            if (data.clientStatus) updateData.clientStatus = data.clientStatus;
            if (data.password) {
                updateData.passwordHash = await bcrypt.hash(data.password, 12);
            }

            const user = await prisma.user.update({
                where: { id },
                data: updateData,
                select: { id: true, email: true, name: true, phone: true, role: true, createdAt: true },
            });

            // D3: bloquear encerra NA HORA a sessão já aberta do cliente (o login/refresh já recusam
            // conta bloqueada; sem isto o access token residual valia por até 1h). Trocar o e-mail de login
            // ou a senha também encerra (crítica F8: quem tinha a sessão não segue dentro da conta).
            const newlyBlocked = data.clientStatus === 'BLOCKED' && existing.clientStatus !== 'BLOCKED';
            const passwordSet = !!data.password;
            if (newlyBlocked || emailChanged || passwordSet) {
                await revokeUserSessions(id);
            }
            if (emailChanged && existing.email && data.email) {
                notifyLoginEmailChanged(existing.email, data.email, existing.name);
            }

            // Auditoria (sem valores sensíveis): campos de cadastro alterados e, à parte, o acesso ao app.
            const actorId = req.user!.userId;
            const before = existing as unknown as Record<string, unknown>;
            const profileFields = Object.keys(updateData).filter(k =>
                !['email', 'googleId', 'passwordHash', 'clientStatus'].includes(k)
                && JSON.stringify(updateData[k] ?? null) !== JSON.stringify(before[k] ?? null));
            const statusChanged = data.clientStatus !== undefined && data.clientStatus !== existing.clientStatus;
            const accessBlockChange = statusChanged && (data.clientStatus === 'BLOCKED' || existing.clientStatus === 'BLOCKED');
            if (statusChanged && !accessBlockChange) profileFields.push('clientStatus');
            if (profileFields.length > 0) await logAudit('USER', id, 'CLIENT_UPDATED', actorId, { fields: profileFields });
            if (emailChanged || passwordSet || accessBlockChange) {
                await logAudit('USER', id, 'CLIENT_ACCESS_CHANGED', actorId, {
                    ...(emailChanged ? { email: true } : {}),
                    ...(passwordSet ? { password: true } : {}),
                    ...(accessBlockChange ? { blocked: data.clientStatus === 'BLOCKED' } : {}),
                });
            }

            res.json({ user, message: 'Cliente atualizado com sucesso.' });
        } catch (err) {
            if (err instanceof z.ZodError) {
                res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
                return;
            }
            const unique = uniqueViolationBody(err);
            if (unique) {
                res.status(409).json(unique);
                return;
            }
            console.error('[USERS] update', err);
            if (!res.headersSent) res.status(500).json({ error: 'Erro ao atualizar o cliente.' });
        }
    });

    // ─── GET /api/users/:id/deletion-preview (clientes.excluir) ──
    // D3: consequências reais da exclusão para o modal (modo hard × soft, o que será cancelado/anulado,
    // o que fica preservado). Mesmas recusas do DELETE (auto-exclusão, conta da equipe, já excluído) —
    // assertUserDeletable (400) roda antes de qualquer 404 de alvo (crítica I1).
    router.get('/:id/deletion-preview', authenticate, requirePermission('clientes.excluir'), async (req: Request, res: Response) => {
        try {
            const id = req.params.id as string;
            await assertUserDeletable(id, req.user!.userId);
            const actor = await routeActor(req, res);
            if (!actor) return;
            // AUDFIN-04: o modal já sabe se o DELETE vai recusar (403) por faltar a chave do que a exclusão anularia.
            const missingPermissions = await deletionMissingPermissions(id, deletionCan(actor));
            res.json({
                preview: {
                    ...(await getDeletionPreview(id)),
                    missingPermissions,
                    blockedMessage: missingPermissions.length > 0 ? deletionMissingPermissionsMessage(missingPermissions) : null,
                },
            });
        } catch (err) {
            if (err instanceof UserDeletionError) {
                res.status(err.httpStatus).json({ error: err.message });
                return;
            }
            console.error('[USER-DELETION-PREVIEW]', err);
            res.status(500).json({ error: 'Erro ao calcular as consequências da exclusão.' });
        }
    });

    // ─── DELETE /api/users/:id (clientes.excluir) ───────────
    // D3: sem nenhum vínculo de negócio → exclusão física; com qualquer vínculo → soft delete com
    // anonimização, cancelando contratos em andamento, gravações futuras e cobranças PENDING
    // (histórico PAID preservado). Regras em lib/userDeletion.ts (conta da equipe → 400).
    router.delete('/:id', authenticate, requirePermission('clientes.excluir'), async (req: Request, res: Response) => {
        try {
            const id = req.params.id as string;
            const actor = await routeActor(req, res);
            if (!actor) return;
            const result = await deleteUser(id, req.user!.userId, new Date(), { can: deletionCan(actor) });
            const { contracts, bookings, payments } = result.cancelled;
            const parts: string[] = [];
            if (contracts > 0) parts.push(`${contracts} contrato(s) cancelado(s)`);
            if (bookings > 0) parts.push(`${bookings} gravação(ões) futura(s) cancelada(s)`);
            if (payments > 0) parts.push(`${payments} cobrança(s) pendente(s) anulada(s)`);
            const paidLate = result.paidDuringDeletion;
            const paidNote = paidLate.payments > 0
                ? ` Atenção: ${paidLate.payments} pagamento(s) (${formatBRL(paidLate.amount)}) foi(ram) confirmado(s) no provedor durante a exclusão e ficou(aram) registrado(s) como pago(s), sem estorno automático — avalie a devolução.`
                : '';
            const message = result.softDeleted
                ? `Cliente excluído. Dados pessoais removidos; histórico preservado.${parts.length ? ` ${parts.join(', ')}.` : ''}${paidNote}`
                : 'Cliente excluído definitivamente.';
            res.json({ message, softDeleted: result.softDeleted, cancelled: result.cancelled, paidDuringDeletion: paidLate });
        } catch (err) {
            if (err instanceof UserDeletionError) {
                res.status(err.httpStatus).json({ error: err.message, ...(err.extra ?? {}) });
                return;
            }
            console.error('[DELETE USER ERROR]:', err);
            res.status(500).json({ error: 'Erro ao excluir o cliente.' });
        }
    });

    // ─── Exclusão DEFINITIVA (só o ADMIN; qualquer conta) ───
    // Apaga a conta e tudo o que é dela (contratos, gravações, cobranças, resgates de cupom). Regras em
    // lib/userDeletion.ts (purgeUser): não a própria conta, nunca o último administrador ativo.
    const purgeErrorBody = (err: unknown, res: Response): boolean => {
        if (err instanceof UserDeletionError) {
            res.status(err.httpStatus).json({ error: err.message, ...(err.extra ?? {}) });
            return true;
        }
        if (err instanceof StaffError) {
            res.status(err.status).json(err.body());
            return true;
        }
        return false;
    };

    router.get('/:id/purge-preview', authenticate, requireAdmin(), async (req: Request, res: Response) => {
        try {
            res.json({ preview: await getPurgePreview(req.params.id as string, req.user!.userId) });
        } catch (err) {
            if (purgeErrorBody(err, res)) return;
            console.error('[USER-PURGE-PREVIEW]', err);
            res.status(500).json({ error: 'Erro ao calcular o que será apagado.' });
        }
    });

    router.delete('/:id/permanent', authenticate, requireAdmin(), async (req: Request, res: Response) => {
        try {
            const result = await purgeUser(req.params.id as string, req.user!.userId);
            const who = result.role === 'CLIENTE' ? 'Cliente' : result.role === 'ADMIN' ? 'Administrador' : 'Colaborador';
            res.json({ message: `${who} excluído definitivamente.`, removed: result.removed });
        } catch (err) {
            if (purgeErrorBody(err, res)) return;
            console.error('[USER-PURGE]', err);
            res.status(500).json({ error: 'Erro ao excluir a conta.' });
        }
    });

    // ─── GET /api/users/:id/payment-overview (clientes.ver, financeiro.ver ou cobrancas.automatica) ──
    // The staff's window into a client's billing: auto-charge status, saved cards (last4),
    // and upcoming/overdue installments — mirrors what the client sees in "Meus Pagamentos".
    // DECISOES resposta 3: sem financeiro.ver some SÓ a receita consolidada; o card "Pagamento" do perfil
    // (parcelas, cartão salvo, status da cobrança automática) segue para quem abre o perfil (clientes.ver).
    // Ligar/desligar a cobrança automática continua só com cobrancas.automatica (PATCH /auto-charge).
    router.get('/:id/payment-overview', authenticate, requirePermission('clientes.ver', 'financeiro.ver', 'cobrancas.automatica'), async (req: Request, res: Response) => {
        try {
            const userId = req.params.id as string;
            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: { autoChargeEnabled: true, stripeCustomerId: true, role: true },
            });
            if (!user || user.role !== 'CLIENTE') { res.status(404).json({ ...CLIENT_NOT_FOUND }); return; }

            const cards = await prisma.savedPaymentMethod.findMany({
                where: { userId },
                select: { id: true, brand: true, last4: true, expMonth: true, expYear: true, isDefault: true },
                orderBy: { isDefault: 'desc' },
            });

            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const duePayments = await prisma.payment.findMany({
                where: { userId, status: 'PENDING' },
                orderBy: { dueDate: 'asc' },
                take: 36,
                select: { id: true, amount: true, dueDate: true, provider: true, contract: { select: { name: true } } },
            });

            res.json({
                autoChargeEnabled: user.autoChargeEnabled,
                hasSavedCard: cards.length > 0,
                cards,
                duePayments: duePayments.map(p => ({
                    id: p.id,
                    amount: p.amount,
                    dueDate: p.dueDate,
                    overdue: p.dueDate ? p.dueDate < today : false,
                    contractName: p.contract?.name ?? 'Avulso',
                })),
            });
        } catch (err) {
            console.error('[PAYMENT-OVERVIEW]', err);
            res.status(500).json({ error: 'Erro ao carregar a visão de pagamento.' });
        }
    });

    // ─── PATCH /api/users/:id/auto-charge (cobrancas.automatica) ──
    // Staff toggles a client's automatic charging (enabling requires a saved CREDIT card — checkAutoChargeCard).
    router.patch('/:id/auto-charge', authenticate, requirePermission('cobrancas.automatica'), async (req: Request, res: Response) => {
        try {
            const userId = req.params.id as string;
            const enabled = !!req.body?.enabled;
            const target = await prisma.user.findUnique({ where: { id: userId }, select: { deletedAt: true, role: true, autoChargeEnabled: true } });
            if (!target || target.role !== 'CLIENTE') { res.status(404).json({ ...CLIENT_NOT_FOUND }); return; }
            if (target.deletedAt) {
                res.status(409).json({ error: 'Este cliente foi excluído. O cadastro não pode ser alterado.' });
                return;
            }
            if (enabled) {
                // AC-3 / E9 "só crédito": a MESMA conferência de quem liga pelo cliente (PUT /stripe/auto-charge
                // e /contracts/:id/subscribe) — o cartão que o autoChargeJob vai cobrar existe, é do cliente e é
                // de crédito. Mesmos códigos, mensagens na 3ª pessoa. Desligar nunca consulta o Stripe.
                const { checkAutoChargeCard, pinAutoChargeCard } = await import('../../lib/savedCards.js');
                const check = await checkAutoChargeCard(userId, { forAdmin: true, logTag: '[AUTO-CHARGE-TOGGLE:ADMIN]' });
                if (!check.ok) {
                    res.status(check.status).json(check.body);
                    return;
                }
                // Z1-a: o cartão conferido vira o PADRÃO do cliente — um cartão salvo depois não assume a
                // cobrança automática sem passar pela conferência (PUT …/default).
                await pinAutoChargeCard(userId, check.card);
            }
            await prisma.user.update({ where: { id: userId }, data: { autoChargeEnabled: enabled } });
            // Nome próprio: AUTO_CHARGE_ENABLED/DISABLED são do próprio cliente (e marcadores em testes).
            if (target.autoChargeEnabled !== enabled) {
                await logAudit('USER', userId, 'AUTO_CHARGE_TOGGLED_BY_STAFF', req.user!.userId, { enabled });
            }
            res.json({ autoChargeEnabled: enabled });
        } catch (err) {
            console.error('[AUTO-CHARGE-TOGGLE]', err);
            res.status(500).json({ error: 'Erro ao atualizar a cobrança automática.' });
        }
    });
}
