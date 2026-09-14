import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import {
  DEV_PORT,
  DEV_STATE_DIR_NAME,
  devInstanceEnv,
  createDevIdleWatch,
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


describe('createDevIdleWatch', () => {
  // A dev daemon must not outlive the `npm start` that spawned it. The app
  // SIGTERMs it on quit and it shares the app's process group so Ctrl-C
  // reaches it — but neither survives `kill -9` on the app, and a stale
  // daemon on 47701 running a build from an hour ago is exactly the leftover
  // this instance exists to avoid. This is the backstop: no client, no turn,
  // no reason to be here.
  //
  // `everConnected` is asked of the server, not inferred from a poll of
  // `clients`. A 5s tick genuinely missed a client that was attached for 2s
  // (2026-09-13), and a watch that decides "nobody ever came" from samples it
  // may not have taken is a watch that never fires.
  const watch = (
    clients: () => number,
    opts: { inFlight?: () => number; everConnected?: () => boolean; startedAt?: number } = {},
  ) =>
    createDevIdleWatch({
      clients,
      inFlight: opts.inFlight ?? (() => 0),
      everConnected: opts.everConnected ?? (() => true),
      startedAt: opts.startedAt ?? 0,
      graceMs: 30_000,
      startupMs: 120_000,
    });

  it('exits once the last client has been gone for the grace period', () => {
    let clients = 1;
    const w = watch(() => clients);
    expect(w.check(0)).toBe(false);
    clients = 0;
    expect(w.check(1_000)).toBe(false);   // starts the clock
    expect(w.check(20_000)).toBe(false);
    expect(w.check(31_000)).toBe(true);
  });

  it('counts a client that came and went between two ticks', () => {
    // Never observed as connected; the server says one was here.
    const w = watch(() => 0, { everConnected: () => true });
    expect(w.check(1_000)).toBe(false);
    expect(w.check(32_000)).toBe(true);
  });

  it('survives a reconnect — a renderer reload is not a quit', () => {
    let clients = 1;
    const w = watch(() => clients);
    w.check(0);
    clients = 0;
    expect(w.check(1_000)).toBe(false);
    clients = 1;
    expect(w.check(2_000)).toBe(false);
    clients = 0;
    // The clock restarts from the new disconnect, not the old one.
    expect(w.check(3_000)).toBe(false);
    expect(w.check(32_000)).toBe(false);
    expect(w.check(34_000)).toBe(true);
  });

  it('never kills a turn that is still running', () => {
    let clients = 1;
    let inFlight = 0;
    const w = watch(() => clients, { inFlight: () => inFlight });
    w.check(0);
    clients = 0;
    inFlight = 1;
    expect(w.check(1_000)).toBe(false);
    expect(w.check(120_000)).toBe(false);
    inFlight = 0;
    // The grace period starts when the turn ends, not when the client left.
    expect(w.check(121_000)).toBe(false);
    expect(w.check(152_000)).toBe(true);
  });

  it('gives the app time to make its first connection', () => {
    // The daemon is listening a second before the app's socket arrives;
    // exiting there would be a launch that killed itself.
    const w = watch(() => 0, { everConnected: () => false, startedAt: 1_000 });
    expect(w.check(2_000)).toBe(false);
    expect(w.check(60_000)).toBe(false);
  });

  it('exits when nothing ever connects — the app it belonged to is gone', () => {
    // `npm start` died during boot, or was killed before the socket opened.
    // Nothing will ever attach to this daemon; it is already a leftover.
    const w = watch(() => 0, { everConnected: () => false, startedAt: 1_000 });
    expect(w.check(60_000)).toBe(false);
    expect(w.check(121_000)).toBe(true);
  });
});
