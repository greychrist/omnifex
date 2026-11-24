import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createBrainService } from '../services/brain/registry';
import type { BrainSource } from '../services/brain/sources/types';
import type { AccountsService } from '../services/accounts';

const LIVE = '11111111-1111-4111-8111-111111111111';
const DEAD = '22222222-2222-4222-8222-222222222222';

describe('brain: live sessions', () => {
  let dir: string;
  let db: Database;

  const stubExec = async () => '';
  const accountsStub = {
    listAccounts: () => [{ id: 1, config_dir: '/cfg/personal' }],
  } as unknown as AccountsService;

  function sessionSource(keys: string[]): BrainSource {
    return {
      id: 'session',
      discover: () => Promise.resolve(keys.map((k) => ({
        sourceId: 'session', itemKey: k, accountId: 1,
        path: join(dir, `${k}.jsonl`),
        mtimeMs: Date.now(), size: 10, label: '/proj',
      }))),
      admit: () => ({ admitted: true, reason: 'ok' }),
      distill: () => Promise.resolve({
        prose: 'x', truncated: false,
        metadata: {
          kind: 'capture' as const,
          capturedAt: '2026-08-13T00:00:00.000Z', project: null, cwd: null,
        },
      }),
    };
  }

  function fileSource(itemKey: string, fileName: string): BrainSource {
    return {
      id: 'auto-memory',
      discover: () => Promise.resolve([{
        sourceId: 'auto-memory', itemKey, accountId: 1,
        path: join(dir, 'memory', fileName), mtimeMs: 2, size: 20, label: '/proj',
      }]),
      admit: () => ({ admitted: true, reason: 'ok' }),
      translate: () => Promise.resolve([]),
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-brain-live-'));
    db = createDatabase(':memory:');
    db.raw.prepare('INSERT INTO accounts (id, name, config_dir) VALUES (?, ?, ?)')
      .run(1, 'Personal', '/cfg/personal');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks an open session in use and leaves closed ones alone', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [sessionSource([LIVE, DEAD])],
      liveSessionIds: () => [LIVE],
    });
    const rows = await brain.listSources(1);
    expect(rows.find((r) => r.itemKey === LIVE)?.inUse).toBe(true);
    expect(rows.find((r) => r.itemKey === DEAD)?.inUse).toBe(false);
  });

  it('never flags a non-session row, even when its key matches a live UUID', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [fileSource(LIVE, 'note.md')],
      liveSessionIds: () => [LIVE],
    });
    const rows = await brain.listSources(1);
    expect(rows[0].inUse).toBe(false);
  });

  it('reports no rows in use when nothing is open', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [sessionSource([LIVE])],
    });
    expect((await brain.listSources(1))[0].inUse).toBe(false);
  });

  it('refuses to index an open session, and spends nothing doing it', async () => {
    let extractorCalls = 0;
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [sessionSource([LIVE])],
      liveSessionIds: () => [LIVE],
      extractor: () => { extractorCalls += 1; return Promise.resolve({ entities: [] }); },
    });
    brain.setVaultPath(1, join(dir, 'vault'));

    const result = await brain.indexSource(1, LIVE);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/active in OmniFex/i);
    expect(result.notesWritten).toEqual([]);
    expect(extractorCalls).toBe(0);
  });

  it('refuses even with force: a partial transcript is partial either way', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [sessionSource([LIVE])],
      liveSessionIds: () => [LIVE],
      extractor: () => Promise.resolve({ entities: [] }),
    });
    brain.setVaultPath(1, join(dir, 'vault'));
    const result = await brain.indexSource(1, LIVE, { force: true });
    expect(result.skipped).toBe(true);
  });

  it('indexes the same session once it is no longer open', async () => {
    let live: string[] = [LIVE];
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [sessionSource([LIVE])],
      liveSessionIds: () => live,
      extractor: () => Promise.resolve({ entities: [] }),
    });
    brain.setVaultPath(1, join(dir, 'vault'));

    expect((await brain.indexSource(1, LIVE)).skipped).toBe(true);
    live = [];
    expect((await brain.indexSource(1, LIVE)).reason).not.toMatch(/active in OmniFex/i);
  });

  it('refuses to queue an open session rather than queueing a no-op', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [sessionSource([LIVE])],
      liveSessionIds: () => [LIVE],
    });
    await expect(brain.enqueueSource(1, LIVE)).rejects.toThrow(/active in OmniFex/i);
  });

  it('survives a live-session lookup that throws', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [sessionSource([LIVE])],
      liveSessionIds: () => { throw new Error('sessions service gone'); },
    });
    const rows = await brain.listSources(1);
    expect(rows[0].inUse).toBe(false);
  });
});

describe('brain: source display name', () => {
  let dir: string;
  let db: Database;
  const stubExec = async () => '';
  const accountsStub = {
    listAccounts: () => [{ id: 1, config_dir: '/cfg/personal' }],
  } as unknown as AccountsService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-brain-name-'));
    db = createDatabase(':memory:');
    db.raw.prepare('INSERT INTO accounts (id, name, config_dir) VALUES (?, ?, ?)')
      .run(1, 'Personal', '/cfg/personal');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function source(id: string, itemKey: string, filePath: string): BrainSource {
    return {
      id,
      discover: () => Promise.resolve([{
        sourceId: id, itemKey, accountId: 1,
        path: filePath, mtimeMs: 1, size: 10, label: '/proj',
      }]),
      admit: () => ({ admitted: true, reason: 'ok' }),
      translate: () => Promise.resolve([]),
    };
  }

  it('names a session by its id, not by its file', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [source('session', LIVE, `/x/y/${LIVE}.jsonl`)],
    });
    expect((await brain.listSources(1))[0].name).toBe(LIVE);
  });

  it('names a file-backed item by its file name, never the whole path', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [source('auto-memory', '-Users-greg-Repos-x:notes.md', '/Users/greg/memory/notes.md')],
    });
    const name = (await brain.listSources(1))[0].name;
    expect(name).toBe('notes.md');
    expect(name).not.toContain('/');
  });

  it('falls back to the item key when there is no usable path', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [source('capture', 'cap-7', '')],
    });
    expect((await brain.listSources(1))[0].name).toBe('cap-7');
  });
});

describe('brain: indexing cost', () => {
  let dir: string;
  let db: Database;
  const stubExec = async () => '';
  const accountsStub = {
    listAccounts: () => [{ id: 1, config_dir: '/cfg/personal' }],
  } as unknown as AccountsService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-brain-cost-'));
    db = createDatabase(':memory:');
    db.raw.prepare('INSERT INTO accounts (id, name, config_dir) VALUES (?, ?, ?)')
      .run(1, 'Personal', '/cfg/personal');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function costSource(itemKey: string): BrainSource {
    return {
      id: 'session',
      discover: () => Promise.resolve([{
        sourceId: 'session', itemKey, accountId: 1,
        path: join(dir, `${itemKey}.jsonl`), mtimeMs: 1, size: 10, label: '/proj',
      }]),
      admit: () => ({ admitted: true, reason: 'ok' }),
      distill: () => Promise.resolve({
        prose: 'x', truncated: false,
        metadata: {
          kind: 'capture' as const,
          capturedAt: '2026-08-13T00:00:00.000Z', project: null, cwd: null,
        },
      }),
    };
  }

  it('records what an indexing run cost, against the item it indexed', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [costSource('sess-cost')],
      extractor: () => Promise.resolve({
        entities: [],
        run: {
          costUsd: 0.020333,
          inputTokens: 10,
          outputTokens: 315,
          cacheReadTokens: 0,
          cacheCreationTokens: 9374,
        },
      }),
    });
    brain.setVaultPath(1, join(dir, 'vault'));

    await brain.indexSource(1, 'sess-cost');

    const rows = await brain.listSources(1);
    expect(rows[0].costUsd).toBeCloseTo(0.020333, 6);
    expect(rows[0].inputTokens).toBe(10);
    expect(rows[0].outputTokens).toBe(315);
    expect(rows[0].cacheCreationTokens).toBe(9374);
  });

  it('adds the retry to the bill rather than replacing it', async () => {
    let call = 0;
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [costSource('sess-retry')],
      extractor: () => {
        call += 1;
        return Promise.resolve({
          entities: [],
          run: {
            costUsd: call === 1 ? 0.01 : 0.02,
            inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
          },
        });
      },
    });
    brain.setVaultPath(1, join(dir, 'vault'));

    await brain.indexSource(1, 'sess-retry');
    const rows = await brain.listSources(1);
    expect(rows[0].costUsd).toBeCloseTo(0.01, 6);
  });

  it('leaves cost null for an item nothing has been spent on', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [costSource('sess-untouched')],
    });
    const rows = await brain.listSources(1);
    expect(rows[0].costUsd).toBeNull();
  });

  it('reports what this account has spent in total', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [costSource('sess-a')],
      extractor: () => Promise.resolve({
        entities: [],
        run: {
          costUsd: 0.25, inputTokens: 1, outputTokens: 1,
          cacheReadTokens: 0, cacheCreationTokens: 0,
        },
      }),
    });
    brain.setVaultPath(1, join(dir, 'vault'));
    await brain.indexSource(1, 'sess-a');

    const stats = brain.stats(1);
    expect(stats.spentUsd).toBeCloseTo(0.25, 6);
  });

  it('records the model that ran in the spend ledger, not the alias asked for', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [costSource('sess-m')],
      extractor: () => Promise.resolve({
        entities: [],
        run: {
          costUsd: 0.1, inputTokens: 1, outputTokens: 1,
          cacheReadTokens: 0, cacheCreationTokens: 0, model: 'claude-sonnet-5-5',
        },
      }),
    });
    brain.setVaultPath(1, join(dir, 'vault'));
    await brain.indexSource(1, 'sess-m');

    const row = db.raw.prepare('SELECT model FROM brain_spend').get() as { model: string };
    expect(row.model).toBe('claude-sonnet-5-5');
  });

  it('records the alias when the CLI reported no model', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [costSource('sess-n')],
      extractor: () => Promise.resolve({
        entities: [],
        run: {
          costUsd: 0.1, inputTokens: 1, outputTokens: 1,
          cacheReadTokens: 0, cacheCreationTokens: 0, model: null,
        },
      }),
    });
    brain.setVaultPath(1, join(dir, 'vault'));
    await brain.indexSource(1, 'sess-n');

    const row = db.raw.prepare('SELECT model FROM brain_spend').get() as { model: string };
    expect(row.model).toBe('sonnet');
  });

  it('never reports another account spend as this one', async () => {
    db.raw.prepare('INSERT INTO accounts (id, name, config_dir) VALUES (?, ?, ?)')
      .run(2, 'Work', '/cfg/work');
    db.raw
      .prepare(
        `INSERT INTO brain_sources
           (account_id, source_id, item_key, status, cost_usd)
         VALUES (2, 'session', 'other', 'indexed', 9.99)`,
      )
      .run();

    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub, sources: [costSource('sess-a')],
    });
    expect(brain.stats(1).spentUsd).toBe(0);
  });
});
