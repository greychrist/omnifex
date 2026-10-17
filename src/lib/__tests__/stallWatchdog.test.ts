import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('@/services/tabPersistence', () => ({
  TabPersistenceService: {
    loadTabs: () => ({
      activeTabId: 't2',
      tabs: [
        { id: 't1', type: 'chat', title: 'small', sessionId: 's1' },
        { id: 't2', type: 'projects', title: 'Projects' },
      ],
    }),
  },
}));
vi.mock('@/stores/claudeSessionStore', () => ({
  useClaudeSessionStore: {
    getState: () => ({
      tabs: { t1: { messages: [1, 2] }, t3: { messages: new Array(3988) } },
    }),
  },
}));

const logWriteBatch = vi.fn();
vi.mock('@/lib/api', () => ({ api: { logWriteBatch: (...a: unknown[]) => logWriteBatch(...a) } }));

import { createStallWatchdog, writeWithRetry, stallContext, installStallWatchdog } from '@/lib/stallWatchdog';

describe('createStallWatchdog', () => {
  let clock: number;
  let tick: (() => void) | null;
  let visible: boolean;
  const onStall = vi.fn();

  const start = (thresholdMs = 2000) =>
    createStallWatchdog({
      intervalMs: 500,
      thresholdMs,
      now: () => clock,
      every: (fn) => { tick = fn; return () => { tick = null; }; },
      isVisible: () => visible,
      onStall,
    });

  const advance = (ms: number) => { clock += ms; tick?.(); };

  beforeEach(() => { clock = 1_000_000; tick = null; visible = true; onStall.mockReset(); });

  it('stays quiet while ticks arrive on time', () => {
    start();
    for (let i = 0; i < 20; i++) advance(500);
    advance(1_900); // late, but under the threshold
    expect(onStall).not.toHaveBeenCalled();
  });

  it('reports how long the thread was blocked when a tick arrives late', () => {
    start();
    advance(500);
    advance(135_500);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenCalledWith({
      stalledMs: 135_000,
      startedAt: new Date(1_001_000).toISOString(),
      endedAt: new Date(1_136_000).toISOString(),
    });
  });

  // A hidden window is not a stalled one: its timers may be throttled, and a
  // gap there is not evidence of anything.
  it('ignores a gap that spans a hidden window', () => {
    start();
    visible = false;
    advance(60_000);
    visible = true;
    advance(500);
    advance(500);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('stops ticking when stopped', () => {
    const stop = start();
    stop();
    expect(tick).toBeNull();
  });
});

describe('writeWithRetry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // The stall this exists to catch is the one that gets the daemon to drop
  // the socket, so the first write usually lands on a dead connection.
  it('retries until the write lands', async () => {
    const write = vi.fn()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockRejectedValueOnce(new Error('not connected'))
      .mockResolvedValueOnce(undefined);

    const done = writeWithRetry(write, { retryMs: 2000, attempts: 5 });
    await vi.advanceTimersByTimeAsync(4000);

    await expect(done).resolves.toBe(true);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('gives up after the last attempt', async () => {
    const write = vi.fn().mockRejectedValue(new Error('down'));

    const done = writeWithRetry(write, { retryMs: 2000, attempts: 3 });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(done).resolves.toBe(false);
    expect(write).toHaveBeenCalledTimes(3);
  });
});

// Every open tab is mounted, so the tab doing the work need not be the one on
// screen: name the active tab, and rank every tab by transcript size.
it('stallContext names the active tab and ranks tabs by transcript size', () => {
  expect(stallContext()).toEqual({
    activeTab: { id: 't2', type: 'projects', title: 'Projects', sessionId: null },
    tabMessages: [
      { id: 't3', messages: 3988 },
      { id: 't1', messages: 2 },
    ],
  });
});

describe('installStallWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { visibilityState: 'visible' });
    logWriteBatch.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('writes a renderer-stall warn to app_logs when the thread blocks', async () => {
    const stop = installStallWatchdog();
    await vi.advanceTimersByTimeAsync(500);
    vi.setSystemTime(Date.now() + 30_000); // the thread was busy; no tick ran
    await vi.advanceTimersByTimeAsync(500);
    stop();

    expect(logWriteBatch).toHaveBeenCalledTimes(1);
    const [entry] = logWriteBatch.mock.calls[0][0] as Array<Record<string, string>>;
    expect(entry).toMatchObject({ level: 'warn', source: 'frontend', category: 'renderer-stall' });
    expect(entry.message).toBe('renderer main thread stalled 30.0s');
    expect(JSON.parse(entry.metadata)).toMatchObject({
      stalledMs: 30_000,
      activeTab: { id: 't2', type: 'projects' },
    });
  });
});
