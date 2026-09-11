# Session signals — routing notices to the widget they concern

**Status:** implemented, 2026-09-11
**Replaces:** the banner stack above the transcript (five components)

## The problem

OmniFex answered every "the user should know this" with another horizontal bar.
By the time this was written there were five, in two stacks:

| Component | What it said |
|---|---|
| `AccountMismatchBanner` | this config dir is signed in as somebody else |
| `ContextPressureBanner` | context is past your budget, click to `/compact` |
| `SessionNotices` | this prompt added 325k · cache TTL changed · N MCP servers skipped |
| `ThinkingBar` | thinking, ~13,400 tokens |
| `UsageLimitBanner` | parked on a usage limit, resets in 2h |

Each was locally correct and separately justified — the specs are still in this
directory. The sum was not: a strip of amber rows, none attached to the thing it
described, all competing for the space directly above the transcript, several
capable of being on screen at once.

The failure mode is not aesthetic. A row that is always there is a row nobody
reads, so the one that mattered — "compact now" — had the same weight as "cache
TTL changed".

## The model

A signal names the widget it is **about** (`anchor`) and what the UI should
**do** with it (`kind`). Those two fields are the whole design.

```ts
type SignalKind   = 'state' | 'event' | 'action';
type SignalAnchor = 'session' | 'account' | 'branch' | 'agents' | 'mcp';
```

| Kind | Routing | May take space? |
|---|---|---|
| `state` | updates the anchored widget in place; same `key` replaces | never |
| `event` | appends to the anchor's log, increments its unread badge | never |
| `action` | enters the attention queue **and** the anchor's popover | one at a time |

`src/lib/signals/store.ts` enforces this and nothing else does. `types.ts` holds
the shapes, `emitters.ts` produces them, `useSessionSignals.ts` binds a store to
a tab.

### Signals are derived, never pushed

This is the property everything else rests on. `deriveSessionSignals` is a pure
function of state `AgentSession` already holds — the message array, the resolved
context numbers, the settings — and it re-runs on every render.

Three consequences:

- **`emit` must be idempotent.** Re-emitting the same thing cannot duplicate a
  row, resurrect a read event, or un-dismiss an action. Events therefore de-dupe
  on `id` (anchored to a prompt uuid or a server name), not on `key`.
- **Retraction is free.** `reconcile` drops any `state` or `action` whose key the
  current derivation no longer produces, so a signal lives exactly as long as the
  condition behind it. There is no "clear" call to forget.
- **Remote mode needs no replay path.** A session resumed from the daemon
  replays the stream, the stream produces the messages, and the same derivation
  rebuilds every `state` signal. Events are bounded by the transcript window for
  the same reason.

The original plan called for subscribing to the `claude-notification` /
`session-cost` channels. That was wrong on the facts: `claude-notification` is
the desktop-notification channel (`{title, body, is_error}`) and carries none of
this. Every signal here comes from the renderer's own message stream.

## Where each notice went

| Was | Is | Anchor |
|---|---|---|
| "this prompt added 325k" banner | `event` `context.delta`, one per turn | session |
| context-pressure banner, amber half | `state` `context.level` → meter colour | session |
| context-pressure banner, red half | `action` `context.boundary` → attention slot | session |
| thinking bar | `state` `session.activity` → activity pill | session |
| usage-limit banner | `state` `session.activity` (`usage-limit`) → activity pill | session |
| cache-TTL notice | `event` `cache.ttl` | session |
| skipped MCP servers | `event` `mcp.skipped.<server>` | mcp |
| account mismatch | `action` `account.mismatch` | account |

### Splitting the pressure banner is the load-bearing decision

The banner escalated in two steps — amber at 80% of budget, red at 100% —
because a banner was the only surface it had. Under this model those steps are
different **kinds**. "Getting full" is a value, so it tints the meter in place.
"Do something about it" is a call to action, so it goes to the attention slot,
and **only at `critical`**.

Routing `warn` to the slot as well would put an item there that says nothing the
meter's colour has not already said — which is how the stack grew the first time.

## UI

### Two pills, not one

The session widget's existing status pill reports `sessionStatus` — is the CLI
process up. `docs/session-lifecycle.md` invariant 5 forbids the renderer from
keeping a second copy of that, so the activity signal renders as a **separate
pill below it**: `thinking 12s`, `limit · 2h`, or nothing. Two pills that each
answer one question beat one pill that blurs two.

The thinking clock comes from the burst's *first* `thinking_tokens` ping, not
`Date.now()` on first sight, so it survives a remount and reads the same on a
resumed transcript. The token count moved to the pill's tooltip.

### The meter reads the budget, not the window

`SessionCard` used to colour at `pct > 80 / > 50` of the **window**. The budget
is a different scale — 250k on a 1M window is critical at 25% full — so the meter
was green while the banner was red. It now takes its colour from
`context.level`, and draws a tick where the budget sits so "compact at 25%" is
visible rather than implied.

### The gutter is the only inline home for a delta

`ContextTimelineTick` already stamped cumulative context per sample and labelled
jumps. It now labels **every** turn's delta, reconstructs the drop across a
compaction from `prevTokens` (`delta` stays null there, or `isJump` and the level
colouring would start treating a reset as a step), and offers `before → after` on
hover. Compact output mode hides deltas under 2k; Verbose shows all of them.

`context_timeline_enabled` **flipped to on by default**. It shipped off as an
opt-in retrospective view while the banner stack carried context growth for
everyone else; with the banners gone, leaving it off would have silently removed
the signal for the default user.

### `AttentionSlot`

One item, ever. Overflow is a `1 of N` counter, not another row — that rule is
what stops the stack growing back. Sits directly above `SubagentBar` at a
matching row height, returns `null` (not an empty box) when the queue is empty.

Dismiss is safe here only because a dismissed action keeps standing in its
anchored widget's popover until the condition ends. The old pressure banner had
to be non-dismissible for exactly the lack of that surface.

**Snooze** adds 20k to the budget for this tab and stands the action down. The
offset is stored but applied by the *emitter*, so the action that returns once
the raised line is crossed is a genuinely new one rather than a suppressed one —
that is what "re-arms" means. Snoozing twice buys 40k. "Raise limit" is the
different verb for the different scope: it writes the shared setting.

## What deliberately did not become a signal

- **Subagents and todos.** Not notices; they have their own collapsible bar,
  left as it was. The attention slot sits above it, never beside it.
- **Tool permission prompts.** `PermissionCard` / `AskUserQuestionCard` are rich
  cards with suggestion checkboxes and selectable options. `SignalAction[]` is a
  row of buttons and cannot express them.
- **MCP needs-auth.** Does not surface anywhere in the app today, so there was
  nothing to migrate. The `mcp` anchor and its badge are wired, so an emitter is
  all it would take.

## Guardrail

`src/components/__tests__/bannerStackRemoved.test.ts` asserts the five
components are gone, that `AgentSession` cannot import them back, and that
exactly one `AttentionSlot` is mounted. If it fails, the question to answer
first is which anchor the new notice belongs to — not where to put another bar.
