// Cost module — spend the CLI counted but no transcript records.
//
// For each CLI process, `latest − baseline` (cli-process-usage.ts) is what the
// process spent, per model, by the CLI's own count. The transcript's usage
// rows inside the same process window are the part the Cost Report already
// prices. What is left — side questions, title generation, anything run with
// `skipTranscript` — is priced here as `cli-unlogged-<session>` rows.
//
// The rule that keeps money from being counted twice: these rows are the
// complement of the transcript by construction, never an independent record.
// Anything else that records CLI spend without a transcript (a per-call side-
// question ledger, a cost-state reconciliation) must not be added alongside
// them — it is already inside the CLI's totals, and so already here.
//
// Pure, like session-cost-core.ts, so the sweep and the tests share it.

import { computeMessageCost, type ModelPricingInput } from '../../../src/lib/pricing';
import type { SessionCostDailyRow } from './session-cost-core';
import type { ExtractedUsageRow } from './usage-extract';
import type { CliModelUsage, CliProcessUsage } from './cli-process-usage';

export const UNLOGGED_SESSION_PREFIX = 'cli-unlogged-';
export const UNLOGGED_INTERNAL_KIND = 'cli-unlogged';

export interface ComputeUnloggedArgs {
  sessionId: string;
  accountName: string;
  configDir: string;
  projectPath: string | null;
  processes: readonly CliProcessUsage[];
  /** Deduped usage rows from the session's main JSONL and every subagent JSONL. */
  transcript: readonly ExtractedUsageRow[];
  overrides?: readonly ModelPricingInput[] | undefined;
}

export interface UnloggedSkip {
  processId: string;
  reason: 'no-baseline' | 'no-latest';
}

interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }

/**
 * The CLI keys its totals by the id it ran (`claude-opus-5-5[1m]`); the
 * transcript records the API's model id (`claude-opus-5-5`). The bracketed
 * suffix is the CLI's context-window variant, not a different model.
 */
function modelKey(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '');
}

function totalsByModel(usage: CliModelUsage): Map<string, Tokens> {
  const out = new Map<string, Tokens>();
  for (const [model, t] of Object.entries(usage)) {
    const key = modelKey(model);
    const acc = out.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    acc.input += t.inputTokens;
    acc.output += t.outputTokens;
    acc.cacheRead += t.cacheReadInputTokens;
    acc.cacheWrite += t.cacheCreationInputTokens;
    out.set(key, acc);
  }
  return out;
}

export function computeUnloggedRows(args: ComputeUnloggedArgs): {
  rows: SessionCostDailyRow[];
  skipped: UnloggedSkip[];
} {
  const skipped: UnloggedSkip[] = [];
  const daily = new Map<string, SessionCostDailyRow>();
  const processes = [...args.processes].sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  processes.forEach((proc, i) => {
    if (!proc.baseline) { skipped.push({ processId: proc.processId, reason: 'no-baseline' }); return; }
    if (!proc.latest || !proc.latestAt) { skipped.push({ processId: proc.processId, reason: 'no-latest' }); return; }

    const windowEnd = processes[i + 1]?.startedAt;
    const logged = new Map<string, Tokens>();
    for (const row of args.transcript) {
      if (!row.timestamp || row.timestamp < proc.startedAt) continue;
      if (windowEnd && row.timestamp >= windowEnd) continue;
      const key = modelKey(row.model);
      const acc = logged.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      acc.input += row.usage.input_tokens ?? 0;
      acc.output += row.usage.output_tokens ?? 0;
      acc.cacheRead += row.usage.cache_read_input_tokens ?? 0;
      acc.cacheWrite += row.usage.cache_creation_input_tokens ?? 0;
      logged.set(key, acc);
    }

    const baseline = totalsByModel(proc.baseline);
    const date = proc.latestAt.slice(0, 10);
    for (const [model, latest] of totalsByModel(proc.latest)) {
      const before = baseline.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const seen = logged.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      // Per category, never below zero: a transcript row written after the
      // CLI's last report (a turn still running) must not cancel spend in
      // another category.
      const hidden: Tokens = {
        input: Math.max(0, latest.input - before.input - seen.input),
        output: Math.max(0, latest.output - before.output - seen.output),
        cacheRead: Math.max(0, latest.cacheRead - before.cacheRead - seen.cacheRead),
        cacheWrite: Math.max(0, latest.cacheWrite - before.cacheWrite - seen.cacheWrite),
      };
      if (hidden.input + hidden.output + hidden.cacheRead + hidden.cacheWrite === 0) continue;

      // The CLI's totals carry no cache-write TTL split, so these tokens take
      // the same path as any unsplit usage: splitCacheWriteTokens prices them
      // at the 5-minute rate, and they are stored in the 5-minute column.
      const cost = computeMessageCost(model, {
        input_tokens: hidden.input,
        output_tokens: hidden.output,
        cache_read_input_tokens: hidden.cacheRead,
        cache_creation_input_tokens: hidden.cacheWrite,
      }, args.overrides, date);

      const key = `${date}|${model}`;
      let d = daily.get(key);
      if (!d) {
        d = {
          session_id: `${UNLOGGED_SESSION_PREFIX}${args.sessionId}`,
          internal_kind: UNLOGGED_INTERNAL_KIND,
          date,
          model,
          account_name: args.accountName,
          config_dir: args.configDir,
          project_path: args.projectPath,
          is_subagent: 0,
          // The CLI reports totals, not calls; how many requests made them up
          // is not known and is not guessed.
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
      d.input_tokens += hidden.input;
      d.output_tokens += hidden.output;
      d.cache_read_tokens += hidden.cacheRead;
      d.cache_write_5m_tokens += hidden.cacheWrite;
      d.input_usd += cost.inputUsd;
      d.output_usd += cost.outputUsd;
      d.cache_read_usd += cost.cacheReadUsd;
      d.cache_write_usd += cost.cacheWriteUsd;
      d.cost_usd += cost.usd;
      if (cost.estimated) d.is_estimated = 1;
    }
  });

  return { rows: [...daily.values()], skipped };
}
