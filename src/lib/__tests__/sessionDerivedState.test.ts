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
  lastAssistantModel,
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

// The CLI `result` envelope classifies to kind:'cli-stream-result' (see
// jsonlClassifier — every `type:'result'` line routes there). It is the
// turn-complete marker and closes `waitingOnClaude` regardless of the
// preceding assistant's stop_reason — load-bearing under
// --include-partial-messages, where the committed assistant carries
// stop_reason:null and the terminal reason rides the message_delta overlay.
function resultNode(timestamp: string): JsonlNode {
  return {
    kind: 'cli-stream-result',
    sessionId: 's1',
    receivedAt: timestamp,
    raw: { type: 'result', subtype: 'success', is_error: false, timestamp } as never,
  } as unknown as JsonlNode;
}

// system.status — plumbing that often trails a completed turn.
function systemStatus(timestamp: string): JsonlNode {
  return {
    kind: 'system',
    subtype: 'status',
    receivedAt: timestamp,
    raw: { type: 'system', subtype: 'status', timestamp } as never,
  } as unknown as JsonlNode;
}

// SessionStart hook / init plumbing that fires before (and around) any turn.
function systemNode(
  subtype: 'init' | 'hook_started' | 'hook_progress' | 'hook_response',
): JsonlNode {
  return {
    kind: 'system',
    subtype,
    receivedAt: '2026-05-27T00:00:00Z',
    raw: { type: 'system', subtype } as never,
  } as unknown as JsonlNode;
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

  // --- result-row terminal signal (--include-partial-messages) -------------
  // Under --include-partial-messages the committed `assistant` message carries
  // stop_reason: null — the terminal reason rides the message_delta
  // stream_event, which never enters messages[]. The CLI's `result` row
  // (kind:'unknown', raw.type:'result') is therefore the authoritative
  // "turn complete" marker for a live-streamed turn.
  it('returns false when a result row follows a null-stop_reason assistant', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', null),
      resultNode('2026-05-27T00:00:02Z'),
    ];
    expect(waitingOnClaude(msgs)).toBe(false);
  });

  it('ignores trailing system.status after a result row', () => {
    // system.status frequently lands AFTER the result row but does not mean
    // the conversation resumed — plumbing must not reopen a closed turn.
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', null),
      resultNode('2026-05-27T00:00:02Z'),
      systemStatus('2026-05-27T00:00:03Z'),
    ];
    expect(waitingOnClaude(msgs)).toBe(false);
  });

  it('ignores trailing rate-limit / lifecycle overlays after a result row', () => {
    const msgs: JsonlNode[] = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', null),
      resultNode('2026-05-27T00:00:02Z'),
      { kind: 'rate-limit' } as unknown as JsonlNode,
    ];
    expect(waitingOnClaude(msgs)).toBe(false);
  });

  it('still waits on a null-stop_reason assistant when no result row has landed', () => {
    // Mid-stream (deltas flowing, no result yet) AND resumed-history rely on
    // this: without a result row the assistant's stop_reason is the only
    // signal, so a non-terminal one keeps the turn open.
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', null),
    ];
    expect(waitingOnClaude(msgs)).toBe(true);
  });

  it('settles resumed history via terminal stop_reason when no result row exists', () => {
    // Persisted JSONL records the real end_turn on the assistant (it has no
    // result row), so loaded transcripts must read as not-waiting.
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', 'end_turn'),
      systemStatus('2026-05-27T00:00:02Z'),
    ];
    expect(waitingOnClaude(msgs)).toBe(false);
  });

  // Ported from the retired deriveConversationStatus module (now that this is
  // the single source of truth for both useSessionLifecycle and
  // usePublishTabStatus). SessionStart hooks emit init + hook events BEFORE any
  // user turn — a transcript of only plumbing must NOT read as waiting, or the
  // spinner/prompt status sticks on a fresh idle session.
  it('does not wait on a fresh session whose only messages are SessionStart hook events', () => {
    const msgs = [
      systemNode('init'),
      systemNode('hook_started'),
      systemNode('hook_progress'),
      systemNode('hook_response'),
    ];
    expect(waitingOnClaude(msgs)).toBe(false);
  });

  it('still waits when a hook event trails an unanswered user prompt', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      systemNode('hook_started'),
    ];
    expect(waitingOnClaude(msgs)).toBe(true);
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

describe('cli-stream envelope derivation', () => {
  it('treats a trailing cli-stream-result as the turn ender', () => {
    const msgs: JsonlNode[] = [
      userPrompt('2026-05-27T00:00:00Z'),
      {
        kind: 'cli-stream-result',
        sessionId: 's1',
        receivedAt: '2026-05-27T00:00:01Z',
        raw: { type: 'result', subtype: 'success' } as never,
      },
    ];
    expect(waitingOnClaude(msgs)).toBe(false); // result envelope closes the turn
  });

  it('closes the turn even when the committed assistant carries stop_reason:null', () => {
    // The real --include-partial-messages shape: the committed assistant frame
    // has stop_reason:null (terminal reason rides the message_delta overlay),
    // and the cli-stream-result row is what actually ends the turn. Without
    // honoring it, the null-stop_reason assistant pins waitingOnClaude true
    // forever. This is the regression that left sessions stuck on "Working".
    const msgs: JsonlNode[] = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', null),
      {
        kind: 'cli-stream-result',
        sessionId: 's1',
        receivedAt: '2026-05-27T00:00:02Z',
        raw: { type: 'result', subtype: 'success' } as never,
      },
    ];
    expect(waitingOnClaude(msgs)).toBe(false);
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

describe('lastAssistantModel', () => {
  function assistantWithModel(
    timestamp: string,
    model: string | undefined,
    opts: { isSidechain?: boolean } = {},
  ): JsonlNode {
    const node = assistantWithStop(timestamp, 'end_turn', opts);
    (node as { raw: { message: { model?: string } } }).raw.message.model = model;
    return node;
  }

  it('returns the model of the most recent main-chain assistant', () => {
    const msgs = [
      assistantWithModel('t1', 'claude-sonnet-4-6'),
      assistantWithModel('t2', 'claude-fable-5'),
    ];
    expect(lastAssistantModel(msgs)).toBe('claude-fable-5');
  });

  it('skips sidechain (subagent) assistants', () => {
    const msgs = [
      assistantWithModel('t1', 'claude-fable-5'),
      assistantWithModel('t2', 'claude-haiku-4-5', { isSidechain: true }),
    ];
    expect(lastAssistantModel(msgs)).toBe('claude-fable-5');
  });

  it('skips synthetic error assistants', () => {
    const msgs = [
      assistantWithModel('t1', 'claude-fable-5'),
      assistantWithModel('t2', '<synthetic>'),
    ];
    expect(lastAssistantModel(msgs)).toBe('claude-fable-5');
  });

  it('returns null when no assistant carries a model', () => {
    expect(lastAssistantModel([])).toBeNull();
    expect(lastAssistantModel([userPrompt('t1'), assistantWithModel('t2', undefined)])).toBeNull();
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
