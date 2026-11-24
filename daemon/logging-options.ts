import type { LogEntry, LoggingServiceOptions } from './services/logging';

export interface LoggingOptionsDeps {
  db: { getSetting(key: string): string | null | undefined };
  sendToRenderer: (channel: string, payload: unknown) => void;
}

export function createLoggingOptions(
  deps: LoggingOptionsDeps,
): Required<Pick<LoggingServiceOptions, 'shouldAccept' | 'onError'>> {
  return {
    shouldAccept: (entry: LogEntry) => {
      if (entry.level !== 'info' && entry.level !== 'debug') return true;
      if (entry.source === 'claude-hooks') {
        return deps.db.getSetting('log_verbose_claude_hooks') === 'true';
      }
      if (entry.source === 'usage-runner') {
        return deps.db.getSetting('log_verbose_usage_runner') === 'true';
      }
      return true;
    },
    onError: (entry: LogEntry) => {
      // Default ON: a missing setting (fresh install) still toasts.
      if (deps.db.getSetting('log_error_toast_enabled') === 'false') return;
      deps.sendToRenderer('log-error', {
        source: entry.source,
        message: entry.message,
        category: entry.category ?? null,
        level: entry.level,
        timestamp: entry.timestamp,
      });
    },
  };
}
