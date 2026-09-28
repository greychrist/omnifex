// Sessions module — automatic recap.
//
// When a turn finishes and nobody answers for a while, send the CLI's own
// `/recap` so whoever comes back to the tab can read where things stand. The
// CLI's automatic away-summaries fire only on terminal focus loss and are
// never written to the transcript, so a stream-json host never sees them;
// `/recap` typed by a host runs (verified 2.1.284) and lands as a
// `system/local_command` row the transcript already renders.
//
// Once per turn: the recap is itself a turn, and its ending arms nothing. A
// prompt the user sends — even one that joins the recap's turn — makes the
// next ending a real one again.
//
// The timer lives here, in main, beside the turn axis it watches: it keeps
// working with no window open and for every client of the daemon.

import {
  AUTO_RECAP_DELAY_KEY,
  AUTO_RECAP_ENABLED_KEY,
  autoRecapEnabled,
  autoRecapMinutes,
} from '../../../src/lib/autoRecapSettings';

export interface AutoRecapPolicy {
  enabled: boolean;
  delayMs: number;
}

/** The stored settings, read fresh on each use. On by default, after 5 minutes. */
export function readAutoRecapPolicy(getSetting: (key: string) => string | null): AutoRecapPolicy {
  return {
    enabled: autoRecapEnabled(getSetting(AUTO_RECAP_ENABLED_KEY)),
    delayMs: autoRecapMinutes(getSetting(AUTO_RECAP_DELAY_KEY)) * 60_000,
  };
}

export interface AutoRecapDeps {
  policy: () => AutoRecapPolicy;
  /** Whether the tab can take a prompt right now: live, idle, a Claude session. */
  canSend: (tabId: string) => boolean;
  /** Deliver `/recap` without counting it as the user's own prompt. */
  send: (tabId: string) => void;
}

export interface AutoRecap {
  onTurn(tabId: string, status: 'idle' | 'running'): void;
  /** A prompt the user sent, as opposed to the recap itself. */
  noteUserSend(tabId: string): void;
  forget(tabId: string): void;
}

export function createAutoRecap(deps: AutoRecapDeps): AutoRecap {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Tabs whose current turn is a recap we sent. */
  const recapTurns = new Set<string>();

  function clear(tabId: string): void {
    const t = timers.get(tabId);
    if (t !== undefined) clearTimeout(t);
    timers.delete(tabId);
  }

  function fire(tabId: string): void {
    timers.delete(tabId);
    if (!deps.policy().enabled || !deps.canSend(tabId)) return;
    recapTurns.add(tabId);
    deps.send(tabId);
  }

  return {
    onTurn(tabId, status) {
      clear(tabId);
      if (status === 'running') return;
      if (recapTurns.delete(tabId)) return;
      const policy = deps.policy();
      if (!policy.enabled) return;
      timers.set(tabId, setTimeout(() => fire(tabId), policy.delayMs));
    },
    noteUserSend(tabId) {
      recapTurns.delete(tabId);
    },
    forget(tabId) {
      clear(tabId);
      recapTurns.delete(tabId);
    },
  };
}
