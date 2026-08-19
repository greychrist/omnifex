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
  notificationStatsByToolUse,
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

  it('merges the subagent\'s own effort', () => {
    const subs = deriveSubagents([agentToolUse(TOOL_USE_ID), taskNotification(TOOL_USE_ID)]);
    const merged = applySubagentMeta(subs, { [TOOL_USE_ID]: { effort: 'high' } });
    expect(merged[0].effort).toBe('high');
  });

  it('leaves effort undefined when meta carries none', () => {
    const subs = deriveSubagents([agentToolUse(TOOL_USE_ID), taskNotification(TOOL_USE_ID)]);
    const merged = applySubagentMeta(subs, { [TOOL_USE_ID]: { model: 'claude-opus-4-8' } });
    expect(merged[0].effort).toBeUndefined();
  });
});

// A nested subagent's dispatching tool_use is issued inside its PARENT's
// transcript, so deriveSubagents (which reads the main stream) never produces
// a row for it. The sidecars are the only record, and without this the whole
// branch is silently missing from the SubagentBar.
describe('applySubagentMeta — nested subagents', () => {
  const CHILD_ID = 'toolu_CHILD';
  const parentOnly = () =>
    deriveSubagents([agentToolUse(TOOL_USE_ID), taskNotification(TOOL_USE_ID)]);

  const nestedMeta = () => ({
    [TOOL_USE_ID]: { agentId: 'a987', agentType: 'general-purpose', spawnDepth: 1 },
    [CHILD_ID]: {
      agentId: 'a843',
      agentType: 'general-purpose',
      parentAgentId: 'a987',
      spawnDepth: 2,
      model: 'claude-haiku-4-5-20251001',
    },
  });

  it('adds a row for a nested subagent the main stream never dispatched', () => {
    const merged = applySubagentMeta(parentOnly(), nestedMeta());
    expect(merged).toHaveLength(2);
    const child = merged.find((s) => s.toolUseId === CHILD_ID);
    expect(child?.model).toBe('claude-haiku-4-5-20251001');
    expect(child?.agentType).toBe('general-purpose');
  });

  it('links the nested row to its parent ROW, not just the parent agentId', () => {
    // SubagentBar rows are keyed by toolUseId, so the agentId from the
    // sidecar has to be resolved through the meta map to be useful.
    const merged = applySubagentMeta(parentOnly(), nestedMeta());
    const child = merged.find((s) => s.toolUseId === CHILD_ID);
    expect(child?.parentToolUseId).toBe(TOOL_USE_ID);
  });

  it('places the nested row directly after its parent', () => {
    const merged = applySubagentMeta(parentOnly(), nestedMeta());
    expect(merged.map((s) => s.toolUseId)).toEqual([TOOL_USE_ID, CHILD_ID]);
  });

  it('marks a child of a returned parent as inferred, not confirmed, complete', () => {
    // This used to assert plain 'completed', on the reasoning that a child
    // cannot outlive the Task that dispatched it. CLI 2.1.232 broke that: an
    // agent backgrounds its own children and returns without them. Observed
    // in session f54bcd1a — parent done at 24s, children still working at 74s
    // and 82s. With no notification of its own, a child's completion is an
    // inference, and `completed_inferred` is the status that says so.
    const merged = applySubagentMeta(parentOnly(), nestedMeta());
    const parent = merged.find((s) => s.toolUseId === TOOL_USE_ID);
    const child = merged.find((s) => s.toolUseId === CHILD_ID);
    expect(parent?.status).toBe('completed');
    expect(child?.status).toBe('completed_inferred');
  });

  it('prefers the child\'s own notification over any inference', () => {
    const merged = applySubagentMeta(parentOnly(), nestedMeta(), {
      [CHILD_ID]: { status: 'completed', summary: 'child done', totalTokens: 42 },
    });
    const child = merged.find((s) => s.toolUseId === CHILD_ID);
    expect(child?.status).toBe('completed');
    expect(child?.latest?.totalTokens).toBe(42);
  });

  it('shows a nested row as running while its parent still is', () => {
    const running = deriveSubagents([agentToolUse(TOOL_USE_ID)]);
    expect(running[0].status).toBe('running');
    const merged = applySubagentMeta(running, nestedMeta());
    expect(merged.find((s) => s.toolUseId === CHILD_ID)?.status).toBe('running');
  });

  it('does not invent rows for depth-1 meta with no dispatch', () => {
    // A depth-1 entry with no row means the main stream hasn't been read yet
    // (or the dispatch was dropped) — not a nested branch. Synthesising it
    // would duplicate the row once the dispatch does arrive.
    const merged = applySubagentMeta([], {
      [TOOL_USE_ID]: { agentId: 'a987', spawnDepth: 1 },
    });
    expect(merged).toEqual([]);
  });

  it('skips a nested entry whose parent cannot be resolved', () => {
    // An orphan has nothing to attach to; a floating row with no context is
    // worse than omitting it.
    const merged = applySubagentMeta(parentOnly(), {
      [CHILD_ID]: { agentId: 'a843', parentAgentId: 'MISSING', spawnDepth: 2 },
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].toolUseId).toBe(TOOL_USE_ID);
  });

  it('leaves parentToolUseId unset on ordinary depth-1 rows', () => {
    const merged = applySubagentMeta(parentOnly(), nestedMeta());
    expect(merged.find((s) => s.toolUseId === TOOL_USE_ID)?.parentToolUseId).toBeUndefined();
  });

  it('does not mutate the input array', () => {
    const subs = parentOnly();
    applySubagentMeta(subs, nestedMeta());
    expect(subs).toHaveLength(1);
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

  describe('implicit background dispatch (CLI >= 2.1.232)', () => {
    // 2.1.232 made non-teammate agent spawns in interactive sessions run in
    // the background BY DEFAULT. `run_in_background` stays optional on the
    // tool schema, so the model omits it and the dispatch input carries no
    // background flag at all — the only signals are on the result side:
    //   - `toolUseResult.status === 'async_launched'` (+ `isAsync: true`),
    //     the enrichment the CLI writes onto the on-disk JSONL line, which is
    //     what TUI mode tails; and
    //   - the ACK text itself, which is all the live stream-json path gets.
    // The CLI's own agent panel reads both. Without them a launched agent
    // reads as finished for its entire run.
    function asyncLaunchedAck(
      toolUseId: string,
      opts: { enrichment?: boolean } = {},
    ): JsonlNode {
      const node = toolResult(
        toolUseId,
        false,
        'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: agent_x',
      ) as unknown as { raw: Record<string, unknown> };
      if (opts.enrichment) {
        node.raw.toolUseResult = {
          isAsync: true,
          status: 'async_launched',
          agentId: 'agent_x',
          description: 'Audit',
          resolvedModel: 'claude-opus-5',
        };
      }
      return node as unknown as JsonlNode;
    }

    it('stays running on an async_launched ACK carrying the toolUseResult enrichment', () => {
      const subs = deriveSubagents([
        agentToolUse(TOOL_USE_ID, 'Audit', 'general-purpose'),
        asyncLaunchedAck(TOOL_USE_ID, { enrichment: true }),
      ]);
      expect(subs[0].status).toBe('running');
      expect(subs[0].isBackground).toBe(true);
    });

    it('stays running on the bare ACK text when the enrichment is absent (live stream)', () => {
      const subs = deriveSubagents([
        agentToolUse(TOOL_USE_ID, 'Audit', 'general-purpose'),
        asyncLaunchedAck(TOOL_USE_ID),
      ]);
      expect(subs[0].status).toBe('running');
      expect(subs[0].isBackground).toBe(true);
    });

    it('stays running when the ACK text arrives as a content-block array', () => {
      // Verified against a real 2.1.232 transcript: the CLI persists the ACK
      // as `content: [{type:'text', text:'Async agent launched successfully…'}]`,
      // not as a bare string. The enrichment covers the JSONL path, so this
      // shape is what the text fallback actually has to handle.
      const node = toolResult(TOOL_USE_ID, false) as unknown as { raw: any };
      node.raw.message.content[0].content = [
        { type: 'text', text: 'Async agent launched successfully. (This tool result is internal metadata …)' },
      ];
      const subs = deriveSubagents([
        agentToolUse(TOOL_USE_ID, 'Audit', 'general-purpose'),
        node as unknown as JsonlNode,
      ]);
      expect(subs[0].status).toBe('running');
      expect(subs[0].isBackground).toBe(true);
    });

    it('still flips to completed when the task_notification arrives', () => {
      const subs = deriveSubagents([
        agentToolUse(TOOL_USE_ID, 'Audit', 'general-purpose'),
        asyncLaunchedAck(TOOL_USE_ID, { enrichment: true }),
        taskNotification(TOOL_USE_ID, 'completed', 'all good'),
      ]);
      expect(subs[0].status).toBe('completed');
    });

    it('an errored launch still fails the row', () => {
      // is_error on the ACK means the dispatch itself failed — that is a real
      // terminal signal, not a "work continues in the background" ACK.
      const subs = deriveSubagents([
        agentToolUse(TOOL_USE_ID, 'Audit', 'general-purpose'),
        toolResult(TOOL_USE_ID, true, 'Async agent launch failed'),
      ]);
      expect(subs[0].status).toBe('failed');
    });

    it('a genuine foreground agent result still closes the row', () => {
      const subs = deriveSubagents([
        agentToolUse(TOOL_USE_ID, 'Audit', 'general-purpose'),
        toolResult(TOOL_USE_ID, false, 'Here is the full report the agent returned.'),
      ]);
      expect(subs[0].status).toBe('completed');
    });
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

    it('Bash run_in_background stays running when the parent advances past the result without a notification', () => {
      // Previously asserted `completed_inferred` here. A backgrounded shell
      // outlives the turn that launched it exactly as a backgrounded agent
      // does — `docker build` is still running when the user types the next
      // prompt — so the parent's `result` was never evidence it finished.
      // The row closes on its own carrier (`task_notification`, or the
      // queue-operation XML the JSONL tail forwards) or not at all.
      const subs = deriveSubagents([
        bashBackground(TOOL_USE_ID, 'Build DMG'),
        toolResult(TOOL_USE_ID, false, 'Async agent launched'),
        { kind: 'cli-stream-result', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'success', result: 'awaiting' } } as any,
        { kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '', raw: { type: 'user', message: { content: [{ type: 'text', text: 'next' }] } } } as any,
      ]);
      expect(subs[0].status).toBe('running');
      expect(subs[0].closureSource).toBeUndefined();
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

  it('background dispatch stays running when a result fires and the parent moves on without task_notification', () => {
    // Previously asserted `completed_inferred`: the parent moving on was
    // read as proof the agent had finished. It is not — the user typing the
    // next prompt is unrelated to a background agent's progress, and since
    // CLI 2.1.232 that is the normal shape of every agent spawn rather than
    // a rare missing-carrier edge case.
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID, 'Verify', 'general-purpose', true),
      toolResult(TOOL_USE_ID, false, 'Async agent launched successfully'),
      { kind: 'cli-stream-result', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'success', result: 'awaiting' } } as any,
      { kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '', raw: { type: 'user', message: { content: [{ type: 'text', text: 'next prompt' }] } } } as any,
    ]);
    expect(subs[0].status).toBe('running');
    expect(subs[0].closureSource).toBeUndefined();
  });

  it('a backgrounded agent stays running after its parent turn ends (CLI >=2.1.232 launches async)', () => {
    // Reproduces the pi-tuitive session: the dispatch input carries no
    // `run_in_background` (2.1.232 backgrounds agent spawns by default), the
    // ACK is what marks the row background, and the parent's turn ends
    // seconds later — twelve minutes before the agent actually returned.
    // A backgrounded agent's life is no longer bounded by the turn that
    // launched it, so the parent's `result` is not evidence it finished.
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID, 'Adversarial pre-push review', 'general-purpose', false),
      toolResult(TOOL_USE_ID, false, 'Async agent launched successfully. (This tool result is internal metadata.)'),
      { kind: 'cli-stream-result', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'success', result: 'dispatched' } } as any,
      taskProgress(TOOL_USE_ID, 'Reviewing the diff'),
    ]);
    expect(subs[0].status).toBe('running');
    expect(subs[0].isBackground).toBe(true);
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

describe('applySubagentMeta — nested row labelling', () => {
  // Real depth-2 run (session 015da44f): both nested rows rendered as the
  // parent's description, "Compare subagent stream modules", because the
  // synthesised row copied the parent's label. Each sidecar carries the
  // child's own description; use it.
  const dispatched = () =>
    deriveSubagents([agentToolUse(TOOL_USE_ID, 'Compare stream modules', 'general-purpose')]);

  it('labels a synthesised nested row with its own description', () => {
    const merged = applySubagentMeta(dispatched(), {
      [TOOL_USE_ID]: { agentId: 'a1e3', agentType: 'general-purpose', spawnDepth: 1 },
      toolu_child: {
        agentId: 'a0f9',
        agentType: 'general-purpose',
        description: 'Summarize subagentEvents.ts',
        parentAgentId: 'a1e3',
        spawnDepth: 2,
      },
    });
    const child = merged.find((s) => s.toolUseId === 'toolu_child');
    expect(child?.description).toBe('Summarize subagentEvents.ts');
  });

  it('gives a synthesised nested row the stats from its own task-notification', () => {
    // The nested agent's totals exist ONLY here: its dispatch happens inside
    // the parent's transcript (so no main-stream row), the parent transcript
    // holds just the async-launch ACK, and the sidecar carries no counts. The
    // main stream does receive the child's <task-notification>, which the
    // reducer drops for want of a row — so it is re-applied at merge time.
    const childXml = {
      kind: 'unknown', sessionId: '', receivedAt: '',
      raw: {
        type: 'queue-operation',
        operation: 'enqueue',
        content: [
          '<task-notification>',
          '<task-id>a0f93b41c3f3dd035</task-id>',
          '<tool-use-id>toolu_child</tool-use-id>',
          '<status>completed</status>',
          '<summary>Agent "Summarize subagentEvents.ts" finished</summary>',
          '<usage><subagent_tokens>38320</subagent_tokens><tool_uses>5</tool_uses><duration_ms>61259</duration_ms></usage>',
          '</task-notification>',
        ].join('\n'),
      },
    } as unknown as JsonlNode;

    const messages = [
      agentToolUse(TOOL_USE_ID, 'Compare stream modules', 'general-purpose'),
      childXml,
    ];
    const merged = applySubagentMeta(
      deriveSubagents(messages),
      {
        [TOOL_USE_ID]: { agentId: 'a1e3', spawnDepth: 1 },
        toolu_child: {
          agentId: 'a0f9',
          description: 'Summarize subagentEvents.ts',
          parentAgentId: 'a1e3',
          spawnDepth: 2,
        },
      },
      notificationStatsByToolUse(messages),
    );
    const child = merged.find((s) => s.toolUseId === 'toolu_child');
    expect(child?.status).toBe('completed');
    expect(child?.latest?.totalTokens).toBe(38320);
    expect(child?.latest?.toolUses).toBe(5);
    expect(child?.latest?.durationMs).toBe(61259);
  });

  it('falls back to the parent description when the sidecar has none', () => {
    const merged = applySubagentMeta(dispatched(), {
      [TOOL_USE_ID]: { agentId: 'a1e3', spawnDepth: 1 },
      toolu_child: { agentId: 'a0f9', parentAgentId: 'a1e3', spawnDepth: 2 },
    });
    const child = merged.find((s) => s.toolUseId === 'toolu_child');
    expect(child?.description).toBe('Compare stream modules');
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

  it('carries the <usage> run stats onto the closing progress entry', () => {
    // Verified against a real 2.1.232 transcript. Since backgrounding became
    // the default, this XML block is the ONLY carrier of a subagent's run
    // stats: the `toolUseResult` totals `readSubagentMeta` reads are absent
    // from the async-launch ACK, and no structured task_notification is
    // written to the JSONL at all. Dropping it blanks the numbers on every
    // SubagentBar row.
    const withUsage = [
      '<task-notification>',
      `<task-id>bgtask1</task-id>`,
      `<tool-use-id>${TOOL_USE_ID}</tool-use-id>`,
      '<status>completed</status>',
      '<summary>Agent "Summarize subagentEvents.ts" finished</summary>',
      '<usage><subagent_tokens>33770</subagent_tokens><tool_uses>5</tool_uses><duration_ms>54278</duration_ms></usage>',
      '</task-notification>',
    ].join('\n');
    const subs = deriveSubagents([
      bashBg(TOOL_USE_ID, 'summarize'),
      bgAck(TOOL_USE_ID),
      {
        kind: 'unknown', sessionId: '', receivedAt: '',
        raw: { type: 'queue-operation', operation: 'enqueue', content: withUsage },
      } as unknown as JsonlNode,
    ]);
    expect(subs[0].status).toBe('completed');
    expect(subs[0].latest?.totalTokens).toBe(33770);
    expect(subs[0].latest?.toolUses).toBe(5);
    expect(subs[0].latest?.durationMs).toBe(54278);
  });

  it('re-attaches a resumed agent notification by task-id when the tool-use-id is new', () => {
    // Real case (session 015da44f): Claude re-opened a finished agent with
    // SendMessage, so the second notification is keyed to the SendMessage
    // tool_use_id — which never dispatched a row. Its <task-id> is still the
    // original agent's, and its usage supersedes (the CLI reports the agent's
    // running totals, not per-segment deltas). Without the fallback the
    // resumed run's 57661 tokens vanish entirely.
    const xml = (toolUseId: string, tokens: number, tools: number, ms: number) =>
      ({
        kind: 'unknown', sessionId: '', receivedAt: '',
        raw: {
          type: 'queue-operation',
          operation: 'enqueue',
          content: [
            '<task-notification>',
            '<task-id>a1e3d9ab18183b8f2</task-id>',
            `<tool-use-id>${toolUseId}</tool-use-id>`,
            '<status>completed</status>',
            '<summary>Agent "Compare subagent stream modules" finished</summary>',
            `<usage><subagent_tokens>${tokens}</subagent_tokens><tool_uses>${tools}</tool_uses><duration_ms>${ms}</duration_ms></usage>`,
            '</task-notification>',
          ].join('\n'),
        },
      }) as unknown as JsonlNode;

    const subs = deriveSubagents([
      bashBg(TOOL_USE_ID, 'compare'),
      bgAck(TOOL_USE_ID),
      xml(TOOL_USE_ID, 34206, 3, 16723),
      xml('toolu_sendmessage_id', 57661, 8, 106180),
    ]);
    expect(subs).toHaveLength(1);
    expect(subs[0].latest?.totalTokens).toBe(57661);
    expect(subs[0].latest?.toolUses).toBe(8);
    expect(subs[0].latest?.durationMs).toBe(106180);
  });

  describe('resuming a finished agent (SendMessage)', () => {
    // Resuming keys the eventual notification to the SendMessage's tool_use_id
    // (handled above by the task-id fallback), but the row also has to go BACK
    // to running for the duration of the resumed work — otherwise it reads
    // "completed" while the agent is demonstrably busy. The signal is the
    // SendMessage result's `toolUseResult.resumedAgentId`, which carries the
    // same id the notifications use as <task-id>. Verified in session b1a9cc55.
    const AGENT_ID = 'a65a69b5b316a0611';

    function sendMessageResult(agentId: string, opts: { enrichment?: boolean } = {}): JsonlNode {
      const payload = JSON.stringify({
        success: true,
        message: `Resuming agent ${agentId.slice(0, 7)}`,
        resumedAgentId: agentId,
      });
      const node = {
        kind: 'user', userKind: 'tool-result', sessionId: '', receivedAt: '',
        raw: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_sendmessage', content: [{ type: 'text', text: payload }] },
            ],
          },
        },
      } as unknown as { raw: Record<string, unknown> };
      if (opts.enrichment) {
        node.raw.toolUseResult = { success: true, resumedAgentId: agentId };
      }
      return node as unknown as JsonlNode;
    }

    /** A finished row whose taskId is AGENT_ID. */
    const finished = () => [
      bashBg(TOOL_USE_ID, 'map sessions'),
      bgAck(TOOL_USE_ID),
      {
        kind: 'unknown', sessionId: '', receivedAt: '',
        raw: {
          type: 'queue-operation',
          operation: 'enqueue',
          content: [
            '<task-notification>',
            `<task-id>${AGENT_ID}</task-id>`,
            `<tool-use-id>${TOOL_USE_ID}</tool-use-id>`,
            '<status>completed</status>',
            '<summary>Agent "map sessions" finished</summary>',
            '<usage><subagent_tokens>42632</subagent_tokens><tool_uses>5</tool_uses><duration_ms>53971</duration_ms></usage>',
            '</task-notification>',
          ].join('\n'),
        },
      } as unknown as JsonlNode,
    ];

    it('puts a completed row back to running', () => {
      const done = deriveSubagents(finished());
      expect(done[0].status).toBe('completed');

      const resumed = deriveSubagents([...finished(), sendMessageResult(AGENT_ID, { enrichment: true })]);
      expect(resumed).toHaveLength(1);
      expect(resumed[0].status).toBe('running');
      expect(resumed[0].endedAt).toBeUndefined();
      expect(resumed[0].closureSource).toBeUndefined();
    });

    it('detects the resume from the result text when the enrichment is absent', () => {
      const resumed = deriveSubagents([...finished(), sendMessageResult(AGENT_ID)]);
      expect(resumed[0].status).toBe('running');
    });

    it('closes again, with the resumed run\'s totals, when the next notification lands', () => {
      const subs = deriveSubagents([
        ...finished(),
        sendMessageResult(AGENT_ID, { enrichment: true }),
        {
          kind: 'unknown', sessionId: '', receivedAt: '',
          raw: {
            type: 'queue-operation',
            operation: 'enqueue',
            content: [
              '<task-notification>',
              `<task-id>${AGENT_ID}</task-id>`,
              '<tool-use-id>toolu_sendmessage</tool-use-id>',
              '<status>completed</status>',
              '<summary>Agent "map sessions" finished</summary>',
              '<usage><subagent_tokens>56192</subagent_tokens><tool_uses>11</tool_uses><duration_ms>182029</duration_ms></usage>',
              '</task-notification>',
            ].join('\n'),
          },
        } as unknown as JsonlNode,
      ]);
      expect(subs).toHaveLength(1);
      expect(subs[0].status).toBe('completed');
      expect(subs[0].latest?.totalTokens).toBe(56192);
    });

    it('is not closed by a parent result that predates the resume', () => {
      // The inferred-closure rule closes a running row once the parent has
      // advanced past a `result`. After a resume, only results AFTER the
      // resume say anything about the new run — the earlier one belongs to
      // the turn that already finished.
      const subs = deriveSubagents([
        bashBg(TOOL_USE_ID, 'map sessions'),
        bgAck(TOOL_USE_ID),
        { kind: 'cli-stream-result', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'success' } } as any,
        ...finished().slice(2),
        sendMessageResult(AGENT_ID, { enrichment: true }),
        { kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '', raw: { type: 'user', message: { content: [{ type: 'text', text: 'next' }] } } } as any,
      ]);
      expect(subs[0].status).toBe('running');
    });

    it('ignores a resume naming an agent we have no row for', () => {
      // SendMessage also addresses other Claude SESSIONS (CLI 2.1.232's @-mention),
      // where `to` is a session name and no subagent row should react.
      const subs = deriveSubagents([...finished(), sendMessageResult('some-other-session', { enrichment: true })]);
      expect(subs).toHaveLength(1);
      expect(subs[0].status).toBe('completed');
    });
  });

  it('ignores an XML notification whose tool-use-id AND task-id are both unknown', () => {
    // The orphan guard still holds: notifications routinely name tool_uses
    // from earlier turns we do not have in scope, and inventing rows for them
    // would litter the bar.
    const subs = deriveSubagents([
      bashBg(TOOL_USE_ID, 'compare'),
      bgAck(TOOL_USE_ID),
      queueOp('toolu_never_seen', 'completed', 'from another turn'),
    ]);
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe('running');
  });

  it('closes cleanly when the XML carries no <usage> block', () => {
    const subs = deriveSubagents([
      bashBg(TOOL_USE_ID, 'verify gate'),
      bgAck(TOOL_USE_ID),
      queueOp(TOOL_USE_ID, 'completed', 'verify gate done'),
    ]);
    expect(subs[0].status).toBe('completed');
    expect(subs[0].latest?.totalTokens).toBeUndefined();
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

  // A forwarded frame in which the SUBAGENT dispatches its own background
  // shell. Its `parent_tool_use_id` is the only carrier of who owns the
  // resulting task — the `task_started` that follows names the shell's own
  // tool_use_id and says `owned_by_subagent: true`, but never the owner.
  function forwardedAssistantToolUse(parentToolUseId: string, toolUseId: string, description: string): JsonlNode {
    return {
      kind: 'assistant', sessionId: '', receivedAt: '',
      raw: {
        type: 'assistant',
        parent_tool_use_id: parentToolUseId,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'sleep 40', description, run_in_background: true } }],
        },
      },
    } as unknown as JsonlNode;
  }

  function ownedTaskStarted(toolUseId: string, taskId: string, description: string): JsonlNode {
    return {
      kind: 'unknown', sessionId: '', receivedAt: '',
      raw: {
        type: 'system',
        subtype: 'task_started',
        task_id: taskId,
        owned_by_subagent: true,
        tool_use_id: toolUseId,
        description,
        task_type: 'local_bash',
      },
    } as unknown as JsonlNode;
  }

  it('nests a subagent-owned background task under the agent that started it', () => {
    // Verified against a live 2.1.235 stream: an agent that backgrounds its
    // own shell produced a second TOP-LEVEL row in the parent session's bar,
    // labelled with the shell's description ("Sleep 40 seconds in
    // background") and indistinguishable from a real agent.
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID, 'probe owner', 'general-purpose', false),
      toolResult(TOOL_USE_ID, false, 'Async agent launched successfully.'),
      forwardedAssistantToolUse(TOOL_USE_ID, TOOL_USE_ID_2, 'Sleep 40 seconds in background'),
      ownedTaskStarted(TOOL_USE_ID_2, 'bnncsuaov', 'Sleep 40 seconds in background'),
    ]);
    expect(subs).toHaveLength(2);
    const owner = subs.find((s) => s.toolUseId === TOOL_USE_ID);
    const owned = subs.find((s) => s.toolUseId === TOOL_USE_ID_2);
    expect(owned?.parentToolUseId).toBe(TOOL_USE_ID);
    // Nested rows share the owner's colour — the indent is what tells them
    // apart from a sibling (see SubagentBar).
    expect(owned?.colorIndex).toBe(owner?.colorIndex);
    // ...and render directly beneath their owner.
    expect(subs[0].toolUseId).toBe(TOOL_USE_ID);
    expect(subs[1].toolUseId).toBe(TOOL_USE_ID_2);
  });

  it('nests an owned task even when task_started arrives before the frame naming its owner', () => {
    // This is the real arrival order, not a hypothetical: the engine's
    // assistant resolver buffers each committed frame on its own
    // parent-chain key and flushes it only when that chain emits again, so
    // the subagent's `task_started` reaches the renderer first. Harvesting
    // ownership inline while walking messages nested nothing on a recorded
    // 2.1.235 stream; the pre-pass is what makes it order-independent.
    const subs = deriveSubagents([
      agentToolUse(TOOL_USE_ID, 'probe owner', 'general-purpose', false),
      toolResult(TOOL_USE_ID, false, 'Async agent launched successfully.'),
      ownedTaskStarted(TOOL_USE_ID_2, 'bnncsuaov', 'Sleep 40 seconds in background'),
      forwardedAssistantToolUse(TOOL_USE_ID, TOOL_USE_ID_2, 'Sleep 40 seconds in background'),
    ]);
    expect(subs.find((s) => s.toolUseId === TOOL_USE_ID_2)?.parentToolUseId).toBe(TOOL_USE_ID);
  });

  it('leaves an owned task at top level when its owner was never dispatched', () => {
    // A visible orphan beats a task that ran invisibly — e.g. the owner's
    // dispatch fell outside the loaded history.
    const subs = deriveSubagents([
      forwardedAssistantToolUse('toolu_MISSING_OWNER', TOOL_USE_ID_2, 'Sleep 40 seconds in background'),
      ownedTaskStarted(TOOL_USE_ID_2, 'bnncsuaov', 'Sleep 40 seconds in background'),
    ]);
    expect(subs).toHaveLength(1);
    expect(subs[0].toolUseId).toBe(TOOL_USE_ID_2);
    expect(subs[0].colorIndex).toBeGreaterThanOrEqual(0);
  });

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
