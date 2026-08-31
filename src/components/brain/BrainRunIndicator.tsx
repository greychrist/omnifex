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

  const now = useRunClock(run !== null);

  if (!run) return null;

  const name = accounts.find((a) => a.id === run.accountId)?.name;
  // A deleted-mid-run account still has a vault and still has a run, so the id
  // has to read as a possessive rather than a name: "account 99's vault".
  const vault = name ? `${name} vault` : `account ${String(run.accountId)}'s vault`;
  // Item-positional, the same framing the Brain tab's own banner uses: the
  // `completed + 1`-th item is the one in flight. Reporting the completed count
  // instead made one run read "0 of 2" in the titlebar and "1 of 2" in the tab.
  //
  // Shown always, including "1 of 1". A queue drain recomputes `total` per
  // claimed entry, so the last pending item is a one-item run — which is most
  // of them. Hiding the counter there left the pill reading "Indexing Personal
  // vault" and nothing else for minutes at a time.
  const position = `${String(run.completed + 1)} of ${String(run.total)}`;
  const phase = PHASE_LABEL[run.phase];
  const elapsed = formatElapsed(now - run.startedAt);
  const label = `Indexing ${vault} · ${position} · ${phase}`;

  return (
    // Own provider: the titlebar has one, but this also renders in shells that
    // do not, and nesting Radix providers is legal.
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            data-testid="brain-run-indicator"
            // Both names: the key identifies the row in the Sources table, the
            // label is the one a person can read.
            aria-label={`Brain indexing: ${run.label} (${run.item}) into the ${vault}, item ${position}, ${phase}, ${elapsed} elapsed`}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-violet-600/15 text-violet-400 app-no-drag"
          >
            <Brain size={13} className="animate-pulse" />
            <span className="tabular-nums">{label}</span>
            {/* Truncated alone, so a long project name shrinks instead of
                pushing the counter and the clock out of the titlebar. */}
            <span className="max-w-[16ch] truncate">{run.label}</span>
            <span className="tabular-nums opacity-70">{`· ${elapsed}`}</span>
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
          <p className="text-muted-foreground tabular-nums">
            Item {position} · {phase} · {elapsed} elapsed
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
