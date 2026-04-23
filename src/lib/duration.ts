/**
 * Format a duration in milliseconds as a human-readable string.
 *
 *   950       → "0.95s"
 *   45230     → "45.23s"
 *   75550     → "1m 15.55s"
 *   3605000   → "1h 0m 5.00s"
 *
 * Seconds always carry two decimals so fast tool calls don't read as "0.00s".
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0.00s';

  const totalSeconds = ms / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds - hours * 3600) / 60);
  const seconds = totalSeconds - hours * 3600 - minutes * 60;
  const secondsStr = seconds.toFixed(2);

  if (hours > 0) return `${hours}h ${minutes}m ${secondsStr}s`;
  if (minutes > 0) return `${minutes}m ${secondsStr}s`;
  return `${secondsStr}s`;
}
