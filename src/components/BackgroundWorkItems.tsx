/**
 * The status bar's `agents` and `shells` readouts: what is running beside the
 * main conversation, one readout per kind. Each pulses while anything of its
 * kind runs, the way `thinking` does, and opens a popover of its rows.
 *
 * Two readouts rather than one list, because the two are not the same thing:
 * subagent rows are built from `Agent` tool calls and the subagents' own
 * transcripts, shell rows from the CLI's stream-only
 * `background_tasks_changed` snapshot. They used to share a strip under the
 * transcript; that strip is gone.
 */
import React from 'react';
import { Bot, SquareTerminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover } from '@/components/ui/popover';
import { SubagentRow, ShellRow } from '@/components/BackgroundWorkRows';
import type { Subagent } from '@/lib/subagentStreams';
import type { SubagentCost } from '@/lib/api';
import { subagentTotals } from '@/lib/subagentRunStats';
import { formatCost } from '@/components/claude-code-session/CostWidget';
import type { BackgroundShell, TaskOutputTail } from '@/lib/backgroundShells';

/** Everything the status bar needs to draw both readouts. */
export interface BackgroundWork {
  subagents: Subagent[];
  /** Per-agent cost and context, keyed by agent id. */
  subagentCost?: Record<string, SubagentCost> | null;
  onDismissSubagent?: (toolUseId: string) => void;
  onDismissAllCompletedSubagents?: () => void;
  /** Background shells and Monitors (`local_bash` tasks). */
  shells: BackgroundShell[];
  readShellOutput: (taskId: string) => Promise<TaskOutputTail | null>;
  onDismissShell?: (taskId: string) => void;
  onDismissAllEndedShells?: () => void;
}

interface ReadoutProps {
  noun: string;
  icon: React.ReactNode;
  colour: string;
  running: number;
  total: number;
  onClearDone?: () => void;
  /** Read `done/total` while running rather than `N running`. */
  showProgress?: boolean;
  /** Appended to the header's `done/total done`, e.g. a cost total. */
  headerExtra?: string;
  children: React.ReactNode;
}

/**
 * One readout and its popover. Running count while anything runs, done count
 * otherwise — the same label-then-value shape as `turn 12s`.
 */
function BackgroundReadout({
  noun,
  icon,
  colour,
  running,
  total,
  onClearDone,
  showProgress = false,
  headerExtra,
  children,
}: ReadoutProps): React.JSX.Element {
  const live = running > 0;
  const done = total - running;
  return (
    <Popover
      align="end"
      side="bottom"
      className="p-0 overflow-hidden"
      trigger={
        <button
          type="button"
          aria-label={`${noun} ${live ? 'running' : 'done'}`}
          title={live ? `${running} of ${total} ${noun} running` : `${total} ${noun} finished`}
          className={cn(
            'flex items-center gap-1 rounded hover:bg-muted/60',
            colour,
            live && 'animate-pulse',
          )}
        >
          {icon}
          <span className="opacity-70">{noun}</span>
          <span>{live ? (showProgress ? `${done}/${total}` : `${running} running`) : `${done} done`}</span>
        </button>
      }
      content={
        <div className="w-[32rem] max-w-[90vw] font-sans">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/60 text-[11px]">
            <span className="font-medium text-foreground capitalize">{noun}</span>
            <span className="text-muted-foreground tabular-nums">
              {`${done}/${total} done${headerExtra ? ` · ${headerExtra}` : ''}`}
            </span>
            {onClearDone && (
              <button
                type="button"
                onClick={onClearDone}
                disabled={done === 0}
                className={cn(
                  'ml-auto inline-flex items-center px-1.5 py-0.5 rounded border border-border/60 bg-background',
                  'text-muted-foreground hover:text-foreground hover:bg-accent transition-colors',
                  'disabled:opacity-30 disabled:hover:bg-background disabled:cursor-not-allowed',
                )}
              >
                Clear done{done > 0 ? ` (${done})` : ''}
              </button>
            )}
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: '50vh' }}>
            {children}
          </div>
        </div>
      }
    />
  );
}

export function AgentsStatusItem({
  subagents,
  costs,
  onDismiss,
  onDismissAllCompleted,
}: {
  subagents: Subagent[];
  costs?: Record<string, SubagentCost> | null;
  onDismiss?: (toolUseId: string) => void;
  onDismissAllCompleted?: () => void;
}): React.JSX.Element {
  const totals = subagentTotals(subagents, costs);
  return (
    <BackgroundReadout
      noun="agents"
      icon={<Bot className="h-3.5 w-3.5" />}
      colour="text-sky-400"
      running={subagents.filter((s) => s.status === 'running').length}
      total={subagents.length}
      onClearDone={onDismissAllCompleted}
      showProgress
      headerExtra={totals.usd !== undefined ? `≈${formatCost(totals.usd)}` : undefined}
    >
      {subagents.map((sub) => (
        <SubagentRow key={sub.toolUseId} sub={sub} onDismiss={onDismiss} costs={costs} />
      ))}
    </BackgroundReadout>
  );
}

export function ShellsStatusItem({
  shells,
  readShellOutput,
  onDismiss,
  onDismissAllEnded,
}: {
  shells: BackgroundShell[];
  readShellOutput: (taskId: string) => Promise<TaskOutputTail | null>;
  onDismiss?: (taskId: string) => void;
  onDismissAllEnded?: () => void;
}): React.JSX.Element {
  return (
    <BackgroundReadout
      noun="shells"
      icon={<SquareTerminal className="h-3.5 w-3.5" />}
      colour="text-amber-400"
      running={shells.filter((s) => s.status === 'running').length}
      total={shells.length}
      onClearDone={onDismissAllEnded}
    >
      {shells.map((shell) => (
        <ShellRow key={shell.taskId} shell={shell} read={readShellOutput} onDismiss={onDismiss} />
      ))}
    </BackgroundReadout>
  );
}
