/**
 * `omnifex-server <start|stop|status|install|uninstall|config|help>` —
 * argument parsing and the subcommands that do not need the daemon itself.
 *
 * Kept apart from the process entry (`electron/omnifex-server.ts`) so the
 * parsing and the launchd plumbing can be unit-tested without spawning
 * anything.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { dirname, join } from 'node:path';

import type { ServerConfig } from './config';
import {
  buildLaunchAgentPlist,
  launchAgentPath,
  launchAgentSpecFor,
  launchctlCommands,
  type DaemonInvocation,
} from './launchd';

export type CliCommand = 'start' | 'stop' | 'status' | 'install' | 'uninstall' | 'config' | 'help';

export interface CliArgs {
  command: CliCommand;
  flags: Record<string, string | true>;
  unknown?: string;
}

const COMMANDS: readonly CliCommand[] = ['start', 'stop', 'status', 'install', 'uninstall', 'config', 'help'];

/**
 * What the running daemon calls itself, Unix-style (`sshd`, `launchd`).
 *
 * The daemon is the app's own Electron binary re-run with
 * ELECTRON_RUN_AS_NODE, so without this it appears as a second `omnifex` in
 * `ps` and Activity Monitor. Setting `process.title` rewrites argv[0] and,
 * on macOS, the LaunchServices display name — which is the field Activity
 * Monitor shows. The kernel's `p_comm` stays `omnifex`, so use `pgrep -f`,
 * not plain `pgrep`, to find it by this name.
 */
export const DAEMON_PROCESS_TITLE = 'omnifexd';

export function setDaemonProcessTitle(proc: { title: string } = process): void {
  proc.title = DAEMON_PROCESS_TITLE;
}

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

  start        run the daemon in the foreground (what launchd runs); shows as omnifexd
  stop         SIGTERM the running daemon (via ~/.omnifex/server.pid)
  status       ping /healthz and print the result (--json for raw)
  install      write ~/Library/LaunchAgents/com.omnifex.server.plist and load it
  uninstall    unload and remove the LaunchAgent
  config       print the resolved configuration
  help         this

Config: ~/.omnifex/server.json  { host, port, webRoot, ringSize, permissionTimeoutMs, rpcAllow, rpcDeny }
Env:    OMNIFEX_STATE_DIR (default ~/.omnifex), OMNIFEX_USER_DATA_DIR (default Electron userData)
`;

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

/** `stop`: signal the pid on file and wait for it to go. */
export async function stopDaemon(config: ServerConfig, out: (s: string) => void): Promise<number> {
  const pid = readPid(config);
  if (!pid || !isProcessAlive(pid)) {
    removePidFile(config);
    out('omnifex-server is not running');
    return 0;
  }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 50; i++) {
    if (!isProcessAlive(pid)) {
      removePidFile(config);
      out(`stopped omnifex-server (pid ${pid})`);
      return 0;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  out(`omnifex-server (pid ${pid}) did not exit within 5s`);
  return 1;
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
