import React from 'react';
import { ReadoutLabel } from '@/components/ui/readout-label';
import { Bot, SquareTerminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover } from '@/components/ui/popover';
import { SubagentRow, ShellRow } from '@/components/BackgroundWorkRows';
import type { Subagent } from '@/lib/subagentStreams';
import type { SubagentCost } from '@/lib/api';
import { subagentTotals } from '@/lib/subagentRunStats';
import { formatCost } from '@/components/claude-code-session/CostWidget';
import type { BackgroundShell, TaskOutputTail } from '@/lib/backgroundShells';

export interface BackgroundWork {
  subagents: Subagent[];
  subagentCost?: Record<string, SubagentCost> | null;
  onDismissSubagent?: (toolUseId: string) => void;
  onDismissAllCompletedSubagents?: () => void;
  shells: BackgroundShell[];
  readShellOutput: (taskId: string) => Promise<TaskOutputTail | null>;
  onDismissShell?: (taskId: string) => void;
  onDismissAllEndedShells?: () => void;
  /** Stop a background shell, Monitor or agent by task id (`stop_task`). */
  stopTask?: (taskId: string) => Promise<void>;
  /** Move a running foreground agent to the background (`background_tasks`). */
  backgroundTask?: (toolUseId: string) => Promise<boolean>;
}

interface ReadoutProps {
  noun: string;
  icon: React.ReactNode;
  color: string;
  running: number;
  total: number;
  onClearDone?: () => void;
  showProgress?: boolean;
  headerExtra?: string;
  children: React.ReactNode;
}

function BackgroundReadout({
  noun,
  icon,
  color,
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
            color,
            live && 'animate-pulse',
          )}
        >
          {icon}
          <ReadoutLabel>{noun}</ReadoutLabel>
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
  onStop,
  onBackground,
}: {
  subagents: Subagent[];
  costs?: Record<string, SubagentCost> | null;
  onDismiss?: (toolUseId: string) => void;
  onDismissAllCompleted?: () => void;
  onStop?: (taskId: string) => Promise<void>;
  onBackground?: (toolUseId: string) => Promise<boolean>;
}): React.JSX.Element {
  const totals = subagentTotals(subagents, costs);
  return (
    <BackgroundReadout
      noun="agents"
      icon={<Bot className="h-3.5 w-3.5" />}
      color="text-sky-400"
      running={subagents.filter((s) => s.status === 'running').length}
      total={subagents.length}
      onClearDone={onDismissAllCompleted}
      showProgress
      headerExtra={totals.usd !== undefined ? `≈${formatCost(totals.usd)}` : undefined}
    >
      {subagents.map((sub) => (
        <SubagentRow
          key={sub.toolUseId}
          sub={sub}
          onDismiss={onDismiss}
          costs={costs}
          onStop={onStop}
          onBackground={onBackground}
        />
      ))}
    </BackgroundReadout>
  );
}

export function ShellsStatusItem({
  shells,
  readShellOutput,
  onDismiss,
  onDismissAllEnded,
  onStop,
}: {
  shells: BackgroundShell[];
  readShellOutput: (taskId: string) => Promise<TaskOutputTail | null>;
  onDismiss?: (taskId: string) => void;
  onDismissAllEnded?: () => void;
  onStop?: (taskId: string) => Promise<void>;
}): React.JSX.Element {
  return (
    <BackgroundReadout
      noun="shells"
      icon={<SquareTerminal className="h-3.5 w-3.5" />}
      color="text-amber-400"
      running={shells.filter((s) => s.status === 'running').length}
      total={shells.length}
      onClearDone={onDismissAllEnded}
    >
      {shells.map((shell) => (
        <ShellRow key={shell.taskId} shell={shell} read={readShellOutput} onDismiss={onDismiss} onStop={onStop} />
      ))}
    </BackgroundReadout>
  );
}
