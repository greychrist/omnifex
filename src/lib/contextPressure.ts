/**
 * Context-pressure thresholds — when to warn that a session should be
 * `/compact`ed.
 *
 * The user configures a *budget* for how much context they are willing to
 * carry, expressed either as a percentage of the session's window or as an
 * absolute token count. The banner then escalates in two steps relative to that
 * budget: amber at 80% of it, red at 100% of it.
 *
 * Persisted in `app_settings` and applied live via ContextPressureContext, the
 * same shape as `autoScrollThresholds.ts` / `AutoScrollContext`.
 *
 * See docs/superpowers/specs/2026-07-30-context-pressure-banner-design.md
 */

export type ContextPressureMode = 'percent' | 'tokens';

export interface ContextPressureSetting {
  enabled: boolean;
  mode: ContextPressureMode;
  /** Percent of the window (1-100), or an absolute token count. */
  value: number;
}

export const CONTEXT_PRESSURE_ENABLED_SETTING_KEY = 'context_pressure_enabled';
export const CONTEXT_PRESSURE_MODE_SETTING_KEY = 'context_pressure_mode';
export const CONTEXT_PRESSURE_VALUE_SETTING_KEY = 'context_pressure_value';

/** Default budget when the mode is `percent`. */
export const DEFAULT_CONTEXT_PRESSURE_PERCENT = 80;
/** Default budget when the mode is `tokens` — sized for 1M-window sessions. */
export const DEFAULT_CONTEXT_PRESSURE_TOKENS = 250_000;

export const DEFAULT_CONTEXT_PRESSURE: ContextPressureSetting = {
  enabled: true,
  mode: 'tokens',
  value: DEFAULT_CONTEXT_PRESSURE_TOKENS,
};

/**
 * An absolute budget is clamped to this fraction of the real window.
 *
 * The 250k default exceeds a 200k window. Clamping to the raw window would put
 * `critical` at exactly 200k, which is unreachable in practice because the CLI
 * auto-compacts first — so the user would only ever see the amber `warn` level
 * on 200k sessions. Clamping to 190k keeps both levels reachable there, while
 * 1M sessions still get the literal 250k budget.
 */
export const ABSOLUTE_BUDGET_WINDOW_FRACTION = 0.95;

/** Fraction of the budget at which the banner turns amber. */
const WARN_FRACTION_OF_BUDGET = 0.8;

/** Smallest absolute budget worth configuring. */
const MIN_ABSOLUTE_TOKENS = 1_000;

export type ContextPressureLevel = 'none' | 'warn' | 'critical';

export interface ContextPressure {
  level: ContextPressureLevel;
  /** Resolved budget in tokens, after clamping. */
  budgetTokens: number;
  /** Occupancy as a percent of the real window — display only. */
  pct: number;
}

/** The default `value` for a mode, used when a stored value is unusable. */
export function defaultValueForMode(mode: ContextPressureMode): number {
  return mode === 'percent'
    ? DEFAULT_CONTEXT_PRESSURE_PERCENT
    : DEFAULT_CONTEXT_PRESSURE_TOKENS;
}

/** Enforce the per-mode bounds: percent 1-100, tokens floored at 1000. */
export function clampContextPressureValue(
  value: number,
  mode: ContextPressureMode,
): number {
  const n = Math.floor(value);
  if (!Number.isFinite(n)) return defaultValueForMode(mode);
  if (mode === 'percent') return Math.min(100, Math.max(1, n));
  return Math.max(MIN_ABSOLUTE_TOKENS, n);
}

export function parseContextPressureMode(raw: string | null): ContextPressureMode {
  if (raw === 'percent' || raw === 'tokens') return raw;
  return DEFAULT_CONTEXT_PRESSURE.mode;
}

export function parseContextPressureValue(
  raw: string | null,
  mode: ContextPressureMode,
): number {
  if (raw === null) return defaultValueForMode(mode);
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return defaultValueForMode(mode);
  return clampContextPressureValue(n, mode);
}

export function parseContextPressureEnabled(raw: string | null): boolean {
  if (raw === null) return DEFAULT_CONTEXT_PRESSURE.enabled;
  return raw === 'true';
}

/** Resolve the configured budget into tokens against a concrete window. */
export function resolveBudgetTokens(
  setting: ContextPressureSetting,
  limit: number,
): number {
  const value = clampContextPressureValue(setting.value, setting.mode);
  if (setting.mode === 'percent') {
    return Math.floor(limit * (value / 100));
  }
  return Math.floor(Math.min(value, limit * ABSOLUTE_BUDGET_WINDOW_FRACTION));
}

/**
 * Where a token count sits against the configured budget — thresholds only,
 * with none of the banner's gating.
 *
 * Split out because the transcript's context rail colours every row by the
 * same three levels but answers to a different switch (`context_timeline_
 * enabled`) and has no notion of a live session — it is a history. Sharing
 * this function is what makes "amber" mean one thing across the app; the rail
 * having its own copy of 80%-of-budget is precisely how the two would drift.
 */
export function contextPressureLevel(opts: {
  tokens: number;
  limit: number;
  setting: ContextPressureSetting;
}): ContextPressureLevel {
  const { tokens, limit, setting } = opts;
  if (tokens <= 0 || limit <= 0) return 'none';
  const budgetTokens = resolveBudgetTokens(setting, limit);
  if (budgetTokens <= 0) return 'none';
  if (tokens >= budgetTokens) return 'critical';
  return tokens >= budgetTokens * WARN_FRACTION_OF_BUDGET ? 'warn' : 'none';
}

/**
 * Decide whether the banner shows, and in which of its two levels.
 *
 * Pure and stateless by design: there is no "already shown" latch, so the
 * banner re-arms for free — it clears when a `/compact` drops context and
 * reappears the next time the budget is crossed.
 */
export function evaluateContextPressure(opts: {
  tokens: number;
  limit: number;
  setting: ContextPressureSetting;
  /**
   * Is the CLI actually up (sessionStatus === 'started')?
   *
   * The banner's only action is "run /compact", which a dead or still-starting
   * session cannot do. Gating on the weaker "not stopped" predicate flashed an
   * un-actionable banner while a resumed session was dialing, then yanked it
   * away when the resume failed. Defaults true so a caller that has no session
   * concept (tests, previews) behaves as before.
   */
  sessionLive?: boolean;
}): ContextPressure {
  const { tokens, limit, setting, sessionLive = true } = opts;
  const inert: ContextPressure = { level: 'none', budgetTokens: 0, pct: 0 };
  if (!sessionLive || !setting.enabled || tokens <= 0 || limit <= 0) return inert;

  const budgetTokens = resolveBudgetTokens(setting, limit);
  const pct = Math.min(100, (tokens / limit) * 100);
  if (budgetTokens <= 0) return inert;

  return { level: contextPressureLevel({ tokens, limit, setting }), budgetTokens, pct };
}

/**
 * Pick the token count and window to measure against.
 *
 * The live CLI `get_context_usage` response wins when present; otherwise we use
 * the estimate derived from the last assistant turn. Shared with SessionCard's
 * gauge so the gauge and the banner can never disagree.
 */
export function selectContextTokens(opts: {
  contextUsage: { totalTokens: number; maxTokens: number } | null | undefined;
  fallbackTokens: number;
}): { tokens: number; sdkMaxTokens: number | null } {
  const { contextUsage, fallbackTokens } = opts;
  if (contextUsage) {
    return { tokens: contextUsage.totalTokens, sdkMaxTokens: contextUsage.maxTokens };
  }
  return { tokens: fallbackTokens, sdkMaxTokens: null };
}

/** `1.2k` / `250k` / `1.0M`, matching the gauge readout's style. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
