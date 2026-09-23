import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, runMigrations, type Database } from '../services/database';

/**
 * v26 gives the user's model rows a context window, so the gauge's pre-live
 * fallback is data a user can correct rather than a "[1m]" suffix guess.
 */
describe('model_pricing.context_window (v26)', () => {
  let db: Database;

  beforeEach(() => { db = createDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  const columns = (): string[] =>
    (db.raw.prepare('PRAGMA table_info(model_pricing)').all() as Array<{ name: string }>).map((c) => c.name);

  it('exists on a fresh install', () => {
    expect(columns()).toContain('context_window');
  });

  it('is added to a v25 table that lacks it, keeping existing rows', () => {
    db.raw.exec('DROP TABLE model_pricing');
    db.raw.exec(`CREATE TABLE model_pricing (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT NOT NULL,
      effective_from TEXT NOT NULL DEFAULT '1970-01-01',
      input_per_m REAL, output_per_m REAL, fast_input_per_m REAL, fast_output_per_m REAL,
      cache_read_per_m REAL, cache_write_5m_per_m REAL, cache_write_1h_per_m REAL,
      label TEXT, color_slot INTEGER, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (pattern, effective_from))`);
    db.raw.prepare("INSERT INTO model_pricing (pattern, input_per_m) VALUES ('opus-9', 7)").run();
    // `>=`: runMigrations gates on MAX(version).
    db.raw.prepare('DELETE FROM schema_version WHERE version >= 26').run();
    runMigrations(db.raw);
    expect(columns()).toContain('context_window');
    expect(db.raw.prepare("SELECT input_per_m FROM model_pricing WHERE pattern='opus-9'").get()).toEqual({ input_per_m: 7 });
  });

  it('is idempotent on a table that already has it', () => {
    db.raw.prepare('DELETE FROM schema_version WHERE version >= 26').run();
    expect(() => runMigrations(db.raw)).not.toThrow();
  });
});
