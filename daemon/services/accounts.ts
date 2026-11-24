import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from './database';
import { discoverConfigDirs, nameFromConfigDir } from './first-run-discovery';
import { encodeProjectId } from './project-paths';

export type AccountEngine = 'claude' | 'codex';

export interface SessionDefaults {
  model?: string;
  permissionMode?: string;
  effort?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface Account {
  id: number;
  name: string;
  config_dir: string;
  // Immutable after create.
  engine: AccountEngine;
  // No is_default: there is no default account.
  subscription_label: string;
  has_cost: boolean;
  color: string | null;
  icon: string | null;
  session_defaults?: SessionDefaults;
  cli_path: string | null;
  /** Null means "don't check": verification is skipped with no I/O. */
  expected_email: string | null;
  created_at: string;
  updated_at: string;
  summarizeOnClose?: boolean;
  summaryModel?: string | null;
}

export interface CreateAccountOptions {
  name: string;
  configDir: string;
  engine?: AccountEngine;
  subscriptionLabel?: string;
  hasCost?: boolean;
  color?: string;
  icon?: string;
  sessionDefaults?: SessionDefaults;
  cliPath?: string | null;
  expectedEmail?: string | null;
}

export interface UpdateAccountOptions {
  name: string;
  configDir: string;
  // engine omitted: immutable after create.
  subscriptionLabel?: string;
  hasCost?: boolean;
  color?: string;
  icon?: string;
  sessionDefaults?: SessionDefaults | null;
  cliPath?: string | null;
  /** undefined preserves the current value, null clears it, string sets it. */
  expectedEmail?: string | null;
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
  match_type: ResolveMatchType;
  match_detail: string | null;
}

/** `on_disk` is evidence, not a default: the project dir exists under exactly one account. */
export type ResolveMatchType = 'override' | 'path_rule' | 'on_disk';

export interface ResolveSlot {
  account: Account;
  matchType: ResolveMatchType;
  matchDetail: string;
}

/** An all-null pair is an error, never a default-account fallback. */
export interface ResolvePair {
  claude: ResolveSlot | null;
  codex: ResolveSlot | null;
}

export interface AccountsService {
  listAccounts(): Account[];
  /** Reverse lookup only; never part of resolution. */
  getAccountByConfigDir(configDir: string): Account | null;
  createAccount(opts: CreateAccountOptions): Account;
  updateAccount(id: number, opts: UpdateAccountOptions): void;
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
  explainResolution(projectPath: string, engine?: AccountEngine): ResolutionExplanation | null;

  discoverAccounts(): Promise<DiscoveredConfigDirTuple[]>;
  scanForNewAccounts(): Promise<Account[]>;
}

export interface DiscoveredConfigDirTuple {
  dirName: string;
  configDir: string;
  engine: AccountEngine;
}

interface AccountRow {
  id: number;
  name: string;
  config_dir: string;
  engine: AccountEngine;
  subscription_label: string;
  has_cost: number;
  color: string | null;
  icon: string | null;
  session_defaults: string | null;
  cli_path: string | null;
  expected_email: string | null;
  created_at: string;
  updated_at: string;
  summarizeOnClose: number;
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
      ? (JSON.parse(row.session_defaults) as SessionDefaults)
      : undefined,
    cli_path: row.cli_path,
    expected_email: row.expected_email ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    summarizeOnClose: row.summarizeOnClose !== 0,
    summaryModel: row.summaryModel,
  };
}

function normalizePath(p: string): string {
  let expanded = p;
  if (p.startsWith('~/') || p === '~') {
    expanded = path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(expanded);
}

function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface AccountsServiceDeps {
  existsSync?: (p: string) => boolean;
}

export function createAccountsService(
  db: Database,
  deps: AccountsServiceDeps = {},
): AccountsService {
  const raw = db.raw;
  const existsSync = deps.existsSync ?? fs.existsSync;

  function listAccounts(): Account[] {
    const rows = raw
      .prepare('SELECT * FROM accounts ORDER BY name')
      .all() as AccountRow[];
    return rows.map(rowToAccount);
  }

  function getAccountByConfigDir(configDir: string): Account | null {
    if (!configDir) return null;
    const target = normalizePath(configDir);
    const rows = raw.prepare('SELECT * FROM accounts').all() as AccountRow[];
    const match = rows.find((r) => normalizePath(r.config_dir) === target);
    return match ? rowToAccount(match) : null;
  }

  function createAccount(opts: CreateAccountOptions): Account {
    const info = raw
      .prepare(
        `INSERT INTO accounts
           (name, config_dir, engine, subscription_label, has_cost, color, icon, session_defaults, cli_path, expected_email)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        opts.expectedEmail ?? null,
      );

    const row = raw
      .prepare('SELECT * FROM accounts WHERE id = ?')
      .get(info.lastInsertRowid) as AccountRow;

    return rowToAccount(row);
  }

  function updateAccount(id: number, opts: UpdateAccountOptions): void {
    const hasCostValue =
      opts.hasCost === undefined ? null : opts.hasCost ? 1 : 0;

    // COALESCE can't tell "clear" from "preserve" (both arrive as NULL); the flag column does.
    const setExpectedEmail = opts.expectedEmail === undefined ? 0 : 1;
    const expectedEmailValue = opts.expectedEmail ?? null;

    if (opts.sessionDefaults !== undefined) {
      raw
        .prepare(
          `UPDATE accounts
           SET name = ?, config_dir = ?,
               subscription_label = COALESCE(?, subscription_label),
               has_cost = COALESCE(?, has_cost),
               color = ?, icon = ?, session_defaults = ?, cli_path = ?,
               expected_email = CASE WHEN ? = 1 THEN ? ELSE expected_email END,
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
          setExpectedEmail,
          expectedEmailValue,
          id,
        );
    } else {
      raw
        .prepare(
          `UPDATE accounts
           SET name = ?, config_dir = ?,
               subscription_label = COALESCE(?, subscription_label),
               has_cost = COALESCE(?, has_cost),
               color = ?, icon = ?, cli_path = ?,
               expected_email = CASE WHEN ? = 1 THEN ? ELSE expected_email END,
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
          opts.cliPath ?? null,
          setExpectedEmail,
          expectedEmailValue,
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

  function listPathRules(): PathRule[] {
    return raw
      .prepare(
        `SELECT r.id, r.account_id, a.name AS account_name, a.engine AS account_engine,
                r.path_prefix, r.priority
         FROM account_path_rules r
         JOIN accounts a ON a.id = r.account_id
         ORDER BY LENGTH(r.path_prefix) DESC, r.priority DESC`,
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

  function setProjectOverride(projectPath: string, accountId: number): void {
    const acct = raw
      .prepare('SELECT engine FROM accounts WHERE id = ?')
      .get(accountId) as { engine: AccountEngine } | undefined;
    if (!acct) throw new Error(`Account ${accountId} not found`);
    // Normalize before storing: resolve() looks up the normalized path, so any other form never matches.
    raw
      .prepare(
        `INSERT INTO project_account_overrides (project_path, engine, account_id) VALUES (?, ?, ?)
         ON CONFLICT(project_path, engine) DO UPDATE SET account_id = excluded.account_id`,
      )
      .run(normalizePath(projectPath), acct.engine, accountId);
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

    // 2. Path rules, only for slots not filled by an override.
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

    // 3. On-disk ownership, Claude slot only.
    result.claude ??= resolveOnDisk(normalizedProject);

    return result;
  }

  /**
   * Not a default: fires only when the dir exists under exactly one account, and never invents `~/.claude`.
   * Claude-only: Codex reads a single `~/.codex` with no per-account `projects/` layout.
   */
  function resolveOnDisk(normalizedProject: string): ResolveSlot | null {
    const encoded = encodeProjectId(normalizedProject);

    const claudeAccounts = (
      raw.prepare('SELECT * FROM accounts').all() as AccountRow[]
    ).filter((row) => (row.engine === 'codex' ? 'codex' : 'claude') === 'claude');

    const owners = claudeAccounts.filter((row) =>
      existsSync(path.join(normalizePath(row.config_dir), 'projects', encoded)),
    );

    // More than one owner is ambiguous: null, so the picker asks.
    if (owners.length !== 1) return null;

    return {
      account: rowToAccount(owners[0]),
      matchType: 'on_disk',
      matchDetail: owners[0].config_dir,
    };
  }

  function explainResolution(
    projectPath: string,
    engine?: AccountEngine,
  ): ResolutionExplanation | null {
    // Per engine: a Claude session on a path that also matches a Codex rule must not show the Codex account.
    if (engine) {
      const slot = resolve(projectPath)[engine];
      if (!slot) return null;
      return {
        account: slot.account,
        match_type: slot.matchType,
        match_detail: slot.matchDetail,
      };
    }

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

  return {
    listAccounts,
    getAccountByConfigDir,
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
