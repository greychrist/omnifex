import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createBrainService, type BrainRun } from '../services/brain/registry';
import type { BrainSource } from '../services/brain/sources/types';
import type { AccountsService } from '../services/accounts';

/**
 * A multi-item indexing run, tracked in the main process.
 *
 * The run used to be a `for` loop inside BrainSources.tsx, so its progress died
 * with the component: switching the Brain tab's sub-tab unmounts the pane, and
 * the user came back to a run that was still spending tokens with nothing on
 * screen to say so. Ownership moved here so any mount can ask what is running.
 */
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

  /** A source whose items all reach the extractor, so a run can be held there. */
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

  /**
   * An extractor that parks every call until released, so assertions can run
   * with an item genuinely in flight rather than inferred after the fact.
   */
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

    // First item in flight: nothing has finished yet. Counting starts instead
    // was the original bug — the bar opened at 1/2 before any work happened.
    await until(() => release.length === 1, 'first item to reach the extractor');
    expect(brain.currentRun(1)).toMatchObject({ total: 2, completed: 0, item: 'a' });

    release[0]();
    await until(() => release.length === 2, 'second item to reach the extractor');
    expect(brain.currentRun(1)).toMatchObject({ total: 2, completed: 1, item: 'b' });

    release[1]();
    await run;
    // The run is over, so there is nothing to report — not a stale 2 of 2.
    expect(brain.currentRun(1)).toBeNull();
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

    // Opens at 0, then one frame per item finished — including the last, which
    // is a true 2-of-2 rather than a jump straight from 1-of-2 to gone.
    expect(seen.map((r) => (r === null ? null : r.completed))).toEqual([0, 1, 2, null]);
    // The terminating null is what tells a live pane to drop the banner; without
    // it the bar would hang at the last frame forever.
    expect(seen[seen.length - 1]).toBeNull();
    brain.closeAll();
  });

  /**
   * A run belongs to the account that started it. The Sources pane is
   * account-scoped, so reporting one account's run under another's header would
   * be the same category of error as rendering its notes there.
   */
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

  /**
   * Concurrency 1, matching the queue worker's contract with the rate limit.
   * Two runs would also pay twice for an item that appears in both selections.
   */
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

    // And once it is over, the next run is allowed.
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
        // `indexSource` swallows extractor failures into a skipped result, so
        // this reaches indexSelection as a skip rather than a throw. The item
        // that matters here is that the run does not stop.
        if (calls === 1) return Promise.reject(new Error('model exploded'));
        return Promise.resolve({ entities: [] });
      },
      sources: [fakeSource(1, ['a', 'b'])],
    });
    brain.setVaultPath(1, join(dir, 'v5'));

    const result = await brain.indexSelection(1, ['a', 'b']);

    // Both were attempted: one bad item must not abandon the rest of a
    // selection the user explicitly ticked.
    expect(calls).toBe(2);
    expect(result.written).toBe(1);
    expect(result.skipped).toBe(1);
    brain.closeAll();
  });

  /**
   * A one-item run has to be able to say WHY it declined — "indexed 0,
   * skipped 1" is not an answer a user can act on.
   */
  it('carries each item\'s own reason back, in order', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      extractor: () => Promise.resolve({ entities: [] }),
      sources: [fakeSource(1, ['a', 'b'])],
    });
    brain.setVaultPath(1, join(dir, 'v7'));

    await brain.indexSelection(1, ['a']);
    // 'a' is now unchanged since it was indexed, so the second run declines it
    // for a reason the pane can print verbatim.
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
    // No vault configured, so indexSource throws rather than returning.
    const result = await brain.indexSelection(1, ['a']);

    // One entry per item either way: a caller reading outcomes should never
    // have to join two arrays to learn what happened to one item.
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

    // A miss is the caller's mistake, same as indexSource treats it. Leaving a
    // run record behind would strand the banner with nothing to finish it.
    await expect(brain.indexSelection(1, [])).rejects.toThrow(/no items/i);
    expect(brain.currentRun(1)).toBeNull();
    brain.closeAll();
  });
});
