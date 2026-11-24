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
import { PHASE_LABEL, formatElapsed, useRunClock } from './runProgress';
import { SplitHandle } from '@/components/ui/SplitHandle';
import { useSplitWidth } from '@/hooks/useSplitWidth';

type Nonce = number;

export const BrainSources: React.FC<{
  accountId: number | null;
  /** Call after any vault change: the stats bar is a sibling and re-reads only on this. */
  onVaultChanged?: () => void;
}> = ({ accountId, onVaultChanged }) => {
  const [items, setItems] = useState<BrainSourceSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<BrainSourcePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [nonce, setNonce] = useState<Nonce>(0);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [managing, setManaging] = useState(false);
  // Seeded from brainCurrentRun on mount: a sub-tab switch unmounts this pane mid-run.
  const [runProgress, setRunProgress] = useState<BrainRun | null>(null);
  const now = useRunClock(runProgress !== null);
  const tableRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const splitRef = useRef<HTMLDivElement>(null);
  const split = useSplitWidth({
    storageKey: 'omnifex.brain.sourcesSplit',
    defaultWidth: 640,
    min: 320,
    minRight: 360,
    containerRef: splitRef,
  });

  const indexing = starting || runProgress !== null;

  // Ref, not a dep: the owner passes an inline closure, and depending on it loops forever.
  const onVaultChangedRef = useRef(onVaultChanged);
  useEffect(() => { onVaultChangedRef.current = onVaultChanged; });

  const reload = useCallback(() => {
    setNonce((n) => n + 1);
    onVaultChangedRef.current?.();
  }, []);

  useEffect(() => {
    setSelected(null);
    setPreview(null);
    setOutcome(null);
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
      .catch((err: unknown) => {
        if (cancelled) return;
        setItems([]);
        setError((err instanceof Error ? err.message : String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, nonce]);

  useEffect(() => {
    if (accountId === null) return;
    let cancelled = false;
    api
      .brainCurrentRun(accountId)
      .then((run) => { if (!cancelled) setRunProgress(run); })
      .catch(() => { if (!cancelled) setRunProgress(null); });
    return () => { cancelled = true; };
  }, [accountId]);

  useEffect(() => {
    if (accountId === null) return;
    return api.onBrainRunProgress((run) => {
      if (run !== null && run.accountId !== accountId) return;
      setRunProgress(run);
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
        .catch((err: unknown) => setError((err instanceof Error ? err.message : String(err))));
    },
    [accountId],
  );

  // The run loop lives in main (this pane unmounts on sub-tab switch). Only the ticked items, never a queue drain.
  const startRun = useCallback(
    (itemKeys: string[]) => {
      if (accountId === null || itemKeys.length === 0) return;
      setStarting(true);
      setOutcome(null);
      setError(null);
      setRunProgress({
        accountId, total: itemKeys.length, completed: 0, item: itemKeys[0],
        label: itemKeys[0], phase: 'preparing', startedAt: Date.now(),
        written: 0, skipped: 0,
      });

      api
        // force: only an explicit press reaches here; the admission gate is for unattended indexing.
        .brainIndexSelection(accountId, itemKeys, { force: true })
        .then((result) => {
          const only = result.results.length === 1 ? result.results[0] : null;
          setOutcome(
            only
              ? only.skipped
                ? `Not indexed: ${only.reason}`
                : `Indexed — ${only.notesWritten.join(', ') || 'nothing worth a note'}`
              : `indexed ${String(result.written)}, skipped ${String(result.skipped)}`,
          );
          setSelectedRows(new Set());
          reload();
        })
        .catch((err: unknown) => { setError((err instanceof Error ? err.message : String(err))); })
        .finally(() => {
          setStarting(false);
          // Also cleared here in case this window missed main's terminating null.
          setRunProgress(null);
        });
    },
    [accountId, reload],
  );

  const index = useCallback(() => {
    if (selected === null) return;
    startRun([selected]);
  }, [selected, startRun]);

  const indexSelected = useCallback(() => {
    const targets = items.filter((r) => selectedRows.has(rowId(r)));
    startRun(targets.map((r) => r.itemKey));
  }, [items, selectedRows, startRun]);

  const refresh = reload;

  const excluded = useMemo(
    () => new Set(items.filter((r) => r.excluded).map((r) => r.label)),
    [items],
  );

  const toggleExcluded = useCallback(
    (path: string, exclude: boolean) => {
      if (accountId === null) return;
      // Send every decision: an absent key re-applies the scratch-path default exclusion.
      const decisions: Record<string, boolean> = {};
      for (const row of items) decisions[row.label] = row.excluded;
      decisions[path] = exclude;
      api
        .brainSetExcludedProjects(accountId, decisions)
        .then(() => { setNonce((n) => n + 1); })
        .catch((err: unknown) => { setError((err instanceof Error ? err.message : String(err))); });
    },
    [accountId, items],
  );

  const visibleRows = useMemo(
    () => (managing ? items : items.filter((r) => !r.excluded)),
    [items, managing],
  );

  const closePreview = useCallback(() => {
    setSelected(null);
    setPreview(null);
    setOutcome(null);
  }, []);

  // Presses in the preview or on the splitter don't dismiss: mousedown would unmount the panel before its click lands.
  useEffect(() => {
    if (selected === null) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (tableRef.current?.contains(target)) return;
      if (previewRef.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest('[data-omnifex-split-handle]') !== null
      ) {
        return;
      }
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
      <div className="border-b bg-background px-4 py-2">
        <BrainQueueActions accountId={accountId} refreshToken={nonce} />
      </div>
      <div ref={splitRef} className="flex min-h-0 flex-1">
      <div
        className={`flex min-h-0 flex-col ${selected === null ? 'flex-1' : 'shrink-0'}`}
        style={selected === null ? undefined : { width: split.width }}
      >
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

        {runProgress && (
          <div role="status" aria-live="polite" className="border-b bg-primary/5 px-3 py-2 text-xs">
            <div className="mb-1 flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              {/* Counter shown even at "1 of 1": queue-drain runs are mostly one item. */}
              <span className="font-medium">
                {`Indexing ${String(runProgress.completed + 1)} of ${String(runProgress.total)} · ${PHASE_LABEL[runProgress.phase]}`}
              </span>
              <span className="truncate">{runProgress.label}</span>
              <span className="truncate font-mono text-muted-foreground">{runProgress.item}</span>
              <span className="ml-auto tabular-nums text-muted-foreground">
                {formatElapsed(now - runProgress.startedAt)}
              </span>
            </div>
            {/* A lone item reports no partial progress, so it gets a sweep, not a percentage. */}
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

        {error && <div className="border-b px-3 py-2 text-xs text-destructive">{error}</div>}

        {loading && <div className="p-3 text-xs text-muted-foreground">scanning…</div>}
        {!loading && (
          <div ref={tableRef} className="flex min-h-0 flex-1 flex-col">
            <BrainSourcesTable
              rows={visibleRows}
              selected={selectedRows}
              onSelectedChange={setSelectedRows}
              activeItemKey={selected}
              indexingItemKey={runProgress?.item ?? null}
              onOpen={select}
            />
          </div>
        )}
      </div>

      {selected !== null && (
      <SplitHandle
        label="Resize the sources list"
        onMouseDown={split.startResize}
        onDoubleClick={split.reset}
      />
      )}
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
