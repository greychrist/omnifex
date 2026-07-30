# Cache Expiry Session Timer

**Date:** 2026-07-30
**Status:** Approved, ready for planning

A countdown showing how much of the prompt cache's lifetime is left, in the
session header and mirrored as a tab-strip glyph so it is visible from other
tabs.

## Problem

Prompt caching makes a follow-up turn dramatically cheaper than a cold one, but
the cache expires on a timer measured from the last API request. There is
currently no way to know how long you have before the next turn pays a full
re-read — you find out from the bill.

## Scope

In scope: observing the effective cache TTL, counting down from the last
assistant turn, rendering that in `SessionCard`, and surfacing the level as a
tab-strip indicator.

Out of scope (separate spec): the context-pressure banner
(`2026-07-30-context-pressure-banner-design.md`). The two features share a
Settings section and nothing else.

## Why the TTL Is Observed, Not Configured

There is no readable "cache TTL" setting. In CLI 2.1.220 the decision function
reduces to:

```
FORCE_PROMPT_CACHING_5M       → 5m
ENABLE_PROMPT_CACHING_1H      → 1h
!subscriptionGate || isUsingOverage → 5m
otherwise                     → 1h iff querySource matches a server-controlled
                                 allowlist, default
                                 ["repl_main_thread*","sdk","auto_mode",
                                  "memdir_relevance"]
```

So the effective TTL depends on env knobs *plus* subscription state, overage
state, query source, and a remote allowlist. The env knobs are readable from an
account's `settings.json` `env` block, but reading them alone is wrong in the
common case where none are set.

The CLI does, however, report what it actually did. Each turn's
`usage.cache_creation` carries `ephemeral_1h_input_tokens` and
`ephemeral_5m_input_tokens` — already parsed elsewhere in this app
(`electron/services/usage.ts`) and already in hand in the renderer
(`AgentSession.tsx:946` reads `message.usage`). The CLI tracks the same two
numbers internally as `lastMainThreadCacheTtlMs` and
`lastApiCompletionTimestamp`; this feature derives them from the JSONL instead.

## Data

New pure module `src/lib/cacheExpiry.ts`. Two observations, both walking
`messages` backwards from the end, mirroring the `totalTokens` derivation at
`AgentSession.tsx:945`:

```ts
/** 3_600_000 or 300_000, or null when no turn has reported a cache write. */
export function observeCacheTtlMs(messages: JsonlNode[]): number | null;

/** Timestamp (ms) of the last assistant message, or null. */
export function lastAssistantAnchorMs(messages: JsonlNode[]): number | null;
```

`observeCacheTtlMs` returns `3_600_000` when the most recent assistant turn with
a nonzero `usage.cache_creation` counter has `ephemeral_1h_input_tokens > 0`, and
`300_000` when it has `ephemeral_5m_input_tokens > 0`. Turns that only *read*
cache leave both counters at zero and are skipped, so the last non-zero
observation is what sticks. When no turn has ever reported a cache write, the
result is `null` and no timer renders — the feature never guesses.

The anchor is the last assistant message's normalized `receivedAt`, because the
cache is refreshed by each API request: the TTL restarts when the last response
completed, not when the user last typed.

### Evaluator

```ts
export type CacheExpiryLevel = 'fresh' | 'warn' | 'critical' | 'expired';

export interface CacheExpiry {
  level: CacheExpiryLevel;
  remainingMs: number;   // clamped at 0
  elapsedPct: number;    // may exceed 100 before clamping for display
}

export function evaluateCacheExpiry(opts: {
  anchorMs: number;
  ttlMs: number;
  nowMs: number;
}): CacheExpiry;
```

Thresholds are on the **elapsed** fraction of the TTL: `warn` at ≥ 80%,
`critical` at ≥ 90%, `expired` at ≥ 100%, `fresh` below 80%. Concretely:

| TTL | yellow | red | expired |
| --- | --- | --- | --- |
| 5m | 4:00 | 4:30 | 5:00 |
| 1h | 48m | 54m | 60m |

`nowMs` is injected so the lib is deterministic under test.

A formatter lives alongside it: `m:ss` below ten minutes, `Nm` above.

## Where the Clock Ticks

`AgentSession` never ticks. It is ~2800 lines with a deep child tree, and
re-rendering it every second to advance a countdown would be a real cost. It
computes only `{ anchorMs, ttlMs }` — values that change once per turn — and
distributes them:

1. **Down to `SessionCard`** as props, alongside the `contextUsage` /
   `totalTokens` it already receives. `SessionCard` owns a 1-second interval and
   renders the countdown, so only that subtree re-renders.
2. **Onto the tab object** via `updateTab`, guarded by a last-value ref exactly
   like the existing `promptStatus` mirror (`AgentSession.tsx:1354`). The guard
   is load-bearing: `updateTab` creates a new tab object every call, so an
   unguarded write from a ticking effect is the render-loop shape this codebase
   has hit before.

`TabManager` then runs **one** interval for the entire strip and derives each
tab's level from its stored anchor/TTL. Two intervals total, both calling the
same evaluator, so the header and the tab cannot disagree about where 80% is.
Each interval clears itself once there is nothing left to count (no observed
TTL, or every tracked session already `expired`).

## Display

### SessionCard

A new row directly beneath the context-gauge button, inside the existing
`flex-col` wrapper that already holds the controls label and the gauge
(`SessionCard.tsx:193`). Mono `text-xs`, matching the gauge readout.

| State | Text | Style |
| --- | --- | --- |
| `fresh` | `cache 42m left` | `text-muted-foreground` |
| `warn` | `cache 48s left` | `text-amber-500` |
| `critical` | `cache 24s left` | `text-red-500` |
| `expired` | `cache expired` | `text-muted-foreground` |
| turn in flight | `cache refreshing…` | `text-muted-foreground` |

Tooltip carries the detail: *"1h prompt cache, last written 18m ago, expires
14:32."*

**The in-flight case is not cosmetic.** During a long turn the anchor is still
the *previous* assistant message, so a 5m cache would read "expired" while a
fresh write is actually in progress. Whenever a turn is in flight the row shows
a neutral `cache refreshing…` and the tab signal clears. The countdown is only
meaningful between turns.

At `expired` the row goes neutral and stops rather than staying red: the cost is
already sunk, so a red alert would be nagging about the past.

### Tab strip

A new `cacheExpiring` entry in `config.tabIndicators` (`messageRenderingConfig.ts`),
defaulting to `{ icon: "Timer", color: "yellow" }`, rendered through the existing
`TabStatusGlyph` and editable in Settings alongside error / permission /
question / complete. At `critical` the same style renders in `red`.

`TabStatusGlyph` gains an opt-out of its `animate-pulse`, which every current
glyph hard-codes. Pulsing is right for "I need you now" and wrong for a countdown
that would otherwise strobe for minutes.

Glyph precedence in `TabManager` (`TabManager.tsx:69`) puts `cacheExpiring`
**below** error, permission, and question — those are actionable, this is
ambient.

Because `config.tabIndicators` gains a key, `messageRenderingConfig`'s version
is bumped and `mergeTabIndicators` supplies the new default for saved configs.
The existing merge strategy (defaults as baseline, user patch on top) handles
this without a reset.

## Setting

One `app_settings` key, `cache_timer_enabled`, default `"true"`, in the same
Settings section as the context-pressure banner. Off hides both the header row
and the tab glyph.

This toggle was not requested. It is included because an always-on countdown is
the kind of ambient motion that wears out its welcome, and the banner beside it
already has an off switch.

## Testing

TDD, in this order:

1. `src/lib/__tests__/cacheExpiry.test.ts`
   - `observeCacheTtlMs`: 1h turn → `3_600_000`; 5m turn → `300_000`;
     zero-counter turns skipped in favour of an older non-zero turn; no cache
     write anywhere → `null`; missing `cache_creation` object tolerated
   - `lastAssistantAnchorMs`: picks the last assistant message, ignores user and
     system nodes, `null` on an empty transcript
   - `evaluateCacheExpiry`: both sides of 80 / 90 / 100 for both TTLs;
     `remainingMs` clamped at 0 past expiry
   - formatter: `m:ss` below ten minutes, `Nm` above
2. `src/components/__tests__/SessionCard.cacheTimer.test.tsx`
   - fresh / warn / critical / expired rendering under `vi.useFakeTimers()`
   - `cache refreshing…` while a turn is in flight
   - renders nothing when disabled or when no TTL has been observed
3. `src/components/__tests__/TabManager.cacheGlyph.test.tsx`
   - glyph appears at `warn`, renders red at `critical`, clears at `expired`
   - loses precedence to a pending permission
   - does not pulse

Verification gate (renderer-only change): `npm run check`, `npm run build`,
`npm test`. Then `npm run rebuild:electron` before relaunching, since a vitest
run leaves `better-sqlite3` built for Node rather than Electron.

## Known Limitations

- **The TTL is retrospective.** It reflects what the last cache-writing turn
  did. If subscription state changes mid-session — entering overage drops the
  CLI from 1h to 5m — the timer keeps showing 1h until the next turn writes
  cache and reveals the change.
- **No timer before the first cache write.** A resumed session whose recent
  turns only read cache shows nothing until a turn writes. This is deliberate:
  the alternative is inventing a TTL.
- **TUI mode is fine here.** Unlike the context gauge, this feature needs no
  live control request — the JSONL carries everything, so TUI and chat behave
  identically.
