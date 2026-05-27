# Render JSONL as Written — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the `jsonlSynthesizer` + `jsonlAdapter` layers, move `conversationStatus` from a main-process FSM to a renderer-side derivation over `JsonlNode[]` + task/subagent stores, and preserve engine-mode stream-json envelopes as their own kinds in `messages[]` instead of fabricating "init" / "result" cards.

**Architecture:** The renderer's `messages[]` becomes a list of real CLI emissions only — JSONL lines from the file and engine-mode stream-json envelopes from the CLI's stdout. Nothing is synthesized; nothing is mutated. UI affordances that today depend on injected `synthesized-init` / `synthesized-result` envelopes (the spinner, the completion card, "session in flight") are computed in pure selectors over `messages[]` plus the existing task and subagent stores. The main-process `setStatus` FSM stops owning `conversationStatus`; it stays the owner of `sessionStatus` only.

**Tech Stack:** TypeScript, React 18, Vitest, Electron main + renderer over IPC.

**Reference docs (read before starting):**
- `docs/superpowers/specs/2026-05-27-jsonl-as-rendered-design.md` — the design this plan implements.
- `docs/session-lifecycle.md` — current FSM model; this plan rewrites it in Task 13.
- `CLAUDE.md` (root + `src/CLAUDE.md`) — repo conventions, account-aware paths, testing gate.

**Verification gate at end of every task:** `npm run check` and `npm test` must both pass. For tasks that touch renderer components, also run `npm run build`. For the final task, run `npm run test:coverage`.

---

## Phase 1 — Foundation: pure derivation layer

### Task 1: Create `sessionDerivedState.ts` with pure derivation functions

**Files:**
- Create: `src/lib/sessionDerivedState.ts`
- Test: `src/lib/__tests__/sessionDerivedState.test.ts`

This task adds the new derivation file in isolation. No consumers yet — the file just exists with full unit coverage. Subsequent tasks wire it in.

- [ ] **Step 1: Read the design's "Components" section for the exact function signatures**

Open `docs/superpowers/specs/2026-05-27-jsonl-as-rendered-design.md` and read the "**`src/lib/sessionDerivedState.ts` (new).**" subsection. Those four signatures are the contract.

- [ ] **Step 2: Inspect the current task / subagent store types**

Run:
```bash
rg -l "TaskRow|SubagentRow|deriveSubagents|tasks\.some" src/
```
Identify the canonical types for `TaskRow` and `SubagentRow` (most likely in `src/lib/subagents.ts` or `src/stores/`). If neither name matches verbatim in this repo, use whatever name the renderer's task/subagent stores actually export — the derivation only needs `.status` on each row.

- [ ] **Step 3: Write the failing test file**

Create `src/lib/__tests__/sessionDerivedState.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import {
  waitingOnClaude,
  hasOpenTasks,
  hasOpenSubagents,
  conversationStatus,
  turnDuration,
  sessionStartedAt,
} from '../sessionDerivedState';

// Minimal helpers — these build JsonlNodes with the fields the derivation reads.
function userPrompt(timestamp: string, sessionId = 's1'): JsonlNode {
  return {
    kind: 'user',
    userKind: 'prompt',
    sessionId,
    receivedAt: timestamp,
    raw: {
      type: 'user',
      message: { role: 'user', content: 'hi' },
      sessionId,
      timestamp,
    } as never,
  };
}

function assistantWithStop(
  timestamp: string,
  stop_reason: string | null,
  opts: { isSidechain?: boolean; sessionId?: string } = {},
): JsonlNode {
  const sessionId = opts.sessionId ?? 's1';
  return {
    kind: 'assistant',
    sessionId,
    receivedAt: timestamp,
    raw: {
      type: 'assistant',
      message: { role: 'assistant', content: [], stop_reason },
      isSidechain: opts.isSidechain ?? false,
      sessionId,
      timestamp,
    } as never,
  };
}

describe('waitingOnClaude', () => {
  it('returns false for an empty message list', () => {
    expect(waitingOnClaude([])).toBe(false);
  });

  it('returns true when the only message is a user prompt', () => {
    expect(waitingOnClaude([userPrompt('2026-05-27T00:00:00Z')])).toBe(true);
  });

  it('returns false after assistant with terminal stop_reason', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', 'end_turn'),
    ];
    expect(waitingOnClaude(msgs)).toBe(false);
  });

  it('returns true when the last assistant has stop_reason: null (stuck turn)', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', null),
    ];
    expect(waitingOnClaude(msgs)).toBe(true);
  });

  it('treats max_tokens, stop_sequence, refusal, model_context_window_exceeded as terminal', () => {
    for (const stop of ['stop_sequence', 'max_tokens', 'refusal', 'model_context_window_exceeded']) {
      const msgs = [
        userPrompt('2026-05-27T00:00:00Z'),
        assistantWithStop('2026-05-27T00:00:01Z', stop),
      ];
      expect(waitingOnClaude(msgs), `stop=${stop}`).toBe(false);
    }
  });

  it('ignores isSidechain assistants when looking for the last assistant', () => {
    // Sidechain assistant streams without terminal stop; main assistant terminated cleanly.
    // Status must be 'not waiting' because the main turn ended.
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', 'end_turn'),
      assistantWithStop('2026-05-27T00:00:02Z', null, { isSidechain: true }),
    ];
    expect(waitingOnClaude(msgs)).toBe(false);
  });

  it('multiple sequential terminal-stop assistants resolve to not waiting', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', 'end_turn'),
      assistantWithStop('2026-05-27T00:00:02Z', 'end_turn'),
    ];
    expect(waitingOnClaude(msgs)).toBe(false);
  });
});

describe('hasOpenTasks / hasOpenSubagents', () => {
  it('returns false for empty arrays', () => {
    expect(hasOpenTasks([])).toBe(false);
    expect(hasOpenSubagents([])).toBe(false);
  });

  it('returns true when any task has status !== "completed"', () => {
    expect(hasOpenTasks([{ status: 'completed' }, { status: 'running' }] as never)).toBe(true);
    expect(hasOpenTasks([{ status: 'completed' }, { status: 'completed' }] as never)).toBe(false);
  });

  it('returns true when any subagent has status !== "completed"', () => {
    expect(hasOpenSubagents([{ status: 'completed' }, { status: 'pending' }] as never)).toBe(true);
    expect(hasOpenSubagents([{ status: 'completed' }] as never)).toBe(false);
  });
});

describe('conversationStatus', () => {
  it('idle when nothing is pending', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', 'end_turn'),
    ];
    expect(conversationStatus(msgs, [], [])).toBe('idle');
  });

  it('running when waiting on Claude', () => {
    const msgs = [userPrompt('2026-05-27T00:00:00Z')];
    expect(conversationStatus(msgs, [], [])).toBe('running');
  });

  it('running when an open subagent exists even if assistant terminated', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', 'end_turn'),
    ];
    expect(conversationStatus(msgs, [], [{ status: 'running' }] as never)).toBe('running');
  });

  it('running when an open task exists even if assistant terminated', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00Z'),
      assistantWithStop('2026-05-27T00:00:01Z', 'end_turn'),
    ];
    expect(conversationStatus(msgs, [{ status: 'pending' }] as never, [])).toBe('running');
  });
});

describe('turnDuration', () => {
  it('returns ms between user.prompt and the assistant at the given index', () => {
    const msgs = [
      userPrompt('2026-05-27T00:00:00.000Z'),
      assistantWithStop('2026-05-27T00:00:02.500Z', 'end_turn'),
    ];
    expect(turnDuration(msgs, 1)).toBe(2500);
  });

  it('returns null when the assistant has no preceding user prompt in the array', () => {
    const msgs = [assistantWithStop('2026-05-27T00:00:01Z', 'end_turn')];
    expect(turnDuration(msgs, 0)).toBeNull();
  });

  it('returns null when the index does not point at an assistant', () => {
    const msgs = [userPrompt('2026-05-27T00:00:00Z')];
    expect(turnDuration(msgs, 0)).toBeNull();
  });
});

describe('sessionStartedAt', () => {
  it('returns null for empty messages', () => {
    expect(sessionStartedAt([])).toBeNull();
  });

  it('returns the raw.timestamp of the first message', () => {
    const msgs = [userPrompt('2026-05-27T00:00:00Z')];
    expect(sessionStartedAt(msgs)).toBe('2026-05-27T00:00:00Z');
  });
});
```

- [ ] **Step 4: Run the test file and confirm it fails to import**

Run:
```bash
npx vitest run src/lib/__tests__/sessionDerivedState.test.ts
```
Expected: failure — module `../sessionDerivedState` not found.

- [ ] **Step 5: Implement `sessionDerivedState.ts`**

Create `src/lib/sessionDerivedState.ts`:

```ts
import type { JsonlNode } from '@/types/jsonl';

const TERMINAL_STOP_REASONS = new Set([
  'end_turn',
  'stop_sequence',
  'max_tokens',
  'refusal',
  'model_context_window_exceeded',
]);

// Treat the value of TaskRow / SubagentRow loosely — we only read `.status`.
// If/when the repo's canonical types are typed strictly, swap these aliases.
type WithStatus = { status: string };

function isMainAssistant(node: JsonlNode): boolean {
  if (node.kind !== 'assistant') return false;
  const isSidechain = (node.raw as { isSidechain?: boolean }).isSidechain === true;
  return !isSidechain;
}

function lastMainAssistant(messages: JsonlNode[]): Extract<JsonlNode, { kind: 'assistant' }> | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const n = messages[i];
    if (isMainAssistant(n)) return n as Extract<JsonlNode, { kind: 'assistant' }>;
  }
  return null;
}

function lastMainPromptIndex(messages: JsonlNode[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const n = messages[i];
    if (n.kind === 'user' && n.userKind === 'prompt') return i;
  }
  return -1;
}

export function waitingOnClaude(messages: JsonlNode[]): boolean {
  if (messages.length === 0) return false;
  const lastAssistant = lastMainAssistant(messages);
  if (!lastAssistant) {
    // No main-chain assistant has spoken; we're waiting only if a prompt is awaiting reply.
    return lastMainPromptIndex(messages) >= 0;
  }
  const stop = (lastAssistant.raw as { message?: { stop_reason?: string | null } }).message?.stop_reason ?? null;
  if (stop === null) return true;
  return !TERMINAL_STOP_REASONS.has(stop);
}

export function hasOpenTasks(tasks: WithStatus[]): boolean {
  return tasks.some((t) => t.status !== 'completed');
}

export function hasOpenSubagents(subagents: WithStatus[]): boolean {
  return subagents.some((s) => s.status !== 'completed');
}

export function conversationStatus(
  messages: JsonlNode[],
  tasks: WithStatus[],
  subagents: WithStatus[],
): 'running' | 'idle' {
  return waitingOnClaude(messages) || hasOpenTasks(tasks) || hasOpenSubagents(subagents)
    ? 'running'
    : 'idle';
}

export function turnDuration(messages: JsonlNode[], assistantIndex: number): number | null {
  const node = messages[assistantIndex];
  if (!node || node.kind !== 'assistant') return null;
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate.kind === 'user' && candidate.userKind === 'prompt') {
      const start = Date.parse((candidate.raw as { timestamp?: string }).timestamp ?? '');
      const end = Date.parse((node.raw as { timestamp?: string }).timestamp ?? '');
      if (Number.isFinite(start) && Number.isFinite(end)) return Math.max(0, end - start);
      return null;
    }
  }
  return null;
}

export function sessionStartedAt(messages: JsonlNode[]): string | null {
  const first = messages[0];
  if (!first) return null;
  const ts = (first as { receivedAt?: string }).receivedAt
    ?? (first as { raw?: { timestamp?: string } }).raw?.timestamp;
  return typeof ts === 'string' ? ts : null;
}
```

- [ ] **Step 6: Run the test and confirm it passes**

Run:
```bash
npx vitest run src/lib/__tests__/sessionDerivedState.test.ts
```
Expected: all tests pass.

- [ ] **Step 7: Run the full check + test gate**

Run:
```bash
npm run check && npm test
```
Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/lib/sessionDerivedState.ts src/lib/__tests__/sessionDerivedState.test.ts
git commit -m "feat(derived): add pure session-state derivation over JsonlNode[]"
```

---

## Phase 2 — Renderer: derive `conversationStatus` instead of subscribing to it

### Task 2: Replace FSM-driven `conversationStatus` in `useSessionLifecycle` with derived selector

**Files:**
- Modify: `src/hooks/useSessionLifecycle.ts`
- Modify: `src/hooks/__tests__/useSessionLifecycle.test.tsx`

At this point the main process still emits `conversationStatus` on `session-status:<tabId>` — we don't break that yet. We just stop *reading* it on the renderer. Derivation takes over.

- [ ] **Step 1: Read the current hook subscription**

Open `src/hooks/useSessionLifecycle.ts` and read lines 100-200 (the state declarations, `resetStatus`, and `attachStreamListeners`).

- [ ] **Step 2: Locate consumers of `conversationStatus` in the renderer**

Run:
```bash
rg -n "conversationStatus" src/ --type=ts --type=tsx
```
Note every consumer. They'll need to consume the derived value via a new selector hook or by being passed `conversationStatus` as a derived prop.

- [ ] **Step 3: Find the messages array and the task/subagent stores the consumers can read**

Run:
```bash
rg -n "messages:|setMessages|subagents|tasks" src/hooks/useSessionLifecycle.ts src/components/ClaudeCodeSession.tsx
rg -l "subagentStore|taskStore|useSubagents|useTasks" src/
```
Confirm the path used today to access the messages array and task/subagent state. Most likely the `messages` state lives in `ClaudeCodeSession.tsx` and tasks/subagents live in zustand stores under `src/stores/`.

- [ ] **Step 4: Write a failing test for the new derived hook**

Create or extend `src/hooks/__tests__/useSessionLifecycle.test.tsx` (or add a new sibling test for the derived hook if the existing test file is large). Add a test asserting that `conversationStatus` returned by the hook reflects `waitingOnClaude(messages)` rather than the IPC payload. Replicate the existing test scaffolding (mock `window.electronAPI`, mock the messages array).

```tsx
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionLifecycle } from '../useSessionLifecycle';

// (Use the same mock setup pattern as the existing test file. The test
// below verifies that after a session-status event with sessionStatus=started
// AND a messages array containing a user.prompt with no assistant, the
// derived conversationStatus is 'running'.)
```

Tailor the test to match the file's existing mocking conventions — copy patterns from neighboring tests for the harness setup. The assertion: emit a `session-status:<tabId>` event with `{ sessionStatus: 'started' }` (note: no `conversationStatus` in payload) and verify the hook returns `conversationStatus === 'running'` when fed messages containing only a user prompt.

- [ ] **Step 5: Run the new test and confirm it fails**

```bash
npx vitest run src/hooks/__tests__/useSessionLifecycle.test.tsx
```
Expected: failure on the new derived-status assertion.

- [ ] **Step 6: Update the hook to derive `conversationStatus`**

In `src/hooks/useSessionLifecycle.ts`:

1. Add import:
```ts
import { conversationStatus as deriveConversationStatus } from '@/lib/sessionDerivedState';
```

2. Change the `UseSessionLifecycleArgs` interface to add the inputs the derivation needs:
```ts
messages: JsonlNode[];
tasks: WithStatus[];        // use the canonical TaskRow type once identified in Task 2 Step 3
subagents: WithStatus[];    // use the canonical SubagentRow type
```
(Replace `WithStatus` with the real exported types from the stores.)

3. Remove the `conversationStatus` `useState` and its setter in the body. Remove the `resetStatus` field write to `conversationStatus`. Remove the `conversationStatus` reading branch in the `session-status:` event handler — drop the field from the payload destructure.

4. At the return statement, compute and return:
```ts
const derivedConversationStatus: ConversationStatus | null =
  sessionStatus === 'started'
    ? deriveConversationStatus(messages, tasks, subagents)
    : null;
```

5. Return `conversationStatus: derivedConversationStatus` from the hook (preserving the public API name).

- [ ] **Step 7: Update `ClaudeCodeSession.tsx` to pass `messages`, `tasks`, `subagents` into the hook**

Open `src/components/ClaudeCodeSession.tsx` and find the `useSessionLifecycle({...})` call. Pass the existing `messages` state and references to the task / subagent stores into the hook (matching the names you identified in Step 3). If the hook is called from any other component, update those call sites too — `rg -n "useSessionLifecycle" src/`.

- [ ] **Step 8: Run all tests**

```bash
npm run check && npm test
```
Expected: pass. Note that the value type for `messages` here is whatever the renderer currently uses (likely still `ClaudeStreamMessage[]` from the adapter — that's fine for now; Phase 4 changes it).

If the derivation imports `JsonlNode` but the messages state is `ClaudeStreamMessage[]`, add a small adapter in the hook that converts `ClaudeStreamMessage` → `JsonlNode`-like shape (only `.kind`, `.userKind`, `.raw.message.stop_reason`, `.raw.isSidechain` are read). The adapter can live in `useSessionLifecycle.ts` for now; it disappears entirely when Phase 4 lands.

- [ ] **Step 9: Commit**

```bash
git add src/hooks/useSessionLifecycle.ts src/hooks/__tests__/useSessionLifecycle.test.tsx src/components/ClaudeCodeSession.tsx
git commit -m "feat(hook): derive conversationStatus from messages + stores instead of FSM"
```

---

## Phase 3 — Main process: stop emitting `conversationStatus`

### Task 3: Drop `conversationStatus` from the `session-status:<tabId>` IPC payload and from the service surface

**Files:**
- Modify: `electron/services/sessions/status.ts`
- Modify: `electron/services/sessions/types.ts`
- Modify: `electron/services/sessions/lifecycle.ts`
- Modify: `electron/services/sessions/runtime.ts`
- Modify: `electron/services/sessions/queries.ts`
- Modify: `electron/services/sessions/permissions.ts`
- Modify: `electron/services/sessions/index.ts` (the service entry point — `setMode`, status getters)
- Modify: `electron/ipc/handlers.ts` (the IPC handlers that surface `getStatus` / `getInfo` / `getHealth`)
- Modify: `src/lib/api.ts` (the renderer-side type exports)

- [ ] **Step 1: Audit `conversationStatus` usage in main process**

```bash
rg -n "conversationStatus" electron/
```
Catalog every read and every write. The plan handles them in this single task to keep the IPC contract change atomic.

- [ ] **Step 2: Write failing tests for the new IPC shape**

Update `electron/__tests__/ipc-handlers.test.ts` (or the relevant test file — find it via `rg -l "session-status:" electron/__tests__/`) to assert that:
- `session-status:<tabId>` payloads now contain `{ sessionStatus }` only.
- `session_get_health` returns `{ alive, sessionId, sessionStatus }` (no `conversationStatus`).
- `setStatus({ conversationStatus: 'running' }, ...)` is a TypeScript error or a no-op (depending on the API choice in Step 4).

Run:
```bash
npm test -- electron/__tests__/ipc-handlers.test.ts
```
Expected: failures.

- [ ] **Step 3: Update `status.ts` to drop `conversationStatus`**

Open `electron/services/sessions/status.ts` and replace the entire file with:

```ts
// Sessions module — status emitter (sessionStatus only).
//
// The renderer derives conversationStatus from JSONL content + task/subagent
// stores (see src/lib/sessionDerivedState.ts and the
// docs/superpowers/specs/2026-05-27-jsonl-as-rendered-design.md spec).
// Main process owns sessionStatus only — the "is the CLI process up?" axis.
//
// See `docs/session-lifecycle.md` for the model.

import type { SessionHandle, SessionStatus, SendToRenderer } from './types';

export interface SessionStatusEvent {
  sessionStatus: SessionStatus;
}

/**
 * Apply a partial transition to a handle. Omits the conversationStatus axis
 * entirely — that's the renderer's job now.
 */
export function setStatus(
  handle: SessionHandle,
  patch: { sessionStatus?: SessionStatus },
  tabId: string,
  sendToRenderer: SendToRenderer,
): void {
  const next = patch.sessionStatus ?? handle.sessionStatus;
  if (handle.sessionStatus === next) return;
  handle.sessionStatus = next;
  sendToRenderer(`session-status:${tabId}`, { sessionStatus: next } satisfies SessionStatusEvent);
}
```

- [ ] **Step 4: Drop `conversationStatus` field from `SessionHandle` and the service interface**

In `electron/services/sessions/types.ts`:

- Delete the `ConversationStatus` type alias and its export.
- Remove `conversationStatus` from `SessionHandle` (line ~365).
- Remove `conversationStatus` from `getStatus`, `getInfo`, `getHealth`, `listSessionStatuses` return shapes.
- Update `listInFlightTabIds` JSDoc to reflect that the in-flight calculation has moved to the renderer; the main-process service no longer reports per-tab conversation state. (We keep `listInFlightTabIds` for the installer's wait-for-idle gate — Step 5 reworks its implementation.)

- [ ] **Step 5: Rework `listInFlightTabIds` and the installer wait-for-idle gate**

The installer today asks main "are any tabs in flight?" via `listInFlightTabIds`, which reads `handle.conversationStatus`. Under the new model, main doesn't know.

Options to discuss in the PR description (do the simpler one):

- **Option A (recommended):** keep `listInFlightTabIds` but make it return the empty list always, and rewire the installer's wait-for-idle gate to ask the renderer via a new `installer_wait_for_idle` IPC roundtrip that the renderer can answer from its derived state. This is more correct but adds an IPC contract.
- **Option B (faster):** drop the wait-for-idle gate entirely and accept that auto-updates can fire mid-turn. Probably fine given OmniFex auto-updates are user-initiated.

Pick A. Add a new IPC channel `session_is_in_flight` (renderer side) that the renderer answers from `conversationStatus === 'running'` and have the installer poll all open tabs through this channel. Add tests in `electron/__tests__/` for the new channel.

If option A is too much for this task, do option B and file a follow-up issue.

- [ ] **Step 6: Remove all main-process callers of `setStatus({ conversationStatus: ... })`**

In each file (`lifecycle.ts`, `runtime.ts`, `queries.ts`, `permissions.ts`), find every call to `setStatus` that passes `conversationStatus` and delete the key. Example transformation:

```ts
// Before
setStatus(handle, { sessionStatus: 'started', conversationStatus: 'idle' }, tabId, sendToRenderer);
// After
setStatus(handle, { sessionStatus: 'started' }, tabId, sendToRenderer);
```

Also remove any standalone calls like `setStatus(handle, { conversationStatus: 'running' }, ...)` — those become no-ops and should be deleted entirely (not converted to empty patches).

- [ ] **Step 7: Update the IPC handlers in `electron/ipc/handlers.ts`**

Find handlers for `session_get_info`, `session_get_health`, `session_get_status`, `session_list_in_flight`. Update their response shapes to drop `conversationStatus`.

- [ ] **Step 8: Update `src/lib/api.ts`**

Remove the `ConversationStatus` re-export and any wrapper methods whose return type included it. Add the new `session_is_in_flight` API method if option A was chosen in Step 5.

- [ ] **Step 9: Re-run all tests**

```bash
npm run check && npm test
```
Expected: pass. If renderer code still references `ConversationStatus`, the type-check will catch it — fix those sites (most are in `useSessionLifecycle.ts`, already handled in Task 2; any stragglers update now).

- [ ] **Step 10: Commit**

```bash
git add electron/ src/lib/api.ts
git commit -m "refactor(ipc): drop conversationStatus from session-status payload and service surface"
```

---

## Phase 4 — Renderer: stop mutating raw, switch consumers to `JsonlNode`

### Task 4: Drop the `timestamp → receivedAt` rename fallback from the classifier

**Files:**
- Modify: `src/lib/jsonlClassifier.ts`
- Modify: `src/lib/__tests__/jsonlClassifier.test.ts`

The classifier today falls back to `new Date().toISOString()` for missing `timestamp`. Real CLI JSONL always has `timestamp`; the fallback masks data bugs. Drop it.

- [ ] **Step 1: Write a failing test**

Add to `src/lib/__tests__/jsonlClassifier.test.ts`:

```ts
it('returns null for a JSONL line missing timestamp on a kind that requires it', () => {
  const raw = { type: 'assistant', sessionId: 's1', message: { role: 'assistant', content: [] } };
  expect(classifyJsonlLine(raw)).toBeNull();
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
npx vitest run src/lib/__tests__/jsonlClassifier.test.ts
```
Expected: failure (classifier currently returns a node with a wall-clock `receivedAt`).

- [ ] **Step 3: Update `classifyJsonlLine`**

In `src/lib/jsonlClassifier.ts`, replace line 38:
```ts
const receivedAt = typeof r.timestamp === 'string' ? r.timestamp : new Date().toISOString();
```
with:
```ts
const receivedAt = typeof r.timestamp === 'string' ? r.timestamp : null;
```

In each `classify*` function that receives `receivedAt`, change the signature to accept `string | null` and return `null` if it's null AND the kind requires `receivedAt` (assistant, user, attachment, queue-operation, system, real-result — i.e. every variant whose union member declares `receivedAt: string`).

Kinds that don't carry `receivedAt` in the type (`last-prompt`, `permission-mode`, `ai-title`, `file-history-snapshot`) keep working as-is.

- [ ] **Step 4: Run the test and confirm it passes**

```bash
npx vitest run src/lib/__tests__/jsonlClassifier.test.ts
```
Expected: pass.

- [ ] **Step 5: Run all tests**

```bash
npm run check && npm test
```
Expected: pass. Existing tests may need updates if they passed timestamp-less assistant/user fixtures; fix them by adding a `timestamp` to the fixture.

- [ ] **Step 6: Commit**

```bash
git add src/lib/jsonlClassifier.ts src/lib/__tests__/jsonlClassifier.test.ts
git commit -m "refactor(classifier): drop wall-clock fallback; require real CLI timestamps"
```

### Task 5: Delete the synthesizer

**Files:**
- Delete: `src/lib/jsonlSynthesizer.ts`
- Delete: `src/lib/__tests__/jsonlSynthesizer.test.ts`
- Delete: `src/lib/__tests__/jsonlSynthesizer.skillBody.test.ts`
- Modify: `src/types/jsonl.ts` (drop `synthesized-init`, `synthesized-result`, `real-result`)
- Modify: every consumer of those kinds (find via grep in Step 1)

- [ ] **Step 1: Inventory all consumers**

```bash
rg -n "synthesized-init|synthesized-result|real-result|synthesizeBatch|createSynthesizer" src/ electron/
```
Note every file. The plan deletes the producer and every consumer in one task to keep the build green.

- [ ] **Step 2: Update `src/types/jsonl.ts`**

Delete these variants from the `JsonlNode` union (lines 178-181):
```ts
| { kind: 'real-result'; raw: RealResultRaw; sessionId: string; receivedAt: string }
| { kind: 'synthesized-init'; sessionId: string; cwd: string; receivedAt: string }
| { kind: 'synthesized-result'; sessionId: string; isError: boolean; subtype: string; body: string; durationMs: number; usage: UsageShape; totalCostUsd: number; stopReason: string | null; receivedAt: string }
```
Also delete the `RealResultRaw` interface (lines 93-102) and the `import` of `RealResultRaw` from any other file that took it.

Update the top-of-file comment to reflect that "Synthesized variants are manufactured by the synthesizer" no longer applies — the doc-string should now describe `JsonlNode` as "every real CLI emission, one variant per visually meaningful category, no synthesis."

- [ ] **Step 3: Update `src/lib/jsonlClassifier.ts`**

Delete the `case 'result':` branch (lines 59-60) and the `classifyResult` function (lines 210-220). Remove the `RealResultRaw` import.

- [ ] **Step 4: Delete `src/lib/jsonlSynthesizer.ts` and its test files**

```bash
git rm src/lib/jsonlSynthesizer.ts src/lib/__tests__/jsonlSynthesizer.test.ts src/lib/__tests__/jsonlSynthesizer.skillBody.test.ts
```

- [ ] **Step 5: Update consumers found in Step 1**

For each consumer, remove the synthesized-/result-handling branches. Specifically:
- `src/lib/jsonlAdapter.ts` — will be deleted in Task 6; for now, drop the three `case 'synthesized-init' | 'synthesized-result' | 'real-result'` branches and any `import RealResultRaw`.
- `src/components/StreamMessage.tsx` — drop the dispatch cases for synthesized kinds and result.
- `src/components/StreamMessage/MessageFrameCard.tsx` and similar — drop completion-card rendering.
- `src/lib/messageKind.ts` and `messageRenderingConfig.ts` — drop catalog entries for synthesized kinds and `result.*` kinds.
- `src/services/sessionPersistence.ts` — drop persistence handling.

The exhaustive switch on `JsonlNode['kind']` in TypeScript will surface every remaining case. Run `npm run check` between fixes.

- [ ] **Step 6: Run the full gate**

```bash
npm run check && npm test
```
Expected: pass. Fix any test fixtures that referenced synthesized kinds (they're no longer in the union — the test should be deleted or rewritten to assert that the JSONL flow simply doesn't produce them).

- [ ] **Step 7: Commit**

```bash
git add -A src/ electron/
git commit -m "refactor(synth): delete jsonlSynthesizer and synthesized JsonlNode variants"
```

### Task 6: Delete the JSONL adapter; consumers read `JsonlNode` directly

**Files:**
- Delete: `src/lib/jsonlAdapter.ts`
- Delete: `src/lib/__tests__/jsonlAdapter.test.ts`
- Modify: `src/components/StreamMessage.tsx`
- Modify: `src/lib/sessionStreamReducer.ts`
- Modify: `src/lib/sessionStreamEffects.ts`
- Modify: `src/lib/normalizeMessage.ts`
- Modify: any other consumer surfaced by grep

- [ ] **Step 1: Inventory `jsonlAdapter` and `ClaudeStreamMessage` consumers**

```bash
rg -n "jsonlNodeToStreamMessage|jsonlAdapter|ClaudeStreamMessage" src/ electron/
```
`ClaudeStreamMessage` is the type the adapter outputs. Many components type-check against it; they'll need to migrate to `JsonlNode`.

- [ ] **Step 2: Write a failing test for `StreamMessage` consuming `JsonlNode` directly**

Pick an existing `StreamMessage` test and rewrite one case so the test passes a `JsonlNode` directly instead of a `ClaudeStreamMessage`. For example, the assistant-text case:

```tsx
const node: JsonlNode = {
  kind: 'assistant',
  sessionId: 's1',
  receivedAt: '2026-05-27T00:00:00Z',
  raw: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn' }, sessionId: 's1', timestamp: '2026-05-27T00:00:00Z' } as never,
};
render(<StreamMessage message={node} {/* other props */} />);
expect(screen.getByText('Hello')).toBeInTheDocument();
```

Run:
```bash
npx vitest run src/components/__tests__/StreamMessage.test.tsx
```
Expected: failure (the component still expects `ClaudeStreamMessage`).

- [ ] **Step 3: Change `StreamMessage`'s prop type to `JsonlNode`**

In `src/components/StreamMessage.tsx`:
- Change the `message` prop type from `ClaudeStreamMessage` to `JsonlNode`.
- Switch on `message.kind` instead of `message.type` / `message.subtype` / `message.streamKind`.
- For the assistant branch, read `message.raw.message` for content, `message.raw.message.stop_reason` for terminal detection, `message.raw.message.usage` for token counts.
- For terminal `stop_reason`, render the inline completion metadata band (duration via `turnDuration(allMessages, currentIndex)`, usage via `message.raw.message.usage`, cost computed via existing cost util).
- Drop any reads of `message.streamKind` / `message.receivedAt` — use `message.raw.timestamp` or the wrapper's `receivedAt`.

- [ ] **Step 4: Migrate every consumer surfaced in Step 1**

For each file that takes a `ClaudeStreamMessage`, change the type to `JsonlNode` and read the same data from the new location (almost always: drop the field; read `node.raw.<field>` instead).

Particularly important:
- `src/lib/sessionStreamReducer.ts` — likely reduces messages by mutating a state; switch its discriminator from `m.type` to `m.kind` and read raw fields.
- `src/lib/sessionStreamEffects.ts` — effects fire on certain message kinds; update the discriminator.
- `src/lib/normalizeMessage.ts` — likely the entry point that took raw IPC payloads and produced `ClaudeStreamMessage`. Now produces `JsonlNode` via `classifyJsonlLine` (already exists). Delete the normalization shim.

- [ ] **Step 5: Delete the adapter and its tests**

```bash
git rm src/lib/jsonlAdapter.ts src/lib/__tests__/jsonlAdapter.test.ts
```

- [ ] **Step 6: Run the full gate**

```bash
npm run check && npm run build && npm test
```
Expected: pass. The build is needed because this is a renderer-heavy change.

- [ ] **Step 7: Commit**

```bash
git add -A src/
git commit -m "refactor(render): delete jsonlAdapter; consumers read JsonlNode directly"
```

---

## Phase 5 — Engine-mode CLI stream-json events as their own kinds

### Task 7: Add `cli-stream-init` and `cli-stream-result` kinds + classifier

**Files:**
- Modify: `src/types/jsonl.ts`
- Modify: `src/lib/jsonlClassifier.ts` (or new `src/lib/cliStreamClassifier.ts` — pick within the task)
- Modify: `src/lib/__tests__/jsonlClassifier.test.ts`
- Modify: the renderer code that processes `agent-output:<tabId>` payloads (most likely `useSessionLifecycle.ts`'s `handleJsonlLine`) to route engine-stream events through classification too

- [ ] **Step 1: Confirmed envelope shapes (already inventoried)**

CLI stream-json envelopes that fall under these new kinds, taken from a real engine-mode session:

```json
// system:init
{"type":"system","subtype":"init","session_id":"abc","cwd":"/work","model":"claude-opus-4-7","tools":[],"mcp_servers":[]}

// result (success)
{"type":"result","subtype":"success","is_error":false,"result":"<final text>","duration_ms":3210,"duration_api_ms":2900,"num_turns":4,"stop_reason":"end_turn","total_cost_usd":0.012,"usage":{...},"modelUsage":{},"permission_denials":[],"session_id":"abc"}

// result (error_during_execution — the one from the bug report)
{"type":"result","subtype":"error_during_execution","is_error":true,"result":"","duration_ms":4679375,"duration_api_ms":0,"num_turns":0,"stop_reason":null,"total_cost_usd":0.000138,"usage":{...},"modelUsage":{},"permission_denials":[],"session_id":"c0e34556-8703-4a95-9ee2-999180bc7cf1"}
```

Use these as the basis for the `CliInitRaw` and `CliResultRaw` field lists in Step 2.

- [ ] **Step 2: Add `CliInitRaw`, `CliResultRaw` interfaces and new union kinds**

In `src/types/jsonl.ts`, after the existing `RawLineBase` interfaces:

```ts
export interface CliInitRaw {
  type: 'system';
  subtype: 'init';
  session_id?: string;
  cwd?: string;
  model?: string;
  tools?: string[];
  mcp_servers?: unknown[];
  [k: string]: unknown;
}

export interface CliResultRaw {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  stop_reason?: string | null;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
  session_id?: string;
  [k: string]: unknown;
}
```

Add to `JsonlNode`:
```ts
| { kind: 'cli-stream-init'; raw: CliInitRaw; sessionId: string; receivedAt: string }
| { kind: 'cli-stream-result'; raw: CliResultRaw; sessionId: string; receivedAt: string }
```

- [ ] **Step 3: Write failing tests for the new classification path**

Add to `src/lib/__tests__/jsonlClassifier.test.ts`:

```ts
describe('CLI stream-json envelopes (engine mode)', () => {
  it('classifies a system:init envelope as cli-stream-init', () => {
    const raw = {
      type: 'system',
      subtype: 'init',
      session_id: 'abc',
      cwd: '/work',
      timestamp: '2026-05-27T00:00:00Z',
    };
    const node = classifyJsonlLine(raw);
    expect(node?.kind).toBe('cli-stream-init');
  });

  it('classifies a result envelope as cli-stream-result', () => {
    const raw = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1234,
      session_id: 'abc',
      timestamp: '2026-05-27T00:00:00Z',
    };
    const node = classifyJsonlLine(raw);
    expect(node?.kind).toBe('cli-stream-result');
  });
});
```

Run:
```bash
npx vitest run src/lib/__tests__/jsonlClassifier.test.ts
```
Expected: failures (the `system:init` case currently hits `classifySystem` and likely returns `kind: 'system'`; the `result` case was deleted in Task 5 and now returns `kind: 'unknown'`).

- [ ] **Step 4: Add the cli-stream branches to the classifier**

In `src/lib/jsonlClassifier.ts`:

1. Before the `case 'system':` add:
```ts
case 'system':
  if (r.subtype === 'init') return classifyCliInit(r, sessionId, receivedAt);
  return classifySystem(r, sessionId, receivedAt);
```
(replacing the existing `case 'system': return classifySystem(...)`).

2. Add a new top-level case (do this BEFORE the `default`):
```ts
case 'result':
  return classifyCliResult(r, sessionId, receivedAt);
```

3. Add the two helper functions:
```ts
function classifyCliInit(r: Record<string, unknown>, sessionId: string, receivedAt: string | null): JsonlNode | null {
  if (receivedAt === null) return null;
  return { kind: 'cli-stream-init', raw: r as unknown as CliInitRaw, sessionId, receivedAt };
}

function classifyCliResult(r: Record<string, unknown>, sessionId: string, receivedAt: string | null): JsonlNode | null {
  if (receivedAt === null) return null;
  return { kind: 'cli-stream-result', raw: r as unknown as CliResultRaw, sessionId, receivedAt };
}
```

Import `CliInitRaw` and `CliResultRaw` from `@/types/jsonl`.

- [ ] **Step 5: Confirm cli-stream events do NOT participate in derivation**

In `src/lib/sessionDerivedState.ts`, ensure `waitingOnClaude` ignores `cli-stream-result` (it should — the function looks for `kind === 'assistant'` only). Add a regression test:

```ts
it('does not treat cli-stream-result as a turn ender', () => {
  const msgs: JsonlNode[] = [
    userPrompt('2026-05-27T00:00:00Z'),
    {
      kind: 'cli-stream-result',
      sessionId: 's1',
      receivedAt: '2026-05-27T00:00:01Z',
      raw: { type: 'result', subtype: 'success' } as never,
    },
  ];
  expect(waitingOnClaude(msgs)).toBe(true);  // still waiting — no real assistant arrived
});
```

- [ ] **Step 6: Add default StreamMessage rendering for the new kinds**

In `src/components/StreamMessage.tsx`, add two new cases:
```tsx
case 'cli-stream-init':
  return <CliInitBadge node={message} />;
case 'cli-stream-result':
  return <CliResultBadge node={message} />;
```

Implement `CliInitBadge` and `CliResultBadge` as minimal placeholder components in `src/components/StreamMessage/` that render a small kind-labeled card with `kind`, `sessionId`, `receivedAt`, and (for result) `subtype` + `duration_ms`. These are visible-but-unobtrusive placeholders the user mentioned wanting to iterate on later.

- [ ] **Step 7: Run the full gate**

```bash
npm run check && npm run build && npm test
```
Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/ docs/
git commit -m "feat(cli-stream): classify and render engine-mode init/result envelopes"
```

---

## Phase 6 — Settings → Chats catalog cleanup

### Task 8: Re-audit the message-types catalog against the real `JsonlNode.kind` set

**Files:**
- Modify: `src/lib/messageKind.ts`
- Modify: `src/lib/messageRenderingConfig.ts`
- Modify: `src/lib/blockKind.ts`
- Modify: `src/components/settings-panels/appearance/*.tsx` (audit which files; likely `MessageTypesPanel.tsx` or similar)
- Modify: any tests that reference removed kinds

- [ ] **Step 1: The authoritative `JsonlNode['kind']` catalog post-refactor**

These are the only kinds reachable after Phase 4 + 5. Pin this list as a comment at the top of `messageKind.ts`:

```
ai-title
assistant
attachment
cli-stream-init
cli-stream-result
file-history-snapshot
last-prompt
lifecycle
permission-mode
queue-operation
rate-limit
stream-event
system
unknown
user
```

Any catalog entry not corresponding to one of these is dead.

- [ ] **Step 2: Remove every entry referencing `synthesized-*`, `real-result`, or `result.*`**

In `messageKind.ts`, `messageRenderingConfig.ts`, `blockKind.ts`, find and delete entries with those substrings. The TypeScript exhaustiveness check on `JsonlNode['kind']` will surface anything missed.

- [ ] **Step 3: Add catalog entries for the new `cli-stream-*` kinds**

Mirror the entry shape used by neighboring kinds. Default presentation = side-line (per the 2026-05-24 spec's variant taxonomy if still present, else "small card"). Default visible in compact mode = false (these are low-information indicators).

- [ ] **Step 4: Update the appearance settings panels**

Find the panel file (`rg -l "messageKind|MessageTypesPanel" src/components/settings-panels/`). Update the displayed list to match the new catalog. Migration of stored localStorage filter keys is best-effort: unknown keys are ignored on read, defaults apply. Add a one-time read-translate for any popular legacy keys (e.g. `synthesized-result` → drop entirely, `result.*` → drop).

- [ ] **Step 5: Run the full gate**

```bash
npm run check && npm run build && npm test
```
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/
git commit -m "refactor(settings): re-audit message-types catalog against real JsonlNode kinds"
```

---

## Phase 7 — Documentation and final verification

### Task 9: Rewrite `docs/session-lifecycle.md` for the derived model

**Files:**
- Modify: `docs/session-lifecycle.md`

- [ ] **Step 1: Re-read the current doc**

Read `docs/session-lifecycle.md` and identify the parts that no longer apply: the FSM table at lines 81-91, invariant #3 at line 51, the IPC contract at lines 96-99 referencing `conversationStatus`, the anti-pattern at line 107 about synchronously setting `conversationStatus`.

- [ ] **Step 2: Rewrite the doc**

Replace the doc with a version that:
- Keeps the "three orthogonal axes" framing but reframes axis #2 (`conversationStatus`) as **derived in the renderer** from JSONL content + task/subagent stores.
- Replaces invariant #3 (main-process ownership) with: "`conversationStatus` is computed by `src/lib/sessionDerivedState.ts` and never appears in any IPC payload."
- Replaces the "Mapping main-process SDK events to the model" section with a "Derivation rules" section listing the exact predicates from `sessionDerivedState.ts`.
- Updates IPC contract: `session-status:<tabId>` payload is `{ sessionStatus }` only. `session_get_health` returns `{ alive, sessionId, sessionStatus }` (no `conversationStatus`).
- Removes the SDK terminology throughout (the SDK is gone — refer to "the CLI engine" or "stream-json output" instead).
- Keeps the in-flight rollup section but points the formula at the renderer-side selector instead of `handle.conversationStatus`.

- [ ] **Step 3: Commit**

```bash
git add docs/session-lifecycle.md
git commit -m "docs(session-lifecycle): rewrite for renderer-derived conversationStatus"
```

### Task 10: Final verification — fixtures + manual + coverage

- [ ] **Step 1: Fixture-based regression check (the original bug)**

Create a small integration test under `src/lib/__tests__/` that loads `c0e34556-8703-4a95-9ee2-999180bc7cf1.jsonl` from Greg's projects folder (or copy the relevant tail into a fixture file under `src/lib/__tests__/fixtures/`), classifies every line, and asserts:
- No node has `kind === 'synthesized-init'` or `'synthesized-result'`.
- `conversationStatus(messages, [], []) === 'idle'` if the final assistant has `stop_reason: end_turn`.
- For a manually truncated copy (delete the final assistant's `stop_reason`), `conversationStatus(...) === 'running'`.

If the real JSONL file is too large or path-sensitive, build the fixture inline from the relevant lines.

- [ ] **Step 2: Run the coverage gate**

```bash
npm run test:coverage
```
Expected: pass, with 80%+ lines on `sessionDerivedState.ts` and `jsonlClassifier.ts`.

- [ ] **Step 3: Manual verification in the running app**

Run `npm start` and verify each of the bullets in the spec's "Manual verification" testing section:
- Open a completed historical session → no fake completion card; inline completion band visible.
- Open the `c0e34556` session → no "Execution Failed" card.
- Start a fresh engine-mode session → cli-stream-init badge appears; turn completes with terminal stop; spinner clears.
- Start a TUI-mode session → identical except no cli-stream-* badges and no typewriter.
- Interrupt a turn mid-stream → spinner stays running; no fake card.
- Settings → Chats reflects real kinds only.

For each item that passes, record `PASS` in the commit message. For any that fail, file a follow-up task and STOP — do not mark the plan complete.

- [ ] **Step 4: Rebuild the Electron native modules and commit**

```bash
npm run rebuild:electron
git status
```
Expected: only the new fixture file and any small follow-up tweaks are unstaged.

```bash
git add -A
git commit -m "test(jsonl): fixture-based regression for derived state; final verification"
```

- [ ] **Step 5: PR description**

Open a PR (or update the branch description) listing each of the 10 tasks and their commits. Note that:
- The spec lives at `docs/superpowers/specs/2026-05-27-jsonl-as-rendered-design.md`.
- The session-lifecycle doc was rewritten in Task 9.
- The `cli-stream-*` rendering is intentionally minimal (placeholder badges) — visual polish is a follow-up.
- Any open question deferred to follow-up (e.g. installer wait-for-idle Option A vs B in Task 3 Step 5) is named.
