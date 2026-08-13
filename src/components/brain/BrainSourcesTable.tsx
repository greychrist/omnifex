import React, { useMemo, useState } from 'react';
import type { BrainSourceSummary } from '@/lib/api';
import { Popover } from '@/components/ui/popover';

/**
 * The sources table: sort, filter, and multi-select.
 *
 * Presentational on purpose — it takes rows and selection state and returns
 * elements. Every rule worth pinning (which rows select-all covers, whether the
 * button count matches what will run) is then testable without IPC, a vault, or
 * a queue.
 */

export type SortKey = 'project' | 'type' | 'when' | 'size' | 'status';
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

/**
 * True when indexing this row would do nothing.
 *
 * `indexSource` short-circuits an already-indexed item whose bytes and mtime
 * have not moved — "unchanged since it was last indexed" — so ticking one buys
 * a press that spends nothing and changes nothing. A row that HAS changed is
 * still worth re-indexing.
 */
export function isSettled(r: BrainSourceSummary): boolean {
  return r.status === 'indexed' && !r.changed;
}

function matchesStatus(r: BrainSourceSummary, f: StatusFilter): boolean {
  if (f === 'all') return true;
  if (f === 'changed') return r.status === 'indexed' && r.changed;
  if (f === 'indexed') return r.status === 'indexed';
  if (f === 'failed') return r.status === 'failed';
  return r.status === null;
}

/**
 * What kind of thing a row is.
 *
 * Not every row is a session — auto-memory notes and repo instruction files
 * are `.md` on disk and were indistinguishable from one, which made a Markdown
 * file masquerading as a conversation. Mirrors the `*_SOURCE_ID` constants in
 * electron/services/brain/sources/.
 */
export function sourceTypeLabel(sourceId: string): string {
  switch (sourceId) {
    case 'session': return 'Session';
    case 'auto-memory': return 'Memory';
    case 'repo': return 'Repo file';
    case 'capture': return 'Capture';
    // An adapter added later still renders as something rather than blank.
    default: return sourceId;
  }
}

function kb(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Every project folder on screen, with how many rows it holds, A→Z.
 *
 * Segment-wise and case-insensitive rather than a plain `localeCompare` on the
 * whole string: comparing paths as flat text interleaves a folder with its own
 * children (`/a/b` lands between `/a-x` and `/a/c`), which reads as unsorted.
 */
export function projectsOf(rows: BrainSourceSummary[]): { path: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
  return [...counts]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => comparePaths(a.path, b.path));
}

/** Order two paths the way a person reads a folder tree. */
export function comparePaths(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];
    // A shorter path is the parent, so it sorts first.
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const cmp = l.localeCompare(r, undefined, { sensitivity: 'base', numeric: true });
    if (cmp !== 0) return cmp;
  }
  return 0;
}

export const BrainSourcesTable: React.FC<BrainSourcesTableProps> = ({
  rows, selected, onSelectedChange, activeItemKey, onOpen,
}) => {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'when', desc: true });
  const [text, setText] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  // Which projects the view is narrowed to. Empty means "no narrowing" — every
  // project shows — so a newly discovered project appears without the user
  // having to notice and tick it.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);

  const projects = useMemo(() => projectsOf(rows), [rows]);

  const visible = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const filtered = rows.filter(
      (r) =>
        !hidden.has(r.label) &&
        matchesStatus(r, status) &&
        (needle === '' ||
          // The item key stays searchable though it no longer has a column:
          // pasting a session id is how you find one specific conversation.
          r.itemKey.toLowerCase().includes(needle) ||
          r.label.toLowerCase().includes(needle) ||
          sourceTypeLabel(r.sourceId).toLowerCase().includes(needle)),
    );
    const dir = sort.desc ? -1 : 1;
    return [...filtered].sort((a, b) => {
      switch (sort.key) {
        case 'project': return dir * comparePaths(a.label, b.label);
        case 'type': return dir * a.sourceId.localeCompare(b.sourceId);
        case 'size': return dir * (a.size - b.size);
        case 'status': return dir * statusOf(a).localeCompare(statusOf(b));
        default: return dir * (a.mtimeMs - b.mtimeMs);
      }
    });
  }, [rows, text, status, hidden, sort]);

  /**
   * Rows worth ticking: filtered, minus the ones indexing would refuse.
   *
   * Select-all covers the FILTERED rows and never the whole corpus — a
   * select-all that silently reaches past what is on screen is how a user ends
   * up indexing 158 sessions having meant to index one.
   */
  const selectableIds = useMemo(
    () => visible.filter((r) => !isSettled(r)).map(rowId),
    [visible],
  );
  const allVisibleSelected =
    selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  function toggleAll(): void {
    const next = new Set(selected);
    if (allVisibleSelected) selectableIds.forEach((id) => next.delete(id));
    else selectableIds.forEach((id) => next.add(id));
    onSelectedChange(next);
  }

  function toggleHidden(path: string): void {
    const next = new Set(hidden);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setHidden(next);
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
      {/* The filter row is a second bar, tinted to read as chrome rather than
          as the first line of the table. */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs">
        <input
          value={text}
          onChange={(e) => { setText(e.target.value); }}
          placeholder="Filter sessions…"
          aria-label="Filter sessions"
          className="h-7 w-48 rounded-md border bg-background px-2"
        />
        <Popover
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          align="start"
          className="max-h-80 w-[34rem] overflow-y-auto p-2"
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
                  onClick={() => { setHidden(new Set(projects.map((p) => p.path))); }}
                  className="rounded px-1 hover:bg-accent"
                >
                  Hide all
                </button>
              </div>
              <ul>
                {projects.map((p) => (
                  <li key={p.path}>
                    <label className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-accent">
                      <input
                        type="checkbox"
                        checked={!hidden.has(p.path)}
                        onChange={() => { toggleHidden(p.path); }}
                        aria-label={`Show ${p.path}`}
                        className="h-3 w-3 shrink-0"
                      />
                      {/* Whole path, unabridged — see the Project column. */}
                      <span className="break-all">{p.path}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground">{p.count}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          }
        />
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

      {/* Scrolls in both directions: paths are not truncated, so a deep one
          is allowed to run past the pane rather than be abridged. `bg-card`
          separates the data surface from the bars above it. */}
      <div className="min-h-0 flex-1 overflow-auto bg-card">
        <table className="w-full text-xs">
          {/* Opaque and shadowed: a transparent sticky header let striped
              rows scroll through the column names. */}
          <thead className="sticky top-0 z-10 bg-card text-muted-foreground shadow-[0_1px_0_0_hsl(var(--border))]">
            <tr>
              <th className="w-8 px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleAll}
                  aria-label="Select all shown"
                  className="h-3 w-3"
                />
              </th>
              {header('project', 'Project')}
              {header('type', 'Type')}
              {header('when', 'When')}
              {header('size', 'Size')}
              {header('status', 'Status')}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const id = rowId(r);
              const active = activeItemKey === r.itemKey;
              const settled = isSettled(r);
              return (
                <tr
                  key={id}
                  onClick={() => { onOpen(r.itemKey); }}
                  aria-selected={active}
                  // A left bar rather than a fill alone: with a striped body,
                  // one row tinted a shade darker is not legible as "this is
                  // the one open on the right".
                  className={`cursor-pointer border-b border-border/50 ${
                    active
                      ? 'bg-accent text-accent-foreground shadow-[inset_3px_0_0_0_hsl(var(--primary))]'
                      : 'even:bg-muted/30 hover:bg-muted/60'
                  } ${r.excluded ? 'opacity-50' : ''}`}
                >
                  <td className="px-2 py-1.5" onClick={(e) => { e.stopPropagation(); }}>
                    <input
                      type="checkbox"
                      checked={selected.has(id)}
                      disabled={settled}
                      onChange={() => { toggleOne(id); }}
                      aria-label={`Select ${r.itemKey}`}
                      title={settled ? 'Already indexed — nothing has changed since' : undefined}
                      className="h-3 w-3 disabled:opacity-40"
                    />
                  </td>
                  {/* One line, whole path. These share long prefixes, so
                      cutting one anywhere hides the part that identifies it,
                      and wrapping made every row two lines tall. The table
                      scrolls sideways instead. */}
                  <td className="whitespace-nowrap px-2 py-1.5 font-medium">{r.label}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                    {sourceTypeLabel(r.sourceId)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-muted-foreground">
                    {new Date(r.mtimeMs).toISOString().slice(0, 10)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                    {kb(r.size)}
                  </td>
                  {/* A rejected row shows the gate's REASON, not just
                      "skipped" — "fewer than 2 prompts" is the answer to the
                      question the status alone provokes. */}
                  <td
                    className="max-w-[12rem] truncate px-2 py-1.5 text-muted-foreground"
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
