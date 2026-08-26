import React, { useCallback, useEffect, useState } from 'react';
import { api, type BrainQueueCounts, type BrainQueueEntry } from '@/lib/api';

/**
 * The operational surface spec §14 promised, deferred out of Plan 2 because a
 * control panel over a queue nothing drained would have been a control surface
 * for nothing. The worker exists now, so it lands.
 *
 * Split in two along the line the Brain tab's tabs draw:
 *
 *  - `BrainQueueActions` — what the queue is doing and what you can do to it
 *    right now. Lives above the Sources table, because Backfill and Curate act
 *    on the list you are looking at.
 *  - `BrainAutomationSettings` — the three persistent switches. They are
 *    configuration, not actions, and a tab named Settings is where someone
 *    goes to stop unattended spending.
 *
 * Everything here is scoped to the selected account. Queue depth is per
 * account, and showing one account's backlog under another would misreport
 * what is about to be indexed and where it will land.
 */
const EMPTY: BrainQueueCounts = { pending: 0, running: 0, done: 0, failed: 0 };

/** Mirrors the backend keys in electron/services/brain/queue.ts. */
const AUTO_INDEX_KEY = 'brain.autoIndex';
const PAUSED_KEY = 'brain.queuePaused';
const CURATE_KEY = 'brain.curate';
const IDLE_MINUTES_KEY = 'brain.idleMinutes';
const SWEEP_HOURS_KEY = 'brain.sweepHours';

/**
 * Mirrors the defaults and ranges in electron/services/brain/queue.ts.
 *
 * Duplicated rather than imported because the renderer cannot import from
 * `electron/`. The backend clamps whatever arrives regardless, so a drift here
 * costs a misleading input hint and never a bad stored value.
 */
const IDLE_MINUTES = { def: 15, min: 1, max: 1440 };
const SWEEP_HOURS = { def: 24, min: 1, max: 720 };

/** Parse a stored setting the way the backend's readNumericSetting does. */
function readNumber(
  raw: string | null,
  range: { def: number; min: number; max: number },
): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return range.def;
  return Math.min(range.max, Math.max(range.min, parsed));
}

/**
 * Optimistic, then persisted: a toggle is the user's own action, and a control
 * that lags a round trip reads as broken. A failed write puts it back and says
 * why, so the switch never lies about what was stored.
 */
function persistSwitch(
  key: string,
  next: boolean,
  apply: (v: boolean) => void,
  onError: (message: string) => void,
): void {
  apply(next);
  api.saveSetting(key, next ? 'true' : 'false').catch((err: Error) => {
    apply(!next);
    onError(err.message);
  });
}

/**
 * Persist a number, reverting the control if the write fails.
 *
 * Applies first like `persistSwitch` — the value is already clamped and the
 * user typed it — but the revert restores the PREVIOUS value rather than the
 * negation, which is the only difference a number makes.
 */
function persistNumber(
  key: string,
  next: number,
  prev: number,
  apply: (v: number) => void,
  onError: (message: string) => void,
): void {
  apply(next);
  api.saveSetting(key, String(next)).catch((err: Error) => {
    apply(prev);
    onError(err.message);
  });
}

/**
 * A labelled number box for one persistent setting.
 *
 * Deliberately NOT optimistic on every change like `persistSwitch`: a switch
 * has one event per user decision, a text box has one per keystroke, and
 * writing on each would persist every intermediate value typed on the way to
 * the one they meant. Commits on blur or Enter instead, and restores the
 * stored value on Escape, so the box never shows a number the backend does
 * not hold.
 */
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

  // The stored value is authoritative: when it changes underneath this — the
  // initial read landing, or a failed write reverting — the box follows.
  useEffect(() => { setDraft(String(value)); }, [value]);

  const commit = useCallback(() => {
    const parsed = Number.parseInt(draft.trim(), 10);
    // The same clamp-or-fall-back rule readNumericSetting applies, so what the
    // box accepts and what the backend stores can never disagree.
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

/** A labelled switch for one persistent setting. */
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

/**
 * Queue depth, the actions that change it, and anything that failed.
 *
 * Pause/Resume lives here rather than with the switches: stopping a run in
 * progress is something you DO, and it belongs beside the buttons whose work
 * it stops.
 */
export const BrainQueueActions: React.FC<{
  accountId: number | null;
  /**
   * Bumped by the owner when something OUTSIDE this panel changed the queue —
   * a background drain on session close, or the Sources pane's Refresh.
   *
   * Its own controls already re-read via `nonce`; this covers the changes it
   * has no way to notice, which is the other half of the stale-read the
   * comment below describes.
   */
  refreshToken?: number;
}> = ({ accountId, refreshToken = 0 }) => {
  const [counts, setCounts] = useState<BrainQueueCounts>(EMPTY);
  const [entries, setEntries] = useState<BrainQueueEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [paused, setPaused] = useState(false);

  // Re-read on `nonce`, i.e. after every action — not only at mount. Reading
  // once is the stale-read bug this tab has now shipped three times: a pause
  // applied from anywhere else left this showing the opposite of the truth.
  useEffect(() => {
    let cancelled = false;
    void api
      .getSetting(PAUSED_KEY)
      .then((pause) => { if (!cancelled) setPaused(pause === 'true'); })
      .catch(() => {
        // A failed read leaves it un-paused, matching the stored default.
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
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [accountId, nonce, refreshToken]);

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
    <div className="text-xs">
      <div className="flex flex-wrap items-center gap-3">
        {/* The queue's own reading, boxed away from the buttons beside it —
            four counts run together read as one sentence about nothing. */}
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

        {/* No bulk index button. Indexing is driven by the checked rows below
            (Index Selected) and by the worker, which drains this queue when a
            session closes. A control that ran everything pending is what
            indexed 158 sessions — about an hour of Sonnet — when the user
            meant to index the one row they had ticked. */}

        {/* A button, not a checkbox: stopping a run in progress is an action,
            and the label has to say what pressing it will DO. */}
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

/**
 * The three switches that let the Brain spend without being asked.
 *
 * Grouped under Settings because that is where someone goes to turn unattended
 * spending off. Each is off by default, and a failed settings read leaves them
 * that way — the safe direction, since it can never turn spending ON by
 * accident.
 */
export const BrainAutomationSettings: React.FC<{ accountId: number | null }> = ({ accountId }) => {
  const [autoIndex, setAutoIndex] = useState(false);
  const [curate, setCurate] = useState(false);
  const [idleMinutes, setIdleMinutes] = useState(IDLE_MINUTES.def);
  const [sweepHours, setSweepHours] = useState(SWEEP_HOURS.def);
  const [error, setError] = useState<string | null>(null);
  // Unlike the two above, this one IS per account — it writes into one
  // account's Claude config — so it re-reads whenever the account changes.
  const [mcpStatus, setMcpStatus] = useState({ registered: false, available: false });

  // These settings are GLOBAL, not per account — deliberately not re-read when
  // the account changes, which would imply a scoping they do not have.
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
        // Leaves both switches off — never turns unattended spending on by
        // accident — and both numbers at the shipped defaults.
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
        // Unknown reads as "not exposed", which is the safe direction: it can
        // never imply residue exists in a config dir when it does not.
        if (!cancelled) setMcpStatus({ registered: false, available: false });
      });
    return () => { cancelled = true; };
  }, [accountId]);

  const setMcpRegistered = useCallback((next: boolean) => {
    if (accountId === null) return;
    // Not optimistic, unlike the two global switches: this one writes into a
    // real Claude config dir, and showing it flipped before the write landed
    // would claim residue that may not exist.
    setError(null);
    const call = next ? api.brainMcpRegister(accountId) : api.brainMcpUnregister(accountId);
    void call
      .then(() => { setMcpStatus((prev) => ({ ...prev, registered: next })); })
      .catch((err: Error) => { setError(err.message); });
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

        {/* Indented under the switch they modify, and hidden while it is off:
            neither value means anything until auto-indexing is on, and a knob
            for a disabled feature reads as a knob that does nothing. */}
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
