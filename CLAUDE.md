# CLAUDE.md

OmniFex (by GreyChrist) is an **Electron** desktop app for Claude Code. The current product surface centers on multi-account routing, interactive Claude sessions, custom agents, MCP management, and usage analytics.

The shipping app is OmniFex. Internal identifiers like `greychrist.db`, the `greychrist-file://` protocol, and localStorage keys retain the legacy name to avoid migration churn — only the user-facing brand and the repo/folder name changed.

The repo migrated from Tauri 2 (Rust) to Electron (Node.js/TypeScript) in April 2026. The original driver was the Claude Agent SDK (which needed a Node runtime); since then the app has dropped the SDK entirely and now drives the Claude CLI binary directly via `node-pty` and `child_process` — Node is still required for that. Any reference to `src-tauri/`, `cargo`, `just`, `nix-shell`, an Axum web server, or `@anthropic-ai/claude-agent-sdk` in source code is legacy noise.

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
- Node.js is the only required runtime. No Rust toolchain is needed.
- Commands:
  - `npm start` — launch the Electron app via Electron Forge
  - `npm run dev` — renderer-only Vite dev server
  - `npm run build` — `tsc && vite build --config vite.renderer.config.ts`
  - `npm run check` — TypeScript check across renderer and main process
  - `npm run package` — Electron Forge package output
  - `npm run make` — Electron Forge installers
  - `npm test` — Vitest one-shot
  - `npm run test:watch` — Vitest watch mode
  - `npm run test:coverage` — Vitest with v8 coverage

## Architecture

### Process Model

- **Main process**: `electron/**`
  Owns SQLite, filesystem access, Claude CLI spawning (interactive sessions, agents, usage), account resolution, and all privileged work.
- **Preload**: `electron/preload.ts`
  Exposes `window.electronAPI.invoke(channel, params)` through a strict allow-list. Missing channels fail here first.
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
- `electron/services/sessions/` (split across `tui.ts`, `lifecycle.ts`, etc.)
  Interactive sessions through the Claude CLI binary, spawned via `node-pty` for TUI mode and `child_process` for non-interactive queries. The binary is located at runtime via `electron/services/claude-binary.ts`.
- `electron/services/agents.ts`
  Agent CRUD and execution through the Claude CLI.
- `electron/services/usage.ts`
  Usage aggregation across config dirs.
- `electron/services/mcp.ts`
  MCP server management.
- `electron/services/slash-commands.ts`
  Slash-command storage and resolution.
- `electron/services/database.ts`
  `better-sqlite3` factory, schema init, migrations.

## Multi-Account Rules

`AccountsService.resolve()` must use this order:

1. Explicit project override
2. Longest matching path rule
3. `null`

Do not introduce a silent default-account fallback.

Other account rules:

- Normalize path rules before matching.
- Use `isPathInside()`-style prefix checks so sibling paths do not match accidentally.
- Session and agent launches pass `CLAUDE_CONFIG_DIR` from the resolved account.
- Do not assume every Claude config read/write path is fully account-scoped today; verify settings, hooks, MCP, slash commands, and usage behavior end to end when touching them.

## Repo Rules

- New renderer IPC work should go through `src/lib/api.ts` when possible. Some older components still call preload APIs directly.
- Strip `undefined` optional params before crossing IPC.
- Every new invoke channel must be added to the allow-list in `electron/preload.ts`.
- Event channels must match the preload prefix allow-lists.
- Handler adapters should accept both camelCase and snake_case params, for example `data.configDir ?? data.config_dir`.
- Preserve the end-to-end account-aware path whenever a change touches projects, sessions, agents, usage, hooks, MCP, or Claude settings.
- There is no web or REST mode.
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
- `src/components/ClaudeCodeSession.tsx`
  Core session UX and stream handling.

## Testing And Verification

- Tests live in `electron/__tests__/*.test.ts`.
- Coverage target is 80% lines for backend work.
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
