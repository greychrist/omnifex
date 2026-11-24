// The dev daemon passes a closed `enabled` gate (read per tick): two processes on one DB re-run
// recovered Brain extractions and bill `brain_spend` twice.

import {
  BRAIN_AUTO_INDEX_SETTING_KEY,
  BRAIN_CURATE_SETTING_KEY,
  BRAIN_SWEEP_HOURS_SETTING_KEY,
  DEFAULT_SWEEP_HOURS,
  MAX_SWEEP_HOURS,
  MIN_SWEEP_HOURS,
  readNumericSetting,
} from './services/brain/queue';
import { settleStrandedScratch } from './services/sessions/internal-spend';
import { AUTO_ON_CLOSE_SETTING_KEY, ENABLED_SETTING_KEY } from './services/sessions-summary';
import { createSummarySweep, type SummarySweepDeps } from './services/summary-sweep';
import type { AccountLike as CostAccountLike, CostHistoryService } from './services/cost/cost-history';

const TEN_SECONDS = 10_000;
const THIRTY_SECONDS = 30_000;
const ONE_HOUR = 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;

type PeriodicAccount = CostAccountLike & { id: number };

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
  costHistory: Pick<CostHistoryService, 'backfill' | 'recordInternal'>;
  /** Read per use, not captured: assigned after the service graph is built. */
  brain: () => BrainLike | undefined;
  /** Read per tick, like `brain`: assigned late. */
  summary: SummarySweepDeps['summary'];
  activeSessionIds: () => string[];
  log: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  warmSessionMetadata?: () => Promise<{ files: number }>;
  enabled?: () => boolean;
}

export function startPeriodicWork(deps: PeriodicWorkDeps): () => void {
  const { db, listAccounts, costHistory, brain, log } = deps;
  const owned = (): boolean => deps.enabled?.() ?? true;

  const timers: (NodeJS.Timeout | number)[] = [];

  const settleScratch = (): void => {
    try {
      const r = settleStrandedScratch({
        accounts: listAccounts(),
        record: costHistory.recordInternal,
        nowMs: Date.now(),
      });
      if (r.settled) log.info('settled stranded internal transcripts', { settled: r.settled });
      if (r.failed) log.warn('internal transcripts left unpriced', { failed: r.failed });
    } catch (err) {
      log.warn('internal transcript settle failed', { error: String(err) });
    }
  };

  const warm = deps.warmSessionMetadata;
  if (warm) {
    timers.push(
      setTimeout(() => {
        if (!owned()) return;
        const started = Date.now();
        warm()
          .then((r) => { log.info('session metadata warm-up', { files: r.files, ms: Date.now() - started }); })
          .catch((err: unknown) => { log.warn('session metadata warm-up failed', { error: String(err) }); });
      }, TEN_SECONDS),
    );
  }

  timers.push(
    setTimeout(() => {
      if (!owned()) return;
      settleScratch();
      // Inside the chain so a synchronous throw is logged, not uncaught in a timer.
      Promise.resolve()
        .then(() => costHistory.backfill(listAccounts()))
        .then((r) => { log.info('cost-history startup backfill', { sessionsScanned: r.sessionsScanned }); })
        .catch((err: unknown) => { log.warn('cost-history startup backfill failed', { error: String(err) }); });
    }, THIRTY_SECONDS),
  );

  timers.push(
    setInterval(() => {
      if (!owned()) return;
      settleScratch();
      Promise.resolve()
        .then(() => costHistory.backfill(listAccounts()))
        .catch((err: unknown) => { log.warn('cost-history sweep failed', { error: String(err) }); });
    }, ONE_HOUR),
  );

  // Without this SQLite's freelist only grows. Also run soon after start: most runs never reach an hour.
  const reclaim = (): void => {
    if (!owned()) return;
    try {
      db.reclaimFreePages();
    } catch (err) {
      log.warn('free-page reclaim failed', { error: String(err) });
    }
  };
  timers.push(setTimeout(reclaim, THIRTY_SECONDS));
  timers.push(setInterval(reclaim, ONE_HOUR));

  // Close is not the only drain trigger: a stalled drain has nothing else to restart it.
  timers.push(
    setInterval(() => {
      if (!owned()) return;
      void (async () => {
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
            if (!brain()?.vaultPath(account.id)) continue;
            try {
              if (autoIndexOn) await brain()?.backfill(account.id, { sinceMs });
              if (curateOn) brain()?.enqueueCuration(account.id);
            } catch (err) {
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

  const summarySweep = createSummarySweep({
    listConfigDirs: () => listAccounts().map((a) => a.config_dir),
    activeSessionIds: deps.activeSessionIds,
    summary: deps.summary,
    log,
  });
  timers.push(
    setInterval(() => {
      if (!owned()) return;
      if (db.getSetting(ENABLED_SETTING_KEY) !== 'true') return;
      if (db.getSetting(AUTO_ON_CLOSE_SETTING_KEY) !== 'true') return;
      summarySweep.tick().catch((err: unknown) => {
        log.warn('summary sweep failed', { error: String(err) });
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
