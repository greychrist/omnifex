// Under --include-partial-messages the committed assistant frame has stop_reason: null and stub usage;
// the resolved values ride the trailing message_delta, which arrives after it.

export interface AssistantMeta {
  stopReason: string | null;
  usage?: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Keyed by parent_tool_use_id so a subagent's delta never merges into the main chain. */
export function deltaStashKey(frame: { parent_tool_use_id?: unknown }): string {
  const pid = frame.parent_tool_use_id;
  return typeof pid === 'string' && pid.length > 0 ? pid : '__main__';
}

export function readMessageDeltaMeta(payload: unknown): AssistantMeta | null {
  if (!isRecord(payload) || payload.type !== 'stream_event') return null;
  const event = payload.event;
  if (!isRecord(event) || event.type !== 'message_delta') return null;
  const delta = isRecord(event.delta) ? event.delta : undefined;
  const stopReasonRaw = delta?.stop_reason;
  const stopReason = typeof stopReasonRaw === 'string' ? stopReasonRaw : null;
  const usage = isRecord(event.usage) ? (event.usage) : undefined;
  return { stopReason, usage };
}

/** Never overwrites a stop_reason the frame already resolved; the delta's usage wins (it carries the final output_tokens). */
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

/** Handles either order and never drops a frame: a delta-less message passes unchanged, and `result` flushes anything buffered. */
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
      const key = deltaStashKey(payload);
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

        return [payload];
      }

      if (type === 'assistant') {
        const out: unknown[] = [];
        flush(key, out);
        const message = isRecord(payload.message) ? payload.message : undefined;
        const messageId = typeof message?.id === 'string' ? message.id : null;
        const pd = pendingDelta.get(key);
        if (pd && (pd.messageId === messageId || pd.messageId === null)) {
          applyAssistantMeta(payload, pd.meta);
          pendingDelta.delete(key);
        }
        buffered.set(key, { messageId, payload: payload });
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

      // Flush this chain's buffered assistant first to preserve order.
      const out: unknown[] = [];
      flush(key, out);
      out.push(payload);
      return out;
    },
  };
}
