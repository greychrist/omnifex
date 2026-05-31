/**
 * Source-of-truth taxonomy for messages flowing through the renderer's
 * message pipeline. Every JSONL line the CLI writes maps to exactly one
 * variant (or is dropped by the classifier): every real CLI emission, one
 * variant per visually meaningful category, no synthesis. Overlay variants
 * come from the CLI stream in CLI mode and never touch the renderer's
 * messages[] — they drive separate UI surfaces (partials buffer,
 * rate-limit service, SubagentBar / hook progress / status badges).
 *
 * Inventory drawn from 126 real session JSONL files. See the design spec
 * for the per-kind line counts.
 */

/** Generic raw-line shell. Every JSONL line carries at least `type`. */
export interface RawLineBase {
  type: string;
  sessionId?: string;
  timestamp?: string;
  uuid?: string;
}

export interface AssistantRaw extends RawLineBase {
  type: 'assistant';
  message: {
    role: 'assistant';
    content: unknown;
    stop_reason?: string | null;
    usage?: Record<string, unknown>;
    model?: string;
  };
  parentUuid?: string;
  cwd?: string;
  gitBranch?: string;
}

export interface UserRaw extends RawLineBase {
  type: 'user';
  message: {
    role: 'user';
    content: unknown;
  };
  parentUuid?: string;
  cwd?: string;
  promptId?: string;
  permissionMode?: string;
  /** True when the record was synthesized by the harness, not typed by the user. */
  isMeta?: boolean;
  /** Set when a meta record was emitted on behalf of a specific tool_use (e.g. Skill bodies). */
  sourceToolUseID?: string;
}

export interface AttachmentRaw extends RawLineBase {
  type: 'attachment';
  attachment: {
    type?: string;
    prompt?: string;
    [key: string]: unknown;
  };
  parentUuid?: string;
  cwd?: string;
}

export interface QueueOpRaw extends RawLineBase {
  type: 'queue-operation';
  operation: string;
  content?: string;
}

export interface LastPromptRaw extends RawLineBase {
  type: 'last-prompt';
  lastPrompt: string;
  leafUuid: string;
}

export interface PermissionModeRaw extends RawLineBase {
  type: 'permission-mode';
  permissionMode: string;
}

export interface AiTitleRaw extends RawLineBase {
  type: 'ai-title';
  aiTitle: string;
}

export interface FileSnapshotRaw extends RawLineBase {
  type: 'file-history-snapshot';
  messageId?: string;
  snapshot: unknown;
  isSnapshotUpdate?: boolean;
}

export type UserKind =
  | 'prompt'
  | 'tool-result'
  | 'meta-skill'
  | 'meta-attachment'
  | 'meta-other';

export type SystemSubtype =
  | 'init'
  | 'notification'
  | 'stop_hook_summary'
  | 'hook_started'
  | 'hook_progress'
  | 'hook_response'
  | 'local_command'
  | 'api_error'
  | 'turn_duration'
  | 'away_summary'
  | 'compact_boundary'
  | 'informational'
  | 'status'
  | 'permission_denied';

export interface SystemRaw extends RawLineBase {
  type: 'system';
  subtype: SystemSubtype;
  content?: string;
  parentUuid?: string;
  cwd?: string;
  level?: string;
  /** Present when subtype === 'notification'. */
  notification_type?: string;
  title?: string;
  body?: string;
  /**
   * Present when subtype === 'status' — a transient per-turn phase ping
   * (e.g. 'requesting', 'compacting'). Open string on the wire; the docs
   * only list 'compacting' | null but the CLI emits others. Surfaced as the
   * live activity label via `phaseLabel`, never rendered in the transcript.
   */
  status?: string | null;
}

export interface CliInitRaw {
  type: 'system';
  subtype: 'init';
  session_id?: string;
  cwd?: string;
  model?: string;
  tools?: string[];
  mcp_servers?: unknown[];
  [k: string]: unknown;
}

export interface CliResultRaw {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  stop_reason?: string | null;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
  session_id?: string;
  [k: string]: unknown;
}

export type LifecycleKind =
  | 'task_started' | 'task_updated' | 'task_progress' | 'task_notification'
  | 'hook_started' | 'hook_progress' | 'hook_response'
  | 'status' | 'permission_denied' | 'plugin_install' | 'tool_progress'
  | 'auth_status' | 'session_state_changed' | 'notification'
  | 'files_persisted' | 'tool_use_summary' | 'memory_recall'
  | 'elicitation_complete' | 'prompt_suggestion' | 'mirror_error'
  | 'api_retry' | 'local_command_output';

export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
  surpassedThreshold?: number;
}

export interface UsageShape {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: unknown;
}

// Real-but-unhandled envelope types (fall through to 'unknown'):
//   - 'mode' (2 occurrences in 137 sessions as of 2026-05-27; promote to a kind
//     if usage grows enough to need filtering)

/** Discriminated union — exactly one `kind` per node. */
export type JsonlNode =
  // Conversation content (persisted to JSONL)
  | { kind: 'assistant'; raw: AssistantRaw; sessionId: string; receivedAt: string }
  | { kind: 'user'; raw: UserRaw; sessionId: string; receivedAt: string; userKind: UserKind }
  | { kind: 'attachment'; raw: AttachmentRaw; sessionId: string; receivedAt: string }
  | { kind: 'unknown'; raw: Record<string, unknown>; sessionId: string; receivedAt: string }
  // Closure carriers (background-bash plumbing)
  | { kind: 'queue-operation'; raw: QueueOpRaw; sessionId: string; receivedAt: string }
  // CLI bookkeeping (TUI-only in practice)
  | { kind: 'last-prompt'; raw: LastPromptRaw; sessionId: string }
  | { kind: 'permission-mode'; raw: PermissionModeRaw; sessionId: string }
  | { kind: 'ai-title'; raw: AiTitleRaw; sessionId: string }
  | { kind: 'file-history-snapshot'; raw: FileSnapshotRaw }
  // System sub-variants
  | { kind: 'system'; subtype: SystemSubtype; raw: SystemRaw; sessionId: string; receivedAt: string }
  // CLI engine-mode stream envelopes (engine/--output-format stream-json)
  | { kind: 'cli-stream-init'; raw: CliInitRaw; sessionId: string; receivedAt: string }
  | { kind: 'cli-stream-result'; raw: CliResultRaw; sessionId: string; receivedAt: string }
  // Overlay (CLI stream only — never enters messages[])
  | { kind: 'stream-event'; uuid: string; deltaText: string }
  | { kind: 'rate-limit'; info: RateLimitInfo }
  | { kind: 'lifecycle'; eventType: LifecycleKind; raw: unknown }
  // Synthetic control-change markers (live-session only; never produced by
  // classifyJsonlLine — injected via appendMessage when a control picker fires).
  | { kind: 'control-change'; control: 'effort' | 'model' | 'permission'; value: string; sessionId: string; receivedAt: string };

/** Convenience: which kinds appear in the renderer's `messages[]`. */
export type RenderedKind = Exclude<JsonlNode['kind'], 'stream-event' | 'rate-limit' | 'lifecycle'>;

/** Convenience: kinds that exist as overlay channels only. */
export type OverlayKind = Extract<JsonlNode['kind'], 'stream-event' | 'rate-limit' | 'lifecycle'>;
