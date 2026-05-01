import React, { useEffect, useMemo, useReducer, useRef } from 'react';
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
import {
  initialTodoBarState,
  todoBarReducer,
} from '@/lib/todoBarState';

const AUTO_COLLAPSE_MS = 5000;

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

  const [state, dispatch] = useReducer(todoBarReducer, initialTodoBarState);

  const lastKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (todos === null) {
      lastKeyRef.current = null;
      return;
    }
    if (lastKeyRef.current !== key) {
      lastKeyRef.current = key;
      dispatch({ type: 'TODOS_CHANGED' });
    }
  }, [key, todos]);

  useEffect(() => {
    if (state.kind !== 'expanded_auto') return;
    const t = window.setTimeout(
      () => dispatch({ type: 'TIMER_EXPIRED' }),
      AUTO_COLLAPSE_MS,
    );
    return () => window.clearTimeout(t);
  }, [state]);

  if (!isLive || todos === null) return null;

  const expanded = state.kind !== 'collapsed_idle';
  const running = summary.running;

  const StatusIcon = running ? Loader2 : ListChecks;
  const statusIconClass = cn('h-3.5 w-3.5 text-emerald-400', running && 'animate-spin');
  const counter = running
    ? `${summary.done} of ${summary.total}`
    : `${summary.total} of ${summary.total} ✓`;

  return (
    <div className={cn('shrink-0 border-t border-border/40 flex flex-col', className)}>
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-1 text-[11px] bg-muted/20 shrink-0',
          running && 'animate-pulse',
        )}
      >
        <button
          type="button"
          onClick={() => dispatch({ type: 'CLICK' })}
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          title={expanded ? 'Collapse todos' : 'Expand todos'}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" />
          )}
          <StatusIcon className={statusIconClass} />
          <span className="font-medium text-foreground">ToDo</span>
          <span className="text-muted-foreground/70">·</span>
          <span className="text-foreground/90 tabular-nums">{counter}</span>
        </button>
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
        'border-l-2 border-emerald-400/40 bg-emerald-400/10',
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
