# Branch Colors — Design

**Date:** 2026-04-29
**Status:** Draft, pending implementation plan

## Problem

Branch chips on the project page and the session header today get a color from a name-hash over a 6-color palette in `src/components/claude-code-session/GitBranchBadge.tsx`. Two pain points:

- The main folder's branch and its sibling worktree branches frequently hash to the **same color**, so the chips read as one undifferentiated cluster.
- There is no way for the user to **pin** a color to a branch they care about (e.g. always show `develop` in a specific color).

## Goal

1. Color the main folder's branch chip predictably (black for `main`/`master`, blue for any other name).
2. Color worktree branch chips so no two chips in the same view share a color and no chip collides with the main folder chip.
3. Let the user pin a specific color to a branch from the project page, surfaced as a list (similar to the Accounts list).
4. Replace the remaining raw `<select>` elements with shadcn `<Select>` for visual consistency.

## Non-goals

- Per-account or global branch-color overrides.
- Renaming or restyling chips elsewhere in the app (account badges, status icons).
- Changing the existing palette beyond what the resolver needs.

## Resolution rules

A pure resolver decides each chip's color. Inputs: the user's pin map for the project, the main folder's branch name, and the ordered list of branch names being rendered in the current view (main folder branch followed by worktree branches as listed in `worktreeList`).

For each branch in order, the resolver applies:

1. If the branch has a user pin → use the pinned color.
2. Else if the branch is `main` or `master` → black (the existing trunk style).
3. Else if the branch is the main folder branch → blue (`#60a5fa`).
4. Else → next palette color, skipping any color already assigned by steps 1–3 above and any earlier step-4 pick in the same view.
5. If the palette is exhausted in step 4, fall through to the existing name-hash color so chips never render uncolored.

Step 4 iterates the existing `BRANCH_COLORS` palette in order and skips any color already taken by an earlier rule. When the main folder branch hits step 3 (non-trunk), blue is reserved and worktrees skip past it; when the main folder branch is `main` itself (step 2), blue is free and the next worktree may pick it. If the palette is exhausted before all branches are colored, the resolver falls through to the name-hash for the remainder so chips never render uncolored — duplicates are tolerated only in this fallback.

## Architecture

### Persistence

New SQLite table:

```sql
CREATE TABLE branch_colors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  color TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(project_path, branch_name)
);
CREATE INDEX idx_branch_colors_project ON branch_colors(project_path);
```

`color` is stored as a hex string (matches `Account.color` convention). `sort_order` keeps the list stable in the UI without forcing a separate sort key.

Migration is added to `electron/services/database.ts` following the pattern used for `path_rules` and `project_overrides`.

### Service

`electron/services/branch-colors.ts` exports `createBranchColorsService(db)` returning:

- `listForProject(projectPath: string): BranchColor[]`
- `upsert(input: { project_path: string; branch_name: string; color: string }): BranchColor`
- `delete(id: number): boolean`

Tests in `electron/__tests__/branch-colors.test.ts` cover CRUD, the `(project_path, branch_name)` uniqueness constraint, and ordering by `sort_order, id`.

### Branch listing IPC

`git:list-branches(projectPath)` returns the local branch names for the dropdown in the new card. Implementation: spawn `git for-each-ref refs/heads --format=%(refname:short)` from `projectPath`. Failure modes (not a repo, git missing) return an empty array; the UI falls back to a free-text input only if the array is empty.

This lives next to the existing git helpers in the main process. No new service file unless one already exists for git utilities — otherwise add to `electron/services/git.ts`.

### Pure resolver

`src/lib/branchColors.ts` exports:

```ts
export interface ResolveInput {
  pins: Record<string, string>;            // branch_name -> hex
  mainFolderBranch: string | null;          // null if not in a repo
  branches: string[];                       // ordered: main folder first, then worktrees
}
export interface ResolveOutput {
  colors: Record<string, string>;           // branch_name -> hex
  trunkBlack: Set<string>;                  // branches that should render with the black "trunk" style
}
export function resolveBranchColors(input: ResolveInput): ResolveOutput;
```

Pure, no React, fully unit-testable. The existing trunk-style code in `GitBranchBadge` keeps its black background but the decision now comes from `trunkBlack` rather than a literal `name === 'main'` check inside the badge — this keeps the override path open for users who pin a color to `main`.

`GitBranchBadge` is refactored to accept a resolved `color: string | null` and `isTrunk: boolean` from the parent. The internal `BRANCH_COLORS` array and `hashBranchColor` move into `branchColors.ts` as implementation detail of the resolver.

### Renderer wiring

- `TabContent` (project page): on project open, fetch `branchColors.listForProject(path)` and `git.listBranches(path)`. Pass results to `BranchColorsCard` and via context/props to anything that renders branch chips on this surface.
- `ClaudeCodeSession` (session header chips): in addition to the existing git snapshot, fetch the pin map for the project once on mount. Pass `pins`, `mainFolderBranch` (= `gitStatus.branch`), and the chip's `branches` array through `resolveBranchColors` and into each `GitBranchBadge`.

The pin map is small (typically <10 entries per project), so plain props/state is sufficient — no new Zustand store.

### UI: `BranchColorsCard`

Lives at `src/components/BranchColorsCard.tsx`. Mounted in `TabContent` inside the right column, above the existing `SessionList`. The right column wraps both the new card and the session list in a flex container so the card's top edge aligns with the `NewSessionForm`'s top.

Layout mirrors `AccountSettings`'s account list:

- Card header: "Branch Colors".
- Empty state: short hint + "Add" button.
- Each row: chip preview (using the resolver, so the user sees exactly the chip they will get) · branch name text · pencil to edit · trash to delete.
- Add/edit row: shadcn `<Select>` for branch (populated from `git:list-branches`, with the user's existing pins filtered out in add mode), `ColorSwatchGrid` for color, Save / Cancel.

`SWATCHES` and `ColorSwatchGrid` are extracted from `AccountSettings.tsx` to `src/components/ui/ColorSwatchGrid.tsx` and reused here.

### Side task: raw `<select>` cleanup

Replace all 9 raw `<select>` elements with shadcn `<Select>` to match the rest of the app:

- `src/components/AccountSettings.tsx` — lines 112, 133, 146, 159, 172, 626 (account-edit dialog: type, model, thinking, effort, permissions, plus path-rule account picker).
- `src/components/Settings.tsx` — line 321 (account picker for settings).
- `src/components/SessionPermissionsEditor.tsx` — line 212.
- `src/components/ProjectList.tsx` — line 198.

Behavior preserved — values, change handlers, and surrounding labels stay identical. Only the rendering swap.

## Data flow

```
User opens project
  └─ TabContent.useEffect
        ├─ api.branchColors.list(projectPath)        ─┐
        └─ api.git.listBranches(projectPath)          ─┤
                                                       ├─ BranchColorsCard
ClaudeCodeSession opens                                │
  └─ session-git snapshot stream                       │
        └─ resolveBranchColors({ pins, mainFolderBranch, branches })
              └─ GitBranchBadge (presentational)
```

## Error handling

- `git:list-branches` failures (not a repo, git not installed): return `[]`. The card's Add flow shows "No branches detected — open a repo first." and disables the form.
- `branch-colors.upsert` collision (branch already pinned): the service replaces the existing color — there is exactly one pin per `(project, branch)` by design.
- Renderer: any IPC failure is logged and the card renders with `pins = {}` so chips fall back to the auto rules.

## Testing

- **Service** (`electron/__tests__/branch-colors.test.ts`): list / upsert (insert + replace) / delete / uniqueness / ordering. Uses `createDatabase(':memory:')`.
- **Resolver** (`src/lib/__tests__/branchColors.test.ts`): rule priority, no-duplicates invariant across a 4–8 branch sample, palette exhaustion fallback, pin overrides, trunk override.
- **Manual verification**: open a multi-worktree project (`~/Repos/personal/WIN`), confirm `develop` is blue, three worktrees pick distinct colors, pin one of them to a specific color and confirm the others rebalance to avoid it.

## Verification

Per `CLAUDE.md`'s cross-cutting rule:

- `npm run check`
- `npm test`
- `npm run build`
- `npm run test:coverage` (target: ≥80% lines on new service + resolver)
- `npm run rebuild:electron` after the test run, before relaunching the app.

## Bundled concern: Opus 200K context window mis-reporting

**Symptom:** Sessions started with the `opus` (200K) model id show context usage calculated against a 1,000,000-token limit instead of 200,000.

**Code path today:**

- `src/components/ModelPicker.tsx:18-50` exposes two opus entries: `id: "opus[1m]"` and `id: "opus"`.
- `electron/services/sessions/lifecycle.ts:241` passes the chosen `model` straight to the SDK `query({ options: { model } })` without any translation.
- `src/components/SessionHeader.tsx:357-363` uses `contextUsage.maxTokens` from `query.getContextUsage()` when available; the static `model.includes("[1m]")` fallback only fires when `contextUsage` is null.

If the displayed limit is 1M for an `opus` session, the SDK's `getContextUsage()` is returning `maxTokens: 1_000_000` for that session — meaning either the SDK is mis-reporting, or the SDK is silently routing `"opus"` to the long-context variant.

**Investigation steps:**

1. Add a one-line diagnostic in `lifecycle.ts` `start()` after the SDK options are built that logs the chosen `model` id alongside the first `getContextUsage()` snapshot once the query starts streaming.
2. Start three sessions in sequence — `opus[1m]`, `opus`, `sonnet` — and capture the logged maxTokens for each from `/tmp/greychrist.log`.
3. Cross-reference the values with the Agent SDK's documented model-alias behavior (Context7 lookup on `@anthropic-ai/claude-agent-sdk`).

**Fix path branches:**

- *If the SDK is reporting wrong numbers but routing the model correctly* — add a renderer-side clamp in `SessionHeader.tsx`: when `contextUsage.maxTokens > 200_000` and the active model id does not contain `[1m]`, treat the limit as `200_000`. Keep the SDK number as the source of truth otherwise.
- *If the SDK is silently routing `"opus"` to the 1M variant* — change the model alias passed to the SDK so the 200K option resolves to the explicit short-context model id (e.g. `claude-opus-4-7`). The picker's display id can stay `"opus"`; the translation lives in `lifecycle.ts` start.
- *If the SDK exposes a `betas` / `context1m` flag* — the 1M option opts in via that flag and the plain `opus` alias is implicitly 200K. In that case, the bug is on our side: we never set the flag for `opus[1m]`, so both fall to whatever default the SDK picks. Switch to flag-based selection.

The fix lands in this same change because it shares the model-string handling that the branch-colors work touches transitively (none directly — but the user asked for them bundled).

**Verification:**

- `npm test` covers the lifecycle change if the fix path requires translation logic — add a test in `electron/__tests__/sessions.test.ts` that asserts the SDK options for each picker id.
- Manual: start sessions on each model, confirm the context donut reads against 200K for `opus` and `sonnet`, and 1M for `opus[1m]`.

## Build sequence

1. Extract `SWATCHES` + `ColorSwatchGrid` to `src/components/ui/ColorSwatchGrid.tsx`. Update `AccountSettings.tsx` to import from the new location.
2. DB migration in `electron/services/database.ts` + `branch-colors.ts` service + tests.
3. IPC channels (`branch-colors:list|upsert|delete`, `git:list-branches`) wired in `electron/main.ts`, `electron/ipc/handlers.ts`, `electron/preload.ts`. Typed wrappers in `src/lib/api.ts`.
4. Pure resolver + tests in `src/lib/branchColors.ts`.
5. Refactor `GitBranchBadge` to accept resolved color/isTrunk; update `ClaudeCodeSession` to compute and pass them.
6. Build `BranchColorsCard` and mount in `TabContent` right-column wrapper.
7. Swap all 9 raw `<select>` to shadcn `<Select>`.
8. Investigate Opus 200K mis-reporting per the steps above and apply the matching fix branch.
9. Run full verification gate.
