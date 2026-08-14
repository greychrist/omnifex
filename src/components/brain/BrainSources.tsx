import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import {
  api,
  type BrainRun,
  type BrainSourcePreview,
  type BrainSourceSummary,
} from '@/lib/api';
import { BrainQueueActions } from './BrainQueuePanel';
import { BrainSourcesTable, rowId } from './BrainSourcesTable';
import { BrainProjectExclusions } from './BrainProjectExclusions';
import { Popover } from '@/components/ui/popover';

/** Bumped to re-run the listing effect after an indexing run changes a status. */
type Nonce = number;

/**
 * The Sources pane: what the session adapter found, what the admission gate
 * decided, and what a distilled transcript actually looks like.
 *
 * This is why step 3 of the build sequence ships before step 4. If
 * distillation output looks like noise here, no API budget was spent finding
 * that out.
 *
 * It is NOT the operational pane from spec §14 — queue depth, Index-now,
 * pause, kill switch. Those arrive in Plan 4 with the worker that gives them
 * something to control; an operations panel over a queue nothing drains would
 * be a control surface for nothing.
 */
export const BrainSources: React.FC<{
  accountId: number | null;
  /**
   * Called when this pane did something that changes the vault as a whole —
   * a run finished, or the user asked for a refresh.
   *
   * The stats bar ("Spent indexing", "Notes in vault") is a SIBLING of this
   * pane and reads `brain_stats` on its own, so nothing here can re-read it.
   * Without this the cost figure kept showing a number from before the spend,
   * and only closing and reopening the tab ever corrected it.
   */
  onVaultChanged?: () => void;
}> = ({ accountId, onVaultChanged }) => {
  const [items, setItems] = useState<BrainSourceSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<BrainSourcePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * True between pressing an index button and the call settling.
   *
   * Distinct from `runProgress`, which is the main process's view: this covers
   * the round trip before the first frame lands, so the button cannot be
   * pressed twice into a run that exists but has not reported yet.
   */
  const [starting, setStarting] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [nonce, setNonce] = useState<Nonce>(0);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [managing, setManaging] = useState(false);
  /**
   * The run in flight, as the MAIN PROCESS reports it. `completed` counts
   * items that have FINISHED, and `item` names the one in flight.
   *
   * Not owned here: this pane unmounts whenever the Brain tab's sub-tab
   * changes, and a run that lived in component state died with it — the user
   * came back to tokens still being spent and nothing on screen saying so. It
   * is seeded from `brainCurrentRun` on mount and then followed by pushed
   * frames, so a run started before this component existed still draws.
   */
  const [runProgress, setRunProgress] = useState<BrainRun | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  /** Any index button is live work: either starting, or already reported. */
  const indexing = starting || runProgress !== null;

  /**
   * Held in a ref, not read directly, so the effects below can announce a
   * change without listing the callback as a dependency.
   *
   * The owner passes an inline closure, which is a new function every render;
   * depending on it would re-subscribe on every render and, via the setState
   * that subscription performs, loop forever. Same ref-capture rule the tab
   * system's callback props follow.
   */
  const onVaultChangedRef = useRef(onVaultChanged);
  useEffect(() => { onVaultChangedRef.current = onVaultChanged; });

  /**
   * Re-list here, and tell the owner to re-read what only it can reach.
   *
   * Every path that changes what the vault contains or costs goes through
   * this, so no caller has to remember there are two things to refresh.
   */
  const reload = useCallback(() => {
    setNonce((n) => n + 1);
    onVaultChangedRef.current?.();
  }, []);

  // Both are account-scoped: carrying either across a switch would render one
  // account's material under another account's header.
  useEffect(() => {
    setSelected(null);
    setPreview(null);
    setOutcome(null);
    // A selection is a set of this account's item keys; carrying it across a
    // switch would run work against the wrong vault.
    setSelectedRows(new Set());
    setManaging(false);
  }, [accountId]);

  useEffect(() => {
    if (accountId === null) return;
    let cancelled = false;
    setLoading(true);
    api
      .brainListSources(accountId, { includeExcluded: true })
      .then((rows) => {
        if (cancelled) return;
        setItems(rows);
        setError(null);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setItems([]);
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, nonce]);

  /**
   * Pick up a run already in flight.
   *
   * Runs on mount and on every account switch, because either can leave this
   * pane looking at work it never saw start — a sub-tab switch unmounts it
   * outright. The equivalent of SessionList asking `summary_generating_now`.
   */
  useEffect(() => {
    if (accountId === null) return;
    let cancelled = false;
    api
      .brainCurrentRun(accountId)
      .then((run) => { if (!cancelled) setRunProgress(run); })
      // A run we cannot ask about is not worth an error banner over the whole
      // pane: the listing below is still perfectly usable.
      .catch(() => { if (!cancelled) setRunProgress(null); });
    return () => { cancelled = true; };
  }, [accountId]);

  /**
   * Follow the run the main process is actually executing.
   *
   * A `null` frame means it ended: drop the banner and re-list, since the run
   * just changed the statuses the table is showing.
   */
  useEffect(() => {
    if (accountId === null) return;
    return api.onBrainRunProgress((run) => {
      // Another account's run is not this pane's to draw, and clearing on its
      // terminating null would blank a banner this account still owns.
      if (run !== null && run.accountId !== accountId) return;
      setRunProgress(run);
      // A finished run changed both the rows and the vault's totals.
      if (run === null) reload();
    });
  }, [accountId, reload]);

  const select = useCallback(
    (itemKey: string) => {
      if (accountId === null) return;
      setSelected(itemKey);
      setPreview(null);
      setOutcome(null);
      api
        .brainSourcePreview(accountId, itemKey)
        .then(setPreview)
        .catch((err: Error) => setError(err.message));
    },
    [accountId],
  );

  /**
   * Start a run in the main process and report what it cost.
   *
   * The loop deliberately lives on the other side of this call. Here it was a
   * `for` over the selection, which meant unmounting the pane — a Brain sub-tab
   * switch does exactly that — left the run spending tokens with no progress
   * on screen and no completion refresh at the end.
   *
   * Still exactly the ticked items, never a queue drain: draining processes
   * everything pending, which is how "Drain now" once ran 158 sessions for one
   * selected row.
   */
  const startRun = useCallback(
    (itemKeys: string[]) => {
      if (accountId === null || itemKeys.length === 0) return;
      setStarting(true);
      setOutcome(null);
      setError(null);
      // An optimistic first frame, so the banner is up before the round trip
      // returns. Real frames overwrite it within milliseconds.
      setRunProgress({
        accountId, total: itemKeys.length, completed: 0, item: itemKeys[0],
        written: 0, skipped: 0,
      });

      api
        .brainIndexSelection(accountId, itemKeys)
        .then((result) => {
          // One item can say exactly why; a selection can only report totals.
          // "indexed 0, skipped 1" is not an answer a user can act on when
          // they asked about one specific file.
          const only = result.results.length === 1 ? result.results[0] : null;
          setOutcome(
            only
              ? only.skipped
                ? `Not indexed: ${only.reason}`
                : `Indexed — ${only.notesWritten.join(', ') || 'nothing worth a note'}`
              : `indexed ${String(result.written)}, skipped ${String(result.skipped)}`,
          );
          setSelectedRows(new Set());
          // Re-listing is what turns a row's status from null to indexed.
          // Without it the button looks like it did nothing.
          reload();
        })
        // Only whole-run failures land here — no vault, a run already in
        // flight. Per-item outcomes come back in `results` above.
        .catch((err: Error) => { setError(err.message); })
        .finally(() => {
          setStarting(false);
          // The main process also sends a terminating null; clearing here too
          // covers the case where this window missed it.
          setRunProgress(null);
        });
    },
    [accountId],
  );

  /** The preview panel's button: the one row being looked at. */
  const index = useCallback(() => {
    if (selected === null) return;
    startRun([selected]);
  }, [selected, startRun]);

  /** The action bar's button: every ticked row. */
  const indexSelected = useCallback(() => {
    const targets = items.filter((r) => selectedRows.has(rowId(r)));
    startRun(targets.map((r) => r.itemKey));
  }, [items, selectedRows, startRun]);

  /**
   * Re-read this page on demand — the rows here AND the stats bar above.
   *
   * "Refresh" has to mean everything on the page, not everything in this
   * component: pressing it and watching a stale cost figure sit there is
   * exactly the report that produced this. Stays live during a run on
   * purpose, since a run only re-lists once the WHOLE selection finishes.
   */
  const refresh = reload;

  /**
   * Each row already carries the effective verdict, so the exclusion state is
   * read off the listing rather than fetched separately. One source of truth,
   * and no window in which the checkboxes and the rows disagree.
   */
  const excluded = useMemo(
    () => new Set(items.filter((r) => r.excluded).map((r) => r.label)),
    [items],
  );

  const toggleExcluded = useCallback(
    (path: string, exclude: boolean) => {
      if (accountId === null) return;
      // Every project's decision goes over, not just the excluded ones. An
      // absent key means "not decided", which leaves the scratch-path default
      // in force — so an exclusions-only payload would silently re-exclude a
      // temp project the user had deliberately re-included.
      const decisions: Record<string, boolean> = {};
      for (const row of items) decisions[row.label] = row.excluded;
      decisions[path] = exclude;
      api
        .brainSetExcludedProjects(accountId, decisions)
        .then(() => { setNonce((n) => n + 1); })
        .catch((err: Error) => { setError(err.message); });
    },
    [accountId, items],
  );

  /** Rows the table shows: excluded projects are hidden unless being managed. */
  const visibleRows = useMemo(
    () => (managing ? items : items.filter((r) => !r.excluded)),
    [items, managing],
  );

  const closePreview = useCallback(() => {
    setSelected(null);
    setPreview(null);
    setOutcome(null);
  }, []);

  /**
   * A press away from the table clears the selection.
   *
   * "Away" excludes the preview itself: a mousedown there would unmount the
   * panel before the click reached its own Index or close button, so the
   * preview's controls would never fire. Everything else — the action bar, the
   * queue panel, empty space — dismisses.
   */
  useEffect(() => {
    if (selected === null) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (tableRef.current?.contains(target)) return;
      if (previewRef.current?.contains(target)) return;
      closePreview();
    };
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('mousedown', onDown); };
  }, [selected, closePreview]);

  if (accountId === null) {
    return <div className="p-4 text-xs text-muted-foreground">Select an account.</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The queue's actions, above the list they act on. The persistent
          switches that let it spend unattended live under Settings. */}
      <div className="border-b bg-background px-4 py-2">
        {/* `nonce` is bumped by `reload()`, so Refresh and a finished run
            reach the queue chip too — it sits on this bar and a background
            drain changes its counts with nothing here to notice. */}
        <BrainQueueActions accountId={accountId} refreshToken={nonce} />
      </div>
      <div className="flex min-h-0 flex-1">
      {/* The table takes the whole pane until something is selected — there is
          nothing to reserve room for. */}
      <div
        className={`flex min-h-0 flex-col ${
          selected === null ? 'flex-1' : 'w-[40rem] shrink-0 border-r'
        }`}
      >
        {/* The action bar. Its own surface, above the filter bar and the table
            — three stacked rows that all looked alike read as one undivided
            slab. */}
        <div className="flex flex-wrap items-center gap-2 border-b bg-background px-3 py-2 text-xs">
          <button
            type="button"
            onClick={indexSelected}
            disabled={indexing || selectedRows.size === 0}
            className="rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            Index Selected ({selectedRows.size})
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-md border px-2 py-1 hover:bg-accent disabled:opacity-40"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          {/* A popover, not an inline block: expanding in place pushed the
              whole table down, so the rows being talked about moved off
              screen the moment you went to change them. */}
          <Popover
            open={managing}
            onOpenChange={setManaging}
            align="start"
            className="max-h-96 w-[40rem] overflow-y-auto p-0"
            trigger={
              <button
                type="button"
                onClick={() => { setManaging((m) => !m); }}
                aria-pressed={managing}
                aria-expanded={managing}
                className="rounded-md border px-2 py-1 hover:bg-accent"
              >
                Projects{excluded.size > 0 ? ` (${String(excluded.size)} excluded)` : ''}
              </button>
            }
            content={
              <BrainProjectExclusions
                rows={items}
                excluded={excluded}
                onToggle={toggleExcluded}
                onClose={() => { setManaging(false); }}
              />
            }
          />
          {outcome && !runProgress && <span className="text-muted-foreground">{outcome}</span>}
        </div>

        {/* Above the table, where the user is looking. A ~20s model call whose
            only sign was a disabled button in the side panel was
            indistinguishable from a dead button. */}
        {runProgress && (
          <div role="status" aria-live="polite" className="border-b bg-primary/5 px-3 py-2 text-xs">
            <div className="mb-1 flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              <span className="font-medium">
                {runProgress.total > 1
                  ? `Indexing ${String(runProgress.completed + 1)} of ${String(runProgress.total)}`
                  : 'Indexing'}
              </span>
              <span className="truncate text-muted-foreground">{runProgress.item}</span>
            </div>
            {/* One item is the only unit of progress there is: `indexSource`
                distills and extracts behind a single await and reports nothing
                partway. So a lone item gets a sweep, not a percentage — the
                fraction would be 0% for the whole call and then gone. */}
            <div
              role="progressbar"
              aria-label="Indexing progress"
              {...(runProgress.total > 1
                ? {
                    'aria-valuemin': 0,
                    'aria-valuemax': runProgress.total,
                    'aria-valuenow': runProgress.completed,
                  }
                : {})}
              className="h-1 w-full overflow-hidden rounded bg-muted"
            >
              {runProgress.total > 1 ? (
                <div
                  className="h-full bg-primary transition-[width] duration-300"
                  style={{
                    width: `${String(Math.round((runProgress.completed / runProgress.total) * 100))}%`,
                  }}
                />
              ) : (
                <div className="brain-indeterminate-bar h-full w-1/3 rounded bg-primary" />
              )}
            </div>
          </div>
        )}

        {/* Errors belong beside the table, not in the preview: a listing
            failure happens with nothing selected, and the preview is not
            rendered then. */}
        {error && <div className="border-b px-3 py-2 text-xs text-destructive">{error}</div>}

        {loading && <div className="p-3 text-xs text-muted-foreground">scanning…</div>}
        {!loading && (
          <div ref={tableRef} className="flex min-h-0 flex-1 flex-col">
            <BrainSourcesTable
              rows={visibleRows}
              selected={selectedRows}
              onSelectedChange={setSelectedRows}
              activeItemKey={selected}
              // Which row the indexer is actually on. The banner counts
              // "3 of 20" without saying which of these rows it means.
              indexingItemKey={runProgress?.item ?? null}
              onOpen={select}
            />
          </div>
        )}
      </div>

      {/* Rendered only for a selected row. An empty panel holding a "select
          something" placeholder took half the pane to say nothing. */}
      {selected !== null && (
      <div ref={previewRef} className="min-w-0 flex-1 overflow-y-auto p-4">
        <div className="mb-3 flex items-center gap-3">
          {preview?.admitted === true && (
            <button
              type="button"
              onClick={index}
              disabled={indexing}
              className="rounded-md border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              {indexing ? 'Indexing…' : 'Index'}
            </button>
          )}
          {/* The outcome renders once, in the action bar above: both the
              per-item Index and Index Selected report through it, and
              showing the same message twice made it read as two results. */}
          <button
            type="button"
            onClick={closePreview}
            aria-label="Close preview"
            className="ml-auto rounded-md border px-2 py-0.5 text-xs hover:bg-accent"
          >
            ✕
          </button>
        </div>
        {!preview && !error && (
          <div className="text-xs text-muted-foreground">distilling…</div>
        )}
        {preview && (
          <>
            <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              {preview.metadata === null ? (
                <>
                  {/* A translating source: no distillation, so what it would
                      write IS the preview. */}
                  <dt className="text-muted-foreground">writes</dt>
                  <dd className="truncate">{preview.notePaths.join(', ') || '—'}</dd>
                  <dt className="text-muted-foreground">model</dt>
                  <dd>not used</dd>
                </>
              ) : preview.metadata.kind === 'artifact' ? (
                <>
                  <dt className="text-muted-foreground">repository</dt>
                  <dd className="truncate">{preview.metadata.repoPath}</dd>
                  <dt className="text-muted-foreground">file</dt>
                  <dd className="truncate">{preview.metadata.file}</dd>
                </>
              ) : preview.metadata.kind === 'capture' ? (
                <>
                  <dt className="text-muted-foreground">captured</dt>
                  <dd>{preview.metadata.capturedAt.slice(0, 10) || '—'}</dd>
                  <dt className="text-muted-foreground">project</dt>
                  <dd className="truncate">{preview.metadata.project ?? '—'}</dd>
                  <dt className="text-muted-foreground">directory</dt>
                  <dd className="truncate">{preview.metadata.cwd ?? '—'}</dd>
                </>
              ) : (
                <>
                  <dt className="text-muted-foreground">project</dt>
                  <dd className="truncate">{preview.metadata.projectPath ?? '—'}</dd>
                  <dt className="text-muted-foreground">branch</dt>
                  <dd>{preview.metadata.gitBranch ?? '—'}</dd>
                  <dt className="text-muted-foreground">models</dt>
                  <dd>{preview.metadata.models.join(', ') || '—'}</dd>
                  <dt className="text-muted-foreground">turns</dt>
                  <dd>
                    {preview.metadata.promptCount} prompts · {preview.metadata.proseCount} replies
                  </dd>
                  <dt className="text-muted-foreground">files</dt>
                  <dd>{preview.metadata.filesTouched.length}</dd>
                  <dt className="text-muted-foreground">outcome</dt>
                  <dd>{preview.metadata.terminalStatus}</dd>
                </>
              )}
            </dl>
            {preview.truncated && (
              <div className="mb-2 text-xs text-amber-600">
                Truncated to the distillation ceiling — oldest assistant replies dropped first.
              </div>
            )}
            <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
              {preview.prose}
            </pre>
          </>
        )}
      </div>
      )}
      </div>
    </div>
  );
};

export default BrainSources;
