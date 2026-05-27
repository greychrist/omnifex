import React, { createContext, useContext, useEffect, useState } from 'react';
import { api, type AppCapabilities } from '@/lib/api';
import { logAndForget } from '@/lib/fireAndLog';

/**
 * Renderer-side cache of the main process's static feature flags. The
 * Codex gate lives here so every Codex-aware surface (AgentPicker in
 * NewSessionForm, the Codex section in AccountSettings, the Codex
 * partition in SessionList) can branch on `useAppCapabilities()` instead
 * of doing its own IPC round-trip.
 *
 * The defaults are intentionally restrictive: `codexEnabled` starts
 * `false` so that the first render — before the IPC resolves — hides
 * Codex surfaces. The provider fetches once on mount and updates state
 * on success. Failures keep the safe default.
 *
 * The flag is read ONCE per app startup main-side (via
 * `process.env.OMNIFEX_ENABLE_CODEX === '1'`), so no hot-reload is
 * supported — restart the app to flip it.
 */
const AppCapabilitiesContext = createContext<AppCapabilities>({
  codexEnabled: false,
});

export const AppCapabilitiesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [capabilities, setCapabilities] = useState<AppCapabilities>({
    codexEnabled: false,
  });

  useEffect(() => {
    let cancelled = false;
    logAndForget(
      'app-capabilities:fetch',
      api
        .getAppCapabilities()
        .then((caps) => {
          if (cancelled) return;
          setCapabilities(caps);
        })
        .catch(() => {
          // Silent fallback: keep the restrictive defaults if the IPC
          // call fails. Worst case the user sees a Claude-only UI and
          // an error in the log; never the inverse (Codex surfaces
          // rendered against a backend that isn't ready).
        }),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AppCapabilitiesContext.Provider value={capabilities}>
      {children}
    </AppCapabilitiesContext.Provider>
  );
};

/**
 * Read the current `AppCapabilities` snapshot. Safe to call outside a
 * provider — falls back to the restrictive defaults (Codex disabled)
 * so component tests and storybook stories don't have to mount the
 * provider just to render Claude-only surfaces.
 */
export function useAppCapabilities(): AppCapabilities {
  return useContext(AppCapabilitiesContext);
}

/**
 * Exported for test harnesses that need to override the value with
 * `<AppCapabilitiesContext.Provider value={...}>`.
 */
export { AppCapabilitiesContext };
