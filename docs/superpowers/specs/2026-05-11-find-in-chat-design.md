# Find in Chat — Design

**Status:** Approved, implementing
**Date:** 2026-05-11
**Scope:** OmniFex chat session pane

## Problem

OmniFex chats grow long. There is no way to locate text inside the current session beyond scrolling and eyeballing. Users expect a Cmd/Ctrl+F find experience as a baseline editor/browser affordance.

## Goals

- Add Cmd/Ctrl+F text search inside the active chat session.
- Scoped strictly to the chat transcript — sidebar / header / settings panes do not match.
- Match only what is currently visible to the user (collapsed tool blocks, unmounted content are skipped by construction).
- Plain case-insensitive substring match; no toggles (case sensitivity / whole word / regex are explicitly out of scope).
- Wrap-around next / prev with auto-scroll to the active hit.

## Non-Goals

- Searching across sessions or projects.
- Searching collapsed tool outputs / thinking blocks without first expanding them.
- Regex / case / whole-word toggles.
- Persisting the last query across sessions.
- Replace functionality.

## Approach

**Approach B from brainstorming: renderer-side DOM walker scoped to the chat pane.**

Two other approaches were considered and rejected:

- **Approach A: Electron `webContents.findInPage`.** Almost no code, but searches the entire window — matches in sidebar, headers, and modals leak in. Conflicts with the "in-transcript only" requirement.
- **Approach C: Parallel per-message text index.** Duplicates the DOM as the source of truth, has to be synced on every stream tick, and still needs DOM-range mapping for highlighting. Pure overhead.

Approach B honors the "visible text only" constraint by construction: the React tree only renders what is currently expanded; the walker only sees rendered DOM; collapsed `<details>` and unmounted children produce no matches without any extra logic.

## Architecture

### New files

#### `src/hooks/useFindInChat.ts` (~150 lines)

Signature:

```ts
export interface UseFindInChatArgs {
  containerRef: React.RefObject<HTMLElement | null>;
  query: string;
  isOpen: boolean;
  transcriptVersion: number;
}

export interface UseFindInChatResult {
  count: number;
  activeIndex: number; // 0-based; meaningless when count === 0
  next: () => void;
  prev: () => void;
}

export function useFindInChat(args: UseFindInChatArgs): UseFindInChatResult;
```

Responsibilities:

- Walk `containerRef.current` with `document.createTreeWalker(SHOW_TEXT)` whenever a re-run trigger fires (debounced ~120 ms).
- For each text node, do a case-insensitive `indexOf` scan for the query. Record `{ node, offset, length }` matches.
- Skip nodes inside `<script>`, `<style>`, `<noscript>`, `mark[data-find]` (existing find marks — defense in depth), or any ancestor with the `data-find-skip` attribute (the `FindBar` sets this on itself so its own input does not self-match).
- Skip nodes whose nearest element has `display: none` or `visibility: hidden`. Cache the per-element computed style during a single walk to avoid repeat lookups.
- Wrap each match in `<mark data-find>` using a `Range` (`splitText` at offset → wrap with a `<mark>` element). Store the resulting elements in document order in `matchesRef.current`.
- Before each re-walk: unwrap the previous `<mark>` elements (replace each with its text node, normalize parents to coalesce adjacent text nodes), then walk fresh.
- Apply `is-active` to `matchesRef.current[activeIndex]` and call `scrollIntoView({ block: 'center', behavior: 'auto' })`.
- `next()` / `prev()` advance `activeIndex` modulo `matches.length` (wrap-around in both directions), update the active class, and re-scroll.
- On `isOpen` flipping to `false` or on unmount: unwrap all marks and clear state.

Re-run triggers (all coalesced through a single debounced runner):

1. `query` changes
2. `isOpen` flips to `true`
3. `transcriptVersion` changes while `isOpen` is `true`

State preservation across re-walks:

- Keep `activeIndex` if it is still in range (`< newMatches.length`); otherwise reset to `0`.
- Do **not** auto-scroll on a content-driven re-walk; only on user-driven `next()` / `prev()` or on the very first walk after open. This prevents the active hit from yanking around while streaming.

#### `src/components/FindBar.tsx` (~100 lines)

Floating bar pinned to the top-right of the chat pane (absolutely positioned inside the existing `relative` messages wrapper). Sets `data-find-skip` on its root so the walker ignores its own DOM.

Props:

```ts
interface FindBarProps {
  query: string;
  onQueryChange: (value: string) => void;
  count: number;
  activeIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}
```

Layout:

- Compact horizontal pill: input on the left, then `N/M` count, then `‹` `›` `×` buttons.
- Mirrors the visual treatment of existing OmniFex toolbar widgets (border, rounded, `bg-background/80 backdrop-blur-sm`).
- Buttons are `Button variant="ghost" size="icon"` from `src/components/ui/button.tsx`.

Keyboard:

- Input has `autoFocus`.
- `Enter` → `onNext`. `Shift+Enter` → `onPrev`. `Escape` → `onClose`.
- Buttons are `disabled` when `count === 0`.
- Count text shows `${activeIndex + 1}/${count}` when `count > 0`, else `0/0`.

### Modified files

#### `src/components/ClaudeCodeSession.tsx`

Three small additions:

1. **State.** `const [findOpen, setFindOpen] = useState(false); const [findQuery, setFindQuery] = useState('');` Plus a `transcriptVersion` value derived from `messages.length` (or a counter incremented in the existing message reducer effect).
2. **Shortcut listener.** A `useEffect` that attaches a `keydown` listener on `window` while the session is mounted, checks for `(meta || ctrl) && key === 'f'`, calls `e.preventDefault()`, and sets `findOpen(true)`. Removed on unmount.
3. **Mount the bar.** Inside the `messagesList` wrapper (`flex-1 min-h-0 px-10 py-2 bg-muted/30 relative` at line 1241), conditionally render `<FindBar />` as the first child. The hook `useFindInChat({ containerRef: contentRef, query: findQuery, isOpen: findOpen, transcriptVersion })` is called unconditionally; the hook does nothing when `!isOpen`.

The hook's container target is `contentRef` (the inner wrapper at line 1272 holding only the message list), not `parentRef` (the scroll container) — that keeps the walker focused on just the messages, not on overlay controls inside `parentRef`.

#### `src/index.css` (or whichever global stylesheet the renderer loads)

Two rules:

```css
mark[data-find] {
  background-color: rgba(250, 204, 21, 0.35); /* yellow-400 / 35% */
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}

mark[data-find].is-active {
  background-color: rgba(250, 204, 21, 0.75);
  outline: 1px solid rgba(202, 138, 4, 0.9); /* yellow-600 */
}
```

Theme-neutral: yellow reads correctly on both light and dark themes. The active outline gives the eye an anchor while scrolling.

## Data Flow

```
User presses Cmd+F
  → ClaudeCodeSession setFindOpen(true)
  → <FindBar> mounts with autoFocus
  → user types
  → onQueryChange → setFindQuery(value)
  → useFindInChat's debounced runner fires
    → unwrap previous marks
    → TreeWalker over contentRef
    → wrap matches in <mark data-find>
    → set is-active on matches[activeIndex]
    → scrollIntoView on first walk only
  → returns { count, activeIndex } → FindBar shows N/M

User presses Enter
  → FindBar onNext
  → hook activeIndex = (activeIndex + 1) % count
  → is-active class moves + scrollIntoView

Streaming continues → messages array grows → transcriptVersion bumps
  → debounced runner re-walks
  → activeIndex preserved if still in range
  → no auto-scroll on this path

User presses Esc
  → FindBar onClose → setFindOpen(false)
  → hook unwraps all marks, resets state
```

## Error Handling & Edge Cases

| Case | Behavior |
|---|---|
| Empty query | No walk; no marks; count = 0; nav disabled. |
| Zero matches | Marks unwrapped; count = 0; nav disabled; bar stays open. |
| Matches disappear mid-stream | Count drops to 0; bar stays open; no error. |
| `contentRef` not yet mounted when shortcut fires | Hook is a no-op when `containerRef.current == null`. |
| Active mark's DOM node detached between re-walks | Re-walk produces fresh array; `activeIndex` clamped to new range. |
| User scrolled away from active hit while streaming | We don't re-scroll on content re-walks; user keeps their reading position. |
| Multiple find-bar instances (defense in depth) | Walker skips `mark[data-find]` ancestors, so a re-entry can't double-wrap. |

## Testing Strategy

Vitest with `// @vitest-environment jsdom` for renderer DOM coverage.

### Unit: `src/hooks/__tests__/useFindInChat.test.tsx`

Render a small fixture component that exposes the hook over a static container. Tests:

- Empty query → count 0, no marks.
- Single-word query → correct match count + each match wrapped in `<mark data-find>`.
- Case-insensitive: query `Hello` matches `hello` and `HELLO`.
- `next()` wraps last → first; `prev()` wraps first → last.
- `is-active` class lives on exactly one mark at a time.
- Re-render with new content → unwraps stale marks, walks fresh, count updated.
- Closing (isOpen → false) unwraps all marks.
- Skips elements inside `data-find-skip` ancestors.
- Skips elements with `display: none` ancestor.

### Unit: `src/components/__tests__/FindBar.test.tsx`

- Renders count text correctly for `count = 0`, `count = 5, activeIndex = 2`.
- `Enter` calls `onNext`; `Shift+Enter` calls `onPrev`; `Escape` calls `onClose`.
- Click handlers fire on the button row.
- Prev/Next disabled when `count === 0`.
- Input has the `autoFocus` and the bar root has `data-find-skip`.

### Smoke: `src/components/__tests__/ClaudeCodeSession.find.test.tsx`

Lighter test — render a stub `ClaudeCodeSession`-like wrapper if the real one is too heavy, otherwise mount with minimal fixture. Verify:

- Cmd+F (synthetic event) toggles the bar open.
- Esc closes the bar.

If the real component is too entangled for an isolated mount, the smoke layer is omitted; the hook tests + FindBar tests cover behavior.

## Verification Gate

Frontend-only change per repo rule:

- `npm run check`
- `npm run build`

Plus the new vitest files; we'll run `npm test` to confirm nothing else regressed.

## Out of Scope (Future Work)

- Multi-session / cross-project find.
- "Match inside collapsed content" with auto-expand on hit.
- Regex / case / whole word toggles.
- Persisting last query.
- Find-and-replace.
