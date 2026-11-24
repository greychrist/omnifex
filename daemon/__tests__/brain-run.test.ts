import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createBrainService, type BrainRun } from '../services/brain/registry';
import type { BrainSource } from '../services/brain/sources/types';
import { SESSION_SOURCE_ID } from '../services/brain/sources/session-transcripts';
import type { AccountsService } from '../services/accounts';

describe('brain indexing runs', () => {
  let dir: string;
  let db: Database;

  const stubExec = async () => '';
  const accountsStub = {
    listAccounts: () => [
      { id: 1, config_dir: '/cfg/personal' },
      { id: 2, config_dir: '/cfg/work' },
    ],
  } as unknown as AccountsService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-brain-run-'));
    db = createDatabase(':memory:');
    db.raw.prepare('INSERT INTO accounts (id, name, config_dir) VALUES (?, ?, ?)')
      .run(1, 'Personal', '/cfg/personal');
    db.raw.prepare('INSERT INTO accounts (id, name, config_dir) VALUES (?, ?, ?)')
      .run(2, 'Work', '/cfg/work');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeSource(accountId: number, keys: string[]): BrainSource {
    return {
      id: 'fake',
      discover: () => Promise.resolve(keys.map((k) => ({
        sourceId: 'fake', itemKey: k, accountId,
        path: join(dir, k), mtimeMs: 1, size: 10, label: 'fake',
      }))),
      admit: () => ({ admitted: true, reason: 'ok' }),
      distill: () => Promise.resolve({
        prose: 'x', truncated: false,
        metadata: {
          kind: 'capture' as const,
          capturedAt: '2026-08-12T00:00:00.000Z', project: null, cwd: null,
        },
      }),
    };
  }

  function gatedExtractor() {
    const release: ((value?: unknown) => void)[] = [];
    const extractor = () =>
      new Promise<{ entities: never[] }>((resolve) => {
        release.push(() => { resolve({ entities: [] }); });
      });
    return { extractor, release };
  }

  async function until(pred: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 500; i += 1) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 1));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  it('reports no run when nothing is indexing', () => {
    const brain = createBrainService(db, { execGit: stubExec, accounts: accountsStub });
    expect(brain.currentRun(1)).toBeNull();
    brain.closeAll();
  });

  it('counts items finished, not items started', async () => {
    const { extractor, release } = gatedExtractor();
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub, extractor,
      sources: [fakeSource(1, ['a', 'b'])],
    });
    brain.setVaultPath(1, join(dir, 'v1'));

    const run = brain.indexSelection(1, ['a', 'b']);

    await until(() => release.length === 1, 'first item to reach the extractor');
    expect(brain.currentRun(1)).toMatchObject({ total: 2, completed: 0, item: 'a' });

    release[0]();
    await until(() => release.length === 2, 'second item to reach the extractor');
    expect(brain.currentRun(1)).toMatchObject({ total: 2, completed: 1, item: 'b' });

    release[1]();
    await run;
    expect(brain.currentRun(1)).toBeNull();
    brain.closeAll();
  });

  it('publishes a run for a background queue drain, not just a manual selection', async () => {
    const seen: (BrainRun | null)[] = [];
    const { extractor, release } = gatedExtractor();
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub, extractor,
      sources: [fakeSource(1, ['a', 'b'])],
      onRunProgress: (run) => { seen.push(run); },
    });
    brain.setVaultPath(1, join(dir, 'v-queue'));

    await brain.backfill(1);
    const drain = brain.drainQueue();

    await until(() => release.length === 1, 'first queued item');
    expect(brain.currentRun(1)).toMatchObject({ total: 2, completed: 0, item: 'a' });

    release[0]();
    await until(() => release.length === 2, 'second queued item');
    expect(brain.currentRun(1)).toMatchObject({ total: 2, completed: 1, item: 'b' });

    release[1]();
    await drain;
    expect(brain.currentRun(1)).toBeNull();
    expect(seen[seen.length - 1]).toBeNull();
    brain.closeAll();
  });

  it('widens the total when work is enqueued mid-drain', async () => {
    const { extractor, release } = gatedExtractor();
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub, extractor,
      sources: [fakeSource(1, ['a', 'late-arrival'])],
      onRunProgress: () => undefined,
    });
    brain.setVaultPath(1, join(dir, 'v-widen'));

    await brain.enqueueSource(1, 'a');
    const drain = brain.drainQueue();
    await until(() => release.length === 1, 'first queued item');
    expect(brain.currentRun(1)).toMatchObject({ total: 1, completed: 0 });

    await brain.enqueueSource(1, 'late-arrival');
    release[0]();

    await until(() => release.length === 2, 'the late arrival to reach the extractor');
    expect(brain.currentRun(1)).toMatchObject({ total: 2, completed: 1, item: 'late-arrival' });
    release[1]();
    await drain;
    brain.closeAll();
  });

  it('widens the published frame as soon as work is queued, not at the next claim', async () => {
    const seen: (BrainRun | null)[] = [];
    const { extractor, release } = gatedExtractor();
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub, extractor,
      sources: [fakeSource(1, ['a', 'second-close', 'third-close'])],
      onRunProgress: (run) => { seen.push(run); },
    });
    brain.setVaultPath(1, join(dir, 'v-live-total'));

    await brain.enqueueSource(1, 'a');
    const drain = brain.drainQueue();
    await until(() => release.length === 1, 'first queued item');
    expect(seen[seen.length - 1]).toMatchObject({ total: 1, completed: 0, item: 'a' });

    await brain.enqueueSource(1, 'second-close');
    expect(seen[seen.length - 1]).toMatchObject({ total: 2, completed: 0, item: 'a' });

    await brain.enqueueSource(1, 'third-close');
    expect(seen[seen.length - 1]).toMatchObject({ total: 3, completed: 0, item: 'a' });
    expect(brain.currentRun(1)).toMatchObject({ total: 3, completed: 0 });

    release[0]();
    await until(() => release.length === 2, 'the second item to start');
    release[1]();
    await until(() => release.length === 3, 'the third item to start');
    release[2]();
    await drain;
    brain.closeAll();
  });

  it('publishes nothing when an enqueue does not change the count', async () => {
    const seen: (BrainRun | null)[] = [];
    const { extractor, release } = gatedExtractor();
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub, extractor,
      sources: [fakeSource(1, ['a', 'b'])],
      onRunProgress: (run) => { seen.push(run); },
    });
    brain.setVaultPath(1, join(dir, 'v-no-churn'));

    await brain.enqueueSource(1, 'a');
    const drain = brain.drainQueue();
    await until(() => release.length === 1, 'first queued item');

    await brain.enqueueSource(1, 'b');
    const after = seen.length;
    await brain.enqueueSource(1, 'b');
    expect(seen.length).toBe(after);

    release[0]();
    await until(() => release.length === 2, 'the second item to start');
    release[1]();
    await drain;
    brain.closeAll();
  });

  it('leaves a manual selection total alone when the queue grows behind it', async () => {
    const seen: (BrainRun | null)[] = [];
    const { extractor, release } = gatedExtractor();
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub, extractor,
      sources: [fakeSource(1, ['a', 'b', 'c', 'late-close'])],
      onRunProgress: (run) => { seen.push(run); },
    });
    brain.setVaultPath(1, join(dir, 'v-selection-total'));

    const run = brain.indexSelection(1, ['a', 'b', 'c']);
    await until(() => release.length === 1, 'the first selected item');
    expect(seen[seen.length - 1]).toMatchObject({ total: 3, completed: 0, item: 'a' });

    await brain.enqueueSource(1, 'late-close');
    expect(seen[seen.length - 1]).toMatchObject({ total: 3, completed: 0, item: 'a' });

    release[0]();
    await until(() => release.length === 2, 'the second selected item');
    expect(brain.currentRun(1)).toMatchObject({ total: 3, completed: 1, item: 'b' });

    release[1]();
    await until(() => release.length === 3, 'the third selected item');
    release[2]();
    await run;

    const last = seen.filter((f) => f !== null).at(-1);
    expect(last).toMatchObject({ total: 3, completed: 3 });
    brain.closeAll();
  });

  it('picks up work that arrives as the drain is finishing', async () => {
    const { extractor, release } = gatedExtractor();
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub, extractor,
      sources: [fakeSource(1, ['a', 'straggler'])],
      onRunProgress: () => undefined,
    });
    brain.setVaultPath(1, join(dir, 'v-straggler'));

    await brain.enqueueSource(1, 'a');
    const drain = brain.drainQueue();
    await until(() => release.length === 1, 'first queued item');

    await brain.enqueueSource(1, 'straggler');
    release[0]();

    await until(() => release.length === 2, 'the straggler to reach the extractor');
    release[1]();
    const outcome = await drain;

    expect(outcome.processed).toBe(2);
    expect(brain.queueCounts(1).pending).toBe(0);
    brain.closeAll();
  });

  it('refuses a queue drain while a manual selection owns the run', async () => {
    const { extractor, release } = gatedExtractor();
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub, extractor,
      sources: [fakeSource(1, ['a', 'b'])],
    });
    brain.setVaultPath(1, join(dir, 'v-busy'));

    await brain.backfill(1);
    const selection = brain.indexSelection(1, ['a']);
    await until(() => release.length === 1, 'the selection to reach the extractor');

    expect(await brain.drainQueue()).toMatchObject({ processed: 0, reason: 'busy' });

    release[0]();
    await selection;
    brain.closeAll();
  });

  it('pushes every progress change to the subscriber, ending with null', async () => {
    const seen: (BrainRun | null)[] = [];
    const { extractor, release } = gatedExtractor();
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub, extractor,
      sources: [fakeSource(1, ['a', 'b'])],
      onRunProgress: (run) => { seen.push(run); },
    });
    brain.setVaultPath(1, join(dir, 'v2'));

    const run = brain.indexSelection(1, ['a', 'b']);
    await until(() => release.length === 1, 'first item');
    release[0]();
    await until(() => release.length === 2, 'second item');
    release[1]();
    await run;

    // Deduped: a run also pushes a frame per phase change.
    const steps = seen
      .map((r) => (r === null ? null : r.completed))
      .filter((v, i, all) => i === 0 || v !== all[i - 1]);
    expect(steps).toEqual([0, 1, 2, null]);
    expect(seen[seen.length - 1]).toBeNull();
    brain.closeAll();
  });

  it('hides a run from a different account', async () => {
    const { extractor, release } = gatedExtractor();
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub, extractor,
      sources: [fakeSource(1, ['a'])],
    });
    brain.setVaultPath(1, join(dir, 'v3'));

    const run = brain.indexSelection(1, ['a']);
    await until(() => release.length === 1, 'the item');

    expect(brain.currentRun(1)).not.toBeNull();
    expect(brain.currentRun(2)).toBeNull();

    release[0]();
    await run;
    brain.closeAll();
  });

  it('refuses a second run while one is in flight', async () => {
    const { extractor, release } = gatedExtractor();
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub, extractor,
      sources: [fakeSource(1, ['a', 'b'])],
    });
    brain.setVaultPath(1, join(dir, 'v4'));

    const run = brain.indexSelection(1, ['a']);
    await until(() => release.length === 1, 'the first run to start');

    await expect(brain.indexSelection(1, ['b'])).rejects.toThrow(/already/i);

    release[0]();
    await run;

    const second = brain.indexSelection(1, ['b']);
    await until(() => release.length === 2, 'the second run to start');
    release[1]();
    await expect(second).resolves.toBeDefined();
    brain.closeAll();
  });

  it('carries on after an item that throws, and reports it', async () => {
    let calls = 0;
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      extractor: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('model exploded'));
        return Promise.resolve({ entities: [] });
      },
      sources: [fakeSource(1, ['a', 'b'])],
    });
    brain.setVaultPath(1, join(dir, 'v5'));

    const result = await brain.indexSelection(1, ['a', 'b']);

    expect(calls).toBe(2);
    expect(result.written).toBe(1);
    expect(result.skipped).toBe(1);
    brain.closeAll();
  });

  it('carries each item\'s own reason back, in order', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      extractor: () => Promise.resolve({ entities: [] }),
      sources: [fakeSource(1, ['a', 'b'])],
    });
    brain.setVaultPath(1, join(dir, 'v7'));

    await brain.indexSelection(1, ['a']);
    const again = await brain.indexSelection(1, ['a', 'b']);

    expect(again.results.map((r) => r.itemKey)).toEqual(['a', 'b']);
    expect(again.results[0].skipped).toBe(true);
    expect(again.results[0].reason).toMatch(/unchanged/);
    expect(again.results[1].skipped).toBe(false);
    brain.closeAll();
  });

  it('records an item that threw as a skip carrying its message', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      extractor: () => Promise.resolve({ entities: [] }),
      sources: [fakeSource(1, ['a'])],
    });
    const result = await brain.indexSelection(1, ['a']);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ itemKey: 'a', skipped: true });
    expect(result.results[0].reason).toMatch(/no vault configured/);
    brain.closeAll();
  });

  it('rejects an unknown item without starting a run', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      extractor: () => Promise.resolve({ entities: [] }),
      sources: [fakeSource(1, ['a'])],
    });
    brain.setVaultPath(1, join(dir, 'v6'));

    await expect(brain.indexSelection(1, [])).rejects.toThrow(/no items/i);
    expect(brain.currentRun(1)).toBeNull();
    brain.closeAll();
  });

  it('carries a human label for the item in flight, not just its key', async () => {
    const { extractor, release } = gatedExtractor();
    const session: BrainSource = {
      ...fakeSource(1, ['9f3c-uuid']),
      id: SESSION_SOURCE_ID,
      discover: () => Promise.resolve([{
        sourceId: SESSION_SOURCE_ID, itemKey: '9f3c-uuid', accountId: 1,
        path: join(dir, '9f3c-uuid.jsonl'), mtimeMs: 1, size: 10,
        label: '/Users/greg/Repos/work/pi-tuitive',
      }]),
    };
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub, extractor, sources: [session],
    });
    brain.setVaultPath(1, join(dir, 'v-label'));

    const run = brain.indexSelection(1, ['9f3c-uuid']);
    await until(() => release.length === 1, 'the item to reach the extractor');

    expect(brain.currentRun(1)).toMatchObject({ item: '9f3c-uuid', label: 'pi-tuitive' });

    release[0]();
    await run;
    brain.closeAll();
  });

  it('falls back to the item key when there is no better label', async () => {
    const { extractor, release } = gatedExtractor();
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub, extractor,
      sources: [fakeSource(1, ['a'])],
    });
    brain.setVaultPath(1, join(dir, 'v-nolabel'));

    const run = brain.indexSelection(1, ['a']);
    await until(() => release.length === 1, 'the item to reach the extractor');
    expect(brain.currentRun(1)?.label).toBe('a');

    release[0]();
    await run;
    brain.closeAll();
  });

  it('reports which stage of an item is running', async () => {
    const seen: (BrainRun | null)[] = [];
    const { extractor, release } = gatedExtractor();
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub, extractor,
      sources: [fakeSource(1, ['a'])],
      onRunProgress: (run) => { seen.push(run); },
    });
    brain.setVaultPath(1, join(dir, 'v-phase'));

    const run = brain.indexSelection(1, ['a']);
    await until(() => release.length === 1, 'the item to reach the extractor');

    expect(brain.currentRun(1)?.phase).toBe('extracting');

    release[0]();
    await run;

    const phases = seen
      .map((r) => (r === null ? null : r.phase))
      .filter((v, i, all) => i === 0 || v !== all[i - 1]);
    expect(phases).toEqual(['preparing', 'distilling', 'extracting', 'writing', null]);
    brain.closeAll();
  });

  it('reports the distilling stage while the source is still being read', async () => {
    const release: (() => void)[] = [];
    const slow: BrainSource = {
      ...fakeSource(1, ['a']),
      distill: () => new Promise((resolve) => {
        release.push(() => { resolve({
          prose: 'x', truncated: false,
          metadata: {
            kind: 'capture' as const,
            capturedAt: '2026-08-12T00:00:00.000Z', project: null, cwd: null,
          },
        }); });
      }),
    };
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      extractor: () => Promise.resolve({ entities: [] }),
      sources: [slow],
    });
    brain.setVaultPath(1, join(dir, 'v-distill'));

    const run = brain.indexSelection(1, ['a']);
    await until(() => release.length === 1, 'the item to reach distillation');
    expect(brain.currentRun(1)?.phase).toBe('distilling');

    release[0]();
    await run;
    brain.closeAll();
  });

  it('stamps when the current item started, and restamps for the next one', async () => {
    let t = 1_000;
    const { extractor, release } = gatedExtractor();
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub, extractor,
      sources: [fakeSource(1, ['a', 'b'])],
      now: () => t,
    });
    brain.setVaultPath(1, join(dir, 'v-elapsed'));

    const run = brain.indexSelection(1, ['a', 'b']);
    await until(() => release.length === 1, 'first item');
    expect(brain.currentRun(1)?.startedAt).toBe(1_000);

    t = 61_000;
    release[0]();
    await until(() => release.length === 2, 'second item');
    expect(brain.currentRun(1)?.startedAt).toBe(61_000);

    release[1]();
    await run;
    brain.closeAll();
  });
});
