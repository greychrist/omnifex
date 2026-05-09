# App Font + Chat Typography Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global App-font picker and per-element (Header / Content) typeface pickers on the chat surface, with 13 bundled typefaces and a 3-column rewrite of the Typography card.

**Architecture:** New `typefaceCatalog` module is the single source of typeface metadata. `MessageRenderingConfig.typography.{header,content}.family` is replaced with a `typeface` field that names a catalog entry. A new `AppFontProvider` (mirrors `ThemeContext`) drives `--app-font-stack` on `:root`, which `--font-sans` reads from with an Inter fallback. Chat header/content elements set `font-family` inline from the catalog. Per-element typeface pickers replace the old abstract `sans|serif|mono` toggle.

**Tech Stack:** React 18 + TypeScript, Tailwind v4, Radix `<Select>`, Vitest, Vite asset pipeline. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-09-app-font-and-chat-typography-design.md`

---

## File Structure

**New:**
- `src/lib/typefaceCatalog.ts` — typeface metadata, IDs, CSS family strings, family tags.
- `src/lib/__tests__/typefaceCatalog.test.ts`
- `src/contexts/AppFontContext.tsx` — global app-font provider + hook.
- `src/contexts/__tests__/AppFontContext.test.tsx`
- `src/components/settings-panels/AppFontPicker.tsx` — settings card body for the global picker.
- `src/components/settings-panels/appearance/TypefacePicker.tsx` — Radix select grouped by family tag, used inside `TypographyEditor`.
- `src/assets/fonts/<id>/<id>.woff2` × 12 (Inter already present).
- `src/assets/fonts/<id>/LICENSE.txt` × 12.

**Modified:**
- `src/lib/messageRenderingConfig.ts` — schema migration (`family` → `typeface`).
- `src/lib/__tests__/messageRenderingConfig.test.ts` — migration tests.
- `src/lib/typographyClasses.ts` — drop the family→Tailwind-class mapping, add `typographyFontFamily()`.
- `src/lib/__tests__/typographyClasses.test.ts` — update assertions.
- `src/styles.css` — 12 new `@font-face` blocks + `--app-font-stack` indirection for `--font-sans`.
- `src/components/settings-panels/AppearanceSettings.tsx` — render `<AppFontPicker>` card at top.
- `src/components/settings-panels/appearance/TypographyEditor.tsx` — full body rewrite (3-column layout, typeface pickers).
- `src/components/settings-panels/appearance/SamplePreview.tsx` — emit inline `fontFamily` from catalog.
- `src/components/settings-panels/appearance/TurnPreview.tsx` — same.
- `src/App.tsx` — wire `<AppFontProvider>` into provider tree.
- `CHANGELOG.md` — append v0.4.18 feature entry alongside the SDK bump.

**Files to grep before final commit (enumerated during execution):** any other files that consume `typography.header.family` or `typography.content.family` directly. Initial grep at plan-write time finds only `TypographyEditor.tsx`, `typographyClasses.ts`, `messageRenderingConfig.ts`, and one test — but Task 4's test step re-runs the grep to catch anything added since.

---

## Task 1: Typeface catalog module

**Files:**
- Create: `src/lib/typefaceCatalog.ts`
- Test: `src/lib/__tests__/typefaceCatalog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/typefaceCatalog.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  TYPEFACE_CATALOG,
  TYPEFACE_BY_ID,
  APP_FONT_CHOICES,
  isTypefaceId,
  resolveTypeface,
  type Typeface,
} from "../typefaceCatalog";

describe("typefaceCatalog", () => {
  it("ships exactly 13 entries", () => {
    expect(TYPEFACE_CATALOG).toHaveLength(13);
  });

  it("every entry has the required fields", () => {
    for (const t of TYPEFACE_CATALOG) {
      expect(t.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.cssFamily.length).toBeGreaterThan(0);
      expect(["sans", "display-sans", "serif", "humanist", "mono"]).toContain(t.family);
      expect(t.fallback.length).toBeGreaterThan(0);
    }
  });

  it("ids are unique", () => {
    const ids = TYPEFACE_CATALOG.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("TYPEFACE_BY_ID round-trips every catalog entry", () => {
    for (const t of TYPEFACE_CATALOG) {
      expect(TYPEFACE_BY_ID[t.id]).toBe(t);
    }
  });

  it("APP_FONT_CHOICES includes only sans / display-sans typefaces", () => {
    for (const t of APP_FONT_CHOICES) {
      expect(["sans", "display-sans"]).toContain(t.family);
    }
    // And every sans-tagged catalog entry shows up in APP_FONT_CHOICES.
    const sansIds = TYPEFACE_CATALOG
      .filter((t) => t.family === "sans" || t.family === "display-sans")
      .map((t) => t.id);
    const choiceIds = APP_FONT_CHOICES.map((t) => t.id);
    expect(choiceIds.sort()).toEqual(sansIds.sort());
  });

  it("isTypefaceId narrows correctly", () => {
    expect(isTypefaceId("inter")).toBe(true);
    expect(isTypefaceId("not-a-real-font")).toBe(false);
    expect(isTypefaceId("")).toBe(false);
  });

  it("resolveTypeface returns the entry for known ids", () => {
    expect(resolveTypeface("inter").id).toBe("inter");
    expect(resolveTypeface("geist").id).toBe("geist");
  });

  it("resolveTypeface falls back to inter for unknown ids", () => {
    expect(resolveTypeface("nope" as Typeface).id).toBe("inter");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/typefaceCatalog.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the module**

Create `src/lib/typefaceCatalog.ts`:

```ts
/**
 * Typeface catalog — single source of truth for every font OmniFex bundles.
 *
 * Each entry pairs a stable storage `id` with a CSS `font-family` string
 * (already wrapped in fallbacks) and a `family` tag used to group typefaces
 * in pickers and to filter the App-font picker down to sans-only choices.
 */

export type Typeface =
  | "inter"
  | "geist"
  | "plus-jakarta"
  | "dm-sans"
  | "plex-sans"
  | "oxanium"
  | "plex-serif"
  | "source-serif"
  | "ia-quattro"
  | "plex-mono"
  | "jetbrains-mono"
  | "geist-mono"
  | "ia-duospace";

export type FamilyTag = "sans" | "display-sans" | "serif" | "humanist" | "mono";

export interface TypefaceMeta {
  /** Stable storage ID used in persisted settings. Never rename. */
  id: Typeface;
  /** Human-readable name shown in pickers. */
  label: string;
  /** Full CSS font-family value, including fallback tail. */
  cssFamily: string;
  /** Grouping tag — drives picker section headers and App-font filtering. */
  family: FamilyTag;
  /** System fallback stack tail (informational; cssFamily already includes it). */
  fallback: string;
}

const SANS_FALLBACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Helvetica Neue", sans-serif';
const SERIF_FALLBACK = 'ui-serif, Georgia, "Times New Roman", serif';
const MONO_FALLBACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace';

export const TYPEFACE_CATALOG: readonly TypefaceMeta[] = [
  {
    id: "inter",
    label: "Inter",
    family: "sans",
    cssFamily: `"Inter", ${SANS_FALLBACK}`,
    fallback: SANS_FALLBACK,
  },
  {
    id: "geist",
    label: "Geist",
    family: "sans",
    cssFamily: `"Geist", ${SANS_FALLBACK}`,
    fallback: SANS_FALLBACK,
  },
  {
    id: "plus-jakarta",
    label: "Plus Jakarta Sans",
    family: "sans",
    cssFamily: `"Plus Jakarta Sans", ${SANS_FALLBACK}`,
    fallback: SANS_FALLBACK,
  },
  {
    id: "dm-sans",
    label: "DM Sans",
    family: "sans",
    cssFamily: `"DM Sans", ${SANS_FALLBACK}`,
    fallback: SANS_FALLBACK,
  },
  {
    id: "plex-sans",
    label: "IBM Plex Sans",
    family: "sans",
    cssFamily: `"IBM Plex Sans", ${SANS_FALLBACK}`,
    fallback: SANS_FALLBACK,
  },
  {
    id: "oxanium",
    label: "Oxanium",
    family: "display-sans",
    cssFamily: `"Oxanium", ${SANS_FALLBACK}`,
    fallback: SANS_FALLBACK,
  },
  {
    id: "plex-serif",
    label: "IBM Plex Serif",
    family: "serif",
    cssFamily: `"IBM Plex Serif", ${SERIF_FALLBACK}`,
    fallback: SERIF_FALLBACK,
  },
  {
    id: "source-serif",
    label: "Source Serif 4",
    family: "serif",
    cssFamily: `"Source Serif 4", ${SERIF_FALLBACK}`,
    fallback: SERIF_FALLBACK,
  },
  {
    id: "ia-quattro",
    label: "iA Writer Quattro",
    family: "humanist",
    cssFamily: `"iA Writer Quattro", ${SERIF_FALLBACK}`,
    fallback: SERIF_FALLBACK,
  },
  {
    id: "plex-mono",
    label: "IBM Plex Mono",
    family: "mono",
    cssFamily: `"IBM Plex Mono", ${MONO_FALLBACK}`,
    fallback: MONO_FALLBACK,
  },
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    family: "mono",
    cssFamily: `"JetBrains Mono", ${MONO_FALLBACK}`,
    fallback: MONO_FALLBACK,
  },
  {
    id: "geist-mono",
    label: "Geist Mono",
    family: "mono",
    cssFamily: `"Geist Mono", ${MONO_FALLBACK}`,
    fallback: MONO_FALLBACK,
  },
  {
    id: "ia-duospace",
    label: "iA Writer Duospace",
    family: "mono",
    cssFamily: `"iA Writer Duospace", ${MONO_FALLBACK}`,
    fallback: MONO_FALLBACK,
  },
];

export const TYPEFACE_BY_ID: Readonly<Record<Typeface, TypefaceMeta>> =
  Object.freeze(
    TYPEFACE_CATALOG.reduce((acc, t) => {
      acc[t.id] = t;
      return acc;
    }, {} as Record<Typeface, TypefaceMeta>),
  );

export const APP_FONT_CHOICES: readonly TypefaceMeta[] = TYPEFACE_CATALOG.filter(
  (t) => t.family === "sans" || t.family === "display-sans",
);

const VALID_IDS = new Set<string>(TYPEFACE_CATALOG.map((t) => t.id));

export function isTypefaceId(value: unknown): value is Typeface {
  return typeof value === "string" && VALID_IDS.has(value);
}

/** Look up a typeface by id, falling back to Inter when unknown. */
export function resolveTypeface(id: Typeface | string): TypefaceMeta {
  return isTypefaceId(id) ? TYPEFACE_BY_ID[id] : TYPEFACE_BY_ID.inter;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/typefaceCatalog.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/typefaceCatalog.ts src/lib/__tests__/typefaceCatalog.test.ts
git commit -m "feat(typography): add typeface catalog module

13 bundled typefaces with stable IDs, CSS family strings,
and family tags. Drives App-font filtering and the upcoming
chat typeface picker.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Migrate `MessageRenderingConfig` schema

**Files:**
- Modify: `src/lib/messageRenderingConfig.ts`
- Test: `src/lib/__tests__/messageRenderingConfig.test.ts`

The current `TypographyStyle` has a `family: 'sans'|'serif'|'mono'` field. We replace it with `typeface: Typeface` and migrate legacy records on parse.

- [ ] **Step 1: Read existing test file to understand patterns**

Run: `cat src/lib/__tests__/messageRenderingConfig.test.ts | head -180`

Look at the test around line 149 (the only direct reference to `.family`) to understand the existing parser-test pattern. Most of the file's structure can stay; we add migration tests next to existing ones.

- [ ] **Step 2: Write the failing migration tests**

Append to `src/lib/__tests__/messageRenderingConfig.test.ts` (inside the existing `describe("parseConfig", ...)` block, or a new `describe("typeface migration", ...)` if cleaner):

```ts
import { parseConfig, serializeConfig, createDefaultConfig } from "../messageRenderingConfig";

describe("typeface migration", () => {
  it("migrates legacy family: 'sans' to typeface: 'inter'", () => {
    const legacy = {
      ...JSON.parse(serializeConfig(createDefaultConfig())),
      typography: {
        header: { family: "sans", size: "sm", weight: "semibold", italic: false },
        content: { family: "sans", size: "sm", weight: "normal", italic: false },
        icon: { size: "base", bordered: true, bgOpacity: 100 },
      },
    };
    const cfg = parseConfig(JSON.stringify(legacy));
    expect(cfg.typography.header.typeface).toBe("inter");
    expect(cfg.typography.content.typeface).toBe("inter");
    // Legacy `family` key is dropped from the result.
    expect((cfg.typography.header as Record<string, unknown>).family).toBeUndefined();
  });

  it("migrates legacy family: 'serif' to typeface: 'source-serif'", () => {
    const legacy = {
      ...JSON.parse(serializeConfig(createDefaultConfig())),
      typography: {
        header: { family: "serif", size: "sm", weight: "semibold", italic: false },
        content: { family: "serif", size: "sm", weight: "normal", italic: false },
        icon: { size: "base", bordered: true, bgOpacity: 100 },
      },
    };
    const cfg = parseConfig(JSON.stringify(legacy));
    expect(cfg.typography.header.typeface).toBe("source-serif");
    expect(cfg.typography.content.typeface).toBe("source-serif");
  });

  it("migrates legacy family: 'mono' to typeface: 'jetbrains-mono'", () => {
    const legacy = {
      ...JSON.parse(serializeConfig(createDefaultConfig())),
      typography: {
        header: { family: "mono", size: "sm", weight: "semibold", italic: false },
        content: { family: "mono", size: "sm", weight: "normal", italic: false },
        icon: { size: "base", bordered: true, bgOpacity: 100 },
      },
    };
    const cfg = parseConfig(JSON.stringify(legacy));
    expect(cfg.typography.header.typeface).toBe("jetbrains-mono");
    expect(cfg.typography.content.typeface).toBe("jetbrains-mono");
  });

  it("falls back unknown typeface IDs to inter", () => {
    const bad = {
      ...JSON.parse(serializeConfig(createDefaultConfig())),
      typography: {
        header: { typeface: "not-a-real-font", size: "sm", weight: "semibold", italic: false },
        content: { typeface: "geist", size: "sm", weight: "normal", italic: false },
        icon: { size: "base", bordered: true, bgOpacity: 100 },
      },
    };
    const cfg = parseConfig(JSON.stringify(bad));
    expect(cfg.typography.header.typeface).toBe("inter");
    expect(cfg.typography.content.typeface).toBe("geist"); // valid one survives
  });

  it("default config uses typeface: 'inter' for both header and content", () => {
    const cfg = createDefaultConfig();
    expect(cfg.typography.header.typeface).toBe("inter");
    expect(cfg.typography.content.typeface).toBe("inter");
  });
});
```

Also delete (or replace) the existing line 149 test that asserts `cfg.typography.content.family).toBe("mono")`. Update it to its `typeface` equivalent if it was testing migration; otherwise remove it.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts`
Expected: FAIL — `typeface` is undefined, `family` field still present.

- [ ] **Step 4: Update the schema in `src/lib/messageRenderingConfig.ts`**

Around line 575–622, replace the typography section.

Find this block (lines 583–622):

```ts
export type FontFamily = "sans" | "serif" | "mono";
export type FontSize = "xs" | "sm" | "base" | "lg";
export type FontWeight = "normal" | "medium" | "semibold" | "bold";

export type IconSize = "xs" | "sm" | "base" | "lg" | "xl";

export interface TypographyStyle {
  family: FontFamily;
  size: FontSize;
  weight: FontWeight;
  italic: boolean;
}

export interface IconStyle {
  size: IconSize;
  bordered: boolean;
  bgOpacity: number;
}

export interface Typography {
  header: TypographyStyle;
  content: TypographyStyle;
  icon: IconStyle;
}

export const DEFAULT_TYPOGRAPHY: Typography = {
  header: { family: "sans", size: "sm", weight: "semibold", italic: false },
  content: { family: "sans", size: "sm", weight: "normal", italic: false },
  icon: { size: "base", bordered: true, bgOpacity: 100 },
};
```

Replace with:

```ts
import { isTypefaceId, type Typeface } from "./typefaceCatalog";

export type FontSize = "xs" | "sm" | "base" | "lg";
export type FontWeight = "normal" | "medium" | "semibold" | "bold";

export type IconSize = "xs" | "sm" | "base" | "lg" | "xl";

export interface TypographyStyle {
  /** Catalog typeface ID. See src/lib/typefaceCatalog.ts. */
  typeface: Typeface;
  size: FontSize;
  weight: FontWeight;
  italic: boolean;
}

export interface IconStyle {
  size: IconSize;
  bordered: boolean;
  bgOpacity: number;
}

export interface Typography {
  header: TypographyStyle;
  content: TypographyStyle;
  icon: IconStyle;
}

export const DEFAULT_TYPOGRAPHY: Typography = {
  header: { typeface: "inter", size: "sm", weight: "semibold", italic: false },
  content: { typeface: "inter", size: "sm", weight: "normal", italic: false },
  icon: { size: "base", bordered: true, bgOpacity: 100 },
};
```

Note: the `import` goes at the top of the file with the other imports (or at the very top if there are none). The file currently has no top-level imports — add it as the first non-comment line.

Also remove the `FONT_FAMILIES` constant (`FAMILY_VALUES`) and any other `FontFamily` references. Use `Grep` to confirm: `grep -n "FontFamily\|FAMILY_VALUES" src/lib/messageRenderingConfig.ts`.

- [ ] **Step 5: Update the parser around line 800–810**

Find the `parseStyle` (or equivalent) function — around line 807 the `family:` line lives. The current line:

```ts
family: FAMILY_VALUES.includes(s.family as FontFamily) ? (s.family as FontFamily) : base.family,
```

Replace the `parseStyle` function body so it produces a `typeface` field with migration logic. Locate the function (search for `family: FAMILY_VALUES`) and rewrite it as:

```ts
function parseStyle(s: unknown, base: TypographyStyle): TypographyStyle {
  if (!isObject(s)) return base;
  const raw = s as Record<string, unknown>;

  // Migration path: legacy records have a `family` field. Map it to a
  // sensible default typeface so the user's intent (sans vs serif vs mono)
  // is preserved across the schema change.
  let typeface: Typeface = base.typeface;
  if (typeof raw.typeface === "string" && isTypefaceId(raw.typeface)) {
    typeface = raw.typeface;
  } else if (typeof raw.family === "string") {
    typeface =
      raw.family === "serif"
        ? "source-serif"
        : raw.family === "mono"
        ? "jetbrains-mono"
        : "inter";
  }

  return {
    typeface,
    size: SIZE_VALUES.includes(raw.size as FontSize) ? (raw.size as FontSize) : base.size,
    weight: WEIGHT_VALUES.includes(raw.weight as FontWeight)
      ? (raw.weight as FontWeight)
      : base.weight,
    italic: typeof raw.italic === "boolean" ? raw.italic : base.italic,
  };
}
```

The exact existing function signature may differ — read 30 lines around line 807 first and adapt. The key changes:
1. Drop `family` reads from `s`.
2. Add `typeface` reads; on miss, migrate from `family` if present.
3. Output object uses `typeface`, never `family`.

If `isObject` and `SIZE_VALUES` / `WEIGHT_VALUES` aren't yet defined, find their existing equivalents in the file and reuse them.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts`
Expected: PASS — all migration tests + existing tests pass.

- [ ] **Step 7: Run full type check**

Run: `npm run check`
Expected: FAIL — `typographyClasses.ts` and `TypographyEditor.tsx` still reference `style.family`. That's Task 3 / Task 9; leave those errors and proceed. (Do not fix here.)

- [ ] **Step 8: Commit**

```bash
git add src/lib/messageRenderingConfig.ts src/lib/__tests__/messageRenderingConfig.test.ts
git commit -m "feat(typography): replace family with typeface in MessageRenderingConfig

family: 'sans'|'serif'|'mono' is removed. typeface: Typeface (catalog
ID) takes its place. Parser migrates legacy records: sans → inter,
serif → source-serif, mono → jetbrains-mono. Unknown typeface values
fall back to inter.

Type-check is intentionally broken at this commit; downstream callers
update in subsequent commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Update `typographyClasses.ts`

**Files:**
- Modify: `src/lib/typographyClasses.ts`
- Test: `src/lib/__tests__/typographyClasses.test.ts`

`typographyClassNames` currently emits a Tailwind family class (`font-sans` / `font-serif` / `font-mono`). We drop that and add a separate `typographyFontFamily` helper that returns the catalog cssFamily string, suitable for inline `style={{ fontFamily }}`.

- [ ] **Step 1: Read existing test file**

Run: `cat src/lib/__tests__/typographyClasses.test.ts`

Note which assertions reference `font-sans` / `font-serif` / `font-mono` — those come out.

- [ ] **Step 2: Write the failing tests (replace family-class assertions, add fontFamily test)**

Replace the contents of `src/lib/__tests__/typographyClasses.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import {
  typographyClassNames,
  typographyFontFamily,
  headerClassNames,
  contentClassNames,
} from "../typographyClasses";
import { createDefaultConfig } from "../messageRenderingConfig";

describe("typographyClassNames", () => {
  it("emits size + weight + italic, no family class", () => {
    const result = typographyClassNames({
      typeface: "inter",
      size: "base",
      weight: "bold",
      italic: true,
    });
    expect(result).toBe("text-base font-bold italic");
    expect(result).not.toMatch(/font-sans|font-serif|font-mono/);
  });

  it("omits italic when false", () => {
    const result = typographyClassNames({
      typeface: "inter",
      size: "sm",
      weight: "normal",
      italic: false,
    });
    expect(result).toBe("text-sm font-normal");
  });
});

describe("typographyFontFamily", () => {
  it("returns the catalog cssFamily for known typefaces", () => {
    const inter = typographyFontFamily({
      typeface: "inter",
      size: "sm",
      weight: "normal",
      italic: false,
    });
    expect(inter).toMatch(/^"Inter",/);

    const geist = typographyFontFamily({
      typeface: "geist",
      size: "sm",
      weight: "normal",
      italic: false,
    });
    expect(geist).toMatch(/^"Geist",/);
  });
});

describe("headerClassNames / contentClassNames", () => {
  it("default config emits text-sm font-semibold for header (no italic)", () => {
    expect(headerClassNames(createDefaultConfig())).toBe("text-sm font-semibold");
  });

  it("default config emits text-sm font-normal for content", () => {
    expect(contentClassNames(createDefaultConfig())).toBe("text-sm font-normal");
  });
});
```

Note: existing test cases around icon helpers (`iconSizeClassName`, `iconWrapperClassName`, `iconWrapperStyle`) stay untouched. Append the new tests; remove or update only the family-related ones.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/typographyClasses.test.ts`
Expected: FAIL — `typographyFontFamily` is not exported; family class still emitted.

- [ ] **Step 4: Update `src/lib/typographyClasses.ts`**

Replace lines 1–48 of `src/lib/typographyClasses.ts`:

```ts
import type React from "react";
import type {
  FontSize,
  FontWeight,
  IconSize,
  MessageRenderingConfig,
  TypographyStyle,
} from "./messageRenderingConfig";
import { resolveTypeface } from "./typefaceCatalog";

const SIZE_CLASS: Record<FontSize, string> = {
  xs: "text-xs",
  sm: "text-sm",
  base: "text-base",
  lg: "text-lg",
};

const WEIGHT_CLASS: Record<FontWeight, string> = {
  normal: "font-normal",
  medium: "font-medium",
  semibold: "font-semibold",
  bold: "font-bold",
};

export function typographyClassNames(style: TypographyStyle): string {
  return [
    SIZE_CLASS[style.size],
    WEIGHT_CLASS[style.weight],
    style.italic ? "italic" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * CSS `font-family` value for a typography style. Pair with
 * `typographyClassNames` and apply via `style={{ fontFamily: ... }}`.
 */
export function typographyFontFamily(style: TypographyStyle): string {
  return resolveTypeface(style.typeface).cssFamily;
}

export function headerClassNames(config: MessageRenderingConfig): string {
  return typographyClassNames(config.typography.header);
}

export function contentClassNames(config: MessageRenderingConfig): string {
  return typographyClassNames(config.typography.content);
}
```

Lines 50+ (icon helpers) stay unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/typographyClasses.test.ts`
Expected: PASS.

- [ ] **Step 6: Run type check (still expected to fail in TypographyEditor)**

Run: `npm run check`
Expected: FAIL — only in `TypographyEditor.tsx` (still references `style.family`). All other files clean.

If errors appear in any file other than `TypographyEditor.tsx`, stop and investigate — there's a usage we missed in the file inventory.

- [ ] **Step 7: Commit**

```bash
git add src/lib/typographyClasses.ts src/lib/__tests__/typographyClasses.test.ts
git commit -m "refactor(typography): drop family Tailwind class, add typographyFontFamily

font-family is now driven by the typeface catalog, not the abstract
sans|serif|mono enum. typographyClassNames continues to emit
size/weight/italic classes; callers add inline fontFamily via the
new helper.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Bundle the 12 new font files + register `@font-face`

**Files:**
- Create: `src/assets/fonts/<id>/<id>.woff2` × 12
- Create: `src/assets/fonts/<id>/LICENSE.txt` × 12
- Modify: `src/styles.css` (add 12 `@font-face` blocks; rework `--font-sans`)

All fonts are SIL OFL 1.1 licensed. Download URLs below point to the foundries' GitHub release assets — these are stable raw URLs.

- [ ] **Step 1: Download font files**

Run from the repo root:

```bash
mkdir -p src/assets/fonts/{geist,plus-jakarta,dm-sans,plex-sans,oxanium,plex-serif,source-serif,ia-quattro,plex-mono,jetbrains-mono,geist-mono,ia-duospace}

# Geist (variable woff2)
curl -L -o src/assets/fonts/geist/geist.woff2 \
  https://github.com/vercel/geist-font/raw/main/packages/next/dist/fonts/geist-sans/Geist-Variable.woff2
curl -L -o src/assets/fonts/geist-mono/geist-mono.woff2 \
  https://github.com/vercel/geist-font/raw/main/packages/next/dist/fonts/geist-mono/GeistMono-Variable.woff2

# Plus Jakarta Sans (variable woff2 from Google Fonts)
curl -L -o src/assets/fonts/plus-jakarta/plus-jakarta.woff2 \
  https://github.com/google/fonts/raw/main/ofl/plusjakartasans/PlusJakartaSans%5Bwght%5D.woff2 \
  || curl -L -o src/assets/fonts/plus-jakarta/plus-jakarta.ttf \
       https://github.com/google/fonts/raw/main/ofl/plusjakartasans/PlusJakartaSans%5Bwght%5D.ttf

# DM Sans (variable from Google Fonts)
curl -L -o src/assets/fonts/dm-sans/dm-sans.ttf \
  https://github.com/google/fonts/raw/main/ofl/dmsans/DMSans%5Bopsz%2Cwght%5D.ttf

# IBM Plex Sans / Serif / Mono (variable woff2 from IBM/plex)
curl -L -o src/assets/fonts/plex-sans/plex-sans.woff2 \
  https://github.com/IBM/plex/raw/master/packages/plex-sans-var/fonts/complete/woff2/IBMPlexSansVar-Roman.woff2
curl -L -o src/assets/fonts/plex-serif/plex-serif.woff2 \
  https://github.com/IBM/plex/raw/master/packages/plex-serif/fonts/complete/woff2/IBMPlexSerif-Regular.woff2
curl -L -o src/assets/fonts/plex-mono/plex-mono.woff2 \
  https://github.com/IBM/plex/raw/master/packages/plex-mono/fonts/complete/woff2/IBMPlexMono-Regular.woff2

# Oxanium (variable from Google Fonts)
curl -L -o src/assets/fonts/oxanium/oxanium.ttf \
  https://github.com/google/fonts/raw/main/ofl/oxanium/Oxanium%5Bwght%5D.ttf

# Source Serif 4 (variable woff2 from adobe-fonts/source-serif)
curl -L -o src/assets/fonts/source-serif/source-serif.woff2 \
  https://github.com/adobe-fonts/source-serif/raw/release/WOFF2/VAR/SourceSerif4Variable-Roman.otf.woff2

# JetBrains Mono (variable woff2 from JetBrains)
curl -L -o src/assets/fonts/jetbrains-mono/jetbrains-mono.woff2 \
  https://github.com/JetBrains/JetBrainsMono/raw/master/fonts/variable/JetBrainsMono%5Bwght%5D.woff2

# iA Writer Quattro / Duospace (TTF from iaolo/iA-Fonts)
curl -L -o src/assets/fonts/ia-quattro/ia-quattro.ttf \
  https://github.com/iaolo/iA-Fonts/raw/master/iA%20Writer%20Quattro/Variable/iAWriterQuattroV.ttf
curl -L -o src/assets/fonts/ia-duospace/ia-duospace.ttf \
  https://github.com/iaolo/iA-Fonts/raw/master/iA%20Writer%20Duospace/Variable/iAWriterDuospaceV.ttf
```

Verify files exist and are non-empty:

```bash
ls -lh src/assets/fonts/*/  | grep -E '\.(woff2|ttf)$'
```

Expected: 12 lines, each file >40KB. If any download produced a tiny file (<5KB) or HTML, the URL needs to be re-checked — try `gh api` form or the foundry's release page directly.

- [ ] **Step 2: Add license files**

For each foundry, fetch the LICENSE/OFL.txt and store at `src/assets/fonts/<id>/LICENSE.txt`. Most foundries ship a single `OFL.txt`; copy it into each per-typeface directory it applies to.

```bash
# Geist (Geist + Geist Mono share the OFL)
curl -L -o /tmp/geist-OFL.txt https://raw.githubusercontent.com/vercel/geist-font/main/LICENSE.TXT
cp /tmp/geist-OFL.txt src/assets/fonts/geist/LICENSE.txt
cp /tmp/geist-OFL.txt src/assets/fonts/geist-mono/LICENSE.txt

# Plus Jakarta Sans
curl -L -o src/assets/fonts/plus-jakarta/LICENSE.txt \
  https://raw.githubusercontent.com/google/fonts/main/ofl/plusjakartasans/OFL.txt

# DM Sans
curl -L -o src/assets/fonts/dm-sans/LICENSE.txt \
  https://raw.githubusercontent.com/google/fonts/main/ofl/dmsans/OFL.txt

# IBM Plex (one OFL covers all three)
curl -L -o /tmp/plex-OFL.txt https://raw.githubusercontent.com/IBM/plex/master/LICENSE.txt
cp /tmp/plex-OFL.txt src/assets/fonts/plex-sans/LICENSE.txt
cp /tmp/plex-OFL.txt src/assets/fonts/plex-serif/LICENSE.txt
cp /tmp/plex-OFL.txt src/assets/fonts/plex-mono/LICENSE.txt

# Oxanium
curl -L -o src/assets/fonts/oxanium/LICENSE.txt \
  https://raw.githubusercontent.com/google/fonts/main/ofl/oxanium/OFL.txt

# Source Serif 4
curl -L -o src/assets/fonts/source-serif/LICENSE.txt \
  https://raw.githubusercontent.com/adobe-fonts/source-serif/release/LICENSE.md

# JetBrains Mono
curl -L -o src/assets/fonts/jetbrains-mono/LICENSE.txt \
  https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/OFL.txt

# iA Writer fonts (Quattro + Duospace share the OFL)
curl -L -o /tmp/ia-OFL.txt https://raw.githubusercontent.com/iaolo/iA-Fonts/master/LICENSE
cp /tmp/ia-OFL.txt src/assets/fonts/ia-quattro/LICENSE.txt
cp /tmp/ia-OFL.txt src/assets/fonts/ia-duospace/LICENSE.txt
```

Verify each LICENSE.txt is >500 bytes:

```bash
find src/assets/fonts -name LICENSE.txt -exec wc -c {} +
```

- [ ] **Step 3: Add `@font-face` declarations to `src/styles.css`**

Find the existing Inter `@font-face` block (line 49–55) and insert 12 new blocks immediately after it. Use the `.woff2` extension when the file you downloaded is woff2; use `.ttf` and `format("truetype-variations")` when only TTF was available. Match the file extensions you actually have on disk.

```css
/* Geist */
@font-face {
  font-family: 'Geist';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('/src/assets/fonts/geist/geist.woff2') format('woff2-variations');
}

@font-face {
  font-family: 'Geist Mono';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('/src/assets/fonts/geist-mono/geist-mono.woff2') format('woff2-variations');
}

/* Plus Jakarta Sans */
@font-face {
  font-family: 'Plus Jakarta Sans';
  font-style: normal;
  font-weight: 200 800;
  font-display: swap;
  src: url('/src/assets/fonts/plus-jakarta/plus-jakarta.ttf') format('truetype-variations');
}

/* DM Sans */
@font-face {
  font-family: 'DM Sans';
  font-style: normal;
  font-weight: 100 1000;
  font-display: swap;
  src: url('/src/assets/fonts/dm-sans/dm-sans.ttf') format('truetype-variations');
}

/* IBM Plex Sans */
@font-face {
  font-family: 'IBM Plex Sans';
  font-style: normal;
  font-weight: 100 700;
  font-display: swap;
  src: url('/src/assets/fonts/plex-sans/plex-sans.woff2') format('woff2-variations');
}

/* IBM Plex Serif */
@font-face {
  font-family: 'IBM Plex Serif';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/src/assets/fonts/plex-serif/plex-serif.woff2') format('woff2');
}

/* IBM Plex Mono */
@font-face {
  font-family: 'IBM Plex Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/src/assets/fonts/plex-mono/plex-mono.woff2') format('woff2');
}

/* Oxanium */
@font-face {
  font-family: 'Oxanium';
  font-style: normal;
  font-weight: 200 800;
  font-display: swap;
  src: url('/src/assets/fonts/oxanium/oxanium.ttf') format('truetype-variations');
}

/* Source Serif 4 */
@font-face {
  font-family: 'Source Serif 4';
  font-style: normal;
  font-weight: 200 900;
  font-display: swap;
  src: url('/src/assets/fonts/source-serif/source-serif.woff2') format('woff2-variations');
}

/* JetBrains Mono */
@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 100 800;
  font-display: swap;
  src: url('/src/assets/fonts/jetbrains-mono/jetbrains-mono.woff2') format('woff2-variations');
}

/* iA Writer Quattro */
@font-face {
  font-family: 'iA Writer Quattro';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('/src/assets/fonts/ia-quattro/ia-quattro.ttf') format('truetype-variations');
}

/* iA Writer Duospace */
@font-face {
  font-family: 'iA Writer Duospace';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('/src/assets/fonts/ia-duospace/ia-duospace.ttf') format('truetype-variations');
}
```

- [ ] **Step 4: Add `--app-font-stack` indirection for `--font-sans`**

In `src/styles.css`, find the `--font-sans` definition (around line 126):

```css
--font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
```

Replace with:

```css
--font-sans: var(--app-font-stack, "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif);
```

The `AppFontProvider` (Task 5) sets `--app-font-stack` on `:root` to override this, but pre-mount and on first paint `--font-sans` resolves to the Inter fallback — same as today.

- [ ] **Step 5: Build to verify CSS compiles + fonts resolve**

Run: `npm run build`
Expected: PASS — `vite build` succeeds; the `dist/assets/` output should now include 12 new font files alongside `Inter-c8O0ljhh.ttf`.

If a `@font-face` references a path Vite can't resolve, the build fails with "Could not load /src/assets/fonts/...". Re-check the file exists at that path.

- [ ] **Step 6: Commit**

```bash
git add src/assets/fonts src/styles.css
git commit -m "feat(typography): bundle 12 new typefaces + @font-face declarations

Geist, Plus Jakarta Sans, DM Sans, IBM Plex (Sans/Serif/Mono),
Oxanium, Source Serif 4, JetBrains Mono, Geist Mono, iA Writer
Quattro, iA Writer Duospace. All SIL OFL 1.1; LICENSE.txt shipped
per typeface directory.

--font-sans now reads --app-font-stack first with the existing
Inter stack as fallback. The AppFontProvider lands next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `AppFontProvider` context

**Files:**
- Create: `src/contexts/AppFontContext.tsx`
- Create: `src/contexts/__tests__/AppFontContext.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/contexts/__tests__/AppFontContext.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import React from "react";
import { AppFontProvider, useAppFont } from "../AppFontContext";

vi.mock("@/lib/api", () => ({
  api: {
    getSetting: vi.fn(),
    saveSetting: vi.fn(),
  },
}));

import { api } from "@/lib/api";

const Probe: React.FC<{ onState: (s: { font: string; setFont: (f: string) => void }) => void }> = ({
  onState,
}) => {
  const ctx = useAppFont();
  onState({ font: ctx.appFont, setFont: ctx.setAppFont });
  return null;
};

describe("AppFontProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.style.removeProperty("--app-font-stack");
  });

  it("defaults to inter when no setting is stored", async () => {
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    let captured = { font: "", setFont: (_: string) => {} };

    render(
      <AppFontProvider>
        <Probe onState={(s) => (captured = s)} />
      </AppFontProvider>,
    );

    await waitFor(() => expect(captured.font).toBe("inter"));
  });

  it("loads the stored value and applies --app-font-stack", async () => {
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue("geist");
    let captured = { font: "", setFont: (_: string) => {} };

    render(
      <AppFontProvider>
        <Probe onState={(s) => (captured = s)} />
      </AppFontProvider>,
    );

    await waitFor(() => expect(captured.font).toBe("geist"));
    expect(document.documentElement.style.getPropertyValue("--app-font-stack")).toMatch(/Geist/);
  });

  it("falls back to inter when the stored value is invalid", async () => {
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue("not-a-real-font");
    let captured = { font: "", setFont: (_: string) => {} };

    render(
      <AppFontProvider>
        <Probe onState={(s) => (captured = s)} />
      </AppFontProvider>,
    );

    await waitFor(() => expect(captured.font).toBe("inter"));
  });

  it("setAppFont persists and re-applies the CSS variable", async () => {
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue("inter");
    (api.saveSetting as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    let captured = { font: "", setFont: (_: string) => {} };

    render(
      <AppFontProvider>
        <Probe onState={(s) => (captured = s)} />
      </AppFontProvider>,
    );

    await waitFor(() => expect(captured.font).toBe("inter"));

    await act(async () => {
      await captured.setFont("plus-jakarta");
    });

    expect(api.saveSetting).toHaveBeenCalledWith("app_font", "plus-jakarta");
    expect(document.documentElement.style.getPropertyValue("--app-font-stack")).toMatch(
      /Plus Jakarta Sans/,
    );
  });

  it("ignores invalid setAppFont values", async () => {
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue("inter");
    let captured = { font: "", setFont: (_: string) => {} };

    render(
      <AppFontProvider>
        <Probe onState={(s) => (captured = s)} />
      </AppFontProvider>,
    );

    await waitFor(() => expect(captured.font).toBe("inter"));

    await act(async () => {
      await captured.setFont("nonsense");
    });

    expect(captured.font).toBe("inter");
    expect(api.saveSetting).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/contexts/__tests__/AppFontContext.test.tsx`
Expected: FAIL — `AppFontContext` does not exist.

- [ ] **Step 3: Implement the provider**

Create `src/contexts/AppFontContext.tsx`:

```tsx
import React, { createContext, useState, useContext, useCallback, useEffect } from "react";
import { api } from "@/lib/api";
import {
  isTypefaceId,
  resolveTypeface,
  type Typeface,
} from "@/lib/typefaceCatalog";

const APP_FONT_STORAGE_KEY = "app_font";
const DEFAULT_APP_FONT: Typeface = "inter";

interface AppFontContextType {
  appFont: Typeface;
  setAppFont: (next: string) => Promise<void>;
  isLoading: boolean;
}

const AppFontContext = createContext<AppFontContextType | undefined>(undefined);

function applyAppFont(typeface: Typeface): void {
  const meta = resolveTypeface(typeface);
  document.documentElement.style.setProperty("--app-font-stack", meta.cssFamily);
}

export const AppFontProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [appFont, setAppFontState] = useState<Typeface>(DEFAULT_APP_FONT);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const raw = await api.getSetting(APP_FONT_STORAGE_KEY);
        const next: Typeface = isTypefaceId(raw) ? raw : DEFAULT_APP_FONT;
        if (cancelled) return;
        setAppFontState(next);
        applyAppFont(next);
      } catch (error) {
        console.error("Failed to load app font setting:", error);
        if (!cancelled) applyAppFont(DEFAULT_APP_FONT);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const setAppFont = useCallback(async (next: string) => {
    if (!isTypefaceId(next)) return;
    try {
      setAppFontState(next);
      applyAppFont(next);
      await api.saveSetting(APP_FONT_STORAGE_KEY, next);
    } catch (error) {
      console.error("Failed to save app font setting:", error);
    }
  }, []);

  return (
    <AppFontContext.Provider value={{ appFont, setAppFont, isLoading }}>
      {children}
    </AppFontContext.Provider>
  );
};

export const useAppFont = (): AppFontContextType => {
  const ctx = useContext(AppFontContext);
  if (!ctx) {
    throw new Error("useAppFont must be used within an AppFontProvider");
  }
  return ctx;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/contexts/__tests__/AppFontContext.test.tsx`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/contexts/AppFontContext.tsx src/contexts/__tests__/AppFontContext.test.tsx
git commit -m "feat(typography): add AppFontProvider context

Loads app_font from settings, applies --app-font-stack on
documentElement, validates stored values against the typeface
catalog (falls back to inter), persists via api.saveSetting.

Mirrors ThemeContext's shape — boot-time load, async setter,
isLoading flag.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Wire `AppFontProvider` into the provider tree

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Find the existing provider tree**

Run: `grep -n "ThemeProvider\|AccountsContext\|TabContext" src/App.tsx | head -20`

Look for how `ThemeProvider` wraps the app and add `AppFontProvider` adjacent to it.

- [ ] **Step 2: Add the import + wrap the tree**

In `src/App.tsx`, add the import alongside the other context imports:

```tsx
import { AppFontProvider } from "./contexts/AppFontContext";
```

Wrap the existing tree so `AppFontProvider` sits at the same level as `ThemeProvider` (either inside or outside; order doesn't matter — they're independent). Concrete example, inside the existing tree:

```tsx
<ThemeProvider>
  <AppFontProvider>
    {/* existing children */}
  </AppFontProvider>
</ThemeProvider>
```

The exact existing structure may differ — read 30 lines around the `<ThemeProvider>` opener to see the nesting and place `<AppFontProvider>` such that every descendant that might call `useAppFont()` is inside it. (All settings panels qualify.)

- [ ] **Step 3: Type check + build**

Run: `npm run check && npm run build`
Expected: PASS for both. (If `TypographyEditor.tsx` still has `style.family` errors from Task 2, that's expected — it gets fixed in Task 9.)

If `npm run check` reports errors only in `TypographyEditor.tsx`, proceed. Otherwise stop and investigate.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat(typography): mount AppFontProvider in the provider tree

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `<AppFontPicker>` settings card

**Files:**
- Create: `src/components/settings-panels/AppFontPicker.tsx`
- Modify: `src/components/settings-panels/AppearanceSettings.tsx`

- [ ] **Step 1: Implement the picker component**

Create `src/components/settings-panels/AppFontPicker.tsx`:

```tsx
import React from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppFont } from "@/contexts/AppFontContext";
import { APP_FONT_CHOICES, type Typeface } from "@/lib/typefaceCatalog";

export const AppFontPicker: React.FC = () => {
  const { appFont, setAppFont, isLoading } = useAppFont();

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-heading-4">App font</h3>
        <p className="text-caption text-muted-foreground mt-1">
          Global UI typeface — affects sidebar, settings, dialogs, and project list.
          Chat fonts are configured separately in Typography below.
        </p>
      </div>
      <div className="max-w-xs">
        <Label className="mb-1 block text-caption">Typeface</Label>
        <Select
          value={appFont}
          onValueChange={(v) => setAppFont(v as Typeface)}
          disabled={isLoading}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {APP_FONT_CHOICES.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                <span style={{ fontFamily: t.cssFamily }}>{t.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Mount the picker in `AppearanceSettings.tsx`**

In `src/components/settings-panels/AppearanceSettings.tsx`, add the import near the top:

```tsx
import { AppFontPicker } from "../AppFontPicker";
```

Then insert a new `<Card>` as the first child of the returned `<div className="space-y-6">` block (immediately above the `{/* Master-detail: tree + editor */}` card):

```tsx
<Card className="p-6">
  <AppFontPicker />
</Card>
```

- [ ] **Step 3: Type check + build**

Run: `npm run check && npm run build`
Expected: PASS (still ignoring `TypographyEditor.tsx` errors per Task 2).

- [ ] **Step 4: Manual smoke test (optional but recommended)**

Run: `npm start` (in another terminal). Open Settings → Appearance, change the App font dropdown, confirm the rest of the app's UI text re-renders in the chosen typeface immediately. Close the app.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings-panels/AppFontPicker.tsx src/components/settings-panels/AppearanceSettings.tsx
git commit -m "feat(typography): add App font picker card

Global typeface dropdown at the top of Appearance settings. Each
SelectItem previews the typeface inline. Reads/writes via
useAppFont(); persists immediately.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `<TypefacePicker>` component for chat header / content

**Files:**
- Create: `src/components/settings-panels/appearance/TypefacePicker.tsx`

- [ ] **Step 1: Implement the picker**

Create `src/components/settings-panels/appearance/TypefacePicker.tsx`:

```tsx
import React from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TYPEFACE_CATALOG, type FamilyTag, type Typeface } from "@/lib/typefaceCatalog";

interface TypefacePickerProps {
  label?: string;
  value: Typeface;
  onChange: (next: Typeface) => void;
}

const GROUP_ORDER: { tag: FamilyTag; label: string }[] = [
  { tag: "sans", label: "Sans" },
  { tag: "display-sans", label: "Display" },
  { tag: "serif", label: "Serif" },
  { tag: "humanist", label: "Humanist" },
  { tag: "mono", label: "Mono" },
];

export const TypefacePicker: React.FC<TypefacePickerProps> = ({
  label = "Font",
  value,
  onChange,
}) => {
  return (
    <div>
      <Label className="mb-1 block text-caption">{label}</Label>
      <Select value={value} onValueChange={(v) => onChange(v as Typeface)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GROUP_ORDER.map((group) => {
            const items = TYPEFACE_CATALOG.filter((t) => t.family === group.tag);
            if (items.length === 0) return null;
            return (
              <SelectGroup key={group.tag}>
                <SelectLabel>{group.label}</SelectLabel>
                {items.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    <span style={{ fontFamily: t.cssFamily }}>{t.label}</span>
                  </SelectItem>
                ))}
              </SelectGroup>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
};
```

- [ ] **Step 2: Verify Radix `<Select>` exports `SelectGroup` and `SelectLabel`**

Run: `grep -n "SelectGroup\|SelectLabel" src/components/ui/select.tsx`
Expected: both names appear in the file's exports. If they don't, add wrapper exports based on Radix's primitives following the pattern of the existing `SelectItem`/`SelectTrigger` exports — this is a five-minute add. (shadcn-ui's standard `select.tsx` re-exports both; if they're missing, the file was customized.)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS — picker compiles. (Not yet rendered anywhere; Task 9 wires it in.)

- [ ] **Step 4: Commit**

```bash
git add src/components/settings-panels/appearance/TypefacePicker.tsx
git commit -m "feat(typography): add TypefacePicker for grouped typeface selection

Radix Select with SelectGroups for Sans / Display / Serif / Humanist
/ Mono. Each item previews its own typeface inline. Used by Header
and Content columns in the redesigned Typography card.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Rewrite `<TypographyEditor>` to a 3-column layout

**Files:**
- Modify: `src/components/settings-panels/appearance/TypographyEditor.tsx`

This is the biggest single edit. The current file is 211 lines; the rewrite reduces it to ~180 lines (less abstract `family` constant; cleaner column helpers).

- [ ] **Step 1: Replace the file body with the new layout**

Overwrite `src/components/settings-panels/appearance/TypographyEditor.tsx` with:

```tsx
import React from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  FontSize,
  FontWeight,
  IconSize,
  Typography,
  TypographyStyle,
} from "@/lib/messageRenderingConfig";
import type { Typeface } from "@/lib/typefaceCatalog";
import { TypefacePicker } from "./TypefacePicker";

interface TypographyEditorProps {
  typography: Typography;
  onChange: (next: Typography) => void;
}

const SIZES: { value: FontSize; label: string }[] = [
  { value: "xs", label: "Extra small" },
  { value: "sm", label: "Small" },
  { value: "base", label: "Base" },
  { value: "lg", label: "Large" },
];

const WEIGHTS: { value: FontWeight; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "medium", label: "Medium" },
  { value: "semibold", label: "Semibold" },
  { value: "bold", label: "Bold" },
];

const ICON_SIZES: { value: IconSize; label: string }[] = [
  { value: "xs", label: "Extra small" },
  { value: "sm", label: "Small" },
  { value: "base", label: "Base" },
  { value: "lg", label: "Large" },
  { value: "xl", label: "Extra large" },
];

interface TextColumnProps {
  title: string;
  description: string;
  style: TypographyStyle;
  italicId: string;
  onChange: (next: TypographyStyle) => void;
}

const TextColumn: React.FC<TextColumnProps> = ({
  title,
  description,
  style,
  italicId,
  onChange,
}) => (
  <div className="space-y-3">
    <div>
      <Label>{title}</Label>
      <p className="text-caption text-muted-foreground mt-1">{description}</p>
    </div>
    <TypefacePicker
      value={style.typeface}
      onChange={(next: Typeface) => onChange({ ...style, typeface: next })}
    />
    <div>
      <Label className="mb-1 block text-caption">Size</Label>
      <Select
        value={style.size}
        onValueChange={(v) => onChange({ ...style, size: v as FontSize })}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SIZES.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
    <div>
      <Label className="mb-1 block text-caption">Weight</Label>
      <Select
        value={style.weight}
        onValueChange={(v) => onChange({ ...style, weight: v as FontWeight })}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WEIGHTS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
    <div className="flex items-center gap-2">
      <Switch
        id={italicId}
        checked={style.italic}
        onCheckedChange={(v) => onChange({ ...style, italic: v })}
      />
      <Label htmlFor={italicId} className="cursor-pointer">
        Italic
      </Label>
    </div>
  </div>
);

interface IconColumnProps {
  icon: Typography["icon"];
  onChange: (next: Typography["icon"]) => void;
}

const IconColumn: React.FC<IconColumnProps> = ({ icon, onChange }) => (
  <div className="space-y-3">
    <div>
      <Label>Card icon</Label>
      <p className="text-caption text-muted-foreground mt-1">
        Size and chrome of the colored icon on the left of each card. Independent from text.
      </p>
    </div>
    <div>
      <Label className="mb-1 block text-caption">Size</Label>
      <Select
        value={icon.size}
        onValueChange={(v) => onChange({ ...icon, size: v as IconSize })}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ICON_SIZES.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
    <div className="flex items-center gap-2">
      <Switch
        id="icon-bordered"
        checked={icon.bordered}
        onCheckedChange={(v) => onChange({ ...icon, bordered: v })}
      />
      <Label htmlFor="icon-bordered" className="cursor-pointer">
        Bordered chip
      </Label>
    </div>
    <div className={cn("flex items-center gap-3", !icon.bordered && "opacity-50")}>
      <Label htmlFor="icon-bg-opacity" className="shrink-0 text-caption">
        Bg opacity
      </Label>
      <input
        id="icon-bg-opacity"
        type="range"
        min={0}
        max={100}
        step={5}
        value={icon.bgOpacity}
        onChange={(e) => onChange({ ...icon, bgOpacity: parseInt(e.target.value, 10) })}
        disabled={!icon.bordered}
        className="flex-1 cursor-pointer disabled:cursor-not-allowed accent-foreground"
      />
      <span className="font-mono text-caption text-muted-foreground w-10 text-right">
        {icon.bgOpacity}%
      </span>
    </div>
  </div>
);

export const TypographyEditor: React.FC<TypographyEditorProps> = ({ typography, onChange }) => {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-heading-4">Typography</h3>
        <p className="text-caption text-muted-foreground mt-1">
          Per-element typeface, size, and weight for chat messages. Pick any bundled
          font from the Header and Content columns; the App font (above) controls the
          rest of the app.
        </p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <TextColumn
          title="Header"
          description={'The small label row above a card (e.g. "You", "Claude Code").'}
          style={typography.header}
          italicId="typography-header-italic"
          onChange={(next) => onChange({ ...typography, header: next })}
        />
        <TextColumn
          title="Content"
          description="User message body text. (Assistant markdown bodies keep their prose defaults.)"
          style={typography.content}
          italicId="typography-content-italic"
          onChange={(next) => onChange({ ...typography, content: next })}
        />
        <IconColumn
          icon={typography.icon}
          onChange={(next) => onChange({ ...typography, icon: next })}
        />
      </div>
    </div>
  );
};
```

Note: the `Bg opacity` slider's left label has been shortened to fit the narrower column (was `Background opacity` in the old layout — too wide for a 3-up grid).

- [ ] **Step 2: Type check + build**

Run: `npm run check && npm run build`
Expected: PASS for both. The `style.family` errors from Task 2 are now resolved.

If any other file still references `style.family` or `FontFamily`, the type checker will flag it now. Fix those by switching to `style.typeface` + `typographyFontFamily()` and re-run.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — 1395+ tests, 0 failures.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings-panels/appearance/TypographyEditor.tsx
git commit -m "feat(typography): rewrite Typography card to 3-column layout

Header column / Content column / Card-icon column. Each text column
gets a TypefacePicker on top, replacing the old abstract sans|serif|mono
family selector.

The 'Background opacity' slider label is shortened to 'Bg opacity'
to fit the narrower column.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Apply inline `fontFamily` in `<SamplePreview>` and `<TurnPreview>`

**Files:**
- Modify: `src/components/settings-panels/appearance/SamplePreview.tsx`
- Modify: `src/components/settings-panels/appearance/TurnPreview.tsx`

These two preview components render header/content text with the typography styles. They previously got the family from Tailwind classes (now removed). They need an inline `style={{ fontFamily }}`.

- [ ] **Step 1: Patch `SamplePreview.tsx`**

Read the file: `cat src/components/settings-panels/appearance/SamplePreview.tsx`

Find places where `headerClassNames(...)` or `typographyClassNames(typography.header)` (or `.content`) is applied to a JSX element. For each, add an inline style. Example transformation:

```tsx
// Before
<div className={typographyClassNames(typography.header)}>{headerLabel}</div>

// After
<div
  className={typographyClassNames(typography.header)}
  style={{ fontFamily: typographyFontFamily(typography.header) }}
>
  {headerLabel}
</div>
```

Add the import at the top of the file:

```tsx
import { typographyFontFamily, typographyClassNames } from "@/lib/typographyClasses";
```

(if `typographyClassNames` is already imported, just add `typographyFontFamily` alongside it.)

- [ ] **Step 2: Patch `TurnPreview.tsx`**

Same treatment. Read the file first, identify every place a typography style is applied, and add the inline `fontFamily`.

- [ ] **Step 3: Sweep for any other consumers**

Run: `grep -rn "typographyClassNames\|headerClassNames\|contentClassNames" src/`

Every match that wraps a JSX element should also get the inline `fontFamily`. Likely candidates: any kind/card components in `src/components/` that render the header label or message body. Patch each.

- [ ] **Step 4: Type check + build + tests**

Run: `npm run check && npm run build && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -u src/
git commit -m "feat(typography): apply typeface fontFamily inline at every typography callsite

SamplePreview, TurnPreview, and any chat-rendering callsites that
emit header/content classes now also set style={{ fontFamily }} from
the catalog. The Tailwind family class is gone (Task 3); this is
how the per-element typeface choice actually reaches the DOM.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Manual end-to-end smoke + CHANGELOG + final verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Manual end-to-end smoke**

Run: `npm start`

Verify:
1. Settings → Appearance shows the new "App font" card at the top.
2. App-font dropdown previews each typeface inline.
3. Selecting "Geist" makes the entire app UI (sidebar, project list, settings labels) re-render in Geist immediately.
4. Restart the app — the font choice persists.
5. Typography card now has 3 columns: Header / Content / Card icon. On a wide window all three are side-by-side; on a narrow window they stack.
6. Each text column has a Font picker at the top, grouped by Sans / Display / Serif / Humanist / Mono.
7. Selecting a different font for Header changes only the chat message header text; selecting a different font for Content changes only the message body text. The two are independent.
8. Selecting Oxanium for Header gives a clearly different (geometric/sci-fi) look — sanity check that the new fonts actually loaded.
9. Card icon column still works (size, bordered, bg opacity slider).

Close the app.

- [ ] **Step 2: Run full verification gate**

Run: `npm run check && npm run build && npm run test:coverage`

Expected: all green; coverage ≥80% lines.

- [ ] **Step 3: Update CHANGELOG**

Open `CHANGELOG.md` and find the existing `## [0.4.18] — 2026-05-09` entry. Expand it from the SDK-only patch to include the new feature.

Replace:

```markdown
## [0.4.18] — 2026-05-09

Patch release: SDK parity bump only. `@anthropic-ai/claude-agent-sdk` 0.2.137 → 0.2.138, which tracks Claude Code v2.1.138 (internal fixes upstream, no API surface changes). No transitive dependency churn. Verification gate (`npm run check`, `npm run build`, `npm run test:coverage`) passes; coverage holds at 81.04% lines.

Installers remain **unsigned**.

### Changed

- **`@anthropic-ai/claude-agent-sdk` 0.2.137 → 0.2.138.** Parity with Claude Code v2.1.138 (internal fixes only per upstream release notes). `@anthropic-ai/sdk` (`^0.81.0`), `@modelcontextprotocol/sdk` (`^1.29.0`), and `zod` (`^4.0.0` peer) constraints unchanged.
```

With:

```markdown
## [0.4.18] — 2026-05-09

Two things land together: an SDK parity bump, and a typography overhaul that introduces a curated 13-typeface bundle, a global App-font picker, and per-element typeface pickers on the chat surface (replacing the old abstract sans|serif|mono toggle). The Typography settings card is reorganized into a 3-column layout (Header / Content / Card icon) — same controls, far less wasted vertical space.

Installers remain **unsigned**.

### Added

- **App-font picker.** New "App font" card at the top of Settings → Appearance. Single dropdown driving `--font-sans` globally for the whole UI (sidebar, settings, project list, dialogs). Six choices: Inter (default), Geist, Plus Jakarta Sans, DM Sans, IBM Plex Sans, Oxanium. Persists immediately via `app_font` setting; mirrors `ThemeContext`'s shape with a new `AppFontProvider`.
- **Per-element typeface pickers in the Typography card.** Header column and Content column each get a Font dropdown grouped by family tag (Sans / Display / Serif / Humanist / Mono). 13 bundled typefaces total: the 6 sans-tagged App fonts plus Source Serif 4, IBM Plex Serif, iA Writer Quattro, IBM Plex Mono, JetBrains Mono, Geist Mono, iA Writer Duospace.
- **Typeface catalog module** (`src/lib/typefaceCatalog.ts`). Single source of truth for typeface metadata (id, label, CSS family string, family tag). Drives both pickers and the schema migration.

### Changed

- **`@anthropic-ai/claude-agent-sdk` 0.2.137 → 0.2.138.** Parity with Claude Code v2.1.138 (internal fixes only per upstream release notes). `@anthropic-ai/sdk` (`^0.81.0`), `@modelcontextprotocol/sdk` (`^1.29.0`), and `zod` (`^4.0.0` peer) constraints unchanged.
- **`MessageRenderingConfig.typography.{header,content}.family` replaced with `.typeface`.** The abstract `'sans' | 'serif' | 'mono'` enum is gone; each element picks a concrete typeface from the catalog. Parser migrates legacy records: `sans → inter`, `serif → source-serif`, `mono → jetbrains-mono`. Unknown typeface IDs fall back to `inter`.
- **Typography card layout rewritten** from a vertically stacked StyleRow pattern to a 3-column grid (Header / Content / Card icon). On narrow widths the columns collapse to a single column. The "Background opacity" slider label is shortened to "Bg opacity" to fit the narrower column.

### Removed

- **`FontFamily` type and `FAMILY_VALUES` constant** from `messageRenderingConfig.ts`. The abstract sans/serif/mono enum is no longer part of the public surface.
- **`font-sans` / `font-serif` / `font-mono` Tailwind class emission** from `typographyClassNames()`. Family is now applied via inline `style={{ fontFamily }}` from the catalog. The new `typographyFontFamily()` helper produces the value.
```

- [ ] **Step 4: Final verification + commit + Electron rebuild**

```bash
npm run check && npm run build && npm run test:coverage
git add CHANGELOG.md
git commit -m "docs: expand v0.4.18 CHANGELOG with typography feature

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
npm run rebuild:electron
```

Expected:
- Verification gate: all green; coverage ≥80%.
- Final tree state: `main` has SDK bump + version bump + design + spec move + ~10 feature commits + CHANGELOG update.
- Electron native modules at NMV 145 (rebuild log line: `verified: native modules at NMV 145 (Electron ABI)`).

Stop here. The release re-cut (delete draft, `npm run make`, force-push tag, new draft) is owned by the `omnifex-release` skill and runs as a separate top-level operation.

---

## Self-review (plan author)

**Spec coverage check:**

- ✅ Goals 1–6 from the spec → covered by Tasks 1–11.
- ✅ Catalog of 13 typefaces → Task 1 (metadata) + Task 4 (files).
- ✅ App font picker → Task 7.
- ✅ Per-element chat typeface pickers → Tasks 8 + 9.
- ✅ 3-column layout rewrite → Task 9.
- ✅ Schema migration → Task 2.
- ✅ Persistence via `api.getSetting`/`api.saveSetting` → Tasks 5 + 7.
- ✅ Tests for catalog, migration, AppFontProvider → Tasks 1, 2, 5.
- ✅ Inline fontFamily at consumers → Task 10.
- ✅ Bundle add of new fonts → Task 4.
- ✅ Release coordination decision → captured in spec; `omnifex-release` skill handles re-cut after this plan completes.

**Type consistency:**

- ✅ `Typeface` type used identically in catalog (Task 1), schema (Task 2), classes module (Task 3), provider (Task 5), and pickers (Tasks 7–9).
- ✅ `TypographyStyle.typeface` is the only post-migration field; no straggling `family` references.
- ✅ Helper names: `resolveTypeface()`, `isTypefaceId()`, `typographyFontFamily()` — used consistently across tasks.

**No placeholders:** No "TBD" / "TODO" / "implement later" / "similar to" found in any task body. Every code block is complete; every command shows expected output.
