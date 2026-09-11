import { describe, it, expect } from 'vitest';
import {
  EMPTY_SIGNAL_STATE,
  MAX_EVENTS,
  actionsForAnchor,
  attentionQueue,
  dismissAction,
  emit,
  eventsForAnchor,
  markAnchorRead,
  reconcile,
  resolve,
  snoozeTokensFor,
  snooze,
  stateSignal,
  unreadCount,
} from '../store';
import type { SessionSignal, SignalKind, SignalPriority } from '../types';

const TAB = 'tab-1';

function signal(over: Partial<SessionSignal> & { key: string; kind: SignalKind }): SessionSignal {
  return {
    id: over.id ?? over.key,
    tabId: TAB,
    anchor: 'session',
    priority: 'normal',
    title: over.key,
    at: 1000,
    ...over,
  };
}

describe('signal store — state routing', () => {
  it('replaces a state signal emitted under the same key', () => {
    let s = emit(EMPTY_SIGNAL_STATE, signal({ kind: 'state', key: 'session.activity', title: 'thinking' }));
    s = emit(s, signal({ kind: 'state', key: 'session.activity', title: 'idle', at: 2000 }));

    expect(stateSignal(s, 'session.activity')?.title).toBe('idle');
    expect(Object.keys(s.states)).toHaveLength(1);
  });

  it('keeps state signals out of the event log and the attention queue', () => {
    const s = emit(EMPTY_SIGNAL_STATE, signal({ kind: 'state', key: 'session.activity' }));

    expect(eventsForAnchor(s, 'session')).toHaveLength(0);
    expect(attentionQueue(s)).toHaveLength(0);
  });
});

describe('signal store — event routing', () => {
  it('appends events newest-first and counts them as unread', () => {
    let s = emit(EMPTY_SIGNAL_STATE, signal({ kind: 'event', key: 'context.delta', id: 'p1', at: 1000 }));
    s = emit(s, signal({ kind: 'event', key: 'context.delta', id: 'p2', at: 2000 }));

    expect(eventsForAnchor(s, 'session').map((e) => e.id)).toEqual(['p2', 'p1']);
    expect(unreadCount(s, 'session')).toBe(2);
  });

  it('de-dupes a re-emitted event by id, not by key', () => {
    // Signals are derived from the message stream every render: the same jump
    // arrives over and over and must land as one row.
    let s = emit(EMPTY_SIGNAL_STATE, signal({ kind: 'event', key: 'context.delta', id: 'p1' }));
    s = emit(s, signal({ kind: 'event', key: 'context.delta', id: 'p1', title: 'updated' }));

    const events = eventsForAnchor(s, 'session');
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('updated');
  });

  it('does not resurrect an already-read event when it is re-emitted', () => {
    let s = emit(EMPTY_SIGNAL_STATE, signal({ kind: 'event', key: 'context.delta', id: 'p1' }));
    s = markAnchorRead(s, 'session');
    s = emit(s, signal({ kind: 'event', key: 'context.delta', id: 'p1' }));

    expect(unreadCount(s, 'session')).toBe(0);
  });

  it('clears unread only for the anchor that was read', () => {
    let s = emit(EMPTY_SIGNAL_STATE, signal({ kind: 'event', key: 'context.delta', id: 'p1' }));
    s = emit(s, signal({ kind: 'event', key: 'mcp.skipped', id: 'm1', anchor: 'mcp' }));
    s = markAnchorRead(s, 'session');

    expect(unreadCount(s, 'session')).toBe(0);
    expect(unreadCount(s, 'mcp')).toBe(1);
  });

  it('caps the event log so a long session cannot grow it without bound', () => {
    let s = EMPTY_SIGNAL_STATE;
    for (let i = 0; i < MAX_EVENTS + 10; i += 1) {
      s = emit(s, signal({ kind: 'event', key: 'context.delta', id: `p${i}`, at: 1000 + i }));
    }

    expect(s.events).toHaveLength(MAX_EVENTS);
    // The oldest are the ones dropped.
    expect(s.events[s.events.length - 1].id).toBe('p10');
  });

  it('limits what an anchor returns for the popover', () => {
    let s = EMPTY_SIGNAL_STATE;
    for (let i = 0; i < 30; i += 1) {
      s = emit(s, signal({ kind: 'event', key: 'context.delta', id: `p${i}`, at: 1000 + i }));
    }

    expect(eventsForAnchor(s, 'session', 20)).toHaveLength(20);
  });
});

describe('signal store — action routing', () => {
  const action = (key: string, priority: SignalPriority, at: number) =>
    signal({ kind: 'action', key, priority, at, actions: [{ id: 'a', label: 'Do it', run: () => {} }] });

  it('replaces rather than duplicates an action re-emitted under the same key', () => {
    let s = emit(EMPTY_SIGNAL_STATE, action('context.boundary', 'high', 1000));
    s = emit(s, signal({ kind: 'action', key: 'context.boundary', priority: 'high', at: 2000, title: 'newer' }));

    const queue = attentionQueue(s);
    expect(queue).toHaveLength(1);
    expect(queue[0].title).toBe('newer');
  });

  it('orders the queue by priority, then oldest first within a priority', () => {
    let s = emit(EMPTY_SIGNAL_STATE, action('b', 'normal', 1000));
    s = emit(s, action('c', 'high', 3000));
    s = emit(s, action('a', 'high', 2000));
    s = emit(s, action('d', 'low', 500));

    // Oldest-first inside a band: an unresolved item must not be buried by a
    // newer one of equal urgency.
    expect(attentionQueue(s).map((x) => x.key)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('mirrors actions into the anchored widget even after they are dismissed', () => {
    let s = emit(EMPTY_SIGNAL_STATE, action('context.boundary', 'high', 1000));
    s = dismissAction(s, 'context.boundary');

    expect(attentionQueue(s)).toHaveLength(0);
    expect(actionsForAnchor(s, 'session')).toHaveLength(1);
  });

  it('keeps a dismissed action dismissed when derivation re-emits it', () => {
    // The boundary condition still holds on the next render, so the same key
    // arrives again. Waving it off once must not become waving it off forever
    // only to have it reappear a frame later.
    let s = emit(EMPTY_SIGNAL_STATE, action('context.boundary', 'high', 1000));
    s = dismissAction(s, 'context.boundary');
    s = emit(s, action('context.boundary', 'high', 2000));

    expect(attentionQueue(s)).toHaveLength(0);
  });

  it('re-arms a dismissed action once it has been resolved', () => {
    let s = emit(EMPTY_SIGNAL_STATE, action('context.boundary', 'high', 1000));
    s = dismissAction(s, 'context.boundary');
    s = resolve(s, 'context.boundary');
    s = emit(s, action('context.boundary', 'high', 3000));

    expect(attentionQueue(s)).toHaveLength(1);
  });

  it('removes an action from both the queue and the widget when resolved', () => {
    let s = emit(EMPTY_SIGNAL_STATE, action('context.boundary', 'high', 1000));
    s = resolve(s, 'context.boundary');

    expect(attentionQueue(s)).toHaveLength(0);
    expect(actionsForAnchor(s, 'session')).toHaveLength(0);
  });
});

describe('signal store — reconcile', () => {
  it('drops state and action signals that derivation no longer produces', () => {
    let s = emit(EMPTY_SIGNAL_STATE, signal({ kind: 'state', key: 'session.activity' }));
    s = emit(s, signal({ kind: 'action', key: 'context.boundary', priority: 'high' }));

    s = reconcile(s, [signal({ kind: 'state', key: 'session.activity', title: 'idle' })]);

    expect(stateSignal(s, 'session.activity')?.title).toBe('idle');
    expect(attentionQueue(s)).toHaveLength(0);
  });

  it('never drops events — the log is history, not a current value', () => {
    let s = emit(EMPTY_SIGNAL_STATE, signal({ kind: 'event', key: 'context.delta', id: 'p1' }));
    s = reconcile(s, []);

    expect(eventsForAnchor(s, 'session')).toHaveLength(1);
  });

  it('clears the dismissal when the action it belonged to goes away', () => {
    let s = emit(EMPTY_SIGNAL_STATE, signal({ kind: 'action', key: 'context.boundary', priority: 'high' }));
    s = dismissAction(s, 'context.boundary');
    s = reconcile(s, []);
    s = reconcile(s, [signal({ kind: 'action', key: 'context.boundary', priority: 'high', at: 5000 })]);

    expect(attentionQueue(s)).toHaveLength(1);
  });

  it('returns the same object when nothing changed, so React can bail out', () => {
    const derived = [signal({ kind: 'state', key: 'session.activity' })];
    const s = reconcile(EMPTY_SIGNAL_STATE, derived);

    expect(reconcile(s, derived)).toBe(s);
  });
});

describe('signal store — snooze', () => {
  it('raises the boundary by the snooze amount and clears the pending action', () => {
    let s = emit(EMPTY_SIGNAL_STATE, signal({ kind: 'action', key: 'context.boundary', priority: 'high' }));
    s = snooze(s, 'context.boundary', 20_000);

    expect(snoozeTokensFor(s, 'context.boundary')).toBe(20_000);
    expect(attentionQueue(s)).toHaveLength(0);
  });

  it('accumulates repeated snoozes rather than resetting the offset', () => {
    let s = snooze(EMPTY_SIGNAL_STATE, 'context.boundary', 20_000);
    s = snooze(s, 'context.boundary', 20_000);

    expect(snoozeTokensFor(s, 'context.boundary')).toBe(40_000);
  });

  it('re-arms: an action emitted after a snooze reaches the queue again', () => {
    // The offset lives in the store, but it is the *emitter* that applies it.
    // Once the raised threshold is crossed the action is a fresh one and must
    // not be suppressed by the snooze that preceded it.
    let s = emit(EMPTY_SIGNAL_STATE, signal({ kind: 'action', key: 'context.boundary', priority: 'high' }));
    s = snooze(s, 'context.boundary', 20_000);
    s = emit(s, signal({ kind: 'action', key: 'context.boundary', priority: 'high', at: 9000 }));

    expect(attentionQueue(s)).toHaveLength(1);
  });

  it('reports zero for a key that has never been snoozed', () => {
    expect(snoozeTokensFor(EMPTY_SIGNAL_STATE, 'context.boundary')).toBe(0);
  });
});
