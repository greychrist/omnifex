import React, { useMemo, useState } from 'react';
import type { BrainSourceSummary } from '@/lib/api';
import { Popover } from '@/components/ui/popover';

export type SortKey = 'project' | 'name' | 'type' | 'when' | 'size' | 'cost' | 'status';
export type StatusFilter = 'all' | 'never' | 'indexed' | 'failed' | 'changed';

export interface BrainSourcesTableProps {
  rows: BrainSourceSummary[];
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  activeItemKey: string | null;
  /** The row the indexer is on (`BrainRun.item`), not the row open in the preview. */
  indexingItemKey: string | null;
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

/** A row with a note shows what happened; the gate's reason only while nothing indexed it. */
export function statusLabel(r: BrainSourceSummary): string {
  if (r.status === 'indexed' || r.status === 'failed') return statusOf(r);
  return r.admitted ? statusOf(r) : r.reason;
}

export function isSettled(r: BrainSourceSummary): boolean {
  return r.status === 'indexed' && !r.changed;
}

export function blockedReason(r: BrainSourceSummary): string | null {
  if (r.inUse) return 'This session is open in OmniFex — close the tab to index it';
  if (isSettled(r)) return 'Already indexed — nothing has changed since';
  return null;
}

function matchesStatus(r: BrainSourceSummary, f: StatusFilter): boolean {
  if (f === 'all') return true;
  if (f === 'changed') return r.status === 'indexed' && r.changed;
  if (f === 'indexed') return r.status === 'indexed';
  if (f === 'failed') return r.status === 'failed';
  return r.status === null;
}

/** Mirrors the `*_SOURCE_ID` constants in daemon/services/brain/sources/. */
export function sourceTypeLabel(sourceId: string): string {
  switch (sourceId) {
    case 'session': return 'Session';
    case 'auto-memory': return 'Memory';
    case 'repo': return 'Repo file';
    case 'capture': return 'Capture';
    default: return sourceId;
  }
}

/** Four decimals: at two, every cheap run would read as "$0.00". */
function usd(cost: number | null): string {
  if (cost === null) return '—';
  return `$${cost.toFixed(4)}`;
}

function costBreakdown(r: BrainSourceSummary): string | undefined {
  if (r.costUsd === null) return undefined;
  const n = (v: number | null): string => (v === null ? '?' : v.toLocaleString());
  return (
    `${usd(r.costUsd)} — ${n(r.inputTokens)} in, ${n(r.outputTokens)} out, ` +
    `${n(r.cacheReadTokens)} cache read, ${n(r.cacheCreationTokens)} cache write. ` +
    "The CLI's own figure for the run that indexed this item."
  );
}

function kb(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Paths sort segment-wise: flat text interleaves a folder with its children. */
export function projectsOf(rows: BrainSourceSummary[]): { path: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
  return [...counts]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => comparePaths(a.path, b.path));
}

export function comparePaths(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const cmp = l.localeCompare(r, undefined, { sensitivity: 'base', numeric: true });
    if (cmp !== 0) return cmp;
  }
  return 0;
}

export const BrainSourcesTable: React.FC<BrainSourcesTableProps> = ({
  rows, selected, onSelectedChange, activeItemKey, indexingItemKey, onOpen,
}) => {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'when', desc: true });
  const [text, setText] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  // Hidden, not shown: a newly discovered project appears without being ticked.
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
          // Item key stays searchable: pasting a session id finds one conversation.
          r.itemKey.toLowerCase().includes(needle) ||
          r.name.toLowerCase().includes(needle) ||
          r.label.toLowerCase().includes(needle) ||
          sourceTypeLabel(r.sourceId).toLowerCase().includes(needle)),
    );
    const dir = sort.desc ? -1 : 1;
    return [...filtered].sort((a, b) => {
      switch (sort.key) {
        case 'project': return dir * comparePaths(a.label, b.label);
        case 'name': return dir * a.name.localeCompare(b.name, undefined, { numeric: true });
        case 'type': return dir * a.sourceId.localeCompare(b.sourceId);
        case 'size': return dir * (a.size - b.size);
        case 'cost': return dir * ((a.costUsd ?? 0) - (b.costUsd ?? 0));
        case 'status': return dir * statusOf(a).localeCompare(statusOf(b));
        default: return dir * (a.mtimeMs - b.mtimeMs);
      }
    });
  }, [rows, text, status, hidden, sort]);

  // Select-all covers the FILTERED rows, never the whole corpus.
  const selectableIds = useMemo(
    () => visible.filter((r) => blockedReason(r) === null).map(rowId),
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

  function sortButton(key: SortKey, label: string): React.ReactElement {
    const active = sort.key === key;
    return (
      <button
        type="button"
        onClick={() => { setSort((s) => ({ key, desc: s.key === key ? !s.desc : true })); }}
        aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}
        className={active ? 'text-foreground' : 'hover:text-foreground'}
      >
        {label}{active ? (sort.desc ? ' ↓' : ' ↑') : ''}
      </button>
    );
  }

  function header(key: SortKey, label: string): React.ReactElement {
    return <th className="px-2 py-1 text-left font-medium">{sortButton(key, label)}</th>;
  }

  // Both halves of a stacked cell keep their own sort control.
  function pairHeader(
    a: [SortKey, string],
    b: [SortKey, string],
    align: 'left' | 'right' = 'left',
  ): React.ReactElement {
    return (
      <th className={`px-2 py-1 font-medium text-${align}`}>
        {sortButton(a[0], a[1])}
        <span className="px-1 text-muted-foreground/50">/</span>
        {sortButton(b[0], b[1])}
      </th>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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

      <div className="min-h-0 flex-1 overflow-auto bg-card">
        <table className="w-full text-xs">
          {/* Opaque: a transparent sticky header let rows scroll through it. */}
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
              {pairHeader(['project', 'Project'], ['name', 'Name'])}
              {header('type', 'Type')}
              {header('when', 'When')}
              {pairHeader(['size', 'Size'], ['cost', 'Cost'], 'right')}
              {header('status', 'Status')}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const id = rowId(r);
              const active = activeItemKey === r.itemKey;
              const indexing = indexingItemKey === r.itemKey;
              const blocked = blockedReason(r);
              return (
                <tr
                  key={id}
                  onClick={() => { onOpen(r.itemKey); }}
                  aria-selected={active}
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
                      disabled={blocked !== null}
                      onChange={() => { toggleOne(id); }}
                      aria-label={`Select ${r.itemKey}`}
                      title={blocked ?? undefined}
                      className="h-3 w-3 disabled:opacity-40"
                    />
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 align-top leading-tight">
                    <div data-testid="source-project" className="font-medium">{r.label}</div>
                    <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                      <span data-testid="source-name">{r.name}</span>
                      {r.inUse && (
                        <span
                          title="This session is open in OmniFex — close the tab to index it"
                          className="rounded-sm bg-primary/15 px-1 py-px font-sans text-[10px] font-medium text-primary"
                        >
                          In use
                        </span>
                      )}
                    </div>
                  </td>
                  <td
                    data-testid="source-type"
                    className="whitespace-nowrap px-2 py-1.5 align-top text-muted-foreground"
                  >
                    {sourceTypeLabel(r.sourceId)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 align-top tabular-nums text-muted-foreground">
                    {new Date(r.mtimeMs).toISOString().slice(0, 10)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right align-top leading-tight tabular-nums">
                    <div data-testid="source-size" className="text-muted-foreground">
                      {kb(r.size)}
                    </div>
                    <div
                      data-testid="source-cost"
                      title={costBreakdown(r)}
                      className={r.costUsd === null ? 'text-muted-foreground/70' : ''}
                    >
                      {usd(r.costUsd)}
                    </div>
                  </td>
                  <td
                    data-testid="source-status"
                    className={`max-w-[12rem] truncate px-2 py-1.5 align-top ${
                      indexing ? 'font-medium text-primary' : 'text-muted-foreground'
                    }`}
                    title={indexing ? 'Being indexed right now' : r.reason}
                  >
                    {indexing ? 'indexing…' : statusLabel(r)}
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
