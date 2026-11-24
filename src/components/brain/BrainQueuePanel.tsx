import React, { useCallback, useEffect, useState } from 'react';
import { api, type BrainQueueCounts, type BrainQueueEntry } from '@/lib/api';

const EMPTY: BrainQueueCounts = { pending: 0, running: 0, done: 0, failed: 0 };

/** Must match the keys in daemon/services/brain/queue.ts. */
const AUTO_INDEX_KEY = 'brain.autoIndex';
const PAUSED_KEY = 'brain.queuePaused';
const CURATE_KEY = 'brain.curate';
const IDLE_MINUTES_KEY = 'brain.idleMinutes';
const SWEEP_HOURS_KEY = 'brain.sweepHours';

// Mirrors queue.ts's defaults and ranges (the renderer can't import daemon/); the backend clamps regardless.
const IDLE_MINUTES = { def: 15, min: 1, max: 1440 };
const SWEEP_HOURS = { def: 24, min: 1, max: 720 };

function readNumber(
  raw: string | null,
  range: { def: number; min: number; max: number },
): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return range.def;
  return Math.min(range.max, Math.max(range.min, parsed));
}

function persistSwitch(
  key: string,
  next: boolean,
  apply: (v: boolean) => void,
  onError: (message: string) => void,
): void {
  apply(next);
  api.saveSetting(key, next ? 'true' : 'false').catch((err: unknown) => {
    apply(!next);
    onError((err instanceof Error ? err.message : String(err)));
  });
}

function persistNumber(
  key: string,
  next: number,
  prev: number,
  apply: (v: number) => void,
  onError: (message: string) => void,
): void {
  apply(next);
  api.saveSetting(key, String(next)).catch((err: unknown) => {
    apply(prev);
    onError((err instanceof Error ? err.message : String(err)));
  });
}

// Commits on blur or Enter, not per keystroke: writing each change would persist every intermediate value.
const SettingNumber: React.FC<{
  label: string;
  suffix: string;
  title: string;
  value: number;
  min: number;
  max: number;
  onCommit: (next: number) => void;
}> = ({ label, suffix, title, value, min, max, onCommit }) => {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => { setDraft(String(value)); }, [value]);

  const commit = useCallback(() => {
    const parsed = Number.parseInt(draft.trim(), 10);
    // readNumericSetting's clamp-or-fall-back, so the box and the backend never disagree.
    const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : value;
    setDraft(String(next));
    if (next !== value) onCommit(next);
  }, [draft, min, max, value, onCommit]);

  return (
    <label className="inline-flex items-center gap-1.5" title={title}>
      <span className="text-muted-foreground">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={draft}
        onChange={(e) => { setDraft(e.target.value); }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') { setDraft(String(value)); e.currentTarget.blur(); }
        }}
        className="w-14 rounded border border-border bg-background px-1 py-0.5 text-xs"
      />
      <span className="text-muted-foreground">{suffix}</span>
    </label>
  );
};

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

export const BrainQueueActions: React.FC<{
  accountId: number | null;
  refreshToken?: number;
}> = ({ accountId, refreshToken = 0 }) => {
  const [counts, setCounts] = useState<BrainQueueCounts>(EMPTY);
  const [entries, setEntries] = useState<BrainQueueEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [paused, setPaused] = useState(false);

  // Re-read on every nonce, not only at mount: reading once is the stale-read bug this tab shipped three times.
  useEffect(() => {
    let cancelled = false;
    void api
      .getSetting(PAUSED_KEY)
      .then((pause) => { if (!cancelled) setPaused(pause === 'true'); })
      .catch(() => {
        // Un-paused, the stored default.
      });
    return () => { cancelled = true; };
  }, [nonce, refreshToken]);

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
      .catch((err: unknown) => { if (!cancelled) setError((err instanceof Error ? err.message : String(err))); });
    return () => { cancelled = true; };
  }, [accountId, nonce, refreshToken]);

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
        .catch((err: unknown) => setError((err instanceof Error ? err.message : String(err))))
        .finally(() => { setBusy(false); });
    },
    [],
  );

  if (accountId === null) return null;

  const failed = entries.filter((e) => e.status === 'failed');

  return (
    <div className="text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <span
          data-testid="queue-counts"
          className="rounded-md border bg-muted/40 px-2 py-1 tabular-nums text-muted-foreground"
        >
          <span className="font-medium text-foreground">{counts.pending}</span> queued
          {counts.running > 0 && <> · {counts.running} running</>} · {counts.done} done
          {counts.failed > 0 && (
            <> · <span className="text-destructive">{counts.failed} failed</span></>
          )}
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
              const n = await api.brainEnqueueCuration(accountId);
              return `queued ${String(n)} for curation`;
            });
          }}
          className="rounded-md border px-2 py-1 hover:bg-accent disabled:opacity-50"
        >
          Curate
        </button>

        {/* No bulk index button: one indexed 158 sessions (~an hour of Sonnet) when the user meant one ticked row. */}

        <button
          type="button"
          onClick={() => { persistSwitch(PAUSED_KEY, !paused, setPaused, setError); }}
          className="rounded-md border px-2 py-1 hover:bg-accent"
        >
          {paused ? 'Resume' : 'Pause'}
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
              <span className="font-medium">{e.itemKey}</span> — {e.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// Each switch is off by default and a failed read leaves it off: never turn spending on by accident.
export const BrainAutomationSettings: React.FC<{ accountId: number | null }> = ({ accountId }) => {
  const [autoIndex, setAutoIndex] = useState(false);
  const [curate, setCurate] = useState(false);
  const [idleMinutes, setIdleMinutes] = useState(IDLE_MINUTES.def);
  const [sweepHours, setSweepHours] = useState(SWEEP_HOURS.def);
  const [error, setError] = useState<string | null>(null);
  // Per account: it writes one account's Claude config.
  const [mcpStatus, setMcpStatus] = useState({ registered: false, available: false });

  // Global settings: deliberately not re-read on account change.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.getSetting(AUTO_INDEX_KEY),
      api.getSetting(CURATE_KEY),
      api.getSetting(IDLE_MINUTES_KEY),
      api.getSetting(SWEEP_HOURS_KEY),
    ])
      .then(([auto, cur, idle, sweep]) => {
        if (cancelled) return;
        setAutoIndex(auto === 'true');
        setCurate(cur === 'true');
        setIdleMinutes(readNumber(idle, IDLE_MINUTES));
        setSweepHours(readNumber(sweep, SWEEP_HOURS));
      })
      .catch(() => {
        // Switches stay off, numbers at the shipped defaults.
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (accountId === null) {
      setMcpStatus({ registered: false, available: false });
      return;
    }
    let cancelled = false;
    void api
      .brainMcpStatus(accountId)
      .then((status) => { if (!cancelled) setMcpStatus(status); })
      .catch(() => {
        if (!cancelled) setMcpStatus({ registered: false, available: false });
      });
    return () => { cancelled = true; };
  }, [accountId]);

  const setMcpRegistered = useCallback((next: boolean) => {
    if (accountId === null) return;
    // Not optimistic: it writes a real Claude config dir, so flipping first would claim residue that may not exist.
    setError(null);
    const call = next ? api.brainMcpRegister(accountId) : api.brainMcpUnregister(accountId);
    void call
      .then(() => { setMcpStatus((prev) => ({ ...prev, registered: next })); })
      .catch((err: unknown) => { setError((err instanceof Error ? err.message : String(err))); });
  }, [accountId]);

  if (accountId === null) return null;

  return (
    <div className="text-xs">
      <h3 className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        Automation
      </h3>
      <div className="flex flex-col gap-2">
        <SettingSwitch
          label="Auto-index"
          title="Index each session when it closes, and check every few minutes for sessions that have gone idle without being closed. Off by default — it spends tokens unattended."
          checked={autoIndex}
          onChange={(next) => { persistSwitch(AUTO_INDEX_KEY, next, setAutoIndex, setError); }}
        />

        {autoIndex && (
          <div className="ml-4 flex flex-col gap-2 border-l border-border pl-3">
            <SettingNumber
              label="Index open sessions after"
              suffix="min idle"
              title="A session still open in OmniFex is indexed once its transcript has gone untouched this long — it no longer has to wait for the tab to close. If the conversation continues afterwards it is indexed again, so the note keeps up."
              value={idleMinutes}
              min={IDLE_MINUTES.min}
              max={IDLE_MINUTES.max}
              onCommit={(next) => {
                persistNumber(IDLE_MINUTES_KEY, next, idleMinutes, setIdleMinutes, setError);
              }}
            />
            <SettingNumber
              label="Each check looks back"
              suffix="h"
              title="How far into the past the background check looks. Older sessions are ignored, so turning auto-index on does not queue your entire history at once. Backfill still sees everything."
              value={sweepHours}
              min={SWEEP_HOURS.min}
              max={SWEEP_HOURS.max}
              onCommit={(next) => {
                persistNumber(SWEEP_HOURS_KEY, next, sweepHours, setSweepHours, setError);
              }}
            />
          </div>
        )}

        <SettingSwitch
          label="Auto-curate"
          title="Compress long notes so retrieving them costs less context. Runs when a session closes and on the same background check as auto-indexing. Off by default — it spends tokens unattended and rewrites existing notes. Every run commits as 'Curation', so git revert in the vault undoes it."
          checked={curate}
          onChange={(next) => { persistSwitch(CURATE_KEY, next, setCurate, setError); }}
        />

        {mcpStatus.available && (
          <SettingSwitch
            label="Expose to Claude outside OmniFex"
            title="Sessions started from OmniFex already reach this vault. This also writes the Brain server into this account's Claude config, so terminal sessions reach it too."
            checked={mcpStatus.registered}
            onChange={setMcpRegistered}
          />
        )}

        {error && <span className="text-destructive">{error}</span>}
      </div>
    </div>
  );
};
