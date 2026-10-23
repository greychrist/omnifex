/**
 * The app's view of the daemon: is it up, is it *this* build, and if not,
 * make it so. Run by `omnifex-server ensure|restart`, which the macOS app
 * calls at launch and from the Daemon popover's Restart button.
 *
 * The daemon is spawned DETACHED and unref'd. That is the entire point of the
 * split — quit the app mid-turn, the CLI keeps running, reopen and catch up
 * — so the daemon must outlive the window that started it. launchd is the
 * proper owner (`omnifex-server install`); this is the fallback for a machine
 * where nobody has run that yet.
 *
 * Because it outlives the app, it also outlives an *upgrade*: install a new
 * OmniFex, launch it, and the daemon answering on the port is still the old
 * build. Nothing in the protocol would catch that (same protocol version,
 * different code). So the app that launches wins: a daemon reporting another
 * version is replaced — at once when it has no turn in flight, otherwise the
 * app attaches to it for now (`outdated: true`) and asks again until it is
 * idle. Nobody has to run a script. The asking-again is the caller's: this
 * runs in a CLI process that exits once it has answered.
 *
 * Pure with respect to I/O: probing, spawning, stopping and sleeping are
 * injected, so the decision logic is unit-testable without a socket or a
 * child process.
 */
import { get as httpGet } from 'node:http';

import { isLoopbackHost, type ServerConfig } from './config';

/** What the launcher needs from `GET /healthz`. */
export interface DaemonHealth {
  version: string;
  /** Bundle stamp (script mtime), when the daemon reports one. */
  build?: string;
  /** Absolute path of the daemon script it is running, when it reports one. */
  script?: string;
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
  /** The app's version; a daemon reporting anything else gets replaced. */
  appVersion: string;
  /**
   * This bundle's stamp, dev only: the version never moves between `npm start`s,
   * so a same-version daemon with another stamp is stale too. Packaged builds
   * leave it undefined and compare versions alone. Defined ⇒ this is a dev
   * build, which is also what limits it to retiring its own daemon (below).
   */
  appBuild?: string;
  /**
   * Absolute path of the daemon script this bundle would spawn. A dev build
   * replaces only a daemon that reports this same path.
   */
  appScript?: string;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a spawned daemon to answer, or a stopped one to go. */
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface EnsureResult {
  /** The daemon's WebSocket URL, or null when it is not available. */
  url: string | null;
  /**
   * The daemon answering is another build, busy, and kept for now. The
   * caller asks again later; the first idle answer replaces it.
   */
  outdated: boolean;
}

export interface RemoteLauncher {
  ensure(): Promise<EnsureResult>;
  /**
   * Stop whatever daemon answers on the port — busy or not, the user asked —
   * and start this build's. The renderer's socket client reconnects on its
   * own once the new daemon is up.
   */
  restart(): Promise<EnsureResult>;
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
const LOOPBACK = '127.0.0.1';

/**
 * The URL for a client on this machine. A daemon on a tailnet address also
 * listens on loopback (`extraListenHosts`), and the Mac app must use that:
 * WebKit runs plain http on a non-loopback address in its EnhancedSecurity
 * process — no JIT, about 5x slower JavaScript — and denies it a secure
 * context, so no async clipboard either. Loopback is neither. An older daemon
 * that does not listen there keeps the configured URL.
 */
async function localUrl(
  result: EnsureResult,
  config: Pick<ServerConfig, 'host' | 'port'>,
  probe: (healthUrl: string) => Promise<DaemonHealth | null>,
): Promise<EnsureResult> {
  if (!result.url || isLoopbackHost(config.host)) return result;
  const loopback = { host: LOOPBACK, port: config.port };
  return (await probe(healthUrlFor(loopback))) ? { ...result, url: wsUrlFor(loopback) } : result;
}

export function parseDaemonHealth(body: string): DaemonHealth | null {
  try {
    const h = JSON.parse(body) as { version?: unknown; build?: unknown; script?: unknown; sessions?: { inFlight?: unknown } };
    if (typeof h.version !== 'string') return null;
    const inFlight = Number(h.sessions?.inFlight ?? 0);
    return {
      version: h.version,
      ...(typeof h.build === 'string' ? { build: h.build } : {}),
      ...(typeof h.script === 'string' ? { script: h.script } : {}),
      inFlight: Number.isFinite(inFlight) ? inFlight : 0,
    };
  } catch {
    return null;
  }
}

export function createRemoteLauncher(deps: RemoteLauncherDeps): RemoteLauncher {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const startupTimeoutMs = deps.startupTimeoutMs ?? 10_000;
  const pollIntervalMs = deps.pollIntervalMs ?? 250;
  const log = deps.log ?? (() => {});

  // One attempt at a time: a second spawn racing the first would only fail on
  // the port and confuse the log.
  let inFlight: Promise<EnsureResult> | null = null;

  const up = (url: string | null): EnsureResult => ({ url, outdated: false });

  /** Poll until `pred` holds or the startup window closes. */
  async function waitUntil(pred: () => Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      if (await pred()) return true;
    }
    return false;
  }

  /**
   * The daemon on `config`'s address, or else on loopback. A daemon started
   * before Tailscale came up listens on loopback only, while this computes
   * the tailnet address now; looking only there spawned a second daemon
   * beside the running one.
   */
  async function probeDaemon(config: ServerConfig): Promise<DaemonHealth | null> {
    const found = await deps.probe(healthUrlFor(config));
    if (found || isLoopbackHost(config.host)) return found;
    return deps.probe(healthUrlFor({ host: LOOPBACK, port: config.port }));
  }

  function readConfig(): ServerConfig | null {
    try {
      return deps.config();
    } catch (err) {
      log('remote config unreadable', { error: String(err) });
      return null;
    }
  }

  /**
   * Stop the running daemon and wait for the port to clear. Null once it is
   * gone; the ws url when it has to be kept as is (unreachable, or it ignored
   * the stop) — spawning onto an occupied port would only fail.
   */
  async function retire(config: ServerConfig, ws: string, meta: Record<string, unknown>): Promise<string | null> {
    if (!(await deps.stop(config))) {
      log('could not reach the running daemon to stop it; using it as is', meta);
      return ws;
    }
    if (!(await waitUntil(async () => (await probeDaemon(config)) === null))) {
      log('daemon did not exit in time; using it as is', meta);
      return ws;
    }
    return null;
  }

  async function launch(config: ServerConfig, ws: string): Promise<EnsureResult> {
    if (!deps.spawn(config)) {
      log('daemon could not be spawned');
      return up(null);
    }
    if (await waitUntil(async () => (await probeDaemon(config)) !== null)) {
      log('daemon started', { health: healthUrlFor(config) });
      return up(ws);
    }
    log('daemon did not answer in time', { health: healthUrlFor(config), startupTimeoutMs });
    return up(null);
  }

  async function attempt(): Promise<EnsureResult> {
    const config = readConfig();
    if (!config) return up(null);
    const health = healthUrlFor(config);
    const ws = wsUrlFor(config);

    const running = await probeDaemon(config);
    if (running) {
      // A dev build is a guest on this port. It shares `~/.omnifex` and the
      // DB with the INSTALLED app, whose daemon holds every live CLI process
      // the user has open — and which differs from the dev bundle in both
      // version and stamp, so every earlier rule said "replace it". `npm start`
      // therefore SIGTERM'd the installed app's daemon and killed its sessions
      // (2026-09-13). A dev build now retires only a daemon that reports the
      // very script it would spawn itself; anything else it attaches to, old
      // or new. The installed app keeps full authority over the port: it is
      // the product, and it must still replace its own daemon after an
      // upgrade even if the app moved.
      if (deps.appBuild !== undefined && running.script !== deps.appScript) {
        log('daemon belongs to another install; attaching to it instead of replacing it', {
          running: `${running.version} (${running.script ?? 'unknown script'})`,
          app: `${deps.appVersion} (${deps.appScript ?? 'unknown script'})`,
        });
        return up(ws);
      }
      const sameVersion = running.version === deps.appVersion;
      const sameBuild = !deps.appBuild || !running.build || running.build === deps.appBuild;
      if (sameVersion && sameBuild) {
        log('daemon already running', { health, version: running.version });
        return up(ws);
      }
      const versions = {
        running: sameVersion ? `${running.version} (build ${running.build})` : running.version,
        app: sameVersion ? `${deps.appVersion} (build ${deps.appBuild})` : deps.appVersion,
      };
      if (running.inFlight > 0) {
        log('daemon is another build; replacing it once its turns finish', { ...versions, inFlight: running.inFlight });
        return { url: ws, outdated: true };
      }
      log('daemon is another build and idle; replacing it', versions);
      const kept = await retire(config, ws, versions);
      if (kept) return up(kept);
    }
    return launch(config, ws);
  }

  async function restartAttempt(): Promise<EnsureResult> {
    const config = readConfig();
    if (!config) return up(null);
    const health = healthUrlFor(config);
    const ws = wsUrlFor(config);

    const running = await probeDaemon(config);
    if (running) {
      const meta = { version: running.version, inFlight: running.inFlight };
      log('restarting the daemon', meta);
      const kept = await retire(config, ws, meta);
      if (kept) return up(kept);
    } else {
      log('restart requested but no daemon answers; starting one', { health });
    }
    return launch(config, ws);
  }

  /** Run `fn` as the one in-flight attempt; `after` queues behind whatever is running. */
  function occupy(fn: () => Promise<EnsureResult>, after: Promise<unknown> | null): Promise<EnsureResult> {
    const p: Promise<EnsureResult> = (after ? after.then(fn, fn) : fn()).finally(() => {
      // Nothing is cached: the next call probes again, so a daemon started by
      // hand a minute later is picked up.
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
  }

  /** `fn`, then the loopback URL in place of the configured one if it answers. */
  function local(fn: () => Promise<EnsureResult>): () => Promise<EnsureResult> {
    return async () => {
      const result = await fn();
      const config = readConfig();
      return config ? localUrl(result, config, deps.probe) : result;
    };
  }

  function ensure(): Promise<EnsureResult> {
    return inFlight ?? occupy(local(attempt), null);
  }

  function restart(): Promise<EnsureResult> {
    return occupy(local(restartAttempt), inFlight);
  }

  return { ensure, restart };
}

/**
 * `GET /healthz`, parsed — or null when nothing answers within 1.5 s. The
 * one piece of real I/O the launcher needs; kept out of it so the decisions
 * stay testable without a socket.
 */
/* v8 ignore start -- a socket round trip; the parse it ends in is tested */
export function probeDaemonHealth(url: string): Promise<DaemonHealth | null> {
  return new Promise<DaemonHealth | null>((resolve) => {
    const req = httpGet(url, { timeout: 1500 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve(parseDaemonHealth(body)));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}
/* v8 ignore stop */
