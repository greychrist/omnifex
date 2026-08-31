import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { api, type BrainNoteMeta, type BrainSearchHit } from '@/lib/api';
import { Popover } from '@/components/ui/popover';
import { useDebounce } from '@/hooks/useDebounce';

/**
 * The vault as a table: name, type, project, dates.
 *
 * It replaced a folder-grouped list of paths, which could only ever be ordered
 * one way — because a path is the only fact a path carries. Ownership and
 * recency live in frontmatter, and they are what a person actually navigates a
 * 338-note vault by.
 *
 * Search NARROWS this table rather than replacing it with a second, differently
 * shaped list. Two lists meant the pane changed layout under you depending on
 * whether the box had text in it, and which one you were reading was not always
 * obvious.
 */

export type NoteSortKey = 'name' | 'type' | 'project' | 'updated' | 'relevance';

export interface BrainNotesTableProps {
  accountId: number | null;
  notes: BrainNoteMeta[];
  selected: string | null;
  onSelect: (relPath: string) => void;
}

const SEARCH_DEBOUNCE_MS = 200;

/** The filter bucket for notes that name no project. */
export const NO_PROJECT = '(no project)';

const projectKey = (n: BrainNoteMeta): string => n.project ?? NO_PROJECT;

/**
 * Every project on screen with how many notes it holds, A→Z, unowned last.
 *
 * Unowned notes are a real population — 7 of 338 in the live vault — so they
 * get a bucket rather than being silently unfilterable. Last, not interleaved
 * under "(": an absence is not a name that sorts.
 */
export function projectsOf(notes: BrainNoteMeta[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const n of notes) counts.set(projectKey(n), (counts.get(projectKey(n)) ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => {
      if (a.name === NO_PROJECT) return 1;
      if (b.name === NO_PROJECT) return -1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    });
}

/**
 * Order two projects, keeping unowned notes at the bottom in BOTH directions.
 *
 * Reversing the sort should reverse the notes that have an owner; it should not
 * promote the ones that have none to the top, where they read as the most
 * important rows in the table.
 */
export function compareProjects(a: BrainNoteMeta, b: BrainNoteMeta, dir: number): number {
  if (a.project === null && b.project === null) return 0;
  if (a.project === null) return 1;
  if (b.project === null) return -1;
  return dir * a.project.localeCompare(b.project, undefined, { sensitivity: 'base', numeric: true });
}

export const BrainNotesTable: React.FC<BrainNotesTableProps> = ({
  accountId, notes, selected, onSelect,
}) => {
  const [sort, setSort] = useState<{ key: NoteSortKey; desc: boolean }>({
    key: 'updated', desc: true,
  });
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hits, setHits] = useState<BrainSearchHit[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const debounced = useDebounce(query, SEARCH_DEBOUNCE_MS);

  /** Discards a slow response for a query the user has already moved past. */
  const searchToken = useRef(0);

  useEffect(() => {
    const token = ++searchToken.current;
    if (accountId === null || debounced.trim() === '') {
      setHits(null);
      setSearchError(null);
      return;
    }
    api
      .brainSearch(accountId, debounced)
      .then((result) => {
        if (searchToken.current !== token) return;
        setHits(result);
        setSearchError(null);
      })
      .catch((err: unknown) => {
        if (searchToken.current !== token) return;
        // An empty table here would read as "nothing matched", which is a very
        // different and much more reassuring claim than "the search failed".
        setSearchError((err as Error).message);
        setHits(null);
      });
  }, [accountId, debounced]);

  const searching = hits !== null;

  /** Rank and snippet per hit path, for the relevance ordering and the cell. */
  const hitInfo = useMemo(() => {
    const map = new Map<string, { rank: number; snippet: string }>();
    hits?.forEach((h, i) => { map.set(h.notePath, { rank: i, snippet: h.snippet }); });
    return map;
  }, [hits]);

  const projects = useMemo(() => projectsOf(notes), [notes]);

  const visible = useMemo(() => {
    const filtered = notes.filter(
      (n) => !hidden.has(projectKey(n)) && (!searching || hitInfo.has(n.relPath)),
    );
    const dir = sort.desc ? -1 : 1;
    return [...filtered].sort((a, b) => {
      switch (sort.key) {
        case 'name':
          return dir * a.title.localeCompare(b.title, undefined, { numeric: true });
        case 'type': return dir * a.type.localeCompare(b.type);
        case 'project': return compareProjects(a, b, dir);
        // Search rank is ascending by nature — hit 0 is the best match — so it
        // ignores `desc`, which would otherwise offer "worst match first".
        case 'relevance':
          return (hitInfo.get(a.relPath)?.rank ?? 0) - (hitInfo.get(b.relPath)?.rank ?? 0);
        // Ties on date break on name, so the order does not shuffle between
        // renders for the many notes written the same day.
        default:
          return dir * (a.updated.localeCompare(b.updated) || a.title.localeCompare(b.title));
      }
    });
  }, [notes, hidden, searching, hitInfo, sort]);

  /**
   * A search re-sorts by rank, and clearing it goes back to recency.
   *
   * Left on "updated", the top hit for a query could land anywhere in the
   * list — which makes searching a filter rather than a way to find one note.
   * An explicit press on any header sticks, because `sort` is state.
   */
  useEffect(() => {
    setSort((s) => {
      if (searching && s.key !== 'relevance') return { key: 'relevance', desc: true };
      if (!searching && s.key === 'relevance') return { key: 'updated', desc: true };
      return s;
    });
  }, [searching]);

  function toggleHidden(name: string): void {
    const next = new Set(hidden);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setHidden(next);
  }

  function header(key: NoteSortKey, label: string, className = ''): React.ReactElement {
    const active = sort.key === key;
    return (
      <th className={`px-2 py-1.5 text-left font-medium ${className}`}>
        <button
          type="button"
          onClick={() => { setSort((s) => ({ key, desc: s.key === key ? !s.desc : true })); }}
          aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}
          className={active ? 'text-foreground' : 'hover:text-foreground'}
        >
          {label}{active ? (sort.desc ? ' ↓' : ' ↑') : ''}
        </button>
      </th>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* One bar, tinted as chrome: the search box and the project filter are
          the same act — narrowing the table below. */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); }}
            placeholder="Search this vault"
            aria-label="Search this vault"
            className="h-7 w-48 rounded-md border bg-background pl-7 pr-2"
          />
        </div>
        <Popover
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          align="start"
          className="max-h-80 w-72 overflow-y-auto p-2"
          trigger={
            <button
              type="button"
              onClick={() => { setPickerOpen((o) => !o); }}
              aria-label="Filter by project"
              aria-expanded={pickerOpen}
              className="h-7 rounded-md border px-2 hover:bg-accent"
            >
              {hidden.size === 0
                ? 'All projects'
                : `${String(projects.length - hidden.size)} of ${String(projects.length)} projects`}
            </button>
          }
          content={
            <div className="text-xs">
              <div className="mb-1 flex gap-2 border-b pb-1">
                <button
                  type="button"
                  onClick={() => { setHidden(new Set()); }}
                  className="rounded px-1 hover:bg-accent"
                >
                  Show all
                </button>
                <button
                  type="button"
                  onClick={() => { setHidden(new Set(projects.map((p) => p.name))); }}
                  className="rounded px-1 hover:bg-accent"
                >
                  Hide all
                </button>
              </div>
              <ul>
                {projects.map((p) => (
                  <li key={p.name}>
                    <label className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-accent">
                      <input
                        type="checkbox"
                        checked={!hidden.has(p.name)}
                        onChange={() => { toggleHidden(p.name); }}
                        aria-label={`Show ${p.name}`}
                        className="h-3 w-3 shrink-0"
                      />
                      <span className={`break-all ${p.name === NO_PROJECT ? 'italic text-muted-foreground' : ''}`}>
                        {p.name}
                      </span>
                      <span className="ml-auto shrink-0 text-muted-foreground">{p.count}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          }
        />
        <span className="text-muted-foreground">
          {visible.length} of {notes.length}
        </span>
      </div>

      {searchError !== null && (
        <p className="border-b px-3 py-2 text-xs text-destructive">{searchError}</p>
      )}

      <div className="min-h-0 flex-1 overflow-auto bg-card">
        <table className="w-full text-xs">
          {/* Opaque and shadowed, so striped rows do not scroll through the
              column names. Same header treatment as the Sources table. */}
          <thead className="sticky top-0 z-10 bg-card text-muted-foreground shadow-[0_1px_0_0_hsl(var(--border))]">
            <tr>
              {header('name', 'Name')}
              {header('type', 'Type')}
              {header('project', 'Project')}
              {header('updated', 'Updated')}
            </tr>
          </thead>
          <tbody>
            {visible.map((n) => {
              const active = selected === n.relPath;
              const snippet = hitInfo.get(n.relPath)?.snippet;
              return (
                <tr
                  key={n.relPath}
                  onClick={() => { onSelect(n.relPath); }}
                  aria-selected={active}
                  title={n.relPath}
                  // A left bar rather than a fill alone: against striped rows,
                  // one row a shade darker does not read as "this is the one
                  // open on the right".
                  className={`cursor-pointer border-b border-border/50 ${
                    active
                      ? 'bg-accent text-accent-foreground shadow-[inset_3px_0_0_0_hsl(var(--primary))]'
                      : 'even:bg-muted/30 hover:bg-muted/60'
                  }`}
                >
                  <td className="max-w-0 px-2 py-1.5 align-top leading-tight">
                    <div data-testid="note-title" className="truncate font-medium">{n.title}</div>
                    {/* Only while searching: the snippet is why THIS row is in
                        a narrowed list, and it has nothing to say otherwise. */}
                    {snippet !== undefined && (
                      <div className="truncate text-[11px] text-muted-foreground">{snippet}</div>
                    )}
                  </td>
                  <td
                    data-testid="note-type"
                    className="whitespace-nowrap px-2 py-1.5 align-top text-muted-foreground"
                  >
                    {n.type}
                  </td>
                  <td
                    data-testid="note-project"
                    className={`max-w-[12rem] truncate px-2 py-1.5 align-top ${
                      n.project === null ? 'text-muted-foreground/60' : ''
                    }`}
                  >
                    {n.project ?? '—'}
                  </td>
                  {/* Updated over curated, dimmed second line — the stacked
                      cell the Sources table uses for size over cost. Curation
                      touches 20 of 338 notes, so a column of its own would be
                      an em dash 94% of the way down. */}
                  <td className="whitespace-nowrap px-2 py-1.5 align-top leading-tight tabular-nums">
                    <div data-testid="note-updated">{n.updated}</div>
                    <div data-testid="note-curated" className="text-[11px] text-muted-foreground">
                      {n.curatedAt === null ? '' : `curated ${n.curatedAt}`}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* "This vault is empty" and "your filter excluded everything" are
            different problems with different fixes, so they are different
            sentences. */}
        {visible.length === 0 && (
          <div className="p-3 text-xs text-muted-foreground">
            {notes.length === 0 ? 'No notes in this vault yet.' : 'Nothing matches that filter.'}
          </div>
        )}
      </div>
    </div>
  );
};

export default BrainNotesTable;
