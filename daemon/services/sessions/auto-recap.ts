// Sent by the host: the CLI's own away-summaries fire only on terminal focus loss and never reach the transcript.
// Once per turn: the recap is itself a turn, and its ending must not re-arm.
// The delay measures quiet: the CLI closes a turn seconds after launching a background agent, so every message restarts the countdown.

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

export function readAutoRecapPolicy(getSetting: (key: string) => string | null): AutoRecapPolicy {
  return {
    enabled: autoRecapEnabled(getSetting(AUTO_RECAP_ENABLED_KEY)),
    delayMs: autoRecapMinutes(getSetting(AUTO_RECAP_DELAY_KEY)) * 60_000,
  };
}

export interface AutoRecapDeps {
  policy: () => AutoRecapPolicy;
  canSend: (tabId: string) => boolean;
  send: (tabId: string) => void;
}

export interface AutoRecap {
  onTurn(tabId: string, status: 'idle' | 'running'): void;
  onActivity(tabId: string): void;
  noteUserSend(tabId: string): void;
  forget(tabId: string): void;
}

export function createAutoRecap(deps: AutoRecapDeps): AutoRecap {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const armed = new Set<string>();
  const recapTurns = new Set<string>();

  function clear(tabId: string): void {
    const t = timers.get(tabId);
    if (t !== undefined) clearTimeout(t);
    timers.delete(tabId);
  }

  function countDown(tabId: string): void {
    clear(tabId);
    const policy = deps.policy();
    if (!policy.enabled) {
      armed.delete(tabId);
      return;
    }
    timers.set(tabId, setTimeout(() => fire(tabId), policy.delayMs));
  }

  function fire(tabId: string): void {
    timers.delete(tabId);
    if (!deps.policy().enabled) {
      armed.delete(tabId);
      return;
    }
    if (!deps.canSend(tabId)) return;
    armed.delete(tabId);
    recapTurns.add(tabId);
    deps.send(tabId);
  }

  return {
    onTurn(tabId, status) {
      clear(tabId);
      armed.delete(tabId);
      if (status === 'running') return;
      if (recapTurns.delete(tabId)) return;
      armed.add(tabId);
      countDown(tabId);
    },
    onActivity(tabId) {
      if (armed.has(tabId)) countDown(tabId);
    },
    noteUserSend(tabId) {
      recapTurns.delete(tabId);
    },
    forget(tabId) {
      clear(tabId);
      armed.delete(tabId);
      recapTurns.delete(tabId);
    },
  };
}
