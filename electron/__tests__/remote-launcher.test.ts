import { describe, it, expect, vi } from 'vitest';

import { createRemoteLauncher, healthUrlFor, wsUrlFor } from '../remote-launcher';
import type { ServerConfig } from '../remote/config';

const CONFIG = { host: '127.0.0.1', port: 47700 } as ServerConfig;

function make(probeResults: boolean[], spawnOk = true) {
  const probe = vi.fn(async () => probeResults.shift() ?? false);
  const spawn = vi.fn(() => spawnOk);
  const sleeps: number[] = [];
  const launcher = createRemoteLauncher({
    config: () => CONFIG,
    probe,
    spawn,
    sleep: async (ms) => { sleeps.push(ms); },
    startupTimeoutMs: 1000,
    pollIntervalMs: 250,
  });
  return { launcher, probe, spawn, sleeps };
}

describe('remote launcher', () => {
  it('derives the health and ws urls from the daemon config', () => {
    expect(healthUrlFor(CONFIG)).toBe('http://127.0.0.1:47700/healthz');
    expect(wsUrlFor(CONFIG)).toBe('ws://127.0.0.1:47700/ws');
  });

  it('returns the url without spawning when the daemon already answers', async () => {
    const { launcher, spawn } = make([true]);
    expect(await launcher.ensure()).toBe('ws://127.0.0.1:47700/ws');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns, then polls until the daemon answers', async () => {
    const { launcher, spawn, probe, sleeps } = make([false, false, false, true]);
    expect(await launcher.ensure()).toBe('ws://127.0.0.1:47700/ws');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([250, 250, 250]);
  });

  it('gives up after the startup timeout and reports legacy', async () => {
    let now = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const probe = vi.fn(async () => false);
    const launcher = createRemoteLauncher({
      config: () => CONFIG,
      probe,
      spawn: () => true,
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
    const { launcher, probe } = make([false], false);
    expect(await launcher.ensure()).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('returns null when the config cannot be read, rather than throwing into the window', async () => {
    const launcher = createRemoteLauncher({
      config: () => { throw new Error('server.json is not valid JSON'); },
      probe: async () => true,
      spawn: () => true,
    });
    expect(await launcher.ensure()).toBeNull();
  });

  it('shares one in-flight attempt between concurrent callers, and retries after a null', async () => {
    const probe = vi.fn(async () => false);
    const spawn = vi.fn(() => false);
    const launcher = createRemoteLauncher({ config: () => CONFIG, probe, spawn });
    const [a, b] = await Promise.all([launcher.ensure(), launcher.ensure()]);
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
    // Not cached: a daemon started by hand later is picked up.
    probe.mockResolvedValueOnce(true);
    expect(await launcher.ensure()).toBe('ws://127.0.0.1:47700/ws');
  });
});
