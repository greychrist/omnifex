# SDK → CLI Engine + Codex Support — Design

> **Status:** Approved design. Implementation phased over several releases (see §10).
> **Authors:** Greg + Claude (brainstormed 2026-05-25).
> **Related:** Supersedes the SDK-based session engine. Builds on the SDK↔TUI mode work from v0.3.33.

## Goals

1. **Replace the `@anthropic-ai/claude-agent-sdk` runtime with the `claude` CLI** so OmniFex rides directly on whatever the real Claude Code does — slash commands, plugins, hooks, MCP servers, `/model`, settings semantics, all of it. No more waiting on the SDK to catch up with the CLI's surface.
2. **Add OpenAI Codex CLI** as a peer agent. Tabs are bound to either Claude or Codex at creation; the existing rich-chat renderer is the destination for both.
3. Keep the "beauty" of OmniFex's current rich-chat UX: tool widgets, permission dialogs, status FSM, multi-account isolation, JSONL-based session resume.
4. Keep TUI mode (raw pty + xterm) as an orthogonal axis available to both agents.

## Non-Goals

- Cross-agent conversation switching mid-session. Agent is immutable per tab.
- Codex multi-account in v1. Single `~/.codex/` only; schema is forward-compatible for accounts later.
- Native OAuth for either agent. Auth flows shell out to `claude /login` / `codex login` inside an in-app terminal modal.
- Custom event-vocabulary normalization between agents. Each agent's transcript renders its own native message shapes.
- Replacing the existing "browse to an existing CLAUDE_CONFIG_DIR" account-add UX. (We add a re-auth affordance for stale credentials, nothing more.)
- Cross-agent feature parity in the *renderer*. Codex gets a transcript built for `codex mcp` events; it does not pretend to be Claude.

## Architectural Overview

A new `electron/services/agents/` module owns the engine abstraction and the two concrete implementations. The existing `electron/services/sessions/` keeps lifecycle/status/JSONL-tail/notifications/subagent-tracking — it just stops importing the SDK and instead drives an opaque `AgentEngine`.

```
electron/services/
  agents/
    engine.ts              # AgentEngine interface + AgentMessage union + AgentPermissionRequest
    claude-engine.ts       # spawns `claude --output-format stream-json --input-format stream-json`
    codex-engine.ts        # spawns `codex mcp`
    json-rpc-client.ts     # small JSON-RPC over stdio helper used by codex-engine
    codex-binary.ts        # binary discovery, mirror of claude-binary.ts
  sessions/                # lifecycle, status, jsonl-tail, notifications — engine-agnostic
  auth/
    claude-auth.ts         # re-auth detection + pty login flow
    codex-auth.ts          # status + pty login flow
```

### The `AgentEngine` interface

```ts
export type AgentKind = 'claude' | 'codex';

export interface AgentEngine {
  readonly kind: AgentKind;
  start(params: AgentStartParams): Promise<void>;
  send(input: AgentMessageInput): Promise<void>;
  respondPermission(requestId: string, decision: 'allow' | 'deny', payload?: unknown): void;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  kill(): void;
  getResumeId(): string | null;
  onMessage(cb: (msg: AgentMessage) => void): Disposable;
  onPermissionRequest(cb: (req: AgentPermissionRequest) => void): Disposable;
  onExit(cb: (info: { code: number; signal?: string }) => void): Disposable;
}
```

`AgentMessage` is a **discriminated union with an `agent` tag**. Claude messages keep their existing `SDKMessage`-shaped payload (so the current transcript renders them unchanged); Codex messages carry their native `items[]` and reasoning summaries. The shared envelope only normalizes routing metadata (`tabId`, `receivedAt`, `sessionId`, message direction). **No content normalization** — each transcript renders its own native shapes.

`AgentPermissionRequest` is the one point of genuine normalization, because both engines need the same UX:

```ts
export interface AgentPermissionRequest {
  agent: AgentKind;
  requestId: string;
  kind: 'tool' | 'patch' | 'exec';
  summary: string;        // short headline for the dialog
  payload: unknown;       // agent-native body for the diff/preview rendering
}
```

The shared permission dialog branches on `kind` + `agent` for the right preview. The handler returns `'allow' | 'deny'` + optional payload; each engine knows how to ship the response back to its CLI.

### Per-handle structure

`SessionHandle` (in `sessions/types.ts`) replaces its `query: Query` field with `engine: AgentEngine`. The `mode: 'sdk' | 'tui'` field is renamed `mode: 'rich' | 'tui'` (since the rich side is no longer SDK-backed). The handle gains `agent: AgentKind` so anyone holding a handle knows which engine is inside.

## Agent identity & routing

### Schema

Two migrations on `database.ts`:

```sql
ALTER TABLE sessions ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE path_rules ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude';
-- account_id already exists on path_rules; it stays NULL for Codex rules in v1.
```

Default-fills on backfill: every existing row becomes `'claude'`. No data is lost.

### Routing

`AccountsService.resolve()` grows a parallel `resolve()` that returns `{ agent, account }` for a project path, using the same longest-prefix-wins logic. The resolution order remains:

1. Explicit project override (now `{ agent, account_id }`)
2. Longest matching path rule (now `{ agent, account_id }`)
3. `null`

When the resolver returns `null`, the existing account-picker dialog gains an agent picker at the top: **Which agent?** → Claude / Codex; then, if Claude, **Which account?**. For Codex, no account picker (single account in v1).

### Tab and session state

`TabContext` adds `agent: AgentKind` to its tab record. Once set on tab creation, the agent is immutable for the tab's life. The new-session DB row (and the session-list walker output) all carry `agent`.

### Header chip

`SessionHeader` grows a small agent indicator next to the account chip — a Claude logo for Claude tabs, an OpenAI badge for Codex tabs. Hover/click opens the same dialog that today picks an account; clicking is gated by "tab has no in-flight conversation."

## Claude engine internals

### Subprocess

```
claude --output-format stream-json \
       --input-format stream-json \
       --include-partial-messages \
       [--resume <sessionId>] \
       [--model <model>] \
       [--permission-mode <mode>] \
       [--allowed-tools …]
```

Spawned with `cwd = projectPath`, `env.CLAUDE_CONFIG_DIR = configDir`. Binary path resolution reuses the existing `claude-binary.ts` discovery chain (per-account override → user-configured global → `which claude` → bundled fallback).

Anything the SDK could configure (model, permission mode, allowed tools, MCP servers, hooks dir), the CLI configures via flags or the user's settings file. This is the surface the SDK was wrapping; the SDK was not adding capability on top.

### Output parsing

NDJSON line-by-line off stdout. Each line is a JSON message in the same shape the SDK previously yielded (`type: 'assistant' | 'user' | 'system' | 'result' | 'stream_event'`, etc.). That's *why* the existing transcript doesn't need to change. A small line-buffer (carried-over from any partial-read at end-of-chunk) is the only new logic.

Stderr is captured separately and surfaced as `agent-error:` events (renamed from `claude-error:` in phase 3).

### Input

User messages are written to stdin as stream-json:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]},"parent_tool_use_id":null,"session_id":"…"}
```

…followed by `\n`. A small write-queue serializes writes so an interrupted turn doesn't interleave.

### Permission protocol

The CLI's stream-json mode emits:

```json
{"type":"control_request","subtype":"permission_request","tool_name":"…","input":{…},"request_id":"…"}
```

…whenever the SDK would have invoked `canUseTool`. The engine translates that into a normalized `AgentPermissionRequest` and emits `onPermissionRequest`. The renderer's existing permission dialog (in shared chrome) is unchanged. The decision goes back on stdin:

```json
{"type":"control_response","request_id":"…","decision":"allow","input":{…}}
```

### Hooks

`PreToolUse` / `PostToolUse` / `Notification` hooks already live in the user's settings file and are invoked by the CLI itself — no longer through the SDK's `hooks` option. This is a feature: the user's own `~/.claude-personal/settings.json` hooks (or per-project ones) now run identically in OmniFex and in real `claude`. The current `electron/services/sessions/hooks.ts` is deleted; OmniFex's own internal hook-shaped concerns (rate-limit tracking, claude-output-extra carriers) re-express as direct subscribers on the message stream or JSONL tail.

### Resume

`--resume <session_id>` is identical to the SDK's `resume` option. On stream death the engine restarts with `--resume engine.getResumeId()`, the same logic that's in `runtime.ts:245-268` today, just delegated to the engine.

### Subagents / JSONL tail

Unchanged. The CLI writes the same JSONL to `<configDir>/projects/<encoded-projectPath>/<sessionId>.jsonl` and the existing `jsonl-tail.ts` still surfaces background-Bash queue-operation carriers and queued_command attachments.

### Interrupt

ESC during a turn → engine writes `{ "type": "control_request", "subtype": "interrupt", "request_id": "…" }` to stdin. The current SDK has `query.interrupt()`; the stream-json mode exposes the same primitive over the wire.

## Codex engine internals

### Subprocess

```
codex mcp
```

Spawned with `cwd = projectPath`, `env = process.env` (no `CODEX_HOME` override in v1; the user's `~/.codex/` is the only home). Binary resolution mirrors `claude-binary.ts` — a new `codex-binary.ts` with per-user override → `which codex` → "not installed" error surfaced as a banner in the new-session dialog with a link to install docs.

### Protocol

`codex mcp` speaks JSON-RPC 2.0 over stdio. The engine wraps it with three concerns, all implemented in a small `JsonRpcClient` (~80 lines, isolated, fully unit-testable with a mock duplex):

1. **Request/response correlation.** Each outgoing call gets an incrementing `id`; pending promises keyed by id resolve when the matching response arrives.
2. **Server-initiated requests** (`applyPatchApproval`, `execCommandApproval`). The engine surfaces these as `AgentPermissionRequest` with `kind: 'patch'` or `kind: 'exec'` and remembers each one's JSON-RPC `id` so `respondPermission` can ship the `{ decision: 'allow' | 'deny' }` reply on the right id.
3. **Notifications** (`codex/event`-family: `agent_message`, `agent_reasoning`, `item.*`, `task_started`, `task_complete`, `error`). These flow through `onMessage` as `AgentMessage` with `agent: 'codex'` and a `payload` field carrying the raw notification.

### Conversation lifecycle

On `start()` the engine sends `newConversation` (or `resumeConversation` if `params.sessionId` is set) with the configured model, sandbox policy, approval policy, reasoning effort, and personality. The server returns a `conversationId` which becomes `handle.sessionId`. On `send()`, the engine sends `sendUserTurn` with the new user text; `task_started` flips conversation status to `running`, `task_complete` flips it back to `idle`.

### Per-session config surfaces

Sandbox policy, approval policy, reasoning effort, reasoning summary, personality, model — all live on the `AgentStartParams.codex` sub-object. Default policy is `workspace-write` + `on-request` approvals (matching Codex's own default). `SessionHeader` gets a "Codex settings" gear alongside the existing model/permission-mode controls Claude has.

### Skills, MCP, hooks

Codex's skills + `AGENTS.md` are read by `codex` itself from `~/.codex/`; nothing for OmniFex to do beyond pointing `cwd` at the project. Codex MCP servers configured in `~/.codex/config.toml` ride along the same way. Hooks-equivalent in Codex (notify scripts, exec policies) live in `config.toml` — OmniFex's per-project Codex settings surface in v1 is "open `~/.codex/config.toml` in your editor" + a read-only TOML preview pane. A richer settings editor is post-v1.

### Resume

Codex persists rollouts at `~/.codex/sessions/<conversationId>.jsonl`; `resumeConversation` rehydrates from that file. Same mental model as Claude's JSONL but in a different directory shape.

### Interrupt

`interruptConversation` JSON-RPC method.

### Disconnect / restart

Stream death → set `sessionStatus: 'error'`, drop pending-promise map, next `send()` re-spawns with `resumeConversation`. Identical FSM to Claude's restart path; the differences live inside the engine, hidden from `sessions/`.

## Renderer split

`ClaudeCodeSession.tsx` is renamed `AgentSession.tsx` (phase 3) and becomes a thin shell that owns the shared chrome and dispatches body rendering to one of two transcript components.

### Shared chrome (agent-agnostic)

- `SessionHeader` — title, account+agent chip, model picker (model list is engine-provided), and a polymorphic `<AgentSettingsControl agent={agent} />` slot that renders the permission-mode picker (Claude) or sandbox-policy/approval-policy picker (Codex).
- `SessionModeToggle` — relabel "SDK / Terminal" → "Chat / Terminal". Behavior unchanged.
- Composer / input box — text, attachments, slash-command autocomplete (slash-command list is engine-provided).
- Status bar — `sessionStatus`, `conversationStatus`, rate-limit indicator, in-flight rollup.
- Permission dialog — single component handles both Claude tool-use approvals and Codex patch/exec approvals; the dialog body branches on `req.kind` and `req.agent` for the right preview (diff viewer for patch, shell preview for exec, tool-input panel for tool).
- Log tab — renders messages from any agent as a generic envelope view (no tool-widget rendering).
- Subagent/task list panel — feeds off the JSONL tail for Claude; off `item.*` notifications for Codex; the panel itself is shared.

### Agent-specific (two parallel trees)

- `src/components/claude/ClaudeTranscript.tsx` — the existing transcript code lifted out of `ClaudeCodeSession.tsx`. Tool widgets (`CommandWidget`, `EditWidget`, `TodoWriteWidget`, `TaskList`, `WebFetchWidget`, etc.) move under `src/components/claude/tools/`. **No behavior change** — same message shape in, same render out.
- `src/components/codex/CodexTranscript.tsx` — new. Renders Codex's `agent_message`, `agent_reasoning` (collapsible "Thinking…" block with the reasoning summary), `item.exec_command`, `item.apply_patch`, `item.web_search`, `item.mcp_tool_call`, etc. Each item type gets a small dedicated widget under `src/components/codex/items/`.

### Shared because shape-identical

- The diff viewer (lifted from Claude side to `src/components/shared/DiffViewer.tsx`)
- The streaming-text component
- The message-card chrome (avatar, role, timestamp)
- The slash-command autocomplete dropdown

### Routing

```tsx
{tab.agent === 'claude'
  ? <ClaudeTranscript messages={messages} … />
  : <CodexTranscript messages={messages} … />}
```

State that's shared (messages, status, permission queue) lives in `useSessionLifecycle` — the same hook, but its message type widens to `AgentMessage`. State that's agent-specific (Claude's tool-input cache, Codex's reasoning-collapse state) lives inside the respective transcript component.

## Persistence, resume, multi-account

### Schema migration

Already covered above: `agent` column on `sessions` and `path_rules`, default `'claude'`, backfilled on first start under the new build. No data migration.

### Resume across both engines

Both engines persist their conversation transcript to disk in a JSONL format owned by the respective CLI. Resume is the CLI's responsibility — OmniFex just hands the `conversationId` / `sessionId` back via `--resume` (Claude) or `resumeConversation` (Codex).

- Claude: `<configDir>/projects/<encoded-projectPath>/<sessionId>.jsonl` (unchanged)
- Codex: `~/.codex/sessions/<conversationId>.jsonl`

A thin `agentTranscriptStore` abstraction with per-agent implementations sits in front of anything that needs to read the on-disk transcript (JSONL tail, summary regeneration, "open conversations" list).

### Open-conversations / session list

The session list grows a per-agent partition: Claude sessions discovered via the existing walker (per-account-configDir), Codex sessions discovered via `~/.codex/sessions/*.jsonl` (new walker, ~50 lines). The list UI gets one new column (agent badge) and a filter dropdown.

### Multi-account boundaries

- **Claude:** unchanged. Every Claude session resolves to an account → `CLAUDE_CONFIG_DIR` flows to the subprocess env.
- **Codex:** single-account. Subprocess env has no `CODEX_HOME` override. Settings UI for Codex hides the "account" picker entirely.

### Forward compatibility for Codex accounts

When Codex accounts come (post-v1), the only thing that changes is: `account_id` populates on Codex `path_rules` rows, the engine reads `params.codex.configDir` and sets `CODEX_HOME` in env. No schema migration; no rerouting of how sessions persist.

### Existing sessions on disk

Every Claude JSONL file already on disk continues to work — the CLI reads the exact format the SDK was writing. No data migration needed. The first time OmniFex starts under the new build, it sees all existing sessions as `agent: 'claude'` (via the default), and `--resume` picks up where each left off.

## Auth UX

### Codex sign-in

A new `CodexAuthService` (main process) reads `~/.codex/auth.json` and exposes:

```ts
interface CodexAuthService {
  getStatus(): Promise<{ authenticated: boolean; email?: string; mode?: 'oauth' | 'apikey' }>;
  watch(cb: (status) => void): Disposable;       // fs.watch on the auth file
  startLoginFlow(): Promise<{ ptyHandle: string }>;
  cancelLoginFlow(handle: string): void;
}
```

Flow:

1. User clicks "Sign in to Codex" (in settings, or in the new-session dialog when `agent === 'codex'` and not authenticated).
2. A modal hosting `OneShotTerminal` opens. `startLoginFlow()` spawns `codex login` in a pty.
3. The pty's bytes stream into the xterm in the modal; the user completes the OAuth handshake.
4. The fs watcher fires when `~/.codex/auth.json` updates; if the file reflects logged-in state and the pty exits with code 0, the modal auto-closes and the UI shows the new auth state.
5. Cancel button kills the pty and closes the modal.

API-key mode (`OPENAI_API_KEY` in env) is detected by `getStatus()` and shown as a non-interactive auth state.

### Claude re-auth (recovery only)

No changes to Claude's add-account UX. When OmniFex detects an account's credentials are stale or missing, the account chip in the header (and the account row in `AccountSettings`) shows a small "Re-authenticate" button. Clicking opens the same `OneShotTerminal` modal, spawns `claude /login` with `CLAUDE_CONFIG_DIR` set to that specific account's dir, watches the dir's `.credentials.json` for refresh, and auto-closes on success.

**Detection.** An account counts as needs-reauth when:
- Its `.credentials.json` doesn't exist, or
- Spawning a session under it returns the CLI's "not authenticated" / "credentials expired" error.

The first check runs lazily (on app start + on account-row mount); the second is reactive (when a session fails with that specific error, OmniFex flips that account's state to needs-reauth and shows the button on its chip + a banner in the failed session).

### Shared primitive

`runInteractiveCliFlow` lives under `OneShotTerminal` and serves both `CodexAuthService.startLogin()` and `ClaudeAuthService.reauthenticate(accountId)`. Same modal component, same xterm, same auto-close-on-credentials-update behavior — only the binary, args, env, and watch path differ.

## Error handling, status FSM, restart semantics

The three-axis status model documented in `docs/session-lifecycle.md` (sessionStatus / conversationStatus / per-item task status) is **engine-agnostic** and stays unchanged. Engines drive the FSM by calling `setStatus` on their handle the same way `runtime.ts` does today.

### Engine → status mapping

| Lifecycle moment | Claude engine signal | Codex engine signal | Status transition |
|---|---|---|---|
| Process spawn | child process spawned | child process spawned + `newConversation` sent | `sessionStatus: 'starting'` |
| Conversation handshake | `system:init` message | `newConversation` response | `sessionStatus: 'started'`, `conversationStatus: 'idle'` |
| User send | stdin write | `sendUserTurn` request | `conversationStatus: 'running'` (eagerly) |
| Mid-turn signal | `assistant`/`user`/`tool_use` message | `task_started` / `item.*` notification | `conversationStatus: 'running'` |
| Turn complete | `result` message | `task_complete` notification | `conversationStatus: 'idle'` |
| Permission requested | `control_request: permission_request` | `applyPatchApproval` / `execCommandApproval` | orthogonal — pending queue, no FSM move |
| Rate limit hit | rate-limit info in `result` / system message | Codex emits `error` with rate-limit shape | rate-limit hook fires; `conversationStatus` unchanged |
| Stream/process error | stdout/stderr EOF or non-zero exit | RPC connection drop / process exit | `sessionStatus: 'error'`, next `send()` restarts |
| Clean stop | explicit `close()` | explicit `close()` | `sessionStatus: 'stopped'`, remove from map |

### Restart on error

Existing `runtime.ts:245-268` semantics generalize: when an engine emits a stream/process error, the session stays in the map with `sessionStatus: 'error'`. The next `sendMessage()` call triggers `engine.start({ resumeSessionId: handle.sessionId, … })` transparently. Same UX; delegated to the engine.

### StrictMode double-mount guards

Today `runtime.ts` checks `sessions.get(tabId) !== handle` to detect "start() has replaced this handle, suppress events." That check is engine-agnostic and stays in `sessions/`. Engines do not know about identity-replace.

### Exit / cleanup ordering

Engine `close()` is `await`-able; sessions service drains it before deleting the handle and emitting `agent-complete:`. `kill()` is fire-and-forget for hard shutdowns (app quit, tab close mid-turn).

### Stderr surfacing

Both engines pipe stderr separately; sessions service emits `agent-error:<tabId>` with the agent kind in the payload. Renderer error banner gets an `agent` field for branding.

### Permission-request lifecycle

A pending `AgentPermissionRequest` queue lives on the handle, keyed by `requestId`. `respondPermission(requestId, decision)` finds the queued request, ships the decision back through the engine, and drops it from the queue. If the engine dies with pending requests outstanding, they're cleared and resurfaced as errors on the next send.

## Testing strategy

### Per-engine unit tests

Under `electron/__tests__/agents/`:

- `claude-engine.test.ts` — mock `child_process.spawn` to return a controllable readable/writable pair; feed canned NDJSON lines from fixtures; assert: `start()` spawns with right args+env, `onMessage` fires per line, `send()` writes well-formed stream-json + newline, permission round-trip works, stream EOF transitions to `onExit`, restart with `--resume` sends the right flag, `interrupt()` writes the right control_request, `close()` is idempotent.
- `codex-engine.test.ts` — mock the same way; canned JSON-RPC bodies; assert: id-correlation correctness (concurrent in-flight requests resolve to right promises), notifications surface as `onMessage`, server-initiated approvals surface as `onPermissionRequest` with the matching id, `respondPermission` ships a response on the right id, restart re-spawns + calls `resumeConversation`.

### Fixture transcripts

`electron/__tests__/fixtures/agents/claude-stream/*.ndjson` and `codex-rpc/*.ndjson` capture real CLI runs (captured once via a small `npm run capture:fixtures` script, then frozen). Each fixture is a complete turn: init → assistant text → tool use → permission round-trip → result. Engine tests replay these and snapshot the emitted `AgentMessage` sequence. When the upstream protocol changes, re-capture and re-snapshot in a single PR.

### Sessions service tests

`electron/__tests__/sessions.test.ts` stops importing `query()`. The existing `installFakeQuery` test helper becomes `installFakeEngine` — returns a `FakeEngine` implementing `AgentEngine` with the same `pushMessage` / `pushPermissionRequest` test-affordance methods. All existing sessions tests keep their assertions; only the helper changes. Net-new tests cover the agent dimension (`start({ agent: 'codex' })` picks the codex engine factory, etc.).

### Renderer tests

Existing `useSessionLifecycle.test.tsx` and `TabContext.test.tsx` grow agent-dimension assertions. New tests for `CodexTranscript` render fixtures of each Codex item type and assert the right widget mounts. Shared chrome (permission dialog, header, status) gets one parameterized test per agent kind.

### Integration smoke

A "real binary" suite gated behind `OMNIFEX_E2E_REAL_CLAUDE=1` / `OMNIFEX_E2E_REAL_CODEX=1` env flags. Skipped by default; opt-in for release verification. Each spawns the real CLI against a throwaway project + empty config dir, sends one prompt, asserts a `result` message arrives within timeout.

### Coverage gate

Same 80%-line target. Hot-spot focus during implementation: the two engines and the permission round-trip path (cross-engine, bug-prone).

### Manual verification per release

A new entry on the omnifex-release skill's checklist: run a Claude session + a Codex session in a freshly-installed build, do one approval flow each, switch the Claude session into TUI and back, kill and resume each.

## Migration, sunset, phasing

This spec describes the destination. The implementation lands in phases, each shippable and bisectable. The implementation plan (written next via superpowers:writing-plans, after this spec is approved) details commits.

### Phase 1 — Engine seam for Claude (no Codex)

Introduce `AgentEngine` interface + `ClaudeCliEngine`. Sessions service holds an opaque engine instead of a `Query`. Renderer is unchanged (Claude messages flow through unchanged). SDK still installed; not used at runtime — keep it for the duration of phase 1 only as a fallback behind `OMNIFEX_USE_SDK=1` so a CLI regression can be A/B'd. Permission protocol + hooks + JSONL tail + summary regeneration all swap to CLI. Schema migration: add `agent` column to sessions + path_rules with `'claude'` default.

Net: every existing session keeps working, but now via subprocess.

### Phase 2 — Remove the SDK dependency

Delete `@anthropic-ai/claude-agent-sdk` from `package.json`, delete the `OMNIFEX_USE_SDK` fallback, delete `electron/services/sessions/hooks.ts` and any SDK-typed leftovers. Forge config drops the SDK from `asar.unpack`. Pretest / rebuild hooks drop SDK references.

### Phase 3 — Codex engine + agent-aware routing + Codex transcript

Add `CodexCliEngine`, `codex-binary.ts`, `CodexAuthService`, `OneShotTerminal`, agent picker in new-session dialog, `CodexTranscript` + item widgets, Codex auth UI, Codex session-list partition. Largest phase; probably splits into engine-first / UI-second during planning. Ship Codex behind a feature flag (`OMNIFEX_ENABLE_CODEX=1` or hidden settings toggle) until the manual verification checklist is comfortable, then flip.

### Phase 4 — Claude re-auth affordance

Detect needs-reauth + surface the button + wire `ClaudeAuthService.reauthenticate()` through `runInteractiveCliFlow`. Small, isolated. Independent of phase 3 ordering — can ship before, after, or in parallel.

### What gets deleted

- `node_modules/@anthropic-ai/claude-agent-sdk` (phase 2)
- `electron/services/sessions/hooks.ts` (phase 1, replaced by engine-internal handling)
- SDK imports in `runtime.ts`, `lifecycle.ts`, `summary-query.ts`, `types.ts` (phases 1-2)
- The `SDK` label in `SessionModeToggle` becomes `Chat` (phase 1)

### What gets renamed

- `ClaudeCodeSession.tsx` → `AgentSession.tsx` (phase 3)
- `mode: 'sdk' | 'tui'` → `mode: 'rich' | 'tui'` on `SessionHandle` (phase 1)
- `claude-output:<tabId>` / `claude-error:` / `claude-complete:` → `agent-output:` / `agent-error:` / `agent-complete:` (phase 3, with a brief preload compat shim during cutover)
- `installFakeQuery` test helper → `installFakeEngine` (phase 1)

### What does not change

- Sessions on disk (Claude JSONL format)
- Path-rule matching logic
- Account-add UX
- TUI mode (now `rich` ↔ `tui` toggle)
- Status FSM and `docs/session-lifecycle.md` invariants
- Multi-account isolation
- omnifex-release flow

### Roll-back posture

Phase 1's env flag is the safety hatch. Phase 2 is the no-going-back commit; ship phase 2 only once phase 1 has been live and stable for at least one release cycle. Phase 3 is feature-flagged so it can land mostly-finished and flip when ready.

## Open questions deferred to implementation

- **JSONL-tail necessity for Codex.** Claude relies on the JSONL tail to surface closure carriers the SDK iterator didn't yield (queue-operation enqueue, queued_command attachments). Codex's MCP notifications surface item lifecycle directly, so the tail may be unnecessary on the Codex side. Confirm during phase 3 — if any item type leaks state to the rollout file but not the live stream, we add a Codex JSONL tail with a parallel implementation.
- **Slash-command surface for Codex.** Codex's slash commands (if/when its CLI exposes them programmatically) need a parallel autocomplete data source. v1 may ship with a static Codex command list; full integration is post-v1.
- **Settings editor for Codex `~/.codex/config.toml`.** v1 ships a read-only TOML preview + "open in editor" button. A richer editor is a post-v1 effort; intentionally out of scope for this spec.
- **Codex usage analytics.** Codex's CLI doesn't yet expose a stable usage-tracking surface comparable to Claude's. v1 displays whatever it surfaces in `task_complete` payloads; deeper analytics is post-v1.
