import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  ensureDefaultSettings,
  toActionableNativeModuleError,
  type Database,
  type Migration,
} from '../services/database';

describe('database', () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('migration v5 adds cli_path column to accounts', () => {
    const cols = db.raw.pragma('table_info(accounts)') as { name: string }[];
    expect(cols.some((c) => c.name === 'cli_path')).toBe(true);
  });

  it('migration v12 creates the model_catalog table', () => {
    const row = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_catalog'")
      .get();
    expect(row).toBeTruthy();
    const cols = (db.raw.pragma('table_info(model_catalog)') as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['config_dir', 'cli_version', 'catalog_json', 'fetched_at']);
  });

  it('initSchema emits the post-v11 accounts shape (no account_type, has engine/has_cost/subscription_label)', () => {
    const names = (db.raw.pragma('table_info(accounts)') as { name: string }[]).map((c) => c.name);
    expect(names).toContain('subscription_label');
    expect(names).toContain('engine');
    expect(names).toContain('has_cost');
    expect(names).not.toContain('account_type');
  });

  it('a fresh DB has the same accounts + overrides columns as a legacy DB migrated up (no init/migration drift)', () => {
    // Legacy pre-v11 DB: old accounts/overrides shape, no schema_version rows,
    // so every migration runs against it.
    const legacy = new BetterSqlite3(':memory:');
    legacy.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        config_dir TEXT NOT NULL,
        account_type TEXT NOT NULL DEFAULT 'pro',
        color TEXT, icon TEXT, claude_binary TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE account_path_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        path_prefix TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE project_account_overrides (
        project_path TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
    `);
    runMigrations(legacy, { homeDir: '/nonexistent-home-for-test' });

    const colset = (d: BetterSqlite3.Database, table: string): string[] =>
      (d.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name).sort();

    expect(colset(legacy, 'accounts')).toEqual(colset(db.raw, 'accounts'));
    expect(colset(legacy, 'project_account_overrides')).toEqual(
      colset(db.raw, 'project_account_overrides'),
    );
    legacy.close();
  });

  it('running migrations again on a fresh DB is a no-op (idempotent)', () => {
    const before = (db.raw.pragma('table_info(accounts)') as { name: string }[]).map((c) => c.name);
    expect(() => runMigrations(db.raw, { homeDir: '/nonexistent-home-for-test' })).not.toThrow();
    const after = (db.raw.pragma('table_info(accounts)') as { name: string }[]).map((c) => c.name);
    expect(after).toEqual(before);
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

  it('account_path_rules has no agent column post-v11 (engine lives on accounts)', () => {
    const info = db.raw
      .prepare('PRAGMA table_info(account_path_rules)')
      .all() as { name: string; notnull: number }[];
    const cols = info.map((c) => c.name);
    expect(cols).not.toContain('agent');
    // account_id is NOT NULL after v11.
    expect(info.find((c) => c.name === 'account_id')?.notnull).toBe(1);
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

  it('runs a synthetic migration end-to-end (applies up + records version)', () => {
    let upCalls = 0;
    const synthetic: Migration[] = [
      {
        version: 99,
        description: 'synthetic test migration',
        up: (db) => {
          upCalls++;
          db.exec('CREATE TABLE synthetic_marker (id INTEGER PRIMARY KEY)');
        },
      },
    ];

    runMigrations(raw, { migrationsOverride: synthetic });

    expect(upCalls).toBe(1);

    // schema_version row recorded for the synthetic migration.
    const row = raw
      .prepare('SELECT applied_at FROM schema_version WHERE version = 99')
      .get() as { applied_at: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.applied_at).toBeTruthy();

    // Second run is a no-op — version already applied.
    runMigrations(raw, { migrationsOverride: synthetic });
    expect(upCalls).toBe(1);

    // Sanity: the `up` actually ran against the real DB.
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='synthetic_marker'")
      .all() as { name: string }[];
    expect(tables.length).toBe(1);
  });

  it('rolls back a throwing migration (no schema_version row, no partial side-effects)', () => {
    const bad: Migration[] = [
      {
        version: 42,
        description: 'deliberately failing migration',
        up: (db) => {
          // Create a table first so we can verify it's rolled back with the throw.
          db.exec('CREATE TABLE should_not_exist (id INTEGER PRIMARY KEY)');
          throw new Error('migration boom');
        },
      },
    ];

    expect(() => runMigrations(raw, { migrationsOverride: bad })).toThrow(/migration boom/);

    // No schema_version row for the failed migration.
    const row = raw
      .prepare('SELECT version FROM schema_version WHERE version = 42')
      .get() as { version: number } | undefined;
    expect(row).toBeUndefined();

    // And the partial table write was rolled back with the transaction.
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='should_not_exist'")
      .all() as { name: string }[];
    expect(tables.length).toBe(0);
  });

  it('runs multiple synthetic migrations in ascending version order even when passed out of order', () => {
    const callOrder: number[] = [];
    const synthetic: Migration[] = [
      { version: 3, description: 'third', up: () => { callOrder.push(3); } },
      { version: 1, description: 'first', up: () => { callOrder.push(1); } },
      { version: 2, description: 'second', up: () => { callOrder.push(2); } },
    ];

    runMigrations(raw, { migrationsOverride: synthetic });

    expect(callOrder).toEqual([1, 2, 3]);
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

  it('migration v2 adds an icon column to accounts', () => {
    const db = new BetterSqlite3(':memory:');
    db.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        config_dir TEXT NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT 0,
        account_type TEXT NOT NULL DEFAULT 'pro',
        color TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    runMigrations(db);

    const cols = db.pragma('table_info(accounts)') as { name: string }[];
    expect(cols.some((c) => c.name === 'icon')).toBe(true);
    db.close();
  });

  it('migration v2 is idempotent (running twice does not throw)', () => {
    const db = new BetterSqlite3(':memory:');
    db.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        config_dir TEXT NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT 0,
        account_type TEXT NOT NULL DEFAULT 'pro',
        color TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    expect(() => {
      runMigrations(db);
      runMigrations(db);
    }).not.toThrow();

    const cols = db.pragma('table_info(accounts)') as { name: string }[];
    expect(cols.filter((c) => c.name === 'icon')).toHaveLength(1);
    db.close();
  });

  it('migration v8 drops the is_default column from existing installs', () => {
    const db = new BetterSqlite3(':memory:');
    // Old schema with is_default still present (a pre-v8 install).
    db.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        config_dir TEXT NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT 0,
        account_type TEXT NOT NULL DEFAULT 'pro',
        color TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO accounts (name, config_dir, is_default) VALUES ('Personal', '/cfg/p', 1);
    `);

    runMigrations(db);

    const cols = db.pragma('table_info(accounts)') as { name: string }[];
    expect(cols.some((c) => c.name === 'is_default')).toBe(false);
    // Row data preserved (just without the dropped column).
    const row = db.prepare('SELECT name, config_dir FROM accounts').get() as
      | { name: string; config_dir: string }
      | undefined;
    expect(row?.name).toBe('Personal');
    expect(row?.config_dir).toBe('/cfg/p');
    db.close();
  });

  it('fresh installs (initSchema only) never have an is_default column', () => {
    // Goes through the full createDatabase path so initSchema + runMigrations
    // both fire. initSchema creates the new schema (no is_default), and v8 is
    // a no-op when the column was never there to begin with.
    const db = createDatabase(':memory:');
    const cols = db.raw.pragma('table_info(accounts)') as { name: string }[];
    expect(cols.some((c) => c.name === 'is_default')).toBe(false);
    db.close();
  });
});

describe('toActionableNativeModuleError', () => {
  it('wraps a NODE_MODULE_VERSION mismatch with a clear rebuild hint', () => {
    const original = new Error(
      "The module '/path/better_sqlite3.node' was compiled against a different Node.js " +
        'version using NODE_MODULE_VERSION 145. This version of Node.js requires ' +
        'NODE_MODULE_VERSION 115. Please try re-compiling or re-installing the module.',
    );

    const wrapped = toActionableNativeModuleError(original);

    expect(wrapped).not.toBe(original);
    expect(wrapped.message).toMatch(/npm run rebuild:electron/);
    expect(wrapped.message).toMatch(/npm test/);
    expect(wrapped.message).toContain('Original error:');
  });

  it('passes non-ABI errors through unchanged', () => {
    const original = new Error('unable to open database file');

    const result = toActionableNativeModuleError(original);

    expect(result).toBe(original);
  });

  it('wraps non-Error throwables into an Error', () => {
    const result = toActionableNativeModuleError('something went wrong');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('something went wrong');
  });
});

describe('database migration v6', () => {
  it('creates branch_colors table with the expected columns', () => {
    const db = createDatabase(':memory:');
    const cols = db.raw.pragma('table_info(branch_colors)') as { name: string; type: string }[];
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('id')).toBe(true);
    expect(names.has('project_path')).toBe(true);
    expect(names.has('branch_name')).toBe(true);
    expect(names.has('color')).toBe(true);
    expect(names.has('sort_order')).toBe(true);
    expect(names.has('created_at')).toBe(true);
    db.close();
  });

  it('enforces unique (project_path, branch_name)', () => {
    const db = createDatabase(':memory:');
    db.raw.prepare(
      "INSERT INTO branch_colors (project_path, branch_name, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run('/p', 'develop', '#3b82f6', 0, Date.now());
    expect(() =>
      db.raw.prepare(
        "INSERT INTO branch_colors (project_path, branch_name, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run('/p', 'develop', '#84cc16', 0, Date.now())
    ).toThrow(/UNIQUE constraint/);
    db.close();
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
