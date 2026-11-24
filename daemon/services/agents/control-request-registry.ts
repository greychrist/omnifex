const DEFAULT_TIMEOUT_MS = 10_000;

interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ControlRequestRegistry {
  create<T = unknown>(id: string, subtype?: string, timeoutMs?: number): Promise<T>;
  settle(id: string, value: unknown): void;
  fail(id: string, err: Error): void;
  failAll(err: Error): void;
  size(): number;
}

export function createControlRequestRegistry(opts?: {
  timeoutMs?: number;
}): ControlRequestRegistry {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = new Map<string, PendingEntry>();

  function drop(id: string): PendingEntry | undefined {
    const entry = pending.get(id);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    pending.delete(id);
    return entry;
  }

  return {
    create<T = unknown>(id: string, subtype?: string, perCallTimeoutMs?: number): Promise<T> {
      const ms = perCallTimeoutMs ?? timeoutMs;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (drop(id)) {
            reject(
              new Error(
                `control_request${subtype ? ` '${subtype}'` : ''} timed out after ${ms}ms`,
              ),
            );
          }
        }, ms);
        if (typeof timer.unref === 'function') timer.unref();
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      });
    },

    settle(id: string, value: unknown): void {
      drop(id)?.resolve(value);
    },

    fail(id: string, err: Error): void {
      drop(id)?.reject(err);
    },

    failAll(err: Error): void {
      for (const id of [...pending.keys()]) {
        drop(id)?.reject(err);
      }
    },

    size(): number {
      return pending.size;
    },
  };
}
