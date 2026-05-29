/**
 * Persistent tabId → session-identity map.
 *
 * The Log tab shows the CLI-side category for every entry, which is
 * `session:<tabId>` (tabIds look like `tab-1778624839066-n893j4wui`). Tab
 * state is in-memory and disappears when a tab is closed, while log rows
 * live forever in SQLite. This registry bridges the gap: whenever a tab
 * updates, we mirror its identifying fields to localStorage so the Log tab
 * can render real session labels even for tabs that were closed days ago.
 *
 * The historical entries were just `{ title }` strings; entries written by
 * later builds carry `{ projectName, claudeSessionId, title }` so the Log
 * tab can produce a `session: <project> - <guid7>` label without depending
 * on the (in-memory) TabContext for closed tabs.
 *
 * Bounded by `MAX_ENTRIES` (oldest evicted first) so a runaway never blows
 * out localStorage. Only chat tabs with at least one identifying field are
 * recorded.
 */

const STORAGE_KEY = 'omnifex_session_name_registry_v1';
const MAX_ENTRIES = 500;

/**
 * One stored entry. All identity fields are optional because they get
 * populated at different points in a chat tab's lifecycle:
 *   - `title` and `projectName` are known as soon as a chat tab opens.
 *   - `claudeSessionId` is assigned by the CLI after the first `init`
 *     message lands, so it shows up a moment later.
 * Each write merges with what's already stored — partial updates don't
 * overwrite fields that were set by an earlier call.
 */
export interface SessionRegistryEntry {
  title?: string;
  projectName?: string;
  claudeSessionId?: string;
  updatedAt: number;
}

export interface SessionRegistryInput {
  title?: string | null;
  projectName?: string | null;
  claudeSessionId?: string | null;
}

type Registry = Record<string, SessionRegistryEntry>;

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
      // Existing entries from the original v1 schema only had {title,
      // updatedAt}; the new optional fields will simply be undefined on
      // those rows, which is exactly what we want. No migration step
      // needed.
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
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- justified: trimming oldest entries from a bounded local record; keys come from the sorted local array.
    delete reg[sorted[i][0]];
  }
}

/** Trim, drop empty strings; preserves `undefined` for "not provided". */
function clean(s: string | null | undefined): string | undefined {
  if (s == null) return undefined;
  const t = String(s).trim();
  return t.length > 0 ? t : undefined;
}

export const sessionNameRegistry = {
  /**
   * Record (or refresh) identity fields for a tab. Partial updates are
   * merged with the stored entry — if you call with only `{ claudeSessionId }`
   * the previously-stored `title` and `projectName` stay intact. No-op if
   * every provided field is empty.
   */
  set(tabId: string, input: SessionRegistryInput): void {
    if (!tabId) return;
    const title = clean(input.title);
    const projectName = clean(input.projectName);
    const claudeSessionId = clean(input.claudeSessionId);
    if (!title && !projectName && !claudeSessionId) return;

    const reg = { ...loadFromStorage() };
    const existing = reg[tabId];

    // Skip the write if every provided field already matches — avoids
    // touching localStorage on every render cycle when the tab hasn't
    // actually changed identity.
    if (
      existing &&
      (title === undefined || existing.title === title) &&
      (projectName === undefined || existing.projectName === projectName) &&
      (claudeSessionId === undefined || existing.claudeSessionId === claudeSessionId)
    ) {
      return;
    }

    reg[tabId] = {
      ...existing,
      ...(title !== undefined ? { title } : {}),
      ...(projectName !== undefined ? { projectName } : {}),
      ...(claudeSessionId !== undefined ? { claudeSessionId } : {}),
      updatedAt: Date.now(),
    };
    evictOldest(reg, MAX_ENTRIES);
    persist(reg);
  },

  /** Returns the full stored entry for the tab, or null if none recorded. */
  get(tabId: string): SessionRegistryEntry | null {
    const reg = loadFromStorage();
    return reg[tabId] ?? null;
  },

  /** Returns a snapshot of all known entries. */
  snapshot(): Record<string, SessionRegistryEntry> {
    const reg = loadFromStorage();
    // Defensive shallow copy so callers can't mutate the cache.
    const out: Record<string, SessionRegistryEntry> = {};
    for (const k of Object.keys(reg)) {
      out[k] = { ...reg[k] };
    }
    return out;
  },

  /** Test helper — drops the in-memory cache so the next read re-parses storage. */
  _resetCacheForTests(): void {
    cache = null;
  },
};
