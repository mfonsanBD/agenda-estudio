import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ─── Provedores e e-mail: nenhuma chamada de rede real ──
vi.mock('../../src/lib/sicoobService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/sicoobService')>();
    return {
        ...orig,
        sicoobGetCob: vi.fn(),
        sicoobRemoveCob: vi.fn(async () => true),
        sicoobCreatePix: vi.fn(),
        getSicoobEnvironment: vi.fn(async () => 'sandbox'),
        sicoobGetWebhook: vi.fn(async () => null),
        sicoobRegisterWebhook: vi.fn(async () => undefined),
        sicoobDeleteWebhook: vi.fn(async () => undefined),
        sicoobTestConnection: vi.fn(async () => ({ success: true, message: 'ok' })),
    };
});
vi.mock('../../src/lib/stripeService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/stripeService')>();
    return {
        ...orig,
        isStripeEnabled: vi.fn(async () => false),
        stripeCardInstallmentsSupported: vi.fn(async () => false),
        stripeGetPaymentIntent: vi.fn(async () => ({ id: 'pi_x', status: 'requires_payment_method', amount: 0, metadata: {} })),
        stripeCancelPaymentIntent: vi.fn(async () => ({ status: 'canceled', canceled: true })),
        stripeCancelSubscription: vi.fn(async () => {}),
        stripeCreatePaymentIntent: vi.fn(async (o: { paymentId: string }) => ({ clientSecret: `cs_${o.paymentId}`, paymentIntentId: `pi_new_${o.paymentId.slice(0, 8)}`, status: 'requires_payment_method' })),
        stripeGetOrCreateCustomer: vi.fn(async () => 'cus_test'),
        stripeCreateSetupIntent: vi.fn(async () => ({ clientSecret: 'seti_secret_test', setupIntentId: 'seti_test' })),
        stripeListPaymentMethods: vi.fn(async () => []),
        stripeTestConnection: vi.fn(async () => ({ success: true, message: 'ok' })),
    };
});
vi.mock('../../src/lib/coraService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/coraService')>();
    return {
        ...orig,
        coraListWebhookEndpoints: vi.fn(async () => []),
        coraRegisterWebhookEndpoint: vi.fn(async () => ({ id: 'wh_test' })),
        coraDeleteWebhookEndpoint: vi.fn(async () => undefined),
        coraTestConnection: vi.fn(async () => ({ success: true, message: 'ok' })),
    };
});
vi.mock('../../src/lib/email', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/email')>();
    return { ...orig, sendEmail: vi.fn(async () => undefined), deliverOtpEmail: vi.fn(async () => undefined) };
});
vi.mock('../../src/modules/push/pushService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/modules/push/pushService')>();
    return { ...orig, sendPushToUser: vi.fn(async () => 1) };
});

import bcrypt from 'bcryptjs';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { ADMIN_ONLY_KEYS } from '../../src/config/staffPermissions';
import { getBasePriceDynamic } from '../../src/utils/pricing';
import { invalidateConfigCache } from '../../src/lib/businessConfig';
import { invalidateTemplateCache } from '../../src/modules/notifications/templateStore';
import { runPushNotificationJob } from '../../src/jobs/pushNotificationJob';
import * as push from '../../src/modules/push/pushService';
import { mkUser, mkStaff, mkContract, mkPayment, mkCpf } from './factories';
import {
    ALL_KEYS, CONFIG_KEYS, MATRIX, RECEPCAO, allExcept, call, cookieFor, dbDate, isPermissionDenied, matrixRowName,
    refreshCookieFor, seedFlexBooking, startServer, todaySp, uniqueEmail, weekdayN,
    type Res, type Who,
} from './eq-authHelpers';
import { addDaysYmd } from '../../src/lib/avulsoMakeup';

// FRENTE T — testes da MATRIZ DE PERMISSÕES da equipe (proposta §6.3 com as correções do DECISOES-EQUIPE
// e da crítica §8). Roda sobre a API montada como no src/index.ts (eq-authHelpers.buildApp) e fixtures
// reais (factories.ts):
//  1. TABELA DA VERDADE de todas as rotas administrativas e mistas (eq-authHelpers.MATRIX, cuja cobertura
//     é conferida contra a pilha real do Express em eq-route-invariants.test.ts). Em cada linha:
//     sem login → 401; CLIENTE → 403 (rota mista: o dono segue o ramo dele); COLABORADOR sem chaves → 403
//     PERMISSION_DENIED; COLABORADOR com TODAS as outras chaves → 403 com a chave da linha; COLABORADOR
//     só com cada chave aceita → passa; ADMIN → passa. "Só ADMIN": COLABORADOR com tudo → 403.
//     Autoatendimento: só CLIENTE (S5 — nem o ADMIN). Rota MISTA (R4e — QT-01/QT-02): o dono, o
//     COLABORADOR com a chave e o ADMIN recebem o status EXATO de sucesso (`ok`), e um CLIENTE que não é
//     o dono recebe `stranger` (404 nas rotas com id) sem mudar nada nas fixtures do dono. R5 (UXT-08): toda
//     sonda RECUSADA (401/403) deixa `Probe.state` igual e `Probe.applied` falso; nas linhas com `applied`,
//     quem passa executa a ação DE VERDADE (um 409 de outra regra não conta como "passou").
//  2. EFEITO IMEDIATO com o MESMO token: permissão retirada/devolvida, rebaixamento/promoção e
//     desativação/exclusão (401 ACCOUNT_DISABLED sem depender da revogação no Redis).
//  3. Equipe (E1, E2, autoalteração, último admin em corrida, e-mail), Clientes (D1/D9/F8), Configurações,
//     Dinheiro (F1, cartão salvo, receita), F2, F3, F5, S1 e S3.
// (Sem o antigo item 7 da proposta — "hoje.ver força a data de hoje" —, cortado pela crítica C2.)

const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const sendPush = m(push.sendPushToUser);

let base = '';
let close: () => Promise<void> = async () => {};

beforeAll(async () => {
    ({ base, close } = await startServer());
});

afterAll(async () => {
    await close();
});

beforeEach(async () => {
    vi.clearAllMocks();
    sendPush.mockResolvedValue(1);
    invalidateConfigCache();
    invalidateTemplateCache();
    // Formas de pagamento ativas (o /custom e o checkout validam a forma escolhida).
    for (const [i, key] of ['PIX', 'CARTAO', 'BOLETO'].entries()) {
        await prisma.paymentMethodConfig.create({
            data: { key, label: key, shortLabel: key, emoji: '-', description: key, color: '#000000', active: true, sortOrder: i },
        });
    }
});

const go = (method: string, path: string, who?: Who | string, body?: unknown) => call(base, method, path, who, body);
const newAdmin = () => mkUser({ role: 'ADMIN' });
type StaffOverrides = NonNullable<NonNullable<Parameters<typeof mkStaff>[0]>['overrides']>;
const staff = (permissions: readonly string[], overrides: StaffOverrides = {}) => mkStaff({ permissions: [...permissions], overrides });
const RANGE = '?from=2026-09-01&to=2026-09-30';
/** Chaves que o 403 de uma rota "só do administrador" pode citar. */
const ADMIN_LIKE: string[] = ['ADMIN', ...ADMIN_ONLY_KEYS];

function expectDenied(r: Res, label: string) {
    expect(isPermissionDenied(r), `${label}: esperado 403 PERMISSION_DENIED, veio ${r.status} ${JSON.stringify(r.body)}`).toBe(true);
}
/** Passou da permissão: nunca 401, 5xx, 403 PERMISSION_DENIED nem um 403 sem `code`. */
function expectAllowed(r: Res, label: string) {
    const bad = r.status === 401 || r.status >= 500 || r.status === 403;
    expect(bad, `${label}: esperado passar pela permissão, veio ${r.status} ${JSON.stringify(r.body)}`).toBe(false);
}
/** Status EXATO (QT-01): na rota mista, o 404 do filtro do cliente aplicado à equipe não conta como "passou". */
function expectStatus(r: Res, want: number, label: string) {
    expect(r.status, `${label}: esperado ${want}, veio ${r.status} ${JSON.stringify(r.body)}`).toBe(want);
}

/** Resultado de uma sonda da tabela: a resposta + o estado das fixtures antes/depois e se a ação aconteceu. */
type Outcome = Res & { before: unknown; after: unknown; applied: boolean | undefined };

/** R5 (UXT-08): recusada (401/403) → nada muda nas fixtures (Probe.state) e a ação não aconteceu (Probe.applied). */
function expectNoEffect(r: Outcome, label: string) {
    expect(r.after, `${label}: recusada, mas o estado das fixtures mudou`).toEqual(r.before);
    if (r.applied !== undefined) expect(r.applied, `${label}: recusada, mas a ação aconteceu`).toBe(false);
}

/** 403 PERMISSION_DENIED e sem efeito nenhum. */
function expectDeniedNoEffect(r: Outcome, label: string) {
    expectDenied(r, label);
    expectNoEffect(r, label);
}

// ═══ 1. Tabela da verdade ═══════════════════════════════

describe('§6.3.1 — tabela da verdade: todas as rotas administrativas e mistas (CLIENTE × COLABORADOR × ADMIN)', () => {
    it('toda linha MISTA declara o status exato de sucesso (ok) e a sonda do cliente estranho (stranger) — QT-01/QT-02', () => {
        const missing = MATRIX.filter(r => r.mixed && (r.ok === undefined || r.stranger === undefined)).map(matrixRowName);
        expect(missing).toEqual([]);
    });

    for (const row of MATRIX) {
        const name = matrixRowName(row);
        it(name, async () => {
            let k = 0;
            /**
             * Fixtures NOVAS a cada sondagem (a rota pode mudar o estado); `who` = 'dono' usa o cliente das
             * fixtures; 'estranho' = outro CLIENTE (nunca dono): devolve também o estado antes/depois (QT-02).
             */
            const probe = async (who: Who | 'anon' | 'dono' | 'estranho'): Promise<Outcome> => {
                const owner = await mkUser();
                const p = await row.build({ k: k++, owner });
                const actor = who === 'anon' ? undefined : who === 'dono' ? owner : who === 'estranho' ? await mkUser() : who;
                const before = await p.state?.();
                const r = await go(p.method, p.path, actor, p.body);
                const after = await p.state?.();
                const applied = p.applied ? await p.applied() : undefined;
                return Object.assign(r, { before, after, applied });
            };
            const label = (s: string) => `${name} · ${s}`;
            /** Passou: status certo (`ok`, quando declarado) e, com Probe.applied, a ação aconteceu DE VERDADE (R5). */
            const passed = (r: Outcome, tag: string, want = row.ok) => {
                expectAllowed(r, label(tag));
                if (want !== undefined) expectStatus(r, want, label(tag));
                if (r.applied !== undefined) expect(r.applied, `${label(tag)}: passou da permissão, mas a ação não aconteceu`).toBe(true);
            };
            const denied = (r: Outcome, tag: string) => expectDeniedNoEffect(r, label(tag));

            const anon = await probe('anon');
            expect(anon.status, label('sem login')).toBe(401);
            expectNoEffect(anon, label('sem login'));

            const asClient = await probe('dono');
            if (row.need === 'CLIENTE') expectAllowed(asClient, label('CLIENTE'));
            else if (row.mixed) passed(asClient, 'CLIENTE (dono)', row.ownerOk ?? row.ok);
            else denied(asClient, 'CLIENTE');

            // QT-02: um CLIENTE que NÃO é o dono — 404 (ou o ramo dele) e NADA muda nas fixtures do dono.
            if (row.mixed && row.stranger !== undefined) {
                const asStranger = await probe('estranho');
                expectStatus(asStranger, row.stranger, label('CLIENTE estranho'));
                if (row.strangerCode !== undefined) expect(asStranger.body.code, label('CLIENTE estranho · code')).toBe(row.strangerCode);
                expect(asStranger.body, label('CLIENTE estranho · sem dados da cobrança alheia')).not.toHaveProperty('pixString');
                expect(asStranger.body, label('CLIENTE estranho · sem dados da cobrança alheia')).not.toHaveProperty('boletoUrl');
                expect(asStranger.after, label('CLIENTE estranho · estado do dono intacto')).toEqual(asStranger.before);
            }

            if (row.need === 'CLIENTE') {
                // Autoatendimento: nenhuma conta da equipe passa — nem com todas as chaves, nem o ADMIN (S5).
                for (const [who, tag] of [[await staff([]), 'COLABORADOR sem chaves'], [await staff(ALL_KEYS), 'COLABORADOR com tudo'], [await newAdmin(), 'ADMIN']] as const) {
                    const r = await probe(who);
                    denied(r, tag);
                    expect(r.body.permission, label(tag)).toBe('CLIENTE');
                }
                return;
            }

            if (row.need === 'ADMIN') {
                denied(await probe(await staff([])), 'COLABORADOR sem chaves');
                const all = await probe(await staff(ALL_KEYS));
                denied(all, 'COLABORADOR com TODAS as chaves');
                expect(ADMIN_LIKE, label('chave do 403')).toContain(all.body.permission);
                passed(await probe(await newAdmin()), 'ADMIN');
                return;
            }

            const need = row.need;
            denied(await probe(await staff([])), 'COLABORADOR sem chaves');
            // Com TODAS as outras chaves: prova que é exatamente esta chave que libera (e que o corpo/estado
            // da linha chega até a regra — não para antes numa validação).
            const others = await probe(await staff(allExcept(...need)));
            denied(others, `COLABORADOR com as outras ${ALL_KEYS.length - need.length} chaves`);
            expect(need as readonly string[], label('chave citada no 403')).toContain(others.body.permission);
            const also = row.alsoNeed ?? [];
            for (const key of need) {
                passed(await probe(await staff([key, ...also])), `COLABORADOR só com ${[key, ...also].join(' + ')}`);
                // Regra "E": cada chave de alsoNeed é obrigatória junto com a de `need` — sem ela, 403 citando
                // exatamente a que falta e NADA muda (R5 — UXT-08).
                for (const a of also) {
                    const missing = await probe(await staff([key, ...also.filter(x => x !== a)]));
                    denied(missing, `COLABORADOR com ${key} sem ${a}`);
                    expect(missing.body.permission, label(`chave citada sem ${a}`)).toBe(a);
                }
            }
            passed(await probe(await newAdmin()), 'ADMIN');
        });
    }
});

// ═══ 2. Efeito imediato (mesmo token, sem novo login) ═══

describe('§6.3.2 — efeito imediato: o banco é a fonte, o token antigo não segura nada', () => {
    /** [método, rota, chave concedida, chave que o 403 cita (a 1ª do "qualquer uma de" da guarda)]. */
    const PROBES: ReadonlyArray<[string, string, string, string]> = [
        ['GET', '/api/contracts', 'contratos.ver', 'contratos.ver'],
        ['GET', `/api/reports/summary${RANGE}`, 'relatorios.ver', 'relatorios.ver'],
        ['GET', '/api/coupons', 'cupons.ver', 'cupons.ver'],
        ['GET', '/api/notifications/admin/events', 'avisos.modelos', 'avisos.modelos'],
        ['GET', '/api/pricing/business-config', 'config.gerais', 'config.gerais'],
        ['GET', '/api/users', 'clientes.ver', 'clientes.ver'],
        ['GET', '/api/payments', 'financeiro.ver', 'financeiro.ver'],
        ['GET', '/api/bookings', 'hoje.ver', 'agendamentos.ver'],
    ];

    it('permissão retirada → 403 na próxima requisição; devolvida → volta a passar (mesmo cookie)', async () => {
        const keys = PROBES.map(p => p[2]);
        const colab = await staff(keys);
        const session = cookieFor(colab);
        for (const [method, path] of PROBES) expect((await go(method, path, session)).status, `${method} ${path} antes`).toBe(200);

        await prisma.staffProfile.update({ where: { userId: colab.id }, data: { permissions: [] } });
        for (const [method, path, , deniedAs] of PROBES) {
            const r = await go(method, path, session);
            expectDenied(r, `${method} ${path} sem a permissão`);
            expect(r.body.permission).toBe(deniedAs);
        }

        await prisma.staffProfile.update({ where: { userId: colab.id }, data: { permissions: keys } });
        for (const [method, path] of PROBES) expect((await go(method, path, session)).status, `${method} ${path} devolvida`).toBe(200);
    });

    it('rebaixar ADMIN → COLABORADOR: o JWT antigo de ADMIN perde na hora as rotas do administrador', async () => {
        const admin = await newAdmin();
        const keep = await newAdmin(); // sobra um ADMIN ativo (como a tela Equipe exige)
        expect(keep.role).toBe('ADMIN');
        const session = cookieFor(admin); // o token diz ADMIN
        const ADMIN_ROUTES: ReadonlyArray<[string, string]> = [
            ['GET', '/api/staff'], ['GET', '/api/staff/catalog'], ['GET', '/api/integrations'], ['GET', '/api/pricing/business-config/fee-history'],
        ];
        for (const [method, path] of ADMIN_ROUTES) expect((await go(method, path, session)).status, `${path} como ADMIN`).toBe(200);

        await prisma.user.update({
            where: { id: admin.id },
            data: { role: 'COLABORADOR', staffProfile: { create: { permissions: ['contratos.ver'] } } },
        });
        for (const [method, path] of ADMIN_ROUTES) {
            const r = await go(method, path, session);
            expectDenied(r, `${path} depois do rebaixamento`);
            expect(r.body.permission).toBe('ADMIN');
        }
        const cleanup = await go('POST', '/api/bookings/cleanup-orphan-addons', session);
        expectDenied(cleanup, 'manutenção (só ADMIN)');
        // Passa a valer a lista do colaborador: contratos sim, relatórios não.
        expect((await go('GET', '/api/contracts', session)).status).toBe(200);
        expectDenied(await go('GET', `/api/reports/summary${RANGE}`, session), 'relatórios sem relatorios.ver');
    });

    it('promover COLABORADOR → ADMIN no banco vale na hora para o token antigo de colaborador', async () => {
        const colab = await staff([]);
        const session = cookieFor(colab); // o token diz COLABORADOR
        expectDenied(await go('GET', '/api/staff', session), 'antes da promoção');
        await prisma.user.update({ where: { id: colab.id }, data: { role: 'ADMIN' } });
        expect((await go('GET', '/api/staff', session)).status).toBe(200);
        expect((await go('GET', `/api/reports/summary${RANGE}`, session)).status).toBe(200);
    });

    it('desativado (BLOCKED) ou excluído: 401 ACCOUNT_DISABLED em todos os módulos, SEM a chave de revogação no Redis', async () => {
        const anyId = '00000000-0000-0000-0000-000000000000';
        const ROUTES: ReadonlyArray<[string, string, unknown?]> = [
            ['GET', '/api/bookings'],
            ['GET', '/api/contracts'],
            ['GET', '/api/users'],
            ['PATCH', `/api/users/${anyId}`, { name: 'Nome Trocado' }],
            ['GET', `/api/reports/summary${RANGE}`],
            ['GET', '/api/coupons'],
            ['GET', '/api/notifications/admin/events'],
            ['GET', '/api/pricing/business-config'],
            ['GET', '/api/payments'],
            ['GET', '/api/finance/closing/2026/9'],
            ['GET', '/api/notifications'],
            ['PUT', `/api/bookings/${anyId}/check-in`],
            ['DELETE', `/api/bookings/${anyId}`],
            ['POST', '/api/stripe/create-payment', { paymentId: anyId, paymentMethod: 'pix' }],
            ['POST', '/api/coupons/validate', { code: 'QUALQUER', amount: 1000, userId: anyId }],
        ];
        const colab = await staff(ALL_KEYS);
        const session = cookieFor(colab);
        expect((await go('GET', '/api/contracts', session)).status).toBe(200);

        await prisma.user.update({ where: { id: colab.id }, data: { clientStatus: 'BLOCKED' } });
        expect(await redis.exists(`auth:revoked:${colab.id}`)).toBe(0); // sem revogação: vale o banco
        for (const [method, path, body] of ROUTES) {
            const r = await go(method, path, session, body);
            expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBe(401);
            expect(r.body.code, `${method} ${path}`).toBe('ACCOUNT_DISABLED');
        }

        // ADMIN desativado também (o papel não salva a conta).
        const admin = await newAdmin();
        await newAdmin();
        await prisma.user.update({ where: { id: admin.id }, data: { clientStatus: 'BLOCKED' } });
        for (const path of ['/api/staff', '/api/integrations', '/api/contracts']) {
            const r = await go('GET', path, admin);
            expect(r.status, path).toBe(401);
            expect(r.body.code).toBe('ACCOUNT_DISABLED');
        }

        // Excluído (soft delete) também.
        const gone = await staff(ALL_KEYS);
        const goneSession = cookieFor(gone);
        await prisma.user.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
        const r = await go('GET', '/api/contracts', goneSession);
        expect(r.status).toBe(401);
        expect(r.body.code).toBe('ACCOUNT_DISABLED');
    });
});

// ═══ 3. Equipe (/api/staff) ═════════════════════════════

describe('§6.3.3 — Equipe: autoalteração, último admin, e-mail, E1 e E2', () => {
    it('ninguém altera o próprio papel nem a própria situação (400 SELF_CHANGE_FORBIDDEN); nome e cargo podem', async () => {
        const me = await newAdmin();
        await newAdmin();
        const role = await go('PATCH', `/api/staff/${me.id}`, me, { role: 'COLABORADOR' });
        expect(role.status).toBe(400);
        expect(role.body.code).toBe('SELF_CHANGE_FORBIDDEN');
        const off = await go('POST', `/api/staff/${me.id}/deactivate`, me);
        expect(off.status).toBe(400);
        expect(off.body.code).toBe('SELF_CHANGE_FORBIDDEN');
        expect((await go('PATCH', `/api/staff/${me.id}`, me, { name: 'Nome Novo', title: 'Dono' })).status).toBe(200);
        const after = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
        expect([after.role, after.clientStatus, after.name]).toEqual(['ADMIN', 'ACTIVE', 'Nome Novo']);
    });

    it('último admin: duas rebaixas concorrentes (A rebaixa B × B rebaixa A) → exatamente uma passa; sobra 1 ADMIN ativo', async () => {
        const a = await newAdmin();
        const b = await newAdmin();
        const [ra, rb] = await Promise.all([
            go('PATCH', `/api/staff/${b.id}`, a, { role: 'COLABORADOR' }),
            go('PATCH', `/api/staff/${a.id}`, b, { role: 'COLABORADOR' }),
        ]);
        expect([ra.status, rb.status].filter(s => s === 200)).toHaveLength(1);
        const loser = ra.status === 200 ? rb : ra;
        // 409 LAST_ADMIN (as duas passaram do requireAdmin antes do commit) ou 403 (já leu o rebaixamento).
        expect([403, 409]).toContain(loser.status);
        if (loser.status === 409) expect(loser.body.code).toBe('LAST_ADMIN');
        expect(await prisma.user.count({ where: { role: 'ADMIN', deletedAt: null, clientStatus: { not: 'BLOCKED' } } })).toBe(1);
    });

    it('e-mail com maiúsculas é normalizado; e-mail de cliente (sem diferenciar maiúsculas) → 409 EMAIL_IS_CLIENT', async () => {
        const admin = await newAdmin();
        const tag = Date.now().toString(36);
        const created = await go('POST', '/api/staff', admin, {
            name: 'Membro Novo', email: `  Membro.${tag}@Example.COM `, role: 'COLABORADOR', permissions: ['hoje.ver'], sendAccessEmail: false,
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        expect(created.body.member.email).toBe(`membro.${tag}@example.com`);

        const client = await mkUser({ email: `cliente.${tag}@example.com` });
        const clash = await go('POST', '/api/staff', admin, {
            name: 'Mesma Pessoa', email: `CLIENTE.${tag}@EXAMPLE.com`, role: 'COLABORADOR', sendAccessEmail: false,
        });
        expect(clash.status).toBe(409);
        expect(clash.body.code).toBe('EMAIL_IS_CLIENT');
        expect((await prisma.user.findUniqueOrThrow({ where: { id: client.id } })).role).toBe('CLIENTE');
    });

    it('E1: alvo que não é da equipe (um CLIENTE) → 404 em PATCH, senha, desativar, reativar e enviar acesso; nada muda', async () => {
        const admin = await newAdmin();
        const client = await mkUser({ passwordHash: 'hash-intacto' });
        expect((await go('PATCH', `/api/staff/${client.id}`, admin, { role: 'ADMIN' })).status).toBe(404);
        expect((await go('POST', `/api/staff/${client.id}/password`, admin, { password: 'senha-forte-123' })).status).toBe(404);
        expect((await go('POST', `/api/staff/${client.id}/deactivate`, admin)).status).toBe(404);
        expect((await go('POST', `/api/staff/${client.id}/reactivate`, admin)).status).toBe(404);
        expect((await go('POST', `/api/staff/${client.id}/send-access`, admin)).status).toBe(404);
        const after = await prisma.user.findUniqueOrThrow({ where: { id: client.id } });
        expect([after.role, after.clientStatus, after.passwordHash]).toEqual(['CLIENTE', 'ACTIVE', 'hash-intacto']);
    });

    it('E2: um ADMIN não define a senha nem troca o e-mail de OUTRO ADMIN (403); "Enviar acesso" pode', async () => {
        const a = await newAdmin();
        const b = await newAdmin();
        const pwd = await go('POST', `/api/staff/${b.id}/password`, a, { password: 'senha-forte-123' });
        expect(pwd.status).toBe(403);
        expect(pwd.body.code).toBe('ADMIN_TARGET_FORBIDDEN');
        const mail = await go('PATCH', `/api/staff/${b.id}`, a, { email: uniqueEmail('outro-admin') });
        expect(mail.status).toBe(403);
        expect(mail.body.code).toBe('ADMIN_TARGET_FORBIDDEN');
        const after = await prisma.user.findUniqueOrThrow({ where: { id: b.id } });
        expect([after.email, after.passwordHash]).toEqual([b.email, b.passwordHash]);
        expect((await go('POST', `/api/staff/${b.id}/send-access`, a)).status).toBe(200);
    });
});

// ═══ 4. Clientes (/api/users só trata de CLIENTE) ═══════

describe('§6.3.4 — Clientes: papel fora do corpo, alvo só CLIENTE, acesso ao app e CPF do checkout', () => {
    it('POST /api/users com role ADMIN → 400 sem criar nada; role CLIENTE é aceito e ignorado', async () => {
        const admin = await newAdmin();
        const before = await prisma.user.count();
        const bad = await go('POST', '/api/users', admin, { name: 'Tentativa', email: uniqueEmail('promo'), role: 'ADMIN' });
        expect(bad.status).toBe(400);
        expect(bad.body.code).toBe('ROLE_NOT_ALLOWED');
        expect(await prisma.user.count()).toBe(before);
        const ok = await go('POST', '/api/users', admin, { name: 'Cliente', email: uniqueEmail('cli'), role: 'CLIENTE' });
        expect(ok.status).toBe(201);
        expect(ok.body.user.role).toBe('CLIENTE');
    });

    it('PATCH /api/users/:id com alvo ADMIN ou COLABORADOR → 404 (nem promove, nem bloqueia, nem troca senha)', async () => {
        const admin = await newAdmin();
        const otherAdmin = await newAdmin();
        const colab = await staff(['hoje.ver']);
        for (const target of [otherAdmin, colab]) {
            for (const body of [{ name: 'Nome Trocado' }, { clientStatus: 'BLOCKED' }, { password: 'senha-nova-123' }]) {
                const r = await go('PATCH', `/api/users/${target.id}`, admin, body);
                expect(r.status, `${target.role} ${JSON.stringify(body)}`).toBe(404);
            }
            const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
            expect([after.clientStatus, after.name]).toEqual(['ACTIVE', target.name]);
        }
    });

    it('clientes.editar sem clientes.acesso → 403 ao trocar o e-mail de login; com acesso → 200 em minúsculas', async () => {
        const client = await mkUser();
        const editor = await staff(['clientes.ver', 'clientes.editar']);
        const r = await go('PATCH', `/api/users/${client.id}`, editor, { email: 'Novo.Login@Example.com' });
        expectDenied(r, 'troca de e-mail sem clientes.acesso');
        expect(r.body.permission).toBe('clientes.acesso');
        expect((await prisma.user.findUniqueOrThrow({ where: { id: client.id } })).email).toBe(client.email);

        const acesso = await staff(['clientes.ver', 'clientes.acesso']);
        const ok = await go('PATCH', `/api/users/${client.id}`, acesso, { email: 'Novo.Login@Example.com' });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: client.id } })).email).toBe('novo.login@example.com');
    });

    it('F8: senha de cliente só o ADMIN define — colaborador com todas as chaves → 403 ADMIN', async () => {
        const client = await mkUser({ passwordHash: 'hash-intacto' });
        const r = await go('PATCH', `/api/users/${client.id}`, await staff(ALL_KEYS), { password: 'senha-nova-123' });
        expectDenied(r, 'senha de cliente por colaborador');
        expect(r.body.permission).toBe('ADMIN');
        expect((await prisma.user.findUniqueOrThrow({ where: { id: client.id } })).passwordHash).toBe('hash-intacto');
    });

    it('CPF pelo checkout: só cobrancas.cobrar preenche o CPF VAZIO; com CPF já preenchido → 403 clientes.editar', async () => {
        const balcao = await staff(['cobrancas.cobrar']);
        const semCpf = await mkUser();
        const cpf = mkCpf();
        const ok = await go('PATCH', `/api/users/${semCpf.id}`, balcao, { cpfCnpj: cpf });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: semCpf.id } })).cpfCnpj).toBe(cpf);

        const comCpf = await mkUser({ cpfCnpj: mkCpf() });
        const denied = await go('PATCH', `/api/users/${comCpf.id}`, balcao, { cpfCnpj: mkCpf() });
        expectDenied(denied, 'troca de CPF existente só com cobrancas.cobrar');
        expect(denied.body.permission).toBe('clientes.editar');
        expect((await prisma.user.findUniqueOrThrow({ where: { id: comCpf.id } })).cpfCnpj).toBe(comCpf.cpfCnpj);
    });
});

// ═══ 5. Configurações ═══════════════════════════════════

describe('§6.3.5 — Configurações: por grupo, tudo ou nada, e-mail só do ADMIN', () => {
    const value = async (key: string) => (await prisma.businessConfig.findUnique({ where: { key } }))?.value ?? null;

    it('config.politicas salva o grupo policies; lote com email_smtp_host → 403 inteiro e NADA gravado', async () => {
        await prisma.businessConfig.create({ data: { key: 'cancellation_fine_pct', value: '20', type: 'percent', label: 'Multa', group: 'policies' } });
        const politicas = await staff(['config.politicas']);
        const ok = await go('PUT', '/api/pricing/business-config', politicas, { configs: [{ key: 'cancellation_fine_pct', value: '30' }] });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(await value('cancellation_fine_pct')).toBe('30');

        const mixed = await go('PUT', '/api/pricing/business-config', await staff(CONFIG_KEYS), {
            configs: [{ key: 'cancellation_fine_pct', value: '50' }, { key: 'email_smtp_host', value: 'smtp.golpe.test' }],
        });
        expectDenied(mixed, 'lote com chave de e-mail');
        expect(mixed.body.permission).toBe('config.email');
        expect(await value('cancellation_fine_pct')).toBe('30');
        expect(await value('email_smtp_host')).toBeNull();
    });

    it('GET devolve só os grupos permitidos: nunca email/gateway para o colaborador (nem com todas as caixas); ADMIN vê', async () => {
        const groupsOf = (r: Res) => new Set<string>((r.body.configs as Array<{ group: string }>).map(c => c.group));
        const colab = await go('GET', '/api/pricing/business-config', await staff(CONFIG_KEYS));
        expect(colab.status).toBe(200);
        expect(groupsOf(colab).has('email')).toBe(false);
        expect(groupsOf(colab).has('gateway')).toBe(false);
        expect(groupsOf(colab).has('policies')).toBe(true);

        const soPoliticas = await go('GET', '/api/pricing/business-config', await staff(['config.politicas']));
        expect([...groupsOf(soPoliticas)]).toEqual(['policies']);

        const admin = await go('GET', '/api/pricing/business-config', await newAdmin());
        expect(groupsOf(admin).has('email')).toBe(true);
    });
});

// ═══ 6. Dinheiro ════════════════════════════════════════

describe('§6.3.6 — dinheiro: nasce aguardando pagamento (F1/D7), cartão salvo, ficha de clientes e receita', () => {
    it('F1: Recepção cria "Confirmado" → RESERVED com pagamento PENDING (não 403); com cobrancas.baixa → CONFIRMED pago', async () => {
        const client = await mkUser();
        const recepcao = await staff(RECEPCAO);
        const r = await go('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(0), startTime: '10:00', status: 'CONFIRMED' });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.booking.status).toBe('RESERVED');
        expect(r.body.downgraded).toBe(true);
        const pay = await prisma.payment.findUniqueOrThrow({ where: { id: r.body.paymentId } });
        expect([pay.status, pay.paidAt]).toEqual(['PENDING', null]);

        const fin = await staff(['agendamentos.criar', 'cobrancas.baixa']);
        const paid = await go('POST', '/api/bookings/admin', fin, { userId: client.id, date: weekdayN(1), startTime: '10:00', status: 'CONFIRMED' });
        expect(paid.status, JSON.stringify(paid.body)).toBe(201);
        expect(paid.body.booking.status).toBe('CONFIRMED');
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: paid.body.paymentId } })).status).toBe('PAID');
    });

    it('F1: customPrice diferente da faixa (inclusive 0) sem cobrancas.baixa → 403 e nada é criado', async () => {
        const client = await mkUser();
        const recepcao = await staff(RECEPCAO);
        const standard = await getBasePriceDynamic('COMERCIAL');
        for (const customPrice of [0, standard + 1000]) {
            const r = await go('POST', '/api/bookings/admin', recepcao, { userId: client.id, date: weekdayN(0), startTime: '10:00', status: 'RESERVED', customPrice });
            expectDenied(r, `customPrice=${customPrice}`);
            expect(r.body.permission).toBe('cobrancas.baixa');
        }
        expect(await prisma.booking.count()).toBe(0);
        expect(await prisma.payment.count()).toBe(0);
    });

    it('cartão salvo: for-payment sem cobrancas.cartao_salvo vem sem cartões; debitar o cartão salvo sem a chave → 403', async () => {
        const client = await mkUser({ cpfCnpj: mkCpf(), stripeCustomerId: 'cus_eq_t' });
        const payment = await mkPayment(client.id, { provider: 'STRIPE', amount: 84000 });
        const card = await prisma.savedPaymentMethod.create({
            data: { userId: client.id, stripePaymentMethodId: 'pm_eq_t_1', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2031, isDefault: true },
        });
        const balcao = await staff(['cobrancas.cobrar']);
        const list = await go('GET', `/api/stripe/payment-methods/for-payment/${payment.id}`, balcao);
        expect(list.status).toBe(200);
        expect(list.body.paymentMethods).toEqual([]);
        expect(list.body.canUseSavedCards).toBe(false);

        const charge = await go('POST', '/api/stripe/create-payment', balcao, { paymentId: payment.id, paymentMethod: 'cartao', savedPaymentMethodId: card.id });
        expectDenied(charge, 'debitar cartão salvo sem a chave');
        expect(charge.body.permission).toBe('cobrancas.cartao_salvo');
        const intact = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect([intact.status, intact.providerRef]).toEqual(['PENDING', null]);
    });

    it('GET /api/users: ficha com totais para quem vê clientes (resposta 3); diretório mínimo para quem só abre seletores', async () => {
        const client = await mkUser({ cpfCnpj: mkCpf() });
        await mkPayment(client.id, { amount: 5000, status: 'PAID', paidAt: new Date() });
        await mkPayment(client.id, { amount: 3000, status: 'PENDING' });

        const ficha = await go('GET', '/api/users', await staff(['clientes.ver']));
        expect(ficha.status).toBe(200);
        expect(ficha.body.users.find((u: { id: string }) => u.id === client.id)).toMatchObject({ totalPaid: 5000, totalPending: 3000 });

        const cupons = await go('GET', '/api/users', await staff(['cupons.ver']));
        expect(cupons.status).toBe(200);
        const row = cupons.body.users.find((u: { id: string }) => u.id === client.id);
        expect(Object.keys(row).sort()).toEqual(['email', 'id', 'name', 'role']);

        // Nem a equipe aparece na lista de clientes.
        const admin = await newAdmin();
        const colab = await staff(['hoje.ver']);
        const ids = (ficha.body.users as Array<{ id: string }>).map(u => u.id);
        const all = await go('GET', '/api/users', admin);
        const allIds = (all.body.users as Array<{ id: string }>).map(u => u.id);
        expect(allIds).toContain(client.id);
        expect(allIds).not.toContain(admin.id);
        expect(allIds).not.toContain(colab.id);
        expect(ids).not.toContain(colab.id);
    });

    it('relatórios: sem financeiro.ver não há receita consolidada; com ela, há', async () => {
        const client = await mkUser();
        const contract = await mkContract(client.id);
        await prisma.booking.create({
            data: {
                userId: client.id, contractId: contract.id, date: new Date('2026-09-10T00:00:00Z'), startTime: '10:00', endTime: '12:00',
                status: 'COMPLETED', tierApplied: 'COMERCIAL', price: 90000, addOns: [],
            },
        });
        const sem = await go('GET', `/api/reports/summary${RANGE}`, await staff(['relatorios.ver']));
        expect(sem.status).toBe(200);
        expect(sem.body.summary).not.toHaveProperty('totalRevenue');
        const tiers = await go('GET', `/api/reports/tiers${RANGE}`, await staff(['relatorios.ver']));
        for (const t of tiers.body.tierBreakdown) expect(t).not.toHaveProperty('revenue');

        const com = await go('GET', `/api/reports/summary${RANGE}`, await staff(['relatorios.ver', 'financeiro.ver']));
        expect(com.body.summary.totalRevenue).toBe(90000);
    });
});

// ═══ 7. F2, F3 e F5 da crítica ══════════════════════════

describe('crítica F2 — PATCH /bookings/:id por transição e valor alterado', () => {
    it('hoje.presenca confirma RESERVED, mas não reabre CANCELLED nem FALTA', async () => {
        const owner = await mkUser();
        const presenca = await staff(['hoje.ver', 'hoje.presenca']);
        const { booking: reserved } = await seedFlexBooking(owner, 0, { status: 'RESERVED' });
        expect((await go('PATCH', `/api/bookings/${reserved.id}`, presenca, { status: 'CONFIRMED' })).status).toBe(200);
        for (const [i, status] of (['CANCELLED', 'FALTA'] as const).entries()) {
            const { booking } = await seedFlexBooking(owner, 1 + i, { status });
            const r = await go('PATCH', `/api/bookings/${booking.id}`, presenca, { status: 'CONFIRMED' });
            expectDenied(r, `reabrir ${status}`);
            expect(r.body.permission).toBe('agendamentos.editar');
            expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(status);
        }
    });

    it('sair de NAO_REALIZADO só com agendamentos.editar (sem faltas) → 403 e o crédito NÃO muda', async () => {
        const owner = await mkUser();
        const { booking, contract } = await seedFlexBooking(owner, 0, { status: 'NAO_REALIZADO' });
        const before = (await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).flexCreditsRemaining;
        const r = await go('PATCH', `/api/bookings/${booking.id}`, await staff(['agendamentos.ver', 'agendamentos.editar']), { status: 'CONFIRMED' });
        expectDenied(r, 'sair de NAO_REALIZADO sem faltas');
        expect(r.body.permission).toBe('agendamentos.faltas');
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('NAO_REALIZADO');
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).flexCreditsRemaining).toBe(before);
    });

    it('quem só cancela salva pelo modal completo (date/startTime iguais) e o preço não muda', async () => {
        const owner = await mkUser();
        const { booking, date } = await seedFlexBooking(owner, 0);
        const r = await go('PATCH', `/api/bookings/${booking.id}`, await staff(['agendamentos.ver', 'agendamentos.cancelar']), { date, startTime: '10:00', status: 'CANCELLED' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
        expect([after.status, after.price]).toEqual(['CANCELLED', 12345]);
    });
});

describe('crítica F3 — contrato com pedido de cancelamento em análise exige contratos.multa', () => {
    it('cancelar ou editar o status sem contratos.multa → 403 no DELETE e no PATCH (CANCELLED e ACTIVE); com ela, cancela', async () => {
        const owner = await mkUser();
        const contract = await mkContract(owner.id, { status: 'PENDING_CANCELLATION' });
        const semMulta = await staff(['contratos.ver', 'contratos.editar', 'contratos.cancelar']);
        for (const [method, body] of [['DELETE', undefined], ['PATCH', { status: 'CANCELLED' }], ['PATCH', { status: 'ACTIVE' }]] as const) {
            const r = await go(method, `/api/contracts/${contract.id}`, semMulta, body);
            expectDenied(r, `${method} ${JSON.stringify(body ?? {})}`);
            expect(r.body.permission).toBe('contratos.multa');
        }
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe('PENDING_CANCELLATION');

        const comMulta = await staff(['contratos.ver', 'contratos.cancelar', 'contratos.multa']);
        const ok = await go('DELETE', `/api/contracts/${contract.id}`, comMulta);
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe('CANCELLED');
    });
});

describe('crítica F5 — aviso com lista de ids só para CLIENTES não excluídos', () => {
    it('id de um ADMIN (ou de um colaborador) na lista → 400 INVALID_RECIPIENTS e nada é enviado — vale até para o ADMIN', async () => {
        const admin = await newAdmin();
        const client = await mkUser();
        const colab = await staff(['hoje.ver']);
        for (const target of [admin, colab]) {
            for (const sender of [admin, await staff(['avisos.enviar'])]) {
                const r = await go('POST', '/api/notifications/admin/broadcast', sender, {
                    title: 'Confirme sua senha', message: 'Clique aqui', target: [client.id, target.id], sendPush: false,
                });
                expect(r.status, JSON.stringify(r.body)).toBe(400);
                expect(r.body.code).toBe('INVALID_RECIPIENTS');
                expect(r.body.invalidIds).toEqual([target.id]);
            }
        }
        expect(await prisma.notification.count()).toBe(0);
    });
});

// ═══ 8. Avisos para a equipe ════════════════════════════

describe('§6.3.9 — avisos da equipe seguem a permissão do evento', () => {
    const spDay = (n: number) => dbDate(addDaysYmd(todaySp, n));

    it('pedido de cancelamento do cliente: avisa quem tem contratos.multa (e o ADMIN); quem não tem, não', async () => {
        const admin = await newAdmin();
        const comMulta = await staff(['contratos.ver', 'contratos.multa']);
        const semMulta = await staff(['contratos.ver', 'contratos.editar', 'contratos.cancelar']);
        const client = await mkUser({ name: 'Cliente Cancela' });
        const contract = await mkContract(client.id, { type: 'FIXO', paymentMethod: 'PIX', startDate: spDay(-20), endDate: spDay(64) });
        await mkPayment(client.id, { contractId: contract.id, amount: 84000, status: 'PAID', paidAt: new Date(), dueDate: spDay(-20) });
        await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(8) });

        const r = await go('POST', `/api/contracts/${contract.id}/request-cancellation`, client);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        const notes = (userId: string) => prisma.notification.count({ where: { userId, type: 'CANCELLATION_PENDING', entityId: contract.id } });
        expect(await notes(admin.id)).toBe(1);
        expect(await notes(comMulta.id)).toBe(1);
        expect(await notes(semMulta.id)).toBe(0);
    });

    it('alertas calculados do sino: vencidas só para quem vê o financeiro; permissão retirada some na hora', async () => {
        const client = await mkUser({ name: 'Cliente Vencido' });
        await mkPayment(client.id, { amount: 50000, dueDate: spDay(-5) });
        const overdueId = `payment-overdue-${client.id}`;
        const computedIds = async (who: Who | string) => {
            const r = await go('GET', '/api/notifications', who);
            expect(r.status).toBe(200);
            return (r.body.notifications as Array<{ id: string; source: string }>).filter(n => n.source === 'computed').map(n => n.id);
        };

        const fin = await staff(['financeiro.ver']);
        const session = cookieFor(fin);
        expect(await computedIds(session)).toContain(overdueId);
        expect(await computedIds(await staff(['cobrancas.cobrar', 'cobrancas.baixa']))).not.toContain(overdueId);
        expect(await computedIds(await newAdmin())).toContain(overdueId);

        await prisma.staffProfile.update({ where: { userId: fin.id }, data: { permissions: [] } });
        expect(await computedIds(session)).not.toContain(overdueId);
    });
});

// ═══ 9. S1 e S3 (desativação) ═══════════════════════════

describe('crítica S1 — desativado não recebe push', () => {
    const subscribe = (userId: string, n = 0) => prisma.pushSubscription.create({
        data: { userId, endpoint: `https://push.test/${userId}/${n}`, p256dh: 'p256dh-test', auth: 'auth-test' },
    });

    it('desativar pela tela Equipe apaga as inscrições; e o job ignora quem está desativado mesmo com inscrição', async () => {
        await prisma.notificationTemplate.create({ data: { eventKey: 'computed_payment_overdue_admin', pushEnabled: true } });
        invalidateTemplateCache();
        const client = await mkUser({ name: 'Cliente Vencido' });
        await mkPayment(client.id, { amount: 50000, dueDate: dbDate(addDaysYmd(todaySp, -5)) });

        const admin = await newAdmin();
        const ativo = await staff(['financeiro.ver']);
        const saindo = await staff(['financeiro.ver']);
        await subscribe(ativo.id);
        await subscribe(saindo.id);

        const off = await go('POST', `/api/staff/${saindo.id}/deactivate`, admin);
        expect(off.status, JSON.stringify(off.body)).toBe(200);
        expect(await prisma.pushSubscription.count({ where: { userId: saindo.id } })).toBe(0);

        // Um aparelho antigo que volte a se inscrever não faz o desativado receber nada.
        await subscribe(saindo.id, 1);
        await runPushNotificationJob();
        const pushed = new Set(sendPush.mock.calls.map(c => c[0] as string));
        expect(pushed.has(ativo.id)).toBe(true);
        expect(pushed.has(saindo.id)).toBe(false);
        expect(await prisma.notification.count({ where: { userId: saindo.id } })).toBe(0);
    });
});

describe('crítica S3 — desativado é mandado ao login', () => {
    it('/me → 401 ACCOUNT_DISABLED; refresh e login → 403 ACCOUNT_DISABLED (o front trata os dois como conta encerrada)', async () => {
        const passwordHash = await bcrypt.hash('senha-forte-1', 4);
        const colab = await staff(['hoje.ver'], { passwordHash, clientStatus: 'BLOCKED' });
        const me = await go('GET', '/api/auth/me', colab);
        expect(me.status).toBe(401);
        expect(me.body).toEqual({ code: 'ACCOUNT_DISABLED', error: 'Seu acesso foi desativado. Fale com o administrador.' });

        const refresh = await go('POST', '/api/auth/refresh', refreshCookieFor(colab));
        expect(refresh.status).toBe(403);
        expect(refresh.body.code).toBe('ACCOUNT_DISABLED');

        const login = await go('POST', '/api/auth/login', undefined, { email: colab.email, password: 'senha-forte-1' });
        expect(login.status).toBe(403);
        expect(login.body.code).toBe('ACCOUNT_DISABLED');
    });
});
