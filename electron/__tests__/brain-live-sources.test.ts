// A session that is still open is still being written to. Indexing it distils
// a partial conversation, records the item as done, and — because extraction
// asks a non-deterministic model — the note it leaves is one that will never
// match the finished transcript.
//
// This already happened in the field: session 82ab1eb8 was indexed at 02:46 on
// 2026-08-13 while its tab was open in OmniFex.
//
// The guard lives in `indexSource`, not only at the enqueue boundary, because
// the Sources pane's "Index Selected" calls `indexSource` DIRECTLY — a queue-
// only guard would leave the pane's own button as the one unprotected path.
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

  /** Stands in for the real session adapter: itemKey IS the session UUID. */
  function sessionSource(keys: string[]): BrainSource {
    return {
      id: 'session',
      discover: () => Promise.resolve(keys.map((k) => ({
        sourceId: 'session', itemKey: k, accountId: 1,
        path: join(dir, `${k}.jsonl`), mtimeMs: 1, size: 10, label: '/proj',
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

  /** A file-backed source whose itemKey deliberately collides with a live UUID. */
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
    // A capture or memory note whose key happens to equal a session UUID is
    // not that session, and blocking it would be unexplainable to the user.
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
    expect(result.reason).toMatch(/open in OmniFex/i);
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
    // Reaches the extractor now — no note is written for zero entities, but it
    // is no longer refused before it starts.
    expect((await brain.indexSource(1, LIVE)).reason).not.toMatch(/open in OmniFex/i);
  });

  it('refuses to queue an open session rather than queueing a no-op', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [sessionSource([LIVE])],
      liveSessionIds: () => [LIVE],
    });
    await expect(brain.enqueueSource(1, LIVE)).rejects.toThrow(/open in OmniFex/i);
  });

  it('survives a live-session lookup that throws', async () => {
    // The sessions service is injected from main; a listing must not die
    // because that lookup failed. Erring toward "not in use" keeps the pane
    // rendering — `indexSource` is where the money is actually protected.
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
