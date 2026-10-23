/**
 * Decide, once per page load, what `window.electronAPI` is. (The name is the
 * Electron era's; every call site uses it, so it stayed.)
 *
 *  - Desktop (the native app's bridge is present) → the shim over a
 *    WebSocket to the daemon the app started, with the bridge kept as
 *    `window.__omnifexNative` for the channels only the app can serve.
 *  - Web (no bridge)                               → the shim over
 *    `ws(s)://<this host>/ws`. The daemon served the page, so the daemon is
 *    where the socket goes.
 *
 * Both install first and connect second: there is no other transport to fall
 * back to — the in-process mode went with Electron — and the shim queues
 * requests while the socket comes up. A daemon that is down shows as the
 * connection banner, and the client keeps retrying.
 *
 * Must run before anything imports `api.ts` at module scope and calls it —
 * `main.tsx` awaits this before booting React.
 */
import { createServerClient, type ServerClient, type WebSocketFactory } from '@/lib/remote/serverClient';
import { createElectronApiShim } from '@/lib/remote/electronApiShim';
import { installNativeClipboard } from '@/lib/remote/nativeClipboard';
import type { NativeBridge } from '@/lib/platform';

export type RemoteMode = 'desktop' | 'web';

export interface RemoteBridgeInfo {
  mode: RemoteMode;
  url: string | null;
  client: ServerClient | null;
  /** Whether a session's events are actually being delivered to this
   *  client. Connectivity is global, delivery is not. */
  isSessionSubscribed?: (sessionId: string) => boolean;
}

declare global {
  interface Window {
    __omnifexNative?: NativeBridge;
    __omnifexRemote?: RemoteBridgeInfo;
  }
}

function clientId(): string {
  const key = 'omnifex.remote.clientId';
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const fresh = `${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    localStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return `anon-${Math.random().toString(36).slice(2)}`;
  }
}

function webNotify(title: string, body: string): void {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    // eslint-disable-next-line no-new -- the constructor is the API
    new Notification(title, { body });
  } catch {
    // Notifications are best-effort everywhere.
  }
}

/**
 * Web only. The worker exists so Safari's Add to Home Screen yields a real
 * standalone app; it caches nothing (see web/public/sw.js). Registration is
 * best-effort — an insecure origin (plain http on the tailnet, before
 * `tailscale serve` is set up) refuses it, and the app still runs.
 */
function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch((err: unknown) => {
    console.info('[remote] service worker not registered:', err instanceof Error ? err.message : String(err));
  });
}

export interface InstallRemoteBridgeOptions {
  /** Test seam; defaults to the global `WebSocket`. */
  createSocket?: WebSocketFactory;
}

function setElectronApi(api: unknown): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
}

/** The daemon's socket on the host that served this page. */
function pageSocketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

/**
 * Where the native app says its daemon is. It started the daemon and served
 * this page from it, so the page's own origin is the right answer whenever
 * the app cannot give one; the dev server is the one origin that is not.
 */
async function desktopSocketUrl(native: NativeBridge): Promise<string> {
  try {
    const url = (await native.invoke('remote:url')) as string | null;
    if (url) return url;
  } catch (err) {
    console.warn('[remote] remote:url failed; using the page origin', err);
  }
  return pageSocketUrl();
}

export async function installRemoteBridge(opts: InstallRemoteBridgeOptions = {}): Promise<RemoteBridgeInfo> {
  const native: NativeBridge | null = window.__omnifexNative ?? null;
  const mode: RemoteMode = native ? 'desktop' : 'web';
  const url = native ? await desktopSocketUrl(native) : pageSocketUrl();

  const client = createServerClient({ url, clientId: clientId(), clientKind: mode, createSocket: opts.createSocket });
  const shim = createElectronApiShim({ client, native, ...(native ? {} : { webNotify }) });
  setElectronApi(shim);
  client.connect().catch((err: unknown) => {
    console.warn('[remote] initial connect failed; will keep retrying', err);
  });
  if (native) installNativeClipboard(native);
  else registerServiceWorker();

  const info: RemoteBridgeInfo = {
    mode, url, client,
    isSessionSubscribed: (id) => shim.isSessionSubscribed(id),
  };
  window.__omnifexRemote = info;
  console.info(`[remote] mode=${info.mode} url=${url}`);
  return info;
}
