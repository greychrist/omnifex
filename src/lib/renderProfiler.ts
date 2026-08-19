// Render profiler — diagnostic instrumentation for interaction cost.
//
// Why this exists: every tab stays mounted (TabContent hides inactive panels
// with a CSS class rather than unmounting them), and nothing in the tab render
// path is memoised. So a change to `activeTabId` — or to any single tab object
// — produces a new TabContext value and re-renders every panel, every session
// and every unvirtualised transcript row in the app. This module measures that
// instead of guessing at it.
//
// Design constraints, both load-bearing:
//
//  1. It must be usable in a PACKAGED build. The lag was reported there, and
//     dev adds StrictMode's double-invoke on top, which distorts exactly the
//     number we care about. So enablement is a persisted runtime flag, not
//     `import.meta.env.DEV` — flip it from the devtools console (the app menu
//     keeps `role: 'toggleDevTools'`) and reload, no rebuild.
//  2. Disabled must cost ~nothing. `recordRender` is called from component
//     bodies, including once per transcript row, so the disabled path is a
//     single boolean check and return.
//
// Counting is scoped to an *interaction*: `begin()` opens a window, renders
// tally into it, `end()` closes and reports. Renders outside a window are
// ignored, so ambient stream churn doesn't pollute a tab-switch measurement.

export const PROFILE_STORAGE_KEY = 'omnifex_render_profile';

export interface RenderTally {
  name: string;
  count: number;
}

export interface ProfileReport {
  /** Label passed to `begin()` / `profile()`, e.g. 'tab-switch'. */
  interaction: string;
  /** Wall-clock ms from `begin()` to `end()`. */
  durationMs: number;
  /** Sum of every tally — the headline "this click cost N renders". */
  totalRenders: number;
  /** Per-component counts, worst first. */
  renders: RenderTally[];
}

/** The slice of `Storage` we use; `localStorage` satisfies it structurally. */
export interface ProfileStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface RenderProfilerDeps {
  now?: () => number;
  /**
   * Defers the close of a `profile()` window until after React has committed
   * and the browser has painted. Default is a double rAF: the first callback
   * runs before paint, the second after it, which is the cheapest reliable
   * "the frame is on screen now" signal.
   */
  schedule?: (cb: () => void) => void;
  storage?: ProfileStorage | null;
}

export interface RenderProfiler {
  isEnabled: () => boolean;
  setEnabled: (on: boolean) => void;
  /** Called from a component body. Hot path — keep it trivial. */
  recordRender: (name: string) => void;
  /**
   * Add `count` at once. For unvirtualised lists, where the interesting
   * number is "this render walked N rows" and calling `recordRender` N times
   * would measure the profiler as much as the list.
   */
  recordRenders: (name: string, count: number) => void;
  begin: (interaction: string) => void;
  end: () => ProfileReport | null;
  /** Peek at the open window without closing it. */
  snapshot: () => ProfileReport | null;
  /** `begin()` plus a close scheduled after the resulting paint. */
  profile: (interaction: string) => void;
  onReport: (fn: (report: ProfileReport) => void) => () => void;
}

function defaultSchedule(cb: () => void): void {
  if (typeof requestAnimationFrame !== 'function') {
    setTimeout(cb, 0);
    return;
  }
  requestAnimationFrame(() => { requestAnimationFrame(cb); });
}

function defaultStorage(): ProfileStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    // Renderer with storage blocked.
    return null;
  }
}

export function createRenderProfiler(deps: RenderProfilerDeps = {}): RenderProfiler {
  const now = deps.now ?? (() => performance.now());
  const schedule = deps.schedule ?? defaultSchedule;
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;

  let enabled = false;
  try {
    enabled = storage?.getItem(PROFILE_STORAGE_KEY) === '1';
  } catch {
    // A storage that throws on read is the same as no storage: stay off.
    enabled = false;
  }

  let interaction: string | null = null;
  let startedAt = 0;
  const tallies = new Map<string, number>();
  const listeners = new Set<(report: ProfileReport) => void>();

  const build = (): ProfileReport | null => {
    if (interaction === null) return null;
    const renders = Array.from(tallies, ([name, count]) => ({ name, count }));
    // Count desc, then name asc — ties must not reorder between runs, or a
    // report diff reads as a change when nothing moved.
    renders.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
    return {
      interaction,
      durationMs: now() - startedAt,
      totalRenders: renders.reduce((sum, r) => sum + r.count, 0),
      renders,
    };
  };

  return {
    isEnabled: () => enabled,

    setEnabled(on) {
      enabled = on;
      if (!on) {
        interaction = null;
        tallies.clear();
      }
      try {
        if (on) storage?.setItem(PROFILE_STORAGE_KEY, '1');
        else storage?.removeItem(PROFILE_STORAGE_KEY);
      } catch {
        // Persistence is a convenience; the in-memory flag already flipped.
      }
    },

    recordRender(name) {
      if (!enabled || interaction === null) return;
      tallies.set(name, (tallies.get(name) ?? 0) + 1);
    },

    recordRenders(name, count) {
      if (!enabled || interaction === null || count <= 0) return;
      tallies.set(name, (tallies.get(name) ?? 0) + count);
    },

    begin(label) {
      if (!enabled) return;
      interaction = label;
      startedAt = now();
      tallies.clear();
    },

    end() {
      const report = build();
      interaction = null;
      tallies.clear();
      return report;
    },

    snapshot: build,

    profile(label) {
      if (!enabled) return;
      this.begin(label);
      schedule(() => {
        const report = this.end();
        if (!report) return;
        for (const fn of listeners) {
          try {
            fn(report);
          } catch {
            // One bad listener must not swallow the report for the others —
            // this is diagnostic code and has no business throwing into the
            // interaction it is measuring.
          }
        }
      });
    },

    onReport(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

/** App-wide singleton. Components import this; tests build their own. */
export const renderProfiler = createRenderProfiler();
