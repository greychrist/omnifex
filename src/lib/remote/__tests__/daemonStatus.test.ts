import { describe, it, expect, vi } from 'vitest';

import { daemonHealthUrl, fetchDaemonHealth, formatUptime, parseDaemonHealthInfo } from '@/lib/remote/daemonStatus';

describe('daemonHealthUrl', () => {
  it('derives /healthz from the Electron socket url', () => {
    expect(daemonHealthUrl({ mode: 'electron-remote', url: 'ws://100.64.0.1:47700/ws' }, 'http://localhost:5174'))
      .toBe('http://100.64.0.1:47700/healthz');
    expect(daemonHealthUrl({ mode: 'electron-remote', url: 'wss://mac.tail.ts.net/ws' }, 'x'))
      .toBe('https://mac.tail.ts.net/healthz');
  });

  it('uses the page origin on the web, where the daemon served the page', () => {
    expect(daemonHealthUrl({ mode: 'web', url: 'wss://mac.tail.ts.net/ws' }, 'https://mac.tail.ts.net'))
      .toBe('https://mac.tail.ts.net/healthz');
  });

  it('is null without a daemon', () => {
    expect(daemonHealthUrl({ mode: 'electron-legacy', url: null }, 'x')).toBeNull();
    expect(daemonHealthUrl({ mode: 'electron-remote', url: null }, 'x')).toBeNull();
    expect(daemonHealthUrl(undefined, 'x')).toBeNull();
  });
});

describe('parseDaemonHealthInfo', () => {
  it('reads the full body', () => {
    expect(parseDaemonHealthInfo({
      ok: true, version: '0.4.156', protocolVersion: 1, uptimeSec: 90, host: '127.0.0.1', port: 47700, clients: 2,
      sessions: { live: 3, known: 10, inFlight: 1 },
    })).toEqual({
      ok: true, version: '0.4.156', protocolVersion: 1, uptimeSec: 90, host: '127.0.0.1', port: 47700, clients: 2,
      sessions: { live: 3, known: 10, inFlight: 1 },
    });
  });

  it('defaults fields an older daemon does not send', () => {
    expect(parseDaemonHealthInfo({ ok: true, version: '0.4.1' })).toMatchObject({
      version: '0.4.1', clients: 0, sessions: { live: 0, known: 0, inFlight: 0 },
    });
  });

  it('rejects anything without a version', () => {
    expect(parseDaemonHealthInfo({ ok: true })).toBeNull();
    expect(parseDaemonHealthInfo('nope')).toBeNull();
    expect(parseDaemonHealthInfo(null)).toBeNull();
  });
});

describe('fetchDaemonHealth', () => {
  it('fetches without caching and parses', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, version: '1.0.0' }) })) as unknown as typeof fetch;
    const info = await fetchDaemonHealth('http://d/healthz', fetchImpl);
    expect(info?.version).toBe('1.0.0');
    expect(fetchImpl).toHaveBeenCalledWith('http://d/healthz', { cache: 'no-store' });
  });

  it('throws on a non-2xx answer', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(fetchDaemonHealth('http://d/healthz', fetchImpl)).rejects.toThrow('503');
  });
});

describe('formatUptime', () => {
  it('picks the two most significant units', () => {
    expect(formatUptime(45)).toBe('45s');
    expect(formatUptime(12 * 60 + 5)).toBe('12m');
    expect(formatUptime(4 * 3600 + 12 * 60)).toBe('4h 12m');
    expect(formatUptime(3 * 86400 + 4 * 3600 + 59)).toBe('3d 4h');
    expect(formatUptime(-5)).toBe('0s');
  });
});
