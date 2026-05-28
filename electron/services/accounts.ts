import os from 'node:os';
import path from 'node:path';
import type { Database } from './database';
import { discoverConfigDirs, nameFromConfigDir } from './first-run-discovery';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export type AccountEngine = 'claude' | 'codex';

export interface SessionDefaults {
  model?: string;
  thinkingConfig?: 'adaptive' | 'disabled';
  permissionMode?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface Account {
  id: number;
  name: string;
  config_dir: string;
  // Which CLI engine this account drives. Immutable post-create (see spec §3).
  engine: AccountEngine;
  // No is_default field. There is no "default" account — resolution is
  // strictly via path rules and explicit project overrides. See migration
  // v8 in database.ts and CLAUDE.md "Multi-Account Rules".
  //
  // Free-text subscription tier label (e.g. 'Max', 'Pro', 'Plus'). Replaces
  // the old enum-ish `account_type`. `has_cost` decouples billing from the
  // label since 'Max' used to implicitly mean "free".
  subscription_label: string;
  has_cost: boolean;
  color: string | null;
  icon: string | null;
  session_defaults?: SessionDefaults;
  cli_path: string | null;
  created_at: string;
  updated_at: string;
  /** Whether per-session summaries auto-generate on tab close. */
  summarizeOnClose?: boolean;
  /** Model id (e.g. 'claude-haiku-4-5') used for summarization. Null
   *  when toggle is off or no model has been selected. */
  summaryModel?: string | null;
}

export interface CreateAccountOptions {
  name: string;
  configDir: string;
  engine?: AccountEngine; // default 'claude'
  subscriptionLabel?: string; // default ''
  hasCost?: boolean; // default true
  color?: string;
  icon?: string;
  sessionDefaults?: SessionDefaults;
  cliPath?: string | null;
}

export interface UpdateAccountOptions {
  name: string;
  configDir: string;
  // engine intentionally omitted — immutable post-create (see spec §3).
  subscriptionLabel?: string;
  hasCost?: boolean;
  color?: string;
  icon?: string;
  sessionDefaults?: SessionDefaults | null;
  cliPath?: string | null;
}

export interface PathRule {
  id: number;
  account_id: number;
  account_name: string;
  account_engine: AccountEngine;
  path_prefix: string;
  priority: number;
}

export interface ProjectOverride {
  project_path: string;
  engine: AccountEngine;
  account_id: number;
  account_name: string;
}

export interface ResolutionExplanation {
  account: Account;
  match_type: 'override' | 'path_rule';
  match_detail: string | null;
}

/**
 * A single resolved routing target for one engine. `matchType` distinguishes
 * an explicit project override from a path-rule match; `matchDetail` is the
 * project path (override) or the matched prefix (path rule).
 */
export interface ResolveSlot {
  account: Account;
  matchType: 'override' | 'path_rule';
  matchDetail: string;
}

/**
 * Result of resolving a project path. Each engine resolves independently:
 * explicit override → longest-prefix path rule → null. A `null` slot means
 * "no override and no matching path rule for that engine" — callers MUST treat
 * an all-null pair as an error condition, not a default-account fallback.
 */
export interface ResolvePair {
  claude: ResolveSlot | null;
  codex: ResolveSlot | null;
}

export interface AccountsService {
  listAccounts(): Account[];
  createAccount(opts: CreateAccountOptions): Account;
  updateAccount(id: number, opts: UpdateAccountOptions): void;
  /** Update the per-session summarization opt-in for an account. Pass
   *  `summaryModel: null` to clear the model (which also disables the
   *  toggle, since both fields are required for generation). */
  updateSummarySettings(
    id: number,
    summarizeOnClose: boolean,
    summaryModel: string | null,
  ): void;
  deleteAccount(id: number): void;

  listPathRules(): PathRule[];
  addPathRule(accountId: number, pathPrefix: string, priority?: number): PathRule;
  removePathRule(ruleId: number): void;

  resolve(projectPath: string): ResolvePair;
  setProjectOverride(projectPath: string, accountId: number): void;
  listProjectOverrides(): ProjectOverride[];
  explainResolution(projectPath: string): ResolutionExplanation | null;

  discoverAccounts(): Promise<DiscoveredConfigDirTuple[]>;
  /**
   * Scans `$HOME` for `.claude*`/`.codex*` config dirs and creates an Account
   * row for each one not already represented by an existing account's
   * `configDir`. Returns the newly-created accounts. Engine + name are derived
   * from the directory. Resolution semantics are unchanged — no path rules are
   * created. Intended for the Settings escape hatch when a user adds a new
   * config dir after first launch.
   */
  scanForNewAccounts(): Promise<Account[]>;
}

/** Engine-tagged discovery result re-exported for handler/renderer typing. */
export type DiscoveredConfigDirTuple = {
  dirName: string;
  configDir: string;
  engine: AccountEngine;
};

// ---------------------------------------------------------------------------
// Row types returned from SQLite
// ---------------------------------------------------------------------------

interface AccountRow {
  id: number;
  name: string;
  config_dir: string;
  engine: AccountEngine;
  subscription_label: string;
  has_cost: number; // SQLite stores 0/1
  color: string | null;
  icon: string | null;
  session_defaults: string | null;
  cli_path: string | null;
  created_at: string;
  updated_at: string;
  summarizeOnClose: number; // SQLite stores 0/1
  summaryModel: string | null;
}

interface PathRuleRow {
  id: number;
  account_id: number;
  account_name: string;
  account_engine: AccountEngine;
  path_prefix: string;
  priority: number;
}

// ---------------------------------------------------------------------------
// Helper: map a raw SQLite row to the public Account shape
// ---------------------------------------------------------------------------

// The thinking-config schema tightened in v0.4.21 — the legacy
// `'budget'` value is no longer reachable from the picker. Stored
// account rows from before that release may still carry it; coerce to
// `'adaptive'` (which is what the SDK collapsed every non-zero budget
// to anyway) at the deserialize boundary so the renderer never sees an
// out-of-schema value.
function normalizeSessionDefaults(raw: unknown): SessionDefaults | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const out: SessionDefaults = { ...obj };
  if (obj.thinkingConfig === 'budget') {
    out.thinkingConfig = 'adaptive';
  } else if (obj.thinkingConfig !== 'adaptive' && obj.thinkingConfig !== 'disabled') {
    delete out.thinkingConfig;
  }
  return out;
}

function rowToAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    config_dir: row.config_dir,
    engine: row.engine === 'codex' ? 'codex' : 'claude',
    subscription_label: row.subscription_label,
    has_cost: row.has_cost !== 0,
    color: row.color,
    icon: row.icon,
    session_defaults: row.session_defaults
      ? normalizeSessionDefaults(JSON.parse(row.session_defaults))
      : undefined,
    cli_path: row.cli_path,
    created_at: row.created_at,
    updated_at: row.updated_at,
    summarizeOnClose: row.summarizeOnClose !== 0,
    summaryModel: row.summaryModel,
  };
}

// ---------------------------------------------------------------------------
// Helper: normalize paths so ~/foo and /Users/x/foo match.
// Uses path.resolve() to handle relative segments, symlinks, and trailing slashes.
// ---------------------------------------------------------------------------

function normalizePath(p: string): string {
  let expanded = p;
  if (p.startsWith('~/') || p === '~') {
    expanded = path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(expanded);
}

/** True if `child` is `parent` or a descendant of `parent`. */
function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAccountsService(db: Database): AccountsService {
  const raw = db.raw;

  function listAccounts(): Account[] {
    const rows = raw
      .prepare('SELECT * FROM accounts ORDER BY name')
      .all() as AccountRow[];
    return rows.map(rowToAccount);
  }

  function createAccount(opts: CreateAccountOptions): Account {
    const info = raw
      .prepare(
        `INSERT INTO accounts
           (name, config_dir, engine, subscription_label, has_cost, color, icon, session_defaults, cli_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.name,
        opts.configDir,
        opts.engine ?? 'claude',
        opts.subscriptionLabel ?? '',
        (opts.hasCost ?? true) ? 1 : 0,
        opts.color ?? null,
        opts.icon ?? null,
        opts.sessionDefaults ? JSON.stringify(opts.sessionDefaults) : null,
        opts.cliPath ?? null,
      );

    const row = raw
      .prepare('SELECT * FROM accounts WHERE id = ?')
      .get(info.lastInsertRowid) as AccountRow;

    return rowToAccount(row);
  }

  function updateAccount(id: number, opts: UpdateAccountOptions): void {
    // subscription_label / has_cost are preserved when omitted (COALESCE),
    // matching the prior account_type behavior. session_defaults: undefined
    // preserves, null clears, object sets.
    const hasCostValue =
      opts.hasCost === undefined ? null : opts.hasCost ? 1 : 0;

    if (opts.sessionDefaults !== undefined) {
      raw
        .prepare(
          `UPDATE accounts
           SET name = ?, config_dir = ?,
               subscription_label = COALESCE(?, subscription_label),
               has_cost = COALESCE(?, has_cost),
               color = ?, icon = ?, session_defaults = ?, cli_path = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .run(
          opts.name,
          opts.configDir,
          opts.subscriptionLabel ?? null,
          hasCostValue,
          opts.color ?? null,
          opts.icon ?? null,
          opts.sessionDefaults !== null ? JSON.stringify(opts.sessionDefaults) : null,
          opts.cliPath ?? null,
          id,
        );
    } else {
      raw
        .prepare(
          `UPDATE accounts
           SET name = ?, config_dir = ?,
               subscription_label = COALESCE(?, subscription_label),
               has_cost = COALESCE(?, has_cost),
               color = ?, icon = ?, cli_path = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .run(
          opts.name,
          opts.configDir,
          opts.subscriptionLabel ?? null,
          hasCostValue,
          opts.color ?? null,
          opts.icon ?? null,
          opts.cliPath ?? null,
          id,
        );
    }
  }

  function updateSummarySettings(
    id: number,
    summarizeOnClose: boolean,
    summaryModel: string | null,
  ): void {
    raw
      .prepare(
        `UPDATE accounts
         SET summarizeOnClose = ?, summaryModel = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(summarizeOnClose ? 1 : 0, summaryModel, id);
  }

  function deleteAccount(id: number): void {
    raw.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  }

  // -------------------------------------------------------------------------
  // Path rules
  // -------------------------------------------------------------------------

  function listPathRules(): PathRule[] {
    return raw
      .prepare(
        `SELECT r.id, r.account_id, a.name AS account_name, a.engine AS account_engine,
                r.path_prefix, r.priority
         FROM account_path_rules r
         JOIN accounts a ON a.id = r.account_id
         ORDER BY r.priority DESC, LENGTH(r.path_prefix) DESC`,
      )
      .all() as PathRule[];
  }

  function addPathRule(
    accountId: number,
    pathPrefix: string,
    priority = 0,
  ): PathRule {
    const info = raw
      .prepare(
        'INSERT INTO account_path_rules (account_id, path_prefix, priority) VALUES (?, ?, ?)',
      )
      .run(accountId, pathPrefix, priority);

    const row = raw
      .prepare(
        `SELECT r.id, r.account_id, a.name AS account_name, a.engine AS account_engine,
                r.path_prefix, r.priority
         FROM account_path_rules r
         JOIN accounts a ON a.id = r.account_id
         WHERE r.id = ?`,
      )
      .get(info.lastInsertRowid) as PathRuleRow;

    return row;
  }

  function removePathRule(ruleId: number): void {
    raw.prepare('DELETE FROM account_path_rules WHERE id = ?').run(ruleId);
  }

  // -------------------------------------------------------------------------
  // Project overrides
  // -------------------------------------------------------------------------

  function setProjectOverride(projectPath: string, accountId: number): void {
    const acct = raw
      .prepare('SELECT engine FROM accounts WHERE id = ?')
      .get(accountId) as { engine: AccountEngine } | undefined;
    if (!acct) throw new Error(`Account ${accountId} not found`);
    raw
      .prepare(
        `INSERT INTO project_account_overrides (project_path, engine, account_id) VALUES (?, ?, ?)
         ON CONFLICT(project_path, engine) DO UPDATE SET account_id = excluded.account_id`,
      )
      .run(projectPath, acct.engine, accountId);
  }

  function listProjectOverrides(): ProjectOverride[] {
    return raw
      .prepare(
        `SELECT o.project_path, o.engine, o.account_id, a.name AS account_name
         FROM project_account_overrides o
         JOIN accounts a ON a.id = o.account_id
         ORDER BY o.project_path`,
      )
      .all() as ProjectOverride[];
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  function resolve(projectPath: string): ResolvePair {
    const normalizedProject = normalizePath(projectPath);
    const result: ResolvePair = { claude: null, codex: null };

    // 1. Explicit overrides, per engine.
    const overrides = raw
      .prepare(
        `SELECT o.engine AS o_engine, a.* FROM project_account_overrides o
         JOIN accounts a ON a.id = o.account_id
         WHERE o.project_path = ?`,
      )
      .all(normalizedProject) as (AccountRow & { o_engine: AccountEngine })[];
    for (const row of overrides) {
      const slot: ResolveSlot = {
        account: rowToAccount(row),
        matchType: 'override',
        matchDetail: projectPath,
      };
      if (row.o_engine === 'codex') result.codex = slot;
      else result.claude = slot;
    }

    // 2. Path rules per engine — only for slots not already filled by override.
    if (!result.claude || !result.codex) {
      const rules = raw
        .prepare(
          `SELECT r.path_prefix, r.priority, a.* FROM account_path_rules r
           JOIN accounts a ON a.id = r.account_id`,
        )
        .all() as (AccountRow & { path_prefix: string; priority: number })[];

      for (const engine of ['claude', 'codex'] as const) {
        if (result[engine]) continue;
        const match = rules
          .filter((r) => (r.engine === 'codex' ? 'codex' : 'claude') === engine)
          .map((r) => ({ rule: r, prefix: normalizePath(r.path_prefix) }))
          .filter(({ prefix }) => isPathInside(normalizedProject, prefix))
          .sort(
            (a, b) =>
              b.prefix.length - a.prefix.length || b.rule.priority - a.rule.priority,
          )[0];
        if (match) {
          result[engine] = {
            account: rowToAccount(match.rule),
            matchType: 'path_rule',
            matchDetail: match.rule.path_prefix,
          };
        }
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Explain resolution (Claude-centric UI helper; returns the longest-prefix
  // match across engines, preferring an explicit override).
  // -------------------------------------------------------------------------

  function explainResolution(projectPath: string): ResolutionExplanation | null {
    const normalizedProject = normalizePath(projectPath);

    const overrideRow = raw
      .prepare(
        `SELECT a.* FROM project_account_overrides o
         JOIN accounts a ON a.id = o.account_id
         WHERE o.project_path = ?
         ORDER BY o.engine
         LIMIT 1`,
      )
      .get(normalizedProject) as AccountRow | undefined;

    if (overrideRow) {
      return {
        account: rowToAccount(overrideRow),
        match_type: 'override',
        match_detail: projectPath,
      };
    }

    const rules = raw
      .prepare(
        `SELECT r.path_prefix, r.priority, a.* FROM account_path_rules r
         JOIN accounts a ON a.id = r.account_id
         ORDER BY LENGTH(r.path_prefix) DESC, r.priority DESC`,
      )
      .all() as (AccountRow & { path_prefix: string; priority: number })[];

    for (const rule of rules) {
      if (isPathInside(normalizedProject, normalizePath(rule.path_prefix))) {
        return {
          account: rowToAccount(rule),
          match_type: 'path_rule',
          match_detail: rule.path_prefix,
        };
      }
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  async function discoverAccounts(): Promise<DiscoveredConfigDirTuple[]> {
    return discoverConfigDirs(os.homedir());
  }

  async function scanForNewAccounts(): Promise<Account[]> {
    const found = await discoverAccounts();
    if (found.length === 0) return [];

    const existing = new Set(listAccounts().map((a) => a.config_dir));
    const created: Account[] = [];
    for (const { dirName, configDir, engine } of found) {
      if (existing.has(configDir)) continue;
      const acct = createAccount({ name: nameFromConfigDir(dirName, engine), configDir, engine });
      created.push(acct);
    }
    return created;
  }

  // -------------------------------------------------------------------------
  // Return service object
  // -------------------------------------------------------------------------

  return {
    listAccounts,
    createAccount,
    updateAccount,
    updateSummarySettings,
    deleteAccount,
    listPathRules,
    addPathRule,
    removePathRule,
    resolve,
    setProjectOverride,
    listProjectOverrides,
    explainResolution,
    discoverAccounts,
    scanForNewAccounts,
  };
}
