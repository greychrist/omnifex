// Tab Status — main-process aggregator for renderer-published per-tab summaries.
//
// Each chat tab in the renderer has all the state it needs to compute its own
// busy/idle/in-flight summary (messages, isLoading, subagents, todos, git).
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
  publish(summary: TabStatusSummary): void;
  remove(tabId: string): void;
  list(): TabStatusSummary[];
  busyTabIds(): string[];
  clearAll(): void;
}

export function createTabStatusService(
  deps: TabStatusServiceDeps,
): TabStatusService {
  // Insertion-ordered map. The renderer publishes in tab-bar order on first
  // mount, so iteration order naturally matches the visible tab order.
  const summaries = new Map<string, TabStatusSummary>();

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
    publish(summary) {
      const existing = summaries.get(summary.tabId);
      if (existing && shallowEqual(existing, summary)) return;
      summaries.set(summary.tabId, summary);
      deps.broadcast(snapshot());
    },

    remove(tabId) {
      if (!summaries.has(tabId)) return;
      summaries.delete(tabId);
      deps.broadcast(snapshot());
    },

    list() {
      return snapshot();
    },

    busyTabIds() {
      const out: string[] = [];
      for (const s of summaries.values()) if (s.busy) out.push(s.tabId);
      return out;
    },

    clearAll() {
      if (summaries.size === 0) return;
      summaries.clear();
      deps.broadcast([]);
    },
  };
}
