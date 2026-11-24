// Callers that can degrade check `platform.isDesktop`; the rest get a readable rejection, never a hang.
import { NATIVE_INVOKE_CHANNELS } from '@/lib/remote/nativeChannels';

export interface NativeBridge {
  invoke(channel: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(channel: string, callback: (...args: unknown[]) => void): () => void;
}

export function nativeBridge(): NativeBridge | null {
  const w = window as unknown as { __omnifexNative?: NativeBridge };
  return w.__omnifexNative ?? null;
}

export function isNativeInvokeChannel(channel: string): boolean {
  return NATIVE_INVOKE_CHANNELS.includes(channel);
}

function unsupported(what: string): Promise<never> {
  return Promise.reject(new Error(`${what} is not available in the web client`));
}

/** Only http(s) may reach a browser: some URLs come from a remote server's metadata. */
function assertWebUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Unsafe protocol');
}

export interface BrowserInfo {
  bundleId: string;
  name: string;
}

export interface Platform {
  readonly isDesktop: boolean;
  showOpenDialog(options: Record<string, unknown>): Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog(options: Record<string, unknown>): Promise<{ canceled: boolean; filePath?: string }>;
  openExternal(url: string, opts?: { browser?: string }): Promise<void>;
  listBrowsers(): Promise<BrowserInfo[]>;
  openPath(path: string, cwd?: string): Promise<void>;
  revealInFinder(path: string): Promise<void>;

  /** False with no notification centre; a click comes back as `notification-clicked` carrying `id`. */
  showNotification(n: { title: string; body: string; id: string }): Promise<boolean>;

  getAppVersion(): Promise<string>;
  window: { minimize(): void; maximize(): void; close(): void };
}

export function createPlatform(bridge: NativeBridge | null): Platform {
  if (!bridge) {
    return {
      isDesktop: false,
      showOpenDialog: () => unsupported('The file dialog'),
      showSaveDialog: () => unsupported('The save dialog'),
      openExternal: async (url) => {
        assertWebUrl(url);
        window.open(url, '_blank', 'noopener,noreferrer');
      },
      listBrowsers: async () => [],
      openPath: () => unsupported('Opening a file'),
      revealInFinder: () => unsupported('Reveal in Finder'),
      showNotification: async () => false,
      getAppVersion: async () => 'web',
      window: { minimize() {}, maximize() {}, close() {} },
    };
  }
  return {
    isDesktop: true,
    showOpenDialog: (o) => bridge.invoke('dialog:open', o) as Promise<{ canceled: boolean; filePaths: string[] }>,
    showSaveDialog: (o) => bridge.invoke('dialog:save', o) as Promise<{ canceled: boolean; filePath?: string }>,
    // The Swift handler reads either a bare url string or `{url, browser}`.
    openExternal: async (url, opts) => {
      assertWebUrl(url);
      await bridge.invoke(
        'shell:openExternal',
        opts?.browser ? { url, browser: opts.browser } : url as unknown as Record<string, unknown>,
      );
    },
    listBrowsers: async () => {
      const list = await bridge.invoke('shell:listBrowsers');
      return Array.isArray(list) ? (list as BrowserInfo[]) : [];
    },
    openPath: (path, cwd) => bridge.invoke('open_path', cwd ? { path, cwd } : { path }).then(() => undefined),
    revealInFinder: (path) => bridge.invoke('reveal_path_in_finder', { path }).then(() => undefined),
    showNotification: (n) =>
      bridge.invoke('notify:show', { ...n, isError: false, tabId: null }).then(() => true),
    getAppVersion: () => bridge.invoke('get_app_version') as Promise<string>,
    window: {
      minimize: () => { void bridge.invoke('window:minimize'); },
      maximize: () => { void bridge.invoke('window:maximize'); },
      close: () => { void bridge.invoke('window:close'); },
    },
  };
}

export const platform: Platform = createPlatform(typeof window === 'undefined' ? null : nativeBridge());
