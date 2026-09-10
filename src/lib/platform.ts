/**
 * The platform seam: everything the renderer needs from the machine it is
 * running ON, as opposed to the machine the sessions run on.
 *
 * In Electron those are the same machine and the preload bridge answers. In
 * Safari on the iPad there is no bridge, and each capability is either
 * approximated (`openExternal` → `window.open`) or honestly unsupported
 * (there is no Finder to reveal a path in). Callers that can degrade should
 * check `platform.isElectron` first; callers that cannot get a rejection with
 * a readable message rather than a hang.
 *
 * Implementation note: the existing `api.ts` wrappers keep working unchanged,
 * because the remote shim routes these channels to the native bridge itself.
 * This module is the typed front door for new code and the one place that
 * knows which channels are native.
 */
import { NATIVE_INVOKE_CHANNELS } from '@/lib/remote/nativeChannels';

/** What the preload exposes. Absent on the web. */
export interface NativeBridge {
  invoke(channel: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(channel: string, callback: (...args: unknown[]) => void): () => void;
}

export function nativeBridge(): NativeBridge | null {
  const w = window as unknown as { __omnifexNative?: NativeBridge; electronAPI?: NativeBridge };
  // The preload publishes the same object under both names; `__omnifexNative`
  // is the one that survives the shim replacing `electronAPI`.
  return w.__omnifexNative ?? null;
}

export function isNativeInvokeChannel(channel: string): boolean {
  return NATIVE_INVOKE_CHANNELS.includes(channel);
}

function unsupported(what: string): Promise<never> {
  return Promise.reject(new Error(`${what} is not available in the web client`));
}

export interface Platform {
  readonly isElectron: boolean;
  showOpenDialog(options: Record<string, unknown>): Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog(options: Record<string, unknown>): Promise<{ canceled: boolean; filePath?: string }>;
  openExternal(url: string): Promise<void>;
  revealInFinder(path: string): Promise<void>;
  /** Persist pasted image bytes to a temp file the CLI can read; Electron only. */
  savePastedImage(dataUrl: string): Promise<string>;
  getAppVersion(): Promise<string>;
  window: { minimize(): void; maximize(): void; close(): void };
}

export function createPlatform(bridge: NativeBridge | null): Platform {
  if (!bridge) {
    return {
      isElectron: false,
      showOpenDialog: () => unsupported('The file dialog'),
      showSaveDialog: () => unsupported('The save dialog'),
      openExternal: async (url) => {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Unsafe protocol');
        window.open(url, '_blank', 'noopener,noreferrer');
      },
      revealInFinder: () => unsupported('Reveal in Finder'),
      savePastedImage: () => unsupported('Saving a pasted image to disk'),
      getAppVersion: async () => 'web',
      window: { minimize() {}, maximize() {}, close() {} },
    };
  }
  return {
    isElectron: true,
    showOpenDialog: (o) => bridge.invoke('dialog:open', o) as Promise<{ canceled: boolean; filePaths: string[] }>,
    showSaveDialog: (o) => bridge.invoke('dialog:save', o) as Promise<{ canceled: boolean; filePath?: string }>,
    openExternal: (url) => bridge.invoke('shell:openExternal', { url } as unknown as Record<string, unknown>).then(() => undefined),
    revealInFinder: (path) => bridge.invoke('reveal_path_in_finder', { path }).then(() => undefined),
    savePastedImage: (dataUrl) => bridge.invoke('save_pasted_image', { dataUrl }) as Promise<string>,
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
