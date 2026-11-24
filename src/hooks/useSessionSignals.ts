// `handlers` is held in a ref, not a dependency: AgentSession rebuilds it every render, and the turn
// derivation is O(messages). `reconcile` returns the same object when nothing changed so setState bails.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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

export type SessionSignalsInput = Omit<SignalInput, 'boundarySnoozeTokens' | 'handlers'> & {
  handlers: SignalHandlers;
};

export interface SessionSignals {
  state: SignalState;
  /** Highest-priority first. */
  queue: SessionSignal[];
  unreadFor: (anchor: SignalAnchor) => number;
  eventsFor: (anchor: SignalAnchor, limit?: number) => SessionSignal[];
  actionsFor: (anchor: SignalAnchor) => SessionSignal[];
  stateFor: (key: string) => SessionSignal | undefined;
  markRead: (anchor: SignalAnchor) => void;
  dismiss: (key: string) => void;
  snoozeBoundary: () => void;
}

export const BOUNDARY_KEY = 'context.boundary';

export function useSessionSignals(input: SessionSignalsInput): SessionSignals {
  const [state, setState] = useState<SignalState>(EMPTY_SIGNAL_STATE);

  const handlersRef = useRef(input.handlers);
  useLayoutEffect(() => { handlersRef.current = input.handlers; });

  const snoozeBoundary = useCallback(() => {
    setState((s) => snooze(s, BOUNDARY_KEY, BOUNDARY_SNOOZE_TOKENS));
  }, []);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `input` is rebuilt every render; listing it would recompute every render
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
