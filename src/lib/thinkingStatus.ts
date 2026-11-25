import type { JsonlNode } from "@/types/jsonl";
import { forwardedParentToolUseId } from "@/lib/subagentDispatch";

/** A thinking burst currently in flight. `tokens` is the CLI's running estimate. */
export interface ThinkingStatus {
  tokens: number;
  /** The burst's FIRST ping, derived rather than Date.now() so it survives remounts and resumes. */
  startedAt: number | null;
}

/** Non-system nodes end a burst; system ones (status pings) don't. Must agree with messageFilters' lastThinkingTokensPerBurst. */
export function deriveThinkingStatus(messages: JsonlNode[]): ThinkingStatus | null {
  let tokens: number | null = null;
  let startedAt: number | null = null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.kind !== "system") break;
    if (message.subtype !== "thinking_tokens") continue;

    const estimate = (message.raw as { estimated_tokens?: number }).estimated_tokens;
    if (typeof estimate !== "number") break;
    if (tokens === null) tokens = estimate;
    const at = Date.parse(message.receivedAt);
    if (Number.isFinite(at)) startedAt = at;
  }

  return tokens === null ? null : { tokens, startedAt };
}

/** Every burst since the prompt. Null when the latest turn didn't think: the previous figure would read as this one's. */
export function lastTurnThinkingTokens(messages: JsonlNode[]): number | null {
  let total: number | null = null;
  let inBurst = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.kind === "user" && (message.userKind === "prompt" || message.userKind === "peer-message") && forwardedParentToolUseId(message.raw) === null) break;
    if (message.kind !== "system") {
      inBurst = false;
      continue;
    }
    if (message.subtype !== "thinking_tokens" || inBurst) continue;
    const estimate = (message.raw as { estimated_tokens?: number }).estimated_tokens;
    if (typeof estimate !== "number") continue;
    total = (total ?? 0) + estimate;
    inBurst = true;
  }
  return total;
}
