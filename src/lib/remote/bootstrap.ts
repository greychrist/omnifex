/** Decides once per page load what `window.electronAPI` is. Installs first, connects second; must run before anything calls `api.ts`. */
import { createServerClient, type ServerClient, type WebSocketFactory } from '@/lib/remote/serverClient';
import { createElectronApiShim } from '@/lib/remote/electronApiShim';
import { installNativeClipboard } from '@/lib/remote/nativeClipboard';
import type { NativeBridge } from '@/lib/platform';

export type RemoteMode = 'desktop' | 'web';

export interface RemoteBridgeInfo {
  mode: RemoteMode;
  url: string | null;
  client: ServerClient | null;
  /** Connectivity is global; delivery is per session. */
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
    const fresh = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
    localStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return `anon-${Math.random().toString(36).slice(2)}`;
  }
}

function webNotify(title: string, body: string): void {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
     
    new Notification(title, { body });
  } catch {
    // Notifications are best-effort everywhere.
  }
}

/** Web only, best-effort: an insecure origin refuses registration and the app still runs. */
function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch((err: unknown) => {
    console.info('[remote] service worker not registered:', err instanceof Error ? err.message : String(err));
  });
}

export interface InstallRemoteBridgeOptions {
  createSocket?: WebSocketFactory;
}

function setElectronApi(api: unknown): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
}

function pageSocketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

/** Falls back to the page's own origin, except on the dev server. */
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
