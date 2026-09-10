import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDaemonControl } from '../remote/daemon-control';
import { launchAgentPath } from '../remote/launchd';
import type { ServerConfig } from '../remote/config';

const CONFIG = { host: '127.0.0.1', port: 47700, stateDir: '/tmp/x' } as ServerConfig;
const INVOCATION = { execPath: '/Applications/OmniFex.app/Contents/MacOS/omnifex', script: '/Applications/OmniFex.app/Contents/Resources/app.asar/.vite/build/omnifex-server.js' };

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'omnifex-dc-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function make(opts: { plist?: boolean; pid?: number | null; alive?: boolean; scriptExists?: boolean; spawnPid?: number | null } = {}) {
  const plistPath = launchAgentPath(undefined, home);
  if (opts.plist) {
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plistPath, '<plist>old build</plist>');
  }
  const run = vi.fn();
  const kill = vi.fn();
  const spawnDetached = vi.fn(() => opts.spawnPid === undefined ? 4242 : opts.spawnPid);
  const control = createDaemonControl({
    invocation: INVOCATION,
    home,
    uid: 501,
    env: { PATH: '/opt/bin' },
    exists: (p) => (p === INVOCATION.script ? (opts.scriptExists ?? true) : p === plistPath ? !!opts.plist : false),
    run,
    readPid: () => opts.pid ?? null,
    isAlive: () => opts.alive ?? false,
    kill,
    spawnDetached,
  });
  return { control, run, kill, spawnDetached, plistPath };
}

describe('daemon control (detached daemon, no LaunchAgent)', () => {
  it('stop SIGTERMs the pid on file when it is alive', async () => {
    const { control, kill, run } = make({ pid: 777, alive: true });
    expect(await control.stop(CONFIG)).toBe(true);
    expect(kill).toHaveBeenCalledWith(777, 'SIGTERM');
    expect(run).not.toHaveBeenCalled();
  });

  it('stop reports false when there is nothing to signal', async () => {
    expect(await make({ pid: null }).control.stop(CONFIG)).toBe(false);
    expect(await make({ pid: 777, alive: false }).control.stop(CONFIG)).toBe(false);
  });

  it('spawn starts the script detached, logging to ~/Library/Logs', () => {
    const { control, spawnDetached, run } = make();
    expect(control.spawn(CONFIG)).toBe(true);
    expect(spawnDetached).toHaveBeenCalledWith(INVOCATION, join(home, 'Library', 'Logs', 'omnifex-server.log'), { PATH: '/opt/bin' });
    expect(run).not.toHaveBeenCalled();
  });

  it('spawn is false when the script is missing or the child has no pid', () => {
    expect(make({ scriptExists: false }).control.spawn(CONFIG)).toBe(false);
    expect(make({ spawnPid: null }).control.spawn(CONFIG)).toBe(false);
  });
});

describe('daemon control (LaunchAgent installed)', () => {
  it('stop boots the job out so KeepAlive cannot resurrect the old build, and still signals the pid', async () => {
    const { control, run, kill } = make({ plist: true, pid: 777, alive: true });
    expect(await control.stop(CONFIG)).toBe(true);
    expect(run).toHaveBeenCalledWith(['launchctl', 'bootout', 'gui/501/com.omnifex.server']);
    expect(kill).toHaveBeenCalledWith(777, 'SIGTERM');
  });

  it('stop still counts as issued when bootout fails but the pid was signalled', async () => {
    const { control, run } = make({ plist: true, pid: 777, alive: true });
    run.mockImplementationOnce(() => { throw new Error('no such job'); });
    expect(await control.stop(CONFIG)).toBe(true);
  });

  it('spawn rewrites the plist for this build and bootstraps it instead of spawning detached', () => {
    const { control, run, spawnDetached, plistPath } = make({ plist: true });
    expect(control.spawn(CONFIG)).toBe(true);
    expect(spawnDetached).not.toHaveBeenCalled();
    const plist = readFileSync(plistPath, 'utf8');
    expect(plist).toContain(INVOCATION.script);
    expect(plist).toContain(INVOCATION.execPath);
    expect(plist).toContain('/opt/bin');
    expect(run).toHaveBeenCalledWith(['launchctl', 'bootstrap', 'gui/501', plistPath]);
  });

  it('spawn is false when launchctl refuses the new plist', () => {
    const { control, run } = make({ plist: true });
    run.mockImplementation((argv: string[]) => { if (argv[1] === 'bootstrap') throw new Error('Input/output error'); });
    expect(control.spawn(CONFIG)).toBe(false);
  });
});
