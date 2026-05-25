# Phase A — Claude CLI Engine + SDK Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the SDK runtime for Claude sessions with a CLI-backed subprocess (`claude --output-format stream-json --input-format stream-json`), hidden behind a new `AgentEngine` interface, and remove the `@anthropic-ai/claude-agent-sdk` dependency entirely in the same release. No fallback flag, no compat shim — CLI is the only path.

**Architecture:** A new `electron/services/agents/` module defines an `AgentEngine` interface and the first concrete implementation, `ClaudeCliEngine`. Sessions service grows an `engine: AgentEngine` field on the handle; the live message loop in `runtime.ts` drives the engine instead of the SDK's `Query` iterator. The Claude-side stream-json output is byte-for-byte the same JSON the SDK was yielding, so the renderer is unchanged. Once the engine is wired in, the SDK imports go dead and are deleted in the same release.

**Tech Stack:** Node's child-process subprocess (use the project's existing safe spawn pattern — `execFileNoThrow` where appropriate, otherwise the same subprocess primitives `tui.ts` already uses), NDJSON line-buffered parsing, existing `better-sqlite3` migration pattern, existing `claude-binary.ts` discovery chain.

**Spec:** `docs/superpowers/specs/2026-05-25-cli-engine-and-codex-design.md` (combines phases 1 and 2 of the spec into a single shippable release).

---

## Non-Goals (out of scope for this plan)

- Codex engine, agent picker UI, Codex transcript. (Phase 3 — separate plan.)
- Claude re-auth affordance. (Phase 4 — separate plan.)
- Touching the renderer transcript or any of `src/components/`. The renderer still consumes the same Claude message shape it does today.
- TUI mode internals. The `mode: 'rich' | 'tui'` rename is in scope; everything inside `tui.ts` is not.

---

## File Structure

**New files:**
- `electron/services/agents/types.ts` — `AgentKind`, `AgentEngine`, `AgentMessage`, `AgentPermissionRequest`, `AgentStartParams`.
- `electron/services/agents/claude-cli-engine.ts` — `createClaudeCliEngine()` factory.
- `electron/__tests__/agents/claude-cli-engine.test.ts` — unit tests using a mocked subprocess.

**Modified files:**
- `electron/services/sessions/types.ts` — add `engine` to `SessionHandle`; widen `SessionMode` to `'rich' | 'tui'`.
- `electron/services/sessions/lifecycle.ts` — replace SDK `startup()` call with engine; delete SDK option-building code.
- `electron/services/sessions/runtime.ts` — drive `handle.engine` only; delete the SDK iterator loop.
- `electron/services/sessions/summary-query.ts` — rewrite as one-shot CLI invocation; remove SDK dependency.
- `electron/services/database.ts` — add migration for `agent` column on `sessions` + `path_rules`.
- `electron/__tests__/sessions.test.ts` — delete `installFakeQuery`; add tests using the new engine seam.
- `electron/__tests__/permission-persistence.test.ts` — rewrite to mock the engine instead of SDK `query`/`startup`.
- `src/lib/api.ts` — update `SessionMode` literal union.
- `src/components/ClaudeCodeSession.tsx` — update mode comparisons from `'sdk'` to `'rich'`.
- `src/components/NewSessionForm.tsx` — update default mode.
- `src/hooks/useSessionLifecycle.ts` — update mode references.
- `src/components/SessionModeToggle.tsx` — relabel `SDK` → `Chat`.
- `package.json` — **remove** `@anthropic-ai/claude-agent-sdk` dependency; version bump for release.
- `forge.config.ts` — drop the SDK glob from `asar.unpack`.
- `CHANGELOG.md` — combined entry.

**Deleted files:**
- `electron/services/sessions/hooks.ts` — CLI invokes user hooks natively.

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

`npm test -- electron/__tests__/database.test.ts -t "agent column"` → FAIL ("no such column: agent").

- [ ] **Step 3: Add the migration**

In `electron/services/database.ts`, find the migrations block (search for the most recent numbered migration or `ALTER TABLE`). Append:

- `ALTER TABLE sessions ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude'`
- `ALTER TABLE path_rules ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude'`

Use the next sequential version number. If the schema is initialized via `CREATE TABLE` in a top-level `init` block (not numbered migrations), add `agent TEXT NOT NULL DEFAULT 'claude'` to both `CREATE TABLE` statements **and** add a defensive `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for existing on-disk DBs.

- [ ] **Step 4: Verify GREEN + full DB suite**

`npm test -- electron/__tests__/database.test.ts` → all pass.

- [ ] **Step 5: Commit**

`git commit -m "feat(db): add agent column to sessions and path_rules"`

---

## Task 2: Define the `AgentEngine` interface + types

**Files:**
- Create: `electron/services/agents/types.ts`

- [ ] **Step 1: Write the types**

Create `electron/services/agents/types.ts` exporting:

- `type AgentKind = 'claude' | 'codex';`
- `interface AgentStartParams` with: `projectPath: string`, `configDir: string`, `model?: string`, `permissionMode?: string`, `resumeSessionId?: string`, `allowedTools?: string[]`, `claude?: Record<string, unknown>`.
- `interface AgentMessage`: `agent: AgentKind`, `tabId: string`, `receivedAt: string`, `sessionId: string | null`, `payload: unknown`. Claude `payload` is the existing SDKMessage shape; Codex `payload` is the codex/event body. The shared envelope only normalizes routing metadata — no content normalization.
- `interface AgentPermissionRequest`: `agent: AgentKind`, `requestId: string`, `kind: 'tool' | 'patch' | 'exec'`, `summary: string`, `payload: unknown`.
- `interface Disposable { dispose(): void; }`.
- `interface AgentEngineExit { code: number; signal?: string | null; }`.
- `interface AgentEngine` with: `readonly kind: AgentKind`, `start(params)`, `send(text)`, `respondPermission(requestId, decision, payload?)`, `interrupt()`, `close()`, `kill()`, `getResumeId(): string | null`, `onMessage(cb)`, `onPermissionRequest(cb)`, `onError(cb)`, `onExit(cb)`.

- [ ] **Step 2: Verify typecheck**

`npm run check` → clean.

- [ ] **Step 3: Commit**

`git commit -m "feat(agents): define AgentEngine interface and message types"`

---

## Task 3: `createClaudeCliEngine` — subprocess spawn skeleton (TDD)

**Files:**
- Create: `electron/__tests__/agents/claude-cli-engine.test.ts`
- Create: `electron/services/agents/claude-cli-engine.ts`

- [ ] **Step 1: Write failing tests**

Mock the subprocess primitive used by the engine — mirror the pattern in `electron/services/sessions/tui.ts` and `tui.test.ts`. Mock `electron/services/claude-binary` to return a fixed path like `/usr/local/bin/claude`.

Write two failing tests:

1. **`start() spawns the claude binary with stream-json IO flags and CLAUDE_CONFIG_DIR set`** — assert the subprocess mock was called with the binary path returned by `findSystemClaudeBinary`, args including `--output-format stream-json`, `--input-format stream-json`, `--model sonnet`, and spawn opts `cwd: '/proj'`, `env.CLAUDE_CONFIG_DIR === '/conf'`.
2. **`start() with resumeSessionId adds --resume <id>`** — assert args contain both `--resume` and the resume id.

The fake subprocess should be an `EventEmitter` with `.stdout` and `.stderr` as `Readable`s, `.stdin` as a `Writable` that records writes into an array, `.kill = vi.fn()`, `.pid = 12345`.

- [ ] **Step 2: Verify RED**

`npm test -- electron/__tests__/agents/claude-cli-engine.test.ts` → FAIL (cannot resolve module).

- [ ] **Step 3: Minimal implementation**

Create `electron/services/agents/claude-cli-engine.ts`:

- Import the project's subprocess primitive (same one `tui.ts` uses), `findSystemClaudeBinary` from `../claude-binary`, the types from `./types`.
- Export `createClaudeCliEngine({ tabId: string })` returning an `AgentEngine`.
- Closure state: `child` (subprocess handle, initially null), `sessionId` (initially null).
- `buildArgs(p: AgentStartParams)` helper returning: `['--output-format', 'stream-json', '--input-format', 'stream-json', '--include-partial-messages']` plus `'--resume', p.resumeSessionId` (and set `sessionId = p.resumeSessionId`) if set, plus `'--model', p.model` if set, plus `'--permission-mode', p.permissionMode` if set, plus `'--allowed-tools', p.allowedTools.join(',')` if non-empty.
- `start(p)` resolves binary via `findSystemClaudeBinary()` (throw if null), spawns with `cwd: p.projectPath`, `env: { ...process.env, CLAUDE_CONFIG_DIR: p.configDir }`, stores handle in `child`.
- All other interface methods stub as no-ops; `close()` sends SIGTERM and nulls `child`; `kill()` sends SIGKILL and nulls `child`; `getResumeId()` returns `sessionId`. `onMessage`/`onPermissionRequest`/`onError`/`onExit` return `{ dispose() {} }`.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): ClaudeCliEngine spawn skeleton with stream-json flags"`

---

## Task 4: `onMessage` — NDJSON line buffer + emission (TDD)

**Files:**
- Modify: `electron/__tests__/agents/claude-cli-engine.test.ts`
- Modify: `electron/services/agents/claude-cli-engine.ts`

- [ ] **Step 1: Append three RED tests**

1. **Parses NDJSON lines into onMessage events.** Push two complete NDJSON lines (`system:init` and `assistant`) onto fake stdout; await microtask; assert two messages emitted with `agent: 'claude'`, `tabId: 'tm'`, correct payloads.
2. **Handles split lines across chunk boundaries.** Push half a line, then the rest; assert one message emitted with the joined JSON.
3. **Captures session_id from system:init for getResumeId().** Push `system:init` with `session_id: 'freshid'`; assert `engine.getResumeId() === 'freshid'`.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement NDJSON parsing + onMessage**

- Add closure state: `const messageCallbacks: Array<(m: AgentMessage) => void> = [];` and `let lineBuf = '';`.
- `emitMessage(line)`: trim-check, `JSON.parse` (silently drop parse errors), capture session_id from `system:init`, build `AgentMessage` with `agent: 'claude'`, `tabId: params.tabId`, `receivedAt: new Date().toISOString()`, `sessionId`, `payload`, iterate `messageCallbacks` (try/catch each).
- `wireStdout(stdout)`: on `data` chunk, append to `lineBuf`, loop pulling out complete lines via `lineBuf.indexOf('\n')`, call `emitMessage`.
- In `start()`, after spawn, call `wireStdout(child.stdout)`.
- Replace `onMessage`: push to array, return `{ dispose() { splice it out } }`.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): NDJSON line buffer + onMessage emission for ClaudeCliEngine"`

---

## Task 5: `send()` — stream-json input writing (TDD)

**Files:**
- Modify: `electron/__tests__/agents/claude-cli-engine.test.ts`
- Modify: `electron/services/agents/claude-cli-engine.ts`

- [ ] **Step 1: Append RED test**

`send() writes a well-formed stream-json user message to stdin`. After `start()`, push `system:init` with `session_id: 'send-sess'`. Call `await engine.send('hello world')`. Assert: one write captured ending in `\n`, parsed JSON has `type: 'user'`, `message.role: 'user'`, `message.content[0].text: 'hello world'`, `session_id: 'send-sess'`, `parent_tool_use_id: null`.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement `send`**

`async send(text)`: if `!child` or `!child.stdin.writable`, throw `'ClaudeCliEngine.send: child not running'`. Build `{ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: sessionId ?? '' }`. Promise-wrap a `child.stdin.write(JSON.stringify(obj) + '\n', cb)`.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): ClaudeCliEngine.send stream-json input writing"`

---

## Task 6: Permission protocol round-trip (TDD)

**Files:**
- Modify: `electron/__tests__/agents/claude-cli-engine.test.ts`
- Modify: `electron/services/agents/claude-cli-engine.ts`

- [ ] **Step 1: Append two RED tests**

1. **Forwards control_request:permission_request to onPermissionRequest.** Push JSON with `type: 'control_request'`, `subtype: 'permission_request'`, `request_id: 'pr1'`, `tool_name: 'Bash'`, `input: { command: 'ls' }`. Assert callback received `agent: 'claude'`, `kind: 'tool'`, `requestId: 'pr1'`, summary contains `'Bash'`, payload preserves the raw shape.
2. **respondPermission ships a control_response on stdin with right id.** Call `respondPermission('pr2', 'allow')`. Assert one write captured with parsed JSON `{ type: 'control_response', request_id: 'pr2', decision: 'allow' }`.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement**

- Add `const permissionCallbacks: Array<(r: AgentPermissionRequest) => void> = [];`.
- In `emitMessage`, at the top: if `payload?.type === 'control_request' && payload?.subtype === 'permission_request'`, build `AgentPermissionRequest`, iterate `permissionCallbacks`, `return` (don't also emit as normal message).
- Replace `onPermissionRequest`: push + splice-on-dispose.
- `respondPermission(requestId, decision, payload?)`: if `!child?.stdin.writable` return. Build `{ type: 'control_response', request_id: requestId, decision }`, attach `input: payload` if defined, write `JSON.stringify(obj) + '\n'` (fire-and-forget).

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): ClaudeCliEngine permission round-trip via control_response"`

---

## Task 7: `interrupt()` (TDD)

**Files:**
- Modify: `electron/__tests__/agents/claude-cli-engine.test.ts`
- Modify: `electron/services/agents/claude-cli-engine.ts`

- [ ] **Step 1: Append RED test**

`interrupt() writes a control_request:interrupt to stdin`. After `start()`, `await engine.interrupt()`. Assert one write captured with `{ type: 'control_request', subtype: 'interrupt', request_id: <some-string> }`.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement**

`async interrupt()`: if `!child?.stdin.writable` return. Build `{ type: 'control_request', subtype: 'interrupt', request_id: \`int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}\` }`. Promise-wrap a stdin write.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): ClaudeCliEngine.interrupt via control_request"`

---

## Task 8: `close()`, `kill()`, `onExit`, `onError` (TDD)

**Files:**
- Modify: `electron/__tests__/agents/claude-cli-engine.test.ts`
- Modify: `electron/services/agents/claude-cli-engine.ts`

- [ ] **Step 1: Append three RED tests**

1. **onExit fires when child emits exit.** Emit `'exit'` (0, null); assert callback received `{ code: 0, signal: null }`.
2. **onError fires on stderr lines.** Push `'connection refused\n'`; assert callback received `Error` with message containing `'connection refused'`.
3. **close() sends SIGTERM and is idempotent.** Call `await engine.close()` twice; assert `kill` called exactly once.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement**

- Add `const exitCallbacks: Array<(info: AgentEngineExit) => void> = [];` and `const errorCallbacks: Array<(err: Error) => void> = [];`.
- `wireStderr(stderr)`: line-buffer chunks, for each non-empty line construct `new Error(line)` and iterate `errorCallbacks`.
- In `start()` after spawn: call `wireStderr(child.stderr)`, register `child.on('exit', (code, signal) => { for (const cb of exitCallbacks) try { cb({ code: code ?? -1, signal }); } catch {} })`.
- Replace `onError`/`onExit` push/splice.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): ClaudeCliEngine onExit/onError + idempotent close"`

---

## Task 9: Restart-on-stream-death — make `start()` re-entrant (TDD)

**Files:**
- Modify: `electron/__tests__/agents/claude-cli-engine.test.ts`
- Modify: `electron/services/agents/claude-cli-engine.ts`

- [ ] **Step 1: Append RED test**

`start() is re-entrant — second call with resumeSessionId spawns a fresh child with --resume`. Set up two fakes in sequence. First `start()` with no resume; push `system:init` with `session_id: 'sess-rs'`; emit `'exit'` (1, null). Second `start()` with `resumeSessionId: engine.getResumeId() ?? undefined`. Assert spawn called twice, second call's args contain `--resume` and `'sess-rs'`.

- [ ] **Step 2: Verify RED or GREEN**

If GREEN already (likely — `start()` re-runs body), keep the test for regression. If RED, fix.

- [ ] **Step 3: Make `start()` re-entrant**

At top of `start()`, before any spawn: if `child !== null`, try `child.kill('SIGTERM')` (swallow throws), set `child = null`. Reset `lineBuf = ''` so re-spawn doesn't see stale partial data.

- [ ] **Step 4: Verify GREEN + Commit**

`git commit -m "feat(agents): make ClaudeCliEngine.start re-entrant for restart-on-error"`

---

## Task 10: Wire engine into `SessionHandle` + replace SDK call in lifecycle.ts

**Files:**
- Modify: `electron/services/sessions/types.ts`
- Modify: `electron/services/sessions/lifecycle.ts`
- Modify: `electron/__tests__/sessions.test.ts`

- [ ] **Step 1: Add `engine` field to SessionHandle**

In `electron/services/sessions/types.ts`, inside `SessionHandle`:

`engine: import('../agents/types').AgentEngine | null;`

Comment: "Drives the live session. Null only during the brief gap between handle construction and engine spawn (e.g., TUI cold-start)."

Also, the existing `query` field on `SessionHandle` is going away — mark it deprecated for now; final removal happens in Task 11 when `runtime.ts` stops referencing it.

- [ ] **Step 2: Write failing test for engine selection**

In `electron/__tests__/sessions.test.ts` add `start() spawns a ClaudeCliEngine`:

1. `vi.spyOn` `createClaudeCliEngine` from the agents module.
2. Call `svc.start({ tabId, projectPath, configDir, model, permissionMode })`.
3. Assert the spy was called once with the right tabId.
4. Assert the handle's `query` field is null (no SDK call) — verify via a getter or the existing inspector method.

- [ ] **Step 3: Verify RED**

- [ ] **Step 4: Replace the SDK call in lifecycle.ts**

In `lifecycle.ts`:
- Add imports: `createClaudeCliEngine` from `'../agents/claude-cli-engine'`, type `AgentEngine` from `'../agents/types'`.
- Delete the `startup()` call and the SDK option-building block in `start()` (the block that constructs `sdkOptions`, registers SDK hooks, builds `inputChannel`, etc.).
- Replace it with: create `engine = createClaudeCliEngine({ tabId })`, then `await engine.start({ projectPath, configDir, model, permissionMode, resumeSessionId })`. Store `engine` on the handle.
- Wire `engine.onPermissionRequest(...)` into the existing permission-pending queue (search for where `canUseTool` pushes today, mirror).
- Delete the SDK-specific helpers no longer referenced: `sdkOptions` builder, `canUseTool` adapter, anything in `lifecycle.ts` that exists only to feed `startup()`.
- The `restartQuery` exported from `runtime.ts` still references the SDK. Update its body to call `engine.start({ ..., resumeSessionId: handle.sessionId })` instead — or move it inline since the engine handles restart natively.

- [ ] **Step 5: Verify GREEN — all session tests pass**

`npm test -- electron/__tests__/sessions.test.ts electron/__tests__/sessions-account-resolution.test.ts electron/__tests__/sessions-tui-coldstart.test.ts` → green.

`electron/__tests__/permission-persistence.test.ts` will fail — it still mocks `query`/`startup`. Leave it failing for Task 12.

- [ ] **Step 6: Commit**

`git commit -m "feat(sessions): replace SDK startup() with ClaudeCliEngine in lifecycle.ts"`

---

## Task 11: Drive `handle.engine` from runtime.ts; delete SDK iterator loop

**Files:**
- Modify: `electron/services/sessions/runtime.ts`
- Modify: `electron/services/sessions/types.ts`

- [ ] **Step 1: Rewrite `listenToMessages` to drive the engine**

In `electron/services/sessions/runtime.ts`, rewrite `listenToMessages(tabId, handle, deps)`:

- Destructure `{ sendToRenderer, notificationHooks, rateLimitHook }` from deps.
- `const engine = handle.engine!;` (the only valid state).
- Subscribe `engine.onMessage((agentMsg) => { ... })`:
  - `const message = agentMsg.payload as any;`
  - `const event = classifyRuntimeEvent(message);`
  - `(message as any).receivedAt = agentMsg.receivedAt;`
  - Switch on `event.kind` with the same transitions the SDK loop used:
    - `'init'` → if `event.sessionId`, set `handle.sessionId`; `setStatus(handle, { sessionStatus: 'started', conversationStatus: 'idle' }, ...)`; call `ensureJsonlTail()` (hoist to module-scope helper).
    - `'rateLimit'` → fire `rateLimitHook(handle.configDir, event.info)` (try/catch); set `conversationStatus: 'running'`.
    - `'compact'` / `'turn'` → set `conversationStatus: 'running'`.
    - `'streamEvent'` → no-op.
    - `'result'` → handled after renderer dispatch.
  - Always: `sendToRenderer(\`claude-output:${tabId}\`, message);`
  - If `event.kind === 'result'`: call `dispatchResultNotification({ ... })`, then `setStatus(handle, { conversationStatus: 'idle' }, ...)`.
- Subscribe `engine.onError((err) => { ... })`:
  - If `handle.mode === 'tui'`, return.
  - StrictMode/identity-replace guard: if `sessions.get(tabId) !== handle`, return.
  - `setStatus(handle, { sessionStatus: 'error' }, ...)`.
  - `sendToRenderer(\`claude-error:${tabId}\`, err.message)`.
  - `sendToRenderer(\`claude-complete:${tabId}\`)`.
- Subscribe `engine.onExit(() => { ... })`:
  - If `handle.mode === 'tui'`, return.
  - If `sessions.get(tabId) !== handle`, return.
  - `setStatus(handle, { sessionStatus: 'stopped' }, ...)`.
  - `sendToRenderer(\`claude-complete:${tabId}\`)`.
  - `sessions.delete(tabId)`.
- Return a Promise that resolves when `onExit` fires (store resolve fn at top, call inside onExit subscriber).

The function no longer references `handle.query`, `handle.inputChannel`, or any SDK type.

- [ ] **Step 2: Hoist `ensureJsonlTail()` to module scope**

The current `listenToMessages` has the JSONL-tail wiring as inner closures. Hoist `ensureJsonlTail(handle, sendToRenderer)` and `teardownJsonlTail(state)` to module-scope helpers. Behavior identical: tail starts when sessionId is first known, stops on exit/error/identity-replace.

- [ ] **Step 3: Delete the old SDK iterator body**

Everything in the old `for await (const message of handle.query)` block and its catch is gone. The new function above is the entirety of the runtime.

- [ ] **Step 4: Delete `restartQuery` if dead**

If `restartQuery` is no longer called (the engine restarts itself on stream death), delete it. Otherwise update it to call `engine.start({ ..., resumeSessionId: handle.sessionId })`.

- [ ] **Step 5: Remove `query` and `inputChannel` fields from SessionHandle**

In `electron/services/sessions/types.ts`, delete `query` and `inputChannel` from `SessionHandle`. Delete `sdkOptions` if present. Remove SDK type imports.

- [ ] **Step 6: Verify**

`npm run check` → clean. `npm test -- electron/__tests__/sessions.test.ts` → green. Permission-persistence still failing — Task 12.

- [ ] **Step 7: Commit**

`git commit -m "feat(sessions): drive runtime from AgentEngine, delete SDK iterator loop"`

---

## Task 12: Rewrite `permission-persistence.test.ts` to use the engine

**Files:**
- Modify: `electron/__tests__/permission-persistence.test.ts`

The test currently mocks `query` and `startup` from the SDK. After Tasks 10–11 it's red because those calls are gone.

- [ ] **Step 1: Rewrite mocks**

Replace the SDK mock with a mock of `createClaudeCliEngine`. Construct a `FakeEngine` object implementing `AgentEngine` with test-affordance methods to push messages, push permission requests, and trigger exit/error.

`vi.mock('../services/agents/claude-cli-engine', () => ({ createClaudeCliEngine: vi.fn() }));`

In each test's beforeEach, `mockedCreate.mockImplementation(() => makeFakeEngine())`.

`makeFakeEngine()` returns an object with `start: async () => {}`, `send: async () => {}`, `respondPermission: vi.fn()`, `interrupt`, `close`, `kill`, `getResumeId` (returning a closure-stored sessionId), `onMessage(cb)`/`onPermissionRequest(cb)`/`onError(cb)`/`onExit(cb)` (returning Disposables; cb stored in arrays for test push). Also expose helpers `pushMessage(payload)` (loops through onMessage callbacks emitting a wrapped AgentMessage) and `pushPermissionRequest(req)`.

- [ ] **Step 2: Update assertion shape**

Where the test previously asserted on SDK option capture (`fake.getCapturedOptions()`), assert on the engine factory call instead: `expect(createClaudeCliEngine).toHaveBeenCalledWith({ tabId: '...' })` and `expect(fakeEngine.start).toHaveBeenCalledWith(expect.objectContaining({ projectPath, configDir, model, permissionMode }))`.

- [ ] **Step 3: Verify GREEN + Commit**

`npm test -- electron/__tests__/permission-persistence.test.ts` → green.

`git commit -m "test(permission-persistence): mock AgentEngine instead of SDK query/startup"`

---

## Task 13: Rewrite `summary-query.ts` as one-shot CLI invocation

**Files:**
- Modify: `electron/services/sessions/summary-query.ts`
- Create: `electron/__tests__/summary-query.test.ts`

- [ ] **Step 1: Inspect current exports**

`cat electron/services/sessions/summary-query.ts` — preserve every exported symbol (at minimum `encodeProjectKey` is consumed by `runtime.ts`).

- [ ] **Step 2: Write failing test**

Create `electron/__tests__/summary-query.test.ts`. Mock the same subprocess primitive the engine uses; mock `findSystemClaudeBinary`.

Test `generateSummary({ transcript, projectPath, configDir, model })`:
- Fake subprocess writes `JSON.stringify({ type: 'result', subtype: 'success', result: 'A short summary.' })` to stdout, emits `'exit'` (0, null) next microtask.
- Assert result is `'A short summary.'`.
- Assert spawn args contain `-p`, `--output-format`, `'json'`.

- [ ] **Step 3: Verify RED**

- [ ] **Step 4: Replace the body**

`export async function generateSummary(p): Promise<string>`:

- Resolve binary via `findSystemClaudeBinary()` (throw if null).
- `prompt = \`Summarize this conversation in one short sentence:\n\n${p.transcript}\``.
- `args = ['-p', prompt, '--output-format', 'json']`; if `p.model` append `'--model', p.model`.
- Spawn with `cwd: p.projectPath`, `env: { ...process.env, CLAUDE_CONFIG_DIR: p.configDir }`, `stdio: ['ignore', 'pipe', 'pipe']`.
- Collect stdout + stderr into strings.
- On `'exit'`: if non-zero reject with `\`claude -p exited ${code}: ${stderr.trim()}\``. Else `JSON.parse(stdout)` and resolve `String(obj?.result ?? '').trim()`. On parse failure reject with `\`claude -p returned non-JSON: ${stdout.slice(0, 200)}\``.

Preserve `encodeProjectKey` and any other exports.

- [ ] **Step 5: Verify GREEN + Commit**

`git commit -m "refactor(sessions): summary-query uses claude -p instead of SDK query()"`

---

## Task 14: Rename `mode: 'sdk' | 'tui'` → `mode: 'rich' | 'tui'`

**Files:**
- Modify: `electron/services/sessions/types.ts`
- Modify: `electron/services/sessions/lifecycle.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/components/ClaudeCodeSession.tsx`
- Modify: `src/components/NewSessionForm.tsx`
- Modify: `src/hooks/useSessionLifecycle.ts`
- Modify: `src/components/SessionModeToggle.tsx`
- Modify: tests asserting the literal `'sdk'`

IPC payload `{ mode: 'sdk' | 'tui' }` is internal — one-shot rename is safe.

- [ ] **Step 1: Update type**

`export type SessionMode = 'rich' | 'tui';` in both `electron/services/sessions/types.ts` and `src/lib/api.ts`.

- [ ] **Step 2: Replace literals**

`git grep -n "'sdk'" electron/ src/` and `git grep -n '"sdk"' electron/ src/`. Replace each. Pay attention to:
- `sessionStartMode: SessionMode = 'sdk'` → `'rich'`
- IPC payload literals in `session-mode:` event sends
- Test assertions

- [ ] **Step 3: Relabel UI**

In `src/components/SessionModeToggle.tsx`, change button label `SDK` → `Chat`. Update tests asserting the label.

- [ ] **Step 4: Verify**

`npm run check && npm test` → green.

- [ ] **Step 5: Commit**

`git commit -am "refactor(sessions): rename mode 'sdk' -> 'rich' across main + renderer"`

---

## Task 15: Delete `electron/services/sessions/hooks.ts`

The CLI invokes user-defined hooks itself; SDK-shaped hook marshalling is dead code now.

- [ ] **Step 1: Find consumers**

```
git grep -n "from './hooks'" electron/services/sessions/
git grep -n "from '../services/sessions/hooks'" electron/
git grep -n "from '@/services/sessions/hooks'" electron/ src/
```

- [ ] **Step 2: Drop or relocate each consumer**

For each importer:
- SDK-only hook type imports → delete.
- OmniFex-internal hook-shaped subscribers (rate-limit hook, claude-output-extra carrier) → move inline into `lifecycle.ts` next to the engine's `onMessage` wiring.

- [ ] **Step 3: Delete the file**

`git rm electron/services/sessions/hooks.ts`

- [ ] **Step 4: Verify**

`npm run check && npm test` → clean.

- [ ] **Step 5: Commit**

`git commit -am "refactor(sessions): delete hooks.ts (CLI invokes user hooks natively)"`

---

## Task 16: Remove `@anthropic-ai/claude-agent-sdk` dependency

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `package-lock.json`
- Modify: `forge.config.ts`
- Modify: any pretest/rebuild script referencing the SDK

- [ ] **Step 1: Find remaining SDK imports**

```
git grep -n "@anthropic-ai/claude-agent-sdk" electron/ src/
```

If any imports remain after Tasks 10–15, fix them now — they're dead refs.

- [ ] **Step 2: Remove from package.json**

In `package.json`, remove `"@anthropic-ai/claude-agent-sdk": "..."` from `dependencies`.

- [ ] **Step 3: Update forge.config.ts**

In `forge.config.ts`, remove the SDK glob from `asar.unpack`. Current shape includes something like `**/@anthropic-ai/claude-agent-sdk-*/**` — delete that fragment, leaving the better-sqlite3 + node-pty entries intact.

- [ ] **Step 4: Update scripts**

Search `package.json` scripts for any reference to the SDK (rebuild, pretest, copy steps). Remove SDK references. Common spots: a `copyNativeModule` call in forge config; a `prestart` or `rebuild:electron` line listing the SDK.

- [ ] **Step 5: Reinstall**

```
npm uninstall @anthropic-ai/claude-agent-sdk
```

(Or edit `package.json` then `rm -rf node_modules package-lock.json && npm install`.) Verify the SDK is no longer in `node_modules`.

- [ ] **Step 6: Verify**

`npm run check && npm test && npm run build` → all green. No references to `@anthropic-ai/claude-agent-sdk` anywhere.

- [ ] **Step 7: Commit**

`git commit -am "chore(deps): remove @anthropic-ai/claude-agent-sdk — CLI engine is the only path"`

---

## Task 17: Verification gate

**Files:** none — runs commands.

- [ ] **Step 1: Full typecheck + build + tests + coverage**

`npm run check && npm run build && npm run test:coverage`

Expected: all green. New `electron/services/agents/` files should hit ≥80% line coverage.

- [ ] **Step 2: Confirm SDK is gone**

`git grep -n "@anthropic-ai/claude-agent-sdk"` → no matches.

`ls node_modules/@anthropic-ai/claude-agent-sdk 2>&1` → "No such file or directory".

- [ ] **Step 3: Manual smoke**

`npm run rebuild:electron`, then `ELECTRON_ENABLE_LOGGING=1 npm start 2>&1 | tee /tmp/omnifex-cli-engine.log`.

Checklist:
1. Open a project that resolves to a Claude account; start a new chat session.
2. Send a message; confirm the response streams in (live, partial messages render).
3. Trigger a tool that prompts for permission (e.g., a Bash command); confirm the dialog works in both directions (allow + deny).
4. Confirm subagent tasks appear in the TaskList panel — JSONL tail still works.
5. Confirm rate-limit indicator updates on a heavy turn.
6. Toggle Chat → Terminal → back; conversation memory persists.
7. Kill the session, reopen the project, resume; history reloads.
8. Check `/tmp/omnifex-cli-engine.log` for unexpected errors.

- [ ] **Step 4: Rebuild Electron ABI**

`npm run rebuild:electron`

- [ ] **Step 5: No commit from this task** — verification only. If anything fails, fix at the source task.

---

## Task 18: CHANGELOG + version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Bump version**

Patch bump in `package.json:4`.

- [ ] **Step 2: Add CHANGELOG entry**

Prepend above the most recent existing entry:

```
## [<new-version>] — YYYY-MM-DD

### Changed

- **Claude sessions now run on the `claude` CLI directly** (`<commit>`). The session engine moved off the `@anthropic-ai/claude-agent-sdk` runtime onto a subprocess running `claude --output-format stream-json --input-format stream-json`. Slash commands, plugins, `/model`, hooks defined in `~/.claude/settings.json`, MCP servers, and `/cost` now work identically to invoking `claude` directly. The renderer is unchanged — the on-wire message shape is the same. Resume, rate-limit tracking, subagent JSONL tail, and the Chat↔Terminal toggle all continue to work.
- **Toggle relabeled SDK→Chat** (`<commit>`). The mode toggle in the session header now reads "Chat / Terminal" since "SDK" no longer describes what's underneath.

### Removed

- **`@anthropic-ai/claude-agent-sdk` dependency** (`<commit>`). The SDK is gone from `package.json`, `node_modules`, forge `asar.unpack`, and pretest/rebuild scripts.
- **`electron/services/sessions/hooks.ts`** (`<commit>`). The CLI invokes user hooks natively; nothing for OmniFex to marshal.

### Notes

- Schema migration: new `agent` column on `sessions` and `path_rules` tables, defaulted to `'claude'` for every existing row. No data loss. Forward-compatible for Codex (Phase 3).
- Phase A of the SDK→CLI engine + Codex support plan. See `docs/superpowers/specs/2026-05-25-cli-engine-and-codex-design.md`. Phases 3 and 4 follow in separate releases.
```

Replace each `<commit>` with the short SHA from this plan's feature commits.

- [ ] **Step 3: Commit**

`git commit -am "chore: bump version to <new-version>"`

- [ ] **Step 4: Cut the release**

Run `/omnifex-release` (or invoke the skill manually).

---

## Self-review

- Spec coverage: the engine swap (spec §3, §5, §8) and SDK removal (spec §10 phase 2) are both covered by Tasks 1–18. Phases 3 and 4 are explicitly out of scope and have their own plans.
- Engine interface: defined in Task 2; every method tested in Tasks 3–9.
- Permission round-trip: Task 6 covers both directions.
- Restart on stream death: Task 9 (engine re-entrancy) + Task 11 (runtime calls `engine.start({ resumeSessionId })` on error).
- JSONL tail unchanged: Task 11 keeps the same helper; on-disk format unchanged.
- Renderer untouched: only the `'sdk' → 'rich'` rename + `SDK→Chat` label.
- Migration: Task 1 adds `agent` column with backfill default; forward-compatible for Phase 3.
- SDK fully removed: Task 16 deletes the dependency; Task 17 verifies no references remain.

---

## Follow-up phases (separate plans)

- **Phase 3 — Codex engine + agent-aware routing + Codex transcript.** New `CodexCliEngine` (JSON-RPC over stdio), `codex-binary.ts`, `CodexAuthService`, `OneShotTerminal`, agent picker in new-session dialog, `CodexTranscript` + per-item widgets, Codex auth UI, Codex session-list partition. Feature-flagged. Plan: `docs/superpowers/plans/2026-05-25-codex-engine-and-routing.md`.
- **Phase 4 — Claude re-auth affordance.** Detect needs-reauth, surface the chip button, wire `ClaudeAuthService.reauthenticate()` through the shared `runInteractiveCliFlow` primitive. Plan: `docs/superpowers/plans/2026-05-25-claude-reauth-recovery.md`.

---

**End of plan.**
