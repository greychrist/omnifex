# Session Lifecycle

This is the **authoritative model** for session and conversation state in OmniFex. Before refactoring anything in `electron/services/sessions/**` or `src/hooks/useSessionLifecycle.ts`, read this first.

## The three orthogonal axes

There are three independent things being tracked. Confusing them is how we end up with bugs like "session stuck on starting" or dual-boolean state that drifts out of sync.

```
┌─────────────────┐    ┌──────────────────────┐    ┌─────────────────┐
│  sessionStatus  │    │  conversationStatus  │    │  tasks / agents │
│  (the phone)    │    │  (the back-and-forth)│    │  (per-item)     │
└─────────────────┘    └──────────────────────┘    └─────────────────┘
```

### 1. `sessionStatus` — the phone call

Is the SDK connection up? Mirrors the lifecycle of the main-process session handle.

| Value      | Phone analogy             | What it means                                                                 |
| ---------- | ------------------------- | ----------------------------------------------------------------------------- |
| `starting` | dialing / ringing         | `query()` fired, awaiting the SDK's first `system:init` message               |
| `started`  | connected, on the call    | SDK has emitted `system:init`; session has a GUID; ready for conversation     |
| `error`    | lost connection           | Stream errored; session kept alive for retry via `restartQuery`               |
| `stopped`  | hung up                   | Clean close — `query.close()`, tab closed, or main-process teardown           |

There is no `idle` or `running` here. Those belong to `conversationStatus`. The connection being up does not say anything about whether a turn is in flight.

### 2. `conversationStatus` — the back-and-forth

What's happening in the user ↔ Claude exchange. **Only meaningful when `sessionStatus === 'started'`. Must be `null` otherwise.** A conversation with nothing on the other end makes no sense.

| Value                | Meaning                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `idle`               | No turn in flight. Either side could send the next message.            |
| `running`            | User sent a message, or Claude is generating / using tools             |
| `waiting_permission` | Claude requested a tool via `canUseTool`; awaiting user approval       |

`waiting_permission` is conversationally in-flight even though no token is streaming — the conversation cannot progress until the user responds.

### 3. Tasks and subagents — per-item

Each task and each subagent has its own status (`pending | running | complete`). These do **not** modify `conversationStatus`. The user and Claude can keep conversing while a subagent runs in the background. But they do feed into the **overall in-flight rollup** below, because anyone watching the call from the outside cares whether work is still pending.

## State invariants

These must hold at all times. If you find code that violates them, that code is wrong.

1. `conversationStatus !== null` ⟺ `sessionStatus === 'started'`. Setting `conversationStatus` while the session isn't `started`, or leaving it set after the session leaves `started`, is a bug.
2. `sessionStatus` transitions are owned by the main process. The renderer reflects them; it does not invent them. (Exceptions: optimistic `'starting'` on user-initiated start, synchronous `'stopped'` set by stop/clear handlers that tear down their own listeners — these compensate for the IPC event being lost or arriving late.)
3. `conversationStatus` transitions are also owned by the main process (driven by the SDK iterator's `init` / `turn` / `result` events and the `canUseTool` callback).
4. Task and subagent statuses are owned by the JSONL pipeline (`tui-jsonl`, `jsonl-tail`, and the renderer's message reducer).
5. There is **never** a `useState` in a renderer component that mirrors any of the above. The hook owns the source of truth; components consume derived predicates.

## The in-flight rollup

This is the canonical predicate for "is anything pending in this session?" It drives:
- The header spinner
- The prompt-input spinner / send-button gating
- The TabManager per-tab spinner
- The status popover's per-tab indicator and aggregate badge count
- The installer's wait-for-idle gate (so updates don't interrupt active work)
- The upgrade-button warning ("you have N sessions still working")

```ts
const inFlight =
  conversationStatus !== null && conversationStatus !== 'idle'
  || subagents.some(s => s.status !== 'complete')
  || tasks.some(t => t.status !== 'complete');
```

Notes:
- `sessionStatus === 'starting'` does **not** count as in-flight by itself. The header badge shows "Starting…" but no spinner — the user hasn't asked for anything yet, there's nothing to wait on.
- `sessionStatus === 'error'` is not in-flight. The badge shows the error state; spinner is off.
- `sessionStatus === 'stopped'` is not in-flight. Session is over.

## Mapping main-process SDK events to the model

Driven from `electron/services/sessions/runtime.ts` and `electron/services/sessions/lifecycle.ts`:

| SDK iterator event              | sessionStatus              | conversationStatus |
| ------------------------------- | -------------------------- | ------------------ |
| `start()` called (pre-SDK)      | `starting`                 | `null`             |
| `system:init`                   | `started`                  | `idle`             |
| `turn` (assistant streaming)    | `started`                  | `running`          |
| `canUseTool` invoked            | `started`                  | `waiting_permission` |
| `result` (turn complete)        | `started`                  | `idle`             |
| stream throws                   | `error`                    | `null`             |
| clean close                     | `stopped`                  | `null`             |

The renderer's eager `setSessionStatus('starting')` before awaiting `api.startSession` is the only renderer-side write. Every other transition flows from the main process via the `session-status:<tabId>` event channel.

## IPC contract

- **Event:** `session-status:<tabId>` — payload: `{ sessionStatus: SessionStatus, conversationStatus: ConversationStatus | null }`. Fired on every transition of either field. The renderer must not destructure looking for the legacy `{ status }` shape.
- **Invoke:** `session_get_health` — returns `{ alive: boolean, sessionId: string | null, sessionStatus: SessionStatus, conversationStatus: ConversationStatus | null }`. Used to seed the renderer after a rebind or reload.

## Anti-patterns (do not do these)

- Maintaining two booleans (`isSessionStarting` + `isSessionActive`) in a component. There is one enum, exposed by the hook.
- Reading `sessionStatus === 'idle'` or `sessionStatus === 'running'` anywhere. Those are not values of `sessionStatus`. They're values of `conversationStatus`.
- Pinning `options.sessionId` on cold start when invoking the SDK. The CLI in stream-json mode suppresses `system:init` when pinned, which leaves `sessionStatus` permanently at `starting`. See `electron/services/sessions/factory.ts:222-225`.
- Renderer components subscribing to `session-status:<tabId>` directly. The hook owns that subscription; consumers read the derived state.
- Synchronously setting `conversationStatus` to anything other than `null` while `sessionStatus !== 'started'`.

## Where the canonical types live

- `electron/services/sessions/types.ts` — `SessionStatus`, `ConversationStatus` enums, plus the `SessionHandle` shape.
- `src/lib/api.ts` — re-exports both enums for the renderer. Keep the two definitions in sync. (A drift test is welcome if this becomes a maintenance burden.)
