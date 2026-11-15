# Multi-repo Git Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A git widget that is always present, discovers sub-repos per project, and shows the repos the user chose to watch, with branch colors keyed by repo.

**Architecture:** A per-project `ProjectReposService` (SQLite + filesystem discovery) tells the existing session git watcher which repos a project watches; one session watch subscribes to one shared `RepoReader` per repo and emits `{repos[], foundCount}`. The renderer draws one chip per repo (layout B) and opens a shared `ProjectReposDialog` for watch toggles + per-repo branch colors.

**Tech Stack:** TypeScript, Node 26, better-sqlite3, React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-14-multi-repo-git-widget-design.md`

## Global Constraints

- Scan depth default 1, allowed 1–5; discovery cap 50 results (`truncated: true` beyond).
- Discovery skips hidden dirs, `node_modules`, symlinked dirs; never runs on the 3s poll.
- Newly discovered repos are never auto-watched.
- Project root, when a repo, is always watched and has no `project_git_repos` row.
- Repo identity path = realpath of the main checkout (linked worktrees resolve to it).
- No dual-shape compatibility for the old `{project, worktrees}` snapshot — every consumer migrates.
- New invoke channels go in `INVOKE_CHANNELS`; handlers accept camelCase and snake_case.
- Main-process gate: `npm run check` + `npm test`; final: `/verify`.

## Review Focus

- Non-repo project with zero repos found → widget shows `⎇ no repos`, opens dialog, no errors in console.
- Same repo watched by two projects open at once → one reader, one `git status` per tick.
- Watched repo deleted on disk → no poll errors spam; dialog shows it as missing.
- Toggling watch in one tab updates another tab of the same project without reload.
- Session opened in a linked worktree → colors match the main checkout's pins.

---

### Task 1: Repo identity, discovery, migration

**Files:**
- Create: `electron/services/git-repos.ts`
- Modify: `electron/services/database.ts` (migration v32)
- Test: `electron/__tests__/git-repos.test.ts`, `electron/__tests__/database.test.ts`

**Interfaces:**
- Produces:
  - `repoIdentity(dir: string): string | null` — sync; null when `dir` is not a repo top level. Reads `.git` (dir or `gitdir:` file); for a gitdir with a `commondir` file, identity = `realpath(dirname(resolved commondir))`; otherwise `realpath(dir)`.
  - `discoverRepos(projectPath: string, depth: number): Promise<{ rootIsRepo: boolean; repos: DiscoveredRepo[]; truncated: boolean }>` where `DiscoveredRepo = { path: string /* realpath */; name: string /* relative to project, posix */ }`. `repos` excludes the root.
  - Tables `project_git_settings(project_path PK, scan_depth)`, `project_git_repos(project_path, repo_path, watched, PK(project_path, repo_path))`; `branch_colors.repo_path` (renamed).

- [ ] **Step 1: Failing tests** in `git-repos.test.ts` (temp dirs, real `git init`):
  - `repoIdentity` → realpath for a plain repo; main-checkout path for a `git worktree add` worktree; null for a plain dir.
  - `discoverRepos(root, 1)` finds `a/`, `b/` repos, not `a/nested/` repo, not `deep/x/` at depth 1 but finds it at depth 2.
  - skips `.hidden/repo`, `node_modules/repo`, symlink to a repo dir.
  - root is a repo containing `sub/` repo → `rootIsRepo: true`, repos `[sub]`.
  - a linked worktree of `a` placed at `wt/` is not listed when `a` is listed.
  - 51 child repos → 50 returned, `truncated: true`.
- [ ] **Step 2:** `npx vitest run electron/__tests__/git-repos.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement in `git-repos.ts` with `fs.promises` BFS; depth counts from root=0.
- [ ] **Step 4:** Failing migration test in `database.test.ts`: seed v31 DB with `branch_colors` rows for (repo R, `feat`), (worktree W of R, `feat`), (W, `wip`), run migrations → rows `(R,feat)` keeps R's color, `(R,wip)` exists, column is `repo_path`, new tables exist; re-run is a no-op. Use the `>= N` schema_version clear pattern.
- [ ] **Step 5:** Add migration v32: create tables; `ALTER TABLE branch_colors RENAME COLUMN project_path TO repo_path`; recreate index as `idx_branch_colors_repo`; for each distinct `repo_path`, `repoIdentity()`; when it differs and is non-null, `UPDATE OR IGNORE` to the identity then `DELETE` leftovers (main checkout wins on clash). Pass the fs function via the migration (pure fs, no git spawn).
- [ ] **Step 6:** Run both test files → PASS. Commit `feat(git): repo identity, sub-repo discovery, v32 schema`.

### Task 2: ProjectReposService, branch colors by repo, IPC

**Files:**
- Create: `electron/services/project-repos.ts`
- Modify: `electron/services/branch-colors.ts`, `electron/ipc/handlers.ts`, `electron/ipc/channels.ts`, `electron/remote/daemon.ts`, `src/lib/api.ts`
- Test: `electron/__tests__/project-repos.test.ts`, `electron/__tests__/branch-colors.test.ts`, `electron/__tests__/ipc-handlers.test.ts`

**Interfaces:**
- Consumes: Task 1 `discoverRepos`, `repoIdentity`.
- Produces:
  - `createProjectReposService({ db, discover, sendToRenderer }): ProjectReposService` with
    - `get(projectPath): Promise<ProjectRepos>`; `ProjectRepos = { scanDepth: number; rootIsRepo: boolean; rootPath: string; repos: { path: string; name: string; watched: boolean; missing: boolean }[]; truncated: boolean }` — union of discovered + saved rows; saved-but-undiscovered rows get `missing: !isRepoDir(path)`, still listed.
    - `setWatched(projectPath, repoPath, watched): void`, `setScanDepth(projectPath, depth): void` (clamp 1–5), `remove(projectPath, repoPath): void`.
    - `watchedRepos(projectPath): { path: string; name: string }[]` — sync, DB only; root first (name `''`) if `repoIdentity(projectPath)`; then watched rows whose path is still a repo, sorted by name.
    - `foundCount(projectPath): Promise<number>` — discovered, unwatched.
    - `onChange(listener: (projectPath: string) => void): () => void` — fired after each write.
  - Branch colors: `listForRepo(repoPath)`, `upsert({ repo_path, branch_name, color })`, `delete(id)`; each write broadcasts `sendToRenderer('branch-colors-changed', { repoPath })`. Callers pass any checkout path; the service normalises via `repoIdentity(path) ?? path`.
  - Channels `get_project_repos`, `set_project_repo_watched`, `set_project_repo_scan_depth`, `remove_project_repo`; `branch_colors_*` take `repoPath`/`repo_path`.
  - `api.getProjectRepos(projectPath)`, `api.setProjectRepoWatched(projectPath, repoPath, watched)`, `api.setProjectRepoScanDepth(projectPath, depth)`, `api.removeProjectRepo(projectPath, repoPath)`, `api.listBranchColors(repoPath)`, `api.upsertBranchColor({ repoPath, branchName, color })`, `api.onBranchColorsChanged(cb: (repoPath: string) => void): () => void`.
- [ ] **Step 1: Failing tests** `project-repos.test.ts` (`createDatabase(':memory:')`, stub `discover`): unwatched by default; `setWatched` persists and fires `onChange`; `watchedRepos` puts root first when root is a repo; depth clamps; saved repo absent from discovery is listed with `missing` true when the dir is gone; `foundCount` excludes watched.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement service; update `branch-colors.ts` + its test (rename, worktree path normalises to main checkout, broadcast on write).
- [ ] **Step 4:** Wire daemon (`satisfies Required<Services>`), handlers, channels, api.ts; extend `ipc-handlers.test.ts` for the four channels (both param casings).
- [ ] **Step 5:** `npm run check && npx vitest run electron/__tests__/{project-repos,branch-colors,ipc-handlers,ipc-channel-contract}.test.ts` → PASS. Commit `feat(git): per-project repo watch settings`.

### Task 3: Session git watcher spans repos

**Files:**
- Modify: `electron/services/git-watcher.ts`, `electron/ipc/handlers.ts` (types), `electron/remote/daemon.ts`, `src/lib/api.ts` (`SessionGitSnapshot`)
- Test: `electron/__tests__/git-watcher.test.ts`, `electron/__tests__/git-watcher-spawns.test.ts`

**Interfaces:**
- Consumes: Task 2 `watchedRepos`, `foundCount`, `onChange`.
- Produces:
  - `createSessionGitWatcher({ ..., repos: { watchedRepos(p): {path,name}[]; foundCount(p): Promise<number> } })` plus `reconfigure(projectPath: string): Promise<void>`.
  - `interface RepoSnapshot { name: string; root: PathSnapshot; worktrees: PathSnapshot[] }`
  - `interface SessionGitSnapshot { repos: RepoSnapshot[]; foundCount: number }`
- Approach: a `Watch { id, projectPath, visible, holder, subs: Map<repoReal, Subscriber>, foundCount, last }`; a `Subscriber` belongs to one watch and one reader and reads `visible` from its watch. `emitAll(r)` collects affected watches and emits each watch's assembled snapshot once. `reconfigure` diffs each matching watch's repo set, attaching/detaching subscribers (dispose readers with zero subscribers), refreshes `foundCount`, emits. Daemon calls `reconfigure` from `projectRepos.onChange`.
- [ ] **Step 1:** Rewrite existing snapshot assertions to the new shape (`snap.repos[0].root`, `snap.repos[0].worktrees`), and add failing tests:
  - non-repo project, nothing watched → `{ repos: [], foundCount: 2 }`.
  - non-repo project with `a`,`b` watched → two repos, names `a`,`b`, each with its own counts.
  - `reconfigure` after watching `b` emits a snapshot including `b`; after unwatching, `b`'s reader is disposed (spawn test: no further `git status` in `b`).
  - two watches on different projects both watching repo `a` → one `git status` per tick for `a` (spawns test).
  - watched repo path deleted → not in `repos`, no thrown errors.
- [ ] **Step 2:** `npx vitest run electron/__tests__/git-watcher*.test.ts` → FAIL.
- [ ] **Step 3:** Implement; update the module header comment for the new shape.
- [ ] **Step 4:** Run → PASS; `npm run check` will fail in renderer consumers — expected until Task 4. Commit `feat(git): one session watch spans the project's watched repos`.

### Task 4: Widget layout B + consumers

**Files:**
- Modify: `src/components/claude-code-session/BranchStatusBar.tsx`, `src/components/claude-code-session/GitBranchBadge.tsx`, `src/components/AgentSession.tsx`
- Create: `src/hooks/useRepoBranchPins.ts`
- Test: `src/components/claude-code-session/__tests__/BranchStatusBar.test.tsx`, `.../GitBranchBadge.test.tsx`, `src/hooks/__tests__/useRepoBranchPins.test.ts`

**Interfaces:**
- Consumes: Task 3 `SessionGitSnapshot`; Task 2 `api.listBranchColors`, `api.onBranchColorsChanged`.
- Produces:
  - `BranchStatusBarProps = { snapshot: SessionGitSnapshot; colorsFor: (repoPath: string) => (branch: string) => { color: string | null; isTrunk: boolean }; onViewChanges: (path: string, label: string) => void; onOpenRepos: () => void; watch?: ReactNode; className?: string }`
  - `GitBranchBadge` gains `repoName?: string` (rendered `name·branch`) and `worktrees?: { path; branch; changed; untracked; error }[]` + `onViewWorktreeChanges?(path)` listed in its popover.
  - `useRepoBranchPins(repoPaths: string[]): Record<repoPath, Record<branch, color>>` — fetches per repo, re-fetches on `branch-colors-changed` for a repo in the list.
- Rendering rules (copy fixed by spec):
  - one repo and it is the root → `branch [main ●3]`; otherwise `repos (N) [api·main ●3] …`.
  - foundCount > 0 → `⎇ +N found` (after chips) or `⎇ N repos found` (no chips); nothing at all → `⎇ no repos`; with chips and foundCount 0 → a bare `⎇` button. All open the dialog (`onOpenRepos`).
  - colors resolved per repo: `resolveBranchColors({ pins: pins[repo], mainFolderBranch: repo.root.branch, branches: [root branch, ...worktree branches] })`.
- [ ] **Step 1:** Failing tests in `BranchStatusBar.test.tsx` for each rendering rule above; `GitBranchBadge.test.tsx` for `repoName` prefix and popover worktree rows each with "View changes"; hook test for refetch on matching event only.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; in `AgentSession.tsx`: replace `gitStatus`/`worktreeList` derivations with `sessionGit.repos`; the header branch block renders the same chips as the bar (header-size); widget always rendered (drop the `gitStatus?.branch` gates, `hasBranchCard` becomes `true` when a snapshot exists); delete the toolbar "Working tree changes" button; tab-status summary reads the root repo (`repos.find(r => r.name === '')`) else null/0; `diffReading`/`gitRefreshToken` search all repos' paths. Delete the old `branchPins` effect.
- [ ] **Step 4:** `npm run check && npx vitest run src/components/claude-code-session src/hooks` → PASS. Commit `feat(git): repo chips in the branch widget`.

### Task 5: ProjectReposDialog + project screen

**Files:**
- Create: `src/components/ProjectReposDialog.tsx`
- Modify: `src/components/BranchColorsCard.tsx` (becomes `BranchColorsEditor` body taking `repoPath`), `src/components/TabContent.tsx`, `src/components/AgentSession.tsx`
- Test: `src/components/__tests__/ProjectReposDialog.test.tsx`

**Interfaces:**
- Consumes: Task 2 api calls; Task 4 `onOpenRepos`.
- Produces: `ProjectReposDialog({ projectPath, open, onOpenChange })`; `BranchColorsEditor({ repoPath, availableBranches, mainFolderBranch })`; project screen card `ProjectReposCard({ projectPath })` = title "Repos & branch colors", repo list summary, "Manage…" button opening the dialog.
- Dialog: depth `Select` (1–5) → `setProjectRepoScanDepth` then refetch; Rescan button → refetch; truncated warning "Showing the first 50 repos"; rows root first: name (root shows the folder name), path, watch `Switch` (root: on + disabled), `missing` rows show "missing" + Remove; expanding a row shows `BranchColorsEditor` for it (branches from `api.gitListBranches(repo.path)`).
- [ ] **Step 1:** Failing tests: toggling a row calls `setProjectRepoWatched`; root switch disabled; depth change calls API and refetches; missing row shows Remove calling `removeProjectRepo`; expanding a row renders the color editor for that repo path.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; replace `BranchColorsCard` in `TabContent.tsx` with `ProjectReposCard`; wire `onOpenRepos` in `AgentSession.tsx`.
- [ ] **Step 4:** Run tests → PASS. Run `/verify` (check, build, test, coverage). Commit `feat(git): repos dialog on session widget and project screen`.
