import type { JsonlNode } from "@/types/jsonl";

/** A thinking burst currently in flight. `tokens` is the CLI's running estimate. */
export interface ThinkingStatus {
  tokens: number;
  /**
   * Epoch ms of the burst's FIRST ping, so an elapsed counter can be rendered
   * without anyone storing a start time.
   *
   * Derived rather than stamped with `Date.now()` on first sight: the pill has
   * to survive a remount (tab switch, panel open) without the clock restarting
   * from zero, and it has to read the same on a resumed transcript as it did
   * live. Null when the CLI omitted a usable timestamp.
   */
  startedAt: number | null;
}

/**
 * Reports the in-flight thinking burst, if the transcript is in one.
 *
 * `system:thinking_tokens` pings carry a running cumulative estimate for the
 * current burst, so the newest ping at the tail of `messages` *is* the live
 * total — nothing needs summing and no turn-end signal needs plumbing. A burst
 * is over as soon as any non-`system` node lands (the assistant text or tool
 * use the thinking produced), which is what makes the activity pill stop
 * reporting on its own.
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
  let tokens: number | null = null;
  let startedAt: number | null = null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.kind !== "system") break;
    if (message.subtype !== "thinking_tokens") continue;

    // Newest ping wins for the count; the scan then keeps walking back so the
    // OLDEST ping of the same burst supplies the start time.
    const estimate = (message.raw as { estimated_tokens?: number }).estimated_tokens;
    if (typeof estimate !== "number") break;
    if (tokens === null) tokens = estimate;
    const at = Date.parse(message.receivedAt);
    if (Number.isFinite(at)) startedAt = at;
  }

  return tokens === null ? null : { tokens, startedAt };
}
