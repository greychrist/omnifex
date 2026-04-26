import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ClaudeStreamMessage } from '@/types/claudeStream';
import {
  deriveSubagents,
  clearCompleted,
  isTaskLifecycleMarker,
  colorIndexFor,
  SUBAGENT_PALETTE_SIZE,
} from '../subagentStreams';

const TOOL_USE_ID = 'toolu_TEST_1';
const TOOL_USE_ID_2 = 'toolu_TEST_2';

function agentToolUse(id: string, description = 'Explore repo', subagentType = 'Explore'): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Agent',
          input: { description, subagent_type: subagentType, prompt: 'go' },
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
