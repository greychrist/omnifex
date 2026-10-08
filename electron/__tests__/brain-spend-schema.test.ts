import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';

/**
 * The spend ledger schema (Plan 8 §3).
 */
describe('brain spend ledger schema', () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  function columns(table: string): string[] {
    return (db.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .map((r) => r.name);
  }

  it('creates brain_spend with the accounting columns', () => {
    expect(columns('brain_spend')).toEqual(
      expect.arrayContaining([
        'account_id', 'account_name', 'kind', 'source_id', 'item_key', 'model',
        'date', 'spent_at', 'input_tokens', 'output_tokens', 'cache_read_tokens',
        'cache_creation_tokens', 'cost_usd',
      ]),
    );
  });

  /**
   * No FOREIGN KEY, unlike every other brain table. Money spent is history: a
   * deleted account must not silently shrink a month that has been reported.
   */
  it('keeps a spend row for an account that no longer exists', () => {
    db.raw.prepare(`INSERT INTO accounts (id, name, config_dir) VALUES (7, 'gone', '/tmp/g')`).run();
    db.raw
      .prepare(
        `INSERT INTO brain_spend
           (account_id, account_name, kind, source_id, item_key, model, date, spent_at, cost_usd)
         VALUES (7, 'gone', 'index', 'session', 'k', 'claude-sonnet-5', '2026-08-14', '2026-08-14T00:00:00Z', 0.5)`,
      )
      .run();

    db.raw.prepare('DELETE FROM accounts WHERE id = 7').run();

    const rows = db.raw.prepare('SELECT * FROM brain_spend').all();
    expect(rows).toHaveLength(1);
  });
});

/**
 * A ledger row that cannot say what it paid for cannot be priced or audited,
 * so the schema refuses one outright.
 */
describe('brain_spend rejects an unattributed model ', () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.raw.prepare(`INSERT INTO accounts (id, name, config_dir) VALUES (1, 'p', '/cfg/p')`).run();
  });

  afterEach(() => {
    db.close();
  });

  function insertModel(model: string): void {
    db.raw
      .prepare(
        `INSERT INTO brain_spend
           (account_id, account_name, kind, source_id, item_key, model, date, spent_at, cost_usd)
         VALUES (1, 'p', 'index', 'session', 'k', ?, '2026-08-14', '2026-08-14T00:00:00Z', 0.5)`,
      )
      .run(model);
  }

  it('accepts a real model name', () => {
    expect(() => { insertModel('claude-sonnet-5'); }).not.toThrow();
  });

  it("rejects the literal 'unknown'", () => {
    expect(() => { insertModel('unknown'); }).toThrow(/CHECK constraint failed/);
  });

  it('rejects an empty model', () => {
    expect(() => { insertModel(''); }).toThrow(/CHECK constraint failed/);
  });
});
