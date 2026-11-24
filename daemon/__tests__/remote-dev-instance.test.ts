import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import {
  DEV_PORT,
  DEV_STATE_DIR_NAME,
  devInstanceEnv,
  isDevDaemon,
  periodicWorkGate,
} from '../remote/dev-instance';

const HOME = '/Users/greg';

describe('devInstanceEnv', () => {
  it('describes the instance: its own state dir, port and marker', () => {
    const env = devInstanceEnv({}, HOME);
    expect(env).toEqual({
      OMNIFEX_STATE_DIR: join(HOME, DEV_STATE_DIR_NAME),
      OMNIFEX_PORT: String(DEV_PORT),
      OMNIFEX_DEV_DAEMON: '1',
    });
  });

  it('does not touch the environment it was handed', () => {
    const env: Record<string, string | undefined> = { PATH: '/opt/bin' };
    devInstanceEnv(env, HOME);
    expect(env).toEqual({ PATH: '/opt/bin' });
  });

  it('returns only the three keys, so merging it is predictable', () => {
    expect(Object.keys(devInstanceEnv({ PATH: '/opt/bin' }, HOME)).sort()).toEqual([
      'OMNIFEX_DEV_DAEMON',
      'OMNIFEX_PORT',
      'OMNIFEX_STATE_DIR',
    ]);
  });

  it('uses a port of its own, so both daemons can be up at once', () => {
    expect(DEV_PORT).not.toBe(47700);
  });

  it('keeps an explicit override', () => {
    const env = devInstanceEnv(
      { OMNIFEX_STATE_DIR: '/tmp/smoke', OMNIFEX_PORT: '49999' },
      HOME,
    );
    expect(env.OMNIFEX_STATE_DIR).toBe('/tmp/smoke');
    expect(env.OMNIFEX_PORT).toBe('49999');
    expect(env.OMNIFEX_DEV_DAEMON).toBe('1');
  });

  it('treats an empty value as unset', () => {
    const env = devInstanceEnv({ OMNIFEX_STATE_DIR: '', OMNIFEX_PORT: '' }, HOME);
    expect(env.OMNIFEX_STATE_DIR).toBe(join(HOME, DEV_STATE_DIR_NAME));
    expect(env.OMNIFEX_PORT).toBe(String(DEV_PORT));
  });
});

describe('isDevDaemon', () => {
  it('reads the marker the dev app puts in the spawn environment', () => {
    expect(isDevDaemon({ OMNIFEX_DEV_DAEMON: '1' })).toBe(true);
    expect(isDevDaemon({})).toBe(false);
    expect(isDevDaemon({ OMNIFEX_DEV_DAEMON: '0' })).toBe(false);
  });
});

describe('periodicWorkGate', () => {
  // Two daemons share one greychrist.db and `brain_spend` is append-only, so a
  // second sweeper bills for real.
  it('shuts periodic work off in a dev daemon', () => {
    const gate = periodicWorkGate({ OMNIFEX_DEV_DAEMON: '1' });
    expect(gate?.()).toBe(false);
  });

  it('leaves the real daemon owning it outright', () => {
    expect(periodicWorkGate({})).toBeUndefined();
  });
});
