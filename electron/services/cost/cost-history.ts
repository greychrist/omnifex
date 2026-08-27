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
import {
  INTERNAL_KINDS,
  INTERNAL_LABEL,
  type InternalKind,
} from '../sessions/internal-archive';

/** Extra scan roots for a backfill sweep. */
export interface BackfillOptions {
  /** `internalArchiveRoot(userData)`. Omitted means "projects only". */
  archiveRoot?: string;
}

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

/** Multi-valued fields OR their values together; an empty array means "no
 *  filter", not "match nothing" — a filter bar that empties the table the
 *  moment you clear a checkbox reads as a bug. */
export interface CostHistoryFilters {
  startDate?: string;
  endDate?: string;
  accountName?: string | string[];
  projectPath?: string | string[];
  model?: string | string[];
  /** `undefined` includes both the main loop and subagents. */
  isSubagent?: boolean;
}

export interface CostHistoryPeriod {
  period: string;
  cost_usd: number;
  request_count: number;
  /** Distinct sessions touching this period. NOT summable across periods —
   *  use `totals()` for a range-wide count. */
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  input_usd: number;
  output_usd: number;
  cache_read_usd: number;
  cache_write_usd: number;
  is_estimated: number;
}

/** One period x model bucket, for the stacked-area chart. */
export interface CostHistoryPeriodModel extends CostHistoryPeriod {
  model: string;
}

export interface CostByProject {
  project_path: string | null;
  cost_usd: number;
  request_count: number;
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface CostByModel {
  model: string;
  cost_usd: number;
  request_count: number;
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface CostByProjectModel extends CostByModel {
  project_path: string | null;
}

export interface CostComponents {
  cost_usd: number;
  input_usd: number;
  output_usd: number;
  cache_read_usd: number;
  cache_write_usd: number;
  /** Share of spend that is context (fresh input + cache read + cache write)
   *  rather than generated output. The headline the report exists to produce:
   *  "87% of spend is context" reframes "we spend a lot on AI" as "we spend a
   *  lot on re-sending context", which is a different and more fixable
   *  problem. 0 when nothing matched. */
  context_share: number;
}

export interface CachingRoi {
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_write_1h_tokens: number;
  cache_read_usd: number;
  cache_write_usd: number;
  /** Reads per write. 0 when nothing was written to cache. */
  read_write_ratio: number;
  /** Reads are billed at 0.1x input and writes at 1.25x, so caching pays for
   *  itself somewhere around 2 reads per write. Below that it costs more than
   *  it saves, which the UI must say out loud rather than printing a number. */
  below_break_even: boolean;
  /** What the cache-read tokens would have cost at the full input rate, minus
   *  what they did cost. Derived from the stored cache_read_usd so it stays
   *  consistent with the rates actually billed. */
  saved_usd: number;
  /** The extra paid for 1h-TTL writes over the 5m rate. */
  premium_1h_usd: number;
}

export interface SubagentSplitRow {
  is_subagent: number;
  cost_usd: number;
  request_count: number;
  /** 0 when the side recorded no requests. */
  usd_per_request: number;
}

export interface UnpricedModel {
  model: string;
  request_count: number;
  cost_usd: number;
}

/** Distinct values available to the filter controls. Deliberately NOT narrowed
 *  by the multi-select filters themselves — a control that erases its own
 *  alternatives when you use it cannot be un-used. */
/** Range-wide totals. Separate from `aggregate()` because `session_count` has
 *  to be counted once over the whole range, not summed per period. */
export interface CostTotals {
  cost_usd: number;
  request_count: number;
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface CostFacets {
  accounts: string[];
  models: string[];
  projects: string[];
  minDate: string | null;
  maxDate: string | null;
}

/** Break-even reads-per-write. cacheRead is 0.10x input and cacheWrite5m is
 *  1.25x, so a write pays for itself after 1.25 / (1 - 0.10) ≈ 1.39 reads;
 *  2 is the conventional rule of thumb and the one the Python report uses. */
const CACHE_BREAK_EVEN_RATIO = 2;

/** Cache reads bill at 0.10x the input rate, so 0.90 of the notional full-rate
 *  cost is what caching saved. */
const CACHE_READ_DISCOUNT = 0.1;

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
  aggregateByModel(filters: CostHistoryFilters, groupBy: 'day' | 'week' | 'month'): CostHistoryPeriodModel[];
  sessions(filters: CostHistoryFilters): CostSessionRow[];
  byProject(filters: CostHistoryFilters): CostByProject[];
  byModel(filters: CostHistoryFilters): CostByModel[];
  byProjectModel(filters: CostHistoryFilters): CostByProjectModel[];
  components(filters: CostHistoryFilters): CostComponents;
  totals(filters: CostHistoryFilters): CostTotals;
  cachingRoi(filters: CostHistoryFilters): CachingRoi;
  subagentSplit(filters: CostHistoryFilters): SubagentSplitRow[];
  unpriced(filters: CostHistoryFilters): UnpricedModel[];
  facets(filters: CostHistoryFilters): CostFacets;
  backfill(accounts: AccountLike[], opts?: BackfillOptions): { sessionsScanned: number };
}

function whereClause(filters: CostHistoryFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const multi = (column: string, value: string | string[] | undefined): void => {
    if (value === undefined) return;
    const values = Array.isArray(value) ? value : [value];
    // An empty array is "the user cleared the checkboxes", which means show
    // everything — not `IN ()`, which matches nothing.
    if (values.length === 0) return;
    clauses.push(`${column} IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  };

  if (filters.startDate) { clauses.push('date >= ?'); params.push(filters.startDate); }
  if (filters.endDate) { clauses.push('date <= ?'); params.push(filters.endDate); }
  multi('account_name', filters.accountName);
  multi('project_path', filters.projectPath);
  multi('model', filters.model);
  if (filters.isSubagent !== undefined) {
    clauses.push('is_subagent = ?');
    params.push(filters.isSubagent ? 1 : 0);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** The SUM columns every grouped query shares.
 *
 *  `session_count` is COUNT(DISTINCT ...), not a SUM — a session spanning two
 *  days contributes a row to each, so summing per-period counts would
 *  double-count it in any range total. */
const SUM_COLUMNS = `
  SUM(cost_usd) AS cost_usd,
  SUM(request_count) AS request_count,
  COUNT(DISTINCT session_id) AS session_count,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cache_read_tokens) AS cache_read_tokens,
  SUM(cache_write_5m_tokens + cache_write_1h_tokens) AS cache_write_tokens`;

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
      is_subagent, request_count,
      input_tokens, output_tokens, cache_read_tokens,
      cache_write_5m_tokens, cache_write_1h_tokens,
      input_usd, output_usd, cache_read_usd, cache_write_usd,
      cost_usd, is_estimated, updated_at, internal_kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteStmt = db.raw.prepare('DELETE FROM session_cost_daily WHERE session_id = ?');

  const replaceSession = db.raw.transaction((sessionId: string, rows: SessionCostDailyRow[]) => {
    deleteStmt.run(sessionId);
    const now = new Date().toISOString();
    for (const r of rows) {
      insertStmt.run(
        r.session_id, r.date, r.model, r.account_name, r.config_dir, r.project_path,
        r.is_subagent, r.request_count,
        r.input_tokens, r.output_tokens, r.cache_read_tokens,
        r.cache_write_5m_tokens, r.cache_write_1h_tokens,
        r.input_usd, r.output_usd, r.cache_read_usd, r.cache_write_usd,
        r.cost_usd, r.is_estimated, now, r.internal_kind ?? null,
      );
    }
  });

  const PERIOD_COLUMNS = `${SUM_COLUMNS},
    SUM(input_usd) AS input_usd,
    SUM(output_usd) AS output_usd,
    SUM(cache_read_usd) AS cache_read_usd,
    SUM(cache_write_usd) AS cache_write_usd,
    MAX(is_estimated) AS is_estimated`;

  function aggregate(filters: CostHistoryFilters, groupBy: 'day' | 'week' | 'month'): CostHistoryPeriod[] {
    const { sql, params } = whereClause(filters);
    return db.raw
      .prepare(`
        SELECT ${PERIOD_EXPR[groupBy]} AS period, ${PERIOD_COLUMNS}
        FROM session_cost_daily ${sql}
        GROUP BY period ORDER BY period
      `)
      .all(...params) as CostHistoryPeriod[];
  }

  /** Period x model, for the stacked-area chart. Kept separate from
   *  `aggregate` so the chart and the KPI tiles cannot disagree about the
   *  total by rounding a re-summed breakdown differently. */
  function aggregateByModel(
    filters: CostHistoryFilters,
    groupBy: 'day' | 'week' | 'month',
  ): CostHistoryPeriodModel[] {
    const { sql, params } = whereClause(filters);
    return db.raw
      .prepare(`
        SELECT ${PERIOD_EXPR[groupBy]} AS period, model, ${PERIOD_COLUMNS}
        FROM session_cost_daily ${sql}
        GROUP BY period, model ORDER BY period, cost_usd DESC
      `)
      .all(...params) as CostHistoryPeriodModel[];
  }

  /** `GROUP BY` one or two columns with the shared SUM set, ordered by spend. */
  function grouped<T>(filters: CostHistoryFilters, columns: string): T[] {
    const { sql, params } = whereClause(filters);
    return db.raw
      .prepare(`
        SELECT ${columns}, ${SUM_COLUMNS}
        FROM session_cost_daily ${sql}
        GROUP BY ${columns} ORDER BY cost_usd DESC
      `)
      .all(...params) as T[];
  }

  const byProject = (f: CostHistoryFilters) => grouped<CostByProject>(f, 'project_path');
  const byModel = (f: CostHistoryFilters) => grouped<CostByModel>(f, 'model');
  const byProjectModel = (f: CostHistoryFilters) =>
    grouped<CostByProjectModel>(f, 'project_path, model');

  function totals(filters: CostHistoryFilters): CostTotals {
    const { sql, params } = whereClause(filters);
    return db.raw
      .prepare(`
        SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd,
               COALESCE(SUM(request_count), 0) AS request_count,
               COUNT(DISTINCT session_id) AS session_count,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens,
               COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
               COALESCE(SUM(cache_write_5m_tokens + cache_write_1h_tokens), 0) AS cache_write_tokens
        FROM session_cost_daily ${sql}
      `)
      .get(...params) as CostTotals;
  }

  function components(filters: CostHistoryFilters): CostComponents {
    const { sql, params } = whereClause(filters);
    // COALESCE because SUM over no rows is NULL, and a null cost_usd reaching
    // the renderer renders as "$NaN" rather than "$0.00".
    const r = db.raw
      .prepare(`
        SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd,
               COALESCE(SUM(input_usd), 0) AS input_usd,
               COALESCE(SUM(output_usd), 0) AS output_usd,
               COALESCE(SUM(cache_read_usd), 0) AS cache_read_usd,
               COALESCE(SUM(cache_write_usd), 0) AS cache_write_usd
        FROM session_cost_daily ${sql}
      `)
      .get(...params) as Omit<CostComponents, 'context_share'>;
    const context = r.input_usd + r.cache_read_usd + r.cache_write_usd;
    return { ...r, context_share: r.cost_usd > 0 ? context / r.cost_usd : 0 };
  }

  function cachingRoi(filters: CostHistoryFilters): CachingRoi {
    const { sql, params } = whereClause(filters);
    const r = db.raw
      .prepare(`
        SELECT COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
               COALESCE(SUM(cache_write_5m_tokens + cache_write_1h_tokens), 0) AS cache_write_tokens,
               COALESCE(SUM(cache_write_1h_tokens), 0) AS cache_write_1h_tokens,
               COALESCE(SUM(cache_read_usd), 0) AS cache_read_usd,
               COALESCE(SUM(cache_write_usd), 0) AS cache_write_usd
        FROM session_cost_daily ${sql}
      `)
      .get(...params) as Omit<CachingRoi, 'read_write_ratio' | 'below_break_even' | 'saved_usd' | 'premium_1h_usd'>;

    const ratio = r.cache_write_tokens > 0 ? r.cache_read_tokens / r.cache_write_tokens : 0;

    // Derived from the STORED cache_read_usd rather than tokens x a blended
    // rate: rates differ per model and are effective-dated, so re-deriving
    // here would drift from what was actually billed.
    const fullRateUsd = r.cache_read_usd / CACHE_READ_DISCOUNT;
    const savedUsd = fullRateUsd - r.cache_read_usd;

    // The 1h premium needs a per-model input rate, which the aggregate has
    // averaged away. Recover it from the 1h tokens' share of cache_write_usd:
    // a 1h token costs 2.00x input and a 5m token 1.25x, so the extra paid is
    // 0.75/2.00 of what those tokens cost.
    const writeTokens = r.cache_write_tokens;
    const share1h = writeTokens > 0 ? r.cache_write_1h_tokens * 2 / (r.cache_write_1h_tokens * 2 + (writeTokens - r.cache_write_1h_tokens) * 1.25) : 0;
    const premium1hUsd = r.cache_write_usd * share1h * (0.75 / 2);

    return {
      ...r,
      read_write_ratio: ratio,
      below_break_even: r.cache_write_tokens > 0 && ratio <= CACHE_BREAK_EVEN_RATIO,
      saved_usd: savedUsd,
      premium_1h_usd: premium1hUsd,
    };
  }

  function subagentSplit(filters: CostHistoryFilters): SubagentSplitRow[] {
    const { sql, params } = whereClause(filters);
    const rows = db.raw
      .prepare(`
        SELECT is_subagent,
               SUM(cost_usd) AS cost_usd,
               SUM(request_count) AS request_count
        FROM session_cost_daily ${sql}
        GROUP BY is_subagent ORDER BY is_subagent
      `)
      .all(...params) as Array<Omit<SubagentSplitRow, 'usd_per_request'>>;
    return rows.map((r) => ({
      ...r,
      usd_per_request: r.request_count > 0 ? r.cost_usd / r.request_count : 0,
    }));
  }

  /** Models priced by the sonnet-tier fallback rather than a table entry.
   *  Surfaced, never silently defaulted — a new model billed at the wrong rate
   *  with no warning is how `<synthetic>` went unnoticed for months. */
  function unpriced(filters: CostHistoryFilters): UnpricedModel[] {
    const { sql, params } = whereClause(filters);
    const where = sql ? `${sql} AND is_estimated = 1` : 'WHERE is_estimated = 1';
    return db.raw
      .prepare(`
        SELECT model, SUM(request_count) AS request_count, SUM(cost_usd) AS cost_usd
        FROM session_cost_daily ${where}
        GROUP BY model ORDER BY cost_usd DESC
      `)
      .all(...params) as UnpricedModel[];
  }

  function facets(filters: CostHistoryFilters): CostFacets {
    // The date range narrows every facet. Beyond that, a control must not
    // narrow its OWN list — select "Work" and "Personal" would vanish from
    // the list you need to get back — so account and model are listed
    // against the date range alone.
    //
    // Projects are the one deliberate exception, and it is not a violation of
    // that rule: the project list is narrowed by ACCOUNT, never by the
    // project selection itself. A project belongs to exactly one account's
    // config dir, so showing every account's projects under a chosen account
    // is noise rather than a useful alternative.
    const dateOnly = { startDate: filters.startDate, endDate: filters.endDate };
    const { sql, params } = whereClause(dateOnly);
    const distinct = (name: string, where: { sql: string; params: unknown[] }): string[] =>
      (db.raw
        .prepare(`SELECT DISTINCT ${name} AS v FROM session_cost_daily ${where.sql} ORDER BY v`)
        .all(...where.params) as Array<{ v: string | null }>)
        .map((r) => r.v)
        .filter((v): v is string => v !== null && v !== '');

    const byDate = { sql, params };
    const byAccount = whereClause({ ...dateOnly, accountName: filters.accountName });
    const range = db.raw
      .prepare(`SELECT MIN(date) AS minDate, MAX(date) AS maxDate FROM session_cost_daily ${sql}`)
      .get(...params) as { minDate: string | null; maxDate: string | null };
    return {
      accounts: distinct('account_name', byDate),
      models: distinct('model', byDate),
      projects: distinct('project_path', byAccount),
      ...range,
    };
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

  function backfill(accounts: AccountLike[], opts?: BackfillOptions): { sessionsScanned: number } {
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

    // OmniFex's own CLI runs. These transcripts used to be deleted the moment
    // the call returned, so the money they cost was invisible; they are
    // retained now and priced here, with the same parser and the same rates.
    //
    // Account and kind come from the archive path rather than from anything
    // inside the file — ownership by location, the rule the Brain already
    // applies to its own sources.
    if (opts?.archiveRoot) {
      sessionsScanned += backfillArchive(opts.archiveRoot, overrides);
    }

    return { sessionsScanned };
  }

  /**
   * Walk `<root>/<account>/<kind>/<date>/*.jsonl`.
   *
   * An unrecognised kind directory is SKIPPED rather than priced under a
   * guessed label: money attributed to something we made up is worse than
   * money we can see we missed.
   */
  function backfillArchive(root: string, overrides: ReturnType<typeof parsePricingOverrides>): number {
    let scanned = 0;
    for (const accountEntry of fsDeps.listDir(root)) {
      if (!accountEntry.isDirectory) continue;
      const accountDir = path.join(root, accountEntry.name);

      for (const kindEntry of fsDeps.listDir(accountDir)) {
        if (!kindEntry.isDirectory) continue;
        if (!(INTERNAL_KINDS as readonly string[]).includes(kindEntry.name)) continue;
        const kind = kindEntry.name as InternalKind;
        const kindDir = path.join(accountDir, kind);

        for (const dateEntry of fsDeps.listDir(kindDir)) {
          if (!dateEntry.isDirectory) continue;
          const dateDir = path.join(kindDir, dateEntry.name);

          for (const entry of fsDeps.listDir(dateDir)) {
            if (entry.isDirectory || !entry.name.endsWith('.jsonl')) continue;
            const sessionId = entry.name.slice(0, -'.jsonl'.length);
            const mainPath = path.join(dateDir, entry.name);

            // Same skip-if-unchanged guard as the projects walk. An archived
            // transcript never changes after it lands, so this is close to a
            // permanent skip once seen.
            const signature = sessionFileSignature(fsDeps, mainPath, path.join(dateDir, sessionId, 'subagents'));
            if (scannedSignatures.get(mainPath) === signature) continue;

            const sessionContent = fsDeps.readFile(mainPath);
            if (sessionContent === null) continue;

            const { dailyRows } = computeSessionCost({
              sessionContent,
              subagentContents: [],
              sessionId,
              accountName: accountEntry.name,
              configDir: '',
              projectPath: INTERNAL_LABEL[kind],
              overrides,
            });
            replaceSession(
              sessionId,
              dailyRows.map((r) => ({ ...r, internal_kind: kind })),
            );
            scannedSignatures.set(mainPath, signature);
            scanned += 1;
          }
        }
      }
    }
    return scanned;
  }

  return {
    replaceSession: (sessionId, rows) => { replaceSession(sessionId, rows); },
    aggregate,
    aggregateByModel,
    sessions,
    byProject,
    byModel,
    byProjectModel,
    components,
    totals,
    cachingRoi,
    subagentSplit,
    unpriced,
    facets,
    backfill,
  };
}
