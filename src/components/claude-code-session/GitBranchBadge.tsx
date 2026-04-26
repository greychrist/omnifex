import * as React from 'react';
import { GitBranch, FilePen, FilePlus } from 'lucide-react';
import { cn } from '@/lib/utils';

// Hex color palette (Tailwind 400 shades). Inline styles are required because
// Tailwind v4's `border-{color}/{alpha}` utilities desaturate to gray under
// this theme, the same reason AccountBadge and the session-status badge use
// inline-style colors.
const BRANCH_COLORS = [
  '#60a5fa', // blue-400
  '#c084fc', // purple-400
  '#34d399', // emerald-400
  '#fbbf24', // amber-400
  '#fb7185', // rose-400
  '#22d3ee', // cyan-400
];

function hashBranchColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return BRANCH_COLORS[Math.abs(hash) % BRANCH_COLORS.length];
}

export const GitBranchBadge: React.FC<{
  name: string;
  changed: number;
  untracked: number;
}> = ({ name, changed, untracked }) => {
  const isTrunk = name === 'main' || name === 'master';
  const branchColor = isTrunk ? null : hashBranchColor(name);

  const titleParts = [`Git branch: ${name}`];
  if (changed > 0) titleParts.push(`${changed} changed`);
  if (untracked > 0) titleParts.push(`${untracked} untracked`);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-mono font-medium',
        isTrunk && 'bg-black text-white border-black',
      )}
      style={
        branchColor
          ? {
              backgroundColor: `${branchColor}33`,
              color: branchColor,
              borderColor: `${branchColor}4d`,
            }
          : undefined
      }
      title={titleParts.join(' · ')}
    >
      <GitBranch className="w-3.5 h-3.5" />
      {name}
      {(changed > 0 || untracked > 0) && (
        <span aria-hidden className="h-3 w-px bg-current opacity-40 mx-0.5" />
      )}
      {changed > 0 && (
        <span className="inline-flex items-center gap-0.5 text-emerald-400">
          <FilePen className="w-3 h-3" />
          {changed}
        </span>
      )}
      {untracked > 0 && (
        <span className="inline-flex items-center gap-0.5 text-amber-300">
          <FilePlus className="w-3 h-3" />
          {untracked}
        </span>
      )}
    </span>
  );
};
