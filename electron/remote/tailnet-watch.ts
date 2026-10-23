/**
 * Listen on the tailnet address once it exists.
 *
 * The daemon picks its address at startup: the tailnet one if Tailscale is
 * up, else loopback. Launched before Tailscale (login at boot, an update's
 * relaunch while it reconnects), it took loopback alone and the iPad lost it
 * until the next restart (2026-10-23). The Mac app was fine — it loads from
 * loopback anyway — which is how it went unnoticed. The launcher's half of
 * the same fix is `probeDaemon` in launcher.ts.
 *
 * A server-transport concern, not database work, so it is not in
 * periodic-work.ts: the dev daemon wants it too, and it has no gate to obey.
 */

export interface TailnetWatchDeps {
  /** The tailnet address now, or null (`detectTailscaleIp`). */
  detect(): string | null;
  /** Addresses being served (`RemoteServer.hosts`). */
  listening(): readonly string[];
  addHost(host: string): Promise<boolean>;
  log: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

export interface TailnetWatch {
  /** Call on a timer. */
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
