import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { createDatabase, runMigrations, type Database } from '../services/database';

/**
 * The spend ledger schema and its one-time backfill (Plan 8 §3).
 *
 * The backfill is the part worth testing hardest. `stats.spentUsd` moves off
 * `brain_sources.cost_usd` and onto this table in the same change, so without a
 * backfill an existing install's reported lifetime spend would silently drop to
 * zero — the numbers would look like the feature had never run.
 */
describe('brain spend ledger schema (v20)', () => {
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
 * Migration-path tests: build the pre-v20 shape by hand, then run the real
 * migration list over it. A fresh `createDatabase` gets the table from
 * `initSchema` and would never exercise the upgrade.
 */
describe('v20 backfill from brain_sources', () => {
  let raw: BetterSqlite3.Database;

  beforeEach(() => {
    raw = new BetterSqlite3(':memory:');
    raw.pragma('foreign_keys = ON');
    raw.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        config_dir TEXT NOT NULL
      );
      CREATE TABLE brain_sources (
        account_id INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        mtime INTEGER,
        hash TEXT,
        last_indexed_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        cost_usd REAL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_creation_tokens INTEGER,
        PRIMARY KEY (account_id, source_id, item_key),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO schema_version (version) VALUES (19);
      INSERT INTO accounts (id, name, config_dir) VALUES (1, 'personal', '/cfg/p');
    `);
  });

  afterEach(() => {
    raw.close();
  });

  function spend(): Record<string, unknown>[] {
    return raw.prepare('SELECT * FROM brain_spend ORDER BY item_key').all() as Record<
      string,
      unknown
    >[];
  }

  it('carries every priced item across so the lifetime total survives', () => {
    raw
      .prepare(
        `INSERT INTO brain_sources
           (account_id, source_id, item_key, last_indexed_at, status,
            cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
         VALUES (1, 'session', 'sess-a', '2026-08-14T18:04:11.204Z', 'indexed', 0.02, 10, 20, 30, 40)`,
      )
      .run();

    runMigrations(raw);

    const rows = spend();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: 1,
      account_name: 'personal',
      kind: 'index',
      source_id: 'session',
      item_key: 'sess-a',
      cost_usd: 0.02,
      input_tokens: 10,
      cache_creation_tokens: 40,
    });
  });

  /**
   * The historical rows cannot say which model they used — `brain_sources`
   * never recorded one, and the pin changed from Haiku to Sonnet partway
   * through. Stamping today's model onto them would be a fabricated attribution
   * in a table people will price from, so they say so instead. `cost_usd` on
   * these rows is the CLI's own figure, so a report can still total them.
   */
  it('marks backfilled rows as an unknown model rather than guessing', () => {
    raw
      .prepare(
        `INSERT INTO brain_sources (account_id, source_id, item_key, last_indexed_at, status, cost_usd)
         VALUES (1, 'session', 'sess-a', '2026-08-14T18:04:11.204Z', 'indexed', 0.02)`,
      )
      .run();

    runMigrations(raw);

    expect(spend()[0].model).toBe('unknown');
  });

  it('skips items that never cost anything', () => {
    raw
      .prepare(
        `INSERT INTO brain_sources (account_id, source_id, item_key, last_indexed_at, status, cost_usd)
         VALUES (1, 'auto-memory', 'mem-a', '2026-08-14T18:04:11.204Z', 'indexed', NULL)`,
      )
      .run();

    runMigrations(raw);

    // An auto-memory note is translated with no model. A row here would claim a
    // payment that never happened.
    expect(spend()).toEqual([]);
  });

  it('dates a backfilled row from when it was indexed, not from today', () => {
    raw
      .prepare(
        `INSERT INTO brain_sources (account_id, source_id, item_key, last_indexed_at, status, cost_usd)
         VALUES (1, 'session', 'old', '2026-06-02T14:00:00.000Z', 'indexed', 0.02)`,
      )
      .run();

    runMigrations(raw);

    // Collapsing history into the upgrade date would move months of spend into
    // whichever month the user happened to update in.
    expect(spend()[0].date).toBe('2026-06-02');
  });

  /**
   * A database old enough to predate `accounts` still runs this migration.
   * `brain_sources`'s foreign key is resolved at DML time, not DDL time, so v18
   * can leave the table behind on a database that has no accounts at all — and
   * a backfill that assumed otherwise crashed the whole migration chain.
   */
  it('skips the backfill when there is nothing to read from', () => {
    const bare = new BetterSqlite3(':memory:');
    bare.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO schema_version (version) VALUES (19);
    `);

    expect(() => { runMigrations(bare); }).not.toThrow();
    expect(bare.prepare('SELECT * FROM brain_spend').all()).toEqual([]);
    bare.close();
  });

  it('is idempotent — a second run does not double the backfill', () => {
    raw
      .prepare(
        `INSERT INTO brain_sources (account_id, source_id, item_key, last_indexed_at, status, cost_usd)
         VALUES (1, 'session', 'sess-a', '2026-08-14T18:04:11.204Z', 'indexed', 0.02)`,
      )
      .run();

    runMigrations(raw);
    runMigrations(raw);

    expect(spend()).toHaveLength(1);
  });
});
