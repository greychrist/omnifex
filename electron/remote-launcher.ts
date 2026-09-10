/**
 * Electron main's view of the daemon: is it up, is it *this* build, and if
 * not, make it so.
 *
 * The daemon is spawned DETACHED and unref'd. That is the entire point of the
 * split — quit Electron mid-turn, the CLI keeps running, reopen and catch up
 * — so the daemon must outlive the window that started it. launchd is the
 * proper owner (`omnifex-server install`); this is the fallback for a machine
 * where nobody has run that yet.
 *
 * Because it outlives the app, it also outlives an *upgrade*: install a new
 * OmniFex, launch it, and the daemon answering on the port is still the old
 * build. Nothing in the protocol would catch that (same protocol version,
 * different code). So the app that launches wins: a daemon reporting another
 * version is replaced — at once when it has no turn in flight, otherwise the
 * app attaches to it for now and checks back until it is idle. Nobody has to
 * run a script.
 *
 * Pure with respect to I/O: probing, spawning, stopping and sleeping are
 * injected, so the decision logic is unit-testable without a socket or a
 * child process.
 */
import type { ServerConfig } from './remote/config';

/** What the launcher needs from `GET /healthz`. */
export interface DaemonHealth {
  version: string;
  /** Sessions with a prompt currently running. */
  inFlight: number;
}

export interface RemoteLauncherDeps {
  /** Read fresh each time: `~/.omnifex/server.json` may change between calls. */
  config: () => ServerConfig;
  /** Parsed `/healthz`, or null when nothing answers. */
  probe: (healthUrl: string) => Promise<DaemonHealth | null>;
  /** Start the daemon in the background. Must not throw for a missing script — return false. */
  spawn: (config: ServerConfig) => boolean;
  /** Ask the running daemon to exit. False when there was no way to reach it. */
  stop: (config: ServerConfig) => Promise<boolean>;
  /** `app.getVersion()`; a daemon reporting anything else gets replaced. */
  appVersion: string;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a spawned daemon to answer, or a stopped one to go. */
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  /** How long to wait before re-checking an outdated daemon that was busy. */
  upgradeRetryMs?: number;
  schedule?: (fn: () => void, ms: number) => void;
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

/**
 * `/healthz` body → what the launcher compares on. Tolerant of an older
 * daemon that does not report `sessions.inFlight` yet: that reads as idle,
 * which is what makes it replaceable by the build that does.
 */
export function parseDaemonHealth(body: string): DaemonHealth | null {
  try {
    const h = JSON.parse(body) as { version?: unknown; sessions?: { inFlight?: unknown } };
    if (typeof h.version !== 'string') return null;
    const inFlight = Number(h.sessions?.inFlight ?? 0);
    return { version: h.version, inFlight: Number.isFinite(inFlight) ? inFlight : 0 };
  } catch {
    return null;
  }
}

export function createRemoteLauncher(deps: RemoteLauncherDeps): RemoteLauncher {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const startupTimeoutMs = deps.startupTimeoutMs ?? 10_000;
  const pollIntervalMs = deps.pollIntervalMs ?? 250;
  const upgradeRetryMs = deps.upgradeRetryMs ?? 30_000;
  const schedule =
    deps.schedule ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
    });
  const log = deps.log ?? (() => {});

  // One attempt at a time: every window asks on startup, and a second spawn
  // racing the first would only fail on the port and confuse the log.
  let inFlight: Promise<string | null> | null = null;
  let upgradeArmed = false;

  function armUpgradeCheck(): void {
    if (upgradeArmed) return;
    upgradeArmed = true;
    schedule(() => {
      upgradeArmed = false;
      void ensure();
    }, upgradeRetryMs);
  }

  /** Poll until `pred` holds or the startup window closes. */
  async function waitUntil(pred: () => Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      if (await pred()) return true;
    }
    return false;
  }

  async function attempt(): Promise<string | null> {
    let config: ServerConfig;
    try {
      config = deps.config();
    } catch (err) {
      log('remote config unreadable; using legacy IPC', { error: String(err) });
      return null;
    }
    const health = healthUrlFor(config);
    const ws = wsUrlFor(config);

    const running = await deps.probe(health);
    if (running) {
      if (running.version === deps.appVersion) {
        log('daemon already running', { health, version: running.version });
        return ws;
      }
      const versions = { running: running.version, app: deps.appVersion };
      if (running.inFlight > 0) {
        log('daemon is another build; replacing it once its turns finish', { ...versions, inFlight: running.inFlight });
        armUpgradeCheck();
        return ws;
      }
      log('daemon is another build and idle; replacing it', versions);
      if (!(await deps.stop(config))) {
        log('could not reach the running daemon to stop it; using it as is', versions);
        return ws;
      }
      if (!(await waitUntil(async () => (await deps.probe(health)) === null))) {
        log('daemon did not exit in time; using it as is', versions);
        return ws;
      }
    }

    if (!deps.spawn(config)) {
      log('daemon could not be spawned; using legacy IPC');
      return null;
    }
    if (await waitUntil(async () => (await deps.probe(health)) !== null)) {
      log('daemon started', { health });
      return ws;
    }
    log('daemon did not answer in time; using legacy IPC', { health, startupTimeoutMs });
    return null;
  }

  function ensure(): Promise<string | null> {
    if (!inFlight) {
      inFlight = attempt().finally(() => {
        // A null result is not cached: the next window (or a retry) probes
        // again, so a daemon started by hand a minute later is picked up.
        inFlight = null;
      });
    }
    return inFlight;
  }

  return { ensure };
}
