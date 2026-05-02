export async function apiCall<T>(command: string, params?: Record<string, unknown>): Promise<T> {
  return window.electronAPI.invoke(command, params) as Promise<T>;
}
