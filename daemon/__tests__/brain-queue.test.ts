import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import {
  CURATION_SOURCE_ID,
  RATE_LIMIT_COOLDOWN_MS,
  createBrainQueueStore,
  createBrainQueueWorker,
  isRateLimitError,
  type BrainQueueStore,
} from '../services/brain/queue';

describe('brain queue store', () => {
  let db: Database;
  let store: BrainQueueStore;
  let personalId: number;
  let workId: number;

  function addAccount(name: string): number {
    const info = db.raw
      .prepare(
        `INSERT INTO accounts (name, config_dir, engine, subscription_label, has_cost)
         VALUES (?, ?, 'claude', 'Max', 0)`,
      )
      .run(name, `/tmp/${name}`);
    return Number(info.lastInsertRowid);
  }

  beforeEach(() => {
    db = createDatabase(':memory:');
    personalId = addAccount('personal');
    workId = addAccount('work');
    store = createBrainQueueStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('enqueues and claims in FIFO order', () => {
    store.enqueue(personalId, 'session', 'a');
    store.enqueue(personalId, 'session', 'b');
    expect(store.claimNext()?.itemKey).toBe('a');
    expect(store.claimNext()?.itemKey).toBe('b');
  });

  it('is idempotent: re-enqueuing a pending item does not duplicate it', () => {
    store.enqueue(personalId, 'session', 'a');
    store.enqueue(personalId, 'session', 'a');
    expect(store.counts(personalId).pending).toBe(1);
  });

  it('does not resurrect a running item on re-enqueue', () => {
    store.enqueue(personalId, 'session', 'a');
    store.claimNext();
    store.enqueue(personalId, 'session', 'a');
    expect(store.counts(personalId)).toMatchObject({ pending: 0, running: 1 });
  });

  it('re-enqueues an item that already finished', () => {
    store.enqueue(personalId, 'session', 'a');
    const entry = store.claimNext()!;
    store.complete(entry.id);

    store.enqueue(personalId, 'session', 'a');

    expect(store.counts(personalId)).toMatchObject({ pending: 1, done: 0 });
  });

  it('claimNext marks the entry running and stamps startedAt', () => {
    store.enqueue(personalId, 'session', 'a');
    const entry = store.claimNext()!;
    expect(entry.status).toBe('running');
    expect(entry.startedAt).not.toBeNull();
  });

  it('claimNext returns null on an empty queue', () => {
    expect(store.claimNext()).toBeNull();
  });

  it('never hands the same entry to two claims', () => {
    store.enqueue(personalId, 'session', 'a');
    const first = store.claimNext();
    const second = store.claimNext();
    expect(first?.itemKey).toBe('a');
    expect(second).toBeNull();
  });

  it('complete and fail move an entry out of pending, and fail records the error', () => {
    store.enqueue(personalId, 'session', 'a');
    store.enqueue(personalId, 'session', 'b');
    store.complete(store.claimNext()!.id);
    store.fail(store.claimNext()!.id, 'extraction blew up');

    const counts = store.counts(personalId);
    expect(counts).toMatchObject({ pending: 0, running: 0, done: 1, failed: 1 });
    const failed = store.list(personalId).find((e) => e.status === 'failed');
    expect(failed?.error).toBe('extraction blew up');
    expect(failed?.finishedAt).not.toBeNull();
  });

  it('a failed entry does not block the next claim', () => {
    store.enqueue(personalId, 'session', 'a');
    store.enqueue(personalId, 'session', 'b');
    store.fail(store.claimNext()!.id, 'nope');
    expect(store.claimNext()?.itemKey).toBe('b');
  });

  it('recoverOrphans resets running rows to pending and reports how many', () => {
    store.enqueue(personalId, 'session', 'a');
    store.claimNext();

    expect(store.recoverOrphans()).toBe(1);
    expect(store.counts(personalId)).toMatchObject({ pending: 1, running: 0 });
    expect(store.claimNext()?.itemKey).toBe('a');
  });

  it('recoverOrphans is a no-op when nothing was running', () => {
    store.enqueue(personalId, 'session', 'a');
    expect(store.recoverOrphans()).toBe(0);
  });

  it('counts are per account when an account is given, global otherwise', () => {
    store.enqueue(personalId, 'session', 'a');
    store.enqueue(workId, 'session', 'b');
    expect(store.counts(personalId).pending).toBe(1);
    expect(store.counts(workId).pending).toBe(1);
    expect(store.counts().pending).toBe(2);
  });

  it('list is scoped to one account and respects its limit', () => {
    store.enqueue(personalId, 'session', 'a');
    store.enqueue(personalId, 'session', 'b');
    store.enqueue(workId, 'session', 'c');

    const rows = store.list(personalId);
    expect(rows.map((r) => r.itemKey).sort()).toEqual(['a', 'b']);
    expect(store.list(personalId, 1)).toHaveLength(1);
  });

  it('clearFinished removes done and failed rows but leaves pending untouched', () => {
    store.enqueue(personalId, 'session', 'a');
    store.enqueue(personalId, 'session', 'b');
    store.enqueue(personalId, 'session', 'c');
    store.complete(store.claimNext()!.id);
    store.fail(store.claimNext()!.id, 'x');

    store.clearFinished(personalId);

    expect(store.counts(personalId)).toMatchObject({ pending: 1, done: 0, failed: 0 });
  });

  it('clearFinished only touches the account it was given', () => {
    store.enqueue(personalId, 'session', 'a');
    store.enqueue(workId, 'session', 'b');
    store.complete(store.claimNext()!.id);
    store.complete(store.claimNext()!.id);

    store.clearFinished(personalId);

    expect(store.counts(workId).done).toBe(1);
  });
});

describe('brain queue worker', () => {
  let db: Database;
  let store: BrainQueueStore;
  let accountId: number;

  function addAccount(name: string): number {
    const info = db.raw
      .prepare(
        `INSERT INTO accounts (name, config_dir, engine, subscription_label, has_cost)
         VALUES (?, ?, 'claude', 'Max', 0)`,
      )
      .run(name, `/tmp/${name}`);
    return Number(info.lastInsertRowid);
  }

  interface Harness {
    indexed: string[];
    paused: boolean;
    now: number;
    result: (itemKey: string) => Promise<{ skipped: boolean; reason: string }>;
  }

  function worker(h: Partial<Harness> = {}) {
    const state: Harness = {
      indexed: [],
      paused: false,
      now: 1_000_000,
      result: async () => ({ skipped: false, reason: 'ok' }),
      ...h,
    };
    const w = createBrainQueueWorker({
      store,
      process: async (entry) => {
        state.indexed.push(entry.itemKey);
        await state.result(entry.itemKey);
      },
      isPaused: () => state.paused,
      now: () => state.now,
    });
    return { w, state };
  }

  beforeEach(() => {
    db = createDatabase(':memory:');
    accountId = addAccount('personal');
    store = createBrainQueueStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('drains pending entries one at a time through indexSource', async () => {
    store.enqueue(accountId, 'session', 'a');
    store.enqueue(accountId, 'session', 'b');
    const { w, state } = worker();

    await w.drain();

    expect(state.indexed).toEqual(['a', 'b']);
    expect(store.counts(accountId)).toMatchObject({ pending: 0, done: 2 });
  });

  it('drains while the user has an interactive session open', async () => {
    store.enqueue(accountId, 'session', 'a');
    store.enqueue(accountId, 'session', 'b');
    const { w, state } = worker();

    await w.drain();

    expect(state.indexed).toEqual(['a', 'b']);
    expect(store.counts(accountId)).toMatchObject({ pending: 0, done: 2 });
  });

  it('does nothing while paused', async () => {
    store.enqueue(accountId, 'session', 'a');
    const { w, state } = worker({ paused: true });

    await w.drain();

    expect(state.indexed).toEqual([]);
    expect(store.counts(accountId).pending).toBe(1);
  });

  it('marks an entry failed when indexSource rejects, and moves on', async () => {
    store.enqueue(accountId, 'session', 'a');
    store.enqueue(accountId, 'session', 'b');
    const { w, state } = worker({
      result: async (key) => {
        if (key === 'a') throw new Error('extraction blew up');
        return { skipped: false, reason: 'ok' };
      },
    });

    await w.drain();

    expect(state.indexed).toEqual(['a', 'b']);
    const counts = store.counts(accountId);
    expect(counts).toMatchObject({ failed: 1, done: 1 });
    expect(store.list(accountId).find((e) => e.status === 'failed')?.error)
      .toContain('extraction blew up');
  });

  it('records a skipped result as done rather than failed', async () => {
    store.enqueue(accountId, 'session', 'a');
    const { w } = worker({ result: async () => ({ skipped: true, reason: 'unchanged' }) });

    await w.drain();

    expect(store.counts(accountId)).toMatchObject({ done: 1, failed: 0 });
  });

  it('never runs two drains concurrently', async () => {
    store.enqueue(accountId, 'session', 'a');
    store.enqueue(accountId, 'session', 'b');
    const { w, state } = worker();

    await Promise.all([w.drain(), w.drain()]);

    expect(state.indexed).toEqual(['a', 'b']);
  });

  it('exposes the current entry while working and null when idle', async () => {
    store.enqueue(accountId, 'session', 'a');
    const seen: (string | null)[] = [];
    const w = createBrainQueueWorker({
      store,
      process: async () => {
        seen.push(wRef.current()?.itemKey ?? null);
      },
      isPaused: () => false,
    });
    const wRef = w;

    expect(w.current()).toBeNull();
    await w.drain();

    expect(seen).toEqual(['a']);
    expect(w.current()).toBeNull();
    expect(w.running()).toBe(false);
  });

  it('reports yielding when paused, distinctly from running to empty', async () => {
    store.enqueue(accountId, 'session', 'a');
    const { w } = worker({ paused: true });
    expect(await w.drain()).toEqual({ processed: 0, yielded: true, reason: 'paused' });
  });

  it('reports how many it processed when it runs to empty', async () => {
    store.enqueue(accountId, 'session', 'a');
    store.enqueue(accountId, 'session', 'b');
    const { w } = worker();
    expect(await w.drain()).toEqual({ processed: 2, yielded: false, reason: 'empty' });
  });

  it('counts a failed item as processed', async () => {
    store.enqueue(accountId, 'session', 'bad');
    const { w } = worker({ result: () => Promise.reject(new Error('boom')) });
    expect((await w.drain()).processed).toBe(1);
  });

  it('reports partial progress when the user pauses mid-run', async () => {
    store.enqueue(accountId, 'session', 'a');
    store.enqueue(accountId, 'session', 'b');
    const { w, state } = worker({
      result: () => {
        state.paused = true;
        return Promise.resolve({ skipped: false, reason: 'ok' });
      },
    });
    expect(await w.drain()).toEqual({ processed: 1, yielded: true, reason: 'paused' });
  });

  it('stops cleanly on an empty queue', async () => {
    const { w, state } = worker();
    await expect(w.drain()).resolves.toEqual({ processed: 0, yielded: false, reason: 'empty' });
    expect(state.indexed).toEqual([]);
  });

  it('hands the whole entry to process, so the worker need not know what an item is', async () => {
    store.enqueue(accountId, 'session', 'a');
    store.enqueue(accountId, CURATION_SOURCE_ID, 'Subsystems/Widget.md');
    const seen: { sourceId: string; itemKey: string }[] = [];
    const w = createBrainQueueWorker({
      store,
      process: async (entry) => {
        seen.push({ sourceId: entry.sourceId, itemKey: entry.itemKey });
      },
      isPaused: () => false,
    });

    await w.drain();

    expect(seen).toEqual([
      { sourceId: 'session', itemKey: 'a' },
      { sourceId: CURATION_SOURCE_ID, itemKey: 'Subsystems/Widget.md' },
    ]);
  });

  it('fails only the curation entry when process throws for it', async () => {
    store.enqueue(accountId, CURATION_SOURCE_ID, 'Subsystems/Bad.md');
    store.enqueue(accountId, 'session', 'good');
    const w = createBrainQueueWorker({
      store,
      process: async (entry) => {
        if (entry.sourceId === CURATION_SOURCE_ID) throw new Error('model said no');
      },
      isPaused: () => false,
    });

    await w.drain();

    const rows = store.list(accountId);
    expect(rows.find((r) => r.itemKey === 'Subsystems/Bad.md')?.status).toBe('failed');
    expect(rows.find((r) => r.itemKey === 'Subsystems/Bad.md')?.error).toBe('model said no');
    expect(rows.find((r) => r.itemKey === 'good')?.status).toBe('done');
  });

  it('checks the pause gate between items, not just once', async () => {
    store.enqueue(accountId, 'session', 'a');
    store.enqueue(accountId, 'session', 'b');
    const { w, state } = worker({
      result: async () => {
        state.paused = true;
        return { skipped: false, reason: 'ok' };
      },
    });

    await w.drain();

    expect(state.indexed).toEqual(['a']);
    expect(store.counts(accountId).pending).toBe(1);
  });
});

describe('brain queue worker — rate-limit backoff', () => {
  let db: Database;
  let store: BrainQueueStore;
  let accountId: number;

  function addAccount(name: string): number {
    const info = db.raw
      .prepare(
        `INSERT INTO accounts (name, config_dir, engine, subscription_label, has_cost)
         VALUES (?, ?, 'claude', 'Max', 0)`,
      )
      .run(name, `/tmp/${name}`);
    return Number(info.lastInsertRowid);
  }

  const START = 1_000_000;

  function worker(reject: (key: string) => Error | null) {
    const state = { indexed: [] as string[], now: START };
    const w = createBrainQueueWorker({
      store,
      process: async (entry) => {
        state.indexed.push(entry.itemKey);
        const err = reject(entry.itemKey);
        if (err) throw err;
      },
      isPaused: () => false,
      now: () => state.now,
    });
    return { w, state };
  }

  beforeEach(() => {
    db = createDatabase(':memory:');
    accountId = addAccount('personal');
    store = createBrainQueueStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns a rate-limited entry to pending rather than failing it', async () => {
    store.enqueue(accountId, 'session', 'a');
    const { w } = worker(() => new Error('Claude usage limit reached'));

    await w.drain();

    expect(store.counts(accountId)).toMatchObject({ pending: 1, failed: 0, done: 0 });
  });

  it('stops the drain and reports when it will retry', async () => {
    store.enqueue(accountId, 'session', 'a');
    store.enqueue(accountId, 'session', 'b');
    const { w, state } = worker((k) => (k === 'a' ? new Error('429 too many requests') : null));

    const outcome = await w.drain();

    expect(state.indexed).toEqual(['a']);
    expect(outcome).toMatchObject({ processed: 0, yielded: true, reason: 'rate-limited' });
    expect(outcome.retryAt).toBe(START + RATE_LIMIT_COOLDOWN_MS);
  });

  it('claims nothing while the cooldown is in force', async () => {
    store.enqueue(accountId, 'session', 'a');
    const { w, state } = worker(() => new Error('rate limit exceeded'));
    await w.drain();
    state.indexed.length = 0;

    state.now = START + RATE_LIMIT_COOLDOWN_MS - 1;
    const outcome = await w.drain();

    expect(state.indexed).toEqual([]);
    expect(outcome).toMatchObject({ processed: 0, yielded: true, reason: 'rate-limited' });
  });

  it('resumes once the cooldown passes', async () => {
    store.enqueue(accountId, 'session', 'a');
    let limited = true;
    const { w, state } = worker(() => (limited ? new Error('usage limit reached') : null));
    await w.drain();
    limited = false;
    state.indexed.length = 0;

    state.now = START + RATE_LIMIT_COOLDOWN_MS;
    await w.drain();

    expect(state.indexed).toEqual(['a']);
    expect(store.counts(accountId)).toMatchObject({ done: 1, pending: 0 });
  });

  it('still fails an entry for an error that is not a rate limit', async () => {
    store.enqueue(accountId, 'session', 'a');
    store.enqueue(accountId, 'session', 'b');
    const { w, state } = worker((k) => (k === 'a' ? new Error('extraction blew up') : null));

    await w.drain();

    expect(state.indexed).toEqual(['a', 'b']);
    expect(store.counts(accountId)).toMatchObject({ failed: 1, done: 1 });
  });
});

describe('isRateLimitError', () => {
  it.each([
    'Claude usage limit reached',
    'RATE LIMIT exceeded, retry later',
    'HTTP 429 Too Many Requests',
    'quota exceeded for this organization',
  ])('matches %j', (message) => {
    expect(isRateLimitError(message)).toBe(true);
  });

  it.each([
    'extraction blew up',
    'zod validation failed: entities[0].name',
    'wrote note Topics/rate-limit-tracking.md',
    'ENOENT: no such file or directory',
  ])('does not match %j', (message) => {
    expect(isRateLimitError(message)).toBe(false);
  });
});
