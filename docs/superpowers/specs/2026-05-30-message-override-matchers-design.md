# Message override matchers — design

Status: draft for review · 2026-05-30

## Problem

Today an "override" is keyed by a precomputed **kind id** (`assistant.tool-use`,
`system.notification.error`). The kind id is produced by an in-code classifier;
users cannot see or author the JSON values that define it, and they can only
override groupings the classifier already emits (e.g. every tool call collapses
to `assistant.tool-use`, so you cannot single out Bash). The add-override picker
is also an inline panel that scrolls out of view, and overrides are listed flat
rather than grouped by category.

## Goals

- Overrides become **user-authored matchers** that test the message's raw JSON.
- Matching is **scoped to a category**: an override is filed under one of the 5
  categories, applies only to messages the classifier put in that category, and
  inherits that category's base style.
- **Full cascade** resolution: every matching override contributes its (sparse)
  style fields; the most specific override wins per field; unset fields fall
  through to the category base.
- A **centered modal** authors the match (label + conditions); **styling stays
  in the right-hand panel** (categories and overrides both).
- The tree **groups overrides under their category**, with an "+ Add override"
  entry per category and an Edit (✎) action before Delete (🗑) on each row.
- The right-hand panel **displays the active selection's matching rules**
  (read-only) under the Sample, next to the name / "inherits from" line.
- **Every existing override is preserved** — migrated 1:1 into the new rule shape.

## Non-goals

- Editing category *matching* (we own that; the classifier stays). Users edit
  category *styles* only.
- Cross-category overrides (an override spans exactly one category; duplicate it
  if you need two).
- A general query language. Conditions are flat `path op value` triples.

## Concepts

- **Category** (5, built-in): fixed matching (the classifier assigns it),
  user-editable *style*. Provides the complete base style for every message.
- **Override** (user): `{ id, label, category, match, style }`. Scoped to one
  category. `match` is a list of conditions; `style` is a sparse `KindStyle`
  patch edited in the right panel.
- **Condition**: `{ path, op, value }` tested against the message.
- **Specificity**: number of conditions in a matching override. More → wins per
  field in the cascade. Ties break by list (definition) order.

## Match syntax

A condition is `path op value`, evaluated against the message's **raw JSON**
(`JsonlNode.raw` — the object behind "copy raw") plus two synthetic paths:

- `$kind` — the classifier's kind id (e.g. `assistant.tool-use`). Lets users
  match the friendly classifier output and is how existing overrides migrate.
- `$category` — the resolved category (redundant with the override's `category`
  scope, exposed for clarity in the example viewer).

Paths into `raw`:

| Path | Resolves |
|---|---|
| `type` | `raw.type` |
| `subtype` | `raw.subtype` (note: lowercase, not `subType`) |
| `notification_type` | `raw.notification_type` |
| `message.stop_reason` | nested via dots |
| `message.content[].name` | **any** element of the `content` array has `name = …` |
| `attachment.type` | `raw.attachment.type` |

- `[]` means "any array element satisfies the remainder of the path." Within one
  condition the same element must satisfy the whole remainder; across separate
  conditions different elements may match (acceptable for v1 — tool-call
  messages carry a single `tool_use` block in practice).
- **Operators**: `eq` (strict, typed equality), `contains` (case-sensitive
  substring on a string value), `regex` (`RegExp.test` on a string value).
- **Values**: `"quoted"` = string; bare `true` / `false` / `null` / numbers are
  typed. `eq` compares the JSON value at the path to the parsed literal.

Examples:

- Bash tool calls → `message.content[].type eq "tool_use"` +
  `message.content[].name eq "Bash"` (2 conditions; beats a generic
  `…type eq "tool_use"` rule).
- Error notifications → `subtype eq "notification"` +
  `notification_type eq "error"`.
- End-of-turn text → `message.stop_reason eq "end_turn"`.
- Migrated built-in → `$kind eq "assistant.tool-use"`.

## Resolution

New pure function:

```
resolveMessageStyle(config, message, classifiedKindId): KindStyle
  category = originOf(classifiedKindId)
  base     = config.categories[category]                       // complete
  hits     = config.overrides.filter(o =>
               o.category === category &&
               conditionsMatch(o.match, message, classifiedKindId))
  hits.sort((a,b) => a.match.length - b.match.length)          // ties: array order
  return hits.reduce((acc,o) => ({ ...acc, ...o.style }), { ...base })
```

- `conditionsMatch(match, message, kindId)` — every condition must hold (AND).
  Empty `match` ⇒ matches all messages in the category (specificity 0).
- `getByPath(raw, path)` — dotted traversal with `[]` any-element semantics;
  `$kind`/`$category` resolved specially.
- Cascade is per-field: more specific overrides overwrite less specific ones
  field-by-field; everything unset falls through to the category base.

`resolveKind(config, kindId)` stays for the no-message case (settings previews,
and as the cascade's base lookup). It is the special case of `resolveMessageStyle`
with no overrides applied.

## Data model + migration

`config.overrides` changes shape:

```
// before (v3): Record<kindId, Partial<KindStyle> & { label?: string }>
// after  (v4): Override[]
type MatchOp = "eq" | "contains" | "regex";
interface MatchCondition { path: string; op: MatchOp; value: string|number|boolean|null }
interface Override {
  id: string;                 // stable, unique
  label: string;
  category: Category;         // scope + base style + tree grouping
  match: MatchCondition[];
  style: Partial<KindStyle>;  // sparse; edited in the right panel
}
```

Bump `version` 3 → 4. `mergeConfig` gains a v3→v4 branch that **converts every
existing override into a rule, dropping none**: each `overrides[id]` becomes
`{ id, label: patch.label ?? id, category: originOf(id),
match: [{ path: "$kind", op: "eq", value: id }], style: <patch minus label> }`.
The conversion is purely a reshape of data the user already has — same id, same
category, same style, and a `$kind eq <id>` rule that reproduces the old exact-id
match — so behavior is identical after migration and nothing is lost. This
applies to both the user's saved overrides and the built-in `DEFAULT_OVERRIDES`
(rewritten in the new shape with the same `$kind` matchers). A unit test asserts
a round-trip of a representative v3 config produces one rule per original
override with matching id/category/style. `serializeConfig` is unchanged (still
`JSON.stringify`). `pruneRedundantOverrides` iterates the array and drops style
fields equal to the category base (keeping `label`, `match`, and the active-edit
exemption); it never removes a rule that carries match conditions, even when its
style is empty.

## UI

**Tree (left), grouped by category:** each category node expands to show
`+ Add override` then that category's overrides (array order). Each override row:
presentation/icon · label · ✎ Edit · 🗑 Delete. Clicking a category or an
override row selects it for **styling in the right panel** (unchanged editor).

**Centered modal (Add/Edit override):** authors `label` + `match` only.
- Shows the chosen **category**.
- Shows an **example message's raw JSON** (built-in fixture per category for v1;
  later, real messages from the active session). Clicking a field adds a
  `path eq <value>` condition (prefilled), which kills typos like `subType`.
- Conditions list: path, op (`eq`/`contains`/`regex`), value; add/remove rows.
- A small condition-count badge communicates specificity.

**Right panel:** the existing `KindEditor` styling controls, used for both
categories and overrides (no change to its field set). Directly under the Sample
preview — at the spot that today reads the name and "Inherits the {Category}
category" line — the panel adds a read-only **Matching rules** block:

- **Override selected:** shows the override's name, its "inherits {Category}"
  line, and its conditions rendered as readable `path op value` rows (e.g.
  `subtype eq "notification"`, `notification_type eq "error"`). Empty match ⇒
  "matches all {Category} messages." This is display-only; conditions are edited
  in the centered dialog (an "Edit rules" affordance opens it).
- **Category selected:** shows the category name and a short, read-only statement
  of how the classifier assigns messages to it (e.g. User = "messages you send
  and their tool results"), so categories read consistently with overrides even
  though their matching isn't user-editable.

The rules block is a small presentational component fed by the resolved
selection; it does not change the styling controls below it.

**Previews:** `SamplePreview` already renders through the real `MessageFrame`
against a synthesized config; it continues to preview a single resolved style.
`TurnPreview` adapts to the new override shape.

## Transition / impact (clean cutover)

The render hot path is left almost untouched by injecting an **effective config**
at the one choke point, reusing the provider pattern already built for the
sample preview:

1. **Add** `resolveMessageStyle`, `conditionsMatch`, `getByPath` (pure, tested).
2. **`MessageFrame`** has both `message` and `streamKind`. It computes the
   cascaded style once and provides an *effective config* (where `streamKind`
   resolves to the cascaded style) to its subtree via a context provider.
   Result: `MessageFrameCard`, `MessageFrameCollapsible`, `KindHeader`, and the
   `accentStyle` / `typographyClasses` / `kindPresentation` helpers keep calling
   `resolveKind(config, kindId)` **unchanged** and transparently get the matched
   style. When `message` is absent (previews) it falls back to plain `resolveKind`.
3. **List-level pre-checks** that need matching switch to `resolveMessageStyle`
   (they have the message in scope): `compactGrouping.isMessageFullyHidden`,
   `blockKind.isBlockHiddenInCompact`, and the `StreamMessage` presentation/
   hidden/header decisions (`StreamMessage.tsx:718,724,898`).
4. **Config**: shape change + `mergeConfig` v3→v4 migration + `DEFAULT_OVERRIDES`
   rewrite + `pruneRedundantOverrides` array form.
5. **Settings UI**: `MessageKindTree` (grouping + per-category add + edit action),
   new `OverrideMatchDialog`, a read-only `MatchingRules` panel component (shown
   under the Sample for the active category/override), and `AppearanceSettings`
   handlers (`addOverride`/`setOverrideField`/`clearOverrideField`/`removeOverride`)
   retargeted to the array + a new `updateOverrideMatch`.
6. **Tests**: rewrite the override portions of `messageRenderingConfig.test.ts`
   and `AppearanceSettings.presentation.test.tsx`; add unit suites for the new
   pure functions and the migration.

## Performance

Matching is a per-message linear scan of same-category overrides with cheap
path lookups; counts are tiny (single digits). Resolve once per `MessageFrame`
and memoize on `(message, streamKind, config)`.

## Phasing (safe, incremental)

- **Phase 1 — engine + migration, no behavior change.** New types, pure
  functions, v3→v4 migration (everything maps to `$kind` matchers), wire
  `resolveMessageStyle` into `MessageFrame` + the list-level pre-checks. Existing
  overrides render identically. Fully covered by tests before any UI ships.
- **Phase 2 — UI.** Tree grouping + per-category add + edit action; the centered
  match dialog (label + conditions + example-JSON click-to-add); styling stays
  in the right panel.
- **Phase 3 — power.** Raw-JSON field matching beyond `$kind` (the `[]`/nested
  paths) and `contains`/`regex` exposed in the dialog; example viewer pulls real
  session messages.

## Risks / open decisions

- **Tree order vs precedence**: tree shows category groups in array order, but
  cascade precedence is by condition count. A condition-count badge mitigates the
  mismatch; revisit if confusing.
- **`[]` cross-condition element independence** (two conditions may match
  different array elements). Acceptable for v1; tighten later if needed.
- **Example JSON source**: fixtures in v1, live messages in Phase 3.
- **Equal-specificity ties**: resolved by array order; reordering UI deferred.
```

## Verification gate for implementation

Frontend + config change → `npm run check`, `npm run build`, `npm test`
(and `npm run test:coverage` for the engine), then `npm run rebuild:electron`.
