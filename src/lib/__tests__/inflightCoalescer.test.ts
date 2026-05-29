import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  appendInflightDelta,
  clearInflightBuffer,
  __resetCoalescerForTests,
} from '../inflightCoalescer';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';

// RAF stubbing — capture the most recently scheduled callback so tests can
// step the frame deterministically.
let pendingFrame: FrameRequestCallback | null = null;
let nextHandle = 1;

beforeEach(() => {
  pendingFrame = null;
  nextHandle = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    pendingFrame = cb;
    return nextHandle++;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    pendingFrame = null;
  });
  useClaudeSessionStore.getState().__resetForTests();
  __resetCoalescerForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function tickFrame() {
  const cb = pendingFrame;
  pendingFrame = null;
  cb?.(performance.now());
}

describe('inflightCoalescer', () => {
  it('accumulates text for the same uuid across multiple appends, flushed once per frame', () => {
    appendInflightDelta('t1', 'msg-1', 'Hel', null);
    appendInflightDelta('t1', 'msg-1', 'lo ', null);
    appendInflightDelta('t1', 'msg-1', 'world', null);
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant).toBeNull();
    tickFrame();
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
    tickFrame();
    const slot = useClaudeSessionStore.getState().selectTab('t1').inflightAssistant;
    expect(slot?.text).toBe('Hello world');
    // The recorded uuid is the most-recent event's; it's informational only.
    expect(slot?.uuid).toBe('evt-3');
    expect(slot?.parentToolUseId).toBeNull();
  });

  it('clearInflightBuffer is the only way to start a fresh accumulation', () => {
    appendInflightDelta('t1', 'evt-1', 'first turn', null);
    tickFrame();
    clearInflightBuffer('t1');
    appendInflightDelta('t1', 'evt-2', 'second turn', null);
    tickFrame();
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant?.text)
      .toBe('second turn');
  });

  it('schedules exactly one frame for many same-frame appends', () => {
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');
    appendInflightDelta('t1', 'msg-1', 'a', null);
    appendInflightDelta('t1', 'msg-1', 'b', null);
    appendInflightDelta('t1', 'msg-1', 'c', null);
    expect(rafSpy).toHaveBeenCalledTimes(1);
  });

  it('flushes both tabs independently in a single frame', () => {
    appendInflightDelta('tab-A', 'uuid-A', 'A text', null);
    appendInflightDelta('tab-B', 'uuid-B', 'B text', 'parent-x');
    tickFrame();
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
    tickFrame();
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant).toBeNull();
  });

  it('flush with empty buffers map is a no-op', () => {
    // Trigger a flush schedule, then clear before it fires.
    appendInflightDelta('t1', 'msg-1', 'temp', null);
    clearInflightBuffer('t1');
    // No store state should have been written.
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant).toBeNull();
    // Frame is still pending — when it fires, no state should change.
    tickFrame();
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant).toBeNull();
  });

  it('preserves the parentToolUseId from the first delta across the turn', () => {
    // Each stream_event has a fresh uuid (per CLI), so accumulation crosses
    // uuids. parentToolUseId is stable within a turn: first value wins.
    appendInflightDelta('t1', 'evt-1', 'first', 'parent-tu-id');
    appendInflightDelta('t1', 'evt-2', '-second', 'parent-tu-id');
    tickFrame();
    const slot = useClaudeSessionStore.getState().selectTab('t1').inflightAssistant;
    expect(slot?.text).toBe('first-second');
    expect(slot?.parentToolUseId).toBe('parent-tu-id');
  });
});
