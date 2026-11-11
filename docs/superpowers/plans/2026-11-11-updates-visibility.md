# Updates Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface new Claude Code and OmniFex releases without Greg having to look: an hourly
background check, a one-per-version macOS notification for Claude Code, a green Updates icon,
an "unreviewed" icon, and an auto-downloaded OmniFex update installed from inside the popover.

**Architecture:** The poll is a renderer interval in `CustomTitlebar`. The OmniFex updater is
renderer-driven through native `updater:*` channels, so a daemon poll could not reach it. The
Claude Code check reuses `claude_cli_review_status`. Dedupe lives in the daemon: a new
`claude_cli_claim_update_notice` channel does a read-compare-write on an `app_settings` key and
returns `true` exactly once per version. The renderer claims and raises the notification only
on a Mac host (`window.__omnifexNative`). With no window open nothing claims, and the launch
check delivers it later: that is the "hold". Clicking the notification opens the popover. That
needs the Swift notifier to carry the notification `id` through to `notification-clicked`.

**Tech Stack:** React 19 + Vitest/RTL (jsdom), Node daemon (TypeScript), Swift 6 (AppKit).

**Spec:** `docs/superpowers/specs/2026-11-11-updates-visibility-design.md`

## Global Constraints

- One notification per Claude Code version, ever. Persisted key: `claude_cli_notified_version`.
- Notify only when `upgrade_available && latest_version` (never on an unknown registry answer).
- Notification id: `claude-cli-update:<version>`. Title `Claude Code <version> is available`,
  body `Open Updates to install it.`
- Background interval: 60 minutes (`BACKGROUND_CHECK_MS = 60 * 60 * 1000`).
- Update-available signal: the `CircleFadingArrowUp` icon gets `text-emerald-500`. Nothing else
  on the button changes. The amber dot `data-updates-indicator` is deleted.
- Unreviewed signal: a `ScanSearch` icon (`data-updates-unreviewed`) on the button, with title
  `Claude Code <installed> not yet reviewed`.
- No OmniFex notification. No auto-install of anything. The review flow is unchanged.
- Dev renderer (`import.meta.env.DEV`) never auto-downloads OmniFex releases.

## Review Focus

1. **A background check while an OmniFex download is ready or installing** must not reset
   `updateState` to `checking`/`available` and lose the downloaded file. Test in Task 4.
2. **Repeat notifications**: a second check, a second window, or a relaunch for the same version
   must not notify again. The daemon claim test is in Task 1, the renderer test in Task 3.
3. **An unknown registry answer** (`latest_version: null`) gives no notification and no green icon.
   Tests in Tasks 3 and 4.
4. **A web (iPad) client** never claims, so a Mac launch later still gets the notification. Test in
   Task 3: no native host → no claim call.
5. **Install while sessions are active** still goes through Waiting / Install anyway / Cancel,
   now inside the popover. Port the existing `installCancel` tests in Task 4.

---

### Task 1: Daemon claim channel

**Files:**
- Create: `electron/services/cli-update-notice.ts`
- Modify: `electron/ipc/handlers.ts` (near `claude_cli_update`), `electron/ipc/channels.ts`
  (after `claude_cli_update`), `src/lib/api.ts` (beside `updateClaudeCli`)
- Test: `electron/__tests__/cli-update-notice.test.ts`

**Interfaces:**
- Produces: `claimCliUpdateNotice(store: { getSetting(k): string|null; saveSetting(k, v): void }, version: string): boolean`,
  `CLI_NOTIFIED_VERSION_SETTING_KEY = 'claude_cli_notified_version'`; channel
  `claude_cli_claim_update_notice` `{ version }` → `boolean`; `api.claimCliUpdateNotice(version): Promise<boolean>`.

- [ ] Test: first claim of `2.1.323` returns true and stores it; second returns false; `2.1.322` after
      that returns false (older); `2.1.324` returns true; unparseable version returns false and stores nothing.
- [ ] Run, see it fail. Implement with `parseCliVersion` / `compareCliVersions` from `claude-cli-review.ts`.
      Handler: `wrapWith((p) => database ? claimCliUpdateNotice(database, String(p?.version ?? '')) : false)`.
- [ ] `npx vitest run electron/__tests__/cli-update-notice.test.ts electron/__tests__/ipc-channel-contract.test.ts` passes.

### Task 2: Notification id reaches `notification-clicked`

**Files:** Modify `macos/Sources/OmniFex/Notifier.swift`, `macos/Sources/OmniFex/AppServices.swift`

- [ ] `show`: build `userInfo` with `tabId` and `id` when present. `onClick: ((String?, String?) -> Void)?`
      passes `(tabId, id)`. `didReceive` reads both.
- [ ] `AppServices`: broadcast `["tabId": …, "id": id ?? NSNull()]`.
- [ ] `npm run test:swift` passes (it compiles the OmniFex target).

### Task 3: Notify on detection, open popover on click, hourly background check

**Files:** Modify `src/components/CustomTitlebar.tsx`, `src/lib/api.ts`
**Test:** `src/components/__tests__/CustomTitlebar.updateNotice.test.tsx`

**Interfaces:**
- Produces: `api.notifyClaudeCliRelease(version: string): Promise<boolean>`. Returns false with no
  native host. Otherwise it claims, and on true invokes `notify:show` with the copy/id above and
  `tabId: null`.

- [ ] Tests (mock `api.notifyClaudeCliRelease`, `window.electronAPI.onEvent`):
  - launch status `{upgrade_available:true, latest_version:'2.1.323'}` → called once with `'2.1.323'`;
  - opening the popover again doesn't call it again in this session (only on a version change);
  - `latest_version: null` → not called;
  - after `vi.advanceTimersByTime(60*60*1000)` `getClaudeCliReviewStatus` is called again without the
    popover opening, and the trigger icon doesn't get `animate-spin` (a quiet check);
  - `notification-clicked` with `{ id: 'claude-cli-update:2.1.323' }` opens the popover
    (the popover content is present); a click event with another id doesn't.
- [ ] Implement: a `notifiedRef` keyed by version gates the call; an effect on `cliReview` calls it;
      `setInterval` runs a quiet check (no `withMinSpin`); an `onEvent('notification-clicked')`
      listener calls `setUpdatesOpen(true)` (not `handleUpdatesOpenChange`, because the background
      check already ran).

### Task 4: Button signals, OmniFex auto-download, install in popover, remove pill and check button

**Files:** Modify `src/components/CustomTitlebar.tsx`
**Tests:** update `CustomTitlebar.cliReview.test.tsx`, `CustomTitlebar.cliUpdate.test.tsx`,
`CustomTitlebar.installCancel.test.tsx`, `CustomTitlebar.compact.test.tsx` to the new markup;
add `CustomTitlebar.appUpdate.test.tsx`.

- [ ] Tests:
  - icon has `text-emerald-500` when the CLI `upgrade_available` with a known latest, or the app check
    returns available; not when `latest_version: null`; `[data-updates-indicator]` never exists;
  - `[data-updates-unreviewed]` present iff `unreviewed`;
  - app check available → `downloadUpdate` called without a click; the popover row
    `[data-app-update-row]` reads `OmniFex 0.4.152 → 0.4.153 ready`; `[data-app-update-install]`
    calls `installUpdate`;
  - a `ready` state survives a later background check (`downloadUpdate` called once, install button still there);
  - a download rejection shows `[data-app-update-retry]`; clicking it re-downloads;
  - an install-status `waiting` event shows Waiting / `Install anyway` / `Cancel` inside the popover (ported);
  - `[data-updates-check]` no longer exists; no titlebar pill outside the popover.
- [ ] Implement:
  - `checkForUpdate` returns early unless the status is `idle | up-to-date | available | error(download)`;
  - on available (and `!import.meta.env.DEV`) start the download;
  - delete the pill block and its `up-to-date` auto-dismiss (the `up-to-date` status goes too);
  - delete the footer button;
  - add the OmniFex row's install/progress/waiting/error controls, styled like `data-cli-update-run`;
  - delete what the pill removal leaves unused: the `Download` import and `TooltipSimple` if unused.

### Task 5: Verify and commit

- [ ] `bash .claude/skills/verify/scripts/verify.sh` (check, build, test, swift). All pass.
- [ ] Commit on `feat/updates-visibility`.
