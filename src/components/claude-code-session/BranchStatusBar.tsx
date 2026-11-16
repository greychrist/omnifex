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

/**
 * The git widget, always present, in the chat status bar's own container and
 * readout style: the "repos" label, then a line per watched repo — its name,
 * then each checkout (main first, then each worktree) as its branch in the
 * branch's color with its changes — and the repos/refresh pair at the end:
 *
 *   ⑂ repos  ▣ backend   │ ⎇ dev ●3 │ ▣ test/wt-be-1 │ ▣ test/wt-be-2   [📁│⟳]
 *            ▣ frontend  │ ⎇ dev    │ ▣ test/wt-fe-1
 *
 * Repo names sit in one column. A repo shows its alias, else its folder name.
 * A checkout's popover has the path and View changes; a repo's name opens the
 * repos dialog.
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

function RepoCapsule({ repo, fullName, displayName, columns, pins, onViewChanges, onOpenRepos }: {
  repo: RepoSnapshot;
  /** Checkout columns in the table: the most any watched repo has. */
  columns: number;
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
    // `contents`: the group is for assistive tech only; its cells — the name,
    // then one per checkout — sit in the parent table's columns.
    <div role="group" aria-label={fullName} className="contents">
      <span data-cell data-repo-name className="flex items-center">
        <button
          type="button"
          onClick={onOpenRepos}
          title={`${fullName}\n${repo.root.path}`}
          // A readout like the chat bar's: icon, muted `name:` label, value.
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
              // A worktree is another folder with its own checkout; the icon says so.
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
      // One container, the chat status bar's own: the label, then a line per
      // repo (names in one column), then the repos/refresh pair at the end of
      // the first line.
      <div
        ref={ref}
        data-testid="branch-status-bar"
        // One line: centered, since the repos/refresh pair is taller than the
        // text beside it. Several: top-aligned, so the label and the pair sit
        // on the first repo's line.
        // Only as wide as its contents, never wider than the column.
        className={cn(STATUS_BAR_SURFACE, 'w-fit max-w-full flex-nowrap', repos.length > 1 ? 'items-start' : 'items-center', className)}
      >
        {/* The row's name, styled as a status readout: icon, then a quiet
            label, in a color of its own as each readout above has. */}
        <span className="flex shrink-0 items-center gap-1 text-purple-400">
          <GitPullRequest aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <ReadoutLabel>repos</ReadoutLabel>
        </span>
        {repos.length > 0 && (
          // Full height, so it rules the label off from every row of the table.
          <InlineDivider data-testid="label-divider" className="h-auto self-stretch" />
        )}
        {repos.length > 0 && (
          // A table: the name, then one column per checkout, sized to the repo
          // with the most, so each checkout's counts sit under its column.
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
        {/* The repos button and the watch glyph act on the same thing — this
            project's git — so they sit together as one control. */}
        {/* At the end, set off from the table by a little space and a rule —
            full height, like the label's, so it spans every repo row. */}
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
