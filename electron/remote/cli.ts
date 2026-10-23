/**
 * `omnifex-server <start|stop|status|ensure|restart|install|uninstall|config|help>`
 * — argument parsing and the subcommands that do not need the daemon itself.
 *
 * Kept apart from the process entry (`electron/omnifex-server.ts`) so the
 * parsing and the launchd plumbing can be unit-tested without spawning
 * anything.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { defaultStateDir, type ServerConfig } from './config';
import { devInstanceEnv, type Env } from './dev-instance';
import {
  buildLaunchAgentPlist,
  launchAgentPath,
  launchAgentSpecFor,
  launchctlCommands,
  type DaemonInvocation,
} from './launchd';

export type CliCommand = 'start' | 'stop' | 'status' | 'ensure' | 'restart' | 'install' | 'uninstall' | 'config' | 'help';

export interface CliArgs {
  command: CliCommand;
  flags: Record<string, string | true>;
  unknown?: string;
}

const COMMANDS: readonly CliCommand[] = ['start', 'stop', 'status', 'ensure', 'restart', 'install', 'uninstall', 'config', 'help'];

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

  start        run the daemon in the foreground (what launchd runs)
  stop         stop the running daemon (launchd bootout when it owns it, then
               SIGTERM via ~/.omnifex/server.pid)
  status       ping /healthz and print the result (--json for raw)
  ensure       make sure THIS build's daemon is running; prints one JSON line
               {"url": ws-url|null, "outdated": bool}. What the app runs at
               launch. --app-version <v>, --app-build <stamp>
  restart      stop whatever answers on the port and start this build's;
               same output as ensure
  install      write ~/Library/LaunchAgents/com.omnifex.server.plist and load it
  uninstall    unload and remove the LaunchAgent
  config       print the resolved configuration
  help         this

  --dev        (ensure, restart, stop) act on the dev instance:
               ~/.omnifex-dev, port 47701, never the LaunchAgent

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

/**
 * Whether a lifecycle command may drive the `com.omnifex.server` LaunchAgent.
 *
 * Only the real instance may: the plist pins one bundle's script with
 * KeepAlive, so the dev instance re-pointing it hands the user's daemon to a
 * working tree, and a smoke run of a packaged build under a throwaway
 * `OMNIFEX_STATE_DIR` would hand it to a build under test.
 */
export function launchdAllowed(env: Env, opts: { dev: boolean }): boolean {
  if (opts.dev) return false;
  return resolve(defaultStateDir(env)) === resolve(join(homedir(), '.omnifex'));
}

export interface StopCommandDeps {
  readPid(config: ServerConfig): number | null;
  isAlive(pid: number): boolean;
  removePidFile(config: ServerConfig): void;
  sleep(ms: number): Promise<void>;
  out(s: string): void;
}

/**
 * `stop`: stop the daemon the way `daemon-control` does — `launchctl bootout`
 * first when the LaunchAgent owns it, or KeepAlive resurrects the old build
 * seconds later — then wait for the pid to go. The app's updater runs this
 * right before it swaps the bundle the daemon is running from.
 */
export async function stopCommand(
  config: ServerConfig,
  control: { stop(config: ServerConfig): Promise<boolean> },
  deps: StopCommandDeps,
): Promise<number> {
  const pid = deps.readPid(config);
  if (!(await control.stop(config))) {
    deps.removePidFile(config);
    deps.out('omnifex-server is not running');
    return 0;
  }
  for (let i = 0; i < 50; i++) {
    if (!pid || !deps.isAlive(pid)) {
      deps.removePidFile(config);
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

export function removePidFile(config: ServerConfig): void {
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
      res.on('data', (d) => { body += d; });
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

export interface LaunchctlRunner {
  (argv: string[]): void;
}

const defaultLaunchctl: LaunchctlRunner = (argv) => {
  execFileSync(argv[0], argv.slice(1), { stdio: 'inherit' });
};

/** `install`: write the plist and (re)load it. */
export function installCommand(
  invocation: DaemonInvocation,
  out: (s: string) => void,
  deps: { run?: LaunchctlRunner; uid?: number; env?: Record<string, string | undefined>; home?: string } = {},
): number {
  const run = deps.run ?? defaultLaunchctl;
  const spec = launchAgentSpecFor(invocation, deps.env ?? process.env, deps.home);
  const plistPath = launchAgentPath(spec.label, deps.home);
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(dirname(spec.stdoutPath), { recursive: true });
  writeFileSync(plistPath, buildLaunchAgentPlist(spec), 'utf8');
  const cmds = launchctlCommands(plistPath, deps.uid ?? process.getuid?.() ?? 501, spec.label);
  try {
    run(cmds.install[0]);
  } catch {
    // Not loaded yet — bootout of an absent job fails, which is the normal
    // first-install case.
  }
  run(cmds.install[1]);
  out(`installed ${plistPath}`);
  out(`logs: ${spec.stdoutPath}`);
  return 0;
}

export function uninstallCommand(
  out: (s: string) => void,
  deps: { run?: LaunchctlRunner; uid?: number; home?: string } = {},
): number {
  const run = deps.run ?? defaultLaunchctl;
  const plistPath = launchAgentPath(undefined, deps.home);
  const cmds = launchctlCommands(plistPath, deps.uid ?? process.getuid?.() ?? 501);
  try {
    run(cmds.uninstall[0]);
  } catch {
    // Already unloaded.
  }
  if (existsSync(plistPath)) rmSync(plistPath);
  out(`removed ${plistPath}`);
  return 0;
}
