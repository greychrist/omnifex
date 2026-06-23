/**
 * Tracks in-flight `control_request`s awaiting their matching `control_response`
 * from the CLI, with a hard timeout so a never-arriving response can't hang the
 * awaiting promise forever.
 *
 * Background: control requests (`get_context_usage`, `set_model`, `interrupt`,
 * …) are fire-a-line-and-await-a-response over the CLI's stream-json stdin/
 * stdout. If the CLI never answers — an unsupported subtype, a request dropped
 * while it's mid-turn, an engine that died — the awaiting promise used to sit
 * pending indefinitely. That surfaced as `Error invoking remote method
 * 'session_context_usage': reply was never sent` once the renderer reloaded with
 * the IPC handler still awaiting. Every pending request now self-rejects after
 * `timeoutMs`, and `failAll` rejects the lot on engine exit, so callers always
 * settle and the renderer falls back cleanly.
 *
 * Pure and child-process-free so the timeout/settle lifecycle is unit-testable
 * with fake timers, independent of a spawned CLI.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ControlRequestRegistry {
  /**
   * Register a pending request and return a promise that settles when the CLI
   * responds (`settle`/`fail`), the request times out, or the engine exits
   * (`failAll`). `subtype` is only used to make the timeout error legible.
   */
  create<T = unknown>(id: string, subtype?: string): Promise<T>;
  /** Resolve a pending request by id (from a non-error `control_response`). */
  settle(id: string, value: unknown): void;
  /** Reject a single pending request by id (e.g. an error `control_response`). */
  fail(id: string, err: Error): void;
  /** Reject every in-flight request — used when the engine exits. */
  failAll(err: Error): void;
  /** Count of in-flight requests. */
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
    create<T = unknown>(id: string, subtype?: string): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (drop(id)) {
            reject(
              new Error(
                `control_request${subtype ? ` '${subtype}'` : ''} timed out after ${timeoutMs}ms`,
              ),
            );
          }
        }, timeoutMs);
        // Don't keep the event loop alive solely for a control-request timeout.
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
