import type { JsonlNode } from '@/types/jsonl';
import type { PermissionRequestPayload } from './types/permissionRequest';
import { phaseLabel } from './phaseLabel';
import { computeMessageCost, type ModelPricingInput, type UsageTokens } from '@/lib/pricing';

export type { PermissionRequestPayload };

export interface StreamReducerContext {
  projectPath: string;
  hasExistingInit: boolean;
  hasExtractedSession: boolean;
  userInterrupted: boolean;
  messagesLength: number;
  pricingOverrides?: readonly ModelPricingInput[] | undefined;
  /** requestId/message.id keys already priced; live streams re-deliver assistant messages per content block. */
  seenCostKeys?: Set<string>;
}

export type StreamReducerEffect =
  | { kind: 'refreshContextUsage' }
  | { kind: 'fetchAccountInfo' }
  | { kind: 'fetchSupportedModels' }
  | { kind: 'fetchSupportedCommands' }
  | {
      kind: 'saveSessionPersistence';
      sessionId: string;
      projectId: string;
      messageCount: number;
    }
  | { kind: 'processQueuedPrompt' }
  | { kind: 'queuePostCompactDirective' }
  | { kind: 'showPermissionPrompt'; payload: PermissionRequestPayload };

export type ActivityUpdate =
  | { kind: 'literal'; label: string }
  | { kind: 'gerund' };

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

export type AppendMode = 'append' | 'insertBeforeFirstUser' | 'skip';

export interface StreamReducerResult {
  append: AppendMode;
  /** Keeps a turn-closer in messages[] while rewriting its presentation. */
  replaceWith?: JsonlNode;
  effects: StreamReducerEffect[];
  sessionIdUpdate?: string;
  extractedSessionInfo?: { sessionId: string; projectId: string };
  pendingPermission?: PermissionRequestPayload;
  clearUserInterrupted?: boolean;
  activityUpdate?: ActivityUpdate;
  metrics: MetricsDelta;
  costDelta: number;
}

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
  TaskCreate: (i) =>
    `Adding todo${
      typeof i.subject === 'string' ? `: ${(i.subject).slice(0, 60)}` : ''
    }`,
  TaskUpdate: (i) => {
    const status = typeof i.status === 'string' ? i.status : '';
    if (status === 'completed') return 'Completing todo';
    if (status === 'in_progress') return 'Starting todo';
    if (status === 'deleted') return 'Removing todo';
    return 'Updating todo';
  },
  TaskList: () => 'Listing todos',
  TaskGet: () => 'Reading todo',
};

function toolUseLabel(name: string, input: Record<string, unknown>): string {
  const builder = TOOL_LABEL_BUILDERS[name];
  return builder ? builder(input) : `Running ${name}`;
}

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

function computeCost(node: JsonlNode, ctx: StreamReducerContext): number {
  // Only assistants: cli-stream-result usage is the CLI's rollup of them.
  if (node.kind !== 'assistant') return 0;
  // Forwarded subagent assistants never reach persisted transcripts; pricing them makes live cost disagree with reload.
  const parentToolUseId = (node.raw as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  if (typeof parentToolUseId === 'string' && parentToolUseId.length > 0) return 0;
  const raw = node.raw as {
    requestId?: string;
    message?: { id?: string; model?: string; usage?: UsageTokens };
  };
  const usage = raw.message?.usage;
  if (!usage) return 0;
  const key = raw.requestId ?? raw.message?.id;
  if (key && ctx.seenCostKeys) {
    if (ctx.seenCostKeys.has(key)) return 0;
    ctx.seenCostKeys.add(key);
  }
  return computeMessageCost(raw.message?.model ?? '', usage, ctx.pricingOverrides).usd;
}

export function reduceSessionStreamMessage(
  node: JsonlNode,
  ctx: StreamReducerContext,
): StreamReducerResult {
  if (node.kind === 'stream-event' || node.kind === 'rate-limit' || node.kind === 'lifecycle') {
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
  const costDelta = computeCost(node, ctx);

  if (node.kind === 'assistant') {
    const content = (node.raw as { message?: { content?: unknown } }).message?.content;
    const blocks = Array.isArray(content) ? content : [];
    const inspected = inspectAssistantContent(blocks);
    metrics = inspected.metrics;
    activity = inspected.activity;
  } else if (node.kind === 'user') {
    const content = (node.raw as { message?: { content?: unknown } }).message?.content;
    const blocks = Array.isArray(content) ? content : [];
    const inspected = inspectUserContent(blocks);
    metrics = inspected.metrics;
    activity = inspected.activity;
  }

  if (node.kind === 'system') {
    const raw = node.raw as { subtype?: string; error?: unknown; status?: string | null };
    if (raw.subtype === 'error' || raw.error) {
      metrics = { ...metrics, errorsEncountered: metrics.errorsEncountered + 1 };
    }
    if (raw.subtype === 'status') {
      const label = phaseLabel(raw.status);
      if (label) activity = { kind: 'literal', label };
    }
  }

  const result: StreamReducerResult = {
    append: 'append',
    effects,
    metrics,
    costDelta,
    activityUpdate: activity ?? undefined,
  };

  // The fetches fire on every init (including restarts); only the duplicate row is skipped.
  if (node.kind === 'cli-stream-init') {
    const raw = node.raw as { session_id?: string };
    const sid = raw.session_id;
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
      effects.push({ kind: 'fetchSupportedCommands' });
    }

    result.append = ctx.hasExistingInit ? 'skip' : 'insertBeforeFirstUser';
    return result;
  }

  // Also drains: the CLI can emit the result before the boundary, which stranded the directive in the queue.
  if (node.kind === 'system' && node.subtype === 'compact_boundary') {
    effects.push({ kind: 'refreshContextUsage' });
    effects.push({ kind: 'queuePostCompactDirective' });
    effects.push({ kind: 'processQueuedPrompt' });
  }

  if (
    node.kind === 'system' &&
    (node.subtype === 'model_fallback' ||
      node.subtype === 'model_refusal_fallback' ||
      node.subtype === 'model_refusal_no_fallback' ||
      node.subtype === 'model_consent_fallback')
  ) {
    effects.push({ kind: 'refreshContextUsage' });
  }

  if (node.kind === 'assistant') {
    const content = (node.raw as { message?: { content?: unknown } }).message?.content;
    if (
      Array.isArray(content) &&
      content.some((b) => (b as { type?: string }).type === 'fallback')
    ) {
      effects.push({ kind: 'refreshContextUsage' });
    }
  }

  if (node.kind === 'cli-stream-result') {
    const raw = node.raw as { is_error?: boolean };
    if (ctx.userInterrupted) {
      result.clearUserInterrupted = true;
      if (raw.is_error === true) {
        // A cancel keeps the result row (context-refresh trigger, turn bracket) with is_error cleared,
        // and must not drain the queue.
        result.replaceWith = {
          ...node,
          raw: { ...(node.raw as Record<string, unknown>), is_error: false },
        } as JsonlNode;
        result.append = 'append';
        return result;
      }
    }

    effects.push({ kind: 'refreshContextUsage' });
    effects.push({ kind: 'processQueuedPrompt' });
  }

  return result;
}
