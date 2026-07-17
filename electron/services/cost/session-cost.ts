// Cost module — live per-session cost watcher.
//
// One watcher per watched session. Polls a change signature (main JSONL
// mtime+size, plus the subagents dir listing with per-file sizes) once per
// pollMs; on change it re-reads and recomputes the whole session (full
// re-parse at 1s debounce is well within budget for multi-MB transcripts and
// avoids the offset/dedup bookkeeping an incremental parse would need),
// pushes the snapshot on `session-cost:<sessionId>`, and upserts history.

import path from 'node:path';
import fs from 'node:fs';
import { encodeProjectKey } from '../sessions/summary-query';
import type { PricingOverrides } from '../../../src/lib/pricing';
import { computeSessionCost, type SessionCostSnapshot } from './session-cost-core';
import { nodeCostFs, type CostFs, type CostHistoryService } from './cost-history';

export interface SessionCostArgs {
  configDir: string;
  projectPath: string;
  sessionId: string;
  accountName: string;
}

export interface SessionCostService {
  get(args: SessionCostArgs): SessionCostSnapshot;
  watch(args: SessionCostArgs): SessionCostSnapshot;
  unwatch(sessionId: string): void;
  stopAll(): void;
}

interface SessionCostDeps {
  sendToRenderer: (channel: string, payload: unknown) => void;
  costHistory: CostHistoryService | null;
  getOverrides: () => PricingOverrides | undefined;
  fs?: CostFs;
  stat?: (p: string) => { mtimeMs: number; size: number } | null;
  pollMs?: number;
}

const nodeStat = (p: string): { mtimeMs: number; size: number } | null => {
  try {
    const s = fs.statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
};

export function createSessionCostService(deps: SessionCostDeps): SessionCostService {
  const fsDeps = deps.fs ?? nodeCostFs;
  const stat = deps.stat ?? nodeStat;
  const pollMs = deps.pollMs ?? 1000;
  const watchers = new Map<string, { timer: NodeJS.Timeout; signature: string }>();

  function paths(args: SessionCostArgs) {
    const projectDir = path.join(args.configDir, 'projects', encodeProjectKey(args.projectPath));
    return {
      sessionFile: path.join(projectDir, `${args.sessionId}.jsonl`),
      subagentsDir: path.join(projectDir, args.sessionId, 'subagents'),
    };
  }

  function signature(args: SessionCostArgs): string {
    const { sessionFile, subagentsDir } = paths(args);
    const main = stat(sessionFile);
    const subs = fsDeps
      .listDir(subagentsDir)
      .filter((e) => !e.isDirectory && e.name.endsWith('.jsonl'))
      .map((e) => {
        const s = stat(path.join(subagentsDir, e.name));
        return `${e.name}:${s?.size ?? 0}:${s?.mtimeMs ?? 0}`;
      })
      .sort()
      .join(',');
    return `${main?.size ?? 0}:${main?.mtimeMs ?? 0}|${subs}`;
  }

  function compute(args: SessionCostArgs): SessionCostSnapshot {
    const { sessionFile, subagentsDir } = paths(args);
    const sessionContent = fsDeps.readFile(sessionFile) ?? '';
    const subagentContents = fsDeps
      .listDir(subagentsDir)
      .filter((e) => !e.isDirectory && e.name.startsWith('agent-') && e.name.endsWith('.jsonl'))
      .map((e) => fsDeps.readFile(path.join(subagentsDir, e.name)))
      .filter((c): c is string => c !== null);
    const { snapshot, dailyRows } = computeSessionCost({
      sessionContent,
      subagentContents,
      sessionId: args.sessionId,
      accountName: args.accountName,
      configDir: args.configDir,
      projectPath: args.projectPath,
      overrides: deps.getOverrides(),
    });
    try {
      deps.costHistory?.replaceSession(args.sessionId, dailyRows);
    } catch (err) {
      console.warn('[session-cost] history upsert failed:', err);
    }
    return snapshot;
  }

  function watch(args: SessionCostArgs): SessionCostSnapshot {
    unwatch(args.sessionId);
    const initial = compute(args);
    const state = { timer: null as unknown as NodeJS.Timeout, signature: signature(args) };
    state.timer = setInterval(() => {
      const sig = signature(args);
      if (sig === state.signature) return;
      state.signature = sig;
      const snapshot = compute(args);
      deps.sendToRenderer(`session-cost:${args.sessionId}`, snapshot);
    }, pollMs);
    watchers.set(args.sessionId, state);
    return initial;
  }

  function unwatch(sessionId: string): void {
    const w = watchers.get(sessionId);
    if (w) {
      clearInterval(w.timer);
      watchers.delete(sessionId);
    }
  }

  return {
    get: compute,
    watch,
    unwatch,
    stopAll: () => {
      for (const id of [...watchers.keys()]) unwatch(id);
    },
  };
}
