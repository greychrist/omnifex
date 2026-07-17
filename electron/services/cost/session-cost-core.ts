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
  date: string;
  model: string;
  account_name: string;
  config_dir: string;
  project_path: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
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
      const cost = computeMessageCost(row.model, row.usage, args.overrides);
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
      const date = row.timestamp ? row.timestamp.slice(0, 10) : '';
      if (date.length === 10) {
        const key = `${date}|${row.model}`;
        let d = daily.get(key);
        if (!d) {
          d = {
            session_id: args.sessionId,
            date,
            model: row.model,
            account_name: args.accountName,
            config_dir: args.configDir,
            project_path: args.projectPath,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
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
