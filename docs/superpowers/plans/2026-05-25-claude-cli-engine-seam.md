# Phase 1 — Claude CLI Engine Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the SDK runtime for Claude sessions with a CLI-backed subprocess (`claude --output-format stream-json --input-format stream-json`), hidden behind a new `AgentEngine` interface, without touching the renderer or removing the SDK dependency yet. Keep the old SDK path as an opt-in fallback (`OMNIFEX_USE_SDK=1`) for one release of A/B safety.

**Architecture:** A new `electron/services/agents/` module defines an `AgentEngine` interface and the first concrete implementation, `ClaudeCliEngine`. Sessions service grows an `engine: AgentEngine | null` field on the handle; the live message loop in `runtime.ts` drives the engine instead of the SDK's `Query` iterator. The Claude-side stream-json output is byte-for-byte the same JSON the SDK was yielding, so the renderer is unchanged.

**Tech Stack:** Node's child-process subprocess (use the project's existing safe spawn pattern — `execFileNoThrow` where appropriate, otherwise the same subprocess primitives `tui.ts` already uses), NDJSON line-buffered parsing, existing `better-sqlite3` migration pattern, existing `claude-binary.ts` discovery chain.

**Spec:** `docs/superpowers/specs/2026-05-25-cli-engine-and-codex-design.md` (phase 1 only).

---

## Non-Goals (out of scope for this plan)

- Removing the `@anthropic-ai/claude-agent-sdk` dependency. (Phase 2.)
- Codex engine, agent picker UI, Codex transcript. (Phase 3.)
- Claude re-auth affordance. (Phase 4.)
- Touching the renderer transcript or any of `src/components/`. The renderer still consumes the same Claude message shape it does today.
- TUI mode internals. The `mode: 'rich' | 'tui'` rename is in scope; everything inside `tui.ts` is not.

---

## File Structure

**New files:**
- `electron/services/agents/types.ts` — `AgentKind`, `AgentEngine`, `AgentMessage`, `AgentPermissionRequest`, `AgentStartParams`.
- `electron/services/agents/claude-cli-engine.ts` — `createClaudeCliEngine()` factory.
- `electron/__tests__/agents/claude-cli-engine.test.ts` — unit tests using a mocked subprocess.

**Modified files:**
- `electron/services/sessions/types.ts` — add `engine` to `SessionHandle`; widen `SessionMode` to `'rich' | 'tui'` (rename from `'sdk' | 'tui'`).
- `electron/services/sessions/lifecycle.ts` — engine-selection seam in `start()`; honor `OMNIFEX_USE_SDK=1`; populate `handle.engine` when CLI engine is selected.
- `electron/services/sessions/runtime.ts` — drive `handle.engine` when present, fall back to `handle.query` (SDK) when not.
- `electron/services/sessions/summary-query.ts` — rewrite as one-shot CLI invocation; remove SDK dependency.
- `electron/services/database.ts` — add migration for `agent` column on `sessions` + `path_rules`.
- `electron/__tests__/sessions.test.ts` — keep existing `installFakeQuery` for the SDK path; add tests exercising the CLI-engine seam.
- `src/lib/api.ts` — update `SessionMode` literal union.
- `src/components/ClaudeCodeSession.tsx` — update mode comparisons from `'sdk'` to `'rich'`.
- `src/components/NewSessionForm.tsx` — update default mode.
- `src/hooks/useSessionLifecycle.ts` — update mode references.
- `electron/services/sessions/hooks.ts` — **deleted** (CLI invokes user-defined hooks itself; OmniFex's own internal hook-shaped concerns move into engine subscribers).
- `package.json` — version bump for release.
- `CHANGELOG.md` — phase 1 entry.

---

## Task 1: Schema migration — `agent` column on `sessions` + `path_rules`

**Files:**
- Modify: `electron/services/database.ts` (migrations block)
- Modify: `electron/__tests__/database.test.ts`

- [ ] **Step 1: Write the failing test**

In `electron/__tests__/database.test.ts`, near the other migration tests, append a test that:
1. Creates an in-memory DB via `createDatabase(':memory:')`.
2. Asserts both `sessions` and `path_rules` have an `agent` column (via `PRAGMA table_info`).
3. Inserts a row into `sessions` without specifying `agent`, then selects it back and asserts `agent === 'claude'`.

- [ ] **Step 2: Verify RED**

Run: `npm test -- electron/__tests__/database.test.ts -t "agent column"`

Expected: FAIL — "no such column: agent".

- [ ] **Step 3: Add the migration**

In `electron/services/database.ts`, find the migrations block (search for the most recent `ALTER TABLE` or numbered migration). Append a new migration after the most recent one:

- Statement 1: `ALTER TABLE sessions ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude'`
- Statement 2: `ALTER TABLE path_rules ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude'`

Use the next sequential version number. If the schema is initialized via `CREATE TABLE` in a top-level `init` block (not numbered migrations), add `agent TEXT NOT NULL DEFAULT 'claude'` to both `CREATE TABLE` statements **and** add a defensive `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for existing on-disk DBs.

- [ ] **Step 4: Verify GREEN**

`npm test -- electron/__tests__/database.test.ts -t "agent column"` → PASS.

- [ ] **Step 5: Run full DB suite**

`npm test -- electron/__tests__/database.test.ts` → all pass.

- [ ] **Step 6: Commit**

`git add electron/services/database.ts electron/__tests__/database.test.ts && git commit -m "feat(db): add agent column to sessions and path_rules"`

---

## Task 2: Define the `AgentEngine` interface + types

**Files:**
- Create: `electron/services/agents/types.ts`

- [ ] **Step 1: Write the types**

Create `electron/services/agents/types.ts` exporting:

- `type AgentKind = 'claude' | 'codex';`
- `interface AgentStartParams` with fields: `projectPath: string`, `configDir: string`, `model?: string`, `permissionMode?: string`, `resumeSessionId?: string`, `allowedTools?: string[]`, `claude?: Record<string, unknown>`.
- `interface AgentMessage` with fields: `agent: AgentKind`, `tabId: string`, `receivedAt: string`, `sessionId: string | null`, `payload: unknown`. Claude `payload` is the existing SDKMessage shape; Codex `payload` is the codex/event body. The shared envelope only normalizes routing metadata — no content normalization.
- `interface AgentPermissionRequest` with fields: `agent: AgentKind`, `requestId: string`, `kind: 'tool' | 'patch' | 'exec'`, `summary: string`, `payload: unknown`.
- `interface Disposable { dispose(): void; }`.
- `interface AgentEngineExit { code: number; signal?: string | null; }`.
- `interface AgentEngine` with: `readonly kind: AgentKind`, `start(params)`, `send(text)`, `respondPermission(requestId, decision, payload?)`, `interrupt()`, `close()`, `kill()`, `getResumeId(): string | null`, `onMessage(cb)`, `onPermissionRequest(cb)`, `onError(cb)`, `onExit(cb)`.

- [ ] **Step 2: Verify typecheck**

`npm run check` → clean.

- [ ] **Step 3: Commit**

`git add electron/services/agents/types.ts && git commit -m "feat(agents): define AgentEngine interface and message types"`

---

## Task 3: `createClaudeCliEngine` — subprocess spawn skeleton (TDD)

**Files:**
- Create: `electron/__tests__/agents/claude-cli-engine.test.ts`
- Create: `electron/services/agents/claude-cli-engine.ts`

- [ ] **Step 1: Write the failing test**

The test suite for the engine mocks the subprocess primitive used by the engine. Look at `electron/services/sessions/tui.ts` and the existing `tui.test.ts` to mirror that mocking pattern. Mock `electron/services/claude-binary` to return a fixed path like `/usr/local/bin/claude`.

Write two failing tests:

1. `start() spawns the claude binary with stream-json IO flags and CLAUDE_CONFIG_DIR set` — asserts the subprocess mock was called with: the binary path returned by `findSystemClaudeBinary`, args including `--output-format stream-json`, `--input-format stream-json`, `--model sonnet`, the spawn opts include `cwd: '/proj'` and `env.CLAUDE_CONFIG_DIR === '/conf'`.
2. `start() with resumeSessionId adds --resume <id>` — asserts the args contain both `--resume` and the resume id.

The fake subprocess should be an `EventEmitter` with `.stdout` and `.stderr` as `Readable`s, `.stdin` as a `Writable` that records writes into an array, `.kill = vi.fn()`, and `.pid = 12345`.

- [ ] **Step 2: Verify RED**

`npm test -- electron/__tests__/agents/claude-cli-engine.test.ts` → FAIL (cannot resolve module).

- [ ] **Step 3: Minimal implementation**

Create `electron/services/agents/claude-cli-engine.ts`:

- Import the project's subprocess primitive (the same one `tui.ts` uses for spawning the `claude` binary), `findSystemClaudeBinary` from `../claude-binary`, and the types from `./types`.
- Export `createClaudeCliEngine({ tabId: string })` returning an `AgentEngine`.
- Closure state: `child` (the subprocess handle, initially null), `sessionId` (initially null).
- A `buildArgs(p: AgentStartParams)` helper that returns the array: starts with `['--output-format', 'stream-json', '--input-format', 'stream-json', '--include-partial-messages']`. If `p.resumeSessionId` is set, append `'--resume', p.resumeSessionId` and set `sessionId = p.resumeSessionId`. If `p.model` is set, append `'--model', p.model`. If `p.permissionMode` is set, append `'--permission-mode', p.permissionMode`. If `p.allowedTools?.length`, append `'--allowed-tools', p.allowedTools.join(',')`.
- `start(p)` resolves the binary via `findSystemClaudeBinary()` (throw if null), builds args, spawns the subprocess with `cwd: p.projectPath` and `env: { ...process.env, CLAUDE_CONFIG_DIR: p.configDir }`, stores the handle in `child`.
- All other interface methods stub as no-ops; `close()` sends SIGTERM and nulls `child`; `kill()` sends SIGKILL and nulls `child`; `getResumeId()` returns `sessionId`. `onMessage`/`onPermissionRequest`/`onError`/`onExit` return `{ dispose() {} }`.

- [ ] **Step 4: Verify GREEN**

Tests pass.

- [ ] **Step 5: Commit**

`git commit -m "feat(agents): ClaudeCliEngine spawn skeleton with stream-json flags"`

---

## Task 4: `onMessage` — NDJSON line buffer + emission (TDD)

**Files:**
- Modify: `electron/__tests__/agents/claude-cli-engine.test.ts`
- Modify: `electron/services/agents/claude-cli-engine.ts`

- [ ] **Step 1: Append three RED tests**

1. **Parses NDJSON lines into onMessage events.** After `start()`, register an `onMessage` callback. Push two complete NDJSON lines onto the fake `stdout` (e.g. a `system:init` message and an `assistant` message). Await a microtask. Assert two messages were emitted, each with `agent === 'claude'`, `tabId === 'tm'`, and the right `payload`.
2. **Handles split lines across chunk boundaries.** Push half a line, then the rest. Assert exactly one message emitted, with the joined JSON.
3. **Captures session_id from system:init for getResumeId().** After pushing a `system:init` with `session_id: 'freshid'`, `engine.getResumeId()` returns `'freshid'`.

- [ ] **Step 2: Verify RED**

Three new fails.

- [ ] **Step 3: Implement NDJSON parsing + onMessage**

In the engine:

- Add closure state: `const messageCallbacks: Array<(m: AgentMessage) => void> = [];` and `let lineBuf = '';`.
- Add `function emitMessage(line: string)`: trim-check, `JSON.parse` (silently drop parse errors), if `payload.type === 'system' && payload.subtype === 'init' && typeof payload.session_id === 'string'` set `sessionId = payload.session_id`. Construct an `AgentMessage` with `agent: 'claude'`, `tabId: params.tabId`, `receivedAt: new Date().toISOString()`, `sessionId`, `payload`. Iterate `messageCallbacks`, try/catch each one (log on throw).
- Add `function wireStdout(stdout)`: on `data` chunk → append to `lineBuf` as UTF-8, then loop pulling out complete lines via `lineBuf.indexOf('\n')`, calling `emitMessage` on each.
- In `start()`, after spawn, call `wireStdout(child.stdout)`.
- Replace `onMessage`: push to `messageCallbacks`, return `{ dispose() { splice it out } }`.

- [ ] **Step 4: Verify GREEN + Commit**

`npm test -- electron/__tests__/agents/claude-cli-engine.test.ts` → all pass.

`git commit -m "feat(agents): NDJSON line buffer + onMessage emission for ClaudeCliEngine"`

---

## Task 5: `send()` — stream-json input writing (TDD)

**Files:**
- Modify: `electron/__tests__/agents/claude-cli-engine.test.ts`
- Modify: `electron/services/agents/claude-cli-engine.ts`

- [ ] **Step 1: Append RED test**

`send() writes a well-formed stream-json user message to stdin.`

After `start()`, push a `system:init` with `session_id: 'send-sess'` so the engine knows the id. Call `await engine.send('hello world')`. Assert: exactly one write was captured on the fake stdin, it ends in `\n`, and the parsed JSON has: `type: 'user'`, `message.role: 'user'`, `message.content[0].type: 'text'`, `message.content[0].text: 'hello world'`, `session_id: 'send-sess'`, `parent_tool_use_id: null`.

- [ ] **Step 2: Verify RED**

`npm test -- electron/__tests__/agents/claude-cli-engine.test.ts -t "send"` → FAIL.

- [ ] **Step 3: Implement `send`**

`async send(text)`:
- If `!child` or `!child.stdin.writable`, throw `'ClaudeCliEngine.send: child not running'`.
- Construct the JSON object: `{ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: sessionId ?? '' }`.
- Write `JSON.stringify(obj) + '\n'` to `child.stdin`, wrapping the callback in a Promise.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): ClaudeCliEngine.send stream-json input writing"`

---

## Task 6: Permission protocol round-trip (TDD)

**Files:**
- Modify: `electron/__tests__/agents/claude-cli-engine.test.ts`
- Modify: `electron/services/agents/claude-cli-engine.ts`

- [ ] **Step 1: Append two RED tests**

1. **Forwards control_request:permission_request to onPermissionRequest.** Push a JSON line with `type: 'control_request'`, `subtype: 'permission_request'`, `request_id: 'pr1'`, `tool_name: 'Bash'`, `input: { command: 'ls' }`. Assert the registered `onPermissionRequest` callback received: `agent: 'claude'`, `kind: 'tool'`, `requestId: 'pr1'`, `summary` containing `'Bash'`, `payload.tool_name === 'Bash'`.
2. **respondPermission ships a control_response on stdin with right id.** Call `engine.respondPermission('pr2', 'allow')`. Assert one write was captured with parsed JSON `{ type: 'control_response', request_id: 'pr2', decision: 'allow' }`.

- [ ] **Step 2: Verify RED**

Two fails.

- [ ] **Step 3: Implement**

- Add `const permissionCallbacks: Array<(r: AgentPermissionRequest) => void> = [];` to closure.
- In `emitMessage`, at the top: if `payload?.type === 'control_request' && payload?.subtype === 'permission_request'`, construct an `AgentPermissionRequest` (`agent: 'claude'`, `requestId: String(payload.request_id ?? '')`, `kind: 'tool'`, `summary: \`${payload.tool_name ?? 'tool'} request\``, `payload`), iterate `permissionCallbacks` (try/catch each), then `return` (don't also emit as a normal message).
- Replace `onPermissionRequest`: push + splice-on-dispose, mirror of `onMessage`.
- Implement `respondPermission(requestId, decision, payload?)`: if `!child?.stdin.writable` return. Build `{ type: 'control_response', request_id: requestId, decision }`, attach `input: payload` if defined, write `JSON.stringify(obj) + '\n'` (fire-and-forget — no need to await).

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): ClaudeCliEngine permission round-trip via control_response"`

---

## Task 7: `interrupt()` (TDD)

**Files:**
- Modify: `electron/__tests__/agents/claude-cli-engine.test.ts`
- Modify: `electron/services/agents/claude-cli-engine.ts`

- [ ] **Step 1: Append RED test**

`interrupt() writes a control_request:interrupt to stdin.` After `start()`, `await engine.interrupt()`. Assert one write captured with parsed JSON `{ type: 'control_request', subtype: 'interrupt', request_id: <some-string> }`.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement**

`async interrupt()`: if `!child?.stdin.writable` return. Build `{ type: 'control_request', subtype: 'interrupt', request_id: \`int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}\` }`. Write `JSON.stringify(obj) + '\n'` via a Promise-wrapped stdin write.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): ClaudeCliEngine.interrupt via control_request"`

---

## Task 8: `close()`, `kill()`, `onExit`, `onError` (TDD)

**Files:**
- Modify: `electron/__tests__/agents/claude-cli-engine.test.ts`
- Modify: `electron/services/agents/claude-cli-engine.ts`

- [ ] **Step 1: Append three RED tests**

1. **onExit fires when child emits exit.** Register callback, emit `'exit'` event with `(0, null)` on the fake subprocess. Assert callback received `{ code: 0, signal: null }`.
2. **onError fires on stderr lines.** Register callback, push `'connection refused\n'` on fake stderr. Assert callback received an `Error` whose message contains `'connection refused'`.
3. **close() sends SIGTERM and is idempotent.** Call `await engine.close()` twice. Assert the fake's `.kill` was called once (after the first close, child is null and second close is a no-op).

- [ ] **Step 2: Verify RED**

Three fails.

- [ ] **Step 3: Implement**

- Add `const exitCallbacks: Array<(info: AgentEngineExit) => void> = [];` and `const errorCallbacks: Array<(err: Error) => void> = [];`.
- Add `function wireStderr(stderr)`: line-buffer the chunks (same pattern as `wireStdout`), for each non-empty line construct `new Error(line)` and iterate `errorCallbacks`.
- In `start()` after spawn, call `wireStderr(child.stderr)` and register `child.on('exit', (code, signal) => { for (const cb of exitCallbacks) try { cb({ code: code ?? -1, signal }); } catch {} })`.
- Replace `onError`/`onExit` to push/splice like the others.
- Confirm `close()` guards against double-close (the `child = null` after first kill makes the second call a no-op naturally).

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): ClaudeCliEngine onExit/onError + idempotent close"`

---

## Task 9: Restart-on-stream-death with `--resume` (TDD)

**Files:**
- Modify: `electron/__tests__/agents/claude-cli-engine.test.ts`
- Modify: `electron/services/agents/claude-cli-engine.ts`

- [ ] **Step 1: Append RED test**

`start() is re-entrant — second call with resumeSessionId spawns a fresh child with --resume.`

Set up two fake subprocesses in sequence (`mockReturnValueOnce(first).mockReturnValueOnce(second)`). Call `start()` once with no resume; push `system:init` with `session_id: 'sess-rs'` to capture it. Emit `'exit'` (1, null) on first. Call `start()` again with `resumeSessionId: engine.getResumeId() ?? undefined`. Assert: spawn was called twice; second call's args contain `--resume` and `'sess-rs'`.

- [ ] **Step 2: Verify RED (or already GREEN)**

If GREEN, keep the test for regression. If RED, harden `start()` to be re-entrant.

- [ ] **Step 3: Make `start()` re-entrant**

At the top of `start()`, before any spawn, if `child !== null`: try `child.kill('SIGTERM')` (swallow throws), set `child = null`. Reset `lineBuf = ''` so a re-spawn doesn't see stale partial data.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): make ClaudeCliEngine.start re-entrant for restart-on-error"`

---

## Task 10: Wire engine into `SessionHandle` + lifecycle.ts seam

**Files:**
- Modify: `electron/services/sessions/types.ts`
- Modify: `electron/services/sessions/lifecycle.ts`
- Modify: `electron/__tests__/sessions.test.ts`

- [ ] **Step 1: Add `engine` field to SessionHandle**

In `electron/services/sessions/types.ts`, inside `SessionHandle`, add:

`engine: import('../agents/types').AgentEngine | null;`

Comment: "When set, runtime drives this engine instead of `query`. Default for new sessions in phase 1. SDK path (via `query`) remains for OMNIFEX_USE_SDK=1."

- [ ] **Step 2: Write the failing test**

In `electron/__tests__/sessions.test.ts`, near the other lifecycle tests, add `start() uses ClaudeCliEngine by default and SDK when OMNIFEX_USE_SDK=1`:

1. `vi.spyOn` `createClaudeCliEngine` from the agents module.
2. With `OMNIFEX_USE_SDK` unset, call `svc.start(...)` and assert the spy was called once.
3. With `OMNIFEX_USE_SDK = '1'`, clear the spy, set up `installFakeQuery()`, call `svc.start(...)` and assert the spy was NOT called.
4. Clean up `process.env.OMNIFEX_USE_SDK` at the end.

- [ ] **Step 3: Verify RED**

`npm test -- electron/__tests__/sessions.test.ts -t "ClaudeCliEngine by default"` → FAIL.

- [ ] **Step 4: Add the engine-selection seam in lifecycle.ts**

At the top of `lifecycle.ts`:
- Import `createClaudeCliEngine` from `'../agents/claude-cli-engine'`.
- Import type `AgentEngine` from `'../agents/types'`.

In `start()`, after resolving `configDir` but before building SDK options:

- `const useSdkFallback = process.env.OMNIFEX_USE_SDK === '1';`
- `let engine: AgentEngine | null = null;`
- If `!useSdkFallback`: create the engine via `createClaudeCliEngine({ tabId })`, then `await engine.start({ projectPath, configDir, model, permissionMode, resumeSessionId })`.

When constructing the handle, set `engine` on it. When `useSdkFallback` is true, fall through to the existing SDK `startup()` work; leave `engine = null`.

When `engine !== null`, skip the SDK option-building and `startup()` call entirely. The engine's lifecycle replaces the SDK's `query` + `inputChannel`. Wire `engine.onPermissionRequest(...)` into the existing permission-pending queue (search for where `canUseTool` pushes into that queue today, and mirror).

- [ ] **Step 5: Verify GREEN**

`npm test -- electron/__tests__/sessions.test.ts -t "ClaudeCliEngine by default"` → PASS.

- [ ] **Step 6: Commit**

`git commit -m "feat(sessions): select CLI engine by default, SDK behind OMNIFEX_USE_SDK=1"`

---

## Task 11: Drive `handle.engine` from runtime.ts when present

**Files:**
- Modify: `electron/services/sessions/runtime.ts`
- Modify: `electron/__tests__/sessions.test.ts`

The runtime currently iterates `handle.query` and dispatches the status FSM via `setStatus()` based on each message's `type`/`subtype`. We want the same FSM driven by `handle.engine.onMessage()` when an engine is present.

- [ ] **Step 1: Implement runtime branch**

In `electron/services/sessions/runtime.ts`, modify `listenToMessages`:

Top of function, before the existing `if (!handle.query) return;`:
- If `handle.engine !== null`, return `listenToEngineMessages(tabId, handle, deps)` and do NOT fall into the SDK loop.
- Otherwise, fall through to the existing SDK loop unchanged.

Add the new helper `listenToEngineMessages(tabId, handle, deps)`:

- Destructure `{ sendToRenderer, notificationHooks, rateLimitHook }` from deps.
- `const engine = handle.engine!;`
- Subscribe `engine.onMessage((agentMsg) => { ... })`:
  - `const message = agentMsg.payload as any;`
  - `const event = classifyRuntimeEvent(message);`
  - `(message as any).receivedAt = agentMsg.receivedAt;`
  - Switch on `event.kind` with the same transitions as the SDK loop:
    - `'init'` → if `event.sessionId`, set `handle.sessionId`; `setStatus(handle, { sessionStatus: 'started', conversationStatus: 'idle' }, ...)`; ensure JSONL tail wired (extract the helper `ensureJsonlTail()` from the SDK loop to module scope if not already, and call it here).
    - `'rateLimit'` → fire `rateLimitHook(handle.configDir, event.info)` (try/catch); set `conversationStatus: 'running'`.
    - `'compact'` / `'turn'` → set `conversationStatus: 'running'`.
    - `'streamEvent'` → no-op.
    - `'result'` → handled after the renderer dispatch (see below).
  - Always: `sendToRenderer(\`claude-output:${tabId}\`, message);`
  - If `event.kind === 'result'`: call `dispatchResultNotification({ tabId, projectPath: handle.projectPath, event, sendToRenderer, notificationHooks })`, then `setStatus(handle, { conversationStatus: 'idle' }, ...)`.
- Subscribe `engine.onError((err) => { ... })`:
  - If `handle.mode === 'tui'`, return (TUI owns lifecycle).
  - `setStatus(handle, { sessionStatus: 'error' }, ...)`.
  - `sendToRenderer(\`claude-error:${tabId}\`, err.message);`
  - `sendToRenderer(\`claude-complete:${tabId}\`);`
- Subscribe `engine.onExit(() => { ... })`:
  - If `handle.mode === 'tui'`, return.
  - `setStatus(handle, { sessionStatus: 'stopped' }, ...)`.
  - `sendToRenderer(\`claude-complete:${tabId}\`);`
  - `deps.sessions.delete(tabId);`
- The function returns a Promise that resolves when the engine fires `onExit`. Implement that by storing the resolve fn at the top, calling it inside the `onExit` subscriber.

Also: the JSONL-tail wiring helper (`ensureJsonlTail`/`teardownJsonlTail`) currently lives inside the SDK loop's closure. Hoist it to a module-scope helper (or duplicate it in the new function — your call; hoist is cleaner). The behavior must be identical: tail starts when sessionId is first known, stops on exit/error/identity-replace.

The StrictMode double-mount guard (`sessions.get(tabId) !== handle`) and the TUI-handoff guard also apply to the engine-driven loop. Mirror them.

- [ ] **Step 2: Run sessions suite**

`npm test -- electron/__tests__/sessions.test.ts electron/__tests__/sessions-account-resolution.test.ts electron/__tests__/sessions-tui-coldstart.test.ts electron/__tests__/permission-persistence.test.ts`

Expected: all green. The SDK path is untouched; the CLI path is exercised by Task 10's seam test plus engine unit tests; deep CLI-runtime integration is covered by the manual smoke in Task 15.

- [ ] **Step 3: Commit**

`git commit -m "feat(sessions): drive runtime from AgentEngine when engine is set on handle"`

---

## Task 12: Rewrite `summary-query.ts` as one-shot CLI invocation

**Files:**
- Modify: `electron/services/sessions/summary-query.ts`
- Create: `electron/__tests__/summary-query.test.ts` (if not present)

The current `summary-query.ts` calls SDK `query()` for a one-shot summary regeneration. Replace with `claude -p "<prompt>" --output-format json`.

- [ ] **Step 1: Inspect the current file**

`cat electron/services/sessions/summary-query.ts` to see ALL its exports. The plan must preserve every exported symbol other modules depend on — at minimum `encodeProjectKey` is consumed by `runtime.ts`.

- [ ] **Step 2: Write the failing test**

Create `electron/__tests__/summary-query.test.ts`. Mock the same subprocess primitive the engine uses; mock `findSystemClaudeBinary`.

Test `generateSummary({ transcript, projectPath, configDir, model })`:
- Sets up a fake subprocess that writes `JSON.stringify({ type: 'result', subtype: 'success', result: 'A short summary.' })` to stdout and emits `'exit'` with code 0 on the next microtask.
- Calls `generateSummary(...)`.
- Asserts the result string is `'A short summary.'`.
- Asserts the subprocess was spawned with args containing `-p`, `--output-format`, and `'json'`.

- [ ] **Step 3: Verify RED**

`npm test -- electron/__tests__/summary-query.test.ts` → FAIL.

- [ ] **Step 4: Replace the body**

`export async function generateSummary(p: { transcript: string; projectPath: string; configDir: string; model?: string }): Promise<string>`:

- Resolve binary via `findSystemClaudeBinary()` (throw if null).
- Build prompt: `\`Summarize this conversation in one short sentence:\n\n${p.transcript}\``.
- Build args: `['-p', prompt, '--output-format', 'json']`; if `p.model`, append `'--model', p.model`.
- Spawn with `cwd: p.projectPath`, `env: { ...process.env, CLAUDE_CONFIG_DIR: p.configDir }`, `stdio: ['ignore', 'pipe', 'pipe']`.
- Collect stdout + stderr into strings.
- On `'exit'`: if `code !== 0`, reject with `\`claude -p exited ${code}: ${stderr.trim()}\``. Otherwise try `JSON.parse(stdout)`, resolve with `String(obj?.result ?? '').trim()`. On parse failure, reject with `\`claude -p returned non-JSON: ${stdout.slice(0, 200)}\``.

Preserve `encodeProjectKey` and any other exports the current file has.

- [ ] **Step 5: Verify GREEN + Commit**

`npm test -- electron/__tests__/summary-query.test.ts electron/__tests__/sessions.test.ts` → all pass.

`git commit -m "refactor(sessions): summary-query uses claude -p instead of SDK query()"`

---

## Task 13: Rename `mode: 'sdk' | 'tui'` → `mode: 'rich' | 'tui'`

**Files:**
- Modify: `electron/services/sessions/types.ts`
- Modify: `electron/services/sessions/lifecycle.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/components/ClaudeCodeSession.tsx`
- Modify: `src/components/NewSessionForm.tsx`
- Modify: `src/hooks/useSessionLifecycle.ts`
- Modify: any test that asserts the literal `'sdk'`

The IPC payload `{ mode: 'sdk' | 'tui' }` is internal (we own both sides), so a one-shot rename is safe.

- [ ] **Step 1: Update the type**

In `electron/services/sessions/types.ts`: `export type SessionMode = 'rich' | 'tui';`

In `src/lib/api.ts`: same.

- [ ] **Step 2: Replace literals**

Run `git grep -n "'sdk'" electron/ src/` and `git grep -n '"sdk"' electron/ src/`. Replace every hit with `'rich'` / `"rich"`. Special attention to:
- `sessionStartMode: SessionMode = 'sdk'` → `'rich'`
- IPC payload literals in `session-mode:` event sends
- Test assertions

- [ ] **Step 3: Relabel the UI toggle**

In `src/components/SessionModeToggle.tsx`, change the button label `SDK` → `Chat`. `git grep -n 'SDK' src/components/` to find. Update tests asserting on the label.

- [ ] **Step 4: Verify**

`npm run check && npm test` → all green.

- [ ] **Step 5: Commit**

`git add -A && git commit -m "refactor(sessions): rename mode 'sdk' -> 'rich' across main + renderer"`

---

## Task 14: Delete `electron/services/sessions/hooks.ts`

The CLI invokes user-defined hooks itself; SDK-shaped hook marshalling is dead code under the CLI path.

- [ ] **Step 1: Find consumers**

```
git grep -n "from './hooks'" electron/services/sessions/
git grep -n "from '../services/sessions/hooks'" electron/
git grep -n "from '@/services/sessions/hooks'" electron/
```

- [ ] **Step 2: Decide per consumer**

For each importer:
- If the import was for SDK-only hook types, drop the import.
- If the import was for an OmniFex-internal hook-shaped subscriber (rate-limit hook, claude-output-extra carrier), move that subscriber inline into `lifecycle.ts` next to where the engine's `onMessage` is wired up.

- [ ] **Step 3: Delete the file**

`git rm electron/services/sessions/hooks.ts`

- [ ] **Step 4: Verify**

`npm run check && npm test` → clean.

- [ ] **Step 5: Commit**

`git commit -am "refactor(sessions): delete hooks.ts (CLI invokes user hooks natively)"`

---

## Task 15: Verification gate

**Files:** none — runs commands.

- [ ] **Step 1: Full typecheck + build + tests + coverage**

`npm run check && npm run build && npm run test:coverage`

Expected: all green. New `electron/services/agents/` files should hit ≥80% line coverage.

- [ ] **Step 2: Manual smoke — Claude CLI path**

`npm run rebuild:electron`, then `ELECTRON_ENABLE_LOGGING=1 npm start 2>&1 | tee /tmp/omnifex-cli-engine.log`.

Checklist:
1. Open a project that resolves to a Claude account; start a new chat session.
2. Send a message; confirm the response streams in (live, partial messages render).
3. Trigger a tool that prompts for permission (e.g., a Bash command); confirm the permission dialog works in both directions (allow + deny).
4. Confirm subagent tasks appear in the TaskList panel — verifies JSONL tail still works.
5. Confirm rate-limit indicator updates on a heavy turn.
6. Toggle Chat → Terminal → back; confirm conversation memory persists.
7. Kill the session (close tab), reopen the project, resume; confirm history reloads.
8. Check `/tmp/omnifex-cli-engine.log` for unexpected errors.

- [ ] **Step 3: Manual smoke — SDK fallback path**

`OMNIFEX_USE_SDK=1 npm start 2>&1 | tee /tmp/omnifex-sdk-fallback.log`

Repeat the same checklist. Expected: identical behavior — the fallback exists precisely so a CLI regression can be A/B'd.

- [ ] **Step 4: Rebuild Electron ABI** (pretest may have flipped it)

`npm run rebuild:electron`

- [ ] **Step 5: No commit from this task** — verification only. If any step fails, circle back to the relevant earlier task and fix at the source; don't paper over with a catch-all commit.

---

## Task 16: CHANGELOG + version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Bump version**

In `package.json:4`, increment patch (whatever's current + 1).

- [ ] **Step 2: Add CHANGELOG entry**

Prepend above the most recent existing entry:

```
## [<new-version>] — YYYY-MM-DD

### Changed

- **Claude sessions now run on the `claude` CLI directly** (`<commit>`). The session engine moved off the `@anthropic-ai/claude-agent-sdk` runtime onto a subprocess running `claude --output-format stream-json --input-format stream-json`. Slash commands, plugins, `/model`, hooks defined in `~/.claude/settings.json`, MCP servers, and `/cost` now all work identically to invoking `claude` directly. The renderer is unchanged — the on-wire message shape is the same. Resume, rate-limit tracking, subagent JSONL tail, and the Chat↔Terminal toggle all continue to work.
- **Toggle relabeled SDK→Chat** (`<commit>`). The mode toggle in the session header now reads "Chat / Terminal" since "SDK" no longer describes what's underneath.
- **Internal:** `summary-query.ts` rewritten as `claude -p ... --output-format json`. `electron/services/sessions/hooks.ts` deleted (CLI invokes user hooks natively). New `electron/services/agents/` module with the `AgentEngine` interface and `ClaudeCliEngine` implementation.

### Notes

- The SDK path is still available behind `OMNIFEX_USE_SDK=1` for one release as an A/B safety hatch. It will be removed in the next release.
- Schema migration: new `agent` column on `sessions` and `path_rules` tables, defaulted to `'claude'` for every existing row. No data loss.
- Phase 1 of the SDK→CLI engine + Codex support plan. See `docs/superpowers/specs/2026-05-25-cli-engine-and-codex-design.md`.
```

Replace each `<commit>` with the short SHA from this plan's feature commits.

- [ ] **Step 3: Commit**

`git add CHANGELOG.md package.json package-lock.json && git commit -m "chore: bump version to <new-version>"`

- [ ] **Step 4: Cut the release**

Run `/omnifex-release` (or invoke the skill manually if running headless).

---

## Self-review

- Spec coverage: Phase 1 of the spec is fully covered by Tasks 1-16. Phases 2, 3, 4 are explicitly out of scope (see Non-Goals + the spec's phasing section).
- Engine interface: Defined in Task 2; every method tested in Tasks 3-9.
- Permission round-trip: Task 6 covers both directions (incoming request → renderer; outgoing decision → CLI).
- Restart on stream death: Task 9. The runtime branch in Task 11 routes errors into the existing restart path.
- JSONL tail unchanged: Task 11 wires the same JSONL-tail helper into the engine-driven runtime; on-disk format unchanged because the CLI writes the same JSONL.
- SDK fallback: Tasks 10-11 preserve the SDK path behind `OMNIFEX_USE_SDK=1`. SDK dependency still installed — removed in phase 2.
- Renderer untouched: Only the `'sdk' → 'rich'` rename (Task 13) and the "SDK"→"Chat" label change. Transcript, tool widgets, permission dialog, status bar all unchanged.
- Migration: Task 1 adds `agent` column with backfill default. Forward-compatible for phase 3.
- Task 11 runtime split: the engine-driven loop duplicates some of the SDK loop's structure. The duplication is intentional for phase 1 to keep the SDK fallback bit-perfect; phase 2 deletes the SDK branch entirely and the duplication collapses.

---

## Follow-up phases (out of scope here)

- **Phase 2 — Remove SDK dependency.** Delete `@anthropic-ai/claude-agent-sdk`, delete the `OMNIFEX_USE_SDK` fallback, delete the SDK branch in `runtime.ts` + `lifecycle.ts`. Drop SDK from forge `asar.unpack`. Drop SDK from pretest / rebuild hooks. Drop `installFakeQuery` test helper.
- **Phase 3 — Codex engine + agent-aware routing + Codex transcript.** New `CodexCliEngine` (JSON-RPC over stdio), `codex-binary.ts`, `CodexAuthService`, `OneShotTerminal`, agent picker in new-session dialog, `CodexTranscript` + per-item widgets, Codex auth UI, Codex session-list partition. Feature-flagged.
- **Phase 4 — Claude re-auth affordance.** Detect needs-reauth, surface the chip button, wire `ClaudeAuthService.reauthenticate()` through the shared `runInteractiveCliFlow` primitive.

Each follow-up phase gets its own plan via `superpowers:writing-plans` when the prior phase has shipped and stabilized.

---

**End of plan.**
