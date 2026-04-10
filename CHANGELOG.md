# Changelog

All notable changes to GreyChrist are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Single `ci.yml` GitHub workflow replacing the old Tauri/Rust dual workflows: TypeScript check, tests, and renderer bundle build across Linux/macOS/Windows.
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

- **Builds are unsigned.** macOS Gatekeeper will require a right-click → Open on first launch; Windows SmartScreen will warn. Signing will be added once Apple Developer + Windows code signing certs are in place.
- A handful of service files (`claude-binary.ts`, `slash-commands.ts`) sit in the 80–88% line coverage range rather than the 90%+ target. Raised in a follow-up.

[0.3.0]: https://github.com/USER/greychrist/releases/tag/v0.3.0
[0.2.0]: https://github.com/USER/greychrist/releases/tag/v0.2.0
