# Multi-repo git widget — design

Date: 2026-11-14
Status: draft, awaiting Greg's approval

## Intent

Some projects are not git repos themselves but contain git repos (Greg's work
project has two sub-folders that are repos). Today those projects get **no git
widget at all**: the session watcher only checks `<project>/.git`
(`resolveGitdir`, `electron/services/git-watcher.ts`), so `gitStatus.branch` is
null and the branch block / `BranchStatusBar` are hidden.

The goal is a git widget that is always present, knows which repos live inside
the project, and shows branch + working-tree state for the ones the user has
chosen to watch — chosen once per project, shared by every session in it.

## Goals

- The git widget is resident in every session, repo or not.
- It discovers sub-repos up to a per-project scan depth (default 1) and shows
  how many were found but are not watched.
- One dialog lists discovered repos; per repo the user can toggle watching and
  edit that repo's branch colours. Scan depth is set in the same dialog.
- Watch selections are saved per project; every open session in that project
  picks up a change live, and future sessions start with it.
- The same dialog opens from the session's git widget and from the project
  screen, replacing `BranchColorsCard` there.
- Branch colours belong to the **repo**, not the project: the same repo shows
  the same colours whether opened directly or inside any project.

## Non-goals

- Tab-status popover / `TabStatusSummary` (`branch`, `filesChanged`,
  `filesUntracked`) stays root-repo-only, or null/0 for a non-repo project.
  Multi-repo there is a later change. *(Claude's call.)*
- No git operations (commit, checkout, fetch) from the dialog.
- No auto-watching. Codex-specific behaviour is unchanged.

## Anti-goals

- A newly appearing repo (a clone, a vendored dependency) must never start
  being polled or appear as a chip without the user opting in. It only bumps
  the "found" count.
- Scanning must not run on the 3s poll and must not walk large trees
  (`node_modules`, hidden dirs).
- No per-tab multi-watch juggling in the renderer — visibility/reconnect/resync
  for git stays one watch per session.

## Decisions (Greg's)

- Colours follow the repo everywhere.
- Scan depth default 1 (direct children only).
- If the project folder is itself a repo, it is always watched; sub-repos are
  extras in the same dialog.
- Newly found repos are never auto-watched.
- Bar layout: option B (below). Greg will adjust after seeing it.
- Implementation: approach A (below).
- Changes view is per repo/worktree; the toolbar diff button goes.

## Approaches considered

- **A. One session watch spanning N repos (chosen).** The session's single
  watch subscribes to one `RepoReader` per watched repo (project root if a
  repo, plus each watched sub-repo). Readers are already keyed by repo
  commondir, so sessions/projects sharing a repo share one poll. The snapshot
  shape changes. Trade-off: touches the watch protocol and every
  `SessionGitSnapshot` consumer.
- **B. Renderer opens one watch per repo and merges.** Less daemon change,
  but each tab manages N watch IDs through visibility/reconnect/resync — the
  area that has produced stuck-state bugs — and the found count needs a
  separate call. Rejected.
- **C. Fold sub-repos into `RepoReader`.** Conflates repo identity with
  project composition; a reader shared across projects would leak one
  project's sub-repos into another. Rejected.

## Design

### Storage (SQLite, `greychrist.db`)

New migration:

- `project_git_settings(project_path TEXT PRIMARY KEY, scan_depth INTEGER NOT NULL DEFAULT 1)`
  — absent row means depth 1.
- `project_git_repos(project_path TEXT, repo_path TEXT, watched INTEGER NOT NULL, PRIMARY KEY(project_path, repo_path))`
  — only repos the user has touched get a row. `repo_path` is the repo's
  **identity path**: the realpath of its main checkout (the parent of the
  common git dir), so a linked worktree resolves to the same identity as its
  main checkout. *(Claude's call — follows "colours follow the repo".)* The project root, when a repo, is implicit
  and has no row.
- Branch colours move to a new `repo_branch_colors(repo_path, branch_name, …)`
  table, copied from `branch_colors` by the migration. Rows keyed by a linked
  worktree fold into the main checkout's identity path (resolved from the
  `.git` file → `commondir`, pure filesystem); on a clash the main checkout's
  row wins. `branch_colors` is left untouched: an older installed daemon
  shares the database with a dev build and reads it at start-up. A later
  migration drops it. *(Claude's call, after review.)*

Paths are stored realpath-normalised, matching the watcher.

### Discovery

`discoverRepos(projectPath, depth)` in a new `electron/services/git-repos.ts`:

- Breadth-first walk from the project root, depth 0 = root itself. The root
  being a repo does **not** stop the walk; sub-repos below a repo root are
  found (Greg's "sub-repos are extras" case).
- Below the root, a directory containing `.git` (dir or `gitdir:` file) is a
  repo and the walk does not descend further into it. Submodules and
  gitignored nested clones count as repos. *(Claude's call.)*
- A linked worktree of an already-found repo is not listed separately — it
  shows in that repo's chip popover.
- Skip hidden dirs, `node_modules`, and symlinks to directories.
- Returns `{ path, name }[]` where `name` is the path relative to the project
  root (`api`, `services/web`).
- Hard cap of 50 results; beyond it, return the first 50 plus `truncated: true`.

Runs on watch start, on dialog open, and on the dialog's Rescan button. Not on
the poll.

### Service: `ProjectReposService`

`createProjectReposService({ db, discover })`:

- `get(projectPath)` → `{ scanDepth, rootIsRepo, repos: [{ path, name, watched }], truncated }`
  — runs discovery and joins with saved rows.
- `setWatched(projectPath, repoPath, watched)`
- `setScanDepth(projectPath, depth)` (1–5)
- `watchedRepos(projectPath)` → realpaths, root first if a repo. Reads saved
  rows only (no discovery), so a watch start subscribes immediately; discovery
  for `foundCount` follows asynchronously.
- An explicitly watched repo stays watched when discovery stops returning it
  (depth lowered, past the cap). If its path is gone or no longer a repo it is
  not polled, the dialog lists it as **missing** with a Remove action, and
  the row is kept until removed. *(Claude's call.)*
- Emits `project-repos-changed:<projectPath>` (or an internal event the git
  watcher subscribes to) after any write.

### Session git watcher (approach A)

`SessionGitSnapshot` becomes:

```ts
interface RepoSnapshot {
  name: string;          // relative to project root; '' for the root itself
  root: PathSnapshot;    // the repo's own checkout
  worktrees: PathSnapshot[];
}
interface SessionGitSnapshot {
  repos: RepoSnapshot[]; // root repo first, then watched sub-repos by name
  foundCount: number;    // discovered but not watched
}
```

- `start(projectPath)` asks `ProjectReposService.watchedRepos` and subscribes
  the one watch to a reader per repo; `snapshotFor` assembles across them.
- Visibility, holder, reconnect, stop all stay per watch; a watch's
  visibility applies to all its readers (a reader is visible if any
  subscriber of any watch is).
- On `project-repos-changed`, every watch for that project re-reads the
  watched set, subscribes/unsubscribes readers, re-runs discovery for
  `foundCount`, and emits.
- A non-repo project with nothing watched yields `{ repos: [], foundCount }`.

All consumers of the old `{ project, worktrees }` shape are migrated in the
same change (`AgentSession.tsx`, `BranchStatusBar`, the header branch block,
`git-diff.ts` references, tests). No dual-shape compatibility.

### Branch colours

- `branch-colors.ts` API renames `project_path` → `repo_path`
  (`listForRepo`, upsert by `repo_path`).
- Colour edits broadcast `branch-colors-changed:<repoPath>`; every open
  session showing that repo re-fetches its pins, so an edit made in the
  dialog shows at once everywhere. *(Claude's call.)*
- `resolveBranchColors` is called **per repo** with that repo's pins and that
  repo's root branch as `mainFolderBranch`. Two repos both on `feat/x` may get
  different colours; that is correct.

### Widget (bar layout B)

Always rendered. Examples:

```
repos (2) [api·main ●3] [web·feat/login ●1 +2]  ⎇ +1 found
branch [main ●3]  ⎇ +2 found            ← project root is a repo, sub-repos unwatched
⎇ 2 repos found                          ← non-repo project, nothing watched
⎇ no repos                               ← nothing found
```

- One chip per watched repo: `name·branch` plus counts. The root repo's chip
  shows the branch alone (no name prefix) when it is the only repo.
- Worktrees move into each chip's popover (list + per-worktree "View
  changes"), instead of a separate `worktrees (n)` section.
- The `⎇ …` affordance opens the repos dialog. Always present (also as a
  settings entry when nothing is found, so scan depth can be raised).
- Same change applies to both the header branch block and `BranchStatusBar`.
- "View changes" is per repo and per worktree only: each chip's popover has
  one for the repo's checkout and one per worktree listed there. The
  toolbar's project-wide "Working tree changes" button
  (`AgentSession.tsx`, `GitCompare` icon) is **removed** (Greg). The diff
  viewer keeps its own close (`onClose` → `setDiffTarget(null)`).

### Repos dialog

One component, `ProjectReposDialog({ projectPath })`, opened from the widget
and from the project screen (a "Repos & branch colours" card replacing
`BranchColorsCard` in `TabContent.tsx`).

- Header: scan depth selector (1–5), Rescan button, truncated warning.
- One row per discovered repo (root first): name, path, current branch,
  watch toggle (root's is on and disabled).
- Expanding a row shows that repo's branch-colour editor — the existing
  `BranchColorsCard` body, re-pointed at `repo_path`.

### IPC

New invoke channels (daemon-owned, network-reachable — fine for the iPad):
`get_project_repos`, `set_project_repo_watched`, `set_project_repo_scan_depth`.
Branch-colour channels keep their names, take `repoPath` (accept
`repo_path`). Add to `INVOKE_CHANNELS`; covered by `ipc-channel-contract.test.ts`.

## Testing

- `git-repos` discovery: depth, skip rules, no descent into repos, cap.
- `ProjectReposService`: in-memory DB, joins, root implicit, writes emit.
- Migration: column rename preserves rows; re-run safe.
- Session git watcher: multi-repo snapshot, shared reader across two
  projects, live re-subscribe on change, `foundCount`, non-repo project.
- Renderer: `BranchStatusBar` states above; dialog toggles and colour edits.

## Left to the builder

- Exact visual styling of the `⎇` affordance and dialog.
- Whether discovery runs inline or off the event loop (`fs.promises`), as
  long as it never blocks a session.
- Debounce for re-subscribe on rapid toggles.
