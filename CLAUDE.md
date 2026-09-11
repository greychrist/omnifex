# CLAUDE.md

`AGENTS.md` is a symlink to this file — one document, two names, so agents that
look for either find the same guidance. It used to be a hand-maintained copy
that said "keep both in sync"; it drifted instead, still describing the app
under its pre-rename name and missing six sections. Don't replace the symlink
with a copy.

OmniFex (by GreyChrist) is an **Electron** desktop app for Claude Code. The current product surface centers on multi-account routing, interactive Claude sessions, custom agents, MCP management, and usage analytics.

The shipping app is OmniFex. Internal identifiers like `greychrist.db`, the `greychrist-file://` protocol, and localStorage keys retain the legacy name to avoid migration churn — only the user-facing brand and the repo/folder name changed.

The repo migrated from Tauri 2 (Rust) to Electron (Node.js/TypeScript) in April 2026. The app drives the Claude CLI binary directly via `node-pty` (TUI mode) and `child_process` (non-interactive), which is why a Node runtime is required. Any reference to `src-tauri/`, `cargo`, `just`, `nix-shell`, or an Axum web server in source code is legacy noise. (The `@anthropic-ai/claude-agent-sdk-*` package names that remain in `electron/services/claude-binary.ts` are intentional — they name the npm packages the binary resolver searches for, not a live dependency.)

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

Any change that touches session status, conversation status, the spinner / in-flight predicate, the status popover, `useSessionLifecycle`, or anything under `electron/services/sessions/`: read `docs/session-lifecycle.md` first. It defines the three orthogonal state axes (`sessionStatus`, `conversationStatus`, per-item task/subagent status), the invariants between them, the canonical in-flight rollup, and the anti-patterns that have repeatedly caused session-stuck-on-starting bugs.

## The Brain

A per-account memory vault: Markdown notes distilled from past sessions, repo artifacts, and explicit captures, searched over SQLite FTS5. Any change under `electron/services/brain/`, `electron/brain-mcp.ts`, `electron/ipc/brain-handlers.ts`, or `src/components/brain/` should start from `docs/superpowers/specs/2026-08-11-brain-memory-vault-design.md` — the parent spec — plus whichever of the six `*-brain-*` specs covers the area. The most recent is `2026-08-14-brain-concurrent-indexing-design.md` (Plan 8).

### Shape

- **Vault** — `~/OmniFex Brain/<account>/`, one per account, path in `app_settings` under `brain.vault.<accountId>`. Deliberately outside userData so it opens in Obsidian and backs up normally, and deliberately out of `~/Documents`/`~/Desktop` so no sync client can evict it (see below). Git-versioned; the FTS index lives at `<vault>/.omnifex/index.db` and is derived and disposable.
- **Orchestration state** — `brain_sources` (change detection), `brain_queue` (work), `brain_spend` (append-only cost ledger) in `greychrist.db`. Note *content* never lives there, only pointers and status.
- **Pipeline** — `sources/*` discover → `admit()` → `distill()` → `extract.ts` (Sonnet, zod-validated) → `merge.ts` (pure) → note. `curate.ts` / `curation.ts` is the separate Opus-pinned pass that rewrites accumulated notes.
- **Consumption** — `brain-mcp.ts` is a stdio MCP server the *CLI* spawns (`brain_search` / `brain_read` / `brain_remember`), plus the Brain tab and `/recall`. Nothing auto-injects vault content into a session.

### Rules that are load-bearing

- **One vault per account, and isolation is enforced by process environment**, not query filters. The MCP server has no account concept — it reads the single `OMNIFEX_VAULT` path it was handed. Never add a "which vault?" parameter to it.
- **The account that owns a source is the account that indexes it and whose vault receives it.** Ownership comes from the source's location (`getAccountByConfigDir` for transcripts), never from `resolve()`. No silent default-account fallback — an unresolved item is `blocked` and surfaced.
- **Spawn the MCP server as `process.execPath` with `ELECTRON_RUN_AS_NODE=1`**, never system `node`: `better-sqlite3` is built against the Electron ABI.
- **The Brain is auxiliary.** Nothing in it may break a session, block the UI, or consume rate limit needed for real work. A failed item never blocks the queue.
- **`merge.ts` must stay pure and idempotent** — indexing the same session twice produces a byte-identical note. It is the property tested hardest.
- **Money is recorded in `brain_spend`, never inferred.** `brain_sources.cost_usd` is a per-item snapshot that re-indexing overwrites; the ledger is append-only and is what `stats.spentUsd` and the Brain tab read. It is an *audit* record, not a reporting one — the Cost Report reads `session_cost_daily` only, so nothing is counted twice.
- **A vault must never live under a file provider.** `~/Documents` and `~/Desktop` are claimed by iCloud Drive whenever "Desktop & Documents Folders" is on; Dropbox/OneDrive/Drive claim their own folders. With storage optimisation, contents are evicted to `SF_DATALESS` stubs costing ~0.6s per read, which turns one `git add -A` into minutes of silent hang — this was the original default and it shipped the bug. `offloaded.ts` probes the flag; `status().offloadedCount` surfaces it. Null there means "not determined", never "none".
- **Extraction transcripts are retained, not swept.** They used to be `rm -rf`'d the moment the call returned, which raced the cost watcher and left a non-deterministic fraction of the Brain's own spend in the cost table. They now move to `<userData>/internal-sessions/<account>/<kind>/<date>/` and are priced there like any other transcript, attributed as `OmniFex/Brain index` and `OmniFex/Brain curation`. Age-capped at 90 days with a Clear button; pruning never removes cost rows. The Brain must never index that archive — it would distil its own distillations and pay for it every cycle. See `docs/superpowers/specs/2026-08-26-internal-session-archive-design.md`.

## OmniFex Remote

The app is split into a headless **daemon** that owns every CLI session and thin
**clients** that talk to it over a versioned WebSocket protocol. The Electron app
is one client; the same renderer, served by the daemon, is a Safari Home Screen
app on the iPad. Start from `docs/remote-access.md` and
`docs/superpowers/specs/` before changing any of it.

### Shape

- **Daemon** — `electron/omnifex-server.ts` → `electron/remote/daemon.ts`, built to
  `.vite/build/omnifex-server.js`. Runs as the app's own Electron executable with
  `ELECTRON_RUN_AS_NODE=1` so `better-sqlite3` and `node-pty` keep one ABI.
- **Process name** — `omnifexd`, and it comes from a second copy of the Electron
  stub shipped in the bundle. Never `process.title`: on macOS that registers a
  headless process with LaunchServices as a launching Foreground app and the Dock
  bounces forever. A symlink does not work either — the kernel resolves it.
- **State** — `~/.omnifex/` (`server.json`, `server.pid`, `projects.json`,
  `sessions/<id>.events.jsonl` + `.meta.json`). The SQLite DB stays in userData
  and is shared with the app.
- **Protocol** — `src/protocol/` (types), `electron/remote/server.ts` (transport),
  `electron/remote/handlers.ts` (methods). The protocol's `sessionId` IS the
  sessions service's `tabId`; that equivalence is the whole trick.
- **Client side** — `src/lib/remote/bootstrap.ts` picks the mode,
  `electronApiShim.ts` maps `invoke()` onto typed methods or `rpc.invoke`, and
  `nativeChannels.ts` names what stays in Electron.

### Rules that are load-bearing

- **Remote mode is the default.** `remote:url` returns a URL unless
  `OMNIFEX_REMOTE=0` or `remote.enabled=false`, and the app starts a daemon if
  none is running. "Desktop" and "legacy IPC" are not the same thing — a
  desktop-only bug can still be a remote-mode bug.
- **The preload publishes `__omnifexNative`, never `electronAPI`.** See the
  Process Model note above.
- **The rpc allow-list is subtractive** (`electron/remote/rpc-allowlist.ts`): it
  starts from every renderer channel and removes Electron-only, typed-session and
  raw-SQL groups. A new channel is therefore network-reachable by default. If it
  should not be, deny it explicitly.
- **`NATIVE_INVOKE_CHANNELS` is one list with two readers** — the daemon's deny
  list and the client's routing table. It lives in `src/` because both sides load
  it. Keep it pure data.
- **The daemon must never `import` the `electron` module.** The one
  `require('electron')` on its import graph is inside `registerIpcHandlers`,
  which the daemon never calls.
- **`electron/remote/daemon.ts` duplicates main.ts's service wiring on purpose**,
  and that duplication is a standing hazard: a service added to one and not the
  other yields a feature that works on the desktop and silently degrades over the
  wire. Change both, or neither. What is deliberate is the *wiring* — imports,
  service construction, and the adapter bags handed to the handler surface.
  Behaviour is not: anything with a rule in it belongs in a module both roots
  import. `periodic-work.ts`, `session-close-work.ts`, `session-jsonl-path.ts`,
  `logging-options.ts` and `createAccountIdentityVerdict` are those modules, and
  each one exists because the copy in one root had been re-typed by hand and the
  reasoning survived in the other. A new callback with a branch in it goes there
  too, not into both roots.
- **Periodic work lives in `electron/periodic-work.ts`, and only one process
  runs it.** The cost-history backfill, the archive prune, `reclaimFreePages`
  and the Brain sweep/drain used to be copy-pasted into both composition roots
  and both ran, because remote mode is the default and both processes are
  normally alive. Two Brain workers drained one queue, and `recoverOrphans()`
  at startup re-queued items the other process was paying to extract — billed
  twice, since `brain_spend` is append-only. `startPeriodicWork` takes an
  `enabled` gate: main passes `() => !remoteInUse`, the daemon passes none.
  The gate is read **per tick**, never sampled at construction — main does not
  learn whether a daemon answered until the renderer asks for `remote:url`,
  which is after the timers are armed. Add new periodic work here, not to a
  composition root.

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
  in the devtools console (works in packaged builds — the app menu keeps
  `role: 'toggleDevTools'`), reload, then interact: each tab switch or drag
  crossing prints its render count and duration. See `src/lib/renderProfiler.ts`.
  Every open tab is mounted at once and the transcript is unvirtualised, so the
  default failure mode is "one click re-rendered every session in the app" —
  check that first.
- Node.js is the only required runtime. No Rust toolchain is needed.
- Commands:
  - `npm start` — launch the Electron app via Electron Forge
  - `npm run dev` — renderer-only Vite dev server
  - `npm run build` — `tsc && vite build --config vite.renderer.config.ts`
  - `npm run check` — TypeScript check across renderer and main process
  - `npm run package` — Electron Forge package output
  - `npm run make` — Electron Forge installers (signed + notarized with `OMNIFEX_NOTARIZE=1`)
  - `npm run build:web` — the browser client into `dist-web/`
  - `npm run build:daemon` — the daemon bundle into `.vite/build/omnifex-server.js`
  - `npm test` — Vitest one-shot
  - `npm run test:watch` — Vitest watch mode
  - `npm run test:coverage` — Vitest with v8 coverage

## Architecture

### Process Model

- **Main process**: `electron/**`
  Owns SQLite, filesystem access, Claude CLI spawning (interactive sessions, agents, usage), account resolution, and all privileged work.
- **Preload**: `electron/preload.ts`
  Publishes one object, `window.__omnifexNative`, through a strict allow-list read from `electron/ipc/channels.ts`. Missing channels fail here first.
  It must NOT publish `electronAPI`: `contextBridge` defines its properties non-writable and non-configurable, so the remote shim could never replace one — the assignment threw and every launch silently fell back to legacy IPC. `src/lib/remote/bootstrap.ts` is the only place `window.electronAPI` is assigned.
- **Renderer**: `src/**`
  UI layer. Most main-process access goes through `src/lib/api.ts` and `src/lib/apiAdapter.ts`, though some older components still call preload APIs directly. No direct Node.js access.

### Service Pattern

- Main-process services live in `electron/services/`.
- Services are factory functions: `createFooService(deps) -> FooService`.
- Dependencies are injected so services can be tested with `createDatabase(':memory:')`.
- Services are constructed in `electron/main.ts` and passed to `registerIpcHandlers(...)` in `electron/ipc/handlers.ts`.
- Keep business logic in services, not renderer components or thin IPC adapters.

### Core Services

- `electron/services/accounts.ts`
  Multi-account CRUD, path rules, project overrides, resolution, discovery.
- `electron/services/claude.ts`
  Project listing, Claude settings, CLAUDE.md file ops, hooks config, version checks.
- `electron/services/sessions/` (split across `tui.ts`, `lifecycle.ts`, `runtime.ts`, `permissions.ts`, etc.)
  Interactive sessions, spawned via `node-pty` (TUI mode) / `child_process` (stream-json). Engine selection (Claude vs Codex) lives here; the binary is located at runtime via `electron/services/claude-binary.ts`.
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
- `electron/services/installer.ts` + `installer/`
  In-app updater install gate — waits for turns to go idle (renderer-derived, via `tab-status.ts`) before swapping the bundle.
- `electron/services/updater.ts`, `notifications.ts`, `notification-sounds.ts`, `proxy.ts`, `permissions-io.ts`, `filesystem.ts`, `project-pins.ts`, `git-branches.ts`, `git-watcher.ts`, `branch-colors.ts`
  Electron-side supporting services. The first four are main-process-only — the daemon has no adapter for them.
- `electron/services/database.ts`
  `better-sqlite3` factory, schema init, migrations. WAL + `busy_timeout=5000`, because the daemon and the Electron app hold the file open at the same time.

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

- New renderer IPC work should go through `src/lib/api.ts` when possible. Some older components still call preload APIs directly.
- Strip `undefined` optional params before crossing IPC.
- Every new invoke channel must be added to `INVOKE_CHANNELS` in `electron/ipc/channels.ts` (which is what `preload.ts` reads). `ipc-channel-contract.test.ts` pins that list against the registered handlers in both directions.
- Decide, for every new channel, whether it is **native-only**. If it needs a `BrowserWindow`, a display, a pty, or the updater, add it to `NATIVE_INVOKE_CHANNELS` in `src/lib/remote/nativeChannels.ts` — otherwise the shim routes it to the daemon, whose adapter bag does not have that service, and the optional-chained handler returns `null` instead of failing. That silent `null` is indistinguishable from "not configured".
- Event channels must match the preload prefix allow-lists.
- Handler adapters should accept both camelCase and snake_case params, for example `data.configDir ?? data.config_dir`.
- Preserve the end-to-end account-aware path whenever a change touches projects, sessions, agents, usage, hooks, MCP, or Claude settings.
- The daemon serves HTTP (`/healthz`, `/api/sessions`, `/api/projects`, `/api/push/*`) and the web client. It is not a general REST API and new functionality belongs on the WebSocket protocol or an allow-listed `rpc.invoke`, not a new route.
- If the Claude CLI already provides the needed behavior via a flag or output mode, drive it through that interface instead of reimplementing it in the wrapper.

## High-Value Paths

- `electron/main.ts`
  App bootstrap, service construction, adapter wiring.
- `electron/ipc/handlers.ts`
  IPC registration and handler surface.
- `electron/preload.ts`
  IPC allow-list and event bridge.
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
- `electron/remote/daemon.ts`
  The daemon's composition root — the second place the service graph is built.
- `src/lib/remote/bootstrap.ts`
  Decides what `window.electronAPI` is, once per page load.
- `src/protocol/messages.ts`
  The wire contract shared by daemon and clients.

## Testing And Verification

- Tests live in `electron/__tests__/*.test.ts`.
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

## Commands And Skills

Repo-local commands live in `.claude/commands/`:

- `/verify`
- `/commit`
- `/resume`
- `/account-trace`

Repo-local skills live in `.claude/skills/`:

- `version-aware-research`
- `multi-account-debugging`
- `omnifex-release`

## Legacy Notes

- Ignore old Tauri- or Rust-era references unless the task is explicitly a cleanup pass.
