import React, { useEffect, useState } from 'react';
import { api, type BrainVaultStats } from '@/lib/api';

/**
 * What the Brain costs, and whether curation is firing at the right time.
 *
 * The threshold in electron/services/brain/curate.ts was inherited from
 * Rowboat and never measured. `qualifyingCount` and the Timeline histogram are
 * what turn it into an observation: 0 means the threshold is theatre, 40 means
 * it is too loose.
 *
 * Rendered above BOTH panes rather than inside Sources, because it describes
 * the vault as a whole — the same thing whichever pane is open.
 */
const EMPTY: BrainVaultStats = {
  noteCount: 0,
  totalBytes: 0,
  byType: {},
  medianBytes: 0,
  largestBytes: 0,
  largestNote: null,
  estimatedTokens: { median: 0, largest: 0, vault: 0 },
  timelineBuckets: [],
  qualifyingCount: 0,
  recentlyCurated: [],
};

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function tokens(n: number): string {
  return n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${String(n)}`;
}

export const BrainStatsPanel: React.FC<{
  accountId: number | null;
  /** Bumped after a run, so the figures do not go stale behind the user. */
  nonce?: number;
  onSelect?: (notePath: string) => void;
}> = ({ accountId, nonce = 0, onSelect }) => {
  const [stats, setStats] = useState<BrainVaultStats>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (accountId === null) {
      setStats(EMPTY);
      return;
    }
    let cancelled = false;
    void api
      .brainStats(accountId)
      .then((s) => {
        if (cancelled) return;
        setStats(s);
        setError(null);
      })
      .catch((err: Error) => {
        // Zeroes would read as "an empty vault", which is a different and much
        // more alarming claim than "the reading failed".
        if (!cancelled) setError(err.message);
      });
    return () => { cancelled = true; };
  }, [accountId, nonce]);

  if (accountId === null) return null;

  return (
    <div className="border-b px-4 py-2 text-xs" data-testid="brain-stats">
      {error ? (
        <span className="text-destructive">{error}</span>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-muted-foreground">
            {stats.noteCount} notes · {kb(stats.totalBytes)}
          </span>
          <span
            className="text-muted-foreground"
            title="Rough estimate at 4 bytes per token. Not a tokenizer count."
          >
            est. context per retrieval: {tokens(stats.estimatedTokens.median)} median ·{' '}
            {tokens(stats.estimatedTokens.largest)} largest
          </span>
          <span className="text-muted-foreground" title="Timeline entries per note.">
            timeline:{' '}
            {stats.timelineBuckets.map((b) => `${b.label} ${String(b.count)}`).join(' · ')}
          </span>
          <span className={stats.qualifyingCount > 0 ? '' : 'text-muted-foreground'}>
            {stats.qualifyingCount} qualify for curation
          </span>
        </div>
      )}

      {stats.recentlyCurated.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground">
          <span>recently curated:</span>
          {stats.recentlyCurated.map((n) => (
            <button
              key={n.relPath}
              type="button"
              onClick={() => onSelect?.(n.relPath)}
              className="rounded border px-1.5 py-0.5 hover:bg-accent"
              title={`Curated ${n.curatedAt}. Every run commits as "Curation" — git revert in the vault undoes it.`}
            >
              {n.relPath}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default BrainStatsPanel;
