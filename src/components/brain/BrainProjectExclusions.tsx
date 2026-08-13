import React from 'react';
import type { BrainSourceSummary } from '@/lib/api';
import { projectsOf, splitPath } from './BrainSourcesTable';

/**
 * Which projects the Brain is allowed to touch at all.
 *
 * Distinct from the table's project FILTER, and labelled so they cannot be
 * confused: the filter narrows what is on screen and resets, while this is a
 * durable property of the account. With Auto-index on, closing a session in a
 * temp project indexes it in the background no matter what the table shows —
 * so only this can keep it out.
 */
export const BrainProjectExclusions: React.FC<{
  rows: BrainSourceSummary[];
  excluded: ReadonlySet<string>;
  onToggle: (label: string, exclude: boolean) => void;
  onClose: () => void;
}> = ({ rows, excluded, onToggle, onClose }) => {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
  // Same ordering rule as the table's filter: alphabetical on the path.
  const projects = projectsOf(rows);

  return (
    <div className="border-b bg-muted/30 px-3 py-2 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-medium">Projects the Brain may index</span>
        <span className="text-muted-foreground">
          unchecking one removes it from the Brain entirely — it stops listing,
          stops queueing, and stops indexing when a session closes
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-md border px-2 py-0.5 hover:bg-accent"
        >
          Done
        </button>
      </div>
      <ul className="grid gap-1 sm:grid-cols-2">
        {projects.map((p) => (
          <li key={p.label}>
            <label className="flex items-center gap-2" title={p.path}>
              <input
                type="checkbox"
                checked={!excluded.has(p.label)}
                onChange={(e) => { onToggle(p.label, !e.target.checked); }}
                aria-label={`Include ${p.path}`}
                className="h-3 w-3 shrink-0"
              />
              {/* Parent truncates, folder name does not — these paths share
                  long prefixes, and the tail is the distinguishing part. */}
              <span className="flex min-w-0 items-baseline">
                <span className="truncate text-muted-foreground">{splitPath(p.path).parent}</span>
                <span className="shrink-0">{splitPath(p.path).base}</span>
              </span>
              <span className="shrink-0 text-muted-foreground">
                {counts.get(p.label)} {counts.get(p.label) === 1 ? 'item' : 'items'}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default BrainProjectExclusions;
