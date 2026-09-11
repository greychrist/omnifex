/**
 * Decide, once per page load, what `window.electronAPI` is.
 *
 *  - Electron, daemon reachable  → the remote shim over a WebSocket; the
 *    preload bridge stays available as `window.__omnifexNative` for the
 *    channels only Electron can serve.
 *  - Electron, no daemon         → the preload bridge itself. This is the
 *    pre-split app, unchanged. `remote:url` answers null when the daemon is
 *    disabled (`OMNIFEX_REMOTE=0`, `remote.enabled=false`) or failed to
 *    start, so nothing about the laptop experience depends on the daemon
 *    being healthy.
 *  - Web (no preload)            → the shim over `ws(s)://<this host>/ws`.
 *    The daemon served the page, so the daemon is where the socket goes.
 *
 * The preload publishes the bridge as `__omnifexNative` only, and this is the
 * one place `window.electronAPI` is defined. contextBridge properties are
 * read-only and undeletable, so had the preload defined `electronAPI`, the
 * shim could never take its place (it tried, threw, and the app quietly ran
 * legacy IPC forever). The bridge is installed as `electronAPI` on the first
 * line — before the daemon is probed — so a failure anywhere below leaves a
 * working app, not an undefined one.
 *
 * Must run before anything imports `api.ts` at module scope and calls it —
 * `main.tsx` awaits this before booting React.
 */
import { createServerClient, type ServerClient, type WebSocketFactory } from '@/lib/remote/serverClient';
import { localModeForced } from '@/lib/remote/localMode';
import { createElectronApiShim } from '@/lib/remote/electronApiShim';
import type { NativeBridge } from '@/lib/platform';

export type RemoteMode = 'electron-legacy' | 'electron-remote' | 'web';

export interface RemoteBridgeInfo {
  mode: RemoteMode;
  url: string | null;
  client: ServerClient | null;
  /**
   * Legacy because the user asked for it, not because no daemon answered.
   * The two look identical from here and need opposite things on screen: one
   * offers a way back, the other has nothing to go back to.
   */
  forcedLocal: boolean;
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

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface InstallRemoteBridgeOptions {
  connectTimeoutMs?: number;
  /** Test seam; defaults to the global `WebSocket`. */
  createSocket?: WebSocketFactory;
}

function setElectronApi(api: unknown): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
}

export async function installRemoteBridge(opts: InstallRemoteBridgeOptions = {}): Promise<RemoteBridgeInfo> {
  const connectTimeoutMs = opts.connectTimeoutMs ?? 8_000;
  const native: NativeBridge | null = window.__omnifexNative ?? null;

  let info: RemoteBridgeInfo;

  if (native) {
    setElectronApi(native);
    // Honoured before anything is probed. `remote:url` STARTS a daemon when
    // none is running, so asking would resurrect the process the user just
    // chose to step away from — see localMode.ts.
    if (localModeForced()) {
      window.__omnifexRemote = { mode: 'electron-legacy', url: null, client: null, forcedLocal: true };
      console.info('[remote] mode=electron-legacy (forced by the user)');
      return window.__omnifexRemote;
    }
    let url: string | null = null;
    try {
      url = (await native.invoke('remote:url')) as string | null;
    } catch (err) {
      console.warn('[remote] remote:url failed; staying on legacy IPC', err);
    }
    if (!url) {
      info = { mode: 'electron-legacy', url: null, client: null, forcedLocal: false };
    } else {
      const client = createServerClient({ url, clientId: clientId(), clientKind: 'electron', createSocket: opts.createSocket });
      try {
        await withTimeout(client.connect(), connectTimeoutMs, 'daemon handshake');
        setElectronApi(createElectronApiShim({ client, native }));
        info = { mode: 'electron-remote', url, client, forcedLocal: false };
      } catch (err) {
        console.warn('[remote] daemon handshake failed; staying on legacy IPC', err);
        client.disconnect();
        info = { mode: 'electron-legacy', url, client: null, forcedLocal: false };
      }
    }
  } else {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    const client = createServerClient({ url, clientId: clientId(), clientKind: 'web', createSocket: opts.createSocket });
    // Install first, connect second: on the web there is nothing to fall back
    // to, and the shim queues requests while the socket comes up.
    setElectronApi(createElectronApiShim({ client, native: null, webNotify }));
    client.connect().catch((err: unknown) => {
      console.warn('[remote] initial connect failed; will keep retrying', err);
    });
    info = { mode: 'web', url, client, forcedLocal: false };
    registerServiceWorker();
  }

  window.__omnifexRemote = info;
  console.info(`[remote] mode=${info.mode}${info.url ? ` url=${info.url}` : ''}`);
  return info;
}
