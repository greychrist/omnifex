/**
 * The Settings tab's starting panel, handed over through sessionStorage.
 *
 * `App.tsx` seeds this when the user presses "View in Log" on an error toast,
 * because the Settings tab may not exist yet: `createSettingsTab()` schedules a
 * mount, and the `log:focus-error-view` event that covers the warm case fires
 * before a lazily-loaded `Settings` chunk has finished loading. The seed is
 * what survives that gap.
 *
 * Reading is deliberately PURE — it does not consume the seed. It used to,
 * inside a `useState` initializer, which React StrictMode breaks by design: it
 * invokes initializers twice, so the first call deleted the key and the second
 * fell back to the default. The button appeared to ignore the request and
 * opened Settings on General. Consuming the seed is now an explicit act, done
 * from an effect once the component is actually mounted.
 */
export const SETTINGS_INITIAL_TAB_KEY = 'omnifex:settings-initial-tab';

/** The panel Settings should open on. `general` when nothing was handed over. */
export function readInitialSettingsTab(): string {
  try {
    return window.sessionStorage.getItem(SETTINGS_INITIAL_TAB_KEY) ?? 'general';
  } catch {
    // Private mode, an opaque origin, a hardened renderer. The handoff is a
    // convenience; losing it must never cost the Settings tab.
    return 'general';
  }
}

/** Hand Settings a starting panel for its next mount. */
export function seedInitialSettingsTab(tab: string): void {
  try {
    window.sessionStorage.setItem(SETTINGS_INITIAL_TAB_KEY, tab);
  } catch {
    // Falls back to the event path, which covers an already-mounted Settings.
  }
}

/**
 * Consume the seed, so it cannot hijack a later, unrelated mount.
 *
 * Idempotent: StrictMode runs mount effects twice, and the warm path clears it
 * again from the event handler.
 */
export function clearInitialSettingsTab(): void {
  try {
    window.sessionStorage.removeItem(SETTINGS_INITIAL_TAB_KEY);
  } catch {
    // Nothing was stored either.
  }
}
