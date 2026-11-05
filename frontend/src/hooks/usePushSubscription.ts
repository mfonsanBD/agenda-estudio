import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
// A marca da sessão e o desligamento no logout (NS-4, unregisterPushOnThisDevice) ficam em utils/pushDevice.ts.
import { PUSH_REGISTERED_KEY } from '../utils/pushDevice';

/**
 * Automatically subscribes the user to push notifications
 * when they are authenticated and the browser supports it.
 * Runs once per session (tracked via sessionStorage).
 */
export function usePushSubscription() {
    const { user } = useAuth();
    const attempted = useRef(false);

    useEffect(() => {
        if (!user || attempted.current) return;
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

        // Skip if already registered in this session
        const alreadyRegistered = sessionStorage.getItem(PUSH_REGISTERED_KEY);
        if (alreadyRegistered === user.id) return;

        attempted.current = true;

        (async () => {
            try {
                // 1. Get VAPID public key from backend
                const vapidRes = await fetch('/api/push/vapid-key');
                const { publicKey } = await vapidRes.json();
                if (!publicKey) return;

                // 2. Wait for service worker to be ready
                const registration = await navigator.serviceWorker.ready;

                // 3. Check existing subscription
                let subscription = await registration.pushManager.getSubscription();

                if (!subscription) {
                    // 4. Request permission
                    const permission = await Notification.requestPermission();
                    if (permission !== 'granted') {
                        console.log('[PUSH] Permission denied by user');
                        return;
                    }

                    // 5. Subscribe to push manager
                    const applicationServerKey = urlBase64ToUint8Array(publicKey);
                    subscription = await registration.pushManager.subscribe({
                        userVisibleOnly: true,
                        applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
                    });
                }

                // 6. Send subscription to backend
                const res = await fetch('/api/push/subscribe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({
                        endpoint: subscription.endpoint,
                        keys: {
                            p256dh: arrayBufferToBase64(subscription.getKey('p256dh')!),
                            auth: arrayBufferToBase64(subscription.getKey('auth')!),
                        },
                    }),
                });

                if (res.ok) {
                    sessionStorage.setItem(PUSH_REGISTERED_KEY, user.id);
                    console.log('[PUSH] Subscription registered successfully');
                }
            } catch (err) {
                console.error('[PUSH] Subscription error:', err);
            }
        })();
    }, [user]);
}

/** Convert VAPID base64 public key to Uint8Array for PushManager */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

/** Convert ArrayBuffer to base64 string */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
