import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Bot, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Subagent } from '@/lib/subagentStreams';

// Cool palette — kept close to the user-message blue but distinguishable.
// Each entry: border + bg + dot/accent color. Tailwind-friendly utility strings.
const PALETTE: Array<{ border: string; bg: string; dot: string; text: string }> = [
  { border: 'border-sky-400/40',    bg: 'bg-sky-400/10',    dot: 'bg-sky-400',    text: 'text-sky-400' },
  { border: 'border-indigo-400/40', bg: 'bg-indigo-400/10', dot: 'bg-indigo-400', text: 'text-indigo-400' },
  { border: 'border-cyan-400/40',   bg: 'bg-cyan-400/10',   dot: 'bg-cyan-400',   text: 'text-cyan-400' },
  { border: 'border-teal-400/40',   bg: 'bg-teal-400/10',   dot: 'bg-teal-400',   text: 'text-teal-400' },
  { border: 'border-violet-400/40', bg: 'bg-violet-400/10', dot: 'bg-violet-400', text: 'text-violet-400' },
  { border: 'border-emerald-400/40',bg: 'bg-emerald-400/10',dot: 'bg-emerald-400',text: 'text-emerald-400' },
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
      <CheckCircle2 className={cn('h-3.5 w-3.5', color.text)} />
    ) : sub.status === 'failed' ? (
      <AlertCircle className="h-3.5 w-3.5 text-destructive" />
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
        onClick={() => setExpanded((v) => !v)}
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
              onDismiss!(sub.toolUseId);
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
              Waiting for first progress event…
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
              <CheckCircle2 className={cn('h-3 w-3 mt-0.5 shrink-0', color.text)} />
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
  if (subagents.length === 0) return null;
  const completedCount = subagents.filter((s) => s.status !== 'running').length;
  return (
    <div className={cn('shrink-0 border-t border-border/40', className)}>
      {completedCount >= 2 && onDismissAllCompleted && (
        <div className="flex justify-end px-3 py-0.5 text-[11px] bg-muted/20">
          <button
            type="button"
            onClick={onDismissAllCompleted}
            className="text-muted-foreground hover:text-foreground"
          >
            Clear done ({completedCount})
          </button>
        </div>
      )}
      {subagents.map((sub) => (
        <SubagentRow key={sub.toolUseId} sub={sub} onDismiss={onDismiss} />
      ))}
    </div>
  );
};
