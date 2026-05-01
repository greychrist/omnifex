import { describe, it, expect } from 'vitest';
import type { ClaudeStreamMessage } from '@/types/claudeStream';
import {
  getLatestTodos,
  summarizeTodos,
  todosKey,
  type TodoItem,
} from '../latestTodos';

function todoWriteMsg(todos: TodoItem[], name = 'TodoWrite'): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name, input: { todos } }],
      stop_reason: 'tool_use',
    },
  } as unknown as ClaudeStreamMessage;
}

function readMsg(): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a' } }],
      stop_reason: 'tool_use',
    },
  } as unknown as ClaudeStreamMessage;
}

describe('getLatestTodos', () => {
  it('returns null on empty input', () => {
    expect(getLatestTodos([])).toBeNull();
  });

  it('returns null when no TodoWrite is present', () => {
    expect(getLatestTodos([readMsg(), readMsg()])).toBeNull();
  });

  it('returns the most recent TodoWrite todos array', () => {
    const first: TodoItem[] = [{ content: 'first', status: 'pending' }];
    const second: TodoItem[] = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ];
    const result = getLatestTodos([
      todoWriteMsg(first),
      readMsg(),
      todoWriteMsg(second),
    ]);
    expect(result).toEqual(second);
  });

  it('matches tool name case-insensitively', () => {
    const todos: TodoItem[] = [{ content: 'x', status: 'pending' }];
    expect(getLatestTodos([todoWriteMsg(todos, 'todowrite')])).toEqual(todos);
    expect(getLatestTodos([todoWriteMsg(todos, 'TODOWRITE')])).toEqual(todos);
  });

  it('returns null when input.todos is missing or empty', () => {
    const empty = todoWriteMsg([]);
    const missing = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: {} }] },
    } as unknown as ClaudeStreamMessage;
    expect(getLatestTodos([empty])).toBeNull();
    expect(getLatestTodos([missing])).toBeNull();
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
