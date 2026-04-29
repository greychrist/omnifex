import * as React from 'react';
import { GitBranch, FilePen, FilePlus } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface GitBranchBadgeProps {
  name: string;
  changed: number;
  untracked: number;
  /** Resolved hex color for non-trunk chips. Ignored when `isTrunk` is true. */
  color: string | null;
  /** When true, render the black trunk style (overrides `color`). */
  isTrunk: boolean;
}

export const GitBranchBadge: React.FC<GitBranchBadgeProps> = ({
  name,
  changed,
  untracked,
  color,
  isTrunk,
}) => {
  const titleParts = [`Git branch: ${name}`];
  if (changed > 0) titleParts.push(`${changed} changed`);
  if (untracked > 0) titleParts.push(`${untracked} untracked`);

  const useColor = !isTrunk && color != null;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-mono font-medium',
        isTrunk && 'bg-black text-white border-black',
      )}
      style={
        useColor
          ? {
              backgroundColor: `${color}33`,
              color: color!,
              borderColor: `${color}4d`,
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
