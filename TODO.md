# SDK Integration Gaps — TODO

Gap analysis of `@anthropic-ai/claude-agent-sdk` 0.2.101 usage vs. what the SDK actually exposes. Written 2026-04-11, updated 2026-04-12.

**Current integration surface:** `sessions.ts` passes ~15 options including `settingSources`, `strictMcpConfig`, `betas`, `stderr`, `hooks`, and all Wave 2 Query-method passthroughs. `agents.ts` is fully SDK-based (`query()` with `systemPrompt`, `permissionMode: 'acceptEdits'`, `settingSources`, `strictMcpConfig`, `betas`). Both services share consistent account resolution via `CLAUDE_CONFIG_DIR`.

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
- [x] **1.5.3** `log_count` / `log_prune` channels + filter name mismatch. Shipped in `407dadc`. Added `count()` and `prune(olderThan?)` to `LoggingService` with a shared `buildWhere()` helper. Also fixed the filter name mismatch: `api.ts` had singular `level`/`source` but `logging.ts` expected plural `levels`/`sources` arrays — filters had been silently no-oping since the Electron migration. 10 new logging tests.

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

- [x] **3.1** `agents.ts::executeAgent` SDK migration — shipped. Switched from raw `spawn()` to `query()` from the SDK. Agent runs now get the same plumbing as interactive sessions: typed `SDKMessage` objects, `settingSources: ['user', 'project', 'local']`, `strictMcpConfig: true`, resolved `CLAUDE_CONFIG_DIR`, and optional `pathToClaudeCodeExecutable`. New `electron/services/agent-run-registry.ts` replaces the old `process-registry.ts` (deleted) — stores `{ query: Query, status }` handles instead of `ChildProcess`, so `killAgentSession` calls `query.close()`, `getSessionStatus` reads from the registry, and `cleanupFinishedProcesses` sweeps non-`running` entries. **Also fixed a pre-existing bug:** the old code sent output on `claude-output:<runId>` but the renderer components (`AgentExecution.tsx`, `AgentRunOutputViewer.tsx`, `SessionOutputViewer.tsx`) listen on `agent-output:<runId>` — agent output had never reached the UI. New code sends on `agent-output:`, plus fires `agent-complete:<runId>` on the natural stream end, `agent-error:<runId>` on stream throws, and `agent-cancelled:<runId>` on kill. Dropped the PID column usage (stays nullable for historical rows; new runs leave it NULL since SDK doesn't expose a PID). 15 new SDK-based tests in `agents.test.ts` replace the old spawn-based 16, plus new `agent-run-registry` tests. `agents.ts` line coverage went from ~88% to 98.87%.
- [ ] **3.2** `enableFileCheckpointing: true` + `query.rewindFiles(messageId)` — per-message undo UI for Claude-made file edits.
- [x] **3.3 (audit-only slice)** Hook callbacks — `PreToolUse`, `PostToolUse`, and `PostToolUseFailure` are now wired in `electron/services/sessions.ts::start()` when a logging service is provided. Each hook writes one entry to the logging service with `source: 'claude-hooks'`, `category: session:<tabId>`, and a cap on metadata size (~4KB) so huge tool responses can't blow up a single log row. PreToolUse messages start with `→`, PostToolUse with `←`, PostToolUseFailure with `✗`. Callbacks return `{}` — audit only, no permission gating. 6 new tests. Other hooks (`SubagentStart/Stop`, `PreCompact`, `UserPromptSubmit`, `FileChanged`, etc.) remain unused and can be added incrementally when there's a UI surface that needs them.
- [ ] **3.4** Session history via SDK: `listSessions()`, `getSessionMessages()`, `renameSession()` — replace our bespoke session listing in `claude.ts` where it overlaps with the SDK's native support.

---

## Wave 4 — opportunistic features (low urgency, add when useful)

- [ ] **4.1** `maxBudgetUsd` — per-session dollar cap (API/free accounts).
- [ ] **4.2** `maxTurns` — turn cap to stop runaway loops.
- [ ] **4.3** `additionalDirectories` — monorepo support.
- [x] **4.4** `betas: ['context-1m-2025-08-07']` — 1M context on Sonnet 4/4.5. Shipped in `2826d14`. Added to both `sessions.ts` and `agents.ts` query options. Safe to pass unconditionally — models that don't support it ignore the beta header.
- [ ] **4.5** `promptSuggestions: true` — predicted next-prompt chips.
- [ ] **4.6** `agentProgressSummaries: true` — live summaries of running subagents.
- [ ] **4.7** `thinking: { type: 'adaptive' }` + `effort` — explicit reasoning depth control.
- [ ] **4.8** `query.setMcpServers()` / `reconnectMcpServer()` / `toggleMcpServer()` / `mcpServerStatus()` — live MCP management UI.
- [ ] **4.9** `query.seedReadState()` — re-seed file-read cache after UI snip/compact so Edit doesn't fail "file not read yet".

---

## Wave 5 — architecture audit punch list (2026-04-17)

Findings from a broad architecture audit run after v0.3.15. Grouped by priority; file:line anchors point at the specific hole. Fix P0 first, then P1; P2 can batch opportunistically.

### P0 — actively broken

- [x] **5.1** **Unreachable IPC channels.** Shipped. Added `agentsService.exportAgentToFile(id, filePath)` + `reveal_path_in_finder` handler (wrapping `shell.showItemInFolder`). Both channels allow-listed in `electron/preload.ts`; typed `api.exportAgentToFile` / `api.revealPathInFinder` in `src/lib/api.ts`. Migrated `CCAgents.tsx`, `Agents.tsx`, `AgentsModal.tsx`, `ClaudeVersionSelector.tsx` to the typed API (AgentsModal's stray `write_file` call is now gone — it uses `exportAgentToFile` too). 2 new agents tests.
- [x] **5.2** **Hardcoded Greg-specific path in `local_update_dir` default.** Shipped. `electron/main.ts` now gates the default on `app.isPackaged`: dev runs (`npm start`) default to `path.join(process.cwd(), 'out', 'make')` — same "just works" behaviour for Greg — while packaged installs default to empty (user configures in Settings). No more Greg-specific absolute path.

### P1 — real gaps likely to bite

- [x] **5.3** **`strictMcpConfig` missing on sessions.** Shipped. Added `strictMcpConfig: true` to session SDK options in `lifecycle.ts`. 1 new sessions test pins it.
- [x] **5.4** **Usage service silently swallows parse/IO errors.** Shipped. `createUsageService` now accepts an optional `LoggingService`; `scanConfigDir` and `readJsonlFile` log `warn`-level entries with `source: 'usage'` on IO failures (missing projects dir, unreadable project session dir, unreadable session file). Per-line JSONL parse errors are still silent by design — JSONL has trailing-newline tolerance and a single bad line in a transcript shouldn't spam the log panel. 2 new tests pin the logging path.
- [x] **5.5** **Hooks config falls back to `~/.claude` when `configDir` is missing.** Shipped. Explicit `configDir` guards added to `getHooksConfig(user)`, `updateHooksConfig(user)`, and `getMergedHooksConfig`. Also found and fixed the renderer side: `api.getHooksConfig` / `api.updateHooksConfig` / `api.getMergedHooksConfig` didn't accept `configDir` at all, so user-scope hook saves in `Settings.tsx` had been broken since `07178d9` landed the throws. Threaded `configDir` through `Settings.tsx` → `HooksSettings` → `HooksEditor`. 3 new claude tests pin the throw contract.
- [x] **5.6** **Event subscriptions bypass `src/lib/api.ts`.** Shipped. Added `api.onAgentOutput` / `onAgentError` / `onAgentComplete` / `onAgentCancelled` helpers in `src/lib/api.ts`, each returning the unsubscribe fn from the preload bridge. Migrated `AgentRunOutputViewer.tsx`, `SessionOutputViewer.tsx`, and `AgentExecution.tsx` to the typed API — no more direct `window.electronAPI.onEvent(...)` calls for agent-run events.

### P2 — notable, batch when convenient

- [ ] **5.7** Updater silently no-ops when `local_update_dir` doesn't exist or is unreadable (`electron/services/updater.ts:115-150`). Add a `debug` log so it's visible in the app's log panel.
- [ ] **5.8** **Sessions service has no tests.** `electron/services/sessions/` is five files (`lifecycle.ts`, `hooks.ts`, `permissions.ts`, `queries.ts`, `types.ts`) with zero test coverage. SDK integration here is non-trivial (hooks, permissions, elicitation, streaming, resume-after-error). Add at minimum: session start, message send, permission decision, hook-fire, and stream-error-recovery tests.
- [ ] **5.9** **Migration framework is in place but only has the baseline migration** (`electron/services/database.ts:16-27`). First real schema change will be the first time the runner is exercised against live data. Add a test that exercises a no-op migration end-to-end so the dance is proven before we need it.
- [ ] **5.10** **better-sqlite3 ABI dance is fragile.** If a developer runs `npm run dev` (Vite renderer only) without a prior `npm start` or `npm test`, the first main-process DB access crashes with a cryptic `NODE_MODULE_VERSION` mismatch. `package.json:8,16-21` handles the start/test paths. Fix: add an ABI check in `createDatabase()` that throws a clear "run `npm run rebuild:electron`" error instead of the native-module fault.

### Overall

Audit conclusion: architecture is healthier than expected. Account scoping is mostly honored end-to-end, IPC layering is solid, recent decomposition refactors paid off. The two items to prioritize: **5.1** (unreachable channels — silent IPC failures are the worst class of bug) and **5.5** (hooks `configDir` fallback — completes the "no silent `~/.claude` fallback" work).
