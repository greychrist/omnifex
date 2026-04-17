import BetterSqlite3 from 'better-sqlite3';

/**
 * Wrap the cryptic `NODE_MODULE_VERSION` error that better-sqlite3 throws when
 * its compiled ABI doesn't match the current runtime with a clear, actionable
 * message. The most common way to hit this is running `npm run dev` (Vite-only,
 * no pre-hook rebuild) after a prior `npm test` (which rebuilds for Node) —
 * the first DB access in Electron crashes with a native-module fault that
 * doesn't mention the real fix.
 *
 * Exported so it's unit-testable without needing to induce a real ABI mismatch.
 */
export function toActionableNativeModuleError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/NODE_MODULE_VERSION/.test(msg)) {
    const hint =
      'better-sqlite3 was built for the wrong runtime ABI. ' +
      'Run `npm run rebuild:electron` before `npm start`, ' +
      'or run `npm test` first (its pretest hook rebuilds for Node).';
    const wrapped = new Error(`${hint}\n\nOriginal error: ${msg}`);
    (wrapped as any).cause = err;
    return wrapped;
  }
  return err instanceof Error ? err : new Error(msg);
}

export interface Database {
  raw: BetterSqlite3.Database;
  getSetting(key: string): string | null;
  saveSetting(key: string, value: string): void;
  close(): void;
}

export interface Migration {
  version: number;
  description: string;
  up: (db: BetterSqlite3.Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    description: 'Add color column to accounts',
    up: (db) => {
      const cols = db.pragma('table_info(accounts)') as { name: string }[];
      if (!cols.some((c) => c.name === 'color')) {
        db.exec('ALTER TABLE accounts ADD COLUMN color TEXT');
      }
    },
  },
];

/**
 * Run any migrations whose `version` is greater than the highest version
 * recorded in `schema_version`. Each migration runs inside its own transaction
 * together with the `schema_version` row insert, so a crashing migration
 * leaves the DB in a clean pre-migration state.
 *
 * `migrationsOverride` is for tests only — production callers pass no argument
 * and use the module-level `migrations` list. Exposing the override lets tests
 * exercise the runner against a synthetic migration (no-op, throwing, etc.)
 * without having to land a real schema change first.
 */
export function runMigrations(
  db: BetterSqlite3.Database,
  migrationsOverride?: Migration[],
): void {
  const migrationsToRun = migrationsOverride ?? migrations;

  // Ensure schema_version table exists (safe to call multiple times).
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const row = db
    .prepare('SELECT MAX(version) AS max_version FROM schema_version')
    .get() as { max_version: number | null };
  const currentVersion = row.max_version ?? 0;

  const pending = migrationsToRun
    .filter((m) => m.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    const runOne = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString()
      );
    });
    runOne();
  }
}

export function createDatabase(dbPath: string): Database {
  let raw: BetterSqlite3.Database;
  try {
    raw = new BetterSqlite3(dbPath);
  } catch (err) {
    throw toActionableNativeModuleError(err);
  }
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');

  initSchema(raw);
  runMigrations(raw);

  return {
    raw,

    getSetting(key: string): string | null {
      const row = raw
        .prepare('SELECT value FROM app_settings WHERE key = ?')
        .get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },

    saveSetting(key: string, value: string): void {
      raw
        .prepare(
          `INSERT INTO app_settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
        )
        .run(key, value);
    },

    close(): void {
      raw.close();
    },
  };
}

/**
 * Write default values for app_settings keys that don't yet have a stored
 * value. Called from `main.ts` on app startup — gives new installs sensible
 * defaults without clobbering user-edited values.
 *
 * An empty string counts as user-set ("I deliberately cleared this"); only
 * truly-missing keys (getSetting returns null) get filled.
 */
export function ensureDefaultSettings(db: Database, defaults: Record<string, string>): void {
  for (const [key, value] of Object.entries(defaults)) {
    if (db.getSetting(key) === null) {
      db.saveSetting(key, value);
    }
  }
}

function initSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      default_task TEXT,
      model TEXT NOT NULL DEFAULT 'sonnet',
      enable_file_read BOOLEAN NOT NULL DEFAULT 1,
      enable_file_write BOOLEAN NOT NULL DEFAULT 1,
      enable_network BOOLEAN NOT NULL DEFAULT 0,
      hooks TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      agent_name TEXT NOT NULL,
      agent_icon TEXT NOT NULL,
      task TEXT NOT NULL,
      model TEXT NOT NULL,
      project_path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      pid INTEGER,
      process_started_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      config_dir TEXT NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT 0,
      account_type TEXT NOT NULL DEFAULT 'pro',
      color TEXT,
      claude_binary TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS account_path_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      path_prefix TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_account_overrides (
      project_path TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      category TEXT,
      message TEXT NOT NULL,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_app_logs_timestamp ON app_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_app_logs_level ON app_logs(level);
    CREATE INDEX IF NOT EXISTS idx_app_logs_source ON app_logs(source);
  `);
}
