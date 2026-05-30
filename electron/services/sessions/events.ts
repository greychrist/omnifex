// Sessions module — CLI event normalisation
//
// Maps a raw CLI message into a small tagged union the runtime can switch
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
 * - `init`: CLI announced a session id (catalog/account data captured). Main
 *   does NOT flip any conversation status — conversationStatus is derived by
 *   the renderer from JSONL content (see docs/session-lifecycle.md).
 * - `result`: turn complete; a notification should fire. No main-side status
 *   flip (the renderer derives 'idle'/'running' from the transcript).
 * - `rateLimit`: rate-limits service should be told.
 * - `compact`: CliCompactBoundaryMessage — the stream is pausing for
 *   conversation compaction. Status stays 'running'; UI may show a hint.
 * - `streamEvent`: CliPartialAssistantMessage — token-level partial
 *   delta, only emitted when `includePartialMessages` is true.
 * - `hook`: CLI hook lifecycle (hook_started / hook_progress /
 *   hook_response / user_prompt_submit). Fires on SessionStart BEFORE
 *   any user turn — forwarded to the renderer but no session-status
 *   event is emitted (conversationStatus derivation is the renderer's job).
 * - `turn`: anything else mid-turn (assistant text, tool_use, tool_result,
 *   non-hook system events, etc.).
 */
export type RuntimeEvent =
  | { kind: 'init'; sessionId: string | null }
  | { kind: 'result'; isError: boolean; body: string }
  | { kind: 'rateLimit'; info: RateLimitInfo }
  | { kind: 'compact'; trigger: 'manual' | 'auto' | null; preTokens: number | null }
  | { kind: 'streamEvent' }
  | { kind: 'hook' }
  | { kind: 'turn' };

const HOOK_LIFECYCLE_SUBTYPES: ReadonlySet<string> = new Set([
  'hook_started',
  'hook_progress',
  'hook_response',
  'user_prompt_submit',
]);

const BODY_MAX_LEN = 200;

function clip(s: string): string {
  return s.length > BODY_MAX_LEN ? s.slice(0, BODY_MAX_LEN) : s;
}

/**
 * Notification body when the CLI provides no `result`/`error`/`errors[0]`
 * string. The CLI distinguishes four error variants — surface that
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

  if (m.type === 'system' && typeof m.subtype === 'string' && HOOK_LIFECYCLE_SUBTYPES.has(m.subtype)) {
    return { kind: 'hook' };
  }

  if (m.type === 'system' && m.subtype === 'compact_boundary') {
    // CliCompactBoundaryMessage's `compact_metadata` shape — typed inline
    // because the CLI types aren't pulled in here (electron main process).
    const meta = m.compact_metadata as
      | { trigger?: 'manual' | 'auto'; pre_tokens?: number }
      | undefined;
    const rawTrigger = meta?.trigger;
    const trigger =
      rawTrigger === 'manual' || rawTrigger === 'auto' ? rawTrigger : null;
    const preTokens =
      typeof meta?.pre_tokens === 'number' ? meta.pre_tokens : null;
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
    // The CLI error variants carry an `errors: string[]` with actionable
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
