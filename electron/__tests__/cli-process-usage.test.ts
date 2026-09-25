import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, runMigrations, type Database } from '../services/database';
import { createCliProcessUsageStore } from '../services/cost/cli-process-usage';

// The CLI's own running per-model totals for one process: a baseline taken
// before the process spends anything, and the latest figure it reported. The
// difference is what the process spent; the part the transcript never shows
// is what the Cost Report used to miss (side questions, title generation…).

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
  inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite,
});

describe('cli process usage store', () => {
  let db: Database;
  beforeEach(() => { db = createDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  it('keeps the baseline and the latest snapshot for each process, keyed by session', () => {
    const store = createCliProcessUsageStore(db);
    store.record({ sessionId: 's1', processId: 'p1', startedAt: '2026-09-25T10:00:00.000Z', phase: 'baseline', at: '2026-09-25T10:00:01.000Z', modelUsage: {} });
    store.record({ sessionId: 's1', processId: 'p1', startedAt: '2026-09-25T10:00:00.000Z', phase: 'latest', at: '2026-09-25T10:05:00.000Z', modelUsage: { 'claude-opus-5-5[1m]': usage(10, 20, 300, 40) } });
    store.record({ sessionId: 's1', processId: 'p1', startedAt: '2026-09-25T10:00:00.000Z', phase: 'latest', at: '2026-09-25T10:09:00.000Z', modelUsage: { 'claude-opus-5-5[1m]': usage(11, 25, 400, 40) } });

    const s1 = store.listBySession().get('s1');
    expect(s1).toEqual([{
      sessionId: 's1',
      processId: 'p1',
      startedAt: '2026-09-25T10:00:00.000Z',
      baseline: {},
      baselineAt: '2026-09-25T10:00:01.000Z',
      latest: { 'claude-opus-5-5[1m]': usage(11, 25, 400, 40) },
      latestAt: '2026-09-25T10:09:00.000Z',
    }]);
  });

  it('a process whose baseline never arrived reads back with a null baseline', () => {
    const store = createCliProcessUsageStore(db);
    store.record({ sessionId: 's1', processId: 'p2', startedAt: 't0', phase: 'latest', at: 't1', modelUsage: {} });
    expect(store.listBySession().get('s1')?.[0]).toMatchObject({ baseline: null, baselineAt: null, latest: {} });
  });

  it('lists processes oldest first', () => {
    const store = createCliProcessUsageStore(db);
    store.record({ sessionId: 's1', processId: 'b', startedAt: '2026-09-25T12:00:00.000Z', phase: 'baseline', at: 'x', modelUsage: {} });
    store.record({ sessionId: 's1', processId: 'a', startedAt: '2026-09-25T09:00:00.000Z', phase: 'baseline', at: 'x', modelUsage: {} });
    expect(store.listBySession().get('s1')?.map((p) => p.processId)).toEqual(['a', 'b']);
  });

  it('migration v28 creates the table on an existing image, and re-running is harmless', () => {
    db.raw.exec('DROP TABLE cli_process_usage');
    db.raw.prepare('DELETE FROM schema_version WHERE version >= 28').run();
    runMigrations(db.raw);
    expect(() => {
      db.raw.prepare('DELETE FROM schema_version WHERE version >= 28').run();
      runMigrations(db.raw);
    }).not.toThrow();
    createCliProcessUsageStore(db).record({ sessionId: 's', processId: 'p', startedAt: 't', phase: 'baseline', at: 't', modelUsage: {} });
    expect(createCliProcessUsageStore(db).listBySession().size).toBe(1);
  });
});
