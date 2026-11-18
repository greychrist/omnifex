import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import {
  DEV_PORT,
  DEV_STATE_DIR_NAME,
  devInstanceEnv,
  isDevDaemon,
  periodicWorkGate,
  shouldUseDevInstance,
} from '../remote/dev-instance';

const HOME = '/Users/greg';

describe('shouldUseDevInstance', () => {
  it('is on for a dev build', () => {
    expect(shouldUseDevInstance({ packaged: false, env: {} })).toBe(true);
  });

  it('is off for the installed app — it is the product and owns the real port', () => {
    expect(shouldUseDevInstance({ packaged: true, env: {} })).toBe(false);
  });

  it('can be opted out of, to drive the real daemon on purpose', () => {
    expect(shouldUseDevInstance({ packaged: false, env: { OMNIFEX_DEV_INSTANCE: '0' } })).toBe(false);
  });
});

describe('devInstanceEnv', () => {
  it('describes the instance: its own state dir, port and marker', () => {
    const env = devInstanceEnv({}, HOME);
    expect(env).toEqual({
      OMNIFEX_STATE_DIR: join(HOME, DEV_STATE_DIR_NAME),
      OMNIFEX_PORT: String(DEV_PORT),
      OMNIFEX_DEV_DAEMON: '1',
    });
  });

  // The bug this replaced: it used to write these three into `process.env`,
  // so every child the dev app spawned inherited them — CLI sessions, agents,
  // Brain extraction, and any shell command run inside a session. `npm test`
  // from a terminal in a dev-app session then failed remote-config's
  // "file overrides port" case, because loadServerConfig() read the inherited
  // OMNIFEX_PORT. The overlay is handed to the two places that want it.
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
    // Still a dev daemon: the marker is about who owns the background work,
    // not about where the state lives.
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
  // Two daemons now share one greychrist.db. `brain_spend` is append-only and
  // recoverOrphans() re-queues whatever the other process is mid-extraction
  // on, so a second sweeper is billed for real. The dev daemon is a test
  // fixture; the installed pair keeps the maintenance.
  it('shuts periodic work off in a dev daemon', () => {
    const gate = periodicWorkGate({ OMNIFEX_DEV_DAEMON: '1' });
    expect(gate?.()).toBe(false);
  });

  it('leaves the real daemon owning it outright', () => {
    expect(periodicWorkGate({})).toBeUndefined();
  });
});
