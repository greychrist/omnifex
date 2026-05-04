import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Circle,
  CheckCircle2,
  XCircle,
  Loader2,
  ListChecks,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ClaudeStreamMessage } from '@/types/claudeStream';
import {
  getLatestTodos,
  summarizeTodos,
  todosKey,
  type TodoItem,
} from '@/lib/latestTodos';

const COLLAPSE_STORAGE_KEY = 'greychrist.todoBar.collapsed';

interface TodoBarProps {
  messages: ClaudeStreamMessage[];
  isLive: boolean;
  className?: string;
}

export const TodoBar: React.FC<TodoBarProps> = ({ messages, isLive, className }) => {
  const todos = useMemo(() => getLatestTodos(messages), [messages]);
  const summary = useMemo(
    () => (todos ? summarizeTodos(todos) : { done: 0, total: 0, running: false }),
    [todos],
  );
  const key = useMemo(() => todosKey(todos), [todos]);

  // Open/closed mirrors SubagentBar: user-controlled, persisted in
  // localStorage. No auto-expand on TodoWrite, no auto-collapse on a timer.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) !== '0';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  if (!isLive || todos === null || dismissedKey === key) return null;

  const expanded = !collapsed;
  const running = summary.running;

  const StatusIcon = running ? Loader2 : ListChecks;
  const statusIconClass = cn(
    'h-3.5 w-3.5',
    running ? 'text-muted-foreground animate-spin' : 'text-emerald-400',
  );
  const counter = `${summary.done} of ${summary.total} items completed`;

  return (
    <div className={cn('shrink-0 border-t border-border/40 flex flex-col', className)}>
      <div className="relative shrink-0">
        <div
          aria-hidden="true"
          className={cn(
            'absolute inset-0 bg-sky-400/15',
            running && 'animate-pulse',
          )}
        />
        <div className="relative flex items-center gap-2 px-3 py-1 text-[11px]">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            title={expanded ? 'Collapse todos' : 'Expand todos'}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5" />
            )}
            <span className="font-medium text-foreground">ToDo List:</span>
            <span className="text-foreground/90 tabular-nums">{counter}</span>
            <StatusIcon className={statusIconClass} />
          </button>
          <button
            type="button"
            onClick={() => setDismissedKey(key)}
            className={cn(
              'ml-auto inline-flex items-center px-1.5 py-0.5 rounded border border-border/60 bg-background',
              'text-muted-foreground hover:text-foreground hover:bg-accent transition-colors',
            )}
            title="Clear todo list (reappears on next TodoWrite)"
          >
            Clear
          </button>
        </div>
      </div>

      {expanded && (
        <div className="overflow-y-auto" style={{ maxHeight: '40vh' }}>
          {todos.map((todo, i) => (
            <TodoRow key={i} todo={todo} />
          ))}
        </div>
      )}
    </div>
  );
};

const TodoRow: React.FC<{ todo: TodoItem }> = ({ todo }) => {
  const done = todo.status === 'completed' || todo.status === 'cancelled';

  let glyph: React.ReactNode;
  if (todo.status === 'pending') {
    glyph = <Circle className="h-3.5 w-3.5 text-muted-foreground" />;
  } else if (todo.status === 'in_progress') {
    glyph = <Loader2 className="h-3.5 w-3.5 text-emerald-400 animate-spin" />;
  } else if (todo.status === 'completed') {
    glyph = <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
  } else {
    glyph = <XCircle className="h-3.5 w-3.5 text-muted-foreground" />;
  }

  return (
    <div
      className={cn(
        'border-l-2 border-emerald-400/40 bg-muted/20',
        'px-3 py-1.5 text-xs leading-snug flex items-center gap-2',
      )}
    >
      <span className="shrink-0">{glyph}</span>
      <span
        className={cn(
          'truncate flex-1 text-foreground/90',
          done && 'line-through text-muted-foreground',
        )}
      >
        {todo.content}
      </span>
    </div>
  );
};
