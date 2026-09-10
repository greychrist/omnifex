/**
 * Decide, once per page load, what `window.electronAPI` is.
 *
 *  - Electron, daemon reachable  → the remote shim over a WebSocket; the
 *    preload bridge stays available as `window.__omnifexNative` for the
 *    channels only Electron can serve.
 *  - Electron, no daemon         → leave the preload bridge in place. This is
 *    the pre-split app, unchanged. `remote:url` answers null when the daemon
 *    is disabled (`OMNIFEX_REMOTE=0`, `remote.enabled=false`) or failed to
 *    start, so nothing about the laptop experience depends on the daemon
 *    being healthy.
 *  - Web (no preload)            → the shim over `ws(s)://<this host>/ws`.
 *    The daemon served the page, so the daemon is where the socket goes.
 *
 * Must run before anything imports `api.ts` at module scope and calls it —
 * `main.tsx` awaits this before booting React.
 */
import { createServerClient, type ServerClient } from '@/lib/remote/serverClient';
import { createElectronApiShim } from '@/lib/remote/electronApiShim';
import type { NativeBridge } from '@/lib/platform';

export type RemoteMode = 'electron-legacy' | 'electron-remote' | 'web';

export interface RemoteBridgeInfo {
  mode: RemoteMode;
  url: string | null;
  client: ServerClient | null;
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

export async function installRemoteBridge(opts: { connectTimeoutMs?: number } = {}): Promise<RemoteBridgeInfo> {
  const connectTimeoutMs = opts.connectTimeoutMs ?? 8_000;
  const native: NativeBridge | null =
    window.__omnifexNative ?? ((window as unknown as { electronAPI?: NativeBridge }).electronAPI ?? null);

  let info: RemoteBridgeInfo;

  if (native) {
    let url: string | null = null;
    try {
      url = (await native.invoke('remote:url')) as string | null;
    } catch (err) {
      console.warn('[remote] remote:url failed; staying on legacy IPC', err);
    }
    if (!url) {
      info = { mode: 'electron-legacy', url: null, client: null };
    } else {
      const client = createServerClient({ url, clientId: clientId(), clientKind: 'electron' });
      try {
        await withTimeout(client.connect(), connectTimeoutMs, 'daemon handshake');
        (window as unknown as { electronAPI: unknown }).electronAPI = createElectronApiShim({ client, native });
        info = { mode: 'electron-remote', url, client };
      } catch (err) {
        console.warn('[remote] daemon handshake failed; staying on legacy IPC', err);
        client.disconnect();
        info = { mode: 'electron-legacy', url, client: null };
      }
    }
  } else {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    const client = createServerClient({ url, clientId: clientId(), clientKind: 'web' });
    // Install first, connect second: on the web there is nothing to fall back
    // to, and the shim queues requests while the socket comes up.
    (window as unknown as { electronAPI: unknown }).electronAPI = createElectronApiShim({ client, native: null, webNotify });
    client.connect().catch((err: unknown) => {
      console.warn('[remote] initial connect failed; will keep retrying', err);
    });
    info = { mode: 'web', url, client };
  }

  window.__omnifexRemote = info;
  console.info(`[remote] mode=${info.mode}${info.url ? ` url=${info.url}` : ''}`);
  return info;
}
