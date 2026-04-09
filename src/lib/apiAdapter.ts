export async function apiCall<T>(command: string, params?: Record<string, unknown>): Promise<T> {
  return window.electronAPI.invoke(command, params) as Promise<T>;
}

// Legacy stubs — retained for import compatibility while components are migrated.
// These are no-ops in the Electron context.
export function initializeWebMode(): void {
  // no-op in Electron
}

export function getEnvironmentInfo(): { isTauri: boolean; userAgent: string; location: string } {
  return {
    isTauri: false,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    location: typeof window !== 'undefined' ? window.location.href : '',
  };
}
