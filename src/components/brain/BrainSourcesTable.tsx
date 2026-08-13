import React, { useMemo, useState } from 'react';
import type { BrainSourceSummary } from '@/lib/api';

/**
 * The sources table: sort, filter, and multi-select.
 *
 * Presentational on purpose — it takes rows and selection state and returns
 * elements. Every rule worth pinning (which rows select-all covers, whether the
 * button count matches what will run) is then testable without IPC, a vault, or
 * a queue.
 */

export type SortKey = 'project' | 'item' | 'when' | 'size' | 'status';
export type StatusFilter = 'all' | 'never' | 'indexed' | 'failed' | 'changed';

export interface BrainSourcesTableProps {
  rows: BrainSourceSummary[];
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  activeItemKey: string | null;
  onOpen: (itemKey: string) => void;
}

/** A row's identity. `itemKey` alone is not unique across adapters. */
export function rowId(r: BrainSourceSummary): string {
  return `${r.sourceId}:${r.itemKey}`;
}

function statusOf(r: BrainSourceSummary): string {
  if (r.status === 'failed') return 'failed';
  if (r.status === 'indexed') return r.changed ? 'changed' : 'indexed';
  if (!r.admitted) return 'skipped';
  return 'never';
}

function matchesStatus(r: BrainSourceSummary, f: StatusFilter): boolean {
  if (f === 'all') return true;
  if (f === 'changed') return r.status === 'indexed' && r.changed;
  if (f === 'indexed') return r.status === 'indexed';
  if (f === 'failed') return r.status === 'failed';
  return r.status === null;
}

function kb(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Every project on screen, as `{ label, path }`, ordered by path.
 *
 * Ordered by PATH rather than by label because the path is what the user
 * reads; ordering the encoded names would sort on characters nobody is
 * looking at. The label stays the key throughout — the backend recovers the
 * path authoritatively from a transcript's `cwd`, but only the label is
 * guaranteed to be the name on disk.
 */
export function projectsOf(rows: BrainSourceSummary[]): { label: string; path: string }[] {
  const byLabel = new Map<string, string>();
  for (const r of rows) if (!byLabel.has(r.label)) byLabel.set(r.label, r.labelPath);
  return [...byLabel]
    .map(([label, path]) => ({ label, path }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A path split so the folder name survives truncation.
 *
 * Every project of Greg's shares a `/Users/…/Repos/…` prefix, so a column that
 * truncates on the right cuts away the only part that distinguishes one row
 * from another. The parent gets `truncate`; the basename does not.
 */
export function splitPath(path: string): { parent: string; base: string } {
  const cut = path.lastIndexOf('/');
  if (cut < 0) return { parent: '', base: path };
  return { parent: path.slice(0, cut + 1), base: path.slice(cut + 1) };
}

export const BrainSourcesTable: React.FC<BrainSourcesTableProps> = ({
  rows, selected, onSelectedChange, activeItemKey, onOpen,
}) => {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'when', desc: true });
  const [text, setText] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [project, setProject] = useState<string>('all');

  const projects = useMemo(() => projectsOf(rows), [rows]);

  const visible = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const filtered = rows.filter(
      (r) =>
        (project === 'all' || r.label === project) &&
        matchesStatus(r, status) &&
        (needle === '' ||
          r.itemKey.toLowerCase().includes(needle) ||
          r.label.toLowerCase().includes(needle)),
    );
    const dir = sort.desc ? -1 : 1;
    return [...filtered].sort((a, b) => {
      switch (sort.key) {
        case 'project': return dir * a.labelPath.localeCompare(b.labelPath);
        case 'item': return dir * a.itemKey.localeCompare(b.itemKey);
        case 'size': return dir * (a.size - b.size);
        case 'status': return dir * statusOf(a).localeCompare(statusOf(b));
        default: return dir * (a.mtimeMs - b.mtimeMs);
      }
    });
  }, [rows, text, status, project, sort]);

  const visibleIds = useMemo(() => visible.map(rowId), [visible]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  /**
   * Select-all covers the FILTERED rows, never the whole corpus.
   *
   * A select-all that silently reaches past what is on screen is how a user
   * ends up indexing 158 sessions having meant to index one.
   */
  function toggleAll(): void {
    const next = new Set(selected);
    if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
    else visibleIds.forEach((id) => next.add(id));
    onSelectedChange(next);
  }

  function toggleOne(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  }

  function header(key: SortKey, label: string): React.ReactElement {
    const active = sort.key === key;
    return (
      <th className="px-2 py-1 text-left font-medium">
        <button
          type="button"
          onClick={() => { setSort((s) => ({ key, desc: s.key === key ? !s.desc : true })); }}
          aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}
          className="hover:text-foreground"
        >
          {label}{active ? (sort.desc ? ' ↓' : ' ↑') : ''}
        </button>
      </th>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
        <input
          value={text}
          onChange={(e) => { setText(e.target.value); }}
          placeholder="Filter sessions…"
          aria-label="Filter sessions"
          className="h-7 w-48 rounded-md border bg-background px-2"
        />
        <select
          value={project}
          onChange={(e) => { setProject(e.target.value); }}
          aria-label="Filter by project"
          className="h-7 rounded-md border bg-background px-1"
        >
          <option value="all">All projects</option>
          {projects.map((p) => (
            <option key={p.label} value={p.label}>{p.path}</option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value as StatusFilter); }}
          aria-label="Filter by status"
          className="h-7 rounded-md border bg-background px-1"
        >
          <option value="all">Any status</option>
          <option value="never">Never indexed</option>
          <option value="indexed">Indexed</option>
          <option value="changed">Changed since indexed</option>
          <option value="failed">Failed</option>
        </select>
        <span className="text-muted-foreground">
          {visible.length} of {rows.length}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-background text-muted-foreground">
            <tr className="border-b">
              <th className="w-8 px-2 py-1">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleAll}
                  aria-label="Select all shown"
                  className="h-3 w-3"
                />
              </th>
              {header('project', 'Project')}
              {header('item', 'Session')}
              {header('when', 'When')}
              {header('size', 'Size')}
              {header('status', 'Status')}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const id = rowId(r);
              return (
                <tr
                  key={id}
                  onClick={() => { onOpen(r.itemKey); }}
                  aria-selected={activeItemKey === r.itemKey}
                  className={`cursor-pointer border-b hover:bg-accent ${
                    activeItemKey === r.itemKey ? 'bg-accent' : ''
                  } ${r.excluded ? 'opacity-50' : ''}`}
                >
                  <td className="px-2 py-1" onClick={(e) => { e.stopPropagation(); }}>
                    <input
                      type="checkbox"
                      checked={selected.has(id)}
                      onChange={() => { toggleOne(id); }}
                      aria-label={`Select ${r.itemKey}`}
                      className="h-3 w-3"
                    />
                  </td>
                  {/* Parent truncates, basename does not — see splitPath. */}
                  <td className="px-2 py-1" title={r.labelPath}>
                    <span className="flex max-w-[16rem] items-baseline">
                      <span className="truncate text-muted-foreground">
                        {splitPath(r.labelPath).parent}
                      </span>
                      <span className="shrink-0">{splitPath(r.labelPath).base}</span>
                    </span>
                  </td>
                  <td className="max-w-[14rem] truncate px-2 py-1" title={r.reason}>
                    {r.itemKey}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-muted-foreground">
                    {new Date(r.mtimeMs).toISOString().slice(0, 10)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-muted-foreground">
                    {kb(r.size)}
                  </td>
                  {/* A rejected row shows the gate's REASON, not just
                      "skipped" — "fewer than 2 prompts" is the answer to the
                      question the status alone provokes. */}
                  <td
                    className="max-w-[12rem] truncate px-2 py-1 text-muted-foreground"
                    title={r.reason}
                  >
                    {r.admitted ? statusOf(r) : r.reason}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 && (
          <div className="p-3 text-xs text-muted-foreground">Nothing matches that filter.</div>
        )}
      </div>
    </div>
  );
};

export default BrainSourcesTable;
