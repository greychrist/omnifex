import { describe, it, expect, vi } from 'vitest';

import { createRemoteLauncher, healthUrlFor, parseDaemonHealth, wsUrlFor, type DaemonHealth } from '../remote/launcher';
import type { ServerConfig } from '../remote/config';

const CONFIG = { host: '127.0.0.1', port: 47700 } as ServerConfig;
const WS = 'ws://127.0.0.1:47700/ws';
const APP = '0.5.0';
const UP = { url: WS, outdated: false };
const DOWN = { url: null, outdated: false };

const same = (): DaemonHealth => ({ version: APP, inFlight: 0 });
const old = (inFlight = 0): DaemonHealth => ({ version: '0.4.9', inFlight });

function make(probeResults: Array<DaemonHealth | null>, opts: { spawnOk?: boolean; stopOk?: boolean } = {}) {
  const probe = vi.fn(async () => (probeResults.length ? probeResults.shift()! : null));
  const spawn = vi.fn(() => opts.spawnOk ?? true);
  const stop = vi.fn(async () => opts.stopOk ?? true);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const launcher = createRemoteLauncher({
    config: () => CONFIG,
    probe,
    spawn,
    stop,
    appVersion: APP,
    sleep: async (ms) => { sleeps.push(ms); },
    startupTimeoutMs: 1000,
    pollIntervalMs: 250,
    log: (m) => { logs.push(m); },
  });
  return { launcher, probe, spawn, stop, sleeps, logs };
}

describe('remote launcher', () => {
  it('derives the health and ws urls from the daemon config', () => {
    expect(healthUrlFor(CONFIG)).toBe('http://127.0.0.1:47700/healthz');
    expect(wsUrlFor(CONFIG)).toBe(WS);
  });

  it('returns the url without spawning when a daemon of this build already answers', async () => {
    const { launcher, spawn, stop } = make([same()]);
    expect(await launcher.ensure()).toEqual(UP);
    expect(spawn).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('spawns, then polls until the daemon answers', async () => {
    const { launcher, spawn, probe, sleeps } = make([null, null, null, same()]);
    expect(await launcher.ensure()).toEqual(UP);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([250, 250, 250]);
  });

  it('gives up after the startup timeout and reports no url', async () => {
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
    expect(await launcher.ensure()).toEqual(DOWN);
    // initial probe + 4 polls inside the 1000ms window
    expect(probe).toHaveBeenCalledTimes(5);
    spy.mockRestore();
  });

  it('returns null without polling when the spawn itself fails', async () => {
    const { launcher, probe } = make([null], { spawnOk: false });
    expect(await launcher.ensure()).toEqual(DOWN);
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
    expect(await launcher.ensure()).toEqual(DOWN);
  });

  it('shares one in-flight attempt between concurrent callers, and retries after a null', async () => {
    const probe = vi.fn(async () => null as DaemonHealth | null);
    const spawn = vi.fn(() => false);
    const launcher = createRemoteLauncher({ config: () => CONFIG, probe, spawn, stop: async () => true, appVersion: APP });
    const [a, b] = await Promise.all([launcher.ensure(), launcher.ensure()]);
    expect(a).toEqual(DOWN);
    expect(b).toEqual(DOWN);
    expect(probe).toHaveBeenCalledTimes(1);
    // Not cached: a daemon started by hand later is picked up.
    probe.mockResolvedValueOnce(same());
    expect(await launcher.ensure()).toEqual(UP);
  });

  describe('upgrade', () => {
    it('replaces an idle daemon of another build: stop, wait for it to go, spawn, wait for it to answer', async () => {
      const { launcher, stop, spawn, probe, logs } = make([old(), old(), null, null, same()]);
      expect(await launcher.ensure()).toEqual(UP);
      expect(stop).toHaveBeenCalledWith(CONFIG);
      expect(spawn).toHaveBeenCalledTimes(1);
      // stop is issued before spawn, and spawn only after a null probe
      expect(stop.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[0]);
      expect(probe).toHaveBeenCalledTimes(5);
      expect(logs).toContain('daemon is another build and idle; replacing it');
    });

    // The caller re-runs ensure() while `outdated` holds: the app is the
    // long-lived process, and this one exits after answering.
    it('attaches to a busy daemon of another build and says it is outdated', async () => {
      const { launcher, stop, spawn } = make([old(2)]);
      expect(await launcher.ensure()).toEqual({ url: WS, outdated: true });
      expect(stop).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('replaces the outdated daemon on a later ensure once it is idle', async () => {
      const { launcher, stop, spawn, probe } = make([old(1), old(0), null, same()]);
      expect(await launcher.ensure()).toEqual({ url: WS, outdated: true });
      expect(await launcher.ensure()).toEqual(UP);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledTimes(4);
    });

    it('uses the old daemon as is when it cannot be stopped', async () => {
      const { launcher, spawn, logs } = make([old()], { stopOk: false });
      expect(await launcher.ensure()).toEqual(UP);
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
      expect(await launcher.ensure()).toEqual(UP);
      expect(spawn).not.toHaveBeenCalled();
      expect(logs).toContain('daemon did not exit in time; using it as is');
      spy.mockRestore();
    });
  });

  describe('build stamp (dev)', () => {
    const stamped = (build: string, inFlight = 0): DaemonHealth => ({ version: APP, build, inFlight });

    function makeStamped(
      probeResults: Array<DaemonHealth | null>,
      appBuild?: string,
      extra: Partial<Parameters<typeof createRemoteLauncher>[0]> = {},
    ) {
      const probe = vi.fn(async () => (probeResults.length ? probeResults.shift()! : null));
      const stop = vi.fn(async () => true);
      const spawn = vi.fn(() => true);
      const logs: string[] = [];
      const launcher = createRemoteLauncher({
        config: () => CONFIG, probe, stop, spawn, appVersion: APP, appBuild,
        sleep: async () => {}, startupTimeoutMs: 1000, pollIntervalMs: 250,
        log: (m) => { logs.push(m); },
        ...extra,
      });
      return { launcher, stop, spawn, logs };
    }

    it('replaces a same-version daemon whose build stamp differs', async () => {
      const { launcher, stop, spawn } = makeStamped([stamped('100'), null, stamped('200')], '200');
      expect(await launcher.ensure()).toEqual(UP);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('keeps a same-version daemon with the same stamp', async () => {
      const { launcher, stop } = makeStamped([stamped('200')], '200');
      expect(await launcher.ensure()).toEqual(UP);
      expect(stop).not.toHaveBeenCalled();
    });

    // The incident: `npm start` killed the daemon the INSTALLED app's live
    // sessions were running in. Same version, different bundle, so the stamp
    // mismatched and the dev app retired a daemon it had never started —
    // every CLI process with it. A dev build is a guest on this port.
    it("never retires another install's daemon", async () => {
      const { launcher, stop, spawn, logs } = makeStamped(
        [{ version: APP, build: '100', script: '/Applications/OmniFex.app/omnifex-server.js', inFlight: 0 }],
        '200',
        { appScript: '/repo/.vite/build/omnifex-server.js' },
      );
      expect(await launcher.ensure()).toEqual(UP);
      expect(stop).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(logs).toContain('daemon belongs to another install; attaching to it instead of replacing it');
    });

    it("does not retire another install's daemon over a version difference either", async () => {
      const { launcher, stop } = makeStamped(
        [{ version: '0.4.9', build: '100', script: '/Applications/OmniFex.app/omnifex-server.js', inFlight: 0 }],
        '200',
        { appScript: '/repo/.vite/build/omnifex-server.js' },
      );
      expect(await launcher.ensure()).toEqual(UP);
      expect(stop).not.toHaveBeenCalled();
    });

    it('still replaces a stale daemon started from the same dev bundle', async () => {
      const script = '/repo/.vite/build/omnifex-server.js';
      const { launcher, stop, spawn } = makeStamped(
        [{ version: APP, build: '100', script, inFlight: 0 }, null, { version: APP, build: '200', script, inFlight: 0 }],
        '200',
        { appScript: script },
      );
      expect(await launcher.ensure()).toEqual(UP);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('treats a daemon that reports no script as not ours', async () => {
      // Pre-0.4.167 daemon: it cannot prove where it came from, and a dev app
      // guessing wrong costs live sessions. It gets to keep the port.
      const { launcher, stop } = makeStamped([stamped('100')], '200', {
        appScript: '/repo/.vite/build/omnifex-server.js',
      });
      expect(await launcher.ensure()).toEqual(UP);
      expect(stop).not.toHaveBeenCalled();
    });

    it('the installed app keeps full authority over the port', async () => {
      // Packaged: no stamp, and a version mismatch is a real upgrade — replace
      // it wherever it was started from (the app may have been moved).
      const { launcher, stop, spawn } = makeStamped(
        [{ version: '0.4.9', script: '/Volumes/old/OmniFex.app/omnifex-server.js', inFlight: 0 }, null, same()],
        undefined,
        { appScript: '/Applications/OmniFex.app/omnifex-server.js' },
      );
      expect(await launcher.ensure()).toEqual(UP);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('ignores stamps when the app has none (packaged) or the daemon reports none', async () => {
      const a = makeStamped([stamped('100')], undefined);
      expect(await a.launcher.ensure()).toEqual(UP);
      expect(a.stop).not.toHaveBeenCalled();
      const b = makeStamped([same()], '200');
      expect(await b.launcher.ensure()).toEqual(UP);
      expect(b.stop).not.toHaveBeenCalled();
    });
  });

  describe('restart', () => {
    it('stops the running daemon, waits for it to go, spawns, and waits for the new one', async () => {
      // probe: running → gone → gone → answering
      const { launcher, stop, spawn, probe } = make([same(), null, same()]);
      expect(await launcher.restart()).toEqual(UP);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledTimes(3);
    });

    it('restarts even when a turn is in flight — the user asked', async () => {
      const { launcher, stop, spawn } = make([{ version: APP, inFlight: 2 }, null, same()]);
      expect(await launcher.restart()).toEqual(UP);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('just spawns when nothing is running', async () => {
      const { launcher, stop, spawn } = make([null, same()]);
      expect(await launcher.restart()).toEqual(UP);
      expect(stop).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('keeps the running daemon when it cannot be signalled, rather than spawning onto its port', async () => {
      const { launcher, spawn, logs } = make([same()], { stopOk: false });
      expect(await launcher.restart()).toEqual(UP);
      expect(spawn).not.toHaveBeenCalled();
      expect(logs.some((l) => l.includes('could not reach'))).toBe(true);
    });

    it('reports no url when the new daemon never answers', async () => {
      let now = 0;
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const probe = vi.fn(async () => { now += 300; return null; });
        const launcher = createRemoteLauncher({
          config: () => CONFIG,
          probe,
          spawn: () => true,
          stop: async () => true,
          appVersion: APP,
          sleep: async () => {},
          startupTimeoutMs: 1000,
          pollIntervalMs: 250,
        });
        expect(await launcher.restart()).toEqual(DOWN);
      } finally {
        spy.mockRestore();
      }
    });

    it('shares the in-flight slot: an ensure() during a restart gets the restart result', async () => {
      const { launcher, spawn } = make([same(), null, same()]);
      const restarting = launcher.restart();
      const ensured = launcher.ensure();
      expect(await Promise.all([restarting, ensured])).toEqual([UP, UP]);
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('parseDaemonHealth', () => {
    it('reads version and in-flight count', () => {
      expect(parseDaemonHealth('{"ok":true,"version":"0.4.156","sessions":{"live":2,"inFlight":1}}')).toEqual({ version: '0.4.156', inFlight: 1 });
    });
    it('carries the build stamp when reported', () => {
      expect(parseDaemonHealth('{"version":"0.4.156","build":"1757520000000"}')).toEqual({ version: '0.4.156', build: '1757520000000', inFlight: 0 });
    });

    it('carries the daemon script path when reported', () => {
      expect(parseDaemonHealth('{"version":"0.4.156","script":"/Applications/OmniFex.app/omnifex-server.js"}'))
        .toEqual({ version: '0.4.156', script: '/Applications/OmniFex.app/omnifex-server.js', inFlight: 0 });
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

/**
 * On a tailnet host the daemon also listens on loopback, and the Mac app must
 * load from there: WebKit runs plain http on a non-loopback address in its
 * EnhancedSecurity process — no JIT, ~5x slower JavaScript — and gives it no
 * secure context (no async clipboard). Loopback is "potentially trustworthy".
 */
describe('remote launcher on a tailnet host', () => {
  const TAILNET = { host: '100.64.1.2', port: 47700 } as ServerConfig;
  const LOOPBACK_HEALTH = 'http://127.0.0.1:47700/healthz';

  function tailnet(answers: (url: string, call: number) => DaemonHealth | null) {
    let call = 0;
    const probe = vi.fn(async (url: string) => answers(url, call++));
    const launcher = createRemoteLauncher({
      config: () => TAILNET,
      probe,
      spawn: () => true,
      stop: async () => true,
      appVersion: APP,
      sleep: async () => {},
      startupTimeoutMs: 1000,
      pollIntervalMs: 250,
    });
    return { launcher, probe };
  }

  it('hands back the loopback url when the daemon answers there', async () => {
    const { launcher, probe } = tailnet(() => same());
    expect(await launcher.ensure()).toEqual({ url: 'ws://127.0.0.1:47700/ws', outdated: false });
    expect(probe).toHaveBeenLastCalledWith(LOOPBACK_HEALTH);
  });

  it('keeps the tailnet url for a daemon that does not listen on loopback', async () => {
    const { launcher } = tailnet((url) => (url === LOOPBACK_HEALTH ? null : same()));
    expect(await launcher.ensure()).toEqual({ url: 'ws://100.64.1.2:47700/ws', outdated: false });
  });

  it('keeps the tailnet url for an older build kept mid-turn, which predates loopback', async () => {
    const { launcher } = tailnet((url) => (url === LOOPBACK_HEALTH ? null : old(1)));
    expect(await launcher.ensure()).toEqual({ url: 'ws://100.64.1.2:47700/ws', outdated: true });
  });

  it('applies to restart too', async () => {
    // running → stopped → spawned and answering (both addresses)
    const { launcher } = tailnet((url, call) => (call === 1 ? null : same()));
    expect(await launcher.restart()).toEqual({ url: 'ws://127.0.0.1:47700/ws', outdated: false });
  });

  // A daemon started before Tailscale came up listens on loopback only. The
  // launcher computes the tailnet address now, finds nothing there, and used
  // to spawn a second daemon beside the running one.
  it('finds a daemon that answers only on loopback instead of spawning another', async () => {
    let spawned = 0;
    const probe = vi.fn(async (url: string) => (url === LOOPBACK_HEALTH ? same() : null));
    const launcher = createRemoteLauncher({
      config: () => TAILNET, probe, spawn: () => { spawned++; return true; }, stop: async () => true,
      appVersion: APP, sleep: async () => {}, startupTimeoutMs: 1000, pollIntervalMs: 250,
    });
    expect(await launcher.ensure()).toEqual({ url: 'ws://127.0.0.1:47700/ws', outdated: false });
    expect(spawned).toBe(0);
  });

  it('replaces an outdated loopback-only daemon, as on any address', async () => {
    let calls = 0;
    const stop = vi.fn(async () => true);
    // loopback answers old → stopped → spawned daemon answers on both
    const probe = vi.fn(async (url: string) => {
      calls++;
      if (calls <= 2) return url === LOOPBACK_HEALTH ? old() : null;
      if (calls <= 4) return null;
      return same();
    });
    const launcher = createRemoteLauncher({
      config: () => TAILNET, probe, spawn: () => true, stop,
      appVersion: APP, sleep: async () => {}, startupTimeoutMs: 1000, pollIntervalMs: 250,
    });
    expect((await launcher.ensure()).url).toBe('ws://127.0.0.1:47700/ws');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('reports nothing when the daemon is down', async () => {
    const { launcher } = tailnet(() => null);
    expect((await launcher.ensure()).url).toBeNull();
  });
});
