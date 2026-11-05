import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { config } from '../../src/config/index';
import * as stripe from '../../src/lib/stripeService';
import {
    revokeUserSessions, readUserSessionRevocation, clearUserSessionRevocation, revocationTtlSeconds,
} from '../../src/middleware/auth';
import authRoutes from '../../src/modules/auth/routes';
import userRoutes from '../../src/modules/users/routes';
import { mkUser, mkStaff, mkContract, mkPayment } from './factories';

// Rodada 2, frente R2a — sessão (backend):
//  • NS-3: o POST /auth/refresh só responde 401 quando a sessão acabou de verdade (falha do jwt.verify,
//    sessão revogada com code SESSION_REVOKED, usuário inexistente; conta bloqueada/excluída segue com o
//    assertNotBlocked). Erro de banco ou inesperado → 503 SESSION_REFRESH_UNAVAILABLE, sem mexer no cookie;
//  • exclusão de cliente que FALHA não apaga uma revogação ANTERIOR (troca de senha/e-mail — F8, 30 dias):
//    a marca volta ao valor e à validade de antes; só as sessões que a exclusão derrubou voltam a valer.

vi.mock('../../src/lib/stripeService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/stripeService')>();
    return {
        ...orig,
        isStripeEnabled: vi.fn(async () => true),
        stripeGetPaymentIntent: vi.fn(),
        stripeCancelPaymentIntent: vi.fn(async () => ({ status: 'canceled', canceled: true })),
        stripeDetachPaymentMethod: vi.fn(async () => {}),
        stripeCancelSubscription: vi.fn(async () => {}),
        stripeDeleteCustomer: vi.fn(async () => {}),
    };
});

// Banco "fora do ar" sob demanda: o prisma real, embrulhado num Proxy que repassa tudo, exceto
// `prisma.user.findUnique` enquanto houver falhas na fila (cada chamada consome uma). vi.spyOn no delegate
// do Prisma não serve: ao restaurar, o método some (o delegate vem de um Proxy do próprio Prisma).
const dbFault = vi.hoisted(() => ({ userFindUnique: [] as Error[] }));
vi.mock('../../src/lib/prisma', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/prisma')>();
    const real = orig.prisma;
    const bound = (target: object, value: unknown) => (typeof value === 'function' ? value.bind(target) : value);
    const user = new Proxy(real.user, {
        get(target, prop) {
            if (prop === 'findUnique' && dbFault.userFindUnique.length > 0) {
                const failure = dbFault.userFindUnique.shift()!;
                return async () => { throw failure; };
            }
            return bound(target, Reflect.get(target, prop));
        },
    });
    const prisma = new Proxy(real, {
        get(target, prop) {
            return prop === 'user' ? user : bound(target, Reflect.get(target, prop));
        },
    });
    return { ...orig, prisma };
});

const getPI = vi.mocked(stripe.stripeGetPaymentIntent);

let server: Server;
let base = '';
const touched: string[] = [];

beforeAll(async () => {
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
    dbFault.userFindUnique.length = 0;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    const keys = touched.splice(0).map(id => `auth:revoked:${id}`);
    if (keys.length) await redis.del(...keys);
});

type Who = { id: string; email: string | null; role: string };
const nowSec = () => Math.floor(Date.now() / 1000);
const DAY_MS = 24 * 3600 * 1000;
const revokedKey = (id: string) => `auth:revoked:${id}`;
const UNAVAILABLE = 'SESSION_REFRESH_UNAVAILABLE';

function accessCookie(u: Who, iat?: number) {
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

const refresh = (cookieHeader?: string) => call('POST', '/api/auth/refresh', cookieHeader);

/** Cliente com um cartão "em processamento" no Stripe: o DELETE /api/users/:id dá 409 sem excluir nada. */
async function clientWithInflightCharge() {
    const client = await mkUser({ autoChargeEnabled: true });
    touched.push(client.id);
    const contract = await mkContract(client.id, { type: 'FIXO', status: 'ACTIVE' });
    await mkPayment(client.id, { contractId: contract.id, provider: 'STRIPE', providerRef: 'pi_r2a_processing', amount: 84000 });
    getPI.mockResolvedValue({ id: 'pi_r2a_processing', status: 'processing', amount: 84000, created: nowSec(), metadata: {} } as any);
    return client;
}

// ─── 1) POST /auth/refresh: 401 só para sessão que acabou; 503 para falha passageira (NS-3) ───

describe('POST /auth/refresh — erro de banco é 503, não fim de sessão (NS-3)', () => {
    it('banco indisponível → 503 SESSION_REFRESH_UNAVAILABLE sem Set-Cookie; com o banco de volta, o MESMO cookie renova', async () => {
        const client = await mkUser();
        const staff = await mkStaff({ permissions: ['clientes.ver'] });
        for (const who of [client, staff]) {
            const rc = refreshCookie(who, nowSec() - 60);
            const failures = [
                new Error("Can't reach database server at localhost:5436"),
                Object.assign(new Error('Timed out fetching a new connection from the connection pool.'), { code: 'P2024' }),
            ];
            for (const failure of failures) {
                dbFault.userFindUnique.push(failure);
                const down = await refresh(rc);
                expect(dbFault.userFindUnique).toHaveLength(0); // a falha foi consumida pelo refresh
                expect(down.status).toBe(503);
                expect(down.body.code).toBe(UNAVAILABLE);
                expect(down.body.error).toBe('Não foi possível renovar a sessão agora. Tente novamente em instantes.');
                // O cookie não é apagado (nenhum Set-Cookie: nem limpeza, nem token novo).
                expect(down.setCookies).toHaveLength(0);
            }
            const back = await refresh(rc);
            expect(back.status).toBe(200);
            expect(back.body.user.id).toBe(who.id);
            expect(back.setCookies.some((c) => c.startsWith('accessToken='))).toBe(true);
            expect(back.setCookies.some((c) => c.startsWith('refreshToken='))).toBe(true);
        }
    });

    it('só falha do jwt.verify dá 401: expirado, assinatura errada, lixo, sem userId; cookie ausente → 401', async () => {
        const client = await mkUser();
        touched.push(client.id);
        const payload = { userId: client.id, email: client.email ?? '', role: 'CLIENTE' };
        const expired = jwt.sign({ ...payload, iat: nowSec() - 7200, exp: nowSec() - 3600 }, config.jwt.refreshSecret);
        const wrongSecret = jwt.sign(payload, 'outro-segredo-qualquer', { expiresIn: '30d' });
        const accessAsRefresh = jwt.sign(payload, config.jwt.secret, { expiresIn: '1h' });
        const noUserId = jwt.sign({ email: client.email, role: 'CLIENTE' }, config.jwt.refreshSecret, { expiresIn: '30d' });
        const accessCase = config.jwt.secret !== config.jwt.refreshSecret ? [accessAsRefresh] : [];
        for (const token of [expired, wrongSecret, ...accessCase, 'nao-e-um-jwt', noUserId]) {
            const r = await refresh(`refreshToken=${token}`);
            expect(r.status).toBe(401);
            expect(r.body.error).toBe('Refresh token inválido ou expirado.');
            expect(r.body.code).toBeUndefined();
            expect(r.setCookies).toHaveLength(0);
        }
        const none = await refresh();
        expect(none.status).toBe(401);
        expect(none.body.error).toBe('Refresh token não encontrado.');
    });

    it('token revogado → 401 SESSION_REVOKED (refresh e rotas autenticadas); usuário inexistente → 401', async () => {
        const client = await mkUser();
        const before = nowSec() - 30;
        const oldRefresh = refreshCookie(client, before);
        const oldAccess = accessCookie(client, before);
        await revokeUserSessions(client.id);

        const r = await refresh(oldRefresh);
        expect(r.status).toBe(401);
        expect(r.body).toEqual({ error: 'Sessão encerrada. Faça login novamente.', code: 'SESSION_REVOKED' });
        expect(r.setCookies).toHaveLength(0);
        const me = await call('GET', '/api/auth/me', oldAccess);
        expect(me.status).toBe(401);
        expect(me.body.code).toBe('SESSION_REVOKED');

        // Login posterior à revogação renova normalmente.
        expect((await refresh(refreshCookie(client, nowSec() + 2))).status).toBe(200);

        const ghost = { id: randomUUID(), email: 'fantasma@example.com', role: 'CLIENTE' };
        const g = await refresh(refreshCookie(ghost));
        expect(g.status).toBe(401);
        expect(g.body.error).toBe('Usuário não encontrado.');
    });

    it('conta bloqueada/excluída continua com a resposta de antes (403 ACCOUNT_DISABLED, 401 Conta não encontrada.)', async () => {
        const blocked = await mkUser({ clientStatus: 'BLOCKED' });
        const b = await refresh(refreshCookie(blocked));
        expect(b.status).toBe(403);
        expect(b.body.code).toBe('ACCOUNT_DISABLED');
        expect(b.body.error).toContain('bloqueada');

        const disabledStaff = await mkStaff({ permissions: ['clientes.ver'], overrides: { clientStatus: 'BLOCKED' } });
        const s = await refresh(refreshCookie(disabledStaff));
        expect(s.status).toBe(403);
        expect(s.body.code).toBe('ACCOUNT_DISABLED');

        const deleted = await mkUser({ deletedAt: new Date(), email: null });
        const d = await refresh(refreshCookie(deleted));
        expect(d.status).toBe(401);
        expect(d.body.error).toBe('Conta não encontrada.');
        for (const res of [b, s, d]) expect(res.setCookies).toHaveLength(0);
    });
});

// ─── 2) Exclusão que falha devolve a revogação ao estado anterior (não a apaga) ───

describe('exclusão de cliente que falha não apaga a revogação anterior', () => {
    it('troca de senha (T1) → exclusão 409 → refresh anterior a T1 continua 401; a chave volta a T1 com a validade que restava', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await clientWithInflightCharge();
        const beforeT1 = nowSec() - 30;
        const oldRefresh = refreshCookie(client, beforeT1);

        expect((await call('PATCH', `/api/users/${client.id}`, accessCookie(admin), { password: 'senha-cliente-1' })).status).toBe(200);
        const t1 = await redis.get(revokedKey(client.id));
        const pttlT1 = await redis.pttl(revokedKey(client.id));
        expect(t1).not.toBeNull();
        expect(pttlT1).toBeGreaterThan(29 * DAY_MS);

        const del = await call('DELETE', `/api/users/${client.id}`, accessCookie(admin));
        expect(del.status).toBe(409);
        expect(del.body.error).toContain('em processamento no provedor');
        expect((await prisma.user.findUniqueOrThrow({ where: { id: client.id } })).deletedAt).toBeNull();

        // A marca é a da troca de senha, com a validade que ela ainda tinha (não 30 dias novos, nem apagada).
        expect(await redis.get(revokedKey(client.id))).toBe(t1);
        const pttlAfter = await redis.pttl(revokedKey(client.id));
        expect(pttlAfter).toBeLessThanOrEqual(pttlT1);
        expect(pttlAfter).toBeGreaterThan(pttlT1 - 15_000);

        const r = await refresh(oldRefresh);
        expect(r.status).toBe(401);
        expect(r.body.code).toBe('SESSION_REVOKED');
        // Controle: login depois da troca de senha renova.
        expect((await refresh(refreshCookie(client, nowSec() + 2))).status).toBe(200);
    });

    it('as sessões que só a exclusão derrubou voltam a valer; as anteriores à troca de senha, não', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await clientWithInflightCharge();
        // Troca de senha 10 minutos atrás (F8): revokedAt = T1, validade de 30 dias menos os 10 minutos.
        const t1 = nowSec() - 600;
        await redis.set(revokedKey(client.id), String(t1), 'EX', revocationTtlSeconds() + 60 - 600);
        const preT1 = refreshCookie(client, t1 - 60);     // sessão do aparelho que a troca de senha derrubou
        const postT1 = refreshCookie(client, t1 + 60);    // login do cliente depois da troca de senha
        expect((await refresh(postT1)).status).toBe(200);
        expect((await refresh(preT1)).status).toBe(401);

        // Durante a exclusão (consulta ao Stripe), a revogação provisória derruba também o login pós-T1.
        const during: { value: string | null; postT1Status: number } = { value: null, postT1Status: 0 };
        getPI.mockImplementation(async () => {
            during.value = await redis.get(revokedKey(client.id));
            during.postT1Status = (await refresh(postT1)).status;
            return { id: 'pi_r2a_processing', status: 'processing', amount: 84000, created: nowSec(), metadata: {} } as any;
        });

        const del = await call('DELETE', `/api/users/${client.id}`, accessCookie(admin));
        expect(del.status).toBe(409);
        expect(Number(during.value)).toBeGreaterThan(t1);
        expect(during.postT1Status).toBe(401);

        // Exclusão desfeita: volta T1. O login pós-T1 renova de novo; o anterior a T1 segue recusado.
        expect(await redis.get(revokedKey(client.id))).toBe(String(t1));
        expect(await redis.ttl(revokedKey(client.id))).toBeGreaterThan(29 * 24 * 3600);
        expect((await refresh(postT1)).status).toBe(200);
        const old = await refresh(preT1);
        expect(old.status).toBe(401);
        expect(old.body.code).toBe('SESSION_REVOKED');
    });

    it('revogação feita DURANTE a exclusão (outra troca de senha) é mantida pelo desfazer', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await clientWithInflightCharge();
        const t1 = nowSec() - 600;
        await redis.set(revokedKey(client.id), String(t1), 'EX', revocationTtlSeconds());
        let later = '';
        getPI.mockImplementation(async () => {
            // Outra revogação em outro segundo, no meio da exclusão (ex.: o admin trocou a senha de novo).
            later = String(Number(await redis.get(revokedKey(client.id))) + 3);
            await redis.set(revokedKey(client.id), later, 'EX', revocationTtlSeconds() + 60);
            return { id: 'pi_r2a_processing', status: 'processing', amount: 84000, created: nowSec(), metadata: {} } as any;
        });

        expect((await call('DELETE', `/api/users/${client.id}`, accessCookie(admin))).status).toBe(409);
        expect(await redis.get(revokedKey(client.id))).toBe(later);
        expect(await redis.ttl(revokedKey(client.id))).toBeGreaterThan(29 * 24 * 3600);
    });

    it('sem revogação anterior a chave some (como antes); Redis falhando na leitura → a revogação provisória é mantida', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const c1 = await clientWithInflightCharge();
        const session = accessCookie(c1, nowSec() - 30);
        expect((await call('DELETE', `/api/users/${c1.id}`, accessCookie(admin))).status).toBe(409);
        expect(await redis.exists(revokedKey(c1.id))).toBe(0);
        expect((await call('GET', '/api/auth/me', session)).status).toBe(200);

        // Leitura do estado anterior falha (estado desconhecido): não arrisca apagar nada — a sessão segue encerrada.
        const c2 = await clientWithInflightCharge();
        const session2 = accessCookie(c2, nowSec() - 30);
        const multi = vi.spyOn(redis, 'multi').mockImplementationOnce(() => { throw new Error('Connection is closed.'); });
        expect((await call('DELETE', `/api/users/${c2.id}`, accessCookie(admin))).status).toBe(409);
        expect(multi).toHaveBeenCalled();
        expect(await redis.exists(revokedKey(c2.id))).toBe(1);
        const me = await call('GET', '/api/auth/me', session2);
        expect(me.status).toBe(401);
        expect(me.body.code).toBe('SESSION_REVOKED');
    });
});

// ─── 3) Helpers de leitura/restauração da marca (Redis real) ───

describe('readUserSessionRevocation / clearUserSessionRevocation', () => {
    it('restaura valor e validade restante; sem expiração fica sem expiração; validade vencida → apaga; sem anterior → apaga', async () => {
        const id = randomUUID();
        touched.push(id);
        const key = revokedKey(id);

        expect(await readUserSessionRevocation(id)).toMatchObject({ value: null, pttlMs: null });

        await redis.set(key, '1000', 'EX', 3600);
        const snap = (await readUserSessionRevocation(id))!;
        expect(snap.value).toBe('1000');
        expect(snap.pttlMs).toBeGreaterThan(3590_000);
        const provisional = await revokeUserSessions(id);
        expect(provisional).not.toBeNull();
        await clearUserSessionRevocation(id, snap, { onlyIfValue: provisional! });
        expect(await redis.get(key)).toBe('1000');
        const pttl = await redis.pttl(key);
        expect(pttl).toBeGreaterThan(3500_000);
        expect(pttl).toBeLessThanOrEqual(3600_000);

        // Chave anterior sem expiração (ex.: gravada à mão pelo runbook) volta sem expiração.
        await redis.set(key, '2000');
        const snapNoTtl = (await readUserSessionRevocation(id))!;
        expect(snapNoTtl).toMatchObject({ value: '2000', pttlMs: null });
        await revokeUserSessions(id);
        await clearUserSessionRevocation(id, snapNoTtl);
        expect(await redis.get(key)).toBe('2000');
        expect(await redis.pttl(key)).toBe(-1);

        // A validade anterior já teria acabado enquanto a exclusão rodava → apaga.
        await revokeUserSessions(id);
        await clearUserSessionRevocation(id, { value: '3000', pttlMs: 1_000, readAt: Date.now() - 5_000 });
        expect(await redis.exists(key)).toBe(0);

        // Sem revogação anterior → apaga; onlyIfValue diferente do atual → não mexe.
        const p2 = await revokeUserSessions(id);
        await clearUserSessionRevocation(id, { value: null, pttlMs: null, readAt: Date.now() }, { onlyIfValue: `${p2}x` });
        expect(await redis.get(key)).toBe(p2);
        await clearUserSessionRevocation(id, { value: null, pttlMs: null, readAt: Date.now() }, { onlyIfValue: p2! });
        expect(await redis.exists(key)).toBe(0);
    });
});
