// Cost module — live per-session cost watcher.
//
// One watcher per watched session, ticking every pollMs. Each tick stats the
// main JSONL and every subagent transcript at any depth under `subagents/`,
// reads only what each grew by (transcript-usage.ts), and when anything
// changed re-prices the folded rows, pushes the snapshot on
// `session-cost:<sessionId>` and upserts history.
//
// It used to re-read and re-parse the whole session synchronously whenever a
// file changed — every second while a turn streamed, up to 59 MB per read,
// per open tab — on the event loop every session's streaming shares.

import path from 'node:path';
import { encodeProjectId } from '../project-paths';
import type { ModelPricingInput } from '../../../src/lib/pricing';
import { priceSessionUsage, type SessionCostSnapshot } from './session-cost-core';
import { claimSessionUsage } from './usage-extract';
import {
  advanceFileUsage,
  collectSubagentFiles,
  nodeCostFs,
  subagentId,
  type CostFs,
  type FileStat,
  type FileUsageState,
} from './transcript-usage';
import type { CostHistoryService } from './cost-history';

export interface SessionCostArgs {
  configDir: string;
  projectPath: string;
  sessionId: string;
  accountName: string;
}

export interface SessionCostService {
  get(args: SessionCostArgs): Promise<SessionCostSnapshot>;
  watch(args: SessionCostArgs): Promise<SessionCostSnapshot>;
  unwatch(sessionId: string): void;
  stopAll(): void;
}

interface SessionCostDeps {
  sendToRenderer: (channel: string, payload: unknown) => void;
  costHistory: CostHistoryService | null;
  getOverrides: () => readonly ModelPricingInput[] | undefined;
  fs?: CostFs;
  stat?: (p: string) => FileStat | null | Promise<FileStat | null>;
  pollMs?: number;
}

/** What a session's transcripts have been folded to so far. */
interface SessionUsageState {
  mainPath: string | null;
  main: FileUsageState | null;
  /** By absolute path. */
  subagents: Map<string, FileUsageState>;
}

const emptyState = (): SessionUsageState => ({ mainPath: null, main: null, subagents: new Map() });

interface Watcher {
  args: SessionCostArgs;
  state: SessionUsageState;
  timer: NodeJS.Timeout | null;
  /** The refresh under way, if any: a tick that finds one skips. */
  busy: Promise<unknown> | null;
  stopped: boolean;
}

export function createSessionCostService(deps: SessionCostDeps): SessionCostService {
  const fsDeps = deps.fs ?? nodeCostFs;
  const stat = deps.stat ?? ((p: string) => fsDeps.stat(p));
  const pollMs = deps.pollMs ?? 1000;
  const watchers = new Map<string, Watcher>();
  // Sessions launched with a cwd inside a CLI worktree (.claude/worktrees/<name>)
  // get encoded into a *different* projects/ subdirectory than the app's own
  // project path would predict. Once we've located the real directory for a
  // sessionId (by scanning projects/'s siblings), remember it so each tick
  // doesn't rescan every subdirectory.
  const resolvedDirs = new Map<string, string>();

  async function resolveProjectDir(args: SessionCostArgs): Promise<string> {
    // Re-checked every call: EnterWorktree moves a live session's transcript
    // into the worktree's directory, leaving the cached one empty.
    const cached = resolvedDirs.get(args.sessionId);
    if (cached && (await stat(path.join(cached, `${args.sessionId}.jsonl`)))) return cached;

    const projectsDir = path.join(args.configDir, 'projects');
    const primaryDir = path.join(projectsDir, encodeProjectId(args.projectPath));
    const primaryFile = path.join(primaryDir, `${args.sessionId}.jsonl`);
    if (await stat(primaryFile)) {
      resolvedDirs.set(args.sessionId, primaryDir);
      return primaryDir;
    }

    for (const entry of await fsDeps.listDir(projectsDir)) {
      if (!entry.isDirectory) continue;
      const candidateDir = path.join(projectsDir, entry.name);
      if (candidateDir === primaryDir) continue;
      const candidateFile = path.join(candidateDir, `${args.sessionId}.jsonl`);
      if (await stat(candidateFile)) {
        resolvedDirs.set(args.sessionId, candidateDir);
        return candidateDir;
      }
    }

    // Not found anywhere — fall back to the primary dir so callers keep the
    // existing "missing file -> zero snapshot" behavior instead of erroring.
    return primaryDir;
  }

  /**
   * Bring `state` up to date with the session's files. True when anything
   * folded changed. A file that vanished drops out; one that failed to read is
   * forgotten, so the next refresh reads it from the start.
   */
  async function refresh(args: SessionCostArgs, state: SessionUsageState): Promise<boolean> {
    const projectDir = await resolveProjectDir(args);
    const sessionFile = path.join(projectDir, `${args.sessionId}.jsonl`);
    const subagentsDir = path.join(projectDir, args.sessionId, 'subagents');
    let changed = false;

    // A transcript the CLI moved is a different file: start it over.
    if (state.mainPath !== sessionFile) {
      changed = state.main !== null;
      state.mainPath = sessionFile;
      state.main = null;
    }
    const mainStat = await stat(sessionFile);
    if (!mainStat) {
      changed ||= state.main !== null;
      state.main = null;
    } else {
      const r = await advanceFileUsage(fsDeps, sessionFile, mainStat, state.main ?? undefined);
      changed ||= r === null ? state.main !== null : r.changed;
      state.main = r?.state ?? null;
    }

    const present = new Set(await collectSubagentFiles(fsDeps, subagentsDir));
    for (const file of state.subagents.keys()) {
      if (!present.has(file)) {
        state.subagents.delete(file);
        changed = true;
      }
    }
    for (const file of present) {
      const prev = state.subagents.get(file);
      const s = await stat(file);
      const r = s ? await advanceFileUsage(fsDeps, file, s, prev) : null;
      if (r) {
        state.subagents.set(file, r.state);
        changed ||= r.changed;
      } else if (prev) {
        state.subagents.delete(file);
        changed = true;
      }
    }
    return changed;
  }

  /** Price what `state` holds and upsert history. Pure CPU over the folded
   *  rows — no reads. */
  function price(args: SessionCostArgs, state: SessionUsageState): SessionCostSnapshot {
    const subagents = [...state.subagents]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([file, s]) => ({ agentId: subagentId(file), rows: [...s.fold.rows.values()] }));
    const usage = claimSessionUsage(state.main ? [...state.main.fold.rows.values()] : [], subagents);
    const { snapshot, dailyRows } = priceSessionUsage(usage, {
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

  /** Run `fn` as the watcher's one refresh, after any already under way. */
  async function exclusive<T>(w: Watcher, fn: () => Promise<T>): Promise<T> {
    while (w.busy) await w.busy.catch(() => undefined);
    const run = fn();
    w.busy = run;
    try {
      return await run;
    } finally {
      if (w.busy === run) w.busy = null;
    }
  }

  async function get(args: SessionCostArgs): Promise<SessionCostSnapshot> {
    // A watched session already holds its folded state: catch it up rather
    // than reading every file again.
    const w = watchers.get(args.sessionId);
    if (w) return exclusive(w, async () => { await refresh(w.args, w.state); return price(w.args, w.state); });
    const state = emptyState();
    await refresh(args, state);
    return price(args, state);
  }

  async function watch(args: SessionCostArgs): Promise<SessionCostSnapshot> {
    unwatch(args.sessionId);
    const w: Watcher = { args, state: emptyState(), timer: null, busy: null, stopped: false };
    watchers.set(args.sessionId, w);
    const initial = await exclusive(w, async () => { await refresh(args, w.state); return price(args, w.state); });
    if (w.stopped) return initial;
    w.timer = setInterval(() => {
      // Skip, don't queue: a tick that lands mid-read would only re-stat
      // what the running read is about to catch up on.
      if (w.busy || w.stopped) return;
      void exclusive(w, async () => {
        if (!(await refresh(args, w.state)) || w.stopped) return;
        const snapshot = price(args, w.state);
        if (!w.stopped) deps.sendToRenderer(`session-cost:${args.sessionId}`, snapshot);
      }).catch((err: unknown) => {
        // Forget everything so the next tick starts clean.
        w.state = emptyState();
        console.warn('[session-cost] refresh failed:', err);
      });
    }, pollMs);
    return initial;
  }

  function unwatch(sessionId: string): void {
    const w = watchers.get(sessionId);
    if (w) {
      w.stopped = true;
      if (w.timer) clearInterval(w.timer);
      watchers.delete(sessionId);
      resolvedDirs.delete(sessionId);
    }
  }

  return {
    get,
    watch,
    unwatch,
    stopAll: () => {
      for (const id of [...watchers.keys()]) unwatch(id);
    },
  };
}
