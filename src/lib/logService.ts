import { api, type LogEntry } from './api';

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
  /Failed to set up Tauri drag-drop listener/,
];

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
  private tauriUnlisten: (() => void) | null = null;

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
      const { listen } = await import('@tauri-apps/api/event');
      this.tauriUnlisten = await listen('backend-log', (event: any) => {
        const payload = event.payload as {
          level: string;
          category: string;
          message: string;
          timestamp: string;
        };
        this.addEntry({
          timestamp: payload.timestamp,
          level: payload.level,
          source: 'backend',
          category: payload.category,
          message: payload.message,
        });
      });
    } catch {
      // Not in Tauri environment (web mode) — skip backend events
    }

    // Start periodic flush
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  private captureConsole(level: LogLevel, args: any[]): void {
    const message = args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');

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
      this.flush();
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
    if (this.tauriUnlisten) {
      this.tauriUnlisten();
      this.tauriUnlisten = null;
    }
    await this.flush();
  }
}

export const logService = LogService.getInstance();
