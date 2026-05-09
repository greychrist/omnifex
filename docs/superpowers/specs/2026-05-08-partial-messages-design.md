# Partial messages — token-level assistant text streaming

Status: design
Owner: Greg
Surface: `electron/services/sessions/factory.ts`, `src/stores/claudeSessionStore.ts`, `src/components/ClaudeCodeSession.tsx`, new `src/lib/inflightCoalescer.ts`, new `src/components/InflightAssistantBubble.tsx`

## Problem

Today, when Claude takes 8 seconds to reply, the user stares at a spinner. The Claude Agent SDK supports `includePartialMessages: true`, which streams `SDKPartialAssistantMessage` events (each carrying a `BetaRawMessageStreamEvent`) so the renderer can paint assistant text as Claude generates it. OmniFex doesn't enable this today.

The runtime side is already partials-aware: `electron/services/sessions/events.ts:86-88` returns `{ kind: 'streamEvent' }` for `type: 'stream_event'`, the FSM has the explicit no-op case branch (`runtime.ts:97-102`), and `runtime.ts:112` already forwards every message — including stream events — over `claude-output:${tabId}`. So enabling the flag delivers stream events to the renderer; the missing piece is renderer-side: the reducer (`sessionStreamReducer.ts`) and store (`claudeSessionStore.ts`) treat `messages` as an append-only list of complete SDK messages, with no concept of an in-flight assistant.

## Solution summary

Always-on `includePartialMessages: true` in `buildSdkOptions`, plus a renderer-side **text-only** streaming pipeline: the existing `claude-output:${tabId}` subscriber detects `type: 'stream_event'` ahead of the reducer, filters to `text_delta` content-block deltas, and routes them through a new sidecar `inflightCoalescer.ts` module. The coalescer accumulates per-tab text in an off-Zustand Map and flushes once per `requestAnimationFrame` to a new `setInflightAssistantText` store action. A new `<InflightAssistantBubble />` component renders the slot as an assistant-styled bubble with a blinking cursor `|` at the end. When the SDK's complete assistant message lands (matching the streamed message by uuid), the subscriber clears the slot and lets the existing reducer append the canonical complete message — single source of truth in `messages[]`, no mutation.

The reducer stays pure. The store gains one optional slot field and two actions. Zero new IPC channels.

## Settled UX decisions

| Decision | Outcome |
|---|---|
| Delta scope | Text-only. Reducer/subscriber handles `text_delta` only; ignores `input_json_delta`, `thinking_delta`, `signature_delta`, `citations_delta`, `compaction_delta`. Tool args, thinking, citations all keep current full-block render. |
| In-flight state | Separate slot `inflightAssistant: { uuid, text, parentToolUseId } \| null` on `TabSessionState`. `messages[]` stays append-only. Slot reconciles by uuid match when the complete assistant message arrives. |
| Toggle | Always-on. `includePartialMessages: true` set unconditionally in `factory.ts`. Same shape as the rewindFiles checkpoint flag. |
| Backpressure | RAF-bounded coalescing at the store-write boundary. Per-tab module-level buffer Map; one RAF flush per frame regardless of how many deltas arrive. |
| Visual | Plain assistant-styled bubble that grows with the streamed text + a subtle blinking `|` cursor at the end. Cursor disappears when the slot clears (complete assistant lands, OR error card lands, OR explicit clear). The existing per-tab `isLoading` spinner is cleared on the first `setInflightAssistantText` flush so the streaming bubble naturally replaces it. |
| Subagent partials (`parent_tool_use_id !== null`) | Filtered out at the IPC subscriber in v1. Captured as future work for SubagentBar streaming. |

## Component & data flow

### Main process

- **`electron/services/sessions/factory.ts`** — In `buildSdkOptions()`, add to the options object literal next to the existing flags:

  ```ts
  // Stream token-level partial assistant messages so the renderer can paint
  // assistant text as Claude generates it (rendered into the inflight slot
  // via src/lib/inflightCoalescer.ts). Subagent partials and non-text deltas
  // are filtered renderer-side; this flag is the single switch.
  includePartialMessages: true,
  ```

  No other main-process changes. `runtime.ts` already forwards stream events; `events.ts:classifyRuntimeEvent` already classifies them.

### Renderer

- **`src/lib/inflightCoalescer.ts`** *(new)* — Per-tab text-buffer Map + RAF flush. Functional API; module-level state. The coalescer **owns** the buffer and the RAF schedule, but **does not own** the rendered surface (Zustand does). React reconciles only on flush, never per delta.

  ```ts
  import { useClaudeSessionStore } from '@/stores/claudeSessionStore';

  interface Buffer {
    uuid: string;
    text: string;
    parentToolUseId: string | null;
  }

  const buffers = new Map<string, Buffer>();
  let rafHandle: number | null = null;

  /** Append a text_delta chunk to the per-tab buffer keyed by assistant uuid.
   *  A new uuid resets the buffer (any leftover partials from a never-completed
   *  prior turn are discarded). Schedules a RAF flush if not already pending. */
  export function appendInflightDelta(
    tabId: string,
    uuid: string,
    deltaText: string,
    parentToolUseId: string | null,
  ): void {
    const existing = buffers.get(tabId);
    if (existing && existing.uuid === uuid) {
      existing.text += deltaText;
    } else {
      buffers.set(tabId, { uuid, text: deltaText, parentToolUseId });
    }
    scheduleFlush();
  }

  /** Drop the per-tab buffer without flushing. Call on tab close, on receipt
   *  of the complete assistant message that matches, and on stream error. */
  export function clearInflightBuffer(tabId: string): void {
    buffers.delete(tabId);
  }

  function scheduleFlush(): void {
    if (rafHandle !== null) return;
    rafHandle = requestAnimationFrame(flush);
  }

  function flush(): void {
    rafHandle = null;
    if (buffers.size === 0) return;
    const { setInflightAssistantText } = useClaudeSessionStore.getState();
    for (const [tabId, buf] of buffers) {
      setInflightAssistantText(tabId, buf.uuid, buf.text, buf.parentToolUseId);
    }
  }

  /** Test-only — wipe internal state between cases. */
  export function __resetCoalescerForTests(): void {
    buffers.clear();
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
  }
  ```

- **`src/stores/claudeSessionStore.ts`** — Add to `TabSessionState`:

  ```ts
  /** Text-streaming slot for partial messages. Populated by the
   *  inflight coalescer's RAF flush; cleared when the complete assistant
   *  message lands (matching uuid), on stream error, or on tab close. */
  inflightAssistant: {
    uuid: string;
    text: string;
    parentToolUseId: string | null;
  } | null;
  ```

  Add to `EMPTY_TAB_SESSION`:

  ```ts
  inflightAssistant: null,
  ```

  Add two actions to `ClaudeSessionStoreState`:

  ```ts
  setInflightAssistantText(
    tabId: string,
    uuid: string,
    text: string,
    parentToolUseId: string | null,
  ): void;
  clearInflightAssistant(tabId: string): void;
  ```

  Implementations follow the existing `patchTab` / `appendMessage` shape — copy-on-write into `tabs[tabId]`.

- **`src/components/InflightAssistantBubble.tsx`** *(new)* — minimal renderer over the slot:

  ```tsx
  import React from 'react';
  import { useClaudeSessionStore } from '@/stores/claudeSessionStore';
  import { Card, CardContent } from '@/components/ui/card';
  import { MarkdownBlock } from './MarkdownBlock';
  import { cn } from '@/lib/utils';

  /**
   * Renders the in-flight assistant text from the inflight slot, with a
   * blinking cursor at the end. Returns null when the slot is empty —
   * the only side effect is mounting/unmounting based on slot presence.
   *
   * Once the complete assistant message lands, the subscriber clears the
   * slot and the bubble unmounts, replaced by the canonical message
   * already appended into messages[] by the reducer.
   *
   * Subscribes via a narrow store selector so this component re-renders
   * ONLY when the inflight slot changes — not on unrelated tab state
   * mutations (messages[] appends, account info refresh, etc.).
   */
  export const InflightAssistantBubble: React.FC<{ tabId: string }> = ({ tabId }) => {
    const inflight = useClaudeSessionStore(
      (s) => s.tabs[tabId]?.inflightAssistant ?? null,
    );
    if (!inflight || !inflight.text) return null;
    return (
      <Card className={cn('group/card relative my-1 border-border/40')}>
        <CardContent className="prose prose-sm dark:prose-invert max-w-none py-2 px-3">
          <MarkdownBlock content={inflight.text} />
          <span
            aria-hidden
            className="animate-pulse text-muted-foreground inline-block ml-0.5"
          >
            |
          </span>
        </CardContent>
      </Card>
    );
  };
  ```

  Visual styling matches the existing assistant bubble class set — exact tokens depend on `MessageCard` / `StreamMessage` conventions; the implementer should diff against the assistant-message render path in `StreamMessage.tsx` and copy what's there to keep visual parity.

- **`src/components/ClaudeCodeSession.tsx`** — Two changes:

  1. **Branch the IPC subscriber** that handles `claude-output:${tabId}`. Before calling `reduceSessionStreamMessage`, intercept stream events:

     ```ts
     // Inside the existing claude-output:${tabId} handler, before the reducer call:
     if (msg.type === 'stream_event') {
       // Filter subagent partials — out of scope for v1
       if (msg.parent_tool_use_id !== null) return;
       const event = msg.event;
       if (
         event?.type === 'content_block_delta' &&
         event.delta?.type === 'text_delta' &&
         typeof event.delta.text === 'string'
       ) {
         appendInflightDelta(
           tabId,
           msg.uuid,
           event.delta.text,
           msg.parent_tool_use_id,
         );
       }
       return; // never run the regular reducer for stream_event
     }
     ```

  2. **Reconcile on assistant complete and on stream error.** After the reducer runs and effects are applied, two clean-up paths:

     ```ts
     // After the existing append / effects flow:
     if (result.append === 'append' && msg.type === 'assistant') {
       clearInflightAssistant(tabId);
       clearInflightBuffer(tabId);
     }
     // Defensive: any error notification clears the inflight slot so users
     // don't see a stale streaming bubble next to an error card.
     if (
       msg.type === 'system' &&
       msg.subtype === 'notification' &&
       msg.notification_type === 'error'
     ) {
       clearInflightAssistant(tabId);
       clearInflightBuffer(tabId);
     }
     ```

  3. **Mount the bubble** after the existing message-list `.map(...)`:

     ```tsx
     {/* Existing message list */}
     {messages.map(/* … */)}
     {/* New: in-flight streaming bubble (renders null when slot empty) */}
     <InflightAssistantBubble tabId={tabId} />
     {/* Existing TodoBar / SubagentBar / FloatingPromptInput etc. */}
     ```

  4. **Cleanup on unmount.** In the existing `useEffect` that handles tab teardown (or a new one if absent), call `clearInflightBuffer(tabId)` so the Map doesn't leak across long-lived renderer sessions:

     ```ts
     useEffect(() => () => clearInflightBuffer(tabId), [tabId]);
     ```

### Data flow (sequence)

```
[main: SDK stream] ──IPC──> claude-output:tabId
                                   │
                    type === 'stream_event'?
              ┌─────yes─────┐         ┌─no──┐
              ▼             │         ▼     │
   parent_tool_use_id !== null?       reduceSessionStreamMessage(msg, ctx)
        ┌yes┐  ┌no──────────│              │ returns { append, effects, … }
        │   │  │            │              ▼
        ▼   │  ▼            │         apply effects (existing path)
       drop │  event.type === 'content_block_delta'
            │  && delta.type === 'text_delta'?
            │     ┌yes──┐  ┌─no───┐         after append + assistant:
            │     │     │  │      │            clearInflightAssistant(tabId)
            │     ▼     │  ▼      │            clearInflightBuffer(tabId)
            │  appendInflightDelta(tabId,uuid,text,parentId)
            │     │     buffer the rest, no-op
            │     │
            │     ▼
            │  scheduleFlush()
            │     │
            │     ▼
            │  requestAnimationFrame(flush)
            │     │
            │     ▼
            │  drains buffers Map → setInflightAssistantText(...)
            │                          │
            │                          ▼
            │                   <InflightAssistantBubble> re-renders with new text
            │
            ▼
           drop (subagent partial — future work)
```

## Error handling / edge cases

| Scenario | Behavior |
|---|---|
| Subagent partial (`parent_tool_use_id !== null`) | Dropped at the IPC subscriber. Not buffered, not rendered. |
| Non-`text_delta` event (content_block_start, message_start, message_delta, content_block_stop, message_stop) | Dropped at the IPC subscriber. Buffer untouched. |
| New uuid arrives while old buffer still present | Buffer reset to new uuid, prior text discarded. (A never-completed prior turn loses its leftover partials.) |
| RAF paused (window hidden / minimized) | Buffer accumulates indefinitely. On window foreground, RAF fires and drains. User sees full accumulated text up to that point; no streaming animation in the background. |
| Stream error mid-streaming | Runtime emits its existing `system/notification` error card via `claude-output:${tabId}`. Subscriber clears the inflight slot + buffer on receipt of any `notification_type: 'error'`. Prevents stale streaming bubble next to an error card. |
| Tab close | Component unmount calls `clearInflightBuffer(tabId)`. Map entry drops. |
| Tab reload (Cmd+R) | Renderer reload wipes Zustand and the module-level Map (fresh module instance). Clean slate. |
| Two tabs streaming simultaneously | Each tab has its own Map entry by `tabId` key. RAF flush iterates the whole Map; no cross-tab interference. |
| Assistant `append` arrives but uuid doesn't match the slot | Defensive: clear the slot anyway. Harmless if the slot was already empty; correct if state was stale. |
| `isLoading` spinner timing | Existing reducer clears `isLoading` on assistant `append`. With partials, the inflight bubble appears *before* the assistant `append`. To avoid spinner-and-streaming-bubble both showing: in `setInflightAssistantText`, also patch `isLoading: false` — first delta flush implicitly clears the spinner. |

## Testing (TDD)

Renderer tests for this feature live in `src/lib/__tests__/` and `src/stores/__tests__/`, matching the existing renderer-side test convention (the repo's coverage target applies to backend; renderer tests are still encouraged where pure logic lives).

**Primary entry point** — `src/lib/__tests__/inflightCoalescer.test.ts` *(new)*:

1. `appendInflightDelta` accumulates text across multiple calls for the same uuid (verified by triggering RAF flush and reading the captured `setInflightAssistantText` call).
2. `appendInflightDelta` resets the buffer when a new uuid arrives for the same tab.
3. RAF flush calls `setInflightAssistantText` with the full accumulated text, the correct uuid, and the captured `parentToolUseId`.
4. Multiple `appendInflightDelta` calls within the same frame produce exactly one RAF schedule and one Zustand call per tab.
5. `clearInflightBuffer` drops the Map entry; subsequent flush is a no-op for that tab.
6. Two-tab interleave: deltas to `t1` and `t2` produce one flush that updates both slots independently with their respective text.
7. Flush with empty buffers map is a no-op (no Zustand call).

Test harness:
- `vi.useFakeTimers()` for any time-based assertions.
- Stub RAF: `vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { /* manually invoke or queue */ })`. Pattern in `vitest` is well-supported; the implementer can choose between manual stepping (most deterministic) or `microtask` flushing.
- Mock the store: `vi.mock('@/stores/claudeSessionStore')` and assert against `setInflightAssistantText: vi.fn()`. Or use the real store with `__resetForTests()` between cases and read state directly via `useClaudeSessionStore.getState().tabs[tabId].inflightAssistant`.
- `__resetCoalescerForTests()` between cases.

**Secondary** — `src/stores/__tests__/claudeSessionStore.test.ts` (extend):

8. `setInflightAssistantText(tabId, uuid, text, parentToolUseId)` populates the slot on the right tab, leaves other tabs untouched.
9. `clearInflightAssistant(tabId)` sets the slot to `null`.
10. Setting the slot also patches `isLoading: false` (per the §Error-handling table's spinner-timing rule).
11. Re-setting the slot with a new uuid replaces all four fields atomically.

**Manual smoke** during implementation:
- Start a session, ask a long question. Confirm text streams in real time, cursor blinks at the end. Spinner clears as soon as text starts.
- Tab away mid-stream, come back — confirm latest text is visible (no jank from RAF backlog).
- Force a stream error (e.g., disconnect network mid-turn). Confirm the inflight bubble clears when the error card appears.
- Two simultaneous sessions in two tabs — confirm streaming flows independently in each.

**Verification gate** (per CLAUDE.md "Cross-cutting or risky change"):
`npm run check && npm run build && npm run test:coverage`. After vitest, `npm run rebuild:electron` per the repo convention.

## Open verification items

These need confirmation during implementation, not pre-decided now:

1. **JSONL persistence sanity check.** Enable the flag, run a session, inspect the SDK CLI's per-session JSONL log. Expectation: no `stream_event` entries persisted. If they *are* persisted, OmniFex's session reload path may load them back as messages — needs a `case 'stream_event'` filter at session-load time. Almost certainly safe (the SDK CLI handles its own filtering for in-memory streaming concerns), but verify.

2. **Existing reducer behavior on `stream_event`.** Read `sessionStreamReducer.ts`'s switch statement. With our IPC-subscriber branch landing first, the reducer never sees stream events — but as a defensive safety net, add `case 'stream_event': return { append: 'skip', metrics: EMPTY_METRICS_DELTA, costDelta: 0 };` so behavior degrades gracefully if the subscriber branch is ever bypassed.

3. **Exact `claude-output:${tabId}` subscriber location.** Confirm `ClaudeCodeSession.tsx` is where `electronAPI.on('claude-output:'+tabId, …)` lives. (Backed by `src/CLAUDE.md`: streaming-session UX in `ClaudeCodeSession.tsx`.) The branch we're adding goes wherever the subscriber currently dispatches into the reducer.

4. **Store-selector ergonomics.** The bubble subscribes via `useClaudeSessionStore((s) => s.tabs[tabId]?.inflightAssistant ?? null)` rather than `useTabSession(tabId)` because the existing `useTabSession` returns the whole slice and would re-render the bubble on every unrelated state change. Confirm during implementation that the narrow selector behaves correctly under React strict mode and Zustand's shallow-equality semantics — the returned object identity should change only when `inflightAssistant` itself changes.

5. **`MarkdownBlock` partial-render safety.** Confirm `MarkdownBlock` handles incomplete markdown (e.g. an unclosed code fence mid-stream) without throwing or producing broken DOM. Most markdown renderers degrade gracefully — text outside fences renders as text, broken fences render as preformatted text — but worth a smoke test on a turn that's heavy on code blocks.

## Out of scope (explicit non-goals for v1)

- **Tool args streaming** (`input_json_delta` rendered character-by-character into tool_use cards). Visually noisy; partial JSON is not human-friendly. Defer.
- **Thinking deltas** (`thinking_delta` streamed into the thinking block). Currently the thinking block renders as a complete unit at content_block_stop. Streaming it is doable but adds another render path with limited UX upside vs. cost.
- **Subagent partial streaming.** When a Task tool's subagent runs, partials carry `parent_tool_use_id !== null`. Filtered out in v1; SubagentBar streaming is a separate design.
- **Citations / signature / compaction deltas.** All ignored in v1.
- **User-controlled toggle.** Always-on; revisit only if dogfooding shows real performance issues.
- **Per-tab streaming preference.** Same.
- **Persisting the inflight slot across renderer reloads.** The slot is in-memory only; reload starts fresh.

## Future work

1. **Tool-arg streaming.** When users want it, a follow-up design can fold `input_json_delta` into the tool_use card as a "Claude is typing the argument…" affordance.
2. **Thinking-delta streaming.** Real-time thinking block growth for long thinking turns.
3. **SubagentBar partial streaming.** Subagent text partials flowing into the SubagentBar's expanded view — same coalescer pattern, different store slice.
4. **User-controlled toggle.** A Settings entry to disable partial streaming if the always-on default has measurable cost on slower machines.
5. **Coalescer cost telemetry.** If perf becomes a concern, instrument the RAF flush rate and per-flush text-length so we can tune.

## References

- SDK type defs: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
  - `Options.includePartialMessages` — line 1384
  - `SDKPartialAssistantMessage` — line 3070
- SDK delta type defs: `node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts`
  - `BetaRawMessageStreamEvent` — line 1175
  - `BetaRawContentBlockDelta` — line 1113 (text_delta is line 1336)
- Official docs (verify against the local SDK if behavior diverges): <https://code.claude.com/docs/en/agent-sdk/typescript> (search `includePartialMessages`).
- Existing patterns:
  - `electron/services/sessions/events.ts:86-88` — already classifies `stream_event` as `{ kind: 'streamEvent' }`.
  - `electron/services/sessions/runtime.ts:97-102` — explicit no-op case branch.
  - `electron/services/sessions/runtime.ts:112` — already forwards stream events to the renderer.
  - `src/stores/claudeSessionStore.ts` — existing `TabSessionState` shape and copy-on-write action pattern.
  - `src/lib/sessionStreamReducer.ts` — append-only reducer; the new field doesn't change its surface.
- Original "Wave 3" listing in `TODO.md`: `includePartialMessages` was on the deferred list as a UX-shaping feature.
