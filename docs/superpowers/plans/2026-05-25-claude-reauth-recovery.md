# Phase 4 — Claude Re-Auth Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a one-click "Re-authenticate" affordance on Claude accounts whose credentials have gone stale (file missing, OAuth refresh failed, CLI returned "not authenticated"). No changes to the existing add-account UX; this is purely a recovery flow for an account that already exists in OmniFex's accounts list.

**Architecture:** New `ClaudeAuthService` mirrors `CodexAuthService` from Phase 3 — detects stale credentials lazily on app start + per account-row mount, reactively on session start errors, exposes a `reauthenticate(accountId)` method that spawns `claude /login` against that account's `CLAUDE_CONFIG_DIR` via the shared `OneShotTerminal` primitive. UI surface: a "Re-authenticate" chip button on stale account rows in `AccountSettings`, plus an in-session banner when a session fails with a credentials error.

**Tech Stack:** No new deps. Reuses Phase 3's `OneShotTerminal`, `runInteractiveCliFlow` shared primitive, and `fs.watch` patterns. Subprocess primitive unchanged.

**Spec:** `docs/superpowers/specs/2026-05-25-cli-engine-and-codex-design.md` (phase 4 only).

**Depends on:** Phase 3 (`2026-05-25-codex-engine-and-routing.md`) must be shipped — Phase 4 reuses `OneShotTerminal`. If Phase 4 ships before Phase 3 for any reason, this plan needs to ship the `OneShotTerminal` infrastructure too; that would roughly double its size.

---

## Non-Goals (out of scope)

- Changes to add-account UX. The existing "browse to an existing `CLAUDE_CONFIG_DIR`" flow stays unchanged. Re-auth operates on accounts already known to OmniFex.
- Reauth for Codex (already covered by Phase 3's sign-in flow).
- Bulk re-auth ("re-auth all stale accounts at once"). Each account is re-auth'd individually.
- Auto-detection of every possible stale-credentials shape. We cover the two clearest signals (file missing + session start error); fancier heuristics are future work.

---

## File Structure

**New files:**
- `electron/services/auth/claude-auth.ts` — `ClaudeAuthService` (status detection + reauth flow).
- `electron/__tests__/auth/claude-auth.test.ts`
- `src/components/claude/ReauthBanner.tsx` — in-session banner shown when session fails with credentials error.
- `src/components/shared/runInteractiveCliFlow.ts` — shared primitive (split out from `CodexAuthService.startLoginFlow` if not already separate).

**Modified files:**
- `electron/preload.ts` — add Claude auth channels.
- `electron/ipc/handlers.ts` — handlers for Claude auth status + reauth.
- `electron/main.ts` — construct + wire `ClaudeAuthService`.
- `src/lib/api.ts` — typed wrappers.
- `src/components/AccountSettings.tsx` — show stale state + "Re-authenticate" button per account row.
- `src/components/SessionHeader.tsx` — show stale state on the account chip.
- `electron/services/sessions/runtime.ts` — detect credentials-error in session start failures; emit a `session-credentials-stale:<tabId>` event.
- `src/components/AgentSession.tsx` — subscribe to that event; mount `ReauthBanner`.
- `CHANGELOG.md`, `package.json` — release.

---

## Task 1: Extract `runInteractiveCliFlow` as a shared primitive (if not already)

**Files:**
- Create or modify: `src/components/shared/runInteractiveCliFlow.ts` (or `.tsx` if it has React)

The Phase 3 `CodexAuthService.startLoginFlow` already wraps the OneShotTerminal pattern. This task verifies the wrapper exists as a reusable primitive (or extracts it if Phase 3 inlined it).

- [ ] **Step 1: Inspect current shape**

Look at how `CodexAuthService.startLoginFlow()` currently dispatches the pty. If it's already a clean primitive `runInteractiveCliFlow({ binary, args, env, watchPath, detectSuccess })`, skip to Task 2.

If it's inlined inside `CodexAuthService`, extract it now:

`runInteractiveCliFlow(params: { binary: string; args: string[]; env: Record<string, string>; cwd?: string; watchPath: string; detectSuccess: (filePath: string) => Promise<boolean>; })` returns `{ ptyHandle, onSuccess, onCancel }`.

- [ ] **Step 2: Update CodexAuthService to use the primitive**

Refactor `startLoginFlow` to call `runInteractiveCliFlow(...)` with Codex-specific params.

- [ ] **Step 3: Test**

Existing Codex auth tests must still pass with the refactor.

- [ ] **Step 4: Commit**

`git commit -m "refactor(auth): extract runInteractiveCliFlow shared primitive"`

---

## Task 2: `ClaudeAuthService` — credential status detection

**Files:**
- Create: `electron/services/auth/claude-auth.ts`
- Create: `electron/__tests__/auth/claude-auth.test.ts`

- [ ] **Step 1: Failing tests**

`ClaudeAuthService` exposes:
- `getStatus(accountId: string): Promise<{ stale: boolean; reason?: string }>`.
- `watch(accountId: string, cb: (status) => void): Disposable`.
- `reauthenticate(accountId: string): Promise<{ ptyHandle: string }>`.
- `markStale(accountId: string, reason: string): void` — for reactive marking from session-error detection.

Tests:
1. **getStatus returns `stale: true` when `.credentials.json` is missing.** Construct a temp configDir without the file. Call `getStatus(accountId)`. Assert `stale: true`, reason mentions "missing".
2. **getStatus returns `stale: false` when the file is present and parses.** Drop a minimal valid `.credentials.json`. Assert `stale: false`.
3. **getStatus returns `stale: true` when file is present but JSON-malformed.** Drop garbage. Assert `stale: true`, reason mentions "malformed".
4. **watch() fires when the file appears/disappears.** Construct watcher, delete the file, assert watcher fires with `stale: true`. Re-create, assert `stale: false`.
5. **markStale records the reason; subsequent getStatus returns it.** Call `markStale('a1', 'session-init failed: invalid token')`. Assert `getStatus('a1')` returns `stale: true` with the recorded reason. Watcher fires.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement**

`createClaudeAuthService(deps: { accountsService })`:

- Closure state: `manualStale: Map<accountId, reason>` — set by `markStale`, cleared on next successful auth.
- `getStatus(accountId)`:
  - If `manualStale.has(accountId)`, return `{ stale: true, reason: manualStale.get(accountId) }`.
  - Look up account → `configDir`. Read `<configDir>/.credentials.json`:
    - File missing → `{ stale: true, reason: '.credentials.json missing' }`.
    - Parse fails → `{ stale: true, reason: 'malformed credentials' }`.
    - Parses → `{ stale: false }`.
- `watch(accountId, cb)`: `fs.watch` on `<configDir>/.credentials.json` (or its parent dir; macOS `fs.watch` is happier watching directories). Debounce 250ms. On fire, call `getStatus(accountId)` and pass to cb.
- `markStale(accountId, reason)`: store in `manualStale`. Fire any active watchers for that account.
- `clearStale(accountId)`: remove from `manualStale` (called after a successful reauth).

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(auth): ClaudeAuthService status detection + watcher"`

---

## Task 3: `reauthenticate(accountId)` — pty login flow

**Files:**
- Modify: `electron/services/auth/claude-auth.ts`
- Modify: `electron/__tests__/auth/claude-auth.test.ts`

- [ ] **Step 1: Failing test**

`reauthenticate(accountId)` spawns `claude /login` via `runInteractiveCliFlow` with the correct `CLAUDE_CONFIG_DIR`:
1. Mock `runInteractiveCliFlow`.
2. Call `service.reauthenticate('a1')` where account a1 has `configDir: '/conf/a1'`.
3. Assert mock called with: `binary: 'claude'`, `args: ['/login']`, `env.CLAUDE_CONFIG_DIR === '/conf/a1'`, `watchPath: '/conf/a1/.credentials.json'`, `detectSuccess` parses the file and returns true on valid credentials.
4. After the mock's `onSuccess` fires, assert `manualStale` for `'a1'` is cleared.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement**

```
async reauthenticate(accountId) {
  const account = accountsService.get(accountId);
  if (!account) throw new Error(`reauthenticate: unknown account ${accountId}`);
  const credsPath = path.join(account.configDir, '.credentials.json');

  const handle = await runInteractiveCliFlow({
    binary: 'claude',
    args: ['/login'],
    env: { ...process.env, CLAUDE_CONFIG_DIR: account.configDir },
    cwd: process.env.HOME,
    watchPath: credsPath,
    detectSuccess: async (p) => {
      try {
        const data = await fs.readFile(p, 'utf8');
        JSON.parse(data);
        return true;
      } catch { return false; }
    },
  });

  handle.onSuccess(() => {
    manualStale.delete(accountId);
    fireWatchers(accountId);
  });

  return { ptyHandle: handle.id };
}
```

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(auth): ClaudeAuthService.reauthenticate via pty login flow"`

---

## Task 4: Reactive stale-detection — sessions service marks accounts stale on credentials-error

**Files:**
- Modify: `electron/services/sessions/runtime.ts` (or wherever engine errors surface to sessions)
- Modify: `electron/services/sessions/lifecycle.ts`
- Modify: `electron/__tests__/sessions.test.ts`

- [ ] **Step 1: Identify the error shape**

When `claude` returns a credentials error, the engine surfaces it via `onError(Error)`. The Error message contains substrings like:
- `"not authenticated"`
- `"credentials expired"`
- `"401 unauthorized"`
- (anything else the CLI prints on auth failure — confirm by running `claude` against an empty config dir and capturing stderr)

Build a small predicate: `function isCredentialsError(err: Error): boolean` checking the message against a small case-insensitive list.

- [ ] **Step 2: Failing test**

In `sessions.test.ts`: start a session, simulate the engine emitting an `onError` with message `"Error: not authenticated"`. Assert: `claudeAuthService.markStale(accountId, ...)` was called. Assert: a `session-credentials-stale:<tabId>` event was emitted to the renderer.

- [ ] **Step 3: Implement**

In `runtime.ts`'s `engine.onError` subscriber:

```
if (isCredentialsError(err)) {
  claudeAuthService.markStale(handle.accountId, err.message);
  sendToRenderer(`session-credentials-stale:${tabId}`, { accountId: handle.accountId, reason: err.message });
}
```

Inject `claudeAuthService` into sessions service deps; thread through `createSessionsService(...)` constructor.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(sessions): mark accounts stale on credentials-error and notify renderer"`

---

## Task 5: Wire IPC channels

**Files:**
- Modify: `electron/preload.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/main.ts`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add channels**

In preload allow-list:
- Invoke: `claude_auth_status`, `claude_auth_reauthenticate`.
- Event prefixes: `claude-auth-status-changed`, `session-credentials-stale:`.

- [ ] **Step 2: Handlers**

`claude_auth_status` → `claudeAuthService.getStatus(accountId)`.
`claude_auth_reauthenticate` → `claudeAuthService.reauthenticate(accountId)`.

Set up the watcher subscription in main: for each known account, subscribe `claudeAuthService.watch(accountId, ...)` and forward to renderer as `claude-auth-status-changed`. Use the existing per-account-row subscription pattern.

- [ ] **Step 3: api.ts wrappers**

`getClaudeAuthStatus(accountId)`, `reauthenticateClaudeAccount(accountId)`.

- [ ] **Step 4: Verify**

`npm run check && npm test`.

- [ ] **Step 5: Commit**

`git commit -m "feat(ipc): wire Claude auth status + reauthenticate channels"`

---

## Task 6: AccountSettings — stale state + "Re-authenticate" button

**Files:**
- Modify: `src/components/AccountSettings.tsx`
- Modify: `src/components/AccountSettings.test.tsx` (if present)

- [ ] **Step 1: Subscribe to status**

In the account row component, on mount: call `api.getClaudeAuthStatus(account.id)` and store in state. Subscribe to `claude-auth-status-changed` for live updates.

- [ ] **Step 2: Render stale UI**

If `status.stale === true`:
- Show a warning icon next to the account name.
- Show a small "Re-authenticate" button.
- Show the stale reason as a tooltip on the icon.

On button click: call `api.reauthenticateClaudeAccount(account.id)`. Open `OneShotTerminal` modal hosting the returned `ptyHandle`. When the modal auto-closes (auth succeeded), refresh the status.

- [ ] **Step 3: Tests**

Render with `stale: true` and `stale: false` states. Assert button visibility + correct status. Trigger click, assert the reauth API was called.

- [ ] **Step 4: Commit**

`git commit -m "feat(ui): AccountSettings shows re-auth chip for stale Claude accounts"`

---

## Task 7: SessionHeader chip — stale state indicator

**Files:**
- Modify: `src/components/SessionHeader.tsx`

- [ ] **Step 1: Show a stale dot on the account chip**

When the current tab's account `status.stale === true`, render a small red dot on the account chip (corner badge). Hover tooltip: "This account needs to re-authenticate."

Click on the chip opens the same re-auth modal as AccountSettings.

- [ ] **Step 2: Test**

Render header with stale and fresh status; assert dot visibility.

- [ ] **Step 3: Commit**

`git commit -m "feat(ui): SessionHeader account chip shows stale-credential dot"`

---

## Task 8: In-session ReauthBanner

**Files:**
- Create: `src/components/claude/ReauthBanner.tsx`
- Modify: `src/components/AgentSession.tsx`

- [ ] **Step 1: ReauthBanner component**

`<ReauthBanner accountId={...} onResolved={...} />`:
- Renders an info banner: "This session can't authenticate. Re-authenticate to continue."
- Inline "Re-authenticate" button. Click opens the same flow as AccountSettings.
- When `claude-auth-status-changed` reports `stale: false`, call `onResolved()`.

- [ ] **Step 2: Wire into AgentSession**

Subscribe to `session-credentials-stale:<tabId>`. When fired, set local state `credentialsStale: true`. Render `<ReauthBanner accountId={...} onResolved={() => setCredentialsStale(false)} />` above the composer.

- [ ] **Step 3: Tests**

Renderer test: fire the stale event, assert banner mounts. Fire the resolved event, assert banner unmounts.

- [ ] **Step 4: Commit**

`git commit -m "feat(ui): in-session ReauthBanner triggered on credentials-error"`

---

## Task 9: Verification gate

**Files:** none — runs commands.

- [ ] **Step 1: Full typecheck + build + tests + coverage**

`npm run check && npm run build && npm run test:coverage` → all green. New `electron/services/auth/claude-auth.ts` ≥80% line coverage.

- [ ] **Step 2: Manual smoke — recovery flow**

A safe way to test without breaking your live account: pick an account, move its `.credentials.json` aside (`mv ~/.claude-local/.credentials.json ~/.claude-local/.credentials.json.bak`), start the app.

Checklist:
1. AccountSettings: the affected account shows a warning icon + "Re-authenticate" button. Hover tooltip shows the reason.
2. Click "Re-authenticate". The OneShotTerminal modal opens, running `claude /login` against that account's configDir.
3. Complete the OAuth dance. Modal auto-closes. AccountSettings refreshes: warning gone.
4. Start a session under that account. Should work normally.
5. Restore the moved file (`mv ...bak ...`) for cleanup.

Second smoke — reactive detection:
1. Pick an account. Edit its `.credentials.json` to be syntactically valid but with an invalid token (e.g., truncate the access token).
2. Start a session under that account. The session fails to start; an in-session ReauthBanner appears.
3. Click "Re-authenticate" in the banner; the same modal opens. Complete OAuth.
4. The banner disappears; the session can be started.

- [ ] **Step 3: Rebuild Electron ABI**

`npm run rebuild:electron`.

- [ ] **Step 4: No commit** — verification only.

---

## Task 10: CHANGELOG + version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Bump version**

Patch bump.

- [ ] **Step 2: Add CHANGELOG entry**

```
## [<new-version>] — YYYY-MM-DD

### Added

- **Claude account re-authentication recovery** (`<commit>`). When a Claude account's credentials go stale (file missing/malformed, OAuth refresh failed, or a session fails to start with an auth error), OmniFex now surfaces:
  - A "Re-authenticate" button on the account row in AccountSettings.
  - A red dot on the account chip in the SessionHeader.
  - An in-session ReauthBanner above the composer.
  Clicking any of these opens an embedded xterm that runs `claude /login` against that specific account's `CLAUDE_CONFIG_DIR`. The modal auto-closes when credentials refresh, and the UI updates live via filesystem watch.

### Internal

- New `ClaudeAuthService` (mirrors `CodexAuthService` from Phase 3). Reuses the `runInteractiveCliFlow` shared primitive.
- Sessions service grew an `onCredentialsError` hook that marks the account stale and emits `session-credentials-stale:<tabId>` to the renderer.

### Notes

- Phase 4 of the SDK→CLI engine + Codex support plan. See `docs/superpowers/specs/2026-05-25-cli-engine-and-codex-design.md`. This completes the plan.
- The existing add-account UX is unchanged. This is purely a recovery flow for accounts that already exist in OmniFex.
```

Replace `<commit>` with short SHAs.

- [ ] **Step 3: Commit + release**

`git commit -am "chore: bump version to <new-version>"`

Run `/omnifex-release`.

---

## Self-review

- **Spec coverage:** Phase 4 of the spec (§7 "Claude re-auth recovery") fully covered.
- **No add-account changes:** Tasks 6–8 only add affordances to existing accounts; the add-account dialog is untouched.
- **Detection completeness:** Two signals — lazy (file missing/malformed at start + on row mount) and reactive (session start error). Catches the realistic failure modes.
- **UX surfaces:** Three entry points (AccountSettings, header chip, in-session banner). All open the same modal, so the flow is consistent.
- **Reuse:** `OneShotTerminal` + `runInteractiveCliFlow` reused from Phase 3. No new primitive built; isolated changes.

---

## Follow-up

- None. This completes the SDK→CLI engine + Codex support plan. Post-v1 ideas (Codex multi-account, richer settings editor, deeper usage analytics) are tracked separately and don't depend on this work.

---

**End of plan.**
