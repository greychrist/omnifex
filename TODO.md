# SDK Integration Gaps — TODO

Gap analysis of `@anthropic-ai/claude-agent-sdk` 0.2.101 usage vs. what the SDK actually exposes. Written 2026-04-11 after reading `code.claude.com/docs/en/agent-sdk/overview` + the installed type defs in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.

**Current integration surface:** `electron/services/sessions.ts` passes 7 options (`cwd`, `model`, `permissionMode`, `env`, `pathToClaudeCodeExecutable`, `resume`, `canUseTool`). The `Options` type has ~50 fields; the `Query` object has ~20 methods we never call.

**Also note:** `electron/services/agents.ts::executeAgent` doesn't use the SDK at all — it still `spawn()`s the CLI directly. This was deferred during the Tauri→Electron migration (see `docs/superpowers/specs/2026-04-09-sdk-integration-design.md:194`).

---

## Wave 1 — one-line fixes that close real gaps ✅ SHIPPED

Landed in `74fe715 feat(sessions): wire SDK settingSources, strictMcpConfig, stderr logging`.

- [x] **1.1** Add `settingSources: ['user', 'project', 'local']` to session options in `electron/services/sessions.ts`. Without this, the SDK runs in isolation mode and ignores project `CLAUDE.md`, `.claude/skills/*`, `.claude/commands/*`, `.claude/settings.json` — a critical gap for a Claude Code GUI.
- [x] **1.2** Make sure MCP servers configured via our MCP service reach `query()`. **Covered by 1.1:** `settingSources: ['user', ...]` loads `~/.claude/settings.json` (where our `mcp.ts` writes `mcpServers`), and the SDK CLI loads project `.mcp.json` automatically from `cwd`. No explicit `mcpServers` option needed.
- [x] **1.3** Add `stderr` callback on the session options that pipes the CLI subprocess's stderr into the logging service. Wired via a new optional `logging: LoggingService | null` param on `createSessionsService`. Stderr lines are written as `{ source: 'claude-sdk', category: 'session:<tabId>', level: 'debug' }` log entries. **Nuance discovered during verification:** the Claude CLI routes its own `--debug` output to `~/.claude-personal/debug/<sessionId>.txt`, not stderr. The callback still catches *unexpected* stderr (crashes, fatal errors) but won't see routine debug chatter. Clarified in comments in `5798b48`.
- [x] **1.4** Add `strictMcpConfig: true` so invalid MCP configs surface as errors instead of silent warnings.
- [x] **1.5** Run full verify gate. Commits landed:
  - `74fe715` — Wave 1 SDK options (292/292 tests, 94.16% line coverage, sessions.ts at 97.84%).
- [x] **1.6** Verify in running app. Confirmed 2026-04-11 04:10 local via `~/.claude-personal/debug/<sessionId>.txt` debug trace:
  - SDK is loading skills from project `.claude/skills` path → `settingSources` working
  - 53 permission rules loaded from user settings + 6 from localSettings → all three setting sources honored
  - No `NODE_MODULE_VERSION` mismatch or `Blocked IPC channel` noise from Wave 1 paths

---

## Wave 1.5 — off-roadmap fixes discovered during Wave 1 verification

- [x] **1.5.1** `get_checkpoint_settings` channel missing end-to-end (service method, handler interface, handler registration, main.ts adapter mapping, preload allow-list). Every session start was logging "Failed to check auto checkpoint: Blocked IPC channel". Fixed in `aa918c3 fix(ipc): wire get_checkpoint_settings channel end-to-end` — 4 new tests, verified gone in app log.
- [x] **1.5.2** Add `npm run rebuild:electron` dev script that invokes `electron-rebuild -f -w better-sqlite3`. After any vitest run, the `pretest` hook rebuilds better-sqlite3 for system Node's ABI, which crashes Electron on `rs` with `NODE_MODULE_VERSION` mismatch → avalanche of "No handler registered" errors. Script gives a fast (~5s) way to flip the ABI back without killing the app. Landed in `5798b48`.
- [ ] **1.5.3** `log_count` / `log_prune` channels missing end-to-end. `LogTab.tsx`'s Clear-All button calls `api.logCount()` → shows "blocked IPC channel: log_count" error; then on confirm would call `api.logPrune()` which would also fail. Need: new `count()` and `prune(olderThan?)` methods on `LoggingService`, handler interface + registration, main.ts adapter, preload allow-list, tests. **Still open.**

---

## Wave 2 — high-leverage `Query` methods ✅ SHIPPED

**Backend** landed in `78d6107`. All 8 Query-method passthroughs exposed in `SessionsService`, wired through IPC, covered by 9 unit tests.

**Renderer** landed incrementally over 6 commits:

- [x] **2.4a** `sessionSetModel` wired in `ClaudeCodeSession.tsx`. Switching models mid-conversation no longer tears down and restarts the session — the session + full history stays intact. Falls back to the old restart path if `setModel()` throws. (`266f281`)
- [x] **2.1** `query.accountInfo()` — fetched in `ClaudeCodeSession.tsx` when the `system:init` message arrives, rendered by `SessionHeader.tsx` as a `ShieldCheck` indicator with the SDK's email/organization/subscription. A yellow `ShieldAlert` flags any session running against a non-first-party `apiProvider` (bedrock/vertex/foundry/…). Smoke-tests the multi-account flow end-to-end every session start. (`89d5c2b`)
- [x] **2.2** `query.getContextUsage()` — replaced the client-side token approximation in `SessionHeader.tsx` with SDK-authoritative numbers. Fetched on `system:init` (baseline) and on every `result` message (refresh). Shipped a shadcn `HoverCard` with a Recharts donut + color-coded legend + per-category token breakdown, sized 2x (`h-72`, radii 76/120) inside a `w-96` card. Gracefully deduplicates the SDK's own "Free space" category so the donut doesn't double-count it. (`4697720`, `28a512b`, `e1c6359`, `5fb3a23`)
- [x] **2.3** `query.interrupt()` — `handleCancelExecution` now calls `api.sessionInterrupt()` instead of `api.stopSession()`. The current assistant turn halts but the session stays alive with full history, so the user can immediately retype without a restart round-trip. Falls back to the hard `stopSession` path if interrupt throws, so the UI always unsticks. (`772e40e`)
- [x] **2.4b** Mid-session permission-mode dropdown in `SessionHeader.tsx`. Exposes the full SDK mode set (`default`, `acceptEdits`, `plan`, `bypassPermissions`) — not just the pre-session binary toggle. Driven by a new `sdkPermissionMode` state in `ClaudeCodeSession.tsx` that seeds from the pre-session picker on init and from then on is owned by the header dropdown, which calls `api.sessionSetPermissionMode()` on every change.
- [x] **2.5** `query.supportedModels()` — SessionHeader now renders a model dropdown populated from the SDK's live list (fetched once on `system:init`), complete with display names and descriptions. Picking a model calls `api.sessionSetModel()` — same path as 2.4a, so no restart. The pre-session hardcoded picker at `ClaudeCodeSession.tsx:1199+` stays as a fallback because it runs before any session exists. `supportedCommands()` and `supportedAgents()` are wired on the backend (`78d6107`) but there's no hardcoded list in the UI to replace — if a future feature needs them they're ready.

---

## Wave 3 — bigger bets (each its own spec/plan)

- [ ] **3.1** `agents.ts::executeAgent` SDK migration — finally ship the deferred work from `2026-04-09-sdk-integration-design.md`. Switch from raw `spawn()` to `query()` so agent runs get typed messages, proper `canUseTool` permission flow, hooks, and account-scoped config dir handling.
- [ ] **3.2** `enableFileCheckpointing: true` + `query.rewindFiles(messageId)` — per-message undo UI for Claude-made file edits.
- [ ] **3.3** Hook callbacks — wire a subset of the 27 available (`PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `PreCompact`, `UserPromptSubmit`) into an audit log and UI notifications.
- [ ] **3.4** Session history via SDK: `listSessions()`, `getSessionMessages()`, `renameSession()` — replace our bespoke session listing in `claude.ts` where it overlaps with the SDK's native support.

---

## Wave 4 — opportunistic features (low urgency, add when useful)

- [ ] **4.1** `maxBudgetUsd` — per-session dollar cap (API/free accounts).
- [ ] **4.2** `maxTurns` — turn cap to stop runaway loops.
- [ ] **4.3** `additionalDirectories` — monorepo support.
- [ ] **4.4** `betas: ['context-1m-2025-08-07']` — 1M context on Sonnet 4/4.5.
- [ ] **4.5** `promptSuggestions: true` — predicted next-prompt chips.
- [ ] **4.6** `agentProgressSummaries: true` — live summaries of running subagents.
- [ ] **4.7** `thinking: { type: 'adaptive' }` + `effort` — explicit reasoning depth control.
- [ ] **4.8** `query.setMcpServers()` / `reconnectMcpServer()` / `toggleMcpServer()` / `mcpServerStatus()` — live MCP management UI.
- [ ] **4.9** `query.seedReadState()` — re-seed file-read cache after UI snip/compact so Edit doesn't fail "file not read yet".
