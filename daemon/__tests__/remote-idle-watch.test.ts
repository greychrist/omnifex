import { describe, it, expect } from 'vitest';

import { createIdleWatch, IDLE_CHECK_MS, IDLE_GRACE_MS, progressingTurns, STARTUP_GRACE_MS } from '../remote/idle-watch';

describe('createIdleWatch', () => {
  // A daemon must not outlive the app that spawned it. The app stops it on
  // quit and it shares the app's process group — but neither survives
  // `kill -9` or a crash, and a leftover daemon holds stale permissions and
  // an old build. This is the backstop: no client, no turn, no reason to be
  // here.
  //
  // `everConnected` is asked of the server, not inferred from a poll of
  // `clients`. A 5s tick genuinely missed a client that was attached for 2s
  // (2026-09-13), and a watch that decides "nobody ever came" from samples it
  // may not have taken is a watch that never fires.
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
    // The app died during boot, or was killed before the socket opened.
    // Nothing will ever attach to this daemon; it is already a leftover.
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
  // What the watch counts as "a turn still running". A turn blocked on a
  // permission or question cannot progress once no client is attached —
  // nobody is left to answer, and permissionTimeoutMs defaults to never — so
  // counting it kept a crash-orphaned daemon alive forever (review, 2026-11-18).
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
