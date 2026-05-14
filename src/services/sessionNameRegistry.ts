/**
 * Persistent tabId → human-readable label map.
 *
 * The Log tab shows the SDK-side category for every entry, which is
 * `session:<tabId>` (tabIds look like `tab-1778624839066-n893j4wui`). The
 * tab title is the user-facing session name — but tab state is in-memory
 * and disappears when a tab is closed, while log rows live forever in
 * SQLite. This registry bridges the gap: whenever a tab updates, we write
 * `tabId → title` to localStorage, so the Log tab can show real names even
 * for sessions whose tabs were closed days ago.
 *
 * Bounded by `MAX_ENTRIES` (oldest evicted first) so a runaway never blows
 * out localStorage. Only chat tabs with a real title are recorded.
 */

const STORAGE_KEY = 'omnifex_session_name_registry_v1';
const MAX_ENTRIES = 500;

interface Entry {
  title: string;
  updatedAt: number;
}

type Registry = Record<string, Entry>;

let cache: Registry | null = null;

function loadFromStorage(): Registry {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cache = {};
      return cache;
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      cache = parsed as Registry;
      return cache;
    }
  } catch {
    // fall through to fresh registry
  }
  cache = {};
  return cache;
}

function persist(reg: Registry): void {
  cache = reg;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(reg));
  } catch {
    // localStorage quota — silently ignore; the registry is best-effort.
  }
}

function evictOldest(reg: Registry, target: number): void {
  const keys = Object.keys(reg);
  if (keys.length <= target) return;
  const sorted = keys
    .map((k) => [k, reg[k].updatedAt] as const)
    .sort((a, b) => a[1] - b[1]);
  const toDrop = sorted.length - target;
  for (let i = 0; i < toDrop; i++) {
    delete reg[sorted[i][0]];
  }
}

export const sessionNameRegistry = {
  /**
   * Record (or refresh) the label for a tab. No-op for empty / whitespace
   * titles so we don't poison the registry with a default placeholder.
   */
  set(tabId: string, title: string): void {
    if (!tabId) return;
    const clean = title?.trim?.() ?? '';
    if (!clean) return;
    const reg = { ...loadFromStorage() };
    const existing = reg[tabId];
    if (existing && existing.title === clean) return; // no-op, avoid touching storage
    reg[tabId] = { title: clean, updatedAt: Date.now() };
    evictOldest(reg, MAX_ENTRIES);
    persist(reg);
  },

  /** Returns the stored title for the tab, or null if none recorded. */
  get(tabId: string): string | null {
    const reg = loadFromStorage();
    return reg[tabId]?.title ?? null;
  },

  /** Returns a snapshot of all known tabId → title pairs. */
  snapshot(): Record<string, string> {
    const reg = loadFromStorage();
    const out: Record<string, string> = {};
    for (const k of Object.keys(reg)) {
      out[k] = reg[k].title;
    }
    return out;
  },

  /** Test helper — drops the in-memory cache so the next read re-parses storage. */
  _resetCacheForTests(): void {
    cache = null;
  },
};
