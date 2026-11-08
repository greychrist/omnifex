import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, runMigrations, type Database } from '../services/database';

/**
 * v31 drops model_pricing.color_slot. The Cost Report's colour is derived
 * from a model's price tier and version (costChartPalette.ts), so a per-row
 * palette index has nothing left to drive. No user row ever set one.
 */
describe('model_pricing.color_slot dropped (v31)', () => {
  let db: Database;

  beforeEach(() => { db = createDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  const columns = (): string[] =>
    (db.raw.prepare('PRAGMA table_info(model_pricing)').all() as Array<{ name: string }>).map((c) => c.name);

  it('is absent on a fresh install', () => {
    expect(columns()).not.toContain('color_slot');
    expect(columns()).toContain('context_window');
  });

  it('is dropped from a v30 table, keeping the other columns and the rows', () => {
    db.raw.exec('DROP TABLE model_pricing');
    db.raw.exec(`CREATE TABLE model_pricing (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT NOT NULL,
      effective_from TEXT NOT NULL DEFAULT '1970-01-01',
      input_per_m REAL, output_per_m REAL, fast_input_per_m REAL, fast_output_per_m REAL,
      cache_read_per_m REAL, cache_write_5m_per_m REAL, cache_write_1h_per_m REAL,
      label TEXT, color_slot INTEGER, context_window INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (pattern, effective_from))`);
    db.raw.prepare("INSERT INTO model_pricing (pattern, input_per_m, label, color_slot) VALUES ('opus-9', 7, 'Opus 9', 3)").run();
    // `>=`: runMigrations gates on MAX(version).
    db.raw.prepare('DELETE FROM schema_version WHERE version >= 31').run();
    runMigrations(db.raw);
    expect(columns()).not.toContain('color_slot');
    expect(db.raw.prepare("SELECT input_per_m, label FROM model_pricing WHERE pattern='opus-9'").get())
      .toEqual({ input_per_m: 7, label: 'Opus 9' });
  });

  it('is idempotent on a table that already lacks it', () => {
    db.raw.prepare('DELETE FROM schema_version WHERE version >= 31').run();
    expect(() => runMigrations(db.raw)).not.toThrow();
  });
});
