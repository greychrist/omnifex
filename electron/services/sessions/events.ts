// Sessions module — SDK event normalisation
//
// Maps a raw SDK message into a small tagged union the runtime can switch
// on. Keeps `(message as any)` casts contained here instead of scattered
// across the FSM.

export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
  surpassedThreshold?: number;
}

/**
 * Categorisation the session runtime cares about.
 *
 * - `init`: SDK announced a session id; status flips to 'idle'.
 * - `result`: turn complete; status flips to 'idle' and a notification
 *   should fire.
 * - `rateLimit`: rate-limits service should be told.
 * - `turn`: anything else mid-turn (assistant text, tool_use, tool_result,
 *   hook events, compact_boundary, etc.). Status flips to 'running'.
 */
export type RuntimeEvent =
  | { kind: 'init'; sessionId: string | null }
  | { kind: 'result'; isError: boolean; body: string }
  | { kind: 'rateLimit'; info: RateLimitInfo }
  | { kind: 'turn' };

const BODY_MAX_LEN = 200;

function clip(s: string): string {
  return s.length > BODY_MAX_LEN ? s.slice(0, BODY_MAX_LEN) : s;
}

export function classifyRuntimeEvent(raw: unknown): RuntimeEvent {
  if (!raw || typeof raw !== 'object') return { kind: 'turn' };
  const m = raw as Record<string, unknown>;

  if (m.type === 'system' && m.subtype === 'init') {
    const sid = typeof m.session_id === 'string' ? (m.session_id as string) : null;
    return { kind: 'init', sessionId: sid };
  }

  if (m.type === 'result') {
    const isError =
      m.is_error === true ||
      (typeof m.subtype === 'string' && m.subtype === 'error');
    const result = typeof m.result === 'string' ? (m.result as string) : null;
    const error = typeof m.error === 'string' ? (m.error as string) : null;
    const body = clip(result ?? error ?? (isError ? 'Task failed' : 'Task complete'));
    return { kind: 'result', isError, body };
  }

  if (m.type === 'rate_limit_event') {
    const info = m.rate_limit_info as RateLimitInfo | undefined;
    if (info) return { kind: 'rateLimit', info };
    return { kind: 'turn' };
  }

  return { kind: 'turn' };
}
