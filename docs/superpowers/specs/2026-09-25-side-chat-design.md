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
- Reply: `{response: string | null, synthetic: boolean, refusal_fallback?:
  {original_model, fallback_model, content}}`. `response: null` means no
  answer. The fork computes a `usage`, but the print-mode wrapper drops it
  before replying (verified in 2.1.282's binary, and `null` in both real
  replies logged 2026-09-25), so no per-call spend reaches the host. See "Cost".
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

Side-chat spend is counted, but not per question: the CLI never tells the host
what a side question cost. The print-mode wrapper drops the fork's `usage`
(verified in 2.1.282; `null` in both real replies logged 2026-09-25). What the
CLI does report is its own running per-model token totals for the process —
`modelUsage` on every `result`, `session.model_usage` from `get_usage` — and
those include every call it keeps out of the transcript: side questions, title
generation, anything run with `skipTranscript`. So the fix counts that whole
gap at once, which side chat is one instance of.

**Capture** — `electron/services/sessions/cli-usage.ts`, shared by main and
the daemon (both pass `createCliProcessUsageStore(db).record` as the sessions
service's last argument; `claude-binary-wiring.test.ts` pins it in both roots):

- `beginCliProcess` on every engine start (first start, resume, restart): a new
  process id, then a **baseline** from `get_usage {skip_behaviors:true}`,
  before the process spends anything. A baseline is required because
  `--resume` restores an earlier process's saved totals when its `cost-state`
  record exists, and does not when it doesn't.
- `recordResultUsage` on every `result`: the **latest** totals.
- `refreshCliUsage` after every side question settles: the latest totals
  again, because no `result` follows a question asked between turns.
- Stored in `cli_process_usage` (migration v28): one row per
  `(session_id, process_id)` with `baseline_json` / `latest_json`.
- Auxiliary: every path swallows and logs. A failed read or a failing store
  never fails or delays the side question or the session.

**Pricing** — `electron/services/cost/unlogged-spend.ts`, run by the hourly cost
sweep (`cost-history.ts` `backfill`):

- Per process and model: `latest − baseline − transcript usage inside the
  process window` (main JSONL + every subagent JSONL, from the process's
  `startedAt` to the next process's), clamped at zero per token category.
- Priced with `computeMessageCost` and the user's `model_pricing` overrides,
  like any transcript row. The CLI's totals carry no cache-write TTL split, so
  those tokens take the existing rule for unsplit usage
  (`splitCacheWriteTokens`: the 5-minute rate, stored in the 5-minute column).
- Written as `session_cost_daily` rows with `session_id = cli-unlogged-<id>`,
  `internal_kind = 'cli-unlogged'`, the session's own account, config dir and
  project, dated by the process's latest figure. `request_count` is 0 — the
  CLI reports totals, not calls.
- A process missing its baseline or its latest figure is skipped and logged,
  never estimated.
- A new figure with no transcript change still rescans the session: the
  process ids and timestamps are part of the sweep's skip signature.

**Nothing counted twice.** `replaceSession(<id>)` deletes a session's rows
wholesale on every rescan, so the CLI-derived rows carry their own id and
survive it. They are the complement of the transcript by construction. The
rule: nothing else may record CLI spend that lacks a transcript — not a
per-call side-question ledger, not a `cost-state` reconciliation — because
it is already inside the CLI's totals and so already in these rows. The Cost
Report counts `cli-unlogged-<id>` as part of `<id>` (`SESSION_KEY` in
`cost-history.ts`), so it never appears as a session of its own.

**Limits.** Hourly, not live: the rows land on the next cost sweep. Sessions
from before this change have no baselines and gain no rows. The ask path still
logs `synthetic`, the answer length and the answering model through
`logControl`; it cannot log tokens, since the reply carries none.

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
