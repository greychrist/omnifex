import type { JsonlNode } from '@/types/jsonl';

// tool_progress is stdout-only, never on disk: an overlay that never reaches messages[].

export type ToolProgressNode = Extract<JsonlNode, { kind: 'tool-progress' }>;

export interface ToolProgressRetry {
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
  errorCategory: string;
}

export interface ToolProgressEntry {
  elapsedSeconds: number;
  /** Lets a chip interpolate between the CLI's 30-second beats. */
  arrivedAtMs: number;
  retry: ToolProgressRetry | null;
}

export type ToolProgressMap = ReadonlyMap<string, ToolProgressEntry>;

export const EMPTY_TOOL_PROGRESS: ToolProgressMap = new Map<string, ToolProgressEntry>();

const HEARTBEAT_SUFFIX = /-heartbeat-\d+$/;

/** The CLI mints `${toolUseID}-heartbeat-${n}` per beat; stripping the suffix is right both nested and top-level. */
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

/** Returns `prev` when nothing changed, so a duplicate (reconnect replay) costs no render. */
export function reduceToolProgress(
  prev: ToolProgressMap,
  node: ToolProgressNode,
  nowMs: number,
): ToolProgressMap {
  const key = node.anchorToolUseId;
  const existing = prev.get(key);
  const raw = node.raw;

  // Only a retry frame speaks about retry; a heartbeat mid-retry must not resolve it.
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
    // subagent_type without subagent_retry is the CLI's resolved signal.
    retry = null;
  }

  const elapsedSeconds = raw.elapsed_time_seconds;
  if (
    existing?.elapsedSeconds === elapsedSeconds &&
    existing.arrivedAtMs === nowMs &&
    sameRetry(existing.retry, retry)
  ) {
    return prev;
  }

  const next = new Map(prev);
  next.set(key, { elapsedSeconds, arrivedAtMs: nowMs, retry });
  return next;
}

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
