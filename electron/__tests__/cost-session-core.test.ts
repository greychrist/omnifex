import { describe, it, expect } from 'vitest';
import { computeSessionCost } from '../services/cost/session-cost-core';

const M = 1_000_000;
const line = (obj: unknown) => JSON.stringify(obj);

function assistantLine(req: string, ts: string, model: string, usage: unknown): string {
  return line({ type: 'assistant', requestId: req, timestamp: ts, message: { id: `m_${req}`, model, usage } });
}

const baseArgs = {
  sessionId: 'sess1',
  accountName: 'Work',
  configDir: '/cfg',
  projectPath: '/Users/me/proj',
};

describe('computeSessionCost', () => {
  it('totals main-session usage into snapshot and daily rows', () => {
    const sessionContent = [
      assistantLine('r1', '2026-07-16T23:59:00Z', 'claude-opus-4-8', { input_tokens: 10, output_tokens: 100 }),
      assistantLine('r2', '2026-07-17T00:01:00Z', 'claude-opus-4-8', { input_tokens: 20, output_tokens: 200, cache_read_input_tokens: 1000 }),
    ].join('\n');
    const { snapshot, dailyRows } = computeSessionCost({ ...baseArgs, sessionContent, subagentFiles: [] });

    const expectedOut = 300 * (25 / M);
    const expectedIn = 30 * (5 / M);
    const expectedCacheRead = 1000 * (5 / M) * 0.1;
    expect(snapshot.totalUsd).toBeCloseTo(expectedIn + expectedOut + expectedCacheRead, 10);
    expect(snapshot.breakdown.inputUsd).toBeCloseTo(expectedIn, 10);
    expect(snapshot.subagentUsd).toBe(0);
    expect(snapshot.estimated).toBe(false);
    expect(snapshot.tokens).toEqual({ input: 30, output: 300, cacheRead: 1000, cacheWrite: 0 });
    expect(snapshot.byModel).toHaveLength(1);
    expect(snapshot.byModel[0].model).toBe('claude-opus-4-8');

    // Two UTC dates -> two rows
    expect(dailyRows).toHaveLength(2);
    const dates = dailyRows.map((r) => r.date).sort();
    expect(dates).toEqual(['2026-07-16', '2026-07-17']);
    expect(dailyRows[0].session_id).toBe('sess1');
    expect(dailyRows[0].account_name).toBe('Work');
  });

  it('includes subagent usage in total, subagentUsd, and daily rows', () => {
    const sessionContent = assistantLine('r1', '2026-07-17T01:00:00Z', 'claude-opus-4-8', { output_tokens: 100 });
    const sub = assistantLine('r_sub', '2026-07-17T01:05:00Z', 'claude-haiku-4-5', { output_tokens: 1000 });
    const { snapshot, dailyRows } = computeSessionCost({ ...baseArgs, sessionContent, subagentFiles: [{ agentId: 'a1', content: sub }] });
    const mainUsd = 100 * (25 / M);
    const subUsd = 1000 * (5 / M);
    expect(snapshot.totalUsd).toBeCloseTo(mainUsd + subUsd, 10);
    expect(snapshot.subagentUsd).toBeCloseTo(subUsd, 10);
    expect(snapshot.byModel.map((b) => b.model).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-4-8']);
    expect(dailyRows).toHaveLength(2); // same date, two models
  });

  it('keeps each subagent\'s cost, live context and model by agent id', () => {
    const sessionContent = assistantLine('r1', '2026-07-17T01:00:00Z', 'claude-opus-4-8', { output_tokens: 100 });
    const a1 = [
      assistantLine('a1r1', '2026-07-17T01:01:00Z', 'claude-haiku-4-5', { input_tokens: 10, output_tokens: 1000 }),
      // Same request seen twice (one line per content block): counted once.
      assistantLine('a1r2', '2026-07-17T01:02:00Z', 'claude-haiku-4-5', { input_tokens: 20, output_tokens: 500, cache_read_input_tokens: 3000, cache_creation_input_tokens: 400 }),
      assistantLine('a1r2', '2026-07-17T01:02:00Z', 'claude-haiku-4-5', { input_tokens: 20, output_tokens: 500, cache_read_input_tokens: 3000, cache_creation_input_tokens: 400 }),
    ].join('\n');
    const a2 = assistantLine('a2r1', '2026-07-17T01:03:00Z', 'claude-opus-4-8', { output_tokens: 10 });
    const { snapshot } = computeSessionCost({
      ...baseArgs,
      sessionContent,
      subagentFiles: [{ agentId: 'a1', content: a1 }, { agentId: 'a2', content: a2 }],
    });

    const a1Usd = (30 * 1 + 1500 * 5 + 3000 * 0.1 + 400 * 1.25) / M;
    expect(snapshot.bySubagent.a1.usd).toBeCloseTo(a1Usd, 10);
    // Context = the LATEST request's full prompt plus its output, not a sum.
    expect(snapshot.bySubagent.a1.contextTokens).toBe(20 + 3000 + 400 + 500);
    expect(snapshot.bySubagent.a1.model).toBe('claude-haiku-4-5');
    expect(snapshot.bySubagent.a1.estimated).toBe(false);
    expect(snapshot.bySubagent.a2.usd).toBeCloseTo(10 * (25 / M), 10);
    expect(snapshot.subagentUsd).toBeCloseTo(snapshot.bySubagent.a1.usd + snapshot.bySubagent.a2.usd, 10);
  });

  it('has no per-subagent entries for a session without subagents', () => {
    const sessionContent = assistantLine('r1', '2026-07-17T01:00:00Z', 'claude-opus-4-8', { output_tokens: 100 });
    expect(computeSessionCost({ ...baseArgs, sessionContent, subagentFiles: [] }).snapshot.bySubagent).toEqual({});
  });

  it('flags estimated on unknown model and in affected daily rows', () => {
    const sessionContent = assistantLine('r1', '2026-07-17T01:00:00Z', 'claude-mystery-model', { output_tokens: 10 });
    const { snapshot, dailyRows } = computeSessionCost({ ...baseArgs, sessionContent, subagentFiles: [] });
    expect(snapshot.estimated).toBe(true);
    expect(dailyRows[0].is_estimated).toBe(1);
  });

  it('rows without timestamps count toward snapshot but not daily rows', () => {
    const sessionContent = line({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-4-8', usage: { output_tokens: 10 } } });
    const { snapshot, dailyRows } = computeSessionCost({ ...baseArgs, sessionContent, subagentFiles: [] });
    expect(snapshot.totalUsd).toBeGreaterThan(0);
    expect(dailyRows).toHaveLength(0);
  });

  it('splits cache-write tokens 5m/1h into daily row columns', () => {
    const sessionContent = assistantLine('r1', '2026-07-17T01:00:00Z', 'claude-opus-4-8', {
      cache_creation: { ephemeral_5m_input_tokens: 111, ephemeral_1h_input_tokens: 222 },
    });
    const { dailyRows } = computeSessionCost({ ...baseArgs, sessionContent, subagentFiles: [] });
    expect(dailyRows[0].cache_write_5m_tokens).toBe(111);
    expect(dailyRows[0].cache_write_1h_tokens).toBe(222);
  });
});
