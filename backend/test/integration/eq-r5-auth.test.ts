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

// Rodada 5, frente R5c — pendências do r4-R4b (auth):
//  • POST /auth/google respondia 401 "Falha na autenticação via Google." para QUALQUER erro, inclusive banco fora
//    do ar depois de o token ser aceito. Agora: falha na verificação do token (Google) → 401 como antes; erro
//    depois dela (conta no banco, sessão) → 500 { error: 'Não foi possível concluir agora. Tente novamente em
//    instantes.' }, sem Set-Cookie — o mesmo padrão do login por senha. Corpo inválido → 400.
//  • PATCH /auth/profile: se a senha nova já foi gravada e algo falha depois (a releitura da conta antes de
//    reemitir os cookies da equipe), a resposta diz que a senha mudou — nunca o 500 genérico "não foi possível
//    concluir", que daria a entender que nada mudou.

// Banco "fora do ar" sob demanda: o prisma real num Proxy que repassa tudo, exceto prisma.user.<método>
// conforme a fila dele — cada chamada consome um item: um Error falha a chamada; null deixa passar (para
// derrubar só a 2ª leitura, por exemplo). Fila vazia = passa.
const fault = vi.hoisted(() => ({ user: {} as Record<string, Array<Error | null>> }));
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

// Login Google sem rede: o verifyIdToken devolve o payload que o teste definir (null = "não é um ID token").
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
const realFetch = globalThis.fetch;
const originalClientId = process.env.GOOGLE_CLIENT_ID;

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authRoutes);
    app.use(errorHandler); // como no index.ts
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
    fault.user = {};
    google.payload = null;
    vi.restoreAllMocks();
    if (originalClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = originalClientId;
    const keys = redisKeys.splice(0);
    if (keys.length) await redis.del(...keys);
});

const UNEXPECTED = { error: 'Não foi possível concluir agora. Tente novamente em instantes.' };
const GOOGLE_FAILED = { error: 'Falha na autenticação via Google.' };
const PASSWORD_SAVED_INCOMPLETE = {
    error: 'Sua senha foi alterada, mas não foi possível renovar o seu acesso agora. Se você for desconectado, entre com a nova senha.',
    code: 'PASSWORD_CHANGED',
};
const dbDown = () => new Error("Can't reach database server at localhost:5436");
/** A `nth` chamada (1 = a próxima) de prisma.user.<method> falha; as anteriores passam. */
const failCall = (method: string, nth = 1, err: Error = dbDown()) => {
    const queue = (fault.user[method] ??= []);
    for (let i = 1; i < nth; i++) queue.push(null);
    queue.push(err);
};

type Who = { id: string; email: string | null; role: string };
function accessCookie(u: Who) {
    redisKeys.push(`auth:revoked:${u.id}`);
    return `accessToken=${jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' })}`;
}

/** Com prazo: sem resposta vira falha em 4 s, não um teste pendurado até o timeout da suíte. */
async function call(method: string, path: string, cookieHeader?: string, body?: unknown) {
    const res = await realFetch(`${base}${path}`, {
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

/**
 * Fallback do access_token sem rede: o tokeninfo e o userinfo do Google respondem o que o teste mandar
 * (Response, ou Error = falha de rede). O resto (as chamadas do teste ao servidor) passa para o fetch real.
 */
function stubGoogleHttp(opts: { tokeninfo: Response | Error; userinfo?: Response | Error }) {
    process.env.GOOGLE_CLIENT_ID = 'cliente-google-r5';
    const answer = async (r: Response | Error | undefined) => {
        if (!r) throw new Error('chamada inesperada ao Google');
        if (r instanceof Error) throw r;
        return r;
    };
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) return answer(opts.tokeninfo);
        if (url.startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) return answer(opts.userinfo);
        return realFetch(input, init);
    });
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('POST /auth/google — erro depois da verificação do token é 500, não 401', () => {
    it('banco fora do ar ao procurar a conta pelo Google → 500 genérico, logado, sem Set-Cookie; com o banco de volta, entra', async () => {
        const sub = `google-r5-${Date.now()}`;
        const client = await mkUser({ googleId: sub });
        redisKeys.push(`auth:revoked:${client.id}`);
        google.payload = { sub, email: client.email, email_verified: true, name: client.name };
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        failCall('findFirst');
        const down = await call('POST', '/api/auth/google', undefined, { idToken: 'id-token-r5' });
        expect(down.status).toBe(500);
        expect(down.body).toEqual(UNEXPECTED); // nada do erro cru (host/porta do banco)
        expect(down.setCookies).toHaveLength(0);
        expect(fault.user.findFirst).toHaveLength(0);
        expect(logged(errSpy, '[AUTH:Google] login error:')).toBe(true);
        expect(logged(errSpy, '[AUTH:Google] Authentication error:')).toBe(false);

        const ok = await call('POST', '/api/auth/google', undefined, { idToken: 'id-token-r5' });
        expect(ok.status).toBe(200);
        expect(ok.body.user).toMatchObject({ id: client.id, role: 'CLIENTE' });
        expect(ok.setCookies.some((c) => c.startsWith('accessToken='))).toBe(true);
    });

    it('banco fora do ar ao criar a conta nova → 500 genérico e nada criado; depois cria e entra', async () => {
        const sub = `google-r5-novo-${Date.now()}`;
        const email = `google-r5-novo-${Date.now()}@example.com`;
        google.payload = { sub, email, email_verified: true, name: 'Pessoa Google' };
        vi.spyOn(console, 'error').mockImplementation(() => {});

        failCall('create');
        const down = await call('POST', '/api/auth/google', undefined, { idToken: 'id-token-r5' });
        expect(down.status).toBe(500);
        expect(down.body).toEqual(UNEXPECTED);
        expect(down.setCookies).toHaveLength(0);
        expect(await prisma.user.count({ where: { googleId: sub } })).toBe(0);

        const ok = await call('POST', '/api/auth/google', undefined, { idToken: 'id-token-r5' });
        expect(ok.status).toBe(200);
        redisKeys.push(`auth:revoked:${ok.body.user.id}`);
        expect(ok.body.user).toMatchObject({ email, role: 'CLIENTE' });
        expect(ok.setCookies.some((c) => c.startsWith('accessToken='))).toBe(true);
    });

    it('controles: falha na verificação do token continua 401 "Falha na autenticação via Google." (sem tocar no banco)', async () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        // Não é ID token; o tokeninfo aceita o access_token, mas o userinfo recusa → erro da verificação → 401.
        stubGoogleHttp({ tokeninfo: json(200, { aud: 'cliente-google-r5' }), userinfo: json(401, { error: 'invalid_token' }) });
        failCall('findFirst'); // se a rota chegasse ao banco, seria 500 — não chega
        const r = await call('POST', '/api/auth/google', undefined, { idToken: 'access-token-r5' });
        expect(r.status).toBe(401);
        expect(r.body).toEqual(GOOGLE_FAILED);
        expect(r.setCookies).toHaveLength(0);
        expect(fault.user.findFirst).toHaveLength(1); // a falha preparada ficou sem uso
        expect(logged(errSpy, '[AUTH:Google] Authentication error:')).toBe(true);
        expect(logged(errSpy, '[AUTH:Google] login error:')).toBe(false);
        vi.restoreAllMocks();

        // Rede do Google fora do ar no tokeninfo: também é a verificação → 401 (não o 500 do banco).
        vi.spyOn(console, 'error').mockImplementation(() => {});
        stubGoogleHttp({ tokeninfo: new TypeError('fetch failed') });
        const net = await call('POST', '/api/auth/google', undefined, { idToken: 'access-token-r5' });
        expect(net.status).toBe(401);
        expect(net.body).toEqual(GOOGLE_FAILED);
        vi.restoreAllMocks();

        // Os 401 explícitos da verificação não mudaram.
        stubGoogleHttp({ tokeninfo: json(400, { error: 'invalid_token' }) });
        const bad = await call('POST', '/api/auth/google', undefined, { idToken: 'access-token-r5' });
        expect(bad.status).toBe(401);
        expect(bad.body).toEqual({ error: 'Token Google inválido.' });
    });

    it('controle: corpo sem idToken → 400 "Dados inválidos." (como o login por senha), sem Set-Cookie', async () => {
        const r = await call('POST', '/api/auth/google', undefined, {});
        expect(r.status).toBe(400);
        expect(r.body.error).toBe('Dados inválidos.');
        expect(r.setCookies).toHaveLength(0);
    });
});

describe('PATCH /auth/profile — senha já gravada e falha depois: a resposta não esconde que a senha mudou', () => {
    it('equipe troca a própria senha e a releitura da conta falha → 500 dizendo que a senha mudou; a nova vale, esta sessão cai', async () => {
        const oldHash = await bcrypt.hash('senha-antiga-r5', 4);
        const colab = await mkStaff({ permissions: ['hoje.ver'], overrides: { passwordHash: oldHash, name: 'Colab R5' } });
        const ac = accessCookie(colab);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        // 1ª user.findUnique = loadWritableAccount (passa); 2ª = a releitura antes de reemitir os cookies (falha).
        failCall('findUnique', 2);
        const r = await call('PATCH', '/api/auth/profile', ac, { name: 'Colab R5 Novo', password: 'senha-nova-r5-123' });
        expect(r.status).toBe(500);
        expect(r.body).toEqual(PASSWORD_SAVED_INCOMPLETE);
        expect(r.setCookies).toHaveLength(0); // os cookies novos não saíram
        expect(fault.user.findUnique).toHaveLength(0);
        expect(logged(errSpy, '[AUTH] profile: senha gravada, falha depois:')).toBe(true);
        expect(logged(errSpy, '[AUTH] profile update error:')).toBe(false);

        // O que a mensagem afirma é verdade: a senha (e o resto do perfil) foi gravada…
        const after = await prisma.user.findUniqueOrThrow({ where: { id: colab.id }, select: { passwordHash: true, name: true } });
        expect(await bcrypt.compare('senha-nova-r5-123', after.passwordHash!)).toBe(true);
        expect(after.name).toBe('Colab R5 Novo');
        // …e esta sessão foi revogada (a pessoa é desconectada na próxima requisição).
        const me = await call('GET', '/api/auth/me', ac);
        expect(me.status).toBe(401);
        expect(me.body.code).toBe('SESSION_REVOKED');
    });

    it('controle: a gravação falha (nada mudou) → o 500 genérico de sempre, senha antiga intacta', async () => {
        const oldHash = await bcrypt.hash('senha-antiga-r5', 4);
        const colab = await mkStaff({ permissions: ['hoje.ver'], overrides: { passwordHash: oldHash } });
        const ac = accessCookie(colab);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        failCall('update');
        const r = await call('PATCH', '/api/auth/profile', ac, { password: 'senha-nova-r5-123' });
        expect(r.status).toBe(500);
        expect(r.body).toEqual(UNEXPECTED);
        expect(r.setCookies).toHaveLength(0);
        expect(logged(errSpy, '[AUTH] profile update error:')).toBe(true);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: colab.id } })).passwordHash).toBe(oldHash);
        expect((await call('GET', '/api/auth/me', ac)).status).toBe(200); // nada revogado
    });

    it('controle: a troca de senha da equipe sem falha → 200, cookies novos e a sessão segue', async () => {
        const colab = await mkStaff({ permissions: ['hoje.ver'], overrides: { passwordHash: await bcrypt.hash('senha-antiga-r5', 4) } });
        const ac = accessCookie(colab);
        const r = await call('PATCH', '/api/auth/profile', ac, { password: 'senha-nova-r5-123' });
        expect(r.status).toBe(200);
        expect(r.body.message).toBe('Perfil atualizado com sucesso.');
        expect(r.body.user).toMatchObject({ id: colab.id, permissions: ['hoje.ver'] });
        const fresh = r.setCookies.find((c) => c.startsWith('accessToken='));
        expect(fresh).toBeDefined();
        expect((await call('GET', '/api/auth/me', fresh!.split(';')[0])).status).toBe(200);
    });
});
