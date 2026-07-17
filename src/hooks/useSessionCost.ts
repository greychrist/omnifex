import { useEffect, useState } from 'react';
import { api, type SessionCostSnapshot } from '@/lib/api';

/**
 * Live computed session cost for cost-based accounts. Starts a main-process
 * watcher over the session's JSONL (+ subagents), seeds from the watch
 * response, then follows `session-cost:<sessionId>` push events. Cleans up
 * watcher + listener on unmount / arg change.
 */
export function useSessionCost(args: {
  enabled: boolean;
  configDir?: string;
  projectPath?: string;
  sessionId?: string | null;
  accountName?: string;
}): SessionCostSnapshot | null {
  const { enabled, configDir, projectPath, sessionId, accountName } = args;
  const [snapshot, setSnapshot] = useState<SessionCostSnapshot | null>(null);

  useEffect(() => {
    if (!enabled || !configDir || !projectPath || !sessionId || !accountName) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    api
      .sessionCostWatch(configDir, projectPath, sessionId, accountName)
      .then((snap) => {
        if (!cancelled && snap) setSnapshot(snap);
      })
      .catch(() => {});
    const unlisten = window.electronAPI.onEvent(
      `session-cost:${sessionId}`,
      (...eventArgs: unknown[]) => {
        const payload = eventArgs[0] as SessionCostSnapshot | undefined;
        if (payload && typeof payload.totalUsd === 'number') setSnapshot(payload);
      },
    );
    return () => {
      cancelled = true;
      unlisten();
      void api.sessionCostUnwatch(sessionId).catch(() => {});
    };
  }, [enabled, configDir, projectPath, sessionId, accountName]);

  return snapshot;
}
