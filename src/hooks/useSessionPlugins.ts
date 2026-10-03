import { useCallback, useEffect, useState } from 'react';
import { api, type SessionPluginInfo } from '@/lib/api';
import { logAndForget } from '@/lib/fireAndLog';

/**
 * The session's plugin list, mods included — shared by the Session context
 * panel and the context popover's summary row, so one fetch serves both.
 *
 * A change of `reloadKey` fetches again. The caller keys it on the session
 * having an init and on the panel opening, so opening the panel after a
 * restart shows the restarted process's list. `enabled` gates the first fetch — before any init, main can only
 * answer by sending reload_plugins, which re-runs every mod's session.start,
 * so it waits until there is an init or the panel is actually open.
 */
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
