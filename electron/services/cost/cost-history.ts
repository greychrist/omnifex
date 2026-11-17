// Cost module — durable cost history in SQLite.
//
// Rows survive the CLI's transcript pruning (cleanupPeriodDays); the table is
// the source for the Costs view. replaceSession keeps writes idempotent
// (delete-then-insert per session inside one transaction). backfill() walks
// every account config dir's surviving JSONLs — including sessions run
// outside OmniFex — so monthly totals can reconcile against Anthropic's
// console.

import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Database } from '../database';
import { createModelPricingService } from '../model-pricing';
import { SHIPPED_PRICING, type ModelPricingInput } from '../../../src/lib/pricing';
import { mapLimit } from '../util/map-limit';
import { computeSessionCost, priceSessionUsage, type SessionCostDailyRow } from './session-cost-core';
import { claimSessionUsage } from './usage-extract';
import {
  advanceFileUsage,
  collectSubagentFiles,
  nodeCostFs,
  subagentId,
  type CostFs,
  type FileStat,
} from './transcript-usage';
import { createCliProcessUsageStore, type CliProcessUsage } from './cli-process-usage';
import { computeUnloggedRows, UNLOGGED_SESSION_PREFIX } from './unlogged-spend';
import {
  INTERNAL_LABEL,
  isSummaryScratchProject,
  type RecordInternalSpend,
} from '../sessions/internal-spend';

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
  /** Re-price every session whose transcripts (or pricing) changed since its
   *  last scan. Overlapping calls share one sweep. */
  backfill(accounts: AccountLike[]): Promise<{ sessionsScanned: number }>;
  /**
   * Price one of OmniFex's own CLI runs, from its transcript, under the
   * activity's label. Replaces any rows already held for the session id, so a
   * run an earlier pass priced under the scratch path is relabelled, not
   * doubled. See sessions/internal-spend.ts.
   */
  recordInternal: RecordInternalSpend;
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

/**
 * The session a row belongs to. `cli-unlogged-<id>` rows are that session's
 * spend the transcript never recorded; they carry their own id only so the
 * transcript rescan (`replaceSession(<id>)`) cannot delete them. Every count
 * and per-session grouping reads through this, so they are never a session of
 * their own.
 */
const SESSION_KEY = `CASE WHEN session_id LIKE '${UNLOGGED_SESSION_PREFIX}%'
  THEN substr(session_id, ${UNLOGGED_SESSION_PREFIX.length + 1}) ELSE session_id END`;

/** The SUM columns every grouped query shares.
 *
 *  `session_count` is COUNT(DISTINCT ...), not a SUM — a session spanning two
 *  days contributes a row to each, so summing per-period counts would
 *  double-count it in any range total. */
const SUM_COLUMNS = `
  SUM(cost_usd) AS cost_usd,
  SUM(request_count) AS request_count,
  COUNT(DISTINCT ${SESSION_KEY}) AS session_count,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cache_read_tokens) AS cache_read_tokens,
  SUM(cache_write_5m_tokens + cache_write_1h_tokens) AS cache_write_tokens`;

const PERIOD_EXPR: Record<'day' | 'week' | 'month', string> = {
  day: 'date',
  week: "strftime('%Y-W%W', date)",
  month: 'substr(date, 1, 7)',
};

/** Bump when what a scan extracts or how it prices changes in code: every
 *  persisted signature then goes stale and the next sweep re-reads everything. */
const COST_SCAN_VERSION = 1;

/** Sessions scanned at once. Each read is chunked and every chunk yields, so
 *  this bounds memory and thread-pool share, not event-loop time. */
const SCAN_CONCURRENCY = 2;

/**
 * Everything other than the transcripts that decides a session's rows: the
 * scan code's version, the shipped rates and the user's pricing rows. Part of
 * every persisted signature, so a release with new rates, or an edited pricing
 * row, re-prices history on the next sweep — which a daemon restart used to do
 * by forgetting every signature.
 */
function pricingKey(overrides: readonly ModelPricingInput[] | undefined): string {
  return createHash('sha256')
    .update(JSON.stringify([COST_SCAN_VERSION, SHIPPED_PRICING, overrides ?? null]))
    .digest('hex')
    .slice(0, 16);
}

/** A session's on-disk transcripts as one sweep saw them. */
interface SessionFiles {
  main: FileStat | null;
  subagents: { file: string; stat: FileStat | null }[];
  /** Main file `size:mtimeMs` plus every subagent transcript at any depth,
   *  keyed on its path relative to `subagents/`, not its basename — two
   *  workflows can each hold an `agent-<id>.jsonl`, and a basename-keyed
   *  signature would let a new nested file hide behind an unchanged flat one. */
  signature: string;
}

async function statSessionFiles(fsDeps: CostFs, mainPath: string, subagentsDir: string): Promise<SessionFiles> {
  const main = await fsDeps.stat(mainPath);
  const subagents: SessionFiles['subagents'] = [];
  for (const file of await collectSubagentFiles(fsDeps, subagentsDir)) {
    subagents.push({ file, stat: await fsDeps.stat(file) });
  }
  const subs = subagents
    .map(({ file, stat }) => `${path.relative(subagentsDir, file)}:${stat?.size ?? 0}:${stat?.mtimeMs ?? 0}`)
    .join(',');
  return { main, subagents, signature: `${main?.size ?? 0}:${main?.mtimeMs ?? 0}|${subs}` };
}

/** What changes when the CLI reports a new figure for any of the session's processes. */
function cliUsageSignature(processes: readonly CliProcessUsage[]): string {
  return processes.map((p) => `${p.processId}:${p.baselineAt ?? ''}:${p.latestAt ?? ''}`).join(',');
}

export function createCostHistoryService(db: Database, fsDeps: CostFs = nodeCostFs): CostHistoryService {
  // Session file path -> the signature it was last scanned at, in SQLite
  // (`cost_scan_signatures`, migration 35) so it outlives the daemon. Lets a
  // sweep skip sessions whose transcripts have not changed: kept in memory
  // only, every restart re-read and re-parsed every transcript of every
  // account — ~1.9 GB, in one synchronous call that froze every session.
  const selectSignature = db.raw.prepare('SELECT signature FROM cost_scan_signatures WHERE file_path = ?');
  const upsertSignature = db.raw.prepare(`
    INSERT INTO cost_scan_signatures (file_path, signature) VALUES (?, ?)
    ON CONFLICT(file_path) DO UPDATE SET signature = excluded.signature
  `);
  // Prefix match by substr, not LIKE: `_` and `%` are legal in folder names.
  const selectSignaturesUnder = db.raw.prepare(
    'SELECT file_path FROM cost_scan_signatures WHERE substr(file_path, 1, length(@prefix)) = @prefix',
  );
  const deleteSignature = db.raw.prepare('DELETE FROM cost_scan_signatures WHERE file_path = ?');
  const pruneSignatures = db.raw.transaction((paths: string[]) => {
    for (const p of paths) deleteSignature.run(p);
  });
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
               COUNT(DISTINCT ${SESSION_KEY}) AS session_count,
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
      .all(...params) as Omit<SubagentSplitRow, 'usd_per_request'>[];
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
        .all(...where.params) as { v: string | null }[])
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
        SELECT ${SESSION_KEY} AS session_id, account_name, project_path,
               MIN(date) AS first_date, MAX(date) AS last_date,
               SUM(cost_usd) AS cost_usd,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_5m_tokens + cache_write_1h_tokens) AS cache_write_tokens
        FROM session_cost_daily ${sql}
        GROUP BY ${SESSION_KEY} ORDER BY cost_usd DESC LIMIT 500
      `)
      .all(...params) as CostSessionRow[];
  }

  interface SessionItem {
    account: AccountLike;
    dirName: string;
    sessionId: string;
    mainPath: string;
    subagentsDir: string;
  }

  /** Read one session's transcripts and replace its rows. False when its main
   *  transcript could not be read (vanished mid-sweep): nothing written. */
  async function scanSession(
    item: SessionItem,
    files: SessionFiles,
    processes: readonly CliProcessUsage[],
    overrides: readonly ModelPricingInput[] | undefined,
  ): Promise<boolean> {
    const { account, sessionId } = item;
    if (!files.main) return false;
    const main = await advanceFileUsage(fsDeps, item.mainPath, files.main);
    if (!main) return false;
    const subagents = [];
    for (const { file, stat } of files.subagents) {
      if (!stat) continue;
      const sub = await advanceFileUsage(fsDeps, file, stat);
      if (sub) subagents.push({ agentId: subagentId(file), rows: [...sub.state.fold.rows.values()] });
    }
    const usage = claimSessionUsage([...main.state.fold.rows.values()], subagents);
    // The real project path, from `cwd` on an early line; the dir name's
    // `/`→`-` encoding is lossy. Mirrors usage.ts's recovery approach.
    const projectPath = main.state.fold.cwd ?? item.dirName.replace(/-/g, '/');
    const meta = { sessionId, accountName: account.name, configDir: account.config_dir, projectPath, overrides };
    replaceSession(sessionId, priceSessionUsage(usage, meta).dailyRows);
    if (processes.length > 0) {
      const { rows, skipped } = computeUnloggedRows({
        sessionId,
        accountName: account.name,
        configDir: account.config_dir,
        projectPath,
        processes,
        transcript: [...usage.main, ...usage.subagents.flatMap((sub) => sub.rows)],
        overrides,
      });
      for (const skip of skipped) {
        console.warn(`[cost-history] unlogged CLI spend not priced for session ${sessionId}, process ${skip.processId}: ${skip.reason}`);
      }
      replaceSession(`${UNLOGGED_SESSION_PREFIX}${sessionId}`, rows);
    }
    return true;
  }

  async function sweep(accounts: AccountLike[]): Promise<{ sessionsScanned: number }> {
    const overrides = createModelPricingService(db).toOverrides();
    const pricing = pricingKey(overrides);
    // The CLI's own per-process totals, read once per sweep. A new figure
    // (a side question after the last turn) changes nothing on disk, so it
    // joins the file signature below — otherwise the session would be skipped
    // as unchanged and the spend would wait for its next transcript write.
    const cliUsage = createCliProcessUsageStore(db).listBySession();

    const items: SessionItem[] = [];
    for (const account of accounts) {
      const projectsDir = path.join(account.config_dir, 'projects');
      for (const projectEntry of await fsDeps.listDir(projectsDir)) {
        if (!projectEntry.isDirectory) continue;
        // OmniFex's own runs are priced by recordInternal under their
        // activity's label. Priced here they would land under the scratch path.
        if (isSummaryScratchProject(projectEntry.name)) continue;
        const projectDir = path.join(projectsDir, projectEntry.name);
        for (const entry of await fsDeps.listDir(projectDir)) {
          if (entry.isDirectory || !entry.name.endsWith('.jsonl')) continue;
          const sessionId = entry.name.slice(0, -'.jsonl'.length);
          items.push({
            account,
            dirName: projectEntry.name,
            sessionId,
            mainPath: path.join(projectDir, entry.name),
            subagentsDir: path.join(projectDir, sessionId, 'subagents'),
          });
        }
      }
    }

    // replaceSession keys on the session id, and EnterWorktree can leave one
    // id's transcripts in two project dirs: the last one scanned wins. Scan
    // each id's files in listing order within one task, so that stays the
    // later dir however the concurrent reads interleave.
    const byId = new Map<string, SessionItem[]>();
    for (const item of items) {
      const group = byId.get(item.sessionId);
      if (group) group.push(item);
      else byId.set(item.sessionId, [item]);
    }

    // A group is re-read whole when any member changed, so the later dir
    // wins even when only the earlier one was written to.
    const scanGroup = async (group: SessionItem[]): Promise<number> => {
      const processes = cliUsage.get(group[0].sessionId) ?? [];
      const looked = [];
      for (const item of group) {
        const files = await statSessionFiles(fsDeps, item.mainPath, item.subagentsDir);
        const signature = `${pricing}|${files.signature}|${cliUsageSignature(processes)}`;
        const stored = selectSignature.get(item.mainPath) as { signature: string } | undefined;
        looked.push({ item, files, signature, unchanged: stored?.signature === signature });
      }
      if (looked.every((l) => l.unchanged)) return 0; // unchanged, skip entirely
      let n = 0;
      for (const { item, files, signature } of looked) {
        if (!(await scanSession(item, files, processes, overrides))) continue;
        upsertSignature.run(item.mainPath, signature);
        n += 1;
      }
      return n;
    };
    const scanned = await mapLimit([...byId.values()], SCAN_CONCURRENCY, async (group) => {
      try {
        return await scanGroup(group);
      } catch (err) {
        // One bad transcript must not cost the rest of the sweep; it is
        // tried again next sweep, its signature unrecorded.
        console.warn(`[cost-history] scan failed for session ${group[0].sessionId}:`, err);
        return 0;
      }
    });

    // Forget transcripts the CLI has pruned, so the table tracks what exists.
    const seen = new Set(items.map((i) => i.mainPath));
    for (const account of accounts) {
      const prefix = path.join(account.config_dir, 'projects') + path.sep;
      const gone = (selectSignaturesUnder.all({ prefix }) as { file_path: string }[])
        .map((r) => r.file_path)
        .filter((p) => !seen.has(p));
      if (gone.length > 0) pruneSignatures(gone);
    }

    return { sessionsScanned: scanned.reduce((n, x) => n + x, 0) };
  }

  // One sweep at a time: the hourly tick, the startup pass and a manual rescan
  // can all land while a cold first sweep is still reading.
  let running: Promise<{ sessionsScanned: number }> | null = null;
  function backfill(accounts: AccountLike[]): Promise<{ sessionsScanned: number }> {
    running ??= sweep(accounts).finally(() => { running = null; });
    return running;
  }

  const recordInternal: RecordInternalSpend = ({ sessionId, content, kind, accountName, configDir }) => {
    const { dailyRows } = computeSessionCost({
      sessionContent: content,
      subagentFiles: [],
      sessionId,
      accountName,
      configDir,
      projectPath: INTERNAL_LABEL[kind],
      overrides: createModelPricingService(db).toOverrides(),
    });
    replaceSession(sessionId, dailyRows.map((r) => ({ ...r, internal_kind: kind })));
  };

  return {
    replaceSession: (sessionId, rows) => { replaceSession(sessionId, rows); },
    recordInternal,
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
