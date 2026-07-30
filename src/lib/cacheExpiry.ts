/**
 * Prompt-cache expiry countdown.
 *
 * The prompt cache is refreshed by each API request and expires a fixed TTL
 * after the last one, so a follow-up turn inside the window is dramatically
 * cheaper than a cold one. This module answers "how long is left?".
 *
 * ── Why the TTL is observed rather than read from config ────────────────────
 *
 * There is no readable "cache TTL" setting. In CLI 2.1.220 the decision reduces
 * to: FORCE_PROMPT_CACHING_5M → 5m; ENABLE_PROMPT_CACHING_1H → 1h; no
 * subscription gate or in usage overage → 5m; otherwise 1h iff the querySource
 * matches a *server-controlled* allowlist. So it depends on env knobs plus
 * subscription state, overage state, query source, and a remote list — the env
 * knobs alone are wrong in the common case where none are set.
 *
 * But the CLI reports what it actually did: every turn's
 * `usage.cache_creation` carries `ephemeral_1h_input_tokens` and
 * `ephemeral_5m_input_tokens`. We read those from the tailed JSONL. (The CLI
 * tracks the same pair internally as lastMainThreadCacheTtlMs /
 * lastApiCompletionTimestamp.)
 *
 * See docs/superpowers/specs/2026-07-30-cache-expiry-timer-design.md
 */

import type { JsonlNode } from '@/types/jsonl';

export const CACHE_TTL_1H_MS = 3_600_000;
export const CACHE_TTL_5M_MS = 300_000;

export const CACHE_TIMER_ENABLED_SETTING_KEY = 'cache_timer_enabled';
export const DEFAULT_CACHE_TIMER_ENABLED = true;

/** Elapsed fraction of the TTL at which the countdown turns amber. */
const WARN_ELAPSED_PCT = 80;
/** Elapsed fraction of the TTL at which the countdown turns red. */
const CRITICAL_ELAPSED_PCT = 90;

export type CacheExpiryLevel = 'fresh' | 'warn' | 'critical' | 'expired';

export interface CacheExpiry {
  level: CacheExpiryLevel;
  /** Milliseconds of cache lifetime left, clamped at 0. */
  remainingMs: number;
  /** Elapsed share of the TTL as a percent (may exceed 100). */
  elapsedPct: number;
}

interface CacheCreationBreakdown {
  ephemeral_1h_input_tokens?: number;
  ephemeral_5m_input_tokens?: number;
}

/** Pull the cache_creation breakdown off an assistant node, if it has one. */
function cacheCreationOf(node: JsonlNode): CacheCreationBreakdown | null {
  if (node.kind !== 'assistant') return null;
  const usage = node.raw.message?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const breakdown = (usage as { cache_creation?: unknown }).cache_creation;
  if (!breakdown || typeof breakdown !== 'object') return null;
  return breakdown as CacheCreationBreakdown;
}

/**
 * The TTL the CLI actually used on the most recent turn that wrote cache, or
 * null when no turn ever has.
 *
 * Turns that only *read* cache leave both counters at zero and carry no signal,
 * so they are skipped and the last non-zero observation stands. Returning null
 * rather than a guess is deliberate: with no observation there is no timer.
 */
export function observeCacheTtlMs(messages: JsonlNode[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const breakdown = cacheCreationOf(messages[i]);
    if (!breakdown) continue;
    const oneHour = breakdown.ephemeral_1h_input_tokens ?? 0;
    const fiveMin = breakdown.ephemeral_5m_input_tokens ?? 0;
    if (oneHour > 0) return CACHE_TTL_1H_MS;
    if (fiveMin > 0) return CACHE_TTL_5M_MS;
  }
  return null;
}

/**
 * When the TTL last restarted: the timestamp of the last assistant message.
 *
 * The cache is refreshed by each API request, so the clock runs from the last
 * *response*, not from when the user last typed. Counting from the user's send
 * would drift pessimistic on long turns.
 */
export function lastAssistantAnchorMs(messages: JsonlNode[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const node = messages[i];
    if (node.kind !== 'assistant') continue;
    const ms = Date.parse(node.receivedAt);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/** `nowMs` is injected so this stays deterministic under test. */
export function evaluateCacheExpiry(opts: {
  anchorMs: number;
  ttlMs: number;
  nowMs: number;
}): CacheExpiry {
  const { anchorMs, ttlMs, nowMs } = opts;
  const elapsed = Math.max(0, nowMs - anchorMs);
  const elapsedPct = ttlMs > 0 ? (elapsed / ttlMs) * 100 : 100;
  const remainingMs = Math.max(0, ttlMs - elapsed);

  const level: CacheExpiryLevel =
    elapsedPct >= 100
      ? 'expired'
      : elapsedPct >= CRITICAL_ELAPSED_PCT
        ? 'critical'
        : elapsedPct >= WARN_ELAPSED_PCT
          ? 'warn'
          : 'fresh';

  return { level, remainingMs, elapsedPct };
}

/** `4:07` under ten minutes, `42m` at or above it. */
export function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  if (totalSeconds >= 600) return `${Math.floor(totalSeconds / 60)}m`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
