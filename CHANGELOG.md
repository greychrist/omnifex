# Changelog

All notable changes to GreyChrist are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
