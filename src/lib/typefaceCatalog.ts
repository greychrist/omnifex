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
export function resolveTypeface(id: string): TypefaceMeta {
  return isTypefaceId(id) ? TYPEFACE_BY_ID[id] : TYPEFACE_BY_ID.inter;
}
