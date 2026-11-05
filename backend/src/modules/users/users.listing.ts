import { Router, Request, Response, RequestHandler } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { actorOrReply, canAny, requirePermission } from '../../middleware/permissions.js';
import type { PermissionKey } from '../../config/staffPermissions.js';
import { paidChargedAmount } from '../../lib/pixGateway.js';

// /api/users trata SÓ de CLIENTE (D1). A equipe (ADMIN/COLABORADOR) fica em /api/staff, só para o ADMIN.

/** Express 4 não captura rejeições de handlers async: responde 500 em vez de deixar a promessa solta. */
export function safeHandler(logTag: string, fallback: string, handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
    return async (req: Request, res: Response) => {
        try {
            await handler(req, res);
        } catch (err) {
            console.error(logTag, err);
            if (!res.headersSent) res.status(500).json({ error: fallback });
        }
    };
}

/**
 * Quem abre o diretório de clientes: a tela Clientes e os SELETORES de cliente das outras telas
 * (Agendamentos, Contratos, Cupons e o aviso aos clientes — os dois primeiros carregam a lista num
 * Promise.all com a tela, então negar aqui derrubaria a tela inteira).
 */
export const CLIENT_DIRECTORY_PERMISSIONS: readonly PermissionKey[] = [
    'clientes.ver', 'agendamentos.ver', 'contratos.ver', 'cupons.ver', 'avisos.enviar',
];

/**
 * Quem recebe a FICHA na listagem (CPF/CNPJ para cobrar, telefone, etiquetas, contagens e totais). Os
 * demais recebem só o diretório mínimo `{ id, name, email, role }` (crítica I5).
 */
export const CLIENT_DIRECTORY_FULL_PERMISSIONS: readonly PermissionKey[] = [
    'clientes.ver', 'agendamentos.criar', 'contratos.criar', 'cobrancas.cobrar',
];

export function registerUserListingRoutes(router: Router) {
    // ─── GET /api/users (equipe: diretório de clientes) ─────

    router.get('/', authenticate, requirePermission(...CLIENT_DIRECTORY_PERMISSIONS), safeHandler('[USERS] list', 'Erro ao carregar os clientes.', async (req: Request, res: Response) => {
        const { role } = req.query;
        // Lista só de clientes: `?role` só aceita CLIENTE (a equipe não aparece aqui).
        if (role !== undefined && role !== 'CLIENTE') {
            res.status(400).json({ error: 'Esta lista é só de clientes. A equipe fica na tela Equipe.', code: 'ROLE_NOT_ALLOWED' });
            return;
        }
        const actor = await actorOrReply(req, res);
        if (!actor) return;

        // Filtro POSITIVO (D1): só CLIENTE — nem ADMIN nem COLABORADOR aparecem em Clientes nem nos seletores.
        // D3: cliente excluído (soft delete) some da lista, da busca, dos KPIs e de todos os seletores
        // de cliente dos modais — o perfil histórico continua acessível por GET /:id.
        const where = { role: 'CLIENTE' as const, deletedAt: null };

        if (!canAny(actor, ...CLIENT_DIRECTORY_FULL_PERMISSIONS)) {
            const users = await prisma.user.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                select: { id: true, name: true, email: true, role: true },
            });
            res.json({ users });
            return;
        }

        const rawUsers = await prisma.user.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                email: true,
                name: true,
                phone: true,
                role: true,
                // Necessário para a equipe cobrar o CLIENTE (gate/coleta de CPF do PIX/Boleto usa o
                // documento do cliente selecionado, não o de quem opera). Só na ficha (FULL_PERMISSIONS).
                cpfCnpj: true,
                clientStatus: true,
                tags: true,
                createdAt: true,
                _count: {
                    select: { bookings: true, contracts: true },
                },
                contracts: {
                    // endDate/durationMonths: o front decide se um plano "Concluído" (D6) ainda está
                    // vigente (carência após o fim — clientHealth.isPlanInForce) e reconhece o FLEX
                    // legado de 1 mês como avulso. Sem eles, todo plano concluído contava como ativo.
                    select: { type: true, status: true, addOns: true, endDate: true, durationMonths: true },
                },
                payments: {
                    // chargedAmount/provider/providerRef: "total pago" pelo valor EFETIVAMENTE cobrado (no cartão,
                    // o valor do PaymentIntent) — mesmo critério do fechamento financeiro (paidChargedAmount).
                    select: { amount: true, status: true, chargedAmount: true, provider: true, providerRef: true },
                },
            },
        });

        const users = rawUsers.map(u => {
            const totalPaid = u.payments
                .filter(p => p.status === 'PAID')
                .reduce((sum, p) => sum + paidChargedAmount(p), 0);
            // Pendente = o valor da cobrança (amount), como no fechamento.
            const totalPending = u.payments
                .filter(p => p.status === 'PENDING')
                .reduce((sum, p) => sum + p.amount, 0);
            const { payments, ...rest } = u;
            return { ...rest, totalPaid, totalPending };
        });

        res.json({ users });
    }));

    // ─── GET /api/users/:id (perfil do cliente) ─────────────

    router.get('/:id', authenticate, requirePermission('clientes.ver'), safeHandler('[USERS] detail', 'Erro ao carregar o cliente.', async (req: Request, res: Response) => {
        const id = req.params.id as string;

        const user = await prisma.user.findUnique({
            where: { id },
            select: {
                id: true,
                email: true,
                name: true,
                phone: true,
                role: true,
                notes: true,
                photoUrl: true,
                cpfCnpj: true,
                address: true,
                addressNumber: true,
                complement: true,
                neighborhood: true,
                city: true,
                state: true,
                zipCode: true,
                tags: true,
                socialLinks: true,
                clientStatus: true,
                deletedAt: true, // D3: perfil histórico de cliente excluído (front mostra o aviso)
                createdAt: true,
                contracts: {
                    orderBy: { createdAt: 'desc' },
                    take: 100, // bound nested load (admin detail view)
                    select: {
                        id: true,
                        type: true,
                        tier: true,
                        status: true,
                        startDate: true,
                        endDate: true,
                        durationMonths: true,
                        discountPct: true,
                        contractUrl: true,
                        flexCreditsTotal: true,
                        flexCreditsRemaining: true,
                        totalSessions: true, // L6: para o card derivar as gravações reais de CUSTOM (não por duração)
                    },
                },
                bookings: {
                    orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
                    take: 200, // bound nested load (most-recent first)
                    select: {
                        id: true,
                        date: true,
                        startTime: true,
                        endTime: true,
                        status: true,
                        tierApplied: true,
                        price: true,
                        contractId: true,
                        adminNotes: true,
                        clientNotes: true,
                        durationMinutes: true,
                        peakViewers: true,
                        chatMessages: true,
                        audienceOrigin: true,
                    },
                },
                payments: {
                    orderBy: { createdAt: 'desc' },
                    take: 200, // bound nested load (most-recent first)
                    select: {
                        id: true,
                        amount: true,
                        status: true,
                        dueDate: true,
                        createdAt: true,
                        // Saúde do cliente (front): "pago" pelo valor efetivamente cobrado (paidChargedAmount).
                        chargedAmount: true,
                        provider: true,
                        providerRef: true,
                    },
                },
            },
        });

        // Alvo precisa ser CLIENTE (a equipe não é revelada por aqui). Excluído continua acessível (histórico).
        if (!user || user.role !== 'CLIENTE') {
            res.status(404).json({ error: 'Cliente não encontrado.' });
            return;
        }

        res.json({ user });
    }));
}
