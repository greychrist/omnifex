import BetterSqlite3 from 'better-sqlite3';

export interface Database {
  raw: BetterSqlite3.Database;
  getSetting(key: string): string | null;
  saveSetting(key: string, value: string): void;
  close(): void;
}

export function createDatabase(dbPath: string): Database {
  const raw = new BetterSqlite3(dbPath);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');

  initSchema(raw);

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

  // Migrations for existing databases
  const cols = db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[];
  if (!cols.some(c => c.name === 'color')) {
    db.exec("ALTER TABLE accounts ADD COLUMN color TEXT");
  }
}
