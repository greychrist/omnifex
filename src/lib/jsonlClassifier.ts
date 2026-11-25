import type {
  JsonlNode,
  AssistantRaw,
  UserRaw,
  UserKind,
  AttachmentRaw,
  QueueOpRaw,
  LastPromptRaw,
  PermissionModeRaw,
  AiTitleRaw,
  CustomTitleRaw,
  FileSnapshotRaw,
  SystemRaw,
  SystemSubtype,
  CliInitRaw,
  CliResultRaw,
  RateLimitEventRaw,
  ProgressRaw,
  ToolProgressRaw,
} from '@/types/jsonl';
import { anchorToolUseId } from './toolProgress';
import { isLocalCommandEnvelope, isModelCommandEcho } from './commandEnvelope';

/** Null only for malformed input or a known kind missing required fields; unrecognized types classify as 'unknown', never dropped. */
export function classifyJsonlLine(raw: unknown): JsonlNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (typeof type !== 'string') return null;

  const sessionId =
    typeof r.sessionId === 'string'
      ? r.sessionId
      : typeof r.session_id === 'string'
        ? r.session_id
        : '';
  // `timestamp` on disk, `receivedAt` on the live stream; null only when both are absent (no synthetic fallback).
  const receivedAt =
    typeof r.timestamp === 'string' ? r.timestamp
    : typeof r.receivedAt === 'string' ? r.receivedAt
    : null;

  switch (type) {
    case 'assistant':
      return classifyAssistant(r, sessionId, receivedAt);
    case 'user':
      return classifyUser(r, sessionId, receivedAt);
    case 'attachment':
      return classifyAttachment(r, sessionId, receivedAt);
    case 'queue-operation':
      return classifyQueueOp(r, sessionId, receivedAt);
    case 'last-prompt':
      return classifyLastPrompt(r, sessionId);
    case 'permission-mode':
      return classifyPermissionMode(r, sessionId);
    case 'ai-title':
      return classifyAiTitle(r, sessionId);
    case 'custom-title':
      return classifyCustomTitle(r, sessionId);
    case 'file-history-snapshot':
      return classifyFileSnapshot(r);
    case 'system':
      if (r.subtype === 'init') return classifyCliInit(r, sessionId, receivedAt);
      return classifySystem(r, sessionId, receivedAt);
    case 'result':
      return classifyCliResult(r, sessionId, receivedAt);
    case 'rate_limit_event':
      return classifyRateLimitEvent(r, sessionId, receivedAt);
    case 'progress':
      return { kind: 'progress', raw: r as unknown as ProgressRaw, sessionId, receivedAt };
    case 'tool_progress':
      return classifyToolProgress(r);
    default:
      // Never drop. Some record types ('summary', 'mode') carry no timestamp, so 'unknown' tolerates null.
      return {
        kind: 'unknown',
        raw: r,
        sessionId,
        receivedAt,
      };
  }
}

function classifyAssistant(r: Record<string, unknown>, sessionId: string, receivedAt: string | null): JsonlNode | null {
  if (receivedAt === null) return null;
  const message = r.message;
  if (!message || typeof message !== 'object') return null;
  return {
    kind: 'assistant',
    raw: r as unknown as AssistantRaw,
    sessionId,
    receivedAt,
  };
}

function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return false;
  return content.every((c) => c && typeof c === 'object' && (c as { type?: string }).type === 'tool_result');
}

function isAttachmentMarker(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  const first = content[0] as { type?: string; text?: string } | undefined;
  if (first?.type !== 'text' || typeof first.text !== 'string') return false;
  return first.text.startsWith('[Image: ');
}

/** Never consult `isSynthetic`: it fires for skill bodies and image markers, and misses a directed summarize. */
export function isCompactSummaryRecord(r: Record<string, unknown>): boolean {
  return r.isCompactSummary === true;
}

/**
 * Without this a Stop marker classifies as a prompt nothing answers, pinning the turn open.
 * Anchored end-to-end: the CLI may prepend the marker to the next typed prompt, which IS a prompt.
 */
const INTERRUPT_NOTICE = /^\[Request interrupted by user[^\]]*\]$/;

export function isInterruptNotice(content: unknown): boolean {
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    if (!content.every((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')) {
      return false;
    }
    text = content.map((b) => String((b as { text?: string }).text ?? '')).join('');
  } else {
    return false;
  }
  return INTERRUPT_NOTICE.test(text.trim());
}

function classifyUser(r: Record<string, unknown>, sessionId: string, receivedAt: string | null): JsonlNode | null {
  if (receivedAt === null) return null;
  const message = r.message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  const isMeta = r.isMeta === true;
  const hasSourceToolUseID = typeof r.sourceToolUseID === 'string' && r.sourceToolUseID.length > 0;

  let userKind: UserKind;
  if (isCompactSummaryRecord(r)) {
    userKind = 'compact-summary';
  } else if (isToolResultOnly(content)) {
    userKind = 'tool-result';
  } else if ((r.origin as { kind?: unknown } | undefined)?.kind === 'peer') {
    userKind = 'peer-message';
  } else if (isMeta && hasSourceToolUseID) {
    userKind = 'meta-skill';
  } else if (isMeta && isAttachmentMarker(content)) {
    userKind = 'meta-attachment';
  } else if (isMeta) {
    userKind = 'meta-other';
  } else if (isInterruptNotice(content)) {
    userKind = 'interrupt';
  } else if (isLocalCommandEnvelope(content) && !isModelCommandEcho(content, r.turnOrigin)) {
    // A built-in's echo and stdout carry no isMeta; as 'prompt' they would await a reply that never comes.
    userKind = 'local-command';
  } else {
    userKind = 'prompt';
  }

  return {
    kind: 'user',
    raw: r as unknown as UserRaw,
    sessionId,
    receivedAt,
    userKind,
  };
}

function classifyAttachment(r: Record<string, unknown>, sessionId: string, receivedAt: string | null): JsonlNode | null {
  if (receivedAt === null) return null;
  if (!r.attachment || typeof r.attachment !== 'object') return null;
  return {
    kind: 'attachment',
    raw: r as unknown as AttachmentRaw,
    sessionId,
    receivedAt,
  };
}

function classifyQueueOp(r: Record<string, unknown>, sessionId: string, receivedAt: string | null): JsonlNode | null {
  if (receivedAt === null) return null;
  if (typeof r.operation !== 'string') return null;
  return {
    kind: 'queue-operation',
    raw: r as unknown as QueueOpRaw,
    sessionId,
    receivedAt,
  };
}

const SYSTEM_SUBTYPES: ReadonlySet<SystemSubtype> = new Set<SystemSubtype>([
  // 'init' intentionally absent: system:init is routed to classifyCliInit before classifySystem.
  'notification',
  'stop_hook_summary',
  'hook_started',
  'hook_progress',
  'hook_response',
  'local_command',
  'api_error',
  'turn_duration',
  'away_summary',
  'compact_boundary',
  'informational',
  'status',
  'permission_denied',
  'thinking_tokens',
  'model_fallback',
  'model_refusal_fallback',
  'model_refusal_no_fallback',
  'session_writes_lost',
  'model_consent_fallback',
  'error_during_execution',
  'background_tasks_changed',
  'feedback_draft_queued',
  'dev_intent',
  'per_turn_effort_changed',
  'elicitation_complete',
  'session_metadata',
  'session_title_changed',
  'ui_log',
  'ui_toast',
  'ui_status',
  'ui_invalidate',
  'ui_focus',
  'ui_panes',
  'ui_placed',
  'ui_scroll',
  'ui_notify',
  'ui_notify_cancel',
  'commands_changed',
  'permission_check_status',
]);

function classifyLastPrompt(r: Record<string, unknown>, sessionId: string): JsonlNode | null {
  if (typeof r.lastPrompt !== 'string') return null;
  return {
    kind: 'last-prompt',
    raw: r as unknown as LastPromptRaw,
    sessionId,
  };
}

function classifyPermissionMode(r: Record<string, unknown>, sessionId: string): JsonlNode | null {
  if (typeof r.permissionMode !== 'string') return null;
  return {
    kind: 'permission-mode',
    raw: r as unknown as PermissionModeRaw,
    sessionId,
  };
}

function classifyAiTitle(r: Record<string, unknown>, sessionId: string): JsonlNode | null {
  if (typeof r.aiTitle !== 'string') return null;
  return {
    kind: 'ai-title',
    raw: r as unknown as AiTitleRaw,
    sessionId,
  };
}

function classifyCustomTitle(r: Record<string, unknown>, sessionId: string): JsonlNode | null {
  if (typeof r.customTitle !== 'string') return null;
  return {
    kind: 'custom-title',
    raw: r as unknown as CustomTitleRaw,
    sessionId,
  };
}

function classifyFileSnapshot(r: Record<string, unknown>): JsonlNode | null {
  if (r.snapshot === undefined) return null;
  return {
    kind: 'file-history-snapshot',
    raw: r as unknown as FileSnapshotRaw,
  };
}

function classifySystem(r: Record<string, unknown>, sessionId: string, receivedAt: string | null): JsonlNode | null {
  const subtype = r.subtype;
  if (typeof subtype !== 'string' || !SYSTEM_SUBTYPES.has(subtype as SystemSubtype)) {
    return { kind: 'unknown', raw: r, sessionId, receivedAt };
  }
  if (receivedAt === null) return null;
  return {
    kind: 'system',
    subtype: subtype as SystemSubtype,
    raw: r as unknown as SystemRaw,
    sessionId,
    receivedAt,
  };
}

function classifyCliInit(r: Record<string, unknown>, sessionId: string, receivedAt: string | null): JsonlNode | null {
  if (receivedAt === null) return null;
  return { kind: 'cli-stream-init', raw: r as unknown as CliInitRaw, sessionId, receivedAt };
}

function classifyCliResult(r: Record<string, unknown>, sessionId: string, receivedAt: string | null): JsonlNode | null {
  if (receivedAt === null) return null;
  return { kind: 'cli-stream-result', raw: r as unknown as CliResultRaw, sessionId, receivedAt };
}

// Never null and no receivedAt required: real samples lack `timestamp`, and a stricter check drops it to 'unknown'.
function classifyRateLimitEvent(r: Record<string, unknown>, sessionId: string, receivedAt: string | null): JsonlNode {
  return { kind: 'rate-limit-event', raw: r as unknown as RateLimitEventRaw, sessionId, receivedAt };
}


/** Overlay node: the CLI never writes this frame to disk. The guard mirrors the CLI's own `sdkMessageAdapter`. */
function classifyToolProgress(r: Record<string, unknown>): JsonlNode | null {
  const toolUseId = r.tool_use_id;
  const toolName = r.tool_name;
  const elapsed = r.elapsed_time_seconds;
  if (typeof toolUseId !== 'string' || toolUseId.length === 0) return null;
  if (typeof toolName !== 'string') return null;
  if (typeof elapsed !== 'number' || !Number.isFinite(elapsed)) return null;
  return {
    kind: 'tool-progress',
    raw: r as unknown as ToolProgressRaw,
    anchorToolUseId: anchorToolUseId(toolUseId),
  };
}
