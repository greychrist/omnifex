import { hasOneMillionSuffix, resolveContextWindow, type ModelPricingInput } from './pricing';

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
 * resumed session sits on the fallback until its next turn.
 *
 * The fallback no longer guesses from the suffix alone. It used to return
 * 200k for anything without "[1m]", which was wrong for every natively-1M
 * model (Opus 4.7+, Sonnet 5, Fable, Mythos — the JSONL records their bare
 * id). The window is now DATA: `contextWindow` on the model rows in
 * `pricing.ts` (shipped + the user's `model_pricing` overrides), read off the
 * CLI's own model table. In order:
 *
 *  1. An explicit "[1m]" on the selection (or what the catalog resolves it to)
 *     is the user's opt-in and wins.
 *  2. The model that actually ran (`runningModel`, from the transcript), then
 *     the catalog's resolution of the selected alias, then the selection
 *     itself — the first concrete `claude-*` id whose row states a window.
 *  3. An "Account Default" session also honours the account's settings.json
 *     pin ("opus[1m]"), which is the only place that opt-in survives a resume.
 *  4. 200k — the smallest window any current model has.
 */
export interface ContextCatalogEntry {
  value: string;
  /** The concrete id the CLI maps this picker value to (`claude-opus-5-5[1m]`). */
  resolvedModel?: string;
}

const ONE_MILLION = 1_000_000;
const SMALLEST_WINDOW = 200_000;

export function resolveContextLimit(opts: {
  /** `contextUsage.maxTokens` from the live CLI, or null when no live data yet. */
  sdkMaxTokens: number | null;
  /** The selected/known model string; may carry the UI "[1m]" suffix. */
  model: string | undefined;
  /** The account's resolved default model (settings.json `model`), used when
   *  the session runs "Account Default" and its own model string lacks [1m]. */
  defaultModel?: string | null;
  /** The concrete model id the transcript says actually ran. */
  runningModel?: string | null;
  /** The account's CLI model catalog, to resolve aliases (`default`, `opus`). */
  catalog?: readonly ContextCatalogEntry[] | null;
  /** The user's `model_pricing` rows, which may override a shipped window. */
  pricingOverrides?: readonly ModelPricingInput[] | null;
}): number {
  const { sdkMaxTokens, model, defaultModel, runningModel, catalog, pricingOverrides } = opts;

  if (sdkMaxTokens != null && sdkMaxTokens > 0) {
    return sdkMaxTokens;
  }

  const usingDefault = !model || model === 'default';
  const resolveAlias = (value: string | undefined): string | undefined =>
    catalog?.find((e) => e.value === (value || 'default'))?.resolvedModel;
  const selectedResolved = resolveAlias(model);

  if (hasOneMillionSuffix(model) || hasOneMillionSuffix(selectedResolved)) return ONE_MILLION;

  // The account pin only speaks for a session running that default: no
  // explicit model, the "default" sentinel, or the same family. An explicit
  // cross-family pick (sonnet on an opus[1m]-default account) must not inherit.
  if (hasOneMillionSuffix(defaultModel)) {
    if (usingDefault || familyOf(model) === familyOf(defaultModel)) return ONE_MILLION;
  }

  for (const candidate of [runningModel, selectedResolved, model]) {
    const window = resolveContextWindow(candidate, pricingOverrides);
    if (window != null && window > 0) return window;
  }
  return SMALLEST_WINDOW;
}

/** The model-family token (opus/sonnet/haiku/fable) within a model string, or
 *  null when none is recognizable. Used to decide whether a session is running
 *  the account's default model when sizing the context-window fallback. */
function familyOf(s: string | null | undefined): string | null {
  const m = s?.match(/opus|sonnet|haiku|fable/i);
  return m ? m[0].toLowerCase() : null;
}
