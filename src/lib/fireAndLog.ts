/**
 * Fire-and-forget wrapper for async work hosted by call sites that
 * expect a `void`-returning function (JSX event handlers, addEventListener,
 * setTimeout / setInterval). Keeps `@typescript-eslint/no-misused-promises`
 * happy AND eliminates today's silent-rejection risk where a rejected
 * Promise from `<button onClick={async () => …}>` only reached the Log
 * tab via the browser's "Uncaught (in promise)" fallback path.
 *
 * The renderer-side `LogService` (initialized at app entry in
 * `src/main.tsx`) wraps `console.error` and pipes every call into
 * `app_logs` via `api.logWriteBatch`. So `console.error('[label]', err)`
 * inside the catch lands in the Log tab as a structured frontend-source
 * error entry — labeled, attributed, and indexable. No need to thread a
 * dedicated logger through every call site.
 *
 * Usage:
 *
 *   <button onClick={fireAndLog('account-save', () => saveAccount(form))}>
 *     Save
 *   </button>
 *
 *   addEventListener('keydown', fireAndLog('keymap-load', loadKeymaps));
 *
 *   setInterval(fireAndLog('heartbeat', sendHeartbeat), 5000);
 *
 * Compared to inline `() => { void doX().catch(console.error); }`:
 *   - One short call instead of an inline arrow + brace + void + catch.
 *   - The label is mandatory and shows up in the Log tab as
 *     `[label] <err message>` — so a future reader can tell the source
 *     of every leaked rejection without grepping for the catch site.
 *   - Centralized: if we later want to add a Sentry-style breadcrumb,
 *     a toast hook, or a per-action retry policy, this is the single
 *     place to wire it.
 */
export function fireAndLog<TArgs extends unknown[]>(
  label: string,
  fn: ((...args: TArgs) => Promise<unknown> | void) | undefined,
): (...args: TArgs) => void {
  return (...args: TArgs) => {
    if (!fn) return;
    const result = fn(...args);
    // Tolerate sync-returning callers (a Promise is the only thing the
    // rule actually cares about); only attach a .catch when one exists.
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        // LogService captures console.error → app_logs (frontend / error).
        console.error(`[${label}]`, err);
      });
    }
  };
}
