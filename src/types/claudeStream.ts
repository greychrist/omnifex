/**
 * Shape of one message off the Claude Agent SDK stream, as the renderer
 * receives it on `claude-output:<tabId>` events.
 *
 * Anchored on `SDKMessage` (the SDK's 29-variant discriminated union)
 * intersected with `OmnifexEnvelope` (the main process timestamps each
 * message as it crosses the IPC boundary). Three OmniFex synthetic
 * variants cover what the SDK doesn't model:
 *
 *   - `permission_request` — emitted by `canUseTool` for the in-app
 *     permission gate. Wire is snake_case; the reducer normalises to
 *     camelCase `PermissionRequestPayload` before downstream consumers.
 *   - `system` + `notification` — OmniFex's toast-style status row
 *     (info/warn/error/stop). Distinct from `SDKNotificationMessage`
 *     (which has key/text/priority for the REPL notification queue) —
 *     we `Exclude` the SDK variant from the union so the discriminator
 *     unambiguously names the OmniFex shape.
 *   - `summary` — compaction summary loaded from session JSONL.
 *
 * Why anchor on the full `SDKMessage` rather than enumerate variants:
 * `subagentStreams.ts` consumes `task_started`/`task_progress`/
 * `task_notification`/`task_updated`; `messageFilters.ts` drops the
 * `hook_started`/`hook_progress`/`hook_response` family as plumbing
 * noise; `messageKind.ts` classifies `hook_started`/`hook_response`
 * (`hook_progress` is never reached because the filter strips it
 * upstream). Enumerating only the handful with first-class rendering
 * would force every other site back through casts. Using the SDK's
 * own union and `Exclude`-ing the one colliding variant is the
 * smallest change that lets the compiler narrow correctly throughout.
 */

import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKNotificationMessage,
  SDKResultMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
} from '@anthropic-ai/claude-agent-sdk';
import type { PermissionSuggestion } from '../lib/types/permissionRequest';

/**
 * Fields the main process attaches to every message as it crosses the IPC
 * boundary. Live messages receive `receivedAt`; JSONL-reloaded messages
 * carry `timestamp`. `synthesized` marks result rows reconstructed by
 * `synthesizeResultMessages` rather than emitted by the SDK.
 */
export interface OmnifexEnvelope {
  /** ISO timestamp stamped when the main process received the message from the SDK stream. */
  receivedAt?: string;
  /** Wall-clock timestamp from JSONL history. Distinct from `receivedAt`. */
  timestamp?: string;
  /** True on messages reconstructed by `synthesizeResultMessages` rather than emitted live. */
  synthesized?: boolean;
  /**
   * Annotation applied by OmniFex's JSONL loader to messages the SDK marked
   * `meta`. The renderer skips meta rows unless an exemption applies (skill
   * injection, system context). Not emitted on live-stream messages.
   */
  isMeta?: boolean;
}

/**
 * `SDKMessage` minus `SDKNotificationMessage`. The SDK variant carries
 * `{ key, text, priority }` for the REPL's notification queue; OmniFex's
 * `SystemNotificationMessage` synthetic occupies the same `system+notification`
 * discriminator with a different shape. The SDK shape is never currently
 * emitted to the renderer; if that changes, route it through a distinct
 * subtype rather than colliding here.
 */
type AnchoredSDKMessage = Exclude<SDKMessage, SDKNotificationMessage>;

/**
 * `permission_request` is OmniFex-synthetic — it travels on the same
 * `claude-output:<tabId>` channel as SDK messages and is normalised
 * onto `PermissionRequestPayload` by `sessionStreamReducer`. Snake_case
 * field names match the wire format emitted by `permissions.ts`.
 */
export interface PermissionRequestMessage extends OmnifexEnvelope {
  type: 'permission_request';
  request_id: string;
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
 * SDK has `SDKCompactBoundaryMessage` for the live marker
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
  | (AnchoredSDKMessage & OmnifexEnvelope)
  | PermissionRequestMessage
  | SystemNotificationMessage
  | CompactionSummaryMessage;

// ---------------------------------------------------------------------------
// Narrowing guards
// ---------------------------------------------------------------------------

/** True when `msg` is the SDK's assistant variant (carries a wrapped BetaMessage). */
export function isAssistantMessage(
  msg: ClaudeStreamMessage,
): msg is SDKAssistantMessage & OmnifexEnvelope {
  return msg.type === 'assistant';
}

/**
 * True when `msg` is an SDK user-variant — typed prompt, tool_result reply,
 * hook feedback, or JSONL-replay. Both `SDKUserMessage` and
 * `SDKUserMessageReplay` share `type: 'user'`.
 */
export function isUserMessage(
  msg: ClaudeStreamMessage,
): msg is (SDKUserMessage | SDKUserMessageReplay) & OmnifexEnvelope {
  return msg.type === 'user';
}

/** True when `msg` is a terminal turn result — success or error subtype, real or synthesized. */
export function isResultMessage(
  msg: ClaudeStreamMessage,
): msg is SDKResultMessage & OmnifexEnvelope {
  return msg.type === 'result';
}

/**
 * Returns the inner content blocks for an assistant or user message, `undefined`
 * for any other variant. Always an array post boundary-normalization (see
 * `lib/normalizeMessage` — the CLI's bare-string user prompts get wrapped at
 * the JSONL / IPC ingress). Returned as `unknown` because the SDK's own
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
