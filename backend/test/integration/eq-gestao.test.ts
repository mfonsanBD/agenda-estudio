import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// ─── Mocks dos provedores (Stripe / Sicoob / Cora / e-mail): nenhuma chamada de rede real ─────────
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

import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { config } from '../../src/config/index';
import * as stripe from '../../src/lib/stripeService';
import { allPermissionKeys, type PermissionKey } from '../../src/config/staffPermissions';
import stripeRoutes from '../../src/modules/stripe/routes';
import paymentRoutes from '../../src/modules/payments/routes';
import { financeRouter } from '../../src/modules/finance/routes';
import reportRoutes from '../../src/modules/reports/routes';
import couponRoutes from '../../src/modules/coupons/routes';
import pricingRoutes from '../../src/modules/pricing/routes';
import integrationRoutes from '../../src/modules/integrations/routes';
import notificationAdminRoutes from '../../src/modules/notifications/admin';
import { mkUser, mkStaff, mkContract, mkPayment, mkBooking, mkCoupon, mkCpf } from './factories';

// Frente B3 (Equipe / COLABORADOR): rotas de GESTÃO — cobranças, financeiro, relatórios, cupons,
// configurações, integrações e avisos — passam pela matriz de permissões (DECISOES-EQUIPE.md D2/D3):
//  • tabela da verdade: em cada rota, CLIENTE → 403; COLABORADOR sem a chave (vazio E com todas as OUTRAS
//    chaves) → 403 PERMISSION_DENIED; COLABORADOR com a chave (cada uma do "qualquer uma de") → passa;
//    ADMIN → passa. Rotas "só ADMIN": COLABORADOR com TODAS as chaves → 403. Autoatendimento: só CLIENTE.
//    Rotas mistas: o cliente segue o ramo dele (não é recusado por permissão); R4e — o dono, o COLABORADOR
//    com a chave e o ADMIN recebem o status EXATO (`ok`, QT-01) e um CLIENTE estranho recebe `stranger`
//    (404 na cobrança alheia) sem mudar a cobrança (QT-02). Nenhum 403 conta como "passou" fora do `ok`;
//  • caso 5 (Configurações): grupos permitidos no GET; PUT tudo-ou-nada por grupo (nada gravado no 403);
//  • caso 6 (dinheiro): cartões salvos só com cobrancas.cartao_salvo; debitar cartão salvo exige a chave;
//    baixa manual só com cobrancas.baixa; receita dos relatórios só com financeiro.ver (ranking por
//    sessões sem ela); GET /users MANTÉM totalPaid/totalPending (DECISOES, resposta 3);
//  • F5: aviso com lista de ids só para CLIENTES não excluídos (senão 400, nada enviado).

type Who = { id: string; email: string | null; role: string };
type Res = { status: number; body: any };
const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/stripe', stripeRoutes);
    app.use('/api/payments', paymentRoutes);
    app.use('/api/finance', financeRouter);
    app.use('/api/reports', reportRoutes);
    app.use('/api/coupons', couponRoutes);
    app.use('/api/pricing', pricingRoutes);
    app.use('/api/integrations', integrationRoutes);
    app.use('/api/notifications/admin', notificationAdminRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

function cookie(u: Who) {
    return `accessToken=${jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' })}`;
}

async function callAt(root: string, method: string, path: string, who?: Who, body?: unknown): Promise<Res> {
    const res = await fetch(`${root}${path}`, {
        method,
        headers: {
            ...(who ? { Cookie: cookie(who) } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
const call = (method: string, path: string, who?: Who, body?: unknown) => callAt(base, method, path, who, body);

const ALL_KEYS: PermissionKey[] = allPermissionKeys();
const CONFIG_KEYS: PermissionKey[] = ALL_KEYS.filter(k => k.startsWith('config.'));

/** 403 da matriz (o 403 do sandbox do /simulate, por exemplo, não conta). */
const isDenied = (r: Res) => r.status === 403 && r.body?.code === 'PERMISSION_DENIED';

function expectDenied(r: Res, label: string) {
    expect(isDenied(r), `${label}: esperado 403 PERMISSION_DENIED, veio ${r.status} ${JSON.stringify(r.body)}`).toBe(true);
}
/**
 * Passou da permissão. R4e (QT-01): nenhum 403 conta como "passou" — nem o sem `code` — salvo quando a
 * linha declara exatamente esse status (`ok: 403`, o sandbox desligado do /simulate); e, com `ok`, o
 * status precisa ser EXATAMENTE ele (um 404 do filtro do cliente aplicado à equipe reprova).
 */
function expectAllowed(r: Res, label: string, ok?: number) {
    const bad = isDenied(r) || r.status === 401 || r.status >= 500 || (r.status === 403 && ok !== 403);
    expect(bad, `${label}: esperado passar pela permissão, veio ${r.status} ${JSON.stringify(r.body)}`).toBe(false);
    if (ok !== undefined) expect(r.status, `${label}: esperado ${ok}, veio ${r.status} ${JSON.stringify(r.body)}`).toBe(ok);
}

/** A cobrança inteira que um efeito mudaria (baixa, emissão, troca de provedor, valor). */
const paymentState = (id: string) => prisma.payment.findUniqueOrThrow({
    where: { id },
    select: { status: true, provider: true, providerRef: true, pixString: true, boletoUrl: true, amount: true, chargedAmount: true, paidAt: true },
});

const staff = (permissions: string[]) => mkStaff({ permissions });

// ─── Fixtures da tabela da verdade ──────────────────────

interface Fx {
    admin: Who;
    client: Who;
    paymentId: string;
    couponId: string;
    couponCode: string;
}

async function mkFx(): Promise<Fx> {
    const admin = await mkUser({ role: 'ADMIN' });
    const client = await mkUser({ cpfCnpj: mkCpf(), stripeCustomerId: 'cus_client' });
    const payment = await mkPayment(client.id, { provider: 'SICOOB', amount: 84000, dueDate: new Date('2026-09-20T00:00:00Z') });
    // Cupom EXCLUSIVO do cliente da fixture: o estranho que manda o userId dele é avaliado como ele mesmo (QT-02).
    const coupon = await mkCoupon(admin.id, { active: true, eligibleUsers: { create: [{ userId: client.id }] } });
    // Cartão ativo: o create-payment (cartão novo) passa da forma de pagamento e chega à busca da cobrança.
    await prisma.paymentMethodConfig.create({
        data: { key: 'CARTAO', label: 'CARTAO', shortLabel: 'CARTAO', emoji: '-', description: 'CARTAO', color: '#000000', active: true, sortOrder: 0 },
    });
    return { admin, client, paymentId: payment.id, couponId: coupon.id, couponCode: coupon.code };
}

/** `need`: chaves (qualquer uma) | 'ADMIN' (só o administrador) | 'CLIENTE' (autoatendimento). */
interface Row {
    name: string;
    method: string;
    path: (fx: Fx) => string;
    body?: (fx: Fx) => unknown;
    need: PermissionKey[] | 'ADMIN' | 'CLIENTE';
    /** Rota mista: o cliente segue o ramo dele (nunca 403 de permissão). */
    mixed?: boolean;
    /** Rota mista (QT-01): status EXATO do dono, do COLABORADOR com cada chave e do ADMIN. */
    ok?: number;
    /** Rota mista (QT-02): status EXATO de um CLIENTE que não é o dono da fixture; a cobrança fica intacta. */
    stranger?: number;
    strangerCode?: string;
}

const RANGE = '?from=2026-09-01&to=2026-09-30';
const EVENT = 'payment_confirmed';

const ROWS: Row[] = [
    // ── Cobranças e financeiro ──
    { name: 'GET /api/payments', method: 'GET', path: () => '/api/payments', need: ['financeiro.ver'] },
    { name: 'GET /api/payments/summary', method: 'GET', path: () => '/api/payments/summary', need: ['financeiro.ver'] },
    { name: 'PATCH /api/payments/:id (baixa manual)', method: 'PATCH', path: fx => `/api/payments/${fx.paymentId}`, body: () => ({ status: 'CANCELLED' }), need: ['cobrancas.baixa'] },
    { name: 'GET /api/payments/:id/status (mista)', method: 'GET', path: fx => `/api/payments/${fx.paymentId}/status`, need: ['cobrancas.cobrar', 'financeiro.ver', 'cobrancas.baixa'], mixed: true, ok: 200, stranger: 404 },
    // Sem integração em sandbox: o 403 SEM code ("só em sandbox") vem DEPOIS da busca da cobrança — por isso é
    // o status exato de quem a encontra (um 404 aqui seria o filtro do cliente aplicado à equipe).
    { name: 'POST /api/payments/:id/simulate (mista; sandbox)', method: 'POST', path: fx => `/api/payments/${fx.paymentId}/simulate`, need: ['cobrancas.cobrar'], mixed: true, ok: 403, stranger: 404 },
    { name: 'GET /api/finance/closing/:y/:m', method: 'GET', path: () => '/api/finance/closing/2026/9', need: ['financeiro.ver'] },
    { name: 'GET /api/stripe/payment-methods/for-payment/:id', method: 'GET', path: fx => `/api/stripe/payment-methods/for-payment/${fx.paymentId}`, need: ['cobrancas.cobrar'] },
    // Cartão novo (PI mockado): nada barra antes da busca da cobrança (o boleto parava no BOLETO_UNAVAILABLE).
    { name: 'POST /api/stripe/create-payment (mista)', method: 'POST', path: () => '/api/stripe/create-payment', body: fx => ({ paymentId: fx.paymentId, paymentMethod: 'cartao' }), need: ['cobrancas.cobrar'], mixed: true, ok: 200, stranger: 404 },
    { name: 'POST /api/stripe/installment-plans com paymentId (mista)', method: 'POST', path: () => '/api/stripe/installment-plans', body: fx => ({ paymentId: fx.paymentId }), need: ['cobrancas.cobrar'], mixed: true, ok: 200, stranger: 404 },
    { name: 'POST /api/stripe/verify-payment (mista)', method: 'POST', path: () => '/api/stripe/verify-payment', body: fx => ({ paymentId: fx.paymentId, paymentIntentId: 'pi_x' }), need: ['cobrancas.cobrar'], mixed: true, ok: 200, stranger: 404 },
    { name: 'POST /api/stripe/setup-intent (autoatendimento)', method: 'POST', path: () => '/api/stripe/setup-intent', need: 'CLIENTE' },
    { name: 'PUT /api/stripe/auto-charge (autoatendimento)', method: 'PUT', path: () => '/api/stripe/auto-charge', body: () => ({ enabled: false }), need: 'CLIENTE' },

    // ── Relatórios ──
    { name: 'GET /api/reports/summary', method: 'GET', path: () => `/api/reports/summary${RANGE}`, need: ['relatorios.ver'] },
    { name: 'GET /api/reports/occupancy', method: 'GET', path: () => `/api/reports/occupancy${RANGE}`, need: ['relatorios.ver'] },
    { name: 'GET /api/reports/tiers', method: 'GET', path: () => `/api/reports/tiers${RANGE}`, need: ['relatorios.ver'] },
    { name: 'GET /api/reports/audience', method: 'GET', path: () => `/api/reports/audience${RANGE}`, need: ['relatorios.ver'] },
    { name: 'GET /api/reports/ranking', method: 'GET', path: () => `/api/reports/ranking${RANGE}`, need: ['relatorios.ver'] },

    // ── Cupons ──
    { name: 'GET /api/coupons', method: 'GET', path: () => '/api/coupons', need: ['cupons.ver'] },
    { name: 'GET /api/coupons/:id', method: 'GET', path: fx => `/api/coupons/${fx.couponId}`, need: ['cupons.ver'] },
    { name: 'POST /api/coupons', method: 'POST', path: () => '/api/coupons', body: () => ({ code: 'EQNOVO10', discountType: 'PERCENTUAL', discountValue: 10 }), need: ['cupons.editar'] },
    { name: 'PATCH /api/coupons/:id', method: 'PATCH', path: fx => `/api/coupons/${fx.couponId}`, body: () => ({ active: false }), need: ['cupons.editar'] },
    { name: 'DELETE /api/coupons/:id (excluir está em cupons.editar)', method: 'DELETE', path: fx => `/api/coupons/${fx.couponId}`, need: ['cupons.editar'] },
    // Cupom exclusivo do cliente da fixture: dono e equipe validam (200); o estranho é avaliado como ele mesmo.
    { name: 'POST /api/coupons/validate com userId alvo (mista)', method: 'POST', path: () => '/api/coupons/validate', body: fx => ({ code: fx.couponCode, amount: 10000, userId: fx.client.id }), need: ['agendamentos.criar', 'contratos.criar', 'cobrancas.cobrar'], mixed: true, ok: 200, stranger: 403, strangerCode: 'NOT_ELIGIBLE' },

    // ── Avisos e modelos de mensagem ──
    { name: 'GET /api/notifications/admin/events', method: 'GET', path: () => '/api/notifications/admin/events', need: ['avisos.modelos', 'avisos.enviar'] },
    { name: 'PUT /api/notifications/admin/templates/:eventKey', method: 'PUT', path: () => `/api/notifications/admin/templates/${EVENT}`, body: () => ({ enabled: true }), need: ['avisos.modelos'] },
    { name: 'DELETE /api/notifications/admin/templates/:eventKey', method: 'DELETE', path: () => `/api/notifications/admin/templates/${EVENT}`, need: ['avisos.modelos'] },
    { name: 'POST /api/notifications/admin/templates/:eventKey/test', method: 'POST', path: () => `/api/notifications/admin/templates/${EVENT}/test`, body: () => ({ nonce: 1 }), need: ['avisos.modelos'] },
    { name: 'POST /api/notifications/admin/broadcast', method: 'POST', path: () => '/api/notifications/admin/broadcast', body: fx => ({ title: 'Aviso de teste', message: 'Mensagem de teste', target: [fx.client.id], sendPush: false }), need: ['avisos.enviar'] },
    { name: 'GET /api/notifications/admin/broadcasts', method: 'GET', path: () => '/api/notifications/admin/broadcasts', need: ['avisos.enviar', 'avisos.modelos'] },

    // ── Configurações ──
    { name: 'GET /api/pricing/business-config (qualquer config.*)', method: 'GET', path: () => '/api/pricing/business-config', need: CONFIG_KEYS },
    { name: 'PUT /api/pricing/business-config (grupo policies)', method: 'PUT', path: () => '/api/pricing/business-config', body: () => ({ configs: [{ key: 'cancellation_fine_pct', value: '20' }] }), need: ['config.politicas'] },
    { name: 'GET /api/pricing/business-config/fee-history', method: 'GET', path: () => '/api/pricing/business-config/fee-history', need: 'ADMIN' },
    { name: 'POST /api/pricing/business-config/email/test', method: 'POST', path: () => '/api/pricing/business-config/email/test', body: () => ({}), need: 'ADMIN' },
    { name: 'PUT /api/pricing (faixas)', method: 'PUT', path: () => '/api/pricing', body: () => ({ pricing: [{ tier: 'COMERCIAL', price: 30000, label: 'Comercial' }] }), need: ['config.precos'] },
    { name: 'GET /api/pricing/addons/all', method: 'GET', path: () => '/api/pricing/addons/all', need: ['config.servicos'] },
    { name: 'PUT /api/pricing/addons', method: 'PUT', path: () => '/api/pricing/addons', body: () => ({ addons: [] }), need: ['config.servicos'] },
    { name: 'DELETE /api/pricing/addons/:key', method: 'DELETE', path: () => '/api/pricing/addons/NAO_EXISTE', need: ['config.servicos'] },
    { name: 'GET /api/pricing/payment-methods/all', method: 'GET', path: () => '/api/pricing/payment-methods/all', need: ['config.pagamentos'] },
    { name: 'PUT /api/pricing/payment-methods', method: 'PUT', path: () => '/api/pricing/payment-methods', body: () => ({ methods: [] }), need: ['config.pagamentos'] },
    { name: 'PUT /api/pricing/payment-methods/boleto', method: 'PUT', path: () => '/api/pricing/payment-methods/boleto', body: () => ({ enabled: false }), need: ['config.pagamentos'] },

    // ── Integrações (só ADMIN) ──
    { name: 'GET /api/integrations', method: 'GET', path: () => '/api/integrations', need: 'ADMIN' },
    { name: 'GET /api/integrations/:provider', method: 'GET', path: () => '/api/integrations/STRIPE', need: 'ADMIN' },
    { name: 'PUT /api/integrations/:provider', method: 'PUT', path: () => '/api/integrations/NAO_EXISTE', body: () => ({ config: {} }), need: 'ADMIN' },
    { name: 'POST /api/integrations/:provider/test', method: 'POST', path: () => '/api/integrations/NAO_EXISTE/test', need: 'ADMIN' },
    { name: 'POST /api/integrations/:provider/toggle', method: 'POST', path: () => '/api/integrations/NAO_EXISTE/toggle', body: () => ({ enabled: false }), need: 'ADMIN' },
    { name: 'GET /api/integrations/cora/webhooks', method: 'GET', path: () => '/api/integrations/cora/webhooks', need: 'ADMIN' },
    { name: 'POST /api/integrations/cora/webhooks', method: 'POST', path: () => '/api/integrations/cora/webhooks', body: () => ({}), need: 'ADMIN' },
    { name: 'DELETE /api/integrations/cora/webhooks/:id', method: 'DELETE', path: () => '/api/integrations/cora/webhooks/wh_test', need: 'ADMIN' },
    { name: 'GET /api/integrations/sicoob/webhook', method: 'GET', path: () => '/api/integrations/sicoob/webhook', need: 'ADMIN' },
    { name: 'POST /api/integrations/sicoob/webhook', method: 'POST', path: () => '/api/integrations/sicoob/webhook', body: () => ({ url: 'https://exemplo.test/api/webhooks/sicoob' }), need: 'ADMIN' },
    { name: 'DELETE /api/integrations/sicoob/webhook', method: 'DELETE', path: () => '/api/integrations/sicoob/webhook', need: 'ADMIN' },
];

describe('B3 — tabela da verdade das rotas de gestão (CLIENTE × COLABORADOR × ADMIN)', () => {
    for (const row of ROWS) {
        it(row.name, async () => {
            const fx = await mkFx();
            const go = (who?: Who) => call(row.method, row.path(fx), who, row.body?.(fx));

            // Sem login → 401 (nenhuma rota de gestão é pública).
            expect((await go()).status, `${row.name}: sem login`).toBe(401);

            // QT-02: CLIENTE que NÃO é o dono da fixture → status exato (404 na cobrança alheia) e nada muda nela.
            if (row.mixed) {
                expect(row.stranger, `${row.name}: linha mista sem o status do cliente estranho`).toBeDefined();
                const before = await paymentState(fx.paymentId);
                const asStranger = await go(await mkUser());
                expect(asStranger.status, `${row.name} · CLIENTE estranho: ${JSON.stringify(asStranger.body)}`).toBe(row.stranger);
                if (row.strangerCode) expect(asStranger.body.code, `${row.name} · CLIENTE estranho`).toBe(row.strangerCode);
                expect(asStranger.body).not.toHaveProperty('pixString');
                expect(asStranger.body).not.toHaveProperty('boletoUrl');
                expect(await paymentState(fx.paymentId), `${row.name} · CLIENTE estranho: cobrança intacta`).toEqual(before);
            }

            // CLIENTE (dono da fixture)
            const asClient = await go(fx.client);
            if (row.need === 'CLIENTE') expectAllowed(asClient, `${row.name} · CLIENTE`);
            else if (row.mixed) {
                expect(row.ok, `${row.name}: linha mista sem o status exato de sucesso`).toBeDefined();
                expectAllowed(asClient, `${row.name} · CLIENTE (dono)`, row.ok);
            } else expectDenied(asClient, `${row.name} · CLIENTE`);

            if (row.need === 'CLIENTE') {
                // Autoatendimento: nenhuma conta da equipe passa (nem com todas as chaves, nem o ADMIN — S5).
                expectDenied(await go(await staff(ALL_KEYS)), `${row.name} · COLABORADOR com todas as chaves`);
                expectDenied(await go(fx.admin), `${row.name} · ADMIN`);
                return;
            }

            if (row.need === 'ADMIN') {
                expectDenied(await go(await staff([])), `${row.name} · COLABORADOR sem chaves`);
                expectDenied(await go(await staff(ALL_KEYS)), `${row.name} · COLABORADOR com TODAS as chaves`);
                expectAllowed(await go(fx.admin), `${row.name} · ADMIN`);
                return;
            }

            const need = row.need;
            // COLABORADOR sem nenhuma chave e com todas as OUTRAS chaves (prova que a chave certa é exigida).
            expectDenied(await go(await staff([])), `${row.name} · COLABORADOR sem chaves`);
            const others = ALL_KEYS.filter(k => !need.includes(k));
            expectDenied(await go(await staff(others)), `${row.name} · COLABORADOR com as outras ${others.length} chaves`);
            // COLABORADOR com cada chave aceita (qualquer uma de) — nas mistas, o sucesso EXATO (QT-01).
            for (const key of need) {
                expectAllowed(await go(await staff([key])), `${row.name} · COLABORADOR com ${key}`, row.ok);
            }
            expectAllowed(await go(fx.admin), `${row.name} · ADMIN`, row.ok);
        });
    }
});

// ─── Caso 5: Configurações ──────────────────────────────

describe('Caso 5 — Configurações: grupos permitidos e PUT tudo-ou-nada', () => {
    const cfgValue = async (key: string) => (await prisma.businessConfig.findUnique({ where: { key } }))?.value ?? null;

    it('config.politicas salva o grupo policies', async () => {
        const colab = await staff(['config.politicas']);
        const r = await call('PUT', '/api/pricing/business-config', colab, { configs: [{ key: 'cancellation_fine_pct', value: '35' }] });
        expect(r.status).toBe(200);
        expect(await cfgValue('cancellation_fine_pct')).toBe('35');
    });

    it('lote com chave de grupo não permitido (email_smtp_host) → 403 inteiro e NADA é gravado', async () => {
        await prisma.businessConfig.create({ data: { key: 'cancellation_fine_pct', value: '20', type: 'percent', label: 'Multa', group: 'policies' } });
        const colab = await staff(['config.politicas']);
        const r = await call('PUT', '/api/pricing/business-config', colab, {
            configs: [{ key: 'cancellation_fine_pct', value: '50' }, { key: 'email_smtp_host', value: 'smtp.golpe.test' }],
        });
        expectDenied(r, 'lote misto');
        expect(r.body.permission).toBe('config.email');
        expect(r.body.deniedGroups).toEqual(['email']);
        expect(await cfgValue('cancellation_fine_pct')).toBe('20');
        expect(await cfgValue('email_smtp_host')).toBeNull();
    });

    it('taxas de gateway (grupo gateway) são só do ADMIN, mesmo com config.precos', async () => {
        const colab = await staff(['config.precos']);
        const denied = await call('PUT', '/api/pricing/business-config', colab, { configs: [{ key: 'gateway_stripe_fee_pct', value: '1.5' }] });
        expectDenied(denied, 'gateway');
        expect(denied.body.deniedGroups).toEqual(['gateway']);
        expect(await cfgValue('gateway_stripe_fee_pct')).toBeNull();
        expect(await prisma.gatewayFeeHistory.count()).toBe(0);

        const admin = await mkUser({ role: 'ADMIN' });
        expect((await call('PUT', '/api/pricing/business-config', admin, { configs: [{ key: 'gateway_stripe_fee_pct', value: '1.5' }] })).status).toBe(200);
        expect(await cfgValue('gateway_stripe_fee_pct')).toBe('1.5');
    });

    it('chave fora do catálogo: vale o grupo da linha no banco (schedule → config.horarios); sem linha → só ADMIN', async () => {
        await prisma.businessConfig.create({ data: { key: 'time_slots', value: '10:00,14:00', type: 'string', label: 'Horários', group: 'schedule' } });
        const horarios = await staff(['config.horarios']);
        expect((await call('PUT', '/api/pricing/business-config', horarios, { configs: [{ key: 'time_slots', value: '09:00,13:00' }] })).status).toBe(200);
        expect(await cfgValue('time_slots')).toBe('09:00,13:00');

        const politicas = await staff(['config.politicas']);
        const deniedSchedule = await call('PUT', '/api/pricing/business-config', politicas, { configs: [{ key: 'time_slots', value: '08:00' }] });
        expectDenied(deniedSchedule, 'schedule sem config.horarios');
        expect(deniedSchedule.body.deniedGroups).toEqual(['schedule']);

        const allConfig = await staff(CONFIG_KEYS);
        const deniedNew = await call('PUT', '/api/pricing/business-config', allConfig, { configs: [{ key: 'chave_inventada', value: 'x' }] });
        expectDenied(deniedNew, 'chave fora do catálogo e do banco');
        expect(deniedNew.body.permission).toBe('ADMIN');
        expect(await cfgValue('chave_inventada')).toBeNull();

        const admin = await mkUser({ role: 'ADMIN' });
        expect((await call('PUT', '/api/pricing/business-config', admin, { configs: [{ key: 'chave_inventada', value: 'x' }] })).status).toBe(200);
        expect(await cfgValue('chave_inventada')).toBe('x');
    });

    it('GET devolve só os grupos permitidos (nunca email/gateway para o colaborador); ADMIN vê todos', async () => {
        await prisma.businessConfig.create({ data: { key: 'email_smtp_password', value: 'segredo', type: 'string', label: 'Senha', group: 'email' } });
        const colab = await staff(['config.politicas']);
        const r = await call('GET', '/api/pricing/business-config', colab);
        expect(r.status).toBe(200);
        expect(Object.keys(r.body.grouped)).toEqual(['policies']);
        expect(r.body.configs.length).toBeGreaterThan(0);
        expect(r.body.configs.every((c: { group: string }) => c.group === 'policies')).toBe(true);

        const precos = await staff(['config.precos']);
        const p = await call('GET', '/api/pricing/business-config', precos);
        expect(Object.keys(p.body.grouped).sort()).toEqual(['payments', 'plans']);

        // Caixa sem grupo de business-config (Serviços): abre a rota, mas não vê nenhum grupo.
        const servicos = await staff(['config.servicos']);
        const s = await call('GET', '/api/pricing/business-config', servicos);
        expect(s.status).toBe(200);
        expect(s.body.configs).toEqual([]);

        const admin = await mkUser({ role: 'ADMIN' });
        const a = await call('GET', '/api/pricing/business-config', admin);
        expect(Object.keys(a.body.grouped)).toEqual(expect.arrayContaining(['email', 'gateway', 'policies', 'plans', 'payments', 'studio']));
        // Segredo SMTP continua mascarado até para o ADMIN.
        expect(a.body.configs.find((c: { key: string }) => c.key === 'email_smtp_password')?.value).toBe('••••••••');
    });
});

// ─── Caso 6: dinheiro ───────────────────────────────────

describe('Caso 6 — dinheiro: cartão salvo, baixa manual e receita', () => {
    async function clientWithCards() {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ cpfCnpj: mkCpf(), stripeCustomerId: 'cus_cards' });
        const payment = await mkPayment(client.id, { provider: 'STRIPE', amount: 84000 });
        const card = await prisma.savedPaymentMethod.create({
            data: { userId: client.id, stripePaymentMethodId: 'pm_cliente_1', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2031, isDefault: true },
        });
        await prisma.savedPaymentMethod.create({
            data: { userId: client.id, stripePaymentMethodId: 'pm_cliente_2', brand: 'master', last4: '5555', expMonth: 10, expYear: 2030 },
        });
        return { admin, client, payment, card };
    }

    it('for-payment: sem cobrancas.cartao_salvo a lista de cartões vem vazia (o CPF do pagador continua)', async () => {
        const { admin, client, payment } = await clientWithCards();
        const url = `/api/stripe/payment-methods/for-payment/${payment.id}`;

        const balcao = await call('GET', url, await staff(['cobrancas.cobrar']));
        expect(balcao.status).toBe(200);
        expect(balcao.body.paymentMethods).toEqual([]);
        expect(balcao.body.canUseSavedCards).toBe(false);
        expect(balcao.body.payer).toMatchObject({ id: client.id, cpfCnpj: client.cpfCnpj, hasValidCpfCnpj: true });

        const financeiro = await call('GET', url, await staff(['cobrancas.cobrar', 'cobrancas.cartao_salvo']));
        expect(financeiro.status).toBe(200);
        expect(financeiro.body.canUseSavedCards).toBe(true);
        expect(financeiro.body.paymentMethods.map((c: { last4: string }) => c.last4).sort()).toEqual(['4242', '5555']);

        const asAdmin = await call('GET', url, admin);
        expect(asAdmin.body.paymentMethods).toHaveLength(2);
        expect(asAdmin.body.canUseSavedCards).toBe(true);
    });

    it('create-payment com savedPaymentMethodId sem cobrancas.cartao_salvo → 403 antes de qualquer efeito', async () => {
        const { client, payment, card } = await clientWithCards();
        for (const [i, key] of ['PIX', 'CARTAO'].entries()) {
            await prisma.paymentMethodConfig.create({ data: { key, label: key, shortLabel: key, emoji: '-', description: key, color: '#000000', active: true, sortOrder: i } });
        }
        await prisma.integrationConfig.create({ data: { provider: 'STRIPE', enabled: true, environment: 'sandbox', config: '{}' } });
        m(stripe.stripeCreatePaymentIntent).mockClear();

        const body = { paymentId: payment.id, paymentMethod: 'cartao', savedPaymentMethodId: card.id };
        const semCartao = await call('POST', '/api/stripe/create-payment', await staff(['cobrancas.cobrar']), body);
        expectDenied(semCartao, 'sem cartao_salvo');
        expect(semCartao.body.permission).toBe('cobrancas.cartao_salvo');
        expect(stripe.stripeCreatePaymentIntent).not.toHaveBeenCalled();
        const intact = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(intact.providerRef).toBeNull();
        expect(intact.status).toBe('PENDING');

        // Sem cobrancas.cobrar (só ver o financeiro) a equipe não cobra nada — nem PIX.
        const soVer = await call('POST', '/api/stripe/create-payment', await staff(['financeiro.ver']), { paymentId: payment.id, paymentMethod: 'pix' });
        expectDenied(soVer, 'só financeiro.ver');
        expect(soVer.body.permission).toBe('cobrancas.cobrar');

        // Com a chave: debita o cartão salvo do CLIENTE e a trilha registra QUEM cobrou.
        const financeiro = await staff(['cobrancas.cobrar', 'cobrancas.cartao_salvo']);
        const ok = await call('POST', '/api/stripe/create-payment', financeiro, body);
        expect(ok.status).toBe(200);
        expect(stripe.stripeCreatePaymentIntent).toHaveBeenCalledTimes(1);
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[0][0]).toMatchObject({ userId: client.id, savedPaymentMethodId: 'pm_cliente_1' });
        const log = await prisma.auditLog.findMany({ where: { entityType: 'PAYMENT', entityId: payment.id } });
        expect(log.map(l => [l.action, l.performedBy])).toEqual([['ADMIN_CHARGED_SAVED_CARD', financeiro.id]]);
    });

    it('PATCH /payments/:id (marcar como pago) só com cobrancas.baixa', async () => {
        const client = await mkUser();
        const payment = await mkPayment(client.id, { amount: 5000 });

        const balcao = await call('PATCH', `/api/payments/${payment.id}`, await staff(['cobrancas.cobrar', 'financeiro.ver']), { status: 'PAID' });
        expectDenied(balcao, 'sem baixa');
        expect(balcao.body.permission).toBe('cobrancas.baixa');
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('PENDING');

        const baixa = await staff(['cobrancas.baixa']);
        const ok = await call('PATCH', `/api/payments/${payment.id}`, baixa, { status: 'PAID' });
        expect(ok.status).toBe(200);
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('PAID');
        const log = await prisma.auditLog.findFirst({ where: { entityType: 'PAYMENT', entityId: payment.id, action: 'STATUS_PAID' } });
        expect(log?.performedBy).toBe(baixa.id);
    });

    it('relatórios: sem financeiro.ver não há receita e o ranking sai por sessões; com ela, como antes', async () => {
        const caro = await mkUser({ name: 'Cliente Caro' });
        const frequente = await mkUser({ name: 'Cliente Frequente' });
        const cCaro = await mkContract(caro.id);
        const cFreq = await mkContract(frequente.id);
        await mkBooking(caro.id, cCaro.id, { date: new Date('2026-09-10T00:00:00Z'), price: 90000, status: 'COMPLETED' });
        for (const [i, day] of ['11', '12', '13'].entries()) {
            await mkBooking(frequente.id, cFreq.id, { date: new Date(`2026-09-${day}T00:00:00Z`), startTime: ['10:00', '14:00', '18:00'][i], price: 10000 });
        }

        const operador = await staff(['relatorios.ver']);
        const summary = await call('GET', `/api/reports/summary${RANGE}`, operador);
        expect(summary.status).toBe(200);
        expect(summary.body.summary.totalBookings).toBe(4);
        expect(summary.body.summary).not.toHaveProperty('totalRevenue');

        const tiers = await call('GET', `/api/reports/tiers${RANGE}`, operador);
        expect(tiers.status).toBe(200);
        expect(tiers.body.tierBreakdown.length).toBeGreaterThan(0);
        for (const t of tiers.body.tierBreakdown) expect(t).not.toHaveProperty('revenue');
        expect(tiers.body.tierBreakdown.find((t: { tier: string }) => t.tier === 'COMERCIAL').count).toBe(4);

        const ranking = await call('GET', `/api/reports/ranking${RANGE}`, operador);
        expect(ranking.status).toBe(200);
        expect(ranking.body.ranking.map((r: { id: string }) => r.id)).toEqual([frequente.id, caro.id]);
        for (const r of ranking.body.ranking) expect(r).not.toHaveProperty('revenue');
        expect(ranking.body.ranking[0].sessions).toBe(3);

        // Com financeiro.ver (colaborador ou ADMIN): receita e ordem por receita.
        for (const who of [await staff(['relatorios.ver', 'financeiro.ver']), await mkUser({ role: 'ADMIN' })]) {
            const s = await call('GET', `/api/reports/summary${RANGE}`, who);
            expect(s.body.summary.totalRevenue).toBe(120000);
            const t = await call('GET', `/api/reports/tiers${RANGE}`, who);
            expect(t.body.tierBreakdown.find((x: { tier: string }) => x.tier === 'COMERCIAL').revenue).toBe(120000);
            const rk = await call('GET', `/api/reports/ranking${RANGE}`, who);
            expect(rk.body.ranking.map((r: { id: string; revenue: number }) => [r.id, r.revenue])).toEqual([[caro.id, 90000], [frequente.id, 30000]]);
        }
    });

    it('GET /users MANTÉM totalPaid/totalPending para quem vê clientes sem financeiro.ver (DECISOES, resposta 3)', async () => {
        // Rota da frente B1 (users): montada só aqui, num app próprio, para não acoplar o arquivo inteiro a ela.
        const { default: userRoutes } = await import('../../src/modules/users/routes');
        const app = express();
        app.use(express.json());
        app.use(cookieParser());
        app.use('/api/users', userRoutes);
        const local = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
        try {
            const root = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
            const client = await mkUser();
            await mkPayment(client.id, { amount: 5000, status: 'PAID', paidAt: new Date() });
            await mkPayment(client.id, { amount: 3000, status: 'PENDING' });
            const recepcao = await staff(['clientes.ver']);
            const r = await callAt(root, 'GET', '/api/users', recepcao);
            expect(r.status).toBe(200);
            const row = r.body.users.find((u: { id: string }) => u.id === client.id);
            expect(row).toMatchObject({ totalPaid: 5000, totalPending: 3000 });
        } finally {
            await new Promise<void>((resolve) => local.close(() => resolve()));
        }
    });
});

// ─── F5: aviso só para clientes ─────────────────────────

describe('F5 — aviso manual com lista de ids só aceita CLIENTES não excluídos', () => {
    const send = (who: Who, target: unknown) => call('POST', '/api/notifications/admin/broadcast', who, {
        title: 'Confirme sua senha', message: 'Acesse o link para confirmar seus dados.', target, sendPush: false,
    });
    const broadcastRows = () => prisma.notification.count({ where: { entityType: 'BROADCAST' } });

    it('id de ADMIN ou de COLABORADOR na lista → 400 INVALID_RECIPIENTS e nada é enviado (vale também para o ADMIN)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const outroAdmin = await mkUser({ role: 'ADMIN' });
        const colega = await staff(['agendamentos.ver']);
        const client = await mkUser();
        const avisos = await staff(['avisos.enviar']);

        const r1 = await send(avisos, [outroAdmin.id]);
        expect(r1.status).toBe(400);
        expect(r1.body).toMatchObject({ code: 'INVALID_RECIPIENTS', invalidIds: [outroAdmin.id] });

        const r2 = await send(avisos, [client.id, colega.id]);
        expect(r2.status).toBe(400);
        expect(r2.body.invalidIds).toEqual([colega.id]);

        const r3 = await send(admin, [client.id, outroAdmin.id]);
        expect(r3.status).toBe(400);
        expect(r3.body.code).toBe('INVALID_RECIPIENTS');

        expect(await broadcastRows()).toBe(0);
    });

    it('cliente excluído ou id inexistente → 400', async () => {
        const avisos = await staff(['avisos.enviar']);
        const excluido = await mkUser({ deletedAt: new Date() });
        const client = await mkUser();
        const r1 = await send(avisos, [client.id, excluido.id]);
        expect(r1.status).toBe(400);
        expect(r1.body.invalidIds).toEqual([excluido.id]);
        const r2 = await send(avisos, ['11111111-1111-4111-8111-111111111111']);
        expect(r2.status).toBe(400);
        expect(await broadcastRows()).toBe(0);
    });

    it('lista só de clientes → envia; "todos" → só clientes não excluídos (nunca a equipe)', async () => {
        const avisos = await staff(['avisos.enviar']);
        const admin = await mkUser({ role: 'ADMIN' });
        const c1 = await mkUser();
        const c2 = await mkUser();
        await mkUser({ deletedAt: new Date() });

        const one = await send(avisos, [c1.id, c1.id]);
        expect(one.status).toBe(200);
        expect(one.body.sent).toBe(1);
        expect(await prisma.notification.count({ where: { entityType: 'BROADCAST', userId: c1.id } })).toBe(1);

        const all = await send(avisos, 'all');
        expect(all.status).toBe(200);
        expect(all.body.sent).toBe(2);
        const recipients = await prisma.notification.findMany({ where: { entityType: 'BROADCAST', entityId: all.body.batchId }, select: { userId: true } });
        expect(recipients.map(r => r.userId).sort()).toEqual([c1.id, c2.id].sort());
        expect(recipients.some(r => r.userId === admin.id || r.userId === avisos.id)).toBe(false);
    });
});
