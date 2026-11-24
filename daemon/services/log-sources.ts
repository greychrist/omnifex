// Mirrored in src/lib/logSources.ts; a drift test holds the two identical.

export const LOG_SOURCES = [
  'frontend',
  'backend',
  'claude-sdk',
  'claude-hooks',
  'usage',
  'usage-runner',
  'updater',
  'rate-limits',
] as const;

export type LogSource = (typeof LOG_SOURCES)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
