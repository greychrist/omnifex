/**
 * Stopping and starting the daemon. Driven by the `ensure` / `restart` /
 * `stop` CLI commands the macOS app runs.
 *
 * A daemon is the app's: `ensure` spawns it non-detached, and the app runs
 * `ensure` inside its own process group, so the daemon lands there too. The
 * app stops it on quit, and the idle watch (`idle-watch.ts`) is the backstop
 * for an app that died without quitting. Stopping is SIGTERM via the pid file.
 *
 * There used to be a second kind — detached, or held by a `com.omnifex.server`
 * LaunchAgent with KeepAlive — that outlived the app. It kept sessions alive
 * across quits, and with them the permissions macOS granted before they
 * started, so a new grant never applied. See
 * docs/superpowers/specs/2026-11-18-daemon-dies-with-app-design.md.
 *
 * Every side effect is injected so the branching is unit-testable.
 */
import { spawn as spawnChild } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { isProcessAlive, readPid } from './cli';
import type { ServerConfig } from './config';

export interface DaemonInvocation {
  /** The node binary — `Contents/MacOS/omnifexd` in the app. */
  execPath: string;
  /** The built `omnifex-server.js`. */
  script: string;
}

export function defaultLogPath(home: string = homedir()): string {
  return join(home, 'Library', 'Logs', 'omnifex-server.log');
}

export interface DaemonControlDeps {
  /** This bundle's node binary and built daemon script. */
  invocation: DaemonInvocation;
  home?: string;
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  readPid?: (config: ServerConfig) => number | null;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Start the script with stdio appended to `logPath`; the pid, or null. */
  spawnDaemon?: (
    invocation: DaemonInvocation,
    logPath: string,
    env: Record<string, string | undefined>,
  ) => number | null;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface DaemonControl {
  /** Ask the running daemon to exit. False when nothing could be signalled. */
  stop(config: ServerConfig): Promise<boolean>;
  /** Start the daemon from this bundle. False when it could not be started. */
  spawn(config: ServerConfig): boolean;
}

function defaultSpawnDaemon(
  invocation: DaemonInvocation,
  logPath: string,
  env: Record<string, string | undefined>,
): number | null {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  try {
    const child = spawnChild(invocation.execPath, [invocation.script, 'start'], {
      // In the caller's process group: the daemon belongs to the app.
      detached: false,
      stdio: ['ignore', fd, fd],
      env,
    });
    // Sharing the group is about signals, not about holding this short-lived
    // CLI's event loop open until the daemon exits.
    child.unref();
    return child.pid ?? null;
  } finally {
    closeSync(fd);
  }
}

export function createDaemonControl(deps: DaemonControlDeps): DaemonControl {
  const exists = deps.exists ?? existsSync;
  const getPid = deps.readPid ?? readPid;
  const isAlive = deps.isAlive ?? isProcessAlive;
  const kill = deps.kill ?? ((pid, signal) => { process.kill(pid, signal); });
  const spawnDaemon = deps.spawnDaemon ?? defaultSpawnDaemon;
  const env = deps.env ?? process.env;
  const log = deps.log ?? (() => {});

  return {
    async stop(config) {
      const pid = getPid(config);
      if (!pid || !isAlive(pid)) return false;
      try {
        kill(pid, 'SIGTERM');
        log('sent SIGTERM to the daemon', { pid });
        return true;
      } catch (err) {
        log('SIGTERM failed', { pid, error: String(err) });
        return false;
      }
    },

    spawn() {
      if (!exists(deps.invocation.script)) {
        log('daemon script missing', { script: deps.invocation.script });
        return false;
      }
      const logPath = defaultLogPath(deps.home);
      try {
        const pid = spawnDaemon(deps.invocation, logPath, env);
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
