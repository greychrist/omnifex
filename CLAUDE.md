# CLAUDE.md

`AGENTS.md` is a symlink to this file — one document, two names, so agents that
look for either find the same guidance. It used to be a hand-maintained copy
that said "keep both in sync"; it drifted instead, still describing the app
under its pre-rename name and missing six sections. Don't replace the symlink
with a copy.

OmniFex (by GreyChrist) is a **native macOS** app for Claude Code: a Swift (AppKit + WKWebView) window around a React renderer, talking to a Node daemon. The current product surface centers on multi-account routing, interactive Claude sessions, custom agents, MCP management, and usage analytics.

The shipping app is OmniFex. Internal identifiers like `greychrist.db`, the `greychrist-file://` protocol, and localStorage keys retain the legacy name to avoid migration churn — only the user-facing brand and the repo/folder name changed.

The repo migrated from Tauri 2 (Rust) to Electron in April 2026, and from Electron to the Swift shell on 2026-10-23 (`docs/superpowers/specs/2026-10-23-swift-shell-design.md`): Electron had become only a window around a renderer that already talked to the daemon, and its release cadence decided when OmniFex could ship a Node security fix. The daemon drives the Claude CLI binary directly via `child_process` (stream-json), plus `node-pty` for the `/usage` scraper and Codex sign-in, which is why the app bundles Node (26, `Contents/MacOS/omnifexd`). The `electron/` directory kept its name — it is the daemon's TypeScript now, and no Electron is left in the repo. Any reference to `src-tauri/`, `cargo`, `just`, `nix-shell`, or an Axum web server in source code is legacy noise. (The `@anthropic-ai/claude-agent-sdk-*` package names that remain in `electron/services/claude-binary.ts` are intentional — they name the npm packages the binary resolver searches for, not a live dependency.)

## No worktrees

Do not create git worktrees for this repo. Work directly on branches inside the main checkout at `~/Repos/personal/omnifex`. If a skill (`using-git-worktrees`, `subagent-driven-development`) wants to create an isolated workspace, skip that step and use `git checkout -b <branch>` in the main checkout instead.

## Working Style

- Run independent reads and searches in parallel.
- Prefer the smallest safe change that matches existing patterns.
- Make code changes when the user asks for a fix or implementation; do not stop at analysis.
- TDD is required for code changes. Write the failing test first, then implement.
- Refactors must clean up after themselves before being called done. When a change makes a defensive branch, helper, or shape-check unreachable — delete it in the same change, not as a follow-up. "Dead code I'll remove later" is how 71-occurrence branching taxes accumulate. Leaving compatibility code in place is justified only when an external boundary is still emitting the old shape; "we _used to_ accept both shapes" is not.
- For backend or IPC work, add or update tests in `electron/__tests__/`.
- Report the exact commands you ran and whether they passed or failed.
- When using `TodoWrite`, mark the closing item (`Report`, `Summarize`, `Verify`, etc.) **`completed` before** writing the user-visible summary, not after. The session ends with that summary, so a "completed" status flipped after it never gets persisted — OmniFex's "Last activity" / unfinished-todos UI then shows a phantom in-flight item forever.
- Use `/commit` only when the user explicitly asks for a commit.
- Use repo-local skills when they match:
  - `version-aware-research`
  - `multi-account-debugging`

## Permissions Work

Any change that touches Claude Code permission rules, path-rule formatting, or the permissions UI: read `docs/permission-syntax.md` **and** https://code.claude.com/docs/en/permissions before editing. Rule-format gotchas (`/` vs `//` paths, gitignore-style globs, shell-operator boundaries) are load-bearing and have caused every permissions regression to date.

## Session Lifecycle

Any change that touches session status, conversation status, the spinner / in-flight predicate, the status popover, `useSessionLifecycle`, or anything under `electron/services/sessions/`: read `docs/session-lifecycle.md` first. It defines the three orthogonal state axes (`sessionStatus`, `turn` — both owned by the session in main — and per-item task/subagent status), the `conversationStatus` rollup, the invariants between them, and the anti-patterns that have repeatedly caused session-stuck bugs. The turn is never inferred from the transcript.

## The Brain

A per-account memory vault: Markdown notes distilled from past sessions, repo artifacts, and explicit captures, searched over SQLite FTS5. Any change under `electron/services/brain/`, `electron/brain-mcp.ts`, `electron/ipc/brain-handlers.ts`, or `src/components/brain/` should start from `docs/superpowers/specs/2026-08-11-brain-memory-vault-design.md` — the parent spec — plus whichever of the six `*-brain-*` specs covers the area. The most recent is `2026-08-14-brain-concurrent-indexing-design.md` (Plan 8).

### Shape

- **Vault** — `~/OmniFex Brain/<account>/`, one per account, path in `app_settings` under `brain.vault.<accountId>`. Deliberately outside userData so it opens in Obsidian and backs up normally, and deliberately out of `~/Documents`/`~/Desktop` so no sync client can evict it (see below). Git-versioned; the FTS index lives at `<vault>/.omnifex/index.db` and is derived and disposable.
- **Orchestration state** — `brain_sources` (change detection), `brain_queue` (work), `brain_spend` (append-only cost ledger) in `greychrist.db`. Note *content* never lives there, only pointers and status.
- **Pipeline** — `sources/*` discover → `admit()` → `distill()` → `extract.ts` (Sonnet, zod-validated) → `merge.ts` (pure) → note. `curate.ts` / `curation.ts` is the separate Opus-pinned pass that rewrites accumulated notes.
- **Consumption** — `brain-mcp.ts` is a stdio MCP server the *CLI* spawns (`brain_search` / `brain_read` / `brain_remember`), plus the Brain tab and `/recall`. Nothing auto-injects vault note *content* into a session; what is injected is the server's `instructions` string (`brain/instructions.ts`), built at spawn from `process.cwd()` — the CLI starts the server in the session's directory — plus `projectCounts()`. That string is the only thing driving invocation, and invocation, not ranking, has been the binding constraint. It replaced a `SessionStart` hook that did the same job from outside the app; see the module header before reintroducing one.

### Rules that are load-bearing

- **One vault per account, and isolation is enforced by process environment**, not query filters. The MCP server has no account concept — it reads the single `OMNIFEX_VAULT` path it was handed. Never add a "which vault?" parameter to it.
- **The account that owns a source is the account that indexes it and whose vault receives it.** Ownership comes from the source's location (`getAccountByConfigDir` for transcripts), never from `resolve()`. No silent default-account fallback — an unresolved item is `blocked` and surfaced.
- **Spawn the MCP server as `process.execPath`** — the daemon's own node (`omnifexd` in the app) — never whatever `node` is on PATH: `better-sqlite3` is built for one Node major (26).
- **The Brain is auxiliary.** Nothing in it may break a session, block the UI, or consume rate limit needed for real work. A failed item never blocks the queue.
- **`merge.ts` must stay pure and idempotent** — indexing the same session twice produces a byte-identical note. It is the property tested hardest.
- **Money is recorded in `brain_spend`, never inferred.** `brain_sources.cost_usd` is a per-item snapshot that re-indexing overwrites; the ledger is append-only and is what `stats.spentUsd` and the Brain tab read. It is an *audit* record, not a reporting one — the Cost Report reads `session_cost_daily` only, so nothing is counted twice.
- **A vault must never live under a file provider.** `~/Documents` and `~/Desktop` are claimed by iCloud Drive whenever "Desktop & Documents Folders" is on; Dropbox/OneDrive/Drive claim their own folders. With storage optimisation, contents are evicted to `SF_DATALESS` stubs costing ~0.6s per read, which turns one `git add -A` into minutes of silent hang — this was the original default and it shipped the bug. `offloaded.ts` probes the flag; `status().offloadedCount` surfaces it. Null there means "not determined", never "none".
- **OmniFex's own CLI transcripts are never kept — only their spend.** Summaries, Brain indexing and Brain curation run `claude -p` in a scratch cwd (`<tmpdir>/omnifex-summary-scratch`). As each call returns, the runner prices its transcript into `session_cost_daily` (`costHistory.recordInternal`, labelled `OmniFex/Brain index` etc. with `internal_kind`) and deletes it; `settleStrandedScratch` in the hourly sweep does the same for strays older than ten minutes. A transcript whose spend fails to record is left in place, never deleted. The scratch dir is skipped by the Projects list, the cost walk and the Brain. The runner must encode the scratch cwd's **realpath** — macOS's tmpdir is a `/var` symlink, and encoding the unresolved path stranded every transcript from June to October 2026. See `electron/services/sessions/internal-spend.ts`; the archive design it replaced (`2026-08-26-internal-session-archive-design.md`) is superseded.

## The Shape of the App

One **daemon** owns every CLI session and every service; **clients** talk to
it over a versioned WebSocket protocol. The Mac app (`macos/`, Swift) is one
client; the same renderer, served by the daemon, is a Safari Home Screen app
on the iPad. Start from `docs/remote-access.md`,
`docs/superpowers/specs/2026-10-23-swift-shell-design.md` and `macos/README.md`
before changing any of it.

### Shape

- **Daemon** — `electron/omnifex-server.ts` → `electron/remote/daemon.ts`, built
  by `scripts/build-daemon.mjs` to `.vite/build/omnifex-server.js` (plus
  `brain-mcp.js`). The only composition root: every service is built there.
- **Node** — 26.x, one major everywhere: the bundled `omnifexd`, the system
  node that runs tests and `npm start`, and the ABI `npm install` builds
  `better-sqlite3` / `node-pty` for. `packaging/node-runtime.ts` pins the
  bundled version; bumping it and releasing is how a Node security fix ships.
  `.nvmrc` says 26.
- **Process name** — `omnifexd` is the bundled node binary's own file name.
  Never `process.title`: on macOS that registers a headless process with
  LaunchServices as a launching Foreground app and the Dock bounces forever.
  The Brain MCP server runs on the same binary, so it is `omnifexd` too.
- **Mac app** — `macos/`: `OmniFexCore` (pure, tested rules) and `OmniFex`
  (AppKit wiring). It runs `omnifexd omnifex-server.js ensure` to start or
  adopt the daemon (the replace-outdated / launchd rules stay in
  `electron/remote/launcher.ts` and `daemon-control.ts`), then loads the page
  the daemon serves and injects `window.__omnifexNative`.
- **State** — `~/.omnifex/` (`server.json`, `server.pid`, `projects.json`,
  `sessions/<id>.meta.json`). The SQLite DB is in
  `~/Library/Application Support/OmniFex` (`OMNIFEX_USER_DATA_DIR`). Session
  events are memory-only (a 5,000-event ring per session); a reconnect the
  ring cannot serve, or one across a daemon restart (`welcome.bootId`
  changed), gets `resync` and the tab reloads from the CLI's JSONL. The CLI's
  transcript is the history — never add an events file back. State
  transitions go to `app_logs` (`category='session-state'`) for
  `session-trace`.
- **Protocol** — `src/protocol/` (types), `electron/remote/server.ts` (transport),
  `electron/remote/handlers.ts` (methods). The protocol's `sessionId` IS the
  sessions service's `tabId`; that equivalence is the whole trick.
- **Client side** — `src/lib/remote/bootstrap.ts` installs the shim,
  `electronApiShim.ts` maps `invoke()` onto typed methods, `rpc.invoke` or the
  native bridge, and `nativeChannels.ts` names what the Mac app serves.

### Rules that are load-bearing

- **There is one mode: the daemon.** The in-process fallback went with
  Electron. A daemon that is down is the connection banner plus the window's
  Retry, never a different code path.
- **The Mac app loads its page from loopback, never the tailnet address.**
  WebKit runs plain http on a non-loopback address in its EnhancedSecurity
  process — no JIT, ~5× slower JavaScript — and gives it no secure context
  (no async clipboard, no `crypto.randomUUID`). `securityRestrictionMode =
  .none` does not override it. So a daemon on the tailnet also listens on
  `127.0.0.1` (`extraListenHosts`) and `ensure` hands the app the loopback
  URL when it answers there (`localUrl` in `launcher.ts`). Shipped in 0.5.0
  without this; the app felt sluggish everywhere.
- **The native bridge answers the main frame on the app's origin only**
  (`NavigationPolicy.allowsBridge`). The page shows link previews of arbitrary
  sites in iframes, and the bridge reaches `updater:download` /
  `updater:install`.
- **The rpc allow-list is subtractive** (`electron/remote/rpc-allowlist.ts`): it
  starts from every renderer channel and removes native-only, typed-session and
  raw-SQL groups. A new channel is therefore network-reachable by default. If it
  should not be, deny it explicitly.
- **`NATIVE_INVOKE_CHANNELS` is one list with three readers** — the daemon's
  deny list, the client's routing table, and the Swift router
  (`macos/Sources/OmniFexCore/NativeChannels.swift`, held to the list by
  `ipc-channel-contract.test.ts`). Keep it pure data. Native means it needs the
  machine the window is on (display, Finder, dock, notification centre, the
  bundle); anything that can run headless belongs in the daemon, where the iPad
  reaches it too.
- **Every adapter the handler map reads is built by the daemon** —
  `daemon.ts` passes its bag `satisfies Required<Services>`, so a service the
  map needs and the daemon forgot is a compile error, not a silent `null`.
- **A dev build is a guest: `npm start` runs its own instance, and a
  temporary one.** `ensure --dev` puts it on `~/.omnifex-dev`, port 47701,
  `OMNIFEX_DEV_DAEMON=1` (see `electron/remote/dev-instance.ts`). Dev and the
  installed app used to share one daemon on one port — the daemon holding every
  live CLI process the user actually works in — so `npm start` SIGTERM'd it and
  killed those sessions. A dev build also retires only a daemon that reports
  its own script path in `/healthz`, and never drives the LaunchAgent. The
  database stays shared, which is why the dev daemon passes a closed gate to
  `startPeriodicWork` and to the close-time Brain drain: two sweepers on one
  `brain_spend` pay twice. It is also the one daemon that does not outlive its
  app — app's process group, `stop --dev` on quit, and `createDevIdleWatch` as
  the backstop. `OMNIFEX_DEV_INSTANCE=0` opts out.
- **The LaunchAgent belongs to the real instance.** Only `ensure`/`stop` with
  the default state dir may drive `com.omnifex.server` (`launchdAllowed`). A
  packaged build is smoke-tested with `OMNIFEX_STATE_DIR` /
  `OMNIFEX_USER_DATA_DIR` / `OMNIFEX_PORT` pointed somewhere throwaway, and
  `OMNIFEX_SMOKE_DIR` makes the app write a PNG of each window it loads.
- **Periodic work lives in `electron/periodic-work.ts`.** Add new periodic work
  there, not to the composition root. Its `enabled` gate is read per tick.

## Research And Code Intelligence

- Start from evidence, not memory.
- For repo-specific behavior, read the relevant local code path before making claims about architecture or implementation.
- For external behavior, use **Context7 first** before relying on model memory for APIs, config formats, CLI flags, plugin manifests, migration details, or framework behavior.
- For Claude Code, Claude CLI, MCP, hooks, plugins, or settings behavior, prefer **official Anthropic docs** over memory or third-party guides.
- For TypeScript and TSX work, prefer Anthropic's official **`typescript-lsp`** plugin when it is available. Use it for symbol lookup, references, semantic rename/refactor, and diagnostics after edits.
- Do not assume plugin or MCP availability. If `typescript-lsp` is not installed, fall back to targeted `rg`, focused file reads, `npm run check`, and tests.
- Use **Serena** only when semantic navigation is still needed and it is already configured or the user explicitly wants it. Treat Serena as optional, not a default dependency.
- If Context7 is unavailable or insufficient, say so briefly and then fall back to local code inspection plus official docs.
- Never install tools, plugins, or MCP servers as part of ordinary repo work unless the user asks for setup changes.

## Environment

- Package manager: `npm`. `package-lock.json` is the source of truth.
- Confirm animation and drag smoothness in a packaged build before judging it:
  `npm run package`, then launch `out/OmniFex-darwin-arm64/OmniFex.app`. The
  dev renderer runs under `React.StrictMode` and React 19 double-invokes
  renders, effects and ref callbacks, so dev exaggerates render cost roughly
  2×. **Exaggerates, not invents** — do not conclude "dev-only artifact" from
  a symptom that merely looks milder in the packaged build. That call was made
  once about the tab-drag flash and was wrong; the real cause was an
  unmemoised render storm that was present in both.
- Measure renderer performance, do not reason about it. `__omnifexProfile.on()`
  in the Web Inspector console (works in packaged builds — View → Toggle
  Developer Tools, ⌥⌘I, or Safari's Develop menu), reload, then interact: each tab switch or drag
  crossing prints its render count and duration. See `src/lib/renderProfiler.ts`.
  Every open tab is mounted at once and the transcript is unvirtualised, so the
  default failure mode is "one click re-rendered every session in the app" —
  check that first.
- Node.js 26 and Xcode with Swift 6.4+ are the toolchain (the package is Swift 6 language mode). No Rust.
- Commands:
  - `npm start` — build and run the dev app (`out/dev/OmniFex Dev.app`) against
    the Vite dev server and the dev daemon. Never run it to demo something to
    Greg; he runs his own.
  - `npm run dev` — the Vite dev server alone
  - `npm run build` — `tsc && vite build` of the renderer into `dist-web/`
  - `npm run check` — TypeScript check across renderer and daemon
  - `npm run package` — `out/OmniFex-darwin-arm64/OmniFex.app`, signed
  - `npm run make` — plus the release zip and DMG; `OMNIFEX_NOTARIZE=1`
    notarizes and staples both
  - `npm run build:daemon` — `.vite/build/omnifex-server.js` + `brain-mcp.js`
  - `npm test` — Vitest one-shot; `npm run test:swift` — the Swift tests
  - `npm run test:watch` — Vitest watch mode
  - `npm run test:coverage` — Vitest with v8 coverage

## Architecture

### Process Model

- **Daemon**: `electron/**`
  Owns SQLite, filesystem access, Claude CLI spawning (interactive sessions, agents, usage), account resolution, and all privileged work. Runs on the bundled node.
- **Mac app**: `macos/**`
  Windows, menus, dialogs, Finder, notifications and the dock badge, PDF export, the updater, tab-status aggregation — the channels in `nativeChannels.ts`. Injects `window.__omnifexNative` (`invoke` / `onEvent`) at document start.
- **Renderer**: `src/**`
  UI layer, served by the daemon. Backend access goes through `src/lib/api.ts` and `src/lib/apiAdapter.ts` onto `window.electronAPI` — the shim `bootstrap.ts` installs (the name is the Electron era's; every call site uses it). No direct Node.js access.

### Service Pattern

- Daemon services live in `electron/services/`.
- Services are factory functions: `createFooService(deps) -> FooService`.
- Dependencies are injected so services can be tested with `createDatabase(':memory:')`.
- Services are constructed in `electron/remote/daemon.ts` and handed to `getHandlerMap(...)` in `electron/ipc/handlers.ts`.
- Keep business logic in services, not renderer components or thin IPC adapters.

### Core Services

- `electron/services/accounts.ts`
  Multi-account CRUD, path rules, project overrides, resolution, discovery.
- `electron/services/claude.ts`
  Project listing, Claude settings, CLAUDE.md file ops, hooks config, version checks.
- `electron/services/sessions/` (split across `lifecycle.ts`, `runtime.ts`, `permissions.ts`, `queries.ts`, etc.)
  Interactive sessions, spawned via `child_process` (stream-json). There is no terminal/TUI session mode — it was removed 2026-09-20; the only ptys left are the `/usage` scraper and Codex sign-in. Engine selection (Claude vs Codex) lives here; the binary is located at runtime via `electron/services/claude-binary.ts`.
- `electron/services/agents/`
  Multi-engine agent runtime behind a shared `AgentEngine` interface: `claude-cli-engine.ts`, `codex-cli-engine.ts`, `json-rpc-client.ts`, `codex-binary.ts`. (There is no `electron/services/agents.ts` — agent/session execution moved into `sessions/lifecycle.ts` + this engine layer.)
- `electron/services/usage.ts` / `usage-runner.ts`
  Usage aggregation across config dirs; the runner scrapes the CLI `/usage` TUI for rate-limit/utilization data.
- `electron/services/rate-limits.ts`
  Rate-limit snapshot storage + threshold notifications.
- `electron/services/mcp.ts`
  MCP server management.
- `electron/services/slash-commands.ts`
  Slash-command storage and resolution.
- `electron/services/auth/codex-auth.ts` + `one-shot-terminal.ts`
  Codex authentication (`codex login` driven through a shared pty terminal) and the one-shot pty/xterm modal it uses.
- `electron/services/brain/`
  The Brain: a per-account Markdown memory vault, its FTS5 index, the source adapters that feed it, and the throttled indexing queue. See the Brain section below before changing any of it.
- `electron/services/lima.ts` / `git-worktrees.ts`
  Lima VM viewer and git-worktree listing.
- `electron/services/cost/`
  Durable cost history, per-session cost, and the internal-transcript archive's pricing.
- `electron/services/model-pricing.ts` / `models.ts`
  Effective-dated pricing rows layered over `SHIPPED_PRICING`, and the dynamic model catalog.
- `electron/services/proxy.ts`, `permissions-io.ts`, `filesystem.ts`, `project-pins.ts`, `git-branches.ts`, `git-watcher.ts`, `branch-colors.ts`
  Supporting services.
- `electron/remote/account-watchers.ts`
  Identity / Codex-auth file watchers, broadcast to every client.
- `macos/Sources/OmniFexCore/` — `Updater.swift` + `Installer.swift` (GitHub-release updates, the idle gate, the bundle swap), `TabStatusStore.swift`, `NotificationSound.swift`, `NavigationPolicy.swift`, `ProtocolFilePolicy.swift`, `OpenPathPlanner.swift`
  The native side's rules, each ported from the Electron-era TypeScript with its tests.
- `electron/services/database.ts`
  `better-sqlite3` factory, schema init, migrations. WAL + `busy_timeout=5000`, because two daemons (the real one and the dev one) can hold the file open at the same time.

This is a multi-engine app (Claude + Codex). Codex is reachable but partial — `codex-cli-engine.ts` has explicit `not yet wired` stubs for some control paths, and Codex deliberately reads a single `~/.codex` (it does not consume the per-account CODEX_HOME that `resolve()` can compute).

## Multi-Account Rules

`AccountsService.resolve()` must use this order:

1. Explicit project override
2. Longest matching path rule
3. Unambiguous on-disk ownership — the project's `projects/<encoded>` directory
   exists under **exactly one** account's config dir (Claude slot only)
4. `null`

Do not introduce a silent default-account fallback.

Step 3 is evidence, not a default, and the distinction is load-bearing:

- It fires only on **exactly one** match. Two accounts holding the same folder
  is real ambiguity — return `null` and let the account picker ask.
- It never invents `~/.claude` and never picks "the first account".
- Explicit user intent (steps 1–2) always wins over the inference.

The rationale is that `listProjects` has always attributed projects by
location, stamping `account_id` from whichever config dir it found the project
under. Resolution ignoring that produced a contradiction — the Projects list
showing a project as Work's while opening it threw `NO_ACCOUNT_FOR_PROJECT`.
The same principle already governs Brain sources ("ownership comes from the
source's location, never from `resolve()`"); sessions are the same kind of
artifact. Path rules are a convenience for folders with no history yet, not a
gate on folders that demonstrably already belong somewhere.

Codex is excluded from step 3: it reads a single `~/.codex` and has no
per-account `projects/<encoded>` layout, so there is no equivalent evidence.

Other account rules:

- Normalize path rules before matching.
- Use `isPathInside()`-style prefix checks so sibling paths do not match accidentally.
- Session and agent launches pass `CLAUDE_CONFIG_DIR` from the resolved account.
- Do not assume every Claude config read/write path is fully account-scoped today; verify settings, hooks, MCP, slash commands, and usage behavior end to end when touching them.

## Repo Rules

- New renderer IPC work should go through `src/lib/api.ts` when possible. Some older components still call `window.electronAPI` directly.
- Strip `undefined` optional params before crossing IPC.
- Every new invoke channel must be added to `INVOKE_CHANNELS` in `electron/ipc/channels.ts`, and has exactly one owner: the daemon's handler map, a typed session method, or the Mac app. `ipc-channel-contract.test.ts` checks all three, and that the Swift router names every native channel.
- Decide, for every new channel, whether it is **native-only** (needs a window, a display, Finder, the dock, the bundle). Native channels go in `NATIVE_INVOKE_CHANNELS` *and* get a Swift handler (`macos/Sources/OmniFex/NativeHandlers.swift`); native events go in `NATIVE_EVENT_PREFIXES`. Everything else is the daemon's.
- Handler adapters should accept both camelCase and snake_case params, for example `data.configDir ?? data.config_dir`.
- Preserve the end-to-end account-aware path whenever a change touches projects, sessions, agents, usage, hooks, MCP, or Claude settings.
- The daemon serves HTTP (`/healthz`, `/api/sessions`, `/api/projects`, `/api/push/*`) and the web client. It is not a general REST API and new functionality belongs on the WebSocket protocol or an allow-listed `rpc.invoke`, not a new route.
- If the Claude CLI already provides the needed behavior via a flag or output mode, drive it through that interface instead of reimplementing it in the wrapper.

## High-Value Paths

- `electron/remote/daemon.ts`
  The composition root: service construction, adapter wiring.
- `electron/ipc/handlers.ts`
  The channel → handler map the daemon serves over `rpc.invoke`.
- `macos/Sources/OmniFex/` — `AppServices.swift`, `BrowserWindowController.swift`, `Bridge.swift`, `NativeHandlers.swift`
  The Mac app.
- `src/lib/api.ts`
  Typed renderer API surface.
- `src/lib/apiAdapter.ts`
  Renderer transport layer.
- `src/App.tsx`
  Project open flow and account picker handoff.
- `src/components/AccountSettings.tsx`
  Accounts and path-rule UI.
- `src/components/AgentSession.tsx`
  Core session UX and stream handling (formerly `ClaudeCodeSession.tsx`).
- `packaging/` + `scripts/package-mac.ts`
  The bundle layout, the bundled Node, signing and notarization.
- `src/lib/remote/bootstrap.ts`
  Decides what `window.electronAPI` is, once per page load.
- `src/protocol/messages.ts`
  The wire contract shared by daemon and clients.

## Testing And Verification

- Tests live in `electron/__tests__/*.test.ts` (daemon, packaging), beside the renderer code in `src/**/__tests__/`, and in `macos/Tests/` (Swift Testing, `npm run test:swift`).
- **Coverage target is 80% lines, repo-wide** — not backend-only. The target
  used to read "for backend work", which quietly excused the renderer and made
  the headline number unanswerable: a blended 79% could mean anything.
- `npm run coverage:areas` (after `npm run test:coverage`) breaks that number
  down by area and ranks files by uncovered LINES rather than percentage. Use
  it before concluding coverage is "low" — a 400-line file at 14% outweighs
  twenty small files at 0%, and the summary line cannot show that.
- Coverage is reported, not gated. See the comment in `vitest.config.ts`:
  hard thresholds used to trip release builds on diffs that barely moved the
  number, and there is no CI to enforce against.
- `src/components` is the standing gap (~65%). Two things there are genuinely
  low-value to chase and should not be padded for the metric: `src/lib/api.ts`,
  ~3,600 lines of one-line IPC wrappers already guarded by
  `ipc-channel-contract.test.ts` plus `npm run check`, and the presentational
  tool widgets under `src/components/claude/tools/`.
- Use `createDatabase(':memory:')` for DB-backed service tests.
- Verification gate:
  - Frontend-only change: `npm run check` and `npm run build`
  - Main-process change: `npm run check` and `npm test`
  - Cross-cutting or risky change: `npm run check`, `npm run build`, and `npm run test:coverage`
- If verification cannot run, say exactly why.

## Skills

Repo-local skills live in `.claude/skills/` (there is no `.claude/commands/`;
commands were folded into skills 2026-09-24). Deterministic steps live in each
skill's `scripts/` and are invoked as `bash ${CLAUDE_SKILL_DIR}/scripts/<x>.sh`;
the prose in `SKILL.md` covers only the judgment calls.

- `verify` — the verification gate (`scripts/verify.sh`, `--quick` for check + test); runs the Swift tests too
- `commit` — verify, commit, optionally push; no approval step
- `resume` — "where were we"; git state is pre-injected
- `omnifex-release` — the release runbook; preflight is pre-injected, gatekeeper and publish checks are scripts
- `session-trace` — one session UUID → daemon state, CLI transcript, `app_logs`; run before reading code for a stuck session
- `multi-account-debugging` — project path → account resolution trace
- `brain-eval` — is the Brain worth its cost: measure, judge, record, compare; runs stored in `<userData>/brain-evals/`, never the repo or /tmp
- `version-aware-research` — when to confirm version-sensitive syntax before relying on memory

## Legacy Notes

- Ignore old Tauri- or Rust-era references unless the task is explicitly a cleanup pass.
