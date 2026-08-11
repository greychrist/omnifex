import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';

describe('brain orchestration schema (v18)', () => {
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

  it('creates brain_sources with an account_id', () => {
    expect(columns('brain_sources')).toEqual(
      expect.arrayContaining(['account_id', 'source_id', 'item_key', 'mtime', 'hash', 'last_indexed_at', 'status', 'error']),
    );
  });

  it('creates brain_queue with an account_id', () => {
    expect(columns('brain_queue')).toEqual(
      expect.arrayContaining(['account_id', 'source_id', 'item_key', 'status', 'enqueued_at']),
    );
  });

  it('keys brain_sources by (account_id, source_id, item_key)', () => {
    const mkAccount = db.raw.prepare(`INSERT INTO accounts (name, config_dir) VALUES (?, ?)`);
    mkAccount.run('a', '/tmp/a');
    mkAccount.run('b', '/tmp/b');
    const ids = (db.raw.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[]).map((r) => r.id);

    const insert = db.raw.prepare(
      `INSERT INTO brain_sources (account_id, source_id, item_key, mtime, hash, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run(ids[0], 'session', 'abc', 1, 'h', 'indexed');
    // Same item under a DIFFERENT account is a distinct row, not a conflict.
    expect(() => insert.run(ids[1], 'session', 'abc', 1, 'h', 'indexed')).not.toThrow();
    // Same item under the SAME account conflicts.
    expect(() => insert.run(ids[0], 'session', 'abc', 1, 'h', 'indexed')).toThrow();
  });

  it('rejects brain rows for an account that does not exist', () => {
    expect(() =>
      db.raw
        .prepare(`INSERT INTO brain_sources (account_id, source_id, item_key, status) VALUES (999, 'session', 'k', 'pending')`)
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('deletes brain rows when the owning account is deleted', () => {
    db.raw.prepare(`INSERT INTO accounts (name, config_dir) VALUES ('a', '/tmp/a')`).run();
    const accountId = (db.raw.prepare(`SELECT id FROM accounts WHERE name = 'a'`).get() as { id: number }).id;

    db.raw.prepare(
      `INSERT INTO brain_queue (account_id, source_id, item_key, status) VALUES (?, 'session', 'k', 'pending')`,
    ).run(accountId);
    db.raw.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);

    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM brain_queue').get()).toEqual({ n: 0 });
  });

  it('records the migration version', () => {
    const row = db.raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(row.v).toBeGreaterThanOrEqual(18);
  });
});
