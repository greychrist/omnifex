const STORAGE_KEY = 'omnifex_session_name_registry_v1';
const MAX_ENTRIES = 500;

/** Writes merge: a partial update never clears fields set earlier. */
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
    const parsed: unknown = JSON.parse(raw);
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
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- justified: trimming oldest entries from a bounded local record; keys come from the sorted local array.
    delete reg[sorted[i][0]];
  }
}

function clean(s: string | null | undefined): string | undefined {
  if (s == null) return undefined;
  const t = String(s).trim();
  return t.length > 0 ? t : undefined;
}

export const sessionNameRegistry = {
  set(tabId: string, input: SessionRegistryInput): void {
    if (!tabId) return;
    const title = clean(input.title);
    const projectName = clean(input.projectName);
    const claudeSessionId = clean(input.claudeSessionId);
    if (!title && !projectName && !claudeSessionId) return;

    const reg = { ...loadFromStorage() };
    const existing = reg[tabId];

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

  get(tabId: string): SessionRegistryEntry | null {
    const reg = loadFromStorage();
    return reg[tabId] ?? null;
  },

  snapshot(): Record<string, SessionRegistryEntry> {
    const reg = loadFromStorage();
    const out: Record<string, SessionRegistryEntry> = {};
    for (const k of Object.keys(reg)) {
      out[k] = { ...reg[k] };
    }
    return out;
  },

  _resetCacheForTests(): void {
    cache = null;
  },
};
