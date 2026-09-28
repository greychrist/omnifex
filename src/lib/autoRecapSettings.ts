/**
 * Auto-recap settings, shared by the renderer's Settings panel and main's
 * scheduler (`electron/services/sessions/auto-recap.ts`) so the keys and
 * defaults are stated once.
 */
export const AUTO_RECAP_ENABLED_KEY = 'sessions.autoRecap.enabled';
export const AUTO_RECAP_DELAY_KEY = 'sessions.autoRecap.delayMinutes';
export const DEFAULT_AUTO_RECAP_MINUTES = 5;

/** On unless explicitly switched off. */
export function autoRecapEnabled(stored: string | null): boolean {
  return stored !== 'false';
}

/** The stored delay, or the default for anything that is not a positive number. */
export function autoRecapMinutes(stored: string | null): number {
  const minutes = Number(stored);
  return stored !== null && Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_AUTO_RECAP_MINUTES;
}
