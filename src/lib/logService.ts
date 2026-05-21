import { api, type LogEntry } from './api';
import { logAndForget } from "@/lib/fireAndLog";

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const FLUSH_INTERVAL_MS = 2000;
const FLUSH_BATCH_SIZE = 50;

// Patterns to filter out noisy messages
const NOISE_PATTERNS = [
  /Download the React DevTools/,
  /\[HMR\]/,
  /\[vite\]/,
  /Warning: ReactDOM\.render is no longer supported/,
  /act\(\) is not supported in production/,
  /AnimatePresence.*mode is set to "wait"/,
  /\[PostHog\.js\]/,
];

// Plain `JSON.stringify(new Error('boom'))` returns `'{}'` because
// Error.message and Error.stack are non-enumerable. That dropped every
// stream-render exception on the floor and made the renderer's runaway-CPU
// regression invisible. Format Errors explicitly at the top level and via a
// replacer so nested Errors also surface.
function formatError(e: Error): string {
  const head = `${e.name}: ${e.message}`;
  return e.stack ? `${head}\n${e.stack}` : head;
}

export function formatLogArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return formatError(a);
      return JSON.stringify(a, (_key, value) =>
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

    // Wrap console methods
    console.error = (...args: any[]) => {
      this.originalConsole.error(...args);
      this.captureConsole('error', args);
    };
    console.warn = (...args: any[]) => {
      this.originalConsole.warn(...args);
      this.captureConsole('warn', args);
    };
    console.info = (...args: any[]) => {
      this.originalConsole.info(...args);
      this.captureConsole('info', args);
    };
    console.debug = (...args: any[]) => {
      this.originalConsole.debug(...args);
      this.captureConsole('debug', args);
    };

    // Listen for backend log events
    try {
      this.backendLogUnlisten = window.electronAPI.onEvent('backend-log', (payload: any) => {
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

    // Start periodic flush. We can't import fireAndLog here because this
    // service IS the logging substrate fireAndLog calls into; instead,
    // catch the rejection inline so a failed flush doesn't bubble out
    // and re-trigger a console.error → captureConsole loop.
    this.flushTimer = setInterval(() => {
      this.flush().catch((err: unknown) => {
        // Use the original (un-wrapped) console.error so we don't
        // re-enter capture and cause a feedback loop.
        this.originalConsole.error('[logService] flush failed:', err);
      });
    }, FLUSH_INTERVAL_MS);
  }

  private captureConsole(level: LogLevel, args: any[]): void {
    const message = formatLogArgs(args);

    // Filter noise
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
