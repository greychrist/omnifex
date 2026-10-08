import { describe, it, expect } from 'vitest';
import { subagentRunStats, subagentTotals } from '../subagentRunStats';
import type { Subagent } from '../subagentStreams';
import type { SubagentCost } from '../api';

const T0 = Date.parse('2026-10-08T12:00:00.000Z');

function sub(over: Partial<Subagent> = {}): Subagent {
  return {
    toolUseId: 'tu1',
    taskId: 'a1',
    description: 'Build the landing page',
    status: 'running',
    startedAt: new Date(T0).toISOString(),
    latest: null,
    events: [],
    colorIndex: 0,
    ...over,
  };
}

const cost = (over: Partial<SubagentCost> = {}): SubagentCost => ({
  usd: 0.05,
  estimated: false,
  contextTokens: 40_000,
  model: 'claude-opus-5-5',
  ...over,
});

describe('subagentRunStats', () => {
  it('joins the row to its transcript cost by agent id', () => {
    const s = subagentRunStats(sub(), { a1: cost() }, T0);
    expect(s.usd).toBe(0.05);
    expect(s.contextTokens).toBe(40_000);
  });

  it('works out context % against the model window', () => {
    // Opus 5.5 has a 1M window.
    expect(subagentRunStats(sub(), { a1: cost() }, T0).contextPct).toBe(4);
  });

  it('leaves context % out when the window is unknown', () => {
    const s = subagentRunStats(sub(), { a1: cost({ model: 'unknown' }) }, T0);
    expect(s.contextPct).toBeUndefined();
    expect(s.contextTokens).toBe(40_000);
  });

  it('has no cost for a row with no transcript (a background shell task)', () => {
    const s = subagentRunStats(sub({ taskId: 'bm3eixa8c' }), { a1: cost() }, T0);
    expect(s.usd).toBeUndefined();
    expect(s.contextPct).toBeUndefined();
  });

  it('ticks a running row off the clock', () => {
    expect(subagentRunStats(sub(), null, T0 + 26_000).elapsedMs).toBe(26_000);
  });

  it('never shows less than the CLI last reported for a running row', () => {
    // After a reload startedAt is the load time, so the clock starts late.
    const s = subagentRunStats(
      sub({ latest: { description: 'x', durationMs: 90_000 } }),
      null,
      T0 + 5_000,
    );
    expect(s.elapsedMs).toBe(90_000);
  });

  it('uses the final duration once done', () => {
    const s = subagentRunStats(
      sub({ status: 'completed', finalDurationMs: 18_000, latest: { description: 'x', durationMs: 12_000 } }),
      null,
      T0 + 999_000,
    );
    expect(s.elapsedMs).toBe(18_000);
  });

  it('falls back to the last reported duration for a finished row without totals', () => {
    const s = subagentRunStats(
      sub({ status: 'completed_inferred', latest: { description: 'x', durationMs: 12_000 } }),
      null,
      T0 + 999_000,
    );
    expect(s.elapsedMs).toBe(12_000);
  });
});

describe('subagentTotals', () => {
  it('sums the cost of the rows shown, and flags any estimate', () => {
    const subs = [sub(), sub({ toolUseId: 'tu2', taskId: 'a2' }), sub({ toolUseId: 'tu3', taskId: undefined })];
    const t = subagentTotals(subs, { a1: cost(), a2: cost({ usd: 0.1, estimated: true }), a9: cost({ usd: 5 }) });
    expect(t.usd).toBeCloseTo(0.15, 10);
    expect(t.estimated).toBe(true);
  });

  it('is undefined when no row has a cost', () => {
    expect(subagentTotals([sub({ taskId: undefined })], null).usd).toBeUndefined();
  });
});
