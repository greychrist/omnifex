import * as React from 'react';
import { GitBranch, FilePen, FilePlus, Folder } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover } from '@/components/ui/popover';

export interface GitBranchBadgeProps {
  name: string;
  changed: number;
  untracked: number;
  /** Resolved hex color for non-trunk chips. Ignored when `isTrunk` is true. */
  color: string | null;
  /** When true, render the black trunk style (overrides `color`). */
  isTrunk: boolean;
  /** Absolute path of the worktree this branch is checked out in. When
   *  provided, the badge becomes clickable and opens a popover with the
   *  folder + branch detail. */
  path?: string;
  /** Per-row error string from the unified git watch — surfaced inside the
   *  popover so the user can see why a row went red without leaving it. */
  error?: string | null;
}

// WCAG relative luminance — used only to detect TRUE near-black picks where
// `${color}33` would be invisible on the dark page bg. Everything else (blue,
// gray, etc.) keeps the same translucent recipe AccountBadge uses.
function isNearBlack(hex: string): boolean {
  const m = hex.replace('#', '');
  if (m.length !== 6) return false;
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L < 0.05;
}

function tildeHome(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~');
}

export const GitBranchBadge: React.FC<GitBranchBadgeProps> = ({
  name,
  changed,
  untracked,
  color,
  isTrunk,
  path,
  error,
}) => {
  const [open, setOpen] = React.useState(false);

  const titleParts = [`Git branch: ${name}`];
  if (changed > 0) titleParts.push(`${changed} changed`);
  if (untracked > 0) titleParts.push(`${untracked} untracked`);

  const useColor = !isTrunk && color != null;
  const nearBlack = useColor && isNearBlack(color);

  const inlineStyle = useColor
    ? nearBlack
      ? { backgroundColor: '#ffffff26', color: '#ffffff', borderColor: `${color}cc` }
      : { backgroundColor: `${color}33`, color: color, borderColor: `${color}4d` }
    : undefined;

  const badgeContent = (
    <>
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
    </>
  );

  // No path means we have no extra detail to show — render a plain span like
  // before so the badge stays non-interactive in fallback callers.
  if (!path) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-mono font-medium',
          isTrunk && 'bg-black text-white border-black',
        )}
        style={inlineStyle}
        title={titleParts.join(' · ')}
      >
        {badgeContent}
      </span>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="start"
      side="bottom"
      className="w-80"
      trigger={
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-mono font-medium cursor-pointer',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            isTrunk && 'bg-black text-white border-black',
          )}
          style={inlineStyle}
          title={titleParts.join(' · ')}
        >
          {badgeContent}
        </button>
      }
      content={
        <div className="flex flex-col gap-3 text-left">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <GitBranch className="w-3 h-3" />
              Branch
            </div>
            <div className="font-mono text-sm text-foreground/90 break-all">
              {name}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {isTrunk ? 'Trunk branch' : 'Feature / topic branch'}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <Folder className="w-3 h-3" />
              Folder
            </div>
            <div className="font-mono text-xs text-foreground/90 break-all">
              {tildeHome(path)}
            </div>
            <div className="text-[10px] text-muted-foreground/70 mt-0.5 break-all">
              {path}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Working tree
            </div>
            {changed === 0 && untracked === 0 && !error ? (
              <div className="text-xs text-muted-foreground italic">Clean</div>
            ) : (
              <div className="flex flex-col gap-0.5 text-xs">
                {changed > 0 && (
                  <div className="flex items-center gap-1.5 text-emerald-400">
                    <FilePen className="w-3 h-3" />
                    <span>{changed} changed</span>
                  </div>
                )}
                {untracked > 0 && (
                  <div className="flex items-center gap-1.5 text-amber-300">
                    <FilePlus className="w-3 h-3" />
                    <span>{untracked} untracked</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {error && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-rose-400 mb-1">
                Status error
              </div>
              <div className="font-mono text-[11px] text-rose-300/90 break-all">
                {error}
              </div>
            </div>
          )}
        </div>
      }
    />
  );
};
