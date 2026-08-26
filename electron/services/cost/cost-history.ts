// Cost module — durable cost history in SQLite.
//
// Rows survive the CLI's transcript pruning (cleanupPeriodDays); the table is
// the source for the Costs view. replaceSession keeps writes idempotent
// (delete-then-insert per session inside one transaction). backfill() walks
// every account config dir's surviving JSONLs — including sessions run
// outside OmniFex — so monthly totals can reconcile against Anthropic's
// console.

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from '../database';
import { parsePricingOverrides } from '../../../src/lib/pricing';
import { computeSessionCost, type SessionCostDailyRow } from './session-cost-core';

export interface CostFs {
  readFile(p: string): string | null;
  listDir(p: string): Array<{ name: string; isDirectory: boolean }>;
  stat(p: string): { mtimeMs: number; size: number } | null;
}

export const nodeCostFs: CostFs = {
  readFile(p: string): string | null {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  listDir(p: string): Array<{ name: string; isDirectory: boolean }> {
    try {
      return fs
        .readdirSync(p, { withFileTypes: true })
        .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch {
      return [];
    }
  },
  stat(p: string): { mtimeMs: number; size: number } | null {
    try {
      const s = fs.statSync(p);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
  },
};

/** Depth cap for the subagents walk. Workflow agents sit at
 *  `subagents/workflows/<wf-id>/agent-*.jsonl` — depth 3 — so 6 leaves room
 *  for another nesting level upstream without letting a symlink loop spin. */
const MAX_SUBAGENT_DEPTH = 6;

/**
 * Every subagent transcript for one session, at any depth under `subagents/`.
 *
 * The CLI writes plain Task subagents flat (`subagents/agent-<id>.jsonl`) but
 * Workflow subagents one directory deeper
 * (`subagents/workflows/wf_<id>/agent-<id>.jsonl`). A non-recursive listing
 * sees only the first kind and silently drops the rest — for 2026-08 on
 * ~/.claude-work that was 16 files and $37.41 of real spend. See
 * docs/superpowers/specs/2026-08-26-cost-report-page-design.md §1.1.
 *
 * Returns absolute paths, sorted, so callers get a stable order for both
 * change-detection signatures and cost aggregation.
 */
export function collectSubagentFiles(fsDeps: CostFs, subagentsDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SUBAGENT_DEPTH) return;
    for (const entry of fsDeps.listDir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory) {
        walk(full, depth + 1);
      } else if (entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')) {
        found.push(full);
      }
    }
  };
  walk(subagentsDir, 0);
  return found.sort();
}

/**
 * Change-detection fragment for a session's subagent transcripts: each file's
 * path-relative name plus size and mtime.
 *
 * Keyed on the path relative to `subagentsDir`, not the basename — two
 * workflows can each hold an `agent-<id>.jsonl`, and a basename-keyed
 * signature would let a newly-created nested file hide behind an unchanged
 * flat one of the same name.
 */
function subagentSignature(fsDeps: CostFs, subagentsDir: string): string {
  return collectSubagentFiles(fsDeps, subagentsDir)
    .map((full) => {
      const s = fsDeps.stat(full);
      return `${path.relative(subagentsDir, full)}:${s?.size ?? 0}:${s?.mtimeMs ?? 0}`;
    })
    .join(',');
}

export interface CostHistoryFilters {
  startDate?: string;
  endDate?: string;
  accountName?: string;
  projectPath?: string;
  model?: string;
}

export interface CostHistoryPeriod {
  period: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  is_estimated: number;
}

export interface CostSessionRow {
  session_id: string;
  account_name: string;
  project_path: string | null;
  first_date: string;
  last_date: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface AccountLike {
  name: string;
  config_dir: string;
}

export interface CostHistoryService {
  replaceSession(sessionId: string, rows: SessionCostDailyRow[]): void;
  aggregate(filters: CostHistoryFilters, groupBy: 'day' | 'week' | 'month'): CostHistoryPeriod[];
  sessions(filters: CostHistoryFilters): CostSessionRow[];
  backfill(accounts: AccountLike[]): { sessionsScanned: number };
}

function whereClause(filters: CostHistoryFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.startDate) { clauses.push('date >= ?'); params.push(filters.startDate); }
  if (filters.endDate) { clauses.push('date <= ?'); params.push(filters.endDate); }
  if (filters.accountName) { clauses.push('account_name = ?'); params.push(filters.accountName); }
  if (filters.projectPath) { clauses.push('project_path = ?'); params.push(filters.projectPath); }
  if (filters.model) { clauses.push('model = ?'); params.push(filters.model); }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

const PERIOD_EXPR: Record<'day' | 'week' | 'month', string> = {
  day: 'date',
  week: "strftime('%Y-W%W', date)",
  month: 'substr(date, 1, 7)',
};

/** Recover the real project path from `cwd` on early JSONL lines; the dir
 *  name's `/`→`-` encoding is lossy. Mirrors usage.ts's recovery approach. */
function recoverProjectPath(content: string, dirName: string): string {
  const lines = content.split('\n', 50);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as { cwd?: unknown };
      if (typeof parsed.cwd === 'string' && parsed.cwd.startsWith('/')) return parsed.cwd;
    } catch {
      continue;
    }
  }
  return dirName.replace(/-/g, '/');
}

/** Change-detection signature for a session's on-disk JSONLs: main file
 *  `size:mtimeMs` plus every subagent transcript at any depth. Mirrors
 *  session-cost.ts's live-watcher signature() so the two stay consistent
 *  about what counts as "the same session content". */
function sessionFileSignature(fsDeps: CostFs, mainPath: string, subagentsDir: string): string {
  const main = fsDeps.stat(mainPath);
  return `${main?.size ?? 0}:${main?.mtimeMs ?? 0}|${subagentSignature(fsDeps, subagentsDir)}`;
}

export function createCostHistoryService(db: Database, fsDeps: CostFs = nodeCostFs): CostHistoryService {
  // Per-service in-memory cache: session file path -> last-scanned signature.
  // Lets the hourly backfill sweep skip sessions whose JSONLs haven't
  // changed since the last pass, instead of re-reading and rewriting every
  // row for every surviving session on every run (unbounded growth under
  // 365-day retention otherwise).
  const scannedSignatures = new Map<string, string>();
  const insertStmt = db.raw.prepare(`
    INSERT INTO session_cost_daily (
      session_id, date, model, account_name, config_dir, project_path,
      input_tokens, output_tokens, cache_read_tokens,
      cache_write_5m_tokens, cache_write_1h_tokens,
      cost_usd, is_estimated, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteStmt = db.raw.prepare('DELETE FROM session_cost_daily WHERE session_id = ?');

  const replaceSession = db.raw.transaction((sessionId: string, rows: SessionCostDailyRow[]) => {
    deleteStmt.run(sessionId);
    const now = new Date().toISOString();
    for (const r of rows) {
      insertStmt.run(
        r.session_id, r.date, r.model, r.account_name, r.config_dir, r.project_path,
        r.input_tokens, r.output_tokens, r.cache_read_tokens,
        r.cache_write_5m_tokens, r.cache_write_1h_tokens,
        r.cost_usd, r.is_estimated, now,
      );
    }
  });

  function aggregate(filters: CostHistoryFilters, groupBy: 'day' | 'week' | 'month'): CostHistoryPeriod[] {
    const { sql, params } = whereClause(filters);
    return db.raw
      .prepare(`
        SELECT ${PERIOD_EXPR[groupBy]} AS period,
               SUM(cost_usd) AS cost_usd,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_5m_tokens + cache_write_1h_tokens) AS cache_write_tokens,
               MAX(is_estimated) AS is_estimated
        FROM session_cost_daily ${sql}
        GROUP BY period ORDER BY period
      `)
      .all(...params) as CostHistoryPeriod[];
  }

  function sessions(filters: CostHistoryFilters): CostSessionRow[] {
    const { sql, params } = whereClause(filters);
    return db.raw
      .prepare(`
        SELECT session_id, account_name, project_path,
               MIN(date) AS first_date, MAX(date) AS last_date,
               SUM(cost_usd) AS cost_usd,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_5m_tokens + cache_write_1h_tokens) AS cache_write_tokens
        FROM session_cost_daily ${sql}
        GROUP BY session_id ORDER BY cost_usd DESC LIMIT 500
      `)
      .all(...params) as CostSessionRow[];
  }

  function backfill(accounts: AccountLike[]): { sessionsScanned: number } {
    const overrides = parsePricingOverrides(db.getSetting('pricing_overrides'));
    let sessionsScanned = 0;
    for (const account of accounts) {
      const projectsDir = path.join(account.config_dir, 'projects');
      for (const projectEntry of fsDeps.listDir(projectsDir)) {
        if (!projectEntry.isDirectory) continue;
        const projectDir = path.join(projectsDir, projectEntry.name);
        const entries = fsDeps.listDir(projectDir);
        for (const entry of entries) {
          if (entry.isDirectory || !entry.name.endsWith('.jsonl')) continue;
          const sessionId = entry.name.slice(0, -'.jsonl'.length);
          const mainPath = path.join(projectDir, entry.name);
          const subagentsDir = path.join(projectDir, sessionId, 'subagents');

          const signature = sessionFileSignature(fsDeps, mainPath, subagentsDir);
          if (scannedSignatures.get(mainPath) === signature) continue; // unchanged, skip entirely

          const sessionContent = fsDeps.readFile(mainPath);
          if (sessionContent === null) continue;
          const subagentContents = collectSubagentFiles(fsDeps, subagentsDir)
            .map((p) => fsDeps.readFile(p))
            .filter((c): c is string => c !== null);
          const projectPath = recoverProjectPath(sessionContent, projectEntry.name);
          const { dailyRows } = computeSessionCost({
            sessionContent,
            subagentContents,
            sessionId,
            accountName: account.name,
            configDir: account.config_dir,
            projectPath,
            overrides,
          });
          replaceSession(sessionId, dailyRows);
          scannedSignatures.set(mainPath, signature);
          sessionsScanned += 1;
        }
      }
    }
    return { sessionsScanned };
  }

  return {
    replaceSession: (sessionId, rows) => { replaceSession(sessionId, rows); },
    aggregate,
    sessions,
    backfill,
  };
}
