import type { ClaudeStreamMessage } from "@/types/claudeStream";
import { isAssistantMessage } from "@/types/claudeStream";

// Rates used by the live session's client-side cost calc
// (see ClaudeCodeSession.tsx handleStreamMessage). Kept in sync so
// reloaded turns show the same cost we displayed live.
const INPUT_RATE_PER_TOKEN = 0.000003;
const OUTPUT_RATE_PER_TOKEN = 0.000015;

/**
 * Stop reasons that terminate a turn. The assistant has nothing more to
 * say on this exchange, even if the turn didn't end cleanly. We synthesize
 * a result card for every one of these on reload so the user sees a
 * closing summary instead of the cut-off assistant message just dangling.
 *
 * Excluded:
 * - `tool_use` — mid-turn step; the turn continues with a tool_result
 *   user message + another assistant step.
 * - `pause_turn` — server-side tool loop hit its iteration limit; the
 *   harness re-sends to resume, so this is recoverable, not terminal.
 * - `null` / absent — partial or interrupted assistant streams.
 */
const TERMINAL_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'stop_sequence',
  'max_tokens',
  'refusal',
  'model_context_window_exceeded',
]);

/** Subset of terminal stops that represent a clean completion. */
const SUCCESS_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'stop_sequence',
]);

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
  const inner = lastAssistant.message;
  const stopReason = inner?.stop_reason ?? null;
  // Success = clean completion (end_turn / stop_sequence). Everything else
  // that landed here is a terminal-but-unsuccessful stop (max_tokens,
  // refusal, model_context_window_exceeded) — surface as an error so the
  // result card uses the appropriate styling.
  const isError =
    typeof stopReason === 'string' && !SUCCESS_STOP_REASONS.has(stopReason);
  const usage = inner?.usage ?? { input_tokens: 0, output_tokens: 0 };
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const totalCostUsd =
    inputTokens * INPUT_RATE_PER_TOKEN + outputTokens * OUTPUT_RATE_PER_TOKEN;

  // Inherit the last assistant message's timestamp so the Execution Complete
  // card shows a footer time on reloaded sessions, matching live behavior.
  const ts = lastAssistant.receivedAt ?? lastAssistant.timestamp ?? null;

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
    session_id: lastAssistant.sessionId ?? lastAssistant.session_id,
    receivedAt: ts ?? undefined,
    // Marker so downstream code can tell this was reconstructed from disk,
    // not emitted live by the SDK. Useful for debugging or tooltips.
    synthesized: true,
  };
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
    const endTs = parseTimestamp(lastAssistant.timestamp);
    const startTs = turnStartTs ?? endTs ?? 0;
    const durationMs = endTs && startTs ? endTs - startTs : 0;
    turnsSoFar += 1;
    out.push(buildSyntheticResult(lastAssistant, durationMs, turnsSoFar));
    lastAssistant = null;
  };

  for (const msg of messages) {
    if (isUserTurnBoundary(msg)) {
      flushTurn();
      turnStartTs = parseTimestamp(msg.timestamp);
      out.push(msg);
      continue;
    }
    // Assistant messages end a turn on any TERMINAL_STOP_REASONS value —
    // clean completions (end_turn / stop_sequence) and unsuccessful but
    // terminal ones (max_tokens / refusal / model_context_window_exceeded).
    // Mid-turn `tool_use` stops are interstitial steps; `pause_turn` is
    // resumable; partial streams have no stop_reason at all. None of those
    // are turn-enders.
    if (isAssistantMessage(msg)) {
      const stop = msg.message.stop_reason;
      if (typeof stop === 'string' && TERMINAL_STOP_REASONS.has(stop)) {
        lastAssistant = msg;
      }
    }
    out.push(msg);
  }

  flushTurn();

  return out;
}
