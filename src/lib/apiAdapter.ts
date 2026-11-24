/** Errors carry a `[CODE] ` message prefix (custom Error properties do not cross IPC); re-attached as `error.code`. */
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
