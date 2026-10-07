import * as React from 'react';
import { cn } from '@/lib/utils';
import { InlineDivider } from '@/components/ui/inline-divider';
import { STATUS_BAR_SURFACE } from '@/components/ChatStatusBar';
import { GitBranchBadge } from './GitBranchBadge';

/**
 * The branch widget as a second status bar: `branch [main] | worktrees (2)
 * [feat/a] [feat/b] | [watch]`. Same surface and 10px type as the chat status
 * bar it sits under, each label on its badges' line rather than above them.
 * The badges keep their chips, sized to the bar.
 */

interface BranchState {
  name: string;
  changed: number;
  untracked: number;
  path: string;
  error?: string | null;
  onViewChanges?: () => void;
}

interface Worktree {
  path: string;
  branch: string | null;
  changed: number;
  untracked: number;
  error?: string | null;
}

export interface BranchStatusBarProps {
  branch: BranchState;
  worktrees: Worktree[];
  colorFor: (branch: string) => { color: string | null; isTrunk: boolean };
  /** Open the diff viewer on a worktree, by its path. */
  onViewWorktreeChanges?: (path: string) => void;
  /** The git-watch glyph, when this session has a watch. */
  watch?: React.ReactNode;
  className?: string;
}

const LABEL = 'opacity-70 text-muted-foreground';
const ROW = 'flex flex-wrap items-center gap-1';

export const BranchStatusBar = React.forwardRef<HTMLDivElement, BranchStatusBarProps>(
  function BranchStatusBar({ branch, worktrees, colorFor, onViewWorktreeChanges, watch, className }, ref) {
    const items: React.JSX.Element[] = [
      <span key="branch" className={ROW}>
        <span className={LABEL}>branch</span>
        <GitBranchBadge
          size="bar"
          name={branch.name}
          changed={branch.changed}
          untracked={branch.untracked}
          {...colorFor(branch.name)}
          path={branch.path}
          error={branch.error}
          onViewChanges={branch.onViewChanges}
        />
      </span>,
    ];

    if (worktrees.length > 0) {
      items.push(
        <span key="worktrees" className={ROW}>
          <span className={LABEL}>worktrees ({worktrees.length})</span>
          {worktrees.map((wt) => {
            const name = wt.branch ?? '(detached)';
            return (
              <span key={wt.path} title={wt.path}>
                <GitBranchBadge
                  size="bar"
                  name={name}
                  changed={wt.changed}
                  untracked={wt.untracked}
                  {...colorFor(name)}
                  path={wt.path}
                  error={wt.error}
                  onViewChanges={onViewWorktreeChanges && (() => { onViewWorktreeChanges(wt.path); })}
                />
              </span>
            );
          })}
        </span>,
      );
    }

    if (watch) {
      items.push(<React.Fragment key="watch">{watch}</React.Fragment>);
    }

    return (
      <div ref={ref} data-testid="branch-status-bar" className={cn(STATUS_BAR_SURFACE, className)}>
        {items.map((item, i) => (
          // Divider and the item it introduces wrap together, as on the chat bar.
          <span key={item.key} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {i > 0 && <InlineDivider data-testid="status-divider" />}
            {item}
          </span>
        ))}
      </div>
    );
  },
);
