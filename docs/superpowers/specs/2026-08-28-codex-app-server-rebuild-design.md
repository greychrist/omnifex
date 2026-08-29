# Codex Engine Rebuild on `codex app-server` — Design

**Date:** 2026-08-28
**Status:** Approved (Greg, 2026-08-28)
**Supersedes the transport half of:** `docs/superpowers/specs/2026-05-25-cli-engine-and-codex-design.md`
**Plan:** `docs/superpowers/plans/2026-08-28-codex-app-server-rebuild.md`

## 1. Problem

Codex sessions do not work at all against the installed `codex-cli 0.135.0`.
Three independent breakages, verified by probing the binary directly:

1. **The transport was removed.** `codex-cli-engine.ts` spawns `codex mcp`.
   In 0.135.0 `codex mcp` is *"Manage external MCP servers for Codex"* — it
   prints usage and exits 2. The agent server is now `codex app-server`
   (stdio by default); `codex mcp-server` is a separate, coarser MCP-tool
   interface.

   Because `spawn()` still succeeds, the failure presents as a hung
   `newConversation` handshake with no diagnostic — the worst possible
   failure shape.

2. **The method vocabulary was renamed wholesale.** app-server rejected
   `newConversation` and enumerated its real surface:

   | OmniFex sends | 0.135.0 app-server |
   |---|---|
   | `newConversation` | `thread/start` |
   | `resumeConversation` | `thread/resume` |
   | `sendUserTurn` | `turn/start` (+ `turn/steer`) |
   | `interruptConversation` | `turn/interrupt` |

   `applyPatchApproval` / `execCommandApproval` survive as legacy
   server-initiated requests alongside newer
   `item/{commandExecution,fileChange,permissions}/requestApproval`.

3. **The renderer dispatch table is stale.** `CodexTranscript.tsx` keys on
   `agent_message`, `item.exec_command`, `item.apply_patch`. The wire emits
   `item/started`, `item/completed`, `item/agentMessage/delta`,
   `turn/completed`. Every item would fall through to `CodexItemFallback`.

Two further defects sit behind those:

4. **Half the `AgentEngine` contract throws.** `applyExtendedPermissionMode`,
   `sendStructured` and `sendControlRequest` are `not yet wired`. This is not
   cosmetic: `models.ts:134` and `commands-catalog.ts:135` both call
   `sendControlRequest('initialize')`, so the model catalog and command
   catalog throw on any Codex tab.

5. **Multi-account Codex is half-built and self-contradictory.**
   `auth/codex-auth.ts` is fully per-account — login, watch and sign-out are
   all keyed by `configDir` as CODEX_HOME. The engine does the opposite:
   it strips `CLAUDE_CONFIG_DIR` and never sets `CODEX_HOME`
   (`codex-cli-engine.ts:126-129`), so every session runs against `~/.codex`
   no matter which Codex account is signed in. You can authenticate N
   accounts and use exactly one.

Newest Codex rollout on disk is 2026-05-31, so this has been dead roughly
three months without being noticed.

## 2. Goals

- Codex sessions start, stream, approve, interrupt and resume against
  `codex app-server` on codex-cli ≥ 0.135.0.
- Codex sessions are **account-scoped via `CODEX_HOME`**, closing the gap
  with `codex-auth.ts`.
- The renderer transcript renders real Codex items, keyed and updated in
  place rather than appended blind.
- Version drift is *detectable* rather than silently fatal.

## 3. Non-goals

- `thread/fork`, `thread/rollback`, realtime audio, review mode, plugins,
  skills, marketplace, `command/exec` PTY passthrough. The protocol exposes
  ~85 client methods; we wire the ~10 the `AgentEngine` contract needs.
- Codex TUI mode. Codex remains rich-mode only; `startTuiColdStart` stays
  Claude-only.
- Codex cost ingest. Codex rollouts are not priced by `cost-history.ts` and
  this change does not add that.
- Step 3 of `AccountsService.resolve()` (on-disk ownership) for Codex. It
  stays Claude-only — Codex has no `projects/<encoded>` layout, so the
  evidence does not exist. Codex resolution remains override → path rule →
  null.

## 4. Verified protocol facts

All confirmed against `codex-cli 0.135.0` on 2026-08-28 by driving the
binary, not from documentation.

**Handshake.** `initialize` → `initialized` (client *notification*, no id)
→ `thread/start`. Measured: initialize ~56ms, thread/start ~490ms.
`thread/start` returns `ThreadStartResponse` and separately emits a
`thread/started` notification plus a burst of
`mcpServer/startupStatus/updated`.

```
--> {"jsonrpc":"2.0","id":1,"method":"initialize",
     "params":{"clientInfo":{"name":"omnifex","title":"OmniFex","version":"0.4.146"},
               "capabilities":null}}
<-- {"id":1,"result":{"userAgent":"omnifex/0.135.0 (...)","codexHome":"/Users/…/.codex",
                      "platformFamily":"unix","platformOs":"macos"}}
--> {"jsonrpc":"2.0","method":"initialized"}
--> {"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"cwd":"…"}}
<-- {"id":2,"result":{"thread":{"id":"01a04b75-…","path":"…/sessions/2026/08/28/rollout-….jsonl",
                                "cwd":"…","status":{"type":"idle"},"turns":[]},
                      "model":"gpt-5.5","approvalPolicy":"on-request","reasoningEffort":…}}
<-- {"method":"thread/started","params":{"thread":{…}}}
```

**Responses omit the `jsonrpc` field.** The existing `json-rpc-client.ts`
already tolerates this — it keys on `hasOwnProperty('result'|'error')`.

**`CODEX_HOME` is honored.** Spawning with `CODEX_HOME=/tmp/codex-home-probe`
echoed `"codexHome":"/private/tmp/codex-home-probe"` in the initialize
result. Per-account routing is therefore viable with an env var alone.

**Thread id is the resume id.** `ThreadStartResponse.thread.id` is a UUIDv7
and `thread.path` is the rollout JSONL that `codex-session-walker.ts`
already discovers. `thread/resume` takes `{ threadId }`.

**Turn identity.** `turn/interrupt` requires **both** `threadId` and
`turnId`. `turnId` only arrives on the `turn/started` notification, so the
engine must track the in-flight turn to be able to interrupt at all.

**Items are a tagged union, not a method namespace.** `item/started` and
`item/completed` both carry `{ item: ThreadItem, threadId, turnId }`.
`ThreadItem.type` is one of: `userMessage`, `hookPrompt`, `agentMessage`,
`plan`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`,
`dynamicToolCall`, `collabAgentToolCall`, `webSearch`, `imageView`,
`imageGeneration`, `enteredReviewMode`, `exitedReviewMode`,
`contextCompaction`. Every item has a stable `id`.

**Model catalog is a first-class call.** `model/list` → `{ data: Model[] }`
where `Model` carries `id`, `displayName`, `description`,
`supportedReasoningEfforts`, `defaultReasoningEffort`, `isDefault`.

**Approval responses.** `ApplyPatchApprovalResponse` and
`ExecCommandApprovalResponse` are both `{ decision: ReviewDecision }`.

## 5. Design

### 5.1 Transport

`codex app-server` over stdio. Not `mcp-server` — the MCP surface exposes
only `codex` / `codex-reply` tools, which gives no per-item streaming, no
approval round-trip and no interrupt, and would strand every item renderer.

Spawn shape:

```ts
spawn(codexBinaryPath, ['app-server'], {
  cwd: params.projectPath,
  env: { ...process.env, CODEX_HOME: params.configDir },  // CLAUDE_CONFIG_DIR deleted
})
```

`CLAUDE_CONFIG_DIR` continues to be stripped. `CODEX_HOME` is now set from
`AgentStartParams.configDir`, which the engine currently ignores entirely.

### 5.2 Protocol types

Hand-write a narrow `electron/services/agents/codex-protocol.ts` covering
only what we consume (~15 types). We do **not** vendor the 80 generated
files — most describe surface we will never call, and a vendored dump rots
as silently as hand-written types while being much harder to review.

Regeneration for upgrade audits is a documented one-liner, not a build step:

```sh
codex app-server generate-ts --out /tmp/codex-proto
```

Drift is caught by a version watermark, not by types: `codex-binary.ts`
gains `SUPPORTED_CODEX_VERSION = '0.135.0'` and a `compareVersions` floor
check. A binary below the floor fails the session start with a specific
message instead of hanging. A binary *above* it is allowed but recorded, in
the same spirit as `REVIEWED_CLI_VERSION` in `claude-cli-review.ts`.

### 5.3 `AgentEngine` mapping

| `AgentEngine` member | app-server realization |
|---|---|
| `start()` cold | `initialize` → `initialized` → `thread/start { cwd, model, approvalPolicy, sandbox }` |
| `start()` resume | same handshake → `thread/resume { threadId, cwd }` |
| `send(text)` | `turn/start { threadId, input: [{ type:'text', text, text_elements: [] }] }` |
| `sendStructured(content)` | `turn/start` with Claude content blocks mapped to `UserInput[]` |
| `interrupt()` | `turn/interrupt { threadId, turnId }` using the tracked in-flight turn; no-op when idle |
| `applyExtendedPermissionMode(mode)` | stores the mapped `{ approvalPolicy, sandbox }` and applies it on the next `turn/start` (both are documented "this turn and subsequent turns" overrides) |
| `respondPermission()` | `respondToServer(originalId, { result: { decision } })` |
| `sendControlRequest(subtype, params)` | translated per §5.4 |
| `getResumeId()` | tracked `threadId` |
| `getInitData()` | `{ models }` from `model/list`, cached at start |

### 5.4 `sendControlRequest` translation

`sendControlRequest` is the cross-agent imperative surface
(`sessions/queries.ts`, `models.ts`, `commands-catalog.ts`). Codex answers
the subtypes it can and throws a **specific** `CodexUnsupportedControl`
error for the rest, so an unsupported control reports as a disabled UI
affordance rather than a generic failure.

| subtype | Codex |
|---|---|
| `initialize` | `model/list` → `{ models }` (feeds `models.ts` + a `commands: []` so `commands-catalog.ts` gets an empty catalog rather than an exception) |
| `set_model` | store override, applied on next `turn/start` |
| `set_permission_mode` | store mapped `{ approvalPolicy, sandbox }`, applied on next `turn/start` |
| `mcp_status` | `mcpServerStatus/list` mapped to `{ mcpServers }` |
| `get_context_usage` | last `thread/tokenUsage/updated` payload |
| `apply_flag_settings`, `set_max_thinking_tokens`, `reload_plugins` | throw `CodexUnsupportedControl` |

### 5.5 Permission-mode mapping

OmniFex's modes are Claude-shaped. Codex splits the same concern across
`approvalPolicy` (`untrusted` / `on-failure` / `on-request` / `never`) and
`sandbox` (`read-only` / `workspace-write` / `danger-full-access`). The
mapping is an approximation and is documented as one in the code:

| OmniFex mode | `approvalPolicy` | `sandbox` |
|---|---|---|
| `default` | `on-request` | `workspace-write` |
| `plan` | `untrusted` | `read-only` |
| `acceptEdits` | `on-failure` | `workspace-write` |
| `auto` / `dontAsk` | `never` | `workspace-write` |
| `bypassPermissions` | `never` | `danger-full-access` |

### 5.6 Renderer: keyed items, not an append-only list

`CodexTranscript` currently maps notifications 1:1 to cards with
`key={idx}`. The real protocol emits `item/started` → N deltas →
`item/completed` for the *same* `item.id`. Rendering that as an append-only
list would produce three cards per item.

New shape: a pure reducer, `src/lib/codexTranscriptModel.ts`, folding the
notification stream into an ordered `CodexItem[]` keyed by `item.id`:

- `item/started` — insert or replace by id, `status: 'running'`
- `item/completed` — replace by id, `status: 'complete'`
- `item/agentMessage/delta`, `item/reasoning/textDelta`,
  `item/reasoning/summaryTextDelta` — append text to the item's buffer
- `item/commandExecution/outputDelta`, `item/fileChange/outputDelta` —
  append to the item's output buffer
- `turn/started` / `turn/completed` / `thread/*` — status only, no card

Keeping it pure and separate from the component means it is unit-testable
against recorded fixtures, which is how the wire shapes get pinned.

The dispatch table then keys on `ThreadItem.type`, and the six existing
item components are re-pointed at the new item shape:

| `ThreadItem.type` | component |
|---|---|
| `agentMessage` | `AgentMessage.tsx` |
| `reasoning` | `AgentReasoning.tsx` |
| `commandExecution` | `ExecCommand.tsx` |
| `fileChange` | `ApplyPatch.tsx` |
| `webSearch` | `WebSearch.tsx` |
| `mcpToolCall` | `McpToolCall.tsx` |
| everything else | `CodexItemFallback.tsx` |

### 5.7 Account routing

Two changes:

1. The engine sets `CODEX_HOME` from `AgentStartParams.configDir` (§5.1).
2. **`main.ts:877` is currently a live bug waiting to happen.** The account
   re-resolver is hardcoded to the Claude slot:

   ```ts
   (projectPath) => accountsService.resolve(projectPath).claude?.account.config_dir ?? null
   ```

   On a Codex cold start this overwrites `configDir` with the *Claude*
   account's dir. Today that is harmless because the Codex engine discards
   `configDir`; the moment §5.1 lands it would point `CODEX_HOME` at
   `~/.claude-work`. The resolver signature becomes
   `(projectPath, engine) => string | null` and selects the matching slot.

Codex resolution stays override → path rule → `null`, per §3.

### 5.8 Two latent bugs fixed on the way

- **`json-rpc-client.ts` cannot send a notification.** `request()` always
  allocates an id, so sending `initialized` as a request would leave a
  promise pending forever — app-server never replies to notifications. Adds
  `notify(method, params?)`.
- **Approval ids are stringified and never mapped back.** The engine emits
  `requestId: String(id)` to the UI, then calls
  `respondToServer(requestId, …)` — sending a *string* id where the server
  sent a number. The server will not match it. The engine keeps a
  `pendingApprovals: Map<string, string|number>` and responds with the
  original id.

## 6. Testing

- `electron/__tests__/agents/codex-cli-engine.test.ts` — rewritten against a
  fake app-server over a pair of streams: handshake ordering
  (`initialize` before `initialized` before `thread/start`), `CODEX_HOME` in
  the spawn env, resume path, turn id tracking through interrupt, approval
  id round-trip preserving the numeric id, `sendControlRequest` translation
  and the `CodexUnsupportedControl` throw.
- `electron/__tests__/agents/codex-binary.test.ts` — version floor.
- `src/lib/__tests__/codexTranscriptModel.test.ts` — the reducer, against
  fixtures captured from a real 0.135.0 session.
- `electron/__tests__/sessions-account-resolution.test.ts` — the Codex slot
  reaches `CODEX_HOME`, and a Claude-slot-only project does not leak into a
  Codex session.
- Existing Codex component tests are updated to the new item shape rather
  than deleted; they are the only pinning we have on the renderers.

Coverage gate: 80% lines on everything under `electron/services/agents/`.

## 7. Risks

- **The protocol is explicitly experimental.** `codex app-server` is marked
  `[experimental]` in `--help`. It will move again. The version watermark
  plus a narrow type surface is the mitigation; there is no way to make this
  stable.
- **Approval routing has two generations on the wire** (legacy
  `applyPatchApproval` / `execCommandApproval` and newer
  `item/*/requestApproval`). We handle both; the newer set is the one likely
  to survive.
- **Personality / collab / realtime items will render as fallback cards.**
  Acceptable — the fallback is legible and the alternative is chasing a
  moving surface.
