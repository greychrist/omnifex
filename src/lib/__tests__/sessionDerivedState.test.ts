import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import {
  waitingOnClaude,
  hasOpenTasks,
  hasOpenSubagents,
  conversationStatus,
  turnDuration,
  sessionStartedAt,
  lastPermissionMode,
} from '../sessionDerivedState';

// Minimal helpers — these build JsonlNodes with the fields the derivation reads.
function userPrompt(timestamp: string, sessionId = 's1'): JsonlNode {
  return {
    kind: 'user',
    userKind: 'prompt',
    sessionId,
    receivedAt: timestamp,
    // `as never` because AssistantRaw / UserRaw don't declare `isSidechain` and
    // the helpers add fields the union types don't model — see Task notes.
    raw: {
      type: 'user',
      message: { role: 'user', content: 'hi' },
      sessionId,
      timestamp,
    } as never,
  };
}

function assistantWithStop(
  timestamp: string,
  stop_reason: string | null,
  opts: { isSidechain?: boolean; sessionId?: string } = {},
): JsonlNode {
  const sessionId = opts.sessionId ?? 's1';
  return {
    kind: 'assistant',
    sessionId,
    receivedAt: timestamp,
    // `as never` because AssistantRaw / UserRaw don't declare `isSidechain` and
    // the helpers add fields the union types don't model — see Task notes.
    raw: {
      type: 'assistant',
      message: { role: 'assistant', content: [], stop_reason },
      isSidechain: opts.isSidechain ?? false,
      sessionId,
      timestamp,
    } as never,
  };
}

describe('waitingOnClaude', () => {
  it('returns false for an empty message list', () => {
    expect(waitingOnClaude([])).toBe(false);
  });

  it('returns true when the only message is a user prompt', () => {
    expect(waitingOnClaude([userPrompt('2026-05-27T00:00:00Z')])).toBe(true);
  });

  it('returns false after assistant with terminal stop_reason', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', 'end_turn'),
    ];
    expect(waitingOnClaude(msgs)).toBe(false);
  });

  it('returns true when the last assistant has stop_reason: null (stuck turn)', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', null),
    ];
    expect(waitingOnClaude(msgs)).toBe(true);
  });

  it('treats max_tokens, stop_sequence, refusal, model_context_window_exceeded as terminal', () => {
    for (const stop of ['stop_sequence', 'max_tokens', 'refusal', 'model_context_window_exceeded']) {
      const msgs = [
        userPrompt('2026-05-27T00:00:00Z'),
        assistantWithStop('2026-05-27T00:00:01Z', stop),
      ];
      expect(waitingOnClaude(msgs), `stop=${stop}`).toBe(false);
    }
  });

  it('ignores isSidechain assistants when looking for the last assistant', () => {
    // Sidechain assistant streams without terminal stop; main assistant terminated cleanly.
    // Status must be 'not waiting' because the main turn ended.
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', 'end_turn'),
      assistantWithStop('2026-05-27T00:00:02Z', null, { isSidechain: true }),
    ];
    expect(waitingOnClaude(msgs)).toBe(false);
  });

  it('multiple sequential terminal-stop assistants resolve to not waiting', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', 'end_turn'),
      assistantWithStop('2026-05-27T00:00:02Z', 'end_turn'),
    ];
    expect(waitingOnClaude(msgs)).toBe(false);
  });

  it('returns false when messages contain only non-prompt user nodes', () => {
    // No user.prompt and no assistant — nothing to wait on.
    const msgs: JsonlNode[] = [
      {
        kind: 'user',
        userKind: 'tool-result',
        sessionId: 's1',
        receivedAt: '2026-05-27T00:00:00Z',
        raw: {
          type: 'user',
          message: { role: 'user', content: [] },
          sessionId: 's1',
          timestamp: '2026-05-27T00:00:00Z',
        } as never,
      },
    ];
    expect(waitingOnClaude(msgs)).toBe(false);
  });
});

describe('hasOpenTasks / hasOpenSubagents', () => {
  it('returns false for empty arrays', () => {
    expect(hasOpenTasks([])).toBe(false);
    expect(hasOpenSubagents([])).toBe(false);
  });

  it('returns true only when a task is in_progress (pending does NOT count)', () => {
    expect(hasOpenTasks([{ status: 'completed' }, { status: 'in_progress' }] as never)).toBe(true);
    expect(hasOpenTasks([{ status: 'completed' }, { status: 'pending' }] as never)).toBe(false);
    expect(hasOpenTasks([{ status: 'completed' }, { status: 'completed' }] as never)).toBe(false);
  });

  it('returns true only when a subagent is running (failed/abandoned do NOT count)', () => {
    expect(hasOpenSubagents([{ status: 'completed' }, { status: 'running' }] as never)).toBe(true);
    expect(hasOpenSubagents([{ status: 'completed' }, { status: 'failed' }] as never)).toBe(false);
    expect(hasOpenSubagents([{ status: 'completed' }, { status: 'abandoned' }] as never)).toBe(false);
    expect(hasOpenSubagents([{ status: 'completed' }, { status: 'completed_inferred' }] as never)).toBe(false);
    expect(hasOpenSubagents([{ status: 'completed' }] as never)).toBe(false);
  });
});

describe('conversationStatus', () => {
  it('idle when nothing is pending', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', 'end_turn'),
    ];
    expect(conversationStatus(msgs, [], [])).toBe('idle');
  });

  it('running when waiting on Claude', () => {
    const msgs = [userPrompt('2026-05-27T00:00:00Z')];
    expect(conversationStatus(msgs, [], [])).toBe('running');
  });

  it('running when an open subagent exists even if assistant terminated', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', 'end_turn'),
    ];
    expect(conversationStatus(msgs, [], [{ status: 'running' }] as never)).toBe('running');
  });

  it('running when an in_progress task exists even if assistant terminated', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', 'end_turn'),
    ];
    expect(conversationStatus(msgs, [{ status: 'in_progress' }] as never, [])).toBe('running');
  });

  it('idle when only pending tasks exist (a closed session with planned-but-unstarted todos)', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', 'end_turn'),
    ];
    expect(conversationStatus(msgs, [{ status: 'pending' }, { status: 'completed' }] as never, [])).toBe('idle');
  });
});

describe('turnDuration', () => {
  it('returns ms between user.prompt and the assistant at the given index', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00.000Z'),
      assistantWithStop('2026-05-27T00:00:02.500Z', 'end_turn'),
    ];
    expect(turnDuration(msgs, 1)).toBe(2500);
  });

  it('returns null when the assistant has no preceding user prompt in the array', () => {
    const msgs = [assistantWithStop('2026-05-27T00:00:01Z', 'end_turn')];
    expect(turnDuration(msgs, 0)).toBeNull();
  });

  it('returns null when the index does not point at an assistant', () => {
    const msgs = [userPrompt('2026-05-27T00:00:00Z')];
    expect(turnDuration(msgs, 0)).toBeNull();
  });

  it('returns null when the user prompt has an unparseable timestamp', () => {
    const msgs: JsonlNode[] = [
      {
        kind: 'user',
        userKind: 'prompt',
        sessionId: 's1',
        receivedAt: 'not-a-date',
        raw: {
          type: 'user',
          message: { role: 'user', content: 'hi' },
          sessionId: 's1',
          timestamp: 'not-a-date',
        } as never,
      },
      assistantWithStop('2026-05-27T00:00:01Z', 'end_turn'),
    ];
    expect(turnDuration(msgs, 1)).toBeNull();
  });
});

describe('cli-stream kinds do not affect derivation', () => {
  it('does not treat cli-stream-result as a turn ender', () => {
    const msgs: JsonlNode[] = [
      userPrompt('2026-05-27T00:00:00Z'),
      {
        kind: 'cli-stream-result',
        sessionId: 's1',
        receivedAt: '2026-05-27T00:00:01Z',
        raw: { type: 'result', subtype: 'success' } as never,
      },
    ];
    expect(waitingOnClaude(msgs)).toBe(true); // still waiting — no real assistant arrived
  });

  it('does not treat cli-stream-init as a turn start', () => {
    const msgs: JsonlNode[] = [
      {
        kind: 'cli-stream-init',
        sessionId: 's1',
        receivedAt: '2026-05-27T00:00:00Z',
        raw: { type: 'system', subtype: 'init' } as never,
      },
    ];
    expect(waitingOnClaude(msgs)).toBe(false); // no user prompt — not waiting
  });
});

describe('lastPermissionMode', () => {
  function permModeNode(mode: string): JsonlNode {
    return { kind: 'permission-mode', sessionId: 's1', raw: { type: 'permission-mode', permissionMode: mode } as never };
  }
  function userPromptWithMode(timestamp: string, mode: string): JsonlNode {
    return {
      kind: 'user',
      userKind: 'prompt',
      sessionId: 's1',
      receivedAt: timestamp,
      raw: { type: 'user', message: { role: 'user', content: 'hi' }, permissionMode: mode, timestamp } as never,
    };
  }

  it('returns null when no message carries a permission mode', () => {
    expect(lastPermissionMode([userPrompt('2026-05-28T00:00:00Z')])).toBeNull();
    expect(lastPermissionMode([])).toBeNull();
  });

  it('returns the mode from a permission-mode record', () => {
    expect(lastPermissionMode([permModeNode('auto')])).toBe('auto');
  });

  it('returns the mode from a user envelope', () => {
    expect(lastPermissionMode([userPromptWithMode('2026-05-28T00:00:00Z', 'plan')])).toBe('plan');
  });

  it('returns the LAST mode when several appear (walks from the end)', () => {
    const msgs = [
      permModeNode('acceptEdits'),
      userPromptWithMode('2026-05-28T00:00:01Z', 'plan'),
      permModeNode('auto'),
    ];
    expect(lastPermissionMode(msgs)).toBe('auto');
  });
});

describe('sessionStartedAt', () => {
  it('returns null for empty messages', () => {
    expect(sessionStartedAt([])).toBeNull();
  });

  it('returns the raw.timestamp of the first message', () => {
    const msgs = [userPrompt('2026-05-27T00:00:00Z')];
    expect(sessionStartedAt(msgs)).toBe('2026-05-27T00:00:00Z');
  });

  it('falls back to raw.timestamp for variants without receivedAt', () => {
    const msgs: JsonlNode[] = [
      {
        kind: 'last-prompt',
        sessionId: 's1',
        raw: {
          type: 'last-prompt',
          lastPrompt: 'hi',
          leafUuid: 'u',
          timestamp: '2026-05-27T01:00:00Z',
        } as never,
      },
    ];
    expect(sessionStartedAt(msgs)).toBe('2026-05-27T01:00:00Z');
  });
});
