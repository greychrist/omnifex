import type { Database } from '../database';

/** The only code that knows `brain_queue`'s columns. Drains at concurrency 1; a rate limit triggers a cooldown. */

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
  claimNext(): QueueEntry | null;
  complete(id: number): void;
  fail(id: number, error: string): void;
  /** For rate limits: the item is fine, so `fail` (terminal until re-enqueued) would be wrong. */
  requeue(id: number): void;
  counts(accountId?: number): QueueCounts;
  list(accountId: number, limit?: number): QueueEntry[];
  /** Call once at startup. */
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
    // The upsert's WHERE leaves pending/running rows untouched (no double hand-out) and resets finished ones.
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

  /** One transaction: two processes claim from the same DB, and a double claim pays twice and races two writers. */
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
    // Without this, one bad shutdown leaves a row running forever and the queue stops draining.
    const info = raw
      .prepare(
        "UPDATE brain_queue SET status = 'pending', started_at = NULL WHERE status = 'running'",
      )
      .run();
    return info.changes;
  }

  function requeue(id: number): void {
    raw
      .prepare(
        `UPDATE brain_queue
            SET status = 'pending', started_at = NULL, error = NULL
          WHERE id = ?`,
      )
      .run(id);
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
    requeue,
    counts,
    list,
    recoverOrphans,
    clearFinished,
  };
}

/** In memory, never persisted: a restart must not silently refuse to index. */
export const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;

/** `rate limit` with a space only: the corpus is full of `rate-limit` prose that must not match. */
export function isRateLimitError(message: string): boolean {
  return (
    /usage limit/i.test(message) ||
    /rate limit/i.test(message) ||
    /\b429\b/.test(message) ||
    /quota exceeded/i.test(message)
  );
}

export interface QueueWorkerDeps {
  store: BrainQueueStore;
  /** Takes the whole entry: the registry owns dispatch. Rejects only for a real failure, which never blocks the queue. */
  process(entry: QueueEntry): Promise<void>;
  isPaused(): boolean;
  now?: () => number;
}

export interface DrainOutcome {
  processed: number;
  yielded: boolean;
  reason: 'empty' | 'paused' | 'rate-limited' | 'busy';
  retryAt?: number;
}

export interface BrainQueueWorker {
  drain(): Promise<DrainOutcome>;
  current(): QueueEntry | null;
  running(): boolean;
}

export function createBrainQueueWorker(deps: QueueWorkerDeps): BrainQueueWorker {
  let draining = false;
  let currentEntry: QueueEntry | null = null;
  let cooldownUntil: number | null = null;
  const now = deps.now ?? Date.now;

  async function drain(): Promise<DrainOutcome> {
    // Re-entry guard: concurrency 1 is the contract with the user's rate limit.
    if (draining) return { processed: 0, yielded: true, reason: 'paused' };
    draining = true;
    let processed = 0;
    try {
      for (;;) {
        // Re-checked every iteration, so a long backfill stops when the user pauses.
        if (deps.isPaused()) return { processed, yielded: true, reason: 'paused' };
        if (cooldownUntil !== null && now() < cooldownUntil) {
          return { processed, yielded: true, reason: 'rate-limited', retryAt: cooldownUntil };
        }

        const entry = deps.store.claimNext();
        if (!entry) return { processed, yielded: false, reason: 'empty' };

        currentEntry = entry;
        try {
          // A skip is a completed unit of work, never a failure.
          await deps.process(entry);
          deps.store.complete(entry.id);
        } catch (err) {
          const message = (err as Error).message;
          if (isRateLimitError(message)) {
            // Not counted as processed: nothing reached a terminal state.
            deps.store.requeue(entry.id);
            cooldownUntil = now() + RATE_LIMIT_COOLDOWN_MS;
            return { processed, yielded: true, reason: 'rate-limited', retryAt: cooldownUntil };
          }
          // A failed item never blocks the queue.
          deps.store.fail(entry.id, message);
        } finally {
          currentEntry = null;
        }
        // After the try, not in a finally: the rate-limit path returns without processing.
        processed += 1;
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

/** Default off: it spends tokens unattended, so the user opts in once. */
export const BRAIN_AUTO_INDEX_SETTING_KEY = 'brain.autoIndex';

export const BRAIN_QUEUE_PAUSED_SETTING_KEY = 'brain.queuePaused';

/** Names no adapter; only the registry dispatches on it. */
export const CURATION_SOURCE_ID = 'curation';

/** Default off: curation rewrites existing notes. */
export const BRAIN_CURATE_SETTING_KEY = 'brain.curate';

/** Not a cap on re-indexing: a session that resumes after being indexed is indexed again. */
export const BRAIN_IDLE_MINUTES_SETTING_KEY = 'brain.idleMinutes';
export const DEFAULT_IDLE_MINUTES = 15;
export const MIN_IDLE_MINUTES = 1;
export const MAX_IDLE_MINUTES = 1440;

/** Periodic sweep only: without a floor, the first tick after opt-in enqueues every transcript ever written. */
export const BRAIN_SWEEP_HOURS_SETTING_KEY = 'brain.sweepHours';
export const DEFAULT_SWEEP_HOURS = 24;
export const MIN_SWEEP_HOURS = 1;
export const MAX_SWEEP_HOURS = 720;

/** Clamps and falls back, never throws: a NaN threshold would silently disable the feature. */
export function readNumericSetting(
  raw: string | null | undefined,
  def: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return def;
  return Math.min(max, Math.max(min, parsed));
}
