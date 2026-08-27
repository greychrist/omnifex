// What OmniFex's own model usage has left on disk, and how to get rid of it.
//
// Session summaries, Brain indexing and Brain curation all spend real money on
// the user's account. Their transcripts used to be deleted the moment the call
// returned; they are retained now so the spend can be seen in the Cost Report.
// Retention is age-capped, but a user who wants the space back should not have
// to wait 90 days for it.
//
// Design: docs/superpowers/specs/2026-08-26-internal-session-archive-design.md

import { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api, type InternalArchiveStats } from '@/lib/api';
import { Button } from '@/components/ui/button';

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

export function InternalArchiveSettings() {
  const [stats, setStats] = useState<InternalArchiveStats | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .internalArchiveStats()
      .then((s) => { setStats(s); })
      .catch((e: Error) => { setError(e.message); });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const clear = useCallback(() => {
    setBusy(true);
    api
      .internalArchiveClear()
      .then((s) => { setStats(s); setConfirming(false); })
      .catch((e: Error) => { setError(e.message); })
      .finally(() => { setBusy(false); });
  }, []);

  const empty = stats !== null && stats.files === 0;

  return (
    <div className="text-xs">
      <h3 className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        OmniFex&apos;s own transcripts
      </h3>

      <p className="mb-2 text-muted-foreground">
        Session summaries, Brain indexing and Brain curation run the CLI on your
        account. Their transcripts are kept so that spend shows up in the Cost
        Report, and are pruned after 90 days.
      </p>

      <div className="flex items-center justify-between gap-3">
        <span className="text-foreground">
          {stats === null
            ? 'Reading…'
            : empty
              ? 'Nothing archived'
              : `${stats.files.toLocaleString()} transcripts · ${fmtBytes(stats.bytes)}`}
        </span>

        {!confirming && (
          <Button
            size="sm"
            variant="outline"
            disabled={stats === null || empty}
            onClick={() => { setConfirming(true); }}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            Clear
          </Button>
        )}

        {confirming && (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">This can&apos;t be undone.</span>
            <Button size="sm" variant="outline" onClick={() => { setConfirming(false); }}>
              Cancel
            </Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={clear}>
              Delete
            </Button>
          </div>
        )}
      </div>

      {/* The load-bearing sentence. Deleting a transcript does not delete the
          cost rows it already produced -- backfill only visits what it finds,
          and replaceSession only touches the session it replaces. Without
          saying so, a user reasonably assumes clearing rewrites their spend
          history and never touches the button. */}
      <p className="mt-1.5 text-muted-foreground">
        Cost history is not affected — spend already recorded stays in the Cost
        Report.
      </p>

      {error && <p className="mt-1.5 text-red-400">{error}</p>}
    </div>
  );
}
