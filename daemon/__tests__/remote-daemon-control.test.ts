import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDaemonControl } from '../remote/daemon-control';
import type { ServerConfig } from '../remote/config';

const CONFIG = { host: '127.0.0.1', port: 47700, stateDir: '/tmp/x' } as ServerConfig;
// Paths that do not exist anywhere. A test whose fake spawner is not wired
// in falls through to the real one; with the installed app's paths here that
// once launched three real daemons against the user's database (2026-11-18).
const INVOCATION = { execPath: '/nonexistent/omnifex-test/omnifexd', script: '/nonexistent/omnifex-test/omnifex-server.js' };

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'omnifex-dc-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function make(opts: { pid?: number | null; alive?: boolean; scriptExists?: boolean; spawnPid?: number | null } = {}) {
  const kill = vi.fn();
  const spawnDaemon = vi.fn((..._args: unknown[]) => opts.spawnPid === undefined ? 4242 : opts.spawnPid);
  const control = createDaemonControl({
    invocation: INVOCATION,
    home,
    env: { PATH: '/opt/bin' },
    exists: (p) => (p === INVOCATION.script ? (opts.scriptExists ?? true) : false),
    readPid: () => opts.pid ?? null,
    isAlive: () => opts.alive ?? false,
    kill,
    spawnDaemon,
  });
  return { control, kill, spawnDaemon };
}

describe('daemon control', () => {
  it('stop SIGTERMs the pid on file when it is alive', async () => {
    const { control, kill } = make({ pid: 777, alive: true });
    expect(await control.stop(CONFIG)).toBe(true);
    expect(kill).toHaveBeenCalledWith(777, 'SIGTERM');
  });

  it('stop reports false when there is nothing to signal', async () => {
    expect(await make({ pid: null }).control.stop(CONFIG)).toBe(false);
    expect(await make({ pid: 777, alive: false }).control.stop(CONFIG)).toBe(false);
  });

  // Every daemon belongs to the app that started it: in the app's process
  // group, stopped on quit, the idle watch as backstop. There is no detached
  // kind left to ask for. See
  // docs/superpowers/specs/2026-11-18-daemon-dies-with-app-design.md.
  it('spawns the daemon in the caller\'s process group, logging to ~/Library/Logs', () => {
    const { control, spawnDaemon } = make();
    expect(control.spawn(CONFIG)).toBe(true);
    expect(spawnDaemon).toHaveBeenCalledTimes(1);
    const [inv, logPath, env, ...rest] = spawnDaemon.mock.calls[0];
    expect(inv).toEqual(INVOCATION);
    expect(logPath).toBe(join(home, 'Library', 'Logs', 'omnifex-server.log'));
    expect(env).toEqual({ PATH: '/opt/bin' });
    expect(rest).toEqual([]); // no detached option left to pass
  });

  // A KeepAlive job would respawn the daemon the app had just stopped.
  it('never writes a LaunchAgent', () => {
    make().control.spawn(CONFIG);
    expect(existsSync(join(home, 'Library', 'LaunchAgents'))).toBe(false);
  });

  it('spawn is false when the script is missing or the child has no pid', () => {
    expect(make({ scriptExists: false }).control.spawn(CONFIG)).toBe(false);
    expect(make({ spawnPid: null }).control.spawn(CONFIG)).toBe(false);
  });
});
