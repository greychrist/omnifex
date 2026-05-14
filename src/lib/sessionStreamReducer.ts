import type { ClaudeStreamMessage } from '@/types/claudeStream';
import type { PermissionRequestPayload } from './types/permissionRequest';

export type { PermissionRequestPayload };

/**
 * Pure reducer for SDK stream messages flowing into the renderer.
 *
 * Extracted from ClaudeCodeSession.handleStreamMessage so the non-UI logic
 * (append decisions, session-id extraction, permission detection,
 * userInterrupted suppression, post-turn refresh requests) can be tested
 * without React.
 *
 * The reducer is intentionally narrow — currentActivity gerunds, raw JSONL
 * appending, session metrics, and cost tracking still live in the
 * component. Folding those in is a follow-up.
 */

export interface StreamReducerContext {
  projectPath: string;
  /** Whether the messages array already contains a system:init message. */
  hasExistingInit: boolean;
  /** Whether extractedSessionInfo state has been set this session. */
  hasExtractedSession: boolean;
  /** Latest value of userInterruptedRef — used to suppress the SDK's post-cancel error result. */
  userInterrupted: boolean;
  /** Current messages.length, snapshotted before this message is folded in. */
  messagesLength: number;
}

export type StreamReducerEffect =
  | { kind: 'refreshContextUsage' }
  | { kind: 'fetchAccountInfo' }
  | { kind: 'fetchSupportedModels' }
  | {
      kind: 'saveSessionPersistence';
      sessionId: string;
      projectId: string;
      messageCount: number;
    }
  | { kind: 'processQueuedPrompt' }
  | { kind: 'showPermissionPrompt'; payload: PermissionRequestPayload };

/**
 * Activity update for the in-flight indicator.
 *
 * - `literal`: a tool-specific label (e.g. `Searching for "foo"`).
 * - `gerund`: caller picks one of the rotating gerunds — kept out of the
 *   reducer so the reducer stays deterministic.
 */
export type ActivityUpdate =
  | { kind: 'literal'; label: string }
  | { kind: 'gerund' };

/**
 * Per-message deltas to fold into `sessionMetrics`. All numeric fields
 * accumulate; `bumpLastActivity` says "this message implies activity, so
 * snap lastActivityTime to now".
 */
export interface MetricsDelta {
  toolsExecuted: number;
  toolsFailed: number;
  filesCreated: number;
  filesModified: number;
  filesDeleted: number;
  codeBlocksGenerated: number;
  errorsEncountered: number;
  bumpLastActivity: boolean;
}

export const EMPTY_METRICS_DELTA: MetricsDelta = {
  toolsExecuted: 0,
  toolsFailed: 0,
  filesCreated: 0,
  filesModified: 0,
  filesDeleted: 0,
  codeBlocksGenerated: 0,
  errorsEncountered: 0,
  bumpLastActivity: false,
};

/**
 * How the caller should fold this message into messages[].
 *
 * - 'append': normal `setMessages(prev => [...prev, msg])` push.
 * - 'insertBeforeFirstUser': system:init insertion semantics —
 *   splice the message in before the first user message, otherwise
 *   append. Mirrors the original component's "init goes above the
 *   first prompt" rendering.
 * - 'skip': drop the message (duplicate init, suppressed interrupted result).
 */
export type AppendMode = 'append' | 'insertBeforeFirstUser' | 'skip';

export interface StreamReducerResult {
  append: AppendMode;
  effects: StreamReducerEffect[];
  /** New live session id from a system:init message, if any. */
  sessionIdUpdate?: string;
  /** Set extractedSessionInfo (only on the first init for this session). */
  extractedSessionInfo?: { sessionId: string; projectId: string };
  /** Permission UI payload extracted from a permission_request message. */
  pendingPermission?: PermissionRequestPayload;
  /** Tell the caller to clear the isLoading spinner. */
  clearLoading?: boolean;
  /** Tell the caller to clear userInterruptedRef. */
  clearUserInterrupted?: boolean;
  /** Updated activity label, or `gerund` to ask the caller to pick one. */
  activityUpdate?: ActivityUpdate;
  /** Metric deltas — always present; defaults to EMPTY_METRICS_DELTA. */
  metrics: MetricsDelta;
  /** USD cost to add to the session's cumulative cost. 0 if no usage data. */
  costDelta: number;
}

/** Same projectId derivation the original component used. */
function deriveProjectId(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

const TOOL_LABEL_BUILDERS: Record<
  string,
  (input: Record<string, unknown>) => string
> = {
  Grep: (i) => {
    const p = i.pattern;
    return typeof p === 'string'
      ? `Searching for "${p.slice(0, 40)}"`
      : 'Searching for pattern';
  },
  Glob: (i) => {
    const p = i.pattern;
    return typeof p === 'string' ? `Finding files matching ${p}` : 'Finding files ';
  },
  Read: (i) => {
    const f = i.file_path;
    return typeof f === 'string'
      ? `Reading ${String(f).split('/').pop()}`
      : 'Reading file';
  },
  Write: (i) => {
    const f = i.file_path;
    return typeof f === 'string'
      ? `Writing ${String(f).split('/').pop()}`
      : 'Writing file';
  },
  Edit: (i) => {
    const f = i.file_path;
    return typeof f === 'string'
      ? `Editing ${String(f).split('/').pop()}`
      : 'Editing file';
  },
  MultiEdit: (i) => {
    const f = i.file_path;
    return typeof f === 'string'
      ? `Editing ${String(f).split('/').pop()}`
      : 'Editing file';
  },
  Bash: (i) =>
    `Running command${
      typeof i.description === 'string'
        ? `: ${(i.description).slice(0, 60)}`
        : ''
    }`,
  WebFetch: (i) =>
    `Fetching ${typeof i.url === 'string' ? (i.url).slice(0, 50) : 'URL'}`,
  WebSearch: (i) =>
    `Searching web${
      typeof i.query === 'string'
        ? `: "${(i.query).slice(0, 40)}"`
        : ''
    }`,
  Task: (i) =>
    `Running agent${
      typeof i.subagent_type === 'string' ? ` (${i.subagent_type})` : ''
    }`,
  TodoWrite: () => 'Updating todos',
};

function toolUseLabel(name: string, input: Record<string, unknown>): string {
  const builder = TOOL_LABEL_BUILDERS[name];
  return builder ? builder(input) : `Running ${name}`;
}

/**
 * Inspect content blocks and produce activity + metric deltas.
 * Returns `null` for activityUpdate when no relevant block was seen.
 */
function inspectAssistantContent(
  blocks: unknown[],
): { activity: ActivityUpdate | null; metrics: MetricsDelta } {
  const metrics: MetricsDelta = { ...EMPTY_METRICS_DELTA };
  let activity: ActivityUpdate | null = null;

  for (const raw of blocks) {
    const block = raw as { type?: string; name?: string; input?: Record<string, unknown>; text?: string } | null;
    if (!block) continue;

    if (block.type === 'tool_use' && typeof block.name === 'string') {
      metrics.toolsExecuted += 1;
      metrics.bumpLastActivity = true;

      const lower = block.name.toLowerCase();
      if (lower.includes('create') || lower.includes('write')) {
        metrics.filesCreated += 1;
      } else if (
        lower.includes('edit') ||
        lower.includes('multiedit') ||
        lower.includes('search_replace')
      ) {
        metrics.filesModified += 1;
      } else if (lower.includes('delete')) {
        metrics.filesDeleted += 1;
      }

      if (!activity) {
        activity = {
          kind: 'literal',
          label: toolUseLabel(block.name, block.input || {}),
        };
      }
    } else if (block.type === 'thinking' && !activity) {
      activity = { kind: 'gerund' };
    } else if (block.type === 'text') {
      if (!activity) activity = { kind: 'gerund' };
      if (typeof block.text === 'string' && block.text.includes('```')) {
        const fences = (block.text.match(/```/g) || []).length;
        metrics.codeBlocksGenerated += Math.floor(fences / 2);
      }
    }
  }

  return { activity, metrics };
}

function inspectUserContent(blocks: unknown[]): {
  activity: ActivityUpdate | null;
  metrics: MetricsDelta;
} {
  const metrics: MetricsDelta = { ...EMPTY_METRICS_DELTA };
  let sawToolResult = false;

  for (const raw of blocks) {
    const block = raw as { type?: string; is_error?: boolean } | null;
    if (block?.type !== 'tool_result') continue;
    sawToolResult = true;
    if (block.is_error) {
      metrics.toolsFailed += 1;
      metrics.errorsEncountered += 1;
    }
  }

  return {
    activity: sawToolResult ? { kind: 'gerund' } : null,
    metrics,
  };
}

function computeCost(message: ClaudeStreamMessage): number {
  // result rows carry per-turn `usage` at the top level; assistant rows carry
  // the inner BetaMessage's usage. Other variants don't carry token usage.
  let usage: { input_tokens?: number; output_tokens?: number } | undefined;
  if (message.type === 'result') {
    usage = message.usage;
  } else if (message.type === 'assistant') {
    usage = message.message?.usage;
  }
  if (!usage) return 0;
  const input = (usage.input_tokens || 0) * 0.000003;
  const output = (usage.output_tokens || 0) * 0.000015;
  return input + output;
}

export function reduceSessionStreamMessage(
  message: ClaudeStreamMessage,
  ctx: StreamReducerContext,
): StreamReducerResult {
  // Defensive: stream_event messages are intercepted by the IPC subscriber
  // before they reach the reducer. If a future code path bypasses that
  // branch, ensure these never land in messages[] as garbage entries.
  if ((message as { type?: string }).type === 'stream_event') {
    return {
      append: 'skip',
      effects: [],
      metrics: EMPTY_METRICS_DELTA,
      costDelta: 0,
    };
  }

  const effects: StreamReducerEffect[] = [];
  let metrics: MetricsDelta = { ...EMPTY_METRICS_DELTA };
  let activity: ActivityUpdate | null = null;
  const costDelta = computeCost(message);

  if (message.type === 'assistant' && message.message?.content) {
    const blocks = Array.isArray(message.message.content)
      ? message.message.content
      : [];
    const inspected = inspectAssistantContent(blocks);
    metrics = inspected.metrics;
    activity = inspected.activity;
  } else if (message.type === 'user' && message.message?.content) {
    const blocks = Array.isArray(message.message.content)
      ? message.message.content
      : [];
    const inspected = inspectUserContent(blocks);
    metrics = inspected.metrics;
    activity = inspected.activity;
  }

  // Errors surfaced as system messages contribute to the cumulative count.
  if (
    message.type === 'system' &&
    ((message as { subtype?: string }).subtype === 'error' ||
      (message as { error?: unknown }).error)
  ) {
    metrics = { ...metrics, errorsEncountered: metrics.errorsEncountered + 1 };
  }

  const result: StreamReducerResult = {
    append: 'append',
    effects,
    metrics,
    costDelta,
    activityUpdate: activity ?? undefined,
  };

  // Permission request from the SDK's canUseTool callback. The wire format
  // is snake_case (it's an SDK stream message); we normalise to camelCase
  // here so every renderer consumer uses the same shape.
  if (message.type === 'permission_request' && message.request_id) {
    const payload: PermissionRequestPayload = {
      requestId: message.request_id,
      toolName: message.tool_name || 'Unknown',
      toolInput: message.tool_input ?? {},
      title: message.title,
      displayName: message.display_name,
      description: message.description,
      decisionReason: message.decision_reason,
      blockedPath: message.blocked_path,
      suggestions: message.permission_suggestions ?? [],
    };
    result.pendingPermission = payload;
    effects.push({ kind: 'showPermissionPrompt', payload });
  }

  // system:init — extract session id, kick off live SDK info fetches,
  // skip duplicates without suppressing the fetches (they fire on every init,
  // including post-rebind / restart).
  if (message.type === 'system' && message.subtype === 'init') {
    const sid = (message as { session_id?: string }).session_id;
    if (sid) {
      result.sessionIdUpdate = sid;
      if (!ctx.hasExtractedSession) {
        const projectId = deriveProjectId(ctx.projectPath);
        result.extractedSessionInfo = { sessionId: sid, projectId };
        effects.push({
          kind: 'saveSessionPersistence',
          sessionId: sid,
          projectId,
          messageCount: ctx.messagesLength,
        });
      }
      effects.push({ kind: 'fetchAccountInfo' });
      effects.push({ kind: 'refreshContextUsage' });
      effects.push({ kind: 'fetchSupportedModels' });
    }

    result.append = ctx.hasExistingInit ? 'skip' : 'insertBeforeFirstUser';
    return result;
  }

  // SDK emits compact_boundary after a manual or auto compaction; refresh the
  // header context-usage popover immediately rather than waiting for the next
  // turn's result.
  if (message.type === 'system' && message.subtype === 'compact_boundary') {
    effects.push({ kind: 'refreshContextUsage' });
  }

  // Result messages mean "turn complete, awaiting next input" — not exit.
  if (message.type === 'result') {
    if (ctx.userInterrupted) {
      result.clearUserInterrupted = true;
      const isError =
        (message as { is_error?: boolean }).is_error ||
        ((message as { subtype?: string }).subtype?.includes('error') ?? false);
      if (isError) {
        // Deliberate cancel — swallow the SDK's post-interrupt error result so
        // "Execution Failed" doesn't flash. Drop it from messages too.
        result.clearLoading = true;
        result.append = 'skip';
        return result;
      }
    }

    result.clearLoading = true;
    effects.push({ kind: 'refreshContextUsage' });
    effects.push({ kind: 'processQueuedPrompt' });
  }

  return result;
}
