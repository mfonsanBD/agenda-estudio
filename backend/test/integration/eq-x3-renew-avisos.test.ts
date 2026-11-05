import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Nenhum push de verdade (o "Enviar teste" de um modelo cria a notificação com push).
vi.mock('../../src/modules/push/pushService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/modules/push/pushService')>();
    return { ...orig, sendPushToUser: vi.fn(async () => 1) };
});

import { prisma } from '../../src/lib/prisma';
import { invalidateConfigCache } from '../../src/lib/businessConfig';
import { invalidateTemplateCache } from '../../src/modules/notifications/templateStore';
import { NOTIFICATION_EVENT_CATALOG } from '../../src/config/notificationEventCatalog';
import { mkUser, mkStaff, mkContract } from './factories';
import {
    ALL_KEYS, MATRIX_ALL_OF, RECEPCAO, allExcept, call, isPermissionDenied, matrixRowName, startServer,
    type Res, type Who,
} from './eq-authHelpers';

// FRENTE X3 — correções da revisão adversarial (contratos, avisos e bloqueios):
//  • MAT-01/DIN-02/EQ-REQ-01: renovar cria o plano ATIVO sem nenhuma parcela → exige contratos.criar E
//    cobrancas.baixa (requireAllPermissions); corpo validado (duração 3/6, tipo FIXO/FLEX, faixa do enum).
//    Aqui roda a tabela da verdade MATRIX_ALL_OF (duas chaves obrigatórias) de eq-authHelpers.
//  • MAT-02/NS-1: avisos.modelos só mexe nos modelos dos CLIENTES; os avisos da equipe (audiência "admin")
//    só o ADMIN altera, restaura e testa, e o colaborador nem recebe esses eventos em GET /events.
//  • MAT-05: /api/blocked-slots com authenticate + requireStaff no router.use (a invariante E4 confere a pilha).

let base = '';
let close: () => Promise<void> = async () => {};

beforeAll(async () => {
    ({ base, close } = await startServer());
});

afterAll(async () => {
    await close();
});

beforeEach(() => {
    invalidateConfigCache();
    invalidateTemplateCache();
});

const go = (method: string, path: string, who?: Who | string, body?: unknown) => call(base, method, path, who, body);
const staff = (permissions: readonly string[]) => mkStaff({ permissions: [...permissions] });
const newAdmin = () => mkUser({ role: 'ADMIN' });

function expectDenied(r: Res, label: string) {
    expect(isPermissionDenied(r), `${label}: esperado 403 PERMISSION_DENIED, veio ${r.status} ${JSON.stringify(r.body)}`).toBe(true);
}
function expectAllowed(r: Res, label: string) {
    const bad = r.status === 401 || r.status === 403 || r.status >= 500;
    expect(bad, `${label}: esperado passar pela permissão, veio ${r.status} ${JSON.stringify(r.body)}`).toBe(false);
}

// ═══ Tabela da verdade: rotas com DUAS chaves obrigatórias ═══

describe('MATRIX_ALL_OF — cada chave de needAll é obrigatória (requireAllPermissions)', () => {
    for (const row of MATRIX_ALL_OF) {
        const name = matrixRowName(row);
        it(name, async () => {
            let k = 0;
            const probe = async (who: Who | 'anon' | 'dono') => {
                const owner = await mkUser();
                const p = await row.build({ k: k++, owner });
                const actor = who === 'anon' ? undefined : who === 'dono' ? owner : who;
                return go(p.method, p.path, actor, p.body);
            };
            const label = (s: string) => `${name} · ${s}`;

            expect((await probe('anon')).status, label('sem login')).toBe(401);
            expectDenied(await probe('dono'), label('CLIENTE'));
            expectDenied(await probe(await staff([])), label('COLABORADOR sem chaves'));
            // Com TODAS as chaves do catálogo menos uma: o 403 cita exatamente a que falta.
            for (const key of row.needAll) {
                const r = await probe(await staff(allExcept(key)));
                expectDenied(r, label(`COLABORADOR com tudo menos ${key}`));
                expect(r.body.permission, label(`chave citada sem ${key}`)).toBe(key);
            }
            // Só com UMA das chaves: ainda não passa.
            for (const key of row.needAll) expectDenied(await probe(await staff([key])), label(`COLABORADOR só com ${key}`));
            expectAllowed(await probe(await staff(row.needAll)), label(`COLABORADOR com ${row.needAll.join(' + ')}`));
            expectAllowed(await probe(await staff(ALL_KEYS)), label('COLABORADOR com tudo'));
            expectAllowed(await probe(await newAdmin()), label('ADMIN'));
        });
    }
});

// ═══ Renovar contrato ═══

describe('POST /api/contracts/:id/renew — renovação sem parcelas exige a baixa manual (MAT-01/DIN-02/EQ-REQ-01)', () => {
    it('perfil Recepção (contratos.criar sem cobrancas.baixa) → 403 cobrancas.baixa, sem contrato nem sessões', async () => {
        const owner = await mkUser();
        const original = await mkContract(owner.id, {
            type: 'FIXO', fixedDayOfWeek: 1, fixedTime: '10:00',
            startDate: new Date('2026-09-14T00:00:00Z'), endDate: new Date('2026-12-14T00:00:00Z'),
        });
        const r = await go('POST', `/api/contracts/${original.id}/renew`, await staff(RECEPCAO), { durationMonths: 3 });
        expectDenied(r, 'Recepção');
        expect(r.body.permission).toBe('cobrancas.baixa');
        expect(await prisma.contract.count({ where: { renewedFromId: original.id } })).toBe(0);
        expect(await prisma.booking.count({ where: { userId: owner.id } })).toBe(0);
    });

    it('Recepção + cobrancas.baixa → 201 (contrato novo ATIVO, sem parcelas — o comportamento da renovação não muda)', async () => {
        const owner = await mkUser();
        const original = await mkContract(owner.id);
        const r = await go('POST', `/api/contracts/${original.id}/renew`, await staff([...RECEPCAO, 'cobrancas.baixa']), { durationMonths: 3 });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        const renewed = await prisma.contract.findUniqueOrThrow({ where: { id: r.body.contract.id } });
        expect(renewed).toMatchObject({ renewedFromId: original.id, status: 'ACTIVE', durationMonths: 3, type: 'FLEX' });
        expect(await prisma.payment.count({ where: { contractId: renewed.id } })).toBe(0);
    });

    it('ADMIN continua renovando como antes (201), inclusive por 6 meses', async () => {
        const admin = await newAdmin();
        const owner = await mkUser();
        const three = await mkContract(owner.id);
        const r3 = await go('POST', `/api/contracts/${three.id}/renew`, admin, {});
        expect(r3.status, JSON.stringify(r3.body)).toBe(201);
        expect(r3.body.contract.durationMonths).toBe(3);

        const six = await mkContract(owner.id);
        const r6 = await go('POST', `/api/contracts/${six.id}/renew`, admin, { durationMonths: 6 });
        expect(r6.status, JSON.stringify(r6.body)).toBe(201);
        expect(r6.body.contract).toMatchObject({ durationMonths: 6, flexCreditsTotal: 24, flexCreditsRemaining: 24 });
    });

    it('corpo inválido → 400 "Dados inválidos." antes de qualquer efeito (mesmo para o ADMIN)', async () => {
        const admin = await newAdmin();
        const owner = await mkUser();
        const original = await mkContract(owner.id, {
            type: 'FIXO', fixedDayOfWeek: 1, fixedTime: '10:00',
            startDate: new Date('2026-09-14T00:00:00Z'), endDate: new Date('2026-12-14T00:00:00Z'),
        });
        const bodies: Array<[string, unknown]> = [
            ['durationMonths 24 (geraria 24 × sessões)', { durationMonths: 24 }],
            ['durationMonths como texto', { durationMonths: '3' }],
            ['durationMonths 1', { durationMonths: 1 }],
            ['type AVULSO', { type: 'AVULSO' }],
            ['type SERVICO', { type: 'SERVICO' }],
            ['tier fora do enum', { tier: 'VIP' }],
            ['startDate numérica', { startDate: 20270101 }],
        ];
        for (const [label, body] of bodies) {
            const r = await go('POST', `/api/contracts/${original.id}/renew`, admin, body);
            expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBe(400);
            expect(r.body.error, label).toBe('Dados inválidos.');
        }
        // A checagem própria de data continua (mensagem dela).
        const badDate = await go('POST', `/api/contracts/${original.id}/renew`, admin, { startDate: '12/01/2027' });
        expect(badDate.status).toBe(400);
        expect(badDate.body.error).toMatch(/Data de início inválida/);

        expect(await prisma.contract.count({ where: { renewedFromId: original.id } })).toBe(0);
        expect(await prisma.booking.count({ where: { userId: owner.id } })).toBe(0);
    });

    it('colaborador sem as chaves recebe o 403 ANTES da validação do corpo (não vaza o formato)', async () => {
        const owner = await mkUser();
        const original = await mkContract(owner.id);
        const r = await go('POST', `/api/contracts/${original.id}/renew`, await staff(['contratos.ver', 'contratos.criar']), { durationMonths: 24 });
        expectDenied(r, 'só contratos.criar');
        expect(r.body.permission).toBe('cobrancas.baixa');
    });
});

// ═══ Modelos de aviso: os da equipe são só do ADMIN ═══

const TEAM_EVENTS = NOTIFICATION_EVENT_CATALOG.filter(e => e.audience === 'admin').map(e => e.eventKey);
const CLIENT_EVENTS = NOTIFICATION_EVENT_CATALOG.filter(e => e.audience === 'client').map(e => e.eventKey);

describe('avisos.modelos só mexe nos modelos dos CLIENTES (MAT-02/NS-1)', () => {
    it('o catálogo tem avisos da equipe e dos clientes (premissa do teste)', () => {
        expect(TEAM_EVENTS.length).toBeGreaterThanOrEqual(10);
        expect(TEAM_EVENTS).toContain('admin_card_double_charge');
        expect(CLIENT_EVENTS).toContain('payment_confirmed');
    });

    it('colaborador com avisos.modelos: aviso da equipe → 403 ADMIN em editar, desligar, restaurar e testar; nada muda', async () => {
        const admin = await newAdmin();
        const colab = await staff(['avisos.modelos']);
        // O ADMIN personalizou o modelo antes: o "restaurar" do colaborador não pode apagar.
        const own = await go('PUT', '/api/notifications/admin/templates/admin_payment_on_cancelled_charge', admin, { title: 'Pagamento em cobrança cancelada!' });
        expect(own.status, JSON.stringify(own.body)).toBe(200);

        const off = await go('PUT', '/api/notifications/admin/templates/admin_card_double_charge', colab, { enabled: false });
        expectDenied(off, 'desligar cobrança em dobro');
        expect(off.body.permission).toBe('ADMIN');
        const phishing = await go('PUT', '/api/notifications/admin/templates/admin_booking_confirmed', colab, {
            title: 'Ação necessária', message: 'Sua sessão expirou, confirme a senha em https://exemplo.test',
        });
        expectDenied(phishing, 'reescrever aviso que vai ao ADMIN');
        expect(await prisma.notificationTemplate.count({ where: { eventKey: { in: ['admin_card_double_charge', 'admin_booking_confirmed'] } } })).toBe(0);

        const reset = await go('DELETE', '/api/notifications/admin/templates/admin_payment_on_cancelled_charge', colab);
        expectDenied(reset, 'restaurar aviso da equipe');
        expect(reset.body.permission).toBe('ADMIN');
        expect(await prisma.notificationTemplate.count({ where: { eventKey: 'admin_payment_on_cancelled_charge' } })).toBe(1);

        const test = await go('POST', '/api/notifications/admin/templates/admin_card_double_charge/test', colab, { nonce: 1 });
        expectDenied(test, 'testar aviso da equipe');
        expect(await prisma.notification.count({ where: { userId: colab.id } })).toBe(0);

        // Todos os avisos da equipe, não só os de dinheiro.
        for (const eventKey of TEAM_EVENTS) {
            const r = await go('PUT', `/api/notifications/admin/templates/${eventKey}`, colab, { pushEnabled: false });
            expectDenied(r, eventKey);
        }
        expect(await prisma.notificationTemplate.count({ where: { eventKey: { in: TEAM_EVENTS } } })).toBe(1); // só o do ADMIN
    });

    it('colaborador com avisos.modelos continua editando, restaurando e testando os modelos dos clientes', async () => {
        const colab = await staff(['avisos.modelos']);
        const put = await go('PUT', '/api/notifications/admin/templates/payment_confirmed', colab, { title: 'Pagamento confirmado!' });
        expect(put.status, JSON.stringify(put.body)).toBe(200);
        const test = await go('POST', '/api/notifications/admin/templates/payment_confirmed/test', colab, { nonce: 7 });
        expect(test.status, JSON.stringify(test.body)).toBe(200);
        const del = await go('DELETE', '/api/notifications/admin/templates/payment_confirmed', colab);
        expect(del.status, JSON.stringify(del.body)).toBe(200);
        expect(await prisma.notificationTemplate.count({ where: { eventKey: 'payment_confirmed' } })).toBe(0);
        // Evento que não existe continua 404 (não 403).
        expect((await go('PUT', '/api/notifications/admin/templates/nao_existe', colab, { enabled: false })).status).toBe(404);
    });

    it('ADMIN edita, desliga, restaura e testa os avisos da equipe', async () => {
        const admin = await newAdmin();
        const off = await go('PUT', '/api/notifications/admin/templates/admin_card_double_charge', admin, { enabled: false });
        expect(off.status, JSON.stringify(off.body)).toBe(200);
        expect(await prisma.notificationTemplate.findUnique({ where: { eventKey: 'admin_card_double_charge' } })).toMatchObject({ enabled: false });
        const test = await go('POST', '/api/notifications/admin/templates/admin_booking_confirmed/test', admin, { nonce: 3 });
        expect(test.status, JSON.stringify(test.body)).toBe(200);
        const reset = await go('DELETE', '/api/notifications/admin/templates/admin_card_double_charge', admin);
        expect(reset.status, JSON.stringify(reset.body)).toBe(200);
        expect(await prisma.notificationTemplate.count({ where: { eventKey: 'admin_card_double_charge' } })).toBe(0);
    });

    it('GET /events: o colaborador (avisos.modelos ou avisos.enviar) recebe só os eventos dos clientes; o ADMIN recebe todos', async () => {
        for (const perm of ['avisos.modelos', 'avisos.enviar'] as const) {
            const r = await go('GET', '/api/notifications/admin/events', await staff([perm]));
            expect(r.status, JSON.stringify(r.body)).toBe(200);
            const events = r.body.events as Array<{ eventKey: string; audience: string }>;
            expect(events.filter(e => e.audience === 'admin').map(e => e.eventKey), perm).toEqual([]);
            expect(events.map(e => e.eventKey).sort(), perm).toEqual([...CLIENT_EVENTS].sort());
        }
        const all = await go('GET', '/api/notifications/admin/events', await newAdmin());
        expect(all.status).toBe(200);
        expect((all.body.events as Array<{ eventKey: string }>).map(e => e.eventKey).sort()).toEqual([...TEAM_EVENTS, ...CLIENT_EVENTS].sort());
    });
});

// ═══ Bloqueios de horário: router 100% da equipe ═══

describe('/api/blocked-slots — authenticate + requireStaff no router.use (MAT-05)', () => {
    it('cliente é barrado pela guarda do router (STAFF); a equipe segue pela permissão fina', async () => {
        const client = await mkUser();
        const asClient = await go('GET', '/api/blocked-slots', client);
        expectDenied(asClient, 'CLIENTE');
        expect(asClient.body.permission).toBe('STAFF');
        expect((await go('GET', '/api/blocked-slots')).status).toBe(401);

        const semVer = await go('GET', '/api/blocked-slots', await staff(['hoje.ver']));
        expectDenied(semVer, 'colaborador sem agendamentos.ver');
        expect(semVer.body.permission).toBe('agendamentos.ver');
        expect((await go('GET', '/api/blocked-slots', await staff(['agendamentos.ver']))).status).toBe(200);
    });
});
