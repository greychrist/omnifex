# Collapsible AskUserQuestion Card

**Date:** 2026-05-10
**Status:** Approved, ready to implement
**Owner:** Greg

## Problem

When the agent invokes the SDK's `AskUserQuestion` tool with multiple questions
(up to 4, each with up to 4 options plus optional preview blocks), the inline
`AskUserQuestionCard` can occupy ~60vh + header + footer of the chat. That
pushes earlier chat messages out of view, so the user can't re-read context
they need to answer the question.

The card sits inline (not modal) precisely so surrounding chat stays visible —
but with a large enough question set, that goal breaks down.

## Goal

Let the user collapse the question set inline, freeing the vertical space the
card was occupying so chat content above is visible again, then re-expand to
answer and submit.

## Non-Goals

- Drag-to-resize the scroll region.
- Auto-collapse on scroll.
- Persistence of collapsed state across tab switches or new requests.
- A floating chip / overlay rendering of the collapsed state.
- A keyboard shortcut. (Trivial follow-up if needed.)

## Design

### Trigger

A chevron `<button>` is added to the existing card header row (the row that
contains the `MessageCircleQuestion` icon and the "The agent has a question
for you" / subtitle pair). It sits at the right edge of that row.

- Expanded: shows `ChevronUp` from `lucide-react`, with `aria-label="Collapse question"`.
- Collapsed: shows `ChevronDown`, with `aria-label="Expand question"`.

The button uses the same icon-button styling as similar affordances elsewhere
in the renderer (small ghost button, focus-visible ring, no permanent border).

### Collapsed state

When `collapsed === true`:

- The scroll region (`<div className="max-h-[60vh] overflow-y-auto …">`) and
  its mapped questions are not rendered.
- The footer row (Cancel + Send buttons + the `border-t` separator) is not
  rendered.
- The header row remains, including title, subtitle, and the chevron toggle.

This collapses the card down to a single header row's height, restoring the
vertical space below.

### Default and persistence

- Local React state via `useState(false)` — defaults to expanded so the user
  always sees the question the first time it appears.
- State lives on the component instance. A fresh `AskUserQuestion` request
  creates a new component (different `request.id`-keyed render upstream) and
  starts expanded.

### Why submit is gated on expansion

Hiding the questions while keeping a "Submit" button visible would let the
user fire off answers they can no longer see. A user who collapsed the card
to consult chat scrollback can re-expand with one click before submitting,
which is the same gesture they'd need anyway to verify their selections.

### Empty-questions defensive branch

The existing branch at lines 161–178 of `AskUserQuestionCard.tsx` (renders a
"no parseable questions" shell with a Dismiss button) is unaffected. There's
nothing meaningful to collapse there.

## Files Touched

- `src/components/AskUserQuestionCard.tsx` — add `useState`, chevron button,
  conditional rendering of scroll region + footer.
- `src/components/__tests__/AskUserQuestionCard.test.tsx` — TDD tests for
  default expanded, collapse hides questions + Send, expand restores.

No IPC, preload, services, or store changes. No new dependencies.

## Verification

- `npm run check`
- `npm test` (vitest one-shot, scoped run on the test file is sufficient for
  iteration; full suite for the verification gate).

## Out of Scope

Same-card surface improvements like sticky-header-on-scroll, a "collapse all
on submit" animation, or a global "collapse all permission cards" preference
are not part of this change.
