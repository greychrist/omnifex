import React, { useEffect, useState } from 'react';
import { Brain } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip-modern';
import { api, type BrainRun } from '@/lib/api';
import { PHASE_LABEL, formatElapsed, useRunClock } from './runProgress';

export interface BrainRunIndicatorAccount {
  id: number;
  name: string;
}

export const BrainRunIndicator: React.FC<{
  accounts: BrainRunIndicatorAccount[];
}> = ({ accounts }) => {
  const [run, setRun] = useState<BrainRun | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Seed, then subscribe: a pushed frame sets `cancelled` so a late seed can't overwrite it.
    api
      .brainActiveRun()
      .then((active) => {
        if (!cancelled) setRun(active);
      })
      .catch(() => {});

    const unsubscribe = api.onBrainRunProgress((next) => {
      cancelled = true;
      setRun(next);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const now = useRunClock(run !== null);

  if (!run) return null;

  const name = accounts.find((a) => a.id === run.accountId)?.name;
  const vault = name ? `${name} vault` : `account ${String(run.accountId)}'s vault`;
  // `completed + 1` is the item in flight. Shown even at "1 of 1": queue-drain runs are mostly one item.
  const position = `${String(run.completed + 1)} of ${String(run.total)}`;
  const phase = PHASE_LABEL[run.phase];
  const elapsed = formatElapsed(now - run.startedAt);
  const label = `Indexing ${vault} · ${position} · ${phase}`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            data-testid="brain-run-indicator"
            aria-label={`Brain indexing: ${run.label} (${run.item}) into the ${vault}, item ${position}, ${phase}, ${elapsed} elapsed`}
            // Clamped to two lines: the titlebar is 60px tall.
            className="max-w-full min-w-0 px-2.5 py-1 rounded-md text-xs font-medium leading-tight text-center bg-violet-600/15 text-violet-400 app-no-drag"
          >
            {/* Clamp on the inner element: on the padded box a third line shows through the padding. */}
            <span className="line-clamp-2">
              <Brain size={13} className="inline-block align-[-2px] mr-1.5 animate-pulse" />
              <span className="tabular-nums">{label}</span>{' '}
              <span className="inline-block align-bottom max-w-[16ch] truncate">{run.label}</span>{' '}
              <span className="tabular-nums opacity-70">{`· ${elapsed}`}</span>
            </span>
          </div>
        </TooltipTrigger>
        {/* Bottom: the titlebar is the window's top edge. */}
        <TooltipContent side="bottom" className="max-w-xs">
          <p className="font-medium text-popover-foreground">Brain indexing</p>
          <p className="mt-1 text-muted-foreground">
            Distilling past Claude sessions into durable notes in the {vault}.
          </p>
          <p className="mt-1.5 text-muted-foreground">
            Current: <span className="font-mono">{run.item}</span>
          </p>
          <p className="text-muted-foreground tabular-nums">
            Item {position} · {phase} · {elapsed} elapsed
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
