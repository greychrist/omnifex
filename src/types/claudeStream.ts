/**
 * Shape of one message off the `claude` CLI's stream-json output, as the
 * renderer receives it on `agent-output:<tabId>` events.
 *
 * Anchored on `CliMessage` (the CLI's discriminated union of wire
 * variants) intersected with `OmnifexEnvelope` (the main process
 * timestamps each message as it crosses the IPC boundary). Three OmniFex
 * synthetic variants cover what the CLI doesn't model:
 *
 *   - `permission_request` — emitted by `canUseTool` for the in-app
 *     permission gate. Wire is snake_case; the reducer normalises to
 *     camelCase `PermissionRequestPayload` before downstream consumers.
 *   - `system` + `notification` — OmniFex's toast-style status row
 *     (info/warn/error/stop). Distinct from `CliNotificationMessage`
 *     (which has key/text/priority for the REPL notification queue) —
 *     we `Exclude` the CLI variant from the union so the discriminator
 *     unambiguously names the OmniFex shape.
 *   - `summary` — compaction summary loaded from session JSONL.
 *
 * Why anchor on the full `CliMessage` rather than enumerate variants:
 * `subagentStreams.ts` consumes `task_started`/`task_progress`/
 * `task_notification`/`task_updated`; `messageFilters.ts` drops the
 * `hook_started`/`hook_progress`/`hook_response` family as plumbing
 * noise; `messageKind.ts` classifies `hook_started`/`hook_response`
 * (`hook_progress` is never reached because the filter strips it
 * upstream). Enumerating only the handful with first-class rendering
 * would force every other site back through casts. Using the CLI's
 * own union and `Exclude`-ing the one colliding variant is the
 * smallest change that lets the compiler narrow correctly throughout.
 */

import type { PermissionSuggestion } from '../lib/types/permissionRequest';

// ---------------------------------------------------------------------------
// On-wire message shapes
// ---------------------------------------------------------------------------
//
// These mirror what the `claude` CLI emits over its stream-json output
// channel, declared here as plain interfaces. The fields are intentionally
// permissive (`message: unknown`, top-level passthrough via index
// signature) because the renderer's only narrowing need is on the
// top-level `type` discriminator.

/**
 * Anthropic message-usage block as the CLI emits it on assistant /
 * result messages. Field set matches Anthropic's `BetaUsage`, with
 * everything optional because partial streams emit a partial usage
 * object early in the turn.
 */
export interface AnthropicMessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  server_tool_use?: Record<string, unknown>;
  service_tier?: string;
}

export interface CliAssistantMessage {
  type: 'assistant';
  message: {
    id?: string;
    role?: 'assistant';
    content?: MessageContentBlock[];
    model?: string;
    stop_reason?: string | null;
    stop_sequence?: string | null;
    usage?: AnthropicMessageUsage;
  };
  parent_tool_use_id?: string | null;
  session_id?: string;
  uuid?: string;
}

export interface CliUserMessage {
  type: 'user';
  message: { role: 'user'; content: MessageContentBlock[] | string };
  parent_tool_use_id: string | null;
  session_id?: string;
  uuid?: string;
}

/** JSONL-replay variant — same wire shape as `CliUserMessage`. */
export type CliUserMessageReplay = CliUserMessage;

/**
 * Fields shared by all `type: 'result'` variants regardless of subtype.
 */
interface CliResultBase {
  type: 'result';
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  num_turns?: number;
  session_id?: string;
  total_cost_usd?: number;
  usage?: AnthropicMessageUsage;
  permission_denials?: unknown[];
}

/** Successful turn result. Carries the assistant's final `result` text. */
export interface CliResultMessage extends CliResultBase {
  subtype: 'success';
  result?: string;
}

/**
 * CLI's REPL-internal notification queue shape. OmniFex's own
 * `SystemNotificationMessage` (below) occupies the same `system+notification`
 * discriminator with a different shape; this CLI variant is never currently
 * emitted to the renderer but is kept declared so the union below can
 * exclude it cleanly.
 */
export interface CliNotificationMessage {
  type: 'system';
  subtype: 'notification';
  key?: string;
  text?: string;
  priority?: 'info' | 'warn' | 'error';
}

/**
 * `system+init` carries the session bootstrap snapshot. Fields below cover
 * what the renderer reads; `[k: string]: unknown` keeps it permissive for
 * upstream additions.
 */
export interface CliSystemInitMessage {
  type: 'system';
  subtype: 'init';
  session_id?: string;
  uuid?: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  tools?: string[];
  mcp_servers?: unknown[];
  slash_commands?: string[];
  commands?: unknown[];
  agents?: unknown[];
  models?: unknown[];
  account?: unknown;
  output_style?: string;
  skills?: unknown[];
  plugins?: unknown[];
}

/**
 * Error variant of `result`. The CLI emits `subtype !== 'success'` with
 * an `errors: string[]` field.
 */
/**
 * Error variant. Carries `errors: string[]`. Subtypes the CLI emits
 * include `error_max_turns` and `error_during_execution`; the union is
 * `string & not 'success'` so narrowing on `subtype !== 'success'`
 * works against the parent `Result | ResultError` shape.
 */
export type CliResultErrorSubtype = 'error_max_turns' | 'error_during_execution' | (string & { __brand?: never });
export interface CliResultErrorMessage extends CliResultBase {
  subtype: Exclude<CliResultErrorSubtype, 'success'>;
  errors?: string[];
  result?: string;
}

/**
 * Catch-all for `system+<subtype>` messages we haven't explicitly modeled
 * (task_started, task_progress, task_notification, compact_boundary, etc.).
 * Kept slim — no index signature — so it doesn't poison narrowing on the
 * other union members (a `[k: string]: unknown` here would widen
 * `msg.message` on assistant/user variants to `unknown`). Exclude 'init'
 * so `subtype === 'init'` cleanly narrows to `CliSystemInitMessage`.
 */
export type CliSystemOtherSubtype =
  | 'compact_boundary'
  | 'task_started'
  | 'task_progress'
  | 'task_notification'
  | 'task_updated'
  | 'hook_started'
  | 'hook_response'
  | 'permission_denied'
  | 'user_prompt_submit'
  | 'rate_limit_event';
export interface CliSystemOtherMessage {
  type: 'system';
  // 'init' lives on CliSystemInitMessage; 'notification' lives on
  // SystemNotificationMessage. Subtypes outside this literal set go
  // through casts at the call site.
  subtype: CliSystemOtherSubtype;
  // Common opaque fields callers may pluck off — kept individually-typed
  // (no index signature) so they don't widen other variants in the union.
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  status?: string;
  summary?: string;
  last_tool_name?: string;
  usage?: AnthropicMessageUsage & { total_tokens?: number; tool_uses?: number; duration_ms?: number };
  patch?: Record<string, unknown>;
  notification_type?: 'info' | 'warn' | 'error' | 'stop';
  title?: string;
  body?: string;
  text?: string;
  key?: string;
  priority?: string;
}

/** Per-token delta. Renderer ignores its body. */
export interface CliStreamEventMessage {
  type: 'stream_event';
}

export type CliMessage =
  | CliAssistantMessage
  | CliUserMessage
  | CliResultMessage
  | CliResultErrorMessage
  | CliNotificationMessage
  | CliSystemInitMessage
  | CliSystemOtherMessage
  | CliStreamEventMessage;

/**
 * Fields the main process attaches to every message as it crosses the IPC
 * boundary. Live messages receive `receivedAt`; JSONL-reloaded messages
 * carry `timestamp`.
 */
export interface OmnifexEnvelope {
  /** ISO timestamp stamped when the main process received the message from the CLI stream. */
  receivedAt?: string;
  /** Wall-clock timestamp from JSONL history. Distinct from `receivedAt`. */
  timestamp?: string;
  /**
   * Annotation applied by OmniFex's JSONL loader to messages the CLI marked
   * `meta`. The renderer skips meta rows unless an exemption applies (skill
   * injection, system context). Not emitted on live-stream messages.
   */
  isMeta?: boolean;
  /**
   * Dotted kind ID set by the classifier (e.g. "user.prompt",
   * "assistant.thinking", "cli-stream-result", "unknown"). Downstream
   * consumers — filters, blockKind, renderer, compactGrouping —
   * read this instead of re-deriving from type/subtype.
   */
  streamKind?: string;
}

/**
 * `CliMessage` minus `CliNotificationMessage`. The CLI variant carries
 * `{ key, text, priority }` for the REPL's notification queue; OmniFex's
 * `SystemNotificationMessage` synthetic occupies the same `system+notification`
 * discriminator with a different shape. The CLI shape is never currently
 * emitted to the renderer; if that changes, route it through a distinct
 * subtype rather than colliding here.
 */
type AnchoredCliMessage = Exclude<CliMessage, CliNotificationMessage>;

/**
 * `permission_request` is OmniFex-synthetic — it travels on the same
 * `agent-output:<tabId>` channel as CLI messages and is normalised
 * onto `PermissionRequestPayload` by the JSONL classifier. Snake_case
 * field names match the wire format emitted by `permissions.ts`.
 *
 * `kind` defaults to `'tool'` (Claude's `canUseTool` payload). When the
 * Codex engine surfaces an approval, the main process forwards
 * `kind: 'patch' | 'exec'`, `agent: 'codex'`, a human summary, and the
 * raw approval params on `codex_payload` (snake_case to match the wire's
 * existing field-naming convention).
 */
export interface PermissionRequestMessage extends OmnifexEnvelope {
  type: 'permission_request';
  request_id: string;
  /** Permission kind. Defaults to `'tool'` when omitted. */
  kind?: 'tool' | 'patch' | 'exec';
  agent?: 'claude' | 'codex';
  /** Engine-supplied one-line summary. Mirrors `AgentPermissionRequest.summary`. */
  summary?: string;
  /** Raw Codex approval params (applyPatchApproval / execCommandApproval). */
  codex_payload?: unknown;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  title?: string;
  display_name?: string;
  description?: string;
  decision_reason?: string;
  blocked_path?: string;
  permission_suggestions?: PermissionSuggestion[];
}

/**
 * OmniFex's toast-style status row. Emitted by:
 *   - `electron/services/sessions/hooks.ts` (hook-driven notifications, session setup)
 *   - `electron/services/sessions/runtime.ts` (session lifecycle errors)
 *   - `electron/services/sessions/queries.ts` (interrupt failures, permission-rule warnings)
 *   - `src/hooks/useSessionLifecycle.ts` (session-start failures)
 *
 * The `body` field carries the rendered text. Historical wire emitted
 * `message: string` here, which collided with `assistant.message` /
 * `user.message` (a wrapped Anthropic message). The rename lets the
 * discriminated union narrow cleanly.
 */
export interface SystemNotificationMessage extends OmnifexEnvelope {
  type: 'system';
  subtype: 'notification';
  notification_type: 'info' | 'warn' | 'error' | 'stop';
  title?: string;
  body?: string;
}

/**
 * Synthetic for compaction-summary entries loaded from session JSONL.
 * The CLI has `CliCompactBoundaryMessage` for the live marker
 * (`system+compact_boundary`); this synthetic is the *historical*
 * summary row that the Claude CLI writes as `{ type: 'summary',
 * leafUuid, summary }` at the top of a compacted JSONL session file.
 */
export interface CompactionSummaryMessage extends OmnifexEnvelope {
  type: 'summary';
  leafUuid: string;
  summary: string;
}

export type ClaudeStreamMessage =
  | (AnchoredCliMessage & OmnifexEnvelope)
  | PermissionRequestMessage
  | SystemNotificationMessage
  | CompactionSummaryMessage;

// ---------------------------------------------------------------------------
// Narrowing guards
// ---------------------------------------------------------------------------

/** True when `msg` is the CLI's assistant variant (carries a wrapped BetaMessage). */
export function isAssistantMessage(
  msg: ClaudeStreamMessage,
): msg is CliAssistantMessage & OmnifexEnvelope {
  return msg.type === 'assistant';
}

/**
 * True when `msg` is a CLI user-variant — typed prompt, tool_result reply,
 * hook feedback, or JSONL-replay. Both `CliUserMessage` and
 * `CliUserMessageReplay` share `type: 'user'`.
 */
export function isUserMessage(
  msg: ClaudeStreamMessage,
): msg is (CliUserMessage | CliUserMessageReplay) & OmnifexEnvelope {
  return msg.type === 'user';
}

/** True when `msg` is a terminal turn result — success or error subtype. */
export function isResultMessage(
  msg: ClaudeStreamMessage,
): msg is CliResultMessage & OmnifexEnvelope {
  return msg.type === 'result';
}

// ---------------------------------------------------------------------------
// Content block discriminated union
// ---------------------------------------------------------------------------
//
// Anthropic publishes full beta block types (BetaTextBlock,
// BetaToolUseBlock, …) at @anthropic-ai/sdk/resources/beta/messages, but
// @anthropic-ai/sdk is not in OmniFex's package.json. Rather than depend on
// the beta module's path stability, we declare a local mirror covering only
// the discriminants / fields OmniFex's renderer actually reads. Add fields
// here when a new consumer needs them — don't reach into `as any` at call
// sites.
//
// Optional fields use `unknown` rather than precise types because the wire
// payload is wider than the compile-time block type (e.g. tool_result.content
// can be string | array). Callers that need the precise shape should narrow
// at use site with their own guards.

export interface MessageTextBlock {
  type: 'text';
  text: string;
  citations?: unknown;
}

export interface MessageThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface MessageRedactedThinkingBlock {
  type: 'redacted_thinking';
  data?: string;
}

export interface MessageToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  caller?: unknown;
}

export interface MessageServerToolUseBlock {
  type: 'server_tool_use';
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface MessageImageBlock {
  type: 'image';
  source?: {
    type?: string;
    media_type?: string;
    data?: string;
  };
}

export interface MessageToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | (MessageTextBlock | MessageImageBlock | { type: string; text?: string })[];
  is_error?: boolean;
}

/** Server-side code-execution result blocks (bash / text editor variants). */
export interface MessageCodeExecutionResultBlock {
  type: 'bash_code_execution_tool_result' | 'text_editor_code_execution_tool_result';
  tool_use_id?: string;
  content?: unknown;
}

/**
 * Union of every content-block shape OmniFex's renderer touches. Use with
 * `Array.isArray(content)` and switch on `block.type` to narrow. Unknown
 * future block types should fall through to a typed default — do NOT use
 * `as any` to bypass exhaustiveness.
 */
export type MessageContentBlock =
  | MessageTextBlock
  | MessageThinkingBlock
  | MessageRedactedThinkingBlock
  | MessageToolUseBlock
  | MessageServerToolUseBlock
  | MessageImageBlock
  | MessageToolResultBlock
  | MessageCodeExecutionResultBlock;

/**
 * Returns the inner content blocks for an assistant or user message, `undefined`
 * for any other variant. Always an array post boundary-normalization (see
 * `lib/normalizeMessage` — the CLI's bare-string user prompts get wrapped at
 * the JSONL / IPC ingress). Returned as `unknown` because Anthropic's
 * `BetaMessage.content` type doesn't expose `Array.isArray`-narrowable shape
 * to callers; consumers should guard with `Array.isArray(content)` and treat
 * non-array as "missing / malformed". Saves dozens of
 * `if (msg.type === 'assistant' || ...)` narrows across counters / classifiers
 * / filters.
 */
export function getMessageContent(msg: ClaudeStreamMessage): unknown {
  if (msg.type === 'assistant') return msg.message.content;
  if (msg.type === 'user') return msg.message?.content;
  return undefined;
}
