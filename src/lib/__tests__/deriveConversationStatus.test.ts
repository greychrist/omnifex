import { describe, it, expect } from 'vitest';
import {
  deriveConversationStatus,
  deriveWaitingOnClaude,
  isLastMessageExecutionComplete,
} from '../deriveConversationStatus';
import type { ClaudeStreamMessage } from '@/types/claudeStream';

function result(): ClaudeStreamMessage {
  return { type: 'result', subtype: 'success' } as unknown as ClaudeStreamMessage;
}
function resultError(): ClaudeStreamMessage {
  return { type: 'result', subtype: 'error_during_execution', is_error: true } as unknown as ClaudeStreamMessage;
}
function user(text: string): ClaudeStreamMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as unknown as ClaudeStreamMessage;
}
function assistant(): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  } as unknown as ClaudeStreamMessage;
}
function systemHook(
  subtype: 'hook_started' | 'hook_progress' | 'hook_response' | 'user_prompt_submit',
): ClaudeStreamMessage {
  return { type: 'system', subtype } as unknown as ClaudeStreamMessage;
}
function systemInit(): ClaudeStreamMessage {
  return { type: 'system', subtype: 'init' } as unknown as ClaudeStreamMessage;
}
function streamEvent(): ClaudeStreamMessage {
  return { type: 'stream_event' } as unknown as ClaudeStreamMessage;
}

const allSettled = {
  hasIncompleteTasks: false,
  hasIncompleteSubagents: false,
};

describe('isLastMessageExecutionComplete', () => {
  it('returns true for an empty transcript', () => {
    expect(isLastMessageExecutionComplete([])).toBe(true);
  });

  it("returns true when the last message is a 'result' (success)", () => {
    expect(isLastMessageExecutionComplete([user('hi'), assistant(), result()])).toBe(true);
  });

  it("returns true when the last message is a 'result' (error)", () => {
    expect(isLastMessageExecutionComplete([user('hi'), resultError()])).toBe(true);
  });

  it('returns false when the last message is anything but a result', () => {
    expect(isLastMessageExecutionComplete([user('hi')])).toBe(false);
    expect(isLastMessageExecutionComplete([user('hi'), assistant()])).toBe(false);
  });

  // SessionStart hooks fire system events (hook_started / hook_progress /
  // hook_response) BEFORE any user turn. The transcript ending in a plumbing
  // event is NOT proof Claude is waiting on us — there's nothing in flight.
  // Same logic applies to system:init (anchors the session, doesn't open a turn)
  // and stream_event (per-token delta; the parent assistant message carries
  // the conversational signal).
  it('ignores plumbing events when finding the last execution-complete marker', () => {
    // Fresh session: only init + hook events, no real turn yet → complete.
    expect(
      isLastMessageExecutionComplete([
        systemInit(),
        systemHook('hook_started'),
        systemHook('hook_progress'),
        systemHook('hook_response'),
      ]),
    ).toBe(true);
    // Plumbing trailing a result is still complete.
    expect(
      isLastMessageExecutionComplete([
        user('hi'),
        assistant(),
        result(),
        systemHook('hook_started'),
        systemHook('hook_response'),
      ]),
    ).toBe(true);
    // Stream-event deltas are plumbing too.
    expect(
      isLastMessageExecutionComplete([
        user('hi'),
        assistant(),
        result(),
        streamEvent(),
      ]),
    ).toBe(true);
    // BUT plumbing that comes AFTER a real user turn with no result is
    // still "waiting on Claude" — the user prompt is the last real message.
    expect(
      isLastMessageExecutionComplete([
        user('hi'),
        systemHook('hook_started'),
      ]),
    ).toBe(false);
  });
});

describe('deriveWaitingOnClaude', () => {
  it('returns false on an empty transcript', () => {
    expect(deriveWaitingOnClaude([])).toBe(false);
  });

  it("returns false when the transcript ends in 'result'", () => {
    expect(deriveWaitingOnClaude([user('hi'), assistant(), result()])).toBe(false);
  });

  it("returns true when the transcript ends in anything else", () => {
    expect(deriveWaitingOnClaude([user('hi')])).toBe(true);
    expect(deriveWaitingOnClaude([user('hi'), assistant()])).toBe(true);
  });
});

describe('deriveConversationStatus', () => {
  it('returns null when sessionStatus is not started', () => {
    expect(deriveConversationStatus({ sessionStatus: 'stopped', messages: [], ...allSettled })).toBeNull();
    expect(deriveConversationStatus({ sessionStatus: 'starting', messages: [], ...allSettled })).toBeNull();
    expect(deriveConversationStatus({ sessionStatus: 'error', messages: [], ...allSettled })).toBeNull();
  });

  it("returns 'idle' for a fresh started session with no messages", () => {
    expect(
      deriveConversationStatus({ sessionStatus: 'started', messages: [], ...allSettled }),
    ).toBe('idle');
  });

  it("returns 'running' when the last message is not a result (waiting on Claude)", () => {
    expect(
      deriveConversationStatus({
        sessionStatus: 'started',
        messages: [user('hi')],
        ...allSettled,
      }),
    ).toBe('running');
  });

  it("returns 'idle' when the last message IS a result and nothing else is pending", () => {
    expect(
      deriveConversationStatus({
        sessionStatus: 'started',
        messages: [user('hi'), assistant(), result()],
        ...allSettled,
      }),
    ).toBe('idle');
    // Error-terminal results also count as complete.
    expect(
      deriveConversationStatus({
        sessionStatus: 'started',
        messages: [user('hi'), resultError()],
        ...allSettled,
      }),
    ).toBe('idle');
  });

  it("returns 'running' when a task is incomplete (even with a completed last turn)", () => {
    expect(
      deriveConversationStatus({
        sessionStatus: 'started',
        messages: [result()],
        ...allSettled,
        hasIncompleteTasks: true,
      }),
    ).toBe('running');
  });

  it("returns 'running' when a subagent is incomplete (even with a completed last turn)", () => {
    expect(
      deriveConversationStatus({
        sessionStatus: 'started',
        messages: [result()],
        ...allSettled,
        hasIncompleteSubagents: true,
      }),
    ).toBe('running');
  });

  // Regression: opening a session with SessionStart hooks configured emits
  // hook_started / hook_progress / hook_response system events before any
  // user turn. The derivation must treat that as 'idle', not 'running'.
  // Otherwise the inspector pins Prompt status to WORKING, the in-flight
  // rollup fires, and the spinner sticks even after the user navigates
  // away from the session.
  it("returns 'idle' for a fresh session whose only messages are SessionStart hook events", () => {
    expect(
      deriveConversationStatus({
        sessionStatus: 'started',
        messages: [
          systemInit(),
          systemHook('hook_started'),
          systemHook('hook_progress'),
          systemHook('hook_response'),
        ],
        ...allSettled,
      }),
    ).toBe('idle');
  });
});
