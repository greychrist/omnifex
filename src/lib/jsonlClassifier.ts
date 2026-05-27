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
  FileSnapshotRaw,
  SystemRaw,
  SystemSubtype,
  CliInitRaw,
  CliResultRaw,
} from '@/types/jsonl';

/**
 * Single source of truth for classifying a parsed JSONL line into the
 * renderer's taxonomy. Returns null for shapes we explicitly drop or
 * don't recognize — the caller appends only non-null results.
 *
 * Pure function; safe to call repeatedly on the same input. Tolerant of
 * missing optional fields (real JSONL lines often omit `timestamp` on
 * bookkeeping types).
 */
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
  const receivedAt = typeof r.timestamp === 'string' ? r.timestamp : null;

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
    case 'file-history-snapshot':
      return classifyFileSnapshot(r);
    case 'system':
      if (r.subtype === 'init') return classifyCliInit(r, sessionId, receivedAt);
      return classifySystem(r, sessionId, receivedAt);
    case 'result':
      return classifyCliResult(r, sessionId, receivedAt);
    default:
      if (receivedAt === null) return null;
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
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return false;
  return first.text.startsWith('[Image: ');
}

function classifyUser(r: Record<string, unknown>, sessionId: string, receivedAt: string | null): JsonlNode | null {
  if (receivedAt === null) return null;
  const message = r.message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  const isMeta = r.isMeta === true;
  const hasSourceToolUseID = typeof r.sourceToolUseID === 'string' && r.sourceToolUseID.length > 0;

  let userKind: UserKind;
  if (isToolResultOnly(content)) {
    userKind = 'tool-result';
  } else if (isMeta && hasSourceToolUseID) {
    userKind = 'meta-skill';
  } else if (isMeta && isAttachmentMarker(content)) {
    userKind = 'meta-attachment';
  } else if (isMeta) {
    userKind = 'meta-other';
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
    if (receivedAt === null) return null;
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

