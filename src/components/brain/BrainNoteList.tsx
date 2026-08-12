import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useDebounce } from '@/hooks/useDebounce';
import { api, type BrainSearchHit } from '@/lib/api';
import { noteFolder, noteTitle } from '@/lib/brainWikilinks';
import { cn } from '@/lib/utils';

interface BrainNoteListProps {
  accountId: number | null;
  notes: string[];
  selected: string | null;
  onSelect: (notePath: string) => void;
}

const SEARCH_DEBOUNCE_MS = 200;

/**
 * Two modes, never mixed: browse (notes grouped by folder) and search (ranked
 * hits with snippets). Showing folder headers over ranked results would imply
 * a grouping that rank does not have, and interleaving the two lists would
 * make position meaningless.
 */
export const BrainNoteList: React.FC<BrainNoteListProps> = ({
  accountId, notes, selected, onSelect,
}) => {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<BrainSearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const debounced = useDebounce(query, SEARCH_DEBOUNCE_MS);

  /** Discards a slow response for a query the user has already moved past. */
  const searchToken = useRef(0);

  useEffect(() => {
    const token = ++searchToken.current;
    if (accountId === null || debounced.trim() === '') {
      setHits([]);
      setError(null);
      return;
    }
    api
      .brainSearch(accountId, debounced)
      .then((result) => {
        if (searchToken.current !== token) return;
        setHits(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (searchToken.current !== token) return;
        // An empty list here would read as "nothing matched", which is a
        // different and much more reassuring claim than "the search failed".
        setError((err as Error).message);
        setHits([]);
      });
  }, [accountId, debounced]);

  const grouped = useMemo(() => {
    const byFolder = new Map<string, string[]>();
    for (const path of notes) {
      const folder = noteFolder(path);
      const list = byFolder.get(folder) ?? [];
      list.push(path);
      byFolder.set(folder, list);
    }
    return [...byFolder.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([folder, paths]) => ({
        folder,
        paths: [...paths].sort((a, b) => noteTitle(a).localeCompare(noteTitle(b))),
      }));
  }, [notes]);

  const searching = query.trim() !== '';

  const noteButton = (path: string, label: React.ReactNode): React.ReactElement => (
    <button
      key={path}
      type="button"
      onClick={() => { onSelect(path); }}
      className={cn(
        'block w-full truncate px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground',
        selected === path && 'bg-accent text-accent-foreground',
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="relative border-b p-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => { setQuery(e.target.value); }}
          placeholder="Search this vault"
          className="h-7 pl-7 text-xs"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {error !== null && (
          <p className="px-3 py-2 text-xs text-destructive">{error}</p>
        )}

        {error === null && searching && hits.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">No matches.</p>
        )}

        {error === null && searching && hits.map((h) => noteButton(
          h.notePath,
          <span className="block">
            <span className="block truncate font-medium">{h.title}</span>
            <span className="block truncate text-[11px] text-muted-foreground">{h.snippet}</span>
          </span>,
        ))}

        {!searching && notes.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            No notes in this vault yet.
          </p>
        )}

        {!searching && grouped.map(({ folder, paths }) => (
          <div key={folder} className="pb-1">
            <p className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {folder}
            </p>
            {paths.map((path) => noteButton(path, noteTitle(path)))}
          </div>
        ))}
      </div>
    </div>
  );
};

export default BrainNoteList;
