import type { Database } from '../database';

/**
 * The persistent indexing queue (spec §11).
 *
 * `brain_queue` has existed since schema v18 and until now had no owner. This
 * file is the only thing that knows its columns.
 *
 * The queue survives restart, drains at concurrency 1, and yields entirely
 * while the user has an interactive session open — indexing must never compete
 * with real work for rate limit.
 */

export type QueueStatus = 'pending' | 'running' | 'done' | 'failed';

export interface QueueEntry {
  id: number;
  accountId: number;
  sourceId: string;
  itemKey: string;
  status: QueueStatus;
  error: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface QueueCounts {
  pending: number;
  running: number;
  done: number;
  failed: number;
}

export interface BrainQueueStore {
  /** Idempotent for a pending or running item; re-runs a finished one. */
  enqueue(accountId: number, sourceId: string, itemKey: string): void;
  /** Oldest pending entry, marked running. Null when there is nothing to do. */
  claimNext(): QueueEntry | null;
  complete(id: number): void;
  fail(id: number, error: string): void;
  counts(accountId?: number): QueueCounts;
  list(accountId: number, limit?: number): QueueEntry[];
  /** Reset orphaned `running` rows to pending. Call once at startup. */
  recoverOrphans(): number;
  clearFinished(accountId: number): void;
}

interface Row {
  id: number;
  account_id: number;
  source_id: string;
  item_key: string;
  status: string;
  error: string | null;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function toEntry(row: Row): QueueEntry {
  return {
    id: row.id,
    accountId: row.account_id,
    sourceId: row.source_id,
    itemKey: row.item_key,
    status: row.status as QueueStatus,
    error: row.error,
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function createBrainQueueStore(db: Database): BrainQueueStore {
  const raw = db.raw;

  function enqueue(accountId: number, sourceId: string, itemKey: string): void {
    // The WHERE on the upsert is what makes this safe to call from anywhere:
    // a pending or running item is left exactly as it is (so an enqueue racing
    // the worker cannot hand the same item out twice), while a finished one
    // resets to pending — a session the user continued is genuinely new
    // material, and the UNIQUE constraint would otherwise mean an item could
    // be indexed only once in the lifetime of the database.
    raw
      .prepare(
        `INSERT INTO brain_queue (account_id, source_id, item_key, status)
         VALUES (?, ?, ?, 'pending')
         ON CONFLICT (account_id, source_id, item_key) DO UPDATE SET
           status = 'pending',
           error = NULL,
           enqueued_at = CURRENT_TIMESTAMP,
           started_at = NULL,
           finished_at = NULL
         WHERE brain_queue.status IN ('done', 'failed')`,
      )
      .run(accountId, sourceId, itemKey);
  }

  /**
   * Select-then-update inside one transaction.
   *
   * Concurrency is 1 today, but a claim that is only atomic by luck is a bug
   * waiting for the day it is not — and double-claiming means paying twice for
   * one item and racing two writers into the same note.
   */
  const claimTxn = raw.transaction((): Row | null => {
    const row = raw
      .prepare("SELECT * FROM brain_queue WHERE status = 'pending' ORDER BY id LIMIT 1")
      .get() as Row | undefined;
    if (!row) return null;
    raw
      .prepare(
        "UPDATE brain_queue SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
      .run(row.id);
    return raw.prepare('SELECT * FROM brain_queue WHERE id = ?').get(row.id) as Row;
  });

  function claimNext(): QueueEntry | null {
    const row = claimTxn();
    return row ? toEntry(row) : null;
  }

  function finish(id: number, status: 'done' | 'failed', error: string | null): void {
    raw
      .prepare(
        'UPDATE brain_queue SET status = ?, error = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?',
      )
      .run(status, error, id);
  }

  function counts(accountId?: number): QueueCounts {
    const rows = (
      accountId === undefined
        ? raw.prepare('SELECT status, COUNT(*) AS n FROM brain_queue GROUP BY status').all()
        : raw
            .prepare(
              'SELECT status, COUNT(*) AS n FROM brain_queue WHERE account_id = ? GROUP BY status',
            )
            .all(accountId)
    ) as { status: string; n: number }[];

    const out: QueueCounts = { pending: 0, running: 0, done: 0, failed: 0 };
    for (const row of rows) {
      if (row.status in out) out[row.status as QueueStatus] = row.n;
    }
    return out;
  }

  function list(accountId: number, limit = 200): QueueEntry[] {
    const rows = raw
      .prepare('SELECT * FROM brain_queue WHERE account_id = ? ORDER BY id DESC LIMIT ?')
      .all(accountId, limit) as Row[];
    return rows.map(toEntry);
  }

  function recoverOrphans(): number {
    // A crash or quit mid-item leaves a row `running` forever. Without this the
    // queue silently stops draining after one bad shutdown, and the Brain tab
    // shows a current item nobody is working on.
    const info = raw
      .prepare(
        "UPDATE brain_queue SET status = 'pending', started_at = NULL WHERE status = 'running'",
      )
      .run();
    return info.changes;
  }

  function clearFinished(accountId: number): void {
    raw
      .prepare("DELETE FROM brain_queue WHERE account_id = ? AND status IN ('done', 'failed')")
      .run(accountId);
  }

  return {
    enqueue,
    claimNext,
    complete: (id) => { finish(id, 'done', null); },
    fail: (id, error) => { finish(id, 'failed', error); },
    counts,
    list,
    recoverOrphans,
    clearFinished,
  };
}

/**
 * True while the user has an interactive session open.
 *
 * IMPORTANT: implement this with `listActiveTabIds()`, never
 * `listInFlightTabIds()`. The latter is hardcoded to `return []`
 * (`sessions/lifecycle.ts:511`, dead since the jsonl-as-rendered refactor) and
 * `docs/session-lifecycle.md` names relying on it as an anti-pattern. A worker
 * gated on it would never yield — it would run hardest exactly when the user is
 * working, which is the failure the yield rule exists to prevent.
 */
export type HasActiveSession = () => boolean;

export interface QueueWorkerDeps {
  store: BrainQueueStore;
  /**
   * Do one entry's work. Takes the WHOLE entry, not `(accountId, itemKey)`:
   * the queue now carries more than one kind of work — indexing a source and
   * curating a note — and a worker that destructured the pair would have to
   * know which was which. The registry owns that dispatch; this file does not
   * know what an item is.
   *
   * Resolves for a completed unit of work, including a skip. Rejects only for
   * a real failure, which is recorded against the entry and never blocks the
   * queue.
   */
  process(entry: QueueEntry): Promise<void>;
  hasActiveSession: HasActiveSession;
  isPaused(): boolean;
}

export interface BrainQueueWorker {
  /** Drain until empty or until yielding. Safe to call repeatedly. */
  drain(): Promise<void>;
  /** The entry being worked on right now, for the operational pane. */
  current(): QueueEntry | null;
  running(): boolean;
}

export function createBrainQueueWorker(deps: QueueWorkerDeps): BrainQueueWorker {
  let draining = false;
  let currentEntry: QueueEntry | null = null;

  async function drain(): Promise<void> {
    // Re-entry guard. Concurrency 1 is the contract with the user's rate
    // limit, and a second drain would also pay twice for one item.
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        // Re-checked every iteration, not once at the top: checking only on
        // entry would let a long backfill run to completion no matter what the
        // user started doing halfway through.
        if (deps.isPaused() || deps.hasActiveSession()) return;

        const entry = deps.store.claimNext();
        if (!entry) return;

        currentEntry = entry;
        try {
          // A skipped result — a gate rejection, an item unchanged since it was
          // last indexed, or a note that no longer qualifies for curation — is
          // a COMPLETED unit of work, not a failure. Recording it as failed
          // would fill the operational pane with red during entirely normal
          // operation.
          await deps.process(entry);
          deps.store.complete(entry.id);
        } catch (err) {
          // Spec §8: a failed item never blocks the queue.
          deps.store.fail(entry.id, (err as Error).message);
        } finally {
          currentEntry = null;
        }
      }
    } finally {
      draining = false;
      currentEntry = null;
    }
  }

  return {
    drain,
    current: () => currentEntry,
    running: () => draining,
  };
}

/**
 * Auto-indexing on session close. Default `'false'`: the worker ships fully
 * built but idle, because it spends tokens unattended and the user should opt
 * in once — after seeing real notes from an explicit backfill — rather than
 * discovering it already ran.
 */
export const BRAIN_AUTO_INDEX_SETTING_KEY = 'brain.autoIndex';

/** User-facing pause for the queue, independent of the auto-index opt-in. */
export const BRAIN_QUEUE_PAUSED_SETTING_KEY = 'brain.queuePaused';

/**
 * The sentinel `source_id` for a curation row. It names no adapter — there is
 * no curation `BrainSource` — and exists so one queue can carry both kinds of
 * work. The registry dispatches on it; nothing else should match on it.
 */
export const CURATION_SOURCE_ID = 'curation';

/**
 * Curation on session close. Default `'false'`, for the same reason
 * auto-indexing is, and one more: curation REWRITES existing notes rather than
 * only adding to them. The user opts in once, after seeing real output.
 */
export const BRAIN_CURATE_SETTING_KEY = 'brain.curate';
