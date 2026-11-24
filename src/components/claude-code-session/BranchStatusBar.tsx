import * as React from 'react';
import { ReadoutLabel } from '@/components/ui/readout-label';
import { FolderCog, FolderGit, FolderGit2, GitBranch, GitPullRequest } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ButtonGroup } from '@/components/ui/button-group';
import { InlineDivider } from '@/components/ui/inline-divider';
import { STATUS_BAR_SURFACE } from '@/components/ChatStatusBar';
import { resolveBranchColors } from '@/lib/branchColors';
import type { RepoSnapshot, SessionGitSnapshot } from '@/lib/api';
import { GitBranchBadge } from './GitBranchBadge';

export interface BranchStatusBarProps {
  snapshot: SessionGitSnapshot;
  pins: Record<string, Record<string, string>>;
  aliases: Record<string, string>;
  onViewChanges: (path: string, label?: string) => void;
  onOpenRepos: () => void;
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

function RepoCapsule({ repo, fullName, displayName, columns, pins, onViewChanges, onOpenRepos }: {
  repo: RepoSnapshot;
  columns: number;
  fullName: string;
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
    <div role="group" aria-label={fullName} className="contents">
      <span data-cell data-repo-name className="flex items-center">
        <button
          type="button"
          onClick={onOpenRepos}
          title={`${fullName}\n${repo.root.path}`}
          className="flex items-center gap-1 rounded-sm px-0.5 text-[10px] hover:bg-foreground/10 focus:outline-none focus-visible:bg-foreground/10"
        >
          <FolderGit aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <ReadoutLabel aria-hidden="true">name</ReadoutLabel>
          <span>{displayName}</span>
        </button>
      </span>
      {checkouts.map((c, i) => {
        const name = label(c.branch);
        const isMain = i === 0;
        return (
          <span key={c.path} data-cell className="flex items-center gap-2">
            <InlineDivider data-testid="status-divider" />
            <GitBranchBadge
              size="bar"
              variant="text"
              className={isMain ? 'font-semibold' : undefined}
              icon={isMain ? GitBranch : FolderGit2}
              label={isMain ? 'branch' : 'worktree'}
              name={name}
              changed={c.changed}
              untracked={c.untracked}
              color={colors.colors[name] ?? null}
              isTrunk={colors.trunkBlack.has(name)}
              path={c.path}
              error={c.error}
              onViewChanges={() => { onViewChanges(c.path, isMain ? (repo.name || undefined) : name); }}
            />
          </span>
        );
      })}
      {/* Empty cells keep a repo with fewer worktrees on its own row. */}
      {Array.from({ length: Math.max(0, columns - checkouts.length) }, (_, k) => (
        <span key={`empty-${k}`} data-cell aria-hidden="true" />
      ))}
    </div>
  );
}

export const BranchStatusBar = React.forwardRef<HTMLDivElement, BranchStatusBarProps>(
  function BranchStatusBar({ snapshot, pins, aliases, onViewChanges, onOpenRepos, watch, className }, ref) {
    const { repos, foundCount } = snapshot;
    const fullNames = repos.map((r) => r.name || basename(r.root.path));
    const columns = Math.max(0, ...repos.map((r) => 1 + r.worktrees.length));

    const text = reposButtonText(repos.length, foundCount);

    return (
      <div
        ref={ref}
        data-testid="branch-status-bar"
        className={cn(STATUS_BAR_SURFACE, 'w-fit max-w-full flex-nowrap', repos.length > 1 ? 'items-start' : 'items-center', className)}
      >
        <span className="flex shrink-0 items-center gap-1 text-purple-400">
          <GitPullRequest aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <ReadoutLabel>repos</ReadoutLabel>
        </span>
        {repos.length > 0 && (
          <InlineDivider data-testid="label-divider" className="h-auto self-stretch" />
        )}
        {repos.length > 0 && (
          <div
            data-testid="repo-rows"
            className="grid min-w-0 items-center justify-start gap-x-2 gap-y-1 overflow-x-auto"
            style={{ gridTemplateColumns: `auto repeat(${columns}, auto)` }}
          >
            {repos.map((repo, i) => (
              <RepoCapsule
                key={repo.root.path}
                repo={repo}
                fullName={fullNames[i]}
                displayName={aliases[repo.root.path] ?? fullNames[i]}
                columns={columns}
                pins={pins[repo.root.path] ?? {}}
                onViewChanges={onViewChanges}
                onOpenRepos={onOpenRepos}
              />
            ))}
          </div>
        )}
        <InlineDivider data-testid="git-divider" className="ml-2 h-auto self-stretch" />
        <span className="flex shrink-0">
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
        </span>
      </div>
    );
  },
);
