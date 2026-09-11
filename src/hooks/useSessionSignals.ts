/**
 * One signal store per tab, fed by pure derivation over the session's own state.
 *
 * Two things here are load-bearing for performance, both of them consequences
 * of this repo's default failure mode ("one click re-rendered every session in
 * the app", see the root CLAUDE.md):
 *
 * 1. `handlers` is captured in a ref, not a dependency. AgentSession rebuilds
 *    those closures on every render; depending on them would re-derive the
 *    whole turn series — an O(messages) walk — on every keystroke.
 * 2. `reconcile` returns the *same* state object when nothing changed, so the
 *    `setState` below bails out of the re-render rather than scheduling one.
 *
 * Signals are per tab and die with it: this hook's state unmounts with the tab,
 * which is the whole of "cleared on tab close".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deriveSessionSignals,
  BOUNDARY_SNOOZE_TOKENS,
  type SignalHandlers,
  type SignalInput,
} from '@/lib/signals/emitters';
import {
  EMPTY_SIGNAL_STATE,
  actionsForAnchor,
  attentionQueue,
  dismissAction,
  eventsForAnchor,
  markAnchorRead,
  reconcile,
  snooze,
  snoozeTokensFor,
  stateSignal,
  unreadCount,
  type SignalState,
} from '@/lib/signals/store';
import type { SessionSignal, SignalAnchor } from '@/lib/signals/types';

/** Everything the caller supplies; handlers are held by ref, hence the split. */
export type SessionSignalsInput = Omit<SignalInput, 'boundarySnoozeTokens' | 'handlers'> & {
  handlers: SignalHandlers;
};

export interface SessionSignals {
  state: SignalState;
  /** Highest-priority first. The attention slot renders index 0. */
  queue: SessionSignal[];
  unreadFor: (anchor: SignalAnchor) => number;
  eventsFor: (anchor: SignalAnchor, limit?: number) => SessionSignal[];
  actionsFor: (anchor: SignalAnchor) => SessionSignal[];
  stateFor: (key: string) => SessionSignal | undefined;
  /** Clears the anchor's unread badge. Call when its popover opens. */
  markRead: (anchor: SignalAnchor) => void;
  /** Drops an item from the slot; it stays in the anchored popover. */
  dismiss: (key: string) => void;
  /** Raises the context budget by 20k for this tab only, and re-arms. */
  snoozeBoundary: () => void;
}

export const BOUNDARY_KEY = 'context.boundary';

export function useSessionSignals(input: SessionSignalsInput): SessionSignals {
  const [state, setState] = useState<SignalState>(EMPTY_SIGNAL_STATE);

  const handlersRef = useRef(input.handlers);
  handlersRef.current = input.handlers;

  const snoozeBoundary = useCallback(() => {
    setState((s) => snooze(s, BOUNDARY_KEY, BOUNDARY_SNOOZE_TOKENS));
  }, []);

  // Stable indirection so a re-created handler bag never invalidates the memo
  // below. The bag's *identity* changes constantly; what it does does not.
  const handlers = useMemo<SignalHandlers>(
    () => ({
      onCompact: () => handlersRef.current.onCompact(),
      onSnoozeBoundary: snoozeBoundary,
      onRaiseContextBudget: (tokens) => handlersRef.current.onRaiseContextBudget(tokens),
      onRestartSession: () => handlersRef.current.onRestartSession(),
    }),
    [snoozeBoundary],
  );

  const boundarySnoozeTokens = snoozeTokensFor(state, BOUNDARY_KEY);

  const derived = useMemo(
    () => deriveSessionSignals({ ...input, boundarySnoozeTokens, handlers }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `input` is a fresh
    // object literal every render; its fields are the real dependencies.
    [
      input.tabId,
      input.messages,
      input.contextTokens,
      input.contextLimit,
      input.pressureSetting,
      input.jumpSetting,
      input.sessionLive,
      input.turnInFlight,
      input.cacheTtlChange,
      input.mcpErrors,
      input.usageLimitResetsAt,
      input.accountMismatch,
      input.accountRestartable,
      boundarySnoozeTokens,
      handlers,
    ],
  );

  useEffect(() => {
    setState((s) => reconcile(s, derived));
  }, [derived]);

  const queue = useMemo(() => attentionQueue(state), [state]);

  return {
    state,
    queue,
    unreadFor: useCallback((anchor) => unreadCount(state, anchor), [state]),
    eventsFor: useCallback((anchor, limit) => eventsForAnchor(state, anchor, limit), [state]),
    actionsFor: useCallback((anchor) => actionsForAnchor(state, anchor), [state]),
    stateFor: useCallback((key) => stateSignal(state, key), [state]),
    markRead: useCallback((anchor) => { setState((s) => markAnchorRead(s, anchor)); }, []),
    dismiss: useCallback((key) => { setState((s) => dismissAction(s, key)); }, []),
    snoozeBoundary,
  };
}
