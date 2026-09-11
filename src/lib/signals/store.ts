/**
 * The routing rules, in one place.
 *
 * Pure and immutable: every operation returns a new `SignalState` (or the same
 * one, when nothing changed, so `useSyncExternalStore`/`useMemo` can bail out).
 * Nothing here touches React, the DOM, or IPC — which is what makes
 * replace-by-key, priority ordering and snooze re-arm testable as arithmetic.
 *
 * The single most important property: signals are **derived from the message
 * stream on every render**, not pushed once. `emit` is therefore idempotent —
 * re-emitting the same thing must not duplicate a row, resurrect a read event,
 * or un-dismiss an action.
 */

import {
  PRIORITY_RANK,
  type SessionSignal,
  type SignalAction,
  type SignalAnchor,
} from './types';

/**
 * How many events are retained per tab.
 *
 * The popover shows 20; the surplus is headroom so scrolling back a little is
 * possible and so a burst of events cannot evict the whole log. Unbounded
 * growth is not an option — a long session emits one of these per turn.
 */
export const MAX_EVENTS = 100;

/** What the session-widget popover shows without scrolling. */
export const POPOVER_EVENT_LIMIT = 20;

export interface SignalState {
  /** `state` signals by key. */
  states: Record<string, SessionSignal>;
  /** `event` signals, newest first, capped at MAX_EVENTS. */
  events: SessionSignal[];
  /** `action` signals by key, in emission order. */
  actions: SessionSignal[];
  /** Action keys waved off the attention slot; still shown in the popover. */
  dismissedKeys: string[];
  /** Per-key threshold offsets from Snooze. Applied by the emitter, not here. */
  snoozeTokens: Record<string, number>;
}

export const EMPTY_SIGNAL_STATE: SignalState = {
  states: {},
  events: [],
  actions: [],
  dismissedKeys: [],
  snoozeTokens: {},
};

/**
 * Route one signal by its kind.
 *
 * `state` replaces by key, `action` replaces by key, `event` de-dupes by **id**
 * and is otherwise appended. The id/key split matters: one key (`context.delta`)
 * produces many events, each identified by the prompt that caused it, so keying
 * the log would collapse the history to a single row.
 */
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
    // `read` is the store's, not the emitter's. A derived event re-arriving
    // after the popover was opened would otherwise light the badge forever.
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

/**
 * Apply a full derived set: emit everything in it, and drop any `state` or
 * `action` whose key it no longer contains.
 *
 * This is how a derivation-driven store retracts. A boundary action lives
 * exactly as long as the condition that produced it, with no "clear" call to
 * forget — the same self-clearing property `evaluateContextPressure` was
 * deliberately written to have.
 *
 * Events are never dropped: the log is history.
 */
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

/**
 * The condition is over: forget the signal and any dismissal attached to it.
 *
 * Clearing the dismissal here is what makes the whole model re-arm. A boundary
 * waved off at 250k, then dropped by `/compact`, must warn again at 250k — and
 * it does, because resolving removed the key that was suppressing it.
 */
export function resolve(state: SignalState, key: string): SignalState {
  return removeAction(removeState(state, key), key);
}

function removeState(state: SignalState, key: string): SignalState {
  if (!(key in state.states)) return state;
  const states = { ...state.states };
  delete states[key];
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

/** Wave an action off the attention slot. It stays in the anchor's popover. */
export function dismissAction(state: SignalState, key: string): SignalState {
  if (state.dismissedKeys.includes(key)) return state;
  return { ...state, dismissedKeys: [...state.dismissedKeys, key] };
}

/**
 * Raise a threshold for this tab and stand the action down.
 *
 * Additive, not absolute: snoozing twice buys 40k, not 20k again. The offset is
 * stored but *applied by the emitter* — the store has no idea what a token is,
 * and the action that comes back once the raised threshold is crossed is a new
 * one, not a suppressed one, which is exactly what "re-arms" means.
 */
export function snooze(state: SignalState, key: string, tokens: number): SignalState {
  const raised = { ...state.snoozeTokens, [key]: (state.snoozeTokens[key] ?? 0) + tokens };
  return removeAction({ ...state, snoozeTokens: raised }, key);
}

export function snoozeTokensFor(state: SignalState, key: string): number {
  return state.snoozeTokens[key] ?? 0;
}

/** Mark every event on an anchor read. Called when its popover opens. */
export function markAnchorRead(state: SignalState, anchor: SignalAnchor): SignalState {
  if (!state.events.some((e) => e.anchor === anchor && !e.read)) return state;
  return {
    ...state,
    events: state.events.map((e) => (e.anchor === anchor && !e.read ? { ...e, read: true } : e)),
  };
}

/**
 * The attention queue: undismissed actions, highest priority first, then
 * oldest first inside a band so an unresolved item is never buried by a newer
 * one of equal urgency.
 */
export function attentionQueue(state: SignalState): SessionSignal[] {
  return state.actions
    .filter((a) => !state.dismissedKeys.includes(a.key))
    .slice()
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.at - b.at);
}

/** Every action on an anchor, dismissed or not — this feeds the popover. */
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

/**
 * Value equality for the fields a re-derivation can change.
 *
 * `actions[].run` is a fresh closure every render and is deliberately excluded:
 * comparing it would make every signal look changed, defeating the identity
 * bail-out that keeps a 3,000-line session component from re-rendering on every
 * tick. The labels and ids *are* compared, so a genuinely different action set
 * still registers.
 */
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
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => x.id === b[i].id && x.label === b[i].label && x.primary === b[i].primary);
}

function sameMeta(a?: Record<string, unknown>, b?: Record<string, unknown>): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.is(a[k], b[k]));
}
