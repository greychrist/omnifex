// The cache TTL is observed from usage.cache_creation, never read from config: the CLI's
// choice depends on subscription, overage and a server-side allowlist.

import type { JsonlNode } from '@/types/jsonl';

export const CACHE_TTL_1H_MS = 3_600_000;
export const CACHE_TTL_5M_MS = 300_000;

export const CACHE_TIMER_ENABLED_SETTING_KEY = 'cache_timer_enabled';
export const DEFAULT_CACHE_TIMER_ENABLED = true;

const WARN_ELAPSED_PCT = 80;
const CRITICAL_ELAPSED_PCT = 90;

export type CacheExpiryLevel = 'fresh' | 'warn' | 'critical' | 'expired';

export interface CacheExpiry {
  level: CacheExpiryLevel;
  remainingMs: number;
  elapsedPct: number;
}

interface CacheCreationBreakdown {
  ephemeral_1h_input_tokens?: number;
  ephemeral_5m_input_tokens?: number;
}

function cacheCreationOf(node: JsonlNode): CacheCreationBreakdown | null {
  if (node.kind !== 'assistant') return null;
  const usage = node.raw.message?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const breakdown = (usage as { cache_creation?: unknown }).cache_creation;
  if (!breakdown || typeof breakdown !== 'object') return null;
  return breakdown;
}

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

export interface CacheTtlChange {
  fromMs: number;
  toMs: number;
}

export function lastCacheTtlChange(messages: JsonlNode[]): CacheTtlChange | null {
  const writes: number[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const breakdown = cacheCreationOf(messages[i]);
    if (!breakdown) continue;
    const oneHour = breakdown.ephemeral_1h_input_tokens ?? 0;
    const fiveMin = breakdown.ephemeral_5m_input_tokens ?? 0;
    if (oneHour > 0) writes.push(CACHE_TTL_1H_MS);
    else if (fiveMin > 0) writes.push(CACHE_TTL_5M_MS);
  }

  for (let i = 0; i < writes.length - 1; i += 1) {
    if (writes[i] !== writes[i + 1]) {
      return { fromMs: writes[i + 1], toMs: writes[i] };
    }
  }
  return null;
}

/** The cache refreshes per API request, so the TTL runs from the last response, not the user's send. */
export function lastAssistantAnchorMs(messages: JsonlNode[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const node = messages[i];
    if (node.kind !== 'assistant') continue;
    const ms = Date.parse(node.receivedAt);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

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

export function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  if (totalSeconds >= 600) return `${Math.floor(totalSeconds / 60)}m`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
