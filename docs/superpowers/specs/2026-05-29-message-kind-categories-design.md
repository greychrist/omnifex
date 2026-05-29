# Message-Kind Categories — Design

**Date:** 2026-05-29
**Status:** Approved (conceptual model) — pending spec review
**Branch context:** follows the live-status-phase-label / collapsible-card / stop_reason work on `feat/status-phase-label`.

## Problem

The message-rendering catalog (`DEFAULT_KINDS` in `src/lib/messageRenderingConfig.ts`) is a **flat list of 64 fully-specified kinds**. An audit of 394 real transcripts (116,825 lines) showed it is simultaneously:

- **Incomplete** — real CLI types fall through to `unknown`: `pr-link` (775 occurrences), `mode` (128), `system:scheduled_task_fire`, and attachment subtypes `workflow_keyword_request` / `auto_mode_exit` / `plan_mode`.
- **Carrying unverifiable entries** — `attachment.file`, `attachment.compact_file_reference`, `attachment.invoked_skills` had **zero** occurrences and are undocumented internal types.
- **Hard to navigate** — 64 flat rows mixing block-level content, persisted bookkeeping, live-only envelopes, and permission UI, with no signal about which kinds a user will ever see.

The taxonomy is an **open, evolving, largely-undocumented set** (Context7 confirms the docs define only the stream-json message layer, not the on-disk transcript records or attachment subtypes). So enumerating every subtype is a losing game.

**The real goal** (per the user): the chat should mimic the Claude Code TUI's content density but with **clear visual separation between messages** — the TUI's weakness is that it's hard to tell where one message ends and the next begins. The chosen rendering is **card-per-message**, with per-type/subtype styling and the ability to collapse a kind behind a disclosure. What's missing is a **succinct, maintainable way to categorize kinds** so styling can be applied broadly with special-casing only where needed.

## Goals

- Replace the flat 64-entry catalog with a **two-tier model**: a few top-level **categories** (default styling) + a small set of per-kind **overrides** (special handling).
- Any kind — including never-before-seen ones — always resolves to a defined style (no more `unknown` for real types).
- Settings page becomes ~5 category editors + a short, manageable override list, with the ability to **add an override for any kind on demand**.
- Preserve the card-per-message rendering, per-kind collapse, and interactive widgets (AskUserQuestion, permission, thinking, compact-boundary).

## Non-goals

- Changing the rendering strategy (card-per-message stays).
- Changing the classifier's detection logic (it still emits dotted kind ids).
- Pruning by deletion/migration — zero-hit kinds simply stop being enumerated (they inherit a category), so there is nothing to orphan.

## Model: categories + overrides

```
resolveKind(kindId):
    origin   = originOf(kindId)              // user | agent | system | attachment | bookkeeping
    base     = config.categories[origin]     // full default style
    patch    = config.overrides[kindId]      // partial, may be absent
    return   { ...base, ...patch }           // shallow merge; patch wins per-field
```

- **Categories** hold a *complete* style: `presentation` (card | side-line | collapsible), `accentColor`, `icon`, `headerLabel`, `borderStyle`, `hiddenInCompact`, `alignment`, plus collapse/visibility defaults.
- **Overrides** hold only the fields that differ from the category, plus an optional `widget` for interactive kinds.
- A kind with no override renders purely as its category. The merge is shallow and per-field — exactly the CSS-cascade mental model.

`originOf(kindId)` is derived from the kind id's first segment and the classifier's existing `origin` knowledge (the `origin` field already exists on every catalog entry today: `user | assistant | system | cli | bookkeeping | fallback`). `assistant → Agent`; `cli → System`; `fallback →` the last-resort Unknown handling.

## The five categories + defaults

| Category | Resolved from (origin → category, with these kind ids) | Default style |
|---|---|---|
| **User** | origin `user` (prompts, tool-results, commands, system-context) | right-aligned card · header "You" · blue accent |
| **Agent** | origin `assistant` (text, thinking, tool-use, end-turn) | left card · header "Claude" · neutral accent |
| **System** | origin `system` + `cli` (notifications, hooks, errors, cli-stream-init/result) | left card · muted · info icon |
| **Attachment** | origin `attachment` (todo_reminder, diagnostics, skill_listing, …) | collapsible · muted (injected context blobs, low-prominence) |
| **Bookkeeping** | kind ids `last-prompt`, `queue-operation`, `pr-link`, `mode`, `ai-title`, `file-history-snapshot`, `permission-mode` (origin `bookkeeping`) | hidden by default (internal records) |

`originOf(kindId)` maps each classifier output to one of the five categories; the dotted-id prefix usually names it (`user.*`, `assistant.*`, `system.*`, `attachment.*`), and the standalone bookkeeping kind ids above map explicitly.

There is also an implicit **Unknown** fallback (dashed side-line + raw-payload `<details>`) for kinds whose origin can't be determined — the true last resort, rarely hit.

## Override set (the only kinds that need special handling)

Roughly 10–14 overrides replace the 64 flat rows. Initial set:

- **Agent:** `assistant.text.endTurn` → green completion card · `assistant.thinking` → collapsed (ThinkingWidget) · `assistant.tool-use` → tool icon + info accent
- **User:** `user.systemContext` → collapsible (skill / CLAUDE.md card; the work already landed) · `user.tool-result` → hidden (rendered by tool widgets) · `user.command` / `user.commandOutput` → side-line
- **System:** `system.notification.error` / `system.api_error` → red · `system.notification.warn` → amber · `system.notification.stop` → red · `system.compact_boundary` → CompactBoundaryWidget · `system.hook_started` / `hook_progress` / `hook_response` → hidden · `summary.compaction` → SummaryWidget
- **Bookkeeping:** `pr-link` → small visible PR badge (the one bookkeeping record worth surfacing)
- **Permission / interactive (preserved verbatim):** `permission.request` → permission card · `permission.askUserQuestion` → **AskUserQuestion widget** (live prompt) · the answered-summary variant (`AnsweredAskUserQuestionCard`) → answered widget. The category model governs only their chrome; their interactive question/answer rendering is untouched.

Everything else — all other `system` subtypes, all `attachment` subtypes (todo_reminder, diagnostics, … and any future/unknown ones), the silent bookkeeping records — rides its category default with **no entry at all**.

## Adding overrides on demand

The settings page gains an **"Add override"** affordance:
1. Choose a kind from a grouped picker (known classifier outputs + observed kind ids from the session, grouped by category), or enter an unseen kind id.
2. A new override is created pre-filled with the chosen kind's **category defaults**.
3. The user edits only what they want to diverge.
An override that ends up identical to its category default is dropped on save (keeps the list clean).

## Config schema (v2 → v3) + migration

New shape:

```ts
interface MessageRenderingConfigV3 {
  version: 3;
  categories: Record<Category, CategoryStyle>;   // 5 entries, each a full style
  overrides: Record<string, Partial<KindStyle>>; // sparse, keyed by kind id
  // unchanged: hardFilters, palette, typography, terminal, debug
}
```

`mergeConfig` migrates v2 → v3:
- Build the v3 `categories` + curated `overrides` from `createDefaultConfig()`.
- For each kind in a persisted v2 `kinds` map: compute its resolved v3 style; if the persisted entry **differs** from that resolved style, store the diff as an override (preserving the user's customization); if identical, drop it.
- Bump `version` to 3; record the migration in `app_logs` (same pattern as the existing v1→v2 reset).
- Legacy ids retained as-is where they still classify (`user.sdkSystemBracket`, `user.skillInjection`) — they become overrides or ride a category; no id is renamed (avoids orphaning, per the `greychrist.db` rule).

## Classifier + resolution changes

- **`classifyStandaloneKind` / `classifyBlockKind` unchanged** — still emit dotted kind ids. The attachment/system branches may be *simplified* (they no longer need to enumerate every subtype, since unknown subtypes now resolve via category), but that is optional cleanup, not required.
- **New `resolveKind(config, kindId)`** in `src/lib/` returns the merged style. All current `config.kinds[id]` consumers route through it: `accentStyleFor`, `swatchFor`, `iconNameFor`, `headerLabelFor` (`src/lib/accentStyle.ts`, `kindPresentation.ts`), and `MessageFrame` / `MessageFrameCard` / `MessageFrameSideLine` / `MessageFrameCollapsible`.
- **Coverage invariant changes:** the test "every `classifyStandaloneKind` output has a `DEFAULT_KINDS` entry" becomes "every output resolves to a category" — strictly easier to satisfy and robust to new CLI types.

## Settings UX

- `MessageKindTree` → a **category list** (5 editors) + an **overrides** section (the sparse list) + **"Add override."**
- `KindEditor` is reused for both a category style and an override (an override editor shows "inheriting from {Category}" placeholders for un-set fields).
- Presentation dropdown already supports `card | side-line | collapsible` (added in the prior work).

## Testing (TDD)

- `resolveKind`: category-only resolution; override merge (per-field, patch wins); unknown-origin → Unknown fallback.
- Migration: v2 flat config with a customized kind → v3 with that kind as an override; an un-customized kind → no override; version bump.
- Classifier coverage: every emitted kind id resolves to a category.
- AskUserQuestion / permission / thinking / compact-boundary widgets still render through the resolved chrome (component tests).
- Settings: "Add override" creates a category-prefilled override; an override equal to its category is dropped on save.

## Risks / open questions

- **Origin mapping for odd ids** (`cli-stream-init/result`, `summary.compaction`, `permission.*`): pinned above (System / override / preserved), but worth confirming during implementation that every current classifier output maps cleanly.
- **Migration fidelity:** users with heavy per-kind customization must not lose it — the diff-to-override step is the critical path and gets the most test coverage.
- **Bookkeeping default = hidden:** `pr-link` is surfaced via override; if other bookkeeping records turn out worth showing, they become overrides too (no structural change).
