import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  PRE_CUTOVER_EXTRACTION_MODEL,
  POST_CUTOVER_EXTRACTION_MODEL,
  type Database,
} from '../services/database';

/**
 * v21 closes the one hole in the spend ledger: a row that cannot say what it
 * paid for.
 *
 * v20 shipped its backfill stamping the literal 'unknown', on the reasoning
 * that the extraction pin had moved Haiku -> Sonnet partway through and
 * `brain_sources` never recorded which. That reasoning was sound but the
 * conclusion was too weak — every backfilled row carries `last_indexed_at`, and
 * the pin moved at a known instant, so the model is *recoverable* rather than
 * unknowable. v21 rewrites those rows from their own timestamps and adds a
 * CHECK so no future writer or backfill can reintroduce an unattributed row.
 */
describe('brain_spend rejects an unattributed model (v21)', () => {
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

/**
 * Migration-path tests: hand-build the ledger exactly as the shipped v20 left
 * it — table without the CHECK, rows stamped 'unknown' — then run the real
 * migration list over it.
 */
describe('v21 re-attributes rows the shipped v20 left unknown', () => {
  let raw: BetterSqlite3.Database;

  beforeEach(() => {
    raw = new BetterSqlite3(':memory:');
    raw.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO schema_version (version) VALUES (20);

      CREATE TABLE brain_spend (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        account_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_id TEXT,
        item_key TEXT NOT NULL,
        model TEXT NOT NULL,
        date TEXT NOT NULL,
        spent_at TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_creation_tokens INTEGER,
        cost_usd REAL
      );
      CREATE INDEX idx_brain_spend_date ON brain_spend(date);
      CREATE INDEX idx_brain_spend_account_date ON brain_spend(account_name, date);
    `);
  });

  afterEach(() => {
    raw.close();
  });

  function seed(id: number, model: string, spentAt: string, cost: number): void {
    raw
      .prepare(
        `INSERT INTO brain_spend
           (id, account_id, account_name, kind, source_id, item_key, model, date, spent_at,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd)
         VALUES (?, 1, 'personal', 'index', 'session', ?, ?, ?, ?, 1, 2, 3, 4, ?)`,
      )
      .run(id, `item-${String(id)}`, model, spentAt.slice(0, 10), spentAt, cost);
  }

  function rows(): Record<string, unknown>[] {
    return raw.prepare('SELECT * FROM brain_spend ORDER BY id').all() as Record<
      string,
      unknown
    >[];
  }

  it('re-attributes by the instant the row was spent', () => {
    seed(1, 'unknown', '2026-08-11T22:00:00.000Z', 0.1);
    seed(2, 'unknown', '2026-08-14T16:32:44.896Z', 0.2);

    runMigrations(raw);

    expect(rows().map((r) => r.model)).toEqual([
      PRE_CUTOVER_EXTRACTION_MODEL,
      POST_CUTOVER_EXTRACTION_MODEL,
    ]);
  });

  /**
   * Curation is pinned to Opus and was always recorded correctly. A rewrite
   * that clobbered rows which already knew their model would turn a correct
   * attribution into a fabricated one — the exact failure v21 exists to remove.
   */
  it('leaves an already-attributed row alone', () => {
    seed(1, 'claude-opus-5', '2026-08-11T22:00:00.000Z', 0.1);

    runMigrations(raw);

    expect(rows()[0].model).toBe('claude-opus-5');
  });

  it('preserves ids, ordering and the lifetime total', () => {
    seed(1, 'unknown', '2026-08-13T23:43:31.624Z', 0.5139732);
    seed(2, 'unknown', '2026-08-13T20:29:06.391Z', 0.5097867);
    seed(3, 'claude-sonnet-5', '2026-08-14T20:34:36.446Z', 0.1896912);

    const before = raw.prepare('SELECT SUM(cost_usd) AS t FROM brain_spend').get() as { t: number };

    runMigrations(raw);

    const after = raw.prepare('SELECT SUM(cost_usd) AS t FROM brain_spend').get() as { t: number };
    expect(after.t).toBeCloseTo(before.t, 10);
    expect(rows().map((r) => r.id)).toEqual([1, 2, 3]);
    // The token columns must survive the table rebuild, not just the money.
    expect(rows()[0]).toMatchObject({ input_tokens: 1, cache_creation_tokens: 4 });
  });

  /**
   * The rebuild renames the old table out of the way. SQLite carries indexes
   * across a rename, so dropping them first is what stops the new table from
   * being left unindexed when `CREATE INDEX IF NOT EXISTS` finds the old names
   * already taken.
   */
  it('leaves the ledger indexed after the table rebuild', () => {
    seed(1, 'unknown', '2026-08-14T10:00:00.000Z', 0.1);

    runMigrations(raw);

    const idx = (
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='brain_spend'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(idx).toEqual(
      expect.arrayContaining(['idx_brain_spend_date', 'idx_brain_spend_account_date']),
    );
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name='brain_spend_old'").all())
      .toEqual([]);
  });

  it('is idempotent — a second run changes nothing', () => {
    seed(1, 'unknown', '2026-08-14T10:00:00.000Z', 0.1);

    runMigrations(raw);
    const first = rows();
    runMigrations(raw);

    expect(rows()).toEqual(first);
  });
});
