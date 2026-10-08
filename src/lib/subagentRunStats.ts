/**
 * Per-row run stats for the `agents` popover: how long a subagent has run,
 * what its tokens cost, and how full its context is.
 *
 * Cost and context come from the session cost watcher's per-agent split
 * (`SessionCostSnapshot.bySubagent`), which prices each subagent's own
 * transcript the same way the Cost Report does. A row joins it by `taskId`,
 * which for an Agent task is the agent id in the transcript's file name.
 * Rows with no transcript — background shell tasks — get time only.
 */
import type { SubagentCost } from '@/lib/api';
import { resolveContextWindow } from '@/lib/pricing';
import type { Subagent } from '@/lib/subagentStreams';

export interface SubagentRunStats {
  elapsedMs?: number;
  usd?: number;
  estimated?: boolean;
  contextTokens?: number;
  /** Undefined when the model's window is unknown. */
  contextPct?: number;
}

type Costs = Record<string, SubagentCost> | null | undefined;

function costFor(sub: Subagent, costs: Costs): SubagentCost | undefined {
  return sub.taskId ? costs?.[sub.taskId] : undefined;
}

export function subagentRunStats(sub: Subagent, costs: Costs, nowMs: number): SubagentRunStats {
  const reportedMs = sub.latest?.durationMs;
  let elapsedMs: number | undefined;
  if (sub.status === 'running') {
    // `startedAt` is when this view saw the dispatch, so after a reload the
    // clock starts late; the CLI's own last report is the floor.
    const started = sub.startedAt ? Date.parse(sub.startedAt) : NaN;
    const live = Number.isNaN(started) ? 0 : Math.max(0, nowMs - started);
    elapsedMs = Math.max(live, reportedMs ?? 0) || undefined;
  } else {
    elapsedMs = sub.finalDurationMs ?? reportedMs;
  }

  const cost = costFor(sub, costs);
  if (!cost) return { elapsedMs };
  const window = resolveContextWindow(cost.model);
  return {
    elapsedMs,
    usd: cost.usd,
    estimated: cost.estimated,
    contextTokens: cost.contextTokens,
    contextPct: window ? Math.min(100, Math.round((cost.contextTokens / window) * 100)) : undefined,
  };
}

/** The popover header's total: the cost of the rows shown, not every agent
 *  the session ever ran — a dismissed row drops out of both. */
export function subagentTotals(subs: readonly Subagent[], costs: Costs): { usd?: number; estimated: boolean } {
  let usd: number | undefined;
  let estimated = false;
  for (const sub of subs) {
    const cost = costFor(sub, costs);
    if (!cost) continue;
    usd = (usd ?? 0) + cost.usd;
    estimated = estimated || cost.estimated;
  }
  return { usd, estimated };
}
