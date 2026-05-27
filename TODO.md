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

- [x] **5.7** Updater silently no-ops when `local_update_dir` doesn't exist or is unreadable. Shipped. `UpdaterDeps` now takes an optional `logging`; `checkForUpdate` writes a `debug` entry (source `updater`) when `readdir` throws. Disabled-by-empty-setting stays silent by design — debug-level only fires when the setting is populated but the path is unreadable. 2 new updater tests.
- [x] **5.8** **Sessions service has no tests — (audit was wrong).** Actual coverage per vitest v8: `lifecycle.ts` 93%, `hooks.ts` 81%, `queries.ts` 77%. The one real weak spot was `permissions.ts` at 57%. Added tests for the queued-permission path (`respondPermission` advancing to the next pending request) and `setAutoAllow` / `addAutoAllowTool` state mutations, taking `permissions.ts` from 57% → 78%. Remaining uncovered lines are (1) the `fs.appendFileSync('/tmp/gc-perm-debug.log', …)` dev debug block Greg uses for live permission investigation — cruft rather than missing coverage — and (2) a notification-hook-throws error path. Neither is worth testing. If 5.8 follow-up is ever needed, remove the `/tmp/gc-perm-debug.log` writes first.
- [x] **5.9** **Migration framework is in place but only has the baseline migration.** Shipped. `runMigrations` now takes an optional `migrationsOverride` (tests-only) so the runner can be exercised against synthetic migrations without landing a real schema change. 3 new tests: runs a synthetic migration end-to-end (applies + records + skips on re-run), rolls back a throwing migration (no partial side-effects thanks to the per-migration transaction), and respects ascending-version order even when the input array is shuffled.
- [x] **5.10** **better-sqlite3 ABI dance is fragile.** Shipped. Added `toActionableNativeModuleError(err)` helper in `database.ts` that matches the `NODE_MODULE_VERSION` cryptic failure and wraps it with "Run `npm run rebuild:electron` before `npm start`, or run `npm test` first." `createDatabase` now catches the native-module throw and re-throws with the actionable message. 3 tests pin the helper. (Side benefit: running the tests right after `npm run make` leaves better-sqlite3 at Electron ABI, and the guard surfaces the issue immediately instead of a cryptic `ERR_DLOPEN_FAILED`.)

### Overall

Audit conclusion: architecture is healthier than expected. Account scoping is mostly honored end-to-end, IPC layering is solid, recent decomposition refactors paid off. The two items to prioritize: **5.1** (unreachable channels — silent IPC failures are the worst class of bug) and **5.5** (hooks `configDir` fallback — completes the "no silent `~/.claude` fallback" work).

### Wave 5 complete — 2026-04-17

All ten items shipped across three commits (`48e26af`, `9df9115`, plus a third from the P2 batch). Test count went from 437 → 455 (+18 targeted tests). No new deps, no architectural rewrites; everything followed existing patterns. Next architecture audit should skip Wave 5 and focus on new regressions / SDK surface drift.

---

## Wave 6 — architecture audit punch list (2026-04-27)

Findings from a follow-up architecture audit run after v0.3.63. Verified in-repo with file:line spot-checks. Items are loosely coupled — each can ship as its own PR.

### P1 — actively broken / contract mismatches

- [ ] **6.1 Hooks `local` scope is broken end-to-end.**
  Picking the Local tab in `HooksEditor` and saving silently writes user-scope `<configDir>/settings.json` instead of `<projectPath>/.claude/settings.local.json`. Reading the Local tab returns user-scope hooks. The renderer's three-way merge in `api.ts:1680` reads user hooks twice and never sees `settings.local.json` content at all.
  *Root cause:* `main.ts:515-516` does a TS-only `as 'user' | 'project'` cast on a runtime `'local'` value; service signatures and bodies in `claude.ts:668,698` only branch on `'user' | 'project'`, so `'local'` falls through to the user-scope branch. Two competing merge implementations live in the codebase: backend `getMergedHooksConfig` (`claude.ts:760`, two-way) and renderer (`api.ts:1680`, three-way).
  *Fix:* widen the service signatures to `'user' | 'project' | 'local'`; add a `local` branch that reads/writes `<projectPath>/.claude/settings.local.json`; drop the casts in `main.ts:515-516`; collapse the merge into a single backend function that does the proper three-way and have the renderer call it once instead of three round-trips.
  *Tests (TDD):* failing test that picks `'local'`, saves a hook, asserts `settings.local.json` contains it and `configDir/settings.json` does not. Merged-read test that returns hooks from all three files with correct precedence (local > project > user).

- [ ] **6.2 MCP API contract is broken at multiple layers.**
  `mcpAddJson` always throws "Invalid JSON configuration" because the renderer sends `jsonConfig` (`api.ts:1186`) but `handlers.ts:385` passes raw params to `addJson`, which destructures `json` (`mcp.ts:151`). `scope` is silently ignored. The renderer types claim `AddServerResult { success, message, server_name }` but `addJson` returns a raw `MCPServer`. Sibling methods `addFromClaudeDesktop`, `serve`, `testConnection`, `getServerStatus` are explicit stubs (`mcp.ts:161,166,171,186`). `list()` does not populate `scope` or `status` even though the renderer types and UI both rely on them (`MCPServerList.tsx`).
  *Fix:* rename `MCPAddJsonParams.json` → `jsonConfig` (or accept both during transition); have `addJson` honor `scope` (project `.mcp.json` for `local`/`project`, configDir `settings.json` for `user`); wrap the return as `AddServerResult`. Decide on the stubs — implement `addFromClaudeDesktop` (read `~/Library/Application Support/Claude/claude_desktop_config.json`, import each server) or remove the channel from the API. Populate `scope`/`status` in `list()` (status can stay `'unknown'` until process management lands; scope is computable from which file the server was found in).
  *Tests:* `addJson` roundtrip with each scope writing the correct file; `list()` returns `scope`; `ImportResult` shape from `addFromClaudeDesktop`.

### P1/P2 — same-account divergence

- [ ] **6.3 Claude binary resolution is fragmented across subsystems.**
  Same account can launch with different Claude binaries depending on feature. `sessions/lifecycle.ts:49` uses a local hardcoded `findSystemClaudeBinary()` probe. `claude.ts:560` (version check) and `claude.ts:778` (CLI usage) both shell out via `which claude`. `models.ts:21,42` runs its own probe. Only `usage-runner.ts:116` honors the per-account `cli_path` override. A dedicated `claude-binary.ts` service exists with `findBestBinary()` but is not wired into any of these hot paths.
  *Fix:* route every binary lookup through `claude-binary.ts::findBestBinary()`, with per-account `cli_path` taking precedence when an account context is present. Replace the four probe sites; delete `findSystemClaudeBinary()` from `lifecycle.ts` and the `which` fallbacks in `claude.ts`.
  *Tests:* `claude-binary` resolution order pins (account override > system probe > SDK-bundled fallback). Behavioral: same binary used for sessions / version check / CLI usage given the same account.

### P2 — semantic + noise

- [ ] **6.4 Usage cost computation ignores account type.**
  Max-account usage is billed in dashboard totals even though those rows aren't actually cost-bearing. `usage.ts:256` always computes cost from model pricing; `account_type` is carried as metadata only (`usage.ts:260`). Plus the chatty `console.log` block at `usage.ts:480-482,486` writes account names and config dirs to stdout on every `getStatsByAccount` call.
  *Fix:* zero out `cost` for entries where the resolved account is `'max'` (or skip the pricing lookup entirely for those rows). Remove the three `console.log` lines, or route them through the `LoggingService` at `debug` level.
  *Tests:* usage-stats test with mixed max + api accounts asserts max contributions sum to `cost === 0`; api account contributions still compute normally.

### Overall
Top-level architecture is still healthy — main owns privileged work, preload is the IPC boundary, renderer stays in UI land. The drift is concentrated in three places: (1) config-scope correctness (6.1), (2) MCP contract consistency (6.2), (3) "which Claude binary are we actually using?" across features (6.3). 6.1 and 6.2 are real user-visible bugs, not future-debt — start there. 6.3 is a half-landed refactor (the dedicated service exists but isn't called) that gets worse the longer it sits.

---

## jsonl-as-rendered follow-ups (2026-05-27)

### Task 3: installer wait-for-idle gate (option B — always empty)

After Task 3 of the jsonl-as-rendered refactor (`refactor(ipc): drop conversationStatus from session-status payload`), `SessionsService.listInFlightTabIds()` always returns `[]` because main no longer tracks `conversationStatus`.

The installer's `waitForIdle` gate in `electron/services/installer.ts` calls `listInFlightTabIds()`, which is now permanently empty — meaning auto-update will no longer block on an in-flight conversation.

`electron/main.ts` partially addresses this by first checking `tabStatusService.busyTabIds()` (renderer-reported busy count from `tab_status_publish` IPC). If any tab has reported to the renderer, that count is authoritative. The gap is on cold start before any tab has reported — but in that scenario there are no in-flight conversations yet.

**Option A (correct):** wire the gate to ask the renderer for its derived in-flight count via a new `installer_query_in_flight` IPC roundtrip. The renderer answers from its derived `conversationStatus` state.

**Option B (chosen for now):** accept that auto-updates may fire mid-turn. Since OmniFex auto-updates are always user-initiated from the Settings panel, the user understands the consequence. Document this limitation.

If Option A is later implemented, re-add a `listInFlightTabIds` implementation that delegates to the renderer via IPC and remove this TODO.
