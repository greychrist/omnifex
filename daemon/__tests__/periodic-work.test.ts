import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startPeriodicWork } from '../periodic-work';
import type { PeriodicWorkDeps } from '../periodic-work';

const HOUR = 60 * 60 * 1000;

const acct = (id: number) => ({ id, name: `acct-${id}`, config_dir: `/cfg/${id}` });
const FIVE_MIN = 5 * 60 * 1000;

vi.mock('../services/sessions/internal-spend', () => ({
  settleStrandedScratch: vi.fn(() => ({ settled: 0, failed: 0 })),
}));
import { settleStrandedScratch } from '../services/sessions/internal-spend';

const { sweepTick, sweepDeps } = vi.hoisted(() => ({
  sweepTick: vi.fn(async () => 0),
  sweepDeps: [] as unknown[],
}));
vi.mock('../services/summary-sweep', () => ({
  createSummarySweep: vi.fn((d: unknown) => { sweepDeps.push(d); return { tick: sweepTick }; }),
}));

function harness(over: Partial<PeriodicWorkDeps> = {}) {
  const settings: Record<string, string> = {
    'brain.autoIndex': 'true',
    'brain.curate': 'true',
    'brain.sweepHours': '24',
    'sessionsSummary.enabled': 'true',
    'sessionsSummary.autoOnClose': 'true',
  };
  const brain = {
    vaultPath: vi.fn((_id: number): string | null => '/vault'),
    backfill: vi.fn(async (_id: number, _opts?: { sinceMs?: number }) => 0),
    enqueueCuration: vi.fn(() => 0),
    drainQueue: vi.fn(async () => ({}) as never),
  };
  const deps: PeriodicWorkDeps = {
    db: {
      getSetting: (k: string) => settings[k] ?? null,
      reclaimFreePages: vi.fn(),
    },
    listAccounts: vi.fn(() => [acct(1), acct(2)]),
    costHistory: { backfill: vi.fn(async () => ({ sessionsScanned: 3 })), recordInternal: vi.fn() },
    brain: () => brain,
    summary: () => ({ generateSummary: vi.fn(async () => ({ status: 'generated' })) }),
    activeSessionIds: () => ['live-1'],
    log: { info: vi.fn(), warn: vi.fn() },
    ...over,
  };
  return { deps, brain, settings };
}

describe('startPeriodicWork', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(settleStrandedScratch).mockClear();
    sweepTick.mockClear();
    sweepDeps.length = 0;
  });
  afterEach(() => { vi.useRealTimers(); });

  it('backfills cost history 30s after start, then hourly', async () => {
    const { deps } = harness();
    const stop = startPeriodicWork(deps);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.costHistory.backfill).toHaveBeenCalledWith([acct(1), acct(2)]);

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(deps.costHistory.backfill).toHaveBeenCalledTimes(2);
    stop();
  });

  // The backfill's result and failure both arrive after the timer returns.
  it('logs the async startup backfill result, and a rejected sweep as a warning', async () => {
    const backfill = vi.fn()
      .mockResolvedValueOnce({ sessionsScanned: 7 })
      .mockRejectedValueOnce(new Error('EMFILE'));
    const { deps } = harness({ costHistory: { backfill, recordInternal: vi.fn() } });
    const stop = startPeriodicWork(deps);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.log.info).toHaveBeenCalledWith('cost-history startup backfill', { sessionsScanned: 7 });

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(deps.log.warn).toHaveBeenCalledWith('cost-history sweep failed', { error: 'Error: EMFILE' });
    stop();
  });

  it('settles stranded internal transcripts at startup and hourly, recording through the cost table', async () => {
    const { deps } = harness();
    const stop = startPeriodicWork(deps);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settleStrandedScratch).toHaveBeenCalledWith({
      accounts: [acct(1), acct(2)], record: deps.costHistory.recordInternal, nowMs: expect.any(Number),
    });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(settleStrandedScratch).toHaveBeenCalledTimes(2);
    stop();
  });

  it('still prices user sessions when settling throws', async () => {
    const { deps } = harness();
    vi.mocked(settleStrandedScratch).mockImplementationOnce(() => { throw new Error('EACCES'); });
    const stop = startPeriodicWork(deps);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.costHistory.backfill).toHaveBeenCalledTimes(1);
    stop();
  });

  it('sweeps for missing session summaries every five minutes, over every account', async () => {
    const { deps } = harness();
    const stop = startPeriodicWork(deps);
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(sweepTick).toHaveBeenCalledTimes(1);
    const d = sweepDeps[0] as { listConfigDirs(): string[]; activeSessionIds(): string[] };
    expect(d.listConfigDirs()).toEqual(['/cfg/1', '/cfg/2']);
    expect(d.activeSessionIds()).toEqual(['live-1']);
    stop();
  });

  it('does not sweep summaries when summaries or auto-on-close are off', async () => {
    for (const key of ['sessionsSummary.enabled', 'sessionsSummary.autoOnClose']) {
      sweepTick.mockClear();
      const { deps, settings } = harness();
      settings[key] = 'false';
      const stop = startPeriodicWork(deps);
      await vi.advanceTimersByTimeAsync(FIVE_MIN);
      expect(sweepTick).not.toHaveBeenCalled();
      stop();
    }
  });

  it('does not sweep summaries in a process that does not own periodic work', async () => {
    const { deps } = harness({ enabled: () => false });
    const stop = startPeriodicWork(deps);
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(sweepTick).not.toHaveBeenCalled();
    stop();
  });

  // The daemon dies with the app, so most runs are shorter than an hour.
  it('reclaims free pages 30s after start, then hourly', async () => {
    const { deps } = harness();
    const stop = startPeriodicWork(deps);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(deps.db.reclaimFreePages).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deps.db.reclaimFreePages).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR - 30_000);
    expect(deps.db.reclaimFreePages).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does not reclaim at start in a process that does not own periodic work', async () => {
    const { deps } = harness();
    const stop = startPeriodicWork({ ...deps, enabled: () => false });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(deps.db.reclaimFreePages).not.toHaveBeenCalled();
    stop();
  });

  it('sweeps and drains the Brain every five minutes', async () => {
    const { deps, brain } = harness();
    const stop = startPeriodicWork(deps);
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(brain.backfill).toHaveBeenCalledTimes(2); // one per account
    expect(brain.enqueueCuration).toHaveBeenCalledTimes(2);
    expect(brain.drainQueue).toHaveBeenCalledTimes(1);
    stop();
  });

  it('drains even when indexing and curation are both off', async () => {
    const { deps, brain, settings } = harness();
    settings['brain.autoIndex'] = 'false';
    settings['brain.curate'] = 'false';
    const stop = startPeriodicWork(deps);
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(brain.backfill).not.toHaveBeenCalled();
    expect(brain.drainQueue).toHaveBeenCalledTimes(1);
    stop();
  });

  it('skips an account with no vault, and one account failing does not cost the others theirs', async () => {
    const { deps, brain } = harness({ listAccounts: () => [acct(1), acct(2), acct(3)] });
    brain.vaultPath.mockImplementation((id: number) => (id === 2 ? null : '/vault'));
    brain.backfill.mockImplementation(async (id: number) => { if (id === 1) throw new Error('boom'); return 0; });
    const stop = startPeriodicWork(deps);
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(brain.backfill.mock.calls.map((c) => c[0])).toEqual([1, 3]);
    expect(deps.log.warn).toHaveBeenCalled();
    expect(brain.drainQueue).toHaveBeenCalledTimes(1);
    stop();
  });

  // Two daemons can share one database; without the gate both sweep it and the
  // Brain bills twice.

  it('does no work at all while the gate is closed', async () => {
    const { deps, brain } = harness({ enabled: () => false });
    const stop = startPeriodicWork(deps);
    await vi.advanceTimersByTimeAsync(30_000 + HOUR * 2);
    expect(deps.costHistory.backfill).not.toHaveBeenCalled();
    expect(deps.db.reclaimFreePages).not.toHaveBeenCalled();
    expect(brain.drainQueue).not.toHaveBeenCalled();
    expect(settleStrandedScratch).not.toHaveBeenCalled();
    stop();
  });

  it('reads the gate on every tick, not once at start', async () => {
    let daemonInUse = false;
    const { deps } = harness({ enabled: () => !daemonInUse });
    const stop = startPeriodicWork(deps);

    // The startup pass at 30s, then the first hourly tick.
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(deps.db.reclaimFreePages).toHaveBeenCalledTimes(2);

    daemonInUse = true;
    await vi.advanceTimersByTimeAsync(HOUR * 3);
    expect(deps.db.reclaimFreePages).toHaveBeenCalledTimes(2);

    daemonInUse = false;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(deps.db.reclaimFreePages).toHaveBeenCalledTimes(3);
    stop();
  });

  it('runs everything when no gate is supplied', async () => {
    const { deps, brain } = harness();
    const stop = startPeriodicWork(deps);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(deps.costHistory.backfill).toHaveBeenCalled();
    expect(deps.db.reclaimFreePages).toHaveBeenCalled();
    expect(brain.drainQueue).toHaveBeenCalled();
    stop();
  });

  it('stops every timer on dispose', async () => {
    const { deps, brain } = harness();
    const stop = startPeriodicWork(deps);
    stop();
    await vi.advanceTimersByTimeAsync(HOUR * 2);
    expect(deps.costHistory.backfill).not.toHaveBeenCalled();
    expect(deps.db.reclaimFreePages).not.toHaveBeenCalled();
    expect(brain.drainQueue).not.toHaveBeenCalled();
  });

  it('survives a throwing dependency without killing the interval', async () => {
    const { deps } = harness();
    vi.mocked(deps.db.reclaimFreePages).mockImplementationOnce(() => { throw new Error('locked'); });
    const stop = startPeriodicWork(deps);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(deps.log.warn).toHaveBeenCalled();
    expect(deps.db.reclaimFreePages).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(deps.db.reclaimFreePages).toHaveBeenCalledTimes(3);
    stop();
  });

  it('warms the session metadata cache once, ten seconds after start', async () => {
    const warmSessionMetadata = vi.fn(async () => ({ files: 5 }));
    const { deps } = harness({ warmSessionMetadata });
    const stop = startPeriodicWork(deps);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(warmSessionMetadata).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(warmSessionMetadata).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(warmSessionMetadata).toHaveBeenCalledOnce();
    stop();
  });

  // The dev daemon shares the database, so the real one's warm-up serves it.
  it('does not warm the cache when another process owns periodic work', async () => {
    const warmSessionMetadata = vi.fn(async () => ({ files: 0 }));
    const { deps } = harness({ warmSessionMetadata, enabled: () => false });
    const stop = startPeriodicWork(deps);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warmSessionMetadata).not.toHaveBeenCalled();
    stop();
  });

  it('logs rather than throws when the warm-up fails', async () => {
    const warmSessionMetadata = vi.fn(async () => { throw new Error('disk gone'); });
    const { deps } = harness({ warmSessionMetadata });
    const stop = startPeriodicWork(deps);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.log.warn).toHaveBeenCalledWith('session metadata warm-up failed', { error: 'Error: disk gone' });
    stop();
  });
});
