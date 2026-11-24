import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import {
  hasOpenTasks,
  hasOpenSubagents,
  conversationStatus,
  turnDuration,
  sessionStartedAt,
  lastPermissionMode,
  lastAssistantModel,
  lastSessionModel,
  slashModelResult,
  usageLimitWait,
  sessionAuthFailure,
} from '../sessionDerivedState';

function userPrompt(timestamp: string, sessionId = 's1'): JsonlNode {
  return {
    kind: 'user',
    userKind: 'prompt',
    sessionId,
    receivedAt: timestamp,
    // `as never`: the raw union types do not declare `isSidechain`.
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
    // `as never`: the raw union types do not declare `isSidechain`.
    raw: {
      type: 'assistant',
      message: { role: 'assistant', content: [], stop_reason },
      isSidechain: opts.isSidechain ?? false,
      sessionId,
      timestamp,
    } as never,
  };
}

// `result` closes the turn whatever the stop_reason: under
// --include-partial-messages the committed assistant has stop_reason:null.
function resultNode(timestamp: string): JsonlNode {
  return {
    kind: 'cli-stream-result',
    sessionId: 's1',
    receivedAt: timestamp,
    raw: { type: 'result', subtype: 'success', is_error: false, timestamp } as never,
  } as unknown as JsonlNode;
}

function systemStatus(timestamp: string): JsonlNode {
  return {
    kind: 'system',
    subtype: 'status',
    receivedAt: timestamp,
    raw: { type: 'system', subtype: 'status', timestamp } as never,
  } as unknown as JsonlNode;
}

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
    expect(conversationStatus(false, [], [])).toBe('idle');
  });

  it('running when waiting on Claude', () => {
    expect(conversationStatus(true, [], [])).toBe('running');
  });

  it('running when an open subagent exists even if assistant terminated', () => {
    expect(conversationStatus(false, [], [{ status: 'running' }] as never)).toBe('running');
  });

  it('running when an in_progress task exists even if assistant terminated', () => {
    expect(conversationStatus(false, [{ status: 'in_progress' }] as never, [])).toBe('running');
  });

  it('idle when only pending tasks exist (a closed session with planned-but-unstarted todos)', () => {
    expect(conversationStatus(false, [{ status: 'pending' }, { status: 'completed' }] as never, [])).toBe('idle');
  });
});

describe('turnDuration', () => {
  it('returns ms between user.prompt and the assistant at the given index', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00.000Z'),
      assistantWithStop('2026-05-27T00:00:02.500Z', 'end_turn'),
    ];
    expect(turnDuration(msgs, msgs[1])).toBe(2500);
  });

  it('returns null when the assistant has no preceding user prompt in the array', () => {
    const msgs = [assistantWithStop('2026-05-27T00:00:01Z', 'end_turn')];
    expect(turnDuration(msgs, msgs[0])).toBeNull();
  });

  it('returns null for a node that is not an assistant', () => {
    const msgs = [userPrompt('2026-05-27T00:00:00Z')];
    expect(turnDuration(msgs, msgs[0])).toBeNull();
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
    expect(turnDuration(msgs, msgs[1])).toBeNull();
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
  // Forwarded subagent lines carry a non-empty top-level parent_tool_use_id
  // (CLI 2.1.217); main-chain lines carry null or omit it.
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
    expect(turnDuration(msgs, msgs[2])).toBe(60_000);
  });
});

// CLI 2.1.234's `autoContinueAtUsageLimit` (on for claude.ai logins) parks a
// turn at a usage limit until it resets, which can be hours.
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
    // The CLI auto-continues only with a finite resetsAt.
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

// A CLI whose OAuth refresh fails never re-reads the Keychain; only its
// transcript shows it (CLI 2.1.284).
function authFailedAssistant(timestamp: string, uuid: string, text: string): JsonlNode {
  return {
    kind: 'assistant',
    sessionId: 's1',
    receivedAt: timestamp,
    raw: {
      type: 'assistant',
      uuid,
      isSidechain: false,
      error: 'authentication_failed',
      isApiErrorMessage: true,
      message: {
        role: 'assistant',
        model: '<synthetic>',
        stop_reason: 'stop_sequence',
        content: [{ type: 'text', text }],
      },
      timestamp,
    } as never,
  };
}

function localCommand(
  timestamp: string,
  uuid: string,
  stdout: string,
  outcome: 'failed' | 'succeeded',
): JsonlNode {
  return {
    kind: 'system',
    subtype: 'local_command',
    sessionId: 's1',
    receivedAt: timestamp,
    raw: {
      type: 'system',
      subtype: 'local_command',
      uuid,
      content: `<local-command-stdout>${stdout}</local-command-stdout>`,
      commandRun: { command: 'recap', args: '' },
      commandOutcome: { kind: outcome },
      timestamp,
    } as never,
  } as unknown as JsonlNode;
}

function cliInit(timestamp: string): JsonlNode {
  return {
    kind: 'cli-stream-init',
    sessionId: 's1',
    receivedAt: timestamp,
    raw: { type: 'system', subtype: 'init', timestamp } as never,
  } as unknown as JsonlNode;
}

describe('sessionAuthFailure', () => {
  const EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed';

  it('reports an assistant error marked authentication_failed', () => {
    const msgs = [
      userPrompt('2026-09-29T19:43:40Z'),
      authFailedAssistant('2026-09-29T19:43:40.5Z', 'a1', EXPIRED),
    ];
    expect(sessionAuthFailure(msgs)).toEqual({ at: '2026-09-29T19:43:40.5Z', text: EXPIRED });
  });

  // The CLI closes the failed turn with a result that says is_error:false and
  // opens every prompt with a fresh init — neither says anything about auth.
  it('looks past the result and init that bracket the failure', () => {
    const msgs = [
      cliInit('2026-09-29T20:01:21Z'),
      userPrompt('2026-09-29T20:01:21.1Z'),
      authFailedAssistant('2026-09-29T20:01:21.4Z', 'a2', 'Not logged in · Please run /login'),
      resultNode('2026-09-29T20:01:21.5Z'),
    ];
    expect(sessionAuthFailure(msgs)).toEqual({ at: '2026-09-29T20:01:21.4Z', text: 'Not logged in · Please run /login' });
  });

  it('reports a failed local command whose output is the expired-session error', () => {
    const msgs = [localCommand('2026-09-29T19:58:40Z', 'c1', EXPIRED, 'failed')];
    expect(sessionAuthFailure(msgs)).toEqual({ at: '2026-09-29T19:58:40Z', text: EXPIRED });
  });

  it('reports a failed local command whose output is the not-logged-in error', () => {
    const msgs = [localCommand('2026-09-29T19:59:55Z', 'c2', 'Not logged in · Please run /login', 'failed')];
    expect(sessionAuthFailure(msgs)).toEqual({ at: '2026-09-29T19:59:55Z', text: 'Not logged in · Please run /login' });
  });

  it('ignores a failed local command that failed for another reason', () => {
    const msgs = [localCommand('2026-09-29T19:59:55Z', 'c3', 'No conversation to recap', 'failed')];
    expect(sessionAuthFailure(msgs)).toBeNull();
  });

  it('keeps reporting the failure while a new prompt waits for its answer', () => {
    const msgs = [
      authFailedAssistant('2026-09-29T19:43:40Z', 'a1', EXPIRED),
      userPrompt('2026-09-29T19:50:00Z'),
    ];
    expect(sessionAuthFailure(msgs)?.at).toBe('2026-09-29T19:43:40Z');
  });

  it('clears once the model answers again', () => {
    const msgs = [
      authFailedAssistant('2026-09-29T19:43:40Z', 'a1', EXPIRED),
      userPrompt('2026-09-29T20:04:32Z'),
      assistantWithStop('2026-09-29T20:04:52Z', 'end_turn'),
    ];
    expect(sessionAuthFailure(msgs)).toBeNull();
  });

  it('does not let a subagent reply clear the main session failure', () => {
    const msgs = [
      authFailedAssistant('2026-09-29T19:43:40Z', 'a1', EXPIRED),
      assistantWithStop('2026-09-29T19:43:41Z', 'end_turn', { isSidechain: true }),
    ];
    expect(sessionAuthFailure(msgs)?.at).toBe('2026-09-29T19:43:40Z');
  });

  it('returns null for an empty transcript', () => {
    expect(sessionAuthFailure([])).toBeNull();
  });
});

// The CLI answers a typed `/model` with a `user` local-command stdout record
// or a system/local_command record.
describe('slashModelResult', () => {
  const userOut = (text: string, content: 'string' | 'blocks' = 'string'): JsonlNode => ({
    kind: 'user', userKind: 'prompt', sessionId: 's1', receivedAt: 't',
    raw: { type: 'user', uuid: `u-${text.length}`, message: { role: 'user', content: content === 'string' ? text : [{ type: 'text', text }] } } as never,
  });
  const sysOut = (text: string): JsonlNode => ({
    kind: 'system', subtype: 'local_command', sessionId: 's1', receivedAt: 't',
    raw: { type: 'system', subtype: 'local_command', content: text } as never,
  });

  it('reads the concrete id out of "Set model to `alias (id)`"', () => {
    expect(slashModelResult(userOut('<local-command-stdout>Set model to `fable (claude-fable-5-1)`</local-command-stdout>')))
      .toEqual({ model: 'claude-fable-5-1', savedAsDefault: false });
    expect(slashModelResult(userOut('<local-command-stdout>Set model to `opus[1m] (claude-opus-5-5[1m])`</local-command-stdout>', 'blocks')))
      .toEqual({ model: 'claude-opus-5-5[1m]', savedAsDefault: false });
    expect(slashModelResult(sysOut('<local-command-stdout>Set model to `sonnet (claude-sonnet-5-5)`</local-command-stdout>')))
      .toEqual({ model: 'claude-sonnet-5-5', savedAsDefault: false });
  });

  it('takes the token itself when the CLI names no concrete id', () => {
    expect(slashModelResult(userOut('<local-command-stdout>Set model to `claude-opus-4-8`</local-command-stdout>')))
      .toEqual({ model: 'claude-opus-4-8', savedAsDefault: false });
  });

  it('reads "Kept model as" the same way, and notes a save as the default', () => {
    expect(slashModelResult(userOut('<local-command-stdout>Kept model as `fable (claude-fable-5-1)`</local-command-stdout>')))
      .toEqual({ model: 'claude-fable-5-1', savedAsDefault: false });
    expect(slashModelResult(userOut('<local-command-stdout>Set model to `fable (claude-fable-5-1)` and saved as your default for new sessions</local-command-stdout>')))
      .toEqual({ model: 'claude-fable-5-1', savedAsDefault: true });
  });

  it('is null for the command echo, other commands and ordinary prompts', () => {
    expect(slashModelResult(userOut('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>fable</command-args>'))).toBeNull();
    expect(slashModelResult(userOut('<local-command-stdout>Your game looks choppy</local-command-stdout>'))).toBeNull();
    expect(slashModelResult(userOut('Set model to `fable (claude-fable-5-1)` please'))).toBeNull();
    expect(slashModelResult(userPrompt('t'))).toBeNull();
  });
});

describe('lastSessionModel', () => {
  function assistantWithModel(timestamp: string, model: string): JsonlNode {
    const node = assistantWithStop(timestamp, 'end_turn');
    (node as { raw: { message: { model?: string } } }).raw.message.model = model;
    return node;
  }
  const slash = (model: string, alias = 'fable'): JsonlNode => ({
    kind: 'user', userKind: 'prompt', sessionId: 's1', receivedAt: 't',
    raw: { type: 'user', uuid: 'u-' + model, message: { role: 'user', content: `<local-command-stdout>Set model to \`${alias} (${model})\`</local-command-stdout>` } } as never,
  });

  it('is the later of the last turn\'s model and the last /model result', () => {
    expect(lastSessionModel([assistantWithModel('t1', 'claude-opus-5-5'), slash('claude-fable-5-1')])).toBe('claude-fable-5-1');
    expect(lastSessionModel([slash('claude-fable-5-1'), assistantWithModel('t2', 'claude-opus-5-5')])).toBe('claude-opus-5-5');
    expect(lastSessionModel([assistantWithModel('t1', 'claude-opus-5-5')])).toBe('claude-opus-5-5');
    expect(lastSessionModel([userPrompt('t')])).toBeNull();
  });
});
