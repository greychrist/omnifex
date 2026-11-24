import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLegacyPricingOverrides } from '../../src/lib/pricing';
import { repoIdentity } from './git-repos';

export function toActionableNativeModuleError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('NODE_MODULE_VERSION')) {
    const hint =
      'better-sqlite3 was built for the wrong runtime ABI. ' +
      'Native modules must be built for Node 26: run `nvm use` then `npm rebuild`.';
    const wrapped = new Error(`${hint}\n\nOriginal error: ${msg}`);
    (wrapped as Error & { cause?: unknown }).cause = err;
    return wrapped;
  }
  return err instanceof Error ? err : new Error(msg);
}

export interface Database {
  raw: BetterSqlite3.Database;
  getSetting(key: string): string | null;
  saveSetting(key: string, value: string): void;
  /** Returns freed pages to the OS; needs `auto_vacuum = INCREMENTAL` (a no-op under NONE). */
  reclaimFreePages(): number;
  close(): void;
}

export interface MigrationOptions {
  homeDir?: string;
}

export interface Migration {
  version: number;
  description: string;
  up: (db: BetterSqlite3.Database, opts: MigrationOptions) => void;
}

/** Shared by initSchema and migration v18 so the two can't drift. Pointers and status only, never note content. */
const BRAIN_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS brain_sources (
    account_id INTEGER NOT NULL,
    source_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    mtime INTEGER,
    hash TEXT,
    last_indexed_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    -- What the last run of this item actually cost, straight from the CLI's
    -- own total_cost_usd — not an estimate derived from a pricing table we
    -- would then have to keep in step with Anthropic's. NULL means nothing has
    -- been spent on this item, which is distinct from a run that cost 0.
    cost_usd REAL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_creation_tokens INTEGER,
    PRIMARY KEY (account_id, source_id, item_key),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS brain_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    source_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    finished_at TEXT,
    UNIQUE (account_id, source_id, item_key),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );
`;

/**
 * Append-only, apart from session_cost_daily: its daily upsert can't represent re-indexing as new spend.
 * No FK on account_id: deleting an account must not shrink a month already reported.
 */
const BRAIN_SPEND_DDL = `
  CREATE TABLE IF NOT EXISTS brain_spend (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    account_name TEXT NOT NULL,
    -- 'index' | 'curation'. Curation is pinned to a better model on purpose,
    -- so it is the line item most likely to surprise; a blended total hides it.
    kind TEXT NOT NULL,
    source_id TEXT,
    item_key TEXT NOT NULL,
    -- Never blank and never 'unknown'. A ledger row that cannot say what it
    -- paid for cannot be priced or audited. Enforced in the schema so no
    -- writer can introduce one.
    model TEXT NOT NULL CHECK (model <> '' AND model <> 'unknown'),
    -- Local date, YYYY-MM-DD, stored rather than derived. Every consumer groups
    -- by month in the user's own timezone, and deriving that from a UTC instant
    -- at read time is where off-by-one-day bugs live.
    date TEXT NOT NULL,
    spent_at TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_creation_tokens INTEGER,
    cost_usd REAL
  );

  CREATE INDEX IF NOT EXISTS idx_brain_spend_date ON brain_spend(date);
  CREATE INDEX IF NOT EXISTS idx_brain_spend_account_date
    ON brain_spend(account_name, date);
`;

/**
 * `latest_json - baseline_json` is what the process spent; a `--resume` may restore an earlier process's totals.
 * Kept apart from session_cost_daily: this is evidence, that table is derived and replaced per session.
 */
const CLI_PROCESS_USAGE_DDL = `
  CREATE TABLE IF NOT EXISTS cli_process_usage (
    session_id TEXT NOT NULL,
    process_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    baseline_json TEXT,
    baseline_at TEXT,
    latest_json TEXT,
    latest_at TEXT,
    PRIMARY KEY (session_id, process_id)
  );
`;

/** Deltas only, never seeded from src/lib/pricing.ts: a seeded copy would never receive a release's price fix. */
const MODEL_PRICING_DDL = `
  CREATE TABLE IF NOT EXISTS model_pricing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Model-id substring, lowercased. Longest match wins at resolve time.
    pattern TEXT NOT NULL,
    -- YYYY-MM-DD, inclusive. Rate changes APPEND a period; editing one in
    -- place re-prices every past row on the next cost re-scan.
    effective_from TEXT NOT NULL DEFAULT '1970-01-01',
    input_per_m REAL,
    output_per_m REAL,
    fast_input_per_m REAL,
    fast_output_per_m REAL,
    -- Absolute, for models that escape the standard cache multiplier the way
    -- Fable 5.1 does ($0.25/MTok reads on a $10/MTok input rate).
    cache_read_per_m REAL,
    cache_write_5m_per_m REAL,
    cache_write_1h_per_m REAL,
    label TEXT,
    -- Dropped by v31; here because v25 creates the table from this DDL.
    color_slot INTEGER,
    -- Native context window in tokens (v26). Display metadata, not a rate.
    context_window INTEGER,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (pattern, effective_from)
  );
`;

export const migrations: Migration[] = [
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
      // Migrations must no-op when their table is missing: the tests bootstrap minimal schemas.
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
      if (!accountIdCol || accountIdCol.notnull === 0) return;

      // No AUTOINCREMENT: the DROP TABLE below would remove its sqlite_sequence row.
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
  {
    version: 11,
    description:
      'Codex account parity: add engine + has_cost to accounts; rename ' +
      'account_type → subscription_label (capitalized); drop agent column from ' +
      'account_path_rules and make account_id NOT NULL; per-engine ' +
      'project_account_overrides composite key. In-migration Codex discovery ' +
      'runs only when orphan Codex path rules need an account to bind to.',
    up: (db, opts) => {
      const homeDir = opts.homeDir ?? os.homedir();

      const tableExists = (name: string): boolean =>
        !!db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
          .get(name);
      const columnNames = (table: string): Set<string> =>
        new Set(
          (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name),
        );

      // Touch the filesystem only when orphan Codex rules exist, or fresh installs and tests scan the real ~/.codex.
      const pathRulesExist = tableExists('account_path_rules');
      const hasAgentCol = pathRulesExist && columnNames('account_path_rules').has('agent');
      const hasOrphanCodexRules =
        hasAgentCol &&
        !!db
          .prepare(
            `SELECT 1 FROM account_path_rules WHERE account_id IS NULL AND agent = 'codex' LIMIT 1`,
          )
          .get();

      const codexHome = path.join(homeDir, '.codex');
      if (hasOrphanCodexRules) {
        let codexDirExists = false;
        try {
          codexDirExists = fs.existsSync(codexHome);
        } catch {
          codexDirExists = false;
        }
        if (codexDirExists) {
          const existingCodex = db
            .prepare(`SELECT id FROM accounts WHERE config_dir = ?`)
            .get(codexHome);
          if (!existingCodex) {
            db.prepare(
              `INSERT INTO accounts (name, config_dir, account_type) VALUES (?, ?, ?)`,
            ).run('Codex', codexHome, '');
          }
          if (tableExists('app_settings')) {
            db.prepare(
              `INSERT OR REPLACE INTO app_settings (key, value, updated_at)
               VALUES ('codex_discovery_completed', 'true', CURRENT_TIMESTAMP)`,
            ).run();
          }
        }
      }

      if (tableExists('accounts')) {
        const cols = columnNames('accounts');
        if (!cols.has('engine')) {
          db.exec(`ALTER TABLE accounts ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude'`);
        }
        if (!cols.has('has_cost')) {
          db.exec(`ALTER TABLE accounts ADD COLUMN has_cost INTEGER NOT NULL DEFAULT 1`);
        }
        if (cols.has('account_type') && !cols.has('subscription_label')) {
          db.exec(`ALTER TABLE accounts RENAME COLUMN account_type TO subscription_label`);
        }

        db.exec(`UPDATE accounts SET subscription_label = 'Max', has_cost = 0 WHERE subscription_label = 'max'`);
        db.exec(`UPDATE accounts SET subscription_label = 'Pro' WHERE subscription_label = 'pro'`);
        db.exec(`UPDATE accounts SET subscription_label = 'Enterprise' WHERE subscription_label = 'enterprise'`);
        db.exec(`UPDATE accounts SET subscription_label = 'Free' WHERE subscription_label = 'free'`);

        db.prepare(`UPDATE accounts SET engine = 'codex' WHERE config_dir = ?`).run(codexHome);
      }

      if (hasAgentCol) {
        db.exec(`
          UPDATE account_path_rules
             SET account_id = (
               SELECT id FROM accounts WHERE engine = 'codex' ORDER BY id ASC LIMIT 1
             )
           WHERE account_id IS NULL
             AND agent = 'codex'
             AND EXISTS (SELECT 1 FROM accounts WHERE engine = 'codex')
        `);
        db.exec(`DELETE FROM account_path_rules WHERE account_id IS NULL`);

        db.exec(`
          CREATE TABLE account_path_rules_new (
            id INTEGER PRIMARY KEY,
            account_id INTEGER NOT NULL,
            path_prefix TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
          );
          INSERT INTO account_path_rules_new (id, account_id, path_prefix, priority)
            SELECT id, account_id, path_prefix, priority FROM account_path_rules;
          DROP TABLE account_path_rules;
          ALTER TABLE account_path_rules_new RENAME TO account_path_rules;
        `);
      }

      if (
        tableExists('project_account_overrides') &&
        !columnNames('project_account_overrides').has('engine')
      ) {
        db.exec(`
          CREATE TABLE project_account_overrides_new (
            project_path TEXT NOT NULL,
            engine TEXT NOT NULL DEFAULT 'claude',
            account_id INTEGER NOT NULL,
            PRIMARY KEY (project_path, engine),
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
          );
          INSERT INTO project_account_overrides_new (project_path, engine, account_id)
            SELECT project_path, 'claude', account_id FROM project_account_overrides;
          DROP TABLE project_account_overrides;
          ALTER TABLE project_account_overrides_new RENAME TO project_account_overrides;
        `);
      }
    },
  },
  {
    version: 12,
    description:
      'model_catalog: per-config-dir cache of the CLI-reported model list, ' +
      'keyed for invalidation by the CLI version that produced it.',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS model_catalog (
          config_dir   TEXT PRIMARY KEY,
          cli_version  TEXT NOT NULL,
          catalog_json TEXT NOT NULL,
          fetched_at   INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 13,
    description:
      'model_catalog.fetched_at: epoch-ms INTEGER → ISO-8601 TEXT, matching ' +
      'the timestamp style used everywhere else in the schema (and readable ' +
      'in DB browsers). SQLite cannot ALTER a column type, so rebuild-table.',
    up(db) {
      db.exec(`
        CREATE TABLE model_catalog_new (
          config_dir   TEXT PRIMARY KEY,
          cli_version  TEXT NOT NULL,
          catalog_json TEXT NOT NULL,
          fetched_at   TEXT NOT NULL
        );
        INSERT INTO model_catalog_new (config_dir, cli_version, catalog_json, fetched_at)
          SELECT config_dir, cli_version, catalog_json,
                 strftime('%Y-%m-%dT%H:%M:%fZ', fetched_at / 1000.0, 'unixepoch')
          FROM model_catalog;
        DROP TABLE model_catalog;
        ALTER TABLE model_catalog_new RENAME TO model_catalog;
      `);
    },
  },
  {
    version: 14,
    description:
      'command_catalog: per-config-dir cache of the CLI-reported slash-command ' +
      'list (incl. built-ins and plugins), keyed for invalidation by the CLI ' +
      'version that produced it. Mirrors model_catalog — a long-running ' +
      "session's frozen init snapshot misses commands added by a later CLI " +
      'update, so the picker reads this fresh, version-keyed cache instead.',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS command_catalog (
          config_dir   TEXT PRIMARY KEY,
          cli_version  TEXT NOT NULL,
          catalog_json TEXT NOT NULL,
          fetched_at   TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 15,
    description:
      'project_pins: the set of project paths the user pinned to the top of ' +
      'the Projects list. A bare set — pin order is never read (the list sorts ' +
      'within the pinned group by the active sort key), so there is no ' +
      'pinned_at column. Keyed by path like project_account_overrides; a pin ' +
      'for a path that no longer exists on disk is inert.',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_pins (
          project_path TEXT PRIMARY KEY
        );
      `);
    },
  },
  {
    version: 16,
    description: 'Add session_cost_daily table for durable cost history',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_cost_daily (
          session_id            TEXT NOT NULL,
          date                  TEXT NOT NULL,
          model                 TEXT NOT NULL,
          account_name          TEXT NOT NULL,
          config_dir            TEXT NOT NULL,
          project_path          TEXT,
          input_tokens          INTEGER NOT NULL DEFAULT 0,
          output_tokens         INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
          cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd              REAL NOT NULL,
          is_estimated          INTEGER NOT NULL DEFAULT 0,
          updated_at            TEXT NOT NULL,
          PRIMARY KEY (session_id, date, model)
        );
        CREATE INDEX IF NOT EXISTS idx_session_cost_daily_date ON session_cost_daily(date);
        CREATE INDEX IF NOT EXISTS idx_session_cost_daily_account ON session_cost_daily(account_name, date);
      `);
    },
  },
  {
    version: 17,
    description:
      'Add expected_email to accounts — the address the user asserts this ' +
      'config dir should be logged in as. Nullable; null means "do not check", ' +
      'so the session-start verification does no I/O for accounts that have ' +
      'not opted in.',
    up: (db) => {
      // `table_info` on a missing table returns [], which would read as "column absent".
      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'")
        .get();
      if (!tableExists) return;
      const cols = db.pragma('table_info(accounts)') as { name: string }[];
      if (!cols.some((c) => c.name === 'expected_email')) {
        db.exec('ALTER TABLE accounts ADD COLUMN expected_email TEXT');
      }
    },
  },
  {
    version: 18,
    description:
      'Add brain_sources and brain_queue orchestration tables for the ' +
      'per-account Brain vault (change-detection state and indexing work ' +
      'queue, keyed by account_id). Content never lives here — only ' +
      'pointers and status — so this is not a hole in the per-account ' +
      'isolation model. DDL is shared with initSchema via BRAIN_TABLES_DDL ' +
      'so the two cannot drift.',
    up: (db) => {
      db.exec(BRAIN_TABLES_DDL);
    },
  },
  {
    version: 19,
    description:
      'Record what each Brain indexing run cost. Every run already pays for a '
      + '`claude -p --output-format json` call whose envelope carries '
      + '`total_cost_usd` and a usage breakdown; the runner parsed out the '
      + 'reply and discarded the rest, so the Brain could spend without ever '
      + 'being able to say what it spent. Columns are nullable: NULL means '
      + 'nothing has been spent on that item, which is not the same as a run '
      + 'that cost zero.',
    up: (db) => {
      const cols = db.pragma('table_info(brain_sources)') as { name: string }[];
      const add = (name: string, type: string): void => {
        if (!cols.some((c) => c.name === name)) {
          db.exec(`ALTER TABLE brain_sources ADD COLUMN ${name} ${type}`);
        }
      };
      add('cost_usd', 'REAL');
      add('input_tokens', 'INTEGER');
      add('output_tokens', 'INTEGER');
      add('cache_read_tokens', 'INTEGER');
      add('cache_creation_tokens', 'INTEGER');
    },
  },
  {
    version: 22,
    description:
      'Split main-loop and subagent spend into separate session_cost_daily '
      + 'rows, and persist the component cost breakdown. The breakdown was '
      + 'already computed on every ingest (SessionCostSnapshot.breakdown) and '
      + 'thrown away, which is why "what share of spend is re-sent context?" '
      + 'could not be answered without a re-scan. It is STORED rather than '
      + 'recomputed at query time because cost_usd is priced with the rates in '
      + 'force on the row date: a query-time split from tokens x current rates '
      + 'would stop summing to the stored whole the moment a price changed, '
      + 'and would disagree silently. is_subagent joins the primary key rather '
      + 'than arriving as a pair of subagent_* columns, so that every metric '
      + 'splits (tokens, requests, cache ratios) for one column instead of '
      + 'eight. SQLite cannot widen a primary key in place, so the table is '
      + 'rebuilt. Existing rows keep is_subagent = 0 and zeroed component '
      + 'costs until the next backfill sweep re-reads their transcripts, which '
      + 'happens on the first launch after this ships: scannedSignatures is '
      + 'in-memory and starts empty every process.',
    up: (db) => {
      // The table may be absent on a partial image (the migration tests use them).
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_cost_daily'")
        .get() !== undefined;

      // Drop indexes before the rename, or CREATE INDEX IF NOT EXISTS skips and the new table is left unindexed.
      if (exists) {
        db.exec(`
          DROP INDEX IF EXISTS idx_session_cost_daily_date;
          DROP INDEX IF EXISTS idx_session_cost_daily_account;
          ALTER TABLE session_cost_daily RENAME TO session_cost_daily_old;
        `);
      }

      db.exec(`
        CREATE TABLE session_cost_daily (
          session_id            TEXT NOT NULL,
          date                  TEXT NOT NULL,
          model                 TEXT NOT NULL,
          account_name          TEXT NOT NULL,
          config_dir            TEXT NOT NULL,
          project_path          TEXT,
          is_subagent           INTEGER NOT NULL DEFAULT 0,
          request_count         INTEGER NOT NULL DEFAULT 0,
          input_tokens          INTEGER NOT NULL DEFAULT 0,
          output_tokens         INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
          cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
          input_usd             REAL NOT NULL DEFAULT 0,
          output_usd            REAL NOT NULL DEFAULT 0,
          cache_read_usd        REAL NOT NULL DEFAULT 0,
          cache_write_usd       REAL NOT NULL DEFAULT 0,
          cost_usd              REAL NOT NULL,
          is_estimated          INTEGER NOT NULL DEFAULT 0,
          updated_at            TEXT NOT NULL,
          PRIMARY KEY (session_id, date, model, is_subagent)
        );
      `);

      if (exists) {
        db.exec(`
          INSERT INTO session_cost_daily (
            session_id, date, model, account_name, config_dir, project_path,
            input_tokens, output_tokens, cache_read_tokens,
            cache_write_5m_tokens, cache_write_1h_tokens,
            cost_usd, is_estimated, updated_at
          )
          SELECT
            session_id, date, model, account_name, config_dir, project_path,
            input_tokens, output_tokens, cache_read_tokens,
            cache_write_5m_tokens, cache_write_1h_tokens,
            cost_usd, is_estimated, updated_at
          FROM session_cost_daily_old;

          DROP TABLE session_cost_daily_old;
        `);
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_session_cost_daily_date ON session_cost_daily(date);
        CREATE INDEX IF NOT EXISTS idx_session_cost_daily_account ON session_cost_daily(account_name, date);
      `);
    },
  },
  {
    version: 23,
    description:
      'Add session_cost_daily.internal_kind: which OmniFex-internal activity '
      + 'paid for a row (session-summarization | brain-index | brain-curation), '
      + 'NULL for a real user session. OmniFex spends on the user account '
      + 'through the CLI for session summaries, Brain indexing and Brain '
      + 'curation; those transcripts used to be deleted the moment the call '
      + 'returned, which raced the cost watcher and left a non-deterministic '
      + 'fraction of that spend in the table. They are retained now, so the '
      + 'rows need to say what they were. Nullable rather than defaulted, so '
      + 'every existing row and every existing query keeps its exact current '
      + 'meaning: NULL is not "unknown", it is "a real session".',
    up: (db) => {
      // The table may be absent on a partial image.
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_cost_daily'")
        .get() !== undefined;
      if (!exists) return;

      // ADD COLUMN throws on a duplicate, and migrations must be re-runnable.
      const has = (db.prepare('PRAGMA table_info(session_cost_daily)').all() as { name: string }[])
        .some((c) => c.name === 'internal_kind');
      if (!has) db.exec('ALTER TABLE session_cost_daily ADD COLUMN internal_kind TEXT');
    },
  },
  {
    version: 24,
    description:
      'Reconcile historical OmniFex-internal spend. Before transcripts were '
      + 'retained, internal runs were deleted the moment the call returned — '
      + 'but the cost watcher sometimes won the race, so session_cost_daily '
      + 'holds a NON-DETERMINISTIC fraction of that spend under the scratch '
      + 'project path. That is not data, it is whatever won a race, so those '
      + 'rows are dropped and replaced from brain_spend, which recorded every '
      + 'indexing and curation run exactly. Component costs are left at zero: '
      + 'the ledger never recorded a breakdown, and splitting the total by a '
      + 'guess would put invented numbers in the component panel. Pre-change '
      + 'SESSION SUMMARIZATION spend is not recoverable — those transcripts '
      + 'are gone and nothing else recorded them — and no figure is invented '
      + 'for it.',
    up: (db) => {
      const has = (name: string): boolean =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
      if (!has('session_cost_daily')) return;

      // Deleted, not kept: alongside the ledger it would double-count.
      db.prepare("DELETE FROM session_cost_daily WHERE project_path LIKE '%omnifex-summary-scratch%'").run();

      if (!has('brain_spend')) return;

      // Deterministic ids, so a re-run replaces rather than doubles.
      db.prepare("DELETE FROM session_cost_daily WHERE session_id LIKE 'brain-spend-%'").run();

      db.exec(`
        INSERT INTO session_cost_daily (
          session_id, date, model, account_name, config_dir, project_path,
          is_subagent, request_count,
          input_tokens, output_tokens, cache_read_tokens,
          cache_write_5m_tokens, cache_write_1h_tokens,
          input_usd, output_usd, cache_read_usd, cache_write_usd,
          cost_usd, is_estimated, updated_at, internal_kind
        )
        SELECT
          'brain-spend-' || id,
          date,
          model,
          account_name,
          '',
          CASE kind
            WHEN 'index' THEN 'OmniFex/Brain index'
            WHEN 'curation' THEN 'OmniFex/Brain curation'
          END,
          0,
          1,
          COALESCE(input_tokens, 0),
          COALESCE(output_tokens, 0),
          COALESCE(cache_read_tokens, 0),
          0,
          -- The Brain's calls use 1h cache writes; recording them in the 5m
          -- column would misprice any future recomputation from tokens.
          COALESCE(cache_creation_tokens, 0),
          0, 0, 0, 0,
          cost_usd,
          0,
          datetime('now'),
          CASE kind
            WHEN 'index' THEN 'brain-index'
            WHEN 'curation' THEN 'brain-curation'
          END
        FROM brain_spend
        WHERE kind IN ('index', 'curation')
      `);
    },
  },
  {
    version: 25,
    description:
      'Move model pricing out of code and into a user-editable table. Rates '
      + 'lived only in src/lib/pricing.ts, so a model Anthropic shipped after '
      + 'a given build could not be priced without cutting a release — Fable '
      + '5.1 arrived in CLI 2.1.257 with a cache-read rate no formula '
      + 'predicted and was mispriced 4x until one did. The table is a DELTA '
      + 'layer, not a seeded copy: the shipped constants stay the base so '
      + 'released corrections keep landing, and rows hold only what the user '
      + 'says differs. Folds the legacy `pricing_overrides` JSON blob in and '
      + 'clears it, so there is one source of truth rather than two that '
      + 'disagree the moment either is edited.',
    up: (db) => {
      db.exec(MODEL_PRICING_DDL);

      // The table may be absent on a partial image.
      const hasSettings = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings'")
        .get() !== undefined;
      if (!hasSettings) return;

      const blob = db
        .prepare("SELECT value FROM app_settings WHERE key = 'pricing_overrides'")
        .get() as { value: string } | undefined;
      if (!blob?.value?.trim()) return;

      // Scoped reader: a value that never applied must not start applying.
      const parsed = parseLegacyPricingOverrides(blob.value);
      if (!parsed || parsed.length === 0) return;

      // Columns spelled out, never derived from PRICING_FIELDS: a migration describes its own version's schema forever.
      const ins = db.prepare(
        `INSERT OR REPLACE INTO model_pricing (
           pattern, effective_from,
           input_per_m, output_per_m, fast_input_per_m, fast_output_per_m,
           cache_read_per_m, cache_write_5m_per_m, cache_write_1h_per_m,
           label, color_slot
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of parsed) {
        ins.run(
          r.pattern,
          r.effectiveFrom,
          r.inputPerM ?? null,
          r.outputPerM ?? null,
          r.fastInputPerM ?? null,
          r.fastOutputPerM ?? null,
          r.cacheReadPerM ?? null,
          r.cacheWrite5mPerM ?? null,
          r.cacheWrite1hPerM ?? null,
          r.label ?? null,
          null,
        );
      }

      db.prepare("DELETE FROM app_settings WHERE key = 'pricing_overrides'").run();
    },
  },
  {
    version: 26,
    description:
      'Give model rows a native context window. The context gauge sized '
      + 'itself from a "[1m]" suffix before live usage arrived, so every '
      + 'natively-1M model (Opus 4.7+, Sonnet 5, Fable) read as 200k on '
      + 'resume. The window is now data on the model row, shipped in '
      + 'pricing.ts and overridable here.',
    up: (db) => {
      const cols = (db.prepare('PRAGMA table_info(model_pricing)').all() as { name: string }[])
        .map((c) => c.name);
      if (cols.length > 0 && !cols.includes('context_window')) {
        db.exec('ALTER TABLE model_pricing ADD COLUMN context_window INTEGER');
      }
    },
  },
  {
    version: 27,
    description:
      'Drop thinkingConfig from account session defaults. The Thinking '
      + 'picker was removed in v0.4.70 and the setting itself is gone; the '
      + 'CLI now refuses thinking-off on Fable 5, Fable 5.1 and Opus 5.5 '
      + 'anyway. Stripped here once so nothing has to ignore it on read.',
    up: (db) => {
      const cols = (db.prepare('PRAGMA table_info(accounts)').all() as { name: string }[])
        .map((c) => c.name);
      if (!cols.includes('session_defaults')) return;
      const rows = db
        .prepare("SELECT id, session_defaults FROM accounts WHERE session_defaults LIKE '%thinkingConfig%'")
        .all() as { id: number; session_defaults: string }[];
      const update = db.prepare('UPDATE accounts SET session_defaults = ? WHERE id = ?');
      for (const row of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.session_defaults);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== 'object') continue;
        const { thinkingConfig: _dropped, ...rest } = parsed as Record<string, unknown>;
        update.run(JSON.stringify(rest), row.id);
      }
    },
  },
  {
    version: 28,
    description:
      'Add cli_process_usage: the CLI\'s own running per-model token totals '
      + 'for each CLI process, a baseline and the latest figure. The '
      + 'transcript-derived cost table cannot see forks the CLI runs with '
      + 'skipTranscript (side questions, title generation), but the CLI counts '
      + 'them; the difference is priced into cli-unlogged-<session> rows. '
      + 'Shared with initSchema via CLI_PROCESS_USAGE_DDL so the two cannot '
      + 'drift.',
    up: (db) => {
      db.exec(CLI_PROCESS_USAGE_DDL);
    },
  },
  {
    version: 29,
    description:
      'Delete the two-threshold auto-scroll settings (autoscroll_reengage_px, '
      + 'autoscroll_disengage_px). The chat now follows on one distance, '
      + 'autoscroll_follow_px; nothing reads the old pair.',
    up: (db) => {
      const hasTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'")
        .get();
      if (!hasTable) return;
      db.prepare(
        "DELETE FROM app_settings WHERE key IN ('autoscroll_reengage_px', 'autoscroll_disengage_px')",
      ).run();
    },
  },
  {
    version: 30,
    description:
      'Undo v24\'s ledger backfill. v24 assumed the Brain\'s scratch '
      + 'transcripts had been deleted and replaced their cost rows with '
      + 'brain-spend-* rows from the ledger. They had not been: the runner '
      + 'cleaned up the unresolved /var tmpdir path while the CLI wrote under '
      + '/private/var, so every transcript survived and the cost watcher '
      + 'priced it again — Aug 13-26 counted each Brain run twice. The '
      + 'transcript rows are the finer record (per model, per component), so '
      + 'the ledger rows go.',
    up: (db) => {
      const hasTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_cost_daily'")
        .get();
      if (!hasTable) return;
      db.prepare("DELETE FROM session_cost_daily WHERE session_id LIKE 'brain-spend-%'").run();
    },
  },
  {
    version: 31,
    description:
      'Drop model_pricing.color_slot. The Cost Report colors a model by its '
      + 'price tier and version (costChartPalette.ts), so a per-row palette '
      + 'index has nothing left to drive; no user row ever set one. The '
      + 'column stays in MODEL_PRICING_DDL, which v25 runs as the schema of '
      + 'its own day, and goes here.',
    up: (db) => {
      const cols = db.pragma('table_info(model_pricing)') as { name: string }[];
      if (cols.some((c) => c.name === 'color_slot')) {
        db.exec('ALTER TABLE model_pricing DROP COLUMN color_slot');
      }
    },
  },
  {
    version: 32,
    description:
      'Multi-repo git widget: per-project scan depth and watched sub-repos, '
      + 'and branch colors keyed by repo (its main checkout) in a new '
      + 'repo_branch_colors table. Additive on purpose: an older installed '
      + 'daemon shares this database with a dev build and prepares '
      + '`branch_colors.project_path` at start-up, so that table stays as it '
      + 'is until a later migration drops it. Rows keyed by a linked worktree '
      + 'fold into the main checkout; the main checkout wins a clash.',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_git_settings (
          project_path TEXT PRIMARY KEY,
          scan_depth INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS project_git_repos (
          project_path TEXT NOT NULL,
          repo_path TEXT NOT NULL,
          watched INTEGER NOT NULL,
          PRIMARY KEY (project_path, repo_path)
        );
        CREATE TABLE IF NOT EXISTS repo_branch_colors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_path TEXT NOT NULL,
          branch_name TEXT NOT NULL,
          color TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          UNIQUE(repo_path, branch_name)
        );
        CREATE INDEX IF NOT EXISTS idx_repo_branch_colors_repo ON repo_branch_colors(repo_path);
      `);
      const cols = db.pragma('table_info(branch_colors)') as { name: string }[];
      if (!cols.some((c) => c.name === 'project_path')) return;
      const rows = db.prepare(
        'SELECT project_path, branch_name, color, sort_order, created_at FROM branch_colors ORDER BY id',
      ).all() as { project_path: string; branch_name: string; color: string; sort_order: number; created_at: number }[];
      const keyed = rows.map((r) => {
        const id = repoIdentity(r.project_path);
        return { ...r, repo_path: id ?? r.project_path, direct: !id || id === r.project_path };
      });
      // Main-checkout rows first, so INSERT OR IGNORE lets them win.
      keyed.sort((a, b) => Number(b.direct) - Number(a.direct));
      const ins = db.prepare(
        `INSERT OR IGNORE INTO repo_branch_colors (repo_path, branch_name, color, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const r of keyed) ins.run(r.repo_path, r.branch_name, r.color, r.sort_order, r.created_at);
    },
  },
  {
    version: 33,
    description:
      'Repo aliases: a short display name per repo (its main checkout), shown '
      + 'on the git bar in place of the folder name.',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS repo_aliases (
          repo_path TEXT PRIMARY KEY,
          alias TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 34,
    description:
      'Session metadata cache: per transcript, the titles and first/last '
      + 'timestamps the sessions page shows, with the size, mtime and byte '
      + 'offset they were read at — so a daemon restart re-reads only the '
      + 'transcripts that changed. Derived and disposable.',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_metadata_cache (
          file_path TEXT PRIMARY KEY,
          size INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
          read_offset INTEGER NOT NULL,
          ai_title TEXT,
          custom_title TEXT,
          first_timestamp TEXT,
          last_timestamp TEXT
        );
      `);
    },
  },
  {
    version: 35,
    description:
      'Cost scan signatures: per transcript, the signature (pricing, file '
      + 'sizes and mtimes, CLI usage figures) the cost backfill last priced '
      + 'it at — so a daemon restart re-reads only the transcripts that '
      + 'changed. Derived and disposable.',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS cost_scan_signatures (
          file_path TEXT PRIMARY KEY,
          signature TEXT NOT NULL
        );
      `);
    },
  },
];

export function runMigrations(
  db: BetterSqlite3.Database,
  opts: { migrationsOverride?: Migration[]; homeDir?: string } = {},
): void {
  const migrationsToRun = opts.migrationsOverride ?? migrations;
  const migrationOpts: MigrationOptions = { homeDir: opts.homeDir };

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
      migration.up(db, migrationOpts);
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
  // Must precede journal_mode: once WAL writes the header, auto_vacuum changes only via a full VACUUM.
  // INCREMENTAL, not FULL: FULL compacts on every commit.
  raw.pragma('auto_vacuum = INCREMENTAL');
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  // Two daemons (real and dev) share this file; without a timeout a second writer gets SQLITE_BUSY instantly.
  raw.pragma('busy_timeout = 5000');

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

    reclaimFreePages(): number {
      const pageSize = (raw.pragma('page_size', { simple: true }) as number) || 0;
      const before = (raw.pragma('freelist_count', { simple: true }) as number) || 0;
      if (before === 0) return 0;

      raw.pragma('incremental_vacuum');
      // In WAL mode the main file keeps its size until checkpointed and truncated.
      raw.pragma('wal_checkpoint(TRUNCATE)');

      const after = (raw.pragma('freelist_count', { simple: true }) as number) || 0;
      return Math.max(0, before - after) * pageSize;
    },

    close(): void {
      raw.close();
    },
  };
}

/** An empty string counts as user-set; only missing keys are filled. */
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

    -- Canonical shape matches the post-migration-v11 schema so fresh installs
    -- end up identical to an upgraded DB (the v1/v2/v4/v5/v7/v8/v11 account
    -- migrations all detect the already-correct shape and no-op). Notably:
    --   * subscription_label (not the legacy account_type — v11 renamed it)
    --   * engine + has_cost (added by v11)
    --   * no is_default column (there is no "default" account; v8 dropped it).
    --     Resolution is strictly path rule / project override, failure surfaced
    --     as NoAccountError.
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      config_dir TEXT NOT NULL,
      subscription_label TEXT NOT NULL DEFAULT '',
      engine TEXT NOT NULL DEFAULT 'claude',
      has_cost INTEGER NOT NULL DEFAULT 1,
      color TEXT,
      icon TEXT,
      claude_binary TEXT,
      session_defaults TEXT,
      cli_path TEXT,
      summarizeOnClose INTEGER NOT NULL DEFAULT 0,
      summaryModel TEXT,
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

    -- Canonical post-v11 shape: composite (project_path, engine) key so a
    -- project can carry one override per engine. Fresh installs skip v11's
    -- override rebuild (it detects the engine column already present).
    CREATE TABLE IF NOT EXISTS project_account_overrides (
      project_path TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'claude',
      account_id INTEGER NOT NULL,
      PRIMARY KEY (project_path, engine),
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

  db.exec(MODEL_PRICING_DDL);

  db.exec(BRAIN_TABLES_DDL);
  db.exec(BRAIN_SPEND_DDL);
  db.exec(CLI_PROCESS_USAGE_DDL);
}
