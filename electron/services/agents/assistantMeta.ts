// Reconstitutes the assistant metadata that --include-partial-messages splits
// across stream frames.
//
// Under `--include-partial-messages`, the Claude CLI emits the committed
// `{type:'assistant'}` frame with `stop_reason: null` and stub `usage`
// (the message_start-era metadata). The *resolved* stop_reason and final
// usage ride the trailing `message_delta` stream_event, which is otherwise
// consumed only for the typewriter overlay and dropped. That left every
// committed assistant in messages[] with a null stop_reason — which pinned
// `waitingOnClaude` true, suppressed the end-turn card / completion band, and
// produced bogus per-message cost.
//
// The engine stashes the latest message_delta per parent-chain and merges it
// into the next committed assistant for that chain, so downstream consumers
// see honest, fully-resolved frames. Pure so it can be unit-tested without a
// live CLI process.

export interface AssistantMeta {
  stopReason: string | null;
  usage?: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Stash key for a frame. Keys by `parent_tool_use_id` so a subagent's
 * message_delta never merges into a main-chain assistant (or vice versa);
 * main-chain frames (null/absent parent) share one stable key.
 */
export function deltaStashKey(frame: { parent_tool_use_id?: unknown }): string {
  const pid = frame.parent_tool_use_id;
  return typeof pid === 'string' && pid.length > 0 ? pid : '__main__';
}

/**
 * Extract `{stopReason, usage}` from a `message_delta` stream_event, or null
 * if the payload is not one (text deltas, message_start/stop, committed
 * messages, control frames, etc. all return null).
 */
export function readMessageDeltaMeta(payload: unknown): AssistantMeta | null {
  if (!isRecord(payload) || payload.type !== 'stream_event') return null;
  const event = payload.event;
  if (!isRecord(event) || event.type !== 'message_delta') return null;
  const delta = isRecord(event.delta) ? event.delta : undefined;
  const stopReasonRaw = delta?.stop_reason;
  const stopReason = typeof stopReasonRaw === 'string' ? stopReasonRaw : null;
  const usage = isRecord(event.usage) ? (event.usage as Record<string, unknown>) : undefined;
  return { stopReason, usage };
}

/**
 * Merge a stashed message_delta into a committed `{type:'assistant'}` payload.
 *
 * Only fills `stop_reason` when the committed frame left it null — a frame
 * that already resolved its own stop_reason (some CLI versions/paths do) is
 * never overwritten. Usage is shallow-merged with the delta's values winning
 * (the delta carries the final rolled-up `output_tokens`). Returns the same
 * payload reference for non-assistant inputs so callers can pass everything
 * through unconditionally.
 */
export function applyAssistantMeta(payload: unknown, meta: AssistantMeta): unknown {
  if (!isRecord(payload) || payload.type !== 'assistant') return payload;
  const message = payload.message;
  if (!isRecord(message)) return payload;
  if (message.stop_reason != null) return payload;

  message.stop_reason = meta.stopReason;
  if (meta.usage) {
    const existing = isRecord(message.usage) ? message.usage : {};
    message.usage = { ...existing, ...meta.usage };
  }
  return payload;
}
