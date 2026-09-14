// Tab Status — main-process aggregator for renderer-published per-tab summaries.
//
// Each chat tab in the renderer has all the state it needs to compute its own
// busy/idle/in-flight summary (messages, isLoading, subagents, tasks, git).
// Every tab pushes its summary up via IPC; this service stores them and
// broadcasts the full list to all renderers so the status popover can
// subscribe to one channel.
//
// The installer's "wait for idle" gate also reads from this service —
// renderer is the canonical interpreter of "is this session busy?", main is
// the canonical aggregator. See the regression history around handle.status
// flipping back to running on trailing `task_notification` events: that's
// exactly the predicate-drift this service exists to avoid.

/**
 * Renderer-published summary for one tab. The renderer attaches whatever
 * fields it wants (context usage, branch, todo counts, etc.); this service
 * passes them through as opaque properties. The only fields the main
 * process consumes itself are `tabId`, `busy`, and `title`.
 */
export interface TabStatusSummary {
  tabId: string;
  title: string;
  busy: boolean;
  updatedAt: number;
  // Pass-through for any additional renderer-derived fields.
  [key: string]: unknown;
}

export interface TabStatusServiceDeps {
  /** Broadcast the full list to all subscribed renderers. */
  broadcast: (summaries: TabStatusSummary[]) => void;
}

export interface TabStatusService {
  /**
   * `sourceId` identifies the renderer that published this summary — in
   * practice `webContents.id`. It exists so a page that goes away without
   * unmounting its tabs can have its entries retired; see `removeSource`.
   * Optional so non-renderer callers and tests need not invent one.
   */
  publish(summary: TabStatusSummary, sourceId?: number): void;
  remove(tabId: string): void;
  /**
   * Drop every summary still attributed to `sourceId`.
   *
   * Tabs remove themselves on unmount, which covers closing a tab but not a
   * renderer reload or crash: the page is gone before any unmount effect can
   * land an IPC call. Those summaries then outlived the page forever —
   * phantom "working" sessions in the status popover, and an install gate
   * that waited on tabs which no longer existed.
   *
   * A summary re-published by a newer source is attributed to that source,
   * so retiring the old one never deletes a live entry.
   */
  removeSource(sourceId: number): void;
  list(): TabStatusSummary[];
  /** Tabs that are "busy" in the install-gate sense (work in flight OR
   * waiting on the user). Use when you want to wait for everything to
   * settle before doing something destructive. */
  busyTabIds(): string[];
  /** Tabs whose agent is actively doing work (promptStatus === 'working').
   * Distinct from `busyTabIds()` — excludes "paused on user input" tabs.
   * Use for surfacing "N sessions still running" to the user
   * (e.g. the upgrade-button warning). */
  workingTabIds(): string[];
  clearAll(): void;
}

export function createTabStatusService(
  deps: TabStatusServiceDeps,
): TabStatusService {
  // Insertion-ordered map. The renderer publishes in tab-bar order on first
  // mount, so iteration order naturally matches the visible tab order.
  const summaries = new Map<string, TabStatusSummary>();
  // tabId → publishing renderer. Kept beside `summaries` rather than on the
  // summary itself so the broadcast payload stays exactly what the renderer
  // published; `sourceId` is main's bookkeeping, not part of the contract.
  const sources = new Map<string, number>();

  function snapshot(): TabStatusSummary[] {
    return Array.from(summaries.values());
  }

  function shallowEqual(a: TabStatusSummary, b: TabStatusSummary): boolean {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) {
        return false;
      }
    }
    return true;
  }

  return {
    publish(summary, sourceId) {
      // Reattribution happens even when the payload is unchanged: the same
      // tab republished by a fresh renderer belongs to that renderer now, and
      // an identical summary is exactly what a reloaded page sends first.
      if (sourceId === undefined) sources.delete(summary.tabId);
      else sources.set(summary.tabId, sourceId);
      const existing = summaries.get(summary.tabId);
      if (existing && shallowEqual(existing, summary)) return;
      summaries.set(summary.tabId, summary);
      deps.broadcast(snapshot());
    },

    remove(tabId) {
      sources.delete(tabId);
      if (!summaries.has(tabId)) return;
      summaries.delete(tabId);
      deps.broadcast(snapshot());
    },

    removeSource(sourceId) {
      let removed = false;
      for (const [tabId, owner] of sources) {
        if (owner !== sourceId) continue;
        sources.delete(tabId);
        removed = summaries.delete(tabId) || removed;
      }
      if (removed) deps.broadcast(snapshot());
    },

    list() {
      return snapshot();
    },

    busyTabIds() {
      const out: string[] = [];
      for (const s of summaries.values()) if (s.busy) out.push(s.tabId);
      return out;
    },

    workingTabIds() {
      const out: string[] = [];
      for (const s of summaries.values()) {
        if ((s as { promptStatus?: unknown }).promptStatus === 'working') {
          out.push(s.tabId);
        }
      }
      return out;
    },

    clearAll() {
      if (summaries.size === 0) return;
      summaries.clear();
      sources.clear();
      deps.broadcast([]);
    },
  };
}
