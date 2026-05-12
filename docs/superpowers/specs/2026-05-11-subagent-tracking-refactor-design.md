# Subagent Tracking Refactor & Popover Layering — Design

**Date:** 2026-05-11
**Status:** Draft — awaiting user review
**Branches affected:** main → new feature branch
**Bundles:** subagent-state refactor + UsageDetailPopover/SessionCard portal fix

---

## 1. Problem

Two reported bugs, observed live by the user:

**Bug A — subagents stay "running" after the actual work is done.**
SubagentBar shows a row with a spinner / "Waiting for first progress event…" even though the parent session has already emitted `result · success` and is awaiting user input. Because `hasRunningSubagent` bridges the typing-bubble spinner (`src/components/ClaudeCodeSession.tsx:492`), the entire session looks live when it isn't.

**Bug B — popover content punches through.**
`SessionCard`'s context-window `Popover` (rendered in the page header) is `position: absolute` inside a `z-40` parent stacking context. `SubagentBar` lives in a `z-50` container rooted directly under the page, with no parent stacking context. When subagent rows expand they paint on top of the popover, covering the session-id copy icon and the "Clear done" / source rows.

## 2. Diagnostic Evidence

Live session inspected: `5d2c9f24-0302-420c-9d4b-90181e3942f7` (WIN project). The stuck row was `toolu_016hd4wPKBT2wJVdJxhsrGG8` — `Bash` with `run_in_background: true`, description "Run verify.mjs gate in WS-179 worktree".

Inspection of the on-disk JSONL:

- **No** `system + subtype: task_*` messages exist for the stuck `tool_use_id` (none for `task_started`, `task_progress`, or `task_notification`). The whole 216-line file contains only 5 unrelated `stop_hook_summary` system messages.
- The completion signal **does** exist in the JSONL, but as two carriers:
  - Line 209: `{ type: 'queue-operation', operation: 'enqueue', content: '<task-notification>…' }`
  - Line 211: `{ type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>…', commandMode: 'task-notification' } }`
- Both carriers contain `<tool-use-id>toolu_016hd4wPKBT2wJVdJxhsrGG8</tool-use-id>` and `<status>completed</status>`.

Cross-check against `@anthropic-ai/claude-agent-sdk@0.2.139` (`node_modules/.../sdk.d.ts:3164`):

- `SDKMessage` is a discriminated union over `SDKAssistantMessage | SDKUserMessage | SDKUserMessageReplay | SDKResultMessage | SDKSystemMessage | SDKPartialAssistantMessage | SDKCompactBoundaryMessage | SDKStatusMessage | … | SDKTaskNotificationMessage | SDKTaskStartedMessage | SDKTaskUpdatedMessage | SDKTaskProgressMessage | …` and a long tail of others.
- The union **does not** contain a `queue-operation` or `attachment` variant. The SDK's `query()` async iterator only yields union members.

Net: in **live** mode the renderer never receives the carriers that actually closed the background dispatch. The renderer's XML fallback in `subagentStreams.ts:217–246` only works for JSONL reload (where Claude Code's session writer persisted them), never for live streams.

The current orphan detector (`subagentStreams.ts:259–275`) additionally requires another message to exist **after** the `type: 'result'`. In a session awaiting user input, the `result` is the *last* message, so the heuristic never fires.

## 3. Root Causes

1. **Closure signals are not unified.** Foreground `Agent`/`Task` close on `tool_result`; background dispatches need either a structured `task_notification` SystemMessage (often missing) or the XML-in-envelope carriers (never delivered live).
2. **In-place status mutation** in `deriveSubagents` lets late-arriving messages flip status backward, depends on subtle ordering, and has no first-class concept of "terminally locked."
3. **Typing-bubble is bridged to subagent state.** `hasRunningSubagent(subs)` → typing dots. Any false-running row creates a false busy indicator.
4. **Popover stacking context.** `SessionCard` sits in a header at `z-40`; its custom `Popover` is `position: absolute z-50` *within* that context, so it composites under the global `z-50` SubagentBar wrapper.

## 4. Design

### 4.1 Event-sourced subagent state

Replace `deriveSubagents`'s in-place mutation with a pure event-log derivation.

**Events** (per `tool_use_id`):

```ts
type SubagentEvent =
  | { kind: 'Dispatched'; toolUseId; messageIdx; ...metadata }
  | { kind: 'Started'; taskId?; description?; ... }
  | { kind: 'Progress'; usage?; lastToolName?; description?; ... }
  | { kind: 'Completed'; source: 'tool_result' | 'task_notification' | 'task_notification_xml'; summary?; usage? }
  | { kind: 'Failed'; source: …; reason? }
  | { kind: 'ClosedByParentResult'; resultMessageIdx }   // inferred-completion path
  | { kind: 'Abandoned'; reason: 'parent_advanced_past_dispatch' };
```

**Translation layer.** A pure function `messageToEvents(message, ctx) → SubagentEvent[]` converts each SDK / JSONL message into 0+ events. This is the *only* place that knows about SDK message shapes; the rest of the derivation operates on events.

**Reducer.** A pure function `applyEvent(state, event) → state` updates `Subagent` from the event log. Status transitions:

| From → | `Dispatched` | `Started` | `Progress` | `Completed` | `Failed` | `ClosedByParentResult` | `Abandoned` |
|---|---|---|---|---|---|---|---|
| `running` | (idempotent) | apply | apply | → `completed` (locked) | → `failed` (locked) | → `completed_inferred` (locked) | → `abandoned` (locked) |
| any locked terminal | ignore | ignore | ignore | ignore | ignore | ignore | ignore |

Terminal lock is intrinsic to the state machine — once a row reaches a terminal status (`completed` / `failed` / `completed_inferred` / `abandoned`), no further events mutate it. Replaces today's ad-hoc `notificationFinalized` Set.

**Status values:**

| Status | Meaning | Icon |
|---|---|---|
| `running` | dispatched, no terminal signal yet | spinner |
| `completed` | terminal signal received (tool_result success, task_notification status=completed, or XML status=completed) | solid green ✓ |
| `failed` | terminal signal received with error/failed status | red ✕ |
| `completed_inferred` | **new** — terminally inferred because parent emitted `result` after this dispatch without us seeing a direct closure signal | **muted/dashed green ✓** with subdued color (visually distinct from `completed`) |
| `abandoned` | parent advanced past dispatch without resolving (existing heuristic, now generalized to non-background too) | amber ⚠ |

### 4.2 Multi-signal closure (translation rules)

`messageToEvents` emits a `Completed` / `Failed` event for any of these triggers, all carrying the same `tool_use_id`:

1. `type: 'user' + content[].type: 'tool_result'` with `tool_use_id` matching a dispatched subagent — **unless** that subagent is `isBackground` and the tool_result is the immediate non-error ACK (today's exception preserved; encoded via per-subagent metadata stored alongside the event log).
2. `type: 'system' + subtype: 'task_notification'` (structured SDK message — when emitted).
3. `type: 'queue-operation' + operation: 'enqueue'` with `<task-notification>` in `content` (JSONL only).
4. `type: 'attachment'` with `attachment.type: 'queued_command'` and `<task-notification>` in `attachment.prompt` (JSONL only).

In live mode (3) and (4) require the JSONL tail in §4.3 to surface them to the renderer (they are not yielded by the SDK iterator). In JSONL replay (3) and (4) are present in the message array directly. The translation layer is identical for both — only the delivery path changes.

**Inferred closure rule (safety net — not primary).** After processing all messages, for each subagent still in `running`:

- Find the first `type: 'result'` event whose message index ≥ the subagent's dispatch index.
- If found **and** that result is *not* the most recent message in the array (i.e. the parent has clearly advanced past the awaiting turn — a new prompt, a new assistant message, anything), emit `ClosedByParentResult`.

This preserves the conservative half of today's orphan heuristic (`resultIdx < messages.length - 1`) but **drops the `isBackground` restriction** so foreground `Agent`/`Task` dispatches that lost their `tool_result` are also covered. The "result is most recent" case is intentionally left as `running` because the parent may legitimately have emitted a result while a long-running background continues (e.g. "I started npm test in the background, will report back"). In that scenario, the JSONL tail in §4.3 is the primary closure path — when the real `task-notification` lands on disk, the live tail forwards it and the row reaches `completed` directly. Inference is the safety net for cases where the carrier never lands at all.

Rendered as `completed_inferred` so the gap (live signal missing) remains visible.

**Abandoned vs completed_inferred.** Today there is no path that produces `abandoned` for foreground dispatches and the background heuristic was the only producer. Under this design, `abandoned` is reserved for an explicit "we know this didn't finish" case (currently dead; left in the type union for forward use, e.g. when we add a watchdog that times out). Inferred closure always uses `completed_inferred`.

### 4.3 Live JSONL tail for background carriers

The renderer cannot infer background closure from the live SDK stream alone (carriers are not in the SDK union). Main-process change:

- New service module `electron/services/sessions/jsonl-tail.ts`. Given `{ sessionId, configDir, projectKey }`, resolves the JSONL path (`<configDir>/projects/<projectKey>/<sessionId>.jsonl`), opens a tail using `fs.watch` + offset bookkeeping (or `chokidar` if it's already in the dep tree — check first), and parses appended lines.
- For each parsed line whose `type` is `queue-operation` or `attachment`, forward to the renderer on a **new** IPC channel `claude-output-extra:<tabId>` with the parsed object. Add the channel prefix to the preload allow-list (`electron/preload.ts`).
- All other line types are ignored — the SDK stream is the source of truth for everything else.
- Lifecycle: start the tail in `runtime.ts:listenToMessages` once `handle.sessionId` is known (after `system:init`); stop on session close / error / replace.
- Reload path is unchanged — `loadSessionHistory` already pulls everything from JSONL.

The renderer's `useSessionLifecycle` subscribes to `claude-output-extra:<tabId>` and feeds those messages into the same `setMessages` pipeline that handles `claude-output:<tabId>`. No new union member is needed; `ClaudeStreamMessage` already needs a permissive shape for these carriers (it already extends with `OmnifexEnvelope` per the recent type refactor).

**Why a separate channel.** Keeps `claude-output:<tabId>` 1:1 with SDK output (preserves current type narrowing in the stream reducer), surfaces the new path explicitly for testing and logging, and makes it easy to disable behind a feature flag if it misbehaves in the wild.

### 4.4 Decouple typing bubble from subagent state

`hasRunningSubagent` is removed from the typing-indicator path in `ClaudeCodeSession.tsx`. The bubble follows `handle.status === 'running'` (already tracked in main, mirrored to renderer via existing session-status events) — i.e. it reflects whether the SDK is actively producing a turn.

This deliberately decouples *visual session activity* from *outstanding background dispatches*. A subagent stuck in `running` no longer fakes a live turn. SubagentBar continues to show the spinner per-row, which is the appropriate scope.

`hasRunningSubagent` itself is kept (other callers may want it), but the typing bridge stops calling it.

### 4.5 Popover portal fix

`src/components/ui/popover.tsx`:

- Wrap the open-state JSX in `ReactDOM.createPortal(…, document.body)`.
- Reposition from `position: absolute` (parent-anchored) to `position: fixed`, with coordinates computed from the trigger's `getBoundingClientRect()` and the chosen `side`/`align`.
- Track repositioning on scroll/resize via `ResizeObserver` on the trigger and a `scroll`/`resize` listener.

Side effect: the popover escapes every parent stacking context. SubagentBar's `z-50` rows can no longer punch through because the portal target sits at `document.body` above the entire app shell. `SessionCard`'s usage popover is the immediate beneficiary; all other consumers of `ui/popover.tsx` get the same fix transparently.

Trade-off considered: a one-line `isolate` / explicit `z-[60]` on the popover wrapper would work for *this* specific clash but doesn't fix the underlying class (any future z-50 sibling outside the header would re-break it). Portal is the structurally correct fix and unblocks future popovers in `SubagentBar` itself (e.g. per-row detail) without coupling them to header z-index.

### 4.6 SubagentBar rendering changes

- Add a `completed_inferred` icon variant: green check with `opacity-60` + dashed inner ring (vs solid).
- When a row reaches `completed_inferred`, replace the "Waiting for first progress event…" placeholder with `"Completed (no progress reported)"` — the user has explicit signal that we inferred completion rather than receiving a notification.
- Tooltip on the inferred icon: `"Completion inferred from parent result — no task-notification was delivered."` Helps spot SDK-side gaps over time.

## 5. Files

**New:**
- `src/lib/subagentEvents.ts` — `messageToEvents` + `applyEvent` + state machine types
- `electron/services/sessions/jsonl-tail.ts` — main-process tail
- `electron/__tests__/sessions-jsonl-tail.test.ts`
- `src/lib/__tests__/subagentEvents.test.ts`

**Modified:**
- `src/lib/subagentStreams.ts` — `deriveSubagents` becomes a thin wrapper: map → flat events → reduce. `clearCompleted`/`hasRunningSubagent` unchanged in signature.
- `src/components/SubagentBar.tsx` — render `completed_inferred` variant, placeholder text swap
- `src/components/ClaudeCodeSession.tsx` — remove `hasRunningSubagent` from typing-bubble bridge; subscribe to `claude-output-extra:<tabId>` and route into `appendMessage`
- `src/hooks/useSessionLifecycle.ts` — add the extra subscription
- `src/components/ui/popover.tsx` — portal + fixed positioning
- `electron/services/sessions/runtime.ts` — start/stop JSONL tail
- `electron/services/sessions/types.ts` — tail handle on `SessionHandle`
- `electron/preload.ts` — allow-list `claude-output-extra:*`
- `src/types/claudeStream.ts` — accept `queue-operation` / `attachment` shapes explicitly (they are already permissively typed via `OmnifexEnvelope`, but adding named members improves the translation layer's typing)

**Removed (or repurposed):**
- The current background-only orphan loop at `subagentStreams.ts:259–275` — replaced by the generalized `ClosedByParentResult` inference rule.

## 6. Testing

Frame each as a behavioral test, not a structural one.

1. **Bug A direct repro — JSONL-tail closes background.** Synthesize the exact `5d2c9f24` sequence in a renderer test: dispatch (Bash, `run_in_background:true`) → ACK tool_result → `attachment` with `<task-notification status=completed>` arriving via the tail-routed path. `deriveSubagents` returns the subagent as `completed` (the direct carrier wins; no inference involved).
2. **Inferred closure fires when parent advances past result.** Sequence: dispatch → ACK → assistant text → `result` → user message → assistant text. Inferred closure rule fires (result is not the last message). Status `completed_inferred`.
3. **Inferred closure does NOT fire when result is the last message.** Sequence: dispatch → ACK → assistant text → `result`. Status stays `running` (the long-running-background case — JSONL tail is expected to deliver the real signal).
4. **JSONL replay with attachment carrier reaches `completed`.** Same as test 1 but via `loadSessionHistory` path rather than tail event. Direct carrier in message array. Status `completed`.
5. **JSONL replay with queue-operation carrier reaches `completed`.** Same but with the enqueue envelope.
6. **Structured `task_notification` wins over later `tool_result`.** Sequence: dispatch → `task_notification(status=completed, summary=X)` → `tool_result(is_error=false)`. Final state has the summary; status `completed`; terminal lock prevented overwrite.
7. **Foreground Agent normal path.** Dispatch `Agent` tool_use → `task_started` → `task_progress` → `tool_result(is_error=false)` → status `completed`.
8. **Failed tool_result produces `failed`.** Dispatch → ACK error → status `failed`.
9. **Live JSONL tail forwards `attachment` to renderer.** Main-process test: write a fake JSONL line; assert `sendToRenderer` called on `claude-output-extra:<tabId>` with the parsed object.
10. **Tail stops on session close.** Resource leak guard — disposing the session handle removes the watcher.
11. **Popover portal.** DOM test that the popover content node's `parentElement` is `document.body`, not the trigger's parent.
12. **Typing bubble no longer triggered by stuck subagent.** Render session with one `running` subagent and `handle.status: 'idle'` — bubble is absent.

Coverage gate: maintain the project's 80% line target for `src/lib/subagentEvents.ts` and `electron/services/sessions/jsonl-tail.ts`.

## 7. Migration / rollout

- Single PR. The two bugs are sufficiently coupled by the popover-vs-SubagentBar interaction that splitting adds little value and the user prefers bundling.
- No DB migration, no config-schema change.
- Existing JSONLs reload as before (the carrier handlers already exist; the refactor preserves their behavior).
- Feature flag: an env guard `OMNIFEX_DISABLE_JSONL_TAIL=1` short-circuits the tail subscription, in case it misbehaves on a user's filesystem. Defaults off.

## 8. Out of scope

- Watchdog timeouts for foreground `Agent`/`Task` dispatches that genuinely hang upstream (would emit `Abandoned`). The current change leaves them in `running` indefinitely as today — but they'll resolve via `ClosedByParentResult` once the parent emits its result. A real watchdog can come later when we have data on what "too long" means.
- Reworking `SubagentBar` UX beyond the icon/placeholder additions in §4.6.
- Changing `clearCompleted` semantics. Today it filters out everything not in `running`; under the new scheme that includes `completed_inferred` — confirmed intentional ("Clear done" should also clear inferred-done rows).
- Replacing the bespoke `ui/popover.tsx` with a Radix popover. The portal change is small and self-contained; a full Radix swap is a separate cleanup.

## 9. Open questions

None known. Two soft assumptions worth flagging:

- The JSONL path conventions (`<configDir>/projects/<projectKey>/<sessionId>.jsonl`) are stable in current CLI versions. If a future SDK rev moves them, `jsonl-tail.ts` is the single place to update.
- The conservative inference rule (only fire when `result` is not the most recent message) intentionally leaves long-running backgrounds visible as `running` until either the JSONL tail delivers the real signal or the parent moves on. The primary fix for Bug A is the JSONL tail itself; inference is the safety net for cases where the carrier never lands at all. If watchdog timeouts become useful later (§8 out-of-scope), they would emit `Abandoned`, not `ClosedByParentResult`.
