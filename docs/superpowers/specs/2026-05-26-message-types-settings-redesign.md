# Message-types settings redesign

**Status:** Design accepted; awaiting implementation plan.
**Owner:** Greg.
**Date:** 2026-05-26.

## Why

Two related problems with the current `MessageRenderingConfig` system:

1. **The taxonomy doesn't match the actual stream.** Today's ~30 kind rows in Settings → Chats were assembled organically. They don't cleanly map to the JSONL record types and subtypes the renderer actually receives. Result: at least one harness-injected message type (skill bodies, marked `isMeta: true` with a `sourceToolUseID`) is misclassified as a user prompt, which makes the synthesizer emit a phantom `result.error_during_execution` card. That's the bug Greg saw after running `/omnifex-release`. The same misclassification affects image attachment markers (`isMeta: true`, no `sourceToolUseID`) and any future harness-injected user records.
2. **The chrome is one-size-fits-all.** Every kind today renders as a bordered card. Low-noise events (turn boundaries, hook summaries, the SDK init line, skill-loaded notices) get the same visual weight as user prompts and assistant answers. Compact mode hides them entirely or shows them as full cards; there's no middle ground.

This redesign rebuilds the kind catalog around the JSONL types we actually persist, adds a second presentation variant ("side-line": a thin accent bar on the left with an inline icon and one line of text), introduces an explicit `unknown` bucket so future taxonomic gaps are obvious instead of silently misrendered, and drops a layer of redundant global filters now that every kind has its own visibility toggle.

## Out of scope

- Live-overlay events (partial streaming, subagent lifecycle, hook lifecycle, rate-limit notices). These aren't persisted in the JSONL and stay in their existing "Live overlay filters" group.
- Palette, typography, terminal-font settings. Those tabs are untouched.
- The classifier-level fix for `isMeta` lives in this work — not shipped separately first.

## Schema

`MessageRenderingConfig.version` bumps from 1 (implicit / missing today) to 2.

`MessageKindConfig` gains three fields:

```ts
interface MessageKindConfig {
  // existing fields, all preserved
  id: string;
  label: string;
  description: string;
  origin: KindOrigin;
  icon: LucideIconName;
  accentColor: PaletteName | HexColor;
  headerLabel: string;
  alignment: 'left' | 'right' | 'full';      // card-only; ignored when presentation = 'side-line'
  hiddenInCompact: boolean;
  compactBoundaryLocked?: boolean;
  widget?: WidgetOverride;
  iconSize?: number;
  iconBorder?: boolean;
  iconBgOpacity?: number;

  // new in v2
  presentation: 'card' | 'side-line';
  borderStyle: 'solid' | 'dashed';

  // unknown-only
  showRawPayload?: boolean;                  // only meaningful on the unknown row
}
```

`MessageRenderingConfig.hardFilters` loses five JSONL-node filter flags: `dropBookkeeping`, `dropHookSummaries`, `dropEmptyUser`, `dropClosureCarriers`, `dropSystemInformational`. Their work is redundant once every kind has its own `hiddenInCompact` toggle. The live-overlay flags (`hidePartialStreaming`, `hideSubagentLifecycle`, `hideHookLifecycle`, `hideRateLimitNotices`) stay.

## Kind catalog

Dotted IDs throughout so dotted-subtype lookups are unambiguous and present-tense.

### `assistant.*` — block-level kinds inside an assistant message

| ID | Default presentation | Default border | Default hidden-in-compact |
|---|---|---|---|
| `assistant.text` | card | solid | show |
| `assistant.thinking` | card | solid | hide |
| `assistant.tool-use` | card | solid | show |

### `user.*` — message-level kinds

| ID | Default presentation | Default border | Default hidden-in-compact |
|---|---|---|---|
| `user.prompt` | card | solid | show *(compact-boundary-locked)* |
| `user.tool-result` | side-line | solid | hide |
| `user.meta.skill` | side-line | solid | show |
| `user.meta.attachment` | side-line | solid | hide |
| `user.meta.other` | side-line | solid | show |

### `system.*` — split by `subtype` field

| ID | Default presentation | Default border | Default hidden-in-compact |
|---|---|---|---|
| `system.init` | side-line | solid | hide |
| `system.notification` | card | solid | show |
| `system.api_error` | card | solid | show |
| `system.stop_hook_summary` | side-line | solid | hide |
| `system.local_command` | side-line | solid | show |
| `system.turn_duration` | side-line | solid | hide |
| `system.away_summary` | card | solid | show |
| `system.compact_boundary` | card | solid | show |
| `system.informational` | side-line | solid | hide |

### `result.*` — split by `subtype` (synthesized or real)

| ID | Default presentation | Default border | Default hidden-in-compact |
|---|---|---|---|
| `result.success` | side-line | solid | hide |
| `result.error_during_execution` | card | solid | show *(compact-boundary-locked)* |
| `result.user_interrupt` | side-line | solid | show |
| `result.max_tokens` | card | solid | show |
| `result.refusal` | card | solid | show |
| `result.context_window_exceeded` | card | solid | show |

### Bookkeeping — surfaced per Greg's "full control" preference (option D)

| ID | Default presentation | Default border | Default hidden-in-compact |
|---|---|---|---|
| `attachment` | side-line | solid | hide |
| `queue-operation` | side-line | solid | hide |
| `permission-mode` | side-line | solid | hide |
| `last-prompt` | side-line | solid | hide |
| `ai-title` | side-line | solid | hide |
| `file-history-snapshot` | side-line | solid | hide |

### Fallback

| ID | Default presentation | Default border | Default hidden-in-compact | Extra field |
|---|---|---|---|---|
| `unknown` | side-line | **dashed** | show | `showRawPayload: true` |

The `unknown` row uses `HelpCircle` icon and a warning-orange accent distinct from the `result.error_*` red — visible without screaming "error".

## Pipeline

```
JSONL line  →  classifier  →  synthesizer  →  adapter  →  renderer
                (label it)    (group turns)   (UI shape)   (paint)
```

### Classifier (`src/lib/jsonlClassifier.ts`)

`classifyUser` reads `isMeta` and `sourceToolUseID` off the raw record. New `userKind` union:

| `userKind` | When |
|---|---|
| `'prompt'` | text content, `isMeta` absent or false |
| `'tool-result'` | all blocks are `tool_result` |
| `'meta-skill'` | `isMeta === true` AND `sourceToolUseID` is a non-empty string |
| `'meta-attachment'` | `isMeta === true`, no `sourceToolUseID`, content[0].text starts with `[Image: ` |
| `'meta-other'` | `isMeta === true`, no `sourceToolUseID`, not an attachment marker |

These map 1:1 to the `user.*` kind IDs above.

For `system` and `result` records, the classifier reads `subtype` and returns the dotted kind ID directly (e.g. `system.api_error`). If `subtype` is missing or doesn't match the catalog, the classifier returns `{ kind: 'unknown', raw }`. Same for the top-level fallback: if the record's `type` doesn't match any known branch, return `{ kind: 'unknown', raw }`. Today the classifier returns `null` in both cases and the line vanishes — that ends.

There is no `system.unknown` or `result.unknown` row. Diagnostic granularity comes from the `showRawPayload` toggle on the single `unknown` row — the raw JSONL line tells you whether it was an unrecognized `type` or an unrecognized `subtype`.

### Synthesizer (`src/lib/jsonlSynthesizer.ts`)

Unchanged structurally. The turn-boundary check at line 129 stays `if (node.kind === 'user' && node.userKind === 'prompt')`. Because only `prompt` triggers `flushPending()`, the four new `userKind` values flow through the "any other node" branch and never synthesize a phantom result. **This is the bug fix.**

### Adapter (`src/lib/jsonlAdapter.ts`)

Each `ClaudeStreamMessage` carries a `streamKind: string` field — the dotted kind ID set by the classifier. Downstream consumers (`messageFilters.ts`, `blockKind.ts`, `StreamMessage.tsx`, `compactGrouping.ts`) read this field instead of re-deriving the ID from `message.type`/`subtype`. One source of truth, set once at classification time.

### Block kinds (`src/lib/blockKind.ts`)

Per-block classification stays. Block IDs align with the new top-level IDs: `assistant.thinking`, `assistant.text`, `assistant.tool-use`. An assistant message's outer wrapper is transparent — each block renders its own kind's chrome directly. No outer card containing an inner card.

## Rendering

A new `<MessageFrame variant="card" | "side-line">` component in `src/components/StreamMessage/MessageFrame.tsx` becomes the single place that switches chrome. `MessageCard.tsx` is renamed to `MessageFrameCard.tsx`; a new `MessageFrameSideLine.tsx` is the side-line variant. `<StreamMessage>` chooses the variant by looking up the kind's `presentation` in the config.

**Card variant.** Rounded border (solid or dashed per `borderStyle`), header bar with icon + label + accent color, optional alignment (left/right/full), body containing prose/blocks/widgets.

**Side-line variant.** A 2-pixel left accent bar (solid or dashed per `borderStyle`), an inline icon, one line of text. No border, no header bar, full-width left-anchored. Alignment and headerLabel inputs in Settings hide themselves when presentation = side-line.

Shared knobs across both variants: icon, accent color (border tint + bar tint), `hiddenInCompact`, widget override.

Per-block rendering inside assistant messages goes through `<MessageFrame>` too, so a thinking block (`presentation: side-line` by configuration) followed by a text block (`presentation: card`) renders as a quiet side-line strip stacked above a card.

## Unknown bucket

The `unknown` row catches three cases:

1. JSONL line whose top-level `type` doesn't match any classifier branch.
2. Known `type` with a `subtype` not in the catalog (e.g. a new `system.foo` we haven't seen).
3. Defensive: classifier returned an ID not present in `config.kinds`.

**Two trigger paths.**

1. Classifier-level (described in the Pipeline section): top-level `type` not in any branch, OR `system` / `result` record with an unrecognized `subtype`. Classifier returns `kind: 'unknown'` directly.
2. Renderer-level defensive fallback: `streamKind` lookup misses in `config.kinds` (config drift / stale persisted config). Renderer falls back to `config.kinds.unknown` for chrome.

**Diagnostic chrome.** The unknown row has the usual style controls plus a `showRawPayload: boolean` toggle (defaults to `true`). When on, an unknown message renders the kind chrome (side-line by default) followed by a collapsible `<details>` element containing the original JSONL line pretty-printed. Click to expand, see the raw `type` / `subtype` / shape, decide what to add to the taxonomy.

Default icon: `HelpCircle`. Default accent: warning orange (distinct from `result.error_*` red). Default border: **dashed**.

## Settings UI (`src/components/settings-panels/AppearanceSettings.tsx`)

### "Message kinds" tab

- Hierarchical tree grouped by origin: Assistant / User / System / Result / Bookkeeping / Fallback. Six groups, ~30 rows.
- Per-row editor (expand-on-click) gains two new controls at the top:
  - **Presentation** dropdown: card / side-line.
  - **Border** dropdown: solid / dashed.
- **Alignment** and **Header label** controls hide themselves when `presentation = side-line`.
- The `unknown` row alone gets an extra **Show raw payload** toggle.

### "Global" tab

- The five JSONL-node filter toggles (`dropBookkeeping`, `dropHookSummaries`, `dropEmptyUser`, `dropClosureCarriers`, `dropSystemInformational`) are removed. Per-kind `hiddenInCompact` toggles cover the same behavior with finer grain.
- Live-overlay filters stay unchanged.
- "Default view mode" toggle stays.

### "Turn preview" tab

- The sample stream is rebuilt to include one of each new kind so styling choices are visible side-by-side in compact and verbose. Roughly 12–15 sample messages covering: user.prompt, assistant.thinking + .text + .tool-use, user.tool-result, user.meta.skill, system.notification, system.stop_hook_summary, result.success, result.error_during_execution, attachment, and an example unknown row.

### Untouched

Palette, Typography, Terminal tabs.

## First-load behavior (no migration)

On `MessageRenderingContext` mount, the persisted config is read. If `version` is missing or `< 2`:

1. Old config is discarded.
2. The default v2 catalog (the tables above) is written.
3. A single `app_logs` entry is recorded at level `info`, source `frontend`, category `settings:message-rendering`, message `"reset message rendering config v1 → v2 defaults"`.
4. Subsequent reads see `version: 2` and proceed normally.

No mapping table, no v1 backup, no version-handling framework. Single-user app, low blast radius, Greg will be reviewing every row of the new Settings panel as part of validating the redesign anyway. The framework gets added the day we ship v3.

## Testing

Per-area gates:

- **Classifier** (`src/lib/__tests__/jsonlClassifier.test.ts`): new cases for each of the five `userKind` values, including the smoking-gun fixture from the bug session (a skill-body record with `isMeta: true` and `sourceToolUseID`). Plus a top-level unknown-type fixture and a known-type-unknown-subtype fixture.
- **Synthesizer** (`src/lib/__tests__/jsonlSynthesizer.test.ts`): explicit regression — a `tool_use`-ended assistant followed by a `meta-skill` user must NOT produce a synthesized `error_during_execution` result. Adapted from the real JSONL we examined.
- **Adapter** (`src/lib/__tests__/jsonlAdapter.test.ts`): asserts `streamKind` carries forward for one fixture per kind ID.
- **blockKind** (`src/lib/__tests__/blockKind.test.ts`): assert block IDs equal top-level kind IDs.
- **Render variant** (`src/components/StreamMessage/__tests__/MessageFrame.test.tsx`): mount each variant with each border style; snapshot the DOM tree.
- **Settings panel** (`src/components/settings-panels/__tests__/AppearanceSettings.test.tsx`): presentation dropdown changes propagate to config; alignment/headerLabel hide when side-line is selected; unknown row's showRawPayload toggle appears only on that row.
- **First-load reset** (`src/contexts/__tests__/MessageRenderingContext.test.tsx`): version-1 persisted config triggers reset; the `app_logs` entry is written exactly once; subsequent reads are no-ops.

Backend-side: classifier + synthesizer changes don't touch `electron/`, so the existing renderer-only verification gate applies — `npm run check` + `npm run build` + `npm test` for the renderer test files.

## Risks

- **Renaming `MessageCard` → `MessageFrameCard`.** Touches every import. Mechanical refactor; risk is "forgot one import" caught by `npm run check`.
- **Side-line variant inside an assistant message body.** The visual rhythm of a side-line thinking block followed by a card text block needs to look intentional, not awkward. Worth a manual eyeball before merge in the OmniFex app.
- **Per-block chrome means an assistant message has no outer wrapper.** Today the outer card is also where the copy / regenerate buttons hang. Resolution: those buttons attach to the **last card-presentation block** of the assistant message. If every block is side-line, the buttons attach to the last block regardless. This keeps the controls anchored to a visually substantial element and avoids floating toolbars. Pin this commitment when implementing `MessageFrame`.
- **The classifier returning `kind: 'unknown'` for previously-`null` cases** could surface JSONL noise we never wanted visible (e.g. malformed lines). Mitigation: keep the classifier strict on shape validation; only return `unknown` for records that parse cleanly but have an unrecognized `type`/`subtype`. Truly malformed lines still drop.
