import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { api, type BrainSearchHit } from '@/lib/api';
import { formatRecalledNotes } from '@/lib/localSlashCommands';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface RecallDialogProps {
  open: boolean;
  accountId: number;
  onOpenChange: (open: boolean) => void;
  /** Receives the formatted block to insert at the cursor. */
  onInsert: (text: string) => void;
}

/**
 * `/recall` — search one account's Brain and insert whole notes into the
 * prompt.
 *
 * Scoped to the session's own account and never merged across vaults, the same
 * rule the Brain tab enforces: merged-with-badges would make cross-account
 * leakage a rendering detail rather than an impossibility.
 */
export const RecallDialog: React.FC<RecallDialogProps> = ({
  open,
  accountId,
  onOpenChange,
  onInsert,
}) => {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<BrainSearchHit[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [inserting, setInserting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh dialog every time: a stale result list from the previous /recall
  // would invite inserting a note the user did not just search for.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHits([]);
    setSelected([]);
    setError(null);
  }, [open]);

  const runSearch = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setHits([]);
        return;
      }
      setSearching(true);
      setError(null);
      try {
        setHits(await api.brainSearch(accountId, q));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed');
        setHits([]);
      } finally {
        setSearching(false);
      }
    },
    [accountId],
  );

  const toggle = useCallback((notePath: string) => {
    setSelected((prev) =>
      prev.includes(notePath) ? prev.filter((p) => p !== notePath) : [...prev, notePath],
    );
  }, []);

  const insert = useCallback(async () => {
    if (selected.length === 0) return;
    setInserting(true);
    setError(null);
    try {
      const notes = await Promise.all(
        selected.map(async (path) => ({
          path,
          body: (await api.brainReadNote(accountId, path)).body,
        })),
      );
      onInsert(formatRecalledNotes(notes));
      onOpenChange(false);
    } catch (err) {
      // A note that cannot be read must not close the dialog on a silent
      // no-op: the user would think they inserted something.
      setError(err instanceof Error ? err.message : 'Could not read the selected notes');
    } finally {
      setInserting(false);
    }
  }, [accountId, selected, onInsert, onOpenChange]);

  const insertLabel = useMemo(
    () => (selected.length === 1 ? 'Insert 1 note' : `Insert ${String(selected.length)} notes`),
    [selected.length],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Recall from the Brain</DialogTitle>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch(query);
          }}
          className="flex gap-2"
        >
          <Input
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); }}
            placeholder="Search notes — identifiers and file names work well"
            aria-label="Search the Brain"
          />
          <Button type="submit" disabled={searching || !query.trim()}>
            {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          </Button>
        </form>

        {error && <div className="text-xs text-destructive">{error}</div>}

        <div className="max-h-80 overflow-y-auto">
          {hits.length === 0 && !searching && (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {query.trim() ? 'No matching notes.' : 'Search this account’s vault.'}
            </div>
          )}
          {hits.map((hit) => {
            const isSelected = selected.includes(hit.notePath);
            return (
              <button
                type="button"
                key={hit.notePath}
                aria-pressed={isSelected}
                onClick={() => { toggle(hit.notePath); }}
                className={cn(
                  'w-full rounded px-2 py-2 text-left transition-colors',
                  isSelected ? 'bg-primary/10' : 'hover:bg-muted/50',
                )}
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium">{hit.title}</span>
                  <span className="truncate text-xs text-muted-foreground">{hit.notePath}</span>
                </div>
                <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{hit.snippet}</div>
              </button>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => { onOpenChange(false); }}>
            Cancel
          </Button>
          <Button onClick={() => { void insert(); }} disabled={selected.length === 0 || inserting}>
            {inserting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {insertLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
