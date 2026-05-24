/**
 * Source-of-truth taxonomy for messages flowing through the renderer's
 * message pipeline. Every JSONL line the CLI writes maps to exactly one
 * variant (or is dropped by the classifier). Synthesized variants are
 * manufactured by the synthesizer for state JSONL doesn't persist
 * (session init, turn-complete result cards). Overlay variants come from
 * the SDK iterator in SDK mode and never touch the renderer's messages[]
 * — they drive separate UI surfaces (partials buffer, rate-limit service,
 * SubagentBar / hook progress / status badges).
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

export type SystemSubtype =
  | 'init'
  | 'notification'
  | 'stop_hook_summary'
  | 'local_command'
  | 'api_error'
  | 'turn_duration'
  | 'away_summary'
  | 'compact_boundary'
  | 'informational';

export interface SystemRaw extends RawLineBase {
  type: 'system';
  subtype: SystemSubtype;
  content?: string;
  parentUuid?: string;
  cwd?: string;
  level?: string;
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

/** Discriminated union — exactly one `kind` per node. */
export type JsonlNode =
  // Conversation content (persisted to JSONL)
  | { kind: 'assistant'; raw: AssistantRaw; sessionId: string; receivedAt: string }
  | { kind: 'user'; raw: UserRaw; sessionId: string; receivedAt: string; userKind: 'prompt' | 'tool-result' }
  | { kind: 'attachment'; raw: AttachmentRaw; sessionId: string; receivedAt: string }
  // Closure carriers (background-bash plumbing)
  | { kind: 'queue-operation'; raw: QueueOpRaw; sessionId: string; receivedAt: string }
  // CLI bookkeeping (TUI-only in practice)
  | { kind: 'last-prompt'; raw: LastPromptRaw; sessionId: string }
  | { kind: 'permission-mode'; raw: PermissionModeRaw; sessionId: string }
  | { kind: 'ai-title'; raw: AiTitleRaw; sessionId: string }
  | { kind: 'file-history-snapshot'; raw: FileSnapshotRaw }
  // System sub-variants
  | { kind: 'system'; subtype: SystemSubtype; raw: SystemRaw; sessionId: string; receivedAt: string }
  // Synthesized (not on disk; manufactured by the synthesizer)
  | { kind: 'synthesized-init'; sessionId: string; cwd: string; receivedAt: string }
  | { kind: 'synthesized-result'; sessionId: string; isError: boolean; subtype: string; body: string; durationMs: number; usage: UsageShape; totalCostUsd: number; stopReason: string | null; receivedAt: string }
  // Overlay (SDK iterator only — never enters messages[])
  | { kind: 'stream-event'; uuid: string; deltaText: string }
  | { kind: 'rate-limit'; info: RateLimitInfo }
  | { kind: 'lifecycle'; eventType: LifecycleKind; raw: unknown };

/** Convenience: which kinds appear in the renderer's `messages[]`. */
export type RenderedKind = Exclude<JsonlNode['kind'], 'stream-event' | 'rate-limit' | 'lifecycle'>;

/** Convenience: kinds that exist as overlay channels only. */
export type OverlayKind = Extract<JsonlNode['kind'], 'stream-event' | 'rate-limit' | 'lifecycle'>;
