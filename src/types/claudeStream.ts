/**
 * Shape of one message off the Claude Agent SDK stream, as we receive it
 * in the renderer. Mirrors what `claude-output:<tabId>` events deliver.
 *
 * The SDK exposes a richer discriminated union (`SDKMessage` in
 * `@anthropic-ai/claude-agent-sdk` — see `node_modules/.../sdk.d.ts`).
 * OmniFex deliberately keeps a permissive index signature here so JSONL-
 * loaded sessions, synthesized result cards, and tool-specific fields
 * we don't model can pass through the renderer without ceremony.
 *
 * The well-known fields below — including the inner `message.stop_reason`,
 * `message.usage.cache_*` cache attribution, and the OmniFex augmentations
 * like `receivedAt` / `synthesized` / `timestamp` — are typed explicitly so
 * hot-path consumers (synthesizeResults, the result card, classifiers) can
 * read them without `as any` casts. New consumers should prefer adding to
 * this declaration over reaching through the index signature.
 */
export interface ClaudeStreamMessage {
  /**
   * Discriminator. The first five are SDK-emitted variants; `permission_request`
   * is an OmniFex-side synthetic for the canUseTool gate; `summary` is the
   * compaction-summary synthetic (carries `leafUuid` + `summary`); and
   * `stream_event` is the SDK's partial-assistant frame (carries `event`
   * with text/JSON deltas).
   */
  type:
    | 'system'
    | 'assistant'
    | 'user'
    | 'result'
    | 'permission_request'
    | 'summary'
    | 'stream_event';
  subtype?: string;
  request_id?: string;
  tool_name?: string;
  tool_input?: Record<string, any>;
  /** The wrapped Anthropic message — present on `assistant` and `user` rows. */
  message?: {
    /** Mixed content blocks: `text`, `thinking`, `tool_use`, `tool_result`, `image`, … */
    content?: any[];
    /**
     * Why the model stopped on this turn. Terminal values: `end_turn`,
     * `stop_sequence`, `max_tokens`, `refusal`, `model_context_window_exceeded`.
     * Non-terminal: `tool_use`, `pause_turn`. `null`/absent on partial streams.
     * See `synthesizeResults.ts` for the terminal-stop classification.
     */
    stop_reason?: string | null;
    /** Per-call token usage, with prompt-caching attribution. */
    usage?: {
      input_tokens: number;
      output_tokens: number;
      /** Tokens served from the prompt cache (~0.1× input price). */
      cache_read_input_tokens?: number;
      /** Tokens written to the prompt cache (~1.25× input price, 5-min TTL). */
      cache_creation_input_tokens?: number;
    };
  };
  /** Per-turn usage on the synthesized result row (not the inner SDK message). */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  /**
   * ISO timestamp stamped by the main process as the message was received
   * from the SDK stream. Absent on messages loaded from a session's JSONL
   * (the SDK's history has no per-message receive timestamp).
   */
  receivedAt?: string;
  /**
   * Wall-clock timestamp from the JSONL session history. Distinct from
   * `receivedAt`: live messages have `receivedAt`, reloaded messages have
   * `timestamp`. Synthesized result cards inherit one or the other.
   */
  timestamp?: string;
  /** SDK session ID; mirrored on every message after init. */
  sessionId?: string;
  session_id?: string;
  /**
   * Set on assistant messages emitted by a subagent (Task/Agent tool); links
   * back to the parent tool_use block. `null` on the user's own thread.
   */
  parent_tool_use_id?: string | null;
  /** True on JSONL-loaded messages that the SDK marked `meta` (skip rendering unless exempted). */
  isMeta?: boolean;
  /**
   * Marker for messages reconstructed by `synthesizeResultMessages` — they
   * were not emitted live by the SDK. Useful for debugging or tooltips.
   */
  synthesized?: boolean;
  // Tool-specific fields, error details, and other rare augmentations pass
  // through the index signature. Prefer adding to this interface over
  // reaching through the index signature in new code.
  [key: string]: any;
}

/** True when `msg` is the SDK's assistant variant. */
export function isAssistantMessage(
  msg: ClaudeStreamMessage,
): msg is ClaudeStreamMessage & { type: 'assistant'; message: NonNullable<ClaudeStreamMessage['message']> } {
  return msg.type === 'assistant' && msg.message != null;
}

/** True when `msg` is the SDK's user variant (typed prompt, tool_result reply, or hook feedback). */
export function isUserMessage(
  msg: ClaudeStreamMessage,
): msg is ClaudeStreamMessage & { type: 'user' } {
  return msg.type === 'user';
}

/** True when `msg` is a terminal turn result — either real (from SDK) or synthesized. */
export function isResultMessage(
  msg: ClaudeStreamMessage,
): msg is ClaudeStreamMessage & { type: 'result' } {
  return msg.type === 'result';
}
