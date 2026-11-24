import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as realFs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const spied = {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    createReadStream: vi.fn(actual.createReadStream),
  };
  return { ...spied, default: spied };
});

import { createDatabase, type Database } from '../services/database';
import type { AccountsService } from '../services/accounts';
import { createBrainService } from '../services/brain/registry';
import { createSessionSource } from '../services/brain/sources/session-transcripts';
import { repoPathFromTranscripts } from '../services/brain/sources/repo-artifacts';

const PROMPT = (text: string, i: number): string =>
  JSON.stringify({
    type: 'user',
    uuid: `u${i}`,
    timestamp: `2026-08-01T10:0${i}:00.000Z`,
    cwd: '/Users/dev/Repos/omnifex',
    message: { role: 'user', content: text },
  });
const PROSE = (text: string, i: number): string =>
  JSON.stringify({
    type: 'assistant',
    uuid: `a${i}`,
    timestamp: `2026-08-01T10:0${i}:30.000Z`,
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] },
  });
const GOOD = [PROMPT('first', 1), PROSE('one', 1), PROMPT('second', 2), PROSE('two', 2)].join('\n');

const readFileSyncSpy = vi.mocked(realFs.readFileSync);
const createReadStreamSpy = vi.mocked(realFs.createReadStream);

function callsOn(spy: { mock: { calls: unknown[][] } }, suffix: string): number {
  return spy.mock.calls.filter((c) => String(c[0]).endsWith(suffix)).length;
}

describe('brain: transcripts are never read on the event loop', () => {
  let dir: string;
  let cfg: string;
  let db: Database;
  let accounts: AccountsService;

  function writeSession(sessionId: string, body: string): string {
    const projectDir = join(cfg, 'projects', '-Users-dev-Repos-omnifex');
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(file, body, 'utf-8');
    return file;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'brain-nonblocking-'));
    cfg = join(dir, 'cfg');
    db = createDatabase(':memory:');
    db.raw.prepare('INSERT INTO accounts (id, name, config_dir) VALUES (?, ?, ?)').run(1, 'Personal', cfg);
    accounts = { listAccounts: () => [{ id: 1, config_dir: cfg }] } as unknown as AccountsService;
    readFileSyncSpy.mockClear();
    createReadStreamSpy.mockClear();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists sources without a synchronous read of any transcript', async () => {
    writeSession('sess-a', GOOD);
    writeSession('sess-b', GOOD);
    const brain = createBrainService(db, { sources: [createSessionSource({ accounts })] });

    const rows = await brain.listSources(1, { includeExcluded: true });

    expect(rows.map((r) => r.admitted)).toEqual([true, true]);
    expect(callsOn(readFileSyncSpy, '.jsonl')).toBe(0);
  });

  it('does not read an unchanged transcript again on the next listing', async () => {
    writeSession('sess-a', GOOD);
    const reads: string[] = [];
    const source = createSessionSource({
      accounts,
      readFile: (p) => {
        reads.push(p);
        return realFs.promises.readFile(p, 'utf-8');
      },
    });
    const brain = createBrainService(db, { sources: [source] });

    await brain.listSources(1, { includeExcluded: true });
    await brain.listSources(1, { includeExcluded: true });
    expect(reads).toHaveLength(1);

    const file = writeSession('sess-a', `${GOOD}\n${PROMPT('third', 3)}`);
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    await brain.listSources(1, { includeExcluded: true });
    expect(reads).toHaveLength(2);
  });

  it('hashes a changed transcript through a stream, never readFileSync', async () => {
    const file = writeSession('sess-a', GOOD);
    const brain = createBrainService(db, {
      sources: [createSessionSource({ accounts })],
      accounts,
      execGit: async () => '',
      extractor: () => Promise.resolve({ entities: [] }),
    });
    brain.setVaultPath(1, join(dir, 'vault'));
    await brain.indexSource(1, 'sess-a', { force: true });
    utimesSync(file, new Date(), new Date(Date.now() + 60_000));
    readFileSyncSpy.mockClear();
    createReadStreamSpy.mockClear();

    const [row] = await brain.listSources(1, { includeExcluded: true });

    expect(row.changed).toBe(false);
    expect(callsOn(readFileSyncSpy, '.jsonl')).toBe(0);
    expect(callsOn(createReadStreamSpy, 'sess-a.jsonl')).toBe(1);
  });

  it('skips a live session in the sweep before hashing it', async () => {
    const file = writeSession('sess-a', GOOD);
    const now = Date.now();
    const brain = createBrainService(db, {
      sources: [createSessionSource({ accounts })],
      accounts,
      execGit: async () => '',
      extractor: () => Promise.resolve({ entities: [] }),
      liveSessionIds: () => ['sess-a'],
      now: () => now,
      idleMs: () => 15 * 60_000,
    });
    brain.setVaultPath(1, join(dir, 'vault'));
    utimesSync(file, new Date(now - 3_600_000), new Date(now - 3_600_000));
    await brain.indexSource(1, 'sess-a', { force: true });
    writeSession('sess-a', `${GOOD}\n${PROMPT('third', 3)}`);
    utimesSync(file, new Date(now - 60_000), new Date(now - 60_000));
    createReadStreamSpy.mockClear();
    readFileSyncSpy.mockClear();

    const queued = await brain.backfill(1, { sinceMs: now - 86_400_000 });

    expect(queued).toBe(0);
    expect(callsOn(createReadStreamSpy, 'sess-a.jsonl')).toBe(0);
    expect(callsOn(readFileSyncSpy, 'sess-a.jsonl')).toBe(0);
  });

  it('finds a repo path from transcript heads without readFileSync', async () => {
    writeSession('sess-a', GOOD);
    const found = await repoPathFromTranscripts(join(cfg, 'projects', '-Users-dev-Repos-omnifex'));
    expect(found).toBe('/Users/dev/Repos/omnifex');
    expect(callsOn(readFileSyncSpy, '.jsonl')).toBe(0);
  });
});
