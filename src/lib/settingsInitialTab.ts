// Reading must not consume the seed (StrictMode runs useState initializers twice); clear it from an effect.
export const SETTINGS_INITIAL_TAB_KEY = 'omnifex:settings-initial-tab';

export function readInitialSettingsTab(): string {
  try {
    return window.sessionStorage.getItem(SETTINGS_INITIAL_TAB_KEY) ?? 'general';
  } catch {
    // A convenience; losing it must never cost the Settings tab.
    return 'general';
  }
}

export function seedInitialSettingsTab(tab: string): void {
  try {
    window.sessionStorage.setItem(SETTINGS_INITIAL_TAB_KEY, tab);
  } catch {
    // Falls back to the event path, which covers an already-mounted Settings.
  }
}

/** Idempotent: StrictMode runs mount effects twice. */
export function clearInitialSettingsTab(): void {
  try {
    window.sessionStorage.removeItem(SETTINGS_INITIAL_TAB_KEY);
  } catch {
    // Nothing was stored either.
  }
}
