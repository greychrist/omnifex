import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ClaudeStreamMessage } from '@/types/claudeStream';
import {
  deriveSubagents,
  clearCompleted,
  isTaskLifecycleMarker,
  hasRunningSubagent,
  colorIndexFor,
  SUBAGENT_PALETTE_SIZE,
} from '../subagentStreams';

const TOOL_USE_ID = 'toolu_TEST_1';
const TOOL_USE_ID_2 = 'toolu_TEST_2';

function agentToolUse(
  id: string,
  description = 'Explore repo',
  subagentType = 'Explore',
  runInBackground = false,
): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Agent',
          input: {
            description,
            subagent_type: subagentType,
            prompt: 'go',
            ...(runInBackground ? { run_in_background: true } : {}),
          },
        },
      ],
    },
  } as unknown as ClaudeStreamMessage;
}

function taskStarted(toolUseId: string, taskId = 'task_1', description = 'Explore repo'): ClaudeStreamMessage {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    description,
    task_type: 'local_agent',
  } as unknown as ClaudeStreamMessage;
}

function taskProgress(
  toolUseId: string,
  description: string,
  extras: Partial<{ last_tool_name: string; total_tokens: number; tool_uses: number; duration_ms: number }> = {},
): ClaudeStreamMessage {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: 'task_1',
    tool_use_id: toolUseId,
    description,
    last_tool_name: extras.last_tool_name,
    usage: {
      total_tokens: extras.total_tokens ?? 0,
      tool_uses: extras.tool_uses ?? 0,
      duration_ms: extras.duration_ms ?? 0,
    },
  } as unknown as ClaudeStreamMessage;
}

function taskNotification(
  toolUseId: string,
  status: 'completed' | 'failed' = 'completed',
  summary = 'done',
): ClaudeStreamMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task_1',
    tool_use_id: toolUseId,
    status,
    summary,
    usage: { total_tokens: 42060, tool_uses: 29, duration_ms: 37747 },
  } as unknown as ClaudeStreamMessage;
}

function toolResult(
  toolUseId: string,
  isError = false,
  text = 'result text',
): ClaudeStreamMessage {
  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          is_error: isError,
          content: text,
        },
      ],
    },
  } as unknown as ClaudeStreamMessage;
}

describe('isTaskLifecycleMarker', () => {
  it('matches task_started/progress/notification', () => {
    expect(isTaskLifecycleMarker({ type: 'system', subtype: 'task_started' })).toBe(true);
    expect(isTaskLifecycleMarker({ type: 'system', subtype: 'task_progress' })).toBe(true);
    expect(isTaskLifecycleMarker({ type: 'system', subtype: 'task_notification' })).toBe(true);
  });

  it('rejects non-task system messages', () => {
    expect(isTaskLifecycleMarker({ type: 'system', subtype: 'init' })).toBe(false);
    expect(isTaskLifecycleMarker({ type: 'system', subtype: 'hook_started' })).toBe(false);
  });

  it('rejects non-system messages', () => {
    expect(isTaskLifecycleMarker({ type: 'assistant' })).toBe(false);
  });
});

describe('colorIndexFor', () => {
  it('is deterministic for the same id', () => {
    expect(colorIndexFor(TOOL_USE_ID)).toBe(colorIndexFor(TOOL_USE_ID));
  });

  it('returns an index in range', () => {
    const idx = colorIndexFor(TOOL_USE_ID);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(SUBAGENT_PALETTE_SIZE);
  });

  it('typically differs across different ids', () => {
    const ids = ['toolu_a', 'toolu_b', 'toolu_c', 'toolu_d', 'toolu_e', 'toolu_f', 'toolu_g'];
    const colors = new Set(ids.map(colorIndexFor));
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe('deriveSubagents', () => {
  it('returns empty for transcripts with no subagents', () => {
    const msgs: ClaudeStreamMessage[] = [
      { type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } } as any,
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } } as any,
    ];
    expect(deriveSubagents(msgs)).toEqual([]);
  });

  it('creates a running subagent from the parent Agent tool_use alone', () => {
    const subs = deriveSubagents([agentToolUse(TOOL_USE_ID, 'Map session flow', 'Explore')]);
    expect(subs).toHaveLength(1);
    expect(subs[0].toolUseId).toBe(TOOL_USE_ID);
    expect(subs[0].agentType).toBe('Explore');
    expect(subs[0].description).toBe('Map session flow');
    expect(subs[0].status).toBe('running');
    expect(subs[0].latest).toBeNull();
  });

  it('enriches the subagent with task_started metadata', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      taskStarted(TOOL_USE_ID, 'task_abc', 'Explore repo'),
    ]);
    expect(subs[0].taskId).toBe('task_abc');
    expect(subs[0].status).toBe('running');
  });

  it('accumulates progress events and tracks latest', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      taskStarted(TOOL_USE_ID),
      taskProgress(TOOL_USE_ID, 'Finding files', { last_tool_name: 'Glob', tool_uses: 1, duration_ms: 100 }),
      taskProgress(TOOL_USE_ID, 'Reading session lifecycle', { last_tool_name: 'Read', tool_uses: 2, duration_ms: 500 }),
    ]);
    expect(subs[0].events).toHaveLength(2);
    expect(subs[0].latest?.description).toBe('Reading session lifecycle');
    expect(subs[0].latest?.lastToolName).toBe('Read');
    expect(subs[0].latest?.toolUses).toBe(2);
  });

  it('marks completed on task_notification(status=completed)', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      taskStarted(TOOL_USE_ID),
      taskProgress(TOOL_USE_ID, 'working'),
      taskNotification(TOOL_USE_ID, 'completed', 'Finished exploration'),
    ]);
    expect(subs[0].status).toBe('completed');
    expect(subs[0].summary).toBe('Finished exploration');
    expect(subs[0].latest?.totalTokens).toBe(42060);
  });

  it('marks failed on task_notification(status=failed)', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      taskNotification(TOOL_USE_ID, 'failed', 'boom'),
    ]);
    expect(subs[0].status).toBe('failed');
  });

  it('marks completed when only a tool_result arrives (no task_notification)', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      taskStarted(TOOL_USE_ID),
      taskProgress(TOOL_USE_ID, 'half way'),
      toolResult(TOOL_USE_ID),
    ]);
    expect(subs[0].status).toBe('completed');
  });

  it('marks failed when tool_result has is_error=true and no task_notification', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      toolResult(TOOL_USE_ID, true, 'crashed'),
    ]);
    expect(subs[0].status).toBe('failed');
  });

  it('task_notification status wins over tool_result if both are present', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      toolResult(TOOL_USE_ID, true), // would imply failed
      taskNotification(TOOL_USE_ID, 'completed', 'actually fine'),
    ]);
    expect(subs[0].status).toBe('completed');
  });

  it('background dispatch (run_in_background=true) stays running on the synchronous ACK tool_result', () => {
    // The SDK fires an immediate "Async agent launched" tool_result for
    // background dispatches; that's a dispatch ACK, not the actual return
    // value. Status should stay running until task_notification arrives.
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID, 'Audit', 'general-purpose', true),
      toolResult(TOOL_USE_ID, false, 'Async agent launched successfully. agentId: x'),
    ]);
    expect(subs[0].status).toBe('running');
  });

  it('background dispatch flips to completed when task_notification(status=completed) arrives', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID, 'Audit', 'general-purpose', true),
      toolResult(TOOL_USE_ID, false, 'Async agent launched successfully'),
      taskNotification(TOOL_USE_ID, 'completed', 'all good'),
    ]);
    expect(subs[0].status).toBe('completed');
  });

  describe('Bash run_in_background (generalized background detection)', () => {
    function bashBackground(id: string, description = 'Build something'): ClaudeStreamMessage {
      return {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id,
              name: 'Bash',
              input: {
                command: 'docker build ...',
                description,
                run_in_background: true,
              },
            },
          ],
        },
      } as unknown as ClaudeStreamMessage;
    }

    function bashForeground(id: string): ClaudeStreamMessage {
      return {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id,
              name: 'Bash',
              input: { command: 'ls', description: 'list files' },
            },
          ],
        },
      } as unknown as ClaudeStreamMessage;
    }

    it('registers a running subagent from a Bash run_in_background tool_use alone (before task_started fires)', () => {
      const subs = deriveSubagents([bashBackground(TOOL_USE_ID, 'Build DMG')]);
      expect(subs).toHaveLength(1);
      expect(subs[0].toolUseId).toBe(TOOL_USE_ID);
      expect(subs[0].status).toBe('running');
      expect(subs[0].isBackground).toBe(true);
      expect(subs[0].description).toBe('Build DMG');
    });

    it('foreground Bash tool_use does not register a subagent', () => {
      const subs = deriveSubagents([bashForeground(TOOL_USE_ID)]);
      expect(subs).toHaveLength(0);
    });

    it('Bash run_in_background stays running on the synchronous ACK tool_result', () => {
      const subs = deriveSubagents([
        bashBackground(TOOL_USE_ID, 'Build DMG'),
        toolResult(TOOL_USE_ID, false, 'Async agent launched successfully. agentId: x'),
      ]);
      expect(subs[0].status).toBe('running');
    });

    it('Bash run_in_background flips to completed via task_notification', () => {
      const subs = deriveSubagents([
        bashBackground(TOOL_USE_ID, 'Build DMG'),
        toolResult(TOOL_USE_ID, false, 'Async agent launched'),
        taskNotification(TOOL_USE_ID, 'completed', 'build done'),
      ]);
      expect(subs[0].status).toBe('completed');
    });

    it('Bash run_in_background gets marked abandoned by orphan detection (parent moved on without notification)', () => {
      const subs = deriveSubagents([
        bashBackground(TOOL_USE_ID, 'Build DMG'),
        toolResult(TOOL_USE_ID, false, 'Async agent launched'),
        { type: 'result', subtype: 'success', result: 'awaiting' } as any,
        { type: 'user', message: { content: [{ type: 'text', text: 'next' }] } } as any,
      ]);
      expect(subs[0].status).toBe('abandoned');
    });

    it('Bash run_in_background with is_error=true on the ACK still flips to failed', () => {
      const subs = deriveSubagents([
        bashBackground(TOOL_USE_ID, 'Build DMG'),
        toolResult(TOOL_USE_ID, true, 'spawn failed'),
      ]);
      expect(subs[0].status).toBe('failed');
    });
  });

  it('background dispatch with is_error=true on the ACK still flips to failed (dispatch itself errored)', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID, 'Audit', 'general-purpose', true),
      toolResult(TOOL_USE_ID, true, 'spawn failed'),
    ]);
    expect(subs[0].status).toBe('failed');
  });

  it('background dispatch becomes "abandoned" when a result fires and the parent moves on without task_notification', () => {
    // Loaded session: turn dispatched a background agent, the result event
    // closed the turn, and then either a new user message or another turn
    // happened — proving the parent moved on without the notification.
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID, 'Verify', 'general-purpose', true),
      toolResult(TOOL_USE_ID, false, 'Async agent launched successfully'),
      { type: 'result', subtype: 'success', result: 'awaiting' } as any,
      { type: 'user', message: { content: [{ type: 'text', text: 'next prompt' }] } } as any,
    ]);
    expect(subs[0].status).toBe('abandoned');
  });

  it('background dispatch stays running while the result event is the latest message (live awaiting)', () => {
    // Live session paused at the awaiting state — no messages after the result
    // yet. We must not mark these as abandoned; the wake-up may still arrive.
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID, 'Verify', 'general-purpose', true),
      toolResult(TOOL_USE_ID, false, 'Async agent launched successfully'),
      { type: 'result', subtype: 'success', result: 'awaiting' } as any,
    ]);
    expect(subs[0].status).toBe('running');
  });

  it('foreground subagents are never marked abandoned (they have no run_in_background flag)', () => {
    // Without isBackground, the subagent must already be terminal via
    // tool_result/notification — it can never reach the abandoned branch.
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID, 'Verify', 'Explore', false),
      // No tool_result, no notification, but trailing user message
      { type: 'result', subtype: 'success', result: 'huh' } as any,
      { type: 'user', message: { content: [{ type: 'text', text: 'next' }] } } as any,
    ]);
    expect(subs[0].status).toBe('running');
  });

  it('background dispatch with task_notification(completed) is not abandoned even if more messages follow', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID, 'Verify', 'general-purpose', true),
      toolResult(TOOL_USE_ID, false, 'Async agent launched'),
      taskNotification(TOOL_USE_ID, 'completed'),
      { type: 'result', subtype: 'success', result: 'done' } as any,
      { type: 'user', message: { content: [{ type: 'text', text: 'next' }] } } as any,
    ]);
    expect(subs[0].status).toBe('completed');
  });

  it('leaves the subagent running when no tool_result and no notification', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      taskStarted(TOOL_USE_ID),
      taskProgress(TOOL_USE_ID, 'still going'),
    ]);
    expect(subs[0].status).toBe('running');
  });

  it('handles two parallel subagents as distinct entries', () => {
    const msgs: ClaudeStreamMessage[] = [
      agentToolUse(TOOL_USE_ID, 'First', 'Explore'),
      agentToolUse(TOOL_USE_ID_2, 'Second', 'Plan'),
      taskStarted(TOOL_USE_ID),
      taskStarted(TOOL_USE_ID_2, 'task_2'),
      taskProgress(TOOL_USE_ID, 'A step'),
      taskProgress(TOOL_USE_ID_2, 'B step'),
      taskNotification(TOOL_USE_ID, 'completed', 'first done'),
    ];
    const subs = deriveSubagents(msgs);
    expect(subs).toHaveLength(2);
    const first = subs.find((s) => s.toolUseId === TOOL_USE_ID)!;
    const second = subs.find((s) => s.toolUseId === TOOL_USE_ID_2)!;
    expect(first.status).toBe('completed');
    expect(second.status).toBe('running');
    expect(first.agentType).toBe('Explore');
    expect(second.agentType).toBe('Plan');
  });

  it('creates a subagent even without a preceding parent tool_use (lifecycle-only)', () => {
    const subs = deriveSubagents([
      taskStarted(TOOL_USE_ID, 'task_x', 'Orphan task'),
      taskProgress(TOOL_USE_ID, 'working'),
    ]);
    expect(subs).toHaveLength(1);
    expect(subs[0].description).toBe('Orphan task');
  });

  it('assigns a stable colorIndex per toolUseId', () => {
    const subs = deriveSubagents([agentToolUse(TOOL_USE_ID)]);
    expect(subs[0].colorIndex).toBe(colorIndexFor(TOOL_USE_ID));
  });
});

describe('XML task-notification (queue-operation / attachment)', () => {
  // Background Bash dispatches receive their completion signal as XML wrapped
  // in a queue-operation enqueue (live stream) or an attachment.queued_command
  // (replayed through the agent loop), NOT as a structured task_notification
  // SystemMessage. The reducer must extract the embedded <tool-use-id> /
  // <status> / <summary> and route through the same close path that
  // structured task_notification uses.

  function bashBg(id: string, description = 'verify gate'): ClaudeStreamMessage {
    return {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id,
            name: 'Bash',
            input: {
              command: 'node scripts/claude/verify.mjs',
              description,
              run_in_background: true,
            },
          },
        ],
      },
    } as unknown as ClaudeStreamMessage;
  }

  function bgAck(toolUseId: string): ClaudeStreamMessage {
    return toolResult(toolUseId, false, `Command running in background with ID: bg_${toolUseId}`);
  }

  function xmlBody(
    toolUseId: string,
    status: 'completed' | 'failed' = 'completed',
    summary = 'verify gate done',
    taskId = 'bgtask1',
  ): string {
    return [
      '<task-notification>',
      `<task-id>${taskId}</task-id>`,
      `<tool-use-id>${toolUseId}</tool-use-id>`,
      `<status>${status}</status>`,
      `<summary>${summary}</summary>`,
      '</task-notification>',
    ].join('\n');
  }

  function queueOp(toolUseId: string, status: 'completed' | 'failed' = 'completed', summary = 'verify gate done'): ClaudeStreamMessage {
    return {
      type: 'queue-operation',
      operation: 'enqueue',
      content: xmlBody(toolUseId, status, summary),
    } as unknown as ClaudeStreamMessage;
  }

  function attachmentQueued(toolUseId: string, status: 'completed' | 'failed' = 'completed', summary = 'verify gate done'): ClaudeStreamMessage {
    return {
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: xmlBody(toolUseId, status, summary),
      },
    } as unknown as ClaudeStreamMessage;
  }

  it('queue-operation enqueue with <task-notification> closes out the matching bg dispatch', () => {
    const subs = deriveSubagents([
      bashBg(TOOL_USE_ID, 'verify gate'),
      bgAck(TOOL_USE_ID),
      queueOp(TOOL_USE_ID, 'completed', 'verify gate completed (exit 0)'),
    ]);
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe('completed');
    expect(subs[0].summary).toBe('verify gate completed (exit 0)');
    // The summary should become the latest progress event so SubagentBar
    // replaces "Waiting for first progress event…" with the summary line.
    expect(subs[0].events).toHaveLength(1);
    expect(subs[0].latest?.description).toBe('verify gate completed (exit 0)');
  });

  it('attachment(queued_command) carrying <task-notification> closes out the matching bg dispatch', () => {
    const subs = deriveSubagents([
      bashBg(TOOL_USE_ID, 'verify gate'),
      bgAck(TOOL_USE_ID),
      attachmentQueued(TOOL_USE_ID, 'completed', 'verify gate done'),
    ]);
    expect(subs[0].status).toBe('completed');
    expect(subs[0].summary).toBe('verify gate done');
  });

  it('XML <status>failed</status> maps to failed', () => {
    const subs = deriveSubagents([
      bashBg(TOOL_USE_ID),
      bgAck(TOOL_USE_ID),
      queueOp(TOOL_USE_ID, 'failed', 'exit 1'),
    ]);
    expect(subs[0].status).toBe('failed');
  });

  it('XML for an unknown tool_use_id is ignored (no orphan subagent fabricated)', () => {
    const subs = deriveSubagents([queueOp('toolu_never_seen', 'completed', 'whatever')]);
    expect(subs).toHaveLength(0);
  });

  it('structured task_notification arriving first wins over a later XML one', () => {
    const subs = deriveSubagents([
      bashBg(TOOL_USE_ID),
      bgAck(TOOL_USE_ID),
      taskNotification(TOOL_USE_ID, 'completed', 'structured summary'),
      queueOp(TOOL_USE_ID, 'failed', 'xml says failed but structured already won'),
    ]);
    expect(subs[0].status).toBe('completed');
    expect(subs[0].summary).toBe('structured summary');
  });

  it('structured task_notification arriving after XML still wins (structured is most authoritative)', () => {
    // Existing precedence: structured task_notification carries usage + a
    // canonical status, so it overwrites whatever the XML branch set. This
    // matches the structured branch's pre-existing unconditional overwrite.
    const subs = deriveSubagents([
      bashBg(TOOL_USE_ID),
      bgAck(TOOL_USE_ID),
      queueOp(TOOL_USE_ID, 'completed', 'xml summary'),
      taskNotification(TOOL_USE_ID, 'failed', 'structured wins'),
    ]);
    expect(subs[0].status).toBe('failed');
    expect(subs[0].summary).toBe('structured wins');
  });
});

describe('clearCompleted', () => {
  it('drops completed and failed, keeps running', () => {
    const subs = [
      { toolUseId: 'a', status: 'running' } as any,
      { toolUseId: 'b', status: 'completed' } as any,
      { toolUseId: 'c', status: 'failed' } as any,
    ];
    const out = clearCompleted(subs);
    expect(out).toHaveLength(1);
    expect(out[0].toolUseId).toBe('a');
  });
});

describe('hasRunningSubagent', () => {
  // Single source of truth for "is there an outstanding response we're waiting
  // on?" — must match the predicate in classifyStandaloneKind that decides
  // whether a `result` event renders as `result.awaiting_background`. Drift
  // here was the bug behind "spinner gone but Awaiting Background card showing".
  it('returns true for any running subagent regardless of isBackground flag', () => {
    expect(hasRunningSubagent([{ status: 'running' } as any])).toBe(true);
    expect(hasRunningSubagent([{ status: 'running', isBackground: true } as any])).toBe(true);
    expect(hasRunningSubagent([{ status: 'running', isBackground: false } as any])).toBe(true);
  });

  it('returns false when no subagents are running', () => {
    expect(hasRunningSubagent([
      { status: 'completed', isBackground: true } as any,
      { status: 'failed' } as any,
      { status: 'abandoned', isBackground: true } as any,
    ])).toBe(false);
  });

  it('returns false on empty input', () => {
    expect(hasRunningSubagent([])).toBe(false);
  });
});

// Real-transcript sanity check — skipped if the (untracked) fixture isn't present.
const FIXTURE = path.resolve(process.cwd(), 'session_json/test_session.json');
describe.skipIf(!fs.existsSync(FIXTURE))('deriveSubagents with real transcript', () => {
  it('extracts exactly one completed Explore subagent from test_session.json', () => {
    const raw = fs.readFileSync(FIXTURE, 'utf-8');
    const transcript = JSON.parse(raw) as { output: ClaudeStreamMessage[] };
    const subs = deriveSubagents(transcript.output);
    expect(subs).toHaveLength(1);
    const s = subs[0];
    expect(s.agentType).toBe('Explore');
    expect(s.status).toBe('completed');
    expect(s.events.length).toBeGreaterThan(20); // many task_progress events in the recording
    expect(s.latest?.toolUses).toBe(29);
  });
});
