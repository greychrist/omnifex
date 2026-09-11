/**
 * Everything that happens because a session closed: the auto-summary, the
 * Brain's enqueues, and the drain behind them.
 *
 * One module, two composition roots — the same arrangement, and the same
 * reasons, as `periodic-work.ts`. `electron/main.ts` and
 * `electron/remote/daemon.ts` each carried a hand-copied version of this block.
 * They had not drifted semantically, but they had been re-typed (one hoisted a
 * local the other inlined, one kept the rationale comments and the other
 * dropped every one of them), which is what makes the next fix to one of them
 * miss the other.
 *
 * The drain at the end is why this matters beyond tidiness. `periodic-work.ts`
 * gates its drain on whether this process owns the work; this path did not, so
 * it was the remaining way to put a second worker on a queue that two
 * processes share through one SQLite file. `enabled` there, `drainEnabled`
 * here, and for the same reason: the gate is a convention until every call
 * site is made to ask.
 */

import {
  BRAIN_AUTO_INDEX_SETTING_KEY,
  BRAIN_CURATE_SETTING_KEY,
} from './services/brain/queue';
import { AUTO_ON_CLOSE_SETTING_KEY, ENABLED_SETTING_KEY } from './services/sessions-summary';

/** Only the Brain surface a close touches. */
interface BrainLike {
  enqueueSource(accountId: number, itemKey: string): unknown;
  enqueueProjectSources(accountId: number, projectPath: string): unknown;
  enqueueCuration(accountId: number): unknown;
  drainQueue(): Promise<unknown>;
}

interface SummaryLike {
  generateSummary(sessionId: string, projectPath: string, configDir: string): Promise<unknown>;
}

export interface SessionCloseWorkDeps {
  db: { getSetting(key: string): string | null | undefined };
  /**
   * Ownership comes from the config dir the session ran under, never from
   * `resolve()` (spec §4). Still correct if path rules changed after the
   * session ran, and it never invents a default account.
   */
  accounts: { getAccountByConfigDir(configDir: string): { id: number } | null | undefined };
  /**
   * Read per close, not captured: both roots assign these refs after the
   * service graph is built, and a session can close before either resolves.
   */
  brain: () => BrainLike | null | undefined;
  summary: () => SummaryLike | null | undefined;
  warn: (message: string, meta: Record<string, unknown>) => void;
  /**
   * Whether this process owns the queue drain right now. Omitted means
   * "always" — that is the daemon. Evaluated per close, never sampled at
   * construction, because main does not learn whether a daemon answered until
   * the renderer asks for `remote:url`.
   *
   * Only the drain is gated. The enqueues are idempotent and near-free, and
   * the queue is durable, so the process that does own the drain picks the
   * work up on its next pass.
   */
  drainEnabled?: () => boolean;
}

export type SessionCloseHandler = (
  sessionId: string,
  projectPath: string,
  configDir: string,
) => void;

export function createSessionCloseWork(deps: SessionCloseWorkDeps): SessionCloseHandler {
  const drainEnabled = deps.drainEnabled ?? (() => true);

  return (sessionId, projectPath, configDir) => {
    // Auto-on-close summarization. Two global toggles gate this path:
    //   - sessionsSummary.enabled (master) — off means summaries are not used
    //     at all, so no point generating one.
    //   - sessionsSummary.autoOnClose — off means the user wants to hit the
    //     manual refresh button themselves.
    // The manual path doesn't come through here; it hits `summary_generate`
    // directly, so autoOnClose has no effect on it. Read fresh on every close
    // so a flip in Settings takes effect without a restart.
    //
    // Fire-and-forget so teardown isn't blocked by model latency; the
    // size-change gate inside the service makes "close without changes" a
    // no-op. `configDir` comes from the live SessionHandle, so the JSONL
    // lookup is anchored to the exact account that ran the session.
    const summaryOn = deps.db.getSetting(ENABLED_SETTING_KEY) === 'true';
    const autoOnClose = deps.db.getSetting(AUTO_ON_CLOSE_SETTING_KEY) === 'true';
    // A branch, never an early return. Returning here silently disabled Brain
    // indexing for everyone who had summaries turned off — both consumers
    // share this one callback, because the sessions service takes a single
    // `onSessionClosed`.
    if (summaryOn && autoOnClose) {
      deps
        .summary()
        ?.generateSummary(sessionId, projectPath, configDir)
        .catch((err: unknown) => {
          deps.warn('auto-summarize on close failed', { error: String(err) });
        });
    }

    // Brain work on close. Both switches are OFF by default — the user opts in
    // once, after seeing real output. Read fresh on every close, matching the
    // summary gate above.
    const autoIndexOn = deps.db.getSetting(BRAIN_AUTO_INDEX_SETTING_KEY) === 'true';
    const curateOn = deps.db.getSetting(BRAIN_CURATE_SETTING_KEY) === 'true';
    // Armed by EITHER switch. Gating on auto-index alone would leave
    // curation-only users queueing notes that nothing ever drained.
    if (!autoIndexOn && !curateOn) return;

    const account = deps.accounts.getAccountByConfigDir(configDir);
    if (!account) return;

    // Fire-and-forget: session teardown must never wait on Brain work.
    Promise.resolve()
      .then(() => (autoIndexOn ? deps.brain()?.enqueueSource(account.id, sessionId) : undefined))
      // The session just closed in this project, which is exactly when its
      // auto-memory notes and instruction files were most likely edited — the
      // memory tool writes during a session, and a CLAUDE.md is edited in one.
      // Change detection makes the ordinary case a free no-op, so this costs a
      // directory walk and nothing else.
      .then(() =>
        autoIndexOn ? deps.brain()?.enqueueProjectSources(account.id, projectPath) : undefined,
      )
      .then(() => {
        // Selected from the vault as it stands NOW, so a note pushed over the
        // threshold by the indexing queued just above is picked up on the NEXT
        // close rather than this one. A one-session lag against a 7-day
        // cooldown, and it self-corrects; selecting after the drain would mean
        // draining twice on every close.
        if (curateOn) deps.brain()?.enqueueCuration(account.id);
      })
      .then(() => (drainEnabled() ? deps.brain()?.drainQueue() : undefined))
      .catch((err: unknown) => {
        deps.warn('brain work on close failed', { error: String(err) });
      });
  };
}
