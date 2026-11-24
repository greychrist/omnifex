const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SessionIdValidation =
  | { ok: true; id: string }
  | { ok: false; error: string };

export function validateSessionId(raw: string): SessionIdValidation {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: 'Paste a session ID.' };
  const lower = trimmed.toLowerCase();
  if (!UUID_RE.test(lower)) {
    return {
      ok: false,
      error: "Doesn't look like a session ID — expected a GUID like 12345678-90ab-cdef-1234-567890abcdef.",
    };
  }
  return { ok: true, id: lower };
}
