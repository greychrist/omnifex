// Same protocol version can mean different code, so a daemon reporting another app version is replaced.
import { get as httpGet } from 'node:http';

import { isLoopbackHost, type ServerConfig } from './config';

export interface DaemonHealth {
  version: string;
  build?: string;
  script?: string;
  inFlight: number;
}

export interface RemoteLauncherDeps {
  config: () => ServerConfig;
  probe: (healthUrl: string) => Promise<DaemonHealth | null>;
  /** Must not throw for a missing script — return false. */
  spawn: (config: ServerConfig) => boolean;
  stop: (config: ServerConfig) => Promise<boolean>;
  appVersion: string;
  /** Dev only: the version never moves between `npm start`s. Defined ⇒ dev build, which retires only its own daemon. */
  appBuild?: string;
  appScript?: string;
  sleep?: (ms: number) => Promise<void>;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface EnsureResult {
  url: string | null;
  outdated: boolean;
}

export interface RemoteLauncher {
  ensure(): Promise<EnsureResult>;
  restart(): Promise<EnsureResult>;
}

export function healthUrlFor(config: Pick<ServerConfig, 'host' | 'port'>): string {
  return `http://${config.host}:${config.port}/healthz`;
}

export function wsUrlFor(config: Pick<ServerConfig, 'host' | 'port'>): string {
  return `ws://${config.host}:${config.port}/ws`;
}

const LOOPBACK = '127.0.0.1';

// The Mac app must use loopback: WebKit runs non-loopback http without JIT (~5x slower) and without a secure context.
async function localUrl(
  result: EnsureResult,
  config: Pick<ServerConfig, 'host' | 'port'>,
  probe: (healthUrl: string) => Promise<DaemonHealth | null>,
): Promise<EnsureResult> {
  if (!result.url || isLoopbackHost(config.host)) return result;
  const loopback = { host: LOOPBACK, port: config.port };
  return (await probe(healthUrlFor(loopback))) ? { ...result, url: wsUrlFor(loopback) } : result;
}

// A daemon that does not report `sessions.inFlight` must read as idle, so a newer build can replace it.
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

  let inFlight: Promise<EnsureResult> | null = null;

  const up = (url: string | null): EnsureResult => ({ url, outdated: false });

  async function waitUntil(pred: () => Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      if (await pred()) return true;
    }
    return false;
  }

  // Also probe loopback: a daemon started before Tailscale came up listens only there.
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
      // A dev build retires only a daemon running its own script; anything else may be the installed app's, with live sessions.
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

  function occupy(fn: () => Promise<EnsureResult>, after: Promise<unknown> | null): Promise<EnsureResult> {
    const p: Promise<EnsureResult> = (after ? after.then(fn, fn) : fn()).finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
  }

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
