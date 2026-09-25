# Side Chat

**Status:** designed 2026-09-25. Not implemented.
**Scope:** main/daemon + renderer. Three new invoke channels, one new event
channel, no protocol message, no schema change.

## The question this answers

"Can I ask Claude something about this session without derailing it?" — the
CLI's `/btw`. A question answered from the conversation so far, while the main
turn keeps running, that never enters the conversation history.

OmniFex has no way to do this today, and typing `/btw` in the composer sends it
down stream-json as an ordinary prompt.

## What the CLI provides

Verified against the installed binary, 2.1.282.

- A `side_question` control request on the stdio control channel:
  `{subtype:'side_question', question: string, history?: {question, response}[]}`.
- Reply: `{response: string | null, synthetic: boolean, usage, refusalFallback?}`.
  `response: null` means no answer. `usage` is the fork's token total; side
  chat does not read it (see "Cost").
- Implementation: forks the current context with cache-safe params (reads the
  warm prompt cache), `maxTurns: 1`, every tool denied ("Side questions cannot
  use tools"), `skipCacheWrite`, `skipTranscript`. Nothing lands in the JSONL.
- Does not interrupt a running turn.
- **Stateless on the CLI side.** The caller owns the thread and sends history
  each time; the TUI sends the last 20 exchanges.
- The CLI's own deadline for it is 600,000 ms (75,000 for other subtypes).
- Undocumented: the Agent SDK wraps it as `askSideQuestion()`, but the SDK
  reference does not list it. The changelog mentions it once, in a 2.1.268 fix.
  Treat the wire shape as something the CLI review must watch.
- `control_request_progress` is emitted for side questions only on the SDK
  bridge (`bridge:repl`), not on stdio (see the 2.1.28x entry in
  `claude-cli-review.ts`). This design does not depend on progress events.

## Decisions

| Question | Decision |
|---|---|
| Lifetime | Until the session's engine exits, or the user closes the side chat. |
| Close | Discards the side chat. Reopening starts empty. No hidden-with-history state. |
| Owner | The session handle in main/daemon — not the renderer. |
| Concurrency | One pending question at a time. |
| Layout | A docked column beside the messages area, outside the one-at-a-time panel host. |
| Codex | Not supported; button hidden, ask rejected. |

Renderer-owned state was rejected: a reload or remount would lose the side
chat mid-session, and the desktop and the iPad would see different threads —
contradicting "lasts until the session ends". Folding it into
`SessionSidePanels` as a sixth key was rejected: that host's single `open` key
is the one-at-a-time rule, and side chat must stay open beside the others.

## Main / daemon

### State — `electron/services/sessions/side-chat.ts`

A pure module in the shape of `elicitations.ts`, one instance per session
handle.

```ts
type SideChatStatus = 'pending' | 'answered' | 'no-answer' | 'failed';

interface SideChatExchange {
  id: string;
  question: string;
  askedAt: string;        // ISO
  status: SideChatStatus;
  answer?: string;
  error?: string;
  answeredAt?: string;    // ISO
}

interface SideChat {
  exchanges: SideChatExchange[];
}
```

- `ask(question)` — rejects if an exchange is `pending` or the question is
  blank. Otherwise appends a `pending` exchange and returns it with the
  `history` to send: the last 20 `answered` exchanges as `{question, response}`.
  `no-answer` and `failed` exchanges are never sent as history.
- `settle(id, generation, reply)` — `response` string → `answered`;
  `response: null` → `no-answer`. A reply whose generation is not current is
  dropped.
- `fail(id, generation, message)` — → `failed`, same generation check.
- `close()` — empties `exchanges` and bumps the generation.
- `snapshot()` — the whole `SideChat`.

The generation counter exists so an answer arriving after close (or after a
close-and-reopen) can never land in the new thread.

### Service surface

On the sessions service, beside `renameSession` in `queries.ts`:

- `askSideQuestion(tabId, question)` — requires a live Claude engine
  (`no-live-engine` / Codex → error, nothing becomes `pending`). Calls
  `ask`, emits the snapshot, then fires
  `engine.sendControlRequest('side_question', {question, history}, {timeoutMs: 600_000})`
  **without awaiting it in the caller**. Settlement/failure updates the state
  and emits a snapshot. Returns once the exchange is `pending`.
- `closeSideChat(tabId)` — `close()`, best-effort CLI cancel (below), emit.
- `getSideChat(tabId)` — `snapshot()`, or empty when the tab is unknown.

When the engine exits, the side chat is cleared and an empty snapshot emitted.
`pendingControlRequests.failAll` on exit already rejects the in-flight ask; the
generation bump from the clear drops that rejection.

### Per-call control-request timeout

`control-request-registry.ts` defaults every request to 10 s. A side question
routinely takes longer, so it would fail almost every time.
`sendControlRequest(subtype, params, opts?: {timeoutMs?})` passes `timeoutMs`
through to `pendingControlRequests.create`. Every existing caller is unchanged
and keeps 10 s.

### CLI-side cancel on close

Verified in 2.1.282: the stdio handler registers each side question's abort
controller under its `request_id`, and a host-sent
`{type:'control_cancel_request', request_id}` aborts it; the CLI then replies
with the error "Side question cancelled". So close sends the cancel for a
pending exchange, and the generation check drops that error reply. This needs
the engine to expose the request id of an in-flight `sendControlRequest` (or a
`cancelControlRequest(id)`), since today it only returns a promise.

### What side chat never touches

- `turn`, `sessionStatus`, `conversationStatus`. Side chat is not a state axis
  (`docs/session-lifecycle.md`); a pending side question is not "in flight"
  and does not hold the updater's install gate.
- The transcript, `messages[]`, the JSONL tail, the Brain.

## Transport

- **Event:** `session-side-chat:<tabId>`, payload = the full `SideChat`
  snapshot after every change. Always a snapshot, never a delta: replaying the
  event log on reconnect converges on current state, and a close replays as
  empty.
- **Invoke:** `session_side_chat_ask {tabId, question}`,
  `session_side_chat_close {tabId}`, `session_get_side_chat {tabId}`.
  Added to `INVOKE_CHANNELS`; adapters accept `tabId ?? tab_id`.
- **Not native-only.** They need no window, display or pty. The rpc allow-list
  is subtractive, so they reach the daemon over `rpc.invoke` with no change.
- **Bridge:** no change. `bridge.ts`'s default case already forwards an
  unmapped tab-scoped channel as a session `event` under its own prefix, which
  the client shim re-emits. The `session-` prefix is already in the preload's
  event allow-list.
- **Daemon/main parity:** the behaviour lives in the sessions service and the
  shared handler surface, which both composition roots already wire. Nothing
  is hand-duplicated.

## Renderer

### Layout

```
┌──────────── session tab ─────────────────────┬──────────────┐
│ transcript          [MCP/Inspector overlay ▸]│  Side chat ✕ │
│                                              │  Q: …        │
│                                              │  A: …        │
│ composer                                     │  [ask…    ⏎] │
└──────────────────────────────────────────────┴──────────────┘
```

- A docked column, a flex sibling of the messages area. Opening it narrows the
  transcript once; it is not the per-toggle reflow `sm:mr-96` caused, because it
  stays open.
- The existing overlays (Inspector, MCP, Plugins, Permissions, Context) keep
  overlaying the — now narrower — messages area and keep closing each other.
  Side chat is outside that rule.
- Drag-resizable; width in `omnifex.sideChat.panelWidth`.

### Open / close

- A button in the composer's button row, in the slot the Copy-conversation
  popover held (`MessageCircleQuestion`). Hidden for Codex sessions. Copy
  session (Markdown/JSONL) is removed outright — unused.
- Button and bare `/btw` are the same action: open the panel, focus its input,
  send nothing. The question goes to the CLI only when sent from the panel
  (or typed inline as `/btw <question>`).
- `/btw <question>` in the main composer opens the panel and asks, instead of
  sending a prompt. `/btw` alone opens the panel with focus in its input.
- Visible when the local open flag is set **or** the side chat has any
  exchanges — so a thread in progress reappears after a reload and on the iPad.
  The open flag is per-client React state; the thread is shared.
- ✕ with exchanges → confirm ("Discard this side chat?"), then
  `session_side_chat_close`. ✕ on an empty panel just closes.

### Panel — `src/components/SideChatPanel.tsx`

- Header note: "Answers from the conversation so far. No tools. Not saved to
  the session."
- Each exchange: the question, then the answer through the transcript's
  existing markdown renderer.
  - `pending` — spinner, "Thinking…".
  - `no-answer` — muted "No answer".
  - `answered` with `synthetic` / refusal — rendered as returned.
  - `failed` — the error inline, with Retry (re-asks the same question as a new
    exchange).
- Input: auto-growing textarea pinned to the bottom. Enter sends,
  Shift+Enter newlines. Editable while a question is pending; Send disabled.

### Hook — `useSideChat(tabId)`

Seeds from `session_get_side_chat`, then applies `session-side-chat:<tabId>`
snapshots. Exposes `{ sideChat, ask, close }`. `AgentSession.tsx` only mounts
the panel and adds the button — the state does not go into that component.

## Errors

| Case | Result |
|---|---|
| No live engine / Codex | Ask rejected; error shown in the panel; nothing `pending`. |
| Second ask while pending | Rejected (the UI prevents it; the service enforces it). |
| Control error reply / 600 s timeout | Exchange → `failed` with the message. |
| Engine exits mid-ask | Side chat cleared; the rejection is dropped by generation. |
| Reply after close | Dropped by generation. |
| CLI without the handler | The CLI's error reply → `failed` with its text. No version gate. |

## Cost

Side chat does not track its own spend.

Observed in session `cf57222a-931a-4502-9a20-531f80cd4b0f` (TUI, three `/btw`
calls): the JSONL holds nothing from the side questions, but the CLI's
`cost-state` record — its own running total — counts them. Its Opus
`cacheReadInputTokens` ran 447k over the transcript's (about six extra reads of
the ~75k context: the three side questions plus, likely, three prompt
suggestions), ≈ $0.19 of a $0.87 session.

So side-question spend is one instance of a wider gap: every fork the CLI runs
with `skipTranscript` (side questions, prompt suggestions, and the like) is
invisible to the transcript-derived Cost Report. That gap is fixed once, for all
of them, by reconciling against `cost-state` — separate work with its own spec.
Side chat adds no cost code. Until that fix exists, side-chat spend is
unreported (a few cents a question). The one concession: the ask path logs the
reply's `usage`, `synthetic` and answer length (not the text), plus the model —
the handle's last assistant model, since the reply names none and sessions
switch models mid-way, and the refusal-fallback model when the CLI used one —
through
`logControl`, as `setTitle` does, so real per-question numbers are in
`app_logs` if the reconciliation is ever weighed.

## Accepted consequences

- **Side-chat text in the daemon's event log.** `~/.omnifex/sessions/<id>.events.jsonl`
  records the snapshots, as it already records the transcript. It is not a CLI
  transcript, so the Brain's sources do not read it — to be confirmed at plan
  time.
- **Undocumented CLI surface.** The CLI review should add `side_question`'s
  request/response shape to what it diffs.

## Testing

TDD, failing test first.

- `electron/__tests__/sessions/side-chat.test.ts` — pending on ask; second ask
  rejected; history is the last 20 `answered` only; `null` → `no-answer`;
  failure → `failed`; close resets and drops a late settle; engine exit clears.
- Engine — `sendControlRequest` honours `timeoutMs`; the default stays 10 s.
- Sessions service — ask on a dead engine and on Codex is rejected; ask emits a
  snapshot before the CLI replies; settlement emits again.
- IPC — the three channels are pinned by `ipc-channel-contract.test.ts`; the
  native-channel guardrail keeps them off `NATIVE_INVOKE_CHANNELS`.
- Bridge — `session-side-chat:<id>` forwards as a session event.
- Renderer — `useSideChat` seeds then applies snapshots; `SideChatPanel`
  renders each status and confirms before discarding; the composer routes
  `/btw <q>` to the side chat and does not send it as a prompt.
- Gate: `npm run check`, `npm run build`, `npm run test:coverage` (cross-cutting).
  One real side question against the installed app after the build; no dev
  instance is launched for it.
