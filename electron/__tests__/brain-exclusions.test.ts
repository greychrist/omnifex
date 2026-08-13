import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createBrainService, type BrainService } from '../services/brain/registry';
import type { AccountsService } from '../services/accounts';
import type { BrainSource, SourceItem } from '../services/brain/sources/types';

/**
 * Durable project exclusion.
 *
 * A view filter is not enough: with Auto-index on, closing a session in a temp
 * project indexes it in the background whatever the table is showing. So an
 * excluded project has to drop out of every path that can reach the model, and
 * each path is pinned separately here — one shared test would pass while four
 * of the five leaked.
 */

const stubExec = async () => '';

const accountsStub = {
  listAccounts: () => [{ id: 1, config_dir: '/cfg/personal' }],
} as unknown as AccountsService;

function item(itemKey: string, label: string): SourceItem {
  return {
    sourceId: 'session',
    itemKey,
    accountId: 1,
    path: `/transcripts/${itemKey}.jsonl`,
    mtimeMs: 1_000,
    size: 2_048,
    label,
  };
}

/** Two projects: one to keep, one to exclude. */
const ITEMS = [
  item('keep-1', '-Users-greg-Repos-personal-WIN'),
  item('keep-2', '-Users-greg-Repos-personal-WIN'),
  item('tmp-1', '-private-tmp-brain-probe'),
];

function fakeSource(extra: Partial<BrainSource> = {}): BrainSource {
  return {
    id: 'session',
    discover: () => Promise.resolve(ITEMS),
    admit: () => ({ admitted: true, reason: 'ok' }),
    distill: () =>
      Promise.resolve({
        prose: 'USER: hi',
        truncated: false,
        metadata: {
          kind: 'session' as const,
          sessionId: 's',
          projectPath: null,
          gitBranch: null,
          startedAt: null,
          endedAt: null,
          durationMs: null,
          models: [],
          cliVersion: null,
          promptCount: 2,
          proseCount: 2,
          filesTouched: [],
          terminalStatus: 'completed' as const,
        },
      }),
    ...extra,
  } as BrainSource;
}

describe('durable project exclusion', () => {
  let db: Database;
  let dir: string;
  let brain: BrainService;
  let extractor: ReturnType<typeof vi.fn>;
  const accountId = 1;
  const TMP = '-private-tmp-brain-probe';

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.raw
      .prepare(
        `INSERT INTO accounts (id, name, config_dir, engine, subscription_label, has_cost)
         VALUES (1, 'personal', '/cfg/personal', 'claude', 'Max', 0)`,
      )
      .run();
    dir = mkdtempSync(join(tmpdir(), 'brain-excl-'));
    extractor = vi.fn().mockResolvedValue({ entities: [] });
    brain = createBrainService(db, {
      execGit: stubExec,
      accounts: accountsStub,
      extractor: extractor as never,
      sources: [fakeSource()],
    });
    brain.setVaultPath(accountId, join(dir, 'vault'));
  });

  afterEach(() => {
    brain.closeAll();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips the excluded list', () => {
    expect(brain.excludedProjects(accountId)).toEqual([]);
    brain.setExcludedProjects(accountId, [TMP]);
    expect(brain.excludedProjects(accountId)).toEqual([TMP]);
  });

  it('keeps one account exclusions out of another', () => {
    brain.setExcludedProjects(accountId, [TMP]);
    expect(brain.excludedProjects(2)).toEqual([]);
  });

  it('omits excluded rows from listSources', async () => {
    brain.setExcludedProjects(accountId, [TMP]);
    const rows = await brain.listSources(accountId);
    expect(rows.map((r) => r.itemKey).sort()).toEqual(['keep-1', 'keep-2']);
  });

  it('reveals excluded rows on request, so they can be un-excluded', async () => {
    brain.setExcludedProjects(accountId, [TMP]);
    const rows = await brain.listSources(accountId, { includeExcluded: true });
    expect(rows.map((r) => r.itemKey).sort()).toEqual(['keep-1', 'keep-2', 'tmp-1']);
    expect(rows.find((r) => r.itemKey === 'tmp-1')?.excluded).toBe(true);
    expect(rows.find((r) => r.itemKey === 'keep-1')?.excluded).toBe(false);
  });

  it('refuses to queue an excluded item', async () => {
    brain.setExcludedProjects(accountId, [TMP]);
    await expect(brain.enqueueSource(accountId, 'tmp-1')).rejects.toThrow(/excluded/i);
    expect(brain.queueCounts(accountId).pending).toBe(0);
  });

  it('skips excluded items during backfill', async () => {
    brain.setExcludedProjects(accountId, [TMP]);
    expect(await brain.backfill(accountId)).toBe(2);
  });

  /**
   * The backstop. The queue is durable across restarts, so an exclusion added
   * today has to stop work that was queued yesterday.
   */
  it('skips an already-queued item whose project was excluded afterwards', async () => {
    await brain.enqueueSource(accountId, 'tmp-1');
    expect(brain.queueCounts(accountId).pending).toBe(1);

    brain.setExcludedProjects(accountId, [TMP]);
    const result = await brain.indexSource(accountId, 'tmp-1');

    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/excluded/i);
    expect(extractor).not.toHaveBeenCalled();
  });

  it('still indexes an item from a project that is not excluded', async () => {
    brain.setExcludedProjects(accountId, [TMP]);
    const result = await brain.indexSource(accountId, 'keep-1');
    expect(result.skipped).toBe(false);
    expect(extractor).toHaveBeenCalledTimes(1);
  });

  it('reports each item byte size, so a 21MB session is visible as one', async () => {
    const rows = await brain.listSources(accountId);
    expect(rows[0].size).toBe(2_048);
  });
});
