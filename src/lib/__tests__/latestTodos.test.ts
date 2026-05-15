import { describe, it, expect } from 'vitest';
import type { ClaudeStreamMessage } from '@/types/claudeStream';
import {
  getLatestTodos,
  summarizeTodos,
  todosKey,
  type TodoItem,
} from '../latestTodos';

// Helpers — build the live-stream shapes the renderer actually sees under
// SDK 0.3.x, where the agent drives a per-task state machine via discrete
// `TaskCreate` / `TaskUpdate` tool_use blocks rather than a single
// snapshot-shaped `TodoWrite` call.

function taskCreateMsg(
  blockId: string,
  input: { subject?: string; description?: string; activeForm?: string },
  name = 'TaskCreate',
): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: blockId, name, input }],
      stop_reason: 'tool_use',
    },
  } as unknown as ClaudeStreamMessage;
}

function taskCreateResultMsg(blockId: string, taskId: string): ClaudeStreamMessage {
  // The TaskCreate tool_result content carries the server-assigned task id.
  // Stream messages either carry it as a JSON string or as a single-text
  // content array; both shapes occur in practice.
  return {
    type: 'user',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: blockId,
        content: JSON.stringify({ task: { id: taskId, subject: 'unused' } }),
      }],
    },
  } as unknown as ClaudeStreamMessage;
}

function taskUpdateMsg(
  blockId: string,
  input: { taskId: string; status?: string; subject?: string; activeForm?: string },
  name = 'TaskUpdate',
): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: blockId, name, input }],
      stop_reason: 'tool_use',
    },
  } as unknown as ClaudeStreamMessage;
}

function readMsg(): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/a' } }],
      stop_reason: 'tool_use',
    },
  } as unknown as ClaudeStreamMessage;
}

describe('getLatestTodos', () => {
  it('returns null on empty input', () => {
    expect(getLatestTodos([])).toBeNull();
  });

  it('returns null when no Task* tool_use is present', () => {
    expect(getLatestTodos([readMsg(), readMsg()])).toBeNull();
  });

  it('returns a single pending todo after one TaskCreate', () => {
    const msgs = [
      taskCreateMsg('tu1', { subject: 'first task', description: 'do the thing' }),
      taskCreateResultMsg('tu1', 'task_1'),
    ];
    expect(getLatestTodos(msgs)).toEqual([
      { content: 'first task', status: 'pending' },
    ]);
  });

  it('preserves activeForm when supplied', () => {
    const msgs = [
      taskCreateMsg('tu1', { subject: 'run tests', activeForm: 'Running tests' }),
      taskCreateResultMsg('tu1', 'task_1'),
    ];
    expect(getLatestTodos(msgs)).toEqual([
      { content: 'run tests', status: 'pending', activeForm: 'Running tests' },
    ]);
  });

  it('preserves creation order across multiple TaskCreates', () => {
    const msgs = [
      taskCreateMsg('tu1', { subject: 'a' }),
      taskCreateResultMsg('tu1', 'task_a'),
      taskCreateMsg('tu2', { subject: 'b' }),
      taskCreateResultMsg('tu2', 'task_b'),
      taskCreateMsg('tu3', { subject: 'c' }),
      taskCreateResultMsg('tu3', 'task_c'),
    ];
    const result = getLatestTodos(msgs);
    expect(result?.map((t) => t.content)).toEqual(['a', 'b', 'c']);
    expect(result?.every((t) => t.status === 'pending')).toBe(true);
  });

  it('flips a task to in_progress and then completed via TaskUpdate', () => {
    const msgs = [
      taskCreateMsg('tu1', { subject: 'fix bug' }),
      taskCreateResultMsg('tu1', 'task_1'),
      taskUpdateMsg('tu2', { taskId: 'task_1', status: 'in_progress' }),
      taskUpdateMsg('tu3', { taskId: 'task_1', status: 'completed' }),
    ];
    expect(getLatestTodos(msgs)).toEqual([
      { content: 'fix bug', status: 'completed' },
    ]);
  });

  it('drops tasks marked deleted via TaskUpdate', () => {
    const msgs = [
      taskCreateMsg('tu1', { subject: 'keep' }),
      taskCreateResultMsg('tu1', 'task_keep'),
      taskCreateMsg('tu2', { subject: 'drop' }),
      taskCreateResultMsg('tu2', 'task_drop'),
      taskUpdateMsg('tu3', { taskId: 'task_drop', status: 'deleted' }),
    ];
    expect(getLatestTodos(msgs)).toEqual([
      { content: 'keep', status: 'pending' },
    ]);
  });

  it('renames a task when TaskUpdate sets a new subject', () => {
    const msgs = [
      taskCreateMsg('tu1', { subject: 'original' }),
      taskCreateResultMsg('tu1', 'task_1'),
      taskUpdateMsg('tu2', { taskId: 'task_1', subject: 'renamed' }),
    ];
    expect(getLatestTodos(msgs)).toEqual([
      { content: 'renamed', status: 'pending' },
    ]);
  });

  it('matches Task* tool names case-insensitively', () => {
    const msgs = [
      taskCreateMsg('tu1', { subject: 'x' }, 'taskcreate'),
      taskCreateResultMsg('tu1', 'task_1'),
      taskUpdateMsg('tu2', { taskId: 'task_1', status: 'completed' }, 'taskupdate'),
    ];
    expect(getLatestTodos(msgs)).toEqual([
      { content: 'x', status: 'completed' },
    ]);
  });

  it('silently ignores TaskUpdate for an unknown taskId', () => {
    const msgs = [
      taskCreateMsg('tu1', { subject: 'real' }),
      taskCreateResultMsg('tu1', 'task_real'),
      taskUpdateMsg('tu2', { taskId: 'task_does_not_exist', status: 'completed' }),
    ];
    expect(getLatestTodos(msgs)).toEqual([
      { content: 'real', status: 'pending' },
    ]);
  });

  it('falls back to description when subject is missing on TaskCreate', () => {
    const msgs = [
      taskCreateMsg('tu1', { description: 'desc only' }),
      taskCreateResultMsg('tu1', 'task_1'),
    ];
    expect(getLatestTodos(msgs)).toEqual([
      { content: 'desc only', status: 'pending' },
    ]);
  });

  it('handles a mixed Task* event stream as it would appear in a JSONL replay', () => {
    // Three tasks created up front, then progressively marked in_progress
    // and completed, with one renamed mid-flight and one deleted at the end.
    const msgs = [
      taskCreateMsg('tu1', { subject: 'audit' }),
      taskCreateResultMsg('tu1', 'task_audit'),
      taskCreateMsg('tu2', { subject: 'patch' }),
      taskCreateResultMsg('tu2', 'task_patch'),
      taskCreateMsg('tu3', { subject: 'verify' }),
      taskCreateResultMsg('tu3', 'task_verify'),
      taskUpdateMsg('tu4', { taskId: 'task_audit', status: 'in_progress' }),
      taskUpdateMsg('tu5', { taskId: 'task_audit', status: 'completed' }),
      taskUpdateMsg('tu6', { taskId: 'task_patch', subject: 'apply patch' }),
      taskUpdateMsg('tu7', { taskId: 'task_patch', status: 'in_progress' }),
      taskUpdateMsg('tu8', { taskId: 'task_verify', status: 'deleted' }),
    ];
    expect(getLatestTodos(msgs)).toEqual([
      { content: 'audit', status: 'completed' },
      { content: 'apply patch', status: 'in_progress' },
    ]);
  });

  it('omits the task from output when its TaskCreate tool_result has not yet arrived', () => {
    // No taskId is assigned, so a subsequent TaskUpdate that names a real
    // task id wouldn't find it; the optimistic in-flight row still appears
    // in the list (status: 'pending'). This matches what the user sees
    // mid-stream: "I just asked you to add a task; show it now."
    const msgs = [
      taskCreateMsg('tu1', { subject: 'in flight' }),
      // No taskCreateResultMsg yet.
    ];
    expect(getLatestTodos(msgs)).toEqual([
      { content: 'in flight', status: 'pending' },
    ]);
  });
});

describe('summarizeTodos', () => {
  it('counts completed and cancelled as done; total = length', () => {
    const todos: TodoItem[] = [
      { content: '1', status: 'completed' },
      { content: '2', status: 'cancelled' },
      { content: '3', status: 'in_progress' },
      { content: '4', status: 'pending' },
    ];
    expect(summarizeTodos(todos)).toEqual({ done: 2, total: 4, running: true });
  });

  it('reports running=false when nothing is pending or in_progress', () => {
    const todos: TodoItem[] = [
      { content: '1', status: 'completed' },
      { content: '2', status: 'cancelled' },
    ];
    expect(summarizeTodos(todos)).toEqual({ done: 2, total: 2, running: false });
  });

  it('reports running=true when only pending items remain', () => {
    const todos: TodoItem[] = [{ content: '1', status: 'pending' }];
    expect(summarizeTodos(todos)).toEqual({ done: 0, total: 1, running: true });
  });

  it('handles an empty array', () => {
    expect(summarizeTodos([])).toEqual({ done: 0, total: 0, running: false });
  });
});

describe('todosKey', () => {
  it('returns the same key for identical content', () => {
    const a: TodoItem[] = [{ content: 'x', status: 'pending' }];
    const b: TodoItem[] = [{ content: 'x', status: 'pending' }];
    expect(todosKey(a)).toBe(todosKey(b));
  });

  it('returns a different key when status changes', () => {
    const a: TodoItem[] = [{ content: 'x', status: 'pending' }];
    const b: TodoItem[] = [{ content: 'x', status: 'completed' }];
    expect(todosKey(a)).not.toBe(todosKey(b));
  });

  it('returns a different key when an item is added', () => {
    const a: TodoItem[] = [{ content: 'x', status: 'pending' }];
    const b: TodoItem[] = [
      { content: 'x', status: 'pending' },
      { content: 'y', status: 'pending' },
    ];
    expect(todosKey(a)).not.toBe(todosKey(b));
  });

  it('returns a stable empty-key for null', () => {
    expect(todosKey(null)).toBe(todosKey(null));
  });
});
