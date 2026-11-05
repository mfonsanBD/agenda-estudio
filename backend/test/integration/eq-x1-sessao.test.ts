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
import { accessTokenTtlSeconds } from '../../src/middleware/auth';
import authRoutes from '../../src/modules/auth/routes';
import userRoutes from '../../src/modules/users/routes';
import staffRoutes from '../../src/modules/staff/routes';
import { mkUser, mkStaff } from './factories';

// Frente X1 — correções da revisão adversarial (sessão, equipe e clientes):
//  • AUTH-01/REG-2: a marca de revogação vive a validade do REFRESH token (30 dias), não só 1h — um refresh
//    token anterior à troca de senha/e-mail continua recusado depois que o access token teria expirado;
//  • AUTH-02: conta que JÁ FOI ADMIN segue a regra de ADMIN para e-mail e senha (rebaixar → trocar → promover);
//  • AUTH-03: trocar o e-mail de login zera o googleId (cliente e equipe; na equipe também a senha);
//  • AUTH-04: conta BLOCKED não altera o perfil/senha/foto nem recebe cookies novos no PATCH /auth/profile.

let server: Server;
let base = '';
const touched: string[] = [];

beforeAll(async () => {
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
const DAY_S = 24 * 3600;

function cookie(u: Who, iat?: number) {
    touched.push(u.id);
    const payload = { userId: u.id, email: u.email ?? '', role: u.role, ...(iat ? { iat } : {}) };
    return `accessToken=${jwt.sign(payload, config.jwt.secret, { expiresIn: '1h' })}`;
}

function refreshCookie(u: Who, iat?: number) {
    touched.push(u.id);
    const payload = { userId: u.id, email: u.email ?? '', role: u.role, ...(iat ? { iat } : {}) };
    return `refreshToken=${jwt.sign(payload, config.jwt.refreshSecret, { expiresIn: '30d' })}`;
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
    return { status: res.status, body: await res.json().catch(() => ({})) as any, setCookies: res.headers.getSetCookie() };
}

/** POST /api/auth/profile/photo com um "PNG" mínimo (o multer só olha o mimetype; o sharp nem chega a rodar). */
async function uploadPhoto(cookieHeader: string) {
    const form = new FormData();
    form.append('photo', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' }), 'foto.png');
    const res = await fetch(`${base}/api/auth/profile/photo`, { method: 'POST', headers: { Cookie: cookieHeader }, body: form });
    return { status: res.status, body: await res.json().catch(() => ({})) as any, setCookies: res.headers.getSetCookie() };
}

/** Confere que a revogação de `id` cobre a validade do refresh token e que um refresh anterior não renova. */
async function expectLongRevocation(target: Who, refreshIatBefore: number) {
    const ttl = await redis.ttl(`auth:revoked:${target.id}`);
    expect(ttl).toBeGreaterThan(DAY_S);
    expect(ttl).toBeGreaterThanOrEqual(accessTokenTtlSeconds(config.jwt.refreshExpiry));
    // Refresh token emitido antes da troca: 401 (e continuará 401 enquanto a chave viver ≥ 30 dias).
    const r = await call('POST', '/api/auth/refresh', refreshCookie(target, refreshIatBefore));
    expect(r.status).toBe(401);
    expect(r.setCookies.some((c) => c.startsWith('accessToken='))).toBe(false);
}

// ─── AUTH-01 / REG-2 ─────────────────────────────────────

describe('revogação por troca de senha/e-mail cobre o refresh token (AUTH-01 / REG-2)', () => {
    it('"Definir senha" (tela Equipe): chave de revogação ≥ 30 dias e refresh antigo → 401', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const colab = await mkStaff({ permissions: ['clientes.ver'] });
        const before = nowSec() - 30;
        const r = await call('POST', `/api/staff/${colab.id}/password`, cookie(admin), { password: 'senha-forte-1' });
        expect(r.status).toBe(200);
        await expectLongRevocation(colab, before);
    });

    it('troca de e-mail do colaborador (PATCH /api/staff/:id): chave ≥ 30 dias e refresh antigo → 401', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const colab = await mkStaff();
        const before = nowSec() - 30;
        const r = await call('PATCH', `/api/staff/${colab.id}`, cookie(admin), { email: 'novo.email.colab@example.com' });
        expect(r.status).toBe(200);
        await expectLongRevocation(colab, before);
    });

    it('equipe troca a própria senha (PATCH /auth/profile): outras sessões caem por 30 dias; a atual segue', async () => {
        const colab = await mkStaff({ permissions: ['clientes.ver'] });
        const before = nowSec() - 30;
        const r = await call('PATCH', '/api/auth/profile', cookie(colab, before), { password: 'novaSenha123' });
        expect(r.status).toBe(200);
        await expectLongRevocation(colab, before);
        // Os cookies reemitidos pela troca (iat = agora + 1) continuam valendo.
        const access = r.setCookies.find((c) => c.startsWith('accessToken='))!.split(';')[0];
        expect((await call('GET', '/api/auth/me', access)).status).toBe(200);
    });

    it('cliente: ADMIN troca o e-mail ou a senha (F8) → chave ≥ 30 dias e refresh antigo → 401', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const c1 = await mkUser();
        const c2 = await mkUser();
        const before = nowSec() - 30;
        expect((await call('PATCH', `/api/users/${c1.id}`, cookie(admin), { email: 'cliente.novo@example.com' })).status).toBe(200);
        await expectLongRevocation(c1, before);
        expect((await call('PATCH', `/api/users/${c2.id}`, cookie(admin), { password: 'senha-cliente-1' })).status).toBe(200);
        await expectLongRevocation(c2, before);
        // Login legítimo depois da troca (refresh com iat posterior) renova normalmente.
        const after = await call('POST', '/api/auth/refresh', refreshCookie(c2, nowSec() + 2));
        expect(after.status).toBe(200);
    });
});

// ─── AUTH-02 ─────────────────────────────────────────────

describe('conta que já foi ADMIN segue a regra de ADMIN para e-mail e senha (AUTH-02)', () => {
    it('rebaixar → definir senha / trocar e-mail → 403 ADMIN_TARGET_FORBIDDEN, sem gravar nada', async () => {
        const a = await mkUser({ role: 'ADMIN' });
        const b = await mkStaff({ role: 'ADMIN', overrides: { email: 'dono@example.com', passwordHash: 'hash-do-dono' } });

        const demote = await call('PATCH', `/api/staff/${b.id}`, cookie(a), { role: 'COLABORADOR' });
        expect(demote.status).toBe(200);
        expect(demote.body.member.role).toBe('COLABORADOR');

        const pwd = await call('POST', `/api/staff/${b.id}/password`, cookie(a), { password: 'senha-do-atacante' });
        expect(pwd.status).toBe(403);
        expect(pwd.body.code).toBe('ADMIN_TARGET_FORBIDDEN');

        const email = await call('PATCH', `/api/staff/${b.id}`, cookie(a), { email: 'atacante@example.com' });
        expect(email.status).toBe(403);
        expect(email.body.code).toBe('ADMIN_TARGET_FORBIDDEN');

        // Promover e trocar o e-mail no mesmo PATCH também não passa (já foi ADMIN).
        const both = await call('PATCH', `/api/staff/${b.id}`, cookie(a), { role: 'ADMIN', email: 'atacante@example.com' });
        expect(both.status).toBe(403);

        const row = await prisma.user.findUniqueOrThrow({ where: { id: b.id } });
        expect(row.passwordHash).toBe('hash-do-dono');
        expect(row.email).toBe('dono@example.com');
        expect(row.role).toBe('COLABORADOR');
        expect(await prisma.auditLog.count({ where: { entityId: b.id, action: { in: ['STAFF_PASSWORD_SET', 'STAFF_EMAIL_CHANGED'] } } })).toBe(0);

        // Nome, cargo e permissões continuam editáveis; diferença só de maiúsculas no e-mail não é troca.
        const ok = await call('PATCH', `/api/staff/${b.id}`, cookie(a), { name: 'Dono Rebaixado', email: 'DONO@example.com' });
        expect(ok.status).toBe(200);
    });

    it('controle: COLABORADOR que nunca foi ADMIN aceita senha e e-mail; um promovido e rebaixado depois não', async () => {
        const a = await mkUser({ role: 'ADMIN' });
        const colab = await mkStaff({ permissions: ['clientes.ver'] });
        expect((await call('POST', `/api/staff/${colab.id}/password`, cookie(a), { password: 'senha-forte-1' })).status).toBe(200);
        expect((await call('PATCH', `/api/staff/${colab.id}`, cookie(a), { email: 'colab.ok@example.com' })).status).toBe(200);

        // Promovido a ADMIN e rebaixado de novo: daí em diante, regra de ADMIN.
        expect((await call('PATCH', `/api/staff/${colab.id}`, cookie(a), { role: 'ADMIN' })).status).toBe(200);
        expect((await call('PATCH', `/api/staff/${colab.id}`, cookie(a), { role: 'COLABORADOR' })).status).toBe(200);
        const pwd = await call('POST', `/api/staff/${colab.id}/password`, cookie(a), { password: 'outra-senha-1' });
        expect(pwd.status).toBe(403);
        expect(pwd.body.code).toBe('ADMIN_TARGET_FORBIDDEN');
    });
});

// ─── AUTH-03 ─────────────────────────────────────────────

describe('trocar o e-mail de login desfaz o vínculo com o Google (AUTH-03)', () => {
    it('cliente: e-mail novo → googleId null; só maiúsculas diferentes → mantém', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const acesso = await mkStaff({ permissions: ['clientes.ver', 'clientes.acesso'] });
        const c1 = await mkUser({ email: 'maria.s@example.com', googleId: 'g-1' });
        const c2 = await mkUser({ email: 'joana@example.com', googleId: 'g-2', passwordHash: 'hash-c2' });

        const r = await call('PATCH', `/api/users/${c1.id}`, cookie(acesso), { email: 'maria.silva@example.com' });
        expect(r.status).toBe(200);
        const row1 = await prisma.user.findUniqueOrThrow({ where: { id: c1.id } });
        expect(row1.email).toBe('maria.silva@example.com');
        expect(row1.googleId).toBeNull();

        // Só caixa diferente: normalização, sem desvincular (e sem mexer na senha do cliente).
        const caseOnly = await call('PATCH', `/api/users/${c2.id}`, cookie(admin), { email: 'JOANA@example.com' });
        expect(caseOnly.status).toBe(200);
        const row2 = await prisma.user.findUniqueOrThrow({ where: { id: c2.id } });
        expect(row2.googleId).toBe('g-2');
        expect(row2.passwordHash).toBe('hash-c2');

        // A auditoria de cadastro não ganha o campo técnico googleId.
        const updated = await prisma.auditLog.findMany({ where: { entityId: c1.id, action: 'CLIENT_UPDATED' } });
        expect(updated.every((a) => !String(a.changes).includes('googleId'))).toBe(true);
    });

    it('colaborador: e-mail novo → googleId e senha apagados (mensagem avisa); só maiúsculas → mantém', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const colab = await mkStaff({ overrides: { email: 'colab.errado@example.com', googleId: 'g-3', passwordHash: 'hash-colab' } });
        const other = await mkStaff({ overrides: { email: 'colab.caixa@example.com', googleId: 'g-4', passwordHash: 'hash-other' } });
        const semSenha = await mkStaff({ overrides: { email: 'colab.semsenha@example.com', googleId: 'g-5' } });

        const r = await call('PATCH', `/api/staff/${colab.id}`, cookie(admin), { email: 'colab.certo@example.com' });
        expect(r.status).toBe(200);
        expect(r.body.message).toContain('senha antiga foi apagada');
        const row = await prisma.user.findUniqueOrThrow({ where: { id: colab.id } });
        expect(row.email).toBe('colab.certo@example.com');
        expect(row.googleId).toBeNull();
        expect(row.passwordHash).toBeNull();

        const caseOnly = await call('PATCH', `/api/staff/${other.id}`, cookie(admin), { email: 'Colab.Caixa@Example.com' });
        expect(caseOnly.status).toBe(200);
        const rowOther = await prisma.user.findUniqueOrThrow({ where: { id: other.id } });
        expect(rowOther.googleId).toBe('g-4');
        expect(rowOther.passwordHash).toBe('hash-other');

        // Sem senha antes: desvincula o Google e a mensagem não fala de senha.
        const r3 = await call('PATCH', `/api/staff/${semSenha.id}`, cookie(admin), { email: 'colab.semsenha2@example.com' });
        expect(r3.status).toBe(200);
        expect(r3.body.message).not.toContain('senha');
        expect((await prisma.user.findUniqueOrThrow({ where: { id: semSenha.id } })).googleId).toBeNull();
    });
});

// ─── AUTH-04 ─────────────────────────────────────────────

describe('conta BLOCKED não altera o perfil nem recebe cookies novos (AUTH-04)', () => {
    it('colaborador desativado com a revogação perdida: senha, nome e foto → 401 ACCOUNT_DISABLED, sem Set-Cookie', async () => {
        const passwordHash = await bcrypt.hash('senha-antiga-1', 4);
        const colab = await mkStaff({ permissions: ['clientes.ver'], overrides: { passwordHash } });
        const tok = cookie(colab);
        // Desativado direto no banco, SEM revokeUserSessions (simula o Redis fora do ar no Desativar).
        await prisma.user.update({ where: { id: colab.id }, data: { clientStatus: 'BLOCKED' } });

        const pwd = await call('PATCH', '/api/auth/profile', tok, { password: 'novaSenha1' });
        expect(pwd.status).toBe(401);
        expect(pwd.body.code).toBe('ACCOUNT_DISABLED');
        expect(pwd.setCookies).toHaveLength(0);

        const name = await call('PATCH', '/api/auth/profile', tok, { name: 'Nome Novo' });
        expect(name.status).toBe(401);
        expect(name.body.code).toBe('ACCOUNT_DISABLED');

        const photo = await uploadPhoto(tok);
        expect(photo.status).toBe(401);
        expect(photo.body.code).toBe('ACCOUNT_DISABLED');

        const row = await prisma.user.findUniqueOrThrow({ where: { id: colab.id } });
        expect(row.passwordHash).toBe(passwordHash);
        expect(row.name).toBe(colab.name);
        expect(row.photoUrl).toBeNull();
    });

    it('cliente bloqueado: 401 com a mensagem de cliente; excluído continua 404; ativo segue gravando', async () => {
        const blocked = await mkUser({ clientStatus: 'BLOCKED' });
        const r = await call('PATCH', '/api/auth/profile', cookie(blocked), { name: 'Outro Nome' });
        expect(r.status).toBe(401);
        expect(r.body.code).toBe('ACCOUNT_DISABLED');
        expect(r.body.error).toContain('bloqueada');

        const deleted = await mkUser({ deletedAt: new Date(), email: null });
        expect((await call('PATCH', '/api/auth/profile', cookie(deleted), { name: 'Outro Nome' })).status).toBe(404);
        expect((await uploadPhoto(cookie(deleted))).status).toBe(404);

        const active = await mkUser();
        const ok = await call('PATCH', '/api/auth/profile', cookie(active), { name: 'Nome Ativo' });
        expect(ok.status).toBe(200);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: active.id } })).name).toBe('Nome Ativo');
    });
});
