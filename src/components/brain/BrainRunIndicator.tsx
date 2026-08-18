import React, { useEffect, useState } from 'react';
import { Brain } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip-modern';
import { api, type BrainRun } from '@/lib/api';

/**
 * "Something is indexing, and here is where it is" — everywhere in the app.
 *
 * Plan 8 §5. Indexing no longer waits for the user to step away, so it now runs
 * while they are working and needs to be visible from wherever they are. The
 * Brain tab still owns the detail; this is the ambient signal.
 *
 * Two sources, and both are needed. The pushed `brain-run-progress` frames
 * arrive once per item, and an item takes minutes — so a component that only
 * listened would show nothing for minutes after mounting mid-run. The seed read
 * closes that gap, which is the whole reason the run lives in the main process.
 */
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
    // Seed first, then subscribe. A frame that lands between the two wins,
    // because the subscription's setState runs after this promise resolves
    // only if the promise was still pending — hence the `cancelled` guard
    // rather than an unconditional overwrite.
    api
      .brainActiveRun()
      .then((active) => {
        if (!cancelled) setRun(active);
      })
      .catch(() => {
        // The Brain is auxiliary: an indicator that cannot read its own state
        // shows nothing, and never interrupts what the user is doing.
      });

    const unsubscribe = api.onBrainRunProgress((next) => {
      cancelled = true;
      setRun(next);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (!run) return null;

  const name = accounts.find((a) => a.id === run.accountId)?.name;
  // A deleted-mid-run account still has a vault and still has a run, so the id
  // has to read as a possessive rather than a name: "account 99's vault".
  const vault = name ? `${name} vault` : `account ${String(run.accountId)}'s vault`;
  const progress = `${run.completed} of ${run.total}`;

  return (
    // Own provider: the titlebar has one, but this also renders in shells that
    // do not, and nesting Radix providers is legal.
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            data-testid="brain-run-indicator"
            aria-label={`Brain indexing: ${run.item} into the ${vault}, ${progress} complete`}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-violet-600/15 text-violet-400 app-no-drag"
          >
            <Brain size={13} className="animate-pulse" />
            <span className="tabular-nums">
              Indexing {vault} · {progress}
            </span>
          </div>
        </TooltipTrigger>
        {/* Below the pill: the titlebar is the top edge of the window, so a
            top-side tooltip would render off-screen. */}
        <TooltipContent side="bottom" className="max-w-xs">
          <p className="font-medium text-popover-foreground">Brain indexing</p>
          <p className="mt-1 text-muted-foreground">
            Distilling past Claude sessions into durable notes in the {vault}.
          </p>
          <p className="mt-1.5 text-muted-foreground">
            Current: <span className="font-mono">{run.item}</span>
          </p>
          <p className="text-muted-foreground tabular-nums">{progress} complete</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
