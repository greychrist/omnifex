import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createBrainSpendStore, type BrainSpendStore } from '../services/brain/spend';

/**
 * The ledger (Plan 8 §3).
 *
 * `brain_sources.cost_usd` is a snapshot that re-indexing overwrites, so it can
 * answer "what did this item last cost" and nothing else. The user's monthly
 * cost report needs "what did the Brain spend in July", which a snapshot cannot
 * express — and which the swept extraction transcripts mean nothing else on the
 * machine can answer either.
 */
describe('brain spend ledger', () => {
  let db: Database;
  let store: BrainSpendStore;
  let personalId: number;
  let workId: number;

  function addAccount(name: string): number {
    const info = db.raw
      .prepare(
        `INSERT INTO accounts (name, config_dir, engine, subscription_label, has_cost)
         VALUES (?, ?, 'claude', 'Max', 0)`,
      )
      .run(name, `/tmp/${name}`);
    return Number(info.lastInsertRowid);
  }

  const base = {
    kind: 'index' as const,
    sourceId: 'session',
    model: 'claude-sonnet-5',
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 300,
    cacheCreationTokens: 400,
  };

  beforeEach(() => {
    db = createDatabase(':memory:');
    personalId = addAccount('personal');
    workId = addAccount('work');
    store = createBrainSpendStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('records a run and totals it', () => {
    store.record({
      ...base,
      accountId: personalId,
      accountName: 'personal',
      itemKey: 'sess-a',
      spentAt: '2026-08-14T18:04:11.204Z',
      date: '2026-08-14',
      costUsd: 0.0142,
    });

    expect(store.total(personalId)).toBeCloseTo(0.0142, 6);
  });

  /**
   * The property `brain_sources` cannot have. Re-indexing an item is new money
   * on top of old money; a table whose grain is "latest value for this item"
   * reports the second run and silently forgets the first.
   */
  it('adds a second run on the same item rather than replacing it', () => {
    const row = {
      ...base,
      accountId: personalId,
      accountName: 'personal',
      itemKey: 'sess-a',
      date: '2026-08-14',
    };
    store.record({ ...row, spentAt: '2026-08-14T10:00:00.000Z', costUsd: 0.01 });
    store.record({ ...row, spentAt: '2026-08-14T11:00:00.000Z', costUsd: 0.02 });

    expect(store.total(personalId)).toBeCloseTo(0.03, 6);
    expect(store.byMonth('2026-08')).toHaveLength(2);
  });

  it('keeps one account out of another account total', () => {
    store.record({
      ...base, accountId: personalId, accountName: 'personal', itemKey: 'a',
      spentAt: '2026-08-14T10:00:00.000Z', date: '2026-08-14', costUsd: 0.01,
    });
    store.record({
      ...base, accountId: workId, accountName: 'work', itemKey: 'b',
      spentAt: '2026-08-14T10:00:00.000Z', date: '2026-08-14', costUsd: 0.05,
    });

    expect(store.total(personalId)).toBeCloseTo(0.01, 6);
    expect(store.total(workId)).toBeCloseTo(0.05, 6);
    // No argument means every account, which is what a whole-machine monthly
    // report wants.
    expect(store.total()).toBeCloseTo(0.06, 6);
  });

  /**
   * `date` is stored, not derived at read time. Grouping a UTC instant into a
   * month in the user's own timezone is exactly where off-by-one-day bugs live,
   * and this row is the case that proves it: 1am UTC on the 1st is the previous
   * month locally in America/New_York.
   */
  it('groups by the stored local date, not by the instant', () => {
    store.record({
      ...base, accountId: personalId, accountName: 'personal', itemKey: 'late-july',
      spentAt: '2026-08-01T01:12:44.000Z', date: '2026-07-31', costUsd: 0.09,
    });

    expect(store.byMonth('2026-07')).toHaveLength(1);
    expect(store.byMonth('2026-08')).toEqual([]);
  });

  it('separates what curation cost from what indexing cost', () => {
    store.record({
      ...base, accountId: personalId, accountName: 'personal', itemKey: 'a',
      spentAt: '2026-08-14T10:00:00.000Z', date: '2026-08-14', costUsd: 0.01,
    });
    store.record({
      ...base, kind: 'curation', sourceId: 'curation', model: 'claude-opus-5',
      accountId: personalId, accountName: 'personal', itemKey: 'Subsystems/Widget.md',
      spentAt: '2026-08-14T10:05:00.000Z', date: '2026-08-14', costUsd: 0.40,
    });

    const rows = store.byMonth('2026-08');
    // Curation is pinned to a better model on purpose, so it is the line item
    // most likely to surprise. A total that blends it hides that.
    expect(rows.find((r) => r.kind === 'curation')?.costUsd).toBeCloseTo(0.4, 6);
    expect(rows.find((r) => r.kind === 'index')?.costUsd).toBeCloseTo(0.01, 6);
  });

  it('preserves an unreported token count as null rather than zero', () => {
    store.record({
      accountId: personalId, accountName: 'personal', kind: 'index', sourceId: 'capture',
      itemKey: 'cap-1', model: 'claude-sonnet-5',
      spentAt: '2026-08-14T10:00:00.000Z', date: '2026-08-14',
      costUsd: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreationTokens: null,
    });

    const [row] = store.byMonth('2026-08');
    // An envelope that stops carrying a field must degrade to unknown, never to
    // free — the same rule RunCost already follows.
    expect(row.costUsd).toBeNull();
    expect(row.inputTokens).toBeNull();
  });

  it('reports zero for an account that has never spent', () => {
    expect(store.total(personalId)).toBe(0);
    expect(store.byMonth('2026-08')).toEqual([]);
  });

  it('survives the account it belongs to being deleted', () => {
    store.record({
      ...base, accountId: personalId, accountName: 'personal', itemKey: 'a',
      spentAt: '2026-08-14T10:00:00.000Z', date: '2026-08-14', costUsd: 0.01,
    });
    db.raw.prepare('DELETE FROM accounts WHERE id = ?').run(personalId);

    // Money spent is history. A deleted account does not un-spend it, and a
    // monthly report that silently shed rows when an account was removed would
    // understate the month.
    expect(store.byMonth('2026-08')).toHaveLength(1);
    expect(store.byMonth('2026-08')[0].accountName).toBe('personal');
  });
});
