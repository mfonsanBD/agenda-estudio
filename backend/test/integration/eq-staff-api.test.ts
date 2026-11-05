import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { config } from '../../src/config/index';
import { allPermissionKeys, ADMIN_ONLY_KEYS, buildStaffCatalog } from '../../src/config/staffPermissions';
import { assertNotLastActiveAdmin, withStaffGuard } from '../../src/modules/staff/staff.service';
import authRoutes from '../../src/modules/auth/routes';
import userRoutes from '../../src/modules/users/routes';
import staffRoutes from '../../src/modules/staff/routes';
import { mkUser, mkStaff } from './factories';

// Frente B1 — API da Equipe (/api/staff, D5) com as proteções da crítica (E1, E2, E6, LAST_ADMIN,
// SELF_CHANGE_FORBIDDEN, EMAIL_IS_CLIENT), desativação (sessões + push) e o efeito imediato das
// permissões lidas do banco (token antigo perde acesso na hora). Exercita as ROTAS reais num app mínimo.

let server: Server;
let base = '';
const touched: string[] = [];

beforeAll(async () => {
    // "Enviar acesso" sem provedor de e-mail configurado: o serviço cai no mock de console (dev).
    process.env.ALLOW_OTP_BYPASS = 'true';
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authRoutes);
    app.use('/api/users', userRoutes);
    app.use('/api/staff', staffRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
    const keys = touched.splice(0).map(id => `auth:revoked:${id}`);
    if (keys.length) await redis.del(...keys);
});

type Who = { id: string; email: string | null; role: string };
const nowSec = () => Math.floor(Date.now() / 1000);

function cookie(u: Who, iat?: number) {
    touched.push(u.id);
    const payload = { userId: u.id, email: u.email ?? '', role: u.role, ...(iat ? { iat } : {}) };
    return `accessToken=${jwt.sign(payload, config.jwt.secret, { expiresIn: '1h' })}`;
}

function refreshCookie(u: Who, iat?: number) {
    const payload = { userId: u.id, email: u.email ?? '', role: u.role, ...(iat ? { iat } : {}) };
    return `refreshToken=${jwt.sign(payload, config.jwt.refreshSecret, { expiresIn: '1d' })}`;
}

async function call(method: string, path: string, cookieHeader?: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: {
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
}

const audits = (entityId: string, action: string) =>
    prisma.auditLog.findMany({ where: { entityType: 'USER', entityId, action }, orderBy: { createdAt: 'asc' } });

// ─── Só ADMIN (papel do banco) ───────────────────────────

describe('/api/staff — só ADMIN', () => {
    it('colaborador (mesmo com todas as chaves), cliente e anônimo são recusados em todas as rotas', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const colab = await mkStaff({ permissions: allPermissionKeys() });
        const client = await mkUser();
        const target = await mkStaff({ permissions: ['clientes.ver'] });

        const routes: Array<[string, string, unknown?]> = [
            ['GET', '/api/staff'],
            ['GET', '/api/staff/catalog'],
            ['POST', '/api/staff', { name: 'Fulano', email: 'novo@example.com', role: 'COLABORADOR' }],
            ['PATCH', `/api/staff/${target.id}`, { name: 'Outro' }],
            ['POST', `/api/staff/${target.id}/password`, { password: 'senha-forte-1' }],
            ['POST', `/api/staff/${target.id}/send-access`],
            ['POST', `/api/staff/${target.id}/deactivate`],
            ['POST', `/api/staff/${target.id}/reactivate`],
        ];
        for (const [method, path, body] of routes) {
            const asColab = await call(method, path, cookie(colab), body);
            expect(asColab.status, `${method} ${path} (colaborador)`).toBe(403);
            expect(asColab.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'ADMIN' });
            expect((await call(method, path, cookie(client), body)).status, `${method} ${path} (cliente)`).toBe(403);
            expect((await call(method, path, undefined, body)).status, `${method} ${path} (anônimo)`).toBe(401);
        }
        // Nada mudou.
        expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).name).toBe(target.name);
        expect(await prisma.user.count({ where: { email: 'novo@example.com' } })).toBe(0);
        expect((await call('GET', '/api/staff', cookie(admin))).status).toBe(200);
    });

    it('ADMIN rebaixado no banco perde /api/staff na hora, mesmo com o JWT antigo de ADMIN', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const demoted = await mkUser({ role: 'ADMIN' });
        const oldToken = cookie(demoted);
        expect((await call('GET', '/api/staff', oldToken)).status).toBe(200);
        await prisma.user.update({ where: { id: demoted.id }, data: { role: 'COLABORADOR' } });
        const r = await call('GET', '/api/staff', oldToken);
        expect(r.status).toBe(403);
        expect(r.body.permission).toBe('ADMIN');
        expect((await call('GET', '/api/staff', cookie(admin))).status).toBe(200);
    });
});

// ─── Catálogo e lista ───────────────────────────────────

describe('GET /api/staff/catalog e GET /api/staff', () => {
    it('catálogo = buildStaffCatalog (módulos, exclusivas do ADMIN e perfis modelo)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const r = await call('GET', '/api/staff/catalog', cookie(admin));
        expect(r.status).toBe(200);
        expect(r.body).toEqual(JSON.parse(JSON.stringify(buildStaffCatalog())));
        expect(r.body.adminOnly.map((a: { key: string }) => a.key)).toEqual([...ADMIN_ONLY_KEYS]);
        expect(r.body.presets.map((p: { key: string }) => p.key)).toEqual(['recepcao', 'operador', 'financeiro']);
    });

    it('lista só a equipe não excluída, com isSelf, situação e permissões (ADMIN = [])', async () => {
        const admin = await mkUser({ role: 'ADMIN', name: 'Ana Admin' });
        const colab = await mkStaff({ permissions: ['agendamentos.ver', 'chave.que.saiu', 'equipe.gerenciar'], title: 'Recepção' });
        const blocked = await mkStaff({ permissions: [], overrides: { clientStatus: 'BLOCKED' } });
        await mkUser(); // cliente: fora
        await mkStaff({ overrides: { deletedAt: new Date(), email: null } }); // excluído: fora

        const r = await call('GET', '/api/staff', cookie(admin));
        expect(r.status).toBe(200);
        const ids = r.body.members.map((m: { id: string }) => m.id).sort();
        expect(ids).toEqual([admin.id, colab.id, blocked.id].sort());

        const me = r.body.members.find((m: { id: string }) => m.id === admin.id);
        expect(me).toMatchObject({ role: 'ADMIN', isSelf: true, active: true, permissions: [], title: null });
        const c = r.body.members.find((m: { id: string }) => m.id === colab.id);
        // Lido do banco e SANITIZADO: chave que saiu do catálogo e exclusiva do ADMIN não aparecem.
        expect(c).toMatchObject({ role: 'COLABORADOR', isSelf: false, active: true, permissions: ['agendamentos.ver'], title: 'Recepção' });
        expect(Object.keys(c).sort()).toEqual(
            ['id', 'name', 'email', 'phone', 'photoUrl', 'role', 'title', 'permissions', 'active', 'isSelf', 'credentialsLocked', 'createdAt', 'updatedAt'].sort(),
        );
        expect(r.body.members.find((m: { id: string }) => m.id === blocked.id).active).toBe(false);
    });
});

// ─── POST /api/staff ────────────────────────────────────

describe('POST /api/staff', () => {
    it('cria COLABORADOR: e-mail em minúsculas, permissões normalizadas, senha opcional, auditoria', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const r = await call('POST', '/api/staff', cookie(admin), {
            name: '  Bia Recepção ', email: '  Bia.Recepcao@Example.COM ', phone: '(22) 99999-0000', title: 'Recepção',
            role: 'COLABORADOR', permissions: ['agendamentos.criar', 'cobrancas.cartao_salvo'], password: 'senha-forte-1',
        });
        expect(r.status).toBe(201);
        expect(r.body.member).toMatchObject({
            name: 'Bia Recepção', email: 'bia.recepcao@example.com', role: 'COLABORADOR', title: 'Recepção', active: true, isSelf: false,
            // dependências: criar → ver; cartão salvo → cobrar
            permissions: ['agendamentos.ver', 'agendamentos.criar', 'cobrancas.cobrar', 'cobrancas.cartao_salvo'],
        });
        expect(typeof r.body.message).toBe('string');

        const row = await prisma.user.findUniqueOrThrow({ where: { id: r.body.member.id }, include: { staffProfile: true } });
        expect(row.role).toBe('COLABORADOR');
        expect(row.clientStatus).toBe('ACTIVE');
        expect(await bcrypt.compare('senha-forte-1', row.passwordHash!)).toBe(true);
        expect(row.staffProfile?.permissions).toEqual(['agendamentos.ver', 'agendamentos.criar', 'cobrancas.cobrar', 'cobrancas.cartao_salvo']);

        const [audit] = await audits(row.id, 'STAFF_CREATED');
        expect(audit.performedBy).toBe(admin.id);
        expect(audit.changes ?? '').not.toContain('senha-forte-1');
        expect(audit.changes ?? '').not.toContain('$2'); // nada de hash
    });

    it('cria ADMIN sem senha: a lista de permissões é ignorada (grava [])', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const r = await call('POST', '/api/staff', cookie(admin), {
            name: 'Dono Dois', email: 'dono2@example.com', role: 'ADMIN', permissions: ['qualquer.coisa', 'clientes.ver'],
        });
        expect(r.status).toBe(201);
        expect(r.body.member).toMatchObject({ role: 'ADMIN', permissions: [] });
        const row = await prisma.user.findUniqueOrThrow({ where: { id: r.body.member.id }, include: { staffProfile: true } });
        expect(row.passwordHash).toBeNull();
        expect(row.staffProfile?.permissions).toEqual([]);
    });

    it('400: permissão desconhecida ou exclusiva do ADMIN (INVALID_PERMISSION), senha curta, papel CLIENTE', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const base1 = { name: 'Fulano', email: 'fulano@example.com', role: 'COLABORADOR' };
        const unknown = await call('POST', '/api/staff', cookie(admin), { ...base1, permissions: ['clientes.ver', 'foo.bar'] });
        expect(unknown.status).toBe(400);
        expect(unknown.body).toMatchObject({ code: 'INVALID_PERMISSION', invalid: ['foo.bar'] });
        const adminOnly = await call('POST', '/api/staff', cookie(admin), { ...base1, permissions: ['equipe.gerenciar'] });
        expect(adminOnly.status).toBe(400);
        expect(adminOnly.body).toMatchObject({ code: 'INVALID_PERMISSION', invalid: ['equipe.gerenciar'] });
        expect((await call('POST', '/api/staff', cookie(admin), { ...base1, password: '1234567' })).status).toBe(400);
        expect((await call('POST', '/api/staff', cookie(admin), { ...base1, role: 'CLIENTE' })).status).toBe(400);
        expect(await prisma.user.count({ where: { email: 'fulano@example.com' } })).toBe(0);
    });

    it('409 EMAIL_IS_CLIENT / EMAIL_TAKEN sem diferenciar maiúsculas (E6)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        await mkUser({ email: 'Joao.Cliente@Example.com' }); // cadastro antigo com maiúscula
        await mkStaff({ overrides: { email: 'Maria.Equipe@example.com' } });

        const isClient = await call('POST', '/api/staff', cookie(admin), { name: 'João', email: 'joao.cliente@example.com', role: 'COLABORADOR' });
        expect(isClient.status).toBe(409);
        expect(isClient.body.code).toBe('EMAIL_IS_CLIENT');
        const taken = await call('POST', '/api/staff', cookie(admin), { name: 'Maria', email: 'MARIA.EQUIPE@EXAMPLE.COM', role: 'ADMIN' });
        expect(taken.status).toBe(409);
        expect(taken.body.code).toBe('EMAIL_TAKEN');
    });
});

// ─── PATCH /api/staff/:id ───────────────────────────────

describe('PATCH /api/staff/:id', () => {
    it('E1: alvo que não é da equipe (cliente, excluído, inexistente) → 404 em todas as rotas /:id', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ passwordHash: 'x' });
        const deletedStaff = await mkStaff({ overrides: { deletedAt: new Date(), email: null } });
        for (const id of [client.id, deletedStaff.id, '00000000-0000-0000-0000-000000000000']) {
            const tok = cookie(admin);
            expect((await call('PATCH', `/api/staff/${id}`, tok, { role: 'ADMIN' })).status).toBe(404);
            expect((await call('POST', `/api/staff/${id}/password`, tok, { password: 'senha-forte-1' })).status).toBe(404);
            expect((await call('POST', `/api/staff/${id}/deactivate`, tok)).status).toBe(404);
            expect((await call('POST', `/api/staff/${id}/reactivate`, tok)).status).toBe(404);
            expect((await call('POST', `/api/staff/${id}/send-access`, tok)).status).toBe(404);
        }
        const after = await prisma.user.findUniqueOrThrow({ where: { id: client.id } });
        expect(after.role).toBe('CLIENTE'); // não virou ADMIN
        expect(after.clientStatus).toBe('ACTIVE'); // não foi bloqueado
        expect(after.passwordHash).toBe('x'); // senha intacta
    });

    it('permissões: normaliza, audita a diferença e vale na hora para o token antigo do colaborador', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const colab = await mkStaff({ permissions: ['clientes.ver'] });
        const colabToken = cookie(colab);
        expect((await call('GET', '/api/users', colabToken)).status).toBe(200);

        const r = await call('PATCH', `/api/staff/${colab.id}`, cookie(admin), { permissions: ['cupons.editar'] });
        expect(r.status).toBe(200);
        expect(r.body.member.permissions).toEqual(['cupons.ver', 'cupons.editar']);
        const [audit] = await audits(colab.id, 'STAFF_PERMISSIONS_CHANGED');
        expect(JSON.parse(audit.changes!)).toEqual({ added: ['cupons.ver', 'cupons.editar'], removed: ['clientes.ver'] });

        // Mesmo token, sem novo login: perdeu Clientes e ganhou o diretório mínimo pelos Cupons.
        const detail = await call('GET', `/api/users/${(await mkUser()).id}`, colabToken);
        expect(detail.status).toBe(403);
        expect(detail.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'clientes.ver' });
        const me = await call('GET', '/api/auth/me', colabToken);
        expect(me.status).toBe(200);
        expect(me.body.user.permissions).toEqual(['cupons.ver', 'cupons.editar']);

        // Mudar só permissões NÃO encerra a sessão.
        expect(await redis.get(`auth:revoked:${colab.id}`)).toBeNull();
    });

    it('E2: e-mail e senha só de alvo COLABORADOR — de outro ADMIN → 403 (o e-mail troca e encerra sessões)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const otherAdmin = await mkUser({ role: 'ADMIN', email: 'outro.admin@example.com', passwordHash: 'hash-antigo' });
        const colab = await mkStaff({ permissions: [], overrides: { email: 'colab.antigo@example.com' } });

        const adminEmail = await call('PATCH', `/api/staff/${otherAdmin.id}`, cookie(admin), { email: 'sequestro@example.com' });
        expect(adminEmail.status).toBe(403);
        expect(adminEmail.body.code).toBe('ADMIN_TARGET_FORBIDDEN');
        const adminPwd = await call('POST', `/api/staff/${otherAdmin.id}/password`, cookie(admin), { password: 'senha-forte-1' });
        expect(adminPwd.status).toBe(403);
        expect(adminPwd.body.code).toBe('ADMIN_TARGET_FORBIDDEN');
        const selfPwd = await call('POST', `/api/staff/${admin.id}/password`, cookie(admin), { password: 'senha-forte-1' });
        expect(selfPwd.status).toBe(403);
        const still = await prisma.user.findUniqueOrThrow({ where: { id: otherAdmin.id } });
        expect(still.email).toBe('outro.admin@example.com');
        expect(still.passwordHash).toBe('hash-antigo');

        // Colaborador: troca o e-mail (minúsculas), audita mascarado e encerra as sessões dele.
        const colabToken = cookie(colab);
        const ok = await call('PATCH', `/api/staff/${colab.id}`, cookie(admin), { email: 'Colab.Novo@Example.com' });
        expect(ok.status).toBe(200);
        expect(ok.body.member.email).toBe('colab.novo@example.com');
        const [audit] = await audits(colab.id, 'STAFF_EMAIL_CHANGED');
        expect(JSON.parse(audit.changes!)).toEqual({ from: 'c***@example.com', to: 'c***@example.com' });
        expect((await call('GET', '/api/auth/me', colabToken)).status).toBe(401);
        // Nome/cargo não exigem nada e não derrubam sessões.
        const titleOnly = await call('PATCH', `/api/staff/${colab.id}`, cookie(admin), { title: 'Financeiro', name: 'Colab Renomeado' });
        expect(titleOnly.status).toBe(200);
        expect(titleOnly.body.member).toMatchObject({ title: 'Financeiro', name: 'Colab Renomeado' });
    });

    it('troca de e-mail para o de um cliente → 409 EMAIL_IS_CLIENT; senha no PATCH → 400', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const colab = await mkStaff();
        await mkUser({ email: 'cliente@example.com' });
        const r = await call('PATCH', `/api/staff/${colab.id}`, cookie(admin), { email: 'CLIENTE@example.com' });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('EMAIL_IS_CLIENT');
        const pwd = await call('PATCH', `/api/staff/${colab.id}`, cookie(admin), { password: 'senha-forte-1' });
        expect(pwd.status).toBe(400);
        expect(pwd.body.code).toBe('PASSWORD_NOT_ALLOWED');
    });

    it('SELF_CHANGE_FORBIDDEN: o próprio papel e a própria situação não mudam; nome, telefone e cargo podem', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        await mkUser({ role: 'ADMIN' }); // outro admin ativo: o 400 não é o LAST_ADMIN
        const tok = cookie(admin);
        const role = await call('PATCH', `/api/staff/${admin.id}`, tok, { role: 'COLABORADOR' });
        expect(role.status).toBe(400);
        expect(role.body.code).toBe('SELF_CHANGE_FORBIDDEN');
        const off = await call('POST', `/api/staff/${admin.id}/deactivate`, tok);
        expect(off.status).toBe(400);
        expect(off.body.code).toBe('SELF_CHANGE_FORBIDDEN');
        expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).role).toBe('ADMIN');

        const ok = await call('PATCH', `/api/staff/${admin.id}`, tok, { name: 'Dono do Estúdio', phone: '22 98888-7777', title: 'Sócio', role: 'ADMIN' });
        expect(ok.status).toBe(200);
        expect(ok.body.member).toMatchObject({ name: 'Dono do Estúdio', phone: '22 98888-7777', title: 'Sócio', role: 'ADMIN', isSelf: true });
    });

    it('rebaixar ADMIN → COLABORADOR encerra as sessões; o token antigo de ADMIN não abre mais /api/staff', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const target = await mkUser({ role: 'ADMIN' });
        const targetToken = cookie(target);
        const r = await call('PATCH', `/api/staff/${target.id}`, cookie(admin), { role: 'COLABORADOR', permissions: ['hoje.presenca'] });
        expect(r.status).toBe(200);
        expect(r.body.member).toMatchObject({ role: 'COLABORADOR', permissions: ['hoje.ver', 'hoje.presenca'] });
        expect((await audits(target.id, 'STAFF_ROLE_CHANGED')).map(a => JSON.parse(a.changes!))).toEqual([{ from: 'ADMIN', to: 'COLABORADOR' }]);

        expect((await call('GET', '/api/staff', targetToken)).status).toBe(401); // sessão revogada
        // Mesmo sem a revogação (Redis fora → fail-open), o papel do banco manda: 403.
        await redis.del(`auth:revoked:${target.id}`);
        const stale = await call('GET', '/api/staff', targetToken);
        expect(stale.status).toBe(403);
        expect(stale.body.permission).toBe('ADMIN');

        // Promover de volta: a lista guardada é zerada (ADMIN = acesso total).
        const up = await call('PATCH', `/api/staff/${target.id}`, cookie(admin), { role: 'ADMIN' });
        expect(up.status).toBe(200);
        expect(up.body.member).toMatchObject({ role: 'ADMIN', permissions: [] });
        expect((await prisma.staffProfile.findUniqueOrThrow({ where: { userId: target.id } })).permissions).toEqual([]);
    });
});

// ─── LAST_ADMIN ─────────────────────────────────────────

describe('nunca ficar sem ADMIN ativo (LAST_ADMIN)', () => {
    it('duas rebaixas concorrentes (A rebaixa B × B rebaixa A, Promise.all): exatamente uma passa', async () => {
        const a = await mkUser({ role: 'ADMIN' });
        const b = await mkUser({ role: 'ADMIN' });
        const [ra, rb] = await Promise.all([
            call('PATCH', `/api/staff/${b.id}`, cookie(a), { role: 'COLABORADOR' }),
            call('PATCH', `/api/staff/${a.id}`, cookie(b), { role: 'COLABORADOR' }),
        ]);
        const statuses = [ra.status, rb.status].sort();
        expect(statuses[0]).toBe(200);
        // A perdedora: 409 LAST_ADMIN (as duas passaram do requireAdmin antes do commit da outra) ou 403
        // (o getActor dela já leu o rebaixamento). Nunca as duas 200.
        const loser = ra.status === 200 ? rb : ra;
        expect([403, 409]).toContain(loser.status);
        if (loser.status === 409) expect(loser.body.code).toBe('LAST_ADMIN');
        expect(await prisma.user.count({ where: { role: 'ADMIN', deletedAt: null, clientStatus: { not: 'BLOCKED' } } })).toBe(1);
    });

    it('duas desativações concorrentes (A desativa B × B desativa A): sobra um ADMIN ativo', async () => {
        const a = await mkUser({ role: 'ADMIN' });
        const b = await mkUser({ role: 'ADMIN' });
        const [ra, rb] = await Promise.all([
            call('POST', `/api/staff/${b.id}/deactivate`, cookie(a)),
            call('POST', `/api/staff/${a.id}/deactivate`, cookie(b)),
        ]);
        expect([ra.status, rb.status].filter(s => s === 200)).toHaveLength(1);
        expect(await prisma.user.count({ where: { role: 'ADMIN', deletedAt: null, clientStatus: { not: 'BLOCKED' } } })).toBe(1);
    });

    it('a trava recusa tirar o único ADMIN ativo (ADMIN bloqueado não conta)', async () => {
        const only = await mkUser({ role: 'ADMIN' });
        await mkUser({ role: 'ADMIN', clientStatus: 'BLOCKED' });
        await mkStaff({ permissions: allPermissionKeys() }); // colaborador com tudo não conta
        await expect(withStaffGuard(only.id, (tx) => assertNotLastActiveAdmin(tx, only.id)))
            .rejects.toMatchObject({ status: 409, code: 'LAST_ADMIN' });
        const other = await mkUser({ role: 'ADMIN' });
        await expect(withStaffGuard(only.id, (tx) => assertNotLastActiveAdmin(tx, only.id))).resolves.toBeUndefined();
        expect(other.role).toBe('ADMIN');
    });
});

// ─── Senha, acesso, desativar/reativar ──────────────────

describe('POST /api/staff/:id/password, /send-access, /deactivate e /reactivate', () => {
    it('definir senha do colaborador: ≥ 8, grava o hash, audita e encerra as sessões dele', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const colab = await mkStaff({ permissions: ['clientes.ver'] });
        const colabToken = cookie(colab);
        expect((await call('POST', `/api/staff/${colab.id}/password`, cookie(admin), { password: '1234567' })).status).toBe(400);
        const r = await call('POST', `/api/staff/${colab.id}/password`, cookie(admin), { password: 'senha-forte-1' });
        expect(r.status).toBe(200);
        const row = await prisma.user.findUniqueOrThrow({ where: { id: colab.id } });
        expect(await bcrypt.compare('senha-forte-1', row.passwordHash!)).toBe(true);
        expect(await audits(colab.id, 'STAFF_PASSWORD_SET')).toHaveLength(1);
        expect((await call('GET', '/api/users', colabToken)).status).toBe(401);
    });

    it('enviar acesso: e-mail ao membro ativo (auditado); desativado → 409 STAFF_INACTIVE', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const colab = await mkStaff();
        const r = await call('POST', `/api/staff/${colab.id}/send-access`, cookie(admin));
        expect(r.status).toBe(200);
        expect(r.body.message).toContain(colab.email!);
        expect(await audits(colab.id, 'STAFF_ACCESS_SENT')).toHaveLength(1);

        const off = await mkStaff({ overrides: { clientStatus: 'BLOCKED' } });
        const blocked = await call('POST', `/api/staff/${off.id}/send-access`, cookie(admin));
        expect(blocked.status).toBe(409);
        expect(blocked.body.code).toBe('STAFF_INACTIVE');
    });

    it('desativar: BLOCKED, apaga as push_subscriptions, encerra sessões; o token antigo leva 401 ACCOUNT_DISABLED mesmo sem a revogação', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const passwordHash = await bcrypt.hash('senha-forte-1', 4);
        const colab = await mkStaff({ permissions: ['clientes.ver'], overrides: { passwordHash } });
        await prisma.pushSubscription.create({ data: { userId: colab.id, endpoint: `https://push.example/${colab.id}`, p256dh: 'p', auth: 'a' } });
        const colabToken = cookie(colab);
        const oldRefresh = refreshCookie(colab, nowSec() - 30);
        expect((await call('GET', '/api/users', colabToken)).status).toBe(200);

        const r = await call('POST', `/api/staff/${colab.id}/deactivate`, cookie(admin));
        expect(r.status).toBe(200);
        expect(r.body.member.active).toBe(false);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: colab.id } })).clientStatus).toBe('BLOCKED');
        expect(await prisma.pushSubscription.count({ where: { userId: colab.id } })).toBe(0);
        expect(await audits(colab.id, 'STAFF_DEACTIVATED')).toHaveLength(1);

        // Revogação imediata (Redis).
        expect((await call('GET', '/api/users', colabToken)).status).toBe(401);
        // Sem a revogação (Redis fora → fail-open): o banco recusa a conta desativada.
        await redis.del(`auth:revoked:${colab.id}`);
        const stale = await call('GET', '/api/users', colabToken);
        expect(stale.status).toBe(401);
        expect(stale.body).toEqual({ code: 'ACCOUNT_DISABLED', error: 'Seu acesso foi desativado. Fale com o administrador.' });
        const me = await call('GET', '/api/auth/me', colabToken);
        expect(me.status).toBe(401);
        expect(me.body.code).toBe('ACCOUNT_DISABLED');
        // Login e refresh recusam com a mensagem da equipe.
        const login = await call('POST', '/api/auth/login', undefined, { email: colab.email, password: 'senha-forte-1' });
        expect(login.status).toBe(403);
        expect(login.body).toEqual({ code: 'ACCOUNT_DISABLED', error: 'Seu acesso foi desativado. Fale com o administrador.' });
        const refresh = await call('POST', '/api/auth/refresh', oldRefresh);
        expect(refresh.status).toBe(403);
        expect(refresh.body.code).toBe('ACCOUNT_DISABLED');

        // Idempotente.
        expect((await call('POST', `/api/staff/${colab.id}/deactivate`, cookie(admin))).status).toBe(200);
        expect(await audits(colab.id, 'STAFF_DEACTIVATED')).toHaveLength(1);

        // Reativar: volta a entrar (as permissões ficaram guardadas).
        const back = await call('POST', `/api/staff/${colab.id}/reactivate`, cookie(admin));
        expect(back.status).toBe(200);
        expect(back.body.member).toMatchObject({ active: true, permissions: ['clientes.ver'] });
        expect(await audits(colab.id, 'STAFF_REACTIVATED')).toHaveLength(1);
        const relogin = await call('POST', '/api/auth/login', undefined, { email: colab.email, password: 'senha-forte-1' });
        expect(relogin.status).toBe(200);
        expect(relogin.body.user).toMatchObject({ role: 'COLABORADOR', permissions: ['clientes.ver'] });
    });

    it('desativar outro ADMIN funciona quando sobra um ADMIN ativo (quem age)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const other = await mkUser({ role: 'ADMIN' });
        const r = await call('POST', `/api/staff/${other.id}/deactivate`, cookie(admin));
        expect(r.status).toBe(200);
        expect(r.body.member).toMatchObject({ role: 'ADMIN', active: false });
        expect(await prisma.user.count({ where: { role: 'ADMIN', clientStatus: { not: 'BLOCKED' } } })).toBe(1);
    });
});

// ─── /me da equipe ──────────────────────────────────────

describe('GET /api/auth/me — formato com permissions e staffTitle', () => {
    it('ADMIN = todas as chaves + exclusivas; COLABORADOR = as dele (sanitizadas) + cargo; CLIENTE = []', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const colab = await mkStaff({ permissions: ['hoje.ver', 'chave.removida', 'config.email'], title: 'Operador' });
        const client = await mkUser();

        const a = await call('GET', '/api/auth/me', cookie(admin));
        expect(a.status).toBe(200);
        expect(a.body.user.role).toBe('ADMIN');
        expect([...a.body.user.permissions].sort()).toEqual([...allPermissionKeys(), ...ADMIN_ONLY_KEYS].sort());
        expect(a.body.user.staffTitle).toBeNull();

        const c = await call('GET', '/api/auth/me', cookie(colab));
        expect(c.body.user).toMatchObject({ role: 'COLABORADOR', permissions: ['hoje.ver'], staffTitle: 'Operador' });

        const cl = await call('GET', '/api/auth/me', cookie(client));
        expect(cl.body.user).toMatchObject({ role: 'CLIENTE', permissions: [], staffTitle: null });
        expect(cl.body.user.deletedAt).toBeUndefined();
        expect(cl.body.user.clientStatus).toBeUndefined();
    });
});
