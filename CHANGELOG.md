# Changelog

All notable changes to GreyChrist are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.72] — 2026-04-29

Fixup release: 0.3.71 still launch-crashed on macOS — re-signing both binaries with the same self-signed cert isn't sufficient when there's no Apple Developer Team ID. Disabling hardened runtime in the local build sidesteps Library Validation entirely. Installers remain self-signed (Gatekeeper untrusted, first launch needs right-click → Open).

### Fixed

- **Launch crash on macOS, take two** (`forge.config.ts`). 0.3.71 signed the main binary and embedded `Electron Framework` with the same self-signed `GreyChrist Local Sign` cert and assumed Library Validation would accept the pair. It didn't: macOS's policy requires both halves to share an Apple Developer *Team ID*, and self-signed certs have `TeamIdentifier=not set` — Library Validation read that as a mismatch and dyld killed the app at launch with the same "different Team IDs" error 0.3.69/0.3.70 hit. Adding `optionsForFile: () => ({ hardenedRuntime: false })` to the `osxSign` config disables hardened runtime (and therefore Library Validation) on every binary in the bundle. The app now launches and TCC grants still persist because the cert's identity hash is stable across rebuilds.

## [0.3.71] — 2026-04-29

Fixup release: 0.3.69 and 0.3.70 launch-crashed on macOS due to a code-signing regression. This release switches from ad-hoc signing to a self-signed cert so Library Validation passes, and along the way fixes the original goal of persistent TCC grants for free (no Developer ID required yet). Installers are now **self-signed** (still untrusted by Gatekeeper — first launch per build still needs right-click → Open).

### Fixed

- **Launch crash on macOS**. The ad-hoc `osxSign: { identity: '-', identityValidation: false }` config that landed in 0.3.69 caused dyld to refuse loading the embedded `Electron Framework`: `@electron/osx-sign` re-signed the main binary as `Identifier=com.greychrist.app` but left the framework with its original linker-signed `Identifier=Electron Framework`, and macOS Library Validation killed the process at launch with "Library not loaded ... different Team IDs". 0.3.70 inherited the same broken config. Both releases would have crashed on every Mac that installed them — neither was actually shipped to users.

### Changed

- **macOS code signing now uses a self-signed cert** (`forge.config.ts`). `osxSign` references a cert named `GreyChrist Local Sign` in the developer's login keychain. `@electron/osx-sign` signs the main binary AND the embedded `Electron Framework` with the same identity, so Library Validation passes and the app launches with hardened runtime intact. macOS TCC grants are keyed on the cert's identity hash (stable across rebuilds), so "Allow" clicks for App Management / Files & Folders persist — which was the original intent of the 0.3.68/0.3.69 osxSign experiment, finally working correctly.
- **Gatekeeper status unchanged.** The cert is self-signed, not Developer ID, so Gatekeeper still treats the build as untrusted. **First launch per build still needs right-click → Open.** Switching to Developer ID + notarization later requires only a one-line identity swap in `forge.config.ts` and is on the roadmap when distribution becomes worthwhile.

## [0.3.70] — 2026-04-29

Feature release: per-card debug overlay, session GUID in the context popover, and a major Appearance pass that reworks card-icon styling and brings the settings preview into fidelity with the live cards. Installers remain **unsigned** for Gatekeeper purposes — first launch still requires right-click → Open.

### Added

- **Debug overlay on cards** (`1dfe3c2`). New Settings → Appearance → Global → Debug section with a "Show message kind label on cards" toggle (off by default). When on, every card prints its raw SDK type (e.g. `result · success`, `assistant`) on the bottom-left chip and offers a copy button that puts the full message JSON on the clipboard. Useful when a card looks mis-classified ("Execution Complete" being rendered for things that aren't really results).
- **Session GUID in the context popover** (`1dfe3c2`). The context-window popover (the `Database`-icon pill in the session header) now shows the active Claude session id with a copy-to-clipboard button. Threaded from `ClaudeCodeSession.claudeSessionId` into a new `sessionId` prop on `SessionHeader`.
- **Card-icon controls in Typography editor** (`1dfe3c2`). New "Card icon" section: Size (`xs`/`sm`/`base`/`lg`/`xl`), Bordered chip on/off, and Background opacity slider (0–100). The chip uses `color-mix(in oklch, var(--color-background) X%, transparent)` for the fill so it composes correctly across light/dark themes.
- **Per-kind icon overrides** (`1dfe3c2`). `MessageKindConfig` gains optional `iconSize`, `iconBordered`, and `iconBgOpacity` fields. The KindEditor exposes each as a "Use default (X)" dropdown/switch — pick a value to override just that kind, leave on default to inherit the global. Resolution helpers in `src/lib/typographyClasses.ts` accept an optional `kindId` and walk override → global.

### Changed

- **Appearance preview now matches the live render** (`1dfe3c2`). `SamplePreview` was rebuilt to render through the same `<Card>`, `accentStyleFromEntry`, `<KindHeader>`, and `contentClassNames` primitives as `StreamMessage`. Includes a fixed sample timestamp matching `formatLocalTimestamp`'s output and the same chip wrapper / debug overlay chrome on the bottom row. Editing the icon, accent color, or typography in the editor now shows what the live cards will look like.
- **Compact accent-color and icon pickers in KindEditor** (`1dfe3c2`). The full-grid pickers (21 colors, 80+ icons) are now shadcn `<Select>` dropdowns with previews, freeing up real estate for the new per-kind icon-chrome controls.
- **Card-icon chip is now layout-stable** (`1dfe3c2`). The bordered chip uses negative margins (`-mt-1 -mx-1.5 -mb-1.5`) that exactly cancel its `p-1.5` padding, so the icon glyph holds its position relative to the card whether the chip is on or off — toggling bordered no longer reflows surrounding content.
- **Brighter chip text** (`1dfe3c2`). Bottom-row debug-label and timestamp chips now use `text-foreground/80` instead of `text-muted-foreground/70`, plus increased `pb-9` on every `<CardContent>` for breathing room above the chips.

### Fixed

- **Assistant icons now show in the preview** (`1dfe3c2`). The intermediate `SamplePreview` rewrite delegated icon rendering to `<KindHeader showIcon>`, which returns null when `headerLabel` is null — so `assistant.text`, `assistant.thinking`, and `assistant.toolUse` (all `headerLabel: null` by default) silently dropped their icons in the preview. Now the icon is rendered as a sibling of `KindHeader`, matching how the live `StreamMessage` does it.
- **Background opacity slider actually applies** (`1dfe3c2`). The first cut of the chip-bg opacity used `var(--background)`; the actual CSS variable in this project is `--color-background`, so the `color-mix()` was silently invalid and fell through to no fill. Fixed by using the right token.

## [0.3.69] — 2026-04-29

Fixup release: the `osxSign` config landed in 0.3.68 was a silent no-op — `@electron/osx-sign` validated the literal `-` identity against the macOS keychain, found nothing, and skipped signing entirely. This release sets `identityValidation: false` so ad-hoc signing actually runs. The 0.3.68 build does **not** have stable TCC grants; install this build instead. Installers remain **unsigned** for Gatekeeper purposes.

### Fixed

- **Ad-hoc osxSign now actually signs the bundle** (`e60bb96`). Adds `identityValidation: false` next to `identity: '-'` in `forge.config.ts`. Without it, `@electron/osx-sign` calls `findIdentities('-')` against the keychain, gets nothing back, and silently skips the entire signing pass — leaving the bundle with only Electron's pre-existing linker-signed Mach-O signature (`Identifier=Electron`, `Sealed Resources=none`). With it, the full bundle gets signed: main app, Electron Helpers, native `.node` addons, `node-pty`'s `spawn-helper`, and the Claude Agent SDK's per-platform binary, with `Identifier=com.greychrist.app` and properly sealed resources. macOS now has a stable CDHash to attach TCC grants to, so "Allow" clicks for App Management / Files & Folders prompts persist across launches of the same build.

## [0.3.68] — 2026-04-29

Feature release: per-session account override on the project landing page, and ad-hoc codesigning so macOS TCC grants stick across launches. Installers remain **unsigned** for Gatekeeper purposes — first launch still requires right-click → Open.

### Added

- **Per-session account override on the project landing page** (`979208e`). The auto-resolved account in the New Session card now has a "Change" button next to it. Clicking it opens the existing `AccountPickerDialog` with a session-specific title; selecting an account updates the form immediately and threads the choice through `initialSessionConfig` so `ClaudeCodeSession` seeds its `accountResolution` from it instead of re-resolving via the auto-rules. Override sticks even when the dialog's "Remember for this project" checkbox is left unchecked, so one-off session-only overrides actually take effect. Removes the redundant `({account_type})` parenthetical from the form.

### Changed

- **Ad-hoc codesign every binary in the macOS bundle** (`9f13c6e`). Adds `osxSign: { identity: '-' }` to `forge.config.ts` so `@electron/osx-sign` walks the bundle and signs the main app, Electron Helpers, native `.node` addons (better-sqlite3, node-pty), node-pty's `spawn-helper`, and the Claude Agent SDK's per-platform binary. Result: the `.app` gets a stable CDHash, so macOS persists "Allow" clicks for App Management / Files & Folders prompts across launches of the same build. Does not replace Developer ID — Gatekeeper still treats this as untrusted on first launch.

## [0.3.67] — 2026-04-29

Feature release: per-project pinned branch colors, full shadcn `<Select>` rollout across the renderer, and a context-window display fix for Opus 200K sessions. Installers remain **unsigned**.

### Added

- **Branch Colors card on the project page** (`d591b96`, `8bcff54`). New card in the right column above CLAUDE.md Memories, top-aligned with the New Session card. Pin a color per branch via a shadcn `<Select>` populated from local git branches plus a 9-swatch color picker (reused from the account editor). Persisted in a new `branch_colors` SQLite table (migration v6).
- **Auto-cycling branch chip colors** (`ea949ef`, `55b1367`). Pure resolver in `src/lib/branchColors.ts` assigns chip colors with priority: user pin → black for `main`/`master` → blue for the main folder branch → next palette color skipping anything already in use → name-hash fallback when the palette is exhausted. Worktree chips no longer collide with each other or the main folder chip.
- **`branchColors:list|upsert|delete` and `git:list-branches` IPC** (`bcb16b0`, `de642f2`, `62015f7`). New main-process services with 100% line coverage on the new code.

### Changed

- **All raw `<select>` elements migrated to shadcn `<Select>`** (`1c75607`, `36b456a`). Six in `AccountSettings`, plus one each in `Settings`, `SessionPermissionsEditor`, and `ProjectList`. App-default empty options use a `__app_default__` sentinel; placeholder behavior preserved.
- **`GitBranchBadge` is now presentational** (`55b1367`, `3cdb2af`, `b493efd`, `fd40964`). Accepts a resolved `color` and `isTrunk` from the parent. Adds a luminance check (WCAG, threshold 0.05) so near-black picks render as a "ghost" chip — translucent white bg + white text + the chosen color as a border accent — keeping the chip readable on the dark theme. Saturated picks (blue, gray, etc.) keep the same `${color}33` translucent recipe `AccountBadge` uses.
- **Shared `ColorSwatchGrid`** (`21f367b`). Extracted from `AccountSettings` to `src/components/ui/ColorSwatchGrid.tsx` for reuse.

### Fixed

- **Opus 200K context donut read against 1M** (`591caca`). The Agent SDK's `getContextUsage().maxTokens` reports the model's *maximum* supportable window (1M for Opus 4.x) regardless of which alias the session was started with — sessions started on the 200K opus alias showed e.g. 4% used at 42K instead of the actual 21% of 200K. The renderer now clamps the displayed limit to 200K when the picker model id does not contain `[1m]`, and drops the SDK-provided "Free space" slice when clamping is active so the donut math reflects the clamped budget.



Patch release: Claude Agent SDK bumped to 0.2.123. No user-visible changes. Installers remain **unsigned**.

### Changed

- **Claude Agent SDK 0.2.123** (`7d53183`).

## [0.3.65] — 2026-04-28

Feature release: hover-reveal image download button on user message images, resend button on user prompt cards, per-account usage scrape logging, and Claude Agent SDK bumped to 0.2.122. Installers remain **unsigned**.

### Added

- **Image download button** (`90b7636`). Hovering any image in a user message card reveals a `Download` icon overlay. Click saves the file as `image-<timestamp>.<ext>`. Works for both base64-embedded images (pasted) and `greychrist-file://` references.
- **Resend button on user prompt cards** (`90b7636`). A `RotateCcw` icon appears at the rightmost position of the hover-action row on user message cards. Click re-submits the full message — text and images — using the currently selected model. Suppressed on tool-result-only cards and subagent-generated prompt cards.
- **Per-account usage scrape logging** (`90b7636`). `collectEntries` now logs an `info`-level event for each account scan with entry count and full detail array. Cleans up three leftover `console.log` calls in `getStatsByAccount`.
- **LogTab source filter additions** (`90b7636`). `usage`, `usage-runner`, `updater`, and `rate-limits` sources added to the filter dropdown with distinct badge colours.

### Fixed

- **Resend with images sent only text** (`90b7636`). The base64 round-trip regex (`/.+/` without dotAll) could silently drop large image payloads. Replaced with `indexOf`-based slice parsing; send-dispatch now checks `contentBlocks.some(b => b.type === 'image')` instead of the images array.

### Changed

- **Claude Agent SDK 0.2.122** (`90b7636`).

## [0.3.64] — 2026-04-28

Housekeeping release: Wave 6 architecture audit findings logged. No user-visible changes. Installers remain **unsigned**.

### Added

- **Wave 6 architecture audit punch list** (`192255c`). Four findings queued in `TODO.md`: hooks `local` scope writing to the wrong file (P1), MCP API contract mismatches across multiple layers (P1), fragmented Claude binary resolution across subsystems (P1/P2), and usage cost computation ignoring `max`-account type (P2).

## [0.3.63] — 2026-04-27

Hotfix on top of 0.3.62: the new "rejected reset epoch" warnings turned up an obvious gap — Anthropic's CLI uses a third `Resets …` format we hadn't taught the parser. Installers remain **unsigned**.

### Fixed

- **Parse `"<Month> <Day> at <Hour>[:Min]<am|pm> (<Tz>)"` reset labels** (`8743f61`). The `/usage` CLI uses this dated form when the reset is more than ~24 hours away (typical for 7-day windows). The previous parser only knew relative (`"in 5h 23m"`) and bare-clock (`"7pm (America/New_York)"`) forms, so the dated form was rejected as `unparseable` — meaning the runner kept the prior good value via the COALESCE added in 0.3.62 but never actually captured the real reset. New `parseDateClockWithTz` accepts full and abbreviated month names, picks the year by rolling forward from observed-at when needed (so a "Jan 5" label observed in Dec correctly lands on next year), and round-trips through the target timezone so an impossible date like `Feb 30` still rejects cleanly.

## [0.3.62] — 2026-04-27

A focused infra release: one git watch per tab instead of N (project + each peer worktree share a single connection that knows about new and removed worktrees in flight), one click-to-reconnect status icon in the header in place of per-row icons, and `/usage` parsing that waits for a complete render and refuses to clobber a known-good reset time with junk. Plus the Claude Agent SDK bumped to 0.2.121 and Haiku 4.5 added to every model picker. Installers remain **unsigned**.

### Added

- **Unified `SessionGitWatcher`** (`9bb2553`). One per-tab IPC watch (`startSessionGitWatch` / `stopSessionGitWatch` / `reconnectSessionGitWatch`, channel `session-git-changed:<watchId>`) replaces the prior N per-peer `startGitBranchWatch` connections plus the standalone `startWorktreeListWatch`. The single watcher owns one `fs.watch` per known gitdir, one watcher on `<commondir>/worktrees/`, and one shared 3 s poll; per-path reads run via `Promise.allSettled` with a per-`git status` timeout so a wedged peer never blocks the cycle. Adds and removes are picked up via the worktrees-dir watcher with the poll as a backstop.
- **Header status icon at the tab level** (`9bb2553`). One `GitWatchStatusIcon` next to the project's branch badge — green when every path in the snapshot reads cleanly, red when any path reports an error, with a tooltip that lists the offending labels. Click triggers `reconnectSessionGitWatch` for the whole tab. Replaces the per-row icon variant.
- **`/usage` completeness gate** (`9bb2553`). New `isUsageOutputComplete` predicate exits the TUI-capture loop as soon as all three windows + their `Resets` lines have parsed, then waits an extra 200 ms for trailing bytes. Falls back to the existing quiet timeout when the render is partial (e.g. a CLI version that emits fewer windows).
- **Sanity-bounded reset epochs + parse logging** (`9bb2553`). `validateResetEpoch` rejects parsed reset timestamps that are in the past or implausibly far in the future (>6 h for the 5-hour window, >8 d for 7-day), with named reasons. Every `/usage` cycle now logs one `level: info` line per accepted window and `level: warn` per rejected one (raw label, parsed epoch, observed-at, reason) so format drift is visible.
- **Haiku 4.5 in every model picker** (`9bb2553`). The `MODELS` constant now lists Opus 4.7 (1M / 200K), Sonnet 4.6, and Haiku 4.5 — and the Session Start dialog and Account Settings both render from the same constant, so the four models appear consistently everywhere.

### Changed

- **`@anthropic-ai/claude-agent-sdk` 0.2.119 → 0.2.121** (`9bb2553`). Two patch releases since the previous bump.
- **Model picker drops the SDK-supplied list** (`9bb2553`). The compact / expanded model dropdowns no longer ingest `query.supportedModels()` data, which was the source of the stray "Default" label leaking into the UI. The hardcoded `MODELS` constant is the single source of truth.
- **Header row top-aligns** (`9bb2553`). The Back button, folder, branch, and worktrees columns now align to the top of the row instead of getting vertically centered against the tallest column.

### Fixed

- **`recordUtilization` no longer clobbers a good `resets_at` with `null`** (`9bb2553`). The CLI-runner upsert now uses `COALESCE(excluded.resets_at, rate_limit_snapshots.resets_at)`, matching the SDK-event path. Combined with the sanity bounds above, junky parses become "no update" rather than "overwrite with garbage."
- **Worktree row layout** (`9bb2553`). Header worktrees render as a clean column of branch badges; the per-row error indicator and the inline `AlertTriangle` inside `GitBranchBadge` are gone — error visibility lives in the single header status icon now.

### Removed

- **`startGitBranchWatch` / `stopGitBranchWatch` / `reconnectGitBranchWatch`** and **`startWorktreeListWatch` / `stopWorktreeListWatch`** (`9bb2553`). Replaced by `start_session_git_watch` and friends; the old IPC channels, preload allow-list entries, and corresponding tests were deleted (~250 lines).

## [0.3.61] — 2026-04-27

Follow-up to 0.3.60: the rate-limit pill kept showing "stale" 10 minutes after the last SDK event even after a successful manual refresh. Installers remain **unsigned**.

### Fixed

- **Rate-limit pill never refreshed from CLI-runner writes** (`198a7cc`). `recordUtilization` (the path the usage CLI runner takes) was emitting an `rate_limit_snapshot` IPC channel with no snapshot payload — but the renderer listens to `rate-limits:updated` (the prefix-allowed channel `recordEvent` uses). The DB row got a fresh `observed_at`, but the React state in `ClaudeCodeSession` held the old value and the widget's `now - observed_at > 10min` "stale" check stayed tripped. `recordUtilization` now reads the merged row back and emits `rate-limits:updated` with the same `{ account_name, snapshot }` payload shape, so manual refreshes and the 5-min auto-refresh actually update the pill.

## [0.3.60] — 2026-04-27

Fixes the PTY spawn failure introduced with the 0.3.59 usage runner. Installers remain **unsigned**.

### Fixed

- **node-pty spawn-helper missing from asar unpack** (`d728d4c`). On macOS, node-pty exec's a `spawn-helper` binary via `posix_spawnp` before forking the target process; it rewrites the helper path from `app.asar` → `app.asar.unpacked` at runtime. The asar unpack pattern only extracted `*.node` files, leaving `spawn-helper` trapped inside the archive where `posix_spawnp` fails with ENOENT. This caused "spawn failed: posix_spawnp failed." in both the usage runner and TUI-mode switching. Added `**/node-pty/**/spawn-helper` to the unpack glob.
- **Silent mode-switch errors** (`d728d4c`). TUI / SDK mode toggle failures now surface a 5-second error banner instead of silently swallowing the exception.

## [0.3.59] — 2026-04-27

Headline: a PTY-based **Usage CLI runner** that actually populates the 5-hour / 7-day rate-limit pills introduced in 0.3.57. Those pills were stuck on `?%` for most accounts because Anthropic's Agent SDK only streams `utilization` to accounts with overage unlocked at the org level. The runner sidesteps that by interactively executing `/usage` in a real Claude CLI session and parsing the TUI output. Installers remain **unsigned**.

### Added

- **Usage CLI runner** (`15b6b92`, `1d157bb`). New `electron/services/usage-runner.ts` spawns a node-pty terminal against each account's Claude CLI, waits past the welcome-screen footer + handles the workspace-trust dialog, sends `/usage`, captures + ANSI-strips the TUI output, parses the session block / per-window blocks / "What's contributing" entries, and dual-writes the parsed percentages to `rate_limit_snapshots`. Per-account in-memory cache + concurrent-call dedup. Three new IPC channels (`usage_runner.run`, `usage_runner.getLast`).
- **Reset-time epoch conversion** (`9893184`). Parser labels (`"in 5h"`, `"in 7d"`, `"9:40am (America/New_York)"`, `"7pm (America/New_York)"`) now convert to absolute epochs via a new `resets-label.ts` helper (14 unit tests). The runner writes both `utilization` and `resets_at` to the snapshot table, so the rate-limit pills finally render real countdown tails for the runner-driven 7-day window — not just the 5-hour stream-event path.
- **UsageDetailPopover** (`4b3cdd5`, `f782d6c`). Clicking either rate-limit pill opens a popover showing session cost / API-and-wall durations / tokens / cache reads-and-writes / per-window percentages with reset labels / "What's contributing" headlines.
- **Visibility-aware auto-refresh hook** (`64415a4`, `9893184`). `useUsageAutoRefresh` reads the cached runner result on mount, fires a fresh run if stale (>5 min), re-runs every 5 minutes while the tab is visible, fires once when a session transitions from `starting` to `active`, and pauses on `visibilitychange` to hidden.
- **Account `cli_path` UI** (`46036d5`, `09269e2`, `11a20c2`). Account Settings can now pin a custom Claude binary per account. New SQLite migration v4 adds the `cli_path` column. Validator probes `--version` before saving.
- **Two-column project page** (`8aeba8f`) with a sticky new-session form on the left and the project sidebar on the right.

### Changed

- **Pill labels renamed** (`9893184`). `5-hour` → "Current session", `7-day` → "Current week" — matches the language used inside the popover and inside `/usage` itself.
- **Refresh button now works** (`13c9800`). The 0.3.57 button was wired to `claude -p "/status"`, which the CLI rejects (`"/status isn't available in this environment"`). It now invokes the new runner; spinner shows immediately on click.
- **Usage Dashboard opens as a tab** (`1e0b610`) instead of as a modal, so back-navigation behaves.
- **Prompt input starts at 2 lines tall** (`75d04f2`) instead of 1.

### Fixed

- **Welcome-screen + trust-dialog detection** (`1d157bb`). Old runner heuristic was "wait for `❯` then quiet" — but the workspace-trust dialog uses `❯` as its highlight cursor, so it triggered immediately and silently sent `/usage` into the dialog. Runner now waits for the `"? for shortcuts"` footer and confirms the trust dialog once with Enter if it appears.
- **Refresh spinner showed late** (`16aa9a3`). Removed a redundant double-call to `runUsageCli` that delayed the `loading: true` flip until after the PTY had already finished.
- **Parser missed indented sections** (`198b60e`). Real TUI emits section headers at column 2; the regex was anchored at column 0. Also fixed contributing-factor entries that lead with a percentage headline rather than a colon-key.
- **`recordUtilization` preserves prior status** (`bd19351`). Snapshot upserts only touch `utilization` + `resets_at`; the SDK-reported `status` (`allowed` / `allowed_warning` / `rejected`) carries forward.

## [0.3.58] — 2026-04-27

### Added
- Per-account session defaults (model, thinking, effort, permissions) stored in account settings. Defaults seed the new-session form automatically when a project is opened under that account.
- Thinking mode selector on the new-session start form (Adaptive / Budget / Off).

### Changed
- New-session form no longer shows Config and Matched-by rows — the account badge is sufficient.

Installers remain **unsigned**.

## [0.3.57] — 2026-04-27

Adds rate-limit tracking for the 5-hour and 7-day windows in the session header, and reorganizes the header / chat-bar layout to make room for it. Anthropic's Agent SDK only emits `utilization` for accounts with overage credits unlocked at the org level, so on most accounts today the widget will show `?%` until you cross a 75/90% threshold — the countdown timer and notifications still work. Installers remain **unsigned**.

### Added

- **Rate-limit tracking service** (`ca86d1a`). New `electron/services/rate-limits.ts` captures `SDKRateLimitEvent` messages off the Agent SDK stream and persists per-account snapshots to two new SQLite tables (migration v3): `rate_limit_snapshots` keyed on `(account_name, rate_limit_type)`, and `rate_limit_fired_thresholds` for notification dedup keyed on `(account_name, rate_limit_type, window_resets_at, threshold_key)`. Notifications fire on configurable percent crossings (defaults 75/90 for the 5-hour window) and on Anthropic's own `allowed_warning` / `rejected` status signals — each firing once per window per threshold. Renderer subscribes to a new `rate-limits:updated` event channel for live updates. 26 unit tests covering snapshot upsert, threshold dedup, window roll-over, sticky merging of partial events, multi-account isolation, and settings persistence.
- **Rate-limit widget** in the session header (`ca86d1a`). New `RateLimitWidget` renders one pill per window (5-hour / 7-day) styled to match the existing `context` widget — Lucide icon, mini gradient bar, percentage, and time-to-reset tail text. Stale-state dimming when the latest snapshot is older than 10 minutes. Click-through opens the Usage Dashboard via a new `navigate-to-usage-dashboard` window event handled in `App.tsx`.
- **Rate Limits settings tab** (`ca86d1a`). New `RateLimitsSettings` panel with master notifications toggle, editable comma-separated threshold lists for the 5-hour and 7-day windows, and a separate enable for 7-day notifications (defaulted off). Stored as JSON in `app_settings` under the `rate_limit_settings` key.
- **Manual refresh button** next to the rate-limit pills, with a spinning state while it runs. **Currently non-functional** — wired to `claude -p "/status"`, which the CLI rejects with `"/status isn't available in this environment"` because slash commands aren't supported in print mode. Empirical testing also showed the SDK's streamed `rate_limit_event` itself omits `utilization` for accounts without overage unlocked at the org level. The button stays in place as scaffolding for the eventual statusline-based refresh path.

### Changed

- **Session header layout** (`ca86d1a`). Top row is now `[← Back to Project] | [folder · branch · worktrees]` (the folder/branch/worktrees pills moved up from `SessionHeader`). Bottom row is `[account] [status] [5h pill] [7d pill] [refresh] … [context] [restart]` — the restart Clear button moved down from the top header to pair with the context widget, since restart conceptually clears context. Two pre-existing top-row toggles (mode, output style) moved out of the header entirely.
- **Mode and output-style toggles** (`ca86d1a`). The SDK ↔ Terminal mode switch now sits in the chat bar above the model / effort / thinking / permission pickers (new `modeToggle` slot on `FloatingPromptInput`). The Compact ↔ Verbose output-style switch sits above the copy / MCP / plugins / permissions buttons (new `outputStyleToggle` slot). Frees the session header to be data-only.
- **`COALESCE` upsert** for rate-limit snapshots so a follow-up event with no `utilization` doesn't wipe out a prior good reading. Same for `resets_at`. Locked in by two regression tests.

## [0.3.56] — 2026-04-27

Collapses the upgrade button into a single click and surfaces an active-sessions warning *before* you click, driven by a live in-flight count broadcast from the main process. Installers remain **unsigned**.

### Added

- **Live in-flight session count** (`2f438b2`). Main process polls `listInFlightTabIds()` once a second and broadcasts to every window via `session-inflight-count`; titlebar subscribes through new `api.onSessionInFlightCount`. Drives the new warning state and stays a single source of truth that mirrors what the install gate sees.

### Changed

- **Upgrade button is now one click** (`2f438b2`). Download + install run back-to-back inside `handleUpdateClick` (the local-folder "download" is instant, so the previous two-click flow was redundant). When the live in-flight count is 0 the button is the normal "Update Available!" pill; when it's > 0 the button switches to an amber "<N> active — Install Anyway" warning pill, and clicking calls `installUpdate({ force: true })` so the SDK turns are stopped before the install runs. Main-process `waitForIdle` stays as a safety net for stale renderer state.

## [0.3.55] — 2026-04-27

Replaces the one-shot worktree enumeration with a live fs.watch on the shared gitdir's `worktrees/` so `git worktree add` / `remove` updates the header column without a project re-open. Adds end-to-end install diagnostics + collapses the upgrade button's two-click flow into one for the local-folder updater. Installers remain **unsigned**.

### Added

- **Live worktree-list watcher** (`9d9a345`). New IPC channel `start_worktree_list_watch` enumerates peer worktrees and attaches `fs.watch` to both `<commondir>/` (so `worktrees/` creation is noticed) and `<commondir>/worktrees/` (for child add/remove). Debounced 100ms; only emits `worktrees-changed:<watchId>` when the path/branch set actually changes — HEAD-only churn in the main repo doesn't trip it. Renderer reconciles peer status watches in place: new peers spin up their own `git-branch-watch`, removed peers tear down. Tests: 6 new cases covering initial list, add, remove, no-emit on HEAD-only changes, non-git, and stop().
- **Installer diagnostics** (`9d9a345`). Every step of `updater:install` (entry, params, stage, resolveTargetApp, ensureTargetWritable, waitForIdle, executeInstall, error catch) now logs to main-process stdout. `waitForIdle` prints a per-tab status snapshot on every poll, and the `updater:install-status` waiting payload carries a `tabs: [{tabId, status}]` array — so the renderer / DevTools console mirrors what main sees.

### Changed

- **Upgrade button** (`9d9a345`) chains download → install in a single click. The local-folder "download" is instant, so the previous two-click flow was redundant. State machine is unchanged; the second `installUpdate` call just runs immediately after the first transitions to `'ready'`.

## [0.3.54] — 2026-04-26

Adds a "worktrees" widget to the session header that surfaces sibling git worktrees of the open project — each shown with the same branch + changed/untracked badge as the main branch, live-updated through the existing git-watcher. Also defaults the Recent Projects table sort to Session Count desc, and extracts a shared `HeaderLabel` component so SessionHeader and the toolbar above it share one label style. Installers remain **unsigned**.

### Added

- **Worktrees column** in `SessionHeader` (`5a6540a`). New IPC channel `list_git_worktrees` enumerates peer worktrees via `git worktree list --porcelain` (realpath-normalized, queried path excluded, detached worktrees report `branch: null`). Each peer gets its own per-worktree `start_git_branch_watch`, sharing the existing watcher infrastructure for live changed/untracked counts. The column only renders when at least one peer exists, badges stack vertically, and the header row grows taller as needed. Path tooltip on each badge.
- Tests: 4 new cases in `electron/__tests__/git-watcher.test.ts` (non-git, no-peers, peer enumeration with self-exclusion both directions, detached HEAD) + 3 new IPC handler tests for `list_git_worktrees` (camelCase, snake_case, missing-param fallback). 666 → 670 tests after the change.

### Changed

- **Recent Projects table** default sort is now `Session Count ↓` instead of `Last opened ↓` — quick glance at where the active work is.
- **Header labels** ("account", "status", "folder", "branch", "worktrees", "context", "restart", "mode", "output style") now route through a shared `HeaderLabel` component exported from `SessionHeader`. Single source of truth for label styling — bumped from 9px to 11px in the process so the toolbar above the chat matches the header below it. Vertical dividers between groups now `self-stretch` so they fill whatever the row's tallest column dictates.

## [0.3.53] — 2026-04-26

Removes the in-app agent management system entirely (Claude Code's native subagents already cover the same ground without the parallel format), and replaces the Recent Projects card-list with a sortable / filterable / responsive table. Fixes a session-status bug where every session was stuck reporting `'running'` until its first turn completed. Installers remain **unsigned**.

### Removed

- **In-app agents feature** (`31184a9`). Drops the entire CRUD path, per-run lifecycle, GitHub-import flow (`anthropics/claude-code-agents` was 404'd anyway), the `.greychrist.json` format, the bundled `cc_agents/` directory, and the `agentRunRegistry`. 16 component / service / store files deleted (`Agents.tsx`, `AgentExecution*.tsx`, `AgentRunOutputViewer.tsx`, `AgentRunView.tsx`, `AgentRunsList.tsx`, `AgentsModal.tsx`, `App.cleaned.tsx`, `CCAgents.tsx`, `CreateAgent.tsx`, `GitHubAgentBrowser.tsx`, `SessionOutputViewer.tsx`, `useClaudeMessages.ts`, `outputCache.tsx`, `agentStore.ts`, `electron/services/agents.ts`, `electron/services/agent-run-registry.ts`). 25 IPC channels and 4 event prefixes (`agent-output:`, `agent-error:`, `agent-complete:`, `agent-cancelled:`) trimmed from preload + handlers. Tab union loses `'agent' | 'agents' | 'agent-execution' | 'create-agent' | 'import-agent'`. The Bot button is gone from the titlebar.
- **Sequence ID readout** in `SessionHeader` — the truncated session ID + copy button on the right of the chat header is gone. The same data is now reachable from the project's session list, where each card's session ID is itself the click-to-copy target.

### Added

- **Recent Projects table** (`Name / Path / Account / Sessions / Last opened`). Click-to-sort headers (default `Last opened ↓`), toggle direction on repeat clicks. Per-account filter dropdown — only shown when more than one account is present, falls back to `(unassigned)` for projects with no resolved account. Count next to the title shows `N of M` while a filter is active.
- **Click-to-copy session ID** on each session card in `SessionList`. Truncated 8-char tail copies the full UUID; icon swaps `Copy → Check` for 1.5s as feedback. The `e.stopPropagation()` keeps the row's "open session" handler from firing on the same click.

### Changed

- **Recent Projects layout** is now a sticky-header scrollable table inside a flex chain (`h-full flex flex-col` → `flex-1 min-h-0 overflow-y-auto`). The table claims whatever vertical space is left between the page header and the viewport bottom, so it never extends past the screen — and shrinks responsively when you resize the window. Old `(showAll, currentPage, projectsPerPage, totalPages)` pagination is removed.
- **Session status** state machine: `init` messages now flip the session to `'idle'` instead of `'running'` (only `result` and any non-init message flip to `'running'`). `sendMessage` / `sendStructuredMessage` set `'running'` eagerly so the installer's wait-for-idle gate reacts on user submit, not on first SDK echo. Without this fix every session was stuck on `'running'` until its first turn completed, and the auto-update flow blocked on tabs that were merely open.
- **`ClaudeStreamMessage` type** moved from `AgentExecution.tsx` (deleted) to `src/types/claudeStream.ts`. The ~20 importers across renderer hooks, components, and lib were rewritten en masse — no behavior change, just a stable home for the type.

### Fixed

- **Agent import-from-file IPC** (now moot since the feature was removed, but landed earlier in the same diff): `import_agent_from_file` had no main-process handler and `importAgent` only handled the flat JSON shape, never the `{ version, agent: { ... } }` bundled format that GreyChrist itself exports. Both fixed before the rip.

### Internal

- Installer's wait-for-idle gate no longer consults `agentRunRegistry`. `InstallStatus` drops `activeAgentRuns`. `CustomTitlebar` and `api.onInstallStatus` follow.
- `useTabState` interface trimmed of agent helpers (`createAgentTab`, `createAgentsTab`, `createAgentExecutionTab`, `createCreateAgentTab`, `createImportAgentTab`, `findTabByAgentRunId`, `agentTabCount`).
- 39 test files / 659 tests after the rip (was 41 / 725) — net ~70 agent-only tests removed. The `agents` and `agent_runs` SQLite tables stay in place as zombies; no migration runs.

## [0.3.52] — 2026-04-26

Adds a Lima VM viewer for inspecting and controlling local VMs and Docker containers without leaving the app, splits session status into running/idle so the auto-update gate doesn't block on open-but-quiet tabs, and tightens the SubagentBar (collapse-by-default, persistent header, scrollable list capped at half the viewport). Installers remain **unsigned**.

### Added

- **Lima VM viewer** (`00f8063`). New `'lima'` tab type with a HardDrive icon in the titlebar (next to Agents). Master/detail layout: VM cards on the left (status dot, name, color-coded status text, 2x2 metadata grid for arch/cpu/mem/disk, segmented Play/Stop bar) and Docker container cards on the right (image/status/ports stacked, same Play/Stop bar). Lifecycle is non-destructive throughout — `limactl start|stop` for VMs, `docker start|stop` for containers (no recreate, no pull). Empty state with a `brew install lima` hint when `limactl` isn't on PATH. Polled every 5s while the tab is mounted.
- **`SessionsService.listInFlightTabIds()`** (`00f8063`). Filters to tabs whose status is `'starting'`, `'running'`, or `'waiting_permission'` — used by the installer's wait-for-idle gate so it no longer blocks on tabs that are merely open and waiting on the user.
- **Continuous gradient on the context bar** in `SessionHeader`. Single green-to-orange-to-red gradient clipped from the right by `clip-path` instead of a stepwise color swap, so the bar reads its position in the warning spectrum at a glance.

### Changed

- **`SessionStatus` enum** gained `'idle'` (`00f8063`). After every `result` SDK message a session moves to `'idle'`; the next user message flips it back to `'running'`. `setMode` now accepts `'idle'` so mode toggles work between turns.
- **SubagentBar** (`00f8063`):
  - Collapsed by default; chevron toggle persists in localStorage (`greychrist.subagentBar.collapsed`).
  - Permanent header row with inline summary (`Subagents (N) · X running · Y done`) so you can see what's pending even while collapsed.
  - "Clear done" is now a real outlined button — always present, disabled when there's nothing to clear (no more layout shift as completed runs come and go).
  - List sits inside a `max-h-[50vh]` scroll container so the bar can never push more than half the viewport.
- **Context-window medium tier** in the session header swapped from yellow to orange — both the count text and (via the new gradient) the bar.

### Internal

- New `electron/services/lima.ts` with injectable `execLimactl` for tests; 18 tests in `electron/__tests__/lima.test.ts` covering happy paths, ENOENT, empty NDJSON output, malformed lines, stopped VMs, and lifecycle errors.
- New IPC channels: `lima_check_installed`, `lima_list_vms`, `lima_list_containers`, `lima_start_vm`, `lima_stop_vm`, `lima_start_container`, `lima_stop_container` (typed wrappers in `src/lib/api.ts`, allow-listed in `electron/preload.ts`).
- Installer deps switched from `listActiveTabIds` to `listInFlightTabIds`; existing tests updated to the new fixture shape.

## [0.3.51] — 2026-04-26

Redesigns the session header so the project folder, branch, and context-window readouts each get their own labeled badge — and adds a thinking-mode picker to the chat-input control row that was missing after the previous release dropped the inline pills. Installers remain **unsigned**.

### Added

- **Folder + branch badges in the session header** (`13f0bbc`). The header now shows `account / status / folder / branch / context` as labeled badges, replacing the previous permissions/effort/adaptive pills (those controls already lived in the chat-input control bar). The folder badge is the project path with `~` collapsed; the branch badge picks up a hashed color per branch (trunk stays black-on-white) and now shows working-tree counts as `+N` (`FilePen`, green) for changed files and `?N` (`FilePlus`, amber) for untracked files. Counts come from `git status --porcelain=v1 -z`, polled every 3s and refreshed on `.git/` events.
- **Thinking-mode picker** in `ControlBar` / `FloatingPromptInput` (`13f0bbc`). The bottom row already drove model / effort / permissions through `Query.set*` mid-session; now thinking is wired in too (Brain icon + dropdown matching the other pickers). Selecting `adaptive` / `budget` / `disabled` calls `api.sessionSetThinking` immediately — no session restart.

### Changed

- **All four picker dropdowns get a section title** (Model / Effort / Thinking / Permissions). Small uppercase row above the option list with a divider, matching the new badge labels in the header.
- **Picker buttons and right-side icon buttons** (Copy / MCP / Plugins / Permissions panel toggles) now share a 1px inset outline in `color-mix(in oklch, var(--color-muted-foreground) 30%, transparent)` over `bg-background`. The MCP / Plugins / Permissions toggles flip to `bg-accent` when their panel is open so the active panel is obvious without changing layout.
- **New-tab `+` button** picks up the same inset-shadow outline the active tab uses, so it reads as a sibling of the tab strip rather than a floating affordance.

### Internal

- `electron/services/git-watcher.ts` extended from branch-only to `{ branch, changed, untracked }` snapshots; tests cover clean repos, dirty repos, working-tree poll updates, and non-git directories.
- Extracted `ProjectPathBadge` and `GitBranchBadge` into `src/components/claude-code-session/` so `SessionHeader` can render them without pulling on `ClaudeCodeSession`'s render tree.
- `src/lib/api.ts` gained a `GitBranchSnapshot` type; `startGitBranchWatch` and `onGitBranchChanged` carry the new fields with defensive defaults if a payload arrives without them.

## [0.3.49] — 2026-04-26

Replaces the manual "mount DMG and drag" install path with a one-click auto-install flow: the titlebar update badge now stages the new ZIP, waits for in-flight sessions and agent runs to finish (with an "Install anyway" override), swaps `GreyChrist.app` in place via a detached helper script, and relaunches. Also lets users hide subagent prompts in Compact mode. Installers remain **unsigned**.

### Added

- **Auto-install update flow** (`ed9066a`, `838a893`, `758dbb3`, `afd529c`, `73f579d`, `cbce43f`, plus tests). Click "Install vX" in the titlebar — GreyChrist validates the new bundle, waits for active sessions/agent runs, and replaces `/Applications/GreyChrist.app` itself, then relaunches. New IPC channels `updater:install`, `updater:install-cancel`, `updater:install-status`. The "Install anyway" button force-stops in-flight work and proceeds; "Cancel" drops back to the ready-to-install state. New states `'waiting'` and `'installing'` extend the existing titlebar update-state machine.
- **Defensive shell-injection guard** in the helper-script generator (`ed9066a`). Rejects paths containing `"`, `` ` ``, `$`, `\`, newline, tab, or NUL — even though `process.execPath` and `os.tmpdir()` never produce them in practice.

### Changed

- **Updater scans for ZIP artifacts** instead of DMGs (`0abee7c`). Filename pattern is now `GreyChrist-darwin-arm64-X.Y.Z.zip` (matching Electron Forge's zip maker). The DMG is still produced by `npm run make` for users who want the manual install path.
- **Compact-mode "Subagent prompt"** is hidden by default and toggleable in Settings → Appearance (`38198b0`). Previously the kind was treated as a turn boundary and forced visible; flipping `compactBoundaryLocked` lets subagent prompts collapse into the group marker like other tool-related messages. Existing users with a saved appearance config will see the old visible-by-default behavior until they flip the switch manually.

### Fixed

- **Staged temp directory cleanup** on install failure (`ed9066a`). If `resolveTargetApp`, `waitForIdle`, or user cancel fires after `stage()` extracts the ZIP, the IPC handler now removes the staged dir before surfacing the error — previously every failed attempt leaked a directory in `$TMPDIR`.
- **Detached helper `unref()`** so Electron quits cleanly (`ed9066a`). Without unref, the parent's event loop held a reference to the still-running helper while the helper was waiting for the parent to exit — soft deadlock until the OS reaped the process. Explicit unref breaks the cycle immediately.
- **`version` propagation in the renderer's error-retry path** (`ed9066a`). The `'error'` state now carries the version string, so retry-after-failure no longer downloads a fresh ZIP and then fails install with `VersionMismatch` because the version got dropped.

### Internal

- **`SessionsService.listActiveTabIds()`** (`fad5b54`) and **`AgentRunRegistry.listActiveRunIds()` + `killAll()`** (`e360323`) — small enabler methods used by the new installer's wait-for-idle gate.
- **New `installer.ts` service** with four-step pipeline (`stage`, `resolveTargetApp`, `waitForIdle`, `executeInstall`) plus pre-quit `ensureTargetWritable` check. Covered by 14 unit tests in `electron/__tests__/installer.test.ts` and `installer-helper-script.test.ts`.

## [0.3.48] — 2026-04-25

Aligns the Compact/Verbose view toggle with the adjacent SDK/Terminal mode toggle so the two reads as one consistent control. Installers remain **unsigned**.

### Fixed

- **Compact/Verbose toggle styling** in `SessionViewToggle` (`6897104`) now uses the same container (`bg-muted/30` with `p-0.5`) and active-state treatment (`bg-background shadow-sm`) as `SessionModeToggle`, so the active/inactive coloring matches across the two adjacent toggles in the session header.

## [0.3.47] — 2026-04-25

Trims redundant chrome from the session header now that the AccountBadge popover is the single source of truth for SDK-account details. Installers remain **unsigned**.

### Changed

- **Vertical dividers in the session header** are now `bg-foreground/30` instead of `bg-border/60` — clearly visible against the muted strip background, separating the status row from the permissions, effort, and adaptive sections.

### Removed

- **Static SDK email indicator** in `SessionHeader` (`cbf733d`). The shield-icon + email pill that sat next to the session-status badges is gone — the same email (and the full SDK-reported account block) is already in the popover that opens when you click the AccountBadge. The unused `sdkIdentifier` derivation went with it.

## [0.3.46] — 2026-04-25

(0.3.45 was tagged but never built — the bump commit landed without the corresponding `package.json` version change, so the release was rolled forward to 0.3.46.)



Tab strip restyled to a shadcn pill aesthetic, per-account user-pickable icons, and a wave of polish on the session header. The account badge gains an icon + accountType inline and now opens the SDK/config/match popover. Installers remain **unsigned**.

### Added

- **Per-account Lucide icon** (`7dc1f12` → `336ad03`). New `icon` column on the `accounts` table (migration v2, idempotent). `Account.icon: string | null` threaded through service, IPC, and the renderer `Account` type. AccountSettings gets a `IconPicker` button (reuses the existing Lucide picker that custom agents use) plus a swatch-grid color picker (9 fixed colors with a custom-hex fallback). `AccountBadge` grows a `variant="compact"` mode that renders an 18×18 tinted icon-chip in the account's color, defaulting to `User` when no icon is set.
- **AccountBadge full variant** now renders the account's icon inline before the name (resolved via the new `getIcon` on `AccountsContext`), and an optional `accountType` suffix at 70% opacity (resolved via `getAccountType`) — so the standalone account-type pill in the session header is gone, the type lives inside the badge.
- **Account-details popover on the badge** (`6ed422b`). Clicking the AccountBadge now opens the SDK-account / config-dir / match-by popover that previously hung off the SDK email button. The email becomes a non-clickable status indicator (shield icon + identifier).

### Changed

- **Tab strip aesthetic** (`a7fcae8`). Active tab is a 1px-outlined rounded pill (`bg-background` + 75%-opacity muted-foreground inset border) instead of a bottom underline; dividers between tabs replaced by a 4px gap; rounded corners; height 32px → 36px; type icon 13px → 15px; font 12.5px → 14px (`text-sm`); strip background `bg-muted/40` for a clearly elevated panel. Account text-pill in the tab is replaced by the new compact icon-chip (icon resolved per account, after the title). All existing affordances retained: drag-to-reorder, status indicator (now in a fixed 14px slot), hover-revealed close, overflow scroll, keyboard shortcuts.
- **Tab persistence** (`6d92fb1`). `accountColor` and `accountIcon` now serialize alongside `accountName`, so restored tabs render with the correct chip color immediately on app launch instead of falling back to a hashed color until the next session interaction. The `project.account_name` fast-path also resolves the full account so the chip color is correct even when `listProjects` pre-attaches an account.
- **Session-status badges** (`6ed422b`). Active / Starting… / Closed are now squircle pills tinted in their state color (green / amber / red) using inline hex+alpha (`${color}33` fill / `${color}4d` border / `${color}` text) — the same pattern `AccountBadge` uses, since Tailwind v4's color-utility alpha modifiers were rendering desaturated under this theme's oklch palette.
- **AccountBadge full variant** is a 4px-radius squircle now (was a fully rounded pill) and shares the icon-chip color convention.

### Removed

- **Standalone account-type pill** in `SessionHeader` (`6ed422b`) — replaced by the inline `: <type>` suffix on the AccountBadge.

## [0.3.44] — 2026-04-25

Removes the checkpoint subsystem and fixes two rendering gaps: image-only user messages are visible again, and live subagent progress now streams into the SubagentBar expander instead of going dark mid-run. Installers remain **unsigned**.

### Added

- **Live subagent progress streaming** (`abc3bd7`). Both interactive sessions and agent executions now pass `agentProgressSummaries: true` to the Claude Agent SDK. The SDK emits periodic AI-generated `task_progress` summaries for any nested subagent dispatched via the Task tool, populating the SubagentBar expander mid-run instead of showing nothing between `task_started` and `task_notification`.

### Fixed

- **Image-only user messages stay visible in chat** (`ca4f050`). `filterDisplayableMessages` previously dropped any user message whose content array contained no text blocks, so pasting an image with no caption made the entire message disappear from the timeline. The filter now recognizes image blocks as displayable content.

### Removed

- **Checkpoint subsystem deleted** (`b6f5043`). The full timeline/checkpoint feature is gone — service, IPC, UI panels, fork dialog, and hooks (-2754 lines across 12 files). The feature was unfinished and was creating maintenance drag against the rest of the session UX. If checkpointing returns, it will be designed against the current session model rather than retrofitted onto the old one.

## [0.3.43] — 2026-04-24

Live-session permissions: rule edits made via the in-session sidebar now take effect immediately instead of waiting for a session restart. Plus a small spacing tweak so the message-card timestamp stops crowding the last line of content. Installers remain **unsigned**.

### Fixed

- **Permission rule edits apply to the live SDK session** (`8f739e2`). Previously, adding or removing a rule via the session sidebar wrote to `.claude/settings.local.json` but the running Claude Agent SDK `Query` never picked it up — `settingSources` is loaded once at session start and never re-read — so users kept getting prompted for permissions they had just allowed. The sessions service now exposes `applyPermissions(tabId, { allow, deny })`, which forwards the on-disk allow/deny union into the live session via `Query.applyFlagSettings({ permissions })`. `session_update_permission` calls it after the disk write whenever a `tabId` is provided, so rule changes from the session sidebar take effect on the next tool call. The global Settings panel (no `tabId`) still writes to disk only, taking effect on next session.
- **Message-card timestamp no longer crowds content** (`f52939a`). `CardContent` bumped from `p-4` to `p-4 pb-6` across the four message-card variants (assistant, user/tool-result, result-summary, error fallback) so the absolute-positioned timestamp at `bottom-1 right-2` has ~8px of breathing room above it.

## [0.3.42] — 2026-04-24

Large Appearance pass: every message kind's header label, icon, and accent color is now driven by the config instead of hardcoded per-component. Adds typography controls, more palette and icon options, and a personal-default save/restore workflow. Installers remain **unsigned**.

### Added

- **Configurable typography** (`a301d46`). New `typography` section on `MessageRenderingConfig` with separate header and content styles — each picks family (sans/serif/mono), size (xs/sm/base/lg), weight (normal/medium/semibold/bold), and italic on/off. `src/lib/typographyClasses.ts` maps those values to Tailwind classes; `KindHeader` and user message text read them. A new Typography card in Appearance settings (`TypographyEditor`) exposes the sliders.
- **Palette additions**: `brown` (#92400e), `chocolate` (#78350f), `tan` (#d4a574), `black` (#171717). Plus 49 new Lucide icons — including `Sparkles`, `Brain`, `Wand`, `Rocket`, `MessageCircle`, `ShieldCheck`, `Code2`, `Package`, `Star`, `Heart`, and categories for chat, status, code/tech, creative/thinking, objects, fun/personality, and misc symbols.
- **"Save as my default" + "Reset to my default"** (`a301d46`). Stored alongside the live config under a separate settings key so the user-default survives factory resets. Three buttons: save current as default, reset to your saved default (disabled until one exists), and reset to factory defaults.
- **Icon picker tooltip** — hovering any icon in the Kind Editor shows the icon's name via the app's `TooltipSimple` (200ms delay). Previously only the browser-native `title` attribute fired at ~1s.
- **Debounced save toast** — Appearance changes auto-save; an "Appearance saved" toast now fires 800ms after the last edit so rapid color-picker adjustments emit one toast instead of many.

### Changed

- **Single `KindHeader` component replaces seven inline header markups** across `StreamMessage`, `SystemInitializedWidget`, `ThinkingWidget`, and the tool-result variants. Sizes and weights are now consistent everywhere — previously "You" rendered at `text-xs font-medium` while "Execution Complete" rendered at `text-sm font-semibold`.
- **Kind Editor now spans the full editor column** — the 3-column tree/editor/sample layout collapsed to 2 columns, moving Sample to a compact preview at the top of the editor. Icon and color grids wrap across the full width instead of scrolling.
- **Assistant message header now renders** when `assistant.text.headerLabel` is set (previously the renderer never looked for one, so "Claude Code" and similar customizations were invisible).
- **`ThinkingWidget` default-expands when rendered inside a collapsed group** — the group expander represents an explicit "show me the contents" action, so hiding the thought behind a second click felt broken. In verbose mode (standalone), thinking still starts collapsed.

### Fixed

- **"1 thought" / "1 step" expanders no longer show empty content** (`a301d46`). `summarizeGroup` previously counted signature-only (empty) thinking blocks and fell back to a raw message count, but the renderer would drop those messages as null. The summary now only counts thinking blocks with non-empty text and only falls back to a step count when the group has renderable content; groups with nothing to show render nothing instead of an empty disclosure.
- **Duplicated-text suppression no longer nukes thinking/tool_use blocks** on assistant messages whose text repeats the following Execution Complete card. The renderer now skips just the duplicated text blocks and preserves the rest of the message.
- **"You" header appears on user messages** when the kind's `headerLabel` is set. The previous fix edited an unreachable second text branch in `StreamMessage.tsx`; the reachable array-content branch now renders the header correctly and the dead code was removed.

## [0.3.41] — 2026-04-24

Follow-up to the 0.3.40 Appearance fix: turning off "Hide in compact" for a standalone kind (System Initialized, notifications, results, summaries, permission requests) now actually shows that message inline in compact mode instead of leaving it buried inside a collapsed group marker. Installers remain **unsigned**.

### Fixed

- **Unhidden standalone kinds are now promoted to singles in compact mode** (`33c94b1`). In 0.3.40, `filterCompactHidden` correctly dropped kinds with `hiddenInCompact: true`, but when the toggle was off, `buildCompactItems` still treated the message as non-boundary and collapsed it into a `CollapsibleGroup` (collapsed by default), so from the user's POV the toggle did nothing. `buildCompactItems` now accepts the rendering config and — for any message whose `classifyStandaloneKind` returns a kind with `hiddenInCompact: false` — emits a top-level `single` item instead of folding it into the surrounding group. Back-compat preserved: callers that pass no config keep the old grouping. Two new unit tests in `compactGrouping.test.ts` cover both the promote-when-unhidden case and the no-config baseline.

## [0.3.40] — 2026-04-24

Fixes two bugs in the Appearance settings: the "Hidden in compact" toggle now actually affects the transcript, and the System Initialized / System Context / System Reminder widgets now follow the palette you pick instead of their old hardcoded blue/gray/yellow. Installers remain **unsigned**.

### Fixed

- **`hiddenInCompact` toggle is now wired into the compact renderer** (`ad01b27`). The setting was only read by the Appearance settings UI itself; `ClaudeCodeSession` ignored it when building the compact message list, so toggling `system.init` (or any other standalone kind) had zero visible effect. New `src/lib/messageKind.ts` introduces `classifyStandaloneKind(msg, all)` — returns a kind ID for messages whose rendering is a single unit (system init, SDK notifications, execution result, permission request, compaction summary) and `null` for mixed-content assistant/user messages (which need per-content-block rendering). `filterCompactHidden(messages, config)` drops any message whose classified kind is marked `hiddenInCompact` and isn't boundary-locked. `ClaudeCodeSession` now runs this filter before `buildCompactItems`, so compact view respects the toggle; verbose view is unchanged. 9 unit tests cover the classifier + filter, including boundary-lock defense and notification-subtype mapping.
- **System widgets follow the Appearance palette** (`ad01b27`). `SystemInitializedWidget`, `SystemContextWidget`, and `SystemReminderWidget` were hardcoded to `blue-500`, `gray-500`, and a content-keyword-driven blue/yellow/destructive scheme respectively. All three now read the palette via `useMessageRenderingConfig()` and style themselves with `accentStyleFor`/`swatchFor`, keyed to their owning kind (`system.init`, `user.systemContext`, `tool.result.systemReminder`). Severity variants in `SystemReminderWidget` additionally borrow `system.notification.warn` / `system.notification.error` palette entries when the reminder text contains "warning" or "error", so the warn/error signal stays visible under any palette.

## [0.3.39] — 2026-04-23

Bundles the 0.3.38 UX fixes with a patch bump of the Claude Agent SDK. The v0.3.38 draft was discarded in favor of this rolled-up release. Installers remain **unsigned**.

### Changed

- **`@anthropic-ai/claude-agent-sdk` upgraded to 0.2.119** (`959a0de`). Patch bump, no GreyChrist code changes required. Upstream: `excludeDynamicSections` now keeps static auto-memory instructions in the cacheable system-prompt block (only the per-user memory dir path and per-machine env values move to the first user message); long-running SDK sessions reconnect claude.ai-proxied MCP servers after transport-stream aborts; `SessionStore.append()` failures are retried 3× with short backoff before the batch is dropped and `mirror_error` is emitted. None of these surface new APIs that GreyChrist consumes — the improvements apply automatically to sessions spawned via `query()`.

## [0.3.38] — 2026-04-23

Two UX fixes that stop the app from hijacking your session. Clicking a link in the app no longer turns the window into a browser, and the permission prompt is no longer a modal that blocks every tab and window while one session waits for approval. Installers remain **unsigned**.

### Changed

- **Permission prompt is now an inline card, not a modal** (`e296726`). The old `PermissionDialog` was a `Dialog` component — blocking every tab in every window for a request belonging to a single session. Replaced with an inline `PermissionCard` docked above the composer in the waiting session only; other sessions and windows stay fully interactive. Layout: editable rule field (monospace, black background so its editability is visually obvious), a scope combobox with label + one-line description per option (**Me, Here** → `.claude/settings.local.json`, default; **Me, Everywhere** → `~/.claude/settings.json`; **Team** → `.claude/settings.json`), and a three-button row — **Deny** (red), **Save for Session** (outline; allow once, persist nothing), **Save Permission** (green; persist the edited rule at the selected scope). Card border and fill come from the palette-driven accent of the `permission.request` message kind, so Appearance settings retint it along with the stream-log entry. Pure logic (rule parse/format, suggestion builder, scope options) lives in `src/lib/permissionCardLogic.ts` with 19 unit tests.

### Fixed

- **External links no longer hijack the app window** (`c948f36`). Clicking an `http:` / `https:` link inside the renderer used to navigate the window away — effectively turning GreyChrist into a browser and losing all session state. Added `setWindowOpenHandler` (catches `target="_blank"` / `window.open`) and `will-navigate` guards on every `BrowserWindow`; decision logic lives in a pure `classifyNavigation()` helper covered by 10 unit tests. External URLs open in the OS default browser via `shell.openExternal`; internal URLs (dev-server same-origin, `file://` for packaged load, `greychrist-file://` for local assets, `about:blank`) pass through; unknown protocols (`javascript:`, `data:`) are denied.

### Added

- **`docs/permission-syntax.md`** — reference doc for Claude Code's permission-rule syntax (gitignore-style paths, `/` vs `//`, `Bash(cmd:*)` shorthand, shell-operator boundaries, MCP `mcp__server__tool` form, settings precedence, silent-filter gotchas). Links back to the upstream source at `https://code.claude.com/docs/en/permissions`. Exists to stop permissions regressions from recurring — every permission bug in 0.3.34–0.3.37 traced back to a misunderstanding of this syntax.

## [0.3.37] — 2026-04-23

Fixes a subtle rule-format bug that has made **every file-path-based "Always Allow" silently ineffective** since permission persistence shipped in 0.3.34. Installers remain **unsigned**.

### Fixed

- **`Edit(/Users/...)` rules never matched anything.** Claude Code permission rules use gitignore-style syntax with four path prefixes: `//abs`, `~/home`, `/project-rel`, and bare `rel`. A single leading `/` on an absolute-looking path is interpreted as **project-root-relative**, not absolute — so a rule like `Edit(/Users/alice/proj/src/foo.ts)` tells the matcher to look for `<project-root>/Users/alice/proj/src/foo.ts` (which doesn't exist) and never fires. GreyChrist's `createCanUseTool` fallback synthesized rules from the tool's raw `file_path` without the required `//` prefix, and `respondPermission` persisted them verbatim. Every "Always Allow" click since 0.3.34 saved a rule that looked correct but was silently ineffective — each session start re-asked for the same permission. New util `electron/services/sessions/rule-paths.ts#formatFilePathForRule(fp, projectPath, homeDir)` picks the most readable form:
  - **Inside the session's project** → project-anchored relative `/rel/path` (portable across worktrees of the same repo).
  - **Outside the project but under `$HOME`** → home-relative `~/rel/path` (survives username / machine changes — e.g. a sibling-worktree file at `/Users/greg/Repos/worktrees/WIN/WS-106/.../foo.ts` becomes `~/Repos/worktrees/WIN/WS-106/.../foo.ts`).
  - **Elsewhere** → absolute with the mandatory double slash, `//tmp/scratch.ts`.
  14 unit tests cover every branch: inside/outside project, inside/outside home, exact-root cases, trailing-slash tolerance, prefix-collision (`/proj-other` is NOT inside `/proj`; `/Users/alice2` is NOT inside `/Users/alice`), and project-wins-over-home when the project is itself under home.
  - **Existing broken rules are not rewritten.** If your `settings.local.json` or `settings.json` files already contain rules like `Edit(/Users/...)` (single slash + absolute-looking), they'll stay broken. Manual fix: prepend another `/` to each one (`"Edit(/Users/...` → `"Edit(//Users/...`), or rewrite to project-relative (`Edit(/.claude/commands/**)`) or home-relative (`Edit(~/Repos/worktrees/WIN/**)`). Going forward, GreyChrist will suggest the correct form automatically.

## [0.3.36] — 2026-04-22

New **Appearance** settings tab lets you retint every message type in the session view and toggle compact-mode visibility, with live preview and a full-turn compact-vs-verbose preview. Typing-indicator bubble no longer sits ~280px to the right of the other cards. Installers remain **unsigned**.

### Added

- **Configurable message rendering — new Settings → Appearance tab** (`f6310e8`). All ~20 distinct message kinds in the session view (user prompts, assistant text, tool use, tool results, subagent prompts, system init, SDK notifications, Execution Complete/Failed, permission requests, compaction summaries) now pull their accent color from a user-editable config. Master-detail UI: kind tree on the left (grouped by origin: User / Assistant / Tool / System / Subagent), per-kind editor in the middle (icon picker from an allow-listed Lucide set, palette-name color selector, header-label override, hide-in-compact toggle — locked for boundary kinds), live sample card on the right. A separate "Turn preview" panel flips between compact and verbose on a canned fake turn so you can see the grouping behavior without leaving Settings.
- **Expanded palette.** Added eight new color options on top of the existing set: purple, orange, teal, pink, indigo, cyan, yellow, lime. Each palette name is a single source of truth — edit the swatch once and every kind assigned to that name retints coherently.
- **Live application without restart.** New `MessageRenderingProvider` context loads the config on app start and broadcasts edits to `StreamMessage` in real time, so changes in Settings apply to the running session on the next render. Config persists to `app_settings` under key `message_rendering_config` (JSON, schema-drift tolerant — unknown kinds and palette keys are silently dropped, missing fields fall back to defaults). Hard-filter toggles (drop meta / drop task-lifecycle / drop empty-user) and import/export/reset are exposed in the Global section.
- **Design reference at `docs/message-rendering-config.yaml`.** Captures the full schema that informed the data model — one block per message kind listing match discriminators, classification (origin / isBoundary / isMeta), visual fields, compact behavior, and widget dispatch for per-tool cards. Useful when adding a new message kind.

### Fixed

- **Typing indicator aligned with message cards** (`6101eb3`). The "✶ Plotting…" bubble had its own `w-full max-w-6xl mx-auto px-4` wrapper on top of the parent content's `w-full px-4`. In wide viewports the `max-w-6xl mx-auto` centering pushed it ~280px right of every other card; on any viewport it picked up an extra 16px of left padding. Dropping the redundant wrapper puts the typing bubble flush with user/assistant cards on the same left edge.
- **Card style merge.** `components/ui/card.tsx` was overwriting its own default `{ borderColor, backgroundColor, color }` style whenever a caller passed `style={...}`. Now it spreads caller-supplied style over the defaults, so callers can tint borders/backgrounds without losing the text color fallback. No behavior change for existing callers that didn't pass a style.

## [0.3.35] — 2026-04-22

Sibling git worktrees are now auto-admitted to the SDK sandbox at session start, so `/work-on-ticket`-style flows that create a feature worktree and edit inside it no longer trip "Path is outside allowed working directories" on every write. Installers remain **unsigned**.

### Fixed

- **"Path is outside allowed working directories" fired for every cross-worktree write.** The Agent SDK enforces a working-directory sandbox that's independent of `permissions.allow` rules — a `Write(/.../worktrees/<repo>/**)` entry in `settings.local.json` does not open the sandbox for paths outside the session's CWD. So a session rooted at `~/Repos/personal/<repo>/` (main checkout) kept tripping the Permission Required dialog on writes into `~/Repos/personal/worktrees/<repo>/<feature>/`, no matter how many rules you added. At session start we now shell out to `git -C <cwd> worktree list --porcelain`, parse the output, filter out the cwd itself + any stale paths, and pass the remaining registered worktree paths as `options.additionalDirectories`. Discovery is fire-and-forget on failure (not a git repo, git missing, timeout) — returns `[]` and leaves the session unchanged.
  - New service: `electron/services/git-worktrees.ts` with `discoverWorktrees(cwd)` + a pure `parseWorktreeListPorcelain(output)` parser. 11 unit tests covering canonical output, detached HEADs, bare + locked worktrees, dedup, stale-path filtering, and both git-errors (non-repo + ENOENT).
  - Logged per session-start: `admitting N sibling worktree(s)` with the path list in metadata, so you can confirm which worktrees were admitted.

## [0.3.34] — 2026-04-22

Skill invocations now render distinctly in the chat transcript, drag-dropped images actually land in the prompt, the Permission Required dialog both pre-fills a sensible rule and persists the save, and every message card carries a local-time timestamp. Installers remain **unsigned**.

### Added

- **Skill-injected messages render as a purple Sparkles card** (`995c84a`). When Claude invokes the `Skill` tool, the SDK re-injects the skill's `SKILL.md` body as a user-role message. Previously it was indistinguishable from a prompt the user actually typed (same blue `User` icon and tint). The new branch in `StreamMessage.tsx` detects the injection by walking back to the matching `tool_use`, renders a `border-purple-500/30` card with a `Sparkles` icon and a `Skill: <name>` header, and — in Compact view — collapses the body into the preceding tool group so the transcript stays readable. New util `src/lib/skillDetection.ts` with 6 tests; `compactGrouping.ts` no longer treats the injected body as a boundary; `CollapsibleGroup` now emits a `Skill: <name>` action label in group summaries.
- **Per-card timestamp on every message** (`13fbd47`, `e6f8b9e`). Each message card now shows a dimmed bottom-right timestamp formatted as `M/D/YY H:MM:SS AM/PM` in the user's local timezone — covers assistant messages, user prompts (both typed and streamed back from the SDK), Execution Complete / Failed cards, and the error fallback. Main process stamps live SDK messages with `receivedAt` (ISO) as they arrive in `listenToMessages`; optimistic user-message append in `useSendPrompt` stamps its own. Reloaded-from-JSONL messages show nothing (the SDK's session history has no per-message timestamp; an honest blank beats a misleading load-time stamp). Hover reveals the raw ISO.
- **Shared `formatDurationMs` helper** (`e6f8b9e`). Durations over a minute now read as `1m 15.55s` instead of `75.55s`, and above an hour as `1h 5m 22.00s`. Replaces five inline `toFixed(2)` sites (StreamMessage Execution Complete, AgentExecution + AgentRunOutputViewer markdown exports, AgentRunView badge, Agents run row).

### Removed

- **Floating scroll-to-top / scroll-to-bottom FAB.** 68 lines of `motion.div` + `Button` + `TooltipSimple` JSX in the bottom-right of `ClaudeCodeSession` — never load-bearing, and the virtualizer scroll was buggy enough that clicking it sometimes did nothing. Built-in scrolling is sufficient.

### Changed

- **Claude Agent SDK bumped to 0.2.118.** Parity with Claude Code 2.1.118. Adds `Options.managedSettings` for embedders to pass policy-tier settings to the spawned CLI in-memory (honored below IT-controlled managed sources). GreyChrist doesn't use it yet; no API surface touched by this repo changed.

### Fixed

- **Permission Required dialog opened with an empty rule row** (`93565fb`). When the Agent SDK returned a suggestion with an empty `rules` array (or no suggestion at all for tools we hadn't special-cased), `PermissionDialog.getRuleString()` produced `''` and rendered a blank row — you had to type the rule from scratch. `createCanUseTool` in `electron/services/sessions/permissions.ts` now synthesizes a default rule for `Bash` / `Read` / `Write` / `Edit` / `MultiEdit` / `NotebookEdit` / `Glob` / `Grep` / `WebFetch` (with a `domain:<host>` form pulled from the URL), falling back to the bare tool name so no row is ever blank. The dialog has a second-layer safety net too: if a suggestion somehow still has no rule, it prefills with `toolName`.
- **"Always Allow" didn't write to `.claude/settings.local.json`** (`93565fb`). `respondPermission` only handed the rules to the SDK via `updatedPermissions`; there was no explicit disk write on our side, so when the SDK didn't persist a rule itself the save silently evaporated. `createSessionsService` now accepts an optional `persistPermissionRule` callback, and main.ts wires it to `permissionsIOService.updatePermission`. Every non-`session` destination is written to the right file (`user` → `<configDir>/settings.json`, `project` → `<projectPath>/.claude/settings.json`, `local` → `<projectPath>/.claude/settings.local.json`), wrapped in try/catch so a write failure can't break the allow response. 4 new `sessions.test.ts` cases cover: persists on allow, maps the three scopes, skips `session`, skips on deny.
- **Images dragged onto the chat input silently disappeared** (`e3c1ab9`). Electron 32+ removed `File.path` from the renderer for security, so `(file as any).path` was `undefined` for every dropped file — the OS cursor showed a `+` because our `dragenter` listener fired, but the drop produced nothing. `useImageDropZone` now uses `FileReader.readAsDataURL` (same path as paste) and pushes the result into the existing `pastedImages` base64 array. Works for Finder, macOS screenshots, browser drags, Slack, Figma — anywhere an `image/*` blob comes from.
- **node-addon-api missing from the packaged app broke node-pty's rebuild** (`435922a`). `node-pty`'s `binding.gyp` needs `node-addon-api` at rebuild time. `forge.config.ts`'s `packageAfterCopy` copied `node-pty` but not its transitive header dep, so `electron-rebuild` inside the packaged app threw `Cannot find module 'node-addon-api'`. Added to the copy list. Landed after the v0.3.33 tag but was used to build the v0.3.33 DMG/ZIP locally.

## [0.3.33] — 2026-04-22

Big one: each session now has a **SDK / Terminal mode toggle**. SDK mode is the existing custom UI; Terminal mode drops you into the full Claude Code TUI (every slash command, plugin, `/model`, etc.) on the same conversation. Switch back and forth freely between turns — both sides read and write the same JSONL file. The Compact / Verbose toggle and the mode toggle now live on the project header row; the broken Usage button has been removed. Installers remain **unsigned**.

### Added

- **SDK ↔ Terminal mode toggle per session** (`ab7e996`, `40f8296`, `6b844bd`, `7423bb2`, `9840caf`, `ce4c0b6`, `becbfa3`, `2d43302`, `f243604`). Clicking **Terminal** in the project header cleanly closes the SDK query, spawns `claude --resume <sessionId>` in a `node-pty` terminal rendered via `xterm.js` + the fit addon, and forwards `CLAUDE_CONFIG_DIR` so multi-account routing survives the handoff. `/exit` in the TUI auto-reverts to SDK mode; manual switching works the same way. The idle gate only blocks during `waiting_permission` and on dead sessions — switching is allowed during the transient `starting` window too. Conversation persists because both surfaces read/write the same session JSONL.
- **Mode + view toggles moved to the project-header row** (`f5138c6`). Adjacent to the Back / path / branch controls at the top of the session, right-aligned. The Usage popover button (`BarChart3`) that used to live there has been deleted — it didn't work. `getCliUsage` is retained in the main-process service (no other callers for now, but unused is cheaper than the wrong thing).
- **TuiSession service with full node-pty lifecycle** (`ab7e996`, `2228212`, `dbc080f`). `electron/services/sessions/tui.ts` owns spawn / write / resize / kill / onData / onExit. Disposables from `pty.onData` / `pty.onExit` are collected and disposed in `kill()` so listeners can't outlive the pty. Covered by 4 tests.

### Fixed

- **TUI-mode turns invisible in SDK view after return** (`cfe9f42`). A message sent in Terminal mode wrote to the JSONL file but never flowed through our `claude-output` event stream, so `messages[]` in the renderer missed it. Every TUI→SDK mode flip now reloads the session history from the JSONL via `api.loadSessionHistory` and replaces `messages[]`. Ref-indirected so the event subscription effect can stay `[]` while reading fresh `claudeSessionId` / `projectId` / `projectPath`.
- **Session shown as "Starting…" after returning from Terminal mode until the first prompt** (`be40e04`). Two culprits: the `listenToMessages` error path emitted `claude-complete` without the mode guard, so a throw during `query.close()` wiped the renderer's `isSessionActive` flag; and the renderer never re-asserted active on `session-mode:<tabId>` events. The error path is now guarded the same way the normal-close path is, and the mode event now sets `isSessionActive=true` — the badge stays "Active" across the flip.
- **Mode toggle stuck disabled forever** (`2e758ec`). `isSessionStarting` never resets once a session is running — it only flips false on `claude-complete`. The toggle gate relied on it and therefore was always disabled. `isSessionActive` alone already means the SDK is warm and responsive; dropped the redundant check.
- **`setMode("tui")` rejected during the transient post-restart window** (`1c118e6`). After TUI→SDK, `restartQuery` sets `handle.status = 'starting'` until the first SDK message arrives. The gate only accepted `'running'`, so the user could not flip back to Terminal without first sending a prompt. Gate now accepts both `'starting'` and `'running'`; permission / stopped / error states still block.
- **`stop()` orphaned the TUI pty** (`567abcc`). When the tab was closed, `stop()` tore down the SDK handle but never called `handle.tuiDetach?.()`, leaving the spawned `claude` process running. `stopAll()` cascades through `stop()`, so both paths are now covered.
- **node-pty failed to load in the packaged / bundled main process** (`cbf8070`). Rollup was bundling `node-pty` into `main.js`, which broke its runtime dynamic `require('./prebuilds/darwin-arm64/pty.node')` — the app couldn't start at all. Externalized alongside `better-sqlite3` in `vite.main.config.ts`.
- **node-pty verification in `rebuild:electron` threw on missing directory** (`15af2a1`). The inline verifier called `readdirSync('./node_modules/node-pty/bin')` without try/catch. Now matches the `better-sqlite3` half: wrapped, clean error message, consistent exit code.
- **forge `afterCopy` swallowed rebuild failures** (`15af2a1`). The catch block called `callback()` with no argument after logging, so a broken rebuild silently produced a shippable package. Propagates the error now.

### Changed

- **Dependency additions for TUI mode** (`c86acb1`). `node-pty@^1.1.0`, `@xterm/xterm@^6.0.0`, `@xterm/addon-fit@^0.11.0`. `node-pty` joins `better-sqlite3` as a native module — the `rebuild:electron`, `prestart`, and three `pretest*` scripts now rebuild both, and `forge.config.ts` copies + rebuilds both when packaging. `asar.unpack` pattern extended to include `**/node-pty/**/*.node`.
- **Session handle carries mode state** (`40f8296`). New `SessionMode = 'sdk' | 'tui'` type, new `mode`, `tui`, `tuiDetach` fields on `SessionHandle`, four new methods on `SessionsService` (`setMode`, `tuiWrite`, `tuiResize`, `getMode`). `listenToMessages` skips its normal-close cleanup when `handle.mode === 'tui'` so a deliberate SDK query close during a TUI handoff doesn't wipe the session handle.
- **IPC surface for mode switching** (`ce4c0b6`, `a1dee82`). New invoke channels `session_set_mode`, `session_tui_write`, `session_tui_resize` and event channels `session-mode:<tabId>`, `session-tui-data:<tabId>`, `session-tui-exit:<tabId>` (covered by the existing `session-` event prefix). Handlers apply the dual-key convention (`p?.mode ?? p?.session_mode`, etc.).

### Removed

- **Titlebar Usage button + `onUsageClick` prop path** (`3099f25`). The titlebar path was the first wrong location for the toggles and it's not needed any more; the broken button is gone from `CustomTitlebar`, along with its `BarChart3` import and the `onUsageClick` props in `App.tsx`. `UsageDashboard` view and `createUsageTab` are still wired for future reachability.

## [0.3.32] — 2026-04-21

Permission events now surface in the Logs tab, log search covers metadata and category, and the bundled Claude Agent SDK is bumped to 0.2.117. Installers remain **unsigned**.

### Fixed

- **"Always Allow" persistence was invisible** (`8ccdbbd`). Permission decisions were only written to `/tmp/gc-perm-debug.log` via `fs.appendFileSync`, so nothing showed up in the LogTab and you couldn't tell whether a rule had been saved. `canUseTool` in `electron/services/sessions/permissions.ts` now writes `permission.request` and `permission.decision` entries through the `LoggingService` with `category='permission'`. Decision metadata includes `persisted: true/false`, `destination`, and the saved rules so you can verify at a glance. The stale `setTimeout(1000)` file-read verify hack is gone — the plumbing tests already confirm `updatedPermissions` reaches the SDK.
- **`localSettings` missing from the `PermissionDecision` destination union** (`8ccdbbd`). The `PermissionDialog` defaults new rule suggestions to `localSettings`, but the TypeScript union in `electron/services/sessions/types.ts` only listed `session | projectSettings | userSettings`. Added `localSettings`.

### Changed

- **Log search now matches message, metadata, and category** (`8ccdbbd`). Previously `search` in `electron/services/logging.ts` only matched the `message` column, so permission events (and any structured event whose interesting detail lives in `metadata`) weren't filterable. The query now does `(message LIKE ? OR metadata LIKE ? OR category LIKE ?)`; no renderer change needed.
- **Claude Agent SDK bumped to 0.2.117** (`0c7a803`). Parity with Claude Code 2.1.117. Relevant to GreyChrist: Opus 4.7 sessions no longer show inflated `/context` percentages (the SDK was computing against a 200K window instead of Opus 4.7's native 1M), concurrent MCP server connect at startup, `reload_plugins` no longer reconnects user MCP servers serially, and MCP `elicitation/create` no longer auto-cancels in print/SDK mode when the server finishes connecting mid-turn. No breaking API changes in our `query()` / `canUseTool` paths.

### Removed

- **Dead `src/components/PermissionPrompt.tsx`** (`8ccdbbd`). The live dialog is `PermissionDialog.tsx` (rendered by `ClaudeCodeSession`) and has been for a while; the stale `PermissionPrompt` component was never imported and its misleading in-memory-only "Always Allow" implementation was a real-world diagnostic detour when investigating this release's permission-persistence report.

### Tests

- 4 new `logging.test.ts` cases covering metadata search, category search, message-only still working, and `count()` respecting the broadened search.
- 4 new `sessions.test.ts` cases covering `permission.request` logged, and `permission.decision` logged for allow-session / allow-saved / deny.
- `permissions.ts` 95.08% line coverage, `logging.ts` 96.66% line coverage. Suite: 563 passed, 1 skipped.

## [0.3.31] — 2026-04-21

Single-fix patch: Cmd+R no longer reloads the app. Installers remain **unsigned**.

### Fixed

- **Cmd+R and Cmd+Shift+R no longer reload the window** (`7a87819`). Electron's default `viewMenu` role bound these accelerators to Reload / Force Reload, which would wipe the streaming state, session log, and any unsaved input of an in-flight Claude session. `installAppMenu()` in `electron/main.ts` now builds a custom View submenu that keeps Toggle DevTools, the zoom controls, and fullscreen but omits both reload entries — so Cmd+R is a no-op.

## [0.3.30] — 2026-04-21

Fixes the Referenced SDK titlebar badge going blank in packaged builds, slims the titlebar dropdown, and prunes unused theme options. Installers remain **unsigned**.

### Fixed

- **Referenced SDK badge was blank in packaged app** (`f23caf5`). The runtime `fs` read of `node_modules/@anthropic-ai/claude-agent-sdk/package.json` fails in release builds because Vite tree-shakes the SDK into `main.js` and its `package.json` isn't shipped as a loose file. The SDK version is now baked into the main bundle at build time via a `__GREYCHRIST_REFERENCED_SDK_VERSION__` define in `vite.main.config.ts`, with the runtime fs read kept as a dev fallback.
- **Empty pill rendered next to "Claude Installation" in General Settings** (`f23caf5`). The simplified `ClaudeVersionSelector` layout was rendering a `<Badge>` keyed on `installation.installation_type`, but the main-process `listInstallations()` in `electron/services/claude-binary.ts` never populates that field — so the badge showed as a blank rectangle. Removed the badge; the installation source/version are already visible in the row below.

### Changed

- **Titlebar dropdown no longer lists CLAUDE.md or MCP Servers** (`f23caf5`). Both are reachable elsewhere (project actions / session sidebar panels); the dropdown now shows only Check for Updates and About. `App.tsx` drops the now-unused `onClaudeClick` / `onMCPClick` props on `CustomTitlebar`.
- **Theme system now offers only Gray and Light** (`f23caf5`). Dropped the unused `dark`, `white`, and `custom` themes and the whole custom-color editor from General Settings. Legacy stored preferences normalize to Gray; stale inline `--color-*` CSS variables from the old custom theme are cleared on every theme apply so they can't linger. The Gray / Light toggle in General Settings replaces the previous four-way switcher.
- **Light-theme contrast polish on session header and ControlBar pills** (`f23caf5`). Effort / thinking / permission label colors shifted from `-500` to `-600` weights; the permission, effort, and adaptive badges in `SessionHeader` now carry an explicit `border` + `bg-foreground/10` so the pill shape stays visible against light backgrounds. The account-type chip picks up the same border/bg treatment and only renders when there's a value.
- **Current SDK badge shows a spinner while the npm version fetch is in flight** (`f23caf5`). The badge previously read `—` until the first fetch resolved; it now starts in a checking state, and the dropdown's Check for Updates button refreshes the SDK badge too (previously only the app-update check ran).

## [0.3.29] — 2026-04-21

Adds SDK-version visibility in the titlebar, routes OS notification clicks to the originating tab, and makes the session header's branch badge update live when you switch branches outside the app. Installers remain **unsigned**.

### Added

- **Titlebar now shows three version badges: GreyChrist, Referenced SDK, Current SDK** (`0181cbd`). The Referenced badge reads `@anthropic-ai/claude-agent-sdk`'s version directly from the installed `node_modules/@anthropic-ai/claude-agent-sdk/package.json` (the exact pinned version, not the caret range in `package.json`). The Current badge polls `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest` on launch and every 60 minutes after; it renders green when it matches Referenced, red when a newer SDK has shipped, or neutral `—` when offline. Tooltips explain each state. Implemented as a new `sdk-version` service (`electron/services/sdk-version.ts`) with two IPC channels and 7 unit tests.
- **Clicking a macOS notification now opens the tab that produced it** (`0181cbd`). `NotificationsService.show()` gained an optional `{ tabId }` payload that's forwarded to the click handler; on click the main process emits a `notification-clicked` event and `TabProvider` calls `setActiveTab(tabId)` if that tab still exists. The four session call sites (`lifecycle.ts`, `permissions.ts` twice, `hooks.ts`) all pass the current tabId through. If the tab was closed between fire and click, the window still focuses but no tab switch happens.
- **Session header's branch badge live-updates on external `git checkout`** (`0181cbd`). New `git-watcher` service (`electron/services/git-watcher.ts`) watches `<projectPath>/.git` via `fs.watch`, resolves `.git`-as-file for worktrees/submodules, debounces bursts by 50ms, and emits short SHAs for detached HEAD. `ClaudeCodeSession` subscribes via a pair of `start_git_branch_watch` / `stop_git_branch_watch` IPC channels plus a per-watcher `git-branch-changed:<watchId>` event. Watchers dispose on app quit.

### Changed

- **Branch badge visual treatment** (`0181cbd`). `main`/`master` render solid black with white text and a border; any other branch gets a deterministic color from a six-entry palette keyed off the branch name, matching the account-badge fallback palette. Keeps the existing monospace font and `GitBranch` icon.
- **Titlebar version badges use the same squircle shape as the branch badge** (`0181cbd`). Account badges remain pills.

## [0.3.28] — 2026-04-20

Adds a Plugins side panel alongside the existing MCP Servers panel and reworks the MCP panel to group by scope with richer per-server details. Also bumps the Claude Agent SDK to 0.2.116. Installers remain **unsigned**.

### Added

- **Plugins panel in the session sidebar, sibling to the MCP Servers panel** (`3cc75db`). New `Package`-icon button on the session toolbar opens a slide-in panel that lists every plugin the SDK reports for the active session. Each row shows name, version, marketplace source, and description; expanding a row reveals scope, author (name + email), full path, and the marketplace id. Plugins are grouped by inferred scope (User / Project / Local / Other) — scope is derived from the plugin's path vs. the session's `configDir` and `projectPath`. Powered by a new `session_plugins` IPC channel that calls the SDK's `query.reloadPlugins()`, enriches each entry by reading `<path>/.claude-plugin/plugin.json` for `version` / `description` / `author`, and caches the result per tab so reopening the panel doesn't re-trigger a reload. The panel's refresh button forces a live fetch.

### Changed

- **MCP Servers panel now groups by scope and promotes key fields to the row header** (`3cc75db`). Servers are grouped under User / Project / Local / claude.ai / Managed / Other headings (sorted in that order). The row header now shows name, `v<version>` from the SDK's `serverInfo`, and a transport-type badge (`HTTP` / `STDIO`). The expanded details pane is a labeled key/value list — Scope, Version, Command + args, URL, Env (keys only; values redacted), and Tools — instead of the ad-hoc text blobs from before.
- **Bumped `@anthropic-ai/claude-agent-sdk` from 0.2.114 to 0.2.116** (`ffacf39`). Upstream patch bump for parity with Claude Code v2.1.116. No API changes affecting our `query()` consumers in `electron/services/sessions/`, `electron/services/agents.ts`, or `electron/services/mcp.ts`.

## [0.3.27] — 2026-04-20

Fixes MCP servers silently disabled in every session since v0.3.0-era, and makes the session-status badge honest about the Claude Code 0.2.114 control-channel warmup delay. Installers remain **unsigned**.

### Fixed

- **MCP servers defined in `~/.claude.json` and `.mcp.json` no longer silently disappear from sessions and agent runs** (`ce15fd8`). `electron/services/sessions/lifecycle.ts` and `electron/services/agents.ts` were passing `strictMcpConfig: true` intending the SDK JSDoc's "invalid MCP configs become hard errors instead of warnings" behavior. The underlying Claude CLI `--strict-mcp-config` flag actually means "only use MCP servers from `--mcp-config`, ignore every other source" — so with no `mcpConfig` passed programmatically, user-scope (`claude_ai_Atlassian` etc.) and project-scope MCP servers were getting ignored by the CLI entirely, and `enableAllProjectMcpServers: true` couldn't override it. Removed the flag from both call sites; flipped the two tests that were pinning the buggy behavior to assert it stays falsy, so this can't silently regress again.
- **Session-status badge in `SessionHeader` now distinguishes three states: Starting… (amber, pulsing) / Active (green) / Closed (red)** (`b893bea`). Claude Code CLI 0.2.114's control channel (`accountInfo`, `mcpServerStatus`, `supportedCommands`, `contextUsage`) doesn't answer queries until the subprocess has processed a first user message. The old two-state badge went straight from `undefined` to "Closed" and stayed there until the first prompt, even though the session handle in main was alive. Split `persistentSessionRef` into `isSessionStarting` + `isSessionActive` React state so the badge tracks reality: Starting… fires when `api.startSession` kicks off, Active fires only when `fetchInitInfo` gets a real control-channel response, Closed fires on `claude-complete` / cancel fallback / force-send-from-queue.
- **MCP panel no longer stays stuck on "No MCP servers active" when opened right after Start** (`b893bea`). `SessionMCPStatus` now polls `sessionMcpServerStatus` every 2 s until it gets a non-empty result or the panel unmounts (was a single-shot fetch). So when the SDK control channel finally answers — which happens post-first-prompt in 0.2.114 — the panel picks it up automatically instead of requiring a Refresh click.
- **Chat view no longer looks blank between Start and first prompt** (`b893bea`). `useSessionLifecycle` now synthesizes a `system:init` message (model, cwd, standard tool list) the moment `api.startSession` resolves, instead of waiting for the hanging `sessionAccountInfo` call to return before showing anything. `fetchInitInfo` then merges MCP tool names into that existing init message in-place via a new `upsertInitMessage` helper once the control channel responds, replacing the dedup-skip path that used to drop MCP tools on the floor.
- **`fetchInitInfo` no longer pins the retry loop on a hung first `await`** (`b893bea`). `api.sessionAccountInfo` is now wrapped in a 2 s `Promise.race` timeout (was unbounded, so the control-channel hang meant the retry loop never iterated), and polls indefinitely while `isMountedRef` is true, so late warmups after the first prompt still populate.
- **Auto-start promise rejections are surfaced to devtools** (`b893bea`). `ClaudeCodeSession`'s mount effect now chains `.catch(console.error)` on both the rebind-then-resume path and the fresh-start path, so silent failures during auto-start show up instead of disappearing into unhandled rejections.

## [0.3.26] — 2026-04-20

Upgrades `@anthropic-ai/claude-agent-sdk` to 0.2.114 and teaches the Electron Forge build about the SDK's new per-platform native binary so packaged apps stay self-contained. Installers remain **unsigned**.

### Changed

- **Bumped `@anthropic-ai/claude-agent-sdk` from 0.2.112 to 0.2.114** (`f7600c7`). The SDK's 0.2.113 release stopped bundling its CLI in JavaScript and instead spawns a per-platform native binary shipped in an optional sibling package (e.g. `@anthropic-ai/claude-agent-sdk-darwin-arm64`). It also reverted `options.env` to replace `process.env` instead of overlaying it — no behavior change for us since all three `query()` call sites already pass `{ ...process.env, CLAUDE_CONFIG_DIR }`. Also picks up the new additive APIs (`sessionStore`, `deleteSession`, `title`, OTel trace-context propagation) even though we don't use them yet.
- **`forge.config.ts` now copies the SDK's per-platform binary subpackage(s) into the packaged app and `asarUnpack`s them** (`f7600c7`). Without this, `npm run make` builds would ship an SDK that couldn't find its own CLI for fresh-install users who don't have Claude Code on their PATH. A new `copySdkPlatformBinaries()` helper walks `node_modules/@anthropic-ai/claude-agent-sdk-*` during `afterCopy`; the `asar.unpack` glob now lifts both `better-sqlite3` `.node` addons and the SDK's native binary out of `app.asar` so `spawn()` can execute them.
- **`electron/services/claude-binary.ts` gained `findBundledSdkBinary()` and `findBundledSdkBinaryAuto()`** (`f7600c7`). Pure resolver (platform + arch + candidate node_modules roots) with 6 unit tests, plus a thin auto-configured wrapper that knows about dev (`./node_modules`) and packaged (`app.asar.unpacked/node_modules`) layouts. Wired in as a final fallback inside `findBestBinary()` and inside the local resolvers in `sessions/lifecycle.ts` and `models.ts`, so system installs like `~/.local/bin/claude` still win when present.

## [0.3.25] — 2026-04-20

Cmd+R no longer breaks the active session, and the project view no longer hides the new-session form behind an extra click. Installers remain **unsigned**.

### Added

- **`session_rebind` IPC for re-claiming an in-flight session after a renderer reload** (`c8af874`). New `sessions.rebind(tabId, ownerWebContentsId)` method on the sessions service re-registers per-window event ownership without touching the SDK query, returning `false` when no live session exists for that tab. Wired through `electron/ipc/handlers.ts` (with `ownerWebContentsId` injection), `electron/preload.ts` (allow-list), and `src/lib/api.ts` (`api.sessionRebind`). +3 unit tests covering unknown-tab false return, ownership re-registration on a healthy tab, and no second SDK subprocess spawn on rebind.
- **`NewSessionForm` reusable component** (`c8af874`). Extracted the model/effort/permissions/auto-allow panel out of `ClaudeCodeSession.tsx` so it can render in two places with the same controlled state surface.
- **`initialSessionConfig` field on `Tab`** (`c8af874`). New optional `{ model, effort, permissionMode, autoAllowEnabled? }` shape; `ClaudeCodeSession` seeds its state from it on mount and auto-starts the session, so a Start click in the project view doesn't need a second click in the chat tab.

### Changed

- **Project view shows the new-session form inline above the session history** (`c8af874`). The "+ New session" button and `handleNewSession` indirection are gone from `src/components/TabContent.tsx`. The form sits at the top, with CLAUDE.md memories and past sessions below — Start swaps the tab to chat with the chosen config baked in via `initialSessionConfig`. `api.explainAccountResolution` now runs when a project is opened so the form's Account/Config/Matched-by block is populated.
- **`useSessionLifecycle` exposes `rebindPersistentSession()` and split listener-attach / init-info-fetch helpers** (`c8af874`). The auto-resume effect in `ClaudeCodeSession` now tries `rebindPersistentSession` first and only falls back to the existing `startPersistentSession(session.id)` resume path when the main process has no live session for that tab. Same effect also handles the new "auto-start from `initialSessionConfig`" path.

### Fixed

- **Cmd+R reload while a session is running no longer leaves prompts stuck on a spinner** (`c8af874`). The auto-resume effect used to call `api.startSession(...)` unconditionally on every remount, which closed the healthy SDK query in the main process and replaced it with a fresh `resume:` query — and the new query's input channel wasn't always wired up before the next prompt arrived. Status read "active" but new prompts produced no output. Now the renderer rebinds to the existing session through `session_rebind` and only restarts when the main side actually has nothing live.

## [0.3.24] — 2026-04-19

Second-window UX: one dock icon with multiple windows, and stuck subagent rows now clean themselves up. Installers remain **unsigned**.

### Changed

- **File → New Window now opens a second in-process window instead of a second app instance** (`f7ea3d2`). The previous implementation shelled out to `open -n <bundle>` so each new window got its own dock icon and its own isolated process. It now calls `createWindow()` inside the existing main process, so all windows share one dock icon and appear together under the macOS Window menu and the dock's right-click list — the standard Ghostty/Safari/VS Code pattern. The singleton `mainWindow` state in `electron/main.ts` was refactored into a `Set<BrowserWindow>`; dock-badge focus tracking, notification-focus checks, and context-menu popups now operate on the set rather than a fixed window. `electron/new-instance.ts` and its 9 tests were removed.
- **Session and agent stream events route per-window instead of broadcasting to a single assumed main window** (`f7ea3d2`). New `electron/window-router.ts` tracks which window started each session (`tabId`) or agent run (`runId`) and routes `claude-output/error/complete/subagent/compact:*`, `elicitation-request:*`, and `agent-output/error/complete/cancelled:*` events only to the owning window. App-wide events (`claude-notification`, `updater:progress`) broadcast to every open window. `SessionStartParams` and `executeAgent()` accept a new optional `ownerWebContentsId`, and `electron/ipc/handlers.ts` injects `event.sender.id` automatically for the `session_start` and `execute_agent` channels so renderers don't need to be aware of the routing. `updater:download` progress goes only to the window that initiated the download. +9 router tests, +6 ownership-hook tests across sessions and agents.

### Fixed

- **SubagentBar rows no longer get stuck on "running" when the SDK skips `task_notification`** (`8a38697`). Some parent-session streams deliver the subagent's `tool_result` block without a corresponding `task_notification` system message, which left the row in its loading state indefinitely and blocked the per-row ✕ dismiss button and the "Clear done" control. `deriveSubagents` now scans user messages for `tool_result` blocks matching each subagent's `tool_use_id` and flips status to `completed` (or `failed` when `is_error: true`) as a fallback. A real `task_notification` still wins when both arrive so the richer summary and usage data survive. +4 unit tests.

## [0.3.23] — 2026-04-19

You can now run multiple GreyChrist windows at once. Installers remain **unsigned**.

### Added

- **File → New Window (⌘N) and a dock-menu entry** (`32705e7`). The app previously had no single-instance lock but also no visible way to launch a second instance — the Dock right-click menu was empty and there was no application menu. `electron/main.ts` now installs a composed application menu (appMenu + File + edit/view/window roles) with a "New Window" item bound to ⌘N, plus a custom dock menu with the same item. Both shell out to `open -n <bundle>` so each new window is a fully isolated process with its own SDK sessions. A new `electron/new-instance.ts` module handles bundle-path resolution (walks up from `process.execPath` to the outermost `.app`) and gates launches to packaged macOS builds only — dev mode logs and refuses so `npm start` doesn't try to relaunch a non-existent bundle. +9 unit tests covering bundle resolution and refusal paths.

## [0.3.22] — 2026-04-18

Subagent (background task) activity now has its own colored status bar above the prompt input, and right-click finally works on session output. Installers remain **unsigned**.

### Added

- **SubagentBar: live status rows for Agent/Task tool dispatches** (`3724b21`). When Claude fires an `Agent`/`Task` tool, a new left-border colored row appears above the prompt input showing the subagent type, latest `task_progress` description, tool-use count, token total, and elapsed time. Parallel dispatches stack as distinct rows — each `tool_use_id` gets a deterministic color from a cool palette (sky/indigo/cyan/teal/violet/emerald). Rows are click-to-expand to show the full `task_started → task_progress* → task_notification` event log plus the completion summary. Derivation lives in a pure `src/lib/subagentStreams.ts` helper (`deriveSubagents` + `clearCompleted` + `isTaskLifecycleMarker`), tested against the real SDK transcript shape with 17 unit tests. Task lifecycle markers are filtered out of the main chat via `messageFilters` so they don't render as blank system rows.
- **Dismiss controls on the SubagentBar**. Each completed or failed row gets an `X` button to clear it individually; if two or more subagents are done at once, a `Clear done (N)` button appears at the top-right of the stack. Running subagents cannot be dismissed. Dismissed state is per-session and forgotten on reload.
- **Native right-click context menu on the main window** (`3724b21`). `mainWindow.webContents.on('context-menu')` in `electron/main.ts` now pops a platform menu driven by Electron's `editFlags`: `Copy`/`Select All` on selected output text, the full `Cut`/`Copy`/`Paste`/`Select All` set in editable fields (enabled per the DOM edit state), and `Open Link`/`Copy Link` when the target is a URL. No `electron-context-menu` dependency — kept inline since the menu only needs the standard roles.

## [0.3.21] — 2026-04-18

Quieter notifications: macOS banners that pile up in Notification Center while the app is in the background now get dismissed the moment you focus the window. Installers remain **unsigned**.

### Changed

- **Notifications auto-dismiss when the app regains focus** (`8b325c6`). Previously, every task-complete / permission-request notification stayed in Notification Center until the user manually swiped them away, even after they came back to GreyChrist. The per-notification `showNotification` closure in `electron/main.ts` was extracted into a dedicated `electron/services/notifications.ts` service that tracks each active Electron `Notification` instance and exposes `dismissAll()`. The existing `mainWindow.on('focus')` handler — which already clears the dock badge — now also calls `dismissAll()`, so outstanding banners clear as soon as the user is looking at the app. The sound-when-focused / notification-when-not split is preserved, as is the click-to-focus behavior. +10 tests.

## [0.3.20] — 2026-04-18

Fix for stale context-usage numbers after compaction. Installers remain **unsigned**.

### Fixed

- **Context-usage popover refreshes after compaction** (`67d47cb`). The session header popover pulled authoritative numbers from the Agent SDK's `query.getContextUsage()`, but only re-fetched on session init and end-of-turn `result` messages. A `/compact` (manual or auto) moved the SDK's internal context to the compacted state, but the popover kept showing the pre-compaction numbers until the next full turn finished. `ClaudeCodeSession` now listens for `system` messages with `subtype: 'compact_boundary'` and fires a fresh `sessionContextUsage` fetch inline, so `totalTokens`, `maxTokens`, and the per-category breakdown reflect the post-compaction state immediately.

## [0.3.19] — 2026-04-17

Small compact-mode UX win: the current todo list now stays pinned at top level instead of hiding inside a collapsible group summary. Installers remain **unsigned**.

### Changed

- **Compact mode keeps the live todo list visible** (`e583dbc`). The most recent `TodoWrite` tool_use is now promoted to a top-level single item in compact mode, so an in-flight task list renders as the full `TodoWidget` card instead of being collapsed behind an `Updated todos (N)` summary row. Only the latest `TodoWrite` is promoted — earlier, superseded snapshots stay collapsed so the scrollback doesn't stack obsolete lists. Grouping logic extracted into a pure `buildCompactItems` helper in `src/lib/compactGrouping.ts` (with `isBoundaryMessage` moved alongside it) and unit-tested. +10 tests.

## [0.3.18] — 2026-04-17

Bug-fix follow-up to 0.3.17's auto-scroll work: the "Plotting…" thinking indicator no longer scrolls off the bottom of the viewport. Installers remain **unsigned**.

### Fixed

- **Thinking indicator stays pinned to the bottom during streaming** (`52cce9c`). The loading and error indicators in `ClaudeCodeSession` were DOM siblings rendered *after* the `contentRef` wrapper that holds the messages and the `messagesEndRef` marker. `scrollIntoView(messagesEndRef, block: 'end')` only scrolled the end of the message list into view, leaving the indicator below the viewport after every new message. The `ResizeObserver` on `contentRef` also missed indicator height changes (first appearance, token count digit growth, activity gerund updates), so no compensating scroll fired. Moved both indicators inside `contentRef`, ahead of `messagesEndRef`, so the scroll target is truly last and the observer covers the indicator subtree — the viewport now tracks the real bottom of the scroll area.

## [0.3.17] — 2026-04-17

Session view gains a Compact/Verbose toggle and "Execution Complete" cards are reconstructed for resumed sessions. Installers remain **unsigned**.

### Added

- **Compact/Verbose toggle in the session header** (`1d89776`, `19951b8`, `e0f674b`, `47b85ea`, `bb678a1`). Verbose renders every message fully (unchanged). Compact groups intermediate turn steps — tool_use assistants, tool_result replies, thinking, system events — into a single collapsible row summarized by per-tool actions (e.g. `2 thoughts + Read foo.ts · Edited bar.ts · Ran: npm test`). User prompts, final Claude responses (`stop_reason: end_turn` or text-only content), Execution Complete cards, and permission requests always render fully. Expanded groups sit under a left rule with `pl-8` indent. Long summaries wrap instead of truncating. Compact is the default; no persistence across restarts.
- **Synthetic "Execution Complete" cards on reloaded sessions** (`e0d548d`). The Claude CLI's JSONL does not persist live SDK `result` messages, so resumed sessions never rendered the green end-of-turn card. A pure `synthesizeResultMessages(messages)` helper now walks the loaded array, finds turn boundaries (user text prompt through an assistant with `stop_reason: end_turn`), and splices a synthetic result entry carrying the real wall-clock duration, turn number, per-turn token usage, and a cost computed from the same `$3/M input + $15/M output` rates the live session uses. Intermediate `tool_use` assistants and tool_result-only user messages are ignored so mid-turn steps don't get mis-flagged as failures. Truncated/incomplete turns produce no card rather than a misleading "Execution Failed" one. Live sessions are untouched — real result messages from the SDK take precedence. +5 tests.

### Changed

- **Vitest config runs `src/**/*.test.ts`** with an `@ → src` alias, so renderer-side pure helpers (starting with `synthesizeResultMessages`) get unit-tested in the node env alongside existing electron service tests.

## [0.3.16] — 2026-04-17

Architecture-audit cleanup release: closes the full Wave 5 punch list (10 items across three batches), plus a session-UX polish pass (auto-scroll stickiness, permission-dialog layout) and the removal of Greg's hardcoded updater path so non-Greg installs no longer seed a broken default. Installers remain **unsigned**.

### Added

- **`agentsService.exportAgentToFile(id, filePath)`** with matching IPC channel `export_agent_to_file`, preload allow-listing, and a typed `api.exportAgentToFile` wrapper (`48e26af`). Replaces the silently-rejected direct `window.electronAPI.invoke('export_agent_to_file', …)` calls in `CCAgents.tsx`, `Agents.tsx`, and `AgentsModal.tsx`.
- **`reveal_path_in_finder` IPC handler** wrapping `shell.showItemInFolder`, with a typed `api.revealPathInFinder` wrapper (`48e26af`). `ClaudeVersionSelector.tsx` migrated off the direct invoke.
- **Typed agent-run event helpers** in `src/lib/api.ts`: `onAgentOutput`, `onAgentError`, `onAgentComplete`, `onAgentCancelled` (`9df9115`). Three components migrated off `window.electronAPI.onEvent('agent-*:${id}', …)` direct calls.
- **Actionable error message for better-sqlite3 ABI mismatches** (`0049bce`). `createDatabase()` now catches the cryptic `NODE_MODULE_VERSION` failure and re-throws with a "run `npm run rebuild:electron`" hint. +3 tests.
- **Test-only `runMigrations(db, migrationsOverride?)` parameter** (`0049bce`) so the migration runner can be exercised against synthetic migrations without landing a real schema change. +3 tests covering apply/skip/rollback semantics.

### Changed

- **Sessions pass `strictMcpConfig: true`** to the SDK (`48e26af`). Malformed MCP configs now surface as startup errors instead of silent warnings. Matches the behaviour `agents.ts` already had.
- **Hooks accessors require `configDir` explicitly** (`48e26af`). `getHooksConfig(user)`, `updateHooksConfig(user)`, and `getMergedHooksConfig` now throw a clear error at the surface instead of implicitly falling back to the SDK's default `~/.claude` resolution. The renderer-side `api.getHooksConfig` / `updateHooksConfig` / `getMergedHooksConfig` signatures now accept `configDir`, and `Settings.tsx` threads the account-resolved dir through `HooksSettings` → `HooksEditor`. This fixes user-scope hook saves, which had been broken since commit `07178d9` landed the underlying throw.
- **`local_update_dir` default is no longer hardcoded to Greg's machine** (`9df9115`). `main.ts` now gates the first-run default on `app.isPackaged`: dev runs default to `path.join(process.cwd(), 'out', 'make')`, packaged installs default to empty. Non-Greg installs no longer get a broken default seeded into their DB.
- **Auto-scroll in `ClaudeCodeSession`** (`e37da51`). Widened near-bottom thresholds (400 px engage / 800 px disengage), switched streaming scroll to `behavior: 'auto'` to stop lag-compounding during rapid SDK message bursts, and added a `ResizeObserver` on the content wrapper so in-place height changes (syntax-highlighting completing, images loading, long diffs finalising) trigger scroll even when no new message arrives. Sending a new prompt now force-engages stickiness so the view follows new activity.
- **Permission dialog rule text wraps on long paths** (`b406d70`). Swapped `truncate` for `break-all` on the rule-row display so `Edit(/very/long/path/…)` flows onto multiple lines inside the rule box instead of stretching the whole dialog beyond its `sm:max-w-lg` cap.
- **Updater writes a debug log entry** when `local_update_dir` is populated but unreadable (`0049bce`). Silent when the setting is empty/disabled.

### Fixed

- **Usage service no longer silently swallows IO errors** (`9df9115`). `createUsageService` accepts an optional `LoggingService`; readdirSync / readFileSync failures in `scanConfigDir` and `readJsonlFile` write `warn`-level entries (source `usage`) with the path + error message. Per-line JSONL parse failures stay silent by design. +2 tests.
- **Permission queue test coverage** in `permissions.ts` (`0049bce`). Added tests for the queued-next-permission path in `respondPermission` and for `setAutoAllow` / `addAutoAllowTool` state mutations. `permissions.ts` coverage: 57% → 78%.

### Removed

- **Direct `window.electronAPI.invoke(…)` / `onEvent(…)` calls for several channels** in feature components. Four P0 "unreachable IPC" calls (`export_agent_to_file`, `reveal_path_in_finder`, `write_file`) and twelve direct `agent-*:${id}` event subscriptions now go through typed `src/lib/api.ts` wrappers.

## [0.3.15] — 2026-04-17

Thinking cards in interactive sessions show summary text again. Installers remain **unsigned**.

### Fixed

- **Empty "Thinking…" cards in the session UI.** The Claude Agent SDK defaults `showThinkingSummaries` to `false`, which makes the underlying CLI send the `redact-thinking` beta header to the API — thinking blocks then arrive signature-only with empty `thinking` text, so the session UI rendered bare "Thinking…" cards with no body. GreyChrist now passes `settings: { showThinkingSummaries: true }` to the SDK so thinking blocks come back with summary text populated. `StreamMessage` also skips rendering `ThinkingWidget` when a block has no text, as a safety net for any residual signature-only blocks (e.g., older resumed sessions).

## [0.3.14] — 2026-04-17

Sessions now use the full Claude Code CLI system prompt, and app settings persistence is fixed for newly-introduced keys. Installers remain **unsigned**.

### Added

- **`systemPrompt: { type: 'preset', preset: 'claude_code' }` on interactive sessions.** The Claude Agent SDK ships a minimal default prompt; without this option, GreyChrist sessions lost the plan-first / ask-clarifying-questions / tool-use conventions of the Claude Code CLI. Paired with the already-enabled `settingSources`, sessions now behave like `claude` in a terminal. Custom agent runs (`electron/services/agents.ts`) are unaffected — they continue to use their own `system_prompt` string.
- **`ensureDefaultSettings(db, defaults)` helper** in `electron/services/database.ts`. Seeds first-run values into `app_settings` without clobbering user-edited values. An empty string counts as user-set ("deliberately cleared"); only truly-missing keys get the default. Called from `main.ts` on app startup.

### Fixed

- **`getSetting` / `saveSetting` persistence for new keys.** The renderer's `api.saveSetting()` previously went through `storageUpdateRow`, which silently no-op'd when the row didn't exist — so any newly-introduced setting never made it to disk on its first write. Both helpers now use the dedicated `get_setting` / `save_setting` IPC channels, which hit `db.getSetting` / `db.saveSetting` directly (the latter is `INSERT ... ON CONFLICT(key) DO UPDATE`). The localStorage fast-path is preserved.

## [0.3.13] — 2026-04-16

Updater switched from GitHub release polling to a local-folder scan. Installers remain **unsigned**.

### Changed

- **Updater now reads a local folder** for newer `GreyChrist-<semver>-arm64.dmg` builds instead of polling `api.github.com`. The folder path is a new `local_update_dir` app setting, configurable under Settings → General → "Update Source Folder". Empty setting disables update checks entirely. The setting is read lazily on every check, so changes take effect without restarting the app.
- **`downloadUpdate` is now a no-op** — the DMG is already on disk, so there's nothing to fetch. Fires a single `onProgress({ percent: 100 })` so the renderer's existing progress-bar UI completes naturally.
- **Updater public types (`UpdateInfo`, `UpdaterService`) unchanged**, so the renderer and IPC surface didn't need to move.

### Removed

- **GitHub REST polling from the updater** (`api.github.com/repos/.../releases`), the `getToken` / `github_token` dep, and the `downloadsPath` option — none are meaningful for a local-only flow.

## [0.3.12] — 2026-04-16

Effort-level alignment with the Claude Agent SDK, session-bar refinements, an SDK bump to 0.2.112, and removal of all GitHub Actions workflows in favor of local-only releases. Installers remain **unsigned**.

### Removed

- **All four GitHub Actions workflow files** (`ci.yml`, `release.yml`, `claude.yml`, `claude-code-review.yml`). GreyChrist is a solo project; CI/automated releases weren't earning their Actions-minute cost. Releases are now built locally (`npm run make`) and uploaded via `gh release create`.
- **Vitest coverage thresholds** (`vitest.config.ts`). Coverage still reports on `npm run test:coverage`; it just doesn't gate anything anymore.

### Added

- **Session-bar pill labels and dividers** — `permissions` / `effort` / `adaptive` labels before each pill, plus thin vertical dividers between groups, so the three session modes are readable at a glance instead of bare short codes.
- **`xhigh` effort level** — the SDK has supported `xhigh` (Opus 4.7 only, falls back to `high` elsewhere) since early `0.2.x`; it's now exposed in the effort picker alongside `low`/`medium`/`high`/`max`.
- **Session-less SDK model catalog lookup** — reads the SDK's model descriptors without needing a live session (`d8c979c`).

### Changed

- **EffortLevel matches the SDK 1:1** — `low / medium / high / xhigh / max`. The renderer-only `auto` sentinel is gone; default effort is now `high`, matching the SDK's own default per `sdk.d.ts`.
- **Session-bar pills color-coded** — permissions/effort/adaptive pills use the same icon + shortName + color palette as the chat-bar selectors (one source of truth). Effort uses a cool→warm gradient: low=blue, medium=green, high=yellow, xhigh=orange, max=red.
- **Permissions pill visually matches the chat-bar `PermissionPicker`** — same icon, shortName, and color; imports from `ControlBar.PERMISSION_MODES` so they never drift.
- **Git branch moved to the project header** — renders right after the project path instead of in the session chrome; branches belong to the project, not to a single session.
- **`@anthropic-ai/claude-agent-sdk`** bumped from `0.2.110` → `0.2.112`.

### Fixed

- **`xhigh` type narrowings** — `src/lib/api.ts`, `electron/services/sessions/types.ts`, and `electron/services/sessions/queries.ts` all had stale effort-level unions missing `xhigh` and were silently dropping it. Now aligned with the SDK's `EffortLevel` type.

## [0.3.0] — 2026-04-10

First release under the **GreyChrist** name. Ships a full rewrite from Tauri (Rust) to Electron (Node.js/TypeScript), complete multi-account Claude Code orchestration, and a persistent interactive session model. First installers are **unsigned**.

### Added

**Multi-account Claude Code orchestration**
- Manage multiple Claude accounts (e.g. personal vs work) with separate `CLAUDE_CONFIG_DIR` paths.
- Path-prefix rules resolve a project to an account; explicit per-project overrides take precedence.
- Account-aware everything: project listing, session history, usage aggregation, process launching, checkpoint storage, slash commands, and MCP config.
- Account picker when no rule matches — no silent fallback to `~/.claude`.
- "Explain resolution" UI shows which rule matched and why.
- Account badge in the active session header and project list.
- Editable accounts with folder pickers and per-account `claude_binary` override (supports VS Code extension installs).
- Account types (`max`, `enterprise`, `pro`, `free`); `max` accounts show zero cost in usage stats.

**Interactive sessions (persistent stream-JSON)**
- Multi-turn sessions via the `@anthropic-ai/claude-agent-sdk` `query()` API running in the Electron main process.
- Structured + plain user messages, streaming output, and mid-turn interruption.
- Interactive permission prompts for tool use — approve/deny with optional input editing.
- Per-session auto-allow list for repetitive tools.
- Permission mode toggle in the prompt bar (default / accept-edits / plan / bypass).
- Session resume from previous session id.

**Notifications + badges**
- Native OS notifications on session completion (macOS, Linux, Windows).
- Dock badge with unread counter that clears on window focus (macOS).
- In-app notification event for tab badge handling on non-active tabs.

**IPC security**
- Strict allow-list for `window.electronAPI.invoke` channels in the preload layer.
- Event channel prefix allow-list (`session-`, `agent-output:`, `claude-stream`, `backend-log`, …).

**UI**
- Rebrand from Opcode to GreyChrist across all surfaces (README, icons, bundle id, app name, titlebar).
- Full new icon set at multiple sizes.
- Purple user message bubbles, Opus default, thinking-mode toggle in new session.
- Always-visible session header with account info and cost.
- Session start confirmation panel showing the resolved account and match reason.
- Project settings tab per project (`.claude/settings.json` editing).
- Settings → permissions tab now account-aware.

**Testing + verification**
- 288 Vitest tests covering services, IPC handlers, sessions, and agents.
- Coverage at 94% lines overall, enforced via `vitest.config.ts` thresholds (lines/functions/statements ≥ 90%, branches ≥ 70%).
- `pretest` / `pretest:coverage` hooks that rebuild `better-sqlite3` against the current Node ABI so `npm test` Just Works after `electron-forge start` rebuilds for Electron's ABI.

**Developer experience**
- `ci.yml` GitHub workflow: TypeScript check, Vitest tests, and renderer bundle build across Linux/macOS/Windows on every push and PR, replacing the old Tauri/Rust dual workflows. Cross-platform CI catches regressions cheaply even though only macOS is shipped.
- `release.yml` GitHub workflow: tag-triggered (`v*.*.*`), runs the full coverage gate then `electron-forge make` on `macos-latest` (Apple Silicon) to produce an unsigned `.dmg` + `.zip`, and publishes a draft GitHub Release with the CHANGELOG body attached.
- Repo-local commands in `.claude/commands/`: `/verify`, `/commit`, `/resume`, `/account-trace`.
- Updated `CLAUDE.md`, `src/CLAUDE.md`, and `AGENTS.md` describing the Electron architecture.

### Changed

- **Runtime:** Migrated from Tauri 2 (Rust) to Electron 41 (Node.js/TypeScript). The Claude Agent SDK requires `child_process` / `fs` APIs that aren't available in a Tauri WebView context.
- **Backend language:** All services rewritten from Rust in `src-tauri/` to TypeScript in `electron/services/`. Same public API surface; the frontend `src/lib/api.ts` shape is unchanged.
- **Database:** Migrated from `rusqlite` to `better-sqlite3`. Schema and tables unchanged (`agents`, `agent_runs`, `accounts`, `account_path_rules`, `project_account_overrides`, `app_settings`, `app_logs`).
- **Build:** `electron-forge` + `@electron-forge/plugin-vite` replaces `just` + `cargo tauri build`.
- **Checkpoint subsystem:** Now account-scoped through the command layer rather than a global `~/.claude` dir.
- **Usage tracking:** Aggregates across all configured account config dirs.
- **No silent fallbacks:** Removed every `~/.claude` fallback. Every operation must resolve to an explicit account.

### Fixed

- Project path display for directories containing hyphens.
- Tilde path matching in account path rules.
- Account adapter param name mismatches (camelCase vs snake_case).
- Dialog return shapes and error dialog suppression.
- Stream message deduplication (assistant message no longer duplicated when the result card shows the same text).
- IME composition handling across input components.
- Light-theme code/bash block styling.
- Stdin piping warnings polluting the error display.
- Spinner deadlock in session start.
- Electron startup with nested `require()` in ESM context.

### Removed

- All Rust / Tauri code (`src-tauri/`).
- Web server mode (`greychrist-web` / Axum) — never shipped; Electron is the only target.
- `justfile`, `shell.nix`, `.cargo/`, `bun.lock` / `bun.lockb`, `scripts/fetch-and-build.js` references.
- `web_server.design.md` (design doc for the never-shipped web mode).
- Dead `build:executables:*` scripts.
- `--dangerously-skip-permissions` flag from Claude sessions — replaced by the interactive permission prompt flow.
- Analytics.

### Security

- Preload channel allow-list prevents the renderer from invoking arbitrary IPC channels.
- `openExternal` validates protocol is `http:` / `https:` before delegating to the shell.
- Custom `greychrist-file://` scheme is registered as privileged but used only for local file reads by the renderer (no remote resolution).

### Known limitations

- **macOS-only release.** v0.3.0 ships Apple Silicon (`arm64`) only. Intel macOS, Linux, and Windows are out of scope for the foreseeable future. Intel support would require adding a `macos-13` entry to the release matrix; Linux/Windows would require re-introducing cross-platform release builds.
- **Unsigned build.** The `.dmg` is not notarized. macOS Gatekeeper will block the first launch — right-click the app → Open → confirm the "unidentified developer" warning. Signing + notarization will be wired in once the Apple Developer ID is set up.
- A handful of service files (`claude-binary.ts`, `slash-commands.ts`) sit in the 80–88% line coverage range rather than the 90%+ target. Raised in a follow-up.

[0.3.0]: https://github.com/greychrist/GreyChrist/releases/tag/v0.3.0
[0.2.0]: https://github.com/greychrist/GreyChrist/releases/tag/v0.2.0
