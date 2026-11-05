import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { config } from '../../src/config/index';
import { allPermissionKeys, ADMIN_ONLY_KEYS } from '../../src/config/staffPermissions';
import authRoutes from '../../src/modules/auth/routes';
import { mkUser, mkStaff } from './factories';

// Rodada 3, frente R3a — sessão (backend):
//  • POST /auth/refresh: QUALQUER erro do jwt.verify (inclusive o SyntaxError cru do jsonwebtoken quando o
//    payload não é JSON) é token inválido → 401, nunca 503;
//  • COLABORADOR cuja leitura de staff_profiles falha: nada de 200 com `permissions: []` (o menu sumiria como
//    se o acesso tivesse sido retirado). Refresh → 503 SESSION_REFRESH_UNAVAILABLE sem Set-Cookie; /me → 503
//    PERMISSIONS_UNAVAILABLE; login (senha, código, Google) → 503 com mensagem clara e sem Set-Cookie. Perfil
//    e foto, que já gravaram, respondem 200 SEM `permissions`/`staffTitle` (o front mantém as que tinha);
//  • ADMIN e CLIENTE não mudam: cliente nem consulta staff_profiles; ADMIN entra com acesso total (M1).

// staff_profiles "fora do ar" sob demanda: o prisma real num Proxy que repassa tudo, exceto
// `prisma.staffProfile.findUnique` enquanto houver falhas na fila (cada chamada consome uma). Conta as leituras.
const fault = vi.hoisted(() => ({ staffFindUnique: [] as Error[], staffReads: 0 }));
vi.mock('../../src/lib/prisma', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/prisma')>();
    const real = orig.prisma;
    const bound = (target: object, value: unknown) => (typeof value === 'function' ? value.bind(target) : value);
    const staffProfile = new Proxy(real.staffProfile, {
        get(target, prop) {
            if (prop === 'findUnique') {
                return async (...args: unknown[]) => {
                    fault.staffReads++;
                    const failure = fault.staffFindUnique.shift();
                    if (failure) throw failure;
                    return (Reflect.get(target, prop) as (...a: unknown[]) => Promise<unknown>).apply(target, args);
                };
            }
            return bound(target, Reflect.get(target, prop));
        },
    });
    const prisma = new Proxy(real, {
        get(target, prop) {
            return prop === 'staffProfile' ? staffProfile : bound(target, Reflect.get(target, prop));
        },
    });
    return { ...orig, prisma };
});

// Login Google sem rede: o verifyIdToken devolve o payload que o teste definir.
const google = vi.hoisted(() => ({ payload: null as Record<string, unknown> | null }));
vi.mock('google-auth-library', () => ({
    OAuth2Client: class {
        async verifyIdToken() {
            const p = google.payload;
            if (!p) throw new Error('id token inválido');
            return { getPayload: () => p };
        }
    },
}));

let server: Server;
let base = '';
const redisKeys: string[] = [];

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
    fault.staffFindUnique.length = 0;
    fault.staffReads = 0;
    google.payload = null;
    const keys = redisKeys.splice(0);
    if (keys.length) await redis.del(...keys);
});

type Who = { id: string; email: string | null; role: string };
const nowSec = () => Math.floor(Date.now() / 1000);
const b64url = (s: string) => Buffer.from(s).toString('base64url');

const REFRESH_INVALID = { error: 'Refresh token inválido ou expirado.' };
const REFRESH_UNAVAILABLE = {
    code: 'SESSION_REFRESH_UNAVAILABLE',
    error: 'Não foi possível renovar a sessão agora. Tente novamente em instantes.',
};
const PERMISSIONS_UNAVAILABLE = {
    code: 'PERMISSIONS_UNAVAILABLE',
    error: 'Não foi possível verificar suas permissões agora. Tente novamente em instantes.',
};
const LOGIN_UNAVAILABLE = {
    code: 'PERMISSIONS_UNAVAILABLE',
    error: 'Não foi possível entrar agora: as permissões do seu acesso não puderam ser carregadas. Tente novamente em instantes.',
};
const LOGIN_CODE_UNAVAILABLE = {
    code: 'PERMISSIONS_UNAVAILABLE',
    error: 'Não foi possível entrar agora: as permissões do seu acesso não puderam ser carregadas. Peça um novo código e tente novamente em instantes.',
};

/** Tabela ausente (migration que não entrou) e banco fora do ar: as duas falhas que importam. */
const missingTable = () => Object.assign(
    new Error('The table `public.staff_profiles` does not exist in the current database.'), { code: 'P2021' },
);
const dbDown = () => new Error("Can't reach database server at localhost:5436");

function accessCookie(u: Who, iat?: number) {
    redisKeys.push(`auth:revoked:${u.id}`);
    const payload = { userId: u.id, email: u.email ?? '', role: u.role, ...(iat ? { iat } : {}) };
    return `accessToken=${jwt.sign(payload, config.jwt.secret, { expiresIn: '1h' })}`;
}

function refreshCookie(u: Who, iat?: number) {
    redisKeys.push(`auth:revoked:${u.id}`);
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

const refresh = (cookieHeader?: string) => call('POST', '/api/auth/refresh', cookieHeader);
const hasAuthCookies = (setCookies: string[]) =>
    setCookies.some((c) => c.startsWith('accessToken=')) && setCookies.some((c) => c.startsWith('refreshToken='));

async function staffWithPassword(password: string, extra: Parameters<typeof mkStaff>[0] = {}) {
    return mkStaff({
        permissions: ['agendamentos.ver', 'clientes.ver'],
        title: 'Recepção',
        ...extra,
        overrides: { passwordHash: await bcrypt.hash(password, 4), ...(extra.overrides ?? {}) },
    });
}

// ─── 1) POST /auth/refresh: qualquer erro do jwt.verify → 401 ───

describe('POST /auth/refresh — qualquer erro do jwt.verify é token inválido (401)', () => {
    it("payload 'nao-json' (SyntaxError cru do jsonwebtoken) → 401 com o corpo de token inválido, sem Set-Cookie", async () => {
        const header = b64url('{"alg":"HS256","typ":"JWT"}');
        const payload = b64url('nao-json');
        const unsigned = `${header}.${payload}.x`;
        // Mesmo com a assinatura CERTA o decode falha antes (o payload é lido como JSON por causa do typ 'JWT').
        const signed = `${header}.${payload}.${createHmac('sha256', config.jwt.refreshSecret).update(`${header}.${payload}`).digest('base64url')}`;
        // Header que não é JSON: o jsonwebtoken já o trata como JsonWebTokenError (controle).
        const badHeader = `${b64url('nao-json')}.${payload}.x`;

        // A causa do bug: o verify lança SyntaxError (não JsonWebTokenError) para o payload que não é JSON.
        for (const token of [unsigned, signed]) {
            let thrown: unknown;
            try { jwt.verify(token, config.jwt.refreshSecret, { algorithms: ['HS256'] }); } catch (err) { thrown = err; }
            expect(thrown).toBeInstanceOf(SyntaxError);
            expect(thrown).not.toBeInstanceOf(jwt.JsonWebTokenError);
        }

        for (const token of [unsigned, signed, badHeader]) {
            const r = await refresh(`refreshToken=${token}`);
            expect(r.status).toBe(401);
            expect(r.body).toEqual(REFRESH_INVALID);
            expect(r.setCookies).toHaveLength(0);
        }
    });
});

// ─── 2) COLABORADOR com staff_profiles indisponível: 503, nunca 200 com [] ───

describe('COLABORADOR com staff_profiles indisponível → 503 (nunca 200 com permissions [])', () => {
    it('refresh → 503 SESSION_REFRESH_UNAVAILABLE sem Set-Cookie; o MESMO cookie renova quando a leitura volta', async () => {
        const colab = await mkStaff({ permissions: ['agendamentos.ver'], title: 'Recepção' });
        const rc = refreshCookie(colab, nowSec() - 60);
        for (const failure of [missingTable(), dbDown()]) {
            fault.staffFindUnique.push(failure);
            const down = await refresh(rc);
            expect(fault.staffFindUnique).toHaveLength(0); // a falha foi consumida pelo refresh
            expect(down.status).toBe(503);
            expect(down.body).toEqual(REFRESH_UNAVAILABLE);
            expect(down.setCookies).toHaveLength(0); // nem token novo, nem limpeza do cookie
        }
        const back = await refresh(rc);
        expect(back.status).toBe(200);
        expect(back.body.user).toMatchObject({ id: colab.id, role: 'COLABORADOR', permissions: ['agendamentos.ver'], staffTitle: 'Recepção' });
        expect(hasAuthCookies(back.setCookies)).toBe(true);
    });

    it('/me → 503 PERMISSIONS_UNAVAILABLE; com a leitura de volta, 200 com as permissões', async () => {
        const colab = await mkStaff({ permissions: ['clientes.ver'], title: 'Atendimento' });
        const ac = accessCookie(colab);
        fault.staffFindUnique.push(missingTable());
        const down = await call('GET', '/api/auth/me', ac);
        expect(down.status).toBe(503);
        expect(down.body).toEqual(PERMISSIONS_UNAVAILABLE);
        expect(down.body.user).toBeUndefined();
        expect(fault.staffFindUnique).toHaveLength(0);

        const back = await call('GET', '/api/auth/me', ac);
        expect(back.status).toBe(200);
        expect(back.body.user).toMatchObject({ id: colab.id, role: 'COLABORADOR', permissions: ['clientes.ver'], staffTitle: 'Atendimento' });
    });

    it('login por senha → 503 com mensagem clara e sem Set-Cookie; a mesma senha entra depois', async () => {
        const colab = await staffWithPassword('senha-colab-1');
        redisKeys.push(`auth:revoked:${colab.id}`);
        fault.staffFindUnique.push(dbDown());
        const down = await call('POST', '/api/auth/login', undefined, { email: colab.email, password: 'senha-colab-1' });
        expect(down.status).toBe(503);
        expect(down.body).toEqual(LOGIN_UNAVAILABLE);
        expect(down.setCookies).toHaveLength(0);
        expect(fault.staffFindUnique).toHaveLength(0);

        const ok = await call('POST', '/api/auth/login', undefined, { email: colab.email, password: 'senha-colab-1' });
        expect(ok.status).toBe(200);
        expect(ok.body.user).toMatchObject({ id: colab.id, role: 'COLABORADOR', permissions: ['agendamentos.ver', 'clientes.ver'], staffTitle: 'Recepção' });
        expect(hasAuthCookies(ok.setCookies)).toBe(true);

        // Controle: senha errada continua 401 sem nem chegar a ler as permissões.
        fault.staffReads = 0;
        const wrong = await call('POST', '/api/auth/login', undefined, { email: colab.email, password: 'outra-senha' });
        expect(wrong.status).toBe(401);
        expect(fault.staffReads).toBe(0);
    });

    it('login por código → 503 (pede um novo código) sem Set-Cookie; com um código novo, entra', async () => {
        const colab = await mkStaff({ permissions: ['hoje.ver'], title: 'Operador' });
        const email = colab.email!;
        redisKeys.push(`otp:${email}`, `otp:fail:${email}`, `auth:revoked:${colab.id}`);

        await redis.set(`otp:${email}`, '246810', 'EX', 600);
        fault.staffFindUnique.push(missingTable());
        const down = await call('POST', '/api/auth/login/verify-code', undefined, { email, code: '246810' });
        expect(down.status).toBe(503);
        expect(down.body).toEqual(LOGIN_CODE_UNAVAILABLE);
        expect(down.setCookies).toHaveLength(0);
        // A conferência consumiu o código (por isso a mensagem pede outro).
        expect(await redis.get(`otp:${email}`)).toBeNull();

        await redis.set(`otp:${email}`, '135790', 'EX', 600);
        const ok = await call('POST', '/api/auth/login/verify-code', undefined, { email, code: '135790' });
        expect(ok.status).toBe(200);
        expect(ok.body.user).toMatchObject({ id: colab.id, permissions: ['hoje.ver'], staffTitle: 'Operador' });
        expect(hasAuthCookies(ok.setCookies)).toBe(true);
    });

    it('login Google → 503 sem Set-Cookie (não o 401 genérico da rota); depois entra', async () => {
        const sub = `g-r3a-${Date.now()}`;
        const colab = await mkStaff({ permissions: ['agendamentos.ver'], overrides: { googleId: sub } });
        redisKeys.push(`auth:revoked:${colab.id}`);
        google.payload = { sub, email: colab.email, email_verified: true, name: colab.name };

        fault.staffFindUnique.push(dbDown());
        const down = await call('POST', '/api/auth/google', undefined, { idToken: 'id-token-de-teste' });
        expect(down.status).toBe(503);
        expect(down.body).toEqual(LOGIN_UNAVAILABLE);
        expect(down.setCookies).toHaveLength(0);

        const ok = await call('POST', '/api/auth/google', undefined, { idToken: 'id-token-de-teste' });
        expect(ok.status).toBe(200);
        expect(ok.body.user).toMatchObject({ id: colab.id, role: 'COLABORADOR', permissions: ['agendamentos.ver'] });
        expect(hasAuthCookies(ok.setCookies)).toBe(true);
    });

    it('perfil e foto (já gravados) → 200 SEM permissions/staffTitle; a troca da própria senha mantém a sessão', async () => {
        const colab = await mkStaff({ permissions: ['clientes.ver'], title: 'Recepção' });
        const ac = accessCookie(colab, nowSec() - 30);

        fault.staffFindUnique.push(missingTable());
        const p = await call('PATCH', '/api/auth/profile', ac, { name: 'Colab Renomeado' });
        expect(p.status).toBe(200);
        expect(p.body.user).toMatchObject({ id: colab.id, name: 'Colab Renomeado', role: 'COLABORADOR' });
        // Formato parcial: o front (mergeUser) mantém as permissões que já tinha em vez de zerar o menu.
        expect('permissions' in p.body.user).toBe(false);
        expect('staffTitle' in p.body.user).toBe(false);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: colab.id } })).name).toBe('Colab Renomeado');

        const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
        const form = new FormData();
        form.append('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'foto.png');
        fault.staffFindUnique.push(missingTable());
        const photoRes = await fetch(`${base}/api/auth/profile/photo`, { method: 'POST', headers: { Cookie: ac }, body: form });
        const photo = await photoRes.json() as any;
        expect(photoRes.status).toBe(200);
        expect(photo.user.photoUrl).toMatch(/^data:image\/jpeg;base64,/);
        expect('permissions' in photo.user).toBe(false);
        expect('staffTitle' in photo.user).toBe(false);
        expect(fault.staffFindUnique).toHaveLength(0);

        // Sem falha: o formato completo de sempre.
        const normal = await call('PATCH', '/api/auth/profile', ac, { phone: '21999990000' });
        expect(normal.status).toBe(200);
        expect(normal.body.user).toMatchObject({ permissions: ['clientes.ver'], staffTitle: 'Recepção' });

        // Por último (revoga as sessões anteriores): troca da própria senha com a leitura falhando — perfil
        // salvo e a sessão atual continua (cookies novos), também sem permissions no corpo.
        fault.staffFindUnique.push(dbDown());
        const pw = await call('PATCH', '/api/auth/profile', ac, { password: 'nova-senha-123' });
        expect(pw.status).toBe(200);
        expect('permissions' in pw.body.user).toBe(false);
        expect(hasAuthCookies(pw.setCookies)).toBe(true);
        expect(fault.staffFindUnique).toHaveLength(0);
    });
});

// ─── 3) ADMIN e CLIENTE não mudam ───

describe('ADMIN e CLIENTE não mudam com staff_profiles indisponível', () => {
    it('CLIENTE: login, refresh e /me nem consultam staff_profiles → 200 com permissions [] (a falha fica na fila)', async () => {
        const client = await mkUser({ passwordHash: await bcrypt.hash('senha-cliente-1', 4) });
        redisKeys.push(`auth:revoked:${client.id}`);
        fault.staffFindUnique.push(missingTable());

        const login = await call('POST', '/api/auth/login', undefined, { email: client.email, password: 'senha-cliente-1' });
        expect(login.status).toBe(200);
        expect(login.body.user).toMatchObject({ id: client.id, role: 'CLIENTE', permissions: [], staffTitle: null });
        expect(hasAuthCookies(login.setCookies)).toBe(true);

        const r = await refresh(refreshCookie(client));
        expect(r.status).toBe(200);
        expect(r.body.user).toMatchObject({ role: 'CLIENTE', permissions: [], staffTitle: null });

        const me = await call('GET', '/api/auth/me', accessCookie(client));
        expect(me.status).toBe(200);
        expect(me.body.user).toMatchObject({ role: 'CLIENTE', permissions: [], staffTitle: null });

        const p = await call('PATCH', '/api/auth/profile', accessCookie(client), { name: 'Cliente Novo' });
        expect(p.status).toBe(200);
        expect(p.body.user).toMatchObject({ name: 'Cliente Novo', permissions: [], staffTitle: null });

        expect(fault.staffReads).toBe(0);
        expect(fault.staffFindUnique).toHaveLength(1);
    });

    it('ADMIN: a falha não impede login, refresh nem /me — acesso total, staffTitle null (M1); sem falha, o cargo volta', async () => {
        const admin = await staffWithPassword('senha-admin-1', { role: 'ADMIN', title: 'Sócio', permissions: [] });
        redisKeys.push(`auth:revoked:${admin.id}`);
        const allAdmin = [...allPermissionKeys(), ...ADMIN_ONLY_KEYS].sort();

        fault.staffFindUnique.push(missingTable(), missingTable(), missingTable());
        const login = await call('POST', '/api/auth/login', undefined, { email: admin.email, password: 'senha-admin-1' });
        expect(login.status).toBe(200);
        expect(hasAuthCookies(login.setCookies)).toBe(true);
        const r = await refresh(refreshCookie(admin));
        expect(r.status).toBe(200);
        expect(hasAuthCookies(r.setCookies)).toBe(true);
        const me = await call('GET', '/api/auth/me', accessCookie(admin));
        expect(me.status).toBe(200);
        for (const res of [login, r, me]) {
            expect(res.body.user).toMatchObject({ id: admin.id, role: 'ADMIN', staffTitle: null });
            expect([...res.body.user.permissions].sort()).toEqual(allAdmin);
        }

        fault.staffFindUnique.length = 0;
        const fine = await call('GET', '/api/auth/me', accessCookie(admin));
        expect(fine.status).toBe(200);
        expect(fine.body.user).toMatchObject({ role: 'ADMIN', staffTitle: 'Sócio' });
        expect([...fine.body.user.permissions].sort()).toEqual(allAdmin);
    });
});
