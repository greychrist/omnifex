import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  appendInflightDelta,
  clearInflightBuffer,
  FLUSH_INTERVAL_MS,
  __resetCoalescerForTests,
} from '../inflightCoalescer';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';

// The coalescer schedules on a wall-clock timer rather than an animation
// frame, so time is faked and stepped explicitly. Vitest's fake timers also
// fake `Date`, which is what the throttle measures against.
beforeEach(() => {
  vi.useFakeTimers();
  useClaudeSessionStore.getState().__resetForTests();
  __resetCoalescerForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Run the pending flush without advancing past the throttle window. */
function settle() {
  vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
}

function slotText(tabId: string): string | undefined {
  return useClaudeSessionStore.getState().selectTab(tabId).inflightAssistant?.text;
}

describe('inflightCoalescer', () => {
  it('accumulates text for the same uuid across multiple appends, flushed once', () => {
    appendInflightDelta('t1', 'msg-1', 'Hel', null);
    appendInflightDelta('t1', 'msg-1', 'lo ', null);
    appendInflightDelta('t1', 'msg-1', 'world', null);
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant).toBeNull();
    settle();
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant).toEqual({
      uuid: 'msg-1',
      text: 'Hello world',
      parentToolUseId: null,
    });
  });

  it('keeps accumulating text even when each delta arrives with a fresh uuid', () => {
    // The CLI emits a unique uuid per stream_event message (one per delta) —
    // not a single uuid shared across the whole assistant turn. So the
    // coalescer must NOT reset its buffer on uuid change; the only way to
    // end a turn is an explicit clearInflightBuffer() call from the IPC
    // subscriber's reconciliation path.
    appendInflightDelta('t1', 'evt-1', 'Hel', null);
    appendInflightDelta('t1', 'evt-2', 'lo ', null);
    appendInflightDelta('t1', 'evt-3', 'world', null);
    settle();
    const slot = useClaudeSessionStore.getState().selectTab('t1').inflightAssistant;
    expect(slot?.text).toBe('Hello world');
    // The recorded uuid is the most-recent event's; it's informational only.
    expect(slot?.uuid).toBe('evt-3');
    expect(slot?.parentToolUseId).toBeNull();
  });

  it('clearInflightBuffer is the only way to start a fresh accumulation', () => {
    appendInflightDelta('t1', 'evt-1', 'first turn', null);
    settle();
    clearInflightBuffer('t1');
    appendInflightDelta('t1', 'evt-2', 'second turn', null);
    settle();
    expect(slotText('t1')).toBe('second turn');
  });

  it('schedules exactly one timer for many appends in the same window', () => {
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    appendInflightDelta('t1', 'msg-1', 'a', null);
    appendInflightDelta('t1', 'msg-1', 'b', null);
    appendInflightDelta('t1', 'msg-1', 'c', null);
    expect(timerSpy).toHaveBeenCalledTimes(1);
  });

  it('flushes both tabs independently in a single flush', () => {
    appendInflightDelta('tab-A', 'uuid-A', 'A text', null);
    appendInflightDelta('tab-B', 'uuid-B', 'B text', 'parent-x');
    settle();
    const state = useClaudeSessionStore.getState();
    expect(state.selectTab('tab-A').inflightAssistant).toEqual({
      uuid: 'uuid-A',
      text: 'A text',
      parentToolUseId: null,
    });
    expect(state.selectTab('tab-B').inflightAssistant).toEqual({
      uuid: 'uuid-B',
      text: 'B text',
      parentToolUseId: 'parent-x',
    });
  });

  it('clearInflightBuffer drops the buffer entry without flushing the slot', () => {
    appendInflightDelta('t1', 'msg-1', 'lost', null);
    clearInflightBuffer('t1');
    settle();
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant).toBeNull();
  });

  it('flush with empty buffers map is a no-op', () => {
    // Trigger a flush schedule, then clear before it fires.
    appendInflightDelta('t1', 'msg-1', 'temp', null);
    clearInflightBuffer('t1');
    // No store state should have been written.
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant).toBeNull();
    // Timer is still pending — when it fires, no state should change.
    settle();
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant).toBeNull();
  });

  it('preserves the parentToolUseId from the first delta across the turn', () => {
    // Each stream_event has a fresh uuid (per CLI), so accumulation crosses
    // uuids. parentToolUseId is stable within a turn: first value wins.
    appendInflightDelta('t1', 'evt-1', 'first', 'parent-tu-id');
    appendInflightDelta('t1', 'evt-2', '-second', 'parent-tu-id');
    settle();
    const slot = useClaudeSessionStore.getState().selectTab('t1').inflightAssistant;
    expect(slot?.text).toBe('first-second');
    expect(slot?.parentToolUseId).toBe('parent-tu-id');
  });

  // ---- throttle behaviour -------------------------------------------------

  it('renders the first delta of an idle turn without waiting out the interval', () => {
    // Latency guard: the throttle must not delay the first visible token.
    // After an idle gap the buffer flushes on the next tick, not a full
    // FLUSH_INTERVAL_MS later.
    appendInflightDelta('t1', 'evt-1', 'first token', null);
    vi.advanceTimersByTime(0);
    expect(slotText('t1')).toBe('first token');
  });

  it('does not write the store again until FLUSH_INTERVAL_MS has elapsed', () => {
    appendInflightDelta('t1', 'evt-1', 'a', null);
    vi.advanceTimersByTime(0);
    expect(slotText('t1')).toBe('a');

    // Deltas landing inside the window accumulate but stay unrendered.
    appendInflightDelta('t1', 'evt-2', 'b', null);
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS - 1);
    expect(slotText('t1')).toBe('a');

    // Crossing the boundary publishes everything buffered so far, at once.
    vi.advanceTimersByTime(1);
    expect(slotText('t1')).toBe('ab');
  });

  it('collapses a 60fps delta storm into one store write per interval', () => {
    // This is the whole point of the throttle: the in-flight bubble re-parses
    // its entire accumulated text through ReactMarkdown on every store write,
    // so writes — not deltas — are what cost CPU. One second of frame-rate
    // deltas must produce ~1000/FLUSH_INTERVAL_MS writes, not 60.
    const writes: string[] = [];
    const unsubscribe = useClaudeSessionStore.subscribe((state) => {
      const text = state.selectTab('t1').inflightAssistant?.text;
      if (text !== undefined && writes[writes.length - 1] !== text) writes.push(text);
    });

    for (let i = 0; i < 60; i++) {
      appendInflightDelta('t1', `evt-${String(i)}`, 'x', null);
      vi.advanceTimersByTime(1000 / 60);
    }
    // Drain the flush still pending from the tail of the storm.
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    unsubscribe();

    const maxWrites = Math.ceil(1000 / FLUSH_INTERVAL_MS) + 1;
    expect(writes.length).toBeLessThanOrEqual(maxWrites);
    // No text is lost — the final write holds every delta.
    expect(writes[writes.length - 1]).toBe('x'.repeat(60));
  });
});
