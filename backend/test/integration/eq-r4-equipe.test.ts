import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { config } from '../../src/config/index';
import staffRoutes from '../../src/modules/staff/routes';
import { mkUser, mkStaff } from './factories';

// Rodada 4, frente R4b — TELA-1 (lado servidor): todo membro devolvido por /api/staff traz
// `credentialsLocked` = papel ≠ COLABORADOR OU já foi ADMIN (auditoria STAFF_ROLE_CHANGED from ADMIN) — o
// mesmo critério do assertCredentialsEditable (E2), para a tela travar o e-mail e esconder "Definir senha" em
// vez de oferecer a troca e colher o 403 ADMIN_TARGET_FORBIDDEN. A lista calcula em LOTE (sem N+1).

// Conta as consultas à auditoria feitas pelo prisma "de fora" (a lista; as transações usam o tx real).
const audit = vi.hoisted(() => ({ findMany: 0, findFirst: 0 }));
vi.mock('../../src/lib/prisma', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/prisma')>();
    const real = orig.prisma;
    const bound = (target: object, value: unknown) => (typeof value === 'function' ? value.bind(target) : value);
    const auditLog = new Proxy(real.auditLog, {
        get(target, prop) {
            const value = Reflect.get(target, prop);
            if ((prop === 'findMany' || prop === 'findFirst') && typeof value === 'function') {
                return (...args: unknown[]) => {
                    audit[prop]++;
                    return (value as (...a: unknown[]) => unknown).apply(target, args);
                };
            }
            return bound(target, value);
        },
    });
    const prisma = new Proxy(real, {
        get(target, prop) {
            return prop === 'auditLog' ? auditLog : bound(target, Reflect.get(target, prop));
        },
    });
    return { ...orig, prisma };
});

let server: Server;
let base = '';
const touched: string[] = [];

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/staff', staffRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
    audit.findMany = 0;
    audit.findFirst = 0;
    const keys = touched.splice(0).map(id => `auth:revoked:${id}`);
    if (keys.length) await redis.del(...keys);
});

type Who = { id: string; email: string | null; role: string };

function cookie(u: Who) {
    touched.push(u.id);
    return `accessToken=${jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' })}`;
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

async function lockedById(adminCookie: string): Promise<Record<string, boolean>> {
    const r = await call('GET', '/api/staff', adminCookie);
    expect(r.status).toBe(200);
    for (const m of r.body.members) expect(typeof m.credentialsLocked, `credentialsLocked de ${m.name}`).toBe('boolean');
    return Object.fromEntries(r.body.members.map((m: { id: string; credentialsLocked: boolean }) => [m.id, m.credentialsLocked]));
}

/** "Já foi ADMIN" como a rebaixa grava (STAFF_ROLE_CHANGED from ADMIN), sem passar pela rota. */
const markExAdmin = (userId: string, performedBy: string) => prisma.auditLog.create({
    data: { entityType: 'USER', entityId: userId, action: 'STAFF_ROLE_CHANGED', performedBy, changes: JSON.stringify({ from: 'ADMIN', to: 'COLABORADOR' }) },
});

// ─── O ciclo de vida do flag ────────────────────────────

describe('credentialsLocked em toda resposta de /api/staff', () => {
    it('ADMIN e ex-ADMIN rebaixado → true; COLABORADOR que nunca foi ADMIN → false (PATCH, lista, desativar/reativar)', async () => {
        const dono = await mkUser({ role: 'ADMIN', name: 'Dono' });
        const bia = await mkUser({ role: 'ADMIN', name: 'Bia Sócia' });
        const ana = await mkStaff({ permissions: ['clientes.ver'], overrides: { name: 'Ana Recepção' } });
        const tok = cookie(dono);
        touched.push(bia.id, ana.id); // rebaixar/desativar revogam as sessões delas (chave no Redis)

        // Antes da rebaixa: dois ADMIN travados (inclusive o próprio dono), Ana livre.
        expect(await lockedById(tok)).toEqual({ [dono.id]: true, [bia.id]: true, [ana.id]: false });

        // Rebaixar Bia: a resposta do PATCH já sai travada (calculada na transação, depois da auditoria).
        const demote = await call('PATCH', `/api/staff/${bia.id}`, tok, { role: 'COLABORADOR', permissions: ['agendamentos.ver'] });
        expect(demote.status).toBe(200);
        expect(demote.body.member).toMatchObject({ id: bia.id, role: 'COLABORADOR', credentialsLocked: true });
        expect(await lockedById(tok)).toEqual({ [dono.id]: true, [bia.id]: true, [ana.id]: false });

        // Editar só o nome: segue travada (ex-ADMIN) — e Ana segue livre.
        const rename = await call('PATCH', `/api/staff/${bia.id}`, tok, { name: 'Bia Recepção' });
        expect(rename.body.member).toMatchObject({ name: 'Bia Recepção', credentialsLocked: true });
        const anaRename = await call('PATCH', `/api/staff/${ana.id}`, tok, { title: 'Recepção' });
        expect(anaRename.body.member).toMatchObject({ title: 'Recepção', credentialsLocked: false });

        // Desativar e reativar (os dois ramos: mudou e "já estava"): o flag vem em todas as respostas.
        for (const [path, id, locked] of [
            [`/api/staff/${bia.id}/deactivate`, bia.id, true],
            [`/api/staff/${bia.id}/deactivate`, bia.id, true], // já estava desativada
            [`/api/staff/${bia.id}/reactivate`, bia.id, true],
            [`/api/staff/${bia.id}/reactivate`, bia.id, true], // já estava ativa
            [`/api/staff/${ana.id}/deactivate`, ana.id, false],
            [`/api/staff/${ana.id}/reactivate`, ana.id, false],
        ] as const) {
            const r = await call('POST', path, tok);
            expect(r.status, path).toBe(200);
            expect(r.body.member, path).toMatchObject({ id, credentialsLocked: locked });
        }

        // Promover Ana a ADMIN → true; rebaixá-la de novo → continua true (agora é ex-ADMIN).
        const up = await call('PATCH', `/api/staff/${ana.id}`, tok, { role: 'ADMIN' });
        expect(up.body.member).toMatchObject({ role: 'ADMIN', credentialsLocked: true });
        const down = await call('PATCH', `/api/staff/${ana.id}`, tok, { role: 'COLABORADOR' });
        expect(down.body.member).toMatchObject({ role: 'COLABORADOR', credentialsLocked: true });
        expect(await lockedById(tok)).toEqual({ [dono.id]: true, [bia.id]: true, [ana.id]: true });
    });

    it('POST: COLABORADOR novo → false; ADMIN novo → true', async () => {
        const dono = await mkUser({ role: 'ADMIN' });
        const tok = cookie(dono);
        const colab = await call('POST', '/api/staff', tok, { name: 'Caio Operador', email: 'caio.r4@example.com', role: 'COLABORADOR', permissions: ['hoje.ver'] });
        expect(colab.status).toBe(201);
        expect(colab.body.member).toMatchObject({ role: 'COLABORADOR', credentialsLocked: false });
        const admin = await call('POST', '/api/staff', tok, { name: 'Sócia Nova', email: 'socia.r4@example.com', role: 'ADMIN' });
        expect(admin.status).toBe(201);
        expect(admin.body.member).toMatchObject({ role: 'ADMIN', credentialsLocked: true });
    });

    it('o flag é exatamente a regra do servidor: travado → 403 ADMIN_TARGET_FORBIDDEN em senha e e-mail; livre → passa', async () => {
        const dono = await mkUser({ role: 'ADMIN' });
        const outroAdmin = await mkUser({ role: 'ADMIN' });
        const exAdmin = await mkStaff({ permissions: ['clientes.ver'] });
        await markExAdmin(exAdmin.id, dono.id);
        // Auditoria de OUTRA mudança de papel (COLABORADOR → ADMIN → ...) não trava quem nunca foi ADMIN.
        const nunca = await mkStaff({ permissions: ['clientes.ver'] });
        await prisma.auditLog.create({
            data: { entityType: 'USER', entityId: nunca.id, action: 'STAFF_UPDATED', performedBy: dono.id, changes: JSON.stringify({ fields: ['name'], from: 'ADMIN' }) },
        });
        const tok = cookie(dono);
        touched.push(nunca.id); // definir senha e trocar o e-mail revogam as sessões

        const locked = await lockedById(tok);
        expect(locked).toEqual({ [dono.id]: true, [outroAdmin.id]: true, [exAdmin.id]: true, [nunca.id]: false });

        for (const target of [outroAdmin, exAdmin, nunca]) {
            const pwd = await call('POST', `/api/staff/${target.id}/password`, tok, { password: 'senha-forte-r4' });
            const mail = await call('PATCH', `/api/staff/${target.id}`, tok, { email: `novo.${target.id.slice(0, 8)}@example.com` });
            if (locked[target.id]) {
                expect(pwd.status).toBe(403);
                expect(pwd.body.code).toBe('ADMIN_TARGET_FORBIDDEN');
                expect(mail.status).toBe(403);
                expect(mail.body.code).toBe('ADMIN_TARGET_FORBIDDEN');
            } else {
                expect(pwd.status).toBe(200);
                expect(mail.status).toBe(200);
                expect(mail.body.member).toMatchObject({ credentialsLocked: false });
            }
        }
    });
});

// ─── Lista: em lote, sem N+1 ────────────────────────────

describe('GET /api/staff calcula credentialsLocked em lote', () => {
    it('uma consulta à auditoria para a lista inteira, só pelos COLABORADORes; nenhuma quando só há ADMIN', async () => {
        const dono = await mkUser({ role: 'ADMIN' });
        await mkUser({ role: 'ADMIN' });
        const tok = cookie(dono);

        audit.findMany = 0; audit.findFirst = 0;
        const onlyAdmins = await lockedById(tok);
        expect(Object.values(onlyAdmins)).toEqual([true, true]);
        expect(audit).toEqual({ findMany: 0, findFirst: 0 });

        const colabs = await Promise.all(Array.from({ length: 6 }, (_, i) => mkStaff({ permissions: ['hoje.ver'], overrides: { name: `Colab ${i}` } })));
        const exAdmins = [colabs[1], colabs[4]];
        for (const c of exAdmins) {
            await markExAdmin(c.id, dono.id);
            await markExAdmin(c.id, dono.id); // rebaixado duas vezes: duas linhas, um id
        }
        audit.findMany = 0; audit.findFirst = 0;
        const locked = await lockedById(tok);
        expect(audit).toEqual({ findMany: 1, findFirst: 0 });
        for (const c of colabs) expect(locked[c.id], c.name).toBe(exAdmins.includes(c));
        expect(Object.keys(locked)).toHaveLength(8);
    });
});
