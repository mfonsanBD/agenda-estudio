import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import multer from 'multer';
import sharp from 'sharp';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config/index.js';
import { authenticate, isTokenRevoked, isUserDeletionInProgress, revokeUserSessions, SESSION_REVOKED_BODY } from '../../middleware/auth.js';
import { ACCOUNT_DISABLED_BODY, PERMISSIONS_UNAVAILABLE_BODY } from '../../middleware/permissions.js';
import { isStaffRole, permissionsForRole } from '../../config/staffPermissions.js';
import { OAuth2Client } from 'google-auth-library';
import { otpService } from '../../lib/otp.js';
import { Prisma } from '../../generated/prisma/client.js';
import { isValidCpfCnpj } from '../../utils/document.js';
import { getErrorMessage } from '../../utils/errors.js';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID);


const router = Router();

// ─── Multer for photo uploads (memory storage) ──────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB raw
    fileFilter: (_req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Apenas imagens são permitidas.'));
    },
});

// ─── Validation Schemas ─────────────────────────────────

const registerSchema = z.object({
    email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail inválido'),
    password: z.string().min(6, 'Deve conter no mínimo 6 caracteres'),
    name: z.string().min(2, 'Deve conter no mínimo 2 caracteres'),
    code: z.string().min(6, 'Código inválido').max(6),
});


const loginSchema = z.object({
    email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail inválido'),
    password: z.string().min(1, 'Senha obrigatória'),
});

const googleLoginSchema = z.object({
    idToken: z.string().min(1)
});

// Passwordless e-mail login (OTP): request a code, then verify it.
const loginSendCodeSchema = z.object({
    email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail inválido'),
});

const loginVerifyCodeSchema = z.object({
    email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail inválido'),
    code: z.string().min(6, 'Código inválido').max(6),
});


// ─── Helper: bloqueio de conta ──────────────────────────
// Impede emissão de tokens para contas BLOCKED (bloquear no admin passa a ter efeito real) e para
// contas EXCLUÍDAS (D3: soft delete — deletedAt preenchido).
// Aplicado em todos os pontos que emitem sessão (login senha/OTP/Google + refresh). Os tokens já
// emitidos são revogados na hora pela exclusão/bloqueio (revokeUserSessions → authenticate 401 e
// refresh 401 para refresh token anterior à revogação).
// Equipe desativada (tela Equipe → Desativar = BLOCKED) recebe a mensagem própria; o `code`
// ACCOUNT_DISABLED deixa o front encerrar a sessão em vez de tentar de novo.
function blockedBody(role: string | null | undefined): { error: string; code: string } {
    return isStaffRole(role)
        ? { ...ACCOUNT_DISABLED_BODY }
        : { error: 'Sua conta está bloqueada. Entre em contato com o estúdio.', code: ACCOUNT_DISABLED_BODY.code };
}

function assertNotBlocked(res: Response, user: { clientStatus?: string | null; deletedAt?: Date | null; role?: string | null } | null): boolean {
    if (user && user.deletedAt) {
        res.status(401).json({ error: 'Conta não encontrada.' });
        return true;
    }
    if (user && user.clientStatus === 'BLOCKED') {
        res.status(403).json(blockedBody(user.role));
        return true;
    }
    return false;
}

/** Conta com este e-mail, sem diferenciar maiúsculas (crítica E6: há cadastros antigos com maiúscula). */
function findUserByEmailInsensitive(email: string) {
    return prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
}

/**
 * D3: exclusão do cliente EM ANDAMENTO (deletedAt só é gravado no fim) → o login não emite sessão.
 * Um token emitido nesse intervalo deixaria criar reserva/cobrança depois do passo que as cancela
 * (a revogação final da exclusão o derruba só depois do commit). O refresh já recusa pela revogação.
 */
async function refuseDuringDeletion(res: Response, userId: string): Promise<boolean> {
    if (!(await isUserDeletionInProgress(userId))) return false;
    res.status(409).json({ error: 'Não foi possível entrar agora: sua conta está sendo atualizada pelo estúdio. Tente de novo em instantes.' });
    return true;
}

// ─── Helper: erro inesperado ────────────────────────────
// Banco fora do ar ou qualquer erro que a rota não trata: registra no log e responde 500 com texto genérico
// (o erro cru não vai para o cliente). Nunca relançar no catch: num handler async do Express 4 o `throw`
// vira rejeição não tratada (o errorHandler global não a recebe) e a requisição fica sem resposta.
const UNEXPECTED_ERROR_BODY = Object.freeze({ error: 'Não foi possível concluir agora. Tente novamente em instantes.' });

function replyUnexpected(res: Response, logTag: string, err: unknown): void {
    console.error(logTag, err);
    if (!res.headersSent) res.status(500).json(UNEXPECTED_ERROR_BODY);
}

// ─── Helper: Generate Tokens ────────────────────────────

/**
 * `iat` (opcional): emissão explícita. Usado só ao trocar a própria senha: as sessões até "agora" são
 * revogadas (revokeUserSessions recusa iat ≤ instante da revogação) e a sessão atual recebe tokens com
 * iat no segundo seguinte, para continuar valendo.
 */
function generateTokens(payload: { userId: string; email: string; role: string }, iat?: number) {
    const claims = iat === undefined ? payload : { ...payload, iat };
    const accessToken = jwt.sign(claims, config.jwt.secret as string, {
        expiresIn: config.jwt.accessExpiry as any, // string literal e.g. '15m'
    });
    const refreshToken = jwt.sign(claims, config.jwt.refreshSecret as string, {
        expiresIn: config.jwt.refreshExpiry as any, // string literal e.g. '7d'
    });
    return { accessToken, refreshToken };
}

function setTokenCookies(res: Response, accessToken: string, refreshToken: string) {
    // sameSite is intentionally 'lax' (not 'strict'): 'strict' would drop the auth cookies on the
    // top-level redirect back from Google OAuth and on any external deep-link into the PWA (push/
    // email notification links), breaking those flows. 'lax' still blocks CSRF on unsafe methods.
    res.cookie('accessToken', accessToken, {
        httpOnly: true,
        secure: config.nodeEnv === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 1000, // 1 hour
    });
    res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: config.nodeEnv === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days (VULN-06 fix: was 365 days)
        path: '/api/auth/refresh',
    });
}

// ─── Helper: client-facing user shape ────────────────────
// MUST match GET /me and PATCH /profile. Every auth response returns this full
// shape because the frontend does updateUser(res.user) — a partial object here
// would WIPE fields (e.g. cpfCnpj) from the AuthContext, making the contract
// wizards re-ask for data the user already saved. Com a Equipe, o formato também leva
// `permissions` e `staffTitle`: um formato parcial apagaria as permissões do contexto (o menu sumiria
// depois de trocar a foto). Por isso TODA resposta de auth monta o usuário por loadAuthUser. Única exceção:
// perfil/foto de COLABORADOR com staff_profiles indisponível omitem SÓ `permissions`/`staffTitle`
// (loadAuthUserForProfile) — o mergeUser do front mantém os que já tinha (nunca `permissions: []`).
interface AuthUserRecord {
    id: string; email: string | null; name: string; phone: string | null;
    photoUrl: string | null; role: string; cpfCnpj: string | null;
    address: string | null; addressNumber: string | null; complement: string | null;
    neighborhood: string | null; zipCode: string | null; city: string | null; state: string | null;
    socialLinks: string | null; essentialNotificationsOnly: boolean;
}

const AUTH_USER_SELECT = {
    id: true, email: true, name: true, phone: true, photoUrl: true, role: true, cpfCnpj: true,
    address: true, addressNumber: true, complement: true, neighborhood: true, zipCode: true, city: true, state: true,
    socialLinks: true, essentialNotificationsOnly: true,
} as const satisfies Prisma.UserSelect;

function toAuthUser(u: AuthUserRecord) {
    // A15: incluir os 4 campos do endereço estruturado (número/complemento/bairro/CEP). Sem eles,
    // como o contexto do frontend faz updateUser(res.user), o endereço "some" após login/troca de foto.
    return {
        id: u.id, email: u.email, name: u.name, phone: u.phone, photoUrl: u.photoUrl, role: u.role,
        cpfCnpj: u.cpfCnpj, address: u.address, addressNumber: u.addressNumber, complement: u.complement,
        neighborhood: u.neighborhood, zipCode: u.zipCode, city: u.city, state: u.state,
        socialLinks: u.socialLinks, essentialNotificationsOnly: u.essentialNotificationsOnly,
    };
}

type BaseAuthUser = ReturnType<typeof toAuthUser>;
export type AuthUser = BaseAuthUser & { permissions: string[]; staffTitle: string | null };

/**
 * A leitura de staff_profiles falhou para um COLABORADOR. As permissões dele só existem nessa tabela: sem
 * elas não há como montar a sessão, e um 200 com `permissions: []` faria o front esvaziar o menu como se o
 * acesso tivesse sido retirado. Quem emite/renova sessão responde 503 (loadAuthUserOrReply); perfil e foto,
 * que já gravaram, devolvem o usuário sem as permissões (loadAuthUserForProfile).
 */
class StaffProfileUnavailableError extends Error {
    constructor(userId: string, cause: unknown) {
        super(`staff_profiles indisponível para ${userId}: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.name = 'StaffProfileUnavailableError';
    }
}

/**
 * Formato único do usuário nas respostas de auth (login, OTP, Google, cadastro, refresh, /me, perfil, foto):
 *   • `permissions`: ADMIN = todas as chaves do catálogo + as exclusivas; COLABORADOR = as dele; CLIENTE = [];
 *   • `staffTitle`: cargo (tela Equipe) ou null.
 * Cliente NUNCA consulta staff_profiles. ADMIN lê só o cargo, em try/catch (crítica M1): se a tabela faltar
 * (migration que não entrou), o ADMIN entra com acesso total e `staffTitle: null`. COLABORADOR: falha na
 * leitura → lança StaffProfileUnavailableError (nunca segue com `permissions: []`).
 * Recebe a linha já lida (todo fluxo de auth já leu o usuário para checar bloqueio/exclusão).
 */
async function loadAuthUser(u: AuthUserRecord): Promise<AuthUser> {
    const base = toAuthUser(u);
    if (!isStaffRole(u.role)) return { ...base, permissions: [], staffTitle: null };
    let stored: readonly unknown[] = [];
    let staffTitle: string | null = null;
    try {
        const profile = await prisma.staffProfile.findUnique({ where: { userId: u.id }, select: { title: true, permissions: true } });
        stored = profile?.permissions ?? [];
        staffTitle = profile?.title ?? null;
    } catch (err) {
        if (u.role === 'COLABORADOR') throw new StaffProfileUnavailableError(u.id, err);
        console.error('[AUTH] Falha ao ler o perfil do ADMIN (seguindo sem o cargo):', err instanceof Error ? err.message : err);
    }
    return { ...base, permissions: permissionsForRole(u.role, stored), staffTitle };
}

/**
 * loadAuthUser para quem EMITE ou RENOVA sessão (login senha/OTP/Google, refresh) e para o /me: se as
 * permissões do COLABORADOR não puderam ser lidas, responde 503 com `unavailableBody` e devolve null — quem
 * chama sai SEM Set-Cookie (chame antes do setTokenCookies). Outros erros seguem para o catch da rota.
 */
async function loadAuthUserOrReply(
    res: Response,
    u: AuthUserRecord,
    unavailableBody: Readonly<Record<string, unknown>>,
): Promise<AuthUser | null> {
    try {
        return await loadAuthUser(u);
    } catch (err) {
        if (!(err instanceof StaffProfileUnavailableError)) throw err;
        console.error('[AUTH] Permissões do colaborador indisponíveis (503):', err.message);
        if (!res.headersSent) res.status(503).json(unavailableBody);
        return null;
    }
}

/**
 * loadAuthUser para PATCH /profile e POST /profile/photo, que respondem DEPOIS de gravar: se as permissões
 * do COLABORADOR não puderam ser lidas, devolve o usuário SEM `permissions`/`staffTitle` — o front
 * (AuthContext.mergeUser) mantém as que já tinha. Um 503 diria "falhou" sobre um perfil já salvo, e
 * `permissions: []` esvaziaria o menu.
 */
async function loadAuthUserForProfile(u: AuthUserRecord): Promise<AuthUser | BaseAuthUser> {
    try {
        return await loadAuthUser(u);
    } catch (err) {
        if (!(err instanceof StaffProfileUnavailableError)) throw err;
        console.error('[AUTH] Permissões do colaborador indisponíveis (perfil salvo; resposta sem permissões):', err.message);
        return toAuthUser(u);
    }
}

/**
 * 503 do login (senha/Google) de COLABORADOR quando as permissões não puderam ser lidas: nenhum cookie sai
 * e a mesma senha/conta Google funciona assim que o banco responder.
 */
const LOGIN_PERMISSIONS_UNAVAILABLE_BODY = Object.freeze({
    code: PERMISSIONS_UNAVAILABLE_BODY.code,
    error: 'Não foi possível entrar agora: as permissões do seu acesso não puderam ser carregadas. Tente novamente em instantes.',
});
/** Idem no login por código: a conferência já consumiu o código, então é preciso pedir outro. */
const LOGIN_CODE_PERMISSIONS_UNAVAILABLE_BODY = Object.freeze({
    code: PERMISSIONS_UNAVAILABLE_BODY.code,
    error: 'Não foi possível entrar agora: as permissões do seu acesso não puderam ser carregadas. Peça um novo código e tente novamente em instantes.',
});

// ─── POST /api/auth/register/send-code ──────────────────

const registerSendCodeSchema = z.object({
    email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail inválido'),
    password: z.string().min(6, 'Deve conter no mínimo 6 caracteres'),
    name: z.string().min(2, 'Deve conter no mínimo 2 caracteres'),
});

router.post('/register/send-code', async (req: Request, res: Response) => {
    try {
        const data = registerSendCodeSchema.parse(req.body);
        data.email = data.email.trim().toLowerCase();

        const existingEmail = await findUserByEmailInsensitive(data.email);
        if (existingEmail) {
            res.status(409).json({ error: 'E-mail já cadastrado.', details: { email: 'already in use' } });
            return;
        }

        // Anti-spam: enforce a short per-target resend cooldown
        if (await otpService.isOnSendCooldown(data.email)) {
            res.status(429).json({ error: 'Aguarde alguns segundos antes de solicitar um novo código.' });
            return;
        }

        try {
            await otpService.generateAndSend(data.email, data.name);
        } catch (e) {
            if ((e as { code?: string })?.code === 'OTP_COOLDOWN') {
                res.status(429).json({ error: 'Aguarde alguns segundos antes de solicitar um novo código.' });
                return;
            }
            throw e;
        }

        res.json({ message: `Código enviado para ${data.email}` });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        // Don't leak raw provider errors (SMTP host/port, Resend status) to anonymous callers.
        console.error('[AUTH] register/send-code error:', err);
        res.status(500).json({ error: 'Não foi possível enviar o código agora. Tente novamente em instantes.' });
    }
});


// ─── POST /api/auth/register ────────────────────────────

router.post('/register', async (req: Request, res: Response) => {
    try {
        const data = registerSchema.parse(req.body);
        data.email = data.email.trim().toLowerCase();

        const existingEmail = await findUserByEmailInsensitive(data.email);
        if (existingEmail) {
            res.status(409).json({ error: 'E-mail já cadastrado.', details: { email: 'already in use' } });
            return;
        }

        // Verify OTP (VULN-05 fix: require explicit flag instead of trusting NODE_ENV)
        // PAY-08 FIX: Double-check NODE_ENV — bypass NEVER works in production
        const canBypass = process.env.ALLOW_OTP_BYPASS === 'true' && process.env.NODE_ENV !== 'production';
        let isValid = canBypass && data.code === '999999';
        if (!isValid) {
            isValid = await otpService.verify(data.email, data.code);
        }
        if (isValid && canBypass && data.code === '999999') {
            console.warn(`[AUTH] OTP bypass used for ${data.email} (dev mode)`);
        }

        if (!isValid) {
            res.status(401).json({ error: 'Código inválido ou expirado.' });
            return;
        }

        const passwordHash = await bcrypt.hash(data.password, 12);

        // Cadastro público é SEMPRE de cliente (o zod descarta qualquer `role` do corpo).
        const user = await prisma.user.create({
            data: {
                email: data.email,
                passwordHash,
                name: data.name,
                role: 'CLIENTE',
            },
        });

        const tokens = generateTokens({
            userId: user.id,
            email: user.email || '',
            role: user.role,
        });

        setTokenCookies(res, tokens.accessToken, tokens.refreshToken);

        res.status(201).json({ user: await loadAuthUser(user) });
    } catch (err) {
        console.error('Registration error details:', err);
        if (err instanceof z.ZodError) {

            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Falha ao registrar usuário.' });
    }
});


// ─── POST /api/auth/login ───────────────────────────────

router.post('/login', async (req: Request, res: Response) => {
    try {
        const data = loginSchema.parse(req.body);
        data.email = data.email.trim().toLowerCase();

        const user = await prisma.user.findUnique({ where: { email: data.email } });
        if (!user) {
            res.status(401).json({ error: 'Credenciais inválidas.' });
            return;
        }

        if (!user.passwordHash) {
            res.status(401).json({ error: 'Conta não possui senha cadastrada. Faça login via Google ou código por e-mail.' });
            return;
        }

        const validPassword = await bcrypt.compare(data.password, user.passwordHash);
        if (!validPassword) {
            res.status(401).json({ error: 'Credenciais inválidas.' });
            return;
        }

        if (assertNotBlocked(res, user)) return;
        if (await refuseDuringDeletion(res, user.id)) return;

        const tokens = generateTokens({
            userId: user.id,
            email: user.email || '',
            role: user.role,
        });
        // Usuário montado ANTES dos cookies: COLABORADOR sem as permissões lidas → 503 sem Set-Cookie.
        const authUser = await loadAuthUserOrReply(res, user, LOGIN_PERMISSIONS_UNAVAILABLE_BODY);
        if (!authUser) return;

        setTokenCookies(res, tokens.accessToken, tokens.refreshToken);

        res.json({ user: authUser });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        // Banco fora do ar/erro inesperado (ex.: na leitura do usuário): responde aqui. Um `throw` num handler
        // async do Express 4 vira rejeição não tratada e a requisição fica sem resposta. Sem Set-Cookie: os
        // cookies só saem depois de tudo lido.
        replyUnexpected(res, '[AUTH] login error:', err);
    }
});

// ─── POST /api/auth/login/send-code ─────────────────────
// Passwordless login: e-mail a 6-digit code. Existing accounts only.

router.post('/login/send-code', async (req: Request, res: Response) => {
    try {
        const { email: rawEmail } = loginSendCodeSchema.parse(req.body);
        const email = rawEmail.trim().toLowerCase();

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
            res.status(404).json({ error: 'Conta não encontrada.' });
            return;
        }

        // Anti-spam: enforce a short per-target resend cooldown
        if (await otpService.isOnSendCooldown(email)) {
            res.status(429).json({ error: 'Aguarde alguns segundos antes de solicitar um novo código.' });
            return;
        }

        try {
            await otpService.generateAndSend(email, user.name);
        } catch (e) {
            if ((e as { code?: string })?.code === 'OTP_COOLDOWN') {
                res.status(429).json({ error: 'Aguarde alguns segundos antes de solicitar um novo código.' });
                return;
            }
            throw e;
        }

        res.json({ message: 'Código enviado para seu e-mail.' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        // Don't leak raw provider errors to anonymous callers.
        console.error('[AUTH] login/send-code error:', err);
        res.status(500).json({ error: 'Não foi possível enviar o código agora. Tente novamente em instantes.' });
    }
});

// ─── POST /api/auth/login/verify-code ───────────────────

router.post('/login/verify-code', async (req: Request, res: Response) => {
    try {
        const { email: rawEmail, code } = loginVerifyCodeSchema.parse(req.body);
        const email = rawEmail.trim().toLowerCase();

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
            res.status(404).json({ error: 'Conta não encontrada.' });
            return;
        }

        const canBypass = process.env.ALLOW_OTP_BYPASS === 'true' && process.env.NODE_ENV !== 'production';
        let isValid = canBypass && code === '999999';
        if (!isValid) {
            isValid = await otpService.verify(email, code);
        }
        if (isValid && canBypass && code === '999999') {
            console.warn(`[AUTH] OTP login bypass used for ${email} (dev mode)`);
        }

        if (!isValid) {
            res.status(401).json({ error: 'Código inválido ou expirado.' });
            return;
        }

        if (assertNotBlocked(res, user)) return;
        if (await refuseDuringDeletion(res, user.id)) return;

        const tokens = generateTokens({ userId: user.id, email: user.email || '', role: user.role });
        // COLABORADOR sem as permissões lidas → 503 sem Set-Cookie (o código já foi consumido: pedir outro).
        const authUser = await loadAuthUserOrReply(res, user, LOGIN_CODE_PERMISSIONS_UNAVAILABLE_BODY);
        if (!authUser) return;
        setTokenCookies(res, tokens.accessToken, tokens.refreshToken);

        res.json({ user: authUser });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        console.error('[AUTH] login/verify-code error:', err);
        res.status(500).json({ error: 'Falha ao validar o código.' });
    }
});

// ─── POST /api/auth/google ──────────────────────────────

router.post('/google', async (req: Request, res: Response) => {
    // Duas fases. 1) Verificação do token no Google (assinatura/audience e o fallback do access_token): qualquer
    // falha aqui é "não autenticou" → 401 (como sempre foi). 2) Conta no banco e sessão: um erro aqui (banco fora
    // do ar etc.) NÃO é token inválido → 500 genérico, o mesmo padrão do login por senha.
    let verifyingToken = true;
    try {
        const { idToken } = googleLoginSchema.parse(req.body);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Google payload shape varies between ID token and userinfo endpoint
        let payload: Record<string, any> | null = null;

        const expectedClientId = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID;

        // Try verifying as ID Token first (validates signature + audience for us)
        try {
            const ticket = await googleClient.verifyIdToken({
                idToken,
                audience: expectedClientId,
            });
            payload = ticket.getPayload() ?? null;
        } catch {
            // Not an ID token → treat as an OAuth access_token. We MUST validate that the
            // token was issued for THIS app (audience) before trusting it, otherwise ANY
            // Google access_token obtained by any third-party app could be replayed here
            // to impersonate the victim (account takeover). The /userinfo endpoint happily
            // returns a profile for ANY valid Google access_token regardless of client.
            if (!expectedClientId) {
                res.status(500).json({ error: 'Login Google não está configurado no servidor.' });
                return;
            }

            const tokenInfoRes = await fetch(
                `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(idToken)}`
            );
            if (!tokenInfoRes.ok) {
                res.status(401).json({ error: 'Token Google inválido.' });
                return;
            }
            const tokenInfo = await tokenInfoRes.json() as Record<string, any>;
            const tokenAudience = tokenInfo.aud || tokenInfo.azp || tokenInfo.issued_to;
            if (tokenAudience !== expectedClientId) {
                console.error(`[Auth:Google] access_token audience mismatch (${tokenAudience} != ${expectedClientId}) — rejecting`);
                res.status(401).json({ error: 'Token Google não autorizado para este aplicativo.' });
                return;
            }

            // Audience validated — now it's safe to fetch the profile
            const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${idToken}` }
            });
            if (!response.ok) throw new Error('Invalid token');
            payload = await response.json() as Record<string, any>;
        }

        if (!payload || !payload.email) {
            res.status(400).json({ error: 'Token Google inválido ou sem email.' });
            return;
        }
        payload.email = String(payload.email).trim().toLowerCase();
        verifyingToken = false; // token conferido: daqui em diante, erro é do servidor (500), não do Google

        // AUTH-H1 FIX: First try to find by googleId (safe — unique identifier)
        let user = await prisma.user.findFirst({
            where: { googleId: payload.sub },
        });

        if (!user) {
            // Check if email is already registered (potential account linking). Sem diferenciar
            // maiúsculas: um cadastro antigo "Joao@x.com" não pode virar uma conta CLIENTE duplicada.
            const existingByEmail = await findUserByEmailInsensitive(payload.email);

            if (existingByEmail) {
                // AUTH-H1 FIX: Don't auto-link — require user to login with password first
                // This prevents account takeover via email-based Google OAuth linking
                if (existingByEmail.passwordHash) {
                    res.status(409).json({
                        error: 'Já existe uma conta com este e-mail. Faça login com sua senha e vincule o Google nas configurações.',
                        requiresPasswordAuth: true,
                    });
                    return;
                }
                // Vincular pelo e-mail exige o e-mail VERIFICADO pelo Google (a equipe pode ser criada sem
                // senha — entra por código —, então esse vínculo passa a ser um caminho real de acesso).
                const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
                if (!emailVerified) {
                    res.status(409).json({
                        error: 'Não foi possível vincular o Google a esta conta: o e-mail do Google não está verificado. Entre com o código enviado ao seu e-mail.',
                        code: 'GOOGLE_EMAIL_NOT_VERIFIED',
                    });
                    return;
                }
                // If no password (created via OTP only), safe to link since both are external auth
                user = await prisma.user.update({
                    where: { id: existingByEmail.id },
                    data: { googleId: payload.sub },
                });
            } else {
                // Create new user from Google payload
                user = await prisma.user.create({
                    data: {
                        email: payload.email,
                        googleId: payload.sub,
                        name: payload.name || payload.email.split('@')[0],
                        photoUrl: payload.picture,
                        role: 'CLIENTE',
                    },
                });
            }
        }

        if (assertNotBlocked(res, user)) return;
        if (await refuseDuringDeletion(res, user.id)) return;

        const tokens = generateTokens({ userId: user.id, email: user.email || '', role: user.role });
        // COLABORADOR sem as permissões lidas → 503 sem Set-Cookie (não o 401 genérico do catch abaixo).
        const authUser = await loadAuthUserOrReply(res, user, LOGIN_PERMISSIONS_UNAVAILABLE_BODY);
        if (!authUser) return;
        setTokenCookies(res, tokens.accessToken, tokens.refreshToken);

        res.json({ user: authUser });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        if (!verifyingToken) {
            // Banco fora do ar/erro inesperado depois de o token ser aceito: 500 sem Set-Cookie (os cookies só
            // saem depois de tudo lido). Um 401 aqui diria "o Google recusou" e o front tentaria renovar a sessão.
            replyUnexpected(res, '[AUTH:Google] login error:', err);
            return;
        }
        // AUTH-M3 FIX: Don't expose internal error object to client
        console.error('[AUTH:Google] Authentication error:', err);
        if (!res.headersSent) res.status(401).json({ error: 'Falha na autenticação via Google.' });
    }
});

// ─── POST /api/auth/refresh ─────────────────────────────
// O front (api/client.ts → tryRefresh) decide pela resposta se a sessão ACABOU (apaga o cookie e vai ao
// login) ou se foi uma falha PASSAGEIRA (mantém o usuário). Por isso só respondem 401:
//   • cookie ausente; refresh token que não passa no jwt.verify — QUALQUER erro dele (assinatura, formato,
//     expirado, payload que não é JSON);
//   • sessão revogada (`code: 'SESSION_REVOKED'`); usuário inexistente.
// Conta bloqueada/excluída segue com o assertNotBlocked (403/401 ACCOUNT_DISABLED, 401 'Conta não encontrada.').
// Erro de banco ou qualquer outro inesperado → 503 SESSION_REFRESH_UNAVAILABLE (NS-3): um 401 aqui faria o
// front encerrar a sessão de todo mundo que renovasse durante uma instabilidade do banco. Inclui o
// COLABORADOR cujas permissões (staff_profiles) não puderam ser lidas: 503, nunca 200 com `permissions: []`.

const REFRESH_INVALID_BODY = { error: 'Refresh token inválido ou expirado.' } as const;
/** Mesmo texto de SESSION_REFRESH_UNAVAILABLE_MESSAGE (frontend/src/api/client.ts). */
const REFRESH_UNAVAILABLE_BODY = {
    error: 'Não foi possível renovar a sessão agora. Tente novamente em instantes.',
    code: 'SESSION_REFRESH_UNAVAILABLE',
} as const;

router.post('/refresh', async (req: Request, res: Response) => {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
        res.status(401).json({ error: 'Refresh token não encontrado.' });
        return;
    }

    let decoded: { userId?: unknown; iat?: number };
    try {
        decoded = jwt.verify(refreshToken, config.jwt.refreshSecret, { algorithms: ['HS256'] }) as typeof decoded;
    } catch {
        // Qualquer erro do jwt.verify = token inválido → 401. O verify é cálculo local (sem banco nem rede),
        // então não há falha passageira aqui. Além do JsonWebTokenError (que cobre TokenExpiredError e
        // NotBeforeError), o jsonwebtoken deixa escapar um SyntaxError cru quando o header diz typ 'JWT' e o
        // payload não é JSON — com 503, o front nunca mandaria ao /login e o cookie ficaria até vencer.
        res.status(401).json(REFRESH_INVALID_BODY);
        return;
    }
    // Assinatura válida mas sem userId (payload em texto ou de outro formato): token inválido, não falha passageira.
    if (!decoded || typeof decoded !== 'object' || typeof decoded.userId !== 'string' || !decoded.userId) {
        res.status(401).json(REFRESH_INVALID_BODY);
        return;
    }
    const tokenUserId = decoded.userId;

    try {
        const user = await prisma.user.findUnique({ where: { id: tokenUserId } });
        if (!user) {
            res.status(401).json({ error: 'Usuário não encontrado.' });
            return;
        }

        if (assertNotBlocked(res, user)) return;

        // D3: sessão revogada (exclusão EM ANDAMENTO — deletedAt só é gravado no fim — ou bloqueio
        // recente): o refresh token emitido até a revogação não renova. Sem isto, um refresh no meio
        // da exclusão emitia um access token com iat posterior à revogação, que sobrevivia a ela.
        // Checado DEPOIS da leitura do usuário e logo antes de assinar: se a revogação ainda não
        // existia aqui, o token sai (na prática) com iat ≤ revogação e o authenticate o recusa; a
        // revogação final da exclusão (com folga — userDeletion) cobre o que sobrar dessa corrida.
        if (await isTokenRevoked(user.id, decoded.iat)) {
            res.status(401).json(SESSION_REVOKED_BODY);
            return;
        }

        const tokens = generateTokens({
            userId: user.id,
            email: user.email || '',
            role: user.role,
        });
        // `user` no formato único (papel e permissões atuais do banco) — o front pode atualizar o contexto.
        // Montado ANTES dos cookies: uma falha aqui vira 503 sem Set-Cookie nenhum (o cookie atual fica e
        // renova assim que o banco responder) — inclusive a leitura das permissões do COLABORADOR.
        const authUser = await loadAuthUserOrReply(res, user, REFRESH_UNAVAILABLE_BODY);
        if (!authUser) return;

        setTokenCookies(res, tokens.accessToken, tokens.refreshToken);
        res.json({ message: 'Tokens renovados com sucesso.', user: authUser });
    } catch (err) {
        // Banco fora do ar/pool esgotado ou erro inesperado: passageiro. Nunca 401 (ver o topo da rota) e
        // nunca apaga o cookie — com o banco de volta, o mesmo refresh token renova normalmente.
        console.error('[AUTH] refresh indisponível (erro de banco ou inesperado):', err instanceof Error ? err.message : err);
        if (!res.headersSent) res.status(503).json(REFRESH_UNAVAILABLE_BODY);
    }
});

// ─── POST /api/auth/logout ──────────────────────────────

router.post('/logout', (_req: Request, res: Response) => {
    res.clearCookie('accessToken');
    res.clearCookie('refreshToken', { path: '/api/auth/refresh' });
    res.json({ message: 'Logout realizado com sucesso.' });
});

// ─── GET /api/auth/me ───────────────────────────────────

router.get('/me', authenticate, async (req: Request, res: Response) => {
    try {
        const found = await prisma.user.findUnique({
            where: { id: req.user!.userId },
            select: { ...AUTH_USER_SELECT, deletedAt: true, clientStatus: true },
        });

        // D3: conta excluída (soft delete) se comporta como inexistente para a sessão residual.
        if (!found || found.deletedAt) {
            res.status(404).json({ error: 'Usuário não encontrado.' });
            return;
        }
        // Conta bloqueada/desativada com sessão residual (revogação no Redis é fail-open): 401
        // ACCOUNT_DISABLED, para o front encerrar a sessão em vez de ficar preso na tela (crítica S3).
        if (found.clientStatus === 'BLOCKED') {
            res.status(401).json(blockedBody(found.role));
            return;
        }

        // COLABORADOR sem as permissões lidas → 503 PERMISSIONS_UNAVAILABLE (o refreshPermissions do front
        // mantém o que já tinha), nunca 200 com `permissions: []`.
        const authUser = await loadAuthUserOrReply(res, found, PERMISSIONS_UNAVAILABLE_BODY);
        if (!authUser) return;
        res.json({ user: authUser });
    } catch (err) {
        console.error('[AUTH] /me error:', err);
        res.status(500).json({ error: 'Não foi possível carregar sua conta agora. Tente novamente.' });
    }
});

// D3: a exclusão revoga o access token na hora (authenticate → 401). Rede de segurança caso a
// revogação falhe (Redis indisponível, fail-open): as rotas que GRAVAM dados pessoais recusam a conta
// excluída para não repovoar o registro anonimizado (e prender de novo o CPF/e-mail liberados) e a conta
// BLOCKED/desativada (AUTH-04: como o /me — e o PATCH /profile da equipe reemite cookies, então sem isto
// uma sessão residual de quem foi desativado se renovaria sozinha).
// Responde e devolve null quando recusa: 404 para excluída/inexistente, 401 blockedBody para BLOCKED.
async function loadWritableAccount(res: Response, userId: string): Promise<{ role: string } | null> {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, deletedAt: true, clientStatus: true } });
    if (!u || u.deletedAt) {
        res.status(404).json({ error: 'Conta não encontrada.' });
        return null;
    }
    if (u.clientStatus === 'BLOCKED') {
        res.status(401).json(blockedBody(u.role));
        return null;
    }
    return { role: u.role };
}

// ─── PATCH /api/auth/profile ────────────────────────────

const profileUpdateSchema = z.object({
    name: z.string().min(2).optional(),
    phone: z.string().optional(),
    password: z.string().min(6).optional(),
    cpfCnpj: z.string().optional(),
    address: z.string().optional(),
    addressNumber: z.string().optional(),
    complement: z.string().optional(),
    neighborhood: z.string().optional(),
    zipCode: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    socialLinks: z.union([
        z.string().max(500),
        z.object({
            instagram: z.string().max(100).optional(),
            linkedin: z.string().max(200).optional(),
            youtube: z.string().max(200).optional(),
            tiktok: z.string().max(200).optional(),
            twitter: z.string().max(200).optional(),
        }),
    ]).optional(),
    essentialNotificationsOnly: z.boolean().optional(),
});

/** Senha mínima da equipe (igual à tela Equipe): ADMIN/COLABORADOR trocando a própria senha. */
const STAFF_PASSWORD_MIN = 8;

/**
 * A senha nova JÁ foi gravada e algo depois falhou (ex.: a releitura da conta antes de reemitir os cookies da
 * equipe). O 500 genérico ("não foi possível concluir") esconderia que a senha mudou. As sessões da equipe
 * podem já ter sido revogadas (esta inclusa) e os cookies novos não saíram: a pessoa pode ser desconectada.
 */
const PASSWORD_SAVED_INCOMPLETE_BODY = Object.freeze({
    error: 'Sua senha foi alterada, mas não foi possível renovar o seu acesso agora. Se você for desconectado, entre com a nova senha.',
    code: 'PASSWORD_CHANGED',
});

router.patch('/profile', authenticate, async (req: Request, res: Response) => {
    // true depois que o update com a senha nova foi gravado: um erro daí em diante não pode virar o 500 genérico.
    let passwordSaved = false;
    try {
        // O papel nunca se altera pelo próprio perfil (autoescalada): recusa explícita, sem gravar nada.
        if (req.body && typeof req.body === 'object' && Object.prototype.hasOwnProperty.call(req.body, 'role')) {
            res.status(400).json({ error: 'O tipo de acesso não se altera pelo perfil.', code: 'ROLE_NOT_ALLOWED' });
            return;
        }
        const data = profileUpdateSchema.parse(req.body);
        const userId = req.user!.userId;
        const account = await loadWritableAccount(res, userId);
        if (!account) return;
        const isStaff = isStaffRole(account.role);
        if (data.password && isStaff && data.password.length < STAFF_PASSWORD_MIN) {
            res.status(400).json({ error: `A senha da equipe precisa ter no mínimo ${STAFF_PASSWORD_MIN} caracteres.`, code: 'PASSWORD_TOO_SHORT' });
            return;
        }
        const updateData: Prisma.UserUncheckedUpdateInput = {};
        if (data.name) updateData.name = data.name;
        if (data.phone !== undefined) updateData.phone = data.phone;
        if (data.password) updateData.passwordHash = await bcrypt.hash(data.password, 12);
        if (data.cpfCnpj !== undefined) {
            const digits = data.cpfCnpj.replace(/\D/g, '');
            if (digits && !isValidCpfCnpj(digits)) {
                res.status(400).json({ error: 'CPF/CNPJ inválido. Confira os números.' });
                return;
            }
            updateData.cpfCnpj = digits || null;
        }
        if (data.address !== undefined) updateData.address = data.address;
        if (data.addressNumber !== undefined) updateData.addressNumber = data.addressNumber;
        if (data.complement !== undefined) updateData.complement = data.complement;
        if (data.neighborhood !== undefined) updateData.neighborhood = data.neighborhood;
        if (data.zipCode !== undefined) updateData.zipCode = data.zipCode;
        if (data.city !== undefined) updateData.city = data.city;
        if (data.state !== undefined) updateData.state = data.state;
        // A14: o frontend já envia socialLinks como STRING JSON. Re-stringificar gravava um JSON
        // duplamente codificado (na releitura, parse devolvia uma string, não objeto → links somem).
        // Só serializa quando vier objeto; string já pronta é gravada como está.
        if (data.socialLinks !== undefined) updateData.socialLinks = typeof data.socialLinks === 'string' ? data.socialLinks : JSON.stringify(data.socialLinks);
        if (data.essentialNotificationsOnly !== undefined) updateData.essentialNotificationsOnly = data.essentialNotificationsOnly;

        const user = await prisma.user.update({
            where: { id: userId },
            data: updateData,
            select: AUTH_USER_SELECT,
        });
        passwordSaved = !!data.password;

        // Equipe trocou a própria senha → encerra as OUTRAS sessões (um token roubado deixa de valer) e
        // mantém esta: revoga tudo até agora e reemite os cookies desta sessão com iat no segundo seguinte.
        if (data.password && isStaff) {
            await revokeUserSessions(userId);
            // Relê a conta antes de emitir: se foi desativada/excluída durante o bcrypt (corrida com o
            // Desativar da tela Equipe), não sai cookie novo — a sessão termina como a do /me (AUTH-04).
            const fresh = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, clientStatus: true, deletedAt: true } });
            if (!fresh || fresh.deletedAt) {
                res.status(404).json({ error: 'Conta não encontrada.' });
                return;
            }
            if (fresh.clientStatus === 'BLOCKED') {
                res.status(401).json(blockedBody(fresh.role));
                return;
            }
            const tokens = generateTokens(
                { userId, email: user.email || '', role: user.role },
                Math.floor(Date.now() / 1000) + 1,
            );
            setTokenCookies(res, tokens.accessToken, tokens.refreshToken);
        }

        res.json({ user: await loadAuthUserForProfile(user), message: 'Perfil atualizado com sucesso.' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        // Unique constraint (cpfCnpj already used by another account)
        if (err && typeof err === 'object' && (err as { code?: string }).code === 'P2002') {
            res.status(409).json({ error: 'Este CPF/CNPJ já está cadastrado em outra conta.' });
            return;
        }
        // A senha nova já vale: a resposta diz isso (nunca o "não foi possível concluir" genérico, que daria a
        // entender que nada mudou).
        if (passwordSaved) {
            console.error('[AUTH] profile: senha gravada, falha depois:', err);
            if (!res.headersSent) res.status(500).json(PASSWORD_SAVED_INCOMPLETE_BODY);
            return;
        }
        // Erro de banco/inesperado: 500 aqui (um `throw` deixaria a requisição sem resposta no Express 4).
        replyUnexpected(res, '[AUTH] profile update error:', err);
    }
});

// ─── POST /api/auth/profile/photo ───────────────────────

// Multer errors (file too large, unexpected field, filter rejection) surface in
// English by default. Wrap the middleware so the client always gets pt-BR.
const photoUploadMw = (req: Request, res: Response, next: (err?: unknown) => void) => {
    upload.single('photo')(req, res, (err: unknown) => {
        if (!err) return next();
        console.error('[PHOTO] multer error:', err);
        const code = (err as { code?: string }).code;
        if (code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({ error: 'Imagem muito grande (máx. 10MB).' });
            return;
        }
        const msg = getErrorMessage(err);
        res.status(400).json({ error: msg === 'Apenas imagens são permitidas.' ? msg : 'Não foi possível receber a imagem. Tente novamente.' });
    });
};

router.post('/profile/photo', authenticate, photoUploadMw, async (req: Request, res: Response) => {
    try {
        const file = req.file;
        if (!file) {
            res.status(400).json({ error: 'Nenhuma foto enviada.' });
            return;
        }
        if (!(await loadWritableAccount(res, req.user!.userId))) return;

        // Process image: resize to 256x256 square JPEG and store it as a data-URL in
        // the DB. Railway's filesystem is ephemeral — files under /uploads vanish on
        // every redeploy, which used to leave avatars 404 (empty gradient circle).
        // At 256px/q80 the data-URL is ~15-25KB, fine for a text column.
        const buffer = await sharp(file.buffer)
            .resize(256, 256, { fit: 'cover', position: 'centre' })
            .jpeg({ quality: 80 })
            .toBuffer();
        const photoUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;

        const user = await prisma.user.update({
            where: { id: req.user!.userId },
            data: { photoUrl },
            select: AUTH_USER_SELECT,
        });

        res.json({ user: await loadAuthUserForProfile(user), message: 'Foto atualizada com sucesso.' });
    } catch (err: unknown) {
        // Sharp/Prisma details stay in the server log — the client gets pt-BR.
        console.error('Photo upload error:', err);
        res.status(500).json({ error: 'Não foi possível processar a imagem. Tente novamente.' });
    }
});

export default router;
