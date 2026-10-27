// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { computeUnloggedRows, UNLOGGED_SESSION_PREFIX } from '../services/cost/unlogged-spend';
import type { CliProcessUsage } from '../services/cost/cli-process-usage';
import type { ExtractedUsageRow } from '../services/cost/usage-extract';
import { computeMessageCost } from '../../src/lib/pricing';

const totals = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
  inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite,
});

const proc = (over: Partial<CliProcessUsage>): CliProcessUsage => ({
  sessionId: 's1',
  processId: 'p1',
  startedAt: '2026-09-25T10:00:00.000Z',
  baseline: {},
  baselineAt: '2026-09-25T10:00:01.000Z',
  latest: {},
  latestAt: '2026-09-25T11:00:00.000Z',
  ...over,
});

const tx = (model: string, timestamp: string, input: number, output: number, cacheRead: number, cacheWrite: number): ExtractedUsageRow => ({
  key: `${model}-${timestamp}`,
  model,
  timestamp,
  usage: {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    cache_creation: { ephemeral_1h_input_tokens: cacheWrite, ephemeral_5m_input_tokens: 0 },
  },
});

const base = { sessionId: 's1', accountName: 'Personal', configDir: '/cfg', projectPath: '/proj' };

describe('computeUnloggedRows', () => {
  it('prices what the CLI counted and the transcript lacks, as a cli-unlogged row for the session', () => {
    const { rows } = computeUnloggedRows({
      ...base,
      processes: [proc({ latest: { 'claude-opus-5-5[1m]': totals(2116, 5299, 425072, 70849) } })],
      transcript: [tx('claude-opus-5-5', '2026-09-25T10:30:00.000Z', 12, 4513, 347725, 69259)],
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      session_id: `${UNLOGGED_SESSION_PREFIX}s1`,
      internal_kind: 'cli-unlogged',
      date: '2026-09-25',
      model: 'claude-opus-5-5',
      account_name: 'Personal',
      config_dir: '/cfg',
      project_path: '/proj',
      is_subagent: 0,
      input_tokens: 2104,
      output_tokens: 786,
      cache_read_tokens: 77347,
      // No TTL split in the CLI's totals: priced by the existing rule for
      // unsplit cache writes, which is the 5-minute rate.
      cache_write_5m_tokens: 1590,
      cache_write_1h_tokens: 0,
    });
    const expected = computeMessageCost('claude-opus-5-5', {
      input_tokens: 2104, output_tokens: 786, cache_read_input_tokens: 77347, cache_creation_input_tokens: 1590,
    }, undefined, '2026-09-25');
    expect(row.cost_usd).toBeCloseTo(expected.usd, 10);
    expect(row.cache_read_usd).toBeCloseTo(expected.cacheReadUsd, 10);
  });

  it('subtracts a restored baseline, so an earlier process is never counted again', () => {
    const { rows } = computeUnloggedRows({
      ...base,
      processes: [proc({
        baseline: { 'claude-opus-5-5[1m]': totals(100, 100, 1000, 100) },
        latest: { 'claude-opus-5-5[1m]': totals(150, 300, 2500, 100) },
      })],
      transcript: [tx('claude-opus-5-5', '2026-09-25T10:30:00.000Z', 0, 100, 1000, 0)],
    });
    expect(rows[0]).toMatchObject({ input_tokens: 50, output_tokens: 100, cache_read_tokens: 500, cache_write_5m_tokens: 0 });
  });

  it('only subtracts transcript usage from inside the process window', () => {
    const { rows } = computeUnloggedRows({
      ...base,
      processes: [
        proc({ processId: 'p1', startedAt: '2026-09-25T09:00:00.000Z', latestAt: '2026-09-25T09:30:00.000Z', latest: { 'claude-opus-5-5': totals(0, 10, 0, 0) } }),
        proc({ processId: 'p2', startedAt: '2026-09-25T10:00:00.000Z', latestAt: '2026-09-25T10:30:00.000Z', latest: { 'claude-opus-5-5': totals(0, 10, 0, 0) } }),
      ],
      transcript: [
        tx('claude-opus-5-5', '2026-09-25T08:00:00.000Z', 0, 999, 0, 0), // before either process
        tx('claude-opus-5-5', '2026-09-25T09:10:00.000Z', 0, 10, 0, 0),  // p1's own turn
      ],
    });
    // p1 fully logged; p2 spent 10 output tokens the transcript never shows.
    expect(rows).toHaveLength(1);
    expect(rows[0].output_tokens).toBe(10);
  });

  it('prices a model only the CLI saw — title generation on Haiku', () => {
    const { rows } = computeUnloggedRows({
      ...base,
      processes: [proc({ latest: { 'claude-haiku-4-5-20251001': totals(937, 17, 0, 0) } })],
      transcript: [],
    });
    expect(rows).toEqual([expect.objectContaining({ model: 'claude-haiku-4-5-20251001', input_tokens: 937, output_tokens: 17 })]);
  });

  it('writes nothing when the transcript already accounts for everything', () => {
    const { rows } = computeUnloggedRows({
      ...base,
      processes: [proc({ latest: { 'claude-opus-5-5': totals(10, 10, 10, 10) } })],
      transcript: [tx('claude-opus-5-5', '2026-09-25T10:30:00.000Z', 10, 12, 10, 10)],
    });
    expect(rows).toEqual([]);
  });

  it('skips a process with no baseline or no latest figure, and says why', () => {
    const { rows, skipped } = computeUnloggedRows({
      ...base,
      processes: [
        proc({ processId: 'nb', baseline: null, baselineAt: null, latest: { m: totals(5, 5, 5, 5) } }),
        proc({ processId: 'nl', startedAt: '2026-09-25T12:00:00.000Z', latest: null, latestAt: null }),
      ],
      transcript: [],
    });
    expect(rows).toEqual([]);
    expect(skipped).toEqual([
      { processId: 'nb', reason: 'no-baseline' },
      { processId: 'nl', reason: 'no-latest' },
    ]);
  });

  // CLI >= 2.1.311 reports how many of its cache writes had a 1-hour TTL.
  // The hidden 1-hour part is what the CLI counted at 1h minus what the
  // transcript rows already priced at 1h; the rest keeps the 5-minute rule.
  it('prices hidden cache writes at the 1-hour rate when the CLI splits them', () => {
    const { rows } = computeUnloggedRows({
      ...base,
      processes: [proc({
        baseline: { 'claude-opus-5-5[1m]': { ...totals(0, 0, 0, 1000), cacheCreationEphemeral1hInputTokens: 1000 } },
        latest: { 'claude-opus-5-5[1m]': { ...totals(0, 0, 0, 9000), cacheCreationEphemeral1hInputTokens: 7000 } },
      })],
      // The transcript already priced 4000 cache-write tokens, all at 1h.
      transcript: [tx('claude-opus-5-5', '2026-09-25T10:30:00.000Z', 0, 0, 0, 4000)],
    });
    // Hidden: 9000 − 1000 − 4000 = 4000 in all; at 1h, 7000 − 1000 − 4000 = 2000.
    expect(rows[0]).toMatchObject({ cache_write_5m_tokens: 2000, cache_write_1h_tokens: 2000 });
    const expected = computeMessageCost('claude-opus-5-5', {
      cache_creation_input_tokens: 4000,
      cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 2000 },
    }, undefined, '2026-09-25');
    expect(rows[0].cache_write_usd).toBeCloseTo(expected.cacheWriteUsd, 10);
    expect(rows[0].cost_usd).toBeCloseTo(expected.usd, 10);
  });

  // A baseline restored from an older CLI's cost-state has no 1-hour figure,
  // and the latest one counts only the turns since: nothing to subtract.
  it('treats a baseline without the 1-hour figure as zero of it', () => {
    const { rows } = computeUnloggedRows({
      ...base,
      processes: [proc({
        baseline: { 'claude-opus-5-5': totals(0, 0, 0, 5000) },
        latest: { 'claude-opus-5-5': { ...totals(0, 0, 0, 8000), cacheCreationEphemeral1hInputTokens: 3000 } },
      })],
      transcript: [],
    });
    expect(rows[0]).toMatchObject({ cache_write_5m_tokens: 0, cache_write_1h_tokens: 3000 });
  });

  // The transcript can sit ahead of the CLI's last report (a turn still
  // running), so the 1-hour part is bounded by the hidden total.
  it('never puts more at the 1-hour rate than the hidden cache writes', () => {
    const { rows } = computeUnloggedRows({
      ...base,
      processes: [proc({
        latest: { 'claude-opus-5-5': { ...totals(0, 10, 0, 6000), cacheCreationEphemeral1hInputTokens: 6000 } },
      })],
      transcript: [tx('claude-opus-5-5', '2026-09-25T10:30:00.000Z', 0, 0, 0, 5000)].map((r) => ({
        ...r, usage: { ...r.usage, cache_creation: { ephemeral_5m_input_tokens: 5000, ephemeral_1h_input_tokens: 0 } },
      })),
    });
    expect(rows[0]).toMatchObject({ cache_write_5m_tokens: 0, cache_write_1h_tokens: 1000 });
  });

  it('merges two processes on the same day and model into one row', () => {
    const { rows } = computeUnloggedRows({
      ...base,
      processes: [
        proc({ processId: 'p1', startedAt: '2026-09-25T09:00:00.000Z', latest: { 'claude-opus-5-5': totals(0, 10, 0, 0) } }),
        proc({ processId: 'p2', startedAt: '2026-09-25T10:00:00.000Z', latest: { 'claude-opus-5-5': totals(0, 5, 0, 0) } }),
      ],
      transcript: [],
    });
    expect(rows).toEqual([expect.objectContaining({ output_tokens: 15 })]);
  });
});
