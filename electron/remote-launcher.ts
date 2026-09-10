/**
 * Electron main's view of the daemon: is it up, and if not, start it.
 *
 * The daemon is spawned DETACHED and unref'd. That is the entire point of the
 * split — quit Electron mid-turn, the CLI keeps running, reopen and catch up
 * — so the daemon must outlive the window that started it. launchd is the
 * proper owner (`omnifex-server install`); this is the fallback for a machine
 * where nobody has run that yet.
 *
 * Pure with respect to I/O: probing, spawning and sleeping are injected, so
 * the decision logic (probe → spawn → poll → give up) is unit-testable without
 * a socket or a child process.
 */
import type { ServerConfig } from './remote/config';

export interface RemoteLauncherDeps {
  /** Read fresh each time: `~/.omnifex/server.json` may change between calls. */
  config: () => ServerConfig;
  /** True when GET /healthz answers 200. */
  probe: (healthUrl: string) => Promise<boolean>;
  /** Start the daemon in the background. Must not throw for a missing script — return false. */
  spawn: (config: ServerConfig) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a spawned daemon to answer. */
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface RemoteLauncher {
  /** The daemon's WebSocket URL, or null when it is not available. */
  ensure(): Promise<string | null>;
}

export function healthUrlFor(config: Pick<ServerConfig, 'host' | 'port'>): string {
  return `http://${config.host}:${config.port}/healthz`;
}

export function wsUrlFor(config: Pick<ServerConfig, 'host' | 'port'>): string {
  return `ws://${config.host}:${config.port}/ws`;
}

export function createRemoteLauncher(deps: RemoteLauncherDeps): RemoteLauncher {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const startupTimeoutMs = deps.startupTimeoutMs ?? 10_000;
  const pollIntervalMs = deps.pollIntervalMs ?? 250;
  const log = deps.log ?? (() => {});

  // One attempt at a time: every window asks on startup, and a second spawn
  // racing the first would only fail on the port and confuse the log.
  let inFlight: Promise<string | null> | null = null;

  async function attempt(): Promise<string | null> {
    let config: ServerConfig;
    try {
      config = deps.config();
    } catch (err) {
      log('remote config unreadable; using legacy IPC', { error: String(err) });
      return null;
    }
    const health = healthUrlFor(config);
    if (await deps.probe(health)) {
      log('daemon already running', { health });
      return wsUrlFor(config);
    }
    if (!deps.spawn(config)) {
      log('daemon could not be spawned; using legacy IPC');
      return null;
    }
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      if (await deps.probe(health)) {
        log('daemon started', { health });
        return wsUrlFor(config);
      }
    }
    log('daemon did not answer in time; using legacy IPC', { health, startupTimeoutMs });
    return null;
  }

  return {
    ensure() {
      if (!inFlight) {
        inFlight = attempt().finally(() => {
          // A null result is not cached: the next window (or a retry) probes
          // again, so a daemon started by hand a minute later is picked up.
          inFlight = null;
        });
      }
      return inFlight;
    },
  };
}
