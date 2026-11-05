import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { redis } from '../lib/redis.js';
import { Role } from '../generated/prisma/client.js';

// Extend Express Request type to include user info
declare global {
    namespace Express {
        interface Request {
            user?: {
                userId: string;
                email: string;
                role: Role;
            };
        }
    }
}

interface JwtPayload {
    userId: string;
    email: string;
    role: Role;
    /** Emissão (segundos desde epoch) — preenchido pelo jsonwebtoken. */
    iat?: number;
}

// ─── Revogação imediata de sessão (D3: excluir/bloquear cliente) ─────────
// O access token é um JWT sem estado (válido até 1h). Excluir ou bloquear um cliente precisa
// encerrar a sessão JÁ aberta, não só impedir o próximo refresh. Sem consulta ao banco por
// requisição: uma chave Redis por usuário guarda o instante da revogação (segundos) e vive o
// tempo de validade do token MAIS LONGO — o refresh token (30 dias), não só o access token (1h):
// depois disso todo token anterior (access E refresh) já expirou sozinho. Viver só 1h não basta:
// troca de senha/e-mail (equipe e cliente) e "Definir senha" não deixam marca no banco, então o
// refresh token antigo voltaria a renovar a sessão uma hora depois da revogação.
// O authenticate recusa (401) tokens emitidos até esse instante, e o POST /auth/refresh recusa
// refresh tokens emitidos até ele (senão, durante uma exclusão — deletedAt só é gravado no fim — o
// refresh emitiria um token novo que sobreviveria a ela; o LOGIN, pelo mesmo motivo, recusa enquanto a
// exclusão está em andamento — isUserDeletionInProgress). Um LOGIN legítimo posterior (ex.: cliente
// desbloqueado) emite tokens mais novos e passa normalmente; para conta excluída/bloqueada o próprio
// refresh/login já recusa pelo banco, então a sessão termina de vez.

const REVOKED_PREFIX = 'auth:revoked:';
/** Não deixa um Redis lento travar TODAS as requisições autenticadas (fail-open). */
const REVOCATION_CHECK_TIMEOUT_MS = 500;

/**
 * 401 de sessão revogada (authenticate e POST /auth/refresh). O `code` deixa o front distinguir o fim de
 * sessão (vai ao login) de uma falha passageira do refresh (503 SESSION_REFRESH_UNAVAILABLE — NS-2/NS-3).
 */
export const SESSION_REVOKED_BODY = { error: 'Sessão encerrada. Faça login novamente.', code: 'SESSION_REVOKED' } as const;

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };

/** Validade do access token em segundos (config.jwt.accessExpiry: '1h', '15m', '3600'…). Fallback seguro: 24h. */
export function accessTokenTtlSeconds(expiry: string | number = config.jwt.accessExpiry): number {
    if (typeof expiry === 'number' && Number.isFinite(expiry) && expiry > 0) return Math.ceil(expiry);
    const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)?\s*$/i.exec(String(expiry));
    if (!m) return 24 * 3600;
    const value = Number(m[1]);
    const unit = (m[2] ?? 's').toLowerCase();
    if (unit === 'ms') return Math.max(1, Math.ceil(value / 1000));
    const seconds = value * (UNIT_SECONDS[unit[0]] ?? 1);
    return seconds > 0 ? Math.ceil(seconds) : 24 * 3600;
}

/** Por quanto tempo a marca de revogação precisa durar: a validade do token mais longo (refresh). */
export function revocationTtlSeconds(): number {
    return Math.max(accessTokenTtlSeconds(config.jwt.accessExpiry), accessTokenTtlSeconds(config.jwt.refreshExpiry));
}

/**
 * Encerra na hora as sessões abertas de `userId`: todo access token E refresh token emitido até
 * agora passa a ser recusado (authenticate → 401; POST /auth/refresh → 401) — por toda a validade
 * do refresh token, não só a do access token. Best-effort: falha do Redis só é logada (o
 * refresh/login continuam recusando conta excluída ou bloqueada pelo banco).
 *
 * `graceSeconds` (só para conta que deixou de existir — exclusão concluída): estende a revogação
 * para tokens emitidos até N segundos DEPOIS de agora. Fecha a corrida de um login/refresh que leu
 * o usuário ANTES do commit da exclusão e assina o token um instante depois (bcrypt, Google…). Nunca
 * usar em bloqueio (um login legítimo após desbloquear seria recusado).
 *
 * Devolve o valor gravado na chave (o revokedAt, em texto) — quem revoga de forma PROVISÓRIA (exclusão
 * de cliente) o usa para desfazer só a própria revogação (clearUserSessionRevocation) —, ou null se o
 * Redis falhou.
 */
export async function revokeUserSessions(userId: string, opts: { graceSeconds?: number } = {}): Promise<string | null> {
    try {
        const grace = Math.max(0, Math.floor(opts.graceSeconds ?? 0));
        const revokedAt = String(Math.floor(Date.now() / 1000) + grace);
        // Vive a validade do REFRESH token (a maior das duas) + 60s de margem (relógio/arredondamento
        // do exp). Sempre longa: uma revogação posterior (ex.: bloquear depois de trocar a senha)
        // sobrescreve a chave com revokedAt maior e o mesmo TTL longo, sem encurtar a cobertura.
        await redis.set(`${REVOKED_PREFIX}${userId}`, revokedAt, 'EX', revocationTtlSeconds() + 60 + grace);
        return revokedAt;
    } catch (err) {
        console.error(`[AUTH] Falha ao revogar as sessões de ${userId}:`, err instanceof Error ? err.message : err);
        return null;
    }
}

/**
 * Retrato da marca de revogação de um usuário, lido ANTES de uma revogação provisória (exclusão de
 * cliente), para que desfazê-la devolva a chave ao estado anterior em vez de apagá-la.
 */
export interface SessionRevocationSnapshot {
    /** revokedAt anterior (texto da chave), ou null quando não havia revogação. */
    value: string | null;
    /** Validade que restava à chave anterior, em ms; null = chave sem expiração (ou sem chave). */
    pttlMs: number | null;
    /** Date.now() da leitura: o tempo decorrido até o desfazer é descontado da validade. */
    readAt: number;
}

/**
 * Lê valor e validade de auth:revoked:<userId> numa só ida ao Redis (MULTI). null = Redis falhou (estado
 * desconhecido: quem desfaz uma revogação provisória deve MANTÊ-LA — apagar poderia ressuscitar uma
 * revogação anterior).
 */
export async function readUserSessionRevocation(userId: string): Promise<SessionRevocationSnapshot | null> {
    const key = `${REVOKED_PREFIX}${userId}`;
    try {
        const readAt = Date.now();
        const replies: Array<[Error | null, unknown]> | null = await redis.multi().get(key).pttl(key).exec();
        const failed = replies?.find(([err]) => err)?.[0];
        if (!replies || failed) throw failed ?? new Error('MULTI abortado');
        const value = replies[0][1] as string | null;
        const pttl = Number(replies[1][1]);
        // pttl -2 = a chave sumiu entre o GET e o PTTL (expirou): equivale a "não havia".
        if (value === null || pttl === -2) return { value: null, pttlMs: null, readAt };
        return { value, pttlMs: pttl >= 0 ? pttl : null, readAt };
    } catch (err) {
        console.error(`[AUTH] Falha ao ler a revogação de ${userId}:`, err instanceof Error ? err.message : err);
        return null;
    }
}

// Desfaz atomicamente uma revogação provisória.
//   KEYS[1] = auth:revoked:<id>
//   ARGV[1] = valor que a revogação provisória gravou ('' = não confere): se a chave já tem OUTRO valor, uma
//             revogação posterior (troca de senha, bloqueio) aconteceu no meio — ela fica, nada é desfeito;
//   ARGV[2] = valor anterior ('' = não havia revogação → DEL);
//   ARGV[3] = validade restante do valor anterior em ms ('-1' = a chave anterior não expirava).
const RESTORE_REVOCATION_LUA = `
if ARGV[1] ~= '' and redis.call('get', KEYS[1]) ~= ARGV[1] then
  return 0
end
if ARGV[2] == '' then
  redis.call('del', KEYS[1])
elseif tonumber(ARGV[3]) > 0 then
  redis.call('set', KEYS[1], ARGV[2], 'PX', ARGV[3])
else
  redis.call('set', KEYS[1], ARGV[2])
end
return 1
`;

/**
 * Desfaz uma revogação provisória (ex.: a exclusão do cliente falhou e ele continua existindo) SEM apagar
 * uma revogação ANTERIOR: troca de senha/e-mail do cliente (F8) grava 30 dias de revogação, e um DEL aqui
 * faria o refresh token anterior a ela voltar a valer.
 *  - `previous` com valor → a chave volta ao revokedAt anterior, com a validade que restava (descontado o
 *    tempo decorrido desde a leitura; se ela já teria expirado, DEL);
 *  - `previous` sem valor (não havia chave) ou omitido → DEL.
 * `onlyIfValue` (o que revokeUserSessions devolveu na revogação provisória): só desfaz se a chave ainda
 * guarda esse valor — uma revogação feita no meio do caminho é mantida. Atômico (Lua). Best-effort: falha
 * do Redis só é logada (a sessão continua encerrada, o lado seguro).
 */
export async function clearUserSessionRevocation(
    userId: string,
    previous?: SessionRevocationSnapshot,
    opts: { onlyIfValue?: string } = {},
): Promise<void> {
    try {
        let restoreValue = '';
        let restorePttl = '-1';
        if (previous?.value) {
            if (previous.pttlMs === null) {
                restoreValue = previous.value;
            } else {
                const remaining = previous.pttlMs - Math.max(0, Date.now() - previous.readAt);
                if (remaining > 0) {
                    restoreValue = previous.value;
                    restorePttl = String(Math.ceil(remaining));
                }
            }
        }
        await redis.eval(RESTORE_REVOCATION_LUA, 1, `${REVOKED_PREFIX}${userId}`, opts.onlyIfValue ?? '', restoreValue, restorePttl);
    } catch (err) {
        console.error(`[AUTH] Falha ao desfazer a revogação de ${userId}:`, err instanceof Error ? err.message : err);
    }
}

/** Chave do mutex da exclusão de cliente (userDeletion.deleteUser) — o login também a consulta. */
export const userDeletionLockKey = (userId: string): string => `mutex:user-delete:${userId}`;

/**
 * true enquanto a exclusão de `userId` está em andamento (mutex de deleteUser). O login recusa nesse
 * intervalo: um token emitido no meio da exclusão (deletedAt só é gravado no fim) deixaria o cliente
 * criar reserva/cobrança depois do passo que as cancela. Fail-open (500 ms), como a revogação.
 */
export async function isUserDeletionInProgress(userId: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const n = await Promise.race([
            redis.exists(userDeletionLockKey(userId)),
            new Promise<number>((resolve) => { timer = setTimeout(() => resolve(0), REVOCATION_CHECK_TIMEOUT_MS); }),
        ]);
        return n > 0;
    } catch (err) {
        console.error('[AUTH] Checagem de exclusão em andamento indisponível (seguindo sem ela):', err instanceof Error ? err.message : err);
        return false;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * true se o token (access OU refresh, emitido em `iat`) foi revogado por revokeUserSessions.
 * Em falha/lentidão do Redis: false (fail-open).
 */
export async function isTokenRevoked(userId: string, iat: number | undefined): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const raw = await Promise.race([
            redis.get(`${REVOKED_PREFIX}${userId}`),
            new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), REVOCATION_CHECK_TIMEOUT_MS); }),
        ]);
        if (!raw) return false;
        const revokedAt = Number(raw);
        if (!Number.isFinite(revokedAt)) return true;
        // Sem iat não há como provar que o token é posterior → recusa.
        return typeof iat !== 'number' || iat <= revokedAt;
    } catch (err) {
        console.error('[AUTH] Checagem de revogação indisponível (seguindo sem ela):', err instanceof Error ? err.message : err);
        return false;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Authenticate middleware: validates JWT from HttpOnly cookie and refuses revoked sessions
 * (cliente excluído/bloqueado — ver revokeUserSessions).
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token = req.cookies?.accessToken;

    if (!token) {
        res.status(401).json({ error: 'Autenticação necessária. Faça login.' });
        return;
    }

    let decoded: JwtPayload;
    try {
        // Pin the algorithm to prevent algorithm-confusion attacks (e.g. 'none' / RS↔HS).
        decoded = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] }) as JwtPayload;
    } catch {
        res.status(401).json({ error: 'Token inválido ou expirado.' });
        return;
    }

    if (await isTokenRevoked(decoded.userId, decoded.iat)) {
        res.status(401).json(SESSION_REVOKED_BODY);
        return;
    }

    req.user = {
        userId: decoded.userId,
        email: decoded.email,
        role: decoded.role,
    };
    next();
}

/**
 * Authorization middleware: checks if user has one of the allowed roles.
 */
export function authorize(...allowedRoles: Role[]) {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!req.user) {
            res.status(401).json({ error: 'Autenticação necessária.' });
            return;
        }

        if (!allowedRoles.includes(req.user.role)) {
            res.status(403).json({ error: 'Acesso negado. Permissão insuficiente.' });
            return;
        }

        next();
    };
}
