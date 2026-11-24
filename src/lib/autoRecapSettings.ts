// Shared with the daemon's auto-recap scheduler, so keys and defaults are stated once.
export const AUTO_RECAP_ENABLED_KEY = 'sessions.autoRecap.enabled';
export const AUTO_RECAP_DELAY_KEY = 'sessions.autoRecap.delayMinutes';
export const DEFAULT_AUTO_RECAP_MINUTES = 10;

export function autoRecapEnabled(stored: string | null): boolean {
  return stored !== 'false';
}

export function autoRecapMinutes(stored: string | null): number {
  const minutes = Number(stored);
  return stored !== null && Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_AUTO_RECAP_MINUTES;
}
