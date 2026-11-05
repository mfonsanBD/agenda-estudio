/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches, matchPrecache } from 'workbox-precaching';
import { registerRoute, NavigationRoute, setCatchHandler } from 'workbox-routing';
import { NetworkFirst, StaleWhileRevalidate, CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

declare const self: ServiceWorkerGlobalScope;

// ─── Precaching ───
// Workbox precaching — vite-plugin-pwa injects the manifest here
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ─── Runtime Caching Strategies ───

// API — S2 (equipe): SÓ os GETs PÚBLICOS (sem login, iguais para todo mundo) vão para o cache, para a
// landing e os preços abrirem offline. Nada de /api/auth/* nem rotas da área administrativa ou do
// cliente: antes, TODO GET /api/* ficava 1 h no Cache Storage — num computador de recepção
// compartilhado, quem viesse depois lia o que o administrador carregou (financeiro, clientes com CPF…)
// e, com rede lenta, recebia o /auth/me do usuário anterior. As demais chamadas vão direto à rede.
// O app ainda apaga estes caches no login e no logout (clearApiCaches em api/client.ts).
const PUBLIC_API_CACHE = 'api-public-cache';
/** Cache antigo que guardava qualquer resposta da API (apagado na ativação deste service worker). */
const LEGACY_API_CACHE = 'api-cache';
const PUBLIC_API_PATHS: ReadonlySet<string> = new Set([
    '/api/pricing',
    '/api/pricing/business-config/public',
    '/api/pricing/payment-methods',
    '/api/pricing/addons',
]);

registerRoute(
    ({ url, request, sameOrigin }) =>
        sameOrigin && request.method === 'GET' && PUBLIC_API_PATHS.has(url.pathname.replace(/\/+$/, '')),
    new NetworkFirst({
        cacheName: PUBLIC_API_CACHE,
        networkTimeoutSeconds: 8,
        plugins: [
            new CacheableResponsePlugin({ statuses: [200] }),
            new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 60 * 60 }), // 1 hour
        ],
    }),
    'GET',
);

// Apaga o api-cache legado (respostas autenticadas de versões anteriores) ao ativar esta versão.
self.addEventListener('activate', (event) => {
    event.waitUntil(caches.delete(LEGACY_API_CACHE).then(() => undefined, () => undefined));
});

// Google Fonts stylesheets — StaleWhileRevalidate
registerRoute(
    ({ url }) => url.origin === 'https://fonts.googleapis.com',
    new StaleWhileRevalidate({
        cacheName: 'google-fonts-stylesheets',
        plugins: [
            new CacheableResponsePlugin({ statuses: [0, 200] }),
            new ExpirationPlugin({ maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 }), // 1 year
        ],
    }),
);

// Google Fonts webfonts — CacheFirst (font files rarely change)
registerRoute(
    ({ url }) => url.origin === 'https://fonts.gstatic.com',
    new CacheFirst({
        cacheName: 'google-fonts-webfonts',
        plugins: [
            new CacheableResponsePlugin({ statuses: [0, 200] }),
            new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 }), // 1 year
        ],
    }),
);

// Uploaded images — CacheFirst with expiration
registerRoute(
    ({ url }) => url.pathname.startsWith('/uploads/'),
    new CacheFirst({
        cacheName: 'uploads-cache',
        plugins: [
            new CacheableResponsePlugin({ statuses: [0, 200] }),
            new ExpirationPlugin({ maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 }), // 30 days
        ],
    }),
);

// ─── Offline Fallback for Navigation Requests ───

const navigationHandler = new NetworkFirst({
    cacheName: 'pages-cache',
    networkTimeoutSeconds: 5,
    plugins: [
        new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
});

const navRoute = new NavigationRoute(navigationHandler);
registerRoute(navRoute);

// Serve offline.html when any navigation request fails
setCatchHandler(async ({ request }) => {
    if (request.destination === 'document') {
        // B26: usar matchPrecache — o Workbox precacheia sob a chave revisionada
        // ('/offline.html?__WB_REVISION__=...'), então caches.match('/offline.html') (URL exata)
        // nunca batia e o usuário via o texto cru "Offline". matchPrecache resolve a cache-key certa.
        const cached = await matchPrecache('/offline.html');
        return cached ?? new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/html' } });
    }
    return Response.error();
});

// ─── Push Notification Handler ───
self.addEventListener('push', (event) => {
    if (!event.data) return;

    try {
        const data = event.data.json();
        const options: NotificationOptions = {
            body: data.message || '',
            // B27: PNG (não SVG) — o Chrome Android não renderiza SVG em ícone/badge de notificação.
            icon: '/icons/icon-192.png',
            badge: '/icons/icon-192.png',
            tag: data.tag || 'buzios-default',
            data: { url: data.actionUrl || '/' },
            requireInteraction: data.severity === 'critical',
        };

        event.waitUntil(
            self.registration.showNotification(
                data.title || 'Estúdio Búzios Digital',
                options,
            ),
        );
    } catch (err) {
        console.error('[SW] Push parse error:', err);
    }
});

// ─── Notification Click Handler ───
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data?.url || '/';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            // Focus existing window if any
            for (const client of clientList) {
                if (client.url.includes(self.location.origin) && 'focus' in client) {
                    client.focus();
                    client.navigate(url);
                    return;
                }
            }
            // Open new window
            return self.clients.openWindow(url);
        }),
    );
});

// ─── Auto-update ───
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
