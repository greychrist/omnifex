# Compact Mode Redesign

**Status**: design
**Date**: 2026-04-30
**Owner**: Greg

## Problem

Compact mode today has three frustrations:

1. **Empty expanders.** Two independent filters run — `filterCompactHidden` drops standalone-classifiable messages *before* grouping, and the per-block renderer hides blocks *inside* surviving messages. A `CollapsibleGroup` summary often promises steps that, when expanded, render to nothing because every block inside was already filtered out.
2. **Over-locked toggles.** Eight kinds carry `compactBoundaryLocked: true` (user.prompt, user.image, assistant.text, result.success, result.error, result.awaiting_background, permission.request, summary.compaction). Most of those should be user-toggleable.
3. **Settings UI flattens hierarchy.** Block kinds (assistant.text, assistant.toolUse, tool.result.*) appear flat alongside whole-message kinds (user.prompt, result.success), so users don't see that block kinds are children of message kinds.

## Goal

> Compact mode = verbose mode minus hidden items. Anything hidden goes behind one expander placed at the position it would have rendered.

A simpler mental model with fewer hardcoded special cases.

## Design

### Visibility model

Two levels — message and content-block (the SDK's `assistant` / `user` messages have a `content[]` array of typed blocks: text, thinking, tool_use, tool_result, image; `system` / `result` / `permission_request` / `summary` are leaves).

Three render outcomes per message:

| Parent visibility | Block visibility | Render outcome |
| --- | --- | --- |
| visible | visible | block renders normally inside parent card |
| visible | hidden | block goes into a **mini expander** inside the parent card (same component as the outer group expander) |
| hidden (every block hidden, or message-level kind hidden) | — | message joins the next outer **HiddenEventsGroup**. When the user opens the group, every block inside renders flat — no nested expanders |

Opening any expander is "show me everything you hid here," so we never make the user click twice.

### Lock set

`compactBoundaryLocked: true` only for:

- `user.prompt`
- `result.success`
- `result.error`
- `result.awaiting_background`

All other kinds are user-toggleable. Tooltip copy in `KindEditor.tsx` becomes "Always visible — turn boundary."

### Kind tree (settings UI)

```
Assistant message
  ├─ assistant.text
  ├─ assistant.thinking
  └─ assistant.toolUse
User message
  ├─ user.prompt              [locked]
  ├─ user.subagentPrompt
  ├─ user.sdkSystemBracket
  ├─ user.image
  ├─ user.systemContext
  ├─ tool.result.generic
  └─ tool.result.systemReminder
System
  ├─ system.init
  ├─ system.notification.error
  ├─ system.notification.stop
  ├─ system.notification.warn
  └─ system.notification.info
Turn result
  ├─ result.success            [locked]
  ├─ result.error              [locked]
  └─ result.awaiting_background [locked]
Other
  ├─ permission.request
  └─ summary.compaction
```

Whole-message classifications (`user.prompt`, `user.subagentPrompt`, `user.sdkSystemBracket`) apply when a user message has a single matching block. Block-level classifications (`user.image`, `user.systemContext`, `tool.result.*`) apply per-block when a user message has mixed content.

### Carry-overs

- **Latest TodoWrite always visible.** Even if `assistant.toolUse` is hidden, the most recent TodoWrite tool_use is promoted to a top-level visible card. Existing rule, preserved.
- **Subagent timeline markers.** When `Task` is dispatched, render an inline marker `Subagent spawned: {description}` at that chronological position. When the subagent returns (task_notification or terminal tool_result), render `Subagent returned: {summary} · {duration}` at that position. Both are visible regardless of any kind toggle. Each is a small Collapsible card — click to expand and see the prompt sent / full result. The bottom `SubagentBar` stays for the running-now global view.

### Component primitives

Single shadcn `Collapsible` primitive (`src/components/ui/collapsible.tsx`, new dep on `@radix-ui/react-collapsible`) used everywhere. Two consumer components:

- `HiddenEventsGroup` — outer, wraps consecutive hidden messages in the timeline. Trigger label: `{n} Hidden Events: {prose summary}`. Right-aligned chevron. Body renders messages flat.
- `HiddenBlocksExpander` — inner, attached inside a visible message card to wrap that message's hidden blocks. Trigger label: `{n} hidden {tool_calls|thoughts|...}`. Smaller variant of the same primitive.

### Prose summary generator

`src/lib/hiddenEventsSummary.ts` walks a list of messages and emits one English sentence summarizing what's inside, e.g.:

> "Read 4 files, edited 2, ran 3 commands, processed 5 thinking blocks, dispatched 1 subagent."

Heuristics:

- Tool counts grouped by tool family: read/glob/grep, edit/write/multiedit, bash, search (websearch/webfetch), task (subagent), thinking, system events.
- Falls back to `{n} step{s}` if no families match (matches today's behavior).
- Truncated at ~140 chars; prefer fewer specific facts to a long parade.

## Files

### Add

- `src/components/ui/collapsible.tsx` — shadcn primitive
- `src/components/HiddenEventsGroup.tsx` — outer group
- `src/components/HiddenBlocksExpander.tsx` — inner per-message expander
- `src/components/SubagentTimelineMarker.tsx` — spawned/returned markers
- `src/lib/blockKind.ts` — `classifyBlockKind(block, parentMessage, allMessages): kindId | null`. Per-block analog of `classifyStandaloneKind`.
- `src/lib/hiddenEventsSummary.ts` — prose summary builder
- `src/lib/__tests__/blockKind.test.ts`
- `src/lib/__tests__/hiddenEventsSummary.test.ts`

### Rewrite

- `src/lib/compactGrouping.ts` — replace `isBoundaryMessage` with hidden-driven grouping. New rule: walk messages, group consecutive hidden ones, emit `single` for visible, `group` for runs of hidden.
- `src/lib/__tests__/compactGrouping.test.ts` — rewritten to assert new rule.

### Update

- `src/lib/messageRenderingConfig.ts` — shrink lock set; tests updated.
- `src/components/StreamMessage.tsx` — per-block compact filtering routes hidden blocks into a `HiddenBlocksExpander` when parent is visible; renders flat when parent is in an opened outer group (signaled by existing `inExpandedGroup` prop).
- `src/components/ClaudeCodeSession.tsx` — swap `CollapsibleGroup` for `HiddenEventsGroup`; drop `filterCompactHidden` precondition (grouping handles it).
- `src/components/settings-panels/appearance/KindEditor.tsx` — tooltip copy; uses nested tree.
- `src/components/settings-panels/appearance/MessageKindTree.tsx` — render kinds as nested tree (parent → children) instead of flat list.
- `src/components/settings-panels/appearance/TurnPreview.tsx` — preview mirrors the new model.
- `src/lib/__tests__/messageRenderingConfig.test.ts` — assert new lock set.

### Remove

- `src/components/CollapsibleGroup.tsx` — superseded by `HiddenEventsGroup`.

## Open questions

None at design time. Decisions captured:

1. **Subagent markers**: spawned + returned, inline at chronological positions.
2. **Mixed-content messages**: inner expander on the parent card (option A in earlier discussion).
3. **TodoWrite promotion**: kept as hardcoded exception.

## Build sequence

1. Add shadcn `Collapsible` primitive + `@radix-ui/react-collapsible` dep.
2. Update `DEFAULT_KINDS` lock flags + `messageRenderingConfig.test.ts`.
3. Add `blockKind.ts` classifier + tests.
4. Add `hiddenEventsSummary.ts` + tests.
5. Build `HiddenEventsGroup` + `HiddenBlocksExpander` components.
6. Rewrite `compactGrouping.ts` + tests.
7. Wire `StreamMessage.tsx` to new per-block routing.
8. Build `SubagentTimelineMarker` and place at Task dispatch / return positions.
9. Wire `ClaudeCodeSession.tsx` to new components, drop `filterCompactHidden` precondition.
10. Update `MessageKindTree.tsx` / `KindEditor.tsx` for nested tree + tooltip copy.
11. Update `TurnPreview.tsx`.
12. Delete `CollapsibleGroup.tsx`.
13. Verification: `npm run check`, `npm test`, `npm run build`.

## Verification

- Unit: new tests for `blockKind`, `hiddenEventsSummary`, and rewritten `compactGrouping` cover at least: visible-only, hidden-only, alternating, mixed-content message, latest-TodoWrite promotion, subagent dispatch + return, partially-hidden user message with tool_results, empty/edge inputs.
- Integration: open the live app on a long session and confirm — every expander has content, every hidden item lives behind exactly one expander, no double-nesting, subagent markers appear at the right positions.
- Settings UI: toggle each unlocked kind, confirm visibility flips in real time without restart.
