# Auto-Install Update Flow — Design

**Date:** 2026-04-25
**Status:** Approved (pending implementation plan)
**Owner:** Greg Christie

## Problem

GreyChrist's local-folder updater detects newer DMGs and shows a titlebar badge, but installing requires the user to mount the DMG and drag `GreyChrist.app` to `/Applications` themselves. The release flow already produces a ZIP next to every DMG, so the manual drag is the only gap between "update detected" and "running new build."

## Goal

After clicking the titlebar update badge, the user gets a single "Install vX.Y.Z?" prompt; on confirm the app waits for in-flight work to finish, swaps `GreyChrist.app` in place, and relaunches itself. No DMG mount, no Finder, no `xattr` dance.

Out of scope: code signing / notarization, background pre-download (file is already local), update-on-quit / staged install, automatic rollback.

## Overview

Three pieces:

1. **Updater scans for ZIPs instead of DMGs.** The local-folder updater (`electron/services/updater.ts`) keeps its existing shape — `checkForUpdate()` + `downloadUpdate()` — but its filename regex switches from `GreyChrist-X.Y.Z-arm64.dmg` to `GreyChrist-darwin-arm64-X.Y.Z.zip`. `UpdateInfo.downloadUrl` becomes the absolute path to the ZIP. The existing `updater:open` IPC stays as a Finder fallback for the error path.

2. **New `installer.ts` service.** Handles the four-step install pipeline: stage → resolve target → wait for idle → execute. Fail-loud before quit; fail-soft after.

3. **Renderer titlebar gains two new `UpdateState` variants** (`'waiting'`, `'installing'`) and a confirm step on the existing `'ready'` state. No new modal — everything happens inline in the existing badge.

## Architecture

### Install pipeline

```
[user clicks "Install vX"]
  → updater:install { zipPath, version, force?: boolean }
    → installer.stage(zipPath, version)        [validate ZIP, extract to tmp]
    → installer.resolveTargetApp()             [find writable .app to replace]
    → installer.waitForIdle({ force })         [NEW: gate on sessions + agent runs]
    → installer.executeInstall(staged, target)
      → write helper script, spawn detached, app.quit()
[helper runs after parent exits]
  → wait kill -0 parentPid; rm targetApp; ditto staged → target; open target
```

### `installer.ts` interface

```ts
interface InstallerService {
  /** Extract ZIP to tmp, validate `.app` bundle exists with expected version. */
  stage(zipPath: string, expectedVersion: string): Promise<{ stagedAppPath: string }>;

  /** Walk up from process.execPath to the running .app bundle.
   *  Throws if not running from a .app (dev) or parent dir not writable. */
  resolveTargetApp(): { targetAppPath: string };

  /** Poll active sessions + agent runs until both are zero, or force-stop them.
   *  Emits 'updater:install-status' on every poll:
   *    - { phase: 'waiting', activeSessions, activeAgentRuns } while counts > 0
   *    - { phase: 'installing' } once on resolve, before this method returns
   *  Cancellable via cancelWait(). */
  waitForIdle(opts: { force: boolean }): Promise<void>;

  /** Cancel an in-flight waitForIdle() (renderer hit "Cancel"). */
  cancelWait(): void;

  /** Write helper script, spawn detached, call app.quit(). Never returns
   *  on success — process exits. */
  executeInstall(stagedAppPath: string, targetAppPath: string): Promise<void>;
}
```

### Helper script template

Written to `os.tmpdir()/greychrist-installer-<ts>.sh`, `chmod +x`, spawned with `spawn(... { detached: true, stdio: 'ignore' })`:

```sh
#!/bin/sh
PARENT_PID=$1
TARGET_APP=$2
STAGED_APP=$3
SELF=$0

while kill -0 "$PARENT_PID" 2>/dev/null; do sleep 0.2; done

rm -rf "$TARGET_APP" || exit 1
ditto "$STAGED_APP" "$TARGET_APP" || exit 1
open "$TARGET_APP"

rm -rf "$STAGED_APP"
rm -f "$SELF"
```

`ditto` is preferred over `cp -R` because it preserves `.app` bundle metadata (resource forks, extended attributes) that `cp` can corrupt on macOS. `open` relaunches via Launch Services with the new bundle's bundle ID.

### Wait gate

`waitForIdle()` polls every 1000 ms:

- `sessionsService.listActiveTabIds()` returns tab IDs whose internal session handle is still in `'starting' | 'running' | 'waiting_permission'` state.
- `agentRunRegistry.listActiveRunIds()` returns run IDs that haven't reached a terminal status.
- If `force === true` on entry, calls `sessionsService.stopAll()` and `agentRunRegistry.stopAll()` once, then proceeds normally (the next poll should see zero).
- While both counts are > 0, emits `{ phase: 'waiting', activeSessions, activeAgentRuns }` to the renderer on every poll.
- When both counts hit zero, emits `{ phase: 'installing' }` once and resolves. The renderer flips its UI based on the phase, not the counts.
- Renderer can call `cancelInstall()` IPC to invoke `cancelWait()`, which rejects the wait promise with a `WaitCancelled` error; the install handler catches and returns the renderer to `'ready'` state.

### Renderer state machine

Existing states (in `CustomTitlebar.tsx`):
```
idle → checking → up-to-date | available
available → downloading → ready | error
```

New states:
```
ready → installing                          [click "Install"]
installing → waiting | <quit>               [if active work, gate; otherwise proceed]
waiting → installing                        [counts hit zero, or "Install anyway" forced]
waiting → ready                             [user clicked "Cancel"]
installing → error                          [stage / resolveTarget / executeInstall failed]
```

The `'waiting'` state stores `{ activeSessions: number, activeAgentRuns: number }` so the badge can render `"Waiting for sessions… (2 active)"` with **Install anyway** + **Cancel** buttons.

The `'installing'` state shows a non-cancellable spinner — by this point the helper script is staged and `app.quit()` is imminent.

## Data flow

```
[renderer]                              [main]
  │                                       │
  │── updater:install { zip, ver } ─────▶│
  │                                       │── installer.stage()
  │                                       │── installer.resolveTargetApp()
  │                                       │── installer.waitForIdle()
  │◀───── updater:install-status ────────│   (every 1s while waiting)
  │       { phase, sessions, agents }     │
  │                                       │
  │── updater:install-cancel ───────────▶│── installer.cancelWait()
  │◀───── (rejection) ────────────────────│
  │                                       │
  │  OR (counts hit zero or force)        │
  │                                       │── installer.executeInstall()
  │                                       │── app.quit()
  │◀════════════ process exits ══════════│
                                          │
                                          ▼
                              [helper script runs]
                              waits, swaps, relaunches
```

## Error handling

**Pre-quit (recoverable, surfaces to renderer as `'error'`):**

- ZIP missing / unreadable → "Update file not found"
- ZIP doesn't contain `GreyChrist.app/Contents/MacOS/GreyChrist` → "Update package is invalid"
- Extracted bundle's `Info.plist` `CFBundleShortVersionString` ≠ expected version → "Update version mismatch"
- `process.execPath` not under a `.app` (dev mode) → "Cannot auto-install in development"
- Target `.app` parent dir not writable → "Cannot write to /Applications — install manually" + Open-in-Finder fallback button
- Wait cancelled by user → silently return to `'ready'`

All pre-quit errors include a "Open in Finder" action that calls the existing `updater:open` to drop the user into the manual flow.

**Post-quit (helper script failures):**

The app is already gone, so there's no UI to show. Failure modes:

- Helper can't `rm -rf` the old `.app` (permission denied) → old app stays; `open` at the bottom of the script still relaunches it. User sees old version come back; can retry.
- `ditto` partially copies, then fails → broken `.app`. User opens GreyChrist from Spotlight → macOS reports it as damaged. User has to reinstall manually from the DMG. Acceptable: rare, and the ZIP/DMG are still on disk in `local_update_dir` for manual recovery.
- Helper exits before `open` runs → user opens GreyChrist from Dock/Spotlight manually. New version is in place; no harm done.

No automatic rollback — the failure space is small enough that detection logic would cost more than it saves.

## Testing

### Unit tests (`electron/__tests__/installer.test.ts`)

- `stage()`:
  - Valid ZIP fixture → returns `stagedAppPath`, fixture exists on disk after.
  - Missing ZIP → throws `UpdateFileNotFound`.
  - ZIP without `.app` inside → throws `InvalidUpdatePackage`.
  - ZIP with version-mismatched `Info.plist` → throws `VersionMismatch`.
- `resolveTargetApp()`:
  - Mock `process.execPath` under a `.app` whose parent is writable → returns target path.
  - Mock `process.execPath` not under a `.app` → throws `NotPackaged`.
  - Mock parent dir non-writable → throws `TargetNotWritable`.
- `waitForIdle()`:
  - Mock services returning shrinking active lists → resolves when both reach zero, emits one status event per poll.
  - `force: true` → calls `stopAll()` on both services exactly once, then resolves on next poll showing zero.
  - `cancelWait()` mid-flight → promise rejects with `WaitCancelled`, no further polls.
- `executeInstall()`:
  - Mock `child_process.spawn` and `app.quit` → verify helper script written to expected location with expected content (PARENT_PID, TARGET_APP, STAGED_APP substitutions correct), spawn called with `detached: true` and `stdio: 'ignore'`, `app.quit()` called after spawn.

### Updater test changes

- `electron/__tests__/updater.test.ts` fixtures change `.dmg` → `.zip` filenames; behavior assertions unchanged.

### Manual verification (cannot be unit-tested)

- Real install on Greg's machine: drop a v0.3.49 ZIP into `local_update_dir`, click Install, confirm app relaunches at v0.3.49.
- "Install anyway" with an active session: confirm session-stopped event fires before quit.

## Files to add / modify

| File | Change |
|---|---|
| `electron/services/installer.ts` | **NEW** — `InstallerService` factory with `stage`, `resolveTargetApp`, `waitForIdle`, `cancelWait`, `executeInstall` |
| `electron/__tests__/installer.test.ts` | **NEW** — covers all four pipeline steps |
| `electron/services/updater.ts` | Replace `DMG_RE` with `ZIP_RE`; update doc comments |
| `electron/__tests__/updater.test.ts` | Update fixture filenames `.dmg` → `.zip` |
| `electron/services/sessions/lifecycle.ts` + `types.ts` | Add `listActiveTabIds(): string[]` to `SessionsService` |
| `electron/services/agent-run-registry.ts` | Add `listActiveRunIds(): string[]` and `stopAll(): void` if not already present |
| `electron/main.ts` | Construct `installerService` with sessions + agent-run-registry deps; wire `updater:install` + `updater:install-cancel` handlers; emit `updater:install-status` |
| `electron/ipc/handlers.ts` | Register `updater:install` and `updater:install-cancel` in handler interface |
| `electron/preload.ts` | Allow-list `updater:install`, `updater:install-cancel`; allow-list `updater:install-status` event prefix |
| `src/lib/api.ts` | `installUpdate(zipPath, version, opts?: { force?: boolean })`, `cancelInstall()`, `onInstallStatus(cb)` |
| `src/components/CustomTitlebar.tsx` | Add `'waiting'` and `'installing'` states; render live counts + "Install anyway" + "Cancel" buttons; swap `openUpdate` for `installUpdate` on success path; keep `openUpdate` as the error-state fallback |
| `CHANGELOG.md` | Entry for the new feature on next release |

## Open questions / risks

- **Empty `local_update_dir` in packaged builds.** Default behavior unchanged: feature is dormant until Greg sets the path in Settings.
- **Hung session that never finishes.** Mitigated by "Install anyway" override; wait gate doesn't have a hard timeout because that would surprise the user.
- **Agent-run-registry surface.** If the registry doesn't already expose enumeration / stopAll, the implementation plan adds them. Verified during plan-writing rather than bloating this spec.
- **Non-arm64 builds.** Filename pattern `GreyChrist-darwin-arm64-X.Y.Z.zip` is arm64-only. If x86_64 builds are ever produced, regex needs widening — out of scope for this design.
