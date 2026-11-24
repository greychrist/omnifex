// Pure: the live watcher and the backfill sweep share one implementation.

import {
  computeMessageCost,
  splitCacheWriteTokens,
  type ModelPricingInput,
} from '../../../src/lib/pricing';
import { extractSessionUsage, type ExtractedUsageRow, type SubagentUsage } from './usage-extract';

export interface SessionCostSnapshot {
  totalUsd: number;
  estimated: boolean;
  breakdown: { inputUsd: number; outputUsd: number; cacheReadUsd: number; cacheWriteUsd: number };
  subagentUsd: number;
  byModel: {
    model: string;
    usd: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  bySubagent: Record<string, SubagentCost>;
}

export interface SubagentCost {
  usd: number;
  estimated: boolean;
  /** The latest request's tokens, not a sum over requests. */
  contextTokens: number;
  model: string;
}

export interface SubagentFile {
  agentId: string;
  content: string;
}

export interface SessionCostDailyRow {
  session_id: string;
  /** Set by `recordInternal`, never inferred from the transcript. */
  internal_kind?: string | null;
  date: string;
  model: string;
  account_name: string;
  config_dir: string;
  project_path: string | null;
  /** 0 main loop, 1 subagent; part of the primary key. */
  is_subagent: number;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  /** Stored as billed: recomputed from current rates they would stop summing to `cost_usd`. */
  input_usd: number;
  output_usd: number;
  cache_read_usd: number;
  cache_write_usd: number;
  cost_usd: number;
  is_estimated: number;
}

export interface ComputeSessionCostArgs {
  sessionContent: string;
  subagentFiles: readonly SubagentFile[];
  sessionId: string;
  accountName: string;
  configDir: string;
  projectPath: string | null;
  overrides?: readonly ModelPricingInput[] | undefined;
}

export type SessionCostMeta = Omit<ComputeSessionCostArgs, 'sessionContent' | 'subagentFiles'>;

export interface SessionCost {
  snapshot: SessionCostSnapshot;
  dailyRows: SessionCostDailyRow[];
}

export function computeSessionCost(args: ComputeSessionCostArgs): SessionCost {
  return priceSessionUsage(extractSessionUsage(args.sessionContent, args.subagentFiles), args);
}

export function priceSessionUsage(
  usage: { main: ExtractedUsageRow[]; subagents: readonly SubagentUsage[] },
  args: SessionCostMeta,
): SessionCost {
  const snapshot: SessionCostSnapshot = {
    totalUsd: 0,
    estimated: false,
    breakdown: { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0 },
    subagentUsd: 0,
    byModel: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    bySubagent: {},
  };
  const byModel = new Map<string, SessionCostSnapshot['byModel'][number]>();
  const daily = new Map<string, SessionCostDailyRow>();

  const ingest = (rows: ExtractedUsageRow[], agent: SubagentCost | null): void => {
    const isSubagent = agent !== null;
    for (const row of rows) {
      // Price at the row's own UTC day so a rate change does not re-price history.
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
      if (agent) {
        snapshot.subagentUsd += cost.usd;
        agent.usd += cost.usd;
        agent.estimated = agent.estimated || cost.estimated;
        agent.contextTokens = input + cacheRead + t5m + t1h + output;
        agent.model = row.model;
      }
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

  ingest(usage.main, null);
  for (const sub of usage.subagents) {
    const agent = (snapshot.bySubagent[sub.agentId] ??= { usd: 0, estimated: false, contextTokens: 0, model: 'unknown' });
    ingest(sub.rows, agent);
  }

  snapshot.byModel = [...byModel.values()].sort((a, b) => b.usd - a.usd);
  return { snapshot, dailyRows: [...daily.values()] };
}
