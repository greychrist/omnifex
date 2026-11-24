import { api, type LogEntry } from './api';
import { logAndForget } from "@/lib/fireAndLog";

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const FLUSH_INTERVAL_MS = 2000;
const FLUSH_BATCH_SIZE = 50;

const NOISE_PATTERNS = [
  /Download the React DevTools/,
  /\[HMR\]/,
  /\[vite\]/,
  /Warning: ReactDOM\.render is no longer supported/,
  /act\(\) is not supported in production/,
  /AnimatePresence.*mode is set to "wait"/,
  /\[PostHog\.js\]/,
];

// Error.message and .stack are non-enumerable, so JSON.stringify(err) is '{}'; format Errors explicitly.
function formatError(e: Error): string {
  const head = `${e.name}: ${e.message}`;
  return e.stack ? `${head}\n${e.stack}` : head;
}

export function formatLogArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return formatError(a);
      return JSON.stringify(a, (_key: string, value: unknown) =>
        value instanceof Error
          ? { name: value.name, message: value.message, stack: value.stack }
          : value,
      );
    })
    .join(' ');
}

class LogService {
  private static instance: LogService;
  private buffer: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private originalConsole: {
    error: typeof console.error;
    warn: typeof console.warn;
    info: typeof console.info;
    debug: typeof console.debug;
  };
  private initialized = false;
  private backendLogUnlisten: (() => void) | null = null;

  private constructor() {
    this.originalConsole = {
      error: console.error.bind(console),
      warn: console.warn.bind(console),
      info: console.info.bind(console),
      debug: console.debug.bind(console),
    };
  }

  static getInstance(): LogService {
    if (!LogService.instance) {
      LogService.instance = new LogService();
    }
    return LogService.instance;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    console.error = (...args: unknown[]) => {
      this.originalConsole.error(...args);
      this.captureConsole('error', args);
    };
    console.warn = (...args: unknown[]) => {
      this.originalConsole.warn(...args);
      this.captureConsole('warn', args);
    };
    console.info = (...args: unknown[]) => {
      this.originalConsole.info(...args);
      this.captureConsole('info', args);
    };
    console.debug = (...args: unknown[]) => {
      this.originalConsole.debug(...args);
      this.captureConsole('debug', args);
    };

    try {
      this.backendLogUnlisten = window.electronAPI.onEvent('backend-log', (payload: unknown) => {
        const { level, category, message, timestamp } = payload as {
          level: string;
          category: string;
          message: string;
          timestamp: string;
        };
        this.addEntry({
          timestamp,
          level,
          source: 'backend',
          category,
          message,
        });
      });
    } catch {
      // electronAPI not available — skip backend events
    }

    // Not fireAndLog: this service is its substrate, and a failed flush must not re-enter console capture.
    this.flushTimer = setInterval(() => {
      this.flush().catch((err: unknown) => {
        this.originalConsole.error('[logService] flush failed:', err);
      });
    }, FLUSH_INTERVAL_MS);
  }

  private captureConsole(level: LogLevel, args: unknown[]): void {
    const message = formatLogArgs(args);

    if (NOISE_PATTERNS.some((p) => p.test(message))) return;

    this.addEntry({
      timestamp: new Date().toISOString(),
      level,
      source: 'frontend',
      message,
    });
  }

  private addEntry(entry: LogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length >= FLUSH_BATCH_SIZE) {
      logAndForget('log-service:flush', this.flush());
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    try {
      await api.logWriteBatch(batch);
    } catch {
      // If write fails, don't re-buffer to avoid infinite loops
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.backendLogUnlisten) {
      this.backendLogUnlisten();
      this.backendLogUnlisten = null;
    }
    await this.flush();
  }
}

export const logService = LogService.getInstance();
