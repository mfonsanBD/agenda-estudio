// ─── Inscrição de push deste aparelho ───
// Fora do hook usePushSubscription para o AuthContext poder usar sem importação circular
// (o hook importa o useAuth).

/** Marca da sessão (sessionStorage): id do usuário cuja inscrição já foi enviada ao servidor nesta aba. */
export const PUSH_REGISTERED_KEY = 'push-subscription-registered';

/** Teto do desligamento: sair nunca fica preso esperando o service worker ou a rede. */
const UNREGISTER_TIMEOUT_MS = 1500;

/**
 * NS-4: desvincula a inscrição de push DESTE aparelho (computador de recepção compartilhado: os avisos
 * de quem saiu não podem continuar aparecendo na tela). Best-effort, nunca lança, no máximo ~1,5 s.
 *  - `server: true` (logout normal, com a sessão ainda válida): DELETE /api/push/unsubscribe para apagar
 *    a linha agora — chamar ANTES do /auth/logout, porque a rota exige a sessão;
 *  - sempre: `subscription.unsubscribe()` no navegador — o serviço de push passa a responder 404/410 e o
 *    servidor apaga a linha no próximo envio (pushService), mesmo quando o DELETE não foi possível
 *    (sessão já encerrada ou desativada);
 *  - limpa a marca da sessão, para o próximo login (inclusive da mesma pessoa) inscrever de novo. Com a
 *    permissão de notificação já concedida, o navegador não pergunta outra vez.
 */
export async function unregisterPushOnThisDevice({ server }: { server: boolean }): Promise<void> {
    try { sessionStorage.removeItem(PUSH_REGISTERED_KEY); } catch { /* ignore */ }
    try {
        if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
        const work = (async () => {
            // getRegistration (e não `ready`): sem service worker registrado, `ready` nunca resolve.
            const registration = await navigator.serviceWorker.getRegistration();
            const subscription = await registration?.pushManager.getSubscription();
            if (!subscription) return;
            if (server) {
                await fetch('/api/push/unsubscribe', {
                    method: 'DELETE',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ endpoint: subscription.endpoint }),
                }).catch(() => undefined);
            }
            await subscription.unsubscribe().catch(() => false);
        })().catch(() => undefined);
        await Promise.race([work, new Promise<void>(resolve => setTimeout(resolve, UNREGISTER_TIMEOUT_MS))]);
    } catch { /* ignore */ }
}
