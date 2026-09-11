/**
 * How the log store decides what to keep and what to toast.
 *
 * Shared because both composition roots build a `LoggingService` and both need
 * the same two predicates — `electron/main.ts` kept the reasoning in comments
 * and `electron/remote/daemon.ts` carried the same code with every one of them
 * stripped. See `periodic-work.ts` for why that arrangement is a hazard rather
 * than a style choice.
 *
 * Both predicates read `app_settings` live on every entry, so toggling a
 * switch in the Log tab takes effect without a restart.
 */

import type { LogEntry, LoggingServiceOptions } from './services/logging';

export interface LoggingOptionsDeps {
  db: { getSetting(key: string): string | null | undefined };
  sendToRenderer: (channel: string, payload: unknown) => void;
}

export function createLoggingOptions(
  deps: LoggingOptionsDeps,
): Required<Pick<LoggingServiceOptions, 'shouldAccept' | 'onError'>> {
  return {
    /**
     * Defaults are "off" for the two noisy sources: info and debug entries
     * from the Claude hooks and the usage runner are dropped unless the user
     * opts in. Warn and error always pass through.
     */
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
      // Default is ON. Only suppress when the user has explicitly set the
      // toggle to 'false' — a missing setting (fresh install) still toasts.
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
