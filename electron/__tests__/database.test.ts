import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { createDatabase, runMigrations, ensureDefaultSettings, type Database } from '../services/database';

describe('database', () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates all required tables', () => {
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const names = tables.map((t) => t.name);
    expect(names).toContain('accounts');
    expect(names).toContain('account_path_rules');
    expect(names).toContain('project_account_overrides');
    expect(names).toContain('agents');
    expect(names).toContain('agent_runs');
    expect(names).toContain('app_settings');
    expect(names).toContain('app_logs');
    expect(names).toContain('schema_version');
  });

  it('agents table has correct columns', () => {
    const info = db.raw.prepare('PRAGMA table_info(agents)').all() as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'name', 'icon', 'system_prompt', 'default_task',
        'model', 'hooks', 'created_at', 'updated_at',
      ])
    );
  });

  it('accounts table has claude_binary column', () => {
    const info = db.raw.prepare('PRAGMA table_info(accounts)').all() as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toContain('claude_binary');
  });

  it('getSetting and saveSetting work', () => {
    db.saveSetting('theme', 'dark');
    expect(db.getSetting('theme')).toBe('dark');

    db.saveSetting('theme', 'light');
    expect(db.getSetting('theme')).toBe('light');
  });

  it('getSetting returns null for missing key', () => {
    expect(db.getSetting('nonexistent')).toBeNull();
  });
});

describe('runMigrations', () => {
  let raw: BetterSqlite3.Database;

  beforeEach(() => {
    raw = new BetterSqlite3(':memory:');
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');

    // Bootstrap the schema_version table and accounts table so migrations have
    // something to work against.
    raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        config_dir TEXT NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT 0,
        account_type TEXT NOT NULL DEFAULT 'pro',
        claude_binary TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  });

  afterEach(() => {
    raw.close();
  });

  it('creates schema_version rows for each migration run', () => {
    runMigrations(raw);

    const rows = raw
      .prepare('SELECT version FROM schema_version ORDER BY version')
      .all() as { version: number }[];

    // At minimum migration version 1 should have been applied.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].version).toBe(1);
  });

  it('applied migration has a non-null applied_at timestamp', () => {
    runMigrations(raw);

    const row = raw
      .prepare('SELECT applied_at FROM schema_version WHERE version = 1')
      .get() as { applied_at: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.applied_at).toBeTruthy();
  });

  it('running migrations twice is idempotent (no duplicate rows, no error)', () => {
    runMigrations(raw);
    runMigrations(raw);

    const rows = raw
      .prepare('SELECT version FROM schema_version ORDER BY version')
      .all() as { version: number }[];

    // Exactly one row per migration version — no duplicates.
    const versions = rows.map((r) => r.version);
    const unique = [...new Set(versions)];
    expect(versions).toEqual(unique);
  });

  it('migrations are applied in ascending version order', () => {
    runMigrations(raw);

    const rows = raw
      .prepare('SELECT version FROM schema_version ORDER BY rowid')
      .all() as { version: number }[];

    const versions = rows.map((r) => r.version);
    const sorted = [...versions].sort((a, b) => a - b);
    expect(versions).toEqual(sorted);
  });

  it('migration 1 adds color column to accounts when missing', () => {
    // accounts table was created WITHOUT color column in beforeEach.
    const colsBefore = raw
      .prepare('PRAGMA table_info(accounts)')
      .all() as { name: string }[];
    expect(colsBefore.some((c) => c.name === 'color')).toBe(false);

    runMigrations(raw);

    const colsAfter = raw
      .prepare('PRAGMA table_info(accounts)')
      .all() as { name: string }[];
    expect(colsAfter.some((c) => c.name === 'color')).toBe(true);
  });

  it('migration 1 is skipped when color column already exists', () => {
    // Add the color column manually to simulate a database that already had it.
    raw.exec('ALTER TABLE accounts ADD COLUMN color TEXT');

    // Should not throw.
    expect(() => runMigrations(raw)).not.toThrow();

    // Still records migration 1 as applied.
    const row = raw
      .prepare('SELECT version FROM schema_version WHERE version = 1')
      .get();
    expect(row).toBeDefined();
  });
});

describe('ensureDefaultSettings', () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('writes a default value when the setting does not exist', () => {
    expect(db.getSetting('local_update_dir')).toBeNull();

    ensureDefaultSettings(db, { local_update_dir: '/Users/me/out/make' });

    expect(db.getSetting('local_update_dir')).toBe('/Users/me/out/make');
  });

  it('does not overwrite a user-set value', () => {
    db.saveSetting('local_update_dir', '/custom/path');

    ensureDefaultSettings(db, { local_update_dir: '/default/path' });

    expect(db.getSetting('local_update_dir')).toBe('/custom/path');
  });

  it('supports multiple defaults at once and only fills missing keys', () => {
    db.saveSetting('foo', 'existing');

    ensureDefaultSettings(db, { foo: 'default_foo', bar: 'default_bar' });

    expect(db.getSetting('foo')).toBe('existing');
    expect(db.getSetting('bar')).toBe('default_bar');
  });

  it('treats an empty-string stored value as a user-set value (does not overwrite)', () => {
    // An empty string means the user deliberately cleared the setting
    // (disabling local updates). Do not re-write the default over that.
    db.saveSetting('local_update_dir', '');

    ensureDefaultSettings(db, { local_update_dir: '/default/path' });

    expect(db.getSetting('local_update_dir')).toBe('');
  });
});
