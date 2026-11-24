/** Web only. Needs a secure origin and a user gesture: `enablePush()` is that gesture's handler. */

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

export function deepLinkedSessionId(hash: string = typeof location === 'undefined' ? '' : location.hash): string | null {
  const m = /[#&]session=([^&]+)/.exec(hash);
  return m ? decodeURIComponent(m[1]) : null;
}
