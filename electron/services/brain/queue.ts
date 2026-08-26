import type { Database } from '../database';

/**
 * The persistent indexing queue (spec §11).
 *
 * `brain_queue` has existed since schema v18 and until now had no owner. This
 * file is the only thing that knows its columns.
 *
 * The queue survives restart and drains at concurrency 1.
 *
 * It used to yield entirely while any session tab was open. Plan 8 removed
 * that: a tab is open for hours and spends rate limit for seconds of it, so the
 * gate stalled the queue almost permanently (165 items pending) while
 * protecting almost nothing. The per-item guard that was doing the real work —
 * refusing a transcript still being written — lives in the registry and stays.
 * What replaces the gate as a brake is `isRateLimitError` plus a cooldown.
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
  /**
   * Put a claimed entry back, as though it had never been handed out.
   *
   * For a rate limit specifically: the item is fine, the account is out of
   * budget for the moment. `fail` would be a lie that also costs the user a
   * manual retry, since a failed row is terminal until something re-enqueues it.
   */
  requeue(id: number): void;
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

/**
 * How long to stand down after the account reports a rate limit.
 *
 * In memory, never persisted. A restart is already the user saying they want
 * something to happen, and an app that silently refuses to index for fifteen
 * minutes after launch is indistinguishable from one that is broken.
 */
export const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Whether a failure means "the account is out of budget" rather than "this item
 * is bad".
 *
 * A predicate rather than an inline regex because it is the one part of backoff
 * that depends on wording the CLI controls: when a message shape changes this
 * is a one-line edit with its own test, instead of an archaeology exercise
 * inside a control-flow branch.
 *
 * `rate limit` matches with a space and NOT with a hyphen on purpose. This
 * corpus is engineering prose about, among other things, rate-limit tracking,
 * so `wrote note Topics/rate-limit-tracking.md` must not read as a rate limit.
 */
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
  isPaused(): boolean;
  /** Injectable clock, so cooldown behaviour is testable without timers. */
  now?: () => number;
}

/**
 * What one drain actually did.
 *
 * `drain()` used to return void, so every caller had to assume success. The
 * Brain tab printed "drain finished" whether the worker had indexed 158 items
 * or yielded instantly because a session was open — the user pressed the
 * button, nothing happened, and the UI congratulated itself.
 */
export interface DrainOutcome {
  /** Items taken to a terminal state, successes and failures alike. */
  processed: number;
  /** True when the worker stopped for a reason other than an empty queue. */
  yielded: boolean;
  reason: 'empty' | 'paused' | 'rate-limited' | 'busy';
  /**
   * Epoch ms when a rate-limited worker will try again. Present only for
   * `'rate-limited'`, so the panel can say when rather than only that it
   * stopped — "paused until 2:14pm" is actionable and "paused" is not.
   */
  retryAt?: number;
}

export interface BrainQueueWorker {
  /** Drain until empty or until yielding. Safe to call repeatedly. */
  drain(): Promise<DrainOutcome>;
  /** The entry being worked on right now, for the operational pane. */
  current(): QueueEntry | null;
  running(): boolean;
}

export function createBrainQueueWorker(deps: QueueWorkerDeps): BrainQueueWorker {
  let draining = false;
  let currentEntry: QueueEntry | null = null;
  /** Epoch ms before which no entry may be claimed. Null when clear. */
  let cooldownUntil: number | null = null;
  const now = deps.now ?? Date.now;

  async function drain(): Promise<DrainOutcome> {
    // Re-entry guard. Concurrency 1 is the contract with the user's rate
    // limit, and a second drain would also pay twice for one item. Reported as
    // a yield rather than a completion: this call indexed nothing.
    if (draining) return { processed: 0, yielded: true, reason: 'paused' };
    draining = true;
    let processed = 0;
    try {
      for (;;) {
        // Re-checked every iteration, not once at the top: checking only on
        // entry would let a long backfill run to completion no matter what the
        // user started doing halfway through.
        //
        // Separate checks rather than one `||` so the caller learns WHICH
        // stopped it — "you paused it" and "the account is rate limited" need
        // different words in the UI, and the user has to tell them apart.
        if (deps.isPaused()) return { processed, yielded: true, reason: 'paused' };
        if (cooldownUntil !== null && now() < cooldownUntil) {
          return { processed, yielded: true, reason: 'rate-limited', retryAt: cooldownUntil };
        }

        const entry = deps.store.claimNext();
        if (!entry) return { processed, yielded: false, reason: 'empty' };

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
          const message = (err as Error).message;
          if (isRateLimitError(message)) {
            // Not `processed`: nothing was taken to a terminal state, and the
            // item goes back exactly as it was. Counting it would report work
            // the user did not get.
            deps.store.requeue(entry.id);
            cooldownUntil = now() + RATE_LIMIT_COOLDOWN_MS;
            return { processed, yielded: true, reason: 'rate-limited', retryAt: cooldownUntil };
          }
          // Spec §8: a failed item never blocks the queue.
          deps.store.fail(entry.id, message);
        } finally {
          currentEntry = null;
        }
        // After the try, not inside a `finally`: the rate-limit path returns
        // without processing anything, and a `finally` would credit it anyway.
        // A failed item still counts — it reached a terminal state, and
        // progress that stalled on failures would read as a hung run.
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

/**
 * How long an OPEN session's transcript must sit untouched before the indexer
 * stops treating it as still being written.
 *
 * "Live" used to mean `open`, which meant a tab left open for a week held its
 * conversation out of the vault indefinitely. It now means `still being
 * written`, and this is the line between the two. Fifteen minutes is short
 * enough that a finished conversation lands the same afternoon and long enough
 * that a pause to read a diff does not trip it.
 *
 * The user adjusts it in Brain → Settings. It is deliberately NOT a cap on
 * re-indexing: a session that resumes after being indexed is indexed again, so
 * the note tracks the conversation rather than a snapshot of it.
 */
export const BRAIN_IDLE_MINUTES_SETTING_KEY = 'brain.idleMinutes';
export const DEFAULT_IDLE_MINUTES = 15;
export const MIN_IDLE_MINUTES = 1;
export const MAX_IDLE_MINUTES = 1440;

/**
 * How far back the PERIODIC sweep looks. The Backfill button ignores it.
 *
 * Its whole job is the first tick after the auto-index opt-in: without a
 * floor, that tick would discover every transcript the user has ever written
 * and enqueue the lot unattended — the precise failure the off-by-default
 * posture exists to prevent. Backfill stays the deliberate "everything" action.
 */
export const BRAIN_SWEEP_HOURS_SETTING_KEY = 'brain.sweepHours';
export const DEFAULT_SWEEP_HOURS = 24;
export const MIN_SWEEP_HOURS = 1;
export const MAX_SWEEP_HOURS = 720;

/**
 * Read one numeric setting out of `app_settings`, which stores strings.
 *
 * Clamps rather than rejects, and falls back rather than throwing: these
 * values are milliseconds by the time anything uses them, and a `NaN`
 * threshold would compare false against every transcript and silently disable
 * the feature. A hand-edited row should misbehave visibly at the edge of its
 * range, never turn into a no-op nobody can see.
 */
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
