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
