import * as React from 'react';
import { GitBranch, Folder, GitCompare, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GIT_CHANGED_STYLE, GIT_UNTRACKED_STYLE } from '@/lib/gitStatusStyle';
import { Popover } from '@/components/ui/popover';
import { ReadoutLabel } from '@/components/ui/readout-label';

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
  /** Open the working-tree diff viewer. Omitted where there is nowhere to
   *  open it — the branch-color preview in settings, for instance. */
  onViewChanges?: () => void;
  /** `bar` sets the chip in a status bar: the bar's 10px type, and
   *  block-level so it centres with the bar's readouts. */
  size?: 'header' | 'bar';
  /** Extra classes for the chip, e.g. the heavier weight of a main checkout. */
  className?: string;
  /** The chip's icon: a branch unless told otherwise (a worktree's folder). */
  icon?: LucideIcon;
  /** `chip` (default): tinted, bordered. `text`: no chip, the branch color on
   *  the text alone — the status bar's readout style. */
  variant?: 'chip' | 'text';
  /** A readout label before the name (`branch`, `worktree`). Hidden from
   *  assistive tech: the name and the title already say what it is. */
  label?: string;
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
  onViewChanges,
  size = 'header',
  className,
  icon: Icon = GitBranch,
  variant = 'chip',
  label,
}) => {
  const asText = variant === 'text';
  const textSize = size === 'bar' ? 'text-[10px]' : 'text-[11px]';
  // An inline-flex trigger inside the Popover's block wrapper opens a line
  // box and sits ~1px high among a bar's readouts.
  const display = size === 'bar' ? 'flex' : 'inline-flex';
  const [open, setOpen] = React.useState(false);

  const titleParts = [`Git branch: ${name}`];
  if (changed > 0) titleParts.push(`${changed} changed`);
  if (untracked > 0) titleParts.push(`${untracked} untracked`);

  const useColor = !isTrunk && color != null;
  const nearBlack = useColor && isNearBlack(color);

  // As text, a trunk takes the bar's own text color (a black chip has no
  // text-only equivalent that shows in dark mode), and nothing is filled.
  const inlineStyle = asText
    ? (useColor ? { color: nearBlack ? undefined : color } : undefined)
    : useColor
    ? nearBlack
      ? { backgroundColor: '#ffffff26', color: '#ffffff', borderColor: `${color}cc` }
      : { backgroundColor: `${color}33`, color: color, borderColor: `${color}4d` }
    : undefined;

  const counts = (
    <>
      {changed > 0 && (
        <span className={cn("inline-flex items-center gap-0.5", GIT_CHANGED_STYLE.className)}>
          <GIT_CHANGED_STYLE.Icon className="w-3 h-3" />
          {changed}
        </span>
      )}
      {untracked > 0 && (
        <span className={cn("inline-flex items-center gap-0.5", GIT_UNTRACKED_STYLE.className)}>
          <GIT_UNTRACKED_STYLE.Icon className="w-3 h-3" />
          {untracked}
        </span>
      )}
    </>
  );

  const badgeContent = (
    <>
      <Icon className="w-3.5 h-3.5 shrink-0" />
      {label && <ReadoutLabel aria-hidden="true">{label}</ReadoutLabel>}
      <span className="truncate max-w-[24ch]">{name}</span>
      {/* A chip rules its counts off from the name; as text the counts sit
          right beside it, so they read as that checkout's. */}
      {!asText && (changed > 0 || untracked > 0) && (
        <span aria-hidden className="h-3 w-px bg-current opacity-40 mx-0.5" />
      )}
      {asText ? (
        // As text, the counts share one small outlined badge so they read as
        // this checkout's rather than floating between columns. The border
        // color needs `!` to beat the global `* { border-color }` reset.
        (changed > 0 || untracked > 0) && (
          <span data-testid="change-counts" className="inline-flex items-center gap-1 rounded-sm border border-foreground/25! bg-foreground/10 px-1 font-normal">
            {counts}
          </span>
        )
      ) : counts}
    </>
  );

  // No path means we have no extra detail to show — render a plain span like
  // before so the badge stays non-interactive in fallback callers.
  if (!path) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 px-2 py-0.5 font-mono font-medium',
          !asText && 'rounded border',
          textSize,
          !asText && isTrunk && 'bg-black text-white border-black',
          className,
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
            display,
            'items-center gap-1 font-mono font-medium cursor-pointer',
            asText
              ? 'rounded-sm px-0.5 hover:bg-foreground/10 focus:outline-none focus-visible:bg-foreground/10'
              : 'rounded border px-2 py-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            textSize,
            !asText && isTrunk && 'bg-black text-white border-black',
            className,
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
              Changes
            </div>
            {changed === 0 && untracked === 0 && !error ? (
              <div className="text-xs text-muted-foreground italic">Clean</div>
            ) : (
              <div className="flex flex-col gap-0.5 text-xs">
                {changed > 0 && (
                  <div className={cn("flex items-center gap-1.5", GIT_CHANGED_STYLE.className)}>
                    <GIT_CHANGED_STYLE.Icon className="w-3 h-3" />
                    <span>{changed} changed</span>
                  </div>
                )}
                {untracked > 0 && (
                  <div className={cn("flex items-center gap-1.5", GIT_UNTRACKED_STYLE.className)}>
                    <GIT_UNTRACKED_STYLE.Icon className="w-3 h-3" />
                    <span>{untracked} untracked</span>
                  </div>
                )}
              </div>
            )}
            {onViewChanges && (changed > 0 || untracked > 0) && (
              <button
                type="button"
                onClick={() => { setOpen(false); onViewChanges(); }}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded border px-2 py-1 text-[11px] text-foreground/90 hover:bg-accent"
              >
                <GitCompare className="w-3 h-3" />
                View changes
              </button>
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
