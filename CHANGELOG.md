# Changelog

All notable changes to OmniFex (formerly GreyChrist) are documented in this file. The app was renamed from GreyChrist → OmniFex in v0.4.2; "GreyChrist" remains the LLC/company name. Earlier entries refer to the app under its prior name.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.50] — 2026-05-21

The renderer's idle-CPU regression turned out to NOT be Framer Motion. This release lands the actual root cause plus supporting fixes for missing log diagnostics and a Claude Code 2.1.146 TUI compatibility break.

Installers remain **unsigned**.

### Fixed

- **Renderer no longer burns 100%+ CPU at idle (actually, this time).** 0.4.49's note attributed the idle-CPU loop to a stale `framer-motion` alpha and bumped to 12.39.0 — that bump was a no-op for the underlying bug. Profiling under the new SDK showed `performWorkUntilDeadline` at 58% self time and a tower of React scheduler `postMessage` frames: classic continuous-re-render symptom. Root cause: `TabContent` passes inline arrow closures for callback props (`onProjectPathChange`) on every render, and `TabContext.updateTab` always allocated a new tabs array + new `updatedAt: new Date()` even for no-op updates. `ClaudeCodeSession`'s `useEffect(..., [onProjectPathChange, projectPath])` therefore re-fired on every parent render → called the prop → updated context state → re-rendered the parent → … Two fixes: ref-capture the callback (mirroring the existing `onStreamingChange` pattern in the same file) so the effect keys on `projectPath` only, and make `updateTab` idempotent when every updated field already equals the existing value so future mistakes can't self-amplify.
- **`/usage` panel updates again under Claude Code 2.1.146.** The pty screen-scraper waited for `"shift+tab to cycle"` in the TUI welcome banner; 2.1.146 lays out the banner with cursor-positioning ANSI escapes instead of literal spaces, so after `stripAnsi` the marker arrived as `"shift+tabtocycle"` and never matched. Every usage poll timed out silently. The matcher now normalizes whitespace on both sides; the trust-dialog matcher gets the same treatment.
- **Renderer log entries now include real error messages.** `logService.captureConsole` serialized log args via `JSON.stringify`, which drops `Error.message` and `Error.stack` because they're non-enumerable — so every caught exception logged as `{}`. Format `Error` instances explicitly at the top level, and use a JSON replacer so nested Errors also surface. (Without this we couldn't see what was throwing in the render loop above.)

### Changed

- **`@anthropic-ai/claude-agent-sdk` 0.3.145 → 0.3.146.** Patch bump for parity with Claude Code v2.1.146. Notable upstream fix: uncaught exception at the end of streaming sessions when running via the Agent SDK.

### Removed

- **Dead `onBack` / `onProjectSettings` props on `ClaudeCodeSession`** plus the unused `SessionHeader` component they fed. The props were declared in `ClaudeCodeSessionProps` and force-passed by `TabContent`, but `ClaudeCodeSession` never destructured or invoked them — the only consumer was `SessionHeader`, which is itself never rendered anywhere. -199 lines.

## [0.4.49] — 2026-05-19

Major idle-CPU regression fix in the renderer, plus a few small features and dep bumps.

Installers remain **unsigned**.

### Fixed

- **Renderer no longer burns 100%+ CPU at idle.** Performance profiling traced the burn to Framer Motion's per-frame animation loop (`safeToRemove` / `startAnimation` / `initAnimation` calls running indefinitely) — we were pinned to a year-old `12.0.0-alpha.1`. Bumping to the current stable `12.39.0` makes the loop park when nothing's actively animating. Before/after traces show the dominant function dropping from **92.3%** of total execution time to under 3%. No code changes required.

### Added

- **Copy-image button on chat images.** Hover any image in a chat session to reveal a small toolbar at top-right; the existing Download button is now joined by a Copy button that writes the image straight to the system clipboard. JPEG/WebP sources get re-encoded as PNG via an offscreen canvas first because Chromium's clipboard is only reliable for `image/png`.

### Changed

- **Chevron toggles on TaskList, SubagentBar, and the agent-question card** now wear the same `rounded-md border border-border bg-background` shape as the chat copy buttons, so the toggles read as obviously interactive. Click region on TaskList and SubagentBar stays wide (the styled span is purely visual; the parent button still handles the click).
- **`@anthropic-ai/claude-agent-sdk` 0.3.144 → 0.3.145.** Patch bump for parity with Claude Code v2.1.145. Permission-bypass fixes and MCP prompt error-handling improvements flow through without code changes on our side.

### Accessibility

- **Image lightbox now has a screen-reader title.** Silences Radix's "DialogContent requires a DialogTitle" warning. Uses the image's `alt` text, falls back to "Image preview".

## [0.4.48] — 2026-05-19

A fresh OmniFex install no longer dead-ends new users at an empty account picker.

Installers remain **unsigned**.

### Added

- **Auto-discovery of `~/.claude*` config directories on first launch.** Previously, a fresh install opened with zero accounts. The moment a user tried to open a project, `AccountPickerDialog` appeared with an empty list of accounts — the only path forward was Settings → Accounts → manually type a config path. (The `discoverAccounts` IPC was wired end-to-end but had no UI caller.) Now on Electron main boot, if there are no accounts and the new `discovery_completed` app_setting is unset, the main process scans `$HOME` for `.claude*` dirs and creates one Account row per match. Names derive from the dir name (`.claude` → "Claude", `.claude-work` → "Work", `.claude-side_project` → "Side Project"). Users can rename freely in Settings.
- **"Scan for `~/.claude*` dirs" button in Settings → Accounts.** Manual escape hatch for adding a new config directory after first launch — useful when a user installs OmniFex first, then later creates a `.claude-work` and wants to import it without typing the path. Skips any directory whose `config_dir` already matches an existing account.

### Notes on intentional non-behavior

- **Resolution semantics are unchanged.** `AccountsService.resolve()` still goes override → longest path rule → null. Discovery only populates the picker so it isn't an empty void; it does not designate a default account, create path rules, or pick for the user.
- **One-and-done discovery.** The `discovery_completed` flag prevents silent re-creation if a user later deletes accounts in Settings. Use the Scan button to re-import.

## [0.4.47] — 2026-05-18

Claude Agent SDK patch bump.

Installers remain **unsigned**.

### Changed

- **`@anthropic-ai/claude-agent-sdk` 0.3.143 → 0.3.144.** Assistant messages and `StopFailure` hooks now report `error: 'model_not_found'` instead of the generic `'invalid_request'` when the selected model isn't available; users get a cleaner error string with no app code changes needed. The other change in 0.3.144 (a new `extract` export for `bun build --compile` consumers) doesn't apply to us.

## [0.4.46] — 2026-05-17

Dependency bumps from Dependabot's first sweep on the public repo, plus the in-flight verification cut for the cache-bust fix from v0.4.45 — a click on the update-check button in v0.4.45 should detect this release without needing a restart.

Installers remain **unsigned**.

### Changed

- **Dependency updates** addressing CVEs flagged by Dependabot:
  - `hono` 4.12.12 → 4.12.19 (CSS declaration injection in JSX SSR)
  - `postcss` 8.5.9 → 8.5.14 (XSS via unescaped `</style>` in CSS stringify)
  - `fast-uri` 3.1.0 → 3.1.2 (host confusion via percent-encoded delimiters)
  - `@xmldom/xmldom` 0.8.12 → 0.8.13 (XML injection through unvalidated DocumentType serialization)
  - `ip-address` + `express-rate-limit` (transitive bumps)

### Known remaining

`tar` (dev-only, deep transitive in Electron Forge), `prismjs` (no compatible upgrade on the pinned range), `@tootallnate/once`, and `tmp` still have open Dependabot alerts without auto-fix PRs. None affect user-facing code at runtime; addressing them requires manual upgrade investigation.

## [0.4.45] — 2026-05-17

Two fixes to the in-app updater that surfaced during v0.4.43 → v0.4.44 testing.

Installers remain **unsigned**.

### Fixed

- **Manual update check no longer returns stale "up to date" right after a publish.** GitHub's CDN caches `releases/latest` for ~60s; clicks within that window after a new release would silently miss the upgrade. The fetch now appends `?_=<timestamp>` so the cache key differs on every check, and sends `Cache-Control: no-cache` so any intermediary revalidates.
- **Download no longer auto-installs.** When the download finished, the updater would immediately call `runInstall`, blowing past the "Install Update" affordance the UI was supposed to surface. The user now has to click "Install Update" deliberately to proceed.

## [0.4.44] — 2026-05-17

End-to-end verification release for the GitHub-Releases-based in-app updater introduced in v0.4.43. No functional code changes. Existing v0.4.43 installs should see this build, download the `.zip` asset, and prompt to install.

Installers remain **unsigned**.

### Changed

- Bump version to exercise the v0.4.43 auto-update path.

## [0.4.43] — 2026-05-17

The in-app updater now polls the public GitHub repo for new releases. The previous local-folder scanner is gone; manual builds still install via drag-from-DMG.

Installers remain **unsigned**.

### Changed

- **Updater switched to GitHub Releases as the sole update source.** OmniFex now polls `GET /repos/greychrist/omnifex/releases/latest` (anonymous, ~60 req/hr/IP) and streams the matching `OmniFex-darwin-arm64-<version>.zip` asset to `$TMPDIR` with real progress events; downloads follow GitHub's CDN redirects. The previous local-folder scanner (`local_update_dir` setting, "Update Source Folder" section in General settings) was removed along with its pickFolder helper. Existing `local_update_dir` rows in `app_settings` are now orphaned and harmless — nothing reads the key.
- **README rewritten for the current Electron architecture.** Was still pre-migration Tauri/Rust content under the old GreyChrist name. Now reflects multi-account routing, sessions on the Agent SDK, custom agents via CLI, MCP management, usage analytics, and CLAUDE.md / hooks editing. Install instructions point at the Releases page; build instructions use Electron Forge (`npm start` / `npm run make`).
- **Titlebar byline now reads "by GreyChrist"** (was "by GreyChrist, LLC"); the LLC suffix is retained where it's legally required (LICENSE if/when added) but not on user-visible chrome.

### Note for v0.4.42 users

This is the first OmniFex build with the GitHub-based updater, so the v0.4.42 → v0.4.43 step is a one-time manual drag-install from the `.dmg`. From v0.4.43 forward, the in-app updater handles future versions automatically.

## [0.4.42] — 2026-05-16

Fixes a long-standing chat annoyance where selecting text inside a syntax-highlighted code card would silently deselect on the next incidental re-render — so dragging across a code block to copy a value often "fought back."

Installers remain **unsigned**.

### Fixed

- **Text selection inside Prism-highlighted code cards no longer deselects on re-render.** `StreamMessage` rebuilt `syntaxTheme`, `mdComponents`, and `[remarkGfm]` on every render, and `ClaudeCodeSession` handed every message card a fresh `onResend` arrow each render. `ReactMarkdown` saw new props → `react-syntax-highlighter` produced brand-new `<span>` DOM nodes → the browser dropped any active text selection anchored on them. Memoized `syntaxTheme`/`mdComponents`, hoisted `[remarkGfm]` to a module constant, and stabilized `onResend` with `useCallback` so `React.memo` on `StreamMessage` actually holds.

## [0.4.41] — 2026-05-15

Fixes a slash-command input quirk where typed commands took an extra Enter to clear.

Installers remain **unsigned**.

### Fixed

- **Slash command no longer needs three Enters.** After picking a command, AnimatePresence kept the `SlashCommandPicker` mounted briefly for its exit animation, and its window-level Enter listener re-fired `onSelect` on the next keypress — repopulating the textarea after the send and forcing a third Enter to clear it. The picker now guards its window listener with an `isClosedRef` so it bails out after the first Enter/Escape.

## [0.4.40] — 2026-05-15

Card chrome cleanup. The top-right copy button on every message card is now an always-visible outlined toolbar instead of three near-identical hover-revealed buttons that had drifted apart, and the one on Execution Complete cards finally works. Also picks up the latest Claude Agent SDK patch.

Installers remain **unsigned**.

### Changed

- **One shared `CardActionBar` for every message card.** Three near-identical implementations (`CopyCardButton`, `UserMessageActions`, and the debug copy chip in `MessageCard`) had drifted: only the user-message variant gave clean checkmark feedback, the assistant variant fired a separate floating "Copied" toast, and the result-card variant silently no-op'd because its copy helper only walked `content` while result messages keep their body on `result` / `errors`. Consolidated to one `CardActionBar` plus a shared `extractCopyText` (`src/lib/messageCopy.ts`) that handles both shapes, with checkmark-only feedback and an `extras` slot for the user-message Resend button so every action reads as one family.
- **Header → content gap on every card.** `KindHeader`'s built-in margin bumped from `mb-1` (4px) to `mb-3` (12px) so cards have proper breathing room between the header label and the body content. Single source of truth for that spacing now lives on the header element itself.
- **Lima page restyled to match the Sessions popover card grammar.** VM rows and container tiles now use the same two-zone shell as `TabStatusCard` (tinted header strip with status pill + name, body grid below with `HeaderLabel` left-col + value pills). Status reads as a green/amber/red/muted pill instead of a plain colored dot, with a pulsing dot inside the pill for transient states (`Starting…`, `Stopping…`, `Restarting`). Stopped VMs now wear a red pill — same palette as Broken/Error.
- **Claude Agent SDK bumped to `0.3.143`.** Patch release that moves `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` from `dependencies` to `peerDependencies`. Both are still bundled at runtime; npm auto-installs peer deps, so nothing in OmniFex needed adjustment.

### Fixed

- **Copy button on Execution Complete / Execution Failed cards** now actually copies. Was a silent no-op since the helper looked only at `msg.content` (the assistant/user content-block array), but result messages keep the body on `msg.result` (success) or `msg.errors[]` (error). The unified extractor checks the result shape first.

## [0.4.39] — 2026-05-15

Lets you pick which sound plays when a task finishes. Small surface change; everything sits inside Settings → General.

Installers remain **unsigned**.

### Added

- **User-selectable notification sounds.** New Notification Sounds section in Settings → General with two pickers — one for task-success and one for task-failure — backed by a 16-entry catalog: the bundled OmniFex chime, 14 macOS system sounds (Basso, Blow, Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr, Sosumi, Submarine, Tink), and "No sound". Each picker has a play-test button next to it; changing a sound auto-previews the new pick. "No sound" makes the OS notification fully silent and skips the in-window `afplay` when the app is focused. Choices persist as `notification_sound_success` / `notification_sound_error` in `app_settings` and are read per-call, so changes take effect on the next notification without a restart.

### Changed

- **Notifications service deps simplified.** The previous `getSoundPath(isError)` dep plus the hard-coded `'greychrist_success'` / `'Basso'` sound strings collapsed into one `resolveSound(isError) → { afplayPath, nativeName }` resolver, called once per notification so the DB lookup happens lazily. Notifications honor `silent: true` when the resolved native name is `null`.

## [0.4.38] — 2026-05-15

Big release built around treating the SDK 0.3.x **Task primitive** as a first-class UI feature instead of a flat todo counter, plus a backend half for the long-broken `@`-mention file browser. Two follow-ups to the 0.4.37 wire-shape fix close a stderr-noise regression and the FilePicker's missing IPC handlers.

Installers remain **unsigned**.

### Added

- **Task List panel — replaces the legacy TodoBar.** Each `TaskCreate` becomes its own row at the bottom of the chat with a status icon (`pending` / `in_progress` / `completed`), the subject (or `activeForm` while in_progress), a message-count badge, and an inline expander that shows the messages emitted while that task was being worked on — mirroring `SubagentBar`'s row treatment. Collapsed header shows three pills ("X/Y done", "N in progress", "M pending") with a spinner while anything is non-terminal. The expanded panel grows upward from the header (drawer-style), capped at 50vh.
- **Per-task message attribution.** Because the SDK's new Task primitive doesn't ship per-task progress events the way the older Task tool subagent path does, the renderer infers attribution: any message emitted while a task is in_progress belongs to that task; otherwise the message belongs to the earliest non-terminal task in the queue (handles the common "batch TaskCreates up front, do work, mark complete one by one without ever calling in_progress" agent style). Structural Task* tool_uses and their tool_results are filtered out so the panel never renders meta-rows about itself.
- **FilePicker file-listing + search backend.** `electron/services/filesystem.ts` provides `listDirectoryContents(path)` and `searchFiles(basePath, query)` — dotfiles hidden by default, dirs-first sort, recursive search capped at 200 results / depth 8 with dot-prefixed dirs pruned. Wired through `electron/ipc/handlers.ts`, `electron/preload.ts`'s allow-list, and `electron/main.ts`. The `@`-mention file browser in chat input now actually loads (previously errored with `Blocked IPC channel: list_directory_contents` because the renderer surface had been added back in 2025-06 but the main-process half never landed).

### Changed

- **`TabStatusSummary.todos` renamed to `tasks` at the IPC boundary.** Carries through to `TabStatusPopover`'s label ("X of Y tasks") and to the spinner-gate field in `ClaudeCodeSession`. Wire format and popover labels both updated in lockstep.
- **TaskList header anchors at the top of its block, panel below.** The first cut rendered the expanded panel above the header so the "drawer expands upward" sense came from CSS order, but in practice that made the header (the drawer handle) jump position when clicked. Switched to the SubagentBar pattern — header on top, panel below in DOM order — so the chat content above shrinks and the header visually slides UP as the panel reveals, with the handle staying put relative to the content.

### Fixed

- **CLI-internal hook-callback noise no longer surfaces as a red Log row at every session start.** Under SDK 0.3.x the CLI fires one of its own numbered hooks (a pending-tasks system-reminder injector tied to the new Task* tools) on every session start; it calls back via `sendRequest` after the SDK input channel has already closed and the bun runtime dumps a multi-line source-context block. Bun chunks that dump across multiple stderr writes, so my first attempt (matching the leading `Error in hook callback hook_\d+` line only) demoted the head but let the trailing `error: Stream closed\n at sendRequest (/$bunfs/…)` chunk slip through to a red row. Broadened `electron/services/sessions/factory.ts`'s noise classifier to match `Stream closed`, `/$bunfs/`, and bun source-context line patterns alongside the hook-callback prefix, demoting all of them unconditionally. Dropped the now-redundant `handle.shuttingDown` + `shuttingDownTabs` Set + `isShuttingDown` factory param in the same change.
- **TodoBar wire-shape bug (carried in from 0.4.36's first cut).** `getLatestTodos` was reading the structured `{ task: { id } }` payload off the SDK user-message envelope's `tool_use_result` field — which only exists in persisted JSONL, never on the live stream. The CLI emits the live tool_result with content as a literal `Task #<id> created successfully: <subject>` string (no envelope), so every TaskCreate result returned null from the extractor and every subsequent `TaskUpdate(taskId)` silently dropped, leaving the bar stuck at all-pending under live use. `extractTaskIdFromContent` parses the content string using the same `/^Task #(\S+) created successfully/` regex the CLI binary itself ships, with the envelope path kept as a defensive fallback for the JSONL-replay case.
- **"View in Log" toast action lands directly on Settings → Log instead of Settings → General.** When no Settings tab existed yet, `createSettingsTab()` + `setTimeout(0) dispatchEvent` raced against the Settings component's `useEffect` listener registration, so the event fired before anyone was listening. Added a `sessionStorage` handoff (`omnifex:settings-initial-tab`) read-and-cleared by Settings' `useState` initializer on first render; the window-event path stays as the warm-mount fallback for when the Settings tab is already open.
- **Inferred task completion on turn-end `result` message.** Agents commonly walk through tasks as "TaskUpdate(in_progress) → work → TaskUpdate(completed) → next" but skip the final TaskUpdate(completed) on the LAST task — they emit a summary and end the turn with the task stuck in_progress (or pending under the queue-fallback path). When a `result` message hits the stream every non-completed task is marked completed inline, so the bar matches the user's intuition across reloads and the thinking-bubble gate (which reads `tasksInFlight`) goes quiet when the session is genuinely idle. Inline rather than as a post-pass so the epoch-reset on the next TaskCreate also sees an all-completed map and drops the stale batch.
- **Epoch reset across batches.** When the agent finishes a batch and starts a new one, the new list now replaces the old rather than appending. Detection: a `TaskCreate` that arrives when every existing task is completed clears the prior batch and seeds the new one. Combined with the result-message inference above, a `result` between two TaskCreate batches also functions as an epoch boundary.

### Removed

- **OS-level notifications + dock-unread badge on every TaskCompleted.** Under the Task primitive an agent typically creates a batch of 3-10 todos per turn and walks through them sequentially, so the previous per-completion notification flooded the user. The Log row + chat-stream `task_event` are kept; only the dock/badge/native-notification path is dropped. Permission and elicitation prompts still notify (they genuinely need attention). `createSessionHooks` no longer needs `notificationHooks`, so the unused parameter is dropped through the factory and lifecycle call sites.

## [0.4.37] — 2026-05-15

Single-fix follow-up to 0.4.36. The SDK-upgrade release rewrote `latestTodos` to accumulate per-task state from the new `TaskCreate` / `TaskUpdate` event stream, but the rewrite shipped against a fabricated wire shape: the unit-test fixture treated the `tool_result` block's `content` field as a JSON-stringified `{ task: { id } }` payload, so the implementation tried to `JSON.parse` it. The real shape — verified against live session JSONL under `~/.claude-personal/projects/.../*.jsonl` — is that `tool_result.content` is a plain-English string ("Task #1 created successfully: …") and the structured `{ task: { id } }` payload rides on the OUTER SDK user message envelope as `tool_use_result` (snake_case, live stream) or `toolUseResult` (camelCase, persisted JSONL replay). `JSON.parse` failed on every TaskCreate result, the task id was never registered, every subsequent `TaskUpdate(taskId)` was silently dropped, and the TodoBar effectively never advanced beyond `pending`. 0.4.36's unit tests covered the (wrong) contract perfectly — they did not catch the real bug.

Installers remain **unsigned**.

### Fixed

- **TodoBar now actually reflects `TaskCreate` / `TaskUpdate` activity.** `src/lib/latestTodos.ts` replaces `parseTaskIdFromResult(content)` with `extractTaskIdFromEnvelope(m)`, which reads `tool_use_result` or `toolUseResult` off the parent SDK user message envelope and accepts only string ids. The test helper was rewritten to mint envelopes that mirror real JSONL records, and a dedicated regression test for the camelCase JSONL-replay variant was added so the snake_case vs camelCase wire-shape distinction can't quietly regress again.

## [0.4.36] — 2026-05-15

Claude Agent SDK 0.3.142 upgrade. The release notes flag three breaking changes; two of them required actual code work, the third (`unstable_v2_*` / `SDKSession*` symbol removal) was already cleared in v0.4.14 and only left stale doc-comments behind. Two of the three changes are user-visible — slow MCP servers no longer "disappear" from the tool list, and the live todo list keeps working under the new per-task event model. The third is internal.

Installers remain **unsigned**.

### Changed

- **Claude Agent SDK bumped to `0.3.142`** (from `0.2.141`). Two related surface changes in our code (described below) plus a sweep through `electron/main.ts` and `electron/services/sessions/summary-query.ts` to drop stale doc-comments referencing the long-removed `unstable_v2_prompt` API.
- **MCP server connections under SDK 0.3.x complete in the background.** Slow MCP servers now report `status: 'pending'` in the first init response rather than blocking the SDK for up to 5s like 0.2.x did. `useSessionLifecycle`'s `fetchInitInfo` previously snapshotted that one response, so any tools from a server still warming up stayed missing from the renderer's tool list for the rest of the session. `fetchInitInfo` is now structured in three explicit phases — account-info poll, one-shot enrichment (models / commands / context usage), then a polling loop on `mcpServerStatus` that re-upserts the synthetic `system:init` message every 1.5s until every server reports a terminal status (`connected | failed | needs-auth | disabled`). Freshly-connected tools appear without waiting for the slowest server.

### Fixed

- **Live todo list keeps working under SDK 0.3.x's per-task event model.** The SDK replaced the snapshot-shaped `TodoWrite` tool (one tool_use carrying a `todos[]` array) with discrete `TaskCreate(subject, description, activeForm?)` and `TaskUpdate(taskId, status?, subject?, …)` tool_use blocks; there is no longer a single tool_use that carries the full list, so `getLatestTodos` reading the snapshot off the last `TodoWrite` returned nothing. The function is rewritten as an accumulator that walks tool_use + tool_result blocks and reduces a keyed-by-`task_id` map: tasks are seeded by `tool_use.id` on `TaskCreate` (so the row appears optimistically before the server-assigned id arrives back on the tool_result), then re-keyed to the assigned `task_id`; subsequent `TaskUpdate` calls patch status / subject / activeForm; `TaskUpdate(status: 'deleted')` drops the row. Creation order is preserved across renames and status flips. The `TodoBar` consumer needed no change.

### Fixed (post-tag)

- **CLI-internal hook-callback noise no longer surfaces as a red Log row at every session start.** Under SDK 0.3.x the CLI fires one of its own numbered hooks (a pending-tasks system-reminder injector tied to the new Task* tools) on every session start; it calls back via `sendRequest` after the SDK input channel has already closed and throws "Stream closed". Bun's runtime dumps a multi-line source-context block alongside the throw, so what was a single benign teardown line under 0.2.x now lands as a wall of "code-looking" stderr. The pattern carries no actionable signal — the session works fine despite it — so `electron/services/sessions/factory.ts`'s stderr classifier now splits a new `HOOK_CALLBACK_NOISE` regex out of `TEARDOWN_NOISE` and demotes anything matching `Error in hook callback hook_\d+` to `debug` unconditionally (the bare `Stream closed` shutdown-only demotion is unchanged; FATAL / panic / generic `/^error/` still surface).

### Removed

- **The per-tool `TodoWidget` and its associated render pipeline.** Per-block rendering doesn't fit the new `TaskCreate` / `TaskUpdate` shape (each call is a small atomic mutation, not a list snapshot); the live list is already surfaced inline by `TodoBar`. `compactGrouping` no longer carves out a "most recent TodoWrite" promotion. `messageFilters` drops `todowrite` from the tool-result-suppression list (with no widget, the tool_result must render normally instead of being silently dropped). `KNOWN_TOOL_NAMES` drops `TodoWrite` — old JSONLs render via the generic JSON path. `sessionStreamReducer` gains per-`Task*` activity labels; `hiddenEventsSummary`'s `todo` bucket is extended to recognize the new tool names; `SystemWidget` gets icon entries for `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList`; `useSessionLifecycle`'s `STANDARD_TOOLS` list adds `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` alongside the already-present `TaskOutput` / `TaskStop`.

## [0.4.35] — 2026-05-14

Three user-visible fixes plus the architectural cleanup that closed the bug class behind one of them. The Resend regression on resumed sessions was the immediately visible symptom; the dual-shape `content` field that caused it was costing the renderer ~70 branching sites and producing roughly one quiet bug per year. Closed at the IPC / JSONL boundary instead of at every read site.

Installers remain **unsigned**.

### Fixed

- **Resend button works on resumed sessions.** Clicking Resend on any user-message card in a session loaded from JSONL silently dropped the prompt. User messages restored from disk carry `content` as a bare string (the CLI's persistence shape), but `handleResend` assumed the typed-block-array shape the live SDK emits — extracted text was `''`, the IPC frame went out empty, no log entry, nothing visible to the user. Routed through a new `extractResendPayload` helper that handles both shapes, then collapsed to array-only after the boundary normalization below.
- **Slash-command rendering regression caught during the same refactor.** The `<command-name>/clear</command-name>…` markup that slash commands store as in JSONL was being normalized into a single text block by the boundary fix above — and the array-path renderer was rendering the raw XML verbatim instead of routing through `CommandWidget` / `CommandOutputWidget`. Moved the command/stdout/`@-mention` image detection into the array text-block renderer so the card looks the same pre- and post-normalization.

### Added

- **Session identity in the Log tab's Category column.** The column previously rendered `session:tab-1778624839066-n893j4wui` — load-bearing for debugging but unreadable at a glance. Now formats as `session: <projectName> - <claudeSessionId[0..6]>` (GitHub's 7-char short-SHA convention for the GUID). Falls back to `session: <projectName>` when the SDK hasn't yet assigned a session id, and to a truncated tabId for tabs closed before this code shipped (no recoverable identity).
- **Resizable Log table columns.** Drag handles on the right edge of Time / Level / Source / Category headers. Widths persist to `localStorage`; Message column stays flexible. Min width 40 px so a column can't be dragged to zero.
- **`sessionNameRegistry` localStorage map.** `tabId → { title?, projectName?, claudeSessionId?, updatedAt }`, mirrored from TabContext on every tab change so the Log tab can resolve closed-tab rows. Bounded to 500 entries, oldest-evicted, backward-compatible with the title-only legacy shape from earlier drafts of this work.

### Changed

- **Claude message content normalized to array form at every ingress point.** New `normalizeMessageContent` helper wraps the `content: string` shape (which the Anthropic Messages API allows and the CLI's JSONL persists) into a single typed-block array at the JSONL load, JSONL reload, and live-stream IPC ingress points in `ClaudeCodeSession.tsx`. Idempotent on already-array content. Downstream consumers (StreamMessage, messageFilters, messageKind, compactGrouping, synthesizeResults, skillDetection, …) now branch on one shape, not two.
- **Removed dead string-shape branches across the renderer.** The CLAUDE.md "refactors clean up after themselves" rule was added precisely because a previous version of this commit nearly shipped with the normalization in place but the now-unreachable defensive branches still in the read sites. Cleanup pass touched `StreamMessage.tsx` (contentStr derivation + command-flag guards + extractCopyText), `extractResendPayload`, `messageFilters`, `messageKind`, `compactGrouping`, `synthesizeResults`, `skillDetection`, plus the `getMessageContent` JSDoc to document the new array-only invariant.
- **`CLAUDE.md` (root + `src/CLAUDE.md`) is now tracked in git** instead of gitignored. The files are project guidance, not personal notes — every contributor and every Claude session in this repo needs to see the current versions. Replaced the three explicit ignore lines with a `CLAUDE.local.md` + `**/CLAUDE.local.md` escape hatch for genuinely personal scratch notes.

### Fixed (post-tag)

- **`CLAUDE_CONFIG_DIR` guard at every Claude subprocess spawn.** New `electron/services/util/claude-env.ts` `buildClaudeEnv(configDir, extras?)` helper centralises env construction for every Claude spawn site (sessions, TUI, summary-query, usage-runner, models, CLI `/usage`). Throws on empty / non-string `configDir`, throws when it resolves to `<HOME>/.claude` (the Claude Code default OmniFex must never land on), expands `~/`, and preserves `process.env` — including `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` for users running the SDK against alternate endpoints. Closes a latent footgun in `claude.ts:getCliUsage`, which previously silently inherited the parent env when called without `configDir`. 12 unit tests cover the validation, expansion, and rejection paths. Investigation found that every live Claude subprocess on the current main already inherits a correct `CLAUDE_CONFIG_DIR` (confirmed via `ps eww`); the historic `~/.claude/` leak was a separate, already-fixed bug in the V2-SDK era (commit 7c8611d, v0.4.14). The empty `~/.claude/{ide,skills}` directories that appear today are upstream Claude Code CLI behaviour, not OmniFex.

## [0.4.34] — 2026-05-14

Two internal cleanups born from the v0.4.32/v0.4.33 SDK-tools review pass and a follow-up audit of how OmniFex consumes the Claude Agent SDK's full message-type surface (30 variants in 0.2.141). No new user-visible features; the changes are all under the hood — but two of them close real bug classes the older code shipped silently with.

Installers remain **unsigned**.

### Fixed

- **Subagent dispatch is now case-aligned end to end.** v0.4.32's `asToolInputOneOf` narrowing was case-sensitive against PascalCase while `isSubagentDispatch` (used as the discriminator above it) was case-insensitive. A lowercase `'task'` would pass the guard but fail the narrow and silently render as raw JSON. `isSubagentDispatch` is now case-sensitive too; both layers agree against the SDK's wire contract; the PascalCase-normalization shim deleted.
- **Write tool widget renders for empty content.** The `StreamMessage.tsx` Write widget gate was `writeInput?.file_path && writeInput.content` — the truthiness check sees empty content as falsy and silently dropped empty-file writes (a legitimate `touch`-style operation Claude Code emits) through to the generic JSON display. Now uses `content !== undefined`.
- **`SDKTaskUpdatedMessage` payload is no longer silently discarded.** The SDK's `task_updated` message (subtype `task_updated`, keyed by `task_id` not `tool_use_id`) carries a `patch` describing TaskState changes (status, description, end_time, error, is_backgrounded, …). It was caught by `isTaskLifecycleMarker`'s `task_*` startsWith match and dropped from the chat timeline — but `messagesToEvents` had no branch for it, so the patch was thrown away. The only case in our pipeline where a message was filtered as if consumed but actually discarded. Now: new TaskUpdated event variant in `subagentEvents.ts`; reducer reverse-lookups subagent state by `taskId`; applies `is_backgrounded` / `description` / `error` unconditionally; applies status changes only when not finalized by `task_notification` (which remains canonical). Maps `'killed'` → `'failed'`. Sets `endedAt` from `end_time` ms when going terminal. The `Subagent` shape gains an optional `error?: string` for consumers that want to surface the SDK's structured error string (not displayed in the UI yet — visual surfacing is a follow-up).
- **`hook_progress` no longer leaks into the chat timeline.** SDK's `system+hook_*` family is plumbing noise — `hook_started`, `hook_response`, `hook_progress` (mid-hook stdout/stderr) all describe internal hook execution and should never appear in chat. The `HOOK_LIFECYCLE_SUBTYPES` set in `messageFilters.ts` only listed `hook_started` + `hook_response` + `user_prompt_submit`, letting `hook_progress` leak in as `system.unknown` gray strips. Now includes `hook_progress`.

### Changed

- **Single source of truth for the renderer's tool-name list.** `ToolInputByName` (PascalCase, type-only) and `toolsWithWidgets` (lowercase, runtime array) were two hand-maintained lists that had to stay in sync by convention. `KNOWN_TOOL_NAMES` is now a const tuple in `src/lib/types/toolInput.ts`; `KnownToolName` derives from it; the lowercased `TOOLS_WITH_WIDGETS_LOWER` Set derives from it; and the `ToolInputByName` interface keys are enforced to match (compile-time, via the `<K extends KnownToolName>` constraint on `asToolInput` indexing into `ToolInputByName[K]`). `StreamMessage.tsx` imports `TOOLS_WITH_WIDGETS_LOWER` directly; the maintenance-comment block is gone.
- **`blockKind.ts`'s internal `KNOWN_TOOL_NAMES_LOWER` is now derived from `KNOWN_TOOL_NAMES`** with two documented adjustments: `task` and `agent` removed (handled by `isSubagentDispatch` separately) and `askuserquestion` added (elevated to its own kind but still recognized as a known tool for per-block classification). Closes the third sync hazard in the codebase.

### Added

- **`system.permission_denied` first-class kind.** `SDKPermissionDeniedMessage` (emitted by the SDK on auto-deny short-circuits — auto-mode classifier, dontAsk mode, deny rules, headless-agent auto-deny) and the OmniFex hook synthetic on the same subtype both fell to `system.unknown` with no styling distinct from no-op telemetry. Now classified as `'system.permission_denied'` in `messageKind.ts` with a dedicated `MessageKindConfig` entry (red accent, `ShieldX` icon). Renders as a red-accented inline strip — visually distinct from the gray default but not yet a card; a dedicated card-style render branch is a follow-up.
- **Dev-mode warning when a known tool falls through every widget branch.** `warnUnhandledKnownTool(toolName, rawInput)` in `toolInput.ts` — gated on `import.meta.env.DEV`, production no-op. Fires when `toolName` is in `KNOWN_TOOL_NAMES` but `renderToolWidget` reaches the bottom without matching, which is exactly the silent fall-through the SDK type adoption was meant to surface (malformed input on a known name → generic JSON).

## [0.4.33] — 2026-05-13

Code-review follow-up to the SDK type adoption in 0.4.32. Four issues surfaced by post-release review: a latent case-mismatch in the subagent dispatch branch, a maintenance hazard in the tool-result suppression list, a misleading local interface for `TodoRead`, and a missing `LS` headline in the permission card. The first is theoretical (no production code path emits lowercase tool names today, so the gap was latent rather than active), but closing it removes a foot-gun for future runtime additions. v0.4.32 is being **superseded by 0.4.33** — same SDK adoption work, with the review fixes folded in. v0.4.32's draft can be deleted from GitHub before publishing.

Installers remain **unsigned**.

### Fixed

- **Subagent dispatch branch is now case-aligned end to end.** `isSubagentDispatch` is case-insensitive (defense-in-depth across runtimes that historically emitted lowercase tool names), but the new `asToolInputOneOf(toolName, ['Task', 'Agent'], …)` narrowing introduced in 0.4.32 was case-sensitive against PascalCase. A lowercase `'task'` would pass the guard, fail the narrow, and silently render as raw JSON. `StreamMessage.tsx` now PascalCase-normalizes the name before the narrow so both layers agree.
- **`PermissionCard.formatToolInput` now includes an `LS` branch.** `LS` uses `path` (not `file_path`), and the generic field-probe fallback in the formatter doesn't check `path` — so a permission request for `LS` was rendering as raw JSON instead of showing the directory path as the headline. One typed branch added before the generic fallback.

### Changed

- **`TodoReadInput` interface no longer fabricates a `todos` field.** `TodoRead` takes no meaningful input — it reads the stored list and returns it as the tool result. The 0.4.32 interface mistakenly modelled `todos?: unknown[]` on the input side, which the widget happened to fall back gracefully for (it always extracts todos from the result), but the interface was misleading documentation. Now an empty interface with a comment that points at the real source of todos. The `StreamMessage.tsx` call site stops passing the always-undefined `todos` prop.
- **Tool-result suppression list at `StreamMessage.tsx:1214` carries a maintenance comment.** The lowercased `toolsWithWidgets` list (used to hide the raw `tool_result` block when a typed widget already rendered the dispatch above) is independent from the PascalCase `ToolInputByName` map. Adding a new typed widget without an entry here would cause a visual double-render. The new comment makes the sync obligation visible to the next maintainer; deriving the set from a single source belongs in its own task.

### Added

- **Test: `GrepInputExtended` legacy fields are accessible after narrowing.** Pins the intersection — if someone removed `& { include?: string; exclude?: string }` from the type definition, the test (and `GrepWidget`) would break loudly rather than silently typing those fields as `unknown`.

## [0.4.32] — 2026-05-13

Adopts the Claude Agent SDK's per-tool input schemas in the renderer. Until now, the tool-widget switch in the chat view and the headline picker on the permission prompt both reached into `tool_use.input` with structural `typeof === 'string'` guards — useful at runtime, but invisible to the type-checker, so any field rename on the SDK side would silently render an empty widget. The SDK ships those schemas as `BashInput` / `FileReadInput` / `GrepInput` / etc. via its `sdk-tools` subpath export; this release wires them in via a small name→type map so every branch narrows from `unknown` to the SDK shape before reading fields. Also rolls the SDK forward one patch.

Installers remain **unsigned**.

### Added

- **`src/lib/types/toolInput.ts`: typed tool-input bridge.** Single source of truth mapping each PascalCase tool name to its SDK-shipped input schema (`Bash → BashInput`, `Read → FileReadInput`, `Grep → GrepInputExtended`, …). Exports `asToolInput(name, expected, input)` for single-tool narrowing and `asToolInputOneOf(name, expectedSet, input)` for branches that fold multiple tools (e.g. `Task` and `Agent` both dispatch a subagent). Tools that aren't shipped under `sdk-tools` as of 0.2.141 — `LS`, `TodoRead`, `MultiEdit` — get local interfaces that mirror exactly what our widgets read; swap to the SDK type if a future SDK release adds them. Helpers are pure runtime guards (name string match + object-ness check); the SDK doesn't validate shapes at runtime so neither do we. Eight new tests in `src/lib/types/__tests__/toolInput.test.ts`.

### Changed

- **`StreamMessage.tsx` widget switch: typed narrowing per branch.** Each `if (toolName === "bash" && input?.command)` shape is replaced with `const bashInput = asToolInput(toolName, 'Bash', rawInput); if (bashInput?.command) …`. Inside each branch, `input` is the SDK type for that tool, so the compiler catches field renames (e.g. if a future SDK release renames `Bash.command` the build breaks rather than rendering an empty bash widget). The defensive `content.name?.toLowerCase()` normalization is removed: tool names arrive PascalCase on the wire per SDK contract, and the lowercase guard was protecting against a case mismatch that never actually happened in production. Subagent dispatch (`Task` / `Agent`) uses `asToolInputOneOf` so both names route to the same `AgentInput`-typed branch.
- **`PermissionCard.tsx`: typed headline-field selection.** `formatToolInput` now takes the tool name and uses the typed map to pick the headline field (`Bash → command`, `Read → file_path`, …). For tools outside the map (MCP, future tools), a generic field-probe fallback preserves the pre-typed behavior so the permission card never goes blank.
- **`@anthropic-ai/claude-agent-sdk` → `0.2.141`** (was `0.2.140`). Adds `TaskCreateInput` / `TaskGetInput` / `TaskUpdateInput` / `TaskListInput` (+ matching output types) to the `sdk-tools` exports and aligns the transitive `@anthropic-ai/sdk` to `^0.93.0`. No API breakage; nothing in our code paths uses the new Task* types yet.

### Known issue (carried forward, pre-existing)

- `GrepWidget` reads `input.include` / `input.exclude` for the renderer header, but the SDK's `GrepInput` no longer models those fields (they were superseded upstream by `glob` / `type`). The typed bridge captures this as `GrepInputExtended = GrepInput & { include?: string; exclude?: string }` so the widget behavior is unchanged; replacing `include`/`exclude` with the SDK-canonical `glob`/`type` belongs in its own task and is tracked there.

## [0.4.31] — 2026-05-13

Follow-up to the dashed-path fix in 0.4.29. Recovering the project path from the alphabetically-first JSONL was order-independent of when each session was written, which made the recovered path arbitrary after a folder rename: Claude keeps writing to the same encoded project-id directory with the new `cwd`, but older JSONLs in that directory still carry the pre-rename `cwd`. With random-UUID filenames, alphabetical order is effectively random, so a renamed project could keep displaying its old name indefinitely — in practice the omnifex project itself was being shown as `~/Repos/personal/greychrist`, colliding with the legacy greychrist project dir from before the repo rename.

Installers remain **unsigned**.

### Fixed

- **Renames flip the displayed project path immediately.** `recoverProjectPath()` in `electron/services/claude.ts` now sorts JSONLs by mtime (newest first) before sampling `cwd`, so a single new session under the renamed folder is enough to update the path in the Recent Projects list and project routing. The naive `/`→`-` fallback for empty / cwd-less / corrupt project dirs is unchanged.
- **Usage `by_project` breakdown collapses to the current path after a rename.** The same mtime-desc ordering is applied to the session scan in `electron/services/usage.ts` so token totals from pre- and post-rename sessions aggregate under one canonical path with no stale-name leakage.

## [0.4.30] — 2026-05-13

The Log tab gains sortable columns. All five headers (Time, Level, Source, Category, Message) are clickable; the icon next to each header shows current sort state. Sort is server-side because the query is paginated — reordering only the visible 50 rows would be misleading.

Installers remain **unsigned**.

### Added

- **Sortable column headers on the Log tab.** Click any header to sort by that column; click again to flip direction. Time and Level default to descending (newest / most severe first); Source / Category / Message default to ascending (A→Z reads more naturally). Level sorts by **severity** (`error > warn > info > debug`) rather than alphabetically, so the descending direction lands errors at the top instead of `debug`. Category keeps null/empty rows pinned to the bottom regardless of direction. Tie-breakers on the primary sort column fall through to `timestamp DESC, id DESC` so page boundaries stay stable when many rows share the same level or source. Sorting changes reset the view to page 0 so you don't land in the middle of an unfamiliar dataset.
- **`orderBy` / `orderDir` parameters on `api.logQuery` and the underlying `LoggingService.query()`.** Whitelisted column set: `timestamp | level | source | category | message`. An unrecognised `orderBy` value falls back to the previous default (`timestamp DESC`) — preserves behaviour for any caller that doesn't specify a sort, and closes the SQL-injection surface that an unfiltered `ORDER BY` substitution would open. Exposed as the `LogOrderBy` / `LogOrderDir` types in `src/lib/api.ts`.

## [0.4.29] — 2026-05-12

Fixes a long-standing display bug in the Recent Projects list and the Usage breakdown: any project whose folder name contains a literal dash (e.g. `pi-tuitive-fe`, `claude-agent-sdk`, `node-pty`) was rendered with its dashes turned into slashes — `~/Repos/work/pi-tuitive-fe` would appear as `~/Repos/work/pi/tuitive/fe` with the name truncated to the last segment. Root cause: Claude Code's per-project session-storage directory encoding replaces `/` with `-`, which is lossy; the naive reverse can't tell the difference. The recovered path now comes from the authoritative `cwd` field that Claude Code stamps onto every JSONL entry.

Installers remain **unsigned**.

### Fixed

- **Recent Projects list and project routing recover the true path for any project with literal dashes in the name.** `electron/services/claude.ts` gains a `recoverProjectPath(projectDir, projectId)` helper that scans up to the first 50 lines of the alphabetically-first JSONL inside the project directory, returns the first valid `cwd`, and falls back to the existing naive `-`-to-`/` decode only when no JSONL is present, when none of the sampled entries carries `cwd`, or when the file is unreadable / corrupt. Wired into both `listProjects()` and `getProjectSessions()`. The displayed project name (driven by `path.basename(path)` on the renderer side) is now correct for every dashed folder, and account resolution against path rules is also more accurate as a side effect.
- **Usage `by_project` breakdown uses the recovered path.** `electron/services/usage.ts`'s `scanConfigDir` now samples `cwd` opportunistically from the JSONL entries it's already reading for token counts — no additional IO — and falls back to the naive decode when no entry carries `cwd`. `RawMessage` picks up an optional `cwd?: string` field for self-documentation.

## [0.4.28] — 2026-05-12

A noise pass on the error-toast pipeline added in 0.4.27. Two specific cases were treating routine chat events as app-level errors: closing a tab mid-session fired a toast for every tab (the Claude Code CLI's own teardown hook throws "Stream closed" on its way out, which our stderr classifier was catching as an error), and every shell command that exited non-zero from inside the agent — `grep` with no match, `git pull` blocked by an untracked file, `pgrep` with no result — wrote an error row even though Claude already explained the failure in the chat. The Log tab is now reserved for events the chat doesn't already show; tool-call mirroring and notification mirroring were dropped wholesale. Also rolls the Claude Agent SDK forward to track upstream.

Installers remain **unsigned**.

### Fixed

- **Tab close no longer fires a spurious error toast for sessions with live SDK queries.** The Claude Code CLI runs an internal teardown hook on shutdown that tries to push a system-reminder through the control channel; once we close the input channel it throws `Stream closed` and dumps a bun stack trace to stderr. The session-factory stderr classifier now downgrades `Error in hook callback` / `Stream closed` messages to debug-level while a session is shutting down (tracked via a new `shuttingDownTabs` set on the sessions service, populated at the top of `stop()` and surviving the per-tab handle's removal from the live-sessions map). Real `FATAL` / `panic` / generic `error:` lines still surface even during shutdown so genuine crashes aren't hidden.

### Changed

- **Tool-call hook log rows retired.** `PreToolUse` / `PostToolUse` / `PostToolUseFailure` no longer write to `app_logs`. Every tool call and tool failure is already visible to the user in the chat (`tool_use` + `tool_result` blocks) and in Claude's own session JSONL on disk; the Log mirror was duplicative, and `PostToolUseFailure` in particular was generating error toasts for benign non-zero exit codes.
- **`Notification` / `SubagentStart` / `SubagentStop` hooks stop writing log rows.** Renderer side effects are preserved: the `claude-notification` channel still drives tab badges (`useNotifications.ts`), notifications still appear inline in the chat via `claude-output`, and the subagent UI continues to update via the JSONL tail. Only the `app_logs` mirror was removed.
- **`@anthropic-ai/claude-agent-sdk` → `0.2.140`** (was `0.2.139`). CLI-parity bump; no API changes.

## [0.4.27] — 2026-05-12

Quality-of-life pass on two surfaces that had grown loud: the slash-command picker and the application log. The picker now opens on a Project filter (the one you actually want), Left/Right arrows cycle filter tabs, and the SDK-sourced "Default" tab is renamed to "Claude" — with `project` and `user` scopes split into separate tabs. The log gains two verbose-source toggles (Claude hook events, Usage runner) so the bulk info-level chatter can be silenced without losing warnings and errors, plus a new "Toast on errors" feature that pops a corner toast with a "View in Log" action whenever a real error is recorded, so you can correlate noisy stack traces back to the action that triggered them.

Installers remain **unsigned**.

### Added

- **Slash-command picker: Left/Right arrow keys cycle filter tabs.** Wraps at both ends — `Project → User → Claude → All → Project`. `↑/↓` still moves the highlighted command and `Enter`/`Esc` still select/close.
- **Slash-command picker: separate `User` tab.** Previously the `Project` filter lumped together project-scoped and user-scoped (global custom) commands; they're now two tabs. The per-row scope badge mirrors the change.
- **Log: "Claude hook events" verbose toggle.** Gates info/debug entries from the `claude-hooks` source (hook stream is otherwise extremely chatty). Default **off**. Warn/error always pass through regardless.
- **Log: "Usage runner" verbose toggle.** Gates info/debug entries from the `usage-runner` source. Default **off**. Warn/error always pass through.
- **Log: "Toast on errors" notifications.** When any error-level entry is recorded, a 6-second corner toast surfaces `[source] first-line-of-message…` with a **View in Log** action. Tapping the action opens the Settings → Log tab pre-filtered to `level=error`. Identical `source+message` pairs within a 2-second window are deduped so a burst doesn't stack toasts. Default **on**; toggle lives alongside the verbose-source switches.
- **`LoggingService` accepts a `shouldAccept(entry)` predicate and an `onError(entry)` observer.** Both are evaluated live on every `writeBatch`, so toggling the new settings takes effect on the next event without an app restart. Observer exceptions are swallowed so a misbehaving handler can't break the write path.

### Changed

- **Slash-command picker tab order: `Project · User · Claude · All`.** `Project` is selected on open (was `All`). Per-row scope badges now read `project` / `user` / `claude` to match.
- **Slash-command picker: "Default" → "Claude".** The tab and per-row badge for SDK-sourced commands (`scope: "default"`) display as `Claude`. The underlying scope value is unchanged so persisted commands still resolve correctly.
- **Toast component supports an optional action button.** New `action?: { label, onClick }` prop renders a bordered text button to the left of the dismiss `×`. Existing toasts (success/info confirmations) are unaffected.

### Fixed

- **Slash-command picker: "Project" filter now actually means project-scoped.** Previously the filter passed both `project` and `user` scopes, which made the label misleading once user-scoped commands existed.

## [0.4.26] — 2026-05-12

A new first-order chat-feed card for answered `AskUserQuestion` interactions, plus a per-kind colour picker in Appearance settings. The answered card pulls a resolved Q+A out of the assistant bubble it used to nest inside and renders it as its own response — header label, accent colour, icon, icon chrome, and timestamp footer all driven by the standard `MessageCard` shell so every Appearance edit for `tool.askUserQuestion.answered` takes effect end-to-end. Accent colour gates that customisation: the per-kind palette dropdown is replaced with a free-form HTML5 colour picker plus a hex text field, and the KindEditor's row order now matches the cards' visual hierarchy (hide-in-compact → header + accent → icon → icon chrome).

Installers remain **unsigned**.

### Added

- **Answered-AskUserQuestion card (`tool.askUserQuestion.answered`).** Renders as its own first-order chat-feed message once the user has answered an `AskUserQuestion` prompt — anchored where the assistant bubble would be (~95% width, left-aligned), with one row per question (header label · question text · italic answer). The data round-trips from `tool_use.input.questions` + the matching `tool_result.content`. Companion kind `tool.askUserQuestion.answered.result` marks the otherwise-redundant user-side tool_result message and hides it from scrollback.
- **Wire-format parser for the SDK's synthesised answer string.** The renderer doesn't see `JSON.stringify(updatedInput)`; the SDK rewrites the tool result into a human-readable sentence (`User has answered your questions: "Q1"="A1", "Q2"="A2, A3" user notes: User selected Other: "<typed>". You can now continue …`). Parser anchors on each question's literal text and recovers per-question annotations by matching Other-text against the answer value. Verified against live session `d6ac42ec-47c0-47ef-8b4b-81fda02fa2f5` and pinned as a regression test.
- **Free-form accent colour picker per kind.** `KindEditor` now exposes an HTML5 `<input type="color">` plus a hex text field for the `accentColor` slot. `MessageKindConfig.accentColor` widened from `PaletteName` to `string`; `mergeConfig` accepts `#rgb`, `#rrggbb`, or `#rrggbbaa` in addition to the legacy palette-name path. New `isHexColor()` helper. New `src/lib/__tests__/accentStyle.test.ts` covering palette resolution, hex synthesis, alpha derivation, and round-trips.
- **Enter-to-submit in `AskUserQuestion`'s "Other" input.** Pressing Enter inside the Other text field fires the same handler as the Send button, gated on the same `isComplete` predicate as the button's disabled state. Shift / Cmd / Ctrl / Alt + Enter are no-ops.

### Changed

- **`AnsweredAskUserQuestionCard` uses the shared `MessageCard` shell.** Two earlier passes reassembled the same chrome (Card + icon column + KindHeader + timestamp footer + `pb-9` padding) by hand, which is why a configured `iconSize` / `iconBordered` / `headerLabel` didn't take effect and the card sat shorter than every other one. The card now wraps its body in `<MessageCard kindId message headerFallbackLabel>` and reads zero config directly — accent, icon, header label, icon chrome, and footer all flow from the kind's config.
- **`KindEditor` row order: hide-in-compact → header label + accent (paired row) → icon → icon chrome.** The previous order put the header label last and the accent in a tall dropdown next to "Hide in compact mode." Pairing header label and accent in a single grid row matches what the user sees first in scrollback.
- **`AskUserQuestion` chevron now matches `TodoBar` / `SubagentBar` convention.** Expanded → `ChevronDown`, collapsed → `ChevronUp` (was inverted).
- **Answered card visual polish (small iterations).** Removed the `→` column (three-column grid: header · question · answer), dropped the rounded gray pill behind question headers (uppercase + foreground-coloured label instead), italicised all answers, deduped Other answers so the typed text appears only once as `You typed: "…"`, dropped `font-medium` on the answer cell, and put the answer in an opaque `bg-background` pill so the card's translucent accent doesn't bleed through long-wrapping answers.

### Fixed

- **`AskUserQuestion` answers no longer show "(no answer recorded)".** Initial implementation expected the structured JSON payload as the tool_result content. The wire format is actually the synthesised sentence above; the parser now anchors on each question's text and recovers the answers verbatim.
- **Empty in-bubble nesting for clean `AskUserQuestion` calls.** The pre-elevation in-bubble renderer was creating card-in-card after the standalone elevation landed. The in-bubble branch + the `'askuserquestion'` entry in `toolsWithWidgets` are gone; mixed-content `AskUserQuestion` calls (assistant text or thinking alongside the tool_use, a rare path) fall through to the generic tool_use display.

### Removed

- **Per-kind palette dropdown.** Replaced by the colour picker described above. The 21-name palette stays in the data model for backwards compatibility and the (rarely used) "retint every kind that shares a name" workflow; existing saved configs that reference palette names still resolve through `config.palette`.

## [0.4.25] — 2026-05-11

Subagent tracking refactor. The renderer's `subagentStreams` was rebuilt around an event-sourced pipeline (`messagesToEvents` → `applyEvents` with an intrinsic terminal lock → inferred-closure post-pass) to fix a class of bug where a `Bash` dispatched with `run_in_background:true` would stay on the pulsing "running" indicator forever after the work had actually finished. The root cause was structural: the SDK's `query()` async iterator does not yield the `queue-operation` enqueue or `attachment.queued_command` envelopes that the CLI uses to carry the `<task-notification>` XML for background completion — they only ever landed in the on-disk JSONL. A new main-process JSONL tail (`electron/services/sessions/jsonl-tail.ts`) polls the session file at 100ms and forwards qualifying carriers to the renderer on a separate `claude-output-extra:<tabId>` IPC channel, fed into the same reducer. A safety-net `completed_inferred` status (distinct dashed-ring icon) covers the rare case where neither the live carrier nor a structured `task_notification` SystemMessage arrives but the parent has clearly advanced past its `result`. Bundled with a popover stacking fix (the session/context popover now portals to `document.body` so SubagentBar's expanded rows can't punch through it) and an `AskUserQuestion` Enter-to-submit shortcut.

Installers remain **unsigned**.

### Added

- **Event-sourced subagent state.** New `src/lib/subagentEvents.ts` with `messagesToEvents` (pure SDK→event translation) and `applyEvents` (per-`tool_use_id` reducer with intrinsic terminal lock). The legacy `deriveSubagents` API in `subagentStreams.ts` is preserved as a thin facade so all existing consumers — SubagentBar, `messageKind.ts`'s `result.awaiting_background` classifier, `clearCompleted` / `hasRunningSubagent` predicates — keep working unchanged.
- **Live JSONL tail for background-Bash closure carriers.** `electron/services/sessions/jsonl-tail.ts` reads `<configDir>/projects/<projectKey>/<sessionId>.jsonl` from EOF and forwards `queue-operation` enqueues with `<task-notification>` XML and `attachment.queued_command` carriers on a new `claude-output-extra:<tabId>` IPC channel. Subscribed alongside the main `claude-output:` stream in `useSessionLifecycle.ts` so both paths feed the same reducer. Toggleable via `OMNIFEX_DISABLE_JSONL_TAIL=1` for rollback. 9 new tests in `electron/__tests__/jsonl-tail.test.ts`.
- **`completed_inferred` subagent status.** Distinct from `completed` — rendered as a dashed-ring `CircleDashed` at 60% opacity with a tooltip indicating completion was inferred from the parent's `result` rather than received via a direct closure carrier. Placeholder text in the expanded row reads `"Completed (no progress reported)"` for these rows so the missing-carrier case stays visible without looking like a hang. The inference rule is conservative: only fires when a `type: 'result'` exists after the dispatch *and* is not the most recent message (so genuinely-still-running backgrounds aren't prematurely closed).
- **Enter-to-submit in `AskUserQuestion`'s "Other" input.** Pressing Enter while typing in the Other text field fires the same handler as the Send button, gated on the same `isComplete` predicate. Shift / Cmd / Ctrl / Alt + Enter are no-ops (matching the chat composer's send-vs-newline split). 5 new tests in `AskUserQuestionCard.test.tsx`.

### Changed

- **Popover renders via portal.** `src/components/ui/popover.tsx` now uses `ReactDOM.createPortal(…, document.body)` with `position: fixed` against the trigger's bounding rect, repositioning on scroll/resize. This escapes the `z-40` session-header stacking context that was capping the popover under the global `z-50` SubagentBar wrapper — the session-id copy icon in the context-window popover was previously unreachable when subagent rows were expanded. Fix benefits every popover consumer (`SessionCard`, `AccountCard`, `ModelPicker`, `Topbar`, etc.) transparently.
- **Inferred-closure rule generalised to foreground `Agent` / `Task` dispatches.** The legacy orphan detector only handled `isBackground` rows; foreground dispatches that lost their `tool_result` carrier stayed `running` forever. The new post-pass treats all subagents uniformly. `abandoned` is now reserved for an explicit "we know this didn't finish" case (currently dead, left in the type union for a future watchdog).
- **Typing-bubble bridge no longer routes through `hasRunningSubagent`.** `ClaudeCodeSession.tsx`'s `outstandingWork` predicate dropped the `awaitingBackground` term, so a stuck subagent row can no longer fake a live turn. SubagentBar's per-row spinner remains the scoped "this dispatch is in flight" signal.
- **`AskUserQuestion` chevron direction.** Matches `TodoBar` / `SubagentBar`: expanded → `ChevronDown`, collapsed → `ChevronUp` (was inverted).

### Fixed

- **Subagent rows stuck on "running" after completion.** Diagnosed against live session `5d2c9f24-0302-420c-9d4b-90181e3942f7` where a `Bash` background dispatch (`Run verify.mjs gate in WS-179 worktree`) had its `<task-notification>` carriers persisted to JSONL (line 209 = `queue-operation` enqueue, line 211 = `attachment.queued_command`) but neither envelope reaches the renderer in live mode because they aren't members of the SDK's `SDKMessage` discriminated union. The new live JSONL tail (primary fix) and the inferred-closure safety net together close the gap. Design notes: `docs/superpowers/specs/2026-05-11-subagent-tracking-refactor-design.md`.
- **Session-ID copy icon unclickable.** The context-window popover sat inside the header's `z-40` stacking context, so SubagentBar's expanded rows (in a `z-50` wrapper rooted at the page level) painted on top and intercepted clicks on the session-GUID copy button. The popover portal fix eliminates the stacking-context dependency entirely.
- **Typing-dots spinner staying on after parent `result`.** A stuck-running subagent kept `hasRunningSubagent` truthy, which kept the chat-level typing indicator on even when the SDK turn had ended and the session was idle awaiting user input. Decoupled per the change above.

## [0.4.24] — 2026-05-11

A two-part Agent SDK pass. The first part is structural: the renderer's `ClaudeStreamMessage` type — which had been a loose interface plus a `[key: string]: any` escape hatch — is now anchored on the SDK's own `SDKMessage` discriminated union via intersection with an `OmnifexEnvelope` mixin, with three explicit synthetic variants (`permission_request`, OmniFex's `system+notification`, and `summary` for compaction summaries from JSONL). The escape hatch is gone; the discriminator narrows for real. The second part is the three behavioral fixes that surfaced during the audit that drove this work: terminal turn-stops other than `end_turn` now emit a result card on reload, `interrupt()` failures surface to the chat instead of failing silently, and three SDK-side server-tool block kinds are classified defensively in case Anthropic surfaces them through the CLI in a future release. Bundled SDK bumped to 0.2.139.

Installers remain **unsigned**.

### Added

- **SDK-anchored renderer type union.** `ClaudeStreamMessage` is now `Exclude<SDKMessage, SDKNotificationMessage> & OmnifexEnvelope | PermissionRequestMessage | SystemNotificationMessage | CompactionSummaryMessage`. Anchoring on `SDKMessage` (29 variants) means schema drift in the SDK now shows up as compile errors instead of silently producing `undefined` at runtime — which is how this PR uncovered dead reads on `msg.error` (SDK uses `errors: string[]`) and `msg.cost_usd` (SDK uses `total_cost_usd`). `SDKNotificationMessage` is excluded because the SDK's loop-side notification (`{key,text,priority}`) collides with OmniFex's UI-toast shape on the same `system+notification` discriminator; the SDK shape is never currently emitted to the renderer. The three guards (`isAssistantMessage` / `isUserMessage` / `isResultMessage`) now narrow to the SDK types, and a new `getMessageContent(msg)` helper returns the wrapped `BetaMessage` / `MessageParam` content for assistant/user variants — replacing dozens of inline `if (msg.type === 'assistant' || msg.type === 'user')` narrows in classifiers, filters, and counters. 11 new tests in `src/types/__tests__/claudeStream.test.ts` cover the guards and helper; `claudeStream.ts` is at 100% line coverage.
- **`assistant.serverToolUse` and `tool.result.codeExecution` block kinds.** The Agent SDK doesn't currently surface `server_tool_use`, `bash_code_execution_tool_result`, or `text_editor_code_execution_tool_result` blocks through the CLI, but if Anthropic adds the server-side code-execution tool to the SDK in a future release the renderer would have dropped them into the unknown-tool catch-all. Both kinds are now registered in `messageRenderingConfig` and classified in `classifyBlockKind` with their own configurable Appearance entries. 3 new tests in `src/lib/__tests__/blockKind.test.ts`.

### Changed

- **System-notification body field renamed `message` → `body`.** OmniFex's UI-toast synthetic (`type: 'system' + subtype: 'notification'`) used to carry a `message: string` field, which collided with the wrapped Anthropic `message` on assistant/user variants and forced consumers through `(msg as any).message` casts. Renamed across all 11 emit sites (`electron/services/sessions/hooks.ts`, `runtime.ts`, `queries.ts`, plus renderer-side `useSessionLifecycle.ts`, `useSessionTimeouts.ts`, `ClaudeCodeSession.tsx`), the consumer at `StreamMessage.tsx`, and 5 test assertion sites. The discriminated union now narrows by both the discriminator and the field-set without ambiguity.
- **`backgroundTasks()` available on the SDK `Query`** (via the 0.2.138 → 0.2.139 bump). New SDK method to push an in-flight foreground Bash/subagent task to background mid-execution — equivalent to pressing Ctrl+B in the terminal. Not yet wired up to a UI affordance in OmniFex; the existing `task_*` event stream that drives `SubagentBar` is ready when/if a "Background this" button gets added.
- **`apiProvider` gains `'gateway'`** (SDK 0.2.139, enterprise gateway auth). Pure union widening on `AccountInfo`; no consumer code changes needed.

### Fixed

- **Result card emits on every terminal stop reason.** `synthesizeResultMessages` previously emitted a synthetic "Execution Complete" card only when `stop_reason === 'end_turn'`. On session reload, turns that hit `max_tokens` / `refusal` / `model_context_window_exceeded` / `stop_sequence` silently dropped their closing card — the user saw a cut-off assistant message and then nothing, with no signal the model had stopped. Now classifies all five terminal stops; clean completions (`end_turn`, `stop_sequence`) emit a success result, the other three emit an error result. Mid-turn `tool_use` stops, resumable `pause_turn`, and partial streams (no `stop_reason` at all) still correctly emit nothing. 6 new tests in `synthesizeResults.test.ts`.
- **`interrupt()` failures surface to the chat.** `queries.ts#interrupt` previously caught and `console.error`'d SDK errors silently. Stop is user-facing — a silent failure left the user mashing the Stop button with the stream still running and no UI signal. Now mirrors the `applyPermissions` pattern: log plus a `system.notification.error` on the `claude-output:${tabId}` channel so the chat shows what went wrong. 2 new tests in `sessions-queries.test.ts` cover both the new emit path and the silent-on-success case.
- **Dead `msg.error` / `msg.cost_usd` reads removed.** Two legacy reads on the synthesized result message — `msg.error` (singular; SDK uses `errors: string[]`) and `msg.cost_usd` (SDK uses `total_cost_usd`) — were always `undefined` and only "worked" because the pre-refactor index signature silenced them. Both now read the correct SDK fields; result cards now render error text from `errors.join('\n')` and cost from `total_cost_usd` only.

### Removed

- **`[key: string]: any` escape hatch on `ClaudeStreamMessage`.** Every previously-implicit field is either typed via the SDK variant it belongs to, declared on one of the three synthetic variants (`PermissionRequestMessage` / `SystemNotificationMessage` / `CompactionSummaryMessage`), or — for cross-cutting OmniFex annotations like `receivedAt` / `timestamp` / `synthesized` / `isMeta` — declared on the new `OmnifexEnvelope` mixin.

## [0.4.23] — 2026-05-11

Two chat-pane improvements. First, Cmd/Ctrl+F now opens a floating find-in-chat bar that highlights matches inside the current session and walks them with Enter / Shift+Enter (wraps in both directions). Second, stop-hook output and other hook-feedback events the Agent SDK injects as synthetic user messages are now rendered as a collapsible System Context card instead of looking like the user typed them — which previously caused the model to reply as if the hook output were a real prompt.

Installers remain **unsigned**.

### Added

- **Find in chat.** Cmd/Ctrl+F inside a session opens a floating bar pinned to the top-right of the chat pane. Plain case-insensitive substring match scoped strictly to the rendered transcript — sidebar, headers, and collapsed tool blocks are skipped by construction. Enter advances, Shift+Enter retreats, both wrap around; the active hit auto-scrolls to the viewport's center. Count display shows `active/total`. Esc or the × button closes; closing clears the query. Implemented as `useFindInChat` (TreeWalker → `<mark data-find>` wrapping, debounced re-walks during streaming that preserve the user's reading position) plus a presentational `FindBar` component. 24 new tests (12 hook, 12 component) cover wrap-around, case-insensitive matching, stale-mark unwrapping, skip-attribute scoping, hidden-element filtering, and active-index preservation across re-walks. Design: `docs/superpowers/specs/2026-05-11-find-in-chat-design.md`.

### Fixed

- **Hook-feedback rendering.** The Agent SDK delivers stop-hook output (and `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `SubagentStop` / `Notification` / `SessionStart` feedback) as synthetic user-role text messages prefixed with `<Event> hook feedback:` or `SessionStart hook additional context:`. The renderer caught the `<system-reminder>` and skill-load shapes but not the bare hook-feedback prefix, so those messages fell through to the `user.prompt` card and looked like the user said them — and the model replied as if asked a question. New shared `isSystemContextText` helper centralizes the three patterns; `classifyStandaloneKind` now returns `user.systemContext` when every text block in a user-role message classifies as system context (mixed user-typed + appended-reminder messages still fall through to per-block rendering); `StreamMessage.tsx`'s inline detector uses the helper so the bare prefix shape also routes to `SystemContextWidget`. Adds 6 whole-message classification tests covering every hook event plus a negative case guarding mid-sentence false positives.

## [0.4.22] — 2026-05-10

A small UX fix for the inline `AskUserQuestion` card. When the agent sends 3-4 questions with previews the card can occupy ~60vh, hiding the chat content the user wants to consult before answering. A new chevron in the card header collapses it to a single header row so the chat above is visible again; click the chevron to re-expand and submit. Submit stays gated on expansion so you can't fire off answers you can no longer see.

Installers remain **unsigned**.

### Added

- **Collapsible `AskUserQuestion` card.** New chevron toggle in the header (`ChevronUp` / `ChevronDown`, with `aria-label` + `aria-expanded`) drops the scroll region and the Send/Cancel footer, leaving only the header row inline in the chat. Default is expanded — a fresh question always opens visible. State is component-local, so a new request always starts open. 3 new component tests in `AskUserQuestionCard.test.tsx`.

## [0.4.21] — 2026-05-10

A multi-area UX pass on the Projects and Sessions tables, plus a few supporting cleanups that came up while shipping it. Row-wide click is gone on both tables — you now launch a project or session via the explicit name/date link or the right-side launch icon, never by clicking anywhere in the row. New per-row Trash icons for permanent project / session deletion. Account badges adapt to light theme so bright hues stay readable. Thinking-config picker collapses to two states (Adaptive / Off) since "Budget" was a UI lie that produced identical model behavior. One stale-state bug fix for "Start Session warps me back to the session I just backed out of."

Installers remain **unsigned**.

### Added

- **Project-row launch + delete affordances.** Project name renders as a link-styled `<button>` with a trailing `ExternalLink` glyph; both fire `onProjectClick`. New right-most actions column with the launch icon and a Trash icon (shadcn confirm dialog with project path, account name, and session count).
- **`claude:deleteProject` IPC.** Permanently removes `<configDir>/projects/<projectId>` for the row's account. Hard `projectId` validation (rejects `/`, `\`, `..`, empty, `.`, leading-dot), idempotent `rmSync`, resolves `config_dir` strictly via `account_id` so deletion can't bleed into a sibling account whose path rule happens to match. Optimistic removal in the renderer with rollback on error. 5 new service tests + 7 new ProjectList click-semantics tests.
- **Session-row launch + delete affordances** (parallel treatment). Date cell becomes a launch `<button>` with the same trailing `ExternalLink` glyph. Right-side actions cluster consolidates launch + summary refresh + trash into one column (replacing two prior single-icon header cells). 4 new SessionList click-semantics tests covering Date launches, launch icon launches, dispatches the existing `claude-session-selected` CustomEvent, and the dead-cell contract.
- **Tab title and icon when drilled into a project's sessions.** The projects tab title becomes `<ProjectName>: Sessions` and the icon flips from Folder → List. Cleared on Back, on opening a session, on starting a new chat. New pure `getTabIcon(tab)` resolver in `TabManager.tsx` (extracted for direct unit testing) plus a `tab.icon` override path on the existing `Tab.icon?: string` field.
- **Account-filter dropdown badges.** Each option in the Projects-page Account filter renders as the resolved `AccountBadge` (color + icon + name), in both the dropdown items and the closed trigger. `'All'` gets a new gray `AllAccountsBadge` with a lucide `Infinity` glyph. `'(unassigned)'` reads as muted "No account" text.
- **`AccountBadge` `size="sm"` variant.** 12px text (`text-xs`) and a 15px icon, sized to match shadcn's text-xs container chrome (select dropdowns / triggers / etc.). The default `xs` (11px text + 14px icon) is unchanged for every other call site. 3 new size-variant tests.
- **Theme-aware `AccountBadge` colors.** Colored badges now adapt to the active theme via OKLCH `color-mix`. The gray (dark) theme keeps the original transparent-mix look; the light theme mixes the surface toward white and the foreground toward black so bright hues (yellow, cyan, rose) keep contrast on a near-white background. Same treatment on the compact (icon-only) chip variant. 3 new theme-aware tests.
- **`src/lib/thinkingConfig.ts`.** Canonical `type ThinkingConfig = 'adaptive' | 'disabled'` plus `normalizeThinkingConfig(value: unknown)` coercer. Used at every persisted-data read boundary. 4 new unit tests.

### Changed

- **Row hover affordance.** Both tables keep `hover:bg-accent/40` for visual scan-tracking but drop `cursor-pointer` and the row-level `onClick` — hover is presentational, not an affordance. Click targets are now exclusively the name/date link, the launch icon, and the trash icon.
- **`ThinkingConfig` collapses to two states.** `'adaptive' | 'budget' | 'disabled'` → `'adaptive' | 'disabled'`. The SDK's `setMaxThinkingTokens` already collapsed every non-zero value to adaptive on Opus 4.6+, so "Budget" was persisting a label that produced identical model behavior. Picker shows two rows: Adaptive and Off. Type tightens across `ControlBar`, `TabContext`, `src/lib/api`, and `electron/services/accounts`.
- **Stored `'budget'` values silently migrate.** `AccountsService.rowToAccount` runs a new `normalizeSessionDefaults()` over the JSON column on read; legacy `'budget'` flips to `'adaptive'`, truly unknown values get stripped. Same coercion at every renderer read point (`TabContent` form seed, `ClaudeCodeSession` state seed and account-defaults apply). No DB migration needed — coercion happens at every read boundary.
- **`queries.setThinking` simplified.** Drops the `enabled` (fixed-budget) branch — any caller still passing it lands on adaptive instead of falling through. Two branches now: `disabled` → `setMaxThinkingTokens(0)`, anything else → `setMaxThinkingTokens(null)`.
- **Sessions table chrome.** Outer wrapper restructured into a rounded `overflow-hidden` clipper + an inner scroll container so the sticky `<thead>`'s tinted background no longer bleeds past the rounded corners at the top. Sticky `<thead>` switches from `bg-muted/60 + backdrop-blur` to a fully opaque `bg-muted` — `backdrop-filter` opens its own stacking context with looser clipping that escaped the outer `overflow-hidden`, and the 60% alpha let scrolled rows paint through the header as ghosted text. Solid bg fixes both at once.
- **Account-filter trigger left padding.** The closed trigger had shadcn's default `px-3` (12px) eating the space before the badge; tightened to `pl-1` (4px) so the badge sits closer to the left border without crowding it.
- **CHANGELOG-only:** the `commit` skill in `.claude/skills/commit.md` and the `omnifex-release` runbook are unchanged in this release.

### Fixed

- **"Start Session warps me back to the previous session" (stale per-tab store).** `claudeSessionStore` keeps per-tab state (`messages`, `claudeSessionId`, `extractedSessionInfo`, `inflightAssistant`, …) keyed by `tabId`. On chat unmount the slice survived, so the next `ClaudeCodeSession` to mount on the same tab read the leftover state — `effectiveSession` (line 444) synthesized the previous session from `extractedSessionInfo` and the user landed back in the session they just backed out of, even though the SDK side had spawned a fresh subprocess. `handleStartNewSession` and `openSessionInTab` now call `useClaudeSessionStore.getState().resetTab(tab.id)` before flipping the tab type, guaranteeing the new mount starts blank.
- **Light-mode `AccountBadge` invisibility for bright hues.** A yellow / cyan / rose account on the light theme rendered as a near-white wash with bright-color text — no contrast for either text or border. Theme-aware `color-mix` (above) makes every hue land on a readable side of the contrast ratio in both themes.

### Removed

- **`'budget'` thinking-config option.** No model behavior change — the SDK already collapsed it to adaptive. UI label removed; persisted values coerced on read.
- **`THINKING_CONFIGS` Budget entry** (`{ id: 'budget', name: 'Budget', … }`).
- **The `enabled` branch in `queries.setThinking`.** Any caller still passing the `enabled` shape from the broader SDK type lands on adaptive.
- **`backdrop-blur` + `supports-[backdrop-filter]:bg-muted/60` from the Sessions table sticky header.** Replaced by the simpler opaque `bg-muted` (see Changed).

## [0.4.20] — 2026-05-09

A small typography polish on top of v0.4.19. The chat **Header** and **Content** weight pickers were limited to four choices (Normal, Medium, Semibold, Bold) — extended to the full nine standard CSS weights so the bundled variable typefaces (Inter, Geist, DM Sans, JetBrains Mono, iA Writer Quattro/Duospace, etc.) can be used at the weights they actually ship.

Installers remain **unsigned**.

### Added

- **Six new weight options on the chat Header / Content pickers:** Thin (100), Extra light (200), Light (300), Extra bold (800), Black (900). The dropdown is now ordered light → heavy: Thin → Extra light → Light → Normal → Medium → Semibold → Bold → Extra bold → Black. Each value maps to its standard Tailwind class (`font-thin` … `font-black`).

### Notes

- Not every bundled typeface ships every weight. IBM Plex Serif/Mono are 400-only; Plus Jakarta Sans and Oxanium start at 200; IBM Plex Sans tops out at 700. The browser falls back to the closest available weight on a miss, so all nine options remain selectable in the picker without surprises. The Inter, Geist, Geist Mono, DM Sans, JetBrains Mono, iA Writer Quattro, and iA Writer Duospace bundles cover the full 100–900 range.
- Saved `MessageRenderingConfig` records using the previous four weight values keep working unchanged — `WEIGHT_VALUES` was extended additively.

## [0.4.19] — 2026-05-09

A point release that closes the obvious gap left by 0.4.18's typography overhaul: the chat **Content** typeface picker only affected user-prompt bodies, not assistant markdown — so picking a distinctive Content typeface and seeing the assistant text stay on the App font read like the App font was overriding the chat setting.

Installers remain **unsigned**.

### Fixed

- **Chat Content typeface now applies to assistant markdown.** The `typography.content.typeface` selection is mirrored to a new `--chat-content-font` CSS variable on `:root` by `MessageRenderingProvider`, and `.prose` reads it via `font-family: var(--chat-content-font, inherit)`. Every prose surface in the chat picks it up: assistant text blocks, thinking content, fenced markdown blocks (`MarkdownBlock`), in-flight streaming bubble, subagent return marker, web-search result rendering. Previously these inherited `body`'s `--font-sans` (the App font) because no inline `fontFamily` was set on the `.prose` wrappers. Single CSS rule, single variable — no per-call-site plumbing. The Typography card's Content description was updated to reflect the new scope.

## [0.4.18] — 2026-05-09

Three things land together: an SDK parity bump, a typography overhaul that introduces a curated 13-typeface bundle plus a global App-font picker plus per-element typeface pickers on the chat surface (replacing the old abstract sans|serif|mono toggle), and a fix for a long-standing tab-spinner regression where the per-tab busy indicator cleared mid-turn the moment streaming text started, even though the turn was still wide open. The Settings → Appearance Typography card is reorganized into a 3-column layout (Header / Content / Card icon) — same controls, far less wasted vertical space.

Installers remain **unsigned**.

### Added

- **App-font picker** in Settings → General, just below the Theme selector. Single dropdown driving `--font-sans` globally for the whole UI (sidebar, settings, project list, dialogs). Six choices: Inter (default), Geist, Plus Jakarta Sans, DM Sans, IBM Plex Sans, Oxanium. Persists immediately via `app_font` setting; mirrors `ThemeContext`'s shape with a new `AppFontProvider`.
- **Per-element typeface pickers in the Typography card.** Header column and Content column each get a Font dropdown grouped by family tag (Sans / Display / Serif / Humanist / Mono). Each `<SelectItem>` previews its typeface inline. 13 bundled typefaces total: the 6 sans-tagged App fonts plus Source Serif 4, IBM Plex Serif, iA Writer Quattro, IBM Plex Mono, JetBrains Mono, Geist Mono, iA Writer Duospace.
- **Typeface catalog module** (`src/lib/typefaceCatalog.ts`). Single source of truth for typeface metadata (id, label, CSS family string, family tag). Drives both pickers and the schema migration.
- **`--app-font-stack` CSS variable.** `--font-sans` now reads from this var first with the existing Inter stack as fallback. `AppFontProvider` sets it on `:root` based on the persisted choice. First-paint behavior unchanged (Inter still wins until the provider mounts).

### Changed

- **`@anthropic-ai/claude-agent-sdk` 0.2.137 → 0.2.138.** Parity with Claude Code v2.1.138 (internal fixes only per upstream release notes). `@anthropic-ai/sdk` (`^0.81.0`), `@modelcontextprotocol/sdk` (`^1.29.0`), and `zod` (`^4.0.0` peer) constraints unchanged.
- **`MessageRenderingConfig.typography.{header,content}.family` replaced with `.typeface`.** The abstract `'sans' | 'serif' | 'mono'` enum is gone; each element picks a concrete typeface from the catalog. Parser migrates legacy records: `sans → inter`, `serif → source-serif`, `mono → jetbrains-mono`. Unknown typeface IDs fall back to `inter`. Migration is one-way; downgrading to a pre-0.4.18 build resets typography family to default.
- **Typography card layout rewritten** from a vertically stacked StyleRow pattern to a 3-column grid (Header / Content / Card icon). On narrow widths the columns collapse to a single column. The "Background opacity" slider label is shortened to "Bg opacity" to fit the narrower column.
- **Settings page header reclaimed.** The "Settings / Configure Claude Code preferences" h1 + caption block above the tab strip was pure decoration — the Settings tab in the app chrome already labels the page. Removed entirely; the conditional "Save Settings" button (rendered when there are pending changes) now sits at the right edge of the tab strip row, sized down and relabeled "Save". Reclaims ~100px of vertical real estate at the top of every Settings tab.
- **`<Select>` group labels restyled** as proper section headers — smaller (`text-xs`), uppercase tracking-wider, muted-foreground, with a tinted `bg-muted/40` strip extending edge-to-edge of the dropdown. Previously they shared the items' size + weight and visually blended into the list, especially in the font picker where each item is rendered in its own typeface. Only consumer today is the typeface picker, but the change is in the shared shadcn primitive so future grouped Selects get the same treatment.
- **Inter font now ships with its OFL license** (`src/assets/fonts/inter/LICENSE.txt`) — bringing the long-bundled typeface into compliance with the new one-LICENSE-per-typeface convention this release establishes.

### Fixed

- **Tab busy indicator stays on through partial-message turns.** The 0.4.17 partial-messages work introduced a regression where `setInflightAssistantText` flipped `isLoading: false` on the first text-delta flush — intended to let the streaming bubble visually replace the in-chat typing-dots spinner. But the in-chat spinner is already independently suppressed via `hasInflightAssistant`, so the side-effect on `isLoading` was redundant for its stated purpose; meanwhile `isLoading` is what drives the per-tab busy indicator (`mainTurnInFlight` in `usePublishTabStatus`). Tab spinners cleared the instant streaming started, even though the turn was wide open (more text, tool calls, results all still pending). After the first text segment landed in `messages[]` and the bubble unmounted, `isLoading` stayed false for the rest of the turn — sessions mid-tool-call showed no spinner, no typing dots, no bubble: looked dead. Removed the `isLoading: false` side effect; updated the existing store test that was encoding the buggy behavior; added a test that locks in `isLoading` is also preserved when already false.
- **Claude Code hook feedback no longer renders as user prompts.** Stop / PreToolUse / PostToolUse / UserPromptSubmit / SubagentStop / Notification / SessionStart / SessionEnd hooks emit feedback that Claude Code surfaces back to the model as a plain user text block prefixed with `<Event> hook feedback:` (or `additional context:` for SessionStart) — no `<system-reminder>` wrapper. The block-kind classifier only recognized `<system-reminder>` and the skill base-dir marker, so hook feedback fell through and rendered as a "You" card with a `user` chip. With OmniFex's own unfinished-todos Stop hook firing on every session-end attempt, this was particularly noisy. Now classifies as `user.systemContext` (same kind as skill / CLAUDE.md / system-reminder injections) via an anchored regex that won't false-positive on user-typed messages mentioning the same phrases mid-line.

### Removed

- **`FontFamily` type and `FAMILY_VALUES` constant** from `messageRenderingConfig.ts`. The abstract sans/serif/mono enum is no longer part of the public surface.
- **`font-sans` / `font-serif` / `font-mono` Tailwind class emission** from `typographyClassNames()`. Family is now applied via inline `style={{ fontFamily }}` from the catalog. The new `typographyFontFamily()` helper produces the value.

## [0.4.17] — 2026-05-09

Token-level streaming for assistant messages. Until now, when Claude took eight seconds to reply you stared at a typing-dots spinner. The Claude Agent SDK has supported `includePartialMessages: true` for a while — emitting `stream_event` deltas as tokens come off the model — but OmniFex wasn't using it. The renderer's reducer treated `messages[]` as an append-only list of complete SDK messages with no concept of an in-flight assistant. This release adds that: a per-tab text-buffer in a sidecar coalescer module, RAF-bounded flushes into a new `inflightAssistant` slot on the Zustand store, and a small `<InflightAssistantBubble />` that renders the buffered text directly. Bubble appears on the first delta, grows as deltas land, and unmounts cleanly when the canonical assistant message takes over.

Also in this release: a copy-button consolidation across all message cards (always at the top-right of the outer card, never pushed below a header), and the SDK bumped to 0.2.137.

Installers remain **unsigned**.

### Added

- **Streaming assistant text via `includePartialMessages: true`.** Flag set unconditionally in `electron/services/sessions/factory.ts`. The IPC subscriber in `ClaudeCodeSession.tsx` branches on `stream_event` ahead of the stream reducer, filters to `text_delta` content-block deltas from the parent agent (subagent partials are dropped — out of scope for v1), and routes the deltas through a new `src/lib/inflightCoalescer.ts` module. The coalescer accumulates per-tab text in a module-level `Map` and flushes once per `requestAnimationFrame` to a new `setInflightAssistantText` action on `claudeSessionStore`. The action also patches `isLoading: false` on the first flush, so the typing spinner naturally clears as the streaming bubble takes its place. The `<InflightAssistantBubble />` reads the slot via a narrow store selector and renders `inflight.text` through `ReactMarkdown` with the project's existing markdown component dispatcher. Reconciliation: the IPC subscriber clears the inflight slot on assistant append (matching the reducer's `'append'` decision), on system/notification messages with a notification_type matching `/error/i` (catches `error`, `rate_limit_error`, `auth_error`, etc.), and on tab unmount. The bubble is wrapped in `<AnimatePresence>` so the unmount is a brief opacity fade-out instead of a hard snap. **No new IPC channels** — `runtime.ts` already forwarded stream events on `claude-output:${tabId}` and `classifyRuntimeEvent` already returned a `streamEvent` kind from a prior cleanup pass; this release wires the renderer side that was deferred at that time.
- **`stream_event` defensive skip in the stream reducer.** `reduceSessionStreamMessage` now early-returns `{ append: 'skip', effects: [], metrics: EMPTY_METRICS_DELTA, costDelta: 0 }` when it sees `type: 'stream_event'`. The IPC subscriber's branch (above) intercepts these messages before the reducer runs, so this is a defensive safety net — if a future code path bypasses the IPC branch, stream events still won't land in `messages[]` as garbage entries.
- **Card-level copy button on assistant and result message cards.** Single Copy button, anchored top-right of the outer `Card`, hover-revealed via `group/card`. Copies the entire message via `extractCopyText` (text + tool_use args + tool_result body, joined by newlines).

### Changed

- **`@anthropic-ai/claude-agent-sdk` 0.2.133 → 0.2.137.** Parity bump to Claude Code v2.1.137. `resolveSettings()` (alpha) was added in 0.2.136 — useful for inspecting effective merged settings without spawning the CLI. The `TodoWrite` tool was marked deprecated in 0.2.136 in favor of forthcoming `TaskCreate` / `TaskGet` / `TaskUpdate` / `TaskList` tools, but the 0.2.137 type defs don't yet enumerate the new tool names — the model still emits `TodoWrite` and OmniFex's existing TodoBar / TodoWidget routing remains correct. Migration tracked as future work.
- **`zod` 4.3.6 → 4.4.3.** Peer dependency of the SDK; well within the SDK's `^4.0.0` range.
- **Copy buttons consolidated.** Per-block copy buttons on assistant cards (one per text/thinking/tool widget, anchored to the top of each block's wrapper) were inconsistent — when a `KindHeader` rendered above them they appeared "pushed down" below the header rather than at the top-right of the card. Result and Error cards had no copy button at all. The outer Card now owns one Copy button at top-right; per-block copy and the `relative group/card` per-block wrappers were removed.

### Removed

- **`extractToolCopyText` helper.** Per-block copy was the only caller; deleted along with the per-block buttons.

## [0.4.16] — 2026-05-08

The Projects list's "Last activity" column was lying. It was sorting by the newest file mtime found by recursively walking each project's working tree (depth ≤ 8, ≤5000 stats per project, hardcoded exclude list) — which meant any `git pull`, formatter run, or editor save bumped a project ahead of one where you'd actually had a Claude conversation an hour ago. Worse, projects whose on-disk folder was deleted sank to the bottom even when they had real recent session history. The column now sorts by the newest Claude session JSONL mtime directly.

Installers remain **unsigned**.

### Changed

- **"Last activity" sorts by Claude session activity, not filesystem walk.** `ProjectList`'s comparator and cell render now read `most_recent_session` (newest `*.jsonl` mtime in the Claude config dir) instead of the synthesized `last_activity_at`. Editing or building files in the working tree no longer reorders the list; a project whose on-disk folder was moved or deleted now correctly surfaces its last real Claude session. The column tooltip was rewritten to match. Tradeoff: a project that exists in the Claude config but has no session JSONLs yet renders an em-dash and sorts last (was: showed the working-tree mtime).

### Removed

- **`findMostRecentMtime` and the `last_activity_at` field.** The recursive project-tree walker, its exclude set (`node_modules`, `.git`, `dist`, `build`, `target`, `.next`, `.vite`, `.venv`, `__pycache__`, etc.), and its depth/stat-budget caps are gone. `Project.last_activity_at` was dropped from both the renderer and main-process types. Net deletion of ~140 lines and one filesystem walk per project per `listProjects()` call.

## [0.4.15] — 2026-05-08

Two threads this release. The session-list panel got a layout overhaul: summaries are collapsible again, the table is bounded to the viewport with a sticky header, and pagination is gone — every session for a project lives in one scrollable list. Separately, the Claude Agent SDK bumped to `0.2.133`, which deprecated the `unstable_v2_*` symbols; the one consumer (`summary-query`) migrated off them.

Installers remain **unsigned**.

### Changed

- **Session-list table is now bounded + scrollable.** The project view's outer container switched from page-level scroll (`h-full overflow-y-auto`) to a flex column. Header, new-session form, and branch-colors row stay at natural height; the SessionList region claims the rest with `flex-1 min-h-0`. Inside SessionList the table wrapper is `overflow-y-auto` and `<thead>` is `sticky top-0` with an opaque background, so column labels stay visible while rows scroll under them. Long lists no longer push the page off-screen.
- **Expandable session summaries restored.** Each row defaults to collapsed (only the headline shows); a chevron toggles the bullets/paragraph. Per-row state lives in a `Set<string>` so rows expand independently. Restores the affordance removed in v0.4.8 — practical now that the table is bounded.
- **Pagination removed.** The 12-per-page Previous/Next/page-N control is gone — the bounded scroll container makes it redundant. `sessions.map(...)` renders every row; the user scrolls to find what they want.
- **Claude Agent SDK 0.2.132 → 0.2.133.** Upstream marked `unstable_v2_createSession`, `unstable_v2_prompt`, and `unstable_v2_resumeSession` `@deprecated` ("will be removed in a future release"). `query()` is the official replacement. The summary path was the only consumer of `unstable_v2_prompt`; it now uses a small `runQueryOnce(queryFn, message, options)` helper that iterates the streaming `Query` to its first `result` message and closes the handle on every exit path. No behavior change — same scratch-cwd, same permission lockdown, same projects-dir cleanup.

## [0.4.14] — 2026-05-07

Small polish on the native macOS notifications that fire for permission-channel prompts. Previously every prompt read "Task Complete — Permission requested: <Tool>", which was misleading on its face and especially wrong for the SDK's `AskUserQuestion` tool (the agent is asking *the user* something, not requesting a tool). The kind label now lives in the subtitle and the body carries a real summary of the request.

Installers remain **unsigned**.

### Changed

- **Permission-prompt notifications.** Subtitle is now `Permission Request:` for tool prompts and `Answer Needed:` for `AskUserQuestion`, replacing the default `Task Complete` / `Task Failed`. Body shows the SDK-provided title/displayName when available, otherwise a tool-aware summary (`$ <command>` for Bash, `<Tool> <file_path>` for Read/Write/Edit/MultiEdit/NotebookEdit, `WebFetch <url>`, `<Tool> <pattern>` for Glob/Grep). `AskUserQuestion` shows the first question text. All bodies trim to 140 chars. Plumbed via a new optional 5th `options` argument on `NotificationsService.show` and `NotificationHooks.showNotification` carrying `{ subtitle }`; non-permission notifications keep the existing default subtitle behavior.

## [0.4.13] — 2026-05-07

Reliability pass on the `/usage` runner driven by Claude Code 2.1.132's TUI changes — the fetch was timing out, missing the Sonnet bar, and showing dropped characters in the popover ("Longer sessi ns are more expensive…"). The runner now sidesteps Claude's first-launch safety dialog by pre-trusting a per-account scratch folder, recognizes both old and new welcome-screen wordings, tolerates cursor-redraw corruption of the Sonnet header, waits patiently for late-rendering blocks, and post-processes the captured text against the buffer's own vocabulary to recover dropped characters. The popover also gains the three ranked tables Claude shows under "What's contributing" (Skills, Subagents, Plugins), Settings drops three dead fields plus the per-account picker, and the Log tab's prune controls collapse into a single count + period dropdown.

Installers remain **unsigned**.

### Fixed

- **`/usage` no longer times out on Claude Code 2.1.132's first-launch safety dialog.** A new helper at `electron/services/usage-runner/scratch-cwd.ts` creates a per-account empty scratch directory under `<userData>/usage-cwd/<accountKey>/` and writes `projects[<absPath>].hasTrustDialogAccepted: true` into `<configDir>/.claude.json` (atomic temp + rename, idempotent). The runner spawns the Claude CLI in that folder instead of the user's home directory, so the safety dialog never fires.
- **Welcome-screen detection covers Claude Code 2.1.132's new footer.** Replaced the single `READY_MARKER = 'for shortcuts'` with a multi-marker check that matches either `for shortcuts` (pre-2.1.132) or `shift+tab to cycle` (2.1.132+). When Claude reworords the footer again, the failure mode is loud: a `warn` log with the full captured raw buffer.
- **Sonnet bar surfaces despite cursor-redraw corruption of its header.** The `week_sonnet` header regex was loosened from the strict literal `Current week (Sonnet only)` to `Current week (\s*Son[^)]*\)`, which matches both the clean form and observed corruptions like `Current week (Son et nly)` while still excluding `(all models)`.
- **Patient parsing for late-arriving blocks.** New `incompleteParseGraceMs` (default 3000ms) extends the wait when the buffer goes quiet but the parse hasn't yet hit all three windows — Claude sometimes async-renders the Sonnet block over a "Refreshing…" placeholder after the rest has stilled. Falls back to snapshotting whatever has arrived if the grace expires.
- **Vocabulary-driven character-corruption repair.** New `electron/services/usage-runner/repair.ts` recovers single-character corruption introduced by Claude's cursor-positioning redraws (`sessions` → `sessi ns`, `Approximate` → `App oximate`, `Sonnet only` → `Son et nly`, `Resets 7am` → `Rese s 7 m`). For each adjacent token pair `<A> <B>` separated by a single space on the same line, splices in any vocabulary word matching `A + ?c + B` of length `len(A) + 1 + len(B)`. Conservative guardrails: never merges if both fragments stand alone elsewhere in the buffer, never crosses newlines, length-gated, applied iteratively until quiescent.

### Added

- **Skills / Subagents / Plugins ranked tables in the `/usage` popover.** Claude shows three "% of usage" tables under "What's contributing" — these were previously dropped on the floor. The parser now extracts them as `{ rows: { name, pct_used }[], more_count }` and the popover renders them as inline percent-bar lists matching the existing limits-window visual language. Includes the trailing `… N more` marker when Claude truncates.
- **Comprehensive structured logging on the `/usage` runner.** Every phase emits a structured `app_logs` entry — `run start`, `welcome ready`, `trust dialog observed despite pre-trust` (defensive), `/usage sent`, `parse incomplete — extending wait for late chunk`, `usage capture (pre-parse)` with the full raw buffer, `repaired corrupted words from buffer vocabulary`, `parse ok`, `parse failed`, and the timeout path now logs the captured raw too. Visible in Settings → Log filtered by `usage-runner`.
- **Log-tab prune dropdown for arbitrary "older than N <unit>" cutoffs.** The single Count (1–24) + Period (hours / days / weeks / months) + 🗑 Clear control replaces the previous "Older than 1 week / 1 month" buttons. Backend `parseOlderThan` already accepted `Nh / Nd / Nw / Nm`, so this is a renderer-only change.

### Removed

- **General-tab Claude-settings toggles + the per-account picker that scoped them.** `includeCoAuthoredBy` (deprecated upstream in favor of `attribution`), `verbose` (undocumented and unused — OmniFex's actual rendering preference is the Chats tab's `defaultViewMode`), and `cleanupPeriodDays` (load-bearing but rarely tuned; 30-day default is sane) are gone. With nothing in `Settings.tsx` consuming the per-account `getClaudeSettings`/`saveClaudeSettings` flow anymore, the "Editing Claude settings.json for…" picker was retired too. `RateLimitsSettings`'s dead `settings`/`updateSetting` props were removed; `SettingsPanelProps` shrunk to just `setToast`.

## [0.4.12] — 2026-05-07

UX cleanup pass on background-tab signals. The biggest fix is for sessions that ended up stuck on a "Crafting…" spinner with an amber **Awaiting Background Work** card after the parent's success result — when the bg dispatch's completion arrived as XML on a `queue-operation` enqueue (or an `attachment.queued_command`) instead of as a structured `task_notification` SystemMessage, the reducer ignored it and the subagent stayed `running` forever. The reducer now reads both envelopes and routes them through the same close path. The Sessions popover also gained finer-grained labels for tabs paused on the user, and `AskUserQuestion` no longer overlays the chat as a modal Dialog.

Installers remain **unsigned**.

### Fixed

- **Stuck "Crafting…" spinner / amber "Awaiting Background Work" card after a successful turn.** `deriveSubagents` in `src/lib/subagentStreams.ts` now parses `<task-notification>…</task-notification>` payloads carried by `queue-operation` enqueues and `attachment.queued_command` envelopes, pulls the embedded `<tool-use-id>` / `<status>` / `<summary>`, and routes through the same close path as the structured `task_notification` SystemMessage. Closes the zombie-running-subagent case that kept the spinner pinned, the amber card showing instead of the green success card, and the SubagentBar entries stuck on "Waiting for first progress event…". Only acts on tool_use_ids it has already seen so notifications never fabricate orphan subagents.
- **`AskUserQuestion` no longer overlays the chat as a modal Dialog.** The card now renders inline at the bottom of the chat alongside `PermissionCard`, using the same per-kind translucent container, so the surrounding agent context stays visible and the originating tab naturally surfaces the question without any focus tricks.

### Added

- **Tab-status popover surfaces "Permission Request" / "Question Waiting".** Background tabs paused on a permission grant or an `AskUserQuestion` prompt now show an indigo badge with the specific label instead of the generic "Busy" badge, so it's obvious at a glance which tab needs you. Driven by a new `waitingFor` field on `TabStatusSummary` derived from the session's pending permission via a small pure helper.

## [0.4.11] — 2026-05-06

Hot-fix on top of v0.4.10. Manual summary generation in the dev/Electron app failed with `[ENOTDIR] spawn ENOTDIR` because the V2 SDK summary path didn't set `pathToClaudeCodeExecutable` explicitly and the SDK's auto-resolver doesn't work reliably from Electron's bundled main process. The summary path now uses the same binary probe the interactive sessions path has always used.

Installers remain **unsigned**.

### Fixed

- **Manual summary generation no longer fails with `[ENOTDIR] spawn ENOTDIR`.** The V2 `unstable_v2_prompt` runner now sets `pathToClaudeCodeExecutable` explicitly via `findSystemClaudeBinary()` (system installs → SDK-bundled fallback), matching the interactive V1 sessions path. If no binary can be resolved at all, the runner throws a descriptive error instead of letting the renderer see an opaque spawn failure. Lines up with Wave 6 audit item 6.3 ("Claude binary resolution is fragmented across subsystems") — a follow-up is still queued to route every probe site through `claude-binary.ts::findBestBinary`.

## [0.4.10] — 2026-05-06

Bug-fix release. The back-button on a session was generating a summary even when "Generate summaries automatically when leaving a session" was disabled — the lifecycle close hook gated correctly but the back-button path bypassed it. Now both leave-the-session entry points respect the same toggle.

Installers remain **unsigned**.

### Fixed

- **Back-button no longer auto-generates a summary when auto-on-close is off.** The "Back to project" button in `ClaudeCodeSession` now goes through the same `enabled && autoOnClose` gate as the lifecycle close hook in the main process, so flipping "Generate summaries automatically when leaving a session" off actually stops it. The manual refresh button on session rows is still ungated by design — that path is an explicit user action.

## [0.4.9] — 2026-05-06

Session-summary overhaul. The Settings → Sessions tab is now **Session Summaries**, with a master enable switch, instant-save edits to the prompt template, and a separate auto-on-close toggle. Per-row spinners now animate for background generations triggered by closing or backing out of a session. Default summary prompt rewritten to ask for higher-level themes instead of CV-style bullets.

Installers remain **unsigned**.

### Added

- **Master "Enable session summaries" switch** in Settings → Session Summaries. When off, rows fall back to first-message previews and the per-row refresh icon is hidden.
- **Live spinner for auto-on-close generations.** When you back out of a session, the matching row on the project page now spins its refresh icon for the duration of the model call (success or failure clears it). Survives the back-button race by seeding state from a mount-time query against the in-flight set.
- **Auto-save** for the summary-prompt textarea (debounced) — Save and Cancel buttons removed.
- New unit-test coverage: dedicated panel-level tests for `SummaryPromptSettings`, plus tests for the V2 SDK summary-query runner, the generation-state event boundary, and the spinner-mount-seed race fix.

### Changed

- **Summary prompt default** rewritten — asks for a higher-level headline + 2–3 bullets capturing themes (general area, broader goals, problem being solved) instead of CV-style outcome bullets. Existing installs keep whatever prompt they have; click Reset to default in the panel to pick up the new wording.
- **Switched to V2 SDK `unstable_v2_prompt`** for one-shot summarization. Each call runs in a single stable scratch cwd (`os.tmpdir()/omnifex-summary-scratch`) and the resulting `<configDir>/projects/<scratch>/` directory is swept after the call — stops piling up one throwaway folder per summary in the user's session list.
- **Auto-on-close gating split.** "Generate summaries automatically when leaving a session" only gates the close lifecycle now; the manual refresh button stays available regardless. The master "enabled" switch gates UI visibility everywhere.
- **Session summary on each row** always shows headline + bullets together — expand/collapse chevron removed.
- **Settings tab** renamed from "Sessions" to "Session Summaries".
- **Claude Agent SDK** `@anthropic-ai/claude-agent-sdk` 0.2.131 → 0.2.132.

### Removed

- **Per-account "Generate Summaries" toggle** in Account Settings. The master toggle in Session Summaries replaces it. Per-account model picker stays. The SQLite column is kept harmlessly for back-compat but no longer read.
- **Save / Cancel buttons** on the summary-prompt panel — auto-save handles persistence.

## [0.4.8] — 2026-05-06

Dependency bump only — keeps OmniFex on the latest Claude Agent SDK.

Installers remain **unsigned**.

### Changed

- **Claude Agent SDK** `@anthropic-ai/claude-agent-sdk` 0.2.129 → 0.2.131.

## [0.4.7] — 2026-05-06

Per-session AI summaries on the project tab — opt-in per account, generated by the model of your choice when each session's tab closes. Plus a per-row delete action, a slimmer Settings dialog, a redesigned account-edit dialog, and a project-list sort flip to surface what you've actually been working on most recently.

Installers remain **unsigned**.

### Added

- **Per-session AI summaries** on the project tab. Each session row shows a one-line headline (with a chevron-expandable body) generated by the model you select. A `↻` button regenerates on demand; it disables itself when the JSONL file size hasn't changed since the last successful summary (no API spend on no-op clicks). Auto-on-close re-runs every time you close a tab so resumed work picks up new content. Summaries now render as a **3–6 bullet "resume-style" list** rather than a paragraph; legacy paragraph-style sidecars still render correctly until they're regenerated.
- **Sidecar JSON files** (`<session-uuid>.summary.json`) cache each summary next to the JSONL. Atomic writes (tmp + rename), schema-versioned for forward-compat, survives reinstalls. A `promptVersion` field invalidates the size-gate when the active prompt template changes, so an edited prompt re-runs even on JSONLs that haven't grown.
- **Per-account opt-in** in Account Settings — a "Generate summaries when sessions close" toggle plus a Summary-model picker. Cost estimate shown inline (Haiku 4.5 ≈ $0.005–$0.05/session, Sonnet 4.6 ≈ $0.015–$0.15/session, Opus 4.7 ≈ $0.075–$0.75/session). Pro/Max users: pulls from your plan allotment, not billed per-token.
- **Editable summary prompt** in the Settings dialog — change the template, save, and the next summary uses it. `promptVersion` sidecar gating means edits invalidate stale cached summaries automatically.
- **Per-row delete on the session list** — trash icon → confirm dialog → permanently removes the session JSONL plus its `*.summary.json` and `*.todo.json` sidecars in one shot. New `claude.deleteSession()` service + `delete_session` IPC channel.
- New IPC channels: `summary_get`, `summary_generate`, `update_account_summary`, `delete_session`. New event channel: `session-summary:updated` (broadcasts when a sidecar is written so open session lists refresh in real time).

### Changed

- **`SessionList.tsx` row layout** — the "First message" column is now "Summary" and replaces the truncated first-user-message preview with the AI-generated headline when a sidecar exists. Falls back to the existing first-message preview when no summary is on disk yet. Cached summaries hide automatically when the resolved account has summarization toggled off, without needing a tab switch.
- **Account-edit dialog redesigned** — popover-based session-defaults editor, compact form variants for directory/type inputs, tightened spacing throughout.
- **Settings dialog slimmed down** — Permissions, Environment, Advanced, Hooks, and Commands tabs removed. Those keys are configured outside this dialog now (in-session permission prompts, the project hook editor, the slash-command manager). The dialog now reads/writes the default account's `config_dir` for the remaining General/Proxy keys.
- **Project list default sort flipped** from "Sessions" to "Last activity" (descending). The "Last opened" column was renamed "Last activity" and is sourced from the newest file mtime inside the project folder rather than the most recent session JSONL — projects with active edits but no recent Claude session now sort to the top.
- **`accounts` table** gains `summarizeOnClose` and `summaryModel` columns (migration v7). Defaults to off for existing accounts — pure opt-in.
- **AccountBadge** icon size bumped 11px → 14px for visual balance against the label (badge height unchanged).
- **Claude Agent SDK** `@anthropic-ai/claude-agent-sdk` 0.2.128 → 0.2.129.

### Fixed

- **Titlebar version badge** no longer shows the green "Up to Date" pill when the bundled SDK is itself out of date — the badge now waits on the SDK check before claiming everything's current.
- **Summary JSONL discovery** anchored on the resolved account's `configDir`, never silently falling back to `~/.claude` — fixes summaries failing on multi-account setups where the active project lives under a non-default account.
- **Back-button summary trigger** — closing a session via the back arrow now triggers the same auto-on-close summary path as the tab close.
- **Refresh icon** is hidden on rows whose account has no summary model configured (instead of rendering a no-op button).

## [0.4.6] — 2026-05-05

Markdown rendering inside assistant messages got a real polish pass: fenced ` ```markdown ` blocks now have a Rendered/Source toggle and a copy-source button, and code-block chrome is consistent across all three fence variants (markdown, syntax-highlighted, untagged). Fixed a long-standing first-line indent artifact on syntax-highlighted blocks. The slash-command picker now correctly labels project-local skills as **PROJECT** instead of mislabeling them as **DEFAULT**.

Installers remain **unsigned**.

### Added

- **`MarkdownBlock` Source/Rendered tabbed component** for fenced ` ```markdown ` / ` ```md ` blocks. Pill toggle (Rendered is default) plus a copy-source button; the copy button always copies the raw markdown source regardless of which view is active. Markdown fences nested inside markdown fences recurse — each `MarkdownBlock` instance owns its own toggle state.
- **`buildMarkdownComponents` dispatcher** (`src/lib/markdownComponents.tsx`) — single source of truth for `react-markdown`'s `code` component override. `language-markdown` / `language-md` → `MarkdownBlock`; any other `language-*` → Prism `SyntaxHighlighter`; no language → plain `<code>` (inline path). `StreamMessage` now uses this helper instead of duplicating the `code` override.

### Changed

- **Code-block chrome unified across all three fence variants**: ` ```markdown ` blocks (MarkdownBlock card), ` ```typescript `/etc. (`SyntaxHighlighter` wrapper), and untagged ` ``` ` blocks (prose `<pre>`) now all render with the same `var(--color-card)` panel color, `border-border/50`, and `rounded-md` chrome. No more concentric cards from the prose `<pre>` wrapping a MarkdownBlock card.
- **`MarkdownBlock` controls** moved above the content card (instead of overlaying it). Pill toggle group + copy button sit on a small bar above the rendered/source panel.

### Fixed

- **First-line indent on syntax-highlighted code blocks** is gone. Root cause: `SyntaxHighlighter` was using `PreTag="div"`, so `<code>` had no `<pre>` ancestor and Tailwind Typography's `.prose pre code` reset never fired — leaving `.prose code`'s inline horizontal padding visible at the start of the first line in multiline blocks (directory trees, multi-import imports, etc.). Removed `PreTag="div"`; inline `customStyle` neutralizes the inner prose `<pre>` chrome so the wrapper card stays the only visible card.
- **`<pre>` passthrough is now conditional** in `buildMarkdownComponents`: tagged fences skip the prose `<pre>` (their inner component owns the card); untagged fences keep their `<pre>` so `white-space: pre` still preserves newlines. Earlier unconditional passthrough collapsed multiline ASCII trees onto one wrapped line.
- **Slash-command picker now labels project skills as PROJECT** (and user skills as USER), instead of mislabeling everything from the Claude Agent SDK as DEFAULT. The slash-commands service now also scans `<projectPath>/.claude/skills/<name>/SKILL.md` and `<configDir>/skills/<name>/SKILL.md`, emitting them as scoped pseudo-commands; the picker's existing dedup (custom commands win over SDK defaults) re-tags SDK-reported skills with the correct scope.
- **Horizontal bleed in card bodies** is clipped via `overflow-x-auto` so wide inline content (long URLs, source spans) no longer pushes the card past the message column.

## [0.4.5] — 2026-05-04

Polish pass on the Sessions popover and a small QoL improvement in the active session view.

Installers remain **unsigned**.

### Added

- **Scroll-to-top / scroll-to-bottom buttons** on the right edge of the messages panel in the active session view. Stacked chevron-up / chevron-down icon buttons styled to match the chatbar — useful for jumping around long conversations without manually dragging the scrollbar.

### Changed

- **Sessions popover styling overhaul** to match the visual language of the in-session header cards:
  - Body background is now `bg-background` (matching the messages area), with a separate `bg-popover` strip behind the "Tab Status" header.
  - Tab cards use the same translucent fill as the session header's account / branch / session cards (`color-mix` of background + muted), the same 1px-ring + offset-shadow treatment at 45% muted-foreground, and a header-divider rendered via the same shadow color so the border tone matches the card ring exactly.
  - Card header strip uses `bg-muted` for the lighter "title" band, mirroring the session header bar.
- **Branch chip in tab cards** now uses the same chip styling as `GitBranchBadge` in the session header — palette colors via `resolveBranchColors` (palette-rotated across visible tabs), trunk-black for `main` / `master`, and inline `FilePen` (changed) / `FilePlus` (untracked) counts on the chip itself.
- **Context-size widget in tab cards** replaced the plain solid progress bar with the `SessionCard` widget — `Database` icon, k-formatted token count (color shifts orange/red as usage rises), green→orange→red gradient bar with `clip-path` masking, and percentage. Wider gradient bar (`w-24`) for a more readable scale.
- **Labeled rows** in tab cards: `Current Branch:` and `Context Size:` are now `HeaderLabel`-styled and share a fixed label column (`w-28`) so the chips line up vertically. Other rows (turn / agents / todos) stay label-less.
- **Bumped `@anthropic-ai/claude-agent-sdk`** to `0.2.128` (from `0.2.126`). Patch bump; transitive deps and the `zod` peer all unchanged.

## [0.4.4] — 2026-05-04

New **Sessions popover** in the titlebar (atom icon) showing live per-tab status — busy roll-up, main-turn flag, active agent count, todos progress, branch + files changed/untracked, context usage. Click a card header to jump to that tab. Solves the "1 active — Install Anyway" mystery from v0.4.3 by giving you direct visibility into which tab is actually busy and why.

Same architecture also fixes the install-gate predicate-drift bug from v0.4.3: each tab publishes its busy state up to a new main-process aggregator, and both the popover and the installer's wait-for-idle gate read from the same authoritative source. No more leaks where trailing `task_notification` events bumped a session's lifecycle status back to "running" between turns.

Installers remain **unsigned**.

### Added

- **Sessions popover** (`src/components/TabStatusPopover.tsx`) — atom-icon button in the titlebar with a busy-count badge. Popover lists all open chat tabs in tab-bar order; each card header is clickable (jumps to that tab and closes the popover). Click outside or Esc to dismiss. Shows for each tab: status badge (not-started / starting / idle / busy / error), context usage with progress bar, branch + files changed/untracked, main-turn flag, active agent count, todos progress (`X of Y · N pending`).
- **Main-process tab-status aggregator** (`electron/services/tab-status.ts`) — insertion-ordered map of renderer-published per-tab summaries with shallow-equality-skipped broadcasts. New IPC: `tab_status_publish`, `tab_status_remove`, `tab_status_list`; new event channel: `tab-status:changed`. 11 unit tests (TDD).
- **`usePublishTabStatus` hook** — derives the summary from messages / `isLoading` / subagents / todos / git / context-usage and publishes on every change. Removes the entry on unmount.
- **Titlebar segmented-control button group** (`Lima · Sessions · Settings · Updates`) — single bordered container with internal hairline dividers, 16px icons paired with text labels.

### Changed

- **Installer's `listInFlightTabIds`** now reads from the new `TabStatusService.busyTabIds()` (renderer is the canonical interpreter) and falls back to `sessionsService.listInFlightTabIds()` only on cold start before any tab has reported. Fixes the v0.4.3 leak where trailing `task_notification` events flipped lifecycle status back to "running" and stuck the install gate. The "X active — Install Anyway" badge in the upgrade button now also reflects the renderer's authoritative count.
- **Spinner gate folds in pending todos.** The in-tab typing-bubble previously activated only on `isLoading || hasRunningSubagent`; now also lights up while a TodoWrite list has pending or in_progress items, matching the popover's "busy" definition (turn || agents || todos).
- **TodoBar matches SubagentBar.** Removed the auto-expand-on-TodoWrite / 5-second-auto-collapse state machine and replaced it with a single `collapsed` flag persisted in `localStorage` (`greychrist.todoBar.collapsed`). User toggles only — no drift between auto and pinned states.
- **TodoBar's "Clear" button no longer shows a confirmation prompt.** One-click dismiss; the bar will reappear when the agent emits a fresh TodoWrite.
- **Predicate ordering in the popover summary**: `sessionStarted` now wins over `isStarting`, so an active session can't fall back to "Starting…" badge after `fetchInitInfo` returns.
- **`useSessionLifecycle.fetchInitInfo`** now clears `isSessionStarting` when it sets `isSessionActive` — mirrors the `rebindPersistentSession` path. Was a pre-existing inconsistency; only the new popover surfaced it.

### Removed

- `src/lib/todoBarState.ts` and its tests — replaced by the simple boolean toggle described above.

## [0.4.3] — 2026-05-04

Session reliability pass — three coupled bugs in the prompt queue and the spinner gate, surfaced together because they all hit the same "what's outstanding right now?" question.

Installers remain **unsigned**.

### Fixed

- **Queued prompts no longer auto-post when the running turn finishes.** `useSendPrompt`'s queue gate read `isLoading` from a render closure, so the drain path's `setTimeout`-deferred call invoked a stale function that re-queued the prompt instead of sending it. The queue then sat forever with nothing to trigger another drain. Switched the gate to read from a live `isLoadingRef` (synced from state in `ClaudeCodeSession.tsx`) so the gate sees the current value at call time.
- **Pasted images dropped from queued prompts.** Queue items only stored `{ id, prompt, model }` and the drain in `runStreamEffect` only forwarded `prompt + model`. Added `images?: string[]` to the queue-item shape, stored at enqueue time, and passed through on drain so a queued prompt with images sends as the same structured-content blocks an inline submission produces.
- **Spinner disappeared while the "Awaiting Background Work" card was still showing.** The spinner gate (`isWaitingForBackground`) required `isBackground === true`, but the result classifier (`classifyStandaloneKind`) renders the awaiting card for *any* running subagent — Agent/Task/`run_in_background` Bash alike. So a still-running plain Task or Agent dispatch left the card on screen with no spinner after the parent turn ended. Replaced with `hasRunningSubagent` (`status === 'running'`), so both the card and the spinner share one definition of "outstanding response."

### Changed

- `useSendPrompt` now takes `isLoadingRef: MutableRefObject<boolean>` instead of `isLoading: boolean` (caller in `ClaudeCodeSession.tsx` keeps the ref in sync via a one-line `useEffect`).
- `QueuedPrompt` (in `sessionStreamEffects.ts`) and `QueuedPromptItem` (in `useSendPrompt.ts`) gained an optional `images` field; `runStreamEffect`'s `processQueuedPrompt` arm forwards it to `handleSendPrompt`.
- `subagentStreams.ts`: `isWaitingForBackground` removed; replaced with `hasRunningSubagent`. Doc-comment now points at the classifier as the parallel source-of-truth so the two predicates can't drift again.

### Tests

- New `src/hooks/__tests__/useSendPrompt.test.tsx` covers the stale-closure scenario directly: a captured-while-loading function is invoked after `isLoadingRef.current` flips to `false`, and we assert it dispatches via `api.sendMessage` instead of re-queueing. Also asserts images survive both the queue path and the structured-message send path.
- `sessionStreamEffects.test.ts` extended: `processQueuedPrompt` test now asserts the third (`images`) argument is forwarded.
- `subagentStreams.test.ts`: `isWaitingForBackground` block replaced by `hasRunningSubagent` block reflecting the new "any running" semantics.

## [0.4.2] — 2026-05-03

App renamed from **GreyChrist** to **OmniFex**. The shipping product is now OmniFex; the publishing entity remains GreyChrist, LLC ("by GreyChrist, LLC" appears under the app title). Bundle ID, executable, .app name, ZIP filename pattern, notification dialog titles, and user-visible UI strings all carry the new name. Internal identifiers (`greychrist.db`, `greychrist-file://` protocol, localStorage keys, signing-cert identity) are intentionally unchanged to avoid migration churn.

### Manual upgrade required

The .app bundle name changed (`/Applications/GreyChrist.app` → `/Applications/OmniFex.app`), so the v0.4.1-and-earlier auto-installer cannot replace itself with v0.4.2. **First-time install of OmniFex must be manual**: drag `OmniFex.app` into `/Applications` and trash the old `GreyChrist.app`. Subsequent OmniFex → OmniFex updates auto-install normally.

### Added

- **Userdata migration on first launch** (`electron/services/userdata-migration.ts`). Detects the legacy `~/Library/Application Support/GreyChrist/` directory and copies it once into the new `~/Library/Application Support/OmniFex/` location. Drops a `.migrated-from-greychrist` marker so it never re-runs. Idempotent; refuses to overwrite a populated new dir. Backed by 6 unit tests covering the empty/populated/already-migrated/no-legacy permutations.
- **Rich upgrade-check popover** (`src/components/CustomTitlebar.tsx`). The CircleFadingArrowUp icon next to Settings now opens a hover popover showing app version, referenced Claude SDK, and latest Claude SDK on npm — with a green ✓ when matched and amber ⚠ when out-of-date. The icon itself tints amber when the SDK is out-of-date so the warning is visible without hovering. Click still triggers the underlying check.
- **Minimum spin time on upgrade checks.** All check paths (manual click, on-mount, hourly SDK poll) hold the icon spin for a minimum of 700ms via a `withMinSpin()` helper, so cached responses produce visible feedback instead of a flicker.

### Changed

- **Header redesign** (`CustomTitlebar.tsx`). App icon + brand stack ("OmniFex" with `(version)` inline + "by GreyChrist, LLC" subtitle) replaces the previous version/SDK badge row. SDK details moved into the upgrade-check popover.
- **Window title and splash screen.** OS title and `StartupIntro` brand text now read "OmniFex".
- **About dialog removed** along with `NFOCredits.tsx`, `src/assets/nfo/asterisk-logo.png`, and `src/assets/nfo/opcode-nfo.ogg`. Favicon repointed from the deleted asterisk logo to `icons/icon.png`.
- **Renamed**: `package.json` `name`/`productName`, `forge.config.ts` `name`/`executableName`/`appBundleId`, ZIP filename pattern (`OmniFex-darwin-arm64-<semver>.zip`), notification dialog titles, settings panel copy.

### Kept as GreyChrist (deliberately)

- LICENSE copyright holder
- "by GreyChrist, LLC" subtitle in the titlebar
- Repo directory name `greychrist/`
- Internal SQLite filename `greychrist.db`, custom protocol scheme `greychrist-file://`, localStorage key prefixes
- Signing-cert identity `'GreyChrist Local Sign'` (will be renamed when the cert is rotated)
- Historical CHANGELOG entries and `docs/superpowers/plans/` and `specs/` files

## [0.4.1] — 2026-05-03

Test coverage pass. No runtime behavior change. Pushes overall line coverage from 86.11% to 92.11% and brings every previously-sub-80% module to or past the 80% line target. Installers remain **unsigned** — first launch needs right-click → Open.

### Added

- **React component test suites.** New tests for `ControlBar.tsx` (7.69% → 97.43%), `ui/popover.tsx` (4% → 100%), `ui/button.tsx` (75% → 100%), and `ui/tooltip-modern.tsx` (75% → 100%). Adds `@testing-library/react`, `@testing-library/jest-dom`, and `jsdom` as devDependencies; `vitest.config.ts` now picks up `*.test.tsx` files alongside `*.test.ts`.
- **Backend fallback-path coverage.** New tests for `electron/services/claude-binary.ts` NVM/standard-install/VS-Code-extension fallback chain (74.41% → 98.83%), `electron/services/util/find-claude-binary.ts` defaultWhich path (64.28% → 100%), `electron/services/installer.ts` default `extractZip`/`readBundleVersion`/`isWritable` impls (71.91% → 97.75%), `electron/services/sessions/queries.ts` query-passthrough error/cache paths (65.95% → 100%), and `electron/ipc/handlers.ts` logging/branch-colors/git-branches/lima handlers (74.16% → 86.66%).
- **Renderer state coverage.** New tests for `src/lib/utils.ts`, `src/lib/typographyClasses.ts` icon helpers, `src/lib/subagentDispatch.ts`, `src/stores/sessionStore.ts`, and the `useTabSession` hook over `src/stores/claudeSessionStore.ts`.

## [0.4.0] — 2026-05-02

Session/chat architecture tightening pass. Permission card no longer lets an empty rule submit. Stale auto-allow state (renderer hooks + sessions service surface) is gone — it was never wired through IPC and never read by `canUseTool`. Stream-effect execution moved out of `ClaudeCodeSession` into a pure runner with focused tests so `handleStreamMessage` is now thin: parse → reduce → patch → run effects → append. Bundles the in-flight session decomposition (factory / runtime / events / store / log-source) work that had been staged. Installers remain **unsigned** — first launch needs right-click → Open.

### Added

- **`src/lib/sessionStreamEffects.ts`**. Pure `runStreamEffect(effect, deps)` runner that interprets `StreamReducerEffect` descriptors (saveSessionPersistence, fetchAccountInfo, refreshContextUsage, fetchSupportedModels, processQueuedPrompt, showPermissionPrompt). Fire-and-forget semantics preserved; rejections forwarded to `deps.onError`. Backed by 10 unit tests (`src/lib/__tests__/sessionStreamEffects.test.ts`).
- **Empty-rule guard in `permissionCardLogic.ts`**. New `assertNonEmptyRule()` makes `buildSessionSuggestion` and `buildPersistedSuggestion` throw `Error('Cannot build permission suggestion from an empty rule')` rather than silently returning `{ toolName: "" }`. PermissionCard's "Allow for Session" button now also disables when `!rule.trim()`, matching "Save Permission".

### Changed

- **`ClaudeCodeSession.handleStreamMessage`** (`src/components/ClaudeCodeSession.tsx`). The 47-line inline `runEffect` switch is gone. The component now constructs a `StreamEffectDeps` object once per message and delegates to `runStreamEffect`. `useCallback` dep array shrunk accordingly.
- **PermissionCard "Allow Once" → "Allow for Session"** (`src/components/PermissionCard.tsx`). Button label restored to its earlier wording; Clock icon unchanged.

### Removed

- **Stale auto-allow state.** `autoAllowEnabled` / `autoAllowedTools` / `setAutoAllow` / `addAutoAllowTool` removed from `usePermissions`, `ClaudeCodeSession.tsx`, `NewSessionForm.tsx`, `TabContent.tsx`, `TabContext.tsx`, `electron/services/sessions/types.ts`, `electron/services/sessions/lifecycle.ts`, `electron/services/sessions/permissions.ts`, and the matching `electron/__tests__/sessions.test.ts` cases. The state was set but never read in `canUseTool`, never crossed IPC, and the renderer toggle had no observable effect.

## [0.3.81] — 2026-05-02

Header card layout reshuffled so account context lives near the back button and live-session info floats to the right. `AccountCard` now sits left of the git/branch card; `SessionCard` is pushed right with `ml-auto`. Popover anchors flipped accordingly so neither runs off-screen. Back-button drop shadow softened and angled toward the bottom-right, then mirrored on every header card (account, session, git/branch) for a consistent grouped look. Installers remain **unsigned** — first launch needs right-click → Open.

### Changed

- **Header card order** (`src/components/ClaudeCodeSession.tsx`). Swapped `AccountCard` and `SessionCard` positions in the top toolbar. AccountCard now renders right after the back-button divider; SessionCard renders last with `className="ml-auto"`.
- **Popover alignments** (`src/components/SessionCard.tsx`, `src/components/AccountCard.tsx`). Flipped to match new positions: SessionCard's context-window popover went `align="start"` → `align="end"` (now opens leftward from the right edge); AccountCard's account-detail and usage-detail popovers went `align="end"` → `align="start"` (now open rightward from the left edge).
- **Header card drop shadow** (`src/components/ClaudeCodeSession.tsx`, `src/components/AccountCard.tsx`, `src/components/SessionCard.tsx`). Replaced the `border border-border/50` outline on AccountCard, SessionCard, and the git/branch card with the same stacked `border-0` + outset shadow already used by the back button (`0 0 0 1px color-mix(... muted-foreground 30%)` ring + `2px 2px 4px rgb(0 0 0 / 0.08)` angled drop shadow). Back-button shadow itself was eased from `0 3px 8px / 0.2` down to the same softer angled shadow.

### Fixed

- **Off-screen popovers after card swap** (`src/components/AccountCard.tsx`, `src/components/SessionCard.tsx`). With AccountCard now on the left and SessionCard on the right, their previous `align` values would have extended popovers off the window edge. Alignment flips above keep all three context popovers on-screen.

## [0.3.80] — 2026-05-01

Session-header back button collapsed from a labeled "Back to Project" pill to a 48×48 icon-only button, freeing horizontal space in the toolbar. The label moved to a `TooltipSimple` ("Back to Project page") on hover, with a matching `aria-label` for screen readers. Outline now renders via the same border-0 + 1px outset shadow used by the rate-limit refresh button (and now stacks a small drop shadow underneath for a touch of depth). Also re-anchors the session context-window popover to its left edge so it no longer runs off the left of the window after the back-button collapse. Installers remain **unsigned** — first launch needs right-click → Open.

(The `v0.3.79` tag was cut and pushed before the popover fix landed, so it has no GitHub release attached — `v0.3.80` is the actual ship.)

### Changed

- **Session-header back button** (`src/components/ClaudeCodeSession.tsx`). Replaced the labeled `Back to Project` button with a 48×48 icon-only button (`ArrowLeft` at `h-6 w-6`), wrapped in `TooltipSimple` content `Back to Project page`. Visual treatment is `border-0` + a stacked `box-shadow` (1px ring at `color-mix(... muted-foreground 45%)` + a subtle `0 3px 8px rgb(0 0 0 / 0.2)` drop shadow) for a flatter look that still reads as a clickable card.

### Fixed

- **Session context popover anchor** (`src/components/SessionCard.tsx`). Switched `<Popover align>` from `end` to `start` for the context-window pie-chart popover. With `SessionCard` now sitting near the left edge of the top toolbar (right after the icon-only back button), `align="end"` extended the popover leftward off the window. `align="start"` extends it rightward from the trigger so it stays on-screen.

## [0.3.78] — 2026-05-01

Live-session header collapsed into a single toolbar of self-contained cards (folder + branch + worktrees + session + account), each with its label inside and an outset-shadow outline that matches the rate-limit and context pills exactly. The second header row is gone; `SessionHeader` has been deleted and the folder card folded into the branch row's neighborhood (worktrees now sit inside the branch card). The branch badge is click-able and opens a popover with the worktree folder, branch name, working-tree status, and any per-row git error. Account card hides its rate-limit widgets + refresh button when the resolved account is `enterprise` (and skips the `/usage` auto-refresh hook entirely). Installers remain **unsigned** — first launch needs right-click → Open.

### Added

- **Branch popover** (`src/components/claude-code-session/GitBranchBadge.tsx`). Badges with a `path` prop become click-able and open a popover showing the worktree folder (tilde-shortened with the absolute path below), branch name + trunk/feature label, working-tree status (changed/untracked counts or "Clean"), and any per-row git status error. Wired through both the main project branch (path = projectPath) and each sibling worktree (path = wt.path).
- **`AccountCard.tsx`, `SessionCard.tsx`, `HeaderLabel.tsx`** (`src/components/`). The session-header logic split into three discrete components. `AccountCard` owns its own `usagePopoverOpen` state, `useUsageAutoRefresh` hook, account-detail popover, and an `accountType` gate that hides the `/usage` widgets entirely for enterprise accounts. `SessionCard` owns the status badge, context-window widget (with pie-chart popover), and restart button. `HeaderLabel` is the small uppercase label used by every card.
- **GitWatchStatusIcon auto-pulse** (`src/components/claude-code-session/GitWatchStatusIcon.tsx`). The reconnect button now briefly spins for ≥500 ms when the user clicks it (so fast reconnects are still visible) and again whenever a fresh snapshot arrives from the unified git watch. Initial mount is skipped so the seed snapshot doesn't fire a spurious pulse.

### Changed

- **Top toolbar restructured** (`src/components/ClaudeCodeSession.tsx`). One row only: Back button → divider → session card → branch card (now containing the main branch + worktrees + reconnect button) → account card pinned right via `ml-auto`. `SessionHeader.tsx` deleted; folder card removed (folder now surfaces from the branch popover instead). Cost tracking still runs in the background but isn't rendered.
- **Rate-limit widgets** (`src/components/claude-code-session/RateLimitWidget.tsx`). 5h and 7d pills reserve fixed-width pct (`min-w-[4ch]`) and tail (`min-w-[7ch]`) columns with `tabular-nums` so both stack at identical widths regardless of value. Tail text is left-aligned. New `hideLabel` prop lets stacked widgets share a single header. Gradient bars shrunk ~30% (`w-16` → `w-11`).
- **Icon buttons unified** (`src/components/AccountCard.tsx`, `src/components/SessionCard.tsx`, `src/components/claude-code-session/GitWatchStatusIcon.tsx`). All three (account refresh, git-watch reconnect, restart) render at `h-5 w-5` with a 1px outset shadow at `color-mix(in_oklch, var(--color-muted-foreground) 45%, transparent)` so their outline matches the widgets exactly (border-vs-shadow rendering parity). Restart button is now icon-only (`RotateCcw`) with the tooltip "Close this session and open a new one"; `/usage` refresh tooltip shortened to "Pull fresh account stats".
- **AccountBadge `whitespace-nowrap`** (`src/components/AccountBadge.tsx`). Both color and fallback variants get `whitespace-nowrap` so longer "Name : type" combinations don't wrap to two lines inside the card.
- **Account popover anchors right** (`src/components/AccountCard.tsx`). Switched from `align="start"` to `align="end"` so the SDK-account-detail popover extends leftward from the trigger instead of overflowing the right edge of the viewport (the card lives top-right now).

### Removed

- **`src/components/SessionHeader.tsx`**. Whole file deleted; the second header row went with it. The exported `HeaderLabel` and `WorktreeSnapshot` moved (label to its own file, snapshot is no longer needed by anyone except the now-internal git-watch types).

## [0.3.77] — 2026-05-01

New-session screen redesign (form left, Branch Colors right, full-width session list below) and a complete session-list rebuild as a 3-column table (Date / First message / Session ID). Five previously-hardcoded rendering branches (skill injection, slash command echo, command output, unknown tool_use, unknown system subtype) now flow through the kind config so they're tunable from Appearance. Skill-injected user messages survive session reload. Dev-mode StrictMode double-mount no longer wipes the freshly-started session out of the main-process map. TodoBar gets a Clear button. Closed-session badge gets an inline reconnect. Installers remain **unsigned** — first launch needs right-click → Open.

### Added

- **New-session screen redesign** (`src/components/TabContent.tsx`, `src/components/NewSessionForm.tsx`, `src/components/ControlBar.tsx`, `src/components/ModelPicker.tsx`, `src/components/BranchColorsCard.tsx`, `src/components/SessionList.tsx`). Top row is now a 3:1 grid — `NewSessionForm` on the left, `BranchColorsCard` on the right — with the session list flowing full-width underneath. Form pickers (Model / Effort / Thinking / Permission) gain a new `form` variant: full-name trigger that fills its container with a chevron-down on the right, dropdown opens downward. `MODELS` shed the `Claude` prefix in their display names so the longer triggers still fit cleanly. `BranchColorsCard` fills its column height (`h-full`) and drops the redundant branch-name label next to each swatch. `SessionList`'s "Open by ID…" button is now `Open a Session by UUID`.
- **Session-list table** (`src/components/SessionList.tsx`, `electron/services/claude.ts`, `electron/services/sessions.ts`, `src/types/session.ts`). Replaces the card grid with a 3-column table: Date (started timestamp on top, last-message timestamp below in a dimmer line, both `m/d/yyyy h:mm AM/PM` local), First message (gets the most room), Session ID (first 8 chars + copy-full-GUID button). Header row sits above the table with a session count, the Open-by-UUID button, and a refresh button that re-fetches via `api.getProjectSessions` and spins the icon while in flight. Refresh wired in both `App.tsx` and `TabContent.tsx`. Main-process JSONL walker now pulls first/last entry timestamps in the same pass as `first_message`; new `Session.first_timestamp` / `Session.last_timestamp` drive the date column.
- **Status-badge inline reconnect** (`src/components/SessionHeader.tsx`, `src/components/ClaudeCodeSession.tsx`). The "Closed" status pill gains an inline `RefreshCw` icon. Click runs `handleReconnect`: best-effort `stopSession`, reset session-state flags, `rebindPersistentSession` (cheap if main-process still has the handle), fall back to `startPersistentSession(claudeSessionId)` so message history is preserved. Useful after the dev-mode race or any legitimate disconnect.
- **TodoBar Clear button** (`src/components/TodoBar.tsx`). New "Clear" control at the right end of the header, styled to match `SubagentBar`'s clear button. Click stashes the current todos hash and hides the bar while `dismissedKey === currentKey`; the next TodoWrite with different content changes the hash and the bar reappears.
- **Image lightbox** (`src/components/StreamMessage.tsx`). `DownloadableImage` now opens a shadcn `Dialog` on click (90vw × 90vh cap, transparent backdrop, click-outside / Esc / X to close, `cursor-zoom-in`). The download button keeps `stopPropagation` so it doesn't double-trigger when the lightbox is open.
- **Five new message kinds for previously-hardcoded rendering branches** (`src/lib/messageRenderingConfig.ts`, `src/lib/messageKind.ts`, `src/lib/blockKind.ts`, `src/components/StreamMessage.tsx`). New kinds: `user.skillInjection` (purple/Sparkles, right-aligned), `user.command` (blue/Terminal, right-aligned), `user.commandOutput` (green/Terminal, right-aligned), `assistant.toolUse.unknown` (muted/Terminal, `hiddenInCompact: true`), `system.unknown` (muted/Info, `hiddenInCompact: true`). Classifiers wired through `messageKind` / `blockKind` (+4 tests in each). Renderer now reads accent / icon / header label from the kind config for the system fallback strip, skill injection, slash command echo, command output, and unknown tool_use cards — visible defaults unchanged but every branch is now tunable from Appearance.

### Fixed

- **Dev-mode StrictMode double-mount wiped the live session out of main-process map** (`electron/services/sessions/lifecycle.ts`). React 18 StrictMode double-mounts `ClaudeCodeSession`; the second mount's `start()` closes the first session in main-process; the first session's terminating `for-await` then fired `claude-complete` on the new listeners and ran `sessions.delete(tabId)` on the freshly-installed session. `listenToMessages` now bails (no `claude-complete`, no map delete) when `sessions.get(tabId) !== handle` — i.e., when `start()` has replaced this session — and the same guard runs in the catch branch.
- **Skill-injected messages disappeared on session reload** (`src/lib/messageFilters.ts`, `src/components/StreamMessage.tsx`, `src/lib/messageFilters.test.ts`). Skill-injected user messages persist to JSONL with `isMeta: true` (the live SDK variant uses `isSynthetic`, no `isMeta`). Three filter sites were dropping them after reload — `messageFilters.ts` top-level + user-branch and `StreamMessage.tsx` top-level + user-branch. All four now exempt skill-injection messages via `detectSkillInjection`. +3 tests.
- **`SessionHeader` Clear button now confirms** (`src/components/SessionHeader.tsx`). Eraser button wraps `handleClear` in `window.confirm` to match the existing pattern in `AppearanceSettings.tsx` and TodoBar Clear.
- **TodoBar redundant ✓ suffix** (`src/components/TodoBar.tsx`). Counter no longer shows both "13 of 13 ✓" and the trailing `ListChecks` icon — the icon is now the only "done" cue. Counter format is uniform: `{done} of {total} items completed`.
- **Tab reorder smoothness** (`src/components/TabBar.tsx`). `Reorder.Item` swapped `transition-all duration-100` for `transition-colors` so CSS doesn't fight framer-motion's transform animation; dropped the explicit `duration: 0.1` override so the default layout spring takes over; added `whileDrag` scale/zIndex/cursor for visual stability. `Reorder.Group` flipped `layoutScroll={false}` → `layoutScroll` so framer-motion computes drop targets correctly inside the `overflow-x-auto` parent.

### Changed

- **CLAUDE.md memories dropdown removed** (`src/components/SessionList.tsx`, `src/App.tsx`, `src/components/TabContent.tsx`). The dropdown didn't work; removed `ClaudeMemoriesDropdown` import, the `onEditClaudeFile` prop, the App.tsx `claude-file-editor` view + state + handlers, the TabContent `open-claude-file` event listener, and the unused `Hash` icon import. Orphan files (`ClaudeMemoriesDropdown.tsx`, `ClaudeFileEditor.tsx`, `SessionList.optimized.tsx`) left in place.
- **Custom titlebar height + app-icon size** (`src/components/CustomTitlebar.tsx`). Titlebar grew 44px → 60px to fit a bigger icon; app icon bumped 24×24 → 48×48 (`rounded-md`), pulled hard-left (`pl-[80px]` → `pl-3`, since macOS traffic lights live in the OS title bar above this row, not in it). Added `mr-3` between the icon and the first version badge so the version chips don't crowd it.
- **Dropped two stale dev-time `console.log` calls** (`electron/services/accounts.ts`, `electron/services/sessions.ts`). `[accounts.resolve]` (every project resolve) and `[sessions] getSupportedCommands` (every poll cycle) were flooding `/tmp/greychrist.log`.

## [0.3.76] — 2026-05-01

New live-session **TodoBar** strip docked above the SubagentBar that always reflects the latest TodoWrite list — auto-expanding for 5 s on each update, then collapsing; click to toggle with pin-from-collapsed semantics; spinning gray indicator + animate-pulse blue header while items remain pending or in_progress, solid `ListChecks` icon when everything is completed/cancelled. Fix for the "Send now" button on the queued-prompt UI, which was tearing down the live session instead of just bypassing the queue check. Claude Agent SDK bumped 0.2.123 → 0.2.126. Installers remain **unsigned** — first launch needs right-click → Open.

### Added

- **TodoBar live-session strip** (`src/components/TodoBar.tsx`, `src/lib/latestTodos.ts`, `src/lib/todoBarState.ts`, wired in `src/components/ClaudeCodeSession.tsx`). New docked strip rendered immediately above `SubagentBar` whenever the live session has emitted a TodoWrite tool_use. Header carries a layered `bg-sky-400/15 animate-pulse` background so the bar visually pulses without the text fading; the label `ToDo List: {done} of {total} items completed` plus a gray `Loader2 animate-spin` indicator on the right while at least one item is `pending`/`in_progress`, switching to a solid emerald `ListChecks` and `{total} of {total} items completed ✓` when nothing is left. Expanded body renders rows in the SubagentBar visual family (left-rail emerald accent on muted bg, `Circle` / spinning `Loader2` / `CheckCircle2` / `XCircle` glyphs per status, line-through on done items). State machine (`collapsed_idle` ↔ `expanded_auto` (5 s timer) ↔ `expanded_pinned`) lives in a pure `todoBarReducer` so the transitions are unit-tested under the project's node-env vitest setup; the change-detection key is a stable JSON hash of the latest todos so identical successive emissions don't retrigger the auto-expand timer. Visibility is gated on `isSessionActive || isSessionStarting` so reloaded historical sessions don't render the bar. `done = completed + cancelled` (cancelled is treated as off-the-table per Greg's call), `total` = full list length.
- **Design spec + implementation plan** (`docs/superpowers/specs/2026-05-01-todo-bar-design.md`, `docs/superpowers/plans/2026-05-01-todo-bar.md`). Spec captures the brainstormed decisions (visibility lifecycle, pulse semantics, click-toggle rules, counter math). Plan documents the bite-sized TDD tasks that produced the helpers and reducer; deviation note records why the component itself has no `.test.tsx` (vitest is node-env-only in this repo, no React Testing Library setup).

### Fixed

- **Queued-prompt "Send now" button was triggering a session restart** (`src/components/ClaudeCodeSession.tsx`). The click handler was calling `setIsLoading(false)`, **plus** `persistentSessionRef.current = false`, `setIsSessionStarting(false)`, and `setIsSessionActive(false)` before invoking `handleSendPrompt`. The original comment ("Force reset loading state so handleSendPrompt doesn't re-queue") only required `setIsLoading(false)`; nuking the session refs took `handleSendPrompt` down the `if (!persistentSessionRef.current) await startPersistentSession(resumeId)` branch in `src/hooks/useSendPrompt.ts:111`, tearing down the live SDK process and restarting it. Symptom: pressing the button looked like the session "tried to restart or died." The button has been removed entirely — queued prompts continue to auto-drain when the in-flight turn ends (the existing `queuedPromptsRef` flush on `isLoading` → false in `ClaudeCodeSession.tsx:854`), and the X (remove from queue) action stays. Side-effect cleanup: dropped the now-unused `Send` import from `lucide-react`.

### Changed

- **Claude Agent SDK bumped 0.2.123 → 0.2.126** (`@anthropic-ai/claude-agent-sdk` in `package.json`/`package-lock.json`). Three patch versions of upstream fixes. Transitive constraints already satisfied: `@anthropic-ai/sdk@0.81.0` (range `^0.81.0`), `@modelcontextprotocol/sdk@1.29.0` (range `^1.29.0`), `zod@4.3.6` (peer range `^4.0.0`). No code changes required by the bump.

## [0.3.75] — 2026-04-30

Big compact-mode redesign: every hidden message now collapses into a single inline `Hidden Events` expander with a one-line prose summary, and opening the expander reveals everything that was hidden — no more empty placeholders, no more two-layer filtering. The Appearance kind tree is restructured to mirror the SDK's parent/child model (assistant message → text/thinking/tool_use; user message → prompt/image/system context/tool result), the lock set shrinks to just the four real turn boundaries, and several previously-untoggleable kinds (assistant text, permission request, summary, etc.) become user-controllable. Subagent dispatch and return now show as inline timeline markers with markdown formatting and scroll-anchored expanders; reloaded sessions inherit the JSONL `timestamp` so card timestamps render on every historical message. Installers remain **unsigned** — first launch needs right-click → Open.

### Added

- **Inline `HiddenEventsGroup` expander with prose summary** (`src/components/HiddenEventsGroup.tsx`, `src/lib/hiddenEventsSummary.ts`, `src/lib/compactGrouping.ts`). Compact mode now folds runs of consecutive hidden messages into a single shadcn-`Collapsible` row labeled `{n} Hidden Events: {summary}`, where the summary is generated by tallying tool families (read/edit/bash/search/web/task/thinking/tool-result) and emitting a single English sentence. The grouper drives hiding directly via per-kind `hiddenInCompact` instead of pre-filtering, so empty expanders disappear (the old `filterCompactHidden` step caused `CollapsibleGroup` rows to advertise steps that the renderer had already dropped). Opening the expander renders every wrapped message verbatim — no nested collapsibles. Right-aligned `ChevronsUpDown` chevron, `data-[state=open]` highlight via Tailwind, and a near-foreground left rule on the body so the through-line is visible in both themes.
- **Per-message `HiddenBlocksExpander` for mixed-content messages** (`src/components/HiddenBlocksExpander.tsx`, `src/lib/blockKind.ts`, `StreamMessage.tsx` assistant block iteration). Assistant messages with `[text, tool_use, tool_use, …]` blocks where the kind toggles disagree (text visible, tool_use hidden) now render the visible text and stash the hidden blocks behind a small in-card expander labeled `{n} hidden events: …`. New `classifyBlockKind(block, parent)` is the per-block analog of `classifyStandaloneKind` so block-level visibility decisions live in one place. When the parent message itself is being rendered inside an opened outer `HiddenEventsGroup`, the inner expander auto-flattens (no double-collapse).
- **Subagent timeline markers for both spawn and return** (`src/components/tools/TaskWidget.tsx`, `src/components/SubagentReturnedMarker.tsx`, `src/lib/subagentDispatch.ts`). Task / Agent dispatches replace the old JSON-blob fallback with a polished card titled `Subagent Prompt: {description}` and a `subagent_type` subtitle; the prompt text renders inline (no expander). The corresponding tool_result renders as a chronological purple-bordered `Subagent returned: {description}` Collapsible card with the agent output formatted through ReactMarkdown + remark-gfm + Prism syntax highlighting. New `isSubagentDispatch(name)` matches both `Task` (Claude Agent SDK) and `Agent` (Claude Code CLI) tool names. New `isSubagentPrompt(msg, allMessages)` resolves the `parent_tool_use_id` link against the actual stream — the bare presence of the field is not enough since the CLI persists every user prompt with a parent reference for conversation-tree chaining, which previously made reloaded prompts vanish.
- **shadcn `Collapsible` primitive** (`src/components/ui/collapsible.tsx`, new dep `@radix-ui/react-collapsible`). Thin re-export of the Radix primitive, used by every new expander (`HiddenEventsGroup`, `HiddenBlocksExpander`, `SubagentReturnedMarker`). Picked over a hand-rolled disclosure so we get keyboard / ARIA / `data-state` attributes for the open-state highlight rule for free.
- **Scroll-anchored expanders** (`src/lib/useScrollAnchor.ts`). All three Collapsibles wire `onOpenChange` through a hook that captures the trigger's `getBoundingClientRect().top` before the state mutation and, after a double `requestAnimationFrame`, adjusts the nearest scrollable ancestor's `scrollTop` by the delta. The double rAF lets the existing `ResizeObserver`-driven autoscroll fire first; the anchor then pulls the trigger back to its original viewport position so expanding never yanks the click target out of view.
- **Hook lifecycle kinds + `dropHookLifecycle` hard filter** (`src/lib/messageRenderingConfig.ts`, `src/lib/messageFilters.ts`, `src/components/settings-panels/AppearanceSettings.tsx`). New `system.hook.started` / `system.hook.response` / `system.userPromptSubmit` kinds for the SDK lifecycle events emitted around `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` hooks. Default `hiddenInCompact: true`. New hard filter `dropHookLifecycle` (default on) drops these messages entirely before the renderer ever sees them — flip off in Appearance to debug hook behavior. `filterDisplayableMessages` now actually accepts the hardFilters config (the existing UI toggles for `dropMeta` / `dropTaskLifecycle` / `dropEmptyUser` were nominal — they wrote to disk but the filter ignored them).
- **JSONL timestamp restored on reloaded sessions** (`src/components/ClaudeCodeSession.tsx`, `src/lib/synthesizeResults.ts`). Every entry in the CLI's JSONL has its own `timestamp` field; `loadSessionHistory` now maps it to `receivedAt` on both the initial load and the post-launch reload path, so the per-card timestamp footer renders on every historical message instead of being live-only. `synthesizeResultMessages` inherits the last assistant's timestamp onto the synthetic Execution Complete card so reloaded turns also show their footer time.
- **`MessageCard` shell scaffold** (`src/components/MessageCard.tsx`). New base component owning the standard chrome: card frame, accent border from kind palette, leading icon wrapper, `KindHeader` (configured `headerLabel` via Appearance), and the bottom footer with timestamp + debug raw-JSON copy button. Not yet adopted by the existing `StreamMessage.tsx` branches — landing it now so the in-flight per-branch migration to `<MessageCard kindId="..." message={message}>{body}</MessageCard>` has a stable target.
- **App icon in the titlebar** (`src/components/CustomTitlebar.tsx`). Imports `icons/icon.png` (same asset already used by `StartupIntro.tsx`) and renders it as a small 24×24 rounded square at the start of the left-side version-badge row, between the macOS traffic lights and the `GreyChrist {version}` chip.

### Changed

- **Compact-mode lock set shrinks to four boundaries** (`src/lib/messageRenderingConfig.ts`). `compactBoundaryLocked: true` now applies only to `user.prompt`, `result.success`, `result.error`, and `result.awaiting_background`. Previously locked kinds (`user.image`, `assistant.text`, `permission.request`, `summary.compaction`) become user-toggleable in Appearance — flip them hidden to merge them into the surrounding `Hidden Events` expander. `KindEditor.tsx` tooltip copy updated from "Forced visible — this kind is a turn boundary" to "Always visible — turn boundary."
- **Appearance kind tree restructured by parent message** (`src/components/settings-panels/appearance/MessageKindTree.tsx`). Replaces the `origin`-based grouping (which scattered tool result kinds under "Tool" and skill-injected user content under "System") with a tree that mirrors the actual SDK message hierarchy: Assistant message → text/thinking/tool use; User message → prompt/subagent prompt/SDK system bracket/image/system context/tool result/system reminder; System; Turn result; Other. Each row carries an explicit lock-icon badge for boundary-locked kinds, and an `EyeOff` for hidden kinds that aren't locked, so the visibility state is readable at a glance.
- **`TurnPreview` reflects the new model** (`src/components/settings-panels/appearance/TurnPreview.tsx`). The preview's collapsed marker now reads `{n} Hidden {Event|Events}: collapsed in compact mode` with the bordered (not dashed) background that matches `HiddenEventsGroup`, so what you see in the preview matches what the live timeline draws.
- **Tool-result `KindHeader` calls switched from `label` to `fallbackLabel`** (`StreamMessage.tsx`). The Edit/MultiEdit/Directory/Read result widgets used to pass `label="Edit Result"` etc., which is an explicit override that wins over the configured `headerLabel` — so customizing `tool.result.generic`'s label in Appearance had no effect on those variants. Switched to `fallbackLabel`, which only kicks in when the kind's `headerLabel` is `null`. Same fix for the `Tool Error` header on `result.error`.
- **`showUserHeader` honors the configured kind on tool-result-only cards** (`StreamMessage.tsx`). The user-message card renderer was gating `showUserHeader = !!userKindId && !isToolResultOnly`, which silently swallowed the configured `tool.result.generic` header on subagent return cards (and any other tool-result-only user message). Dropped the `!isToolResultOnly` clause and hoisted the `KindHeader` call to the top of the card body so it renders once for every variant — string content, text blocks, image blocks, and tool_result blocks alike.
- **Synthesized subagent prompt user message folded into the dispatch card** (`src/lib/messageFilters.ts`). The CLI persists a synthetic user message after each Task dispatch carrying the same prompt text that lives in the tool_use's `input.prompt`. Now filtered out so the prompt is rendered exactly once — by `TaskWidget` at the dispatch position. Detection uses the strict `isSubagentPrompt` helper so reloaded real user prompts (which the CLI also stamps with a parent_tool_use_id for tree chaining) survive.
- **Generic `system.{subtype}` fallback for unknown SDK system messages** (`StreamMessage.tsx`). Previously only `system.init` and `system.notification` had render paths — anything else (hook lifecycle events before they had registered kinds, future SDK subtypes) fell through to `null`, which meant `Hidden Events` expanders summarized as "1 system event" would reveal nothing on click. Fallback now renders a small monospace line with the subtype + any `message`/`title` field so unknown subtypes are at least visible and inspectable.

### Fixed

- **Reloaded user prompts disappeared from the timeline** (`src/lib/compactGrouping.ts`). The CLI persists typed user prompts with `content: "the prompt text"` (bare string), while the live SDK uses `content: [{type: 'text', text: '...'}]`. `isMessageFullyHidden` early-returned `true` for any non-array content, sweeping every reloaded prompt into the surrounding hidden group. Added a string-form branch: a non-empty string content returns `false` (visible).
- **Empty-rendering messages broke `Hidden Events` runs** (`src/lib/compactGrouping.ts`). Signature-only thinking blocks (`{thinking: "", signature: "..."}`) and assistant messages with empty content arrays would render to `null` but still claim a visible "single" slot in `buildCompactItems`, fragmenting an otherwise contiguous hidden run into two or three separate expanders for no reason. Both cases now return `true` from `isMessageFullyHidden` so they merge into neighboring runs as no-op fillers.
- **Tool name "Agent" missed every Task code path** (`src/lib/subagentDispatch.ts`, wired into `compactGrouping.ts`, `StreamMessage.tsx`, `messageFilters.ts`). The Claude Code CLI emits subagent dispatches under the name `Agent` while the Agent SDK emits `Task`; our checks were `toolName === "task"`, so when run through Code the JSON-blob fallback fired, no `SubagentReturnedMarker` rendered, and the messageFilters widget skip-list missed the dispatch. Centralized in `isSubagentDispatch(name)` (case-insensitive match for `task` / `agent`).

### Removed

- **`CollapsibleGroup.tsx` and its summary tests** (`src/components/CollapsibleGroup.tsx`, `src/lib/__tests__/collapsibleGroupSummary.test.ts`). Superseded by `HiddenEventsGroup` + `hiddenEventsSummary`. The two-layer "filter then group" model that produced empty placeholders is gone.
- **`filterCompactHidden`** (`src/lib/messageKind.ts`). The standalone-kind pre-filter is no longer needed — the grouper drives hiding natively via `isMessageFullyHidden`, so a hidden message lands in a `HiddenEventsGroup` instead of vanishing before grouping.

## [0.3.74] — 2026-04-30

Patch release on top of 0.3.73 with two improvements informed by live testing during yesterday's release flow. Installers remain **unsigned** for Gatekeeper purposes — first launch still requires right-click → Open.

### Added

- **Spinner stays alive across `awaiting_background` turns** (`src/lib/subagentStreams.ts`, `src/components/ClaudeCodeSession.tsx`). The iMessage-style typing bubble was bound strictly to `isLoading`, which flips false the moment the parent's turn-end result event fires — so the amber `Awaiting Background Work` card would land and the spinner would vanish even though a build was still churning in the background. New `isWaitingForBackground(subs)` helper returns true whenever any subagent has `status === 'running' && isBackground === true`. `ClaudeCodeSession` derives an `awaitingBackground` flag from its memoized subagents and ORs it into the spinner's render gate. Net effect: the spinner stays visible from dispatch through the eventual real `Execution Complete`, bridging the awaiting state without changing `isLoading` semantics (cancel button, input enabled state, etc. all unchanged).

### Fixed

- **Saved permission rules now apply live to the running session** (`electron/services/sessions/permissions.ts`). Long-standing UX bug: clicking "Save Permission" wrote the rule to `.claude/settings.local.json` (or whichever scope was selected) but the very next matching tool_use would re-prompt — even with multiple variants of the same rule on disk, even with a bare `Edit` rule that should grant everything. Confirmed via Anthropic's official Agent SDK docs that `PermissionUpdate` destinations (`userSettings` / `projectSettings` / `localSettings` / `session`) are persistence targets, not "apply-now" flags — only `'session'` folds the rule into the running query's in-memory cache. Our renderer was sending only the persistent destination, so the rule landed on disk but the live SDK process never saw it. New `augmentPermissionsWithSession()` helper now mirrors every persistent `addRules` entry with a session-destination twin before resolving the `canUseTool` promise. Matching tool_uses short-circuit `canUseTool` for the rest of the running session AND the rule survives a restart. We continue our own disk write via `persistPermissionRule` (iterating the *original* updates, not the augmented array) as belt-and-braces.

## [0.3.73] — 2026-04-30

Feature release: a new "Awaiting background work" result kind so the parent session no longer claims "Execution Complete" when its turn ended by dispatching a still-running background subagent. Also fixes a long-standing bug where the subagent progress bars at the bottom of a session would flip to "done" the instant a background dispatch was acknowledged — same root cause, healed by the same change. Installers remain **unsigned** for Gatekeeper purposes — first launch still requires right-click → Open.

### Added

- **"Open by ID…" on the project page** (`src/components/OpenSessionByIdDialog.tsx`, `src/components/TabContent.tsx`). New small button next to the session count that opens a dialog accepting a pasted Claude Code session GUID. Validates the shape (UUIDv4) before round-tripping, then calls the existing account-aware `loadSessionHistory(guid, projectId, projectPath)` to confirm the JSONL file exists. On success, opens the session in the current tab via the same code path that clicking a list row uses; on miss, shows an inline error explaining the session isn't in this project's directory (likely bound to the other account or never written). Useful when a session is in-flight and the project listing hasn't refreshed yet, or when you have a GUID from a notification/log and don't want to scroll.
- **`result.awaiting_background` kind** (`05c921b`). Sibling of `result.success` that fires when a turn ends with a still-running `Agent`/`Task` subagent dispatch (e.g. "Will be notified when verify completes"). Renders an amber `Hourglass` chip with header "Awaiting Background Work" instead of the green "Execution Complete." Detection is derived from the message stream itself — `classifyStandaloneKind` runs `deriveSubagents()` on the messages prior to the `result` event and checks for any subagent still in `running` status — because the SDK doesn't distinguish these in the result blob (`stop_reason: "end_turn"`, `terminal_reason: "completed"` are identical to a plain success). The new kind is `compactBoundaryLocked: true` so it's never hidden in compact mode, and is wired through Appearance settings (icon allow-list, fixtures, debug-label preview) like every other kind.

### Fixed

- **`run_in_background` detection generalized beyond Agent/Task** (`src/lib/subagentStreams.ts`). The previous fix gated `isBackground = true` on `block.name === 'Agent' || block.name === 'Task'`, which meant Bash with `run_in_background:true` (long-running builds, e.g. `npm run make` from the release skill) bypassed the gate entirely — the synchronous ACK tool_result still flipped the SubagentBar row to "done" the moment it landed, and the result card classifier saw no running subagents at parent-turn end so the amber `Awaiting Background Work` card never fired. Step 1 now registers a subagent for any tool_use with `input.run_in_background === true`, sets `isBackground` on it, and adds it to the orphan-detection dispatch index. Agent/Task subagents still get their `agentType` from `block.input.subagent_type` (Bash has none, falls through to the "Agent" label like before). Net effect: build dispatches finally show amber while running, and the bar row stays in `running` (animated pulse, non-dismissable) until the build's `task_notification` actually arrives.
- **Tool-result cards rendered the icon twice** (`src/components/StreamMessage.tsx`). The user-message tool_result card had a hard-coded `<Terminal>` chip on the card AND a `KindHeader showIcon` next to the label — with the default config both showed Terminal (visible duplicate); with a customized `tool.result.generic` icon the chip still showed Terminal while the header showed the custom icon (silently ignoring the customization on the chip side). Chip now uses `IconRenderer` with the configured icon, and `showIcon` is dropped from the five `tool.result.generic` `KindHeader` calls (Edit/MultiEdit/Directory/Read result widgets, plus the generic fallback). Matches the single-icon pattern used by `result.success` and `result.error`. The error-result `KindHeader` keeps `showIcon` because its `AlertCircle` is intentionally distinct from the chip's Terminal — double-signaling "tool result + errored."
- **Background subagent dispatches flipped to "completed" the instant they were dispatched** (`src/lib/subagentStreams.ts`). The SDK fires an immediate ACK tool_result for `run_in_background:true` dispatches ("Async agent launched successfully. agentId: ..."), which `deriveSubagents` step 2 was treating as completion — so subagent bars showed "done" immediately and the new `result.awaiting_background` classifier never fired. `Subagent` now carries an `isBackground` flag set from `block.input?.run_in_background === true`; step 2 skips the success-flip for background dispatches, leaving them in `running` until `task_notification` arrives. `is_error: true` ACKs (dispatch itself failed) still flip to `failed`. Two-for-one fix: subagent progress bars now stay alive for the duration of the background work, and the new amber `Hourglass` result card actually shows up.
- **Zombie subagents on reloaded old sessions** (`src/lib/subagentStreams.ts`, `src/components/SubagentBar.tsx`). With the background-dispatch fix above, sessions that were closed mid-await (parent process died before `task_notification` arrived) reopened with eternal "running" bars and ghost amber "Awaiting Background Work" cards — the dispatch was orphaned forever. `SubagentStatus` gains a fourth terminal value, `'abandoned'`, with its own `Ghost` icon and "Session ended before this returned" tooltip. Heuristic: a background subagent is marked abandoned when its turn-closing result event has any message after it (proving the parent advanced without the notification); live sessions still on the awaiting boundary stay `running` because the result is their latest message. The historical result card classifier is unaffected (it slices messages prior to the result event), so old "Awaiting Background Work" cards remain accurate while the bottom bar now correctly shows the corresponding subagent as abandoned.

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
