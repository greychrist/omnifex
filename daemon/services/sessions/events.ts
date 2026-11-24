export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
  surpassedThreshold?: number;
}

export type RuntimeEvent =
  | { kind: 'init'; sessionId: string | null }
  | { kind: 'result'; isError: boolean; body: string }
  | { kind: 'rateLimit'; info: RateLimitInfo }
  | { kind: 'compact'; trigger: 'manual' | 'auto' | null; preTokens: number | null }
  | { kind: 'streamEvent' }
  | { kind: 'hook' }
  | { kind: 'taskStarted'; taskId: string; taskType: string; description: string }
  | {
      kind: 'taskNotification';
      taskId: string;
      status: 'completed' | 'failed';
      summary: string;
      durationMs: number | null;
    }
  | { kind: 'modNotify' }
  | { kind: 'modNotifyCancel' }
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

  if (m.type === 'system' && m.subtype === 'task_started') {
    return {
      kind: 'taskStarted',
      taskId: typeof m.task_id === 'string' ? m.task_id : '',
      taskType: typeof m.task_type === 'string' ? m.task_type : '',
      description: typeof m.description === 'string' ? m.description : '',
    };
  }

  if (m.type === 'system' && m.subtype === 'task_notification') {
    const usage = m.usage as { duration_ms?: unknown } | undefined;
    return {
      kind: 'taskNotification',
      taskId: typeof m.task_id === 'string' ? m.task_id : '',
      // `stopped` counts as failed: the work did not happen.
      status: m.status === 'completed' ? 'completed' : 'failed',
      summary: typeof m.summary === 'string' ? clip(m.summary) : '',
      durationMs: typeof usage?.duration_ms === 'number' ? usage.duration_ms : null,
    };
  }

  if (m.type === 'system' && m.subtype === 'ui_notify') return { kind: 'modNotify' };
  if (m.type === 'system' && m.subtype === 'ui_notify_cancel') return { kind: 'modNotifyCancel' };

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
