// ─── /api/staff — tela Equipe (só ADMIN, papel lido do BANCO) ─
// Contrato D5 (DECISOES-EQUIPE.md). Proteções:
//   • todo /:id exige alvo da equipe (ADMIN/COLABORADOR não excluído), senão 404 (crítica E1);
//   • e-mail e senha só de alvo COLABORADOR que nunca foi ADMIN — de um ADMIN (atual ou rebaixado), só
//     "Enviar acesso" (E2). Todo membro devolvido traz `credentialsLocked` com esse mesmo critério
//     (toMembers: no máximo uma consulta à auditoria por resposta, também na lista), para a tela não
//     oferecer a troca;
//   • trocar o e-mail de login desfaz o vínculo com o Google (googleId) e apaga a senha: quem usava o
//     endereço antigo não segue entrando (AUTH-03);
//   • ninguém altera o próprio papel nem a própria situação (400 SELF_CHANGE_FORBIDDEN; nome, telefone e
//     cargo pode) — e, como só ADMIN chega aqui e ADMIN ignora a lista, as próprias permissões não mudam;
//   • nunca fica sem ADMIN ativo (trava do Postgres + 409 LAST_ADMIN);
//   • permissões: normalizePermissions (dependências); chave desconhecida ou exclusiva do ADMIN → 400
//     INVALID_PERMISSION; ADMIN grava [] (acesso total implícito);
//   • e-mail sem diferenciar maiúsculas: 409 EMAIL_IS_CLIENT / EMAIL_TAKEN (E6);
//   • mudar papel ou e-mail, definir senha e desativar encerram as sessões do alvo; desativar também
//     apaga as push_subscriptions dele (crítica S1);
//   • tudo auditado (audit_logs, na mesma transação). Sem exclusão de membro e sem histórico na v1 (E3/C4).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma.js';
import { logAudit } from '../../lib/audit.js';
import { authenticate, revokeUserSessions } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/permissions.js';
import {
    buildStaffCatalog,
    normalizePermissions,
    sanitizeStoredPermissions,
    type PermissionKey,
} from '../../config/staffPermissions.js';
import {
    MEMBER_SELECT,
    STAFF_ERRORS,
    StaffError,
    assertCredentialsEditable,
    assertEmailAvailableForStaff,
    assertNotLastActiveAdmin,
    auditStaff,
    isUniqueViolation,
    loadMemberOrThrow,
    permissionDiff,
    toMemberResponse,
    toMembers,
    withStaffGuard,
    type StaffRole,
} from './staff.service.js';
import { maskEmail, notifyLoginEmailChanged, sendStaffAccessEmail } from './staffMail.js';

const router = Router();

// Router 100% administrativo: autenticação + ADMIN conferido no banco em TODAS as rotas.
router.use(authenticate, requireAdmin());

// ─── Validação ──────────────────────────────────────────

const emailField = z.string({ required_error: 'Informe o e-mail.', invalid_type_error: 'E-mail inválido.' })
    .trim().toLowerCase()
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail inválido.')
    .max(254, 'E-mail longo demais.');
const nameField = z.string({ required_error: 'Informe o nome.', invalid_type_error: 'Nome inválido.' })
    .trim().min(2, 'Informe o nome (mínimo 2 caracteres).').max(120, 'Nome longo demais.');
const phoneField = z.string({ invalid_type_error: 'Telefone inválido.' }).trim().max(30, 'Telefone longo demais.').nullable().optional();
const titleField = z.string({ invalid_type_error: 'Cargo inválido.' }).trim().max(60, 'O cargo pode ter no máximo 60 caracteres.').nullable().optional();
const roleField = z.enum(['ADMIN', 'COLABORADOR'], { errorMap: () => ({ message: 'Tipo de acesso inválido (Administrador ou Colaborador).' }) });
// Itens validados por normalizePermissions (400 INVALID_PERMISSION com a lista), não pelo zod.
const permissionsField = z.array(z.unknown(), { invalid_type_error: 'Lista de permissões inválida.' }).max(64, 'Lista de permissões longa demais.');
const passwordField = z.string({ required_error: 'Informe a senha.', invalid_type_error: 'Senha inválida.' })
    .min(8, 'A senha precisa ter no mínimo 8 caracteres.').max(128, 'Senha longa demais.');

const createStaffSchema = z.object({
    name: nameField,
    email: emailField,
    phone: phoneField,
    title: titleField,
    role: roleField,
    permissions: permissionsField.optional(),
    password: passwordField.optional(),
    sendAccessEmail: z.boolean().optional(),
});

const updateStaffSchema = z.object({
    name: nameField.optional(),
    email: emailField.optional(),
    phone: phoneField,
    title: titleField,
    role: roleField.optional(),
    permissions: permissionsField.optional(),
});

const passwordSchema = z.object({ password: passwordField });

/** Texto opcional: '' e só espaços viram null (limpar o campo). */
const emptyToNull = (v: string | null | undefined): string | null | undefined =>
    v === undefined ? undefined : (v === null || v.trim() === '' ? null : v.trim());

/** Lista do corpo → chaves gravadas. Desconhecida ou exclusiva do ADMIN → 400 INVALID_PERMISSION. */
function normalizeOrThrow(raw: readonly unknown[] | undefined): PermissionKey[] {
    const norm = normalizePermissions(raw ?? []);
    const invalid = [...norm.invalid, ...norm.removedAdminOnly];
    if (invalid.length > 0) throw STAFF_ERRORS.invalidPermissions(invalid);
    return norm.permissions;
}

function replyError(res: Response, err: unknown, logTag: string, fallback: string): void {
    if (res.headersSent) return;
    if (err instanceof StaffError) { res.status(err.status).json(err.body()); return; }
    if (err instanceof z.ZodError) {
        res.status(400).json({ error: err.errors[0]?.message || 'Dados inválidos.', details: err.errors });
        return;
    }
    if (isUniqueViolation(err)) { res.status(409).json(STAFF_ERRORS.emailTaken().body()); return; }
    console.error(logTag, err);
    res.status(500).json({ error: fallback });
}

const actorIdOf = (req: Request): string => req.actor!.userId; // requireAdmin já resolveu o ator

// ─── GET /api/staff/catalog ─────────────────────────────

router.get('/catalog', (_req: Request, res: Response) => {
    res.json(buildStaffCatalog());
});

// ─── GET /api/staff ─────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
    try {
        const rows = await prisma.user.findMany({
            where: { role: { in: ['ADMIN', 'COLABORADOR'] }, deletedAt: null },
            orderBy: [{ role: 'asc' }, { name: 'asc' }],
            select: MEMBER_SELECT,
        });
        // credentialsLocked em lote: uma consulta à auditoria para a lista inteira.
        res.json({ members: await toMembers(prisma, rows, actorIdOf(req)) });
    } catch (err) {
        replyError(res, err, '[STAFF] list', 'Erro ao carregar a equipe.');
    }
});

// ─── POST /api/staff ────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
    try {
        const data = createStaffSchema.parse(req.body);
        const actorId = actorIdOf(req);
        const role: StaffRole = data.role;
        // ADMIN ignora a lista (acesso total); COLABORADOR grava a lista normalizada.
        const permissions = role === 'COLABORADOR' ? normalizeOrThrow(data.permissions) : [];
        const title = emptyToNull(data.title) ?? null;
        const phone = emptyToNull(data.phone) ?? null;

        await assertEmailAvailableForStaff(prisma, data.email);
        const passwordHash = data.password ? await bcrypt.hash(data.password, 12) : null;

        // O membro da resposta é montado na transação: uma falha ali desfaz a criação (nada de 500 com a
        // conta já criada, que viraria EMAIL_TAKEN na nova tentativa).
        const { created, member } = await withStaffGuard(actorId, async (tx, assertActorStillAdmin) => {
            await assertActorStillAdmin();
            await assertEmailAvailableForStaff(tx, data.email);
            const user = await tx.user.create({
                data: {
                    name: data.name,
                    email: data.email,
                    phone,
                    role,
                    passwordHash,
                    clientStatus: 'ACTIVE',
                    staffProfile: { create: { title, permissions } },
                },
                select: MEMBER_SELECT,
            });
            await auditStaff(tx, user.id, 'STAFF_CREATED', actorId, {
                role,
                title,
                permissions,
                withPassword: !!passwordHash,
            });
            return { created: user, member: await toMemberResponse(tx, user, actorId) };
        });

        let accessEmailSent = false;
        let message = `${created.name} foi adicionado à equipe.`;
        if (data.sendAccessEmail) {
            try {
                await sendStaffAccessEmail({ name: created.name, email: data.email });
                accessEmailSent = true;
                await logAudit('USER', created.id, 'STAFF_ACCESS_SENT', actorId);
                message = `${created.name} foi adicionado à equipe. E-mail de acesso enviado para ${data.email}.`;
            } catch (err) {
                console.error('[STAFF] Falha ao enviar o e-mail de acesso na criação:', err instanceof Error ? err.message : err);
                message = `${created.name} foi adicionado à equipe, mas não foi possível enviar o e-mail de acesso agora. Use “Enviar acesso” depois.`;
            }
        }

        res.status(201).json({ member, message, accessEmailSent });
    } catch (err) {
        replyError(res, err, '[STAFF] create', 'Erro ao adicionar o membro da equipe.');
    }
});

// ─── PATCH /api/staff/:id ───────────────────────────────

router.patch('/:id', async (req: Request, res: Response) => {
    try {
        const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
        if (Object.prototype.hasOwnProperty.call(body, 'password')) {
            res.status(400).json({ error: 'A senha não se altera aqui. Use “Definir senha”.', code: 'PASSWORD_NOT_ALLOWED' });
            return;
        }
        const data = updateStaffSchema.parse(body);
        const id = req.params.id as string;
        const actorId = actorIdOf(req);

        const result = await withStaffGuard(actorId, async (tx, assertActorStillAdmin) => {
            const target = await loadMemberOrThrow(tx, id);
            const isSelf = target.id === actorId;
            const fromRole = target.role as StaffRole;
            const toRole: StaffRole = data.role ?? fromRole;
            const roleChanged = toRole !== fromRole;

            // Autoalteração: nome, telefone e cargo podem; papel não. (Só ADMIN chega aqui e ADMIN ignora a
            // lista de permissões, então as próprias permissões nunca mudam de efeito.)
            if (isSelf && roleChanged) throw STAFF_ERRORS.selfChange();

            // Permissões efetivas depois da mudança.
            const storedBefore = sanitizeStoredPermissions(target.staffProfile?.permissions);
            let nextPermissions: PermissionKey[] | undefined;
            if (toRole === 'ADMIN') {
                if (roleChanged || (target.staffProfile?.permissions.length ?? 0) > 0) nextPermissions = [];
            } else if (data.permissions !== undefined) {
                nextPermissions = normalizeOrThrow(data.permissions);
            } else if (roleChanged) {
                nextPermissions = []; // ADMIN → COLABORADOR sem lista: começa sem módulos
            }

            // E-mail: troca real só de alvo COLABORADOR que nunca foi ADMIN (E2 — senão rebaixar, trocar o
            // e-mail e promover de novo contornaria a regra). Diferença só de maiúsculas = normalização.
            const currentEmail = target.email ?? '';
            const emailChanged = data.email !== undefined && data.email !== currentEmail.trim().toLowerCase();
            const writeEmail = data.email !== undefined && data.email !== currentEmail;
            if (emailChanged) await assertCredentialsEditable(tx, { id: target.id, role: fromRole });
            if (writeEmail) await assertEmailAvailableForStaff(tx, data.email!, target.id);

            // Rebaixar um ADMIN ativo: nunca ficar sem ADMIN ativo. Depois, quem age ainda é ADMIN?
            if (roleChanged && fromRole === 'ADMIN' && target.clientStatus !== 'BLOCKED') {
                await assertNotLastActiveAdmin(tx, target.id);
            }
            await assertActorStillAdmin();

            const name = data.name;
            const phone = emptyToNull(data.phone);
            const title = emptyToNull(data.title);
            const changedFields: string[] = [];
            if (name !== undefined && name !== target.name) changedFields.push('name');
            if (phone !== undefined && phone !== target.phone) changedFields.push('phone');
            if (title !== undefined && title !== (target.staffProfile?.title ?? null)) changedFields.push('title');

            // E-mail de login trocado de fato (AUTH-03): o vínculo com o Google e a senha eram de quem usava o
            // endereço antigo (ex.: e-mail digitado errado; quem o recebeu pode ter entrado pelo código e
            // definido senha em Meu Perfil). O /auth/google acha a conta pelo googleId ANTES do e-mail, então
            // sem zerar ele seguiria entrando. A pessoa certa entra pelo código no e-mail novo.
            const hadPassword = emailChanged
                ? !!(await tx.user.findUnique({ where: { id: target.id }, select: { passwordHash: true } }))?.passwordHash
                : false;
            await tx.user.update({
                where: { id: target.id },
                data: {
                    ...(name !== undefined ? { name } : {}),
                    ...(phone !== undefined ? { phone } : {}),
                    ...(writeEmail ? { email: data.email } : {}),
                    ...(emailChanged ? { googleId: null, passwordHash: null } : {}),
                    ...(roleChanged ? { role: toRole } : {}),
                },
            });
            if (title !== undefined || nextPermissions !== undefined) {
                await tx.staffProfile.upsert({
                    where: { userId: target.id },
                    create: { userId: target.id, title: title ?? null, permissions: nextPermissions ?? [] },
                    update: {
                        ...(title !== undefined ? { title } : {}),
                        ...(nextPermissions !== undefined ? { permissions: nextPermissions } : {}),
                    },
                });
            }

            if (changedFields.length > 0) await auditStaff(tx, target.id, 'STAFF_UPDATED', actorId, { fields: changedFields });
            if (roleChanged) await auditStaff(tx, target.id, 'STAFF_ROLE_CHANGED', actorId, { from: fromRole, to: toRole });
            if (emailChanged) {
                await auditStaff(tx, target.id, 'STAFF_EMAIL_CHANGED', actorId, { from: maskEmail(target.email), to: maskEmail(data.email) });
            }
            if (nextPermissions !== undefined && toRole === 'COLABORADOR') {
                const diff = permissionDiff(fromRole === 'COLABORADOR' ? storedBefore : [], nextPermissions);
                if (diff.added.length > 0 || diff.removed.length > 0) {
                    await auditStaff(tx, target.id, 'STAFF_PERMISSIONS_CHANGED', actorId, diff);
                }
            }

            const updated = await loadMemberOrThrow(tx, target.id);
            // Na transação, DEPOIS da auditoria da rebaixa: ADMIN → COLABORADOR já responde credentialsLocked true.
            const member = await toMemberResponse(tx, updated, actorId);
            return { updated, member, roleChanged, emailChanged, oldEmail: target.email, passwordCleared: hadPassword };
        });

        // Papel ou e-mail mudou → encerra as sessões do alvo (o JWT antigo levaria o papel/e-mail antigos).
        if (result.roleChanged || result.emailChanged) await revokeUserSessions(result.updated.id);
        if (result.emailChanged && result.oldEmail && result.updated.email) {
            notifyLoginEmailChanged(result.oldEmail, result.updated.email, result.updated.name);
        }

        let message = result.roleChanged || result.emailChanged
            ? `Dados de ${result.updated.name} atualizados. As sessões abertas foram encerradas.`
            : `Dados de ${result.updated.name} atualizados.`;
        if (result.passwordCleared) {
            message += ' A senha antiga foi apagada junto com o e-mail: use “Definir senha” ou “Enviar acesso” (código no e-mail novo).';
        }
        res.json({ member: result.member, message });
    } catch (err) {
        replyError(res, err, '[STAFF] update', 'Erro ao atualizar o membro da equipe.');
    }
});

// ─── POST /api/staff/:id/password ───────────────────────

router.post('/:id/password', async (req: Request, res: Response) => {
    try {
        const { password } = passwordSchema.parse(req.body);
        const id = req.params.id as string;
        const actorId = actorIdOf(req);

        // Confere o alvo antes do bcrypt (lento) e de novo dentro da trava. Só COLABORADOR que nunca foi
        // ADMIN (E2: conta que já foi ADMIN segue a regra de ADMIN para e-mail e senha).
        const pre = await loadMemberOrThrow(prisma, id);
        await assertCredentialsEditable(prisma, pre);
        const passwordHash = await bcrypt.hash(password, 12);

        const target = await withStaffGuard(actorId, async (tx, assertActorStillAdmin) => {
            const t = await loadMemberOrThrow(tx, id);
            await assertCredentialsEditable(tx, t);
            await assertActorStillAdmin();
            await tx.user.update({ where: { id: t.id }, data: { passwordHash } });
            await auditStaff(tx, t.id, 'STAFF_PASSWORD_SET', actorId);
            return t;
        });

        await revokeUserSessions(target.id);
        res.json({ message: `Senha definida. As sessões abertas de ${target.name} foram encerradas.` });
    } catch (err) {
        replyError(res, err, '[STAFF] password', 'Erro ao definir a senha.');
    }
});

// ─── POST /api/staff/:id/send-access ────────────────────
// Rate limit leve em index.ts (staffAccessLimiter).

router.post('/:id/send-access', async (req: Request, res: Response) => {
    try {
        const target = await loadMemberOrThrow(prisma, req.params.id as string);
        if (target.clientStatus === 'BLOCKED') throw STAFF_ERRORS.inactive();
        if (!target.email) throw STAFF_ERRORS.notFound();
        try {
            await sendStaffAccessEmail({ name: target.name, email: target.email });
        } catch (err) {
            console.error('[STAFF] Falha ao enviar o e-mail de acesso:', err instanceof Error ? err.message : err);
            res.status(500).json({
                error: 'Não foi possível enviar o e-mail agora. Confira as configurações de e-mail e tente de novo.',
                code: 'EMAIL_SEND_FAILED',
            });
            return;
        }
        await logAudit('USER', target.id, 'STAFF_ACCESS_SENT', actorIdOf(req));
        res.json({ message: `E-mail de acesso enviado para ${target.email}.` });
    } catch (err) {
        replyError(res, err, '[STAFF] send-access', 'Erro ao enviar o e-mail de acesso.');
    }
});

// ─── POST /api/staff/:id/deactivate e /reactivate ───────

router.post('/:id/deactivate', async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const actorId = actorIdOf(req);
        if (id === actorId) throw STAFF_ERRORS.selfChange();

        // O membro da resposta sai da transação (antes da revogação das sessões, que vem logo depois).
        const result = await withStaffGuard(actorId, async (tx, assertActorStillAdmin) => {
            const target = await loadMemberOrThrow(tx, id);
            if (target.clientStatus === 'BLOCKED') return { member: await toMemberResponse(tx, target, actorId), changed: false };
            if (target.role === 'ADMIN') await assertNotLastActiveAdmin(tx, target.id);
            await assertActorStillAdmin();
            await tx.user.update({ where: { id: target.id }, data: { clientStatus: 'BLOCKED' } });
            // Push com nome de cliente e valores não pode seguir chegando no celular de quem saiu (S1).
            const removed = await tx.pushSubscription.deleteMany({ where: { userId: target.id } });
            await auditStaff(tx, target.id, 'STAFF_DEACTIVATED', actorId, { pushSubscriptionsRemoved: removed.count });
            return { member: await toMemberResponse(tx, await loadMemberOrThrow(tx, target.id), actorId), changed: true };
        });

        if (result.changed) await revokeUserSessions(result.member.id);
        res.json({
            member: result.member,
            message: result.changed
                ? `Acesso de ${result.member.name} desativado. As sessões abertas foram encerradas.`
                : `O acesso de ${result.member.name} já estava desativado.`,
        });
    } catch (err) {
        replyError(res, err, '[STAFF] deactivate', 'Erro ao desativar o acesso.');
    }
});

router.post('/:id/reactivate', async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const actorId = actorIdOf(req);
        if (id === actorId) throw STAFF_ERRORS.selfChange();

        const result = await withStaffGuard(actorId, async (tx, assertActorStillAdmin) => {
            const target = await loadMemberOrThrow(tx, id);
            if (target.clientStatus !== 'BLOCKED') return { member: await toMemberResponse(tx, target, actorId), changed: false };
            await assertActorStillAdmin();
            await tx.user.update({ where: { id: target.id }, data: { clientStatus: 'ACTIVE' } });
            await auditStaff(tx, target.id, 'STAFF_REACTIVATED', actorId);
            return { member: await toMemberResponse(tx, await loadMemberOrThrow(tx, target.id), actorId), changed: true };
        });

        res.json({
            member: result.member,
            message: result.changed
                ? `Acesso de ${result.member.name} reativado.`
                : `O acesso de ${result.member.name} já estava ativo.`,
        });
    } catch (err) {
        replyError(res, err, '[STAFF] reactivate', 'Erro ao reativar o acesso.');
    }
});

export default router;
