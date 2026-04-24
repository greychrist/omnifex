# Changelog

All notable changes to GreyChrist are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
