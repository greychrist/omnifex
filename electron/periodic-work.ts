/**
 * The background work that has to happen whether or not anyone is looking:
 * cost-history backfill, internal-archive pruning, SQLite free-page reclaim,
 * and the Brain's discovery sweep + queue drain.
 *
 * One module, two composition roots. `electron/main.ts` and
 * `electron/remote/daemon.ts` build the same service graph, and until this
 * existed they each carried their own copy of these four blocks — the exact
 * "change both or neither" hazard CLAUDE.md warns about, except here the
 * failure was worse than drift: remote mode is the default, so both processes
 * are normally alive and both ran every block against the one database.
 *
 * `createBrainService()` calls `queueStore.recoverOrphans()` at construction,
 * which flips every `running` row back to `pending`. Launch the app while the
 * daemon is mid-extraction and that transcript is distilled a second time.
 * `merge.ts` is idempotent so the note is unchanged — but `brain_spend` is an
 * append-only ledger, so the second Sonnet call is billed for real.
 *
 * Hence `enabled`: main passes a gate that closes whenever the daemon answered
 * `remote:url`, and the daemon passes none. Read per tick, never sampled at
 * construction — main does not know whether a daemon exists until the renderer
 * asks, which happens after the timers are armed.
 */

import {
  BRAIN_AUTO_INDEX_SETTING_KEY,
  BRAIN_CURATE_SETTING_KEY,
  BRAIN_SWEEP_HOURS_SETTING_KEY,
  DEFAULT_SWEEP_HOURS,
  MAX_SWEEP_HOURS,
  MIN_SWEEP_HOURS,
  readNumericSetting,
} from './services/brain/queue';
import { pruneInternalArchive } from './services/sessions/internal-archive';
import type { AccountLike as CostAccountLike, CostHistoryService } from './services/cost/cost-history';

const THIRTY_SECONDS = 30_000;
const ONE_HOUR = 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;

/**
 * Only the fields this module reads: `name` / `config_dir` for the cost sweep,
 * `id` for the Brain's per-account vault lookup.
 */
type PeriodicAccount = CostAccountLike & { id: number };

/** Only the Brain surface the sweep touches. */
interface BrainLike {
  vaultPath(accountId: number): string | null;
  backfill(accountId: number, opts?: { sinceMs?: number }): Promise<number>;
  enqueueCuration(accountId: number): number;
  drainQueue(): Promise<unknown>;
}

export interface PeriodicWorkDeps {
  db: {
    getSetting(key: string): string | null | undefined;
    reclaimFreePages(): void;
  };
  listAccounts(): PeriodicAccount[];
  costHistory: Pick<CostHistoryService, 'backfill'>;
  costBackfillOpts: { archiveRoot: string };
  /** Root of `<userData>/internal-sessions`, the pruner's target. */
  internalArchive: string;
  /**
   * Read per use, not captured: both roots assign their `brainRef` after the
   * service graph is built, and the daemon can be running before it resolves.
   */
  brain: () => BrainLike | undefined;
  log: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  /**
   * Whether this process owns the work right now. Omitted means "always" —
   * that is the daemon. Evaluated on every tick.
   */
  enabled?: () => boolean;
}

/** Arms the timers. Returns the disposer that clears all of them. */
export function startPeriodicWork(deps: PeriodicWorkDeps): () => void {
  const { db, listAccounts, costHistory, costBackfillOpts, internalArchive, brain, log } = deps;
  const owned = (): boolean => deps.enabled?.() ?? true;

  const timers: (NodeJS.Timeout | number)[] = [];

  // Backfill from surviving transcripts shortly after startup, then sweep
  // hourly to catch sessions run outside OmniFex (terminal claude-work).
  timers.push(
    setTimeout(() => {
      if (!owned()) return;
      try {
        const r = costHistory.backfill(listAccounts(), costBackfillOpts);
        log.info('cost-history startup backfill', { sessionsScanned: r.sessionsScanned });
      } catch (err) {
        log.warn('cost-history startup backfill failed', { error: String(err) });
      }
    }, THIRTY_SECONDS),
  );

  timers.push(
    setInterval(() => {
      if (!owned()) return;
      try {
        costHistory.backfill(listAccounts(), costBackfillOpts);
        // Prune AFTER the sweep, never before: a transcript that has not been
        // priced yet must not be deleted for being old. Cost rows survive the
        // prune either way, but pruning first would drop the spend entirely.
        pruneInternalArchive(
          internalArchive,
          Number(db.getSetting('internal.archive.retentionDays') ?? 90),
          new Date().toISOString().slice(0, 10),
        );
      } catch (err) {
        log.warn('cost-history sweep failed', { error: String(err) });
      }
    }, ONE_HOUR),
  );

  // Hand back pages freed by deletes anywhere in the database — rate-limit
  // snapshots, brain queue rows, cost history — not just by a log prune, which
  // compacts on its own way out. Without this, deleted space stays on SQLite's
  // freelist and the file only ever grows: greychrist.db reached 2.15 GB
  // holding 36 MB of live data that way.
  //
  // Cheap by construction: `reclaimFreePages` returns immediately when the
  // freelist is empty (the steady state), and when it isn't, it moves free
  // pages only and never rewrites live data. Hourly rather than on every
  // delete so it never lands on a write path.
  timers.push(
    setInterval(() => {
      if (!owned()) return;
      try {
        db.reclaimFreePages();
      } catch (err) {
        log.warn('free-page reclaim failed', { error: String(err) });
      }
    }, ONE_HOUR),
  );

  // Periodic discovery, then drain.
  //
  // The drain half is Plan 8's: session close is the only other trigger, and
  // it is not enough on its own — a drain that stops (paused, rate limited, or
  // because a selection run held the worker) used to have nothing to restart
  // it until the next session happened to close, which is how 165 items came
  // to be pending.
  //
  // The discovery half is why a tab no longer has to close for its
  // conversation to reach the vault. Session close used to be the ONLY thing
  // that enqueued anything; a tab left open for a week held a conversation
  // that ended on Tuesday out of the vault indefinitely. Both halves are
  // bounded so an idle app pays nothing: an empty queue costs one indexed
  // SELECT, and `backfill`'s cheap predicates run ahead of `admit()` so a
  // sweep that finds nothing new reads no transcripts at all.
  timers.push(
    setInterval(() => {
      if (!owned()) return;
      void (async () => {
        // Read fresh on every tick, matching the close-time gate: a flip in
        // the Settings pane applies without a restart.
        const autoIndexOn = db.getSetting(BRAIN_AUTO_INDEX_SETTING_KEY) === 'true';
        const curateOn = db.getSetting(BRAIN_CURATE_SETTING_KEY) === 'true';

        if (autoIndexOn || curateOn) {
          const sinceMs =
            Date.now() -
            readNumericSetting(
              db.getSetting(BRAIN_SWEEP_HOURS_SETTING_KEY),
              DEFAULT_SWEEP_HOURS,
              MIN_SWEEP_HOURS,
              MAX_SWEEP_HOURS,
            ) * ONE_HOUR;

          for (const account of listAccounts()) {
            // An account with no vault has nowhere to put a note, and
            // `backfill` would only queue work that failed at claim time.
            if (!brain()?.vaultPath(account.id)) continue;
            try {
              if (autoIndexOn) await brain()?.backfill(account.id, { sinceMs });
              // Curation has the same gap indexing had: it was close-triggered
              // only, so a user who never closes tabs would accumulate notes
              // that nothing ever compressed — and unlimited re-indexing is
              // exactly what makes notes accumulate. `enqueueCuration` selects
              // from the vault as it stands now and caps itself per run.
              if (curateOn) brain()?.enqueueCuration(account.id);
            } catch (err) {
              // One account's failure must not cost the others their sweep.
              log.warn('brain sweep failed for account', { accountId: account.id, error: String(err) });
            }
          }
        }

        await brain()?.drainQueue();
      })().catch((err: unknown) => {
        log.warn('brain periodic sweep failed', { error: String(err) });
      });
    }, FIVE_MINUTES),
  );

  return () => {
    for (const t of timers) {
      clearTimeout(t as NodeJS.Timeout);
      clearInterval(t as NodeJS.Timeout);
    }
    timers.length = 0;
  };
}
