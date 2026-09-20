# Session Lifecycle

This is the **authoritative model** for session and conversation state in OmniFex. Before refactoring anything in `electron/services/sessions/**` or `src/hooks/useSessionLifecycle.ts`, read this first.

## The three orthogonal axes

There are three independent things being tracked. Confusing them is how we end up with bugs like "session stuck on starting" or dual-boolean state that drifts out of sync.

```
┌─────────────────┐    ┌──────────────────────┐    ┌─────────────────┐
│  sessionStatus  │    │        turn          │    │  tasks / agents │
│  (the phone)    │    │  (the session's own) │    │  (per-item)     │
└─────────────────┘    └──────────────────────┘    └─────────────────┘
```

`conversationStatus` is the renderer's rollup of the second and third columns. It is not a fourth axis.

### 1. `sessionStatus` — the phone call

Is the CLI process up? Mirrors the lifecycle of the main-process session handle.

| Value      | Phone analogy          | What it means                                                             |
| ---------- | ---------------------- | ------------------------------------------------------------------------- |
| `starting` | dialing / ringing      | `startSession()` fired, awaiting the CLI engine's first output            |
| `started`  | connected, on the call | CLI process is alive; session has a GUID; ready for conversation          |
| `error`    | lost connection        | A `start()`/`restart` spawn failed; the next send retries via `restartQuery`. NOTE: a mid-stream CLI stderr line does NOT flip to `error` — most stderr is benign noise, so the runtime surfaces it (toast) and keeps the session live. A real CLI crash exits → `stopped` and the next prompt does a fresh `--resume` start. |
| `stopped`  | hung up                | Clean close — tab closed or main-process teardown                         |

There is no `idle` or `running` here. Those belong to `turn`. The connection being up does not say anything about whether a turn is in flight.

### 2. `turn` — is the session working on a prompt? (owned by the session)

`{ status: 'idle' | 'running', since: ISO | null }`. **Owned by the main-process session handle** (`electron/services/sessions/`), like `sessionStatus`, and mirrored by the renderer — never derived from the transcript.

| Transition | Where |
| --- | --- |
| `idle → running` | `sendMessage` / `sendStructuredMessage` — the moment the prompt is handed to the CLI, before the write, so a result row that races back cannot be missed (`lifecycle.ts`) |
| `running → idle` | the CLI's `result` row (`runtime.ts`), or `sessionStatus` reaching `stopped` / `error` (`status.ts`), or `stop()` |

Every transition is announced on `session-turn:<tabId>` with the full `TurnState`. `session_get_health` returns it too, so a reloaded renderer can seed itself.

**Why the session owns it, and the transcript never decides.** A `--resume` of a session whose process died mid-turn loads a transcript that ends on an assistant `tool_use` and its `tool_result`, with no result row and no terminal `stop_reason`. Any walk over that transcript reads "waiting on Claude" — and the new process is not working on anything. The spinner sat on WORKING forever on reopen (session `fa4d50f4`, 2026-09-20). The transcript is what the session *said*; whether it is *working* is a fact only the process that owns the prompt can answer, and it answers it by construction: a new process starts `idle` until something is sent. This used to be derived by the renderer (`waitingOnClaude`, 2026-05-27 → 2026-09-20) because TUI mode had no send/result the daemon could see; TUI mode is gone.

`conversationStatus` (`'idle' | 'running'`) is the renderer's **rollup** — `turn.status === 'running' || hasOpenTasks || hasOpenSubagents` — computed in `useSessionLifecycle` via `sessionDerivedState.conversationStatus(turnRunning, tasks, subagents)`. `'waiting_permission'` from the old FSM is gone: a pending permission card keeps the relevant task/subagent entry open, which keeps the rollup at `'running'`.

> **Type locations:** `TurnState` lives in `electron/services/sessions/types.ts` and is mirrored in `src/lib/api.ts` (type only — the renderer has no reason to import a value from `api.ts`, and tests mock that module). `ConversationStatus` is defined in `src/lib/sessionDerivedState.ts`.

### 3. Tasks and subagents — per-item

Each task and each subagent has its own status (`pending | running | complete`). These are transcript content, stay derived from it (`hasOpenTasks` / `hasOpenSubagents` in `sessionDerivedState.ts`), and feed the rollup.

## State invariants

These must hold at all times. If you find code that violates them, that code is wrong.

1. `turn.status === 'running'` implies `sessionStatus === 'started'`. A session that stops or errors is idle — `setStatus` closes the turn in the same breath, and the renderer resets its mirror on those events too. `conversationStatus` is `null` whenever `sessionStatus !== 'started'`.
2. `sessionStatus` and `turn` transitions are owned by the main process. The renderer reflects them; it does not invent them. (Exceptions: optimistic `'starting'` on user-initiated start, synchronous `'stopped'` in stop/clear handlers that tear down their own listeners, and the renderer resetting `turn` to idle on any start or reset — a new process is not working on anything.)
3. `conversationStatus` is a renderer rollup computed by `src/lib/sessionDerivedState.ts` and never appears in any IPC payload. `turn` does — on `session-turn:<tabId>`, `session_get_health`, and `session.state`.
4. Task and subagent statuses are owned by the JSONL pipeline (`jsonl-tail` and the renderer's message reducer).
5. There is **never** a `useState` in a renderer component that mirrors any of the above. The hook owns the mirror; components consume derived predicates.
6. Nothing reads "is a turn running?" off `messages[]`. The predicate that did (`waitingOnClaude`) was deleted on 2026-09-20 along with the reason it existed.

## Derivation rules

Only the per-item column is derived. `src/lib/sessionDerivedState.ts`:

```ts
// True iff any task row has status === 'in_progress'. Pending (planned but
// never started) does NOT count, or a closed session that ended with unstarted
// todos would render as running forever on reload.
hasOpenTasks(tasks: WithStatus[]): boolean

// True iff any subagent row has status === 'running'. Failed / abandoned /
// completed_inferred do NOT count.
hasOpenSubagents(subagents: WithStatus[]): boolean

// The rollup. `turnRunning` is the session's own axis, handed in by the hook.
conversationStatus(turnRunning: boolean, tasks, subagents): 'running' | 'idle'
```

The CLI's `system:init` and `type:'result'` lines classify to `cli-stream-init` / `cli-stream-result` (see `jsonlClassifier`). In the renderer `cli-stream-result` is the `refreshContextUsage` / queue-drain trigger in the reducer and `cli-stream-init` drives session-id extraction, persistence, and the account/model/command fetches. In main, the `result` row is what closes `turn`.

Separately, the engine (`assistantMeta.ts`) merges each chain's trailing `message_delta` (resolved `stop_reason` + final `usage`) back into the committed `assistant` frame before it reaches `messages[]`, so the end-turn card, completion band, and per-message cost — all of which read the assistant's own `stop_reason`/`usage` — see honest values rather than the `message_start`-era stubs.

### Usage-limit parking (`usageLimitWait`)

Claude Code 2.1.234 added the `autoContinueAtUsageLimit` global-config key, and it defaults **on** for claude.ai logins (the CLI only defaults it off when an API key is present). Hitting a usage limit no longer ends the turn: the CLI parks it, waits for the reset, and then continues — which can be hours.

Nothing about the axes changes. No result row lands, so `turn` stays `running` and the in-flight rollup stays true. **That is correct** — the CLI genuinely still owns the turn. Do not "fix" it by closing the turn on a rejection; the turn is not closed, and closing it would drop the resumed output on the floor.

What was missing was an explanation, not a state. `usageLimitWait(messages)` in `src/lib/sessionDerivedState.ts` returns the epoch-**seconds** reset time when the transcript ends on a rejected limit, else `null`:

- a `rate-limit-event` **decides** — `status: 'rejected'` plus a numeric `resetsAt` means parked; anything else means the limit is no longer blocking.
- an assistant / result / main user node means the turn has spoken since, so it resumed or finished → `null`.
- everything else is bookkeeping and is skipped.

A rejection carrying no `resetsAt` returns `null` on purpose: the CLI's own auto-continue predicate requires a finite `resetsAt`, and without one it offers the wait as a dialog choice rather than waiting.

It takes no clock — whether the reset has passed is a presentation question. `UsageLimitBanner` (rendered above the composer, beside `SubagentBar`) does the formatting and owns the countdown tick.

## The in-flight rollup

This is the canonical predicate for "is anything pending in this session?" It drives:
- The header spinner
- The prompt-input spinner / send-button gating
- The TabManager per-tab spinner
- The status popover's per-tab indicator and aggregate badge count
- The upgrade-button warning ("you have N sessions still working")

```ts
const inFlight =
  turn.status === 'running'
  || subagents.some(s => s.status === 'running')
  || tasks.some(t => t.status === 'in_progress');
```

`useSessionLifecycle` exposes it as `conversationStatus === 'running'`; `usePublishTabStatus` takes `turnRunning` and publishes the same answer through `tabStatusService`, which is what the installer's gate reads. The daemon's own `SessionSummary.inFlight` is `sessions.getTurn(id).status === 'running' || pendingPermissions > 0`.

Notes:
- `sessionStatus === 'starting'` does **not** count as in-flight by itself. The header badge shows "Starting…" but no spinner — the user hasn't asked for anything yet, there's nothing to wait on.
- `sessionStatus === 'error'` is not in-flight. The badge shows the error state; spinner is off.
- `sessionStatus === 'stopped'` is not in-flight. Session is over.

## IPC contract

- **Event:** `session-status:<tabId>` — payload: `{ sessionStatus: SessionStatus }`. Fired on every `sessionStatus` transition.
- **Event:** `session-turn:<tabId>` — payload: `TurnState`. Fired on every `turn` transition.
- **Invoke:** `session_get_health` — returns `{ alive, sessionId, sessionStatus, turn }`. Used to seed the renderer after a rebind or reload. `conversationStatus` is not included — it is a rollup.

### Across the daemon boundary

OmniFex Remote does not add a fourth axis, and adding one is the mistake to avoid.

- `session.state` on the wire (`src/protocol/messages.ts`) carries **`sessionStatus` and `turn`** — the two axes main owns — alongside `agent`. `turn` is required: a client must never infer it. There is deliberately no `conversationStatus` field: it is a rollup the renderer computes, and the renderer is the same code whether it is running in Electron or in Safari.
- `electron/remote/bridge.ts` translates the daemon's `sendToRenderer` calls into protocol pushes and keeps a per-session cache of both axes (fed by `session-status:` and `session-turn:`) so a reconnecting client can be told where it stands. That cache mirrors the axes; it does not become a second source of truth for them. In particular it does not close a turn on a `result` row — that row is transcript, and the session announces its own idle.
- `SESSION_SCOPED_PUSHES` is `['session.state', 'event', 'permission.request']`. A reconnecting client replays all three, because replaying transcript events alone would leave it at a stale status with an invisible permission prompt blocking the turn.
- The daemon's `/healthz` reports `sessions.inFlight`. That is a **turn** count from `SessionSummary.inFlight`, and it is what the updater and the daemon-replacement logic gate on. It is not `sessionStatus`.

## Anti-patterns (do not do these)

- Maintaining two booleans (`isSessionStarting` + `isSessionActive`) in a component. There is one enum, exposed by the hook.
- Reading `sessionStatus === 'idle'` or `sessionStatus === 'running'` anywhere. Those are not values of `sessionStatus`. They're values of `conversationStatus`.
- Maintaining `conversationStatus` as renderer-side React state (`useState`). It is a rollup; store the mirrored `turn`, plus `tasks` and `subagents`, and recompute.
- Subscribing to `session-status:<tabId>` expecting a `conversationStatus` field. That field is not in the payload. The turn arrives on `session-turn:<tabId>`.
- Walking `messages[]` to decide whether a turn is running — for a spinner, a gate, a "busy" badge, anything. The transcript records what was said, not whether the process is working; a resumed session's transcript ends open and the session is idle. Ask `turn`.
- Synthesising a transcript node to close a turn on resume. That was the first proposed fix for the reopen spinner; it papers over the wrong source of truth.
- Renderer components subscribing to `session-status:<tabId>` directly. The hook owns that subscription; consumers read the derived state.
- Dropping a `cli-stream-result` row from `messages[]` (e.g. to hide a card). It is the reducer's `refreshContextUsage` / queue-drain trigger. If a result must not render as-is, keep it in `messages[]` and rewrite its presentation (the user-cancel path neutralizes `is_error` via the reducer's `replaceWith`), never `append: 'skip'` it.

## Account identity verification

An account may carry an `expected_email` (nullable column on `accounts`, migration v17). When set, session start performs a secondary confirmation that the resolved config dir is actually authenticated as that address. Null means no check and no I/O — an account that hasn't opted in costs nothing on the start path.

Two checks, both **non-blocking** — the session starts regardless:

1. **Pre-flight** — `lifecycle.start()`. Reads `<configDir>/.claude.json` → `oauthAccount.emailAddress`. Runs against the **re-resolved** config dir, not the one the renderer supplied, so a path-rule change between form-mount and Start-click can't cause the wrong account to be verified. No CLI spawn.
2. **Post-init** — `runtime.ts`. Compares against `account.email` in the CLI's own `system:init` payload. Stronger evidence: that is the identity of the process actually running the session, so it catches a `.claude.json` that has gone stale.

Both emit `session-account-mismatch:<tabId>` with `{ expected, detected, configDir, source }`, where `source` is `'oauth-file'` or `'session-init'`. `detected: null` means nobody is signed in, which is treated as a mismatch — it's the same failure class as being signed in as the wrong person. Comparison is trimmed and case-insensitive, with no Gmail dot-folding or plus-address normalization.

`claude auth status --json` is the authoritative answer and is available in Settings behind the **Detect** button; it is deliberately never run on the session-start path because it costs a process spawn.

Spec: `docs/superpowers/specs/2026-07-27-account-email-verification-design.md`

## Where the canonical types live

- `electron/services/sessions/types.ts` — `SessionStatus` enum, `TurnState`, the `SessionHandle` shape, and `AccountMismatch` (the `session-account-mismatch` payload). Mirrored as types in `src/lib/api.ts` for the renderer.
- `src/lib/sessionDerivedState.ts` — `ConversationStatus` type, the rollup, and the transcript-derived helpers (tasks, subagents, turn duration, usage-limit wait). Also re-exported (as `@deprecated`) via `src/lib/api.ts` for backward compatibility — prefer the direct import.
