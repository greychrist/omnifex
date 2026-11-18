/**
 * When a daemon with no app should exit. See `createIdleWatch`.
 */

/** How often the daemon asks. */
export const IDLE_CHECK_MS = 5_000;

/** Quiet period before an unattended daemon shuts itself down. */
export const IDLE_GRACE_MS = 30_000;
/** How long a daemon waits for its first client before calling it a day. */
export const STARTUP_GRACE_MS = 120_000;

export interface IdleWatch {
  /** True when the daemon should shut down. Call it on a timer. */
  check(nowMs: number): boolean;
}

/**
 * Every daemon's dead-man's switch.
 *
 * A daemon must not outlive the app that spawned it (see
 * docs/superpowers/specs/2026-11-18-daemon-dies-with-app-design.md): a
 * leftover holds an old build and the permissions macOS granted before it
 * started. The app stops it on quit, and `ensure` runs inside the app's
 * process group so the daemon lands there too (`LauncherProcessGroup` in
 * macos/; Foundation's `Process` would give `ensure` a fresh group). Neither
 * survives the app being killed outright or crashing. This does: no client
 * attached, nothing running, no reason to still be here.
 *
 * `everConnected` is the server's own record, not something inferred from
 * successive `clients` samples. A 5s tick missed a client that was attached
 * for 2s, and the watch then sat forever waiting for a first connection it
 * had already slept through.
 *
 * Two things it will not do. It will not exit while a turn is in flight: a
 * disconnected client with a running CLI is the app being reloaded or
 * restarted, and 30 more seconds of daemon is cheaper than a killed turn —
 * the clock starts when the turn ends. And it will not exit in the first
 * couple of minutes of a launch nobody has connected to yet, because the
 * daemon is listening a second before the app's socket arrives. Past that
 * window an unvisited daemon is one whose app never made it, so it goes.
 */
export function createIdleWatch(opts: {
  clients: () => number;
  inFlight: () => number;
  everConnected: () => boolean;
  startedAt: number;
  graceMs?: number;
  startupMs?: number;
}): IdleWatch {
  const graceMs = opts.graceMs ?? IDLE_GRACE_MS;
  const startupMs = opts.startupMs ?? STARTUP_GRACE_MS;
  let idleSince: number | null = null;
  return {
    check(nowMs) {
      if (opts.clients() > 0 || opts.inFlight() > 0) {
        idleSince = null;
        return false;
      }
      if (!opts.everConnected()) {
        idleSince = null;
        return nowMs - opts.startedAt >= startupMs;
      }
      if (idleSince === null) {
        idleSince = nowMs;
        return false;
      }
      return nowMs - idleSince >= graceMs;
    },
  };
}
