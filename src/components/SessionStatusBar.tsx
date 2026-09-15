
import { cn } from '@/lib/utils';
import { AgentCountGlyph } from '@/components/AgentCountGlyph';

export interface SessionStatusBarProps {
  /** Running, non-ambient subagents — `countActiveSubagents`. */
  activeSubagents: number;
  className?: string;
}

/**
 * The session widget's bottom row: how many subagents are running.
 *
 * It used to carry the turn clock and the thinking burst too. Those are about
 * the conversation rather than the session as a whole, so they moved to the
 * chat status bar above the transcript, where they stay visible regardless of
 * whether this widget is open or scrolled to. `ActivityPill` keeps the
 * `usage-limit` case, which is an alarm rather than a metric.
 */
export function SessionStatusBar({
  activeSubagents,
  className,
}: SessionStatusBarProps) {
  if (activeSubagents <= 0) return null;

  return (
    <div className={cn('flex items-center gap-2.5 px-2 text-[10px] font-mono tabular-nums', className)}>
      <AgentCountGlyph count={activeSubagents} />
    </div>
  );
}
