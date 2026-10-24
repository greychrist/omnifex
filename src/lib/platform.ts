/**
 * The platform seam: everything the renderer needs from the machine it is
 * running ON, as opposed to the machine the sessions run on.
 *
 * In the Mac app those are the same machine and its native bridge answers.
 * In Safari on the iPad there is no bridge, and each capability is either
 * approximated (`openExternal` → `window.open`) or honestly unsupported
 * (there is no Finder to reveal a path in). Callers that can degrade should
 * check `platform.isDesktop` first; callers that cannot get a rejection with
 * a readable message rather than a hang.
 *
 * Implementation note: the existing `api.ts` wrappers keep working unchanged,
 * because the remote shim routes these channels to the native bridge itself.
 * This module is the typed front door for new code and the one place that
 * knows which channels are native.
 */
import { NATIVE_INVOKE_CHANNELS } from '@/lib/remote/nativeChannels';

/** What the native app injects. Absent on the web. */
export interface NativeBridge {
  invoke(channel: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(channel: string, callback: (...args: unknown[]) => void): () => void;
}

export function nativeBridge(): NativeBridge | null {
  const w = window as unknown as { __omnifexNative?: NativeBridge };
  // The app publishes the bridge under this name only; `electronAPI` is
  // what bootstrap installed (the remote shim).
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
  /** Open a web link. `browser` (a bundle id) picks the browser on the Mac;
   *  a web client has no say and opens a tab. */
  openExternal(url: string, opts?: { browser?: string }): Promise<void>;
  /** Browsers installed on the Mac, for choosing where sign-in links go.
   *  Empty on a web client. */
  listBrowsers(): Promise<BrowserInfo[]>;
  /** Open a file in its default app; a relative path resolves against `cwd`. */
  openPath(path: string, cwd?: string): Promise<void>;
  revealInFinder(path: string): Promise<void>;

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
      getAppVersion: async () => 'web',
      window: { minimize() {}, maximize() {}, close() {} },
    };
  }
  return {
    isDesktop: true,
    showOpenDialog: (o) => bridge.invoke('dialog:open', o) as Promise<{ canceled: boolean; filePaths: string[] }>,
    showSaveDialog: (o) => bridge.invoke('dialog:save', o) as Promise<{ canceled: boolean; filePath?: string }>,
    // A bare url string, or `{url, browser}` when a browser is chosen — the
    // Swift handler reads either.
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
    getAppVersion: () => bridge.invoke('get_app_version') as Promise<string>,
    window: {
      minimize: () => { void bridge.invoke('window:minimize'); },
      maximize: () => { void bridge.invoke('window:maximize'); },
      close: () => { void bridge.invoke('window:close'); },
    },
  };
}

/** Resolved once per page load; safe to import from anywhere in the renderer. */
export const platform: Platform = createPlatform(typeof window === 'undefined' ? null : nativeBridge());
