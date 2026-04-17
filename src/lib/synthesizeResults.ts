import type { ClaudeStreamMessage } from "@/components/AgentExecution";

// Rates used by the live session's client-side cost calc
// (see ClaudeCodeSession.tsx handleStreamMessage). Kept in sync so
// reloaded turns show the same cost we displayed live.
const INPUT_RATE_PER_TOKEN = 0.000003;
const OUTPUT_RATE_PER_TOKEN = 0.000015;

function parseTimestamp(ts: unknown): number | null {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const n = Date.parse(ts);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function lastTextOf(msg: ClaudeStreamMessage): string {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c: any) => c?.type === 'text')
    .map((c: any) => (typeof c.text === 'string' ? c.text : ''))
    .join('');
}

/**
 * True when this user message is an actual user-typed prompt (contains
 * a text block) rather than the CLI's tool_result reply feeding back into
 * the turn. Tool_result-only user messages appear between every tool_use
 * and the next assistant step — they are not turn boundaries.
 *
 * User messages can also have string content (not an array) — those come
 * from the CLI's initial prompt format and are treated as real prompts.
 */
function isUserTurnBoundary(msg: ClaudeStreamMessage): boolean {
  if (msg.type !== 'user') return false;
  const content: unknown = msg.message?.content;
  if (typeof content === 'string') return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((c: any) => c?.type === 'text');
}

function buildSyntheticResult(
  lastAssistant: ClaudeStreamMessage,
  durationMs: number,
  numTurns: number,
): ClaudeStreamMessage {
  const stopReason = (lastAssistant.message as any)?.stop_reason ?? null;
  const isError = typeof stopReason === 'string' && stopReason !== 'end_turn';
  const usage = (lastAssistant.message as any)?.usage ?? {};
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const totalCostUsd =
    inputTokens * INPUT_RATE_PER_TOKEN + outputTokens * OUTPUT_RATE_PER_TOKEN;

  return {
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError,
    duration_ms: Math.max(0, durationMs),
    num_turns: numTurns,
    stop_reason: stopReason,
    result: lastTextOf(lastAssistant),
    total_cost_usd: totalCostUsd,
    usage,
    session_id: (lastAssistant as any).sessionId ?? (lastAssistant as any).session_id ?? null,
    // Marker so downstream code can tell this was reconstructed from disk,
    // not emitted live by the SDK. Useful for debugging or tooltips.
    synthesized: true,
  } as unknown as ClaudeStreamMessage;
}

/**
 * Walk through a loaded session's messages and inject synthetic `result`
 * entries at turn boundaries so the "Execution Complete" card renders on
 * reload. The CLI's JSONL file does not persist live `result` messages.
 *
 * If the loaded stream already contains real `result` entries (e.g. a
 * future CLI version starts persisting them, or we merge from a sidecar),
 * return the input unchanged — we only fill the gap when it's actually a
 * gap.
 */
export function synthesizeResultMessages(
  messages: ClaudeStreamMessage[],
): ClaudeStreamMessage[] {
  if (messages.some((m) => m.type === 'result')) return messages;

  const out: ClaudeStreamMessage[] = [];
  let turnStartTs: number | null = null;
  let lastAssistant: ClaudeStreamMessage | null = null;
  let turnsSoFar = 0;

  const flushTurn = () => {
    if (!lastAssistant) return;
    const endTs = parseTimestamp((lastAssistant as any).timestamp);
    const startTs = turnStartTs ?? endTs ?? 0;
    const durationMs = endTs && startTs ? endTs - startTs : 0;
    turnsSoFar += 1;
    out.push(buildSyntheticResult(lastAssistant, durationMs, turnsSoFar));
    lastAssistant = null;
  };

  for (const msg of messages) {
    if (isUserTurnBoundary(msg)) {
      flushTurn();
      turnStartTs = parseTimestamp((msg as any).timestamp);
      out.push(msg);
      continue;
    }
    // Assistant messages end a turn only when their stop_reason is
    // 'end_turn'. Mid-turn assistant messages with stop_reason 'tool_use'
    // are interstitial steps; do not treat them as the turn's final say.
    if (msg.type === 'assistant') {
      const stop = (msg.message as any)?.stop_reason;
      if (stop === 'end_turn') {
        lastAssistant = msg;
      }
    }
    out.push(msg);
  }

  flushTurn();

  return out;
}
