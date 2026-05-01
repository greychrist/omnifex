# TodoBar — persistent live TODO progress strip

Status: design
Owner: Greg
Surface: `src/components/ClaudeCodeSession.tsx` and a new `src/components/TodoBar.tsx`

## Problem

After the compact-mode redesign (commit `c55fdc1`), the live TodoWrite list is no longer visible inline in compact view. The carve-out in `src/lib/compactGrouping.ts` promotes the parent message but the per-block hider in `StreamMessage.tsx` still buries the `TodoWidget` inside a `HiddenBlocksExpander`. Users lose at-a-glance visibility into "what is the agent tracking right now."

## Solution summary

Add a docked strip — `<TodoBar>` — anchored above `<SubagentBar>` at the bottom of the session view. It always reflects the **latest** TodoWrite tool_use of the current live session: collapsed by default, auto-expanding for 5 s whenever the list updates, click-to-toggle with pin-from-collapsed semantics. Active state is announced with a spinning icon plus an `animate-pulse` header; finished state goes solid. Hidden on reloaded / historical sessions.

This complements the existing inline `TodoWidget` rendering — the bar is a glanceable always-on-top surface, not a replacement.

## Component & data flow

- **New file** `src/lib/latestTodos.ts` — pure helper.
  - Defines a local `TodoItem` type (no shared type exists today; the existing `TodoWidget` uses `any[]`):
    ```ts
    export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
    export interface TodoItem {
      content: string;
      status: TodoStatus;
      activeForm?: string;
    }
    ```
  - Export `getLatestTodos(messages: ClaudeStreamMessage[]): TodoItem[] | null`. Walks the array in reverse for the most recent assistant `tool_use` block whose `name.toLowerCase() === 'todowrite'` and returns `input.todos` cast to `TodoItem[]` (or `null` if none / empty).
  - Export `summarizeTodos(todos: TodoItem[]): { done: number; total: number; running: boolean }`.
    - `done = todos.filter(t => t.status === 'completed' || t.status === 'cancelled').length`
    - `total = todos.length`
    - `running = todos.some(t => t.status === 'pending' || t.status === 'in_progress')`
- **New file** `src/components/TodoBar.tsx` — presentational + local state.
  - Props: `{ messages: ClaudeStreamMessage[]; isLive: boolean; className?: string }`.
  - Computes `todos = getLatestTodos(messages)` memoized on `messages`.
  - Returns `null` when `todos === null` or `isLive === false`.
  - Owns state for collapsed/expanded/pin and the 5 s auto-collapse timer.
- **Wiring** in `src/components/ClaudeCodeSession.tsx` immediately before `<SubagentBar />` (currently around line 1704):
  ```tsx
  <TodoBar messages={messages} isLive={isSessionActive || isSessionStarting} />
  <SubagentBar … />
  ```
  `isSessionActive || isSessionStarting` is already in scope and is the existing "session process is alive" signal — see lines 375–376 and the `sessionStatus` derivation around line 1459. Reloaded sessions where the user has not resumed streaming have both flags `false`, which gives us the desired hide behavior.

No new IPC, no new Zustand store, no schema migration. The bar is a pure derivation of state already in scope.

## Visual / styling

Mirrors the SubagentBar visual family (`emerald-400` accent so it slots into the existing palette without introducing a new color).

**Header row** — always visible:
- Container: `shrink-0 border-t border-border/40 px-3 py-1 text-[11px] bg-muted/20 flex items-center gap-2`.
- While running, the header carries `animate-pulse`. Finished state drops it.
- Left cluster (one button, toggles collapse on click):
  - Chevron — `ChevronUp` when collapsed, `ChevronDown` when expanded.
  - Status icon — `Loader2 animate-spin text-emerald-400 h-3.5 w-3.5` while running, `ListChecks text-emerald-400 h-3.5 w-3.5` (no spin) when finished.
  - Label — bold `ToDo`, separator dot, then counter.
  - Counter — `4 of 13` while running; `13 of 13 ✓` when finished. `tabular-nums` on the count.

**Expanded body** — compact rows, no card chrome:
- Wrapper: `overflow-y-auto` capped at `maxHeight: '40vh'`.
- Each row: `border-l-2 border-emerald-400/40 bg-emerald-400/10 px-3 py-1.5 text-xs leading-snug flex items-center gap-2`.
- Status glyph (h-3.5 w-3.5):
  - `pending` — `Circle` muted.
  - `in_progress` — `Loader2 animate-spin` emerald.
  - `completed` — `CheckCircle2` emerald.
  - `cancelled` — `XCircle` muted.
- Content text: truncated single line (`truncate flex-1`), strikethrough when status is `completed` or `cancelled`.

## State machine

Owned by `TodoBar` via `useState`. States: `collapsed_idle`, `expanded_auto`, `expanded_pinned`.

```
collapsed_idle  ─ todos changed   ─▶ expanded_auto (start 5s timer)
expanded_auto   ─ timer expires    ─▶ collapsed_idle
expanded_auto   ─ user clicks      ─▶ collapsed_idle (cancel timer)
collapsed_idle  ─ user clicks      ─▶ expanded_pinned
expanded_pinned ─ user clicks      ─▶ collapsed_idle
expanded_pinned ─ todos changed    ─▶ expanded_pinned (no timer reset)
```

- "Todos changed" = the SHA-stable `JSON.stringify(getLatestTodos(messages))` differs from the previously remembered value (cheap; lists are small). Equivalently, identity-compare the underlying tool_use `id` and content.
- 5 s timer resets on every change while in `expanded_auto`, so rapid back-to-back updates extend the visible window.
- Pin state is in-memory; resets on remount. Reloaded sessions do not render the bar at all, so persistence is moot.
- Completion does not auto-expand. The bar stays in whatever state the user left it.

## Edge cases

- **No TodoWrite yet**: bar is absent. First TodoWrite arrives → enters `expanded_auto`.
- **Empty todos array**: treat as `null` and hide.
- **Reloaded historical session**: `isLive=false` → render nothing.
- **Session running between turns with all items completed**: pulse and spinner stop (driven by `summarizeTodos.running`, not by `isLive`). The bar stays visible in solid form until `isLive` flips false at session end, at which point it disappears.
- **TodoWrite emits an identical list**: content hash equal → no state change, no timer reset.
- **Very long lists**: capped scroll body at 40vh. Truncated single-line rows.

## Testing (TDD)

New tests, written before implementation:

- `src/lib/__tests__/latestTodos.test.ts`
  - `getLatestTodos` finds the latest TodoWrite, ignores earlier ones.
  - Returns `null` for empty messages, for messages with no TodoWrite, and for a TodoWrite whose `input.todos` is missing or empty.
  - Case-insensitive on the tool name.
  - `summarizeTodos`: counts cancelled as done, derives `running` correctly across mixed-status lists, all-completed list reports `running=false`, all-pending list reports `running=true`.
- `src/components/__tests__/TodoBar.test.tsx` (Vitest + React Testing Library)
  - Returns `null` when there are no todos or when `isLive=false`.
  - Renders header counter `done of total` with the expected math (including a list with cancellations).
  - Header carries `animate-pulse` only while running.
  - Status icon is `Loader2`+`animate-spin` while running, `ListChecks` (no spin) when finished.
  - Auto-expands for 5 s on first appearance, collapses on timer (use `vi.useFakeTimers()`).
  - Clicking while `expanded_auto` collapses immediately and cancels the timer.
  - Clicking from `collapsed_idle` enters `expanded_pinned`; subsequent updates do not reset the (no-op) timer; clicking again returns to `collapsed_idle`.
  - Identical successive todos do not retrigger auto-expand.

Coverage target: 80% lines on `latestTodos.ts` and `TodoBar.tsx` (matches repo policy).

## Verification gate

Per `CLAUDE.md`:

- `npm run check`
- `npm test`
- `npm run test:coverage` (for non-trivial change)
- Manual smoke: open a live session, trigger a TodoWrite, confirm the bar appears with auto-expand, pulse/spinner, click-toggle, and final solid state. Open a reloaded session and confirm the bar is absent.

## Out of scope

- Animation polish beyond `animate-pulse` + `animate-spin` (no Framer Motion enter/exit transitions in v1).
- Reordering, filtering, or editing todos from the bar (read-only).
- Persisting collapsed/pinned preferences across sessions (lives in memory only).
- Showing the bar on reloaded sessions (explicitly excluded — see Q3 in brainstorming).
- Reverting or modifying the `compactGrouping.ts` carve-out for the inline TodoWidget. The bar is additive; the inline widget keeps doing whatever it does today.
