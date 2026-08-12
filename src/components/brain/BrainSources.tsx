import React, { useCallback, useEffect, useState } from 'react';
import { api, type BrainSourcePreview, type BrainSourceSummary } from '@/lib/api';
import { BrainQueuePanel } from './BrainQueuePanel';

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

  // Both are account-scoped: carrying either across a switch would render one
  // account's material under another account's header.
  useEffect(() => {
    setSelected(null);
    setPreview(null);
    setOutcome(null);
  }, [accountId]);

  useEffect(() => {
    if (accountId === null) return;
    let cancelled = false;
    setLoading(true);
    api
      .brainListSources(accountId)
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

  if (accountId === null) {
    return <div className="p-4 text-xs text-muted-foreground">Select an account.</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BrainQueuePanel accountId={accountId} />
      <div className="flex min-h-0 flex-1">
      <div className="w-80 shrink-0 overflow-y-auto border-r">
        {loading && <div className="p-3 text-xs text-muted-foreground">scanning…</div>}
        {!loading && items.length === 0 && (
          <div className="p-3 text-xs text-muted-foreground">No transcripts found.</div>
        )}
        {items.map((item) => (
          <button
            key={`${item.sourceId}:${item.itemKey}`}
            type="button"
            onClick={() => { select(item.itemKey); }}
            aria-pressed={selected === item.itemKey}
            className={`block w-full border-b px-3 py-2 text-left text-xs hover:bg-accent ${
              selected === item.itemKey ? 'bg-accent' : ''
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  item.admitted ? 'bg-emerald-500' : 'bg-muted-foreground/40'
                }`}
              />
              <span className="truncate font-medium">{item.itemKey}</span>
            </div>
            <div className="truncate text-muted-foreground">{item.label}</div>
            <div className="truncate text-muted-foreground">{item.reason}</div>
          </button>
        ))}
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
              {outcome && <span className="text-xs text-muted-foreground">{outcome}</span>}
            </div>
            <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              {preview.metadata.kind === 'capture' ? (
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
                Truncated to the 8KB ceiling — oldest turns dropped.
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
