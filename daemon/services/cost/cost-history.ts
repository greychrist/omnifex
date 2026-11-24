// Rows outlive the CLI's transcript pruning. replaceSession must stay idempotent (delete-then-insert per session).

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

/** An empty array means "no filter", never "match nothing". */
export interface CostHistoryFilters {
  startDate?: string;
  endDate?: string;
  accountName?: string | string[];
  projectPath?: string | string[];
  model?: string | string[];
  isSubagent?: boolean;
}

export interface CostHistoryPeriod {
  period: string;
  cost_usd: number;
  request_count: number;
  /** Not summable across periods; use `totals()`. */
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
  context_share: number;
}

export interface CachingRoi {
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_write_1h_tokens: number;
  cache_read_usd: number;
  cache_write_usd: number;
  read_write_ratio: number;
  /** The UI must say this out loud rather than print a ratio. */
  below_break_even: boolean;
  /** From the stored cache_read_usd, so it matches the rates actually billed. */
  saved_usd: number;
  premium_1h_usd: number;
}

export interface SubagentSplitRow {
  is_subagent: number;
  cost_usd: number;
  request_count: number;
  usd_per_request: number;
}

export interface UnpricedModel {
  model: string;
  request_count: number;
  cost_usd: number;
}

/** Not narrowed by the multi-select filters: a control that erases its own alternatives cannot be un-used. */
/** `session_count` is counted once over the range, never summed per period. */
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

const CACHE_BREAK_EVEN_RATIO = 2;

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
  backfill(accounts: AccountLike[]): Promise<{ sessionsScanned: number }>;
  /** Replaces rows already held for the session id, so a run priced under the scratch path is relabelled, not doubled. */
  recordInternal: RecordInternalSpend;
}

function whereClause(filters: CostHistoryFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const multi = (column: string, value: string | string[] | undefined): void => {
    if (value === undefined) return;
    const values = Array.isArray(value) ? value : [value];
    // Not `IN ()`, which matches nothing.
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

/** `cli-unlogged-<id>` rows carry their own id only so `replaceSession(<id>)` cannot delete them; every count reads through this. */
const SESSION_KEY = `CASE WHEN session_id LIKE '${UNLOGGED_SESSION_PREFIX}%'
  THEN substr(session_id, ${UNLOGGED_SESSION_PREFIX.length + 1}) ELSE session_id END`;

/** `session_count` is COUNT(DISTINCT): a session spanning two days has a row in each. */
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

/** Bump when extraction or pricing code changes: a restart does not re-price. */
const COST_SCAN_VERSION = 1;

const SCAN_CONCURRENCY = 2;

/** Part of every signature, so new shipped rates or an edited pricing row re-price history. */
function pricingKey(overrides: readonly ModelPricingInput[] | undefined): string {
  return createHash('sha256')
    .update(JSON.stringify([COST_SCAN_VERSION, SHIPPED_PRICING, overrides ?? null]))
    .digest('hex')
    .slice(0, 16);
}

interface SessionFiles {
  main: FileStat | null;
  subagents: { file: string; stat: FileStat | null }[];
  /** Keyed on the path relative to `subagents/`, not the basename: two workflows can each hold `agent-<id>.jsonl`. */
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

function cliUsageSignature(processes: readonly CliProcessUsage[]): string {
  return processes.map((p) => `${p.processId}:${p.baselineAt ?? ''}:${p.latestAt ?? ''}`).join(',');
}

export function createCostHistoryService(db: Database, fsDeps: CostFs = nodeCostFs): CostHistoryService {
  // Persisted: re-reading every transcript on restart (~1.9 GB, synchronously) froze every session.
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

  /** Separate from `aggregate` so the chart and KPI tiles cannot round the total differently. */
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
    // COALESCE: SUM over no rows is NULL, which renders as "$NaN".
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

    // From the stored cache_read_usd: rates are per-model and effective-dated.
    const fullRateUsd = r.cache_read_usd / CACHE_READ_DISCOUNT;
    const savedUsd = fullRateUsd - r.cache_read_usd;

    // A 1h token costs 2.00x input and a 5m token 1.25x, so the premium is 0.75/2.00 of what 1h tokens cost.
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

  /** Surfaced, never silently defaulted to a rate. */
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
    // A control never narrows its own list. Projects narrow by account only: each belongs to one account's config dir.
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
    // The dir name's `/`→`-` encoding is lossy; prefer `cwd`.
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
    // Part of the signature: a new CLI figure changes nothing on disk, so the session would be skipped as unchanged.
    const cliUsage = createCliProcessUsageStore(db).listBySession();

    const items: SessionItem[] = [];
    for (const account of accounts) {
      const projectsDir = path.join(account.config_dir, 'projects');
      for (const projectEntry of await fsDeps.listDir(projectsDir)) {
        if (!projectEntry.isDirectory) continue;
        // Priced by recordInternal; here they would land under the scratch path.
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

    // EnterWorktree can leave one id in two dirs and replaceSession keys on id: scan each id's files in order, in one task, so the later dir wins.
    const byId = new Map<string, SessionItem[]>();
    for (const item of items) {
      const group = byId.get(item.sessionId);
      if (group) group.push(item);
      else byId.set(item.sessionId, [item]);
    }

    // Re-read whole, so the later dir wins even when only the earlier one changed.
    const scanGroup = async (group: SessionItem[]): Promise<number> => {
      const processes = cliUsage.get(group[0].sessionId) ?? [];
      const looked = [];
      for (const item of group) {
        const files = await statSessionFiles(fsDeps, item.mainPath, item.subagentsDir);
        const signature = `${pricing}|${files.signature}|${cliUsageSignature(processes)}`;
        const stored = selectSignature.get(item.mainPath) as { signature: string } | undefined;
        looked.push({ item, files, signature, unchanged: stored?.signature === signature });
      }
      if (looked.every((l) => l.unchanged)) return 0;
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
        // One bad transcript must not cost the sweep; its signature stays unrecorded so it is retried.
        console.warn(`[cost-history] scan failed for session ${group[0].sessionId}:`, err);
        return 0;
      }
    });

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
