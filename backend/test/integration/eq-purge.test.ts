import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { config } from '../../src/config/index';
import authRoutes from '../../src/modules/auth/routes';
import userRoutes from '../../src/modules/users/routes';
import { mkUser, mkStaff, mkContract, mkBooking, mkPayment, mkCoupon, mkBlockedSlot } from './factories';

// Exclusão DEFINITIVA (05/11): só o ADMIN, qualquer conta (cliente, já excluído, colaborador, outro ADMIN),
// apagando tudo o que é dela. Não a própria conta; nunca o último administrador ativo.

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
    const keys = touched.splice(0).map(id => `auth:revoked:${id}`);
    if (keys.length) await redis.del(...keys);
});

type Who = { id: string; email: string | null; role: string };
function cookie(u: Who) {
    touched.push(u.id);
    return `accessToken=${jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' })}`;
}
async function call(method: string, path: string, who: Who) {
    const res = await fetch(`${base}${path}`, { method, headers: { Cookie: cookie(who) } });
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> };
}

/** Cliente com histórico: contrato concluído, gravação, cobranças (paga e anulada) e um resgate de cupom confirmado. */
async function clientWithHistory(adminId: string) {
    const client = await mkUser();
    const contract = await mkContract(client.id, { status: 'COMPLETED' });
    const renewal = await mkContract(client.id, { status: 'EXPIRED', renewedFromId: contract.id });
    const booking = await mkBooking(client.id, contract.id, { status: 'COMPLETED' });
    const paid = await mkPayment(client.id, { contractId: contract.id, bookingId: booking.id, status: 'PAID', amount: 30000, paidAt: new Date() });
    await mkPayment(client.id, { contractId: renewal.id, status: 'CANCELLED', amount: 12000 });
    const coupon = await mkCoupon(adminId, { usedCount: 3 });
    await prisma.couponRedemption.create({
        data: { couponId: coupon.id, userId: client.id, paymentId: paid.id, status: 'CONFIRMED', originalAmount: 33000, discountAmount: 3000 },
    });
    return { client, contract, renewal, booking, paid, coupon };
}

describe('exclusão definitiva', () => {
    it('ADMIN apaga o cliente com todo o histórico; prévia conta o que vai sumir; o cupom recupera o uso', async () => {
        const admin = await mkStaff({ role: 'ADMIN' });
        const h = await clientWithHistory(admin.id);

        const prev = await call('GET', `/api/users/${h.client.id}/purge-preview`, admin);
        expect(prev.status).toBe(200);
        expect(prev.body.preview).toMatchObject({ role: 'CLIENTE', contracts: 2, bookings: 1, payments: 2, paidPayments: 1, paidAmount: 30000 });

        const res = await call('DELETE', `/api/users/${h.client.id}/permanent`, admin);
        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Cliente excluído definitivamente.');
        expect(res.body.removed).toMatchObject({ contracts: 2, bookings: 1, payments: 2, couponRedemptions: 1 });

        expect(await prisma.user.findUnique({ where: { id: h.client.id } })).toBeNull();
        expect(await prisma.contract.count({ where: { userId: h.client.id } })).toBe(0);
        expect(await prisma.booking.count({ where: { id: h.booking.id } })).toBe(0);
        expect(await prisma.payment.count({ where: { userId: h.client.id } })).toBe(0);
        expect((await prisma.coupon.findUniqueOrThrow({ where: { id: h.coupon.id } })).usedCount).toBe(2);
        const audit = await prisma.auditLog.findFirst({ where: { entityId: h.client.id, action: 'PURGED' } });
        expect(audit?.performedBy).toBe(admin.id);
    });

    it('cliente já excluído (soft delete) também é apagado de vez', async () => {
        const admin = await mkStaff({ role: 'ADMIN' });
        const client = await mkUser({ deletedAt: new Date(), email: null });
        const c = await mkContract(client.id, { status: 'CANCELLED' });
        await mkBooking(client.id, c.id, { status: 'CANCELLED' });
        const res = await call('DELETE', `/api/users/${client.id}/permanent`, admin);
        expect(res.status).toBe(200);
        expect(await prisma.user.findUnique({ where: { id: client.id } })).toBeNull();
        expect(await prisma.contract.count({ where: { id: c.id } })).toBe(0);
    });

    it('colaborador é apagado; os bloqueios de agenda dele passam para quem excluiu', async () => {
        const admin = await mkStaff({ role: 'ADMIN' });
        const colab = await mkStaff({ permissions: ['agendamentos.ver'] });
        const slot = await mkBlockedSlot(colab.id);
        const res = await call('DELETE', `/api/users/${colab.id}/permanent`, admin);
        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Colaborador excluído definitivamente.');
        expect(await prisma.user.findUnique({ where: { id: colab.id } })).toBeNull();
        expect(await prisma.staffProfile.findUnique({ where: { userId: colab.id } })).toBeNull();
        expect((await prisma.blockedSlot.findUniqueOrThrow({ where: { id: slot.id } })).createdBy).toBe(admin.id);
    });

    it('ADMIN apaga outro ADMIN; a sessão do excluído deixa de valer', async () => {
        const admin = await mkStaff({ role: 'ADMIN' });
        const other = await mkStaff({ role: 'ADMIN' });
        const otherCookie = cookie(other);
        const res = await call('DELETE', `/api/users/${other.id}/permanent`, admin);
        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Administrador excluído definitivamente.');
        const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: otherCookie } });
        expect(me.status).toBe(401);
    });

    it('recusa a própria conta (400) e conta inexistente (404), sem efeito', async () => {
        const admin = await mkStaff({ role: 'ADMIN' });
        const self = await call('DELETE', `/api/users/${admin.id}/permanent`, admin);
        expect(self.status).toBe(400);
        expect(await prisma.user.findUnique({ where: { id: admin.id } })).not.toBeNull();
        const missing = await call('DELETE', '/api/users/00000000-0000-0000-0000-000000000000/permanent', admin);
        expect(missing.status).toBe(404);
    });

    it('colaborador (mesmo com clientes.excluir) e cliente recebem 403, sem efeito', async () => {
        const colab = await mkStaff({ permissions: ['clientes.ver', 'clientes.excluir', 'contratos.ver', 'contratos.cancelar', 'contratos.multa', 'cobrancas.baixa'] });
        const client = await mkUser();
        const other = await mkUser();
        for (const who of [colab, other]) {
            const res = await call('DELETE', `/api/users/${client.id}/permanent`, who);
            expect(res.status).toBe(403);
            const prev = await call('GET', `/api/users/${client.id}/purge-preview`, who);
            expect(prev.status).toBe(403);
        }
        expect(await prisma.user.findUnique({ where: { id: client.id } })).not.toBeNull();
    });
});
