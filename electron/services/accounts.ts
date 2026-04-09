import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Database } from './database';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface Account {
  id: number;
  name: string;
  config_dir: string;
  is_default: boolean;
  account_type: string;
  claude_binary: string | null;
  created_at: string;
  updated_at: string;
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
  match_type: 'override' | 'path_rule' | 'default';
  match_detail: string | null;
}

export interface AccountsService {
  listAccounts(): Account[];
  createAccount(
    name: string,
    configDir: string,
    isDefault: boolean,
    accountType?: string,
  ): Account;
  updateAccount(
    id: number,
    name: string,
    configDir: string,
    accountType?: string,
  ): void;
  deleteAccount(id: number): void;
  setDefaultAccount(id: number): void;

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
  is_default: number; // SQLite stores 0/1
  account_type: string;
  claude_binary: string | null;
  created_at: string;
  updated_at: string;
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

function rowToAccount(row: AccountRow): Account {
  return {
    ...row,
    is_default: row.is_default !== 0,
  };
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
    isDefault: boolean,
    accountType = 'pro',
  ): Account {
    if (isDefault) {
      raw.prepare('UPDATE accounts SET is_default = 0').run();
    }

    const info = raw
      .prepare(
        `INSERT INTO accounts (name, config_dir, is_default, account_type)
         VALUES (?, ?, ?, ?)`,
      )
      .run(name, configDir, isDefault ? 1 : 0, accountType);

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
  ): void {
    if (accountType !== undefined) {
      raw
        .prepare(
          `UPDATE accounts
           SET name = ?, config_dir = ?, account_type = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .run(name, configDir, accountType, id);
    } else {
      raw
        .prepare(
          `UPDATE accounts
           SET name = ?, config_dir = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .run(name, configDir, id);
    }
  }

  function deleteAccount(id: number): void {
    raw.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  }

  function setDefaultAccount(id: number): void {
    raw.prepare('UPDATE accounts SET is_default = 0').run();
    raw
      .prepare(
        'UPDATE accounts SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      )
      .run(id);
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
    // 1. Explicit project override
    const overrideRow = raw
      .prepare(
        `SELECT a.* FROM project_account_overrides o
         JOIN accounts a ON a.id = o.account_id
         WHERE o.project_path = ?`,
      )
      .get(projectPath) as AccountRow | undefined;

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
      if (
        projectPath === rule.path_prefix ||
        projectPath.startsWith(rule.path_prefix + '/')
      ) {
        return rowToAccount(rule);
      }
    }

    // 3. Default account
    const defaultRow = raw
      .prepare('SELECT * FROM accounts WHERE is_default = 1 LIMIT 1')
      .get() as AccountRow | undefined;

    if (defaultRow) {
      return rowToAccount(defaultRow);
    }

    // 4. No match
    return null;
  }

  // -------------------------------------------------------------------------
  // Explain resolution
  // -------------------------------------------------------------------------

  function explainResolution(projectPath: string): ResolutionExplanation | null {
    // 1. Explicit override
    const overrideRow = raw
      .prepare(
        `SELECT a.* FROM project_account_overrides o
         JOIN accounts a ON a.id = o.account_id
         WHERE o.project_path = ?`,
      )
      .get(projectPath) as AccountRow | undefined;

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
      if (
        projectPath === rule.path_prefix ||
        projectPath.startsWith(rule.path_prefix + '/')
      ) {
        return {
          account: rowToAccount(rule),
          match_type: 'path_rule',
          match_detail: rule.path_prefix,
        };
      }
    }

    // 3. Default account
    const defaultRow = raw
      .prepare('SELECT * FROM accounts WHERE is_default = 1 LIMIT 1')
      .get() as AccountRow | undefined;

    if (defaultRow) {
      return {
        account: rowToAccount(defaultRow),
        match_type: 'default',
        match_detail: null,
      };
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
    deleteAccount,
    setDefaultAccount,
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
