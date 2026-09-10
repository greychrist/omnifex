import type { JsonlNode } from "@/types/jsonl";

/** A thinking burst currently in flight. `tokens` is the CLI's running estimate. */
export interface ThinkingStatus {
  tokens: number;
}

/**
 * Reports the in-flight thinking burst, if the transcript is in one.
 *
 * `system:thinking_tokens` pings carry a running cumulative estimate for the
 * current burst, so the newest ping at the tail of `messages` *is* the live
 * total — nothing needs summing and no turn-end signal needs plumbing. A burst
 * is over as soon as any non-`system` node lands (the assistant text or tool
 * use the thinking produced), which is what makes the ThinkingBar disappear on
 * its own.
 *
 * Interleaved *system* nodes are skipped rather than treated as terminators:
 * `status` phase pings share the stream with thinking and are themselves never
 * rendered, so ending the burst on one would blink the bar out mid-thought.
 * This is the same burst boundary `lastThinkingTokensPerBurst` applies in
 * messageFilters, and the two must agree — the row the filter leaves behind is
 * the same ping this function was last reading.
 *
 * Scans backwards from the tail and stops at the first decision, so appending a
 * message costs a handful of comparisons regardless of transcript length.
 */
export function deriveThinkingStatus(messages: JsonlNode[]): ThinkingStatus | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.kind !== "system") return null;
    if (message.subtype !== "thinking_tokens") continue;

    const tokens = (message.raw as { estimated_tokens?: number }).estimated_tokens;
    return typeof tokens === "number" ? { tokens } : null;
  }
  return null;
}
