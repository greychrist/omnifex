import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { JsonlNode } from '@/types/jsonl';
import {
  deriveSubagents,
  applySubagentMeta,
  clearCompleted,
  isTaskLifecycleMarker,
  hasRunningSubagent,
  colorIndexFor,
  SUBAGENT_PALETTE_SIZE,
  createSubagentColorAllocator,
} from '../subagentStreams';

const TOOL_USE_ID = 'toolu_TEST_1';
const TOOL_USE_ID_2 = 'toolu_TEST_2';

function agentToolUse(
  id: string,
  description = 'Explore repo',
  subagentType = 'Explore',
  runInBackground = false,
): JsonlNode {
  return {
    kind: 'assistant', sessionId: '', receivedAt: '',
    raw: {
      type: 'assistant',
      message: {
        role: 'assistant',
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
    },
  } as unknown as JsonlNode;
}

function taskStarted(toolUseId: string, taskId = 'task_1', description = 'Explore repo'): JsonlNode {
  return {
    kind: 'unknown', sessionId: '', receivedAt: '',
    raw: {
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
      tool_use_id: toolUseId,
      description,
      task_type: 'local_agent',
    },
  } as unknown as JsonlNode;
}

function taskProgress(
  toolUseId: string,
  description: string,
  extras: Partial<{ last_tool_name: string; total_tokens: number; tool_uses: number; duration_ms: number }> = {},
): JsonlNode {
  return {
    kind: 'unknown', sessionId: '', receivedAt: '',
    raw: {
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
    },
  } as unknown as JsonlNode;
}

function taskNotification(
  toolUseId: string,
  status: 'completed' | 'failed' = 'completed',
  summary = 'done',
): JsonlNode {
  return {
    kind: 'unknown', sessionId: '', receivedAt: '',
    raw: {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task_1',
      tool_use_id: toolUseId,
      status,
      summary,
      usage: { total_tokens: 42060, tool_uses: 29, duration_ms: 37747 },
    },
  } as unknown as JsonlNode;
}

// Patch shape mirrors the CLI's CliTaskUpdatedMessage at sdk.d.ts:3619.
// Only the fields a consumer might apply — status, description, end_time,
// total_paused_ms, error, is_backgrounded — appear here.
function taskUpdated(
  taskId: string,
  patch: {
    status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed';
    description?: string;
    end_time?: number;
    total_paused_ms?: number;
    error?: string;
    is_backgrounded?: boolean;
  },
): JsonlNode {
  return {
    kind: 'unknown', sessionId: '', receivedAt: '',
    raw: {
      type: 'system',
      subtype: 'task_updated',
      task_id: taskId,
      patch,
    },
  } as unknown as JsonlNode;
}

function toolResult(
  toolUseId: string,
  isError = false,
  text = 'result text',
): JsonlNode {
  return {
    kind: 'user', userKind: 'tool-result', sessionId: '', receivedAt: '',
    raw: {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            is_error: isError,
            content: text,
          },
        ],
      },
    },
  } as unknown as JsonlNode;
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

describe('createSubagentColorAllocator', () => {
  it('assigns distinct indices to N <= palette size toolUseIds', () => {
    const allocator = createSubagentColorAllocator();
    const indices = new Set<number>();
    for (let i = 0; i < SUBAGENT_PALETTE_SIZE; i++) {
      indices.add(allocator.acquire(`tool-${i}`));
    }
    expect(indices.size).toBe(SUBAGENT_PALETTE_SIZE);
  });

  it('returns the same index for the same toolUseId on repeated calls', () => {
    const allocator = createSubagentColorAllocator();
    const first = allocator.acquire('tool-x');
    const second = allocator.acquire('tool-x');
    expect(first).toBe(second);
  });

  it('release frees the slot for a future allocation', () => {
    const allocator = createSubagentColorAllocator();
    const ids: string[] = [];
    for (let i = 0; i < SUBAGENT_PALETTE_SIZE; i++) ids.push(`t-${i}`);
    const idx0 = allocator.acquire(ids[0]);
    for (let i = 1; i < SUBAGENT_PALETTE_SIZE; i++) allocator.acquire(ids[i]);
    allocator.release(ids[0]);
    // Newcomer should take the freed slot.
    expect(allocator.acquire('newcomer')).toBe(idx0);
  });

  it('falls back to hash-mod when palette is saturated', () => {
    const allocator = createSubagentColorAllocator();
    for (let i = 0; i < SUBAGENT_PALETTE_SIZE; i++) allocator.acquire(`t-${i}`);
    // Overflow — should not throw, returns a valid index in [0, PALETTE_SIZE).
    const overflowIdx = allocator.acquire('overflow');
    expect(overflowIdx).toBeGreaterThanOrEqual(0);
    expect(overflowIdx).toBeLessThan(SUBAGENT_PALETTE_SIZE);
  });

  it('release is a no-op for an unknown toolUseId', () => {
    const allocator = createSubagentColorAllocator();
    expect(() => allocator.release('never-acquired')).not.toThrow();
  });
});

describe('applySubagentMeta', () => {
  it('merges model and authoritative stats onto the matching toolUseId', () => {
    const subs = deriveSubagents([agentToolUse(TOOL_USE_ID), taskNotification(TOOL_USE_ID)]);
    const merged = applySubagentMeta(subs, {
      [TOOL_USE_ID]: {
        model: 'claude-haiku-4-5-20251001',
        agentType: 'code-reviewer',
        totalTokens: 71591,
        durationMs: 53161,
        toolUseCount: 20,
      },
    });
    expect(merged[0].model).toBe('claude-haiku-4-5-20251001');
    expect(merged[0].finalTotalTokens).toBe(71591);
    expect(merged[0].finalDurationMs).toBe(53161);
    expect(merged[0].finalToolUseCount).toBe(20);
  });

  it('fills agentType from meta only when the dispatch did not provide one', () => {
    // agentToolUse dispatches with subagent_type 'Explore' — meta must not clobber it.
    const subs = deriveSubagents([agentToolUse(TOOL_USE_ID, 'desc', 'Explore'), taskNotification(TOOL_USE_ID)]);
    const merged = applySubagentMeta(subs, { [TOOL_USE_ID]: { agentType: 'code-reviewer' } });
    expect(merged[0].agentType).toBe('Explore');
  });

  it('leaves rows without a meta entry unchanged', () => {
    const subs = deriveSubagents([agentToolUse(TOOL_USE_ID), taskNotification(TOOL_USE_ID)]);
    const merged = applySubagentMeta(subs, {});
    expect(merged[0].model).toBeUndefined();
    expect(merged[0].finalTotalTokens).toBeUndefined();
  });

  it('does not mutate the input array', () => {
    const subs = deriveSubagents([agentToolUse(TOOL_USE_ID), taskNotification(TOOL_USE_ID)]);
    applySubagentMeta(subs, { [TOOL_USE_ID]: { model: 'claude-opus-4-8' } });
    expect(subs[0].model).toBeUndefined();
  });
});

describe('deriveSubagents', () => {
  it('returns empty for transcripts with no subagents', () => {
    const msgs: JsonlNode[] = [
      { kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '', raw: { type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } } } as any,
      { kind: 'assistant', sessionId: '', receivedAt: '', raw: { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } } } as any,
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
    // The CLI fires an immediate "Async agent launched" tool_result for
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
    function bashBackground(id: string, description = 'Build something'): JsonlNode {
      return {
        kind: 'assistant', sessionId: '', receivedAt: '',
        raw: {
          type: 'assistant',
          message: {
            role: 'assistant',
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
        },
      } as unknown as JsonlNode;
    }

    function bashForeground(id: string): JsonlNode {
      return {
        kind: 'assistant', sessionId: '', receivedAt: '',
        raw: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id,
                name: 'Bash',
                input: { command: 'ls', description: 'list files' },
              },
            ],
          },
        },
      } as unknown as JsonlNode;
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

    it('Bash run_in_background is marked completed_inferred when the parent advances past the result without a notification', () => {
      // Refactored from the previous `abandoned`-on-orphan-detection assertion.
      // The current design reserves `abandoned` for explicit "we know this
      // didn't finish" cases (e.g. a future watchdog timeout); the
      // safety-net inference path uses `completed_inferred` so the row
      // renders with a distinct icon that makes the missing carrier visible.
      const subs = deriveSubagents([
        bashBackground(TOOL_USE_ID, 'Build DMG'),
        toolResult(TOOL_USE_ID, false, 'Async agent launched'),
        { kind: 'cli-stream-result', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'success', result: 'awaiting' } } as any,
        { kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '', raw: { type: 'user', message: { content: [{ type: 'text', text: 'next' }] } } } as any,
      ]);
      expect(subs[0].status).toBe('completed_inferred');
      expect(subs[0].closureSource).toBe('parent_result');
    });

    it('Bash run_in_background stays running while the result event is the latest (live awaiting)', () => {
      const subs = deriveSubagents([
        bashBackground(TOOL_USE_ID, 'Build DMG'),
        toolResult(TOOL_USE_ID, false, 'Async agent launched'),
        { kind: 'cli-stream-result', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'success', result: 'awaiting' } } as any,
      ]);
      expect(subs[0].status).toBe('running');
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

  it('background dispatch becomes "completed_inferred" when a result fires and the parent moves on without task_notification', () => {
    // Loaded session: turn dispatched a background agent, the result event
    // closed the turn, and then either a new user message or another turn
    // happened — proving the parent moved on without the notification.
    // Inference rule now uses completed_inferred (distinct icon) rather
    // than abandoned, so the missing-carrier case is visible without
    // looking like a hang.
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID, 'Verify', 'general-purpose', true),
      toolResult(TOOL_USE_ID, false, 'Async agent launched successfully'),
      { kind: 'cli-stream-result', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'success', result: 'awaiting' } } as any,
      { kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '', raw: { type: 'user', message: { content: [{ type: 'text', text: 'next prompt' }] } } } as any,
    ]);
    expect(subs[0].status).toBe('completed_inferred');
    expect(subs[0].closureSource).toBe('parent_result');
  });

  it('background dispatch stays running while the result event is the latest message (live awaiting)', () => {
    // Live session paused at the awaiting state — no messages after the result
    // yet. We must not mark these as abandoned; the wake-up may still arrive.
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID, 'Verify', 'general-purpose', true),
      toolResult(TOOL_USE_ID, false, 'Async agent launched successfully'),
      { kind: 'cli-stream-result', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'success', result: 'awaiting' } } as any,
    ]);
    expect(subs[0].status).toBe('running');
  });

  it('foreground subagents also receive completed_inferred when the parent advances past their dispatch', () => {
    // Under the generalised inference rule, foreground Agent/Task
    // dispatches that lose their tool_result also get closed when the
    // parent emits a result and then continues with more activity. This
    // is the exact scenario the user hit on the WIN session — a stuck
    // "general-purpose" row left running because no closure carrier
    // matched, with the parent already advanced.
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID, 'Verify', 'Explore', false),
      // No tool_result, no notification, but trailing user message
      { kind: 'cli-stream-result', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'success', result: 'huh' } } as any,
      { kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '', raw: { type: 'user', message: { content: [{ type: 'text', text: 'next' }] } } } as any,
    ]);
    expect(subs[0].status).toBe('completed_inferred');
    expect(subs[0].closureSource).toBe('parent_result');
  });

  it('background dispatch with task_notification(completed) is not abandoned even if more messages follow', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID, 'Verify', 'general-purpose', true),
      toolResult(TOOL_USE_ID, false, 'Async agent launched'),
      taskNotification(TOOL_USE_ID, 'completed'),
      { kind: 'cli-stream-result', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'success', result: 'done' } } as any,
      { kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '', raw: { type: 'user', message: { content: [{ type: 'text', text: 'next' }] } } } as any,
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
    const msgs: JsonlNode[] = [
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

  function bashBg(id: string, description = 'verify gate'): JsonlNode {
    return {
      kind: 'assistant', sessionId: '', receivedAt: '',
      raw: {
        type: 'assistant',
        message: {
          role: 'assistant',
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
      },
    } as unknown as JsonlNode;
  }

  function bgAck(toolUseId: string): JsonlNode {
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

  function queueOp(toolUseId: string, status: 'completed' | 'failed' = 'completed', summary = 'verify gate done'): JsonlNode {
    return {
      kind: 'unknown', sessionId: '', receivedAt: '',
      raw: {
        type: 'queue-operation',
        operation: 'enqueue',
        content: xmlBody(toolUseId, status, summary),
      },
    } as unknown as JsonlNode;
  }

  function attachmentQueued(toolUseId: string, status: 'completed' | 'failed' = 'completed', summary = 'verify gate done'): JsonlNode {
    return {
      kind: 'unknown', sessionId: '', receivedAt: '',
      raw: {
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          prompt: xmlBody(toolUseId, status, summary),
        },
      },
    } as unknown as JsonlNode;
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
  // on?" — must match the predicate used by session-derived-state to determine
  // whether background subagents are still running. Drift here was the bug
  // behind "spinner gone but Awaiting Background card showing".
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

describe('task_updated handling (CliTaskUpdatedMessage patch application)', () => {
  // CliTaskUpdatedMessage carries a `patch` describing wire-safe TaskState
  // changes (status, description, end_time, error, is_backgrounded, …).
  // Until this batch the message was filtered from the chat timeline (via
  // `isTaskLifecycleMarker`'s `task_*` startsWith match) but its payload
  // was discarded — `messagesToEvents` had no branch for `task_updated`.
  // The reducer is keyed by `toolUseId`; `task_updated` only carries
  // `task_id`, so the reducer maps `task_id` back to the dispatched row
  // via the `taskId` field set on SubagentState during `Started` /
  // `Progress` / `Notification`.

  it('applies is_backgrounded: true to a running subagent', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      taskStarted(TOOL_USE_ID, 'task_1'),
      taskUpdated('task_1', { is_backgrounded: true }),
    ]);
    expect(subs).toHaveLength(1);
    expect(subs[0].isBackground).toBe(true);
    expect(subs[0].status).toBe('running');
  });

  it('updates description from patch.description', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID, 'initial desc'),
      taskStarted(TOOL_USE_ID, 'task_1', 'initial desc'),
      taskUpdated('task_1', { description: 'updated desc' }),
    ]);
    expect(subs[0].description).toBe('updated desc');
  });

  it('terminates a running subagent via patch.status = "completed"', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      taskStarted(TOOL_USE_ID, 'task_1'),
      taskUpdated('task_1', { status: 'completed' }),
    ]);
    expect(subs[0].status).toBe('completed');
  });

  it('maps patch.status = "killed" to failed status', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      taskStarted(TOOL_USE_ID, 'task_1'),
      taskUpdated('task_1', { status: 'killed' }),
    ]);
    expect(subs[0].status).toBe('failed');
  });

  it('exposes patch.error on the resulting Subagent shape', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      taskStarted(TOOL_USE_ID, 'task_1'),
      taskUpdated('task_1', { status: 'failed', error: 'subagent crashed' }),
    ]);
    expect(subs[0].status).toBe('failed');
    expect(subs[0].error).toBe('subagent crashed');
  });

  it('does NOT override a TaskNotification terminal status', () => {
    // TaskNotification is the canonical completion carrier; task_updated
    // should refine pre-terminal state but never overwrite a TaskNotification
    // closure with a contradictory status.
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      taskStarted(TOOL_USE_ID, 'task_1'),
      taskNotification(TOOL_USE_ID, 'completed', 'good'),
      taskUpdated('task_1', { status: 'failed', error: 'late conflict' }),
    ]);
    expect(subs[0].status).toBe('completed');
    expect(subs[0].closureSource).toBe('task_notification');
  });

  it('still applies is_backgrounded after TaskNotification (mid-flight metadata is non-conflicting)', () => {
    // is_backgrounded is descriptive metadata, not a status change. Even
    // after a terminal TaskNotification, an is_backgrounded patch is
    // information about how the dispatch ran and is safe to record.
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      taskStarted(TOOL_USE_ID, 'task_1'),
      taskNotification(TOOL_USE_ID, 'completed'),
      taskUpdated('task_1', { is_backgrounded: true }),
    ]);
    expect(subs[0].status).toBe('completed');
    expect(subs[0].isBackground).toBe(true);
  });

  it('is a no-op when task_id matches no dispatched subagent (no orphan creation)', () => {
    const subs = deriveSubagents([
      taskUpdated('task_unknown', { is_backgrounded: true, status: 'completed' }),
    ]);
    expect(subs).toHaveLength(0);
  });

  it('sets endedAt from patch.end_time (unix ms) when terminating', () => {
    const endTimeMs = Date.UTC(2026, 4, 13, 12, 0, 0); // 2026-05-13T12:00:00Z
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      taskStarted(TOOL_USE_ID, 'task_1'),
      taskUpdated('task_1', { status: 'completed', end_time: endTimeMs }),
    ]);
    expect(subs[0].status).toBe('completed');
    expect(subs[0].endedAt).toBe(new Date(endTimeMs).toISOString());
  });
});

// Real-transcript sanity check — skipped if the (untracked) fixture isn't present.
const FIXTURE = path.resolve(process.cwd(), 'session_json/test_session.json');
describe.skipIf(!fs.existsSync(FIXTURE))('deriveSubagents with real transcript', () => {
  it('extracts exactly one completed Explore subagent from test_session.json', () => {
    const raw = fs.readFileSync(FIXTURE, 'utf-8');
    const transcript = JSON.parse(raw) as { output: JsonlNode[] };
    const subs = deriveSubagents(transcript.output);
    expect(subs).toHaveLength(1);
    const s = subs[0];
    expect(s.agentType).toBe('Explore');
    expect(s.status).toBe('completed');
    expect(s.events.length).toBeGreaterThan(20); // many task_progress events in the recording
    expect(s.latest?.toolUses).toBe(29);
  });
});

describe('forwarded subagent text (--forward-subagent-text)', () => {
  function forwardedAssistantText(parentToolUseId: string, text: string): JsonlNode {
    return {
      kind: 'assistant', sessionId: '', receivedAt: '',
      raw: {
        type: 'assistant',
        parent_tool_use_id: parentToolUseId,
        message: {
          role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'text', text }],
        },
      },
    } as unknown as JsonlNode;
  }

  function forwardedAssistantThinking(parentToolUseId: string, thinking: string): JsonlNode {
    return {
      kind: 'assistant', sessionId: '', receivedAt: '',
      raw: {
        type: 'assistant',
        parent_tool_use_id: parentToolUseId,
        message: {
          role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'thinking', thinking, signature: 'sig' }],
        },
      },
    } as unknown as JsonlNode;
  }

  it('surfaces forwarded assistant text as the latest progress entry on the dispatched row', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      taskStarted(TOOL_USE_ID),
      forwardedAssistantText(TOOL_USE_ID, 'Scanning the auth module for the bug now.'),
    ]);
    expect(subs).toHaveLength(1);
    expect(subs[0].latest?.description).toBe('Scanning the auth module for the bug now.');
    expect(subs[0].status).toBe('running');
  });

  it('keeps the running usage tally from the last task_progress when text arrives', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      taskStarted(TOOL_USE_ID),
      taskProgress(TOOL_USE_ID, 'working', { total_tokens: 5000, tool_uses: 3, duration_ms: 9000 }),
      forwardedAssistantText(TOOL_USE_ID, 'Found it — patching.'),
    ]);
    expect(subs[0].latest?.description).toBe('Found it — patching.');
    // The numeric tally must carry forward, not blank out, so the row's
    // meta bits (tokens/tools/elapsed) don't flicker away on each text.
    expect(subs[0].latest?.totalTokens).toBe(5000);
    expect(subs[0].latest?.toolUses).toBe(3);
  });

  it('falls back to thinking content when the forwarded message has no text block', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      taskStarted(TOOL_USE_ID),
      forwardedAssistantThinking(TOOL_USE_ID, 'The user wants a summary of the diff.'),
    ]);
    expect(subs[0].latest?.description).toBe('The user wants a summary of the diff.');
  });

  it('ignores forwarded text after the row reached a terminal status', () => {
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID),
      taskStarted(TOOL_USE_ID),
      taskNotification(TOOL_USE_ID, 'completed', 'all done'),
      forwardedAssistantText(TOOL_USE_ID, 'late straggler'),
    ]);
    expect(subs[0].status).toBe('completed');
    expect(subs[0].latest?.description).not.toBe('late straggler');
  });

  it('ignores forwarded text with no matching dispatch', () => {
    const subs = deriveSubagents([
      forwardedAssistantText('toolu_never_dispatched', 'orphan'),
    ]);
    expect(subs).toHaveLength(0);
  });
});
