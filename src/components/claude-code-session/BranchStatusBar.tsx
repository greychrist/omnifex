import * as React from 'react';
import { FolderCog, FolderGit, FolderGit2, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ButtonGroup } from '@/components/ui/button-group';
import { STATUS_BAR_SURFACE } from '@/components/ChatStatusBar';
import { resolveBranchColors } from '@/lib/branchColors';
import type { RepoSnapshot, SessionGitSnapshot } from '@/lib/api';
import { GitBranchBadge } from './GitBranchBadge';

/**
 * The git widget, always present: one status bar per watched repo — its name,
 * then a badge per checkout (main first, then each worktree) with that
 * checkout's branch and changes — and a small bar with the repos/refresh pair:
 *
 *   git [backend (⎇ dev ●3) (▣ test/wt-be-1)]  [frontend (⎇ dev) …]  [📁│⟳]
 *
 * The bars sit side by side and wrap. A repo shows its alias, else its folder name.
 * A badge's popover has the path and View changes; a repo's name opens the
 * repos dialog. Same surface and 10px type as the chat status bar above.
 */

export interface BranchStatusBarProps {
  snapshot: SessionGitSnapshot;
  /** Branch → color pins, keyed by each repo's `root.path`. */
  pins: Record<string, Record<string, string>>;
  /** Display aliases, keyed by each repo's `root.path`; a repo without one shows its folder name. */
  aliases: Record<string, string>;
  /** Open the diff viewer on a checkout. `label` names a worktree or a sub-repo. */
  onViewChanges: (path: string, label?: string) => void;
  onOpenRepos: () => void;
  /** The git-watch glyph, when this session has a watch. */
  watch?: React.ReactNode;
  className?: string;
}


function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function reposButtonText(shown: number, found: number): string | null {
  if (shown === 0) return found > 0 ? `${found} repo${found === 1 ? '' : 's'} found` : 'no repos';
  return found > 0 ? `+${found} found` : null;
}

function RepoCapsule({ repo, fullName, displayName, pins, onViewChanges, onOpenRepos }: {
  repo: RepoSnapshot;
  fullName: string;
  /** The repo's alias, or its full name. */
  displayName: string;
  pins: Record<string, string>;
  onViewChanges: BranchStatusBarProps['onViewChanges'];
  onOpenRepos: () => void;
}) {
  const label = (b: string | null) => b ?? '(detached)';
  const colors = resolveBranchColors({
    pins,
    mainFolderBranch: repo.root.branch,
    branches: [label(repo.root.branch), ...repo.worktrees.map((wt) => label(wt.branch))],
  });
  const checkouts = [repo.root, ...repo.worktrees];
  return (
    <span role="group" aria-label={fullName} className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={onOpenRepos}
        title={`${fullName}\n${repo.root.path}`}
        // Styled like the chat bar's readouts (the model one): icon in the
        // bar's text color, name in the muted label style.
        className="flex items-center gap-1 rounded-sm px-0.5 text-[10px] hover:bg-foreground/10 focus:outline-none focus-visible:bg-foreground/10"
      >
        <FolderGit aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span className="opacity-70">{displayName}</span>
      </button>
      {checkouts.map((c, i) => {
        const name = label(c.branch);
        const isMain = i === 0;
        return (
          <GitBranchBadge
            key={c.path}
            size="bar"
            className={isMain ? 'font-semibold' : undefined}
            // A worktree is another folder with its own checkout; the icon says so.
            icon={isMain ? GitBranch : FolderGit2}
            name={name}
            changed={c.changed}
            untracked={c.untracked}
            color={colors.colors[name] ?? null}
            isTrunk={colors.trunkBlack.has(name)}
            path={c.path}
            error={c.error}
            onViewChanges={() => { onViewChanges(c.path, isMain ? (repo.name || undefined) : name); }}
          />
        );
      })}
    </span>
  );
}

export const BranchStatusBar = React.forwardRef<HTMLDivElement, BranchStatusBarProps>(
  function BranchStatusBar({ snapshot, pins, aliases, onViewChanges, onOpenRepos, watch, className }, ref) {
    const { repos, foundCount } = snapshot;
    const fullNames = repos.map((r) => r.name || basename(r.root.path));

    const text = reposButtonText(repos.length, foundCount);

    return (
      // One bar per repo, side by side, wrapping onto the next line when they
      // do not fit; the repos/refresh pair closes the row in a bar of its own.
      <div ref={ref} data-testid="branch-status-bar" className={cn('flex flex-wrap items-center gap-1.5', className)}>
        {/* The row's name, in the chat bar's label style: quiet, outside the bars. */}
        <span className="pl-0.5 font-mono text-[10px] opacity-70 text-muted-foreground">git</span>
        {repos.map((repo, i) => (
          <div key={repo.root.path} data-testid="repo-bar" className={STATUS_BAR_SURFACE}>
            <RepoCapsule
              repo={repo}
              fullName={fullNames[i]}
              displayName={aliases[repo.root.path] ?? fullNames[i]}
              pins={pins[repo.root.path] ?? {}}
              onViewChanges={onViewChanges}
              onOpenRepos={onOpenRepos}
            />
          </div>
        ))}
        <div data-testid="git-bar" className={cn(STATUS_BAR_SURFACE, 'px-1.5')}>
          {/* The repos button and the watch glyph act on the same thing — this
              project's git — so they sit together as one control. */}
          <ButtonGroup label="Git">
            <button
              type="button"
              onClick={onOpenRepos}
              aria-label={text ?? 'Manage repos'}
              title="Repos in this project"
              className="flex h-5 items-center gap-1 px-1 text-[10px] text-foreground hover:bg-accent focus:outline-none focus-visible:bg-accent"
            >
              <FolderCog className="h-3.5 w-3.5" />
              {text}
            </button>
            {watch}
          </ButtonGroup>
        </div>
      </div>
    );
  },
);
