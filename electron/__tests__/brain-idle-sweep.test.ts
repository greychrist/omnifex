// Indexing used to reach a session transcript only when its tab closed. A tab
// left open for a week meant a conversation that ended on Tuesday was never
// indexed, because the 5-minute timer in main.ts only DRAINED an existing
// queue — nothing discovered.
//
// Two changes close that, and both are tested here:
//
//  - "live" stops meaning `open` and starts meaning `still being written`: an
//    open session whose transcript has been untouched for the idle threshold
//    is eligible again.
//  - `backfill` takes an mtime floor, so the periodic sweep can look at the
//    recent past without the first tick after the opt-in enqueueing the user's
//    entire history unattended.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createBrainService } from '../services/brain/registry';
import {
  readNumericSetting,
  DEFAULT_IDLE_MINUTES,
  MIN_IDLE_MINUTES,
  MAX_IDLE_MINUTES,
  DEFAULT_SWEEP_HOURS,
  MIN_SWEEP_HOURS,
  MAX_SWEEP_HOURS,
} from '../services/brain/queue';
import type { BrainSource } from '../services/brain/sources/types';
import type { AccountsService } from '../services/accounts';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

/** A fixed clock, so "45 minutes ago" is a number and not a race. */
const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('brain: numeric settings', () => {
  it('falls back to the default for anything unparseable', () => {
    for (const raw of [null, '', '   ', 'abc', 'NaN', 'Infinity']) {
      expect(readNumericSetting(raw, 15, 1, 1440)).toBe(15);
    }
  });

  it('clamps rather than rejecting, so a hand-edited row still runs', () => {
    expect(readNumericSetting('0', 15, 1, 1440)).toBe(1);
    expect(readNumericSetting('-5', 15, 1, 1440)).toBe(1);
    expect(readNumericSetting('99999', 15, 1, 1440)).toBe(1440);
  });

  it('takes a value inside the range verbatim, and truncates a fraction', () => {
    expect(readNumericSetting('45', 15, 1, 1440)).toBe(45);
    expect(readNumericSetting('45.9', 15, 1, 1440)).toBe(45);
  });

  it('ships the defaults the design settled on', () => {
    expect(DEFAULT_IDLE_MINUTES).toBe(15);
    expect([MIN_IDLE_MINUTES, MAX_IDLE_MINUTES]).toEqual([1, 1440]);
    expect(DEFAULT_SWEEP_HOURS).toBe(24);
    expect([MIN_SWEEP_HOURS, MAX_SWEEP_HOURS]).toEqual([1, 720]);
  });
});

describe('brain: idle open sessions', () => {
  let dir: string;
  let db: Database;

  const stubExec = async () => '';
  const accountsStub = {
    listAccounts: () => [{ id: 1, config_dir: '/cfg/personal' }],
  } as unknown as AccountsService;

  /** Sessions with an explicit mtime, which is the whole point of these tests. */
  function sessionSource(items: { key: string; mtimeMs: number }[]): BrainSource {
    return {
      id: 'session',
      discover: () => Promise.resolve(items.map((i) => ({
        sourceId: 'session', itemKey: i.key, accountId: 1,
        path: join(dir, `${i.key}.jsonl`), mtimeMs: i.mtimeMs, size: 10, label: '/proj',
      }))),
      admit: () => ({ admitted: true, reason: 'ok' }),
      distill: () => Promise.resolve({
        prose: 'x', truncated: false,
        metadata: {
          kind: 'capture' as const,
          capturedAt: '2026-08-26T00:00:00.000Z', project: null, cwd: null,
        },
      }),
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-brain-idle-'));
    db = createDatabase(':memory:');
    db.raw.prepare('INSERT INTO accounts (id, name, config_dir) VALUES (?, ?, ?)')
      .run(1, 'Personal', '/cfg/personal');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function service(opts: {
    items: { key: string; mtimeMs: number }[];
    live: string[];
    idleMs?: () => number;
    onExtract?: () => void;
  }) {
    return createBrainService(db, {
      execGit: stubExec,
      accounts: accountsStub,
      sources: [sessionSource(opts.items)],
      liveSessionIds: () => opts.live,
      now: () => NOW,
      idleMs: opts.idleMs ?? (() => 15 * MINUTE),
      extractor: () => {
        opts.onExtract?.();
        return Promise.resolve({ entities: [] });
      },
    });
  }

  it('still refuses a session that was written to moments ago', async () => {
    let extractorCalls = 0;
    const brain = service({
      items: [{ key: SESSION_A, mtimeMs: NOW - 5 * MINUTE }],
      live: [SESSION_A],
      onExtract: () => { extractorCalls += 1; },
    });
    brain.setVaultPath(1, join(dir, 'vault'));

    const result = await brain.indexSource(1, SESSION_A);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/active/i);
    expect(extractorCalls).toBe(0);
  });

  it('indexes an open session once its transcript has gone quiet', async () => {
    let extractorCalls = 0;
    const brain = service({
      items: [{ key: SESSION_A, mtimeMs: NOW - 45 * MINUTE }],
      live: [SESSION_A],
      onExtract: () => { extractorCalls += 1; },
    });
    brain.setVaultPath(1, join(dir, 'vault'));

    const result = await brain.indexSource(1, SESSION_A);
    expect(result.reason).not.toMatch(/active/i);
    expect(extractorCalls).toBe(1);
  });

  it('treats a transcript exactly at the threshold as idle', async () => {
    // `< idleMs` is live, so equality is idle. Pinned because an off-by-one
    // here is invisible in normal use and only shows up as "why did nothing
    // ever index at exactly my setting".
    const brain = service({
      items: [{ key: SESSION_A, mtimeMs: NOW - 15 * MINUTE }],
      live: [SESSION_A],
    });
    brain.setVaultPath(1, join(dir, 'vault'));
    expect((await brain.indexSource(1, SESSION_A)).reason).not.toMatch(/active/i);
  });

  it('reads the threshold fresh, so a settings change needs no restart', async () => {
    let minutes = 60;
    const brain = service({
      items: [{ key: SESSION_A, mtimeMs: NOW - 30 * MINUTE }],
      live: [SESSION_A],
      idleMs: () => minutes * MINUTE,
    });
    brain.setVaultPath(1, join(dir, 'vault'));

    // 30 minutes idle against a 60-minute threshold: still active.
    expect((await brain.indexSource(1, SESSION_A)).reason).toMatch(/active/i);
    minutes = 15;
    expect((await brain.indexSource(1, SESSION_A)).reason).not.toMatch(/active/i);
  });

  it('marks only an actively-written session in use in the listing', async () => {
    const brain = service({
      items: [
        { key: SESSION_A, mtimeMs: NOW - MINUTE },
        { key: SESSION_B, mtimeMs: NOW - 2 * HOUR },
      ],
      live: [SESSION_A, SESSION_B],
    });
    const rows = await brain.listSources(1);
    expect(rows.find((r) => r.itemKey === SESSION_A)?.inUse).toBe(true);
    expect(rows.find((r) => r.itemKey === SESSION_B)?.inUse).toBe(false);
  });

  it('refuses to queue an active session but accepts an idle one', async () => {
    const brain = service({
      items: [
        { key: SESSION_A, mtimeMs: NOW - MINUTE },
        { key: SESSION_B, mtimeMs: NOW - 2 * HOUR },
      ],
      live: [SESSION_A, SESSION_B],
    });
    await expect(brain.enqueueSource(1, SESSION_A)).rejects.toThrow(/active/i);
    await expect(brain.enqueueSource(1, SESSION_B)).resolves.toBeUndefined();
    expect(brain.queueCounts(1).pending).toBe(1);
  });
});

describe('brain: bounded sweep', () => {
  let dir: string;
  let db: Database;

  const stubExec = async () => '';
  const accountsStub = {
    listAccounts: () => [{ id: 1, config_dir: '/cfg/personal' }],
  } as unknown as AccountsService;

  /** Counts `admit` calls: the sweep must not distil what it will not queue. */
  let admitCalls: string[];

  function sessionSource(items: { key: string; mtimeMs: number }[]): BrainSource {
    return {
      id: 'session',
      discover: () => Promise.resolve(items.map((i) => ({
        sourceId: 'session', itemKey: i.key, accountId: 1,
        path: join(dir, `${i.key}.jsonl`), mtimeMs: i.mtimeMs, size: 10, label: '/proj',
      }))),
      admit: (item) => {
        admitCalls.push(item.itemKey);
        return { admitted: true, reason: 'ok' };
      },
      distill: () => Promise.resolve({
        prose: 'x', truncated: false,
        metadata: {
          kind: 'capture' as const,
          capturedAt: '2026-08-26T00:00:00.000Z', project: null, cwd: null,
        },
      }),
    };
  }

  beforeEach(() => {
    admitCalls = [];
    dir = mkdtempSync(join(tmpdir(), 'omnifex-brain-sweep-'));
    db = createDatabase(':memory:');
    db.raw.prepare('INSERT INTO accounts (id, name, config_dir) VALUES (?, ?, ?)')
      .run(1, 'Personal', '/cfg/personal');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function service(items: { key: string; mtimeMs: number }[], live: string[] = []) {
    return createBrainService(db, {
      execGit: stubExec,
      accounts: accountsStub,
      sources: [sessionSource(items)],
      liveSessionIds: () => live,
      now: () => NOW,
      idleMs: () => 15 * MINUTE,
      extractor: () => Promise.resolve({ entities: [] }),
    });
  }

  it('queues only items newer than the floor', async () => {
    const brain = service([
      { key: SESSION_A, mtimeMs: NOW - 2 * HOUR },
      { key: SESSION_B, mtimeMs: NOW - 48 * HOUR },
    ]);
    const queued = await brain.backfill(1, { sinceMs: NOW - 24 * HOUR });
    expect(queued).toBe(1);
    expect(brain.queueList(1).map((e) => e.itemKey)).toEqual([SESSION_A]);
  });

  it('never distils an item the floor already excluded', async () => {
    // `admit()` reads and parses the WHOLE transcript. Calling it before the
    // mtime check would make every 5-minute tick re-read the user's entire
    // history — the one thing that would make this feature expensive.
    const brain = service([
      { key: SESSION_A, mtimeMs: NOW - 2 * HOUR },
      { key: SESSION_B, mtimeMs: NOW - 48 * HOUR },
    ]);
    await brain.backfill(1, { sinceMs: NOW - 24 * HOUR });
    expect(admitCalls).toEqual([SESSION_A]);
  });

  it('never distils an item that is unchanged since it was indexed', async () => {
    const brain = service([{ key: SESSION_A, mtimeMs: NOW - 2 * HOUR }]);
    brain.setVaultPath(1, join(dir, 'vault'));
    await brain.indexSource(1, SESSION_A);

    admitCalls = [];
    const queued = await brain.backfill(1, { sinceMs: NOW - 24 * HOUR });
    expect(queued).toBe(0);
    expect(admitCalls).toEqual([]);
  });

  it('skips a session that is open and still being written', async () => {
    const brain = service(
      [
        { key: SESSION_A, mtimeMs: NOW - MINUTE },
        { key: SESSION_B, mtimeMs: NOW - 2 * HOUR },
      ],
      [SESSION_A, SESSION_B],
    );
    const queued = await brain.backfill(1, { sinceMs: NOW - 24 * HOUR });
    expect(queued).toBe(1);
    expect(brain.queueList(1).map((e) => e.itemKey)).toEqual([SESSION_B]);
  });

  /**
   * The floor is an age limit on the FILE, not a watermark since the last
   * sweep, so an item that changed while the app was closed for longer than
   * the floor was stranded: every later tick re-excluded it on age, and the
   * Sources table went on reporting it as changed with nothing to act on it.
   *
   * The floor's stated job is the first tick after the opt-in — not enqueuing
   * every transcript ever written. An item already carrying state was admitted
   * and paid for once; re-reading it because its bytes moved is not that case.
   */
  it('re-queues a known item that changed, however old its file is', async () => {
    const before = service([{ key: SESSION_A, mtimeMs: NOW - 48 * HOUR }]);
    before.setVaultPath(1, join(dir, 'vault'));
    await before.indexSource(1, SESSION_A);
    before.closeAll();

    // Same session, edited — and still older than the floor, which is what an
    // edit that landed while the app was shut down looks like on the next run.
    const after = service([{ key: SESSION_A, mtimeMs: NOW - 47 * HOUR }]);
    after.setVaultPath(1, join(dir, 'vault'));
    expect(await after.backfill(1, { sinceMs: NOW - 24 * HOUR })).toBe(1);
    after.closeAll();
  });

  /** The escape hatch above must not become a hole in the floor itself. */
  it('still excludes an old item it has never seen', async () => {
    const brain = service([{ key: SESSION_B, mtimeMs: NOW - 48 * HOUR }]);
    expect(await brain.backfill(1, { sinceMs: NOW - 24 * HOUR })).toBe(0);
    expect(admitCalls).toEqual([]);
    brain.closeAll();
  });

  it('sees everything when called with no floor, which is the button', async () => {
    const brain = service([
      { key: SESSION_A, mtimeMs: NOW - 2 * HOUR },
      { key: SESSION_B, mtimeMs: NOW - 48 * HOUR },
    ]);
    expect(await brain.backfill(1)).toBe(2);
  });
});
