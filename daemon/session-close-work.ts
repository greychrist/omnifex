// The drain is gated (`drainEnabled`) like periodic-work: a second worker on a shared DB pays twice.

import {
  BRAIN_AUTO_INDEX_SETTING_KEY,
  BRAIN_CURATE_SETTING_KEY,
} from './services/brain/queue';
import { AUTO_ON_CLOSE_SETTING_KEY, ENABLED_SETTING_KEY } from './services/sessions-summary';

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
  /** Ownership comes from the session's config dir, never `resolve()`. */
  accounts: { getAccountByConfigDir(configDir: string): { id: number } | null | undefined };
  /** Read per close, not captured: assigned after the service graph is built. */
  brain: () => BrainLike | null | undefined;
  summary: () => SummaryLike | null | undefined;
  warn: (message: string, meta: Record<string, unknown>) => void;
  /** Only the drain is gated: enqueues are idempotent and the queue is durable. */
  drainEnabled?: () => boolean;
}

export type SessionCloseHandler = (
  sessionId: string,
  projectPath: string,
  configDir: string,
  reason?: 'closed' | 'shutdown',
) => void;

export function createSessionCloseWork(deps: SessionCloseWorkDeps): SessionCloseHandler {
  const drainEnabled = deps.drainEnabled ?? (() => true);

  return (sessionId, projectPath, configDir, reason = 'closed') => {
    const summaryOn = deps.db.getSetting(ENABLED_SETTING_KEY) === 'true';
    const autoOnClose = deps.db.getSetting(AUTO_ON_CLOSE_SETTING_KEY) === 'true';
    // A branch, never an early return: Brain work shares this callback.
    // Never on shutdown: the exit kills the summary's `claude -p`; the summary sweep catches up.
    if (summaryOn && autoOnClose && reason !== 'shutdown') {
      deps
        .summary()
        ?.generateSummary(sessionId, projectPath, configDir)
        .catch((err: unknown) => {
          deps.warn('auto-summarize on close failed', { error: String(err) });
        });
    }

    const autoIndexOn = deps.db.getSetting(BRAIN_AUTO_INDEX_SETTING_KEY) === 'true';
    const curateOn = deps.db.getSetting(BRAIN_CURATE_SETTING_KEY) === 'true';
    // Either switch arms it, or curation-only users queue notes nothing drains.
    if (!autoIndexOn && !curateOn) return;

    const account = deps.accounts.getAccountByConfigDir(configDir);
    if (!account) return;

    // Fire-and-forget: teardown must never wait on Brain work.
    Promise.resolve()
      .then(() => (autoIndexOn ? deps.brain()?.enqueueSource(account.id, sessionId) : undefined))
      .then(() =>
        autoIndexOn ? deps.brain()?.enqueueProjectSources(account.id, projectPath) : undefined,
      )
      .then(() => {
        if (curateOn) deps.brain()?.enqueueCuration(account.id);
      })
      .then(() => (drainEnabled() ? deps.brain()?.drainQueue() : undefined))
      .catch((err: unknown) => {
        deps.warn('brain work on close failed', { error: String(err) });
      });
  };
}
