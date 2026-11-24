import { api } from './api';
import { TabPersistenceService } from '@/services/tabPersistence';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';

export interface Stall {
  stalledMs: number;
  startedAt: string;
  endedAt: string;
}

export interface StallWatchdogDeps {
  intervalMs: number;
  thresholdMs: number;
  now: () => number;
  every: (fn: () => void) => () => void;
  isVisible: () => boolean;
  onStall: (stall: Stall) => void;
}

export function createStallWatchdog(deps: StallWatchdogDeps): () => void {
  // Null while hidden: the next visible tick only re-arms.
  let last: number | null = deps.isVisible() ? deps.now() : null;
  return deps.every(() => {
    const now = deps.now();
    if (!deps.isVisible()) {
      last = null;
      return;
    }
    if (last !== null) {
      const stalledMs = now - last - deps.intervalMs;
      if (stalledMs >= deps.thresholdMs) {
        deps.onStall({
          stalledMs,
          startedAt: new Date(last + deps.intervalMs).toISOString(),
          endedAt: new Date(now).toISOString(),
        });
      }
    }
    last = now;
  });
}

/** The stall worth recording usually outlasts the socket, so the first write lands on a dead connection. */
export async function writeWithRetry(
  write: () => Promise<unknown>,
  opts: { retryMs: number; attempts: number },
): Promise<boolean> {
  for (let i = 0; i < opts.attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, opts.retryMs));
    try {
      await write();
      return true;
    } catch {
      // next attempt
    }
  }
  return false;
}

export function stallContext(): Record<string, unknown> {
  const { tabs, activeTabId } = TabPersistenceService.loadTabs();
  const sessions = useClaudeSessionStore.getState().tabs;
  const active = tabs.find((t) => t.id === activeTabId);
  return {
    activeTab: active
      ? { id: active.id, type: active.type, title: active.title, sessionId: active.sessionId ?? null }
      : null,
    tabMessages: Object.entries(sessions)
      .map(([id, s]) => ({ id, messages: s.messages.length }))
      .sort((a, b) => b.messages - a.messages),
  };
}

export function installStallWatchdog(): () => void {
  return createStallWatchdog({
    intervalMs: 500,
    thresholdMs: 2000,
    now: () => Date.now(),
    every: (fn) => {
      const id = setInterval(fn, 500);
      return () => { clearInterval(id); };
    },
    isVisible: () => document.visibilityState === 'visible',
    onStall: (stall) => {
      const entry = {
        timestamp: stall.endedAt,
        level: 'warn',
        source: 'frontend',
        category: 'renderer-stall',
        message: `renderer main thread stalled ${(stall.stalledMs / 1000).toFixed(1)}s`,
        metadata: JSON.stringify({ ...stall, ...stallContext() }),
      };
      void writeWithRetry(() => api.logWriteBatch([entry]), { retryMs: 2000, attempts: 15 });
    },
  });
}
