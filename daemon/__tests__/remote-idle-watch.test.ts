import { describe, it, expect } from 'vitest';

import { createIdleWatch, IDLE_CHECK_MS, IDLE_GRACE_MS, progressingTurns, STARTUP_GRACE_MS } from '../remote/idle-watch';

describe('createIdleWatch', () => {
  const watch = (
    clients: () => number,
    opts: { inFlight?: () => number; everConnected?: () => boolean; startedAt?: number } = {},
  ) =>
    createIdleWatch({
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
    expect(w.check(121_000)).toBe(false);
    expect(w.check(152_000)).toBe(true);
  });

  it('gives the app time to make its first connection', () => {
    const w = watch(() => 0, { everConnected: () => false, startedAt: 1_000 });
    expect(w.check(2_000)).toBe(false);
    expect(w.check(60_000)).toBe(false);
  });

  it('exits when nothing ever connects — the app it belonged to is gone', () => {
    const w = watch(() => 0, { everConnected: () => false, startedAt: 1_000 });
    expect(w.check(60_000)).toBe(false);
    expect(w.check(121_000)).toBe(true);
  });

  it('keeps the values the dev daemon has always used', () => {
    expect(IDLE_GRACE_MS).toBe(30_000);
    expect(STARTUP_GRACE_MS).toBe(120_000);
    expect(IDLE_CHECK_MS).toBe(5_000);
  });
});

describe('progressingTurns', () => {
  // A turn blocked on a permission cannot progress with no client, and
  // permissionTimeoutMs defaults to never.
  it('counts turns that can still finish on their own', () => {
    expect(progressingTurns([{ inFlight: true, pendingPermissions: 0 }])).toBe(1);
  });

  it('does not count a turn waiting on the user', () => {
    expect(progressingTurns([{ inFlight: true, pendingPermissions: 1 }])).toBe(0);
  });

  it('does not count idle sessions', () => {
    expect(progressingTurns([
      { inFlight: false, pendingPermissions: 0 },
      { inFlight: true, pendingPermissions: 0 },
      { inFlight: true, pendingPermissions: 2 },
    ])).toBe(1);
  });
});
