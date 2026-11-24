import { useCallback, useEffect, useState } from 'react';
import { api, type SessionPluginInfo } from '@/lib/api';
import { logAndForget } from '@/lib/fireAndLog';

/** Before any init, main can only answer by sending reload_plugins, which re-runs every mod's session.start. */
export function useSessionPlugins(
  tabId: string,
  reloadKey: string,
  enabled: boolean,
): { plugins: SessionPluginInfo[] | null; refresh: () => void } {
  const [plugins, setPlugins] = useState<SessionPluginInfo[] | null>(null);

  const load = useCallback(async (force: boolean) => {
    try {
      setPlugins((await api.sessionPlugins(tabId, force)) ?? []);
    } catch (err) {
      console.error('[useSessionPlugins] failed to load plugins:', err);
      setPlugins([]);
    }
  }, [tabId]);

  useEffect(() => {
    if (!enabled) return;
    logAndForget('session-plugins:load', load(false));
  }, [enabled, reloadKey, load]);

  const refresh = useCallback(() => {
    setPlugins(null);
    logAndForget('session-plugins:refresh', load(true));
  }, [load]);

  return { plugins, refresh };
}
