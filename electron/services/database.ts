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
  if (msg.includes('NODE_MODULE_VERSION')) {
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
  {
    version: 2,
    description: 'Add icon column to accounts',
    up: (db) => {
      const cols = db.pragma('table_info(accounts)') as { name: string }[];
      if (!cols.some((c) => c.name === 'icon')) {
        db.exec('ALTER TABLE accounts ADD COLUMN icon TEXT');
      }
    },
  },
  {
    version: 4,
    description: 'Add session_defaults column to accounts',
    up: (db) => {
      const cols = db.pragma('table_info(accounts)') as { name: string }[];
      if (!cols.some((c) => c.name === 'session_defaults')) {
        db.exec('ALTER TABLE accounts ADD COLUMN session_defaults TEXT');
      }
    },
  },
  {
    version: 3,
    description: 'Add rate_limit_snapshots and rate_limit_fired_thresholds tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS rate_limit_snapshots (
          account_name TEXT NOT NULL,
          rate_limit_type TEXT NOT NULL,
          status TEXT NOT NULL,
          utilization REAL,
          resets_at INTEGER,
          payload_json TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          PRIMARY KEY (account_name, rate_limit_type)
        );

        CREATE TABLE IF NOT EXISTS rate_limit_fired_thresholds (
          account_name TEXT NOT NULL,
          rate_limit_type TEXT NOT NULL,
          window_resets_at INTEGER NOT NULL,
          threshold_key TEXT NOT NULL,
          fired_at INTEGER NOT NULL,
          PRIMARY KEY (account_name, rate_limit_type, window_resets_at, threshold_key)
        );
      `);
    },
  },
  {
    version: 5,
    description: 'Add cli_path column to accounts',
    up: (db) => {
      const cols = db.pragma('table_info(accounts)') as { name: string }[];
      if (!cols.some((c) => c.name === 'cli_path')) {
        db.exec('ALTER TABLE accounts ADD COLUMN cli_path TEXT');
      }
    },
  },
  {
    version: 6,
    description: 'Add branch_colors table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS branch_colors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          branch_name TEXT NOT NULL,
          color TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          UNIQUE(project_path, branch_name)
        );
        CREATE INDEX IF NOT EXISTS idx_branch_colors_project ON branch_colors(project_path);
      `);
    },
  },
  {
    version: 7,
    description: 'Add summarizeOnClose + summaryModel to accounts (per-session summary opt-in)',
    up: (db) => {
      const cols = db.pragma('table_info(accounts)') as { name: string }[];
      const names = new Set(cols.map((c) => c.name));
      if (!names.has('summarizeOnClose')) {
        db.exec('ALTER TABLE accounts ADD COLUMN summarizeOnClose INTEGER NOT NULL DEFAULT 0');
      }
      if (!names.has('summaryModel')) {
        db.exec('ALTER TABLE accounts ADD COLUMN summaryModel TEXT');
      }
    },
  },
  {
    version: 8,
    description:
      'Drop accounts.is_default — there is no longer any notion of a default account. ' +
      'Account resolution is strictly via path rules and explicit project overrides; ' +
      'failure to resolve is an error surfaced to the user, not a silent fallback.',
    up: (db) => {
      const cols = db.pragma('table_info(accounts)') as { name: string }[];
      if (cols.some((c) => c.name === 'is_default')) {
        // SQLite ≥ 3.35 supports ALTER TABLE DROP COLUMN. better-sqlite3 ships
        // a modern SQLite so this is safe; if a user is on an older bundle the
        // ALTER will throw and the migration's transaction rolls back, leaving
        // the schema_version row unwritten so a future run can retry.
        db.exec('ALTER TABLE accounts DROP COLUMN is_default');
      }
    },
  },
  {
    version: 9,
    description:
      'Add agent column to account_path_rules (forward-compat for Codex routing). ' +
      'Defaults to "claude" so every existing rule keeps its current behavior.',
    up: (db) => {
      // Skip if the table hasn't been created yet — runMigrations tests
      // bootstrap a minimal schema and rely on every migration being a no-op
      // when its target table is missing.
      const tableExists = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='account_path_rules'"
        )
        .get();
      if (!tableExists) return;
      const cols = db.pragma('table_info(account_path_rules)') as { name: string }[];
      if (!cols.some((c) => c.name === 'agent')) {
        db.prepare(
          "ALTER TABLE account_path_rules ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude'"
        ).run();
      }
    },
  },
  {
    version: 10,
    description:
      'Make account_path_rules.account_id nullable so Codex-only rules (which ' +
      'carry no Claude account) can be stored. SQLite cannot drop NOT NULL ' +
      'in-place, so this is a rebuild-table migration: new table, copy data, ' +
      'drop old, rename. Idempotent — re-runs detect the already-nullable ' +
      'schema and bail.',
    up: (db) => {
      const tableExists = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='account_path_rules'"
        )
        .get();
      if (!tableExists) return;

      const cols = db.pragma('table_info(account_path_rules)') as {
        name: string;
        notnull: number;
      }[];
      const accountIdCol = cols.find((c) => c.name === 'account_id');
      // notnull===0 means the column is already nullable; nothing to do.
      if (!accountIdCol || accountIdCol.notnull === 0) return;

      // NB: plain INTEGER PRIMARY KEY (no AUTOINCREMENT). The DROP TABLE below
      // would remove the table's row from sqlite_sequence, breaking the
      // monotonic-id contract AUTOINCREMENT promises. We don't need it here —
      // nothing FKs against account_path_rules.id, and lookups are by path —
      // so we drop AUTOINCREMENT entirely (SQLite docs explicitly recommend
      // this when not strictly needed).
      db.exec(`
        CREATE TABLE account_path_rules_new (
          id INTEGER PRIMARY KEY,
          account_id INTEGER,
          path_prefix TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          agent TEXT NOT NULL DEFAULT 'claude',
          FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
        );

        INSERT INTO account_path_rules_new (id, account_id, path_prefix, priority, agent)
          SELECT id, account_id, path_prefix, priority, agent FROM account_path_rules;

        DROP TABLE account_path_rules;
        ALTER TABLE account_path_rules_new RENAME TO account_path_rules;
      `);
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
      -- No is_default column. There is no notion of a "default" account.
      -- Account resolution is strictly path rule / project override, with
      -- failure surfaced as an error (NoAccountError). Migration v8 drops
      -- this column from existing installs.
      account_type TEXT NOT NULL DEFAULT 'pro',
      color TEXT,
      icon TEXT,
      claude_binary TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Canonical shape matches the post-migration-v10 schema so fresh installs
    -- skip the v9/v10 rebuilds (both migrations are idempotent and will detect
    -- the already-correct shape). account_id is nullable to allow Codex-only
    -- rules; agent defaults to 'claude'. Plain INTEGER PRIMARY KEY (no
    -- AUTOINCREMENT) — see migration v10's comment for why.
    CREATE TABLE IF NOT EXISTS account_path_rules (
      id INTEGER PRIMARY KEY,
      account_id INTEGER,
      path_prefix TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      agent TEXT NOT NULL DEFAULT 'claude',
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
