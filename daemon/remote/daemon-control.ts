// The daemon is the app's: spawned non-detached into the app's process group and stopped on quit.
// One that outlives the app keeps the macOS permission grants from before it started.
import { spawn as spawnChild } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { isProcessAlive, readPid } from './cli';
import type { ServerConfig } from './config';

export interface DaemonInvocation {
  execPath: string;
  script: string;
}

export function defaultLogPath(home: string = homedir()): string {
  return join(home, 'Library', 'Logs', 'omnifex-server.log');
}

export interface DaemonControlDeps {
  invocation: DaemonInvocation;
  home?: string;
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  readPid?: (config: ServerConfig) => number | null;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  spawnDaemon?: (
    invocation: DaemonInvocation,
    logPath: string,
    env: Record<string, string | undefined>,
  ) => number | null;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface DaemonControl {
  stop(config: ServerConfig): Promise<boolean>;
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
    // Sharing the group is about signals, not holding this short-lived CLI's event loop open.
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
