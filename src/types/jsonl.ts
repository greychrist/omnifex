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
  isMeta?: boolean;
  sourceToolUseID?: string;
  /** The only marker of a /compact summary; absent from the stream-json envelope. */
  isCompactSummary?: boolean;
  /** Set with `isCompactSummary` for a plain compaction, not for a directed summarize. */
  isVisibleInTranscriptOnly?: boolean;
  /** Live-stream only, never on disk: nothing may classify on it. */
  isReplay?: boolean;
  /** `isMeta || isVisibleInTranscriptOnly`: too coarse to identify a compact summary. */
  isSynthetic?: boolean;
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

/** The CLI's input queue, not background tasks. */
export interface QueueOpRaw extends RawLineBase {
  type: 'queue-operation';
  operation: string;
  content?: string;
  reason?: string;
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

/** A rename; outranks `ai-title`. */
export interface CustomTitleRaw extends RawLineBase {
  type: 'custom-title';
  customTitle: string;
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
  | 'meta-other'
  | 'compact-summary'
  /** A built-in slash command's echo and stdout: run client-side, the model never replies. A skill's echo is a 'prompt'. */
  | 'local-command'
  /** `[Request interrupted by user]`: a `user` record nobody owes a reply to. */
  | 'interrupt';

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
  | 'permission_denied'
  | 'thinking_tokens'
  | 'model_fallback'
  | 'model_refusal_fallback'
  | 'model_refusal_no_fallback'
  | 'session_writes_lost'
  | 'model_consent_fallback'
  | 'error_during_execution'
  | 'background_tasks_changed'
  | 'dev_intent'
  | 'per_turn_effort_changed'
  | 'elicitation_complete'
  | 'session_metadata'
  | 'session_title_changed'
  | 'ui_log'
  | 'ui_toast'
  | 'ui_status'
  | 'ui_invalidate'
  | 'ui_focus'
  | 'ui_panes'
  | 'ui_placed'
  | 'ui_scroll'
  | 'ui_notify'
  | 'ui_notify_cancel'
  | 'commands_changed'
  | 'permission_check_status'
  | 'feedback_draft_queued';

/** `task_type` distinguishes an agent from a backgrounded shell. */
export interface BackgroundTaskEntry {
  task_id: string;
  task_type: string;
  description?: string;
}

export interface SystemRaw extends RawLineBase {
  type: 'system';
  subtype: SystemSubtype;
  content?: string;
  parentUuid?: string;
  cwd?: string;
  level?: string;
  notification_type?: string;
  title?: string;
  body?: string;
  /** Open string: the CLI emits more than the documented 'compacting' | null. Never rendered in the transcript. */
  status?: string | null;
  estimated_tokens?: number;
  estimated_tokens_delta?: number;
  /** The full set of running background tasks, not a delta. */
  tasks?: BackgroundTaskEntry[];
  hookInfos?: { command?: string; durationMs?: number }[];
  hookErrors?: unknown[];
  preventedContinuation?: boolean;
  stopReason?: string;
  draft_id?: string;
  draft_type?: string;
  details_preview?: string;
  /** camelCase on disk. */
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number; durationMs?: number };
}

/** Servers the CLI skipped: they never appear in `mcp_servers`. */
export interface McpServerConfigError {
  name: string;
  type: string;
  message: string;
}

export interface CliInitRaw {
  type: 'system';
  subtype: 'init';
  session_id?: string;
  cwd?: string;
  model?: string;
  tools?: string[];
  mcp_servers?: unknown[];
  mcp_server_errors?: unknown[] | null;
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

/** All optional: the CLI omits utilization/resetsAt on some events. */
export interface RateLimitEventInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}

/** `subagent_retry` is present only while unresolved; `subagent_type` without it means it recovered. */
export interface ToolProgressRaw {
  type: 'tool_progress';
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds: number;
  uuid?: string;
  session_id?: string;
  task_id?: string;
  heartbeat?: boolean;
  subagent_type?: string;
  subagent_retry?: {
    agent_id: string;
    attempt: number;
    max_retries: number;
    retry_delay_ms: number;
    error_status: number | null;
    error_category: string;
  };
}

export interface ProgressRaw extends RawLineBase {
  type: 'progress';
  data?: { type?: string; [key: string]: unknown };
  toolUseID?: string;
  parentToolUseID?: string;
}

export interface RateLimitEventRaw extends RawLineBase {
  type: 'rate_limit_event';
  session_id?: string;
  rate_limit_info?: RateLimitEventInfo;
}

export interface UsageShape {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: unknown;
}

// 'unknown' receivedAt is nullable: 'summary' and 'mode' records persist with no timestamp.

export type JsonlNode =
  | { kind: 'assistant'; raw: AssistantRaw; sessionId: string; receivedAt: string }
  | { kind: 'user'; raw: UserRaw; sessionId: string; receivedAt: string; userKind: UserKind }
  | { kind: 'attachment'; raw: AttachmentRaw; sessionId: string; receivedAt: string }
  | { kind: 'unknown'; raw: Record<string, unknown>; sessionId: string; receivedAt: string | null }
  | { kind: 'queue-operation'; raw: QueueOpRaw; sessionId: string; receivedAt: string }
  | { kind: 'last-prompt'; raw: LastPromptRaw; sessionId: string }
  | { kind: 'permission-mode'; raw: PermissionModeRaw; sessionId: string }
  | { kind: 'ai-title'; raw: AiTitleRaw; sessionId: string }
  | { kind: 'custom-title'; raw: CustomTitleRaw; sessionId: string }
  | { kind: 'file-history-snapshot'; raw: FileSnapshotRaw }
  | { kind: 'system'; subtype: SystemSubtype; raw: SystemRaw; sessionId: string; receivedAt: string }
  | { kind: 'cli-stream-init'; raw: CliInitRaw; sessionId: string; receivedAt: string }
  | { kind: 'cli-stream-result'; raw: CliResultRaw; sessionId: string; receivedAt: string }
  // A top-level type, not a system subtype; distinct from the overlay `rate-limit` kind, which never enters messages[].
  | { kind: 'rate-limit-event'; raw: RateLimitEventRaw; sessionId: string; receivedAt: string | null }
  | { kind: 'progress'; raw: ProgressRaw; sessionId: string; receivedAt: string | null }
  // Overlay (CLI stream only — never enters messages[])
  | { kind: 'stream-event'; uuid: string; deltaText: string }
  | { kind: 'rate-limit'; info: RateLimitInfo }
  | { kind: 'lifecycle'; eventType: LifecycleKind; raw: unknown }
  // Live-stream only, never on disk: in messages[] a live and a reloaded transcript would disagree.
  // anchorToolUseId is the real tool id: a heartbeat's tool_use_id is synthetic, parent_tool_use_id is the enclosing Task.
  | { kind: 'tool-progress'; raw: ToolProgressRaw; anchorToolUseId: string }
  // Synthetic, live-session only; never produced by classifyJsonlLine.
  | { kind: 'control-change'; control: 'effort' | 'model' | 'permission'; value: string; sessionId: string; receivedAt: string };

export type RenderedKind = Exclude<JsonlNode['kind'], 'stream-event' | 'rate-limit' | 'lifecycle' | 'tool-progress'>;

export type OverlayKind = Extract<JsonlNode['kind'], 'stream-event' | 'rate-limit' | 'lifecycle' | 'tool-progress'>;
