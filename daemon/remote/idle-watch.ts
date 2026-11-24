export const IDLE_CHECK_MS = 5_000;

export const IDLE_GRACE_MS = 30_000;
export const STARTUP_GRACE_MS = 120_000;

export interface IdleWatch {
  check(nowMs: number): boolean;
}

// A daemon must not outlive its app: a leftover keeps an old build and stale macOS permission grants.
// `everConnected` is the server's record, never inferred from samples: a 5 s tick misses a 2 s client.
// Never exit mid-turn (a reloading app looks disconnected), nor before the first client could connect.
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

/** Excludes turns waiting on the user: with no client nobody answers, and counting them kept orphaned daemons alive. */
export function progressingTurns(sessions: readonly { inFlight: boolean; pendingPermissions: number }[]): number {
  return sessions.filter((s) => s.inFlight && s.pendingPermissions === 0).length;
}
