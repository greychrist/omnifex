/**
 * Stopping and starting the daemon from Electron main, launchd-aware.
 *
 * Two ways a daemon can be running:
 *
 *  - detached, spawned by a previous app launch: SIGTERM via the pid file,
 *    then spawn a fresh one from *this* bundle.
 *  - as the `com.omnifex.server` LaunchAgent (`omnifex-server install`): the
 *    plist pins the script path of whichever build ran `install`, and
 *    KeepAlive would resurrect that old build seconds after a SIGTERM. So the
 *    job is booted out (stops it, KeepAlive off), and starting means
 *    re-installing the plist for this bundle's script and bootstrapping it —
 *    the agent follows the app across upgrades without anyone re-running
 *    `install`.
 *
 * Every side effect is injected so the branching is unit-testable.
 */
import { spawn as spawnChild } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

import { installCommand, isProcessAlive, readPid } from './cli';
import type { ServerConfig } from './config';
import { defaultLogPath, launchAgentPath, launchctlCommands, type DaemonInvocation } from './launchd';

export interface DaemonControlDeps {
  /** This bundle's Electron binary and built daemon script. */
  invocation: DaemonInvocation;
  home?: string;
  uid?: number;
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  run?: (argv: string[]) => void;
  readPid?: (config: ServerConfig) => number | null;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Start the script detached with stdio appended to `logPath`; the pid, or null. */
  spawnDetached?: (invocation: DaemonInvocation, logPath: string, env: Record<string, string | undefined>) => number | null;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface DaemonControl {
  managedByLaunchd(): boolean;
  /** Ask the running daemon to exit. False when nothing could be signalled. */
  stop(config: ServerConfig): Promise<boolean>;
  /** Start the daemon from this bundle. False when it could not be started. */
  spawn(config: ServerConfig): boolean;
}

function defaultSpawnDetached(
  invocation: DaemonInvocation,
  logPath: string,
  env: Record<string, string | undefined>,
): number | null {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  try {
    const child = spawnChild(invocation.execPath, [invocation.script, 'start'], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
    return child.pid ?? null;
  } finally {
    closeSync(fd);
  }
}

export function createDaemonControl(deps: DaemonControlDeps): DaemonControl {
  const exists = deps.exists ?? existsSync;
  const run = deps.run ?? ((argv: string[]) => {
    // Lazy so tests never touch launchctl.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    execFileSync(argv[0], argv.slice(1), { stdio: 'ignore' });
  });
  const getPid = deps.readPid ?? readPid;
  const isAlive = deps.isAlive ?? isProcessAlive;
  const kill = deps.kill ?? ((pid, signal) => { process.kill(pid, signal); });
  const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached;
  const env = deps.env ?? process.env;
  const uid = deps.uid ?? process.getuid?.() ?? 501;
  const log = deps.log ?? (() => {});
  const plistPath = launchAgentPath(undefined, deps.home);

  function managedByLaunchd(): boolean {
    return exists(plistPath);
  }

  return {
    managedByLaunchd,

    async stop(config) {
      let issued = false;
      if (managedByLaunchd()) {
        const [bootout] = launchctlCommands(plistPath, uid).uninstall;
        try {
          run(bootout);
          issued = true;
          log('booted out the launchd job');
        } catch (err) {
          log('launchctl bootout failed', { error: String(err) });
        }
      }
      const pid = getPid(config);
      if (pid && isAlive(pid)) {
        try {
          kill(pid, 'SIGTERM');
          issued = true;
          log('sent SIGTERM to the daemon', { pid });
        } catch (err) {
          log('SIGTERM failed', { pid, error: String(err) });
        }
      }
      return issued;
    },

    spawn() {
      if (!exists(deps.invocation.script)) {
        log('daemon script missing', { script: deps.invocation.script });
        return false;
      }
      if (managedByLaunchd()) {
        try {
          installCommand(deps.invocation, (s) => log(s), { run, uid, env, home: deps.home });
          log('re-installed the launchd job for this build', { script: deps.invocation.script });
          return true;
        } catch (err) {
          log('launchd re-install failed', { error: String(err) });
          return false;
        }
      }
      const logPath = defaultLogPath(deps.home);
      try {
        const pid = spawnDetached(deps.invocation, logPath, env);
        if (pid == null) {
          log('spawn returned no pid');
          return false;
        }
        log('spawned daemon', { pid, log: logPath });
        return true;
      } catch (err) {
        log('failed to spawn daemon', { error: String(err) });
        return false;
      }
    },
  };
}
