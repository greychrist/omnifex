import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { launchdAllowed, lifecycleEnv, parseCliArgs, stopCommand } from '../remote/cli';
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

  // The LaunchAgent is the installed app's, pinned to one bundle with
  // KeepAlive. A throwaway state dir (a smoke run of a packaged build) or the
  // dev instance re-pointing it would hand the user's real daemon to a test.
  describe('launchdAllowed', () => {
    it('is the real instance only: default state dir, not dev', () => {
      expect(launchdAllowed({}, { dev: false })).toBe(true);
      expect(launchdAllowed({ OMNIFEX_STATE_DIR: join(homedir(), '.omnifex') }, { dev: false })).toBe(true);
    });

    it('is never the dev instance', () => {
      expect(launchdAllowed({}, { dev: true })).toBe(false);
    });

    it('is never a throwaway state dir', () => {
      expect(launchdAllowed({ OMNIFEX_STATE_DIR: '/tmp/smoke' }, { dev: false })).toBe(false);
    });
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
