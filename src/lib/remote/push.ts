/**
 * Web Push, client side. Web only — Electron has native notifications.
 *
 * Needs a secure origin (the `tailscale serve` HTTPS front from Phase 4) and
 * a user gesture to ask for permission. `enablePush()` is that gesture's
 * handler: ask, subscribe with the daemon's VAPID key, POST the subscription.
 */

export type PushSupport = 'unsupported' | 'insecure' | 'denied' | 'default' | 'granted';

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  return Notification.permission;
}

function base64UrlToUint8Array(s: string): Uint8Array {
  const padding = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

/** Ask, subscribe, register with the daemon. Resolves to the final permission. */
export async function enablePush(): Promise<PushSupport> {
  const support = pushSupport();
  if (support !== 'default' && support !== 'granted') return support;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;

  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = (await (await fetch('/api/push/vapid-public-key')).json()) as { publicKey: string };
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(publicKey) as BufferSource }));
  await postJson('/api/push/subscribe', { ...sub.toJSON(), label: navigator.userAgent.slice(0, 80) });
  return 'granted';
}

export async function disablePush(): Promise<void> {
  if (pushSupport() === 'unsupported') return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await postJson('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

/** `#session=<id>` in the URL — what a notification tap lands on. */
export function deepLinkedSessionId(hash: string = typeof location === 'undefined' ? '' : location.hash): string | null {
  const m = /[#&]session=([^&]+)/.exec(hash);
  return m ? decodeURIComponent(m[1]) : null;
}
