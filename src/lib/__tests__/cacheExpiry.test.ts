import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import {
  CACHE_TTL_1H_MS,
  CACHE_TTL_5M_MS,
  observeCacheTtlMs,
  lastAssistantAnchorMs,
  evaluateCacheExpiry,
  formatRemaining,
} from '../cacheExpiry';

const AT = (iso: string) => Date.parse(iso);

/** An assistant turn with an explicit cache_creation breakdown. */
const assistant = (
  receivedAt: string,
  cacheCreation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } | null,
): JsonlNode =>
  ({
    kind: 'assistant',
    sessionId: 's1',
    receivedAt,
    raw: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [],
        ...(cacheCreation === undefined
          ? {}
          : { usage: { cache_creation: cacheCreation } }),
      },
    },
  }) as unknown as JsonlNode;

const user = (receivedAt: string): JsonlNode =>
  ({
    kind: 'user',
    sessionId: 's1',
    receivedAt,
    userKind: 'prompt',
    raw: { type: 'user', message: { role: 'user', content: 'hi' } },
  }) as unknown as JsonlNode;

describe('observeCacheTtlMs', () => {
  it('reports 1h when the last cache write was a 1h write', () => {
    const msgs = [assistant('2026-07-30T10:00:00Z', { ephemeral_1h_input_tokens: 12_000, ephemeral_5m_input_tokens: 0 })];
    expect(observeCacheTtlMs(msgs)).toBe(CACHE_TTL_1H_MS);
    expect(CACHE_TTL_1H_MS).toBe(3_600_000);
  });

  it('reports 5m when the last cache write was a 5m write', () => {
    const msgs = [assistant('2026-07-30T10:00:00Z', { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 900 })];
    expect(observeCacheTtlMs(msgs)).toBe(CACHE_TTL_5M_MS);
    expect(CACHE_TTL_5M_MS).toBe(300_000);
  });

  // Cache-read-only turns leave both counters at zero and carry no signal, so
  // the last non-zero observation is what sticks.
  it('skips zero-counter turns in favour of an older real write', () => {
    const msgs = [
      assistant('2026-07-30T10:00:00Z', { ephemeral_1h_input_tokens: 12_000, ephemeral_5m_input_tokens: 0 }),
      assistant('2026-07-30T10:05:00Z', { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }),
      assistant('2026-07-30T10:06:00Z', { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }),
    ];
    expect(observeCacheTtlMs(msgs)).toBe(CACHE_TTL_1H_MS);
  });

  it('prefers the most recent write when the TTL changed mid-session', () => {
    const msgs = [
      assistant('2026-07-30T10:00:00Z', { ephemeral_1h_input_tokens: 12_000 }),
      assistant('2026-07-30T10:05:00Z', { ephemeral_5m_input_tokens: 900 }),
    ];
    expect(observeCacheTtlMs(msgs)).toBe(CACHE_TTL_5M_MS);
  });

  it('returns null when nothing has ever written cache', () => {
    expect(observeCacheTtlMs([])).toBeNull();
    expect(observeCacheTtlMs([user('2026-07-30T10:00:00Z')])).toBeNull();
    expect(observeCacheTtlMs([assistant('2026-07-30T10:00:00Z')])).toBeNull();
    expect(observeCacheTtlMs([assistant('2026-07-30T10:00:00Z', null)])).toBeNull();
  });
});

describe('lastAssistantAnchorMs', () => {
  it('uses the last assistant message', () => {
    const msgs = [
      assistant('2026-07-30T10:00:00Z', { ephemeral_1h_input_tokens: 1 }),
      assistant('2026-07-30T10:05:00Z', { ephemeral_1h_input_tokens: 1 }),
    ];
    expect(lastAssistantAnchorMs(msgs)).toBe(AT('2026-07-30T10:05:00Z'));
  });

  it('ignores later user turns — the cache is refreshed by API requests', () => {
    const msgs = [
      assistant('2026-07-30T10:00:00Z', { ephemeral_1h_input_tokens: 1 }),
      user('2026-07-30T10:09:00Z'),
    ];
    expect(lastAssistantAnchorMs(msgs)).toBe(AT('2026-07-30T10:00:00Z'));
  });

  it('returns null on an empty transcript', () => {
    expect(lastAssistantAnchorMs([])).toBeNull();
  });
});

describe('evaluateCacheExpiry — 5m cache', () => {
  const anchorMs = AT('2026-07-30T10:00:00Z');
  const at = (secondsLater: number) =>
    evaluateCacheExpiry({ anchorMs, ttlMs: CACHE_TTL_5M_MS, nowMs: anchorMs + secondsLater * 1000 });

  it('is fresh below 80% elapsed', () => {
    expect(at(239).level).toBe('fresh'); // 3:59
  });

  it('warns at 4:00', () => {
    expect(at(240).level).toBe('warn');
  });

  it('goes critical at 4:30', () => {
    expect(at(269).level).toBe('warn');
    expect(at(270).level).toBe('critical');
  });

  it('expires at 5:00', () => {
    expect(at(299).level).toBe('critical');
    expect(at(300).level).toBe('expired');
  });

  it('reports the remaining time, clamped at zero', () => {
    expect(at(240).remainingMs).toBe(60_000);
    expect(at(600).remainingMs).toBe(0);
  });
});

describe('evaluateCacheExpiry — 1h cache', () => {
  const anchorMs = AT('2026-07-30T10:00:00Z');
  const at = (minutesLater: number) =>
    evaluateCacheExpiry({ anchorMs, ttlMs: CACHE_TTL_1H_MS, nowMs: anchorMs + minutesLater * 60_000 });

  it('warns at 48m and reddens at 54m', () => {
    expect(at(47).level).toBe('fresh');
    expect(at(48).level).toBe('warn');
    expect(at(53).level).toBe('warn');
    expect(at(54).level).toBe('critical');
  });

  it('expires at 60m', () => {
    expect(at(59).level).toBe('critical');
    expect(at(60).level).toBe('expired');
  });

  it('reports elapsed percent', () => {
    expect(at(30).elapsedPct).toBe(50);
  });
});

describe('formatRemaining', () => {
  it('uses m:ss below ten minutes', () => {
    expect(formatRemaining(60_000)).toBe('1:00');
    expect(formatRemaining(24_000)).toBe('0:24');
    expect(formatRemaining(599_000)).toBe('9:59');
  });

  it('uses whole minutes at ten minutes and above', () => {
    expect(formatRemaining(600_000)).toBe('10m');
    expect(formatRemaining(42 * 60_000)).toBe('42m');
  });

  it('floors to 0:00 at expiry', () => {
    expect(formatRemaining(0)).toBe('0:00');
  });
});
