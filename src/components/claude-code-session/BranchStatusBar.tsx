import * as React from 'react';
import { FolderGit2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { InlineDivider } from '@/components/ui/inline-divider';
import { STATUS_BAR_SURFACE } from '@/components/ChatStatusBar';
import { resolveBranchColors } from '@/lib/branchColors';
import type { RepoSnapshot, SessionGitSnapshot } from '@/lib/api';
import { GitBranchBadge } from './GitBranchBadge';

/**
 * The git widget as a second status bar, always present:
 *
 *   branch [main ●3]  ⎇ +2 found              the project folder is the only repo shown
 *   repos (2) [api·main ●3] [web·feat ●1]  ⎇   several repos
 *   ⎇ 2 repos found                           nothing watched yet
 *
 * One chip per watched repo; its worktrees live in the chip's popover. The
 * repos button opens the dialog where the user picks which repos to watch.
 * Same surface and 10px type as the chat status bar it sits under.
 */

export interface BranchStatusBarProps {
  snapshot: SessionGitSnapshot;
  /** Branch → colour pins, keyed by each repo's `root.path`. */
  pins: Record<string, Record<string, string>>;
  /** Open the diff viewer on a checkout. `label` names a worktree or a sub-repo. */
  onViewChanges: (path: string, label?: string) => void;
  onOpenRepos: () => void;
  /** The git-watch glyph, when this session has a watch. */
  watch?: React.ReactNode;
  className?: string;
}

const LABEL = 'opacity-70 text-muted-foreground';
const ROW = 'flex flex-wrap items-center gap-1';

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function reposButtonText(shown: number, found: number): string | null {
  if (shown === 0) return found > 0 ? `${found} repo${found === 1 ? '' : 's'} found` : 'no repos';
  return found > 0 ? `+${found} found` : null;
}

function RepoChip({ repo, label, pins, onViewChanges }: {
  repo: RepoSnapshot;
  /** `repo·` prefix; undefined for a lone project repo. */
  label: string | undefined;
  pins: Record<string, string>;
  onViewChanges: BranchStatusBarProps['onViewChanges'];
}) {
  const name = repo.root.branch ?? '(detached)';
  const colors = resolveBranchColors({
    pins,
    mainFolderBranch: repo.root.branch,
    branches: [name, ...repo.worktrees.map((wt) => wt.branch ?? '(detached)')],
  });
  return (
    <span title={repo.root.path}>
      <GitBranchBadge
        size="bar"
        name={name}
        repoName={label}
        changed={repo.root.changed}
        untracked={repo.root.untracked}
        color={colors.colors[name] ?? null}
        isTrunk={colors.trunkBlack.has(name)}
        path={repo.root.path}
        error={repo.root.error}
        onViewChanges={() => { onViewChanges(repo.root.path, label); }}
        worktrees={repo.worktrees}
        onViewWorktreeChanges={(path, wtLabel) => { onViewChanges(path, wtLabel); }}
      />
    </span>
  );
}

export const BranchStatusBar = React.forwardRef<HTMLDivElement, BranchStatusBarProps>(
  function BranchStatusBar({ snapshot, pins, onViewChanges, onOpenRepos, watch, className }, ref) {
    const { repos, foundCount } = snapshot;
    const lone = repos.length === 1 && repos[0].name === '';
    const items: React.JSX.Element[] = [];

    if (repos.length > 0) {
      items.push(
        <span key="repos" className={ROW}>
          <span className={LABEL}>{lone ? 'branch' : `repos (${repos.length})`}</span>
          {repos.map((repo) => (
            <RepoChip
              key={repo.root.path}
              repo={repo}
              label={lone ? undefined : repo.name || basename(repo.root.path)}
              pins={pins[repo.root.path] ?? {}}
              onViewChanges={onViewChanges}
            />
          ))}
        </span>,
      );
    }

    const text = reposButtonText(repos.length, foundCount);
    items.push(
      <button
        key="manage"
        type="button"
        onClick={onOpenRepos}
        aria-label={text ?? 'Manage repos'}
        title="Repos in this project"
        className="flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <FolderGit2 className="h-3 w-3" />
        {text}
      </button>,
    );

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
