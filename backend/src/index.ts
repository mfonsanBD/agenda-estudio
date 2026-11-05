import './bootTz.js'; // B6: pin process TZ to UTC before any Date is constructed — MUST be first.
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { config } from './config/index.js';
import { errorHandler } from './middleware/errorHandler.js';

// Route modules
import authRoutes from './modules/auth/routes.js';
import bookingRoutes from './modules/bookings/routes.js';
import contractRoutes from './modules/contracts/routes.js';
import userRoutes from './modules/users/routes.js';
import blockedSlotRoutes from './modules/blocked-slots/routes.js';
import pricingRoutes from './modules/pricing/routes.js';
import ambientRoutes from './modules/ambient/routes.js';
import paymentRoutes from './modules/payments/routes.js';
import { financeRouter } from './modules/finance/routes.js';
import notificationRoutes from './modules/notifications/routes.js';
import reportRoutes from './modules/reports/routes.js';
import integrationRoutes from './modules/integrations/routes.js';
import webhookRoutes from './modules/webhooks/routes.js';
import stripeRoutes from './modules/stripe/routes.js';
import pushRoutes from './modules/push/routes.js';
import couponRoutes from './modules/coupons/routes.js';
import staffRoutes from './modules/staff/routes.js';

import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';


// A25: os runners de cron rodam via setInterval/setTimeout (fire-and-forget), e alguns fazem
// `await redis.set/del` e queries de topo FORA de try/catch. Uma falha transitória de DB/Redis num
// tick vira uma rejeição não tratada que, no modo default do Node (v15+), ENCERRA o processo — uma
// falha recuperável derrubando (e potencialmente crash-loopando) a API inteira. Logamos e seguimos.
process.on('unhandledRejection', (reason) => {
    console.error('[Process] Unhandled promise rejection (mantendo a API no ar):', reason);
});

const app = express();

// ─── Middleware ──────────────────────────────────────────

// ─── Security ───────────────────────────────────────────

// Trust first proxy hop (Railway load balancer) — required for
// express-rate-limit to correctly identify clients via X-Forwarded-For
if (config.nodeEnv === 'production') {
    app.set('trust proxy', 1);
}

app.use(helmet({
    contentSecurityPolicy: config.nodeEnv === 'production' ? {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "https://js.stripe.com", "https://accounts.google.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://accounts.google.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "blob:", "https://buzios.digital", "https://app.buzios.digital", "https://*.stripe.com", "https://*.googleusercontent.com"],
            connectSrc: ["'self'", "https://app.buzios.digital", "https://*.stripe.com", "https://matls-clients.api.cora.com.br", "https://accounts.google.com", "https://oauth2.googleapis.com", "https://viacep.com.br"],
            frameSrc: ["'self'", "https://js.stripe.com", "https://*.stripe.com", "https://accounts.google.com"],
        },
    } : false,
    crossOriginEmbedderPolicy: false,
    // OAuth popups (Google login) need the opener relationship preserved. The
    // Helmet default ('same-origin') severs window.opener, so the popup can't
    // return the token and login silently fails.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));

// CORS: accept FRONTEND_URL and production domain
const allowedOrigins = [
    config.frontendUrl,
    'https://app.buzios.digital',
].filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (server-to-server, curl, health checks)
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('CORS not allowed'));
        }
    },
    credentials: true,
}));

// ─── Rate Limiting ──────────────────────────────────────
// Backed by Redis so limits are enforced GLOBALLY across all app instances (an in-memory store
// would let an attacker bypass limits by spreading requests across instances). Each limiter gets
// its own key prefix. The app already hard-depends on Redis (locks, OTP), so this adds no new
// single point of failure.

const rlStore = (prefix: string) => new RedisStore({
    // ioredis: forward the raw command to the shared client.
    sendCommand: (...args: string[]) => (redis as unknown as { call: (...a: string[]) => Promise<unknown> }).call(...args) as Promise<never>,
    prefix,
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 15,
    store: rlStore('rl:auth:'),
    message: { error: 'Muitas tentativas. Tente novamente em 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    store: rlStore('rl:otp:'),
    message: { error: 'Muitos códigos solicitados. Aguarde 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 300,
    store: rlStore('rl:api:'),
    message: { error: 'Requisições excessivas. Aguarde 1 minuto.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// PAY-04 FIX: Stricter limiter for financial endpoints
const paymentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // max 20 payment operations in 15 min per IP
    store: rlStore('rl:pay:'),
    message: { error: 'Muitas tentativas de pagamento. Aguarde 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Refresh-token endpoint limiter (was unprotected) — modest cap to blunt token-grind attempts.
const refreshLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    store: rlStore('rl:refresh:'),
    message: { error: 'Muitas tentativas. Aguarde alguns minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Coupon validation limiter — blunts brute-forcing of coupon codes.
const couponLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    store: rlStore('rl:coupon:'),
    message: { error: 'Muitas tentativas de cupom. Aguarde 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Manual broadcast fan-out is expensive (loops every recipient) — cap it hard.
const broadcastLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    store: rlStore('rl:broadcast:'),
    message: { error: 'Muitos disparos de aviso. Aguarde um pouco.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// "Enviar acesso" da tela Equipe (e-mail para um membro): limite leve contra disparo repetido.
const staffAccessLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    store: rlStore('rl:staff-access:'),
    message: { error: 'Muitos e-mails de acesso enviados. Aguarde alguns minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// ─── Body Parsing ───────────────────────────────────────

// Stripe webhooks need the raw body for signature verification.
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({
    verify: (req: any, _res, buf) => {
        // Store raw body for any other webhook that might need it
        req.rawBody = buf;
    },
}));
app.use(cookieParser());
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ─── Health Check ───────────────────────────────────────

app.get('/api/health', (_req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
    });
});

// ─── Routes ─────────────────────────────────────────────

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/refresh', refreshLimiter);
app.use('/api/auth/register/send-code', otpLimiter);
app.use('/api/auth/login/send-code', otpLimiter);
app.use('/api/pricing/business-config/email/test', otpLimiter);
app.use('/api/stripe/create-payment', paymentLimiter);
app.use('/api/stripe/verify-payment', paymentLimiter);
// VULN-H1 FIX: Rate limit ALL financial endpoints
app.use('/api/contracts/:id/pay', paymentLimiter);
app.use('/api/contracts/:id/confirm-payment', paymentLimiter);
app.use('/api/contracts/:id/subscribe', paymentLimiter);
app.use('/api/contracts/:id/client-renew', paymentLimiter);
app.use('/api/bookings/:id/complete-payment', paymentLimiter);
app.use('/api/coupons/validate', couponLimiter);
app.use('/api/notifications/admin/broadcast', broadcastLimiter);
app.use('/api/staff/:id/send-access', staffAccessLimiter);
app.use('/api', apiLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/users', userRoutes);
app.use('/api/blocked-slots', blockedSlotRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/ambient', ambientRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/finance', financeRouter);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/staff', staffRoutes);

// ─── Serve Frontend (Production) ────────────────────────

if (config.nodeEnv === 'production') {
    const frontendPath = path.join(__dirname, '../../frontend/dist');
    app.use(express.static(frontendPath));

    // Catch-all: send index.html for any non-API route (React Router)
    app.get('*', (_req, res) => {
        res.sendFile(path.join(frontendPath, 'index.html'));
    });
}

// ─── Error Handler ──────────────────────────────────────

app.use(errorHandler);

// ─── Start Server ───────────────────────────────────────

app.listen(config.port, async () => {
    console.log(`🎙️  Studio Scheduler API running on http://localhost:${config.port}`);
    console.log(`   Environment: ${config.nodeEnv}`);

    // Loud, visible warning if the OTP dev-bypass flag is enabled — it must NEVER be on outside dev
    // (it's already double-gated by NODE_ENV !== 'production', but a silent flag is easy to miss).
    if (process.env.ALLOW_OTP_BYPASS === 'true') {
        console.warn(`⚠️  [SECURITY] OTP bypass (code 999999) is ENABLED (env ALLOW_OTP_BYPASS=true) in ${config.nodeEnv}. Remove it for any non-development environment.`);
    }
    if (config.jwt.secret === 'dev-secret' || config.jwt.refreshSecret === 'dev-refresh-secret') {
        console.warn('⚠️  [SECURITY] Using the DEFAULT dev JWT secret(s) — set JWT_SECRET and JWT_REFRESH_SECRET. (Production startup already hard-requires them; this guards misconfigured non-prod envs.)');
    }

    const { redis } = await import('./lib/redis.js');

    // Hold Expiration Cronjob — clean expired HELD bookings & AWAITING_PAYMENT contracts every 60s
    import('./jobs/cleanExpiredHolds.js').then(({ cleanExpiredHolds }) => {
        // Sem sobreposição (jobs-tempo-migrations-3): a varredura concilia no Sicoob/Stripe antes de
        // apagar (cada chamada com timeout de 30s), então uma rodada pode passar de 60s. Flag no
        // processo (o setInterval não empilha rodadas) + trava Redis entre instâncias com TTL acima do
        // pior caso e liberação só pelo DONO (compare-and-delete) — um `del` incondicional de uma
        // rodada lenta liberava a trava de outra que já rodava.
        let holdCleanupRunning = false;
        const HOLD_LOCK_TTL_SECONDS = 600;
        const runHoldCleanup = async () => {
            if (holdCleanupRunning) return;
            holdCleanupRunning = true;
            const holdLockKey = 'cron:hold-cleanup:lock';
            const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            try {
                const lockAcquired = await redis.set(holdLockKey, token, 'EX', HOLD_LOCK_TTL_SECONDS, 'NX');
                if (lockAcquired !== 'OK') return;
                try {
                    await cleanExpiredHolds();
                } finally {
                    await redis.eval(
                        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
                        1, holdLockKey, token,
                    ).catch(() => { /* expira pelo TTL */ });
                }
            } catch (err) {
                console.error('[HOLD-CLEANUP] Tick failed:', err);
            } finally {
                holdCleanupRunning = false;
            }
        };
        setInterval(runHoldCleanup, 60 * 1000);
        console.log('   ⏰ Hold cleanup job registered (every 60s)');
    }).catch(err => console.error('[HOLD-CLEANUP] Failed to load job:', err));

    // Push Notification Cronjob — checks & sends push every 5 minutes
    import('./jobs/pushNotificationJob.js').then(({ runPushNotificationJob }) => {
        const runPushJob = async () => {
            const pushLockKey = 'cron:push-notif:lock';
            const lockAcquired = await redis.set(pushLockKey, 'running', 'EX', 280, 'NX');
            if (lockAcquired !== 'OK') return;
            try {
                await runPushNotificationJob();
            } finally {
                await redis.del(pushLockKey);
            }
        };
        setInterval(runPushJob, 5 * 60 * 1000);
        console.log('   📱 Push notification job registered (every 5min)');
    }).catch(err => console.error('[PUSH-JOB] Failed to load:', err));

    // Booking Reminder Cronjob — sends reminders EXACTLY 24h and 2h before sessions (D14).
    // Every 1 min aligned to the wall-clock minute (+1s), so a 10:00 session gets its 24h
    // reminder at 10:00:01 the day before; the boot run does the ≤60 min catch-up (last-run in Redis).
    import('./jobs/bookingReminderJob.js').then(({ runBookingReminderJob }) => {
        // Uma rodada NUNCA corre em paralelo com a seguinte (um catch-up lento passava de 55s, a trava
        // vencia e o tick seguinte avaliava o mesmo intervalo):
        //  • flag em processo: o tick pula enquanto a rodada anterior deste processo ainda roda;
        //  • trava Redis com dono (token), renovada a cada 20s enquanto a rodada roda (outra instância
        //    não entra no meio) e que some em ≤55s se o processo cair; só o dono a libera.
        // A dedup atômica do createNotification é a 2ª barreira contra lembrete duplicado.
        const REMINDER_LOCK_TTL_S = 55;
        const DEL_IF_OWNER = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
        const RENEW_IF_OWNER = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end";
        let reminderRunning = false;
        const runReminderJob = async () => {
            if (reminderRunning) return;
            reminderRunning = true;
            const reminderLockKey = 'cron:booking-reminder:lock';
            const lockToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
            try {
                const lockAcquired = await redis.set(reminderLockKey, lockToken, 'EX', REMINDER_LOCK_TTL_S, 'NX');
                if (lockAcquired !== 'OK') return;
                const renew = setInterval(() => {
                    redis.eval(RENEW_IF_OWNER, 1, reminderLockKey, lockToken, String(REMINDER_LOCK_TTL_S)).catch(() => {});
                }, 20 * 1000);
                try {
                    await runBookingReminderJob();
                } finally {
                    clearInterval(renew);
                    await redis.eval(DEL_IF_OWNER, 1, reminderLockKey, lockToken);
                }
            } catch (err) {
                console.error('[REMINDER-JOB] Tick failed:', err);
            } finally {
                reminderRunning = false;
            }
        };
        // Recursive setTimeout re-aligned on every tick (setInterval drifts a little each fire).
        const scheduleNextReminderTick = () => {
            setTimeout(() => {
                scheduleNextReminderTick();
                void runReminderJob();
            }, 60 * 1000 - (Date.now() % (60 * 1000)) + 1000);
        };
        scheduleNextReminderTick();
        setTimeout(runReminderJob, 5000); // run once on boot (catch-up)
        console.log('   🔔 Booking reminder job registered (every 1min, minute-aligned)');
    }).catch(err => console.error('[REMINDER-JOB] Failed to load:', err));

    // FLEX Credit Expiry Cronjob — forfeits weekly credits when a window closes behind pace
    import('./jobs/flexCreditExpiryJob.js').then(({ runFlexCreditExpiryJob }) => {
        const runFlexExpiry = async () => {
            const lockKey = 'cron:flex-credit-expiry:lock';
            const lockAcquired = await redis.set(lockKey, 'running', 'EX', 1500, 'NX');
            if (lockAcquired !== 'OK') return;
            try {
                await runFlexCreditExpiryJob();
            } finally {
                await redis.del(lockKey);
            }
        };
        setInterval(runFlexExpiry, 6 * 60 * 60 * 1000); // every 6h
        setTimeout(runFlexExpiry, 8000); // run once on boot
        console.log('   🎟️ FLEX credit expiry job registered (every 6h)');
    }).catch(err => console.error('[FLEX-EXPIRY] Failed to load:', err));

    // Avulso Makeup Expiry Cronjob (D4/D5) — expira janelas de remarcação vencidas (falta justificada
    // → valor perdido + contrato concluído; não realizada → avisa os admins) e lembra nos 2 últimos dias.
    import('./jobs/avulsoMakeupExpiryJob.js').then(({ runAvulsoMakeupExpiryJob }) => {
        const runMakeupExpiry = async () => {
            const lockKey = 'cron:avulso-makeup:lock';
            try {
                const lockAcquired = await redis.set(lockKey, 'running', 'EX', 1500, 'NX');
                if (lockAcquired !== 'OK') return;
                try {
                    await runAvulsoMakeupExpiryJob();
                } finally {
                    await redis.del(lockKey);
                }
            } catch (err) {
                console.error('[MAKEUP-EXPIRY] Tick failed:', err);
            }
        };
        setInterval(runMakeupExpiry, 60 * 60 * 1000); // every 1h
        setTimeout(runMakeupExpiry, 12000); // run once on boot
        console.log('   🔁 Avulso makeup expiry job registered (every 1h)');
    }).catch(err => console.error('[MAKEUP-EXPIRY] Failed to load:', err));

    // Notification Cleanup Cronjob — removes old read/unread notifications daily
    import('./jobs/notificationCleanupJob.js').then(({ runNotificationCleanupJob }) => {
        const runCleanupJob = async () => {
            const cleanupLockKey = 'cron:notif-cleanup:lock';
            const lockAcquired = await redis.set(cleanupLockKey, 'running', 'EX', 3600, 'NX');
            if (lockAcquired !== 'OK') return;
            try {
                await runNotificationCleanupJob();
            } finally {
                await redis.del(cleanupLockKey);
            }
        };
        setInterval(runCleanupJob, 24 * 60 * 60 * 1000);
        setTimeout(runCleanupJob, 10000); // run once on boot
        console.log('   🧹 Notification cleanup job registered (daily)');
    }).catch(err => console.error('[NOTIF-CLEANUP] Failed to load:', err));

    // Cora Reconciliation Cronjob — confirm paid PIX/Boleto whose webhook was missed (every 2min)
    import('./lib/coraReconciliation.js').then(({ reconcilePendingCoraPayments }) => {
        const runReconcile = async () => {
            const lockKey = 'cron:cora-reconcile:lock';
            const lockAcquired = await redis.set(lockKey, 'running', 'EX', 110, 'NX');
            if (lockAcquired !== 'OK') return;
            try {
                await reconcilePendingCoraPayments();
            } finally {
                await redis.del(lockKey);
            }
        };
        setInterval(runReconcile, 2 * 60 * 1000);
        setTimeout(runReconcile, 15000); // run once shortly after boot
        console.log('   💸 Cora reconciliation job registered (every 2min)');
    }).catch(err => console.error('[CORA-RECONCILE] Failed to load:', err));

    // Sicoob Reconciliation Cronjob — confirma PIX pagos cujo webhook falhou (every 2min)
    import('./lib/sicoobReconciliation.js').then(({ reconcilePendingSicoobPayments }) => {
        const runReconcile = async () => {
            const lockKey = 'cron:sicoob-reconcile:lock';
            const lockAcquired = await redis.set(lockKey, 'running', 'EX', 110, 'NX');
            if (lockAcquired !== 'OK') return;
            try {
                await reconcilePendingSicoobPayments();
            } finally {
                await redis.del(lockKey);
            }
        };
        setInterval(runReconcile, 2 * 60 * 1000);
        setTimeout(runReconcile, 20000); // run once shortly after boot
        console.log('   💸 Sicoob reconciliation job registered (every 2min)');
    }).catch(err => console.error('[SICOOB-RECONCILE] Failed to load:', err));

    // Auto-Charge Cronjob — charges saved cards off-session for due installments (daily)
    import('./jobs/autoChargeJob.js').then(({ runAutoChargeJob }) => {
        const runAutoCharge = async () => {
            const lockKey = 'cron:auto-charge:lock';
            const lockAcquired = await redis.set(lockKey, 'running', 'EX', 1800, 'NX');
            if (lockAcquired !== 'OK') return;
            try {
                await runAutoChargeJob();
            } finally {
                await redis.del(lockKey);
            }
        };
        setInterval(runAutoCharge, 24 * 60 * 60 * 1000); // daily
        setTimeout(runAutoCharge, 20000); // run once shortly after boot
        console.log('   💳 Auto-charge job registered (daily)');
    }).catch(err => console.error('[AUTO-CHARGE] Failed to load:', err));

    // Daily Confirmation Cronjob — at 07:00 (São Paulo), notifies clients about the day's
    // recording: paid ⇒ "confirmada", not paid ⇒ "pague para confirmar". Runs hourly; the
    // job itself only acts at 7am SP and guards a once-per-day Redis marker.
    import('./jobs/dailyConfirmationJob.js').then(({ runDailyConfirmationJob }) => {
        const runDailyConfirm = async () => {
            const lockKey = 'cron:daily-confirm:lock';
            const lockAcquired = await redis.set(lockKey, 'running', 'EX', 280, 'NX');
            if (lockAcquired !== 'OK') return;
            try {
                await runDailyConfirmationJob();
            } finally {
                await redis.del(lockKey);
            }
        };
        setInterval(runDailyConfirm, 30 * 60 * 1000); // every 30min (acts only at 7am SP)
        setTimeout(runDailyConfirm, 25000); // check shortly after boot
        console.log('   🌅 Daily confirmation job registered (every 30min, fires at 7am SP)');
    }).catch(err => console.error('[DAILY-CONFIRM] Failed to load:', err));
});

export default app;
