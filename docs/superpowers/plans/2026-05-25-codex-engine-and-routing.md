# Phase 3 — Codex Engine + Agent-Aware Routing + Codex Transcript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land OpenAI Codex CLI as a peer agent next to Claude. Per-session agent identity (immutable per tab), agent picker in the new-session dialog, native Codex transcript rendering, in-app Codex login via pty, dedicated `CodexCliEngine` driving `codex mcp` JSON-RPC, and Codex sessions partitioned in the session list. Feature-flagged behind `OMNIFEX_ENABLE_CODEX=1` until manual verification clears.

**Architecture:** Builds on the `AgentEngine` seam from Phase A. New `CodexCliEngine` implements the same interface but talks JSON-RPC 2.0 over stdio to `codex mcp`. Agent identity (`'claude' | 'codex'`) is stored on each tab and session record (the schema columns already exist from Phase A); the renderer branches at the top into `ClaudeTranscript` vs `CodexTranscript`, sharing only the chrome (header, input, status, permission dialog).

**Tech Stack:** Existing subprocess primitive (same one `claude-cli-engine.ts` uses), small JSON-RPC client helper (~80 lines, testable in isolation), `fs.watch` for auth-file watching, existing `OneShotTerminal` patterns. No new third-party deps.

**Spec:** `docs/superpowers/specs/2026-05-25-cli-engine-and-codex-design.md` (phase 3 only).

**Depends on:** Phase A (`2026-05-25-claude-cli-engine-seam.md`) must be shipped and stable. The `AgentEngine` interface, `agent` schema columns, and CLI-only sessions infrastructure are prerequisites.

---

## Non-Goals (out of scope for this plan)

- Codex multi-account UI. v1 uses the user's single `~/.codex/` config. (Future plan, post-v1.)
- Rich settings editor for `~/.codex/config.toml`. v1 ships a read-only TOML preview + "open in editor" button.
- Codex usage analytics surface. v1 displays whatever `task_complete` payloads carry; deeper analytics is post-v1.
- Codex slash-command autocomplete data source. v1 ships a static command list; full integration is post-v1.
- Claude re-auth (Phase 4 — separate plan).

---

## File Structure

**New files:**
- `electron/services/agents/json-rpc-client.ts` — small request/response correlation helper for JSON-RPC over stdio.
- `electron/services/agents/codex-cli-engine.ts` — `createCodexCliEngine()` factory.
- `electron/services/agents/codex-binary.ts` — Codex binary discovery (mirror of `claude-binary.ts`).
- `electron/services/auth/codex-auth.ts` — auth status + login flow.
- `electron/__tests__/agents/json-rpc-client.test.ts`
- `electron/__tests__/agents/codex-cli-engine.test.ts`
- `electron/__tests__/auth/codex-auth.test.ts`
- `electron/services/codex-session-walker.ts` — discover Codex rollouts in `~/.codex/sessions/`.
- `src/components/shared/OneShotTerminal.tsx` — xterm modal for short-lived pty flows (login, etc.).
- `src/components/shared/AgentPicker.tsx` — Claude/Codex radio for new-session dialog.
- `src/components/shared/DiffViewer.tsx` — lifted from existing Claude tool widgets; shared by Claude `edit` tool + Codex `apply_patch` item.
- `src/components/codex/CodexTranscript.tsx` — Codex message rendering shell.
- `src/components/codex/items/AgentMessage.tsx` — Codex `agent_message` item.
- `src/components/codex/items/AgentReasoning.tsx` — collapsible "Thinking…" with reasoning summary.
- `src/components/codex/items/ExecCommand.tsx` — Codex `exec_command` item.
- `src/components/codex/items/ApplyPatch.tsx` — Codex `apply_patch` item (uses shared DiffViewer).
- `src/components/codex/items/WebSearch.tsx` — Codex `web_search` item.
- `src/components/codex/items/McpToolCall.tsx` — Codex `mcp_tool_call` item.
- `src/components/codex/items/CodexItemFallback.tsx` — unknown item type fallback.
- `src/components/claude/ClaudeTranscript.tsx` — Claude transcript shell, lifted from `ClaudeCodeSession.tsx`.
- `src/components/AgentSession.tsx` — replaces `ClaudeCodeSession.tsx` as the per-tab session view.

**Modified files:**
- `electron/services/sessions/lifecycle.ts` — engine factory dispatches on `params.agent`.
- `electron/services/sessions/types.ts` — `SessionStartParams.agent: AgentKind`; `SessionHandle.agent: AgentKind`.
- `electron/services/accounts.ts` (or `electron/services/agent-resolver.ts`) — `resolve()` returns `{ agent, account }`.
- `electron/preload.ts` — add Codex auth + session-list channels to allow-list.
- `electron/ipc/handlers.ts` — handlers for Codex auth, agent-resolve, codex-session-list.
- `electron/main.ts` — construct + wire `CodexAuthService`.
- `src/lib/api.ts` — typed wrappers for new IPC channels; widen `SessionStartParams` types.
- `src/contexts/TabContext.tsx` — `agent: AgentKind` field on tab record; carried through `addTab`.
- `src/components/NewSessionForm.tsx` — agent picker; defaults from path-rule resolver.
- `src/components/SessionHeader.tsx` — agent indicator next to account chip.
- `src/components/AccountSettings.tsx` — Codex auth section.
- `src/components/SessionList.tsx` — per-agent partition + filter dropdown.
- `src/components/TerminalView.tsx` — extract reusable bits into `OneShotTerminal.tsx`.
- `src/components/AgentSession.tsx` (renamed from `ClaudeCodeSession.tsx`) — dispatches transcript by `agent`.
- `CHANGELOG.md`, `package.json` — release.

---

## Task 1: Agent-resolver — `AccountsService.resolve()` returns `{ agent, account }`

**Files:**
- Modify: `electron/services/accounts.ts`
- Modify: `electron/__tests__/accounts.test.ts`

- [ ] **Step 1: Write failing test**

In the accounts tests, add cases:
1. A Claude path rule resolves to `{ agent: 'claude', account: <claude-account> }`.
2. A Codex path rule (rule row with `agent='codex'`) resolves to `{ agent: 'codex', account: null }`.
3. No rule matches → resolver returns `null`.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement**

In `AccountsService.resolve(projectPath)`:
- Query `path_rules` ORDER BY length(path) DESC.
- For each rule (longest-first): if `isPathInside(projectPath, rule.path)`, return `{ agent: rule.agent, account: rule.account_id ? loadAccount(rule.account_id) : null }`.
- No match → return `null`.

Preserve longest-prefix-wins. Preserve normalization. Migrate any caller that expected just `account` to read `.account` off the new shape.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(accounts): resolve() returns { agent, account } for path-rule routing"`

---

## Task 2: Codex binary discovery

**Files:**
- Create: `electron/services/agents/codex-binary.ts`
- Create: `electron/__tests__/agents/codex-binary.test.ts`

- [ ] **Step 1: Failing test**

Test `findSystemCodexBinary()`:
1. Returns the user override when set in settings.
2. Returns the `which codex` result otherwise.
3. Returns `null` when neither is available.

Mirror the structure of `claude-binary.ts` + `claude-binary.test.ts`.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement**

Mirror `claude-binary.ts`. Read the user-configurable override from settings under `codexBinaryPath`; fall back to `which codex` via the project's subprocess primitive.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): codex binary discovery (override + which fallback)"`

---

## Task 3: JSON-RPC client helper

**Files:**
- Create: `electron/services/agents/json-rpc-client.ts`
- Create: `electron/__tests__/agents/json-rpc-client.test.ts`

- [ ] **Step 1: Failing tests**

The `JsonRpcClient` wraps a duplex stream (stdin/stdout pair). Test:
1. **request() correlates response by id.** Construct client over a mock duplex. Call `client.request('foo', { x: 1 })`. Assert one line written to the writable side: `{ jsonrpc: '2.0', id: 1, method: 'foo', params: { x: 1 } }`. Push `{ jsonrpc: '2.0', id: 1, result: { ok: true } }` onto the readable side; assert the request's promise resolves with `{ ok: true }`.
2. **request() rejects on error response.** Push `{ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'Invalid' } }`. Promise rejects with an Error containing `Invalid`.
3. **Concurrent requests resolve to right promises.** Issue request A (id 1) and request B (id 2). Push response B first, then A. A resolves with A's result, B with B's.
4. **Notifications (no id) call onNotification.** Push `{ jsonrpc: '2.0', method: 'task_started', params: { conversationId: 'c1' } }`. Assert the registered notification handler received `('task_started', { conversationId: 'c1' })`.
5. **Server-initiated requests call onServerRequest.** Push `{ jsonrpc: '2.0', id: 'srv-1', method: 'applyPatchApproval', params: { ... } }`. Assert the registered server-request handler was called with `('applyPatchApproval', params, 'srv-1')`. After the handler calls `client.respondToServer('srv-1', { decision: 'allow' })`, assert a line is written matching `{ jsonrpc: '2.0', id: 'srv-1', result: { decision: 'allow' } }`.
6. **Handles split JSON across chunk boundaries** (same NDJSON line buffering as the Claude engine).

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement**

`createJsonRpcClient({ readable, writable, onNotification, onServerRequest })` returns `{ request(method, params): Promise, respondToServer(id, result | { error }): void, close(): void }`.

- Closure state: `pendingByClientId: Map<number, { resolve, reject }>`, `nextClientId: number = 1`, `lineBuf: string`.
- Wire `readable.on('data', ...)` with line-buffered NDJSON parse. For each parsed object:
  - Has `result` or `error` AND numeric `id` → resolve/reject `pendingByClientId.get(id)` and delete the entry.
  - Has `method` and `id` → server request; call `onServerRequest(method, params, id)`.
  - Has `method` no `id` → notification; call `onNotification(method, params)`.
- `request(method, params)` allocates `id = nextClientId++`, stores `{ resolve, reject }`, writes `{ jsonrpc: '2.0', id, method, params }` + `\n` to writable, returns the promise.
- `respondToServer(id, payload)` writes `{ jsonrpc: '2.0', id, ...payload }` + `\n`. `payload` is either `{ result }` or `{ error: { code, message } }`.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): JSON-RPC over stdio client helper with id correlation"`

---

## Task 4: `createCodexCliEngine` — spawn + newConversation (TDD)

**Files:**
- Create: `electron/__tests__/agents/codex-cli-engine.test.ts`
- Create: `electron/services/agents/codex-cli-engine.ts`

- [ ] **Step 1: Failing test**

Mock the subprocess primitive + `findSystemCodexBinary` returning `/usr/local/bin/codex`.

Test `start() spawns "codex mcp" and issues newConversation`:
- After `start({ projectPath: '/p', configDir: '/c', model: 'gpt-5', codex: { sandboxPolicy: 'workspace-write', reasoningEffort: 'medium' } })`:
- Assert subprocess was spawned with binary `/usr/local/bin/codex`, args `['mcp']`, `cwd: '/p'`.
- Assert one JSON-RPC line written to fake stdin matching `{ jsonrpc: '2.0', id: <n>, method: 'newConversation', params: object containing model + sandboxPolicy + reasoningEffort }`.
- Push back `{ jsonrpc: '2.0', id: <same n>, result: { conversationId: 'conv-1' } }`. Assert `engine.getResumeId()` becomes `'conv-1'`.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Minimal implementation**

`createCodexCliEngine({ tabId })` returning `AgentEngine`:

- Closure state: `child`, `client` (JsonRpcClient), `conversationId: string | null = null`.
- `start(p)`:
  - Resolve binary; throw if null.
  - Spawn `[bin, ['mcp']]` with `cwd: p.projectPath`, default env (no `CODEX_HOME` in v1).
  - Construct `client = createJsonRpcClient({ readable: child.stdout, writable: child.stdin, onNotification, onServerRequest })` (next tasks).
  - If `p.resumeSessionId`: `result = await client.request('resumeConversation', { conversationId: p.resumeSessionId, ... })`; set `conversationId = result.conversationId ?? p.resumeSessionId`.
  - Else: `result = await client.request('newConversation', { model: p.model, ...p.codex })`; set `conversationId = result.conversationId`.

Stub `onNotification`/`onServerRequest` as no-ops for this task.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): CodexCliEngine spawn + newConversation handshake"`

---

## Task 5: `send()` — sendUserTurn JSON-RPC

**Files:**
- Modify: `electron/__tests__/agents/codex-cli-engine.test.ts`
- Modify: `electron/services/agents/codex-cli-engine.ts`

- [ ] **Step 1: Failing test**

After successful `start()`, call `engine.send('hello')`. Assert one JSON-RPC line written: `{ method: 'sendUserTurn', params: { conversationId: 'conv-1', input: 'hello' } }`. Push back a success result; assert promise resolves.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement**

`async send(text)`: `await client.request('sendUserTurn', { conversationId, input: text })`. Throw if `conversationId` is null.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): CodexCliEngine.send via sendUserTurn"`

---

## Task 6: Approval round-trip — `applyPatchApproval` + `execCommandApproval`

**Files:**
- Modify: `electron/__tests__/agents/codex-cli-engine.test.ts`
- Modify: `electron/services/agents/codex-cli-engine.ts`

- [ ] **Step 1: Failing tests**

1. **applyPatchApproval is surfaced as onPermissionRequest with kind='patch'.** Push a JSON-RPC server-initiated request: `{ id: 'srv-p1', method: 'applyPatchApproval', params: { conversationId: 'conv-1', callId: 'c1', fileChanges: {...}, reason: 'edit' } }`. Assert the `onPermissionRequest` callback received: `agent: 'codex'`, `kind: 'patch'`, `requestId: 'srv-p1'`, summary mentions `'patch'`, payload preserves the raw params.
2. **execCommandApproval → kind='exec'.** Same shape, `method: 'execCommandApproval'`, params include `command` and `cwd`. Assert `kind: 'exec'`, summary includes the command.
3. **respondPermission ships a JSON-RPC response on right id.** Call `respondPermission('srv-p1', 'allow')`. Assert one write captured: `{ id: 'srv-p1', result: { decision: 'allow' } }`.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement**

- Add `const permissionCallbacks: Array<(r: AgentPermissionRequest) => void> = [];`.
- `onServerRequest(method, params, id)` (passed to JsonRpcClient):
  - If method is `applyPatchApproval`: build request with `kind: 'patch'`, `summary: 'Apply patch'`; iterate callbacks.
  - If method is `execCommandApproval`: build with `kind: 'exec'`, `summary: \`Run: ${params.command}\``; iterate.
  - Other methods: server may add more later — log and respond `{ error: { code: -32601, message: 'Method not handled' } }`.
- `respondPermission(requestId, decision, payload?)`: `client.respondToServer(requestId, { result: { decision, ...(payload as object ?? {}) } })`.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): CodexCliEngine approval round-trip for patch + exec"`

---

## Task 7: Notification surface — `agent_message`, `agent_reasoning`, `item.*`, `task_*`

**Files:**
- Modify: `electron/__tests__/agents/codex-cli-engine.test.ts`
- Modify: `electron/services/agents/codex-cli-engine.ts`

- [ ] **Step 1: Failing tests**

After `start()`, register `onMessage`. Push notifications:
1. `{ method: 'task_started', params: { conversationId: 'conv-1' } }` → onMessage fires with `agent: 'codex'`, `payload.method === 'task_started'`.
2. `{ method: 'agent_message', params: { content: 'hi' } }` → onMessage fires; payload preserved.
3. `{ method: 'agent_reasoning', params: { summary: 'thinking…' } }` → fires.
4. `{ method: 'item.exec_command', params: { command: 'ls', stdout: '...' } }` → fires.
5. `{ method: 'task_complete', params: { conversationId: 'conv-1' } }` → fires.

Assert all five emit with `agent: 'codex'`, `tabId`, `receivedAt`, `sessionId === 'conv-1'`, `payload` preserving `method` + `params`.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement**

- Add `const messageCallbacks: Array<(m: AgentMessage) => void> = [];`.
- `onNotification(method, params)`: build `AgentMessage` with `agent: 'codex'`, `tabId: params.tabId` (closure capture), `receivedAt: new Date().toISOString()`, `sessionId: conversationId`, `payload: { method, params }`. Iterate `messageCallbacks` (try/catch).
- Replace `onMessage` factory method to push/splice on `messageCallbacks`.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): CodexCliEngine surfaces notifications as AgentMessage"`

---

## Task 8: `interrupt()` — `interruptConversation` (TDD)

- [ ] **Step 1: Failing test**

After `start()`, `await engine.interrupt()`. Assert one JSON-RPC line written: `{ method: 'interruptConversation', params: { conversationId } }`.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement**

`async interrupt()`: if `!conversationId` return. `await client.request('interruptConversation', { conversationId })`.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): CodexCliEngine.interrupt via interruptConversation"`

---

## Task 9: `close()`, `kill()`, `onExit`, `onError` (TDD)

Mirror Task 8 of the Phase A plan. Lifecycle parallels Claude:
- `close()`: SIGTERM the subprocess, null the handle.
- `kill()`: SIGKILL.
- `onExit`/`onError`: subscribe with the same push/splice pattern; exit emits when subprocess exits, error emits stderr lines as `Error` objects.

- [ ] **Step 1: Three failing tests** (onExit/onError/idempotent close — same shape as Phase A Task 8).

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement** following the Claude engine pattern. Wire `wireStderr(child.stderr)` and `child.on('exit', ...)`.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): CodexCliEngine lifecycle — onExit/onError + idempotent close"`

---

## Task 10: Engine factory dispatch by `params.agent`

**Files:**
- Modify: `electron/services/sessions/types.ts`
- Modify: `electron/services/sessions/lifecycle.ts`
- Modify: `electron/__tests__/sessions.test.ts`

- [ ] **Step 1: Add `agent` to start params + handle**

In `electron/services/sessions/types.ts`:
- `SessionStartParams.agent: AgentKind;` (default `'claude'` if missing for back-compat).
- `SessionHandle.agent: AgentKind;`.

- [ ] **Step 2: Failing test**

`start({ agent: 'codex', ... })` calls `createCodexCliEngine`; `start({ agent: 'claude', ... })` calls `createClaudeCliEngine`. Spy on both factories.

- [ ] **Step 3: Verify RED**

- [ ] **Step 4: Dispatch**

In `lifecycle.ts` `start()`:

```
const agent: AgentKind = params.agent ?? 'claude';
const engine = agent === 'codex'
  ? createCodexCliEngine({ tabId })
  : createClaudeCliEngine({ tabId });
await engine.start({
  projectPath, configDir, model, permissionMode, resumeSessionId,
  ...(agent === 'codex' ? { codex: params.codex } : {}),
});
handle.agent = agent;
handle.engine = engine;
```

For Codex, `configDir` flow is `~/.codex/` — but per Q4 v1 we don't override `CODEX_HOME`, so `configDir` is unused by the engine. Track it on the handle anyway for forward-compat (when Codex multi-account lands).

- [ ] **Step 5: Verify GREEN + Commit**

`git commit -m "feat(sessions): dispatch engine factory on params.agent"`

---

## Task 11: TabContext + new-session flow carry `agent`

**Files:**
- Modify: `src/contexts/TabContext.tsx`
- Modify: `src/contexts/__tests__/TabContext.test.tsx`
- Modify: `src/components/NewSessionForm.tsx`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add `agent: AgentKind` to tab record**

Extend the `Tab` type with `agent: 'claude' | 'codex'`. Default to `'claude'` for back-compat when restoring tabs from before this release (the SQL agent column defaulting also handles this).

- [ ] **Step 2: Failing test**

`addTab({ ..., agent: 'codex' })` stores the agent on the resulting tab; resolved-agent overrides default.

- [ ] **Step 3: Implement**

Thread `agent` through `addTab`, `restoreTab`, persistence. When TabContext-level routing resolves a path → agent, pass it into `addTab`.

- [ ] **Step 4: api.ts widening**

`startSession(...)` gains `agent?: AgentKind`. Default `'claude'`.

- [ ] **Step 5: Verify GREEN + Commit**

`git commit -m "feat(tabs): agent identity on tab records, threaded through addTab + restore"`

---

## Task 12: Agent picker in new-session dialog

**Files:**
- Create: `src/components/shared/AgentPicker.tsx`
- Modify: `src/components/NewSessionForm.tsx`

- [ ] **Step 1: Component**

`AgentPicker` is a two-option radio: "Claude" / "Codex". Props: `value: AgentKind`, `onChange: (agent: AgentKind) => void`, `disabled?: boolean`. Render with the existing form-control styles.

- [ ] **Step 2: Wire into the form**

In `NewSessionForm`:
- Add state `const [agent, setAgent] = useState<AgentKind>(initialAgent ?? 'claude');`.
- Render `<AgentPicker value={agent} onChange={setAgent} />` near the top.
- When the resolver returns `{ agent }` from path-rule resolution, prefill the state.
- Hide the Claude account selector when `agent === 'codex'`; show a "Codex" inline indicator instead.
- Pass `agent` into `startSession()` call on submit.

- [ ] **Step 3: Tests**

Update `NewSessionForm.test.tsx` to cover both agents.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(ui): agent picker in new-session form, defaults from path-rule resolver"`

---

## Task 13: OneShotTerminal — shared pty + xterm modal

**Files:**
- Create: `src/components/shared/OneShotTerminal.tsx`
- Modify: `src/components/TerminalView.tsx` (extract reusable bits)

- [ ] **Step 1: Component**

`OneShotTerminal` takes:
- `binary: string`, `args: string[]`, `env: Record<string, string>`, `cwd?: string`
- `watchPath?: string` — fs.watch this; emit `onWatchFire(path)` when it changes.
- `onExit(info: { code: number; signal?: string })` — fires when the spawned subprocess exits.
- `onCancel()` — cancels the run.

Internally: hosts an xterm.js instance (reuse the same wiring `TerminalView.tsx` uses), spawns the subprocess via a new main-process IPC channel, streams stdout to xterm, returns user keystrokes to stdin.

If `watchPath` is set, register an `fs.watch` on it (or fall back to chokidar if `fs.watch` proves flaky). Fire `onWatchFire` debounced ~250ms.

Cleanup on unmount: kill subprocess + close watcher.

- [ ] **Step 2: IPC plumbing**

New channels:
- `one_shot_terminal_spawn` → `{ ptyHandle: string }`
- `one_shot_terminal_write` → write bytes to stdin
- `one_shot_terminal_kill`
- Events: `one-shot-terminal-data:<handle>`, `one-shot-terminal-exit:<handle>`

Implement as a thin wrapper around the existing `tui.ts` pty pattern.

- [ ] **Step 3: Test**

Component test: mount with a fake spawn (e.g., `echo hello; exit 0`), assert "hello" appears in the xterm, assert `onExit` fires.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(ui): OneShotTerminal shared pty+xterm modal for one-shot CLI flows"`

---

## Task 14: CodexAuthService — status + login flow

**Files:**
- Create: `electron/services/auth/codex-auth.ts`
- Create: `electron/__tests__/auth/codex-auth.test.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/main.ts`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Service shape**

`createCodexAuthService()` exposes:
- `getStatus(): Promise<{ authenticated: boolean; email?: string; mode?: 'oauth' | 'apikey' }>` — reads `~/.codex/auth.json`; detects API-key mode via `OPENAI_API_KEY` env.
- `watch(cb: (status) => void): Disposable` — `fs.watch` on the auth file with debounce.
- `startLoginFlow(): Promise<{ ptyHandle: string }>` — spawns `codex login` via the OneShotTerminal IPC primitive; returns the handle.
- `cancelLoginFlow(handle: string): void`.

- [ ] **Step 2: Tests**

Mock `fs.readFile` and `fs.watch`. Cases:
- Returns `authenticated: false` when file missing.
- Returns `authenticated: true, email: 'x@y'` when file has expected shape.
- Returns `mode: 'apikey'` when env has `OPENAI_API_KEY` and file missing.
- `watch()` callback fires when the watched file changes.

- [ ] **Step 3: IPC channels**

Add to preload allow-list:
- `codex_auth_status`, `codex_auth_start_login`, `codex_auth_cancel_login`
- Event: `codex-auth-status-changed`

Handlers + main wiring identical to existing service patterns.

`api.ts` typed wrappers.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(auth): CodexAuthService — status + pty login flow"`

---

## Task 15: Codex sign-in modal + AccountSettings integration

**Files:**
- Create: `src/components/codex/CodexSignInModal.tsx`
- Modify: `src/components/AccountSettings.tsx`

- [ ] **Step 1: Modal**

`CodexSignInModal` shows the current auth status. If unauthenticated, renders an inline "Sign in to Codex" button. Clicking opens the OneShotTerminal modal with: `binary: codex`, `args: ['login']`, `watchPath: ~/.codex/auth.json`. The `onWatchFire` re-runs `getStatus`; if `authenticated: true`, auto-closes the modal.

- [ ] **Step 2: AccountSettings**

Below the existing Claude accounts list, add a "Codex" section: current status (email + "OAuth" / "API key" / "Not authenticated"), "Sign in" / "Sign out" button. Sign-out spawns `codex logout` via a one-shot subprocess (no terminal needed; it's instant).

- [ ] **Step 3: New-session dialog hook**

When `agent === 'codex'` is selected and status is unauthenticated, show a banner above the form's submit button: "You need to sign in to Codex" + inline "Sign in" button. Disable submit until authenticated.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(ui): Codex sign-in modal + AccountSettings integration"`

---

## Task 16: Codex session-list partition

**Files:**
- Create: `electron/services/codex-session-walker.ts`
- Create: `electron/__tests__/codex-session-walker.test.ts`
- Modify: `src/components/SessionList.tsx`
- Modify: IPC + api.ts for the new walker channel

- [ ] **Step 1: Walker**

`listCodexSessions()` walks `~/.codex/sessions/*.jsonl`, reads each file's first message (or last, depending on the format) to extract: conversationId, project path (if recorded), last activity time. Returns sorted by recency.

- [ ] **Step 2: Tests**

Set up a tmpdir with fixture rollouts. Assert the walker returns the expected list.

- [ ] **Step 3: SessionList UI**

The list grows:
- A per-agent badge column (Claude logo / OpenAI logo).
- A filter dropdown: "All / Claude / Codex".

When the user clicks a Codex row, `addTab({ agent: 'codex', projectPath, resumeSessionId: conversationId })`.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(ui): Codex session-list partition with per-agent badge + filter"`

---

## Task 17: Renderer transcript split — `AgentSession` shell + `ClaudeTranscript` extraction

**Files:**
- Rename: `src/components/ClaudeCodeSession.tsx` → `src/components/AgentSession.tsx`
- Create: `src/components/claude/ClaudeTranscript.tsx`
- Modify: `src/components/TabContent.tsx`

- [ ] **Step 1: Extract Claude transcript body**

Move the existing Claude transcript rendering (everything that consumes Claude messages and renders tool widgets) out of `ClaudeCodeSession.tsx` into a new `src/components/claude/ClaudeTranscript.tsx`. Props: `messages: ClaudeMessage[]`, plus whatever callbacks the body currently consumes.

Behavior must be byte-for-byte identical. No new tests beyond the existing transcript tests.

- [ ] **Step 2: Rename + thin out the shell**

Rename `ClaudeCodeSession.tsx` → `AgentSession.tsx`. The shell now owns: header, composer, status bar, permission dialog, log tab. The transcript area renders `<ClaudeTranscript messages={...} />` for Claude sessions.

Update `TabContent.tsx` to mount `AgentSession` instead of `ClaudeCodeSession`.

- [ ] **Step 3: Verify**

`npm run check && npm test && npm run build`. All existing renderer tests still pass.

- [ ] **Step 4: Commit**

`git commit -m "refactor(ui): extract ClaudeTranscript; rename ClaudeCodeSession -> AgentSession"`

---

## Task 18: Move Claude tool widgets under `src/components/claude/tools/`

**Files:**
- Move many: existing tool widgets (CommandWidget, EditWidget, TodoWriteWidget, TaskList, etc.)

- [ ] **Step 1: Inventory**

`git grep -l 'export.*Widget\|export.*TaskList' src/components/` to list current widget files.

- [ ] **Step 2: Move**

`git mv` each into `src/components/claude/tools/`. Update import paths everywhere they're consumed.

- [ ] **Step 3: Lift diff viewer to shared**

If `EditWidget` or similar contains a reusable diff component, extract it to `src/components/shared/DiffViewer.tsx`. Update Claude EditWidget to import from shared. This sets up Codex `apply_patch` to reuse it in Task 21.

- [ ] **Step 4: Verify + Commit**

`git commit -m "refactor(ui): move Claude tool widgets under src/components/claude/tools/"`

---

## Task 19: CodexTranscript shell

**Files:**
- Create: `src/components/codex/CodexTranscript.tsx`
- Modify: `src/components/AgentSession.tsx`

- [ ] **Step 1: Skeleton**

`CodexTranscript({ messages: AgentMessage[] })`:
- Maps each message to a per-item component via a lookup table on `payload.method`:
  - `agent_message` → `<AgentMessageItem />` (next task)
  - `agent_reasoning` → `<AgentReasoningItem />`
  - `item.exec_command` → `<ExecCommandItem />`
  - `item.apply_patch` → `<ApplyPatchItem />`
  - `item.web_search` → `<WebSearchItem />`
  - `item.mcp_tool_call` → `<McpToolCallItem />`
  - Anything else → `<CodexItemFallback />`
- `task_started` / `task_complete` not rendered as cards (they drive status bar, not content).

- [ ] **Step 2: Wire into AgentSession**

```
{tab.agent === 'claude'
  ? <ClaudeTranscript messages={messages} ... />
  : <CodexTranscript messages={messages} ... />}
```

For now stub each item component as `<div>codex: {method}</div>`. Real renderers come in the next tasks.

- [ ] **Step 3: Verify + Commit**

`git commit -m "feat(ui): CodexTranscript shell with per-item dispatch"`

---

## Task 20: Codex item widgets — `agent_message` + `agent_reasoning`

**Files:**
- Create: `src/components/codex/items/AgentMessage.tsx`
- Create: `src/components/codex/items/AgentReasoning.tsx`

- [ ] **Step 1: AgentMessage**

Render the message text using the existing markdown/streaming-text component (from `shared/`). Use the shared message-card chrome (avatar = OpenAI / role tag = "Assistant").

- [ ] **Step 2: AgentReasoning**

A collapsible block similar to Claude's thinking-block component. Collapsed by default, shows the reasoning summary. Expanded shows full reasoning content if present.

- [ ] **Step 3: Tests**

Component tests for both: mount with a fixture payload, assert the right text renders. Toggle the reasoning block, assert open/close.

- [ ] **Step 4: Commit**

`git commit -m "feat(codex): agent_message + agent_reasoning item widgets"`

---

## Task 21: Codex item widgets — `exec_command` + `apply_patch` + `web_search` + `mcp_tool_call`

**Files:**
- Create: `src/components/codex/items/ExecCommand.tsx`
- Create: `src/components/codex/items/ApplyPatch.tsx`
- Create: `src/components/codex/items/WebSearch.tsx`
- Create: `src/components/codex/items/McpToolCall.tsx`
- Create: `src/components/codex/items/CodexItemFallback.tsx`

- [ ] **Step 1: ExecCommand**

Render `command` (monospace, copyable), `cwd`, `stdout` (collapsible if long), `stderr` (collapsible). Status indicator: running / completed / failed.

- [ ] **Step 2: ApplyPatch**

Render the file change set using `shared/DiffViewer`. Header summarizes "N files changed". Each file collapsible.

- [ ] **Step 3: WebSearch**

Render query string + result list (titles + URLs). Click opens in default browser.

- [ ] **Step 4: McpToolCall**

Render server name + tool name + input (collapsed JSON) + output (collapsed if long).

- [ ] **Step 5: CodexItemFallback**

Unknown method → render a generic card with method name + raw JSON payload (collapsed). Logs a warning so we notice missing item types.

- [ ] **Step 6: Tests**

One test per component with a fixture payload.

- [ ] **Step 7: Commit**

`git commit -m "feat(codex): item widgets — exec, patch, web_search, mcp_tool_call, fallback"`

---

## Task 22: Permission dialog branches on `kind` + `agent`

**Files:**
- Modify: `src/components/PermissionDialog.tsx` (or wherever the existing dialog lives)

- [ ] **Step 1: Add Codex-shaped previews**

The dialog already handles `kind: 'tool'` (Claude). Add:
- `kind: 'patch'` (Codex) → render `DiffViewer` over `payload.fileChanges`.
- `kind: 'exec'` (Codex) → render shell preview (command + cwd, monospace).

The "Allow" / "Deny" buttons remain unchanged in behavior; the agent's `respondPermission` knows how to ship the decision.

- [ ] **Step 2: Test**

Render each kind × agent combo with fixture data; assert correct preview component mounts.

- [ ] **Step 3: Commit**

`git commit -m "feat(ui): permission dialog renders Codex patch + exec previews"`

---

## Task 23: SessionHeader agent indicator

**Files:**
- Modify: `src/components/SessionHeader.tsx`

- [ ] **Step 1: Add the indicator**

Next to the existing account chip, render a small badge: Claude logo or "C" for Claude tabs; OpenAI logo or "O" for Codex tabs. Hover tooltip says "Claude" / "Codex".

Click on the indicator opens the same account-picker dialog (since agent + account are paired). Gated by "tab has no in-flight conversation" (`conversationStatus === 'idle'` or `null`).

- [ ] **Step 2: Test**

Render with both agents; assert correct icon mounts; click triggers the dialog.

- [ ] **Step 3: Commit**

`git commit -m "feat(ui): SessionHeader shows agent indicator next to account chip"`

---

## Task 24: Event channel rename — `claude-output:` → `agent-output:` (with compat shim)

**Files:**
- Modify: `electron/preload.ts`
- Modify: `electron/services/sessions/runtime.ts` (and any other emitter)
- Modify: every renderer consumer

- [ ] **Step 1: Rename emitter channel names**

Search `git grep -n "'claude-output:'" electron/`. Replace with `'agent-output:'`. Same for `claude-error:` → `agent-error:`, `claude-complete:` → `agent-complete:`.

- [ ] **Step 2: Preload compat shim**

In `preload.ts` event allow-list: add `agent-output:`, `agent-error:`, `agent-complete:` prefixes. Keep `claude-output:` etc. in the allow-list for one release.

Also add a tiny shim: when a renderer subscribes to `claude-output:<tabId>`, automatically also subscribe to `agent-output:<tabId>`. Log a deprecation warning. Drop in the next release.

- [ ] **Step 3: Renderer updates**

Search `git grep -n "claude-output:\|claude-error:\|claude-complete:" src/`. Replace with the new channel names.

- [ ] **Step 4: Verify**

`npm run check && npm test`. Manual smoke: a Claude session still receives messages on the renamed channels.

- [ ] **Step 5: Commit**

`git commit -am "refactor(ipc): rename claude-output/error/complete channels to agent-* (with compat shim)"`

---

## Task 25: Feature-flag Codex behind `OMNIFEX_ENABLE_CODEX=1`

**Files:**
- Modify: `electron/main.ts`
- Modify: `src/components/NewSessionForm.tsx`
- Modify: `src/components/AccountSettings.tsx`

- [ ] **Step 1: Detect flag**

In main, read `process.env.OMNIFEX_ENABLE_CODEX === '1'` once at startup. Expose to renderer via a new `app_capabilities` IPC channel returning `{ codexEnabled: boolean }`.

- [ ] **Step 2: Gate UI**

If `codexEnabled === false`:
- Hide the AgentPicker in NewSessionForm (force `agent === 'claude'`).
- Hide the Codex section in AccountSettings.
- The Codex session-list partition is hidden / empty.

If `codexEnabled === true`: everything visible.

- [ ] **Step 3: Tests**

Render NewSessionForm with both flag states; assert picker visibility.

- [ ] **Step 4: Commit**

`git commit -am "feat(codex): gate Codex UI behind OMNIFEX_ENABLE_CODEX=1"`

---

## Task 26: Verification gate

**Files:** none — runs commands.

- [ ] **Step 1: Full typecheck + build + tests + coverage**

`npm run check && npm run build && npm run test:coverage` → all green. New `electron/services/agents/codex-cli-engine.ts`, `json-rpc-client.ts`, `codex-binary.ts`, `auth/codex-auth.ts` all ≥80% line coverage.

- [ ] **Step 2: Manual smoke — Claude path (regression)**

Same checklist as Phase A's Task 17. Confirms Codex code paths haven't broken Claude.

- [ ] **Step 3: Manual smoke — Codex path**

`OMNIFEX_ENABLE_CODEX=1 npm start 2>&1 | tee /tmp/omnifex-codex.log`

Checklist:
1. Open AccountSettings → Codex section. Click "Sign in to Codex". Complete the OAuth dance in the modal. Modal auto-closes; status shows email.
2. Start a new session; agent picker shows; select Codex.
3. Send a message; confirm streaming + that `agent_message` + `agent_reasoning` render distinctly.
4. Trigger a file edit; permission dialog opens with the patch preview. Test allow + deny.
5. Trigger a shell command; permission dialog opens with the exec preview. Test allow + deny.
6. Toggle Chat → Terminal → back. Confirm `codex` TUI renders inside xterm; conversation memory persists on return.
7. Kill the session, reopen via session list (filter Codex); confirm resume works.
8. Check `/tmp/omnifex-codex.log` for unexpected errors.

- [ ] **Step 4: Rebuild Electron ABI**

`npm run rebuild:electron`.

- [ ] **Step 5: No commit** — verification only.

---

## Task 27: CHANGELOG + version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Bump version**

Patch bump.

- [ ] **Step 2: Add CHANGELOG entry**

```
## [<new-version>] — YYYY-MM-DD

### Added

- **OpenAI Codex CLI as a peer agent** (`<commit>`). Sessions can now be started against either Claude or Codex; pick at session start. Codex runs via `codex mcp` JSON-RPC over stdio, with full approval round-trip (patch + exec), session resume, and rich item rendering (`agent_message`, `agent_reasoning`, `exec_command`, `apply_patch`, `web_search`, `mcp_tool_call`). Codex sessions appear in the session list filtered by agent. Single-account in v1 (`~/.codex/`).
- **In-app Codex sign-in** (`<commit>`). Click "Sign in to Codex" in AccountSettings to drop into a modal that runs `codex login` inside an embedded xterm; closes automatically when the OAuth dance completes. API-key mode (via `OPENAI_API_KEY`) is detected and displayed without a sign-in flow.
- **Agent identity per tab** (`<commit>`). Path rules now resolve to `{ agent, account }`; the new-session dialog includes an agent picker. Agent is immutable per tab.
- **Codex behind feature flag.** Launch with `OMNIFEX_ENABLE_CODEX=1` to see Codex UI. Will be flipped default-on once manual verification stabilizes.

### Changed

- **`ClaudeCodeSession.tsx` → `AgentSession.tsx`** (`<commit>`). The session view is now agent-aware: shared chrome (header, composer, status, permission dialog) wraps agent-specific transcripts (`ClaudeTranscript` / `CodexTranscript`).
- **Claude tool widgets relocated** to `src/components/claude/tools/`. Diff viewer lifted to `src/components/shared/DiffViewer.tsx` so Codex `apply_patch` items reuse it.
- **Event channels renamed** `claude-output: / claude-error: / claude-complete:` → `agent-output: / agent-error: / agent-complete:`. Old channels remain in the preload allow-list with a deprecation shim for one release.

### Notes

- Phase 3 of the SDK→CLI engine + Codex support plan. See `docs/superpowers/specs/2026-05-25-cli-engine-and-codex-design.md`. Phase 4 (Claude re-auth recovery) follows in a separate release.
- TUI mode (Chat ↔ Terminal toggle) works for both agents. Codex's TUI is `codex` invoked directly; Codex resume is `codex resume <conversationId>`.
```

Replace `<commit>` with short SHAs.

- [ ] **Step 3: Commit + release**

`git commit -am "chore: bump version to <new-version>"`

Run `/omnifex-release`.

---

## Self-review

- **Spec coverage:** Codex engine (spec §4), agent routing (spec §2), renderer split (spec §5), Codex auth (spec §7), session list + persistence (spec §6) — all covered.
- **AgentEngine compliance:** `CodexCliEngine` implements every interface method; Tasks 4–9 each test one.
- **Permission UX:** Task 22 ensures the shared dialog renders Codex shapes natively.
- **TUI mode:** unchanged behavior; Task 26 manual smoke includes the Codex TUI round-trip.
- **Feature flag:** Task 25 gates everything Codex-specific; users without the flag see no Codex UI.
- **Renderer reuse:** Task 17 extracts Claude transcript behavior-preserving; no regressions.
- **Event-channel rename:** Task 24 includes a compat shim so cross-cutting consumers don't break in a single deploy.

---

## Follow-up

- **Phase 4 — Claude re-auth recovery** (`2026-05-25-claude-reauth-recovery.md`).
- Post-v1 polish: Codex multi-account, rich Codex settings editor, Codex usage analytics.

---

**End of plan.**
