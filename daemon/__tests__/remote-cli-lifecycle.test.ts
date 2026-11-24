import { describe, expect, it, vi } from 'vitest';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HELP, lifecycleEnv, parseCliArgs, readPid, removePidFile, stopCommand, writePidFile } from '../remote/cli';
import type { ServerConfig } from '../remote/config';
import { DEV_DAEMON_ENV, DEV_PORT } from '../remote/dev-instance';

const CONFIG = { host: '127.0.0.1', port: 47700, stateDir: '/tmp/state' } as ServerConfig;

describe('cli lifecycle commands', () => {
  it('parses ensure, restart and their flags', () => {
    expect(parseCliArgs(['ensure', '--app-version', '1.2.3', '--dev'])).toEqual({
      command: 'ensure',
      flags: { 'app-version': '1.2.3', dev: true },
    });
    expect(parseCliArgs(['restart'])).toEqual({ command: 'restart', flags: {} });
  });

  describe('lifecycleEnv', () => {
    it('leaves the environment alone outside dev', () => {
      const env = { PATH: '/bin' };
      expect(lifecycleEnv(env, { dev: false })).toBe(env);
    });

    it('moves a dev run onto the dev instance', () => {
      const env = lifecycleEnv({ PATH: '/bin' }, { dev: true }, '/Users/greg');
      expect(env.OMNIFEX_STATE_DIR).toBe('/Users/greg/.omnifex-dev');
      expect(env.OMNIFEX_PORT).toBe(String(DEV_PORT));
      expect(env[DEV_DAEMON_ENV]).toBe('1');
      expect(env.PATH).toBe('/bin');
    });
  });

  // A KeepAlive job would respawn the daemon the app had just stopped, so the
  // LaunchAgent and its commands are gone. Typed from habit, they are unknown.
  it('no longer knows install or uninstall', () => {
    expect(parseCliArgs(['install'])).toEqual({ command: 'help', flags: {}, unknown: 'install' });
    expect(parseCliArgs(['uninstall'])).toEqual({ command: 'help', flags: {}, unknown: 'uninstall' });
    expect(HELP).not.toMatch(/LaunchAgent|launchd|install/);
  });

  describe('stopCommand', () => {
    function deps(over: { issued?: boolean; pid?: number | null; aliveFor?: number } = {}) {
      let checks = 0;
      const out: string[] = [];
      return {
        out,
        control: { stop: vi.fn(async () => over.issued ?? true) },
        d: {
          readPid: () => (over.pid === undefined ? 99 : over.pid),
          isAlive: () => checks++ < (over.aliveFor ?? 0),
          removePidFile: vi.fn(),
          sleep: async () => {},
          out: (s: string) => { out.push(s); },
        },
      };
    }

    it('says so and succeeds when there was nothing to stop', async () => {
      const { control, d, out } = deps({ issued: false });
      expect(await stopCommand(CONFIG, control, d)).toBe(0);
      expect(out).toEqual(['omnifex-server is not running']);
      expect(d.removePidFile).toHaveBeenCalled();
    });

    it('waits for the signalled pid to exit', async () => {
      const { control, d, out } = deps({ aliveFor: 3 });
      expect(await stopCommand(CONFIG, control, d)).toBe(0);
      expect(control.stop).toHaveBeenCalledWith(CONFIG);
      expect(out).toEqual(['stopped omnifex-server (pid 99)']);
    });

    it('fails when the daemon outlives the wait', async () => {
      const { control, d, out } = deps({ aliveFor: 10_000 });
      expect(await stopCommand(CONFIG, control, d)).toBe(1);
      expect(out[0]).toMatch(/did not exit within 5s/);
    });
  });
});

describe('removePidFile', () => {
  // A daemon slow to close can still be shutting down after the app has quit
  // and relaunched; by then the new daemon has written its own pid. The old
  // one's exit must not delete it, or the next quit's `stop` finds "not
  // running" and the daemon survives the quit (review, 2026-11-18).
  const withState = (fn: (config: ServerConfig) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'omnifex-pid-'));
    try {
      fn({ ...CONFIG, stateDir: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('leaves a pid file that names another daemon', () => {
    withState((config) => {
      writePidFile(config, 222);
      removePidFile(config, 111);
      expect(readPid(config)).toBe(222);
    });
  });

  it('removes its own', () => {
    withState((config) => {
      writePidFile(config, 111);
      removePidFile(config, 111);
      expect(readPid(config)).toBeNull();
    });
  });
});
