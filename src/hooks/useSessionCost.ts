import { useEffect, useState } from 'react';
import { api, type SessionCostSnapshot } from '@/lib/api';

export function useSessionCost(args: {
  configDir?: string;
  projectPath?: string;
  sessionId?: string | null;
  accountName?: string;
}): SessionCostSnapshot | null {
  const { configDir, projectPath, sessionId, accountName } = args;
  const [snapshot, setSnapshot] = useState<SessionCostSnapshot | null>(null);

  useEffect(() => {
    if (!configDir || !projectPath || !sessionId || !accountName) {
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
  }, [configDir, projectPath, sessionId, accountName]);

  return snapshot;
}
