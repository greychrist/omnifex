# Session status bar, popover restructure, and `tool_progress`

2026-09-13. Supersedes nothing; extends the signals work in
`2026-08-31-session-signals-design.md` and the cache row in
`2026-07-30-cache-expiry-timer-design.md`.

Four changes that share one surface — the session widget — plus one wire
correctness fix that the fourth depends on.

1. Restructure the context popover: collapse the category breakdown behind a
   disclosure, compress the three control pickers onto one line, reorder.
2. Render the CLI's `tool_progress` frames on the tool rows they belong to,
   instead of as "Unrecognized record" cards.
3. Turn the widget's accidental bottom row into a real status bar: three
   colored glyphs with live readouts.
4. Stop counting `ambient` tasks as active subagents, because the status bar
   is about to publish that number.

---

## 1. The wire: `tool_progress`

### What it is

Read off the SDK message schema embedded in the 2.1.270 binary (a zod schema
with `.describe()` prose, near byte 167,141,609):

```
{ type: "tool_progress",
  tool_use_id: string,
  tool_name: string,
  parent_tool_use_id: string | null,
  elapsed_time_seconds: int,
  uuid: string,
  session_id: string,
  task_id?: string,
  heartbeat?: boolean,
  subagent_type?: string,
  subagent_retry?: { agent_id: string, attempt: int, max_retries: int,
                     retry_delay_ms: int, error_status: int | null,
                     error_category: string } }
```

Four producers, from the stream-json emitter:

| trigger | shape | reaches us? |
|---|---|---|
| `tool_heartbeat` | `heartbeat: true`, real `elapsed_time_seconds` | **yes** |
| `agent_api_retry` | `subagent_type` + optional `subagent_retry` | **yes** |
| `repl_tool_call` | `repl_call: {...}` — *not in the declared schema* | only with a REPL tool |
| `bash_progress` / `powershell_progress` | `task_id`, real elapsed | **no** — gated on `CLAUDE_CODE_REMOTE` / `CLAUDE_CODE_CONTAINER_ID` |

This spec builds the first two. `repl_call` is emitted but absent from the zod
schema, which makes it the shape most likely to move; `bash_progress` cannot
fire in our configuration.

### Three facts that shape the design

**It is never persisted.** Zero `tool_progress` lines across the on-disk
transcripts on this machine; the frame exists only on the stream-json stdout
path. Anything that put it into `messages[]` would make a live transcript and a
reloaded one disagree. It is therefore an overlay kind, alongside
`stream-event`, `rate-limit` and `lifecycle`.

**The heartbeat's own id is synthetic.** The producer is

```js
var $wt = 30000;
setInterval(() => s({ type: "progress",
                      toolUseID: `${n}-heartbeat-${S++}`,
                      data: { type: "tool_heartbeat", toolName: e,
                              elapsedTimeSeconds: Math.floor((Date.now() - d) / 1000) } }),
            $wt).unref()
```

so frames arrive at 30s, 60s, 90s… and `tool_use_id` is `<realId>-heartbeat-<n>`.
`parent_tool_use_id` is **not** a reliable anchor: the wrapper sets it to
`Se.parentToolUseID ?? n`, which is the enclosing Task id for a tool running
inside a subagent and the tool's own id otherwise. **Anchor on
`tool_use_id.replace(/-heartbeat-\d+$/, '')`** — deterministic in both cases.

**A resolved retry is signalled by absence.** The emitter spreads
`...e.data.resolved !== true && { subagent_retry: {...} }`. A frame carrying
`subagent_type` with no `subagent_retry` key means the retry succeeded.

### Plumbing

- **`src/types/jsonl.ts`** — add `ToolProgressRaw` (typed off the schema above)
  and the node `{ kind: 'tool-progress'; raw: ToolProgressRaw; anchorToolUseId: string }`.
  Add `'tool-progress'` to the literal lists inside `RenderedKind` and
  `OverlayKind`; both are hand-written unions, not inferred, so neither updates
  itself.
- **`src/lib/jsonlClassifier.ts`** — a `case 'tool_progress'`. Rejects
  non-string `tool_use_id` / `tool_name` and non-finite `elapsed_time_seconds`,
  mirroring the CLI's own `sdkMessageAdapter` guard, and returns `null` for
  those (the caller drops nulls). Computes `anchorToolUseId`.
- **`src/lib/toolProgress.ts`** (new, pure) —

  ```ts
  export interface ToolProgressEntry {
    elapsedSeconds: number;
    /** Date.now() when the frame arrived; the chip interpolates from here. */
    arrivedAtMs: number;
    retry: { attempt: number; maxRetries: number;
             errorCategory: string; errorStatus: number | null;
             retryDelayMs: number } | null;
  }
  export function reduceToolProgress(
    prev: ReadonlyMap<string, ToolProgressEntry>,
    node: ToolProgressNode,
    nowMs: number,
  ): Map<string, ToolProgressEntry>;
  ```

  Keyed by `anchorToolUseId`. A heartbeat updates `elapsedSeconds` /
  `arrivedAtMs` and leaves `retry` alone. A `subagent_retry` frame writes
  `retry`; a `subagent_type`-only frame sets `retry: null`. Returns `prev`
  unchanged (same reference) when nothing moved, so a no-op frame cannot
  trigger a render.

  Pure, so it is tested without a store. `nowMs` is injected for the same
  reason.
- **`src/stores/claudeSessionStore.ts`** — `TabSessionState` gains
  `toolProgress: ReadonlyMap<string, ToolProgressEntry>`, empty in
  `EMPTY_TAB_SESSION`, plus an `applyToolProgress(tabId, node)` action. Cleared
  by the existing `resetTab`, so clear/restart needs no new code.
- **`src/components/AgentSession.tsx`** — dispatch in the stream handler, in the
  same place `stream-event` reaches `appendInflightDelta` (~line 1240), then
  fall through the existing overlay `return` at ~line 1253 with
  `'tool-progress'` added to its list.

### Eviction

The chip renders only when `getToolResult(toolId)` is `null`. That render-time
gate is the correctness guarantee — a stale entry can never paint. A prune on
turn end (`cli-stream-result`) keeps the map from growing across a long
session; it is hygiene, not correctness.

### The daemon

`electron/remote/bridge.ts` classifies server-side and emits the typed node;
the client shim unwraps `payload.raw` and re-classifies, so the renderer path is
identical in both modes and needs no remote-specific work.

**REVISED DURING IMPLEMENTATION — no bridge change at all.** The original plan
here was to forward `tool-progress` live and skip the session log, on the theory
that replay bought nothing. It did not survive contact with the code, for two
reasons:

1. `emit()` is `publish(log.append(push))` and `broadcast` accepts only
   `{ type: 'channel' }` messages, so "forward but do not log" needs either a
   new unsequenced push type or a stamp-without-persist method on `SessionLog`
   — new protocol surface, for a saving of one ~200-byte line per 30s per slow
   tool against a 5,000-entry ring. That is roughly 41 hours of continuous
   slow-tool activity before it displaces anything.
2. Replay is not actually harmful, and is marginally useful. The render-time
   gate already suppresses progress for any tool whose result has landed, and
   for a tool still running at reconnect the replayed value is simply correct —
   the client sees its elapsed immediately instead of waiting up to 30s.

Heartbeats therefore ride the ordinary logged path. Two tests in
`remote-bridge.test.ts` pin both halves (classified-and-forwarded, and logged)
so the reasoning is recorded where someone would change it back.

---

## 2. The chip

`src/components/claude/tools/ToolProgressChip.tsx`, rendered by the block
renderer in `StreamMessage.tsx` (~line 863) rather than by each widget, so all
fifteen widgets get it without being touched.

- **Heartbeat** — `⏱ 1:30`, muted mono, on the widget header row. Displays
  `elapsedSeconds + (now − arrivedAtMs)/1000` and ticks via `useSecondTick`, so
  it counts smoothly between the 30s frames instead of jumping by half-minutes.
- **Retry** — `↻ attempt 2/3 · overloaded_error`, amber. `error_status` in the
  tooltip. Clears when the resolved frame lands.
- Both disappear when the `tool_result` arrives.

Only chips for running, unresolved tools subscribe to the tick, so an idle
transcript runs no timer — the same discipline `CacheTimerRow` and
`TabItem` already follow.

---

## 3. Popover restructure — `SessionCard.tsx`

Order, top to bottom:

1. `Context` header + percentage
2. `50,104 / 1,000,000 tokens`
3. `boundary 300k · compact at 30%`
4. pending action card, or `Compact now`
5. **`Details` disclosure — collapsed by default** — the stacked band bar and
   the per-category legend
6. `Recent events`
7. **the one-line control row**
8. `session <guid>` + copy
9. `source: …`

Two existing comments in the file change meaning and must be updated rather
than left to rot:

- The one arguing `Recent events` must sit *above* the breakdown so the unread
  badge's meaning is on screen before the user clears it. Collapsing the
  breakdown by default solves the same problem better; the comment should say
  so rather than describing an order that no longer exists.
- The one on `controlsSummary` explaining the thin summary line above the
  gauge. It stays — it is what makes the live state readable without opening
  the popover — but it is now a summary *of a row two inches below it*, not of
  a stacked block.

**Disclosure state** persists under `greychrist.sessionCard.detailsOpen`,
matching `SubagentBar`'s `COLLAPSE_STORAGE_KEY` precedent: default collapsed,
stays open once opened.

### The control row

`SessionDefaultsRow` gains `density?: 'default' | 'compact'`. Compact implies
`direction: 'row'`, drops the `Field` labels (the pickers carry their own icons
and colors), and asks each picker for a smaller trigger.

The pickers have no size axis today — `EffortPicker` and `PermissionPicker`
take `variant: "compact" | "expanded" | "form"`, where `compact` means *the
bottom bar*: `h-9 px-2`, ghost, and a `ChevronUp` because it opens upward. That
is the wrong control inside a downward popover, and reusing it would make the
bottom bar and the popover share a variant they disagree about.

So: a fourth variant, `"inline"`, on `EffortPicker` and `PermissionPicker`, and
a new `InlineModelPicker` export in `ModelPicker.tsx` beside `FormModelPicker`.
All three render `icon + short label + ChevronDown` at `h-6 px-1.5
text-[11px] font-normal`, and all three reuse their existing dropdown content
unchanged. Existing variants are not touched, so the bottom bar and the
new-session form cannot regress.

The model's short label comes from `resolveActualModelName(...)` — the same
call `sessionControlSummary` already makes for the summary line, so the row and
the line above it cannot disagree about what model is running.

If the three triggers still cannot fit at `w-96`, the popover widens. They do
not truncate: a truncated model name is the one thing on that row a user cannot
guess.

---

## 4. The status bar

`SessionCard` is three columns today (`flex items-start gap-3`), and
`ActivityPill` lines up with `CacheTimerRow` only because both happen to be the
third element of their column. That accident is what makes it look like a
status bar.

Make it one: the card becomes `flex-col`, row one is the existing three
columns, row two is a full-width bar — glyph cluster left, `CacheTimerRow`
right.

### `src/components/SessionStatusBar.tsx`

| | icon | color | readout | pulses |
|---|---|---|---|---|
| working | `ServerCog` | emerald-400 | `1:24` | while the turn is in flight |
| thinking | `Brain` | violet-400 | `12.4k` | while the burst is open |
| agents | `Bot` | sky-400 | count, hidden at 1 | while any is running |

Elapsed is `m:ss`, widening to `h:mm:ss` past an hour. Tokens use the existing
`formatTokens`.

`AgentCountGlyph` moves out of `TabManager.tsx` into its own module; the tab
strip and the status bar both import it, so the two surfaces cannot drift on
color, pulse or the hide-the-numeral-at-one rule.

`ActivityPill` loses `active` and `thinking` and keeps a labelled pill for
`usage-limit`, which is not one of the three and reads as an alarm rather than
a metric.

### Freeze on idle

Both readouts hold the previous round's value between turns. Neither number
survives today:

- **Turn elapsed does not exist.** `activitySignal` has `startedAt` only for
  thinking. Its `meta` gains `turnStartedAt` (anchored where `isLoading` flips
  true) and `lastTurnMs`.

  **REVISED DURING IMPLEMENTATION:** `lastTurnMs` is measured at the same
  `isLoading` transition rather than read off `cli-stream-result.duration_ms`.
  The bar counts live from `turnStartedAt` and freezes on `lastTurnMs`;
  `duration_ms` is API time, not wall time, so sourcing the frozen value from it
  would make the number visibly jump at the exact moment it stopped moving.
- **`deriveThinkingStatus` goes null the instant a burst ends** — it returns
  non-null only while the *trailing* messages are `system:thinking_tokens`
  (`thinkingStatus.ts:42-54`). It gains a `lastBurstTokens` that survives the
  burst, reusing the burst-collapsing logic already in `messageFilters`.

---

## 5. `ambient` — the count the status bar is about to publish

`activeSubagentCount` (`AgentSession.tsx:978`) counts every subagent in
`running`. The 2.1.270 schema attaches an `ambient` flag to `task_started` and
`task_notification`, described as:

> True for tasks that are not activity (every skip_transcript task, plus every
> live-update watcher, requested or auto-started); hosts should exclude them
> from activity indicators.

Nothing in the repo reads it, so watchers and housekeeping tasks inflate the
badge in the tab strip today and would inflate the new status bar identically.

- `src/lib/subagentEvents.ts` parses `ambient` off both events.
- `src/lib/subagentStreams.ts` carries it on `Subagent` and exports
  `countActiveSubagents(subs)` = running and not ambient.
- `runningSubagents` is left alone. Its other callers mean "still open", not
  "worth showing a badge for", and conflating the two is how this bug would
  come back.

`skip_transcript` is a *different* flag with a different job — hide from the
inline transcript, still show in a tasks panel — and is out of scope here.

---

## Testing

TDD; failing test first in every case.

| file | covers |
|---|---|
| `src/lib/__tests__/toolProgress.test.ts` | reducer purity and idempotence, `-heartbeat-N` stripping, retry set/clear, unchanged-reference on no-op |
| `src/lib/__tests__/jsonlClassifier.test.ts` | `tool_progress` classifies as an overlay; malformed frames rejected; `anchorToolUseId` for nested and top-level tools |
| `src/components/__tests__/ToolProgressChip.test.tsx` | heartbeat and retry rendering; suppressed once a result exists |
| `src/components/__tests__/SessionCard.test.tsx` | section order, details collapsed by default, disclosure persistence |
| `src/components/__tests__/SessionStatusBar.test.tsx` | glyph presence, labels, freeze-on-idle, pulse gating |
| `src/lib/__tests__/subagentStreams.test.ts` | ambient excluded from the active count, still present as a row |
| `electron/__tests__/remote-bridge.test.ts` | `tool-progress` classified server-side and forwarded; logged like any other transcript row (see the daemon note) |

Cross-cutting gate, per CLAUDE.md: `npm run check`, `npm run build`,
`npm run test:coverage`, then `npm run rebuild:electron`.

## Out of scope, filed for the next CLI review

Found in the same 2.1.270 schema pass, all unhandled, none blocking this work:

- `tool_use_meta: [{ id, display_name, server_display_name, icon_url }]` —
  per-block display metadata. `display_name` is the MCP server's
  `tool.annotations.title`; `MCPWidget` renders raw `mcp__plugin_foo__bar`
  today.
- `tool_result_meta: [{ id, non_execution_kind, user_feedback }]` — why an
  `is_error: true` result did not execute. The transcript cannot currently tell
  "the tool failed" from "you denied it".
- `supersedes` — wire uuids this message replaces after a refusal fallback.
- `aborted` — assistant message truncated mid-word by an interrupt.
- `spawn_depth`, `workflow_name` on `task_started`.
