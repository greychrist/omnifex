import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, runMigrations, type Database } from '../services/database';

/**
 * v29 deletes the two-threshold auto-scroll settings. The chat now follows on
 * one distance (`autoscroll_follow_px`); nothing reads the old pair.
 */
describe('old auto-scroll threshold settings removed (v29)', () => {
  let db: Database;

  beforeEach(() => { db = createDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  const set = (key: string, value: string) =>
    db.raw.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
  const keys = () =>
    (db.raw.prepare("SELECT key FROM app_settings WHERE key LIKE 'autoscroll%' ORDER BY key").all() as Array<{ key: string }>)
      .map((r) => r.key);
  const rerun = () => {
    // `>=`: runMigrations gates on MAX(version).
    db.raw.prepare('DELETE FROM schema_version WHERE version >= 29').run();
    runMigrations(db.raw);
  };

  it('deletes the reengage and disengage keys and keeps the follow distance', () => {
    set('autoscroll_reengage_px', '200');
    set('autoscroll_disengage_px', '400');
    set('autoscroll_follow_px', '250');
    rerun();
    expect(keys()).toEqual(['autoscroll_follow_px']);
  });
});
