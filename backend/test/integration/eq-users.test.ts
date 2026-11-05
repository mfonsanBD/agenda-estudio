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
import authRoutes from '../../src/modules/auth/routes';
import userRoutes from '../../src/modules/users/routes';
import { mkUser, mkStaff, mkCpf, mkPayment } from './factories';

// Frente B1 — /api/users só de CLIENTE (D1/D3/D9) e autenticação com o formato da equipe (D4):
//  • listagem com filtro positivo, `?role` só CLIENTE, diretório mínimo sem a ficha (crítica I5);
//  • alvo da equipe → 404 (leitura/edição) ou 400 (exclusão, I1); `role` fora do corpo;
//  • PATCH por valor alterado (clientes.editar × clientes.acesso; senha só ADMIN; CPF ainda vazio com
//    cobrancas.cobrar); trocar e-mail/senha/bloquear encerra as sessões do cliente; e-mail em minúsculas e
//    checagem sem diferenciar maiúsculas;
//  • /me, login e refresh com role/permissions/staffTitle; /me recusa BLOCKED; PATCH /auth/profile sem
//    `role`, senha ≥ 8 para a equipe e revogação das OUTRAS sessões; cadastro público sempre CLIENTE.

let server: Server;
let base = '';
const touched: string[] = [];

beforeAll(async () => {
    // Cadastro público com o código de teste (999999) — só fora de produção e com a flag.
    process.env.ALLOW_OTP_BYPASS = 'true';
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authRoutes);
    app.use('/api/users', userRoutes);
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
    touched.push(u.id);
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
    return { status: res.status, body: await res.json().catch(() => ({})) as any, setCookies: res.headers.getSetCookie() };
}

/** Cookie `accessToken=...` devolvido no Set-Cookie (para seguir com a sessão reemitida). */
function accessFromSetCookie(setCookies: string[]): string | null {
    const raw = setCookies.find(c => c.startsWith('accessToken='));
    return raw ? raw.split(';')[0] : null;
}

const audits = (entityId: string, action: string) =>
    prisma.auditLog.findMany({ where: { entityType: 'USER', entityId, action } });

// ─── GET /api/users ─────────────────────────────────────

describe('GET /api/users — só clientes', () => {
    it('filtro positivo CLIENTE: nem ADMIN nem COLABORADOR aparecem; ?role ≠ CLIENTE → 400', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const colab = await mkStaff({ permissions: ['clientes.ver'] });
        const client = await mkUser();

        const r = await call('GET', '/api/users', cookie(admin));
        expect(r.status).toBe(200);
        expect(r.body.users.map((u: { id: string }) => u.id)).toEqual([client.id]);
        expect((await call('GET', '/api/users?role=CLIENTE', cookie(admin))).body.users).toHaveLength(1);
        for (const role of ['ADMIN', 'COLABORADOR', 'x']) {
            const bad = await call('GET', `/api/users?role=${role}`, cookie(admin));
            expect(bad.status, role).toBe(400);
            expect(bad.body.code).toBe('ROLE_NOT_ALLOWED');
        }
        expect((await call('GET', '/api/users', cookie(colab))).body.users.map((u: { id: string }) => u.id)).toEqual([client.id]);
    });

    it('diretório mínimo { id, name, email, role } para quem só abre seletores (cupons/avisos); ficha com clientes.ver', async () => {
        const client = await mkUser({ cpfCnpj: mkCpf(), phone: '22 90000-0000' });
        await mkPayment(client.id, { status: 'PAID', paidAt: new Date(), amount: 1000 });
        const cupons = await mkStaff({ permissions: ['cupons.ver'] });
        const avisos = await mkStaff({ permissions: ['avisos.enviar'] });
        const agenda = await mkStaff({ permissions: ['agendamentos.ver'] });
        const recepcao = await mkStaff({ permissions: ['agendamentos.ver', 'agendamentos.criar'] });
        const ficha = await mkStaff({ permissions: ['clientes.ver'] });
        const nada = await mkStaff({ permissions: ['hoje.ver', 'financeiro.ver'] });

        for (const who of [cupons, avisos, agenda]) {
            const r = await call('GET', '/api/users', cookie(who));
            expect(r.status).toBe(200);
            expect(r.body.users).toEqual([{ id: client.id, name: client.name, email: client.email, role: 'CLIENTE' }]);
        }
        for (const who of [recepcao, ficha]) {
            const r = await call('GET', '/api/users', cookie(who));
            expect(r.status).toBe(200);
            expect(r.body.users[0]).toMatchObject({ id: client.id, cpfCnpj: client.cpfCnpj, phone: '22 90000-0000', totalPaid: 1000 });
        }
        const denied = await call('GET', '/api/users', cookie(nada));
        expect(denied.status).toBe(403);
        expect(denied.body.code).toBe('PERMISSION_DENIED');
        expect((await call('GET', '/api/users', cookie(client))).status).toBe(403);
    });

    it('GET /api/users/:id: clientes.ver; alvo da equipe → 404; excluído continua acessível', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const otherAdmin = await mkUser({ role: 'ADMIN' });
        const colab = await mkStaff({ permissions: ['clientes.ver'] });
        const semVer = await mkStaff({ permissions: ['agendamentos.ver'] });
        const client = await mkUser();
        const deleted = await mkUser({ deletedAt: new Date(), email: null });

        expect((await call('GET', `/api/users/${client.id}`, cookie(colab))).status).toBe(200);
        expect((await call('GET', `/api/users/${deleted.id}`, cookie(colab))).status).toBe(200);
        expect((await call('GET', `/api/users/${client.id}`, cookie(semVer))).status).toBe(403);
        for (const staffId of [otherAdmin.id, colab.id]) {
            const r = await call('GET', `/api/users/${staffId}`, cookie(admin));
            expect(r.status).toBe(404);
            expect(r.body.user).toBeUndefined();
        }
    });
});

// ─── POST /api/users ────────────────────────────────────

describe('POST /api/users — sempre CLIENTE', () => {
    it('role ≠ CLIENTE → 400; role CLIENTE é aceito e ignorado; e-mail em minúsculas; repetido sem diferenciar maiúsculas → 409', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const asAdmin = await call('POST', '/api/users', cookie(admin), { email: 'novo@example.com', name: 'Novo Admin', role: 'ADMIN', password: 'segredo1' });
        expect(asAdmin.status).toBe(400);
        expect(asAdmin.body.code).toBe('ROLE_NOT_ALLOWED');
        expect((await call('POST', '/api/users', cookie(admin), { email: 'novo@example.com', name: 'Novo', role: 'COLABORADOR' })).status).toBe(400);
        expect(await prisma.user.count({ where: { email: 'novo@example.com' } })).toBe(0);

        const ok = await call('POST', '/api/users', cookie(admin), { email: '  Novo.Cliente@Example.COM ', name: 'Novo Cliente', role: 'CLIENTE', password: 'segredo1' });
        expect(ok.status).toBe(201);
        expect(ok.body.user).toMatchObject({ email: 'novo.cliente@example.com', role: 'CLIENTE' });
        expect(await audits(ok.body.user.id, 'CLIENT_CREATED')).toHaveLength(1);

        await mkStaff({ overrides: { email: 'Equipe.Antiga@example.com' } });
        const dupe = await call('POST', '/api/users', cookie(admin), { email: 'equipe.antiga@EXAMPLE.com', name: 'Duplicado' });
        expect(dupe.status).toBe(409);
        expect(dupe.body.code).toBe('EMAIL_TAKEN');
    });

    it('colaborador com clientes.criar: sem senha cria (entra por código); com senha → 403 (só ADMIN); nascer bloqueado exige clientes.acesso', async () => {
        const colab = await mkStaff({ permissions: ['clientes.ver', 'clientes.criar'] });
        const noPwd = await call('POST', '/api/users', cookie(colab), { email: 'sem.senha@example.com', name: 'Sem Senha' });
        expect(noPwd.status).toBe(201);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: noPwd.body.user.id } })).passwordHash).toBeNull();

        const withPwd = await call('POST', '/api/users', cookie(colab), { email: 'com.senha@example.com', name: 'Com Senha', password: 'segredo1' });
        expect(withPwd.status).toBe(403);
        expect(withPwd.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'ADMIN' });
        const blocked = await call('POST', '/api/users', cookie(colab), { email: 'bloq@example.com', name: 'Bloqueado', clientStatus: 'BLOCKED' });
        expect(blocked.status).toBe(403);
        expect(blocked.body.permission).toBe('clientes.acesso');

        const semCriar = await mkStaff({ permissions: ['clientes.ver'] });
        expect((await call('POST', '/api/users', cookie(semCriar), { email: 'x@example.com', name: 'Xis' })).status).toBe(403);
        expect(await prisma.user.count({ where: { email: { in: ['com.senha@example.com', 'bloq@example.com', 'x@example.com'] } } })).toBe(0);
    });
});

// ─── PATCH /api/users/:id ───────────────────────────────

describe('PATCH /api/users/:id — por valor alterado', () => {
    it('alvo da equipe → 404 (sem promover, bloquear ou trocar senha de ninguém da equipe)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const otherAdmin = await mkUser({ role: 'ADMIN', passwordHash: 'h' });
        const colab = await mkStaff();
        for (const id of [otherAdmin.id, colab.id]) {
            expect((await call('PATCH', `/api/users/${id}`, cookie(admin), { clientStatus: 'BLOCKED' })).status).toBe(404);
            expect((await call('PATCH', `/api/users/${id}`, cookie(admin), { password: 'segredo1', email: 'tomado@example.com' })).status).toBe(404);
        }
        const after = await prisma.user.findUniqueOrThrow({ where: { id: otherAdmin.id } });
        expect(after).toMatchObject({ clientStatus: 'ACTIVE', passwordHash: 'h', role: 'ADMIN' });
    });

    it('role: ADMIN → 400 sem gravar nada; CLIENTE é ignorado', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const bad = await call('PATCH', `/api/users/${client.id}`, cookie(admin), { role: 'ADMIN', name: 'Virou Admin' });
        expect(bad.status).toBe(400);
        expect(bad.body.code).toBe('ROLE_NOT_ALLOWED');
        const row = await prisma.user.findUniqueOrThrow({ where: { id: client.id } });
        expect(row).toMatchObject({ role: 'CLIENTE', name: client.name });
        const ok = await call('PATCH', `/api/users/${client.id}`, cookie(admin), { role: 'CLIENTE', name: 'Nome Novo' });
        expect(ok.status).toBe(200);
        expect(ok.body.user).toMatchObject({ role: 'CLIENTE', name: 'Nome Novo' });
    });

    it('clientes.editar edita o cadastro (payload completo com o mesmo e-mail passa); e-mail e bloqueio exigem clientes.acesso', async () => {
        const editor = await mkStaff({ permissions: ['clientes.ver', 'clientes.editar'] });
        const client = await mkUser({ email: 'Cliente.Antigo@example.com', phone: '1' });

        // Modal de edição reenvia tudo: e-mail igual (só muda a caixa) e status igual não exigem acesso.
        const full = await call('PATCH', `/api/users/${client.id}`, cookie(editor), {
            name: 'Cliente Editado', email: 'cliente.antigo@example.com', phone: '2', clientStatus: 'ACTIVE', tags: ['vip'],
        });
        expect(full.status).toBe(200);
        const row = await prisma.user.findUniqueOrThrow({ where: { id: client.id } });
        expect(row).toMatchObject({ name: 'Cliente Editado', phone: '2', email: 'cliente.antigo@example.com', tags: ['vip'] });
        expect(await redis.get(`auth:revoked:${client.id}`)).toBeNull(); // normalizar a caixa não derruba sessão

        const email = await call('PATCH', `/api/users/${client.id}`, cookie(editor), { email: 'outro@example.com' });
        expect(email.status).toBe(403);
        expect(email.body.permission).toBe('clientes.acesso');
        const block = await call('PATCH', `/api/users/${client.id}`, cookie(editor), { clientStatus: 'BLOCKED' });
        expect(block.status).toBe(403);
        expect(block.body.permission).toBe('clientes.acesso');
        expect((await call('PATCH', `/api/users/${client.id}`, cookie(editor), { clientStatus: 'INACTIVE' })).status).toBe(200);

        // Sem nada para editar: corpo vazio não vira leitura gratuita.
        const nada = await mkStaff({ permissions: ['agendamentos.ver'] });
        expect((await call('PATCH', `/api/users/${client.id}`, cookie(nada), {})).status).toBe(403);
    });

    it('clientes.acesso troca o e-mail de login: minúsculas, sessões do cliente encerradas, auditoria; e-mail de outra conta → 409', async () => {
        const acesso = await mkStaff({ permissions: ['clientes.ver', 'clientes.acesso'] });
        const client = await mkUser({ email: 'login.antigo@example.com' });
        await mkUser({ email: 'Ja.Usado@example.com' });
        const clientToken = cookie(client);
        expect((await call('GET', '/api/auth/me', clientToken)).status).toBe(200);

        const taken = await call('PATCH', `/api/users/${client.id}`, cookie(acesso), { email: 'ja.usado@example.com' });
        expect(taken.status).toBe(409);
        expect(taken.body.code).toBe('EMAIL_TAKEN');

        const r = await call('PATCH', `/api/users/${client.id}`, cookie(acesso), { email: 'Login.Novo@Example.com' });
        expect(r.status).toBe(200);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: client.id } })).email).toBe('login.novo@example.com');
        expect((await call('GET', '/api/auth/me', clientToken)).status).toBe(401);
        const [audit] = await audits(client.id, 'CLIENT_ACCESS_CHANGED');
        expect(JSON.parse(audit.changes!)).toEqual({ email: true });
        expect(audit.changes).not.toContain('login.novo');
    });

    it('senha de cliente: só ADMIN (colaborador com tudo → 403); o ADMIN define e as sessões do cliente caem', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const colab = await mkStaff({ permissions: ['clientes.ver', 'clientes.editar', 'clientes.acesso'] });
        const client = await mkUser();
        const clientToken = cookie(client);

        const denied = await call('PATCH', `/api/users/${client.id}`, cookie(colab), { password: 'segredo1' });
        expect(denied.status).toBe(403);
        expect(denied.body.permission).toBe('ADMIN');
        expect((await prisma.user.findUniqueOrThrow({ where: { id: client.id } })).passwordHash).toBeNull();

        expect((await call('PATCH', `/api/users/${client.id}`, cookie(admin), { password: 'segredo1' })).status).toBe(200);
        expect(await bcrypt.compare('segredo1', (await prisma.user.findUniqueOrThrow({ where: { id: client.id } })).passwordHash!)).toBe(true);
        expect((await call('GET', '/api/auth/me', clientToken)).status).toBe(401);
    });

    it('CPF/CNPJ: com só cobrancas.cobrar preenche o CPF vazio (checkout) e não troca um CPF existente', async () => {
        const caixa = await mkStaff({ permissions: ['cobrancas.cobrar'] });
        const semCpf = await mkUser();
        const comCpf = await mkUser({ cpfCnpj: mkCpf() });
        const cpf = mkCpf();
        expect((await call('PATCH', `/api/users/${semCpf.id}`, cookie(caixa), { cpfCnpj: cpf })).status).toBe(200);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: semCpf.id } })).cpfCnpj).toBe(cpf);
        const change = await call('PATCH', `/api/users/${comCpf.id}`, cookie(caixa), { cpfCnpj: mkCpf() });
        expect(change.status).toBe(403);
        expect(change.body.permission).toBe('clientes.editar');
        // Mesmo CPF (só a máscara muda): nada muda → passa.
        const masked = `${comCpf.cpfCnpj!.slice(0, 3)}.${comCpf.cpfCnpj!.slice(3, 6)}.${comCpf.cpfCnpj!.slice(6, 9)}-${comCpf.cpfCnpj!.slice(9)}`;
        expect((await call('PATCH', `/api/users/${comCpf.id}`, cookie(caixa), { cpfCnpj: masked })).status).toBe(200);
    });
});

// ─── Exclusão, visão de pagamento e cobrança automática ──

describe('exclusão e rotas de cobrança do cliente', () => {
    it('DELETE e deletion-preview: clientes.excluir; conta da equipe (ADMIN ou COLABORADOR) → 400 (I1)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const excluir = await mkStaff({ permissions: ['clientes.ver', 'clientes.excluir'] });
        const semExcluir = await mkStaff({ permissions: ['clientes.ver', 'clientes.editar'] });
        const colab = await mkStaff();
        const client = await mkUser();

        for (const who of [admin, excluir]) {
            expect((await call('DELETE', `/api/users/${colab.id}`, cookie(who))).status).toBe(400);
            expect((await call('GET', `/api/users/${colab.id}/deletion-preview`, cookie(who))).status).toBe(400);
        }
        expect((await call('DELETE', `/api/users/${client.id}`, cookie(semExcluir))).status).toBe(403);
        expect((await call('GET', `/api/users/${client.id}/deletion-preview`, cookie(excluir))).status).toBe(200);
        expect(await prisma.user.count({ where: { id: colab.id } })).toBe(1);
    });

    it('payment-overview (clientes.ver, financeiro.ver ou cobrancas.automatica) e auto-charge (cobrancas.automatica): alvo da equipe → 404', async () => {
        const auto = await mkStaff({ permissions: ['clientes.ver', 'cobrancas.automatica'] });
        const fin = await mkStaff({ permissions: ['financeiro.ver'] });
        const ver = await mkStaff({ permissions: ['clientes.ver'] });
        const cupons = await mkStaff({ permissions: ['cupons.ver'] });
        const client = await mkUser({ autoChargeEnabled: true });
        const colab = await mkStaff();

        expect((await call('GET', `/api/users/${client.id}/payment-overview`, cookie(auto))).status).toBe(200);
        expect((await call('GET', `/api/users/${client.id}/payment-overview`, cookie(fin))).status).toBe(200);
        // DECISOES resposta 3 (EQ-REQ-05): quem abre o perfil (clientes.ver) vê o card "Pagamento".
        expect((await call('GET', `/api/users/${client.id}/payment-overview`, cookie(ver))).status).toBe(200);
        expect((await call('GET', `/api/users/${client.id}/payment-overview`, cookie(cupons))).status).toBe(403);
        expect((await call('GET', `/api/users/${colab.id}/payment-overview`, cookie(auto))).status).toBe(404);

        // O interruptor continua só com cobrancas.automatica.
        expect((await call('PATCH', `/api/users/${client.id}/auto-charge`, cookie(ver), { enabled: false })).status).toBe(403);
        expect((await call('PATCH', `/api/users/${client.id}/auto-charge`, cookie(fin), { enabled: false })).status).toBe(403);
        expect((await call('PATCH', `/api/users/${colab.id}/auto-charge`, cookie(auto), { enabled: false })).status).toBe(404);
        const off = await call('PATCH', `/api/users/${client.id}/auto-charge`, cookie(auto), { enabled: false });
        expect(off.status).toBe(200);
        expect(off.body.autoChargeEnabled).toBe(false);
        expect(await audits(client.id, 'AUTO_CHARGE_TOGGLED_BY_STAFF')).toHaveLength(1);
    });
});

// ─── Autenticação (D4) ──────────────────────────────────

describe('autenticação: formato da equipe, bloqueio e perfil', () => {
    it('login e refresh devolvem role, permissions e staffTitle (equipe); cliente com []', async () => {
        const passwordHash = await bcrypt.hash('senha-forte-1', 4);
        const colab = await mkStaff({ permissions: ['agendamentos.ver', 'agendamentos.criar'], title: 'Recepção', overrides: { passwordHash } });
        const client = await mkUser({ passwordHash });

        const login = await call('POST', '/api/auth/login', undefined, { email: colab.email, password: 'senha-forte-1' });
        expect(login.status).toBe(200);
        expect(login.body.user).toMatchObject({ id: colab.id, role: 'COLABORADOR', permissions: ['agendamentos.ver', 'agendamentos.criar'], staffTitle: 'Recepção' });

        const refresh = await call('POST', '/api/auth/refresh', refreshCookie(colab));
        expect(refresh.status).toBe(200);
        expect(refresh.body.user).toMatchObject({ role: 'COLABORADOR', permissions: ['agendamentos.ver', 'agendamentos.criar'] });

        const cl = await call('POST', '/api/auth/login', undefined, { email: client.email, password: 'senha-forte-1' });
        expect(cl.body.user).toMatchObject({ role: 'CLIENTE', permissions: [], staffTitle: null });
    });

    it('/me recusa conta BLOCKED com 401 ACCOUNT_DISABLED (sessão residual sem revogação)', async () => {
        const client = await mkUser({ clientStatus: 'BLOCKED' });
        const colab = await mkStaff({ overrides: { clientStatus: 'BLOCKED' } });
        const c = await call('GET', '/api/auth/me', cookie(client));
        expect(c.status).toBe(401);
        expect(c.body.code).toBe('ACCOUNT_DISABLED');
        const s = await call('GET', '/api/auth/me', cookie(colab));
        expect(s.status).toBe(401);
        expect(s.body).toEqual({ code: 'ACCOUNT_DISABLED', error: 'Seu acesso foi desativado. Fale com o administrador.' });
    });

    it('PATCH /auth/profile: `role` → 400; equipe precisa de senha ≥ 8 e a troca encerra as OUTRAS sessões', async () => {
        const colab = await mkStaff({ permissions: ['hoje.ver'] });
        const other = cookie(colab, nowSec() - 60); // outra sessão (outro aparelho)
        const current = cookie(colab, nowSec() - 30);

        const role = await call('PATCH', '/api/auth/profile', current, { role: 'ADMIN', name: 'Quero Ser Admin' });
        expect(role.status).toBe(400);
        expect(role.body.code).toBe('ROLE_NOT_ALLOWED');
        expect((await prisma.user.findUniqueOrThrow({ where: { id: colab.id } })).role).toBe('COLABORADOR');

        const short = await call('PATCH', '/api/auth/profile', current, { password: '1234567' });
        expect(short.status).toBe(400);
        expect(short.body.code).toBe('PASSWORD_TOO_SHORT');

        const ok = await call('PATCH', '/api/auth/profile', current, { password: 'senha-forte-1' });
        expect(ok.status).toBe(200);
        expect(ok.body.user).toMatchObject({ role: 'COLABORADOR', permissions: ['hoje.ver'] });
        const renewed = accessFromSetCookie(ok.setCookies);
        expect(renewed).not.toBeNull();
        expect((await call('GET', '/api/auth/me', other)).status).toBe(401); // outra sessão caiu
        expect((await call('GET', '/api/auth/me', renewed!)).status).toBe(200); // esta segue
    });

    it('PATCH /auth/profile de cliente: senha de 6 continua valendo e não derruba sessões', async () => {
        const client = await mkUser();
        const tok = cookie(client);
        const r = await call('PATCH', '/api/auth/profile', tok, { password: 'abc123', name: 'Cliente Perfil' });
        expect(r.status).toBe(200);
        expect(r.body.user).toMatchObject({ name: 'Cliente Perfil', permissions: [], staffTitle: null });
        expect((await call('GET', '/api/auth/me', tok)).status).toBe(200);
    });

    it('cadastro público é sempre CLIENTE e não reaproveita e-mail da equipe (sem diferenciar maiúsculas)', async () => {
        await mkStaff({ overrides: { email: 'Membro.Antigo@Example.com' } }); // cadastro antigo com maiúscula
        const taken = await call('POST', '/api/auth/register', undefined, { email: 'membro.antigo@example.com', password: 'abc123', name: 'Intruso', code: '999999' });
        expect(taken.status).toBe(409);
        expect(await prisma.user.count({ where: { email: 'membro.antigo@example.com' } })).toBe(0);

        const r = await call('POST', '/api/auth/register', undefined, { email: 'novo.publico@example.com', password: 'abc123', name: 'Público', code: '999999', role: 'ADMIN' });
        expect(r.status).toBe(201);
        expect(r.body.user).toMatchObject({ role: 'CLIENTE', permissions: [] });
        expect((await prisma.user.findUniqueOrThrow({ where: { email: 'novo.publico@example.com' } })).role).toBe('CLIENTE');
    });
});
