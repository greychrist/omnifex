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
  usageLimitWait,
} from '../sessionDerivedState';
import { classifyJsonlLine } from '../jsonlClassifier';

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

// The summary the CLI writes after /compact. Built through the real
// classifier so the userKind under test is the one production computes.
function compactSummary(timestamp: string, sessionId = 's1'): JsonlNode {
  return classifyJsonlLine({
    type: 'user',
    sessionId,
    timestamp,
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    message: { role: 'user', content: 'Session continued…' },
  }) as JsonlNode;
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

  // A /compact summary is a `user` record. It used to classify as 'prompt',
  // which meant a resumed transcript whose history begins at the compaction
  // had a "prompt" nothing would ever answer — a spinner with no turn behind
  // it. The summary is now its own userKind and cannot hold the turn open.
  it('does not treat a lone compact summary as an unanswered prompt', () => {
    expect(waitingOnClaude([compactSummary('2026-05-27T00:00:00Z')])).toBe(false);
  });

  // The inverse: a real prompt that a compaction interrupted is still
  // unanswered, and the summary trailing it must not close the turn either.
  it('still waits when a compaction interrupted an unanswered prompt', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      compactSummary('2026-05-27T00:00:05Z'),
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

describe('forwarded subagent messages (--forward-subagent-text)', () => {
  // Live-forwarded subagent lines are regular user/assistant envelopes with a
  // non-empty top-level `parent_tool_use_id` (verified against CLI 2.1.217;
  // main-chain lines carry null / omit it). They must never decide the main
  // turn axis, name the session model, or anchor turn durations.
  function forwardedAssistant(timestamp: string, stop_reason: string | null, model = 'claude-haiku-4-5-20251001'): JsonlNode {
    return {
      kind: 'assistant',
      sessionId: 's1',
      receivedAt: timestamp,
      raw: {
        type: 'assistant',
        parent_tool_use_id: 'toolu_fwd_1',
        message: { role: 'assistant', content: [], stop_reason, model },
        sessionId: 's1',
        timestamp,
      } as never,
    };
  }

  function forwardedUserPrompt(timestamp: string): JsonlNode {
    return {
      kind: 'user',
      userKind: 'prompt',
      sessionId: 's1',
      receivedAt: timestamp,
      raw: {
        type: 'user',
        parent_tool_use_id: 'toolu_fwd_1',
        message: { role: 'user', content: [{ type: 'text', text: 'subagent prompt' }] },
        sessionId: 's1',
        timestamp,
      } as never,
    };
  }

  it('waitingOnClaude: a forwarded assistant with a terminal stop_reason does not close the parent turn', () => {
    // Parent dispatched a Task and is still waiting; the subagent finished
    // its own message. The turn is still open.
    const msgs = [
      userPrompt('2026-07-22T10:00:00Z'),
      forwardedAssistant('2026-07-22T10:00:10Z', 'end_turn'),
    ];
    expect(waitingOnClaude(msgs)).toBe(true);
  });

  it('waitingOnClaude: a forwarded user prompt after the result does not reopen the turn', () => {
    const msgs = [
      userPrompt('2026-07-22T10:00:00Z'),
      resultNode('2026-07-22T10:00:20Z'),
      forwardedUserPrompt('2026-07-22T10:00:25Z'),
    ];
    expect(waitingOnClaude(msgs)).toBe(false);
  });

  it('lastAssistantModel skips forwarded subagent assistants', () => {
    const mainAssistant: JsonlNode = {
      kind: 'assistant',
      sessionId: 's1',
      receivedAt: '2026-07-22T10:00:00Z',
      raw: {
        type: 'assistant',
        message: { role: 'assistant', content: [], stop_reason: 'end_turn', model: 'claude-fable-5' },
        sessionId: 's1',
        timestamp: '2026-07-22T10:00:00Z',
      } as never,
    };
    const msgs = [
      mainAssistant,
      forwardedAssistant('2026-07-22T10:00:10Z', 'end_turn', 'claude-haiku-4-5-20251001'),
    ];
    expect(lastAssistantModel(msgs)).toBe('claude-fable-5');
  });

  it('turnDuration anchors on the real user prompt, not a forwarded subagent prompt', () => {
    const msgs = [
      userPrompt('2026-07-22T10:00:00Z'),
      forwardedUserPrompt('2026-07-22T10:00:30Z'),
      assistantWithStop('2026-07-22T10:01:00Z', 'end_turn'),
    ];
    expect(turnDuration(msgs, 2)).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// usageLimitWait — Claude Code 2.1.234
// ---------------------------------------------------------------------------
// 2.1.234 added `autoContinueAtUsageLimit` (default ON for claude.ai logins:
// the CLI only defaults it off when an API key is present). A session that
// hits a usage limit no longer ends its turn — it parks and resumes when the
// limit resets, which can be hours. `waitingOnClaude` correctly stays true
// through that (a rate-limit-event is skip-by-default, so the last decisive
// node is still the unsettled assistant/prompt), which means OmniFex spins
// with no explanation. This derivation is what lets the UI say why.
function rateLimitEvent(
  timestamp: string,
  info: Record<string, unknown> | undefined,
): JsonlNode {
  return {
    kind: 'rate-limit-event',
    sessionId: 's1',
    receivedAt: timestamp,
    raw: { type: 'rate_limit_event', rate_limit_info: info, timestamp } as never,
  } as unknown as JsonlNode;
}

describe('usageLimitWait', () => {
  const RESETS_AT = 1_755_500_000; // epoch SECONDS, as the CLI emits it

  it('returns the reset time when the transcript ends on a rejected limit', () => {
    const msgs = [
      userPrompt('2026-08-18T10:00:00Z'),
      assistantWithStop('2026-08-18T10:00:01Z', null),
      rateLimitEvent('2026-08-18T10:00:02Z', { status: 'rejected', resetsAt: RESETS_AT }),
    ];
    expect(usageLimitWait(msgs)).toBe(RESETS_AT);
  });

  it('returns null once the turn resumes after the reset', () => {
    const msgs = [
      userPrompt('2026-08-18T10:00:00Z'),
      rateLimitEvent('2026-08-18T10:00:02Z', { status: 'rejected', resetsAt: RESETS_AT }),
      assistantWithStop('2026-08-18T13:00:00Z', null),
    ];
    expect(usageLimitWait(msgs)).toBeNull();
  });

  it('returns null when the turn finished after the reset', () => {
    const msgs = [
      userPrompt('2026-08-18T10:00:00Z'),
      rateLimitEvent('2026-08-18T10:00:02Z', { status: 'rejected', resetsAt: RESETS_AT }),
      resultNode('2026-08-18T13:00:00Z'),
    ];
    expect(usageLimitWait(msgs)).toBeNull();
  });

  it('returns null when a later rate-limit event reports the limit allowed again', () => {
    const msgs = [
      userPrompt('2026-08-18T10:00:00Z'),
      rateLimitEvent('2026-08-18T10:00:02Z', { status: 'rejected', resetsAt: RESETS_AT }),
      rateLimitEvent('2026-08-18T13:00:00Z', { status: 'allowed' }),
    ];
    expect(usageLimitWait(msgs)).toBeNull();
  });

  it('looks past trailing bookkeeping nodes that carry no turn meaning', () => {
    const msgs = [
      userPrompt('2026-08-18T10:00:00Z'),
      rateLimitEvent('2026-08-18T10:00:02Z', { status: 'rejected', resetsAt: RESETS_AT }),
      systemStatus('2026-08-18T10:00:03Z'),
    ];
    expect(usageLimitWait(msgs)).toBe(RESETS_AT);
  });

  it('returns null for a rejection with no resetsAt', () => {
    // The CLI's own auto-continue predicate requires a finite resetsAt; with
    // none it shows the limit dialog instead of waiting, so there is no wait
    // to report and we must not invent one.
    const msgs = [
      userPrompt('2026-08-18T10:00:00Z'),
      rateLimitEvent('2026-08-18T10:00:02Z', { status: 'rejected' }),
    ];
    expect(usageLimitWait(msgs)).toBeNull();
  });

  it('returns null for a rate-limit event with no info block at all', () => {
    const msgs = [userPrompt('2026-08-18T10:00:00Z'), rateLimitEvent('2026-08-18T10:00:02Z', undefined)];
    expect(usageLimitWait(msgs)).toBeNull();
  });

  it('returns null for an empty transcript', () => {
    expect(usageLimitWait([])).toBeNull();
  });

  it('ignores a rejection from earlier in the session that a later prompt moved past', () => {
    const msgs = [
      userPrompt('2026-08-18T10:00:00Z'),
      rateLimitEvent('2026-08-18T10:00:02Z', { status: 'rejected', resetsAt: RESETS_AT }),
      assistantWithStop('2026-08-18T13:00:00Z', 'end_turn'),
      userPrompt('2026-08-18T14:00:00Z'),
    ];
    expect(usageLimitWait(msgs)).toBeNull();
  });
});
