import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type BrainSourcePreview, type BrainSourceSummary } from '@/lib/api';
import { BrainQueuePanel } from './BrainQueuePanel';
import { BrainSourcesTable, rowId } from './BrainSourcesTable';
import { BrainProjectExclusions } from './BrainProjectExclusions';

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
export const BrainSources: React.FC<{ accountId: number | null }> = ({ accountId }) => {
  const [items, setItems] = useState<BrainSourceSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<BrainSourcePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [nonce, setNonce] = useState<Nonce>(0);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [managing, setManaging] = useState(false);
  const [runProgress, setRunProgress] = useState<{ current: number; total: number } | null>(null);

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
   * The only control in this app that spends tokens on its own. One item at a
   * time and only on an explicit press — Plan 4b's worker is what makes this
   * automatic, and it does not exist yet.
   */
  const index = useCallback(() => {
    if (accountId === null || selected === null) return;
    setIndexing(true);
    setOutcome(null);
    setError(null);
    api
      .brainIndexSource(accountId, selected)
      .then((result) => {
        setOutcome(
          result.skipped
            ? `Not indexed: ${result.reason}`
            : `Indexed — ${result.notesWritten.join(', ') || 'nothing worth a note'}`,
        );
        // Re-listing is what turns this row's status from null to indexed.
        // Without it the button looks like it did nothing.
        setNonce((n) => n + 1);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => { setIndexing(false); });
  }, [accountId, selected]);

  /**
   * Index exactly the checked rows — one direct call each, not a queue drain.
   *
   * Draining would process everything pending, which is the whole reason the
   * original "Drain now" ran 158 sessions when one was selected. A sequential
   * loop over the selection cannot reach anything the user did not tick.
   */
  const indexSelected = useCallback(() => {
    if (accountId === null || selectedRows.size === 0) return;
    const targets = items.filter((r) => selectedRows.has(rowId(r)));
    setIndexing(true);
    setOutcome(null);
    setError(null);

    void (async () => {
      let written = 0;
      let skipped = 0;
      for (const [i, r] of targets.entries()) {
        setRunProgress({ current: i + 1, total: targets.length });
        try {
          const result = await api.brainIndexSource(accountId, r.itemKey);
          if (result.skipped) skipped += 1;
          else written += 1;
        } catch (err) {
          // One bad item must not abandon the rest of the selection.
          setError((err as Error).message);
          skipped += 1;
        }
      }
      setRunProgress(null);
      setIndexing(false);
      setOutcome(`indexed ${String(written)}, skipped ${String(skipped)}`);
      setSelectedRows(new Set());
      setNonce((n) => n + 1);
    })();
  }, [accountId, items, selectedRows]);

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

  if (accountId === null) {
    return <div className="p-4 text-xs text-muted-foreground">Select an account.</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BrainQueuePanel accountId={accountId} />
      <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 w-[38rem] shrink-0 flex-col border-r">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
          <button
            type="button"
            onClick={indexSelected}
            disabled={indexing || selectedRows.size === 0}
            className="rounded-md border px-2 py-1 hover:bg-accent disabled:opacity-50"
          >
            Index Selected ({selectedRows.size})
          </button>
          <button
            type="button"
            onClick={() => { setManaging((m) => !m); }}
            aria-pressed={managing}
            className="rounded-md border px-2 py-1 hover:bg-accent"
          >
            Projects{excluded.size > 0 ? ` (${String(excluded.size)} excluded)` : ''}
          </button>
          {runProgress && (
            <span className="text-muted-foreground">
              Indexing {runProgress.current} of {runProgress.total}
            </span>
          )}
          {outcome && !runProgress && <span className="text-muted-foreground">{outcome}</span>}
        </div>

        {managing && (
          <BrainProjectExclusions
            rows={items}
            excluded={excluded}
            onToggle={toggleExcluded}
            onClose={() => { setManaging(false); }}
          />
        )}

        {loading && <div className="p-3 text-xs text-muted-foreground">scanning…</div>}
        {!loading && (
          <BrainSourcesTable
            rows={visibleRows}
            selected={selectedRows}
            onSelectedChange={setSelectedRows}
            activeItemKey={selected}
            onOpen={select}
          />
        )}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        {error && <div className="mb-3 text-xs text-destructive">{error}</div>}
        {!selected && !error && (
          <div className="text-xs text-muted-foreground">
            Select an item to preview its distillation.
          </div>
        )}
        {selected && !preview && !error && (
          <div className="text-xs text-muted-foreground">distilling…</div>
        )}
        {preview && (
          <>
            <div className="mb-3 flex items-center gap-3">
              {preview.admitted && (
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
            </div>
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
      </div>
    </div>
  );
};

export default BrainSources;
