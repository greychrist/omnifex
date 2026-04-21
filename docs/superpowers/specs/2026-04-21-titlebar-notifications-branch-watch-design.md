# Titlebar SDK Badges, Notification → Tab Routing, Live Branch Watch

**Date:** 2026-04-21
**Status:** Approved for implementation planning

Three small, independent feature additions to GreyChrist:

1. Show GreyChrist version, referenced SDK version, and latest-available SDK version as badges in the custom titlebar, with color-coded comparison.
2. Clicking an OS notification from a session opens the originating tab (not just the window).
3. The branch badge in `SessionHeader` stays in sync with the project's current git branch while the session is open.

Each feature touches the main-process / renderer IPC surface and is covered end-to-end by tests. No existing flows are removed.

---

## Feature 1 — Titlebar SDK Version Badges

### Goal

Give the user at-a-glance visibility into which SDK version the running build is tied to and whether a newer version has shipped.

### UI

In `src/components/CustomTitlebar.tsx`, add three badges to the left-side region, immediately right of the native traffic lights (currently holds only `v${appVersion}`).

Badges are styled to match `AccountBadge.tsx` (small rounded pill, `text-[10px]` monospace, muted background). Labels:

- `GreyChrist <version>` — e.g. `GreyChrist 0.3.28`
- `Referenced SDK <version>` — e.g. `Referenced SDK 0.2.116`
- `Current SDK <version>` — e.g. `Current SDK 0.2.116`

Color rules for the **Current SDK** badge only:

| State | Background |
| --- | --- |
| Matches referenced | green (`bg-green-500/15 text-green-500`) |
| Differs from referenced | red (`bg-red-500/15 text-red-500`) |
| Network failure / unknown | neutral, label shows `—` |

Tooltips:
- GreyChrist badge: `GreyChrist application version`
- Referenced badge: `SDK version this build is tied to`
- Current badge when matching: `SDK is up to date`
- Current badge when diff: `Newer SDK available on npm: <version>`

### Data

- **GreyChrist version** — existing `api.getAppVersion()`.
- **Referenced SDK version** — version installed in `node_modules`, read from `node_modules/@anthropic-ai/claude-agent-sdk/package.json`'s `version` field. This file is packaged into the Electron asar, so it's reliable at runtime in both dev and production. (We intentionally don't use `package-lock.json` — it's not shipped in the build, and `package.json`'s caret range isn't the exact pinned version.)
- **Current SDK version** — latest version from the npm registry (`https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest`).

### Main-process service

New file `electron/services/sdk-version.ts`:

```ts
export interface SdkVersionDeps {
  readSdkPackageJson: () => Promise<{ version?: string } | null>;
  fetchLatestVersion: () => Promise<string>;
}

export interface SdkVersionService {
  getReferenced(): Promise<string | null>;
  getLatest(): Promise<string | null>;
}

export function createSdkVersionService(deps: SdkVersionDeps): SdkVersionService;
```

- `getReferenced()` returns `.version` from the SDK's `package.json`, or `null` if missing / malformed.
- `getLatest()` returns the registry `.version`, or `null` on any failure (network, parse, non-2xx). Never throws.

In `electron/main.ts`, construct with:
- `readSdkPackageJson`: resolves `@anthropic-ai/claude-agent-sdk/package.json` via `require.resolve` (or read from `path.join(app.getAppPath(), 'node_modules/@anthropic-ai/claude-agent-sdk/package.json')`).
- `fetchLatestVersion`: uses global `fetch` with a 10s timeout.

### IPC

Two new channels added to `electron/ipc/handlers.ts` and `electron/preload.ts` allow-list:

- `get_referenced_sdk_version` → `string | null`
- `get_latest_sdk_version` → `string | null`

Typed wrappers in `src/lib/api.ts`:

```ts
getReferencedSdkVersion(): Promise<string | null>
getLatestSdkVersion(): Promise<string | null>
```

### Renderer behavior

In `CustomTitlebar`:
- On mount: fetch `appVersion`, `referencedSdk`, and `latestSdk` in parallel.
- `setInterval` every 60 minutes re-fetches `latestSdk` only. Cleared on unmount.

State shape: `{ appVersion, referencedSdk, latestSdk }` held as three separate `useState`s (simpler than a reducer for three values).

### Tests

- `electron/__tests__/sdk-version.test.ts` — unit tests with injected deps:
  - returns version from lockfile
  - returns `null` when entry missing
  - returns latest from fetched payload
  - returns `null` on fetch rejection / non-2xx / invalid JSON
- `electron/__tests__/ipc-handlers.test.ts` — wire the two new channels (existing handler test patterns).

No UI tests required (this is a display-only feature).

---

## Feature 2 — Notification Click Opens Source Tab

### Goal

When the user clicks an OS notification raised by a session, the app focuses the window **and** switches to the tab that produced it. Currently only the window focuses.

### Changes

**`electron/services/notifications.ts`:**
- Extend `NotificationsService.show()` signature:
  ```ts
  show(title: string, body: string, isError: boolean, payload?: { tabId?: string }): void
  ```
- Extend `NotificationsDeps` with:
  ```ts
  onNotificationClick?: (payload: { tabId?: string }) => void;
  ```
- In the `notif.on('click', …)` handler: after `focusWindow()`, call `deps.onNotificationClick?.(payload ?? {})`.

**`electron/services/sessions/types.ts`:**
- Widen `showNotification` in `NotificationHooks`:
  ```ts
  showNotification?: (title: string, body: string, isError: boolean, payload?: { tabId?: string }) => void;
  ```

**`electron/services/sessions/lifecycle.ts` + `permissions.ts` + `hooks.ts`:**
- All three callsites already have `tabId` in scope. Pass `{ tabId }` as the 4th argument.

**`electron/main.ts`:**
- Construct the notifications service with:
  ```ts
  onNotificationClick: ({ tabId }) => {
    if (tabId) sendToRenderer('notification-clicked', { tabId });
  }
  ```
- Add `notification-clicked` to the preload event-channel prefix allow-list.

**Renderer (`src/contexts/TabContext.tsx`):**
- Subscribe to `notification-clicked` once in `TabProvider`.
- Handler: if `getTabById(tabId)` exists, call `setActiveTab(tabId)`. If not, no-op (window is already focused; the tab was closed between fire and click).

### Tests

- `electron/__tests__/notifications.test.ts`:
  - calling `show(..., { tabId: 'abc' })` then simulating click invokes `onNotificationClick` with `{ tabId: 'abc' }`.
  - click without payload passes `{}` — no crash.
- `electron/__tests__/sessions.test.ts`:
  - existing `showNotification` assertions updated to assert the 4th-arg `{ tabId }` where applicable.

Renderer-side behavior is straightforward subscription — covered by keeping the handler tiny and trusting the context's existing `setActiveTab` path.

---

## Feature 3 — Live Branch Updates in SessionHeader

### Goal

The branch badge shown in `SessionHeader` (the lower of the two header rows — not the Project Header with "Back to Project") reflects the current branch while the session is open. Branch switches made outside the app (another terminal, another tool) appear without a manual refresh.

### Approach

Watch `.git/HEAD` via `fs.watch` in the main process. On change, re-read and emit. Zero polling cost on idle projects. Instant on branch switch.

### Main-process service

New file `electron/services/git-watcher.ts`:

```ts
export interface GitWatcherDeps {
  fs: Pick<typeof import('fs'), 'promises' | 'watch'>;
  path: Pick<typeof import('path'), 'join' | 'resolve'>;
}

export interface GitBranchWatcher {
  readonly watchId: string;
  stop(): void;
}

export interface GitWatcherService {
  watch(projectPath: string, onChange: (branch: string | null) => void): GitBranchWatcher;
  disposeAll(): void;
}

export function createGitWatcher(deps: GitWatcherDeps): GitWatcherService;
```

Behavior:
- Resolve the effective gitdir:
  - If `<projectPath>/.git` is a directory → gitdir is that directory.
  - If `<projectPath>/.git` is a **file** (git worktrees, submodules) → read it and parse `gitdir: <path>`.
  - If neither exists → return a no-op watcher (branch reported as `null`).
- `fs.watch(gitdir + '/HEAD', { persistent: false })` on change events:
  - Re-read HEAD.
  - Parse. `ref: refs/heads/<branch>` → `<branch>`. Raw SHA → short SHA (first 7 chars).
  - Debounce bursts to the trailing edge (50ms) since editors rewrite HEAD atomically in two ops.
  - Call `onChange(newBranch)`.
- Errors are swallowed and logged; watcher survives transient failures.
- `stop()` closes the underlying watcher. `disposeAll()` stops every active watcher (used on app quit).

Watch IDs are `crypto.randomUUID()`.

### IPC

Three additions:

- `start_git_branch_watch` → `{ projectPath }` → `{ watchId: string, branch: string | null }` (initial branch returned inline to avoid a race between subscribe and fetch).
- `stop_git_branch_watch` → `{ watchId: string }` → `void`.
- Event channel `git-branch-changed:<watchId>` emitting `{ branch: string | null }`.

Added to preload allow-list (invoke) and event-channel prefix allow-list.

Typed wrappers in `src/lib/api.ts`:

```ts
startGitBranchWatch(projectPath: string): Promise<{ watchId: string; branch: string | null }>
stopGitBranchWatch(watchId: string): Promise<void>
onGitBranchChanged(watchId: string, cb: (branch: string | null) => void): () => void
```

### Renderer changes

In `src/components/ClaudeCodeSession.tsx`, replace the existing effect at ~line 207:

```ts
useEffect(() => {
  if (!projectPath) return;
  let cancelled = false;
  let watchId: string | null = null;
  let unsub: (() => void) | null = null;

  (async () => {
    const { watchId: id, branch } = await api.startGitBranchWatch(projectPath);
    if (cancelled) {
      await api.stopGitBranchWatch(id);
      return;
    }
    watchId = id;
    setGitBranch(branch);
    unsub = api.onGitBranchChanged(id, setGitBranch);
  })();

  return () => {
    cancelled = true;
    unsub?.();
    if (watchId) void api.stopGitBranchWatch(watchId);
  };
}, [projectPath]);
```

The existing `api.getGitBranch` one-shot call is removed — the initial branch is returned by `startGitBranchWatch`.

### Tests

`electron/__tests__/git-watcher.test.ts`:
- Uses `child_process.execSync('git init')` in a temp dir.
- `watch()` returns initial branch.
- `git checkout -b foo` triggers `onChange('foo')` (poll with short timeout; filesystem events are async).
- Non-repo directory → `onChange(null)` initial, no crash.
- `.git` as a file (worktree simulated by writing `gitdir: <path>`) resolves correctly.
- `stop()` releases the fs watcher (subsequent changes no longer fire).

`electron/__tests__/ipc-handlers.test.ts`:
- Both new channels wired.
- `start_git_branch_watch` accepts both `projectPath` and `project_path`.

---

## Shared Infrastructure

### Preload allow-list additions

Invoke channels (`electron/preload.ts`):
- `get_referenced_sdk_version`
- `get_latest_sdk_version`
- `start_git_branch_watch`
- `stop_git_branch_watch`

Event prefix allow-list:
- `notification-clicked`
- `git-branch-changed:` (prefix)

### Service registration

`electron/main.ts`:
- Construct `sdkVersionService` and register handlers.
- Extend notifications service construction with `onNotificationClick`.
- Construct `gitWatcherService`, register its handlers, and call `disposeAll()` on app quit.

### Verification

Per repo rules:
- `npm run check`
- `npm test`
- `npm run build`
- `npm run test:coverage` (cross-cutting IPC additions).
- `npm run rebuild:electron` after any vitest run before the app restarts.

No UI-only changes in isolation here — every feature crosses the IPC boundary, so the full gate runs on each step.

---

## Out of Scope

- Auto-updating the SDK from the badge (that's `/update-sdk`).
- Showing branch state (dirty/clean, ahead/behind) — only the branch **name** is tracked.
- Cross-window tab routing — there is only one window.
- Replacing the existing `getGitBranch` IPC for other call sites; those continue to work unchanged. Only `ClaudeCodeSession` switches to the watcher.
