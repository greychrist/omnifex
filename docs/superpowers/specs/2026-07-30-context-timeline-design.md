# Context Timeline

**Date:** 2026-07-30
**Status:** Approved, ready for implementation

A vertical rail running alongside the transcript showing how large the context
was at each point in the conversation, so a session can be reviewed after the
fact to find where context jumped.

## Problem

`ContextPressureBanner` and `SessionNotices` are both *live* signals — they
describe the session's current state. Neither answers the retrospective
question: *which message made this session expensive?* Today the only way to
find that is to read `usage` out of the raw JSONL by hand.

## Scope

In scope: deriving a per-message context series from an already-loaded
transcript, and rendering it as a gutter rail in `ClaudeTranscript` under a
toggle.

Out of scope: cost-per-message (`src/lib/pricing.ts` already computes that and
`StreamMessage` already shows it), and any change to how usage is captured.
This is a rendering feature over data the app already holds.

## The Data Is Already There

Every assistant message carries `message.usage`, and

```
input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens
```

is the *cumulative* context at that moment — not a per-message increment. That
is exactly `turnContextTotal` (`src/lib/turnDelta.ts`). `loadSessionHistory`
reads the entire JSONL into `messages`, so a resumed session has the whole
series available on mount with no new IPC and no new storage.

Measured against a real 329-line session: **164 sampled points**, ranging
64,843 → 466,198, containing one +324,691 step.

## Four Constraints That Shape the Design

### 1. Samples exist only at assistant messages

User prompts and tool results carry no `usage`. The series is a step function
sampled at assistant messages. Between samples the rail carries the last known
value forward rather than interpolating — the context genuinely did not change
in between, and a sloped line would imply measurements that were never taken.

### 2. Compaction resets the series

A `compact_boundary` drops context by design. The rail must render the drop as
a deliberate break, not as a plunge that reads like data loss.

### 3. Sidechain messages are not main-thread context

Subagent assistant messages carry their own `usage` describing *their* context,
not the parent's. Counting them corrupts the series. `sessionDerivedState.ts`
already has the correct predicate (`isMainAssistant`, handling both
`isSidechain` and forwarded `parent_tool_use_id`); it needs exporting.

**This also fixes a live bug.** `turnContextTotal` does not currently apply
that filter, so the context-jump notice shipped in v0.4.104 can report a
subagent's context as a main-thread jump. Same root cause, fixed once.

### 4. Alignment must not depend on array indices

`ClaudeTranscript` renders `displayableMessages` — `messages` filtered by the
user's hard-filter toggles. Two consequences:

- Indices into `displayableMessages` do not match indices into `messages`, so
  an index-keyed timeline silently misaligns whenever a filter is on.
- Deltas must be computed over the **full** `messages` array. Computing them
  over the filtered array would difference across hidden messages and attribute
  a hidden message's growth to its visible neighbour.

So: build the series over `messages`, key it by **node identity** (`Map<JsonlNode,
Point>`), and look points up by reference at render time. `filterDisplayableMessages`
preserves object identity, so this aligns under any filter combination, in both
view modes, for free.

## Module

New pure module `src/lib/contextTimeline.ts`.

```ts
export interface ContextTimelinePoint {
  /** Context size at this row; carried forward between samples. */
  tokens: number;
  /** Growth vs the previous sample. Null at carried-forward rows. */
  delta: number | null;
  /** True only where a real usage reading exists. */
  isSample: boolean;
  /** A sample whose delta met the jump threshold. */
  isJump: boolean;
  /** First sample after a compact_boundary — delta is suppressed. */
  isReset: boolean;
  /** tokens / limit, clamped to 0..1, for bar width. */
  fraction: number;
}

export function buildContextTimeline(
  messages: JsonlNode[],
  opts: { limit: number; jumpThresholdTokens: number },
): Map<JsonlNode, ContextTimelinePoint>;
```

Rows before the first sample get no entry — the rail starts where the data
does rather than drawing a zero.

## Rendering

A fixed-width gutter column to the left of each message row. `ClaudeTranscript`
maps rows in a plain `.map` inside a `space-y-4` scroll container with no
virtualization (`ClaudeTranscript.tsx:234`), so a flex row with a stretched
gutter cell stays aligned with variable-height messages automatically. An
absolutely-positioned SVG rail was rejected: it would need height measurement
and a resize observer to track markdown/code blocks that reflow.

Per row:

- A 1px vertical rail line spanning the row's full height, so the timeline
  reads as continuous.
- At a sample: a horizontal bar whose width is `fraction`, plus a mono token
  count.
- At a jump: the bar and count switch to amber, prefixed with the delta
  (`▲ +325k`). Threshold reuses the existing `context_jump_tokens` setting so
  the rail and the live notice agree on what counts as a jump.
- At a reset: a dashed break and the label `compacted`.

Compact view mode groups messages through `buildCompactItems`, which returns
`{kind:'single', message}` or `{kind:'group', messages[]}`. A group's tick uses
its **last** member's point — the group's exit state, which is what matters for
"how big was context after this."

## Toggle

One `app_settings` key, `context_timeline_enabled`, default `"false"`, loaded
through the existing `SessionGaugesContext` alongside the other gauge settings.
Off by default because the rail costs horizontal room in the message column and
is a review tool rather than an always-on signal, and because it is exposed as a
transcript toolbar control for per-session flipping.

## Testing

TDD, in this order:

1. `src/lib/__tests__/turnDelta.test.ts` — a sidechain assistant between two
   main ones must not become the baseline or the current total.
2. `src/lib/__tests__/contextTimeline.test.ts`
   - samples only at main assistant messages; sidechains excluded
   - carry-forward between samples; no entry before the first sample
   - deltas computed over the full array, so a hidden message's growth is not
     attributed to its neighbour
   - `isJump` at/above and below threshold
   - `isReset` after a `compact_boundary`, with delta suppressed
   - `fraction` clamped at 1 when context exceeds the limit
3. `src/components/__tests__/ContextTimelineTick.test.tsx`
   - renders token count at a sample, nothing at a gap row
   - jump styling and delta label
   - `compacted` break at a reset
4. `src/components/__tests__/ClaudeTranscript.timeline.test.tsx`
   - rail hidden when the setting is off
   - alignment survives a hard filter (identity keying, not index)

Verification gate (renderer-only): `npm run check`, `npm run build`, `npm test`,
then `npm run rebuild:electron`.

## Known Limitations

- **Resolution is per assistant message.** A single message that loads 300k
  shows as one step; the rail cannot show growth *within* a message.
- **Pre-first-sample rows are blank.** A session's opening prompt has no
  reading yet.
- **The series is only as complete as the transcript.** Compact-mode groups
  collapse several messages into one tick, so a jump inside a collapsed group
  is reported at the group's exit rather than at the exact message.
