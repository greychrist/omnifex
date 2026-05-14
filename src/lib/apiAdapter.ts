/**
 * Thin transport layer for `window.electronAPI.invoke`.
 *
 * The main process IPC layer encodes structured error codes as a `[CODE] `
 * prefix on `error.message` (custom Error properties are stripped by
 * Electron's structured-clone serialization). We strip that prefix here and
 * re-attach it as `error.code` so call sites can branch on stable codes
 * (e.g. `error.code === 'NO_ACCOUNT_FOR_PROJECT'`) instead of substring
 * matching the message.
 */
export async function apiCall<T>(command: string, params?: Record<string, unknown>): Promise<T> {
  try {
    return await (window.electronAPI.invoke(command, params) as Promise<T>);
  } catch (err) {
    throw decodeApiError(err);
  }
}

const CODE_PREFIX_RE = /^(?:Error invoking remote method '[^']+': )?\[([A-Z][A-Z0-9_]+)\]\s*/;

function decodeApiError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const match = CODE_PREFIX_RE.exec(err.message);
  if (!match) return err;
  const code = match[1];
  const cleaned = err.message.slice(match[0].length);
  const out = new Error(cleaned) as Error & { code: string };
  out.name = err.name;
  out.stack = err.stack;
  out.code = code;
  return out;
}
