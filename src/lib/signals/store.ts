/** Pure: returns the same state when nothing changed. Signals are re-derived every render, so `emit` must be idempotent. */

import {
  PRIORITY_RANK,
  type SessionSignal,
  type SignalAction,
  type SignalAnchor,
} from './types';

export const MAX_EVENTS = 100;

export const POPOVER_EVENT_LIMIT = 20;

export interface SignalState {
  states: Record<string, SessionSignal>;
  events: SessionSignal[];
  actions: SessionSignal[];
  dismissedKeys: string[];
  /** Applied by the emitter, not here. */
  snoozeTokens: Record<string, number>;
}

export const EMPTY_SIGNAL_STATE: SignalState = {
  states: {},
  events: [],
  actions: [],
  dismissedKeys: [],
  snoozeTokens: {},
};

/** Events de-dupe by id, not key: one key produces many events. */
export function emit(state: SignalState, signal: SessionSignal): SignalState {
  if (signal.kind === 'state') return emitState(state, signal);
  if (signal.kind === 'event') return emitEvent(state, signal);
  return emitAction(state, signal);
}

function emitState(state: SignalState, signal: SessionSignal): SignalState {
  const existing = state.states[signal.key];
  if (existing && sameSignal(existing, signal)) return state;
  return { ...state, states: { ...state.states, [signal.key]: signal } };
}

function emitEvent(state: SignalState, signal: SessionSignal): SignalState {
  const idx = state.events.findIndex((e) => e.id === signal.id);
  if (idx !== -1) {
    const existing = state.events[idx];
    // `read` belongs to the store: a re-derived event would otherwise light the badge forever.
    const merged = { ...signal, read: existing.read };
    if (sameSignal(existing, merged)) return state;
    const events = state.events.slice();
    events[idx] = merged;
    return { ...state, events };
  }
  const events = [signal, ...state.events];
  return { ...state, events: events.length > MAX_EVENTS ? events.slice(0, MAX_EVENTS) : events };
}

function emitAction(state: SignalState, signal: SessionSignal): SignalState {
  const idx = state.actions.findIndex((a) => a.key === signal.key);
  if (idx === -1) return { ...state, actions: [...state.actions, signal] };
  if (sameSignal(state.actions[idx], signal)) return state;
  const actions = state.actions.slice();
  actions[idx] = signal;
  return { ...state, actions };
}

/** Drops any `state`/`action` whose key is gone, so they retract with their condition. Events are never dropped. */
export function reconcile(state: SignalState, derived: readonly SessionSignal[]): SignalState {
  let next = state;
  for (const signal of derived) next = emit(next, signal);

  const liveStateKeys = new Set(derived.filter((s) => s.kind === 'state').map((s) => s.key));
  const liveActionKeys = new Set(derived.filter((s) => s.kind === 'action').map((s) => s.key));

  const staleStates = Object.keys(next.states).filter((k) => !liveStateKeys.has(k));
  const staleActions = next.actions.filter((a) => !liveActionKeys.has(a.key)).map((a) => a.key);
  if (staleStates.length === 0 && staleActions.length === 0) return next;

  let cleaned = next;
  for (const key of staleStates) cleaned = removeState(cleaned, key);
  for (const key of staleActions) cleaned = removeAction(cleaned, key);
  return cleaned;
}

/** Clearing the dismissal too is what re-arms the signal. */
export function resolve(state: SignalState, key: string): SignalState {
  return removeAction(removeState(state, key), key);
}

function removeState(state: SignalState, key: string): SignalState {
  if (!(key in state.states)) return state;
  const { [key]: _removed, ...states } = state.states;
  return { ...state, states };
}

function removeAction(state: SignalState, key: string): SignalState {
  const actions = state.actions.filter((a) => a.key !== key);
  const dismissedKeys = state.dismissedKeys.filter((k) => k !== key);
  if (actions.length === state.actions.length && dismissedKeys.length === state.dismissedKeys.length) {
    return state;
  }
  return { ...state, actions, dismissedKeys };
}

export function dismissAction(state: SignalState, key: string): SignalState {
  if (state.dismissedKeys.includes(key)) return state;
  return { ...state, dismissedKeys: [...state.dismissedKeys, key] };
}

/** Additive: snoozing twice buys twice the offset. The emitter applies it. */
export function snooze(state: SignalState, key: string, tokens: number): SignalState {
  const raised = { ...state.snoozeTokens, [key]: (state.snoozeTokens[key] ?? 0) + tokens };
  return removeAction({ ...state, snoozeTokens: raised }, key);
}

export function snoozeTokensFor(state: SignalState, key: string): number {
  return state.snoozeTokens[key] ?? 0;
}

export function markAnchorRead(state: SignalState, anchor: SignalAnchor): SignalState {
  if (!state.events.some((e) => e.anchor === anchor && !e.read)) return state;
  return {
    ...state,
    events: state.events.map((e) => (e.anchor === anchor && !e.read ? { ...e, read: true } : e)),
  };
}

export function attentionQueue(state: SignalState): SessionSignal[] {
  return state.actions
    .filter((a) => !state.dismissedKeys.includes(a.key))
    .slice()
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.at - b.at);
}

export function actionsForAnchor(state: SignalState, anchor: SignalAnchor): SessionSignal[] {
  return state.actions.filter((a) => a.anchor === anchor);
}

export function eventsForAnchor(
  state: SignalState,
  anchor: SignalAnchor,
  limit = POPOVER_EVENT_LIMIT,
): SessionSignal[] {
  const matching = state.events.filter((e) => e.anchor === anchor);
  return matching.length > limit ? matching.slice(0, limit) : matching;
}

export function unreadCount(state: SignalState, anchor: SignalAnchor): number {
  return state.events.reduce((n, e) => (e.anchor === anchor && !e.read ? n + 1 : n), 0);
}

export function stateSignal(state: SignalState, key: string): SessionSignal | undefined {
  return state.states[key];
}

/** `actions[].run` is a fresh closure each render and deliberately not compared. */
function sameSignal(a: SessionSignal, b: SessionSignal): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.anchor === b.anchor &&
    a.priority === b.priority &&
    a.key === b.key &&
    a.title === b.title &&
    a.detail === b.detail &&
    a.at === b.at &&
    a.read === b.read &&
    sameActionShape(a.actions, b.actions) &&
    sameMeta(a.meta, b.meta)
  );
}

function sameActionShape(a?: SignalAction[], b?: SignalAction[]): boolean {
  if (a === b) return true;
  if (!a || a.length !== b?.length) return false;
  return a.every((x, i) => x.id === b[i].id && x.label === b[i].label && x.primary === b[i].primary);
}

function sameMeta(a?: Record<string, unknown>, b?: Record<string, unknown>): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.is(a[k], b[k]));
}
