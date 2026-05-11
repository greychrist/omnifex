import type { ClaudeStreamMessage } from '@/types/claudeStream';

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

export function getLatestTodos(messages: ClaudeStreamMessage[]): TodoItem[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type !== 'assistant') continue;
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block?.type === 'tool_use' &&
        typeof block?.name === 'string' &&
        block.name.toLowerCase() === 'todowrite'
      ) {
        // BetaToolUseBlock.input is typed as `unknown` (tool-shape-specific).
        const input = (block.input ?? {}) as { todos?: unknown };
        const todos = input.todos;
        if (Array.isArray(todos) && todos.length > 0) {
          return todos as TodoItem[];
        }
        return null;
      }
    }
  }
  return null;
}

export function summarizeTodos(todos: TodoItem[]): {
  done: number;
  total: number;
  running: boolean;
} {
  let done = 0;
  let running = false;
  for (const t of todos) {
    if (t.status === 'completed' || t.status === 'cancelled') done += 1;
    else if (t.status === 'pending' || t.status === 'in_progress') running = true;
  }
  return { done, total: todos.length, running };
}

export function todosKey(todos: TodoItem[] | null): string {
  if (todos === null) return '__null__';
  return JSON.stringify(todos.map((t) => [t.content, t.status]));
}
