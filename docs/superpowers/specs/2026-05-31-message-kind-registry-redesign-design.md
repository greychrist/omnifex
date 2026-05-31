# Message-rendering redesign: id-keyed kind registry

**Date:** 2026-05-31
**Status:** Approved (design)
**Supersedes:** the v4 match-matcher model
(`2026-05-30-message-override-matchers-design.md`) and the v3 category model
(`2026-05-29-message-kind-categories-design.md`).

## Problem

The message-rendering config grew three stacked layers to style a single
message:

1. `classifyStandaloneKind` / `classifyBlockKind` → a dotted kind id
2. `originOf` → one of 5 categories
3. `resolveMessageStyle` → category base ⊕ matching overrides, via a general
   `path / op / value` **match engine** (`conditionsMatch`, `getByPath`, …)

Symptoms that motivated the redesign:

- **Everything renders gray.** Two independent causes:
  - The `primary` palette entry's swatch is literally gray (`#8b8b8b`,
    `messageRenderingConfig.ts:49`). The accent helpers paint a card's
    border/bg from `entry.swatch` (`accentStyle.ts:14-17`), so any kind
    resolving to `primary` is gray *by accident of the palette*. The
    AskUserQuestion question card (`AskUserQuestionCard.tsx:80`) and the
    answered card (`assistant.askUserQuestion`, agent base = `primary`)
    resolve their override correctly — to `primary`, which is gray.
  - `PermissionCard` calls `accentStyleFor` (category base only, via
    `resolveKind`) instead of the cascade-aware `resolvedAccentStyleFor`, so
    its `amber` override is dropped and it falls back to the `system`
    category's `muted` gray (`PermissionCard.tsx:103,282`). Its sibling
    `AskUserQuestionCard` already uses the resolved helper; `PermissionCard`
    was never updated to match.
- **The catalog is aspirational, not real.** `KNOWN_KIND_IDS` lists ~65 kinds,
  but the classifier only ever emits a fraction distinctly. For system
  messages, `classifyStandaloneKind` special-cases only `notification.*`,
  `hook_started`, `hook_response`, `permission_denied`, `user_prompt_submit`;
  **everything else returns `system.unknown`** (`messageKind.ts:184`). So
  `system.{hook_progress,local_command,turn_duration,away_summary,status,
  stop_hook_summary,informational}` are configurable-but-unreachable. All
  `attachment.*` ids (~20) style nothing because `StreamMessage` returns
  `null` for attachment kind (`StreamMessage.tsx:1337`). Bookkeeping ids
  (`pr-link`, `mode`, `last-prompt`, `queue-operation`, `ai-title`,
  `file-history-snapshot`, `permission-mode`) never render.
- **The match engine is over-general for how it's used.** Every default
  override is a `$kind eq <id>` rule (`kindOverride`,
  `messageRenderingConfig.ts:290`). The full `path/op/value` engine,
  per-message cascade resolution, and `effConfig` injection exist to support
  arbitrary user-authored rules that, in practice, no default uses and the
  product does not need.

## Core insight

**The kind id already encodes "the merits of the content."** The classifier
inspects each message/block and assigns an id; `StreamMessage` already chooses
the rendering component on the merits. The config layer's only job is to map
**id → chrome** (accent color, icon, presentation, visibility). Everything that
made it complex — the match engine, per-message cascade, `effConfig`
injection — supports arbitrary user rules, which we are dropping.

So this redesign is mostly **deletion**, plus one new **kind registry**.

## Decisions (locked with the user)

1. **Full rethink** of the classify → style pipeline (not an incremental
   patch).
2. **Keep per-kind editing**, but only for the real kinds the classifier
   actually emits, and **drop the general match engine** — kinds are fixed ids,
   not arbitrary matchers.
3. **Full reset** of saved config to fresh v5 defaults. No migration code;
   typography / terminal / palette customizations are NOT preserved (acceptable
   — they have not been meaningfully customized).

## Design

### 1. Data model (config v5)

A single typed **registry** is the source of truth for every real kind. It
lives in code, not in saved config.

```ts
interface KindDef {
  id: string;                    // e.g. "permission.request"
  category: Category;            // grouping + inheritance base
  label: string;                 // "Permission request"
  description: string;
  default: Partial<KindStyle>;   // built-in chrome for this kind
}

const KIND_REGISTRY: Record<string, KindDef> = { /* §3 */ };

interface MessageRenderingConfig {
  version: 5;
  defaultViewMode: "compact" | "verbose";
  categories: Record<Category, CategoryStyle>;  // 5, unchanged
  kinds: Record<string, Partial<KindStyle>>;    // SPARSE user diffs only
  palette: Palette;                             // unchanged
  typography: Typography;                       // unchanged
  terminal: Terminal;                           // unchanged
  hardFilters: HardFilters;                     // unchanged
  debug: DebugOptions;                          // unchanged
}
```

`KindStyle` keeps its existing fields (`presentation`, `accentColor`, `icon`,
`headerLabel`, `borderStyle`, `alignment`, `hiddenInCompact`,
`compactBoundaryLocked`, `widget?`, `showRawPayload?`, `iconBordered?`,
`iconBgOpacity?`).

### 2. Resolution — one pure function, no message argument

```ts
function categoryOf(id: string): Category {
  return KIND_REGISTRY[id]?.category ?? "system";  // fallback for future ids
}

function resolveKind(config: MessageRenderingConfig, id: string): KindStyle {
  return {
    ...config.categories[categoryOf(id)],   // 1. category theme (bulk)
    ...KIND_REGISTRY[id]?.default,           // 2. kind's built-in look
    ...config.kinds[id],                     // 3. user's tweaks
  };
}
```

Three layers, all by plain id lookup — no match engine, no message inspection.
Because defaults live in the registry, `config.kinds` only ever holds genuine
user changes, and "reset this kind to default" is just `delete config.kinds[id]`.

**Accent helpers collapse to one set.** `resolveKind` now folds in the per-kind
style, so the `accentStyleFor` vs `resolvedAccentStyleFor` distinction
disappears:

```ts
accentFor(config, id)       // resolveKind(config, id).accentColor → PaletteEntry|null
accentStyleFor(config, id)  // → React.CSSProperties | undefined
swatchFor(config, id)       // → hex | undefined
```

The live cards (`PermissionCard`, `AskUserQuestionCard`) call the same
`accentStyleFor(config, id)` as everything else and get the correct color — the
PermissionCard gray bug is fixed structurally, with no card-specific helper.

**Deleted entirely:**
`Override`, `MatchCondition`, `MatchOp`, `resolveMessageStyle`,
`conditionsMatch`, `getByPath`, `valuesForPath`, `valueSatisfies`,
`withResolvedKindStyle`, `pruneRedundantOverrides`, `kindOverride`,
`upsertKindOverride`, `KNOWN_KIND_IDS`, `DEFAULT_OVERRIDES`, the
`resolvedAccentFor` / `resolvedAccentStyleFor` / `resolvedSwatchFor` trio, and
the v2 / v3 / v4 migration branches in `mergeConfig`.

### 3. The honest kind catalog (~28, down from ~65)

Only kinds the classifier/renderer actually produces, grouped by category.
Each gets a `KindDef` with a sensible `default` style.

**agent**
- `assistant.text`
- `assistant.text.endTurn`
- `assistant.thinking`
- `assistant.tool-use`
- `assistant.askUserQuestion` (the answered Q+A card)

**user**
- `user.prompt`
- `user.command`
- `user.commandOutput`
- `user.subagentPrompt`
- `user.skillInjection`
- `user.systemContext`
- `user.sdkSystemBracket`
- `user.tool-result` (unifies the old `tool.result.generic` + `user.tool-result`)
- `user.image`

**system**
- `system.notification.info`
- `system.notification.warn`
- `system.notification.error`
- `system.notification.stop`
- `system.hook_started`
- `system.hook_response`
- `system.permission_denied`
- `system.userPromptSubmit`
- `system.api_error`
- `system.unknown` (catch-all for unrecognized system subtypes)
- `permission.request` (live prompt)
- `permission.askUserQuestion` (live prompt)

**summary / fallback**
- `summary.compaction`
- `unknown`

**Removed as dead weight (~37):**
- all `attachment.*` (StreamMessage returns `null` for attachment kind)
- never-emitted `system.{hook_progress, local_command, turn_duration,
  away_summary, status, stop_hook_summary, informational}`
- bookkeeping ids (`pr-link`, `mode`, `last-prompt`, `queue-operation`,
  `ai-title`, `file-history-snapshot`, `permission-mode`)
- the duplicate tool-result id (`tool.result.generic`) — folded into
  `user.tool-result`

**Implementation guard:** before deleting an id, confirm against the renderer
and classifier that it is genuinely unreachable. Any id that turns out to be
emitted joins the registry instead of being dropped. `cli-stream-init` /
`cli-stream-result` render through their own badge components
(`CliInitBadge` / `CliResultBadge`) and do not need a registry entry unless
they start routing through `MessageFrame`; confirm during implementation.

### 4. Special cases (cross-message / live) stay in the renderer

These never touch the config layer. They remain where they are:

| Case | Dependency | Owner |
|---|---|---|
| AskUserQuestion answered pair | assistant `tool_use` ↔ later user `tool_result` (two messages) | `messageKind.ts` correlation → `AnsweredAskUserQuestionCard` |
| `assistant.text.endTurn` | parent message `stop_reason` | `blockKind.ts` |
| tool_result widget suppression | match to prior `tool_use` | `StreamMessage.tsx` |
| completion band / turn duration | sequence position | `StreamMessage.tsx` |
| compact grouping of hidden runs | consecutive messages | `compactGrouping.ts` |
| live permission / AskUserQuestion prompts | live overlay state (not JSONL) | `AgentSession` → `PermissionCard` / `AskUserQuestionCard` |

The live prompts are the only cards rendered outside `MessageFrame`. With the
unified `resolveKind`, they style themselves with the same `accentStyleFor`
call as in-feed cards.

### 5. Renderer & settings changes

- **`MessageFrame`** drops the per-message cascade: no `useMemo` over
  `resolveMessageStyle`, no `withResolvedKindStyle`, no wrapping children in a
  provider. It calls `resolveKind(config, streamKind)` directly and renders the
  presentation variant. Descendants (`MessageFrameCard`, `KindHeader`,
  side-line) keep calling `resolveKind(config, id)` and transparently get the
  per-kind style, because `resolveKind` now folds the override in.
- **`MessageRenderingPreviewProvider`** stays, but only serves the settings
  live-preview, which injects `config.kinds[previewId] = inEditStyle`. It is no
  longer used by `MessageFrame`.
- **Settings tree (`MessageKindTree`)** iterates the **registry grouped by
  category** — a fixed list of real kinds. Each row edits the kind's
  color / icon / presentation / visibility. No "Add override" affordance.
- **Delete** `OverrideMatchDialog`, `MatchingRules`, and any match-condition
  editing UI.
- **Sample / preview gallery** (the all-kinds list, e.g. via
  `appearance/fixtures.ts`) iterates the registry (~28) instead of
  `KNOWN_KIND_IDS` (~65).
- **`KindEditor`** edits `config.kinds[id]` directly (sparse patch over the
  registry default). "Reset" clears the entry; "Clear field" removes one field
  so it falls back through registry default → category base.

### 6. Default colors

`primary`'s swatch is `#8b8b8b` (gray) — the root of the "everything is gray"
look even when resolution is correct. New registry defaults give the
interactive kinds real accents:

- `permission.request` → amber
- `permission.askUserQuestion` and `assistant.askUserQuestion` → a distinct
  indigo / violet (not neutral `primary`)
- agent text stays neutral, system stays dim, user keeps its accent

Exact hexes are seeded in the registry `default` styles and remain tunable live
in-app. The `primary` palette swatch is also reviewed so "neutral agent" is an
intentional neutral, not an accidental gray.

### 7. Migration

`mergeConfig` keeps only the v5 path plus a reset fallback:

- `saved.version === 5` → shallow-merge `categories`, accept the sparse
  `kinds` map (validated per field against the palette + allowed icons + style
  enums), merge the shared blocks (palette / typography / terminal /
  hardFilters / debug).
- any other / missing version → `createDefaultConfig()` (full reset).

No v2 / v3 / v4 conversion code survives.

## Testing (TDD)

- `resolveKind` three-layer merge: category only, category ⊕ registry default,
  category ⊕ registry default ⊕ user patch; field-level fallthrough.
- `categoryOf` registry lookup + `"system"` fallback for unregistered ids.
- Config v5 parse / serialize round-trip; unknown/missing version → fresh
  defaults; per-field validation drops junk in `config.kinds`.
- **Coverage test:** every id the classifier (`classifyStandaloneKind`,
  `classifyBlockKind`) and the live cards can emit has a `KIND_REGISTRY` entry;
  and every registry id is reachable (no re-introduced dead entries).
- Live-card color resolution: `permission.request` resolves to amber,
  `permission.askUserQuestion` to its distinct accent — not gray.
- `MessageFrame` renders each presentation variant from `resolveKind` with no
  message-cascade machinery.

## Verification gate

Cross-cutting renderer + lib change:
- `npm run check`
- `npm run build`
- `npm test`

## Out of scope

- Changing what the classifier emits (only pruning the catalog to match it).
- Reworking the live-prompt UX (Allow/Deny/answer flows) — only their styling
  path changes.
- Typography / terminal / palette feature changes (data preserved structurally,
  just reset on load this once).

## Files (anticipated; finalized in the plan)

**Heavily changed**
- `src/lib/messageRenderingConfig.ts` — new registry, `resolveKind`,
  `categoryOf`, v5 `mergeConfig`; delete the override/match/migration code.
- `src/lib/accentStyle.ts` — collapse to one accent-helper set.
- `src/components/StreamMessage/MessageFrame.tsx` — drop cascade + effConfig.
- `src/components/settings-panels/appearance/MessageKindTree.tsx` — registry-
  driven tree.
- `src/components/settings-panels/AppearanceSettings.tsx` — remove override
  add/edit wiring.
- `src/components/PermissionCard.tsx` — use unified `accentStyleFor`.

**Deleted**
- `src/components/settings-panels/appearance/OverrideMatchDialog.tsx`
- `src/components/settings-panels/appearance/MatchingRules.tsx`
- related override-only tests.

**Touched**
- `src/components/AskUserQuestionCard.tsx`,
  `src/components/AnsweredAskUserQuestionCard.tsx` — use unified helper / kind
  ids.
- `src/lib/blockKind.ts`, `src/lib/messageKind.ts` — unify the tool-result id;
  no behavior change otherwise.
- `src/components/settings-panels/appearance/{KindEditor,fixtures,SamplePreview,
  MessageKindTree}.tsx` — registry-driven.
- `src/lib/compactGrouping.ts` — uses `resolveKind` instead of
  `resolveMessageStyle`.
- `docs/message-rendering-config.yaml` — regenerate to match v5.
