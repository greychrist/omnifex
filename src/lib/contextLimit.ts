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
 *
 * The fallback is reached more often than you'd think: resuming a session loads
 * its history statically (loadSessionHistory) and never fetches live usage —
 * that only happens on a stream init/result/compact_boundary — so an idle
 * resumed session sits on the fallback until its next turn, even in chat mode.
 * (TUI mode never reports a live window at all; `get_context_usage` is a no-op
 * there — see electron/services/sessions/queries.ts `liveEngine`.)
 *
 * In that fallback, an "Account Default" session's own model string never
 * carries "[1m]" (it's the base id from the JSONL, or the "default" sentinel),
 * so the only signal that the resolved default is a 1M model is the account's
 * settings.json `model` value (e.g. "opus[1m]"). `defaultModel` carries that,
 * so a resumed Account-Default 1M session isn't pinned to 200k.
 */
export function resolveContextLimit(opts: {
  /** `contextUsage.maxTokens` from the live CLI, or null when no live data yet. */
  sdkMaxTokens: number | null;
  /** The selected/known model string; may carry the UI "[1m]" suffix. */
  model: string | undefined;
  /** The account's resolved default model (settings.json `model`), used when
   *  the session runs "Account Default" and its own model string lacks [1m]. */
  defaultModel?: string | null;
}): number {
  const { sdkMaxTokens, model, defaultModel } = opts;

  if (sdkMaxTokens != null && sdkMaxTokens > 0) {
    return sdkMaxTokens;
  }

  const has1m = (s: string | null | undefined): boolean => !!s && s.includes('[1m]');

  let expectsLargeContext = has1m(model);
  if (!expectsLargeContext && has1m(defaultModel)) {
    // Only let the account's 1M default size this session when the session is
    // actually running that default: no explicit model, the "default" sentinel,
    // or the same model family. An explicit cross-family pick (e.g. sonnet on an
    // opus[1m]-default account) must NOT inherit the 1M window.
    const usingDefault =
      !model || model === 'default' || familyOf(model) === familyOf(defaultModel);
    expectsLargeContext = usingDefault;
  }
  return expectsLargeContext ? 1_000_000 : 200_000;
}

/** The model-family token (opus/sonnet/haiku/fable) within a model string, or
 *  null when none is recognizable. Used to decide whether a session is running
 *  the account's default model when sizing the context-window fallback. */
function familyOf(s: string | null | undefined): string | null {
  const m = s?.match(/opus|sonnet|haiku|fable/i);
  return m ? m[0].toLowerCase() : null;
}
