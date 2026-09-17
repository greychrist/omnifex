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
  ToolProgressRaw,
} from '@/types/jsonl';
import { anchorToolUseId } from './toolProgress';
import { isLocalCommandEnvelope } from './commandEnvelope';

/**
 * Single source of truth for classifying a parsed JSONL line into the
 * renderer's taxonomy. Returns null only for malformed input (non-object,
 * missing `type`) and for known kinds missing their required fields;
 * unrecognized types always classify as 'unknown' so the renderer's
 * catch-all card can show them — the caller appends only non-null results.
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
  // Two valid wall-clock sources, depending on the ingress path:
  //   - `timestamp`  → JSONL on disk (the CLI stamps it at persist time)
  //   - `receivedAt` → live IPC stream (main process stamps it at IPC arrival;
  //                    see OmnifexEnvelope in src/types/claudeStream.ts)
  // Both are legitimate. Returning null only when BOTH are absent preserves
  // Task 4's intent (no synthetic wall-clock fallback that masks data bugs)
  // while accepting live envelopes that lack `timestamp` by design.
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
    case 'tool_progress':
      return classifyToolProgress(r);
    default:
      // Catch-all: never drop. Some real record types ('summary', 'mode')
      // persist with no top-level timestamp, so unlike the content kinds
      // above, 'unknown' tolerates a null wall-clock — the history loader
      // preserves file order, which is ordering enough for a marker card.
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

/**
 * A /compact summary reaches us as a `user` record, marked `isCompactSummary`
 * (plus `isVisibleInTranscriptOnly` for a plain compaction, absent for a
 * directed summarize).
 *
 * This used to fall back to `isReplay === false`, because stream-json stripped
 * `isCompactSummary` and the CLI emits `isReplay: !isCompactSummary` while
 * every other emitter hard-codes `true`. That proxy died with the transcript
 * inversion: committed rows now come from the CLI's JSONL, which marks
 * summaries outright (see services/sessions/stream-forward.ts). A census of
 * all 890 personal transcripts found 21 rows carrying `isCompactSummary` and
 * zero carrying `isReplay: false`, across six CLI versions — the field has
 * never appeared on disk, so the fallback could only ever have fired on a
 * shape we no longer render from.
 *
 * `isSynthetic` is deliberately NOT consulted: the CLI defines it as
 * `isMeta || isVisibleInTranscriptOnly`, so it fires for skill bodies and
 * image markers too, and it misses a directed summarize entirely.
 */
export function isCompactSummaryRecord(r: Record<string, unknown>): boolean {
  return r.isCompactSummary === true;
}

/**
 * The marker the CLI writes into the transcript when the user presses Stop:
 *
 *   [Request interrupted by user]
 *   [Request interrupted by user for tool use]
 *
 * Both are plain `user` records carrying neither isMeta nor any other flag, so
 * without this they classify as `prompt` — a prompt nothing will ever answer,
 * which pins the turn axis open forever (work session aacbd708).
 *
 * The prefix is the CLI's own predicate for the same record (2.1.273 counts
 * interruptions with `text.includes("[Request interrupted by user")`), and
 * those two strings are the only ones in the 2.1.273 binary.
 *
 * Anchored end-to-end on purpose: the CLI can prepend the marker to the prompt
 * the user typed next ("[Request interrupted by user]\nUse Sonnet instead."),
 * and that record IS a prompt — Claude owes it a reply.
 *
 * `content` is accepted in both shapes the CLI persists (bare string, array of
 * blocks) for the same reason as isLocalCommandEnvelope: the live stream and a
 * re-read transcript normalize differently.
 */
const INTERRUPT_NOTICE = /^\[Request interrupted by user[^\]]*\]$/;

export function isInterruptNotice(content: unknown): boolean {
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    // A non-text block means this is not a bare marker.
    if (!content.every((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')) {
      return false;
    }
    text = content.map((b) => String((b as { text?: unknown }).text ?? '')).join('');
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
  } else if (isMeta && hasSourceToolUseID) {
    userKind = 'meta-skill';
  } else if (isMeta && isAttachmentMarker(content)) {
    userKind = 'meta-attachment';
  } else if (isMeta) {
    userKind = 'meta-other';
  } else if (isInterruptNotice(content)) {
    userKind = 'interrupt';
  } else if (isLocalCommandEnvelope(content)) {
    // A slash command leaves two `user` records behind — the echo of what was
    // typed and the command's stdout. Neither carries isMeta, so without this
    // branch both classified as 'prompt': a question nothing would ever answer.
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
  'model_consent_fallback',
  'error_during_execution',
  'background_tasks_changed',
  'feedback_draft_queued',
  'dev_intent',
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
    // Unrecognized system subtype → catch-all, timestamp or not (same
    // rationale as the top-level default branch).
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

// rate_limit_event lines carry no `subtype`/narrative field to validate
// against (unlike classifyAttachment/classifyQueueOp above), and real
// samples have been observed without a top-level `timestamp` — so this
// never returns null and never requires receivedAt. The alternative (any
// stricter check) would silently drop the line back to the 'unknown'
// catch-all, defeating the point of first-classing it.
function classifyRateLimitEvent(r: Record<string, unknown>, sessionId: string, receivedAt: string | null): JsonlNode {
  return { kind: 'rate-limit-event', raw: r as unknown as RateLimitEventRaw, sessionId, receivedAt };
}


/**
 * Live progress for an in-flight tool call. An OVERLAY node: it never enters
 * `messages[]`, because the CLI never writes this frame to the JSONL on disk.
 *
 * The guard mirrors the CLI's own `sdkMessageAdapter`, which drops a frame
 * "with a non-string tool_name/tool_use_id or non-finite
 * elapsed_time_seconds" — same three fields, same verdict, so a malformed
 * frame can never reach a chip that does arithmetic on it.
 *
 * No `receivedAt` requirement, unlike every content kind above: the frame
 * carries no `timestamp` by design, and arrival is stamped by the reducer.
 */
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
