// Enabled by a persisted flag, not import.meta.env.DEV: it must work in packaged builds. Disabled must cost one
// boolean check, since recordRender runs once per transcript row.

export const PROFILE_STORAGE_KEY = 'omnifex_render_profile';

export interface RenderTally {
  name: string;
  count: number;
}

export interface ProfileReport {
  interaction: string;
  durationMs: number;
  totalRenders: number;
  renders: RenderTally[];
}

export interface ProfileStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface RenderProfilerDeps {
  now?: () => number;
  schedule?: (cb: () => void) => void;
  storage?: ProfileStorage | null;
}

export interface RenderProfiler {
  isEnabled: () => boolean;
  setEnabled: (on: boolean) => void;
  recordRender: (name: string) => void;
  recordRenders: (name: string, count: number) => void;
  begin: (interaction: string) => void;
  end: () => ProfileReport | null;
  snapshot: () => ProfileReport | null;
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
    enabled = false;
  }

  let interaction: string | null = null;
  let startedAt = 0;
  const tallies = new Map<string, number>();
  const listeners = new Set<(report: ProfileReport) => void>();

  const build = (): ProfileReport | null => {
    if (interaction === null) return null;
    const renders = Array.from(tallies, ([name, count]) => ({ name, count }));
    // Stable tie order, or a report diff reads as a change when nothing moved.
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
            // One bad listener must not swallow the report for the others.
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

export const renderProfiler = createRenderProfiler();
