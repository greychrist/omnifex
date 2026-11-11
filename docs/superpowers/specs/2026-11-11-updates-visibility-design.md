# Updates visibility — design

2026-11-11. Status: draft for Greg's approval.

## Why

A Claude Code release landed and Greg didn't notice it until he happened to
see the small amber dot on the titlebar's Updates button. A new Claude Code
release matters more to him than to an ordinary user: it is his cue to review
what changed in the CLI and what OmniFex needs to do about it (the existing
"Review it →" flow). Today nothing tells him one is out:

- Checks run only at app launch and when the Updates popover opens
  (`CustomTitlebar.tsx`, `checkEverything`). Nothing polls, so a release
  published while the app is open stays invisible.
- The amber dot means three things at once (OmniFex update, Claude Code
  update, Claude Code unreviewed) and it is easy to miss.
- An OmniFex update is a separate titlebar pill outside the popover, with two
  clicks: download, then install.
- The popover's "Check for update" button is redundant. Opening the popover
  already runs the same check.

Success: Greg finds out about a new Claude Code release within about an hour
of it being published, without looking for it, and installing either update
takes one click inside the popover.

## Goals

1. **A background check** for new Claude Code and OmniFex releases while the
   app runs.
2. **A macOS notification when a new Claude Code version is first seen.**
3. **The Updates button's icon turns green** when an update is available
   for either one. That replaces the amber dot.
4. **An icon on the Updates button** when the installed Claude Code hasn't
   been reviewed (`cliReview.unreviewed`).
5. **OmniFex updates download automatically**, and installing is one button
   inside the popover.
6. **Remove the "Check for update" button.**

## Non-goals

- Auto-installing Claude Code. Greg reads what changed, then clicks
  "Update to X" himself, as today.
- A notification for OmniFex releases. Greg said no.
- Changing the review flow. The review still happens *after* the CLI is
  installed. "Review it →" and "Mark X as checked" keep their current trigger
  (`unreviewed`, meaning the installed binary is ahead of the checked
  watermark) and their current behavior.
- Showing changelog text in the popover.

## Anti-goals

- **A notification that repeats.** One notification per Claude Code version,
  ever: not on every launch, not on every check, and not once from each
  window or client.
- **A notification or color for an unknown answer.** An unreachable registry
  is "unknown", never "update available". That is the rule
  `fetchLatestCliVersion` / `latest_version` already follow.
- **Losing the active-session safety on OmniFex installs.** Installing while
  sessions are mid-turn must still wait, or offer "Install anyway" / "Cancel".

## Decided (by Greg)

- **One color for both update types: green, on the icon only.** The
  `CircleFadingArrowUp` icon turns green. The button's background and
  label don't change. The button doesn't say which update it is; the
  popover rows do.
- **The "unreviewed" state gets its own icon on the button**, separate from
  the color. It is a different kind of thing: work to do, not an upgrade to
  take.
- **Claude Code notification: yes. OmniFex notification: no.**
- **OmniFex auto-downloads.** The separate titlebar pill goes away. The
  install control lives in the popover like "Update to X →" does.
- **"Check for update" goes away.**

## Behavior

### Background check
- Polls the Claude Code latest version (`fetchLatestCliVersion`) and the
  OmniFex latest release on an interval. *My call: hourly*, plus the existing
  check at launch and on popover open.
- The result reaches the renderer the way the popover's check does today, so
  the button's color is right without opening the popover.

### Claude Code notification
- Fires when `latest_version` is newer than the installed version **and**
  newer than the last version we notified about. The last-notified version is
  persisted, so a restart doesn't repeat it.
- Text: *my call:* "Claude Code 2.1.323 is available", body
  "Open Updates to install it."
- Clicking it brings the window forward and opens the Updates popover.
- Uses the existing OS notification path (`notify:show` /
  `notification-clicked`) with its existing delivery rules, unchanged.
  When the window is focused that means sound only, no banner. Greg
  decided the chime plus the green icon is enough. No Swift delivery
  change.
- **No Mac window open** (the daemon is running headless): hold the
  notification and deliver it when a Mac client next connects (Greg's
  call). The version counts as notified only once it is handed to a Mac
  client, not when it is detected. No Web Push.

### Updates button
- **Update available** (OmniFex `available`/`ready`, or
  `cliReview.upgrade_available` with a known `latest_version`): the icon
  turns green (`text-emerald-500`, or the green token the titlebar
  already uses). Nothing else on the button changes.
- **Unreviewed:** a small icon on the button (*my call:* a lucide icon such as
  `ScanSearch` or `FileWarning`, with a tooltip "Claude Code X not yet
  reviewed"). Shown together with the color if both apply.
- While a check is running the icon spins as today. Color and icon are
  suppressed mid-check only if they would otherwise flicker. The builder
  decides.
- The amber dot (`data-updates-indicator`) is deleted.

### OmniFex update flow
- When the check finds a release, it downloads immediately. No click.
- Popover OmniFex row: `OmniFex 0.5.33 → 0.5.34 ready`, plus an **Install
  0.5.34** button styled like "Update to X →".
- While it downloads, the row shows progress, and the button counts as
  "available" for color purposes.
- If sessions are active, the button shows the warning styling as today. On
  click it enters the existing wait-for-idle gate, rendered inside the
  popover: "Waiting for N sessions…", **Install anyway**, **Cancel**.
- A download failure retries on the next check. A persistent error (*my call:*
  shown after a failed attempt, with a Retry button) appears in the row.
- The titlebar pill (`updateState` pill block before the icon group) is
  deleted, along with its "Up to date" flash.

### Popover
- Remove the footer "Check for update" button.
- Keep the header spinner while a check runs.

## Constraints

- Native vs daemon: the CLI version check already lives in the daemon
  (`claude-cli-review.ts`). The OmniFex updater is native (Swift
  `Updater.swift`, `updater:*` channels). OS notifications are native
  (`notify:show`). Follow the repo's rule: anything that can run headless
  belongs in the daemon. Periodic work goes in `electron/periodic-work.ts`.
- Two daemons (dev and installed) share one DB. The notification must not
  fire twice for one version because both checked. The dev daemon's
  periodic work is already gated off.
- TDD. Add renderer tests beside `CustomTitlebar` and daemon tests in
  `electron/__tests__/`.

## My calls (Claude's, not Greg's)

- Dev builds (`npm start`) don't auto-download OmniFex releases.
- On iPad and web clients, the button reflects Claude Code updates only.
  The OmniFex updater is native-only.
- Hourly poll interval.

## Left to the builder

- Where the poll runs (daemon periodic work plus a broadcast, or a renderer
  timer), and how the OmniFex check joins it. A renderer timer runs once per
  window/client, so the notification dedupe has to hold across clients.
- Where the last-notified version is persisted (`app_settings` is the obvious
  place).
- The unreviewed icon and the notification copy.
- Whether a version that is downloaded but not yet installed survives an app
  restart, or is re-downloaded.
