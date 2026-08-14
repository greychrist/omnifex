import React, { useEffect, useState } from 'react';
import { Brain } from 'lucide-react';
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

  const vault =
    accounts.find((a) => a.id === run.accountId)?.name ?? `account ${String(run.accountId)}`;

  return (
    <div
      data-testid="brain-run-indicator"
      title={`Indexing ${run.item} into the ${vault} vault`}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-violet-600/15 text-violet-400 app-no-drag"
    >
      <Brain size={13} className="animate-pulse" />
      <span className="tabular-nums">
        {vault} · {run.completed} of {run.total}
      </span>
    </div>
  );
};
