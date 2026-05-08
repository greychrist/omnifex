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

  it('resets the buffer when a new uuid arrives for the same tab', () => {
    appendInflightDelta('t1', 'msg-1', 'old', null);
    tickFrame();
    appendInflightDelta('t1', 'msg-2', 'new', null);
    tickFrame();
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant).toEqual({
      uuid: 'msg-2',
      text: 'new',
      parentToolUseId: null,
    });
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

  it('preserves parentToolUseId across appends to the same uuid', () => {
    appendInflightDelta('t1', 'msg-1', 'first', 'parent-tu-id');
    appendInflightDelta('t1', 'msg-1', '-second', 'parent-tu-id');
    tickFrame();
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant).toEqual({
      uuid: 'msg-1',
      text: 'first-second',
      parentToolUseId: 'parent-tu-id',
    });
  });
});
