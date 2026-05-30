/**
 * Resolve the context-window size to render the usage gauge against.
 *
 * Rule: when the live CLI reports a context window (`contextUsage.maxTokens`),
 * it is authoritative for THIS running session — use it verbatim. The session's
 * `remaining_tokens` is measured against its active window, so total+remaining
 * (i.e. maxTokens) IS the active window, not the model's max capability.
 *
 * The previous logic clamped the live max to 200k unless the model string
 * contained the "[1m]" opt-in suffix. But that suffix is a UI-only artifact: it
 * is the dropdown selection, and it does NOT survive a resume (the JSONL records
 * the base model id `claude-opus-4-8`, and `selectedModel` falls back to "opus"
 * with no suffix). So a resumed 1M session was permanently pinned to 200k even
 * though the live CLI was reporting the true 1M window. Trusting the live number
 * fixes resume and is a no-op for sessions whose live window already matches.
 *
 * The model-suffix heuristic is kept ONLY for the fallback path, before any live
 * `contextUsage` has arrived, where the model name is the only signal we have.
 */
export function resolveContextLimit(opts: {
  /** `contextUsage.maxTokens` from the live CLI, or null when no live data yet. */
  sdkMaxTokens: number | null;
  /** The selected/known model string; may carry the UI "[1m]" suffix. */
  model: string | undefined;
}): number {
  const { sdkMaxTokens, model } = opts;

  if (sdkMaxTokens != null && sdkMaxTokens > 0) {
    return sdkMaxTokens;
  }

  const expectsLargeContext = !!model?.includes('[1m]');
  return expectsLargeContext ? 1_000_000 : 200_000;
}
