import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Circle,
  CheckCircle2,
  Loader2,
  ListChecks,
  ListTodo,
  ChevronRight,
  FileText,
  Terminal,
  Wrench,
  MessageSquare,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ClaudeStreamMessage, MessageContentBlock } from '@/types/claudeStream';
import { getMessageContent } from '@/types/claudeStream';
import {
  getTaskList,
  summarizeTaskList,
  taskListKey,
  type TaskListEntry,
} from '@/lib/taskList';

const COLLAPSE_STORAGE_KEY = 'greychrist.taskList.collapsed';

interface TaskListProps {
  messages: ClaudeStreamMessage[];
  isLive: boolean;
  className?: string;
}

export const TaskList: React.FC<TaskListProps> = ({ messages, isLive, className }) => {
  const entries = useMemo(() => getTaskList(messages), [messages]);
  const summary = useMemo(
    () => (entries ? summarizeTaskList(entries) : { total: 0, done: 0, inProgress: 0, pending: 0, running: false }),
    [entries],
  );
  const key = useMemo(() => taskListKey(entries), [entries]);

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) !== '0';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  if (!isLive || entries === null || dismissedKey === key) return null;

  const expanded = !collapsed;
  const running = summary.running;

  const StatusIcon = running ? Loader2 : ListChecks;
  const statusIconClass = cn(
    'h-3.5 w-3.5',
    running ? 'text-muted-foreground animate-spin' : 'text-emerald-400',
  );

  return (
    // Header stays at the top of this block (the "drawer handle"); the
    // expanded panel grows below it in DOM order. Because the whole
    // block is shrink-0 inside ClaudeCodeSession's flex-column layout,
    // expanding pushes the chat list above us upward — the header
    // visually slides UP as the panel reveals itself.
    <div className={cn('shrink-0 flex flex-col', className)}>
      <div className="relative shrink-0 border-t border-border/40">
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
            onClick={() => { setCollapsed((c) => !c); }}
            className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
            title={expanded ? 'Collapse task list' : 'Expand task list'}
          >
            <span
              className="inline-flex items-center justify-center h-6 w-6 rounded-md border border-border bg-background shrink-0"
              aria-hidden
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronUp className="h-3.5 w-3.5" />
              )}
            </span>
            <ListTodo className="h-3.5 w-3.5 text-foreground" />
            <span className="font-medium text-foreground">Task List:</span>
            <span className="text-foreground/90 tabular-nums">
              {summary.done}/{summary.total} done
            </span>
            {summary.inProgress > 0 && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-sky-400/40 bg-sky-400/10 text-sky-400 tabular-nums">
                <Loader2 className="h-3 w-3 animate-spin" />
                {summary.inProgress} in progress
              </span>
            )}
            {summary.pending > 0 && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-border/60 bg-muted/40 text-muted-foreground tabular-nums">
                <Circle className="h-3 w-3" />
                {summary.pending} pending
              </span>
            )}
            <StatusIcon className={statusIconClass} />
          </button>
          <button
            type="button"
            onClick={() => { setDismissedKey(key); }}
            className={cn(
              'ml-auto inline-flex items-center px-1.5 py-0.5 rounded border border-border/60 bg-background',
              'text-muted-foreground hover:text-foreground hover:bg-accent transition-colors',
            )}
            title="Hide task list (reappears on the next TaskCreate or TaskUpdate)"
          >
            Clear
          </button>
        </div>
      </div>

      {expanded && (
        <div
          className="overflow-y-auto bg-background/95"
          style={{ maxHeight: '50vh' }}
        >
          {entries.map((entry) => (
            <TaskRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
};

interface TaskRowProps {
  entry: TaskListEntry;
}

const TaskRow: React.FC<TaskRowProps> = ({ entry }) => {
  const [expanded, setExpanded] = useState(false);

  const statusIcon =
    entry.status === 'completed' ? (
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
    ) : entry.status === 'in_progress' ? (
      <Loader2 className="h-3.5 w-3.5 text-sky-400 animate-spin" />
    ) : (
      <Circle className="h-3.5 w-3.5 text-muted-foreground" />
    );

  const dim = entry.status === 'completed';
  const hasMessages = entry.messages.length > 0;

  return (
    <div
      className={cn(
        'border-l-2 transition-opacity',
        entry.status === 'in_progress'
          ? 'border-sky-400/60 bg-sky-400/5'
          : entry.status === 'completed'
            ? 'border-emerald-400/40 bg-emerald-400/5'
            : 'border-border/40 bg-muted/10',
        dim && 'opacity-70',
      )}
    >
      <button
        type="button"
        onClick={() => { if (hasMessages) setExpanded((v) => !v); }}
        disabled={!hasMessages}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left',
          hasMessages ? 'hover:bg-white/5 cursor-pointer' : 'cursor-default',
        )}
      >
        <span className="flex items-center justify-center w-4 shrink-0">{statusIcon}</span>
        <span
          className={cn(
            'truncate flex-1 text-foreground/90',
            entry.status === 'completed' && 'line-through text-muted-foreground',
          )}
        >
          {entry.status === 'in_progress' && entry.activeForm
            ? entry.activeForm
            : entry.subject}
        </span>
        {hasMessages && (
          <>
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {entry.messages.length} {entry.messages.length === 1 ? 'msg' : 'msgs'}
            </span>
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
          </>
        )}
      </button>

      {expanded && hasMessages && (
        <div className="px-3 pb-2 pt-0.5 border-t border-white/5 space-y-0.5">
          {entry.messages.map((m, i) => (
            <AttributedMessage key={i} message={m} />
          ))}
        </div>
      )}
    </div>
  );
};

interface AttributedMessageProps {
  message: ClaudeStreamMessage;
}

/**
 * Minimal one-line rendering of a message that was attributed to a task.
 * Mirrors the subagent progress-event row treatment: icon + summary, no
 * heavy `<StreamMessage>` re-render inside the panel.
 */
const AttributedMessage: React.FC<AttributedMessageProps> = ({ message }) => {
  const summary = summarizeMessageForTask(message);
  const Icon = summary.icon;
  return (
    <div className="flex items-start gap-2 text-[11px] leading-snug py-0.5">
      <Icon className={cn('mt-[2px] h-3 w-3 shrink-0', summary.iconClass)} />
      <span className="flex-1 text-foreground/80 break-words">
        {summary.label}
      </span>
    </div>
  );
};

interface MessageSummary {
  icon: typeof FileText;
  iconClass: string;
  label: string;
}

function summarizeMessageForTask(m: ClaudeStreamMessage): MessageSummary {
  const content = getMessageContent(m);
  if (!Array.isArray(content)) {
    return { icon: MessageSquare, iconClass: 'text-muted-foreground', label: '…' };
  }
  const blocks = content as MessageContentBlock[];

  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'tool_use') {
      const name = b.name ?? 'tool';
      return {
        icon: pickToolIcon(name),
        iconClass: 'text-amber-400/80',
        label: `${name}${describeToolInput(name, b.input)}`,
      };
    }
    if (b.type === 'tool_result') {
      const preview = typeof b.content === 'string'
        ? b.content.slice(0, 120)
        : 'tool result';
      return {
        icon: Wrench,
        iconClass: 'text-muted-foreground',
        label: b.is_error ? `Error: ${preview}` : `Result: ${preview}`,
      };
    }
    if (b.type === 'text' && b.text.trim()) {
      return {
        icon: MessageSquare,
        iconClass: 'text-sky-400/80',
        label: b.text.replace(/\s+/g, ' ').trim().slice(0, 200),
      };
    }
    if (b.type === 'thinking' && b.thinking.trim()) {
      return {
        icon: MessageSquare,
        iconClass: 'text-violet-400/60',
        label: `(thinking) ${b.thinking.replace(/\s+/g, ' ').trim().slice(0, 160)}`,
      };
    }
  }

  return { icon: MessageSquare, iconClass: 'text-muted-foreground', label: '…' };
}

function pickToolIcon(name: string): typeof FileText {
  const n = name.toLowerCase();
  if (n === 'bash') return Terminal;
  if (n === 'read' || n === 'write' || n === 'edit' || n === 'multiedit') return FileText;
  return Wrench;
}

function describeToolInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input || typeof input !== 'object') return '';
  const n = name.toLowerCase();
  if (n === 'bash' && typeof input.command === 'string') {
    return `: ${input.command.slice(0, 80)}`;
  }
  if ((n === 'read' || n === 'write' || n === 'edit' || n === 'multiedit') && typeof input.file_path === 'string') {
    return `: ${input.file_path}`;
  }
  if (n === 'grep' && typeof input.pattern === 'string') {
    return `: /${input.pattern.slice(0, 60)}/`;
  }
  if (n === 'glob' && typeof input.pattern === 'string') {
    return `: ${input.pattern}`;
  }
  return '';
}

