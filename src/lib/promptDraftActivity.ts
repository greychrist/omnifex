/**
 * The composer's typing hint to the CLI (`prompt_draft_activity`, CLI
 * 2.1.326). The CLI asks for one ping at the first key and about one every
 * 10 seconds while typing goes on; between turns it may use the time to get
 * the next request ready, during a turn it does nothing. It carries no text.
 */
import { api } from './api';

export const DRAFT_ACTIVITY_INTERVAL_MS = 10_000;

export type DraftActivityPinger = (tabId: string) => void;

export function createDraftActivityPinger(
  send: (tabId: string) => unknown,
  now: () => number = Date.now,
): DraftActivityPinger {
  const last = new Map<string, number>();
  return (tabId) => {
    if (!tabId) return;
    const t = now();
    const prev = last.get(tabId);
    if (prev !== undefined && t - prev < DRAFT_ACTIVITY_INTERVAL_MS) return;
    last.set(tabId, t);
    try {
      void Promise.resolve(send(tabId)).catch(() => undefined);
    } catch {
      // A hint: a failed send changes nothing.
    }
  };
}

/** The app-wide pinger, one clock per tab. */
export const pingPromptDraftActivity: DraftActivityPinger = createDraftActivityPinger(
  (tabId) => api.sessionPromptDraftActivity(tabId),
);
