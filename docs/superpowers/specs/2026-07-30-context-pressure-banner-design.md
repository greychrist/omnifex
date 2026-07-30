# Context Pressure Banner

**Date:** 2026-07-30
**Status:** Approved, ready for planning

A configurable banner across the top of a session that fires when the context
window fills past a user-set budget, and runs `/compact` when clicked.

## Problem

The context gauge in `SessionCard` already shows occupancy, but it is a small
mono readout in a dense header — easy to miss while working. There is no signal
that says "it is time to compact," and no one-click way to act on it. Running
`/compact` today means typing it into the prompt input.

## Scope

In scope: a settings-driven, two-level banner in the session view, and a click
action that submits `/compact` to the running session.

Out of scope (separate spec): the cache-expiry session timer and its tab
coloring. That feature has a different data source (`usage.cache_creation`) and
different surfaces (`SessionCard` body, tab strip).

Explicitly not built: auto-compaction. The banner prompts; the user decides.

## Setting Model

New pure module `src/lib/contextPressure.ts`, mirroring the existing
`src/lib/autoScrollThresholds.ts` (keys + defaults + parse + clamp in a lib, no
React). Live application via `src/contexts/ContextPressureContext.tsx`,
mirroring `AutoScrollContext` — load once on mount, save on change, apply to
open sessions without a restart.

Three `app_settings` keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `context_pressure_enabled` | `"true"` | Master on/off |
| `context_pressure_mode` | `"tokens"` | `"percent"` \| `"tokens"` |
| `context_pressure_value` | `"250000"` | Percent (1–100) or absolute token count |

The default is an absolute **250,000 tokens**, chosen for 1M-window sessions.

### Evaluator

```ts
export type ContextPressureMode = 'percent' | 'tokens';

export interface ContextPressureSetting {
  enabled: boolean;
  mode: ContextPressureMode;
  value: number;
}

export type ContextPressureLevel = 'none' | 'warn' | 'critical';

export interface ContextPressure {
  level: ContextPressureLevel;
  /** Resolved budget in tokens, after clamping. */
  budgetTokens: number;
  /** Occupancy as a percent of the real window, for display. */
  pct: number;
}

export function evaluateContextPressure(opts: {
  tokens: number;
  limit: number;
  setting: ContextPressureSetting;
}): ContextPressure;
```

Rules:

1. `level` is `none` whenever `!enabled`, `tokens <= 0`, or `limit <= 0`.
2. `budgetTokens`:
   - `percent` → `limit * (value / 100)`
   - `tokens` → `min(value, limit * 0.95)`
3. `critical` when `tokens >= budgetTokens`; `warn` when
   `tokens >= budgetTokens * 0.8`; otherwise `none`.
4. `pct` = `min(100, (tokens / limit) * 100)`, for the banner text only.

**Why absolute budgets clamp to 95% of the window, not to the window itself:**
the 250k default exceeds a 200k window. Clamping to the raw window would put
`critical` at exactly 200k — unreachable in practice, since the CLI's own
auto-compaction fires first. The user would then only ever see the amber `warn`
level on 200k sessions. Clamping to 190k keeps both levels reachable, while
1M-window sessions get the literal 250k budget with `warn` at 200k.

### Clamping and parsing

- `percent` mode: value clamped to 1–100.
- `tokens` mode: value clamped to a 1,000 floor (no upper bound — the evaluator
  clamps against the live window instead, which the settings UI cannot know).
- Unparseable or missing stored values fall back to the defaults above, matching
  `parseThresholdPx` in `autoScrollThresholds.ts`.

### Re-arming

The banner is a pure function of `tokens` vs `budgetTokens`, evaluated every
render. There is no dismissal and no "already shown" latch, so it re-arms for
free: after a `/compact` drops context it disappears, and it appears again the
next time the budget is crossed. The only state involved is a transient
in-flight guard on the click handler (below), which is keyed to the send, not to
the level.

## The Banner

New component `src/components/ContextPressureBanner.tsx`.

Chrome copies `AccountMismatchBanner` — same `flex items-start gap-2 px-3 py-2
text-xs` row, leading Lucide icon, no border. (Borders are deliberately avoided:
the unlayered `* { border-color }` rule in `styles.css` overrides Tailwind
border-color utilities app-wide, so a bordered banner would not render the
intended color.)

Two differences from `AccountMismatchBanner`:

- The **entire row is a `<button>`**, full width.
- There is **no dismiss control**. The banner clears only when context actually
  drops below the budget, or when the setting is turned off. This is deliberate,
  per the product decision: a dismissible warning becomes a reflex-dismissed
  warning.

| Level | Classes | Icon |
| --- | --- | --- |
| `warn` | `bg-amber-500/10 text-amber-600 dark:text-amber-400` | `AlertTriangle` |
| `critical` | `bg-red-500/10 text-red-600 dark:text-red-400` | `AlertOctagon` |

Text, with token counts formatted as `k` like the existing gauge:

- `warn` — `Context 200k / 1.0M (20%) — 80% of your 250k compact threshold. Click to run /compact.`
- `critical` — `Context 250k / 1.0M (25%) — over your 250k compact threshold. Click to run /compact.`

While a turn is in flight the button is `disabled` and the trailing sentence
becomes `…waiting for the current turn.` This keeps a click from interleaving
`/compact` with streaming output.

Props are plain data so the component stays trivially testable:

```ts
interface ContextPressureBannerProps {
  pressure: ContextPressure;   // level drives render; 'none' renders null
  tokens: number;
  limit: number;
  busy: boolean;               // a turn is in flight
  onCompact: () => void;
}
```

## Wiring Into AgentSession

Rendered immediately after `<AccountMismatchBanner>` (`AgentSession.tsx:2303`),
so both banners stack in the same slot — outside the header, which carries an
explicit resizable height. Gated on `sessionStarted`, so it never appears over
the new-session form.

Inputs are already in scope at that point, and are exactly the pair
`SessionCard`'s gauge consumes (`SessionCard.tsx:146`), so the banner and the
gauge can never disagree:

- `tokens` — `contextUsage?.totalTokens` when live data is present, else the
  `totalTokens` fallback derived from the last assistant turn
  (`AgentSession.tsx:945`).
- `limit` — `resolveContextLimit({ sdkMaxTokens, model, defaultModel })`.

Since both surfaces need the same derivation, the `useSdk ? … : …` selection is
lifted out of `SessionCard`'s render IIFE into a small exported helper in
`contextPressure.ts` and consumed by both.

### Click action

The handler branches on session mode exactly as `FloatingPromptInput`'s `onSend`
already does (`AgentSession.tsx:2702`):

- TUI → `createTuiPromptHandler(tabId)('/compact', selectedModel)`, which writes
  `/compact\r` into the pty.
- chat → `handleSendPrompt('/compact', selectedModel)`.

The send is dispatched directly rather than typing into the prompt textarea and
simulating Enter. The end state is identical — `/compact` lands in the
transcript as a user turn — but going through `useSendPrompt` inherits the
existing queueing behavior instead of requiring a new imperative method on
`FloatingPromptInputRef` (which today exposes only `addImage`).

The banner then clears itself with no extra plumbing: `/compact` emits a
`compact_boundary`, which already triggers a `contextUsage` refresh
(`runtime.ts:191`), and the refreshed number is below the budget.

## Settings UI

A new section in `src/components/settings-panels/GeneralSettings.tsx`, beside
the auto-scroll thresholds and tab indicators it already hosts:

- `Switch` — enable/disable.
- `Select` — Percent of window / Absolute tokens.
- `Input type="number"` — the value, committed on blur or Enter (same draft-state
  pattern the auto-scroll inputs use, so typing stays smooth).

The sub-label resolves the setting into concrete numbers against a 200k and a 1M
window, e.g. *"On a 1M session: warns at 200k, red at 250k. On a 200k session:
warns at 152k, red at 190k."* This makes the 95% clamp visible rather than
surprising.

## Testing

TDD, in this order:

1. `src/lib/__tests__/contextPressure.test.ts`
   - percent mode: warn and critical boundaries, both sides of each
   - tokens mode: same, plus the `limit * 0.95` clamp when the budget exceeds
     the window (250k against 200k → critical at 190k, warn at 152k)
   - `none` when disabled, when `tokens <= 0`, when `limit <= 0`
   - parse/clamp: bad strings fall back to defaults; percent clamps to 1–100;
     tokens clamps to the 1,000 floor
   - the shared tokens/limit selection helper: live `contextUsage` wins, fallback
     used when absent
2. `src/components/__tests__/ContextPressureBanner.test.tsx`
   (alongside the existing `AccountMismatchBanner.test.tsx`)
   - renders nothing at `none`
   - amber at `warn`, red at `critical`
   - **no dismiss button exists** — this is the regression guard on the product
     decision
   - click calls `onCompact`
   - `busy` renders disabled and does not call `onCompact`

Verification gate (renderer-only change): `npm run check`, `npm run build`,
`npm test`. Then `npm run rebuild:electron` before relaunching the app, since a
vitest run leaves `better-sqlite3` built for Node rather than Electron.

## Addendum — single-turn context jumps

A turn-count habit ("compact every ~40 turns") structurally cannot see a skill
or file load that adds hundreds of thousands of tokens in one turn. Only a
delta alarm can, so `src/lib/turnDelta.ts` computes one from the same usage
numbers the gauge sums:

```
total(N) = input + cache_read + cache_creation + output
delta(N) = total(N) − total(N−1)      // consecutive assistant turns
```

`lastTurnDelta` returns null in three cases that would otherwise produce a
misleading number: fewer than two turns with usage, a `compact_boundary`
between them (compaction drops context by design — the delta is hugely negative
and means the opposite of a problem), and any shrink for the same reason.

Configurable via `context_jump_enabled` / `context_jump_tokens`, default 50,000
tokens absolute. Absolute rather than a percentage because what makes a jump
notable is its raw size: a 325k load is alarming on a 1M window exactly as much
as on a 200k one.

Surfaced as a one-line notice in `SessionNotices.tsx`, beneath the banner.
Because the evaluator only ever reports the *most recent* delta, the notice
self-clears the moment an ordinary turn lands — no dismissal state.

**Deliberately not actionable.** Wiring the notice to `/compact` is the obvious
temptation and it is wrong: a large jump is usually a skill or file load that
was just requested, and compacting immediately would discard it. The notice
reports; the banner acts.

## Known Limitations

- **TUI mode lags by up to one turn.** The CLI does not answer
  `get_context_usage` in TUI mode (`queries.ts` `liveEngine`), so the banner runs
  on the last-assistant-turn fallback derived from the tailed JSONL. It is
  correct, just less current than in chat mode.
- **Budgets near the top of the window are academic.** The CLI auto-compacts on
  its own near the window ceiling, so a budget set at 100% of the window would
  usually be beaten to it. The 250k default sits well clear on 1M sessions, and
  the 95% clamp keeps 200k sessions honest.
