import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startPeriodicWork } from '../periodic-work';
import type { PeriodicWorkDeps } from '../periodic-work';

const HOUR = 60 * 60 * 1000;

/** The shape the cost sweep and the Brain sweep each need a slice of. */
const acct = (id: number) => ({ id, name: `acct-${id}`, config_dir: `/cfg/${id}` });
const FIVE_MIN = 5 * 60 * 1000;

vi.mock('../services/sessions/internal-archive', () => ({
  pruneInternalArchive: vi.fn(),
}));
import { pruneInternalArchive } from '../services/sessions/internal-archive';

function harness(over: Partial<PeriodicWorkDeps> = {}) {
  const settings: Record<string, string> = {
    'brain.autoIndex': 'true',
    'brain.curate': 'true',
    'brain.sweepHours': '24',
    'internal.archive.retentionDays': '90',
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
    costHistory: { backfill: vi.fn(() => ({ sessionsScanned: 3 })) },
    costBackfillOpts: { archiveRoot: '/archive' },
    internalArchive: '/archive',
    brain: () => brain,
    log: { info: vi.fn(), warn: vi.fn() },
    ...over,
  };
  return { deps, brain, settings };
}

describe('startPeriodicWork', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(pruneInternalArchive).mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('backfills cost history 30s after start, then hourly, pruning the archive after each sweep', async () => {
    const { deps } = harness();
    const stop = startPeriodicWork(deps);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.costHistory.backfill).toHaveBeenCalledWith([acct(1), acct(2)], { archiveRoot: '/archive' });
    // The startup pass prices only; pruning belongs to the hourly sweep.
    expect(pruneInternalArchive).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(deps.costHistory.backfill).toHaveBeenCalledTimes(2);
    // Prune AFTER pricing, never before — an unpriced transcript deleted for
    // being old takes its spend with it.
    expect(pruneInternalArchive).toHaveBeenCalledWith('/archive', 90, expect.any(String));
    stop();
  });

  it('reclaims free pages hourly', async () => {
    const { deps } = harness();
    const stop = startPeriodicWork(deps);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(deps.db.reclaimFreePages).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(deps.db.reclaimFreePages).toHaveBeenCalledTimes(2);
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
    // Work already queued still has to leave the queue.
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

  // ── The gate ────────────────────────────────────────────────────────────
  // main.ts and the daemon build the same service graph. Remote mode is the
  // default, so both processes are normally alive; without this gate both run
  // every block below against one database, and the Brain's extraction is
  // billed twice for the item `recoverOrphans` hands back.

  it('does no work at all while the gate is closed', async () => {
    const { deps, brain } = harness({ enabled: () => false });
    const stop = startPeriodicWork(deps);
    await vi.advanceTimersByTimeAsync(30_000 + HOUR * 2);
    expect(deps.costHistory.backfill).not.toHaveBeenCalled();
    expect(deps.db.reclaimFreePages).not.toHaveBeenCalled();
    expect(brain.drainQueue).not.toHaveBeenCalled();
    expect(pruneInternalArchive).not.toHaveBeenCalled();
    stop();
  });

  it('reads the gate on every tick, not once at start', async () => {
    // main.ts only learns whether the daemon answered when the renderer asks
    // for `remote:url`, which is after the timers are armed. A gate sampled at
    // construction would always read "no daemon".
    let daemonInUse = false;
    const { deps } = harness({ enabled: () => !daemonInUse });
    const stop = startPeriodicWork(deps);

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(deps.db.reclaimFreePages).toHaveBeenCalledTimes(1);

    daemonInUse = true;
    await vi.advanceTimersByTimeAsync(HOUR * 3);
    expect(deps.db.reclaimFreePages).toHaveBeenCalledTimes(1);

    daemonInUse = false;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(deps.db.reclaimFreePages).toHaveBeenCalledTimes(2);
    stop();
  });

  it('runs everything when no gate is supplied', async () => {
    // The daemon owns this work unconditionally; it passes no gate.
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
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(deps.db.reclaimFreePages).toHaveBeenCalledTimes(2);
    stop();
  });
});
