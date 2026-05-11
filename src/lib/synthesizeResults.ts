import type { ClaudeStreamMessage } from "@/types/claudeStream";
import { getMessageContent, isAssistantMessage } from "@/types/claudeStream";

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
  const content = getMessageContent(msg);
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
  const content = getMessageContent(msg);
  if (typeof content === 'string') return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((c: any) => c?.type === 'text');
}

function buildSyntheticResult(
  lastAssistant: ClaudeStreamMessage,
  durationMs: number,
  numTurns: number,
): ClaudeStreamMessage {
  // Only assistant messages drive synthesis, but the parameter is the union
  // because flushTurn passes whatever it last saw. Narrow explicitly so the
  // SDK BetaMessage shape is reachable.
  const inner = isAssistantMessage(lastAssistant) ? lastAssistant.message : null;
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

  // SDK's SDKResultSuccess / SDKResultError require fields we don't have on
  // reload (`duration_api_ms`, `modelUsage`, `permission_denials`, `uuid`).
  // Synthesized results pad them with zero-equivalents; the renderer's
  // result card reads `result`, `is_error`, `usage`, `total_cost_usd`,
  // `stop_reason`, `synthesized`, and `session_id` — never the padding.
  const sessionId = isAssistantMessage(lastAssistant)
    ? lastAssistant.session_id
    : undefined;
  const base = {
    duration_ms: Math.max(0, durationMs),
    duration_api_ms: 0,
    num_turns: numTurns,
    stop_reason: stopReason,
    total_cost_usd: totalCostUsd,
    usage: usage as never,
    modelUsage: {},
    permission_denials: [],
    session_id: sessionId ?? '',
    uuid: '' as never,
    receivedAt: ts ?? undefined,
    synthesized: true as const,
  };

  // Both branches carry the last assistant text on `result`. The SDK's
  // SDKResultError type officially omits `result` (it has `errors: string[]`
  // instead), but OmniFex's synthesized error rows still want to surface the
  // truncated assistant message body — the Execution Failed card renders it
  // directly. The cast-widen lets us keep that behavior; downstream
  // consumers that read `result` already check `subtype === 'success'` per
  // the SDK contract, so this extra field is benign noise on the error
  // path. See `result.error`-kind tests in synthesizeResults.test.ts.
  const result = lastTextOf(lastAssistant);
  if (isError) {
    return {
      ...base,
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [],
      result,
    } as ClaudeStreamMessage;
  }
  return {
    ...base,
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
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
