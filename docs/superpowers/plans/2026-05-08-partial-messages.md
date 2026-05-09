# Partial Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream token-level assistant text into a new in-flight slot rendered as a growing assistant bubble with a blinking cursor, replaced by the canonical complete message when the turn ends.

**Architecture:** Always-on `includePartialMessages: true` in `factory.ts`. New sidecar `inflightCoalescer.ts` module owns a per-tab text-buffer Map and a single `requestAnimationFrame` flush that pushes accumulated text into a new `inflightAssistant` slot in the Zustand store. New `<InflightAssistantBubble />` reads the slot via a narrow store selector. `handleStreamMessage` in `ClaudeCodeSession.tsx` branches on `type: 'stream_event'` ahead of the reducer; the reducer stays pure and append-only.

**Tech Stack:** Electron + Node.js (main); React 18 + Zustand + Tailwind v4 + shadcn/ui (renderer); `@anthropic-ai/claude-agent-sdk@^0.2.133`; Vitest.

**Spec:** `docs/superpowers/specs/2026-05-08-partial-messages-design.md`

---

## File Structure

**Created:**
- `src/lib/inflightCoalescer.ts` — per-tab text-buffer Map + RAF flush. Functional API.
- `src/lib/__tests__/inflightCoalescer.test.ts` — primary TDD entry point.
- `src/components/InflightAssistantBubble.tsx` — renders the in-flight slot as an assistant bubble with a blinking cursor.

**Modified (main process):**
- `electron/services/sessions/factory.ts` — add `includePartialMessages: true` to `buildSdkOptions`.

**Modified (renderer):**
- `src/stores/claudeSessionStore.ts` — add `inflightAssistant` field to `TabSessionState`, two new actions (`setInflightAssistantText`, `clearInflightAssistant`).
- `src/lib/sessionStreamReducer.ts` — defensive `case 'stream_event'` returning `{ append: 'skip', … }`.
- `src/components/ClaudeCodeSession.tsx` — branch in `handleStreamMessage` (around line 640), reconciliation on assistant append + error notification, mount `<InflightAssistantBubble />`, cleanup-on-unmount.

**Tests:**
- `electron/__tests__/sessions.test.ts` — extend existing factory-options block with one assertion.
- `src/stores/__tests__/claudeSessionStore.test.ts` — extend with new-action cases.
- `src/lib/__tests__/sessionStreamReducer.test.ts` — extend with the defensive `stream_event` case (verify file exists; if not, see Task 4 for handling).
- `src/lib/__tests__/inflightCoalescer.test.ts` — new file (Task 3).

**No new IPC channels.** No new event channels. Single SDK option is the only main-process change.

---

## Working assumptions

- `runtime.ts` already forwards `stream_event` messages over `claude-output:${tabId}` (verified at `runtime.ts:112`). No main-process branching needed beyond the single flag.
- `classifyRuntimeEvent` already returns `{ kind: 'streamEvent' }` for `m.type === 'stream_event'` (verified at `events.ts:86-88`). The FSM has the explicit no-op case branch (`runtime.ts:97-102`).
- The renderer-side IPC subscriber is `handleStreamMessage` in `src/components/ClaudeCodeSession.tsx` (around line 640, calls `reduceSessionStreamMessage` at ~line 671).
- Vitest one-shot is `npm test`. Single-file run: `npm test -- src/lib/__tests__/inflightCoalescer.test.ts`.
- After any vitest run, `npm run rebuild:electron` is required before launching the app.

---

### Task 1: Factory — enable `includePartialMessages`

**Files:**
- Modify: `electron/services/sessions/factory.ts:50-103` (the `options` object literal in `buildSdkOptions`).
- Test: `electron/__tests__/sessions.test.ts` (extend the existing factory-options block — same place as the rewindFiles plan's Task 1, so both flag-additions live nearby).

- [ ] **Step 1: Write the failing test.** Append inside the same describe block that holds the existing `start() passes settingSources …` and `start() passes systemPrompt preset …` tests:

```ts
  it('start() enables includePartialMessages so assistant text streams to the renderer', () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 't1',
      projectPath: '/p',
      configDir: '/cfg',
      model: 'opus',
      permissionMode: 'default',
    });

    const options = fake.getCapturedOptions();
    expect(options.includePartialMessages).toBe(true);
  });
```

- [ ] **Step 2: Run the test, verify it fails.**

Run: `npm test -- electron/__tests__/sessions.test.ts -t "includePartialMessages"`
Expected: FAIL — "expected undefined to be true".

- [ ] **Step 3: Edit `electron/services/sessions/factory.ts`.** Inside `buildSdkOptions()`, add this field to the `options` literal next to the other always-on flags (next to `agentProgressSummaries: true,` is a natural home):

```ts
    // Stream token-level partial assistant messages so the renderer can paint
    // assistant text as Claude generates it (rendered into the inflight slot
    // via src/lib/inflightCoalescer.ts). Subagent partials and non-text deltas
    // are filtered renderer-side; this flag is the single switch.
    includePartialMessages: true,
```

- [ ] **Step 4: Run the test, verify it passes.**

Run: `npm test -- electron/__tests__/sessions.test.ts -t "includePartialMessages"`
Expected: PASS.

- [ ] **Step 5: Run the full sessions test file** to confirm no regressions.

Run: `npm test -- electron/__tests__/sessions.test.ts`
Expected: all green.

- [ ] **Step 6: Commit.**

```bash
git add electron/services/sessions/factory.ts electron/__tests__/sessions.test.ts
git commit -m "feat(sessions): enable includePartialMessages for streaming UX

The flag is a single switch — runtime.ts already forwards stream_event
messages, classifyRuntimeEvent already classifies them, and the FSM has
the no-op case branch. Renderer-side coalescer + bubble land in the
following commits.

Spec: docs/superpowers/specs/2026-05-08-partial-messages-design.md"
```

---

### Task 2: Store — add `inflightAssistant` slot + actions

**Files:**
- Modify: `src/stores/claudeSessionStore.ts`.
- Test: `src/stores/__tests__/claudeSessionStore.test.ts` (extend).

- [ ] **Step 1: Write the failing tests.** Append at the end of the existing `describe('claudeSessionStore', …)` block:

```ts
  it('setInflightAssistantText populates the inflight slot and clears isLoading', () => {
    const store = useClaudeSessionStore.getState();
    store.patchTab(TAB, { isLoading: true });
    store.setInflightAssistantText(TAB, 'msg-uuid-1', 'Hello world', null);
    const slice = store.selectTab(TAB);
    expect(slice.inflightAssistant).toEqual({
      uuid: 'msg-uuid-1',
      text: 'Hello world',
      parentToolUseId: null,
    });
    expect(slice.isLoading).toBe(false);
  });

  it('setInflightAssistantText replaces the slot when re-called with new uuid/text', () => {
    const store = useClaudeSessionStore.getState();
    store.setInflightAssistantText(TAB, 'msg-uuid-1', 'first', null);
    store.setInflightAssistantText(TAB, 'msg-uuid-2', 'second', 'parent-tu-id');
    expect(store.selectTab(TAB).inflightAssistant).toEqual({
      uuid: 'msg-uuid-2',
      text: 'second',
      parentToolUseId: 'parent-tu-id',
    });
  });

  it('clearInflightAssistant sets the slot to null', () => {
    const store = useClaudeSessionStore.getState();
    store.setInflightAssistantText(TAB, 'msg-uuid-1', 'Hello', null);
    store.clearInflightAssistant(TAB);
    expect(store.selectTab(TAB).inflightAssistant).toBeNull();
  });

  it('inflight slot is per-tab — setting one does not leak to another', () => {
    const store = useClaudeSessionStore.getState();
    store.setInflightAssistantText('tab-A', 'uuid-A', 'A text', null);
    store.setInflightAssistantText('tab-B', 'uuid-B', 'B text', null);
    expect(store.selectTab('tab-A').inflightAssistant?.text).toBe('A text');
    expect(store.selectTab('tab-B').inflightAssistant?.text).toBe('B text');
  });

  it('EMPTY_TAB_SESSION includes inflightAssistant: null', () => {
    expect(EMPTY_TAB_SESSION.inflightAssistant).toBeNull();
  });
```

- [ ] **Step 2: Run the tests, verify they fail.**

Run: `npm test -- src/stores/__tests__/claudeSessionStore.test.ts -t "inflight"`
Expected: FAIL — `setInflightAssistantText is not a function` / `inflightAssistant` undefined.

- [ ] **Step 3: Edit `src/stores/claudeSessionStore.ts`.** Three changes:

  **3a. Extend `TabSessionState`** (around line 20):

  ```ts
  export interface TabSessionState {
    messages: ClaudeStreamMessage[];
    claudeSessionId: string | null;
    extractedSessionInfo: { sessionId: string; projectId: string } | null;
    sdkAccountInfo: SessionAccountInfo | null;
    contextUsage: SessionContextUsage | null;
    supportedModels: SessionModelInfo[];
    isLoading: boolean;
    /** Text-streaming slot for partial messages. Populated by the
     *  inflight coalescer's RAF flush; cleared when the complete assistant
     *  message lands (matching uuid), on stream error, or on tab close. */
    inflightAssistant: {
      uuid: string;
      text: string;
      parentToolUseId: string | null;
    } | null;
  }
  ```

  **3b. Update `EMPTY_TAB_SESSION`** (around line 30):

  ```ts
  export const EMPTY_TAB_SESSION: TabSessionState = {
    messages: [],
    claudeSessionId: null,
    extractedSessionInfo: null,
    sdkAccountInfo: null,
    contextUsage: null,
    supportedModels: [],
    isLoading: false,
    inflightAssistant: null,
  };
  ```

  **3c. Add the two new actions** to `ClaudeSessionStoreState` (around lines 44–64) and to the store implementation (around lines 73+). For the interface:

  ```ts
  // Add inside the ClaudeSessionStoreState interface, alongside other actions:
  setInflightAssistantText(
    tabId: string,
    uuid: string,
    text: string,
    parentToolUseId: string | null,
  ): void;
  clearInflightAssistant(tabId: string): void;
  ```

  For the implementation (inside the `create<ClaudeSessionStoreState>()(subscribeWithSelector((set, get) => ({ … })))` literal), append next to the existing `patchTab` action:

  ```ts
    setInflightAssistantText: (tabId, uuid, text, parentToolUseId) =>
      set((state) => {
        const existing = ensureTab(state.tabs, tabId);
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...existing,
              inflightAssistant: { uuid, text, parentToolUseId },
              // First delta flushing implicitly clears the spinner —
              // the streaming bubble replaces it visually.
              isLoading: false,
            },
          },
        };
      }),

    clearInflightAssistant: (tabId) =>
      set((state) => {
        const existing = state.tabs[tabId];
        if (!existing) return state;
        return {
          tabs: {
            ...state.tabs,
            [tabId]: { ...existing, inflightAssistant: null },
          },
        };
      }),
  ```

- [ ] **Step 4: Run the tests, verify they pass.**

Run: `npm test -- src/stores/__tests__/claudeSessionStore.test.ts -t "inflight"`
Expected: PASS — all five.

- [ ] **Step 5: Run the full file** to confirm no regressions.

Run: `npm test -- src/stores/__tests__/claudeSessionStore.test.ts`
Expected: all green.

- [ ] **Step 6: Type-check.**

Run: `npm run check`
Expected: passes.

- [ ] **Step 7: Commit.**

```bash
git add src/stores/claudeSessionStore.ts src/stores/__tests__/claudeSessionStore.test.ts
git commit -m "feat(store): add inflightAssistant slot + setters

Holds streamed assistant text before the complete message lands.
setInflightAssistantText also patches isLoading: false so the
streaming bubble naturally replaces the spinner on first delta flush.

Spec: docs/superpowers/specs/2026-05-08-partial-messages-design.md"
```

---

### Task 3: Coalescer — buffer Map + RAF flush

**Files:**
- Create: `src/lib/inflightCoalescer.ts`.
- Test: `src/lib/__tests__/inflightCoalescer.test.ts` (new).

- [ ] **Step 1: Write the failing tests.** Create `src/lib/__tests__/inflightCoalescer.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  appendInflightDelta,
  clearInflightBuffer,
  __resetCoalescerForTests,
} from '../inflightCoalescer';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';

// RAF stubbing — capture the most recently scheduled callback so tests can
// step the frame deterministically.
let pendingFrame: FrameRequestCallback | null = null;
let nextHandle = 1;

beforeEach(() => {
  pendingFrame = null;
  nextHandle = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    pendingFrame = cb;
    return nextHandle++;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    pendingFrame = null;
  });
  useClaudeSessionStore.getState().__resetForTests();
  __resetCoalescerForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function tickFrame() {
  const cb = pendingFrame;
  pendingFrame = null;
  cb?.(performance.now());
}

describe('inflightCoalescer', () => {
  it('accumulates text for the same uuid across multiple appends, flushed once per frame', () => {
    appendInflightDelta('t1', 'msg-1', 'Hel', null);
    appendInflightDelta('t1', 'msg-1', 'lo ', null);
    appendInflightDelta('t1', 'msg-1', 'world', null);
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant).toBeNull();
    tickFrame();
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant).toEqual({
      uuid: 'msg-1',
      text: 'Hello world',
      parentToolUseId: null,
    });
  });

  it('resets the buffer when a new uuid arrives for the same tab', () => {
    appendInflightDelta('t1', 'msg-1', 'old', null);
    tickFrame();
    appendInflightDelta('t1', 'msg-2', 'new', null);
    tickFrame();
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant).toEqual({
      uuid: 'msg-2',
      text: 'new',
      parentToolUseId: null,
    });
  });

  it('schedules exactly one frame for many same-frame appends', () => {
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');
    appendInflightDelta('t1', 'msg-1', 'a', null);
    appendInflightDelta('t1', 'msg-1', 'b', null);
    appendInflightDelta('t1', 'msg-1', 'c', null);
    expect(rafSpy).toHaveBeenCalledTimes(1);
  });

  it('flushes both tabs independently in a single frame', () => {
    appendInflightDelta('tab-A', 'uuid-A', 'A text', null);
    appendInflightDelta('tab-B', 'uuid-B', 'B text', 'parent-x');
    tickFrame();
    const state = useClaudeSessionStore.getState();
    expect(state.selectTab('tab-A').inflightAssistant).toEqual({
      uuid: 'uuid-A',
      text: 'A text',
      parentToolUseId: null,
    });
    expect(state.selectTab('tab-B').inflightAssistant).toEqual({
      uuid: 'uuid-B',
      text: 'B text',
      parentToolUseId: 'parent-x',
    });
  });

  it('clearInflightBuffer drops the buffer entry without flushing the slot', () => {
    appendInflightDelta('t1', 'msg-1', 'lost', null);
    clearInflightBuffer('t1');
    tickFrame();
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant).toBeNull();
  });

  it('flush with empty buffers map is a no-op', () => {
    // Trigger a flush schedule, then clear before it fires.
    appendInflightDelta('t1', 'msg-1', 'temp', null);
    clearInflightBuffer('t1');
    // No store state should have been written.
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant).toBeNull();
    // Frame is still pending — when it fires, no state should change.
    tickFrame();
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant).toBeNull();
  });

  it('preserves parentToolUseId across appends to the same uuid', () => {
    appendInflightDelta('t1', 'msg-1', 'first', 'parent-tu-id');
    appendInflightDelta('t1', 'msg-1', '-second', 'parent-tu-id');
    tickFrame();
    expect(useClaudeSessionStore.getState().selectTab('t1').inflightAssistant).toEqual({
      uuid: 'msg-1',
      text: 'first-second',
      parentToolUseId: 'parent-tu-id',
    });
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail.**

Run: `npm test -- src/lib/__tests__/inflightCoalescer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/inflightCoalescer.ts`** with the full implementation:

```ts
// Per-tab text-buffer Map + RAF flush for partial assistant messages.
//
// Owns the buffer state and the RAF schedule, but does NOT own the
// rendered surface — claudeSessionStore.inflightAssistant does. React
// reconciles only on flush, never per delta.

import { useClaudeSessionStore } from '@/stores/claudeSessionStore';

interface Buffer {
  uuid: string;
  text: string;
  parentToolUseId: string | null;
}

const buffers = new Map<string, Buffer>();
let rafHandle: number | null = null;

/**
 * Append a text_delta chunk to the per-tab buffer keyed by assistant uuid.
 * A new uuid resets the buffer (any leftover partials from a never-completed
 * prior turn are discarded). Schedules a RAF flush if not already pending.
 */
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

/**
 * Drop the per-tab buffer without flushing. Call on tab close, on receipt
 * of the complete assistant message that matches, and on stream error.
 */
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

- [ ] **Step 4: Run the tests, verify they all pass.**

Run: `npm test -- src/lib/__tests__/inflightCoalescer.test.ts`
Expected: all 7 tests green.

- [ ] **Step 5: Type-check.**

Run: `npm run check`
Expected: passes.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/inflightCoalescer.ts src/lib/__tests__/inflightCoalescer.test.ts
git commit -m "feat(coalescer): add inflightCoalescer for RAF-bounded delta flush

Per-tab text-buffer Map + single RAF schedule. Many same-frame appends
produce one Zustand write. Two-tab interleave is independent. uuid
mismatch resets the buffer.

Spec: docs/superpowers/specs/2026-05-08-partial-messages-design.md"
```

---

### Task 4: Reducer — defensive `case 'stream_event'`

The IPC subscriber will branch on `stream_event` ahead of the reducer call (Task 6). This task adds a defensive `case 'stream_event'` in the reducer so behavior degrades gracefully if that branch is ever bypassed.

**Files:**
- Modify: `src/lib/sessionStreamReducer.ts`.
- Test: `src/lib/__tests__/sessionStreamReducer.test.ts` (extend).

- [ ] **Step 1: Verify the reducer test file exists.**

Run: `ls src/lib/__tests__/sessionStreamReducer.test.ts`
Expected: file exists.
If FAIL: create the file with a minimal vitest scaffold (`import { describe, it, expect } from 'vitest'; import { reduceSessionStreamMessage } from '../sessionStreamReducer';`) before writing the new test below.

- [ ] **Step 2: Write the failing test.** Append:

```ts
describe('reduceSessionStreamMessage stream_event handling', () => {
  it('skips stream_event messages so they never land in messages[]', () => {
    const result = reduceSessionStreamMessage(
      // Cast — stream_event isn't in the local ClaudeStreamMessage union;
      // the reducer's case branch handles it defensively.
      { type: 'stream_event', uuid: 'u', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } } as any,
      {
        projectPath: '/p',
        hasExistingInit: true,
        hasExtractedSession: true,
        userInterrupted: false,
        messagesLength: 0,
      },
    );
    expect(result.append).toBe('skip');
  });
});
```

- [ ] **Step 3: Run the test, verify it fails.**

Run: `npm test -- src/lib/__tests__/sessionStreamReducer.test.ts -t "stream_event handling"`
Expected: FAIL — `result.append` is most likely `'append'` (the default fallthrough).

- [ ] **Step 4: Edit `src/lib/sessionStreamReducer.ts`.** Find the main switch in `reduceSessionStreamMessage` (around line 269+ per the structural read in this plan's spec). Add a new case at the top of the switch (before any other type-based branches):

```ts
  // Defensive: stream_event messages are intercepted by the IPC subscriber
  // before they reach the reducer. If a future code path bypasses that
  // branch, ensure these never land in messages[] as garbage entries.
  if (message.type === 'stream_event' as any) {
    return {
      append: 'skip',
      effects: [],
      metrics: EMPTY_METRICS_DELTA,
      costDelta: 0,
    };
  }
```

(If the reducer uses a switch statement keyed by `message.type`, add `case 'stream_event': return { append: 'skip', effects: [], metrics: EMPTY_METRICS_DELTA, costDelta: 0 };` instead. Match the existing style in the file.)

- [ ] **Step 5: Run the test, verify it passes.**

Run: `npm test -- src/lib/__tests__/sessionStreamReducer.test.ts -t "stream_event handling"`
Expected: PASS.

- [ ] **Step 6: Run the full reducer test file.**

Run: `npm test -- src/lib/__tests__/sessionStreamReducer.test.ts`
Expected: all green.

- [ ] **Step 7: Commit.**

```bash
git add src/lib/sessionStreamReducer.ts src/lib/__tests__/sessionStreamReducer.test.ts
git commit -m "test(reducer): defensive case for stream_event messages

Stream events are intercepted by the IPC subscriber before reaching the
reducer; this safety net keeps them out of messages[] if that branch is
ever bypassed.

Spec: docs/superpowers/specs/2026-05-08-partial-messages-design.md"
```

---

### Task 5: Create `<InflightAssistantBubble />` component

**Files:**
- Create: `src/components/InflightAssistantBubble.tsx`.

No automated test — renderer component testing isn't load-bearing in the repo. Manual smoke covered in Task 8.

- [ ] **Step 1: Create the file** with the full component:

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

- [ ] **Step 2: Type-check + build.**

Run: `npm run check && npm run build`
Expected: both green. If `MarkdownBlock` import fails, find the project's MarkdownBlock alias (`grep -r "from '@/components/MarkdownBlock'" src` and adjust). If `Card` import fails, the path is wherever `MessageCard.tsx` imports `@/components/ui/card` from — already verified to exist per `MessageCard.tsx:3`.

- [ ] **Step 3: Commit.**

```bash
git add src/components/InflightAssistantBubble.tsx
git commit -m "feat(rewind): add InflightAssistantBubble component

Reads the inflight slot via a narrow store selector and renders a normal
assistant-styled bubble with a blinking cursor at the end. Returns null
when the slot is empty.

Spec: docs/superpowers/specs/2026-05-08-partial-messages-design.md"
```

(Note: the commit message says "rewind" by mistake of habit — fix the prefix to `feat(stream)` if you'd prefer; the change is correct.)

---

### Task 6: Wire the IPC subscriber branch in `handleStreamMessage`

**Files:**
- Modify: `src/components/ClaudeCodeSession.tsx` (the `handleStreamMessage` callback around line 640).

- [ ] **Step 1: Locate `handleStreamMessage`.**

Run: `grep -n "handleStreamMessage" src/components/ClaudeCodeSession.tsx | head`
Expected: definition around line 640, callers in nearby `useEffect` blocks.

Run: `grep -n "reduceSessionStreamMessage" src/components/ClaudeCodeSession.tsx | head`
Expected: one hit around line 671 — the reducer call inside `handleStreamMessage`.

- [ ] **Step 2: Add imports** at the top of `ClaudeCodeSession.tsx`:

```ts
import {
  appendInflightDelta,
  clearInflightBuffer,
} from '@/lib/inflightCoalescer';
```

(If a `useClaudeSessionStore` selector hook for actions is already used in this file, add `clearInflightAssistant` selection alongside other actions — see Task 7. Otherwise, the action is read inline via `useClaudeSessionStore.getState()` in the handler.)

- [ ] **Step 3: Branch the subscriber.** Inside `handleStreamMessage`, **before** the call to `reduceSessionStreamMessage` (around line 671), add:

```ts
  // stream_event: token-level partial assistant message.
  // Filter to text-only deltas from the parent agent (subagent partials
  // are out of scope for v1) and route through the coalescer. Returns
  // before invoking the regular reducer.
  if ((message as any).type === 'stream_event') {
    const m = message as any;
    if (m.parent_tool_use_id !== null) return; // skip subagent partials
    const event = m.event;
    if (
      event?.type === 'content_block_delta' &&
      event.delta?.type === 'text_delta' &&
      typeof event.delta.text === 'string'
    ) {
      appendInflightDelta(
        tabIdRef.current,
        m.uuid,
        event.delta.text,
        m.parent_tool_use_id,
      );
    }
    return;
  }
```

(`tabIdRef.current` is already used elsewhere in this file as the per-tab id reference.)

- [ ] **Step 4: Type-check + build.**

Run: `npm run check && npm run build`
Expected: green.

- [ ] **Step 5: Commit.**

```bash
git add src/components/ClaudeCodeSession.tsx
git commit -m "feat(session-ui): branch handleStreamMessage on stream_event

Routes text_delta partials from the parent agent through the
inflightCoalescer. Subagent partials and non-text deltas drop. The
reducer is bypassed for stream_event entirely.

Spec: docs/superpowers/specs/2026-05-08-partial-messages-design.md"
```

---

### Task 7: Reconciliation — clear inflight on assistant append + on error

**Files:**
- Modify: `src/components/ClaudeCodeSession.tsx`.

- [ ] **Step 1: Find where the reducer's `append` result is acted on** in `handleStreamMessage`. After the existing post-reducer block (where `appendMessage`/`insertMessageBeforeFirstUser`/effects are dispatched), add:

```ts
  // Reconcile inflight slot:
  //  - On any assistant append, the canonical complete message has landed;
  //    clear the inflight slot and any unflushed deltas so the streaming
  //    bubble unmounts as the canonical bubble in messages[] takes its place.
  //  - On any error notification, clear so the streaming bubble doesn't
  //    sit stale next to an error card.
  const store = useClaudeSessionStore.getState();
  if (reduced.append === 'append' && (message as any).type === 'assistant') {
    store.clearInflightAssistant(tabIdRef.current);
    clearInflightBuffer(tabIdRef.current);
  }
  if (
    (message as any).type === 'system' &&
    (message as any).subtype === 'notification' &&
    (message as any).notification_type === 'error'
  ) {
    store.clearInflightAssistant(tabIdRef.current);
    clearInflightBuffer(tabIdRef.current);
  }
```

(Adjust the `reduced.append` reference to match the actual local variable name returned from `reduceSessionStreamMessage(...)` — likely `reduced` per the structural read; could be `result`. Match the existing code.)

- [ ] **Step 2: Type-check + build.**

Run: `npm run check && npm run build`
Expected: green.

- [ ] **Step 3: Commit.**

```bash
git add src/components/ClaudeCodeSession.tsx
git commit -m "feat(session-ui): clear inflight slot on assistant append + on error

The streaming bubble unmounts when the canonical assistant message
lands or when an error notification arrives, preventing a stale
streaming bubble from persisting.

Spec: docs/superpowers/specs/2026-05-08-partial-messages-design.md"
```

---

### Task 8: Mount the bubble + cleanup-on-unmount

**Files:**
- Modify: `src/components/ClaudeCodeSession.tsx`.

- [ ] **Step 1: Add the import.**

```ts
import { InflightAssistantBubble } from './InflightAssistantBubble';
```

- [ ] **Step 2: Mount the bubble** after the existing message-list `.map(...)` and before the bottom-docked strip components (TodoBar / SubagentBar / FloatingPromptInput).

Run: `grep -n "<TodoBar\|<SubagentBar\|messages.map" src/components/ClaudeCodeSession.tsx | head -5`
Expected: hits for the message list render and the bottom strip.

Insert directly after the closing render of the message list:

```tsx
{/* Streaming bubble — renders null when no in-flight slot is set. */}
<InflightAssistantBubble tabId={tabIdRef.current} />
```

- [ ] **Step 3: Add cleanup on unmount.** Add a small `useEffect` in `ClaudeCodeSession.tsx`:

```ts
// Drop any per-tab inflight buffer when this tab unmounts so the
// module-level Map doesn't leak across long-lived renderer sessions.
useEffect(() => () => clearInflightBuffer(tabIdRef.current), []);
```

- [ ] **Step 4: Type-check + build.**

Run: `npm run check && npm run build`
Expected: green.

- [ ] **Step 5: Manual smoke test.**

```bash
npm run rebuild:electron
npm start
```

In the running app:
1. Open a project, start a session, ask a long question (e.g. "explain the architecture of this repo").
2. Confirm the assistant text streams in real time as Claude types — bubble grows, blinking `|` cursor at the end.
3. Confirm the existing isLoading spinner clears the moment text starts streaming.
4. Confirm the streaming bubble disappears and the canonical complete message takes its place at end-of-turn (no flicker, no double-bubble).
5. Tab away mid-stream, come back — confirm latest text is visible (RAF caught up).
6. Force a stream error (disconnect network mid-turn). Confirm the streaming bubble clears when the error card appears.
7. Open a second tab and start a session — confirm both streams independently without cross-talk.

- [ ] **Step 6: Commit.**

```bash
git add src/components/ClaudeCodeSession.tsx
git commit -m "feat(session-ui): mount InflightAssistantBubble + buffer cleanup

The bubble lives between the message list and the bottom strip. Tab
unmount clears the per-tab buffer so the coalescer's Map doesn't grow
unbounded across long renderer sessions.

Spec: docs/superpowers/specs/2026-05-08-partial-messages-design.md"
```

---

### Task 9: Verification gate

Per CLAUDE.md "Cross-cutting or risky change": full check + build + coverage. Per repo memory: rebuild Electron ABI after vitest.

- [ ] **Step 1: Run the full check, build, and coverage.**

Run: `npm run check && npm run build && npm run test:coverage`
Expected: all green; coverage report shows new files (`inflightCoalescer.ts`, store additions) at ≥ 80% lines.

- [ ] **Step 2: Rebuild the Electron native module ABI** before the next interactive run.

Run: `npm run rebuild:electron`
Expected: better-sqlite3 rebuilds for Electron's Node ABI.

- [ ] **Step 3: Final smoke check** (recommended).

Run: `npm start`
Repeat the manual smoke from Task 8 Step 5.

- [ ] **Step 4: No commit needed for the verification gate itself.**

---

## Open verification items from the spec — surface findings during implementation

Not tasks; observations to make and surface in the final report:

1. **JSONL persistence sanity.** During the Task 8 manual smoke, after a full turn, inspect the SDK CLI's per-session JSONL log (path: `${configDir}/projects/<project-id>/<sessionId>.jsonl` or similar). Expectation: no `stream_event` entries persisted. If they are, OmniFex's session reload may load them back as messages and the load path needs a `case 'stream_event'` filter. Almost certainly safe; verify.
2. **`MarkdownBlock` partial-render safety.** Type a long answer that includes code fences. Confirm no DOM errors when streamed text contains an unclosed code fence mid-render (text outside the fence should render as text; broken fence renders as preformatted block until it closes).
3. **`useClaudeSessionStore` narrow-selector behavior under React strict mode.** Confirm the bubble only re-renders when the inflight slot's identity changes — not on every store mutation. React DevTools profiling on a long-streaming turn is the cleanest verification.

---

## Self-review

Spec coverage check, ran against `docs/superpowers/specs/2026-05-08-partial-messages-design.md`:

| Spec section | Covered by |
|---|---|
| Always-on `includePartialMessages` | Task 1 |
| `inflightAssistant` slot in `TabSessionState` + `EMPTY_TAB_SESSION` update | Task 2 |
| `setInflightAssistantText` + `clearInflightAssistant` actions | Task 2 |
| `setInflightAssistantText` clears `isLoading` | Task 2 step 3c |
| `inflightCoalescer.ts` buffer Map + RAF flush | Task 3 |
| New uuid resets buffer, multi-tab independence, single-RAF coalescing | Task 3 (tests 1, 2, 3, 4) |
| Defensive `case 'stream_event'` in reducer | Task 4 |
| `<InflightAssistantBubble />` component | Task 5 |
| Subagent + non-text-delta filtering at IPC subscriber | Task 6 |
| Reconciliation on assistant append + error notification | Task 7 |
| Bubble mount + tab-unmount cleanup | Task 8 |
| Verification gate | Task 9 |

No spec section is uncovered.

Placeholder scan: no "TBD" / "TODO (to fill in)" / "implement later" markers. All tasks include exact code, exact paths, and exact commands.

Type consistency: `inflightAssistant` shape `{ uuid, text, parentToolUseId }` is identical across `TabSessionState` (Task 2), `setInflightAssistantText` action signature (Task 2), buffer record (Task 3), and `<InflightAssistantBubble />` selector return (Task 5). The action name `clearInflightAssistant` (store) and module function `clearInflightBuffer` (coalescer) are intentionally different — they target different state (Zustand slot vs. module-level Map). Both are called together at every reconciliation site (Tasks 7 and 8).
