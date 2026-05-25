# Phase A — Plan Addendum: SDK Query Method Mapping

> **Companion to:** `docs/superpowers/plans/2026-05-25-claude-cli-engine-seam.md`.
> **Why:** The original plan addressed the SDK `for-await` loop and `startup()` call but did not address the 14 imperative `Query` methods (`setModel`, `accountInfo`, `mcpServerStatus`, …) that `electron/services/sessions/queries.ts` calls. This addendum maps each to its replacement and inserts the new tasks between the original Task 9 and Task 10.

---

## Research summary

We read `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` to find what each `Query` method actually puts on the CLI's stdin. Every method maps cleanly to one of two patterns:

**STREAM_JSON (9 methods)** — a `control_request` is written to stdin; the CLI replies with a `control_response` on stdout that we match back to the request by `request_id`:

| Query method | control_request subtype | Request params | Response shape |
|---|---|---|---|
| `interrupt()` | `interrupt` | — | `{ subtype:'success', request_id }` |
| `setModel(model)` | `set_model` | `{ model: string\|undefined }` | success |
| `setPermissionMode(mode)` | `set_permission_mode` | `{ mode: PermissionMode }` | success |
| `applyFlagSettings(settings)` | `apply_flag_settings` | `{ settings }` | success |
| `setMaxThinkingTokens(value)` | `set_max_thinking_tokens` | `{ max_thinking_tokens: number\|null }` | success |
| `getContextUsage()` | `get_context_usage` | — | `SDKControlGetContextUsageResponse` in `.response` |
| `mcpServerStatus()` | `mcp_status` | — | `{ mcpServers: McpServerStatus[] }` in `.response` |
| `reloadPlugins()` | `reload_plugins` | — | plugins/commands/agents/mcpServers in `.response` |
| `canUseTool` reply | (response side of `can_use_tool`) | — | `PermissionResult` body |

**LOCAL_ONLY (4 methods)** — read from cached `system:init` payload, zero wire traffic:

| Query method | Initialization-payload field |
|---|---|
| `accountInfo()` | `init.account` |
| `supportedCommands()` | `init.commands` |
| `supportedModels()` | `init.models` |
| `supportedAgents()` | `init.agents` |

Wire envelope, for reference:
- Request: `{ type: 'control_request', request_id: '<id>', request: { subtype: '<subtype>', ...params } }`
- Success response: `{ type: 'control_response', response: { subtype: 'success', request_id, response?: <payload> } }`
- Error response: `{ type: 'control_response', response: { subtype: 'error', request_id, error: '<msg>' } }`

(Note: the inner `request` / `response` envelope shape is what the SDK writes. The existing engine code in this branch already handles `control_request:permission_request` and `control_response` at the top level — that needs adjustment to match this nested shape. See Task 9b below.)

---

## New tasks inserted between Task 9 and Task 10

### Task 9a — Engine: `sendControlRequest(subtype, params)` with request/response correlation

**Files:**
- Modify: `electron/services/agents/types.ts`
- Modify: `electron/services/agents/claude-cli-engine.ts`
- Modify: `electron/__tests__/agents/claude-cli-engine.test.ts`

- [ ] **Step 1 — Add `sendControlRequest` to `AgentEngine`:**

```ts
sendControlRequest<T = unknown>(subtype: string, params?: Record<string, unknown>): Promise<T>;
```

- [ ] **Step 2 — TDD: request/response correlation**

Tests (RED → impl → GREEN):
1. `sendControlRequest writes a control_request with auto-generated id and resolves when matching control_response arrives`. Push a control_response with the same `request_id`; assert the awaited value matches `response.response`.
2. `concurrent in-flight requests resolve to the right promises`. Send two requests; reply out of order; assert each resolves to its matching payload.
3. `sendControlRequest rejects when control_response has subtype:'error'`. Push `{ type:'control_response', response:{ subtype:'error', request_id, error:'boom' } }`; assert rejection with `'boom'`.
4. `void responses (no payload) resolve to undefined`. For an `interrupt`-shaped reply with no `.response.response`, assert the promise resolves to `undefined`.

- [ ] **Step 3 — Implementation**

- Closure state: `let nextReqId = 1;`, `const pending = new Map<string, { resolve, reject }>();`.
- `sendControlRequest(subtype, params)`: build `id = \`req-${++nextReqId}-${Date.now()}\``, build `{ type:'control_request', request_id:id, request:{ subtype, ...params } }`, write+newline, return promise stored in `pending`.
- In `emitMessage`, at the top (before permission_request branch), add:
  ```
  if (payload.type === 'control_response' && payload.response?.request_id) {
    const entry = pending.get(payload.response.request_id);
    if (entry) {
      pending.delete(payload.response.request_id);
      if (payload.response.subtype === 'error') entry.reject(new Error(payload.response.error));
      else entry.resolve(payload.response.response);
    }
    return;
  }
  ```

- [ ] **Step 4 — Refactor existing `interrupt()` to use the new primitive**

`async interrupt(): Promise<void> { await sendControlRequest('interrupt'); }`. Update the interrupt test to push a `control_response` reply.

- [ ] **Step 5 — Commit**

`feat(agents): control_request/response correlation in ClaudeCliEngine`

---

### Task 9b — Engine: capture init-payload cache (account/commands/models/agents)

**Files:**
- Modify: `electron/services/agents/types.ts`
- Modify: `electron/services/agents/claude-cli-engine.ts`
- Modify: `electron/__tests__/agents/claude-cli-engine.test.ts`

- [ ] **Step 1 — Add `InitData` type + `getInitData(): InitData | null` to the engine**

```ts
export interface InitData {
  account?: unknown;        // AccountInfo (kept opaque at engine layer)
  commands?: unknown[];     // SlashCommand[]
  models?: unknown[];       // ModelInfo[]
  agents?: unknown[];       // AgentInfo[]
}
```

- [ ] **Step 2 — TDD**

`engine captures account/commands/models/agents from system:init for getInitData()`. Push `{type:'system', subtype:'init', session_id:'s', account:{...}, commands:[...], models:[...], agents:[...]}`. Assert `engine.getInitData()` returns the four arrays/objects.

- [ ] **Step 3 — Implementation**

In `emitMessage`, when handling system:init, populate `initData = { account, commands, models, agents }` alongside the existing `sessionId` capture. Add `getInitData(): InitData | null` returning the cached object (or null pre-init).

- [ ] **Step 4 — Commit**

`feat(agents): cache init payload (account, commands, models, agents) for getInitData()`

---

### Task 9c — Engine: `respondPermission` envelope correction

**Files:**
- Modify: `electron/services/agents/claude-cli-engine.ts`
- Modify: `electron/__tests__/agents/claude-cli-engine.test.ts`

The current implementation writes `{ type:'control_response', request_id, decision }` flat. The SDK source shows the CLI expects the nested envelope `{ type:'control_response', response:{ subtype:'success', request_id, response: <PermissionResult> } }` where the permission result body looks like `{ behavior:'allow'|'deny', updatedInput?, updatedPermissions?, toolUseID, decisionClassification? }`.

- [ ] **Step 1 — Update tests + implementation to the nested envelope.**

The control_response writer becomes a generic helper used by both `respondPermission` and the new `sendControlRequest`-driven success path. Specifically for permissions, the inner payload is a `PermissionResult` shape; we wrap `decision`+`updatedInput` accordingly.

- [ ] **Step 2 — Update test: `respondPermission ships a nested control_response on stdin`** to assert the nested shape.

- [ ] **Step 3 — Commit**

`fix(agents): nest control_response inside the SDK's request envelope`

---

## Tasks 10–18 — updates

### Task 10 — Wire engine into `SessionHandle` + lifecycle.ts

No changes from original plan **except**:
- `SessionHandle` gets a new field `initData: import('../agents/types').InitData | null` populated from `engine.getInitData()` on first system:init. (Convenience cache so `queries.ts` doesn't have to call `engine.getInitData()` every time.)

### **NEW** Task 10b — Rewrite `queries.ts` to drive the engine

**Files:**
- Modify: `electron/services/sessions/queries.ts`
- Modify: existing tests for queries (if any) or add new ones if missing.

For each method, replace the `handle.query.<m>()` call as follows:

| Method | Replacement |
|---|---|
| `interrupt(tabId)` | `await handle.engine.sendControlRequest('interrupt')` |
| `setModel(tabId, model)` | `await handle.engine.sendControlRequest('set_model', { model })` |
| `setPermissionMode(tabId, mode)` | `await handle.engine.sendControlRequest('set_permission_mode', { mode })` |
| `setEffort(tabId, level)` | `await handle.engine.sendControlRequest('apply_flag_settings', { settings: { effortLevel: level ?? undefined } })` |
| `applyPermissions(tabId, p)` | `await handle.engine.sendControlRequest('apply_flag_settings', { settings: { permissions: p } })` |
| `setThinking(...)` | `await handle.engine.sendControlRequest('set_max_thinking_tokens', { max_thinking_tokens: 0 \| null })` |
| `getAccountInfo(tabId)` | `(handle.engine.getInitData()?.account as AccountInfo) ?? null` |
| `getContextUsage(tabId)` | `await handle.engine.sendControlRequest('get_context_usage')` |
| `getSupportedCommands(tabId)` | `(handle.engine.getInitData()?.commands as SlashCommand[]) ?? []` |
| `getSupportedModels(tabId)` | `(handle.engine.getInitData()?.models as ModelInfo[]) ?? []` |
| `getSupportedAgents(tabId)` | `(handle.engine.getInitData()?.agents as AgentInfo[]) ?? []` |
| `getMcpServerStatus(tabId)` | `((await handle.engine.sendControlRequest<{mcpServers:McpServerStatus[]}>('mcp_status')).mcpServers)` |
| `getPlugins(tabId, force)` | `await handle.engine.sendControlRequest('reload_plugins')` (cache logic unchanged) |

Existing error handling (try/catch + console.error + user-facing notifications) stays.
Existing TUI-mode guard (`if (!handle.query) return`) becomes `if (handle.mode === 'tui') return` — TUI handles still have an engine but it isn't driving the live conversation; treat its control_requests as no-ops.

The SDK type imports (`AccountInfo`, `ModelInfo`, etc.) stay until Task 16; for now they live as type-only imports.

- [ ] Verify GREEN; commit `refactor(sessions): queries.ts uses engine.sendControlRequest + getInitData`.

### Task 11 — Drive `handle.engine` from runtime.ts

No changes from original plan.

### Task 12 — Rewrite `permission-persistence.test.ts`

No changes from original plan, except `FakeEngine` now needs to implement `sendControlRequest` and `getInitData` to satisfy the wider interface.

### Tasks 13–18 — no changes.

---

## Updated overall ordering

```
Task 1   ✓ (committed)  Schema migration
Task 2   ✓ (committed)  AgentEngine interface
Task 3   ✓ (committed)  spawn skeleton
Task 4   ✓ (committed)  NDJSON line buffer
Task 5   ✓ (committed)  send()
Task 6   ✓ (committed)  permission round-trip
Task 7   ✓ (committed)  interrupt()
Task 8   ✓ (committed)  close/kill/onExit/onError
Task 9   ✓ (committed)  re-entrant start()
─── ADDENDUM TASKS ───
Task 9a  (new)          sendControlRequest + correlation
Task 9b  (new)          init-payload cache + getInitData
Task 9c  (new)          respondPermission envelope correction
─── ORIGINAL PLAN, AMENDED ───
Task 10                 lifecycle.ts wiring + handle.initData
Task 10b (new)          queries.ts rewrite
Task 11                 runtime.ts rewrite
Task 12                 permission-persistence test rewrite
Task 13                 summary-query.ts CLI rewrite
Task 14                 mode 'sdk' → 'rich' rename
Task 15                 delete hooks.ts
Task 16                 remove SDK dep
Task 17                 verification gate
Task 18                 CHANGELOG + version bump
```

---

## Open follow-ups (deferred from this phase)

- `applyFlagSettings` and `set_max_thinking_tokens` may have CLI-version-specific behavior on Opus 4.6+. Existing memory `reference_thinking_sdk_deprecation` already calls this out; behavior preservation is "best effort matching the SDK's no-op-on-newer-models semantics."
- `respondElicitation` for MCP server prompts is not in the queries.ts list above but is in `SessionsService`. It uses a separate elicitation control_request that the SDK exposes via `lifecycle.ts`. To verify during Task 10.
