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

/** Mirrors the backend keys in electron/services/brain/queue.ts. */
const AUTO_INDEX_KEY = 'brain.autoIndex';
const PAUSED_KEY = 'brain.queuePaused';

/**
 * A labelled switch for one global setting.
 *
 * Both switches live here rather than in Settings — spec §14 puts the kill
 * switch in Settings, but every other operational control is already in this
 * panel and splitting them would mean hunting in two places to stop indexing.
 */
const SettingSwitch: React.FC<{
  label: string;
  title: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}> = ({ label, title, checked, onChange }) => (
  <label className="inline-flex items-center gap-1.5" title={title}>
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => { onChange(e.target.checked); }}
      className="h-3 w-3"
    />
    <span className="text-muted-foreground">{label}</span>
  </label>
);

export const BrainQueuePanel: React.FC<{ accountId: number | null }> = ({ accountId }) => {
  const [counts, setCounts] = useState<BrainQueueCounts>(EMPTY);
  const [entries, setEntries] = useState<BrainQueueEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [autoIndex, setAutoIndex] = useState(false);
  const [paused, setPaused] = useState(false);

  // Both switches are GLOBAL, not per account. Read once on mount rather than
  // on every account change, which would imply they are scoped when they are
  // not.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.getSetting(AUTO_INDEX_KEY), api.getSetting(PAUSED_KEY)])
      .then(([auto, pause]) => {
        if (cancelled) return;
        setAutoIndex(auto === 'true');
        setPaused(pause === 'true');
      })
      .catch(() => {
        // A settings read failure leaves both switches off, which is the safe
        // reading: it never turns unattended spending ON by accident.
      });
    return () => { cancelled = true; };
  }, []);

  const setSwitch = useCallback((key: string, next: boolean, apply: (v: boolean) => void) => {
    // Optimistic, then persisted: the toggle is the user's own action, and a
    // control that lags a round trip reads as broken.
    apply(next);
    api.saveSetting(key, next ? 'true' : 'false').catch((err: Error) => {
      apply(!next);
      setError(err.message);
    });
  }, []);

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

        <SettingSwitch
          label="Auto-index"
          title="Index each session when it closes. Off by default — it spends tokens unattended."
          checked={autoIndex}
          onChange={(next) => { setSwitch(AUTO_INDEX_KEY, next, setAutoIndex); }}
        />

        <SettingSwitch
          label="Pause"
          title="Stop the worker from draining, without turning auto-index off."
          checked={paused}
          onChange={(next) => { setSwitch(PAUSED_KEY, next, setPaused); }}
        />

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
