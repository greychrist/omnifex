import React, { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Bot,
  CheckCircle2,
  CircleDashed,
  AlertCircle,
  Ghost,
  X,
  ListChecks,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Subagent } from '@/lib/subagentStreams';

const COLLAPSE_STORAGE_KEY = 'greychrist.subagentBar.collapsed';

// 16-slot palette — one distinct hue per slot so concurrent subagents never
// share a colour until all 16 are live simultaneously (extremely rare).
// The allocator in subagentStreams guarantees ordered assignment so slot 0
// always goes to the first dispatched subagent, slot 1 to the second, etc.
const PALETTE: { border: string; bg: string; dot: string; text: string }[] = [
  // 0–5 original set
  { border: 'border-sky-400/40',     bg: 'bg-sky-400/10',     dot: 'bg-sky-400',     text: 'text-sky-400' },
  { border: 'border-indigo-400/40',  bg: 'bg-indigo-400/10',  dot: 'bg-indigo-400',  text: 'text-indigo-400' },
  { border: 'border-cyan-400/40',    bg: 'bg-cyan-400/10',    dot: 'bg-cyan-400',    text: 'text-cyan-400' },
  { border: 'border-teal-400/40',    bg: 'bg-teal-400/10',    dot: 'bg-teal-400',    text: 'text-teal-400' },
  { border: 'border-violet-400/40',  bg: 'bg-violet-400/10',  dot: 'bg-violet-400',  text: 'text-violet-400' },
  { border: 'border-emerald-400/40', bg: 'bg-emerald-400/10', dot: 'bg-emerald-400', text: 'text-emerald-400' },
  // 6–15 ten new hues, evenly spaced around the wheel
  { border: 'border-rose-400/40',    bg: 'bg-rose-400/10',    dot: 'bg-rose-400',    text: 'text-rose-400' },
  { border: 'border-orange-400/40',  bg: 'bg-orange-400/10',  dot: 'bg-orange-400',  text: 'text-orange-400' },
  { border: 'border-amber-400/40',   bg: 'bg-amber-400/10',   dot: 'bg-amber-400',   text: 'text-amber-400' },
  { border: 'border-lime-400/40',    bg: 'bg-lime-400/10',    dot: 'bg-lime-400',    text: 'text-lime-400' },
  { border: 'border-green-400/40',   bg: 'bg-green-400/10',   dot: 'bg-green-400',   text: 'text-green-400' },
  { border: 'border-blue-400/40',    bg: 'bg-blue-400/10',    dot: 'bg-blue-400',    text: 'text-blue-400' },
  { border: 'border-purple-400/40',  bg: 'bg-purple-400/10',  dot: 'bg-purple-400',  text: 'text-purple-400' },
  { border: 'border-fuchsia-400/40', bg: 'bg-fuchsia-400/10', dot: 'bg-fuchsia-400', text: 'text-fuchsia-400' },
  { border: 'border-pink-400/40',    bg: 'bg-pink-400/10',    dot: 'bg-pink-400',    text: 'text-pink-400' },
  { border: 'border-yellow-400/40',  bg: 'bg-yellow-400/10',  dot: 'bg-yellow-400',  text: 'text-yellow-400' },
];

function formatElapsed(ms?: number): string {
  if (!ms || ms <= 0) return '';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`;
}

interface SubagentRowProps {
  sub: Subagent;
  onDismiss?: (toolUseId: string) => void;
}

const SubagentRow: React.FC<SubagentRowProps> = ({ sub, onDismiss }) => {
  const [expanded, setExpanded] = useState(false);
  const color = PALETTE[sub.colorIndex % PALETTE.length];
  const latest = sub.latest;
  const dim = sub.status !== 'running';
  const dismissable = onDismiss && sub.status !== 'running';

  const statusIcon =
    sub.status === 'completed' ? (
      // Mirrors the TaskList's completed row — green check, not the
      // per-subagent palette color, so "done" reads the same way across
      // both bars at a glance.
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
    ) : sub.status === 'completed_inferred' ? (
      // Distinct icon for inferred completion — the parent emitted a
      // `result` and moved on, but we never received a direct closure
      // carrier (task_notification SystemMessage or
      // queue-operation/attachment XML). The work is done, but we lack
      // the summary/usage data the carriers would have provided. The
      // dashed-ring variant makes this visible at a glance vs the solid
      // CheckCircle2 used for verified completions.
      <span title="Completion inferred from parent result — no task-notification was delivered.">
        <CircleDashed className={cn('h-3.5 w-3.5', color.text, 'opacity-60')} />
      </span>
    ) : sub.status === 'failed' ? (
      <AlertCircle className="h-3.5 w-3.5 text-destructive" />
    ) : sub.status === 'abandoned' ? (
      <span title="Session ended before this returned">
        <Ghost className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
    ) : (
      <span className={cn('inline-block h-2 w-2 rounded-full animate-pulse', color.dot)} />
    );

  const tokens = latest?.totalTokens ? `${Math.round(latest.totalTokens / 1000)}k tok` : '';
  const tools = latest?.toolUses ? `${latest.toolUses} tools` : '';
  const elapsed = formatElapsed(latest?.durationMs);
  const metaBits = [tools, tokens, elapsed].filter(Boolean).join(' · ');

  const headline = latest?.description || sub.description || 'Working…';
  const agentLabel = sub.agentType ?? 'Agent';

  return (
    <div
      className={cn(
        'border-l-2 transition-opacity',
        color.border,
        color.bg,
        dim && 'opacity-60',
      )}
    >
      <button
        type="button"
        onClick={() => { setExpanded((v) => !v); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-white/5"
      >
        <span className="flex items-center justify-center w-4 shrink-0">{statusIcon}</span>
        <Bot className={cn('h-3.5 w-3.5 shrink-0', color.text)} />
        <span className={cn('font-mono font-medium shrink-0', color.text)}>{agentLabel}</span>
        <span className="text-muted-foreground shrink-0">·</span>
        <span className="truncate flex-1 text-foreground/90">{headline}</span>
        {metaBits && (
          <span className="text-muted-foreground shrink-0 tabular-nums">{metaBits}</span>
        )}
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        {dismissable && (
          <span
            role="button"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(sub.toolUseId);
            }}
            className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-white/10 shrink-0"
          >
            <X className="h-3 w-3" />
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-2 pt-0.5 border-t border-white/5 space-y-0.5">
          {sub.events.length === 0 && (
            <div className="text-[11px] text-muted-foreground italic py-1">
              {sub.status === 'completed_inferred'
                ? 'Completed (no progress reported)'
                : 'Waiting for first progress event…'}
            </div>
          )}
          {sub.events.map((ev, i) => {
            const bits = [
              ev.lastToolName,
              ev.toolUses ? `${ev.toolUses} tools` : '',
              ev.totalTokens ? `${Math.round(ev.totalTokens / 1000)}k tok` : '',
              formatElapsed(ev.durationMs),
            ].filter(Boolean).join(' · ');
            return (
              <div key={i} className="flex items-start gap-2 text-[11px] font-mono leading-snug">
                <span className={cn('mt-[5px] h-1 w-1 rounded-full shrink-0', color.dot)} />
                <span className="flex-1 text-foreground/80 break-words">{ev.description || '…'}</span>
                {bits && <span className="text-muted-foreground shrink-0 tabular-nums">{bits}</span>}
              </div>
            );
          })}
          {sub.status === 'completed' && sub.summary && (
            <div className="flex items-start gap-2 text-[11px] pt-1">
              <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0 text-emerald-400" />
              <span className="text-foreground/70 italic">{sub.summary}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

interface SubagentBarProps {
  subagents: Subagent[];
  className?: string;
  onDismiss?: (toolUseId: string) => void;
  onDismissAllCompleted?: () => void;
}

export const SubagentBar: React.FC<SubagentBarProps> = ({
  subagents,
  className,
  onDismiss,
  onDismissAllCompleted,
}) => {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    // Collapsed by default; only expand if the user has explicitly stored '0'.
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) !== '0';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  if (subagents.length === 0) return null;
  const total = subagents.length;
  const runningCount = subagents.filter((s) => s.status === 'running').length;
  const doneCount = total - runningCount;
  const running = runningCount > 0;
  const expanded = !collapsed;

  // Mirrors TaskList's header status icon: green ListChecks at rest,
  // spinning Loader2 while any subagent is running.
  const StatusIcon = running ? Loader2 : ListChecks;
  const statusIconClass = cn(
    'h-3.5 w-3.5',
    running ? 'text-muted-foreground animate-spin' : 'text-emerald-400',
  );

  return (
    <div className={cn('shrink-0 flex flex-col', className)}>
      {/* Header — laid out identically to the TaskList header so the two
          bars feel like the same thing in different domains. */}
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
            onClick={() => { setCollapsed((v) => !v); }}
            className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
            title={expanded ? 'Collapse subagents' : 'Expand subagents'}
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
            <Bot className="h-3.5 w-3.5 text-foreground" />
            <span className="font-medium text-foreground">Subagents:</span>
            <span className="text-foreground/90 tabular-nums">
              {doneCount}/{total} done
            </span>
            {runningCount > 0 && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-sky-400/40 bg-sky-400/10 text-sky-400 tabular-nums">
                <Loader2 className="h-3 w-3 animate-spin" />
                {runningCount} running
              </span>
            )}
            <StatusIcon className={statusIconClass} />
          </button>
          {onDismissAllCompleted && (
            <button
              type="button"
              onClick={onDismissAllCompleted}
              disabled={doneCount === 0}
              className={cn(
                'ml-auto inline-flex items-center px-1.5 py-0.5 rounded border border-border/60 bg-background',
                'text-muted-foreground hover:text-foreground hover:bg-accent transition-colors',
                'disabled:opacity-30 disabled:hover:bg-background disabled:cursor-not-allowed',
              )}
              title={doneCount > 0 ? `Clear ${doneCount} done` : 'No completed subagents'}
            >
              Clear done{doneCount > 0 ? ` (${doneCount})` : ''}
            </button>
          )}
        </div>
      </div>

      {/* Scrollable list — capped at half the viewport */}
      {expanded && (
        <div className="overflow-y-auto bg-background/95" style={{ maxHeight: '50vh' }}>
          {subagents.map((sub) => (
            <SubagentRow key={sub.toolUseId} sub={sub} onDismiss={onDismiss} />
          ))}
        </div>
      )}
    </div>
  );
};
