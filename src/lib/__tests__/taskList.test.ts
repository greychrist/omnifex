import { describe, it, expect } from 'vitest';
import type { ClaudeStreamMessage } from '@/types/claudeStream';
import {
  getTaskList,
  summarizeTaskList,
  type TaskListEntry,
} from '../taskList';

// Build the live-stream shapes the renderer sees under SDK 0.3.x. The
// `taskCreateResultMsg` helper uses the LIVE wire format (content string
// only, no envelope) so attribution + parsing are exercised against the
// real shape end to end. Verified against
// ~/.claude-personal/projects/-Users-gregorychristie-Repos-personal-WIN/
// real session JSONL.

function taskCreateMsg(
  blockId: string,
  input: { subject?: string; description?: string; activeForm?: string },
): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: blockId, name: 'TaskCreate', input }],
      stop_reason: 'tool_use',
    },
  } as unknown as ClaudeStreamMessage;
}

function taskCreateResultMsg(blockId: string, taskId: string): ClaudeStreamMessage {
  return {
    type: 'user',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: blockId,
        content: `Task #${taskId} created successfully: unused`,
      }],
    },
  } as unknown as ClaudeStreamMessage;
}

function taskUpdateMsg(
  blockId: string,
  input: { taskId: string; status?: string; subject?: string; activeForm?: string },
): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: blockId, name: 'TaskUpdate', input }],
      stop_reason: 'tool_use',
    },
  } as unknown as ClaudeStreamMessage;
}

/** A plain assistant text block — the kind of message that should get
 *  attributed to the task that is currently in_progress at the time it
 *  was emitted. */
function assistantText(text: string): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    },
  } as unknown as ClaudeStreamMessage;
}

/** An unrelated tool_use (e.g. Read) that should get attributed to the
 *  currently-in_progress task. */
function readToolUse(blockId: string, file: string): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: blockId, name: 'Read', input: { file_path: file } }],
      stop_reason: 'tool_use',
    },
  } as unknown as ClaudeStreamMessage;
}

describe('getTaskList', () => {
  it('returns null on empty input', () => {
    expect(getTaskList([])).toBeNull();
  });

  it('returns null when no Task* tool_use is present', () => {
    expect(getTaskList([assistantText('hi'), readToolUse('r1', '/a')])).toBeNull();
  });

  it('returns one pending task with no attributed messages after a single TaskCreate', () => {
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'first task' }),
      taskCreateResultMsg('tu1', '1'),
    ]);
    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({
      id: '1',
      subject: 'first task',
      status: 'pending',
      messageIndices: [],
    });
    expect(result?.[0].messages).toEqual([]);
  });

  it('preserves activeForm on a TaskCreate', () => {
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'run tests', activeForm: 'Running tests' }),
      taskCreateResultMsg('tu1', '1'),
    ]);
    expect(result?.[0].activeForm).toBe('Running tests');
  });

  it('preserves creation order across multiple TaskCreates', () => {
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'a' }),
      taskCreateResultMsg('tu1', '1'),
      taskCreateMsg('tu2', { subject: 'b' }),
      taskCreateResultMsg('tu2', '2'),
      taskCreateMsg('tu3', { subject: 'c' }),
      taskCreateResultMsg('tu3', '3'),
    ]);
    expect(result?.map((t) => t.subject)).toEqual(['a', 'b', 'c']);
  });

  it('attributes messages emitted between in_progress and completed to the running task', () => {
    const work1 = assistantText('thinking about the bug');
    const work2 = readToolUse('r1', '/src/auth.ts');
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'fix bug' }),
      taskCreateResultMsg('tu1', '1'),
      taskUpdateMsg('tu2', { taskId: '1', status: 'in_progress' }),
      work1,
      work2,
      taskUpdateMsg('tu3', { taskId: '1', status: 'completed' }),
    ]);
    expect(result).toHaveLength(1);
    expect(result?.[0].status).toBe('completed');
    expect(result?.[0].messages).toEqual([work1, work2]);
    expect(result?.[0].messageIndices).toHaveLength(2);
  });

  it('attributes nothing to a task that never went in_progress (pending → completed direct)', () => {
    const orphan = assistantText('this was emitted while nothing was in_progress');
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'fast task' }),
      taskCreateResultMsg('tu1', '1'),
      orphan,
      taskUpdateMsg('tu2', { taskId: '1', status: 'completed' }),
    ]);
    expect(result?.[0].status).toBe('completed');
    expect(result?.[0].messages).toEqual([]);
  });

  it('switches attribution when one task completes and another goes in_progress', () => {
    const aWork = assistantText('working on A');
    const bWork = assistantText('working on B');
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'task A' }),
      taskCreateResultMsg('tu1', '1'),
      taskCreateMsg('tu2', { subject: 'task B' }),
      taskCreateResultMsg('tu2', '2'),
      taskUpdateMsg('tu3', { taskId: '1', status: 'in_progress' }),
      aWork,
      taskUpdateMsg('tu4', { taskId: '1', status: 'completed' }),
      taskUpdateMsg('tu5', { taskId: '2', status: 'in_progress' }),
      bWork,
      taskUpdateMsg('tu6', { taskId: '2', status: 'completed' }),
    ]);
    expect(result?.[0].messages).toEqual([aWork]);
    expect(result?.[1].messages).toEqual([bWork]);
  });

  it('attributes nothing once the running task completes, until a new one starts', () => {
    const between = assistantText('a comment between tasks');
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'A' }),
      taskCreateResultMsg('tu1', '1'),
      taskUpdateMsg('tu2', { taskId: '1', status: 'in_progress' }),
      taskUpdateMsg('tu3', { taskId: '1', status: 'completed' }),
      between,
    ]);
    expect(result?.[0].messages).toEqual([]);
  });

  it('does NOT attribute the TaskCreate / TaskUpdate tool_uses themselves to a task row', () => {
    // The Task* tool_uses drive the state machine; rendering them as
    // attributed messages would create noisy meta-rows about the system
    // managing itself.
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'A' }),
      taskCreateResultMsg('tu1', '1'),
      taskUpdateMsg('tu2', { taskId: '1', status: 'in_progress' }),
      taskCreateMsg('tu3', { subject: 'B' }),         // emitted during A's window
      taskCreateResultMsg('tu3', '2'),                // result for B
      taskUpdateMsg('tu4', { taskId: '1', status: 'completed' }),
    ]);
    expect(result?.[0].subject).toBe('A');
    expect(result?.[0].messages).toEqual([]);
    expect(result?.[1].subject).toBe('B');
  });

  it('drops a task entirely when TaskUpdate marks it deleted, along with any attributed messages', () => {
    const drop = assistantText('this should not appear anywhere');
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'keep' }),
      taskCreateResultMsg('tu1', '1'),
      taskCreateMsg('tu2', { subject: 'drop' }),
      taskCreateResultMsg('tu2', '2'),
      taskUpdateMsg('tu3', { taskId: '2', status: 'in_progress' }),
      drop,
      taskUpdateMsg('tu4', { taskId: '2', status: 'deleted' }),
    ]);
    expect(result?.map((t) => t.subject)).toEqual(['keep']);
    expect(result?.[0].messages).toEqual([]);
  });

  it('honors a TaskUpdate that renames the subject mid-flight', () => {
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'original' }),
      taskCreateResultMsg('tu1', '1'),
      taskUpdateMsg('tu2', { taskId: '1', subject: 'renamed' }),
    ]);
    expect(result?.[0].subject).toBe('renamed');
  });
});

describe('summarizeTaskList', () => {
  function entry(status: TaskListEntry['status']): TaskListEntry {
    return { id: 'x', subject: 's', status, messages: [], messageIndices: [] };
  }

  it('counts done / in_progress / pending across the list', () => {
    expect(summarizeTaskList([
      entry('completed'),
      entry('completed'),
      entry('in_progress'),
      entry('pending'),
      entry('pending'),
    ])).toEqual({
      total: 5,
      done: 2,
      inProgress: 1,
      pending: 2,
      running: true,
    });
  });

  it('reports running=false when everything is completed', () => {
    expect(summarizeTaskList([entry('completed'), entry('completed')])).toEqual({
      total: 2, done: 2, inProgress: 0, pending: 0, running: false,
    });
  });

  it('reports running=true when only pending items remain', () => {
    expect(summarizeTaskList([entry('pending')])).toEqual({
      total: 1, done: 0, inProgress: 0, pending: 1, running: true,
    });
  });

  it('handles an empty list', () => {
    expect(summarizeTaskList([])).toEqual({
      total: 0, done: 0, inProgress: 0, pending: 0, running: false,
    });
  });
});
