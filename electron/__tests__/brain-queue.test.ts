import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import {
  createBrainQueueStore,
  createBrainQueueWorker,
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
    // Otherwise an enqueue racing the worker hands the same item out twice.
    expect(store.counts(personalId)).toMatchObject({ pending: 0, running: 1 });
  });

  it('re-enqueues an item that already finished', () => {
    store.enqueue(personalId, 'session', 'a');
    const entry = store.claimNext()!;
    store.complete(entry.id);

    store.enqueue(personalId, 'session', 'a');

    // A session the user continued is genuinely new material. The UNIQUE
    // constraint is on (account, source, item), so a finished row must reset
    // to pending rather than be rejected — otherwise a session could only ever
    // be indexed once in the lifetime of the database.
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
    // Concurrency 1 is the whole contract with the user's rate limit.
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
    // Spec §8: a failed item never blocks the queue.
    expect(store.claimNext()?.itemKey).toBe('b');
  });

  it('recoverOrphans resets running rows to pending and reports how many', () => {
    store.enqueue(personalId, 'session', 'a');
    store.claimNext();

    // A crash or quit mid-item leaves `running` forever. Without recovery the
    // queue silently stops draining after one bad shutdown, and the tab shows
    // an item nobody is working on.
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
    active: boolean;
    paused: boolean;
    result: (itemKey: string) => Promise<{ skipped: boolean; reason: string }>;
  }

  function worker(h: Partial<Harness> = {}) {
    const state: Harness = {
      indexed: [],
      active: false,
      paused: false,
      result: async () => ({ skipped: false, reason: 'ok' }),
      ...h,
    };
    const w = createBrainQueueWorker({
      store,
      indexSource: async (_accountId, itemKey) => {
        state.indexed.push(itemKey);
        return state.result(itemKey);
      },
      hasActiveSession: () => state.active,
      isPaused: () => state.paused,
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

  it('does nothing while an interactive session is active', async () => {
    store.enqueue(accountId, 'session', 'a');
    const { w, state } = worker({ active: true });

    await w.drain();

    // Spec §11: indexing must never compete with the user for rate limit.
    expect(state.indexed).toEqual([]);
    // Yielding must not consume the item — it is still waiting, not lost.
    expect(store.counts(accountId).pending).toBe(1);
  });

  it('resumes once the active session ends', async () => {
    store.enqueue(accountId, 'session', 'a');
    const { w, state } = worker({ active: true });
    await w.drain();
    state.active = false;

    await w.drain();

    expect(state.indexed).toEqual(['a']);
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

    // Spec §8: a failed item never blocks the queue.
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

    // A gate rejection or an unchanged item is a completed unit of work, not a
    // failure. Recording it as failed would fill the operational pane with red
    // during entirely normal operation.
    expect(store.counts(accountId)).toMatchObject({ done: 1, failed: 0 });
  });

  it('never runs two drains concurrently', async () => {
    store.enqueue(accountId, 'session', 'a');
    store.enqueue(accountId, 'session', 'b');
    const { w, state } = worker();

    await Promise.all([w.drain(), w.drain()]);

    // Concurrency 1 is the whole contract with the user's rate limit; a
    // double-drain would also pay twice for one item.
    expect(state.indexed).toEqual(['a', 'b']);
  });

  it('exposes the current entry while working and null when idle', async () => {
    store.enqueue(accountId, 'session', 'a');
    const seen: (string | null)[] = [];
    const w = createBrainQueueWorker({
      store,
      indexSource: async () => {
        seen.push(wRef.current()?.itemKey ?? null);
        return { skipped: false, reason: 'ok' };
      },
      hasActiveSession: () => false,
      isPaused: () => false,
    });
    const wRef = w;

    expect(w.current()).toBeNull();
    await w.drain();

    expect(seen).toEqual(['a']);
    expect(w.current()).toBeNull();
    expect(w.running()).toBe(false);
  });

  it('stops cleanly on an empty queue', async () => {
    const { w, state } = worker();
    await expect(w.drain()).resolves.toBeUndefined();
    expect(state.indexed).toEqual([]);
  });

  it('checks the yield gate between items, not just once', async () => {
    store.enqueue(accountId, 'session', 'a');
    store.enqueue(accountId, 'session', 'b');
    const { w, state } = worker({
      result: async () => {
        // The user starts a session while the first item is being indexed.
        state.active = true;
        return { skipped: false, reason: 'ok' };
      },
    });

    await w.drain();

    // Re-checking only at the top of the loop would let a long backfill run to
    // completion no matter what the user started doing halfway through.
    expect(state.indexed).toEqual(['a']);
    expect(store.counts(accountId).pending).toBe(1);
  });
});
