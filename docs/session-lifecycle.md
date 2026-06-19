# Session Lifecycle

This is the **authoritative model** for session and conversation state in OmniFex. Before refactoring anything in `electron/services/sessions/**` or `src/hooks/useSessionLifecycle.ts`, read this first.

## The three orthogonal axes

There are three independent things being tracked. Confusing them is how we end up with bugs like "session stuck on starting" or dual-boolean state that drifts out of sync.

```
┌─────────────────┐    ┌──────────────────────┐    ┌─────────────────┐
│  sessionStatus  │    │  conversationStatus  │    │  tasks / agents │
│  (the phone)    │    │  (derived, renderer) │    │  (per-item)     │
└─────────────────┘    └──────────────────────┘    └─────────────────┘
```

### 1. `sessionStatus` — the phone call

Is the CLI process up? Mirrors the lifecycle of the main-process session handle.

| Value      | Phone analogy          | What it means                                                             |
| ---------- | ---------------------- | ------------------------------------------------------------------------- |
| `starting` | dialing / ringing      | `startSession()` fired, awaiting the CLI engine's first output            |
| `started`  | connected, on the call | CLI process is alive; session has a GUID; ready for conversation          |
| `error`    | lost connection        | A `start()`/`restart` spawn failed; the next send retries via `restartQuery`. NOTE: a mid-stream CLI stderr line does NOT flip to `error` — most stderr is benign noise, so the runtime surfaces it (toast) and keeps the session live. A real CLI crash exits → `stopped` and the next prompt does a fresh `--resume` start. |
| `stopped`  | hung up                | Clean close — tab closed or main-process teardown                         |

There is no `idle` or `running` here. Those belong to `conversationStatus`. The connection being up does not say anything about whether a turn is in flight.

### 2. `conversationStatus` — the back-and-forth (derived in the renderer)

What's happening in the user ↔ Claude exchange. **Derived by the renderer** from `messages: JsonlNode[]` plus the task and subagent stores. The main process does not produce or track this value — it never appears in any IPC payload.

| Value     | Meaning                                                                         |
| --------- | ------------------------------------------------------------------------------- |
| `idle`    | No turn in flight. Either side could send the next message.                     |
| `running` | User sent a message, Claude is generating, tools are active, or a permission    |
|           | request is open (the corresponding task entry keeps `hasOpenTasks` true).       |

`'waiting_permission'` from the old FSM is gone. A pending permission card keeps the relevant task/subagent entry open, which keeps `conversationStatus` at `'running'` through normal derivation. No separate state is needed.

See **Derivation rules** below for the exact predicates.

> **Type locations:** `ConversationStatus` (`'idle' | 'running'`) is defined in and exported from `src/lib/sessionDerivedState.ts`. It is also re-exported via `src/lib/api.ts` but marked `@deprecated` there — import it from `sessionDerivedState.ts` directly in new code.

### 3. Tasks and subagents — per-item

Each task and each subagent has its own status (`pending | running | complete`). These feed into `conversationStatus` (via `hasOpenTasks` / `hasOpenSubagents`) and into the overall in-flight rollup below.

## State invariants

These must hold at all times. If you find code that violates them, that code is wrong.

1. `conversationStatus !== 'idle'` only makes sense when `sessionStatus === 'started'`. Computing it against a dead or starting session is legal but the result is always `'idle'` because `messages[]` will be empty.
2. `sessionStatus` transitions are owned by the main process. The renderer reflects them; it does not invent them. (Exception: optimistic `'starting'` on user-initiated start, and synchronous `'stopped'` in stop/clear handlers that tear down their own listeners.)
3. `conversationStatus` is computed by `src/lib/sessionDerivedState.ts` and never appears in any IPC payload.
4. Task and subagent statuses are owned by the JSONL pipeline (`tui-jsonl`, `jsonl-tail`, and the renderer's message reducer).
5. There is **never** a `useState` in a renderer component that mirrors any of the above. The hook owns the source of truth; components consume derived predicates.

## Derivation rules

`conversationStatus` is the union of three pure predicates in `src/lib/sessionDerivedState.ts`:

```ts
// True iff the conversation is "expecting more from Claude". Walks messages[]
// from the end; only three kinds of node have the power to decide the turn
// axis (first one wins), and everything else is skipped BY DEFAULT:
//   - a `result` row (kind:'cli-stream-result') CLOSES the turn.
//     Under --include-partial-messages the committed assistant carries
//     stop_reason: null (the terminal reason rides the message_delta
//     stream_event, which never enters messages[]), so the result row is the
//     authoritative "turn complete" signal for a live-streamed turn.
//   - a main-chain assistant settles by stop_reason: terminal => done,
//     null/non-terminal => still going. Persisted/resumed transcripts record
//     the real stop_reason here (no result row), so loaded history settles
//     through this branch.
//   - a user message => defer to "is a prompt awaiting a reply?".
// Skip-by-default (rather than matching a hardcoded plumbing list) means
// trailing bookkeeping/overlay nodes — system status/init/hooks, stream-event/
// rate-limit/lifecycle overlays, last-prompt / queue-operation / ai-title /
// file-history-snapshot / permission-mode entries, non-result `unknown` nodes,
// sidechain subagents — never reopen a closed turn, and a new bookkeeping kind
// can't silently regress this.
waitingOnClaude(messages: JsonlNode[]): boolean

// True iff any task row has status !== 'completed'.
hasOpenTasks(tasks: WithStatus[]): boolean

// True iff any subagent row has status !== 'completed'.
hasOpenSubagents(subagents: WithStatus[]): boolean

// The composed status:
conversationStatus(messages, tasks, subagents): 'running' | 'idle'
// → 'running' if any of the three predicates is true; 'idle' otherwise.
```

Terminal `stop_reason` values that close `waitingOnClaude` on a main-chain assistant:
`end_turn`, `stop_sequence`, `max_tokens`, `refusal`, `model_context_window_exceeded`.

A trailing `result` row (kind `cli-stream-result`) **also** closes `waitingOnClaude`, independent of `stop_reason`. This is load-bearing under `--include-partial-messages`: the committed `assistant` message then carries `stop_reason: null` (the real `end_turn` arrives only on the `message_delta` stream_event, which is an overlay and never enters `messages[]`), so without honoring the result row the turn would never read as complete.

The CLI's `system:init` and `type:'result'` lines classify to `cli-stream-init` / `cli-stream-result` (see `jsonlClassifier`) — these are the **only** representation (there is no parallel `unknown`+`result` row). `cli-stream-result` is the turn-closer for derivation and the `refreshContextUsage` / queue-drain trigger in the reducer; `cli-stream-init` drives session-id extraction, persistence, and the account/model/command fetches. Treating these envelopes as inert "badges only" is the regression that left sessions stuck on "Working" and the context popover empty.

Separately, the engine (`assistantMeta.ts`) merges each chain's trailing `message_delta` (resolved `stop_reason` + final `usage`) back into the committed `assistant` frame before it reaches `messages[]`, so the end-turn card, completion band, and per-message cost — all of which read the assistant's own `stop_reason`/`usage` — see honest values rather than the `message_start`-era stubs.

## The in-flight rollup

This is the canonical predicate for "is anything pending in this session?" It drives:
- The header spinner
- The prompt-input spinner / send-button gating
- The TabManager per-tab spinner
- The status popover's per-tab indicator and aggregate badge count
- The upgrade-button warning ("you have N sessions still working")

```ts
const inFlight =
  conversationStatus(messages, tasks, subagents) === 'running'
  || subagents.some(s => s.status !== 'complete')
  || tasks.some(t => t.status !== 'complete');
```

Compute this in the renderer via the selectors from `src/lib/sessionDerivedState.ts`. Do not call `listInFlightTabIds` for this — it returns `[]` now that the main process no longer tracks conversation state.

Notes:
- `sessionStatus === 'starting'` does **not** count as in-flight by itself. The header badge shows "Starting…" but no spinner — the user hasn't asked for anything yet, there's nothing to wait on.
- `sessionStatus === 'error'` is not in-flight. The badge shows the error state; spinner is off.
- `sessionStatus === 'stopped'` is not in-flight. Session is over.

## IPC contract

- **Event:** `session-status:<tabId>` — payload: `{ sessionStatus: SessionStatus }`. Fired on every `sessionStatus` transition. `conversationStatus` is **not** in the payload; the renderer derives it.
- **Invoke:** `session_get_health` — returns `{ alive: boolean, sessionId: string | null, sessionStatus: SessionStatus }`. Used to seed the renderer after a rebind or reload. `conversationStatus` is not included.

## Anti-patterns (do not do these)

- Maintaining two booleans (`isSessionStarting` + `isSessionActive`) in a component. There is one enum, exposed by the hook.
- Reading `sessionStatus === 'idle'` or `sessionStatus === 'running'` anywhere. Those are not values of `sessionStatus`. They're values of `conversationStatus`.
- Maintaining `conversationStatus` as renderer-side React state (`useState`). It is a pure derived value; store `messages[]`, `tasks`, and `subagents` and recompute.
- Subscribing to `session-status:<tabId>` expecting a `conversationStatus` field. That field is not in the payload.
- Computing in-flight via `listInFlightTabIds`. It returns `[]` — the main process no longer tracks conversation state. Use the renderer-side selector instead.
- Renderer components subscribing to `session-status:<tabId>` directly. The hook owns that subscription; consumers read the derived state.
- Dropping a turn-closing `cli-stream-result` row from `messages[]` (e.g. to hide a card). The trailing partial assistant carries `stop_reason: null`, so the result row is the only thing that lets `waitingOnClaude()` settle — drop it and the per-tab "Turn in flight" rollup sticks on WORKING forever, even though `isLoading` cleared. If a result must not render as-is, keep it in `messages[]` and rewrite its presentation (the user-cancel path neutralizes `is_error` via the reducer's `replaceWith`), never `append: 'skip'` it.

## Where the canonical types live

- `electron/services/sessions/types.ts` — `SessionStatus` enum plus the `SessionHandle` shape. Re-exported via `src/lib/api.ts` for the renderer.
- `src/lib/sessionDerivedState.ts` — `ConversationStatus` type and all derivation functions. Also re-exported (as `@deprecated`) via `src/lib/api.ts` for backward compatibility — prefer the direct import.
