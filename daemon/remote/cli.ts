/**
 * `omnifex-server <start|stop|status|ensure|restart|config|help>`
 * — argument parsing and the subcommands that do not need the daemon itself.
 *
 * Kept apart from the process entry (`daemon/omnifex-server.ts`) so the
 * parsing and the lifecycle commands can be unit-tested without spawning
 * anything.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ServerConfig } from './config';
import { devInstanceEnv, type Env } from './dev-instance';

export type CliCommand = 'start' | 'stop' | 'status' | 'ensure' | 'restart' | 'config' | 'help';

export interface CliArgs {
  command: CliCommand;
  flags: Record<string, string | true>;
  unknown?: string;
}

const COMMANDS: readonly CliCommand[] = ['start', 'stop', 'status', 'ensure', 'restart', 'config', 'help'];

export function parseCliArgs(argv: string[]): CliArgs {
  const [first, ...rest] = argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const name = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  if (first === undefined) return { command: 'help', flags };
  if ((COMMANDS as readonly string[]).includes(first)) return { command: first as CliCommand, flags };
  return { command: 'help', flags, unknown: first };
}

export const HELP = `omnifex-server — the OmniFex Remote daemon

  start        run the daemon in the foreground (what ensure spawns)
  stop         stop the running daemon (SIGTERM via ~/.omnifex/server.pid)
  status       ping /healthz and print the result (--json for raw)
  ensure       make sure THIS build's daemon is running; prints one JSON line
               {"url": ws-url|null, "outdated": bool}. What the app runs at
               launch. --app-version <v>, --app-build <stamp>
  restart      stop whatever answers on the port and start this build's;
               same output as ensure
  config       print the resolved configuration
  help         this

  --dev        (ensure, restart, stop) act on the dev instance:
               ~/.omnifex-dev, port 47701

Config: ~/.omnifex/server.json  { host, port, webRoot, ringSize, permissionTimeoutMs, rpcAllow, rpcDeny }
Env:    OMNIFEX_STATE_DIR (default ~/.omnifex),
        OMNIFEX_USER_DATA_DIR (default ~/Library/Application Support/OmniFex)
`;

/**
 * The environment a lifecycle command acts in. `--dev` moves it onto the dev
 * instance — the overlay is applied here, to the command's own copy, never to
 * `process.env` (see dev-instance.ts for what leaking it once cost).
 */
export function lifecycleEnv(env: Env, opts: { dev: boolean }, home: string = homedir()): Env {
  return opts.dev ? { ...env, ...devInstanceEnv(env, home) } : env;
}

export interface StopCommandDeps {
  readPid(config: ServerConfig): number | null;
  isAlive(pid: number): boolean;
  removePidFile(config: ServerConfig, ownerPid: number | null): void;
  sleep(ms: number): Promise<void>;
  out(s: string): void;
}

/**
 * `stop`: signal the daemon the way `daemon-control` does, then wait for the
 * pid to go. The app runs this on quit, and its updater right before it swaps
 * the bundle the daemon is running from.
 */
export async function stopCommand(
  config: ServerConfig,
  control: { stop(config: ServerConfig): Promise<boolean> },
  deps: StopCommandDeps,
): Promise<number> {
  const pid = deps.readPid(config);
  if (!(await control.stop(config))) {
    deps.removePidFile(config, pid);
    deps.out('omnifex-server is not running');
    return 0;
  }
  for (let i = 0; i < 50; i++) {
    if (!pid || !deps.isAlive(pid)) {
      deps.removePidFile(config, pid);
      deps.out(pid ? `stopped omnifex-server (pid ${pid})` : 'stopped omnifex-server');
      return 0;
    }
    await deps.sleep(100);
  }
  deps.out(`omnifex-server (pid ${pid}) did not exit within 5s`);
  return 1;
}

export function pidFilePath(config: ServerConfig): string {
  return join(config.stateDir, 'server.pid');
}

export function writePidFile(config: ServerConfig, pid: number = process.pid): void {
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(pidFilePath(config), `${pid}\n`, 'utf8');
}

/**
 * Remove the pid file — unless it now names another daemon. A daemon slow to
 * close can still be exiting after the app relaunched and a new daemon wrote
 * its pid; deleting that would make the next quit's `stop` find nothing.
 * `ownerPid` null means "whoever": a stale or unreadable file.
 */
export function removePidFile(config: ServerConfig, ownerPid: number | null): void {
  const current = readPid(config);
  if (ownerPid !== null && current !== null && current !== ownerPid) return;
  rmSync(pidFilePath(config), { force: true });
}

export function readPid(config: ServerConfig): number | null {
  try {
    const n = Number(readFileSync(pidFilePath(config), 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function fetchHealth(config: ServerConfig): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpGet(`http://${config.host}:${config.port}/healthz`, { timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => { body += d.toString(); });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`unexpected /healthz body: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

/** `status`: exit 0 when the daemon answers. */
export async function statusCommand(config: ServerConfig, json: boolean, out: (s: string) => void): Promise<number> {
  try {
    const health = await fetchHealth(config);
    if (json) out(JSON.stringify(health, null, 2));
    else {
      const h = health as { version?: string; uptimeSec?: number; sessions?: { live?: number; known?: number }; clients?: number };
      out(`omnifex-server ${h.version ?? '?'} listening on http://${config.host}:${config.port}`);
      out(`  up ${h.uptimeSec ?? '?'}s · ${h.sessions?.live ?? 0} live / ${h.sessions?.known ?? 0} known sessions · ${h.clients ?? 0} client(s)`);
    }
    return 0;
  } catch (err) {
    const pid = readPid(config);
    out(`omnifex-server is not answering at http://${config.host}:${config.port} (${(err as Error).message})`);
    if (pid) out(`  pid file says ${pid}${isProcessAlive(pid) ? ' (alive)' : ' (dead)'}`);
    return 1;
  }
}
