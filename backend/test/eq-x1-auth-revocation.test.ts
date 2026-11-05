import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Unit test puro (AUTH-01 / REG-2): sem banco nem Redis de verdade. O Redis vira um Map com TTL que
// respeita o relógio falso do vitest — assim dá para "esperar" horas e dias sem esperar de verdade.
const store = new Map<string, { v: string; exp: number }>();
const setCalls: Array<{ key: string; ttl: number }> = [];
vi.mock('../src/lib/redis.js', () => ({
    redis: {
        set: async (k: string, v: string, _ex: string, ttl: number) => {
            setCalls.push({ key: k, ttl });
            store.set(k, { v, exp: Date.now() + ttl * 1000 });
            return 'OK';
        },
        get: async (k: string) => {
            const e = store.get(k);
            if (!e) return null;
            if (Date.now() >= e.exp) { store.delete(k); return null; }
            return e.v;
        },
        del: async (k: string) => { store.delete(k); return 1; },
        exists: async () => 0,
    },
}));

import jwt from 'jsonwebtoken';
import { config } from '../src/config/index.js';
import {
    revokeUserSessions,
    isTokenRevoked,
    accessTokenTtlSeconds,
    revocationTtlSeconds,
} from '../src/middleware/auth.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const nowSec = () => Math.floor(Date.now() / 1000);

/** Assina um refresh token como o generateTokens faz (mesmo segredo e validade). */
function signRefresh(userId: string): { token: string; iat: number } {
    const token = jwt.sign({ userId, email: 'c@x.com', role: 'COLABORADOR' }, config.jwt.refreshSecret, {
        expiresIn: config.jwt.refreshExpiry as jwt.SignOptions['expiresIn'],
    });
    return { token, iat: (jwt.decode(token) as { iat: number }).iat };
}

describe('revogação de sessão cobre toda a validade do refresh token (AUTH-01 / REG-2)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
        store.clear();
        setCalls.length = 0;
    });
    afterEach(() => { vi.useRealTimers(); });

    it('a chave vive pelo menos a validade do refresh token (não só a do access token)', async () => {
        await revokeUserSessions('u1');
        expect(setCalls).toHaveLength(1);
        expect(setCalls[0].key).toBe('auth:revoked:u1');
        expect(setCalls[0].ttl).toBeGreaterThanOrEqual(accessTokenTtlSeconds(config.jwt.refreshExpiry));
        expect(setCalls[0].ttl).toBeGreaterThan(accessTokenTtlSeconds() + 60);
        expect(revocationTtlSeconds()).toBe(Math.max(accessTokenTtlSeconds(), accessTokenTtlSeconds(config.jwt.refreshExpiry)));
        // O parser entende '30d' (padrão) — 2.592.000 s.
        expect(accessTokenTtlSeconds('30d')).toBe(2_592_000);
    });

    it('refresh emitido antes da troca de senha continua recusado 2 h e 29 dias depois', async () => {
        // Refresh emitido 10 min antes da revogação (ex.: PC compartilhado da recepção).
        vi.setSystemTime(new Date('2026-11-04T11:50:00Z'));
        const old = signRefresh('u1');

        vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
        await revokeUserSessions('u1'); // troca de senha / e-mail / "Definir senha"
        expect(await isTokenRevoked('u1', old.iat)).toBe(true);

        // Passou da validade do access token (1h + 60s) — antes a chave sumia aqui.
        vi.advanceTimersByTime(2 * HOUR);
        expect(() => jwt.verify(old.token, config.jwt.refreshSecret, { algorithms: ['HS256'] })).not.toThrow();
        expect(await isTokenRevoked('u1', old.iat)).toBe(true);

        // 29 dias depois: o refresh antigo ainda é um JWT válido (30d) e continua revogado.
        vi.advanceTimersByTime(29 * DAY - 2 * HOUR);
        expect(() => jwt.verify(old.token, config.jwt.refreshSecret, { algorithms: ['HS256'] })).not.toThrow();
        expect(await isTokenRevoked('u1', old.iat)).toBe(true);
    });

    it('token emitido DEPOIS da revogação (login novo / reemissão da própria troca) passa', async () => {
        await revokeUserSessions('u1');
        const revokedAt = nowSec();
        // Mesmo segundo da revogação: recusado (iat <= revokedAt).
        expect(await isTokenRevoked('u1', revokedAt)).toBe(true);
        // A troca da própria senha reemite com iat = agora + 1: passa.
        expect(await isTokenRevoked('u1', revokedAt + 1)).toBe(false);
        // Login legítimo horas depois: passa.
        vi.advanceTimersByTime(3 * HOUR);
        expect(await isTokenRevoked('u1', signRefresh('u1').iat)).toBe(false);
    });

    it('revogação posterior não encurta a cobertura da anterior (ex.: bloquear depois de trocar a senha)', async () => {
        vi.setSystemTime(new Date('2026-11-04T11:00:00Z'));
        const old = signRefresh('u1');
        vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
        await revokeUserSessions('u1'); // troca de senha
        vi.advanceTimersByTime(10 * 60 * 1000);
        await revokeUserSessions('u1'); // bloqueio
        // O segundo set também usa o TTL longo.
        expect(setCalls.every((c) => c.ttl >= accessTokenTtlSeconds(config.jwt.refreshExpiry))).toBe(true);
        vi.advanceTimersByTime(5 * DAY);
        expect(await isTokenRevoked('u1', old.iat)).toBe(true);
    });

    it('depois da validade inteira do refresh a chave expira (todo token anterior já expirou sozinho)', async () => {
        vi.setSystemTime(new Date('2026-11-04T11:59:00Z'));
        const old = signRefresh('u1');
        vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
        await revokeUserSessions('u1');
        vi.advanceTimersByTime((revocationTtlSeconds() + 61) * 1000);
        // A chave sumiu, mas o refresh antigo também já não passa no jwt.verify.
        expect(store.has('auth:revoked:u1') ? (store.get('auth:revoked:u1')!.exp > Date.now()) : false).toBe(false);
        expect(() => jwt.verify(old.token, config.jwt.refreshSecret, { algorithms: ['HS256'] })).toThrow();
    });
});
