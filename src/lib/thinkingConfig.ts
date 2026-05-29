// Thinking-config helpers shared across the renderer.
//
// The CLI's `setMaxThinkingTokens` was deprecated in 0.2.x; on Opus 4.6+
// every non-zero value collapses to adaptive at runtime. The "Budget"
// option in the picker was a UI lie — it persisted a different string but
// produced identical model behavior. The picker now exposes only two
// states (Adaptive / Off), and any persisted record carrying the legacy
// `'budget'` value is silently coerced to `'adaptive'` at every read
// boundary so users with an old preference don't get an empty session.

export type ThinkingConfig = 'adaptive' | 'disabled';

/**
 * Coerce an arbitrary persisted / wire value into a valid `ThinkingConfig`.
 *
 * - `'budget'` (legacy) → `'adaptive'`. Behavior change: none — the CLI
 *   already collapses non-zero budgets to adaptive on the only models we
 *   ship today. The cleanup is purely so the UI label matches reality.
 * - `'adaptive'` and `'disabled'` pass through.
 * - Anything else (null, undefined, garbage strings, wrong types) →
 *   `'adaptive'`. We default to "on" because that's what new sessions
 *   start with elsewhere; defaulting to "off" would silently disable
 *   thinking on a stored-config error.
 */
export function normalizeThinkingConfig(value: unknown): ThinkingConfig {
  if (value === 'adaptive' || value === 'disabled') return value;
  return 'adaptive';
}
