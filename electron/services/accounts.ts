import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Database } from './database';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

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
  // No is_default field. There is no "default" account — resolution is
  // strictly via path rules and explicit project overrides. See migration
  // v8 in database.ts and CLAUDE.md "Multi-Account Rules".
  account_type: string;
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

export interface PathRule {
  id: number;
  account_id: number;
  account_name: string;
  path_prefix: string;
  priority: number;
}

export interface ProjectOverride {
  project_path: string;
  account_id: number;
  account_name: string;
}

export interface ResolutionExplanation {
  account: Account;
  match_type: 'override' | 'path_rule';
  match_detail: string | null;
}

export interface AccountsService {
  listAccounts(): Account[];
  /**
   * Create an account row. There is no isDefault parameter — accounts have no
   * default-account flag. Callers that previously passed `true`/`false` as the
   * third positional arg must drop it (migration v8 also drops the column).
   */
  createAccount(
    name: string,
    configDir: string,
    accountType?: string,
    color?: string,
    icon?: string,
    sessionDefaults?: SessionDefaults,
    cliPath?: string | null,
  ): Account;
  updateAccount(
    id: number,
    name: string,
    configDir: string,
    accountType?: string,
    color?: string,
    icon?: string,
    sessionDefaults?: SessionDefaults | null,
    cliPath?: string | null,
  ): void;
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

  resolve(projectPath: string): Account | null;
  setProjectOverride(projectPath: string, accountId: number): void;
  listProjectOverrides(): ProjectOverride[];
  explainResolution(projectPath: string): ResolutionExplanation | null;

  discoverAccounts(): Promise<[string, string][]>;
}

// ---------------------------------------------------------------------------
// Row types returned from SQLite
// ---------------------------------------------------------------------------

interface AccountRow {
  id: number;
  name: string;
  config_dir: string;
  account_type: string;
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
  const out: SessionDefaults = { ...obj } as SessionDefaults;
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
    account_type: row.account_type,
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

  // -------------------------------------------------------------------------
  // Prepared statements (lazy init pattern — prepare once, reuse)
  // -------------------------------------------------------------------------

  function listAccounts(): Account[] {
    const rows = raw
      .prepare('SELECT * FROM accounts ORDER BY name')
      .all() as AccountRow[];
    return rows.map(rowToAccount);
  }

  function createAccount(
    name: string,
    configDir: string,
    accountType = 'pro',
    color?: string,
    icon?: string,
    sessionDefaults?: SessionDefaults,
    cliPath?: string | null,
  ): Account {
    const info = raw
      .prepare(
        `INSERT INTO accounts (name, config_dir, account_type, color, icon, session_defaults, cli_path)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        configDir,
        accountType,
        color ?? null,
        icon ?? null,
        sessionDefaults ? JSON.stringify(sessionDefaults) : null,
        cliPath ?? null,
      );

    const row = raw
      .prepare('SELECT * FROM accounts WHERE id = ?')
      .get(info.lastInsertRowid) as AccountRow;

    return rowToAccount(row);
  }

  function updateAccount(
    id: number,
    name: string,
    configDir: string,
    accountType?: string,
    color?: string,
    icon?: string,
    sessionDefaults?: SessionDefaults | null,
    cliPath?: string | null,
  ): void {
    if (sessionDefaults !== undefined) {
      raw
        .prepare(
          `UPDATE accounts
           SET name = ?, config_dir = ?, account_type = COALESCE(?, account_type),
               color = ?, icon = ?, session_defaults = ?, cli_path = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .run(
          name,
          configDir,
          accountType ?? null,
          color ?? null,
          icon ?? null,
          sessionDefaults !== null ? JSON.stringify(sessionDefaults) : null,
          cliPath ?? null,
          id,
        );
    } else {
      raw
        .prepare(
          `UPDATE accounts
           SET name = ?, config_dir = ?, account_type = COALESCE(?, account_type),
               color = ?, icon = ?, cli_path = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .run(
          name,
          configDir,
          accountType ?? null,
          color ?? null,
          icon ?? null,
          cliPath ?? null,
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
        `SELECT r.id, r.account_id, a.name AS account_name, r.path_prefix, r.priority
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
        `SELECT r.id, r.account_id, a.name AS account_name, r.path_prefix, r.priority
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
    raw
      .prepare(
        `INSERT INTO project_account_overrides (project_path, account_id) VALUES (?, ?)
         ON CONFLICT(project_path) DO UPDATE SET account_id = excluded.account_id`,
      )
      .run(projectPath, accountId);
  }

  function listProjectOverrides(): ProjectOverride[] {
    return raw
      .prepare(
        `SELECT o.project_path, o.account_id, a.name AS account_name
         FROM project_account_overrides o
         JOIN accounts a ON a.id = o.account_id
         ORDER BY o.project_path`,
      )
      .all() as ProjectOverride[];
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  function resolve(projectPath: string): Account | null {
    const normalizedProject = normalizePath(projectPath);

    // 1. Explicit project override
    const overrideRow = raw
      .prepare(
        `SELECT a.* FROM project_account_overrides o
         JOIN accounts a ON a.id = o.account_id
         WHERE o.project_path = ?`,
      )
      .get(normalizedProject) as AccountRow | undefined;

    if (overrideRow) {
      return rowToAccount(overrideRow);
    }

    // 2. Longest matching path rule (LENGTH(path_prefix) DESC, then priority DESC)
    const rules = raw
      .prepare(
        `SELECT r.path_prefix, a.* FROM account_path_rules r
         JOIN accounts a ON a.id = r.account_id
         ORDER BY LENGTH(r.path_prefix) DESC, r.priority DESC`,
      )
      .all() as (AccountRow & { path_prefix: string })[];

    for (const rule of rules) {
      const normalizedPrefix = normalizePath(rule.path_prefix);
      if (isPathInside(normalizedProject, normalizedPrefix)) {
        return rowToAccount(rule);
      }
    }

    // 3. No match
    return null;
  }

  // -------------------------------------------------------------------------
  // Explain resolution
  // -------------------------------------------------------------------------

  function explainResolution(projectPath: string): ResolutionExplanation | null {
    const normalizedProject = normalizePath(projectPath);

    // 1. Explicit override
    const overrideRow = raw
      .prepare(
        `SELECT a.* FROM project_account_overrides o
         JOIN accounts a ON a.id = o.account_id
         WHERE o.project_path = ?`,
      )
      .get(normalizedProject) as AccountRow | undefined;

    if (overrideRow) {
      return {
        account: rowToAccount(overrideRow),
        match_type: 'override',
        match_detail: projectPath,
      };
    }

    // 2. Longest matching path rule
    const rules = raw
      .prepare(
        `SELECT r.path_prefix, r.priority, a.* FROM account_path_rules r
         JOIN accounts a ON a.id = r.account_id
         ORDER BY LENGTH(r.path_prefix) DESC, r.priority DESC`,
      )
      .all() as (AccountRow & { path_prefix: string; priority: number })[];

    for (const rule of rules) {
      const normalizedPrefix = normalizePath(rule.path_prefix);
      if (isPathInside(normalizedProject, normalizedPrefix)) {
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

  async function discoverAccounts(): Promise<[string, string][]> {
    const home = os.homedir();
    const results: [string, string][] = [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(home, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const name = entry.name;
      if (name !== '.claude' && !name.startsWith('.claude-')) continue;

      const fullPath = path.join(home, name);
      results.push([name, fullPath]);
    }

    return results;
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
  };
}
