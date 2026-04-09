interface ElectronAPI {
  invoke: (channel: string, params?: Record<string, unknown>) => Promise<unknown>;
  onEvent: (channel: string, callback: (...args: unknown[]) => void) => () => void;
  showOpenDialog: (options: Record<string, unknown>) => Promise<unknown>;
  showSaveDialog: (options: Record<string, unknown>) => Promise<unknown>;
  openExternal: (url: string) => Promise<void>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
    // Legacy Tauri detection flag — retained for runtime guards in components
    // being migrated to Electron. Always undefined in Electron context.
    __TAURI__?: unknown;
  }
}

export {};
