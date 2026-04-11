# SDK Integration Gaps — TODO

Gap analysis of `@anthropic-ai/claude-agent-sdk` 0.2.101 usage vs. what the SDK actually exposes. Written 2026-04-11 after reading `code.claude.com/docs/en/agent-sdk/overview` + the installed type defs in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.

**Current integration surface:** `electron/services/sessions.ts` passes 7 options (`cwd`, `model`, `permissionMode`, `env`, `pathToClaudeCodeExecutable`, `resume`, `canUseTool`). The `Options` type has ~50 fields; the `Query` object has ~20 methods we never call.

**Also note:** `electron/services/agents.ts::executeAgent` doesn't use the SDK at all — it still `spawn()`s the CLI directly. This was deferred during the Tauri→Electron migration (see `docs/superpowers/specs/2026-04-09-sdk-integration-design.md:194`).

---

## Wave 1 — one-line fixes that close real gaps

- [x] **1.1** Add `settingSources: ['user', 'project', 'local']` to session options in `electron/services/sessions.ts`. Without this, the SDK runs in isolation mode and ignores project `CLAUDE.md`, `.claude/skills/*`, `.claude/commands/*`, `.claude/settings.json` — a critical gap for a Claude Code GUI.
- [x] **1.2** Make sure MCP servers configured via our MCP service reach `query()`. **Covered by 1.1:** `settingSources: ['user', ...]` loads `~/.claude/settings.json` (where our `mcp.ts` writes `mcpServers`), and the SDK CLI loads project `.mcp.json` automatically from `cwd`. No explicit `mcpServers` option needed.
- [x] **1.3** Add `stderr` callback on the session options that pipes the CLI subprocess's stderr into the logging service. Wired via a new optional `logging: LoggingService | null` param on `createSessionsService`. Stderr lines are written as `{ source: 'claude-sdk', category: 'session:<tabId>', level: 'debug' }` log entries.
- [x] **1.4** Add `strictMcpConfig: true` so invalid MCP configs surface as errors instead of silent warnings.
- [x] **1.5** Run full verify gate (`check` ✓ `build` ✓ `test:coverage` ✓ — 292/292 tests, 94.16% line coverage, sessions.ts at 97.84%). Commit pending user approval.

---

## Wave 2 — high-leverage `Query` methods (each a small feature)

- [ ] **2.1** `query.accountInfo()` — after session start, display the SDK's reported account alongside our resolved account badge. Smoke-tests the multi-account flow end-to-end.
- [ ] **2.2** `query.getContextUsage()` — status-bar widget: `N% context used` with breakdown (system prompt, tools, messages, memory, MCP).
- [ ] **2.3** `query.interrupt()` — "stop response" button, distinct from "end session" (which calls `close()`).
- [ ] **2.4** `query.setModel()` + `query.setPermissionMode()` — change mid-session without restarting. Wire to existing model/mode pickers.
- [ ] **2.5** `query.supportedAgents()` / `supportedCommands()` / `supportedModels()` — replace any hardcoded lists with live introspection.

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
