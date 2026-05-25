// Canonical taxonomy for the app log stream (renderer mirror).
//
// Mirrors `electron/services/log-sources.ts`. Both files exist because
// the renderer Vite bundle can't import from the electron tree at
// runtime, but type-safety / single-source-of-truth is preserved by the
// drift-detector test in `__tests__/logSources.drift.test.ts`.

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

/**
 * Display labels and accent classes for the log dropdown / row chips.
 * Add an entry here when adding a new source — the LogTab generates its
 * dropdown from this map's keys.
 */
export const LOG_SOURCE_DISPLAY: Record<LogSource, { label: string; chipClass: string }> = {
  frontend: { label: 'Frontend', chipClass: 'bg-sky-500/20 text-sky-300' },
  backend: { label: 'Backend', chipClass: 'bg-slate-500/20 text-slate-300' },
  'claude-sdk': { label: 'Claude CLI', chipClass: 'bg-amber-500/20 text-amber-300' },
  'claude-hooks': { label: 'Claude Hooks', chipClass: 'bg-emerald-500/20 text-emerald-300' },
  usage: { label: 'Usage', chipClass: 'bg-purple-500/20 text-purple-300' },
  'usage-runner': { label: 'Usage Runner', chipClass: 'bg-violet-500/20 text-violet-300' },
  updater: { label: 'Updater', chipClass: 'bg-orange-500/20 text-orange-300' },
  'rate-limits': { label: 'Rate Limits', chipClass: 'bg-rose-500/20 text-rose-300' },
};
