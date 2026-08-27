// Cost module — pure per-session cost computation.
//
// Input: raw contents of one session's main JSONL plus its subagent JSONLs.
// Output: a live snapshot (drives the header CostWidget) and daily rows for
// the session_cost_daily table (drives the Costs history view). Pure so the
// live watcher and the backfill sweep share one implementation and tests need
// no filesystem.

import {
  computeMessageCost,
  splitCacheWriteTokens,
  type PricingOverrides,
} from '../../../src/lib/pricing';
import { extractDedupedUsage, type ExtractedUsageRow } from './usage-extract';

export interface SessionCostSnapshot {
  totalUsd: number;
  estimated: boolean;
  breakdown: { inputUsd: number; outputUsd: number; cacheReadUsd: number; cacheWriteUsd: number };
  subagentUsd: number;
  byModel: Array<{
    model: string;
    usd: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }>;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface SessionCostDailyRow {
  session_id: string;
  /**
   * Which OmniFex-internal activity paid for this row, or absent for a real
   * user session. Set from the archive path the transcript was found under —
   * ownership by location, never inferred.
   */
  internal_kind?: string | null;
  date: string;
  model: string;
  account_name: string;
  config_dir: string;
  project_path: string | null;
  /** 0 = main loop, 1 = subagent. Part of the primary key, so a day+model can
   *  hold one row of each and every metric splits along the same axis. */
  is_subagent: number;
  /** Billed API requests folded into this row — one per deduped usage record. */
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  /** Component costs as billed, stored rather than derived. Recomputing these
   *  from tokens x current rates would stop them summing to `cost_usd` the
   *  moment a rate changed, and they would disagree silently. */
  input_usd: number;
  output_usd: number;
  cache_read_usd: number;
  cache_write_usd: number;
  cost_usd: number;
  is_estimated: number;
}

export interface ComputeSessionCostArgs {
  sessionContent: string;
  subagentContents: string[];
  sessionId: string;
  accountName: string;
  configDir: string;
  projectPath: string | null;
  overrides?: PricingOverrides;
}

export function computeSessionCost(args: ComputeSessionCostArgs): {
  snapshot: SessionCostSnapshot;
  dailyRows: SessionCostDailyRow[];
} {
  const snapshot: SessionCostSnapshot = {
    totalUsd: 0,
    estimated: false,
    breakdown: { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0 },
    subagentUsd: 0,
    byModel: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const byModel = new Map<string, SessionCostSnapshot['byModel'][number]>();
  const daily = new Map<string, SessionCostDailyRow>();

  const ingest = (rows: ExtractedUsageRow[], isSubagent: boolean): void => {
    for (const row of rows) {
      // Price at the row's own UTC day so an effective-dated rate change does
      // not re-price history on the next backfill sweep. Rows with no
      // timestamp fall through to today's rates — they cannot be bucketed
      // into history either, so they only reach the live snapshot.
      const date = row.timestamp ? row.timestamp.slice(0, 10) : '';
      const cost = computeMessageCost(
        row.model,
        row.usage,
        args.overrides,
        date.length === 10 ? date : undefined,
      );
      const { t5m, t1h } = splitCacheWriteTokens(row.usage);
      const input = row.usage.input_tokens ?? 0;
      const output = row.usage.output_tokens ?? 0;
      const cacheRead = row.usage.cache_read_input_tokens ?? 0;

      snapshot.totalUsd += cost.usd;
      snapshot.estimated = snapshot.estimated || cost.estimated;
      snapshot.breakdown.inputUsd += cost.inputUsd;
      snapshot.breakdown.outputUsd += cost.outputUsd;
      snapshot.breakdown.cacheReadUsd += cost.cacheReadUsd;
      snapshot.breakdown.cacheWriteUsd += cost.cacheWriteUsd;
      if (isSubagent) snapshot.subagentUsd += cost.usd;
      snapshot.tokens.input += input;
      snapshot.tokens.output += output;
      snapshot.tokens.cacheRead += cacheRead;
      snapshot.tokens.cacheWrite += t5m + t1h;

      let m = byModel.get(row.model);
      if (!m) {
        m = { model: row.model, usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        byModel.set(row.model, m);
      }
      m.usd += cost.usd;
      m.inputTokens += input;
      m.outputTokens += output;
      m.cacheReadTokens += cacheRead;
      m.cacheWriteTokens += t5m + t1h;

      // Daily bucket — UTC date from the Z-suffixed ISO timestamp. Rows with
      // no timestamp still count toward the live snapshot but cannot be
      // bucketed into history.
      if (date.length === 10) {
        const key = `${date}|${row.model}|${isSubagent ? 1 : 0}`;
        let d = daily.get(key);
        if (!d) {
          d = {
            session_id: args.sessionId,
            date,
            model: row.model,
            account_name: args.accountName,
            config_dir: args.configDir,
            project_path: args.projectPath,
            is_subagent: isSubagent ? 1 : 0,
            request_count: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            input_usd: 0,
            output_usd: 0,
            cache_read_usd: 0,
            cache_write_usd: 0,
            cost_usd: 0,
            is_estimated: 0,
          };
          daily.set(key, d);
        }
        d.input_tokens += input;
        d.output_tokens += output;
        d.cache_read_tokens += cacheRead;
        d.cache_write_5m_tokens += t5m;
        d.cache_write_1h_tokens += t1h;
        d.request_count += 1;
        d.input_usd += cost.inputUsd;
        d.output_usd += cost.outputUsd;
        d.cache_read_usd += cost.cacheReadUsd;
        d.cache_write_usd += cost.cacheWriteUsd;
        d.cost_usd += cost.usd;
        if (cost.estimated) d.is_estimated = 1;
      }
    }
  };

  ingest(extractDedupedUsage(args.sessionContent), false);
  for (const content of args.subagentContents) {
    ingest(extractDedupedUsage(content), true);
  }

  snapshot.byModel = [...byModel.values()].sort((a, b) => b.usd - a.usd);
  return { snapshot, dailyRows: [...daily.values()] };
}
