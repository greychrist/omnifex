import type { JsonlNode } from '@/types/jsonl';

/**
 * Live, never-persisted progress for in-flight tool calls.
 *
 * The CLI emits `type: "tool_progress"` on the stream-json stdout path only —
 * it is absent from every transcript on disk — so this is an overlay channel
 * like `stream-event`, reduced into a per-tab map and read at render time.
 * Nothing here ever reaches `messages[]`.
 */

export type ToolProgressNode = Extract<JsonlNode, { kind: 'tool-progress' }>;

export interface ToolProgressRetry {
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  /** HTTP status that triggered the retry, or null when the CLI had none. */
  errorStatus: number | null;
  errorCategory: string;
}

export interface ToolProgressEntry {
  /** `elapsed_time_seconds` from the newest frame. */
  elapsedSeconds: number;
  /** Wall clock when that frame arrived, so a chip can interpolate between the
   *  CLI's 30-second beats instead of jumping by half-minutes. */
  arrivedAtMs: number;
  retry: ToolProgressRetry | null;
}

export type ToolProgressMap = ReadonlyMap<string, ToolProgressEntry>;

export const EMPTY_TOOL_PROGRESS: ToolProgressMap = new Map<string, ToolProgressEntry>();

const HEARTBEAT_SUFFIX = /-heartbeat-\d+$/;

/**
 * The real tool_use id a progress frame belongs to.
 *
 * The CLI mints a synthetic id per beat (`${toolUseID}-heartbeat-${n++}`) and
 * sets `parent_tool_use_id` to `Se.parentToolUseID ?? n`, which resolves to the
 * enclosing Task id for a tool running inside a subagent. Stripping the suffix
 * is the only rule that is correct in both the nested and top-level cases.
 */
export function anchorToolUseId(toolUseId: string): string {
  return toolUseId.replace(HEARTBEAT_SUFFIX, '');
}

function sameRetry(a: ToolProgressRetry | null, b: ToolProgressRetry | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.attempt === b.attempt &&
    a.maxRetries === b.maxRetries &&
    a.retryDelayMs === b.retryDelayMs &&
    a.errorStatus === b.errorStatus &&
    a.errorCategory === b.errorCategory
  );
}

/**
 * Fold one frame into the per-tab map.
 *
 * Pure, idempotent, and reference-stable: a frame that changes nothing returns
 * `prev` itself, so a duplicate delivery — a remote client's reconnect replay,
 * say — cannot cost a render.
 */
export function reduceToolProgress(
  prev: ToolProgressMap,
  node: ToolProgressNode,
  nowMs: number,
): ToolProgressMap {
  const key = node.anchorToolUseId;
  const existing = prev.get(key);
  const raw = node.raw;

  // A retry frame is the only thing that speaks about `retry`. A heartbeat
  // leaves whatever is there alone: the two channels interleave, and a beat
  // arriving mid-retry must not report the retry as resolved.
  let retry: ToolProgressRetry | null = existing?.retry ?? null;
  if (raw.subagent_retry) {
    const r = raw.subagent_retry;
    retry = {
      attempt: r.attempt,
      maxRetries: r.max_retries,
      retryDelayMs: r.retry_delay_ms,
      errorStatus: r.error_status,
      errorCategory: r.error_category,
    };
  } else if (raw.subagent_type !== undefined) {
    // `subagent_type` with no `subagent_retry` IS the CLI's resolved signal —
    // the emitter spreads `...resolved !== true && { subagent_retry }`.
    retry = null;
  }

  const elapsedSeconds = raw.elapsed_time_seconds;
  if (
    existing &&
    existing.elapsedSeconds === elapsedSeconds &&
    existing.arrivedAtMs === nowMs &&
    sameRetry(existing.retry, retry)
  ) {
    return prev;
  }

  const next = new Map(prev);
  next.set(key, { elapsedSeconds, arrivedAtMs: nowMs, retry });
  return next;
}

/**
 * Drop every entry whose tool is no longer of interest.
 *
 * Called with an empty keep set at turn end — a finished turn has no running
 * tools. Hygiene, not correctness: the chip already refuses to paint progress
 * for a tool whose result has landed, so a stale entry is invisible either way.
 */
export function pruneToolProgress(
  prev: ToolProgressMap,
  keepIds: Set<string>,
): ToolProgressMap {
  let dropped = false;
  for (const key of prev.keys()) {
    if (!keepIds.has(key)) {
      dropped = true;
      break;
    }
  }
  if (!dropped) return prev;
  const next = new Map<string, ToolProgressEntry>();
  for (const [key, value] of prev) {
    if (keepIds.has(key)) next.set(key, value);
  }
  return next;
}
