// Canonical taxonomy for the app log stream (main process).
//
// Every call site that writes a log entry must use a value from
// LOG_SOURCES and LOG_LEVELS. The renderer mirrors this list in
// `src/lib/logSources.ts` so the LogTab dropdown stays in sync; the
// drift-detector test in `src/lib/__tests__/logSources.drift.test.ts`
// asserts the two arrays are identical.
//
// Adding a new source: add it here, add it to the renderer mirror, and
// the drift test will keep them aligned.

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
