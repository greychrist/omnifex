
import { ServerCog, Brain } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSecondTick } from '@/hooks/useSecondTick';
import { AgentCountGlyph } from '@/components/AgentCountGlyph';
import { formatToolElapsed } from '@/components/claude/tools/ToolProgressChip';
import type { SessionActivity } from '@/lib/signals/emitters';
import type { SessionSignal } from '@/lib/signals/types';

/**
 * `12.4k`, matching the context gauge directly above this row.
 *
 * Not `formatTokens` from contextPressure: that rounds to the nearest
 * thousand, so a 12,400-token burst and a 12,000-token one both read `12k`.
 * At the scale a single thinking burst lives at, the decimal is the signal.
 */
function formatThinkingTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export interface SessionStatusBarProps {
  /** The `session.activity` state signal, or undefined before one exists. */
  activitySignal?: SessionSignal;
  /** Running, non-ambient subagents — `countActiveSubagents`. */
  activeSubagents: number;
  className?: string;
}

interface ActivityMeta {
  status?: SessionActivity;
  thinkingTokens?: number | null;
  turnStartedAt?: number | null;
  lastTurnMs?: number | null;
  lastThinkingTokens?: number | null;
}

/**
 * The session widget's bottom row: what the session is doing, as glyphs.
 *
 * Three orthogonal facts, one icon each, rather than one pill that blurs them.
 * Each glyph renders only when it has a number to show — a fresh session shows
 * an empty bar rather than three zeroes — and each pulses only while its own
 * thing is live.
 *
 * Both readouts hold the PREVIOUS round's value while idle. That is the point:
 * how long the turn took, and how much it thought, are most worth reading in
 * the moment just after the turn that produced them ends. `ActivityPill` keeps
 * the `usage-limit` case, which is an alarm rather than a metric and so stays
 * a labelled pill.
 */
export function SessionStatusBar({
  activitySignal,
  activeSubagents,
  className,
}: SessionStatusBarProps) {
  const meta = activitySignal?.meta as ActivityMeta | undefined;
  const status = meta?.status;

  const turnStartedAt = meta?.turnStartedAt ?? null;
  const running = turnStartedAt !== null;

  // Only subscribe to the shared clock while a turn is actually counting.
  const nowMs = useSecondTick(running);

  const elapsedMs = running
    ? Math.max(0, nowMs - turnStartedAt)
    : (meta?.lastTurnMs ?? null);

  // The live burst total wins over the frozen one: mid-burst, the frozen value
  // is the PREVIOUS burst and showing it would be stale by a whole round.
  const thinkingTokens = meta?.thinkingTokens ?? meta?.lastThinkingTokens ?? null;

  const thinkingLive = status === 'thinking';
  const showWorking = elapsedMs !== null;
  const showThinking = thinkingTokens !== null;
  const showAgents = activeSubagents > 0;

  if (!showWorking && !showThinking && !showAgents) return null;

  return (
    <div className={cn('flex items-center gap-2.5 px-2 text-[10px] font-mono tabular-nums', className)}>
      {showWorking && (
        <span
          aria-label={running ? 'working' : 'working — last round'}
          title={running ? 'A turn is in flight' : 'How long the previous turn took'}
          className={cn(
            'inline-flex items-center gap-1 text-emerald-400',
            running && 'animate-pulse',
          )}
        >
          <ServerCog className="h-3.5 w-3.5" />
          {formatToolElapsed(elapsedMs / 1000)}
        </span>
      )}
      {showThinking && (
        <span
          aria-label={thinkingLive ? 'thinking' : 'thinking — last burst'}
          title={
            thinkingLive
              ? 'Extended thinking in progress'
              : "The previous turn's thinking burst"
          }
          className={cn(
            'inline-flex items-center gap-1 text-violet-400',
            thinkingLive && 'animate-pulse',
          )}
        >
          <Brain className="h-3.5 w-3.5" />
          {formatThinkingTokens(thinkingTokens)}
        </span>
      )}
      {showAgents && <AgentCountGlyph count={activeSubagents} />}
    </div>
  );
}
