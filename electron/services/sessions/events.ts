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
 * - `compact`: SDKCompactBoundaryMessage — the stream is pausing for
 *   conversation compaction. Status stays 'running'; UI may show a hint.
 * - `streamEvent`: SDKPartialAssistantMessage — token-level partial
 *   delta, only emitted when `includePartialMessages` is true.
 * - `turn`: anything else mid-turn (assistant text, tool_use, tool_result,
 *   hook events, etc.). Status flips to 'running'.
 */
export type RuntimeEvent =
  | { kind: 'init'; sessionId: string | null }
  | { kind: 'result'; isError: boolean; body: string }
  | { kind: 'rateLimit'; info: RateLimitInfo }
  | { kind: 'compact'; trigger: 'manual' | 'auto' | null; preTokens: number | null }
  | { kind: 'streamEvent' }
  | { kind: 'turn' };

const BODY_MAX_LEN = 200;

function clip(s: string): string {
  return s.length > BODY_MAX_LEN ? s.slice(0, BODY_MAX_LEN) : s;
}

/**
 * Notification body when the SDK provides no `result`/`error`/`errors[0]`
 * string. The SDK distinguishes four error variants — surface that
 * distinction so the user knows whether they hit a turn cap, a budget cap,
 * a runtime explosion, or a structured-output retry exhaustion.
 */
function defaultBodyForResultSubtype(subtype: string, isError: boolean): string {
  if (!isError) return 'Task complete';
  switch (subtype) {
    case 'error_max_turns':
      return 'Hit max turns for this task';
    case 'error_max_budget_usd':
      return 'Hit budget (max cost) for this task';
    case 'error_during_execution':
      return 'Error during execution';
    case 'error_max_structured_output_retries':
      return 'Failed structured-output retries';
    default:
      return 'Task failed';
  }
}

export function classifyRuntimeEvent(raw: unknown): RuntimeEvent {
  if (!raw || typeof raw !== 'object') return { kind: 'turn' };
  const m = raw as Record<string, unknown>;

  if (m.type === 'system' && m.subtype === 'init') {
    const sid = typeof m.session_id === 'string' ? (m.session_id) : null;
    return { kind: 'init', sessionId: sid };
  }

  if (m.type === 'system' && m.subtype === 'compact_boundary') {
    const meta = (m.compact_metadata ?? null);
    const rawTrigger = meta?.trigger;
    const trigger =
      rawTrigger === 'manual' || rawTrigger === 'auto' ? rawTrigger : null;
    const preTokens =
      typeof meta?.pre_tokens === 'number' ? (meta.pre_tokens) : null;
    return { kind: 'compact', trigger, preTokens };
  }

  if (m.type === 'stream_event') {
    return { kind: 'streamEvent' };
  }

  if (m.type === 'result') {
    const subtype = typeof m.subtype === 'string' ? (m.subtype) : '';
    const isError =
      m.is_error === true ||
      subtype === 'error' ||
      subtype.startsWith('error_');
    const result = typeof m.result === 'string' ? (m.result) : null;
    const error = typeof m.error === 'string' ? (m.error) : null;
    // The SDK error variants carry an `errors: string[]` with actionable
    // text (e.g. "Context window exceeded"). Prefer the first entry over a
    // generic "Task failed" so the notification body actually tells the
    // user what went wrong.
    const errorsArr = Array.isArray(m.errors)
      ? (m.errors as unknown[]).filter((e): e is string => typeof e === 'string')
      : [];
    const firstError = errorsArr.length > 0 ? errorsArr[0] : null;
    const body = clip(
      result ?? error ?? firstError ?? defaultBodyForResultSubtype(subtype, isError),
    );
    return { kind: 'result', isError, body };
  }

  if (m.type === 'rate_limit_event') {
    const info = m.rate_limit_info as RateLimitInfo | undefined;
    if (info) return { kind: 'rateLimit', info };
    return { kind: 'turn' };
  }

  return { kind: 'turn' };
}
