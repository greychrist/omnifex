# App Font + Chat Typeface Pickers — Design

**Date:** 2026-05-09
**Status:** Draft → awaiting review before plan
**Target release:** v0.4.18 (Greg deferred publishing the draft GitHub release to land this feature first; if that constraint shifts, this can roll into v0.4.19 instead — see "Release coordination" at the bottom)

## Problem

OmniFex's global font is hardcoded to Inter via `--font-sans` in `src/styles.css:126`. There's no runtime control over the app's typeface, and the Appearance settings' Typography card only exposes an abstract `sans | serif | mono` toggle per chat element — not the underlying typeface. Greg wants a curated catalog of bundled fonts, a global "App font" picker, and per-element ("Header" / "Content") typeface pickers on the chat surface, all with live preview and persistence.

A second motivation: the current Typography card uses a vertically stacked layout that wastes horizontal space. The redesign collapses Header / Content / Card-icon controls into a 3-column layout, with the new typeface pickers landing at the top of the Header and Content stacks.

## Goals

- Bundle a curated catalog of 13 typefaces (locally, no CDN — match the existing Inter setup, keeps the app offline-capable).
- Add a global **App font** picker (single sans-only dropdown) that drives `--font-sans` everywhere.
- Replace the existing `family: sans|serif|mono` per-element toggle in the Typography card with a concrete **Header font** and **Content font** typeface picker, drawn from the full catalog grouped by family tag.
- Redesign the Typography card to a 3-column layout (Header / Content / Card icon).
- Persist all selections through the existing `api.getSetting` / `api.saveSetting` IPC — no new channels.
- Migrate existing user `MessageRenderingConfig` records (with the legacy `family` field) without data loss.

## Non-Goals

- Separate code/mono font picker for markdown code blocks. The global `--font-mono` continues to drive code fences. Adding a third "Code font" picker is the natural follow-up; deferred.
- Per-message-kind font override (only Header / Content split for now).
- Font subsetting / file-size optimization beyond shipping the variable woff2 each foundry already provides.
- User-uploaded custom fonts.
- A "Reading pack" cohesive trio model. (Briefly considered, replaced by per-element pickers per design call.)

## Catalog

13 typefaces. Each ships as a single variable woff2 where the foundry provides one; static woff2 otherwise. Expected total bundle add: ~1.5–2 MB.

| ID | Display label | Family tag | Source |
|---|---|---|---|
| `inter` | Inter | sans | rsms/inter (OFL) — already bundled, default app font |
| `geist` | Geist | sans | vercel/geist-font (OFL) |
| `plus-jakarta` | Plus Jakarta Sans | sans | tokotype/plusjakartasans (OFL) |
| `dm-sans` | DM Sans | sans | googlefonts/dm-sans (OFL) |
| `plex-sans` | IBM Plex Sans | sans | IBM/plex (OFL) |
| `oxanium` | Oxanium | display-sans | sevmeyer/oxanium (OFL) |
| `plex-serif` | IBM Plex Serif | serif | IBM/plex (OFL) |
| `source-serif` | Source Serif 4 | serif | adobe-fonts/source-serif (OFL) |
| `ia-quattro` | iA Writer Quattro | humanist | iaolo/iA-Fonts (OFL) |
| `plex-mono` | IBM Plex Mono | mono | IBM/plex (OFL) |
| `jetbrains-mono` | JetBrains Mono | mono | JetBrains/JetBrainsMono (OFL) |
| `geist-mono` | Geist Mono | mono | vercel/geist-font (OFL) |
| `ia-duospace` | iA Writer Duospace | mono | iaolo/iA-Fonts (OFL) |

All licenses are SIL OFL 1.1 — compatible with OmniFex's AGPL-3.0 distribution. Each font's license text ships at `src/assets/fonts/<id>/LICENSE.txt`.

The `family` tag drives grouping in the typeface dropdown (`Sans`, `Serif`, `Humanist`, `Mono` sections). The App-font picker filters to entries tagged `sans` or `display-sans`.

## Architecture

### Data model

#### New global setting

- Storage key: `app_font`
- Value: typeface ID, e.g. `"inter"` (default), `"geist"`, etc.
- Loaded at app boot, applied via a new `AppFontProvider` (mirrors `ThemeContext`'s shape).

#### `MessageRenderingConfig` schema change

Current (`src/lib/messageRenderingConfig.ts:594`, `:619-620`):

```ts
type FontFamily = 'sans' | 'serif' | 'mono';
type TypographyStyle = { family: FontFamily; size; weight; italic };
```

After:

```ts
type Typeface =
  | 'inter' | 'geist' | 'plus-jakarta' | 'dm-sans' | 'plex-sans' | 'oxanium'
  | 'plex-serif' | 'source-serif' | 'ia-quattro'
  | 'plex-mono' | 'jetbrains-mono' | 'geist-mono' | 'ia-duospace';

type TypographyStyle = { typeface: Typeface; size; weight; italic };
```

The `family` field is **removed**. Migration in `parseConfig`: if an incoming record has `family`, fall back per-tag (`sans → inter`, `serif → source-serif`, `mono → jetbrains-mono`) and discard the `family` key.

Defaults (replacing `:619-620`):

```ts
header:  { typeface: 'inter', size: 'sm', weight: 'semibold', italic: false }
content: { typeface: 'inter', size: 'sm', weight: 'normal',   italic: false }
```

`typography.icon` is unchanged.

### Typeface catalog module

New file: `src/lib/typefaceCatalog.ts`

```ts
export type FamilyTag = 'sans' | 'display-sans' | 'serif' | 'humanist' | 'mono';

export interface TypefaceMeta {
  id: Typeface;            // stable storage ID
  label: string;           // dropdown display name
  cssFamily: string;       // exact font-family CSS string
  family: FamilyTag;       // grouping/filter tag
  fallback: string;        // system fallback stack tail
}

export const TYPEFACE_CATALOG: readonly TypefaceMeta[] = [...];
export const TYPEFACE_BY_ID: Readonly<Record<Typeface, TypefaceMeta>>;
export const APP_FONT_CHOICES: readonly TypefaceMeta[]; // family in {sans, display-sans}
```

`cssFamily` is the literal CSS string we set, e.g. `'"Inter", system-ui, sans-serif'` — including the system fallback tail so a missing webfont degrades gracefully.

### CSS plumbing

`src/styles.css`:

1. Add 12 new `@font-face` declarations (Inter is already declared). Variable woff2 where supported, with `font-display: swap` and `font-weight: 100 900` (or the actual provided range).

2. Replace the static `--font-sans` value with a layered definition:

```css
:root {
  --font-sans: var(--app-font-stack, "Inter", system-ui, sans-serif);
  --font-serif: var(--chat-font-serif, ui-serif, Georgia, "Times New Roman", serif);
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace;
}
```

The `AppFontProvider` sets `--app-font-stack` on `:root` from `TYPEFACE_BY_ID[appFont].cssFamily`. Default is `var(--app-font-stack, ...)` so initial render before the provider mounts still shows Inter.

3. The chat header and content `font-family` is set inline via React `style={{ fontFamily: TYPEFACE_BY_ID[style.typeface].cssFamily }}` on the existing render path. No new CSS class or scope needed.

### Persistence flow

`AppFontProvider` (new):
- On mount: `await api.getSetting('app_font')`, default to `'inter'` if missing/invalid.
- On `setAppFont(id)`: validate against `TYPEFACE_BY_ID`, update React state, set `--app-font-stack` on `documentElement.style`, persist via `api.saveSetting('app_font', id)`.
- Exposes `useAppFont()` hook.

Wired into `App.tsx` provider tree alongside `ThemeProvider`.

`MessageRenderingConfig` typeface fields persist through the existing `messageRenderingConfig` storage path (no plumbing change beyond the schema migration above).

## UI changes

### `src/components/settings-panels/AppearanceSettings.tsx`

Insert a new card at the top of the panel (above "Message kinds"):

```tsx
<Card className="p-6">
  <AppFontPicker />
</Card>
```

`AppFontPicker` is a thin component: heading + caption + `<Select>` populated from `APP_FONT_CHOICES`. Reads/writes via `useAppFont()`.

### `src/components/settings-panels/appearance/TypographyEditor.tsx`

Full rewrite of the body. The card heading and description stay; the body becomes a 3-column CSS grid:

```tsx
<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
  <ColumnStack title="Header" description={...}>
    <TypefacePicker value={typography.header.typeface} onChange={...} />
    <SizePicker ... />
    <WeightPicker ... />
    <ItalicSwitch ... />
  </ColumnStack>

  <ColumnStack title="Content" description={...}>
    <TypefacePicker value={typography.content.typeface} onChange={...} />
    <SizePicker ... />
    <WeightPicker ... />
    <ItalicSwitch ... />
  </ColumnStack>

  <ColumnStack title="Card icon" description={...}>
    <IconSizePicker ... />
    <BorderedSwitch ... />
    <BgOpacitySlider ... />
  </ColumnStack>
</div>
```

`ColumnStack` is an inline helper (not a separate file — small enough): renders the title + description + a vertical-flex wrapper for children. Uses the same heading/description treatment as the existing `<Label>` + caption pattern.

`TypefacePicker` is a new component (`src/components/settings-panels/appearance/TypefacePicker.tsx`) — a Radix `<Select>` populated from `TYPEFACE_CATALOG`, grouped by `family` via `<SelectGroup>` (`Sans`, `Serif`, `Humanist`, `Mono`). Each `<SelectItem>`'s text uses `style={{ fontFamily: meta.cssFamily }}` so the dropdown previews the typeface.

The `FAMILIES` constant and the abstract `family` `<Select>` go away with the rewrite.

`SizePicker`, `WeightPicker`, `ItalicSwitch`, `IconSizePicker`, `BorderedSwitch`, `BgOpacitySlider` are extracted as inline helpers from the existing JSX. They wrap the existing `<Select>` / `<Switch>` / `<input type="range">` patterns 1:1 — no behavior change, just reorganization.

The `<= md` breakpoint stays as `grid-cols-1` so on narrow widths the columns stack vertically (mobile/sidebar-collapsed mode).

### `src/lib/messageRenderingConfig.ts`

- Remove `FONT_FAMILIES` constant and `FontFamily` type.
- Add `Typeface` type union (matches the catalog IDs).
- Update `Typography`, `TypographyStyle`, defaults.
- Update `parseConfig`'s `parseStyle` (around `:807`) to migrate `family` → `typeface` per the fallback table, and validate `typeface` is one of the 13 known IDs (else fall back to `inter`).

### `src/components/SamplePreview.tsx` and chat rendering

Anywhere the existing typography is applied to a header or content element today, swap the family-class lookup for an inline `fontFamily`. Concretely the changes are isolated to:
- `src/components/settings-panels/appearance/SamplePreview.tsx`
- `src/components/settings-panels/appearance/TurnPreview.tsx`
- The chat rendering path in `src/components/ClaudeCodeSession.tsx` and any kind/card components it renders that consume `typography.header`/`typography.content`. (To be enumerated during plan-writing — quick `rg "typography\.header|typography\.content"` will catch them.)

## Asset pipeline

- New directory: `src/assets/fonts/<id>/<id>.woff2` plus a `LICENSE.txt`.
- `@font-face` `src` URLs use `/src/assets/fonts/<id>/<id>.woff2` (matches the existing Inter pattern).
- Vite copies these into the renderer build automatically (already does so for Inter — see the dist artifact `Inter-c8O0ljhh.ttf` from the latest build). No `vite.renderer.config.ts` changes needed.
- Variable woff2s preferred where the foundry ships them; the goal is one file per typeface to keep `@font-face` declarations simple. Where a foundry only ships static weights, ship one regular + one bold static woff2 and declare two `@font-face` blocks.

## Testing

Renderer-only feature. Tests:

1. `src/lib/__tests__/typefaceCatalog.test.ts` (new):
   - Every catalog entry has `id`, `label`, `cssFamily`, `family`, `fallback`.
   - `family` is one of the allowed `FamilyTag` values.
   - `APP_FONT_CHOICES` filters to `sans | display-sans` only.
   - `TYPEFACE_BY_ID` round-trips.
2. Extend `src/lib/__tests__/messageRenderingConfig.test.ts` (or create if missing):
   - Legacy config with `family: 'sans'` parses to `typeface: 'inter'`.
   - Legacy config with `family: 'serif'` parses to `typeface: 'source-serif'`.
   - Legacy config with `family: 'mono'` parses to `typeface: 'jetbrains-mono'`.
   - Unknown `typeface` value parses to `'inter'`.
3. `src/contexts/__tests__/AppFontContext.test.tsx` (new):
   - Mounts with `inter` when storage is empty.
   - Reads stored value and applies `--app-font-stack` on the documentElement.
   - `setAppFont` persists and re-applies.
   - Unknown stored value falls back to `inter`.

Coverage gate stays at the existing 80% lines target — these tests should comfortably keep us above it.

## File touch list (summary)

**New:**
- `src/lib/typefaceCatalog.ts`
- `src/contexts/AppFontContext.tsx`
- `src/components/settings-panels/AppFontPicker.tsx` (or inline within `AppearanceSettings.tsx` if small)
- `src/components/settings-panels/appearance/TypefacePicker.tsx`
- `src/assets/fonts/<id>/<id>.woff2` × 12 (new typefaces; Inter already present)
- `src/assets/fonts/<id>/LICENSE.txt` × 12
- `src/lib/__tests__/typefaceCatalog.test.ts`
- `src/contexts/__tests__/AppFontContext.test.tsx`
- `docs/2026-05-09-app-font-and-chat-typography-design.md` (this file)

**Modified:**
- `src/styles.css` — 12 new `@font-face` blocks + `--app-font-stack` indirection.
- `src/lib/messageRenderingConfig.ts` — typeface schema + migration.
- `src/components/settings-panels/AppearanceSettings.tsx` — new App-font card.
- `src/components/settings-panels/appearance/TypographyEditor.tsx` — 3-column rewrite.
- `src/components/settings-panels/appearance/SamplePreview.tsx` — typeface inline style.
- `src/components/settings-panels/appearance/TurnPreview.tsx` — typeface inline style.
- `src/App.tsx` — wire `AppFontProvider` into provider tree.
- Chat rendering files that consume `typography.header.family` / `typography.content.family` — to be enumerated in the plan via grep.
- `src/lib/__tests__/messageRenderingConfig.test.ts` — migration tests.
- `CHANGELOG.md` — release entry.

## Risks / caveats

- **Bundle size.** ~1.5–2 MB add to the asar. Acceptable for a desktop app, worth noting.
- **`MessageRenderingConfig` migration.** Existing users have `family: 'sans'` records persisted. Migration is one-way (we drop `family`). Anyone who downgrades to a pre-v0.4.18 build after upgrading would see their `typography.header.family` reset to default `sans` — same blast radius as any forward-only schema change.
- **First-paint flash.** Until `AppFontProvider` mounts and applies `--app-font-stack`, the layered CSS variable falls back to Inter — same as today. Should not be visible to the user.
- **License compliance.** All 13 typefaces are SIL OFL 1.1. The OFL allows redistribution including in binaries; we ship the `LICENSE.txt` per font directory to satisfy the attribution clause.

## Release coordination

A draft v0.4.18 GitHub release was created earlier in this session with the SDK-bump-only artifacts (DMG + ZIP). Greg paused before publishing to add this feature. Two paths when this lands:

1. **Roll into v0.4.18.** Delete the existing draft release on GitHub, rebuild artifacts after the feature lands, re-attach to the same `v0.4.18` tag. The `v0.4.18` tag is already pushed; the omnifex-release skill's "don't re-point an existing tag" rule was written for tags users may have pulled — since v0.4.18 was draft-only and never published, the tag never pointed to a published artifact, so re-pointing locally + force-pushing is acceptable here. Confirm with Greg.

2. **Bump to v0.4.19.** Land this feature with a fresh version bump and new tag. Cleaner versioning history; v0.4.18 (SDK-only) gets published as-is first or just abandoned.

Decision deferred to release time; design doesn't depend on the choice.
