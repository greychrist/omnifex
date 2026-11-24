// Not in periodic-work.ts: the dev daemon needs it too and must not obey that gate.

export interface TailnetWatchDeps {
  detect(): string | null;
  listening(): readonly string[];
  addHost(host: string): Promise<boolean>;
  log: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

export interface TailnetWatch {
  check(): Promise<void>;
}

export function createTailnetWatch(deps: TailnetWatchDeps): TailnetWatch {
  return {
    async check() {
      const host = deps.detect();
      if (!host || deps.listening().includes(host)) return;
      if (await deps.addHost(host)) deps.log.info('now listening on the tailnet address', { host });
      else deps.log.warn('could not listen on the tailnet address', { host });
    },
  };
}
