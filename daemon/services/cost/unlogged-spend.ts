// These rows are the transcript's complement by construction. Never record transcript-less CLI spend anywhere else
// alongside them: it is already inside the CLI's totals, so already here.

import { computeMessageCost, splitCacheWriteTokens, type ModelPricingInput } from '../../../src/lib/pricing';
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
  transcript: readonly ExtractedUsageRow[];
  overrides?: readonly ModelPricingInput[] | undefined;
}

export interface UnloggedSkip {
  processId: string;
  reason: 'no-baseline' | 'no-latest';
}

interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number | null;
}

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: null });

/** The CLI keys totals by `claude-opus-5-5[1m]`, the transcript by `claude-opus-5-5`: the same model. */
function modelKey(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '');
}

function totalsByModel(usage: CliModelUsage): Map<string, Tokens> {
  const out = new Map<string, Tokens>();
  for (const [model, t] of Object.entries(usage)) {
    const key = modelKey(model);
    const acc = out.get(key) ?? zero();
    acc.input += t.inputTokens;
    acc.output += t.outputTokens;
    acc.cacheRead += t.cacheReadInputTokens;
    acc.cacheWrite += t.cacheCreationInputTokens;
    if (t.cacheCreationEphemeral1hInputTokens !== undefined) {
      acc.cacheWrite1h = (acc.cacheWrite1h ?? 0) + t.cacheCreationEphemeral1hInputTokens;
    }
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
      const acc = logged.get(key) ?? zero();
      acc.input += row.usage.input_tokens ?? 0;
      acc.output += row.usage.output_tokens ?? 0;
      acc.cacheRead += row.usage.cache_read_input_tokens ?? 0;
      acc.cacheWrite += row.usage.cache_creation_input_tokens ?? 0;
      acc.cacheWrite1h = (acc.cacheWrite1h ?? 0) + splitCacheWriteTokens(row.usage).t1h;
      logged.set(key, acc);
    }

    const baseline = totalsByModel(proc.baseline);
    const date = proc.latestAt.slice(0, 10);
    for (const [model, latest] of totalsByModel(proc.latest)) {
      const before = baseline.get(model) ?? zero();
      const seen = logged.get(model) ?? zero();
      // Per category, never below zero: a row written after the CLI's last report must not cancel another category.
      const hidden = {
        input: Math.max(0, latest.input - before.input - seen.input),
        output: Math.max(0, latest.output - before.output - seen.output),
        cacheRead: Math.max(0, latest.cacheRead - before.cacheRead - seen.cacheRead),
        cacheWrite: Math.max(0, latest.cacheWrite - before.cacheWrite - seen.cacheWrite),
      };
      if (hidden.input + hidden.output + hidden.cacheRead + hidden.cacheWrite === 0) continue;

      // A baseline without the 1h split came from an older CLI and subtracts nothing; unsplit writes use the 5-minute rate.
      const hidden1h = latest.cacheWrite1h === null
        ? 0
        : Math.min(hidden.cacheWrite, Math.max(0, latest.cacheWrite1h - (before.cacheWrite1h ?? 0) - (seen.cacheWrite1h ?? 0)));
      const hidden5m = hidden.cacheWrite - hidden1h;
      const cost = computeMessageCost(model, {
        input_tokens: hidden.input,
        output_tokens: hidden.output,
        cache_read_input_tokens: hidden.cacheRead,
        cache_creation_input_tokens: hidden.cacheWrite,
        cache_creation: { ephemeral_5m_input_tokens: hidden5m, ephemeral_1h_input_tokens: hidden1h },
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
          // Not known, never guessed.
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
      d.cache_write_5m_tokens += hidden5m;
      d.cache_write_1h_tokens += hidden1h;
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
