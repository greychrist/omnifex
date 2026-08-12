import React, { useCallback, useEffect, useState } from 'react';
import { api, type BrainQueueCounts, type BrainQueueEntry } from '@/lib/api';

/**
 * The operational surface spec §14 promised, deferred out of Plan 2 because a
 * control panel over a queue nothing drained would have been a control surface
 * for nothing. The worker exists now, so it lands.
 *
 * Everything here is scoped to the selected account. Queue depth is per
 * account, and showing one account's backlog under another would misreport
 * what is about to be indexed and where it will land.
 */
const EMPTY: BrainQueueCounts = { pending: 0, running: 0, done: 0, failed: 0 };

export const BrainQueuePanel: React.FC<{ accountId: number | null }> = ({ accountId }) => {
  const [counts, setCounts] = useState<BrainQueueCounts>(EMPTY);
  const [entries, setEntries] = useState<BrainQueueEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setOutcome(null);
    setError(null);
  }, [accountId]);

  useEffect(() => {
    if (accountId === null) return;
    let cancelled = false;
    void Promise.all([api.brainQueueCounts(accountId), api.brainQueueList(accountId, 50)])
      .then(([c, rows]) => {
        if (cancelled) return;
        setCounts(c);
        setEntries(rows);
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [accountId, nonce]);

  /** Every control refreshes on completion, or the panel lies about its state. */
  const run = useCallback(
    (fn: () => Promise<string | null>) => {
      setBusy(true);
      setError(null);
      setOutcome(null);
      fn()
        .then((message) => {
          setOutcome(message);
          setNonce((n) => n + 1);
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => { setBusy(false); });
    },
    [],
  );

  if (accountId === null) return null;

  const failed = entries.filter((e) => e.status === 'failed');

  return (
    <div className="border-b px-4 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-muted-foreground">
          {counts.pending} pending · {counts.running} running · {counts.done} done ·{' '}
          {counts.failed} failed
        </span>

        <button
          type="button"
          disabled={busy}
          onClick={() => {
            run(async () => {
              const n = await api.brainBackfill(accountId);
              return `queued ${String(n)}`;
            });
          }}
          className="rounded-md border px-2 py-1 hover:bg-accent disabled:opacity-50"
        >
          Backfill
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => {
            run(async () => {
              await api.brainQueueDrain();
              return 'drain finished';
            });
          }}
          className="rounded-md border px-2 py-1 hover:bg-accent disabled:opacity-50"
        >
          Drain now
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => {
            run(async () => {
              await api.brainQueueClear(accountId);
              return null;
            });
          }}
          className="rounded-md border px-2 py-1 hover:bg-accent disabled:opacity-50"
        >
          Clear finished
        </button>

        {outcome && <span className="text-muted-foreground">{outcome}</span>}
        {error && <span className="text-destructive">{error}</span>}
      </div>

      {failed.length > 0 && (
        <ul className="mt-2 space-y-1">
          {failed.map((e) => (
            <li key={e.id} className="text-destructive">
              {/* The error text, not just a count: a pane that says something
                  broke without saying what is useless for the job spec §14
                  gives it. */}
              <span className="font-medium">{e.itemKey}</span> — {e.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default BrainQueuePanel;
