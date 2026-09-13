# Session status bar, popover restructure, and `tool_progress` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the CLI's live `tool_progress` frames on the tool rows they belong to, restructure the session context popover, and turn the session widget's bottom edge into a real status bar with working / thinking / subagent glyphs.

**Architecture:** `tool_progress` becomes a fourth *overlay* JSONL kind — classified, reduced by a pure function into a per-tab map keyed by the real tool_use id, and read at render time by a chip on the tool widget. It never enters `messages[]` and is never persisted, because the CLI never writes it to disk. The popover and status-bar work is presentational, except for two derived values (turn elapsed, last thinking burst) that do not exist yet and are added to the existing `session.activity` signal.

**Tech Stack:** React 19, TypeScript, Zustand, Tailwind, Vitest, lucide-react.

**Spec:** `docs/superpowers/specs/2026-09-13-session-status-and-tool-progress-design.md`

## Global Constraints

- **No commits.** Repo CLAUDE.md: use `/commit` only when Greg explicitly asks. Build and verify; leave the tree dirty.
- **No worktrees.** Repo CLAUDE.md: work directly in `~/Repos/personal/omnifex`.
- **TDD is required.** Failing test first, then implementation.
- Anchor every heartbeat on `tool_use_id.replace(/-heartbeat-\d+$/, '')`. **Never** on `parent_tool_use_id` — it is the enclosing Task id for a tool inside a subagent.
- A `tool_progress` frame with `subagent_type` and **no** `subagent_retry` key means *retry resolved*. Absence is the signal.
- Heartbeat cadence is 30s exactly (`var $wt = 30000` in CLI 2.1.270).
- `tool_progress` must never reach `messages[]` and must never be written to the daemon session log.
- Verification gate (cross-cutting change): `npm run check`, `npm run build`, `npm run test:coverage`, then `npm run rebuild:electron`.

---

### Task 1: Classify `tool_progress` and reduce it

**Files:**
- Modify: `src/types/jsonl.ts` (the `JsonlNode` union ~line 343, `RenderedKind` ~349, `OverlayKind` ~352)
- Modify: `src/lib/jsonlClassifier.ts` (the `switch (type)` ~line 54)
- Create: `src/lib/toolProgress.ts`
- Test: `src/lib/__tests__/toolProgress.test.ts`, `src/lib/__tests__/jsonlClassifier.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // src/types/jsonl.ts
  export interface ToolProgressRaw {
    type: 'tool_progress';
    tool_use_id: string;
    tool_name: string;
    parent_tool_use_id: string | null;
    elapsed_time_seconds: number;
    uuid?: string;
    session_id?: string;
    task_id?: string;
    heartbeat?: boolean;
    subagent_type?: string;
    subagent_retry?: {
      agent_id: string; attempt: number; max_retries: number;
      retry_delay_ms: number; error_status: number | null; error_category: string;
    };
  }
  // added to JsonlNode:
  //   | { kind: 'tool-progress'; raw: ToolProgressRaw; anchorToolUseId: string }

  // src/lib/toolProgress.ts
  export interface ToolProgressRetry {
    attempt: number; maxRetries: number; retryDelayMs: number;
    errorStatus: number | null; errorCategory: string;
  }
  export interface ToolProgressEntry {
    elapsedSeconds: number;
    arrivedAtMs: number;
    retry: ToolProgressRetry | null;
  }
  export type ToolProgressMap = ReadonlyMap<string, ToolProgressEntry>;
  export const EMPTY_TOOL_PROGRESS: ToolProgressMap;
  export function reduceToolProgress(
    prev: ToolProgressMap,
    node: Extract<JsonlNode, { kind: 'tool-progress' }>,
    nowMs: number,
  ): ToolProgressMap;
  export function pruneToolProgress(prev: ToolProgressMap, keepIds: Set<string>): ToolProgressMap;
  export function anchorToolUseId(toolUseId: string): string;
  ```

- [ ] **Step 1: Write the failing reducer tests**

```ts
// src/lib/__tests__/toolProgress.test.ts
import { describe, it, expect } from 'vitest';
import { reduceToolProgress, pruneToolProgress, anchorToolUseId, EMPTY_TOOL_PROGRESS } from '../toolProgress';
import type { JsonlNode } from '@/types/jsonl';

function beat(id: string, elapsed: number, parent: string | null = null): Extract<JsonlNode, { kind: 'tool-progress' }> {
  return {
    kind: 'tool-progress',
    anchorToolUseId: anchorToolUseId(id),
    raw: { type: 'tool_progress', tool_use_id: id, tool_name: 'Bash',
           parent_tool_use_id: parent, elapsed_time_seconds: elapsed, heartbeat: true },
  };
}

describe('anchorToolUseId', () => {
  it('strips the synthetic heartbeat suffix', () => {
    expect(anchorToolUseId('toolu_01AAA-heartbeat-0')).toBe('toolu_01AAA');
    expect(anchorToolUseId('toolu_01AAA-heartbeat-17')).toBe('toolu_01AAA');
  });
  it('leaves a plain tool id alone', () => {
    expect(anchorToolUseId('toolu_01AAA')).toBe('toolu_01AAA');
  });
  it('does not strip a trailing hyphen-number that is not a heartbeat', () => {
    expect(anchorToolUseId('toolu_01AAA-retry-2')).toBe('toolu_01AAA-retry-2');
  });
});

describe('reduceToolProgress', () => {
  it('keys the entry by the real tool id, not the heartbeat id', () => {
    const next = reduceToolProgress(EMPTY_TOOL_PROGRESS, beat('toolu_01AAA-heartbeat-0', 30), 1000);
    expect([...next.keys()]).toEqual(['toolu_01AAA']);
    expect(next.get('toolu_01AAA')).toEqual({ elapsedSeconds: 30, arrivedAtMs: 1000, retry: null });
  });

  it('ignores parent_tool_use_id even when it names a different tool', () => {
    // A Bash running inside a subagent: parent is the Task id, not the Bash id.
    const next = reduceToolProgress(EMPTY_TOOL_PROGRESS, beat('toolu_BASH-heartbeat-1', 60, 'toolu_TASK'), 2000);
    expect([...next.keys()]).toEqual(['toolu_BASH']);
  });

  it('is idempotent — the same frame twice yields an equal map', () => {
    const a = reduceToolProgress(EMPTY_TOOL_PROGRESS, beat('toolu_01AAA-heartbeat-0', 30), 1000);
    const b = reduceToolProgress(a, beat('toolu_01AAA-heartbeat-0', 30), 1000);
    expect(b.get('toolu_01AAA')).toEqual(a.get('toolu_01AAA'));
  });

  it('returns the SAME reference when nothing moved', () => {
    const a = reduceToolProgress(EMPTY_TOOL_PROGRESS, beat('toolu_01AAA-heartbeat-0', 30), 1000);
    const b = reduceToolProgress(a, beat('toolu_01AAA-heartbeat-0', 30), 1000);
    expect(b).toBe(a);
  });

  it('does not mutate the previous map', () => {
    const a = reduceToolProgress(EMPTY_TOOL_PROGRESS, beat('toolu_01AAA-heartbeat-0', 30), 1000);
    reduceToolProgress(a, beat('toolu_01AAA-heartbeat-1', 60), 2000);
    expect(a.get('toolu_01AAA')?.elapsedSeconds).toBe(30);
  });

  it('records a subagent retry', () => {
    const node: Extract<JsonlNode, { kind: 'tool-progress' }> = {
      kind: 'tool-progress', anchorToolUseId: 'toolu_TASK',
      raw: { type: 'tool_progress', tool_use_id: 'toolu_TASK', tool_name: 'Task',
             parent_tool_use_id: null, elapsed_time_seconds: 0, subagent_type: 'Explore',
             subagent_retry: { agent_id: 'a1', attempt: 2, max_retries: 3, retry_delay_ms: 1500,
                               error_status: 529, error_category: 'overloaded_error' } },
    };
    const next = reduceToolProgress(EMPTY_TOOL_PROGRESS, node, 1000);
    expect(next.get('toolu_TASK')?.retry).toEqual({
      attempt: 2, maxRetries: 3, retryDelayMs: 1500, errorStatus: 529, errorCategory: 'overloaded_error',
    });
  });

  it('clears the retry when a resolved frame arrives (subagent_retry absent)', () => {
    const retrying: Extract<JsonlNode, { kind: 'tool-progress' }> = {
      kind: 'tool-progress', anchorToolUseId: 'toolu_TASK',
      raw: { type: 'tool_progress', tool_use_id: 'toolu_TASK', tool_name: 'Task',
             parent_tool_use_id: null, elapsed_time_seconds: 0, subagent_type: 'Explore',
             subagent_retry: { agent_id: 'a1', attempt: 2, max_retries: 3, retry_delay_ms: 1500,
                               error_status: 529, error_category: 'overloaded_error' } },
    };
    const resolved: Extract<JsonlNode, { kind: 'tool-progress' }> = {
      kind: 'tool-progress', anchorToolUseId: 'toolu_TASK',
      raw: { type: 'tool_progress', tool_use_id: 'toolu_TASK', tool_name: 'Task',
             parent_tool_use_id: null, elapsed_time_seconds: 0, subagent_type: 'Explore' },
    };
    const a = reduceToolProgress(EMPTY_TOOL_PROGRESS, retrying, 1000);
    const b = reduceToolProgress(a, resolved, 2000);
    expect(b.get('toolu_TASK')?.retry).toBeNull();
  });

  it('a heartbeat does not clear an open retry', () => {
    const retrying: Extract<JsonlNode, { kind: 'tool-progress' }> = {
      kind: 'tool-progress', anchorToolUseId: 'toolu_TASK',
      raw: { type: 'tool_progress', tool_use_id: 'toolu_TASK', tool_name: 'Task',
             parent_tool_use_id: null, elapsed_time_seconds: 0, subagent_type: 'Explore',
             subagent_retry: { agent_id: 'a1', attempt: 1, max_retries: 3, retry_delay_ms: 500,
                               error_status: null, error_category: 'timeout' } },
    };
    const a = reduceToolProgress(EMPTY_TOOL_PROGRESS, retrying, 1000);
    const b = reduceToolProgress(a, beat('toolu_TASK-heartbeat-0', 30), 2000);
    expect(b.get('toolu_TASK')?.retry?.attempt).toBe(1);
    expect(b.get('toolu_TASK')?.elapsedSeconds).toBe(30);
  });
});

describe('pruneToolProgress', () => {
  it('drops every key not in the keep set', () => {
    let m = reduceToolProgress(EMPTY_TOOL_PROGRESS, beat('toolu_A-heartbeat-0', 30), 1000);
    m = reduceToolProgress(m, beat('toolu_B-heartbeat-0', 30), 1000);
    expect([...pruneToolProgress(m, new Set(['toolu_A'])).keys()]).toEqual(['toolu_A']);
  });
  it('returns the same reference when nothing is dropped', () => {
    const m = reduceToolProgress(EMPTY_TOOL_PROGRESS, beat('toolu_A-heartbeat-0', 30), 1000);
    expect(pruneToolProgress(m, new Set(['toolu_A']))).toBe(m);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/toolProgress.test.ts`
Expected: FAIL — cannot resolve `../toolProgress`.

- [ ] **Step 3: Add `ToolProgressRaw` and the node kind to `src/types/jsonl.ts`**

Add the `ToolProgressRaw` interface next to `RateLimitEventRaw`. In the `JsonlNode`
union, put the new member in the **Overlay** block beside `lifecycle`:

```ts
  | { kind: 'tool-progress'; raw: ToolProgressRaw; anchorToolUseId: string }
```

with this comment above it:

```ts
  // Live-stream only, exactly like `stream-event`: the CLI emits tool_progress
  // on the stream-json stdout path and never writes it to the JSONL on disk.
  // Putting it in messages[] would make a live transcript and a reloaded one
  // disagree. `anchorToolUseId` is the REAL tool id — a heartbeat's own
  // tool_use_id is synthetic (`<realId>-heartbeat-<n>`) and its
  // parent_tool_use_id is the enclosing Task id when the tool runs inside a
  // subagent, so neither field can be used directly.
```

Then add `'tool-progress'` to the literal lists in **both** `RenderedKind` and
`OverlayKind` — they are hand-written `Exclude`/`Extract` unions and neither
updates itself:

```ts
export type RenderedKind = Exclude<JsonlNode['kind'], 'stream-event' | 'rate-limit' | 'lifecycle' | 'tool-progress'>;
export type OverlayKind = Extract<JsonlNode['kind'], 'stream-event' | 'rate-limit' | 'lifecycle' | 'tool-progress'>;
```

- [ ] **Step 4: Write `src/lib/toolProgress.ts`**

```ts
import type { JsonlNode } from '@/types/jsonl';

export type ToolProgressNode = Extract<JsonlNode, { kind: 'tool-progress' }>;

export interface ToolProgressRetry {
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
  errorCategory: string;
}

export interface ToolProgressEntry {
  /** `elapsed_time_seconds` from the newest frame. */
  elapsedSeconds: number;
  /** Wall clock when that frame arrived, so a chip can interpolate between
   *  the CLI's 30-second beats instead of jumping by half-minutes. */
  arrivedAtMs: number;
  retry: ToolProgressRetry | null;
}

export type ToolProgressMap = ReadonlyMap<string, ToolProgressEntry>;

export const EMPTY_TOOL_PROGRESS: ToolProgressMap = new Map();

const HEARTBEAT_SUFFIX = /-heartbeat-\d+$/;

/**
 * The real tool_use id a progress frame belongs to.
 *
 * The CLI mints a synthetic id per beat (`${toolUseID}-heartbeat-${n++}`) and
 * sets `parent_tool_use_id` to `Se.parentToolUseID ?? n`, which is the
 * enclosing Task id for a tool running inside a subagent. Stripping the
 * suffix is the only rule correct in both cases.
 */
export function anchorToolUseId(toolUseId: string): string {
  return toolUseId.replace(HEARTBEAT_SUFFIX, '');
}

function sameRetry(a: ToolProgressRetry | null, b: ToolProgressRetry | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.attempt === b.attempt &&
    a.maxRetries === b.maxRetries &&
    a.retryDelayMs === b.retryDelayMs &&
    a.errorStatus === b.errorStatus &&
    a.errorCategory === b.errorCategory
  );
}

/**
 * Fold one frame into the per-tab map. Pure, idempotent, and reference-stable:
 * a frame that changes nothing returns `prev` itself, so a duplicate delivery
 * (a remote client's reconnect replay, say) cannot cost a render.
 */
export function reduceToolProgress(
  prev: ToolProgressMap,
  node: ToolProgressNode,
  nowMs: number,
): ToolProgressMap {
  const key = node.anchorToolUseId;
  const existing = prev.get(key);
  const raw = node.raw;

  // A retry frame is the only thing that speaks about `retry`. A heartbeat
  // leaves whatever is there alone: the two channels interleave, and a beat
  // arriving mid-retry must not report the retry as resolved.
  let retry: ToolProgressRetry | null = existing?.retry ?? null;
  if (raw.subagent_retry) {
    const r = raw.subagent_retry;
    retry = {
      attempt: r.attempt,
      maxRetries: r.max_retries,
      retryDelayMs: r.retry_delay_ms,
      errorStatus: r.error_status,
      errorCategory: r.error_category,
    };
  } else if (raw.subagent_type !== undefined) {
    // `subagent_type` with no `subagent_retry` IS the CLI's resolved signal —
    // the emitter spreads `...resolved !== true && { subagent_retry }`.
    retry = null;
  }

  const elapsedSeconds = raw.elapsed_time_seconds;
  if (
    existing &&
    existing.elapsedSeconds === elapsedSeconds &&
    existing.arrivedAtMs === nowMs &&
    sameRetry(existing.retry, retry)
  ) {
    return prev;
  }

  const next = new Map(prev);
  next.set(key, { elapsedSeconds, arrivedAtMs: nowMs, retry });
  return next;
}

/** Drop every entry whose tool is no longer of interest (turn ended). */
export function pruneToolProgress(prev: ToolProgressMap, keepIds: Set<string>): ToolProgressMap {
  let dropped = false;
  for (const key of prev.keys()) {
    if (!keepIds.has(key)) { dropped = true; break; }
  }
  if (!dropped) return prev;
  const next = new Map<string, ToolProgressEntry>();
  for (const [key, value] of prev) {
    if (keepIds.has(key)) next.set(key, value);
  }
  return next;
}
```

- [ ] **Step 5: Run the reducer tests**

Run: `npx vitest run src/lib/__tests__/toolProgress.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing classifier tests**

Append to `src/lib/__tests__/jsonlClassifier.test.ts`:

```ts
describe('tool_progress', () => {
  const base = {
    type: 'tool_progress',
    tool_use_id: 'toolu_01AAA-heartbeat-0',
    tool_name: 'Bash',
    parent_tool_use_id: 'toolu_01AAA',
    elapsed_time_seconds: 30,
    heartbeat: true,
    session_id: 'fe10d371',
    uuid: '218fefdf',
  };

  it('classifies as the tool-progress overlay kind', () => {
    const node = classifyJsonlLine(base);
    expect(node?.kind).toBe('tool-progress');
  });

  it('anchors on the real tool id, not the synthetic heartbeat id', () => {
    const node = classifyJsonlLine(base);
    expect(node && 'anchorToolUseId' in node && node.anchorToolUseId).toBe('toolu_01AAA');
  });

  it('anchors correctly when the parent is a different tool (nested in a subagent)', () => {
    const node = classifyJsonlLine({ ...base, tool_use_id: 'toolu_BASH-heartbeat-3', parent_tool_use_id: 'toolu_TASK' });
    expect(node && 'anchorToolUseId' in node && node.anchorToolUseId).toBe('toolu_BASH');
  });

  it('rejects a frame with a non-string tool_use_id', () => {
    expect(classifyJsonlLine({ ...base, tool_use_id: 7 })).toBeNull();
  });

  it('rejects a frame with a non-string tool_name', () => {
    expect(classifyJsonlLine({ ...base, tool_name: null })).toBeNull();
  });

  it('rejects a frame with a non-finite elapsed_time_seconds', () => {
    expect(classifyJsonlLine({ ...base, elapsed_time_seconds: 'soon' })).toBeNull();
    expect(classifyJsonlLine({ ...base, elapsed_time_seconds: Infinity })).toBeNull();
  });

  it('needs no timestamp — the frame carries none and is live-only', () => {
    const { ...noTime } = base;
    expect(classifyJsonlLine(noTime)?.kind).toBe('tool-progress');
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/jsonlClassifier.test.ts -t tool_progress`
Expected: FAIL — kind is `'unknown'`.

- [ ] **Step 8: Add the classifier case**

In `src/lib/jsonlClassifier.ts`, add to the switch before `default:`:

```ts
    case 'tool_progress':
      return classifyToolProgress(r);
```

and the function, importing `anchorToolUseId` from `./toolProgress` and
`ToolProgressRaw` from `@/types/jsonl`:

```ts
/**
 * Live-only progress frame for an in-flight tool call.
 *
 * The guard mirrors the CLI's own `sdkMessageAdapter`, which drops a frame
 * "with a non-string tool_name/tool_use_id or non-finite
 * elapsed_time_seconds" — same three fields, same verdict, so a malformed
 * frame cannot reach a chip that will do arithmetic on it.
 *
 * No `receivedAt` requirement: the frame carries no `timestamp` by design
 * (it is never persisted), and the live envelope's `receivedAt` is not
 * needed — the reducer stamps arrival itself.
 */
function classifyToolProgress(r: Record<string, unknown>): JsonlNode | null {
  const toolUseId = r.tool_use_id;
  const toolName = r.tool_name;
  const elapsed = r.elapsed_time_seconds;
  if (typeof toolUseId !== 'string' || toolUseId.length === 0) return null;
  if (typeof toolName !== 'string') return null;
  if (typeof elapsed !== 'number' || !Number.isFinite(elapsed)) return null;
  return {
    kind: 'tool-progress',
    raw: r as unknown as ToolProgressRaw,
    anchorToolUseId: anchorToolUseId(toolUseId),
  };
}
```

- [ ] **Step 9: Run both suites**

Run: `npx vitest run src/lib/__tests__/toolProgress.test.ts src/lib/__tests__/jsonlClassifier.test.ts`
Expected: PASS.

- [ ] **Step 10: Typecheck**

Run: `npm run check`
Expected: clean. If `sessionStreamReducer.ts:323` or `AgentSession.tsx:1253` now
fail exhaustiveness, that is Task 2's work — note it and continue.

---

### Task 2: Store slot, stream wiring, and the daemon log exclusion

**Files:**
- Modify: `src/stores/claudeSessionStore.ts` (`TabSessionState` ~21-37, `EMPTY_TAB_SESSION` ~39-48, actions interface ~63-80, action impls ~95-175)
- Modify: `src/lib/sessionStreamReducer.ts:323` (overlay guard)
- Modify: `src/components/AgentSession.tsx` (~1240-1255)
- Modify: `electron/remote/bridge.ts` (`transcript()` ~126-134)
- Test: `electron/__tests__/remote-bridge.test.ts`

**Interfaces:**
- Consumes: `reduceToolProgress`, `pruneToolProgress`, `EMPTY_TOOL_PROGRESS`, `ToolProgressMap` from Task 1.
- Produces:
  ```ts
  // TabSessionState gains:
  toolProgress: ToolProgressMap;
  // store actions gain:
  applyToolProgress(tabId: string, node: ToolProgressNode): void;
  pruneToolProgressFor(tabId: string, keepIds: Set<string>): void;
  ```

- [ ] **Step 1: Add the store slot**

In `src/stores/claudeSessionStore.ts`, add to `TabSessionState`:

```ts
  /** Live-only per-tool progress, keyed by the REAL tool_use id. Never
   *  persisted and never part of `messages[]` — see src/lib/toolProgress.ts.
   *  `resetTab` clears it, so clear/restart needs no separate handling. */
  toolProgress: ToolProgressMap;
```

to `EMPTY_TAB_SESSION`: `toolProgress: EMPTY_TOOL_PROGRESS,`

to the actions interface:

```ts
  applyToolProgress(tabId: string, node: ToolProgressNode): void;
  pruneToolProgressFor(tabId: string, keepIds: Set<string>): void;
```

and the implementations, both of which bail when the reducer returns the same
reference so a duplicate frame costs no render:

```ts
    applyToolProgress: (tabId, node) =>
      { set((state) => {
        const slice = ensureTab(state.tabs, tabId);
        const toolProgress = reduceToolProgress(slice.toolProgress, node, Date.now());
        if (toolProgress === slice.toolProgress) return state;
        return { tabs: { ...state.tabs, [tabId]: { ...slice, toolProgress } } };
      }); },

    pruneToolProgressFor: (tabId, keepIds) =>
      { set((state) => {
        const slice = state.tabs[tabId];
        if (!slice) return state;
        const toolProgress = pruneToolProgress(slice.toolProgress, keepIds);
        if (toolProgress === slice.toolProgress) return state;
        return { tabs: { ...state.tabs, [tabId]: { ...slice, toolProgress } } };
      }); },
```

- [ ] **Step 2: Extend the two overlay guards**

`src/lib/sessionStreamReducer.ts:323` and `src/components/AgentSession.tsx:1253`
both list the overlay kinds by hand. Add `'tool-progress'` to each. In
`AgentSession.tsx`, dispatch *before* returning:

```ts
      if (node.kind === 'tool-progress') {
        useClaudeSessionStore.getState().applyToolProgress(sessionTabId, node);
        return;
      }
      if (node.kind === 'stream-event' || node.kind === 'rate-limit' || node.kind === 'lifecycle') return;
```

Update the comment at `AgentSession.tsx:1248-1250` — it says overlay kinds
"return null from the classifier", which was already only true of three of
them and is now false of the fourth.

- [ ] **Step 3: Prune at turn end**

Where `AgentSession.tsx` already reacts to `cli-stream-result`, call
`pruneToolProgressFor(tabId, new Set())`. A finished turn has no running tools,
so the keep set is empty; the map never grows across a long session.

- [ ] **Step 4: Write the failing bridge test**

In `electron/__tests__/remote-bridge.test.ts`:

```ts
it('forwards a tool_progress frame to clients but never logs it', () => {
  const { bridge, log, sent } = makeBridge();   // existing harness
  bridge.sendToRenderer('claude-stream:tab-1', {
    type: 'tool_progress', tool_use_id: 'toolu_A-heartbeat-0', tool_name: 'Bash',
    parent_tool_use_id: 'toolu_A', elapsed_time_seconds: 30, heartbeat: true,
  });
  expect(sent.some((m) => m.kind === 'transcript')).toBe(true);
  expect(log.append).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `npx vitest run electron/__tests__/remote-bridge.test.ts -t tool_progress`
Expected: FAIL — the frame is appended to the log.

- [ ] **Step 6: Exclude it in `transcript()`**

`electron/remote/bridge.ts`, in `transcript()`, emit without sequencing/logging
when the node is a heartbeat:

```ts
    // Forwarded live, never logged. A heartbeat is one line per 30s per slow
    // tool and replaying it buys nothing: the render-time gate already hides
    // progress for any tool whose result has landed, and a tool still running
    // at reconnect emits a fresh frame within 30s.
    if (node.kind === 'tool-progress') {
      deps.broadcast({ type: 'event', sessionId, kind: 'transcript', channel, payload: node, origin });
      return;
    }
```

Match the existing broadcast helper's actual signature when writing this —
`emitEvent` sequences through the log, so this path must not use it.

- [ ] **Step 7: Run the bridge suite**

Run: `npx vitest run electron/__tests__/remote-bridge.test.ts`
Expected: PASS.

---

### Task 3: The chip

**Files:**
- Create: `src/components/claude/tools/ToolProgressChip.tsx`
- Modify: `src/components/StreamMessage.tsx` (~line 863, where `renderToolWidget()` is called)
- Test: `src/components/__tests__/ToolProgressChip.test.tsx`

**Interfaces:**
- Consumes: `ToolProgressEntry` (Task 1), `toolProgress` slice (Task 2).
- Produces:
  ```ts
  export interface ToolProgressChipProps { entry: ToolProgressEntry | null | undefined; done: boolean }
  export function formatToolElapsed(totalSeconds: number): string; // "0:42" | "12:05" | "1:04:09"
  export const ToolProgressChip: React.FC<ToolProgressChipProps>;
  ```

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/__tests__/ToolProgressChip.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolProgressChip, formatToolElapsed } from '@/components/claude/tools/ToolProgressChip';

describe('formatToolElapsed', () => {
  it('renders m:ss under an hour', () => {
    expect(formatToolElapsed(42)).toBe('0:42');
    expect(formatToolElapsed(725)).toBe('12:05');
  });
  it('widens to h:mm:ss past an hour', () => {
    expect(formatToolElapsed(3849)).toBe('1:04:09');
  });
  it('floors negatives to zero', () => {
    expect(formatToolElapsed(-5)).toBe('0:00');
  });
});

describe('ToolProgressChip', () => {
  const entry = { elapsedSeconds: 30, arrivedAtMs: Date.now(), retry: null };

  it('renders nothing without an entry', () => {
    const { container } = render(<ToolProgressChip entry={null} done={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing once the tool result has landed', () => {
    const { container } = render(<ToolProgressChip entry={entry} done={true} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows elapsed time while running', () => {
    render(<ToolProgressChip entry={entry} done={false} />);
    expect(screen.getByText(/0:3\d/)).toBeInTheDocument();
  });

  it('shows the retry attempt and error category', () => {
    render(<ToolProgressChip done={false} entry={{
      ...entry,
      retry: { attempt: 2, maxRetries: 3, retryDelayMs: 1500, errorStatus: 529, errorCategory: 'overloaded_error' },
    }} />);
    expect(screen.getByText(/attempt 2\/3/)).toBeInTheDocument();
    expect(screen.getByText(/overloaded_error/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/__tests__/ToolProgressChip.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the chip**

```tsx
import * as React from 'react';
import { Timer, RotateCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSecondTick } from '@/hooks/useSecondTick';
import type { ToolProgressEntry } from '@/lib/toolProgress';

/** `0:42`, `12:05`, `1:04:09`. */
export function formatToolElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const seconds = s % 60;
  const minutes = Math.floor(s / 60) % 60;
  const hours = Math.floor(s / 3600);
  const ss = String(seconds).padStart(2, '0');
  if (hours === 0) return `${minutes}:${ss}`;
  return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
}

export interface ToolProgressChipProps {
  entry: ToolProgressEntry | null | undefined;
  /** True once the tool_result has landed. The render-time kill switch: a
   *  stale map entry can never paint, which is what lets the map be pruned
   *  lazily rather than in lockstep with the stream. */
  done: boolean;
}

/**
 * Transient progress for an in-flight tool call: elapsed time, and a retry
 * banner when a subagent is being retried.
 *
 * The CLI beats every 30 seconds, so the raw value would jump by half-minutes.
 * This interpolates from the last beat's arrival instead, and only subscribes
 * to the shared clock while it is actually showing something — an idle
 * transcript runs no timer.
 */
export const ToolProgressChip: React.FC<ToolProgressChipProps> = ({ entry, done }) => {
  const live = !!entry && !done;
  const nowMs = useSecondTick(live);
  if (!entry || done) return null;

  const seconds = entry.elapsedSeconds + Math.max(0, (nowMs - entry.arrivedAtMs) / 1000);
  const retry = entry.retry;

  return (
    <span className="inline-flex items-center gap-2 text-[10px] font-mono tabular-nums">
      <span
        className="inline-flex items-center gap-1 text-muted-foreground"
        title="Still running — the CLI reports progress every 30s"
      >
        <Timer className="h-3 w-3" />
        {formatToolElapsed(seconds)}
      </span>
      {retry && (
        <span
          className={cn('inline-flex items-center gap-1 text-amber-500')}
          title={
            retry.errorStatus !== null
              ? `HTTP ${retry.errorStatus} — retrying in ${retry.retryDelayMs}ms`
              : `Retrying in ${retry.retryDelayMs}ms`
          }
        >
          <RotateCw className="h-3 w-3 animate-spin" />
          attempt {retry.attempt}/{retry.maxRetries} · {retry.errorCategory}
        </span>
      )}
    </span>
  );
};
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/components/__tests__/ToolProgressChip.test.tsx`
Expected: PASS.

- [ ] **Step 5: Mount it in `StreamMessage.tsx`**

At the `const widget = renderToolWidget();` site (~line 863), read the slice
once per render near `toolResults` (~line 368):

```tsx
  const toolProgress = useTabSession(tabId).toolProgress;
```

(use whatever tab-scoped accessor the component already has in scope; if it has
none, thread `toolProgress` in as a prop from `ClaudeTranscript` rather than
reaching into the store from a leaf.)

Then wrap the widget so **every** tool widget gets the chip without editing
fifteen files:

```tsx
          const widget = renderToolWidget();
          if (widget) {
            return (
              <React.Fragment key={idx}>
                {widget}
                {/* Rendered here, not inside each widget: progress is a
                    property of the CALL, not of any one tool's output. */}
                <ToolProgressChip
                  entry={toolId ? toolProgress.get(toolId) : null}
                  done={!!toolResult}
                />
              </React.Fragment>
            );
          }
```

- [ ] **Step 6: Verify**

Run: `npm run check && npx vitest run src/components/__tests__/`
Expected: PASS.

---

### Task 4: Stop counting `ambient` tasks as activity

**Files:**
- Modify: `src/lib/subagentEvents.ts` (`CliTaskStartedMessage` ~32-39, `SubagentState` ~94-122, `SubagentEvent` `Started` ~130-141, the `task_started` branch ~618-626, the `case 'Started'` reducer ~745-752)
- Modify: `src/lib/subagentStreams.ts` (`Subagent` ~46-, add `countActiveSubagents` near `hasRunningSubagent` ~403)
- Modify: `src/components/AgentSession.tsx:978`
- Test: `src/lib/__tests__/subagentStreams.test.ts`

**Interfaces:**
- Produces: `export function countActiveSubagents(subs: Subagent[]): number;`
  and an `ambient?: boolean` field on `Subagent` / `SubagentState` / the
  `Started` event.

- [ ] **Step 1: Write the failing test**

```ts
describe('countActiveSubagents', () => {
  it('counts running, non-ambient subagents', () => {
    const subs = subagentsFromMessages([
      dispatch('toolu_A', 'real work'),
      taskStarted('toolu_A', { ambient: false }),
      dispatch('toolu_B', 'live-update watcher'),
      taskStarted('toolu_B', { ambient: true }),
    ]);
    expect(countActiveSubagents(subs)).toBe(1);
  });

  it('still renders the ambient row — it is hidden from the COUNT, not the bar', () => {
    const subs = subagentsFromMessages([
      dispatch('toolu_B', 'live-update watcher'),
      taskStarted('toolu_B', { ambient: true }),
    ]);
    expect(subs).toHaveLength(1);
    expect(subs[0].ambient).toBe(true);
  });

  it('treats a task_started with no ambient field as activity', () => {
    const subs = subagentsFromMessages([dispatch('toolu_A', 'work'), taskStarted('toolu_A', {})]);
    expect(countActiveSubagents(subs)).toBe(1);
  });
});
```

(Reuse the file's existing message-builder helpers; add an `ambient` option to
its `taskStarted` builder rather than inventing a new one.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/subagentStreams.test.ts -t countActiveSubagents`
Expected: FAIL — `countActiveSubagents` is not exported.

- [ ] **Step 3: Thread `ambient` through**

`CliTaskStartedMessage` gains `ambient?: boolean`. The `Started` event gains:

```ts
      /** CLI 2.1.270 `task_started.ambient`. The schema's own words: "True
       *  for tasks that are not activity (every skip_transcript task, plus
       *  every live-update watcher, requested or auto-started); hosts should
       *  exclude them from activity indicators." */
      ambient?: boolean;
```

The `task_started` branch passes `ambient: (tlm as { ambient?: unknown }).ambient === true`.
The `case 'Started'` reducer sets `if (ev.ambient) s.ambient = true;`.
`SubagentState` and `Subagent` both carry `ambient?: boolean`, and the
`Subagent` mapper (`subagentStreams.ts`, the object built around line 345)
copies it.

- [ ] **Step 4: Add the counter**

In `src/lib/subagentStreams.ts`, next to `hasRunningSubagent`:

```ts
/**
 * How many subagents count as ACTIVITY — running, and not ambient.
 *
 * Deliberately separate from `hasRunningSubagent`, which means "still open".
 * Conflating the two is how the tab badge ended up counting live-update
 * watchers as work in progress. See the `ambient` note on SubagentState.
 */
export function countActiveSubagents(subs: Subagent[]): number {
  return subs.reduce((n, s) => (s.status === 'running' && !s.ambient ? n + 1 : n), 0);
}
```

- [ ] **Step 5: Use it**

`AgentSession.tsx:978` replaces its inline `reduce` with
`const activeSubagentCount = countActiveSubagents(subagents);`.

- [ ] **Step 6: Run**

Run: `npx vitest run src/lib/__tests__/subagentStreams.test.ts src/lib/__tests__/subagentEvents.test.ts && npm run check`
Expected: PASS.

---

### Task 5: Inline picker variants

**Files:**
- Modify: `src/components/ControlBar.tsx` (`EffortPickerProps.variant` ~144-146, `EffortPicker` ~185-290; `PermissionPickerProps.variant` ~299-302, `PermissionPicker` ~304-365)
- Modify: `src/components/ModelPicker.tsx` (add `InlineModelPicker` beside `FormModelPicker` ~78-130)
- Modify: `src/components/shared/SessionDefaultsRow.tsx`
- Test: `src/components/shared/__tests__/SessionDefaultsRow.test.tsx`

**Interfaces:**
- Produces:
  - `variant?: "compact" | "expanded" | "form" | "inline"` on `EffortPicker`
  - `variant?: "compact" | "form" | "inline"` on `PermissionPicker`
  - `export function InlineModelPicker(props: FormModelPickerProps)` — same props as `FormModelPicker`
  - `density?: 'default' | 'compact'` on `SessionDefaultsRowProps`

- [ ] **Step 1: Write the failing test**

```tsx
it('compact density renders one row with no field labels', () => {
  render(<SessionDefaultsRow engine="claude" density="compact" {...baseProps} />);
  expect(screen.queryByText('Model')).not.toBeInTheDocument();
  expect(screen.queryByText('Effort')).not.toBeInTheDocument();
  expect(screen.queryByText('Permissions')).not.toBeInTheDocument();
});

it('default density keeps the field labels', () => {
  render(<SessionDefaultsRow engine="claude" {...baseProps} />);
  expect(screen.getByText('Model')).toBeInTheDocument();
});

it('compact density still exposes all three controls', () => {
  render(<SessionDefaultsRow engine="claude" density="compact" {...baseProps} />);
  expect(screen.getAllByRole('button')).toHaveLength(3);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/shared/__tests__/SessionDefaultsRow.test.tsx`
Expected: FAIL — labels still render.

- [ ] **Step 3: Add the `inline` variants**

In `ControlBar.tsx`, add a branch above the existing `variant === "form"` check
in each picker. Trigger shape, identical in both:

```tsx
  if (variant === "inline") {
    return (
      <Popover
        trigger={
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => { onOpenChange(!open); }}
            title={`${LABEL}: ${currentLevel?.name}`}
            className="h-6 min-w-0 flex-1 justify-between gap-1 px-1.5 font-normal"
          >
            <span className="flex items-center gap-1 min-w-0">
              {ICON}
              <span className={cn("text-[11px] truncate", COLOR)}>{SHORT_NAME}</span>
            </span>
            <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />
          </Button>
        }
        content={/* the SAME dropdown JSX the form variant uses */}
        open={open}
        onOpenChange={onOpenChange}
      />
    );
  }
```

Note the comment to leave above it:

```tsx
  // A fourth variant rather than a reuse of "compact": that one means THE
  // BOTTOM BAR — h-9, ghost, and a ChevronUp because it opens upward. Inside
  // a downward popover that chevron points at nothing. Sharing a variant the
  // two surfaces disagree about is how one of them silently regresses.
```

`ChevronDown` must be imported in `ControlBar.tsx` if it is not already.

In `ModelPicker.tsx`, `InlineModelPicker` is `FormModelPicker` with
`className="h-6 min-w-0 flex-1 justify-between gap-1 px-1.5 font-normal"`,
`text-[11px]` on the name span, and the same `ModelPickerDropdown` content.
Extract the shared body into one internal component taking a `size: 'form' | 'inline'`
rather than copying it — the two must not drift on selection-closes-the-popover
behaviour, which was a real bug once (see the comment at `ModelPicker.tsx:87`).

- [ ] **Step 4: Add `density` to `SessionDefaultsRow`**

```tsx
  /** 'compact' drops the field labels and uses the `inline` pickers so all
   *  three fit on one line — the context popover's control row. */
  density?: 'default' | 'compact';
```

When `density === 'compact'`: layout is `flex items-center gap-1.5`, `Field`
is bypassed (render the picker directly), and each picker gets
`variant="inline"` / `InlineModelPicker`. The `disabled` TUI footnote keeps
rendering, at `text-[10px]`, below the row.

- [ ] **Step 5: Run**

Run: `npx vitest run src/components/shared/__tests__/SessionDefaultsRow.test.tsx && npm run check`
Expected: PASS.

---

### Task 6: Popover restructure

**Files:**
- Modify: `src/components/SessionCard.tsx` (popover `content` ~335-480)
- Modify: `src/components/AgentSession.tsx` (~2424, pass `density="compact"`)
- Test: `src/components/__tests__/SessionCard.test.tsx`

**Interfaces:**
- Consumes: `density` from Task 5.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing tests**

```tsx
const DETAILS_KEY = 'greychrist.sessionCard.detailsOpen';

it('collapses the category breakdown by default', async () => {
  window.localStorage.removeItem(DETAILS_KEY);
  renderCardWithCategories();
  await openPopover();
  expect(screen.queryByText('Free space')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /details/i })).toBeInTheDocument();
});

it('reveals the breakdown when Details is opened', async () => {
  renderCardWithCategories();
  await openPopover();
  await userEvent.click(screen.getByRole('button', { name: /details/i }));
  expect(screen.getByText('Free space')).toBeInTheDocument();
});

it('remembers that Details was opened', async () => {
  renderCardWithCategories();
  await openPopover();
  await userEvent.click(screen.getByRole('button', { name: /details/i }));
  expect(window.localStorage.getItem(DETAILS_KEY)).toBe('1');
});

it('orders the popover: Details, then Recent events, then controls, then session id', async () => {
  renderCardWithCategories({ controls: <div data-testid="controls" />, sessionId: 'abc-123' });
  await openPopover();
  const order = ['details-disclosure', 'recent-events', 'controls', 'session-id']
    .map((id) => screen.getByTestId(id));
  for (let i = 1; i < order.length; i++) {
    expect(order[i - 1].compareDocumentPosition(order[i]))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/__tests__/SessionCard.test.tsx`
Expected: FAIL — no Details button; categories render eagerly.

- [ ] **Step 3: Reorder and add the disclosure**

Move the band bar + legend block (currently after `Recent events`) up to sit
directly after the `Compact now` button, wrapped in:

```tsx
{/* Collapsed by default. The breakdown is the tallest thing in the popover
    and answers a question ("what is eating the window?") that is asked
    occasionally, while everything around it is read every time. */}
<div className="pt-2 mt-1 border-t border-border/50" data-testid="details-disclosure">
  <button
    type="button"
    onClick={() => { setDetailsOpen((v) => !v); }}
    aria-expanded={detailsOpen}
    className="flex w-full items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
  >
    <ChevronRight className={cn('h-3 w-3 transition-transform', detailsOpen && 'rotate-90')} />
    Details
  </button>
  {detailsOpen && (/* band bar + legend, or the not-yet-available fallback */)}
</div>
```

with state:

```tsx
  // Matches SubagentBar's COLLAPSE_STORAGE_KEY pattern: collapsed by default,
  // sticky once opened.
  const [detailsOpen, setDetailsOpen] = React.useState<boolean>(
    () => typeof window !== 'undefined' && window.localStorage.getItem(DETAILS_KEY) === '1',
  );
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(DETAILS_KEY, detailsOpen ? '1' : '0');
  }, [detailsOpen]);
```

Move the `{controls && …}` block down to sit between `Recent events` and the
session id, and drop its `border-t` wrapper's vertical padding to `pt-1.5`.
Add `data-testid` to the Recent events wrapper (`recent-events`), the controls
wrapper (`controls`) and the session-id row (`session-id`).

- [ ] **Step 4: Rewrite the two stale comments**

The `Recent events` comment ("Above the breakdown, not below it…") now
describes an order that no longer exists — rewrite it to say the breakdown is
collapsed by default, which solves the same off-the-bottom problem more
directly. The `controlsSummary` prop comment stays accurate but should note
that the summary now mirrors a row lower in the same popover.

- [ ] **Step 5: Pass the density**

`AgentSession.tsx:2424` — add `density="compact"` to the `SessionDefaultsRow`
it hands to `controls`.

- [ ] **Step 6: Run**

Run: `npx vitest run src/components/__tests__/SessionCard.test.tsx && npm run check`
Expected: PASS.

---

### Task 7: Turn-elapsed and last-thinking-burst signals

**Files:**
- Modify: `src/lib/thinkingStatus.ts`
- Modify: `src/lib/signals/emitters.ts` (`SignalInput` ~60-79, `activitySignal` ~100-131)
- Modify: `src/components/AgentSession.tsx` (~2183, where `SignalInput` is built)
- Test: `src/lib/__tests__/thinkingStatus.test.ts`, `src/lib/__tests__/signals.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // thinkingStatus.ts
  export function lastThinkingBurstTokens(messages: JsonlNode[]): number | null;
  // activitySignal meta gains:
  //   turnStartedAt: number | null
  //   lastTurnMs: number | null
  //   lastThinkingTokens: number | null
  // SignalInput gains:
  //   turnStartedAt: number | null
  //   lastTurnMs: number | null
  ```

- [ ] **Step 1: Write the failing test**

```ts
describe('lastThinkingBurstTokens', () => {
  it('returns the newest burst total after the burst has ended', () => {
    const messages = [
      thinkingTokens(1200), thinkingTokens(4800),   // burst one
      assistantText('done'),                         // burst closed
    ];
    expect(lastThinkingBurstTokens(messages)).toBe(4800);
  });
  it('returns the open burst total while it is still running', () => {
    expect(lastThinkingBurstTokens([assistantText('x'), thinkingTokens(900)])).toBe(900);
  });
  it('returns null when the session has never thought', () => {
    expect(lastThinkingBurstTokens([assistantText('x')])).toBeNull();
  });
  it('is unaffected by a burst older than the newest one', () => {
    const messages = [thinkingTokens(9000), assistantText('a'), thinkingTokens(100), assistantText('b')];
    expect(lastThinkingBurstTokens(messages)).toBe(100);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/thinkingStatus.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement it**

```ts
/**
 * The newest thinking burst's total, whether or not that burst is still open.
 *
 * `deriveThinkingStatus` deliberately reports only a LIVE burst — it stops at
 * the first trailing non-`thinking_tokens` message — so it goes null the
 * instant the burst ends. The status bar needs the number to survive the turn,
 * so this walks back to the newest `system:thinking_tokens` wherever it sits.
 * Within a burst the newest ping carries the running total, so the first hit
 * scanning backwards IS the burst total.
 */
export function lastThinkingBurstTokens(messages: JsonlNode[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.kind !== 'system' || message.subtype !== 'thinking_tokens') continue;
    const estimate = (message.raw as { estimated_tokens?: number }).estimated_tokens;
    if (typeof estimate === 'number') return estimate;
  }
  return null;
}
```

- [ ] **Step 4: Extend `activitySignal`**

`SignalInput` gains `turnStartedAt: number | null` and `lastTurnMs: number | null`.
`activitySignal`'s `meta` gains all three new fields:

```ts
      turnStartedAt: input.turnInFlight ? input.turnStartedAt : null,
      lastTurnMs: input.lastTurnMs,
      lastThinkingTokens: lastThinkingBurstTokens(messages),
```

- [ ] **Step 5: Feed them from `AgentSession`**

Hold a ref that stamps `Date.now()` when `isLoading` goes false→true, and a
state that stores `duration_ms` from the `cli-stream-result` node the reducer
already sees. Pass both into the `SignalInput` built at ~line 2183.

- [ ] **Step 6: Run**

Run: `npx vitest run src/lib/__tests__/thinkingStatus.test.ts src/lib/__tests__/signals.test.ts && npm run check`
Expected: PASS.

---

### Task 8: The status bar

**Files:**
- Create: `src/components/AgentCountGlyph.tsx` (moved out of `TabManager.tsx:126-141`)
- Create: `src/components/SessionStatusBar.tsx`
- Modify: `src/components/TabManager.tsx` (import the glyph instead of defining it)
- Modify: `src/components/signals/ActivityPill.tsx` (drop `active` / `thinking`)
- Modify: `src/components/SessionCard.tsx` (two-row layout)
- Modify: `src/components/AgentSession.tsx` (pass `activeSubagentCount` to `SessionCard`)
- Test: `src/components/__tests__/SessionStatusBar.test.tsx`, existing `TabManager` tests

**Interfaces:**
- Consumes: the activity signal meta from Task 7; `countActiveSubagents` from Task 4.
- Produces:
  ```ts
  export interface SessionStatusBarProps {
    activitySignal?: SessionSignal;
    activeSubagents: number;
    className?: string;
  }
  ```
  and `SessionCardProps` gains `activeSubagents?: number`.

- [ ] **Step 1: Move `AgentCountGlyph`**

Cut it from `TabManager.tsx` into `src/components/AgentCountGlyph.tsx` verbatim,
re-export nothing from `TabManager` (fix its tests' import path), and leave this
comment on the new module:

```tsx
/**
 * Lives in its own module because two surfaces render it — the tab strip and
 * the session widget's status bar. When it was a local const in TabManager the
 * second copy would have been hand-typed, and the colour, the pulse and the
 * hide-the-numeral-at-one rule would have drifted apart within a release.
 */
```

- [ ] **Step 2: Write the failing status-bar tests**

```tsx
const meta = (m: Record<string, unknown>) => ({ id: 'session.activity', meta: m } as SessionSignal);

it('shows a working glyph with elapsed time while a turn is in flight', () => {
  render(<SessionStatusBar activeSubagents={0} activitySignal={meta({ status: 'active', turnStartedAt: Date.now() - 84_000 })} />);
  expect(screen.getByLabelText(/working/i)).toBeInTheDocument();
  expect(screen.getByText('1:24')).toBeInTheDocument();
});

it('freezes on the previous round when idle', () => {
  render(<SessionStatusBar activeSubagents={0} activitySignal={meta({ status: 'idle', lastTurnMs: 84_000, lastThinkingTokens: 12_400 })} />);
  expect(screen.getByText('1:24')).toBeInTheDocument();
  expect(screen.getByText('12.4k')).toBeInTheDocument();
});

it('does not pulse when idle', () => {
  render(<SessionStatusBar activeSubagents={0} activitySignal={meta({ status: 'idle', lastTurnMs: 1000 })} />);
  expect(screen.getByLabelText(/working/i).className).not.toContain('animate-pulse');
});

it('pulses the thinking glyph while a burst is open', () => {
  render(<SessionStatusBar activeSubagents={0} activitySignal={meta({ status: 'thinking', thinkingTokens: 900, turnStartedAt: Date.now() })} />);
  expect(screen.getByLabelText(/thinking/i).className).toContain('animate-pulse');
});

it('shows the subagent glyph only when agents are running', () => {
  const { rerender } = render(<SessionStatusBar activeSubagents={0} activitySignal={meta({ status: 'idle' })} />);
  expect(screen.queryByLabelText(/agent/i)).not.toBeInTheDocument();
  rerender(<SessionStatusBar activeSubagents={3} activitySignal={meta({ status: 'active', turnStartedAt: Date.now() })} />);
  expect(screen.getByLabelText(/3 background agents working/i)).toBeInTheDocument();
});

it('renders nothing at all for a session that has never run a turn', () => {
  const { container } = render(<SessionStatusBar activeSubagents={0} activitySignal={meta({ status: 'idle' })} />);
  expect(container).toBeEmptyDOMElement();
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/components/__tests__/SessionStatusBar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `SessionStatusBar`**

Three glyphs, each a `<span aria-label>` wrapping a lucide icon plus a
tabular-nums readout:

| | icon | class | readout | pulses while |
|---|---|---|---|---|
| working | `ServerCog` | `text-emerald-400` | `formatToolElapsed` of live or frozen ms | `status === 'active' \|\| status === 'thinking'` |
| thinking | `Brain` | `text-violet-400` | `formatTokens` of live or frozen tokens | `status === 'thinking'` |
| agents | `AgentCountGlyph` | (owns its own sky-400) | count | always, inside the glyph |

Reuse `formatToolElapsed` from Task 3 and `formatTokens` from
`@/lib/contextPressure` rather than writing new formatters. Subscribe to
`useSecondTick` only while `turnStartedAt != null && status !== 'idle'`. Each
glyph renders only when it has a number to show — working needs
`turnStartedAt` or `lastTurnMs`, thinking needs `thinkingTokens` or
`lastThinkingTokens`, agents needs a non-zero count — so a fresh session shows
an empty bar rather than three zeroes.

- [ ] **Step 5: Trim `ActivityPill`**

Delete the `active` and `thinking` branches; keep `usage-limit` and its
countdown, keep the early return for `idle` / `stopped`. Update the module
comment: it now explains why the *limit* case stayed a labelled pill while the
other two became glyphs — a limit is an alarm, not a metric.

- [ ] **Step 6: Restructure `SessionCard`**

Outer wrapper becomes `flex flex-col gap-1`; the existing
`flex items-start gap-3` becomes an inner div. Below it:

```tsx
      <div className="flex items-center justify-between gap-3 px-0.5">
        <SessionStatusBar activitySignal={activitySignal} activeSubagents={activeSubagents} />
        <CacheTimerRow anchorMs={cacheAnchorMs} ttlMs={cacheTtlMs} busy={cacheBusy} />
      </div>
```

`CacheTimerRow` moves out of the gauge column into this row — delete the
"directly under the gauge bar" comment there and replace it with one saying the
row is now a real status bar rather than a column coincidence. Remove
`<ActivityPill>` from column one and render it in the status row instead, so
`usage-limit` still surfaces.

Add `activeSubagents?: number` to `SessionCardProps`, defaulting to `0`, and
pass `activeSubagents={activeSubagentCount}` from `AgentSession.tsx`.

- [ ] **Step 7: Run everything**

Run: `npm run check && npm run build && npm run test:coverage 2>&1 | tee /tmp/omnifex-verify.log`
Expected: typecheck clean, build clean, suite green. Capture the log — do not
re-run to find a failure name (repo rule: re-running resamples a flake).

- [ ] **Step 8: Rebuild the native module**

Run: `npm run rebuild:electron`
Expected: success. Required after any vitest run, before the app is restarted.

---

## Self-review

**Spec coverage:** §1 wire → Tasks 1–2. §2 chip → Task 3. §3 popover → Tasks 5–6.
§4 status bar → Tasks 7–8. §5 ambient → Task 4. Spec's "out of scope" list is
correctly absent from the plan.

**Type consistency:** `anchorToolUseId` is the function (Task 1) and the node
field (Task 1) — same name, different kinds, intentional and adjacent.
`ToolProgressEntry` shape is fixed in Task 1 and consumed unchanged in Tasks 2–3.
`formatToolElapsed` is defined in Task 3 and reused in Task 8, not redefined.
`countActiveSubagents` is defined in Task 4 and consumed in Task 8.
`density` (Task 5) is consumed in Task 6. `SignalInput.turnStartedAt` /
`lastTurnMs` (Task 7) are consumed in Task 8.

**Ordering:** Tasks 1→2→3 are strictly sequential. Task 4 is independent. Task 5
must precede 6. Task 7 must precede 8.
