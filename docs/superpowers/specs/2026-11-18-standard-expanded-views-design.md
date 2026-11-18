# Standard and Expanded: one chat format

2026-11-18. Supersedes the four-format arrangement (Compact / Verbose / All /
Modern) in `2026-10-28-modern-chat-format-design.md`.

## Intent

Greg wants three things, in his words: a simpler settings page, less code to
maintain, and a consistent look for every chat. Modern is the format he uses;
the three classic formats are a second renderer kept alive for settings and
fallbacks. Delete the classic renderer and keep one drawing.

## What gets built

### Two views

- **Standard** (default) — exactly today's Modern with `recordRules:
  "compact"`: kinds whose visibility is Always are drawn, the rest are left
  out.
- **Expanded** — the same Modern drawing with nothing left out, the way All
  worked: every record, including kinds set to Never and bookkeeping. Its
  purpose is to check that every record type is accounted for. Tool runs are
  still folded into the work timeline (Chain of Thought); Expanded only stops
  hiding records, it does not change how they are drawn.

**Expanded skips every display filter.** All was not literally "all": it
still ran `filterDisplayableMessages` (`src/lib/messageFilters.ts`) and
`collapseRepeats`, which drop meta records, task lifecycle markers,
`system:status` pings, attachments with no summary, repeated titles and
task-notification carriers. Greg wants Expanded to verify that every message
type is accounted for, so Expanded draws every persisted record: no
`filterDisplayableMessages`, no `collapseRepeats`, no per-kind visibility.
The exceptions are frames that are not transcript records at all (stream
deltas, rate-limit and lifecycle frames, which never enter `messages[]`) and
the post-compact duplicate reply that `repeatedRecords.ts` drops, which is a
copy of a record already drawn. Standard keeps today's Modern pipeline
exactly. (Claude's call, from Greg's stated purpose.)

`ViewMode` becomes `"standard" | "expanded"`. The composer's 2×2 switch
(`SessionViewToggle`) becomes a two-button `Standard | Expanded` switch. The
default in Settings › General (`defaultViewMode`, the "chat format" radio)
offers the same two.

Saved values migrate on load: `compact` and `modern` → `standard`;
`verbose` and `all` → `expanded`.

Per-mode behavior elsewhere follows the old mode it replaces:

- Context rail deltas (`showsGutterDelta`): Standard hides sub-2k deltas, as
  Compact/Modern did; Expanded prints every one, as Verbose did.
- Repeat collapsing (`collapseRepeats`, rules with `onlyIn`): Standard applies
  what Compact/Modern applied; Expanded applies what All applied.

### Every record gets a Modern drawing

Today Modern draws prompts, answers, work, questions, plans, notices,
compactions, recaps, instruction files and `line` items
(`modernLineOf`, `src/lib/modernLines.ts`). Anything `modernLineOf` returns
null for becomes an `other` item, drawn by the classic `StreamMessage` card.
`other` goes away:

- Each record that falls to `other` today gets a Modern line: the kind's icon
  and color from its Message kinds settings, a title (the kind's label, or a
  better one where the record has it), a short detail where there is one, and
  its text as a folded body. Where the record has no readable text, the body
  is the raw JSON, mono and folded.
- An unrecognized record keeps today's treatment (`Unrecognized record:
  <type>`, raw JSON folded, amber), now in its kind's icon.
- A line takes its color from the kind's color setting. Lines that already
  carry a meaningful accent (permission mode, effort, model) keep it.
- The live permission prompt and the compaction summary, which `modernLineOf`
  excludes today because their own widgets draw them, keep being drawn by
  those widgets (or by Modern's compaction item for the summary). They are
  not classic-card fallbacks.

The builder enumerates exactly which kinds reach `other` once Expanded skips
the filters (run it over real transcripts in `~/.claude-personal/projects` and
`~/.claude-work/projects`, read-only, and list every `o-` item) and gives each
a line. Expected set, from the registry: subagent prompt, skill injection,
system context, task notification, coordinator message, CLI bracket notice,
tool results outside a work run, and assistant/user records Modern does not
model.

### Settings › Chats

Tabs after the change:

1. **Messages** (first, default tab) — today's Modern tab contents (step
   icons and colors, timeline, thoughts, font, answer size, prompt and answer
   card colors, answer style) plus the Message kinds tree merged into it.
   Per kind, three settings: **icon**, **color**, and **Show in Standard**
   (on/off), replacing Always / Verbose / Never.

   **Migration rule (Greg, 2026-11-18): what Modern shows today is what
   Standard shows after the change, whatever the old Compact/Verbose
   settings said.** Show in Standard is computed from the saved config as
   Modern reads it today — the effective style (`resolveKind`: category, then
   registry default, then the user's patch) judged under the saved
   `modern.recordRules`: on under `compact` when the kind is Always; under
   `verbose` when it is Always or Verbose; under `all` for every kind. It is
   written at the level it was set (category or kind), so the inherited
   result is unchanged. A migration test runs a transcript fixture covering
   every registry kind through today's Modern pipeline and the new Standard
   one, under each `recordRules` value and Greg's saved config, and requires
   identical items.
   **The kinds tree lists only kinds whose settings change something on
   screen.** Modern draws some kinds with its own items regardless of
   per-kind visibility, with icons and colors from the step settings
   (`modern.stepIcons` / `stepColors`): prompts, answers, the answer that
   ends a turn, thinking, tool calls, tool results inside a work run,
   answered questions and plans (`buildModernItems`,
   `src/lib/modernGrouping.ts`, where `hidden()` applies only to instruction
   files, recaps and line records). Those kinds are left out of the tree: the
   step settings above it already style them, and Standard keeps drawing them
   as today. The tree holds the kinds Modern draws as lines (and the
   instruction-file and recap items), where icon, color and Show in Standard
   all take effect. (Claude's call: it keeps the goal that every control
   changes something visible, without changing what Standard shows.)

   **Categories stay as group defaults** with the same three settings (icon,
   color, Show in Standard); a kind inherits its category's choice unless it
   sets its own, as `resolveKind` layers them today. Greg's saved config sets
   visibility at the category level (system and live are `verbose`), so
   keeping the layer means nothing has to be copied into individual kinds and
   Standard's contents cannot flip. (Claude's call.)
2. **Turn preview** — a sample turn drawn by the Modern renderer, with a
   Standard / Expanded toggle, so changing a kind's icon, color or switch is
   visible immediately.
3. **Typography** — only what Modern still reads: the chat content typeface
   (Modern's "content" font option uses it) and, if the builder confirms
   they still reach Modern text, content size and weight. The header
   typography and icon-chip settings go.

Removed from settings: "Show records like" (`recordRules`), the All cards
editor, the Hidden Events editor, and per-kind presentation, border style,
alignment, header label, raw-payload toggle, icon border and icon background.

### Deleted

- `StreamMessage` and everything only it reaches: `MessageFrame`,
  `MessageFrameCard`, `KindHeader`, `CardActionBar`, the classic tool widgets
  under `src/components/claude/tools/` and `ToolWidgets.tsx` that nothing
  else imports, `SamplePreview`.
- The "N Hidden Events" grouping: `HiddenEventsGroup`, `compactGrouping.ts`'s
  grouping, `hiddenEventsSummary.ts`.
- The classic paths in `ClaudeTranscript.tsx`.
- Config fields only the classic renderer read: the per-kind fields above,
  `hiddenEvents`, `typography.header`, `typography.icon`,
  `modern.recordRules`, and their editors and tests.

Things to keep even though `StreamMessage` imports them: anything Modern also
imports (`RawJsonPopover`, `getLanguage` in `claude/tools/shared`, markdown
components, the live `AskUserQuestionCard`). The live reply is already Modern's own
(`ModernLiveAnswer`); `InflightAssistantBubble` and `InflightThinking` are
drawn only in the classic formats and are deleted with them. The builder confirms each by import graph, not by
name.

## Goals

- One renderer. No code path draws a chat any other way.
- Expanded shows every persisted record in the transcript (bar the
  exceptions above); an unhandled type is a visible amber line, never
  silently dropped.
- Settings › Chats has three tabs, and every control on them changes
  something visible.
- Saved settings load without errors and land on the equivalent choice.

## Non-goals

- Restyling Modern itself. Prompts, answers, work, questions, plans and
  notices look as they do today.
- A third view, or unfolding tool runs in Expanded.
- Changing what Standard shows by default: the per-kind defaults stay as
  today's Always/Verbose/Never, mapped as above.

## Anti-goals

- A record that Standard used to show and now does not, or that Expanded
  drops. Expanded must be a superset of every old format.
- Any remaining "if classic" branch or dead config field. Per CLAUDE.md,
  refactors delete what they make unreachable in the same change.

## Constraints

- TDD (repo rule). Existing Modern grouping, line and footer tests stay
  green; new lines get tests per kind.
- `ipc` and daemon are untouched: this is renderer-only, plus the config
  shape stored in `app_settings` (`message_rendering_config`), which must
  migrate on read.
- American spelling (guard test).
- Measure render cost after the deletion with `__omnifexProfile` in a
  packaged build — the transcript is windowed (150 rows) and every open tab
  is mounted.

## Approaches considered

1. **Delete the classic renderer; give every record a Modern line** —
   picked. Meets all three of Greg's goals.
2. Keep `StreamMessage` as a slim fallback for records Modern does not model
   — rejected by Greg: keeps a second look and the code behind it.
3. Hide the classic settings only — rejected: simpler page, but none of the
   code goes and chats still mix two looks.

Per-kind settings: Greg picked **icon, color and Show in Standard** over
icon-and-color-only, to keep control over what Standard hides without a
release.

## Decided by Greg

- Two views, Standard (default) and Expanded; Expanded = everything, like All.
- Standard uses the Compact filter Modern already uses.
- Expanded still folds tool runs.
- Migration: compact/modern → standard, verbose/all → expanded.
- Standard shows exactly what Modern shows today; per-kind settings are
  rewritten from Modern's current effective visibility, not from the old
  labels.
- Composer switch becomes two buttons.
- The deletions listed above.
- Per kind: icon, color, Show in Standard.
- Unknown records: classic icon and color, drawn as a Modern icon-and-line.

## Left to the builder (Claude's calls, marked)

- Exact title/detail/body wording per new line (reuse `recordText.ts`).
- Whether content size and weight survive in Typography (keep only if they
  reach Modern text).
- Order of the kinds tree inside Messages, and the Turn preview fixture.
- Order of work: lines first (so `other` empties while both renderers
  exist), then the views, then settings, then deletions.
