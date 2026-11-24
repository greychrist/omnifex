import type { PermissionSuggestion } from '../lib/types/permissionRequest';

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

export type CliUserMessageReplay = CliUserMessage;

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

export interface CliResultMessage extends CliResultBase {
  subtype: 'success';
  result?: string;
}

/** Never emitted to the renderer; declared only so the union can exclude it. */
export interface CliNotificationMessage {
  type: 'system';
  subtype: 'notification';
  key?: string;
  text?: string;
  priority?: 'info' | 'warn' | 'error';
}

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

export type CliResultErrorSubtype = 'error_max_turns' | 'error_during_execution' | (string & { __brand?: never });
export interface CliResultErrorMessage extends CliResultBase {
  subtype: Exclude<CliResultErrorSubtype, 'success'>;
  errors?: string[];
  result?: string;
}

/** No index signature: one here would widen `message` on the other variants to `unknown`. */
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
  subtype: CliSystemOtherSubtype;
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

export interface OmnifexEnvelope {
  receivedAt?: string;
  timestamp?: string;
  isMeta?: boolean;
  /** Classifier kind ID; consumers read this instead of re-deriving from type/subtype. */
  streamKind?: string;
}

/** Excludes the CLI's `system+notification` shape: OmniFex's SystemNotificationMessage owns that discriminator. */
type AnchoredCliMessage = Exclude<CliMessage, CliNotificationMessage>;

/** OmniFex-synthetic; snake_case matches the wire from `permissions.ts`. */
export interface PermissionRequestMessage extends OmnifexEnvelope {
  type: 'permission_request';
  request_id: string;
  kind?: 'tool' | 'patch' | 'exec';
  agent?: 'claude' | 'codex';
  summary?: string;
  codex_payload?: unknown;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  title?: string;
  display_name?: string;
  description?: string;
  decision_reason?: string;
  blocked_path?: string;
  directory_grant?: string[];
  permission_suggestions?: PermissionSuggestion[];
  /** CLI-set: offer no "don't ask again" for this ask. */
  suppress_always_allow_rule?: boolean;
}

/** `body`, not `message`: `message` collides with the wrapped Anthropic message on assistant/user. */
export interface SystemNotificationMessage extends OmnifexEnvelope {
  type: 'system';
  subtype: 'notification';
  notification_type: 'info' | 'warn' | 'error' | 'stop';
  title?: string;
  body?: string;
}

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

export function isAssistantMessage(
  msg: ClaudeStreamMessage,
): msg is CliAssistantMessage & OmnifexEnvelope {
  return msg.type === 'assistant';
}

export function isUserMessage(
  msg: ClaudeStreamMessage,
): msg is (CliUserMessage  ) & OmnifexEnvelope {
  return msg.type === 'user';
}

export function isResultMessage(
  msg: ClaudeStreamMessage,
): msg is CliResultMessage & OmnifexEnvelope {
  return msg.type === 'result';
}

/** Optional: the field can be absent, not just empty. Read via `?? ''`. */
export interface MessageTextBlock {
  type: 'text';
  text?: string;
  citations?: unknown;
}

export interface MessageThinkingBlock {
  type: 'thinking';
  thinking?: string;
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

export interface MessageCodeExecutionResultBlock {
  type: 'bash_code_execution_tool_result' | 'text_editor_code_execution_tool_result';
  tool_use_id?: string;
  content?: unknown;
}

export type MessageContentBlock =
  | MessageTextBlock
  | MessageThinkingBlock
  | MessageRedactedThinkingBlock
  | MessageToolUseBlock
  | MessageServerToolUseBlock
  | MessageImageBlock
  | MessageToolResultBlock
  | MessageCodeExecutionResultBlock;

export function getMessageContent(msg: ClaudeStreamMessage): unknown {
  if (msg.type === 'assistant') return msg.message.content;
  if (msg.type === 'user') return msg.message?.content;
  return undefined;
}
