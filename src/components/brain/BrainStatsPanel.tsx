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
function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function tokens(n: number): string {
  return n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${String(n)}`;
}

/**
 * One figure, with a label saying what it means.
 *
 * The bar previously ran four unlabelled phrases together on one line, so
 * reading it meant decoding which number belonged to which idea.
 */
const Stat: React.FC<{
  label: string;
  value: React.ReactNode;
  sub?: string;
  title?: string;
}> = ({ label, value, sub, title }) => (
  <div title={title} className={title ? 'cursor-help' : undefined}>
    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    <div className="font-medium tabular-nums">{value}</div>
    {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
  </div>
);

export const BrainStatsPanel: React.FC<{
  accountId: number | null;
  /** Bumped after a run, so the figures do not go stale behind the user. */
  nonce?: number;
  /**
   * Overrides the band chrome. The panel now shares a row with the account
   * switcher, and whoever owns that row owns its border and background —
   * otherwise the two halves paint their own bands and the row reads as two.
   */
  className?: string;
}> = ({ accountId, nonce = 0, className }) => {
  /**
   * The account each reading belongs to is stored WITH it, and a reading for
   * any other account is discarded at render.
   *
   * Clearing inside the effect would still paint one frame of the previous
   * account's figures, and `useBrainVault` names that precisely: "showing
   * account 1's note list under account 2's badge for even one frame is
   * exactly the cross-account leak the per-vault design exists to make
   * impossible." Keying the data makes the stale frame unrepresentable rather
   * than merely brief.
   */
  const [loaded, setLoaded] = useState<{ accountId: number; stats: BrainVaultStats } | null>(null);
  const [failure, setFailure] = useState<{ accountId: number; message: string } | null>(null);

  useEffect(() => {
    if (accountId === null) return;
    let cancelled = false;
    void api
      .brainStats(accountId)
      .then((s) => {
        if (cancelled) return;
        setLoaded({ accountId, stats: s });
        setFailure(null);
      })
      .catch((err: Error) => {
        // Zeroes would read as "an empty vault", which is a different and much
        // more alarming claim than "the reading failed".
        if (!cancelled) setFailure({ accountId, message: err.message });
      });
    return () => { cancelled = true; };
  }, [accountId, nonce]);

  if (accountId === null) return null;

  const stats = loaded?.accountId === accountId ? loaded.stats : null;
  const error = failure?.accountId === accountId ? failure.message : null;

  return (
    <div
      className={className ?? 'border-b bg-muted/40 px-4 py-2.5 text-xs'}
      data-testid="brain-stats"
    >
      {error ? (
        <span className="text-destructive">{error}</span>
      ) : stats === null ? (
        // Occupies the same line while the read is in flight, so switching
        // accounts does not shove the panes below up and down.
        <span className="text-muted-foreground">reading vault…</span>
      ) : (
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
          <Stat label="Notes in vault" value={String(stats.noteCount)} sub={kb(stats.totalBytes)} />
          {/* The old label — "est. context per retrieval" — named a mechanism
              rather than a consequence. This is the number that matters: what
              recalling a note costs the session that asks for it. */}
          <Stat
            label="Cost of one recall"
            value={`${tokens(stats.estimatedTokens.median)} tokens`}
            sub={`biggest note ${tokens(stats.estimatedTokens.largest)}`}
            title="What a Brain lookup adds to a session's context. Typical note, then the largest. Rough estimate at 4 bytes per token — not a tokenizer count."
          />
          {/* Every string here names the consequence rather than the jargon.
              "Ready to curate — notes long enough to compress" told a reader
              who did not already know what curation was precisely nothing. */}
          {/* What the Brain has actually cost. Taken from the CLI's own
              `total_cost_usd` per run, summed per account — not estimated from
              a local pricing table that would drift from Anthropic's. */}
          <Stat
            label="Spent indexing"
            value={`$${stats.spentUsd.toFixed(2)}`}
            sub="what this vault has cost so far"
            title="The sum of what every indexing run on this account's vault cost, as the CLI itself reported it. Only runs since cost tracking landed are counted."
          />
          <Stat
            label="Ready to curate"
            value={String(stats.qualifyingCount)}
            sub={
              stats.qualifyingCount === 0
                ? 'no note has 8+ sessions yet'
                : 'can be summarized, making them cheaper to recall'
            }
            title="Notes with 8 or more recorded sessions. Curating one summarizes every entry except the 5 newest, so pulling that note into a session costs less context. It only runs when you press Curate or turn on Auto-curate, and every run commits as 'Curation' — git revert in the vault undoes it."
          />
          {/* Its own column, past a divider: the three figures to the left are
              each one number, while this is a distribution over all of them.
              Run together at the same weight, it read as a fourth figure whose
              value happened to be a long string. */}
          <div className="border-l pl-8">
            <Stat
              label="Sessions recorded per note"
              title="Each note keeps one dated entry per session that touched its subject, and a recall pays for all of them. This is how those entries are spread across the vault: the notes at the right-hand end are the ones whose history can be summarized down."
              value={
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  {stats.timelineBuckets.map((b) => {
                    // 8+ entries is the curation threshold (MIN_TIMELINE_ENTRIES),
                    // so these two buckets ARE the backlog behind "Ready to
                    // curate". An empty one is not a backlog, so it stays plain.
                    const curatable = b.count > 0 && (b.label === '8–15' || b.label === '16+');
                    return (
                      <span
                        key={b.label}
                        data-testid="history-bucket"
                        data-curatable={String(curatable)}
                        title={
                          `${String(b.count)} ${b.count === 1 ? 'note has' : 'notes have'} ` +
                          `${b.label === 'none' ? 'no entries' : `${b.label} entries`}` +
                          (curatable ? ' — old entries here can be summarized to shrink recalls' : '')
                        }
                        className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 ${
                          curatable ? 'border-amber-500/40 bg-amber-500/10' : 'bg-background'
                        }`}
                      >
                        <span className="text-[10px] text-muted-foreground">{b.label}</span>
                        <span className="font-medium tabular-nums">{b.count}</span>
                      </span>
                    );
                  })}
                </div>
              }
              sub="8+ entries: older ones can be summarized to shrink recalls"
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default BrainStatsPanel;
