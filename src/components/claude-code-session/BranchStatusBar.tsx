import * as React from 'react';
import { FolderGit2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { InlineDivider } from '@/components/ui/inline-divider';
import { ButtonGroup } from '@/components/ui/button-group';
import { STATUS_BAR_SURFACE } from '@/components/ChatStatusBar';
import { resolveBranchColors } from '@/lib/branchColors';
import type { RepoSnapshot, SessionGitSnapshot } from '@/lib/api';
import { GitBranchBadge } from './GitBranchBadge';

/**
 * The git widget as a second status bar, always present. Each watched repo is
 * one capsule — its name, then a segment per checkout (main first, then each
 * worktree) with that checkout's branch and changes:
 *
 *   [backend │ dev ●3 │ test/wt-be-1 │ test/wt-be-2 ●1 +2]  [frontend │ dev │ …]  [📁│⟳]
 *
 * Repo names lose the prefix they share; a capsule wraps as a unit. A
 * segment's popover has the path and View changes; a repo's name opens the
 * repos dialog. Same surface and 10px type as the chat status bar above it.
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


function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function reposButtonText(shown: number, found: number): string | null {
  if (shown === 0) return found > 0 ? `${found} repo${found === 1 ? '' : 's'} found` : 'no repos';
  return found > 0 ? `+${found} found` : null;
}

/**
 * Display names with the prefix every repo shares removed, cut back to a
 * separator so `encompass-platform-backend` / `-frontend` become `backend` /
 * `frontend`. A lone repo, or a cut that would empty a name, keeps the full names.
 */
export function shortRepoNames(names: string[]): string[] {
  if (names.length < 2) return names;
  let prefix = names[0];
  for (const n of names.slice(1)) {
    let k = 0;
    while (k < prefix.length && k < n.length && prefix[k] === n[k]) k++;
    prefix = prefix.slice(0, k);
  }
  const cut = Math.max(...['-', '_', '/', '.', ' '].map((c) => prefix.lastIndexOf(c))) + 1;
  if (cut <= 0) return names;
  const short = names.map((n) => n.slice(cut));
  return short.some((n) => n === '') ? names : short;
}

function RepoCapsule({ repo, fullName, shortName, pins, onViewChanges, onOpenRepos }: {
  repo: RepoSnapshot;
  fullName: string;
  shortName: string;
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
    <ButtonGroup label={fullName} className="shrink-0">
      <button
        type="button"
        onClick={onOpenRepos}
        title={`${fullName}\n${repo.root.path}`}
        className="flex items-center px-1.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground focus:outline-none focus-visible:bg-accent"
      >
        {shortName}
      </button>
      {checkouts.map((c, i) => {
        const name = label(c.branch);
        const isMain = i === 0;
        return (
          <GitBranchBadge
            key={c.path}
            size="bar"
            segment
            className={isMain ? 'font-semibold' : undefined}
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
    </ButtonGroup>
  );
}

export const BranchStatusBar = React.forwardRef<HTMLDivElement, BranchStatusBarProps>(
  function BranchStatusBar({ snapshot, pins, onViewChanges, onOpenRepos, watch, className }, ref) {
    const { repos, foundCount } = snapshot;
    const items: React.JSX.Element[] = [];
    const fullNames = repos.map((r) => r.name || basename(r.root.path));
    const shortNames = shortRepoNames(fullNames);

    if (repos.length > 0) {
      items.push(
        <span key="repos" className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {repos.map((repo, i) => (
            <RepoCapsule
              key={repo.root.path}
              repo={repo}
              fullName={fullNames[i]}
              shortName={shortNames[i]}
              pins={pins[repo.root.path] ?? {}}
              onViewChanges={onViewChanges}
              onOpenRepos={onOpenRepos}
            />
          ))}
        </span>,
      );
    }

    const text = reposButtonText(repos.length, foundCount);
    // The repos button and the watch glyph act on the same thing — this
    // project's git — so they sit together as one control.
    items.push(
      <ButtonGroup key="git" label="Git">
        <button
          type="button"
          onClick={onOpenRepos}
          aria-label={text ?? 'Manage repos'}
          title="Repos in this project"
          className="flex h-5 items-center gap-1 px-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground focus:outline-none focus-visible:bg-accent"
        >
          <FolderGit2 className="h-3 w-3" />
          {text}
        </button>
        {watch}
      </ButtonGroup>,
    );

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
