import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
import { errorHandler } from '../../src/middleware/errorHandler';
import { mkUser, mkStaff } from './factories';

// Rodada 4, frente R4b — pendência do r3-R3a: POST /auth/login (senha) e PATCH /auth/profile faziam
// `throw err` no catch para erro que não era Zod/P2002. Num handler async do Express 4 isso vira rejeição não
// tratada (o errorHandler global nem a recebe) e a requisição fica SEM resposta até o cliente desistir.
// Agora: 500 { error: 'Não foi possível concluir agora. Tente novamente em instantes.' }, registrado no log,
// sem Set-Cookie. Zod (400) e P2002 do perfil (409) não mudam.

// Banco "fora do ar" sob demanda: o prisma real num Proxy que repassa tudo, exceto prisma.user.<método>
// enquanto houver falhas na fila dele (cada chamada consome uma).
const fault = vi.hoisted(() => ({ user: {} as Record<string, Error[]> }));
vi.mock('../../src/lib/prisma', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/prisma')>();
    const real = orig.prisma;
    const bound = (target: object, value: unknown) => (typeof value === 'function' ? value.bind(target) : value);
    const user = new Proxy(real.user, {
        get(target, prop) {
            const value = Reflect.get(target, prop);
            if (typeof prop === 'string' && typeof value === 'function') {
                return (...args: unknown[]) => {
                    const failure = fault.user[prop]?.shift();
                    if (failure) return Promise.reject(failure);
                    return (value as (...a: unknown[]) => unknown).apply(target, args);
                };
            }
            return value;
        },
    });
    const prisma = new Proxy(real, {
        get(target, prop) {
            return prop === 'user' ? user : bound(target, Reflect.get(target, prop));
        },
    });
    return { ...orig, prisma };
});

let server: Server;
let base = '';
const redisKeys: string[] = [];

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authRoutes);
    app.use(errorHandler); // como no index.ts — e mesmo assim o `throw` antigo não chegava nele
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
    fault.user = {};
    vi.restoreAllMocks();
    const keys = redisKeys.splice(0);
    if (keys.length) await redis.del(...keys);
});

const UNEXPECTED = { error: 'Não foi possível concluir agora. Tente novamente em instantes.' };
const dbDown = () => new Error("Can't reach database server at localhost:5436");
const failNext = (method: string, err: Error = dbDown()) => { (fault.user[method] ??= []).push(err); };

type Who = { id: string; email: string | null; role: string };
function accessCookie(u: Who) {
    redisKeys.push(`auth:revoked:${u.id}`);
    return `accessToken=${jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' })}`;
}

/** Com prazo: sem resposta (o bug) vira falha em 4 s, não um teste pendurado até o timeout da suíte. */
async function call(method: string, path: string, cookieHeader?: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: {
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(4000),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as any, setCookies: res.headers.getSetCookie() };
}

const logged = (spy: ReturnType<typeof vi.spyOn>, tag: string) =>
    spy.mock.calls.some((args) => args[0] === tag && args[1] instanceof Error);

describe('POST /auth/login — erro de banco responde 500 (nunca fica sem resposta)', () => {
    it('falha na leitura do usuário → 500 genérico, logado, sem Set-Cookie; com o banco de volta, entra', async () => {
        const colab = await mkStaff({ permissions: ['clientes.ver'], overrides: { passwordHash: await bcrypt.hash('senha-r4-login', 4) } });
        redisKeys.push(`auth:revoked:${colab.id}`);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        failNext('findUnique');
        const down = await call('POST', '/api/auth/login', undefined, { email: colab.email, password: 'senha-r4-login' });
        expect(down.status).toBe(500);
        expect(down.body).toEqual(UNEXPECTED); // nada do erro cru (host/porta do banco) para o cliente
        expect(down.setCookies).toHaveLength(0);
        expect(fault.user.findUnique).toHaveLength(0);
        expect(logged(errSpy, '[AUTH] login error:')).toBe(true);

        const ok = await call('POST', '/api/auth/login', undefined, { email: colab.email, password: 'senha-r4-login' });
        expect(ok.status).toBe(200);
        expect(ok.body.user).toMatchObject({ id: colab.id, role: 'COLABORADOR', permissions: ['clientes.ver'] });
        expect(ok.setCookies.some((c) => c.startsWith('accessToken='))).toBe(true);
    });

    it('controles: corpo inválido continua 400 e senha errada 401', async () => {
        const client = await mkUser({ passwordHash: await bcrypt.hash('senha-r4-cli', 4) });
        const bad = await call('POST', '/api/auth/login', undefined, { email: 'nao-e-email', password: 'x' });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toBe('Dados inválidos.');
        const wrong = await call('POST', '/api/auth/login', undefined, { email: client.email, password: 'outra' });
        expect(wrong.status).toBe(401);
    });
});

describe('PATCH /auth/profile — erro de banco responde 500 (nunca fica sem resposta)', () => {
    it('falha na leitura da conta → 500 genérico e logado; nada gravado', async () => {
        const client = await mkUser({ name: 'Cliente Original' });
        const ac = accessCookie(client);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        failNext('findUnique');
        const r = await call('PATCH', '/api/auth/profile', ac, { name: 'Cliente Novo' });
        expect(r.status).toBe(500);
        expect(r.body).toEqual(UNEXPECTED);
        expect(r.setCookies).toHaveLength(0);
        expect(logged(errSpy, '[AUTH] profile update error:')).toBe(true);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: client.id } })).name).toBe('Cliente Original');
    });

    it('falha na gravação → 500 genérico, nada gravado; com o banco de volta, salva', async () => {
        const colab = await mkStaff({ permissions: ['hoje.ver'], overrides: { name: 'Colab Original' } });
        const ac = accessCookie(colab);
        vi.spyOn(console, 'error').mockImplementation(() => {});

        failNext('update');
        const r = await call('PATCH', '/api/auth/profile', ac, { name: 'Colab Novo' });
        expect(r.status).toBe(500);
        expect(r.body).toEqual(UNEXPECTED);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: colab.id } })).name).toBe('Colab Original');

        const ok = await call('PATCH', '/api/auth/profile', ac, { name: 'Colab Novo' });
        expect(ok.status).toBe(200);
        expect(ok.body.user).toMatchObject({ name: 'Colab Novo', permissions: ['hoje.ver'] });
    });

    it('controles: P2002 continua 409 do CPF/CNPJ e corpo inválido 400', async () => {
        const client = await mkUser();
        const ac = accessCookie(client);
        failNext('update', Object.assign(new Error('Unique constraint failed on the fields: (`cpf_cnpj`)'), { code: 'P2002' }));
        const dup = await call('PATCH', '/api/auth/profile', ac, { name: 'Outro Nome' });
        expect(dup.status).toBe(409);
        expect(dup.body).toEqual({ error: 'Este CPF/CNPJ já está cadastrado em outra conta.' });
        const bad = await call('PATCH', '/api/auth/profile', ac, { name: 'x' });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toBe('Dados inválidos.');
    });
});
