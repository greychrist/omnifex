import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, runMigrations, type Database } from '../services/database';

/**
 * v27 strips `thinkingConfig` from stored account session defaults. The
 * Thinking picker went in v0.4.70 and nothing could set the value after
 * that; the setting itself is gone now, so the key would be dead weight
 * that every account save round-tripped.
 */
describe('accounts.session_defaults thinkingConfig strip (v27)', () => {
  let db: Database;

  beforeEach(() => { db = createDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  const insert = (id: number, defaults: string | null) =>
    db.raw
      .prepare("INSERT INTO accounts (id, name, config_dir, session_defaults) VALUES (?, ?, ?, ?)")
      .run(id, `acct-${id}`, `/cfg/${id}`, defaults);
  const defaults = (id: number) =>
    (db.raw.prepare('SELECT session_defaults FROM accounts WHERE id = ?').get(id) as { session_defaults: string | null })
      .session_defaults;
  const rerun = () => {
    // `>=`: runMigrations gates on MAX(version).
    db.raw.prepare('DELETE FROM schema_version WHERE version >= 27').run();
    runMigrations(db.raw);
  };

  it('removes the key and keeps every other default', () => {
    insert(1, JSON.stringify({ model: 'default', effort: 'high', thinkingConfig: 'disabled', permissionMode: 'auto' }));
    rerun();
    expect(JSON.parse(defaults(1)!)).toEqual({ model: 'default', effort: 'high', permissionMode: 'auto' });
  });

  it('leaves rows without the key, and rows without defaults, untouched', () => {
    insert(1, JSON.stringify({ model: 'opus' }));
    insert(2, null);
    rerun();
    expect(defaults(1)).toBe(JSON.stringify({ model: 'opus' }));
    expect(defaults(2)).toBeNull();
  });

  it('skips a row whose defaults are not valid JSON rather than failing the migration', () => {
    insert(1, '{not json');
    expect(() => rerun()).not.toThrow();
    expect(defaults(1)).toBe('{not json');
  });
});
