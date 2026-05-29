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

/**
 * Order-correct reconstitution of committed assistant frames.
 *
 * The real `--include-partial-messages` stream emits each message as
 * `message_start` → (content) → committed `{type:'assistant'}` (stop_reason
 * null, stub usage) → `content_block_stop` → `message_delta` (resolved
 * stop_reason + final usage) → `message_stop`. The committed frame therefore
 * arrives BEFORE the delta that resolves it.
 *
 * This resolver buffers each committed assistant (keyed by its parent chain),
 * merges the `message_delta` that arrives within the same message bracket, and
 * forwards the resolved frame at `message_stop`. It is robust to the reversed
 * order too (delta first → stashed, applied when the committed frame lands),
 * isolates subagent chains from the main chain via `parent_tool_use_id`, and
 * never drops a frame — a delta-less message is forwarded unchanged, and a
 * `result` flushes anything still buffered.
 *
 * `resolve(payload)` returns the frames to forward, in order (0, 1, or 2):
 * buffering the committed assistant yields `[]`; `message_stop`/`result`/any
 * out-of-band frame flushes the buffered assistant ahead of itself.
 */
export function createAssistantResolver(): { resolve(payload: unknown): unknown[] } {
  const buffered = new Map<string, { messageId: string | null; payload: Record<string, unknown> }>();
  const pendingDelta = new Map<string, { messageId: string | null; meta: AssistantMeta }>();
  const openMessageId = new Map<string, string | null>();

  function flush(key: string, out: unknown[]): void {
    const b = buffered.get(key);
    if (b) {
      out.push(b.payload);
      buffered.delete(key);
    }
  }

  return {
    resolve(payload: unknown): unknown[] {
      if (!isRecord(payload)) return [payload];
      const key = deltaStashKey(payload as { parent_tool_use_id?: unknown });
      const type = payload.type;

      if (type === 'stream_event') {
        const event = isRecord(payload.event) ? payload.event : undefined;
        const eventType = event?.type;

        if (eventType === 'message_start') {
          const m = isRecord(event?.message) ? event.message : undefined;
          openMessageId.set(key, typeof m?.id === 'string' ? m.id : null);
          return [payload];
        }

        if (eventType === 'message_delta') {
          const meta = readMessageDeltaMeta(payload);
          if (meta) {
            const b = buffered.get(key);
            const openId = openMessageId.get(key) ?? null;
            if (b && (b.messageId === openId || openId === null)) {
              applyAssistantMeta(b.payload, meta);
            } else if (!b) {
              // Reversed order: delta before the committed frame — stash it.
              pendingDelta.set(key, { messageId: openId, meta });
            }
          }
          return [payload];
        }

        if (eventType === 'message_stop') {
          const out: unknown[] = [];
          flush(key, out);
          openMessageId.set(key, null);
          out.push(payload);
          return out;
        }

        // content_block_* and any other stream_event: pass through untouched.
        return [payload];
      }

      if (type === 'assistant') {
        const out: unknown[] = [];
        // Safety: a still-buffered assistant from the prior bracket flushes first.
        flush(key, out);
        const message = isRecord(payload.message) ? payload.message : undefined;
        const messageId = typeof message?.id === 'string' ? message.id : null;
        const pd = pendingDelta.get(key);
        if (pd && (pd.messageId === messageId || pd.messageId === null)) {
          applyAssistantMeta(payload, pd.meta);
          pendingDelta.delete(key);
        }
        buffered.set(key, { messageId, payload: payload as Record<string, unknown> });
        return out;
      }

      if (type === 'result') {
        const out: unknown[] = [];
        for (const k of [...buffered.keys()]) flush(k, out);
        pendingDelta.clear();
        openMessageId.clear();
        out.push(payload);
        return out;
      }

      // Any other frame (user/tool_result, system, rate_limit_event, …):
      // flush this chain's buffered assistant ahead of it to preserve order.
      const out: unknown[] = [];
      flush(key, out);
      out.push(payload);
      return out;
    },
  };
}
