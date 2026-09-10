import { describe, it, expect, vi } from 'vitest';

import { createRemoteLauncher, healthUrlFor, parseDaemonHealth, wsUrlFor, type DaemonHealth } from '../remote-launcher';
import type { ServerConfig } from '../remote/config';

const CONFIG = { host: '127.0.0.1', port: 47700 } as ServerConfig;
const WS = 'ws://127.0.0.1:47700/ws';
const APP = '0.5.0';

const same = (): DaemonHealth => ({ version: APP, inFlight: 0 });
const old = (inFlight = 0): DaemonHealth => ({ version: '0.4.9', inFlight });

function make(probeResults: Array<DaemonHealth | null>, opts: { spawnOk?: boolean; stopOk?: boolean } = {}) {
  const probe = vi.fn(async () => (probeResults.length ? probeResults.shift()! : null));
  const spawn = vi.fn(() => opts.spawnOk ?? true);
  const stop = vi.fn(async () => opts.stopOk ?? true);
  const sleeps: number[] = [];
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const logs: string[] = [];
  const launcher = createRemoteLauncher({
    config: () => CONFIG,
    probe,
    spawn,
    stop,
    appVersion: APP,
    sleep: async (ms) => { sleeps.push(ms); },
    schedule: (fn, ms) => { scheduled.push({ fn, ms }); },
    startupTimeoutMs: 1000,
    pollIntervalMs: 250,
    upgradeRetryMs: 30_000,
    log: (m) => { logs.push(m); },
  });
  return { launcher, probe, spawn, stop, sleeps, scheduled, logs };
}

describe('remote launcher', () => {
  it('derives the health and ws urls from the daemon config', () => {
    expect(healthUrlFor(CONFIG)).toBe('http://127.0.0.1:47700/healthz');
    expect(wsUrlFor(CONFIG)).toBe(WS);
  });

  it('returns the url without spawning when a daemon of this build already answers', async () => {
    const { launcher, spawn, stop } = make([same()]);
    expect(await launcher.ensure()).toBe(WS);
    expect(spawn).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('spawns, then polls until the daemon answers', async () => {
    const { launcher, spawn, probe, sleeps } = make([null, null, null, same()]);
    expect(await launcher.ensure()).toBe(WS);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([250, 250, 250]);
  });

  it('gives up after the startup timeout and reports legacy', async () => {
    let now = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const probe = vi.fn(async () => null);
    const launcher = createRemoteLauncher({
      config: () => CONFIG,
      probe,
      spawn: () => true,
      stop: async () => true,
      appVersion: APP,
      sleep: async (ms) => { now += ms; },
      startupTimeoutMs: 1000,
      pollIntervalMs: 250,
    });
    expect(await launcher.ensure()).toBeNull();
    // initial probe + 4 polls inside the 1000ms window
    expect(probe).toHaveBeenCalledTimes(5);
    spy.mockRestore();
  });

  it('returns null without polling when the spawn itself fails', async () => {
    const { launcher, probe } = make([null], { spawnOk: false });
    expect(await launcher.ensure()).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('returns null when the config cannot be read, rather than throwing into the window', async () => {
    const launcher = createRemoteLauncher({
      config: () => { throw new Error('server.json is not valid JSON'); },
      probe: async () => same(),
      spawn: () => true,
      stop: async () => true,
      appVersion: APP,
    });
    expect(await launcher.ensure()).toBeNull();
  });

  it('shares one in-flight attempt between concurrent callers, and retries after a null', async () => {
    const probe = vi.fn(async () => null as DaemonHealth | null);
    const spawn = vi.fn(() => false);
    const launcher = createRemoteLauncher({ config: () => CONFIG, probe, spawn, stop: async () => true, appVersion: APP });
    const [a, b] = await Promise.all([launcher.ensure(), launcher.ensure()]);
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
    // Not cached: a daemon started by hand later is picked up.
    probe.mockResolvedValueOnce(same());
    expect(await launcher.ensure()).toBe(WS);
  });

  describe('upgrade', () => {
    it('replaces an idle daemon of another build: stop, wait for it to go, spawn, wait for it to answer', async () => {
      const { launcher, stop, spawn, probe, logs } = make([old(), old(), null, null, same()]);
      expect(await launcher.ensure()).toBe(WS);
      expect(stop).toHaveBeenCalledWith(CONFIG);
      expect(spawn).toHaveBeenCalledTimes(1);
      // stop is issued before spawn, and spawn only after a null probe
      expect(stop.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[0]);
      expect(probe).toHaveBeenCalledTimes(5);
      expect(logs).toContain('daemon is another build and idle; replacing it');
    });

    it('attaches to a busy daemon of another build and checks back later', async () => {
      const { launcher, stop, spawn, scheduled } = make([old(2)]);
      expect(await launcher.ensure()).toBe(WS);
      expect(stop).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0].ms).toBe(30_000);
    });

    it('replaces the busy daemon on the check-back once it is idle', async () => {
      const { launcher, stop, spawn, scheduled, probe } = make([old(1), old(0), null, same()]);
      await launcher.ensure();
      scheduled[0].fn();
      // let the scheduled attempt run to completion
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
      expect(stop).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledTimes(4);
    });

    it('arms one check-back at a time, and re-arms while it stays busy', async () => {
      const { launcher, scheduled } = make([old(1), old(1), old(3)]);
      await launcher.ensure();
      await launcher.ensure();
      expect(scheduled).toHaveLength(1);
      scheduled[0].fn();
      await vi.waitFor(() => expect(scheduled).toHaveLength(2));
    });

    it('uses the old daemon as is when it cannot be stopped', async () => {
      const { launcher, spawn, logs } = make([old()], { stopOk: false });
      expect(await launcher.ensure()).toBe(WS);
      expect(spawn).not.toHaveBeenCalled();
      expect(logs).toContain('could not reach the running daemon to stop it; using it as is');
    });

    it('uses the old daemon as is when it ignores the stop', async () => {
      let now = 0;
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
      const spawn = vi.fn(() => true);
      const logs: string[] = [];
      const launcher = createRemoteLauncher({
        config: () => CONFIG,
        probe: async () => old(),
        spawn,
        stop: async () => true,
        appVersion: APP,
        sleep: async (ms) => { now += ms; },
        startupTimeoutMs: 1000,
        pollIntervalMs: 250,
        log: (m) => { logs.push(m); },
      });
      expect(await launcher.ensure()).toBe(WS);
      expect(spawn).not.toHaveBeenCalled();
      expect(logs).toContain('daemon did not exit in time; using it as is');
      spy.mockRestore();
    });
  });

  describe('parseDaemonHealth', () => {
    it('reads version and in-flight count', () => {
      expect(parseDaemonHealth('{"ok":true,"version":"0.4.156","sessions":{"live":2,"inFlight":1}}')).toEqual({ version: '0.4.156', inFlight: 1 });
    });
    it('treats a daemon that predates inFlight as idle', () => {
      expect(parseDaemonHealth('{"ok":true,"version":"0.4.156","sessions":{"live":2}}')).toEqual({ version: '0.4.156', inFlight: 0 });
    });
    it('rejects bodies without a version, and non-JSON', () => {
      expect(parseDaemonHealth('{"ok":true}')).toBeNull();
      expect(parseDaemonHealth('<html>')).toBeNull();
    });
  });
});
