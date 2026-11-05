import { prisma } from '../../src/lib/prisma';
import type { Prisma } from '../../src/generated/prisma/client';

// Monotonic counter for unique-but-deterministic values (no Math.random needed —
// the DB is truncated before each test, so cross-test collisions can't happen).
let seq = 0;
const uniq = () => `${Date.now().toString(36)}-${++seq}`;

/** CPF VÁLIDO e único por chamada (users.cpf_cnpj é UNIQUE — vários clientes com CPF no mesmo teste). */
let cpfSeq = 0;
export function mkCpf(): string {
    const base = String(100000000 + (++cpfSeq)).slice(0, 9).split('').map(Number);
    const dv = (digits: number[]) => {
        const sum = digits.reduce((s, d, i) => s + d * (digits.length + 1 - i), 0);
        const r = 11 - (sum % 11);
        return r >= 10 ? 0 : r;
    };
    const d1 = dv(base);
    const d2 = dv([...base, d1]);
    return [...base, d1, d2].join('');
}

export async function mkUser(overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) {
    const n = uniq();
    return prisma.user.create({
        data: {
            name: `Test User ${n}`,
            email: `itest-${n}@example.com`,
            ...overrides,
        },
    });
}

/**
 * Membro da EQUIPE: cria o `users` (papel COLABORADOR por padrão) + a linha de `staff_profiles` com as
 * permissões informadas, gravadas COMO VIERAM (sem normalizar — o teste decide; use
 * normalizePermissions de src/config/staffPermissions se quiser as dependências). ADMIN também ganha
 * a linha (com a lista ignorada pelo middleware), como a tela Equipe grava.
 */
export async function mkStaff(opts: {
    permissions?: string[];
    role?: 'COLABORADOR' | 'ADMIN';
    title?: string | null;
    overrides?: Partial<Prisma.UserUncheckedCreateInput>;
} = {}) {
    const n = uniq();
    return prisma.user.create({
        data: {
            name: `Test Staff ${n}`,
            email: `itest-staff-${n}@example.com`,
            role: opts.role ?? 'COLABORADOR',
            ...opts.overrides,
            staffProfile: {
                create: {
                    title: opts.title ?? null,
                    permissions: opts.permissions ?? [],
                },
            },
        },
        include: { staffProfile: true },
    });
}

export async function mkContract(userId: string, overrides: Partial<Prisma.ContractUncheckedCreateInput> = {}) {
    return prisma.contract.create({
        data: {
            name: `Test Contract ${uniq()}`,
            userId,
            type: 'FLEX',
            tier: 'COMERCIAL',
            durationMonths: 3,
            discountPct: 30,
            startDate: new Date('2026-09-15T00:00:00Z'),
            endDate: new Date('2026-12-15T00:00:00Z'),
            status: 'ACTIVE',
            paymentPlan: 'MONTHLY',
            addOns: [],
            ...overrides,
        },
    });
}

export async function mkPayment(userId: string, overrides: Partial<Prisma.PaymentUncheckedCreateInput> = {}) {
    return prisma.payment.create({
        data: {
            userId,
            provider: 'SICOOB',
            amount: 84000,
            status: 'PENDING',
            ...overrides,
        },
    });
}

export async function mkBooking(userId: string, contractId: string, overrides: Partial<Prisma.BookingUncheckedCreateInput> = {}) {
    return prisma.booking.create({
        data: {
            userId,
            contractId,
            date: new Date('2026-09-15T00:00:00Z'),
            startTime: '14:00',
            endTime: '16:00',
            status: 'CONFIRMED',
            tierApplied: 'COMERCIAL',
            price: 30000,
            addOns: [],
            ...overrides,
        },
    });
}

export async function mkCoupon(createdBy: string, overrides: Partial<Prisma.CouponUncheckedCreateInput> = {}) {
    return prisma.coupon.create({
        data: {
            code: `ITEST${uniq().toUpperCase().replace(/[^A-Z0-9]/g, '')}`,
            discountType: 'PERCENTUAL',
            discountValue: 10,
            createdBy,
            ...overrides,
        },
    });
}

export async function mkBlockedSlot(createdBy: string, overrides: Partial<Prisma.BlockedSlotUncheckedCreateInput> = {}) {
    return prisma.blockedSlot.create({
        data: {
            date: new Date('2026-09-15T00:00:00Z'),
            startTime: '14:00',
            endTime: '16:00',
            createdBy,
            ...overrides,
        },
    });
}
