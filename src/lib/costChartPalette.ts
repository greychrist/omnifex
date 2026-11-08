import { SHIPPED_PRICING, resolvePricing, type ModelPricingInput } from './pricing';

// Cost Report palette — colour follows the ENTITY, never its rank on screen.
//
// A model's HUE is its price tier, in the order the effort picker uses for
// its levels: blue (Haiku, cheapest), green (Sonnet), amber (Opus), purple
// (Fable; Mythos is priced as Fable and sits with it). Its SHADE is its
// version within the tier: the newest is the full colour and older ones step
// lighter, so Opus 5.5 and Opus 5 — the two biggest segments of most bars —
// stay apart in a stack and in the legend. Past the ramp the oldest share its
// last shade; they are never in use together.
//
// The rank comes from the versions the pricing table names (shipped rows plus
// the user's), never from which models are on screen. If filtering a model
// out repainted the survivors, no two screenshots would be comparable and
// every month-over-month reading would silently lie.
//
// This replaced a fixed eight-hue categorical palette with a per-row slot
// (`colorSlot`, dropped in schema v31): the colours were CVD-ordered but told
// nothing about the model, and Opus 5 was blue while Opus 5.5 was orange.

export type ChartMode = 'light' | 'dark';
export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable';

/** Cheapest first. */
export const TIER_ORDER: readonly Tier[] = ['haiku', 'sonnet', 'opus', 'fable'];

/** Family token in a model id or pricing pattern → tier. */
const FAMILY_TIER: Record<string, Tier> = {
  haiku: 'haiku',
  sonnet: 'sonnet',
  opus: 'opus',
  fable: 'fable',
  mythos: 'fable',
};

/** Shades newest → older, per surface. Tailwind's blue / green / amber /
 *  purple: 600, 400, 300, 200 on light; 500, 300, 200, 100 on dark, where the
 *  darker steps would sink into the plot. */
export const SHADES: Record<ChartMode, Record<Tier, readonly string[]>> = {
  light: {
    haiku: ['#2563eb', '#60a5fa', '#93c5fd', '#bfdbfe'],
    sonnet: ['#16a34a', '#4ade80', '#86efac', '#bbf7d0'],
    opus: ['#d97706', '#fbbf24', '#fcd34d', '#fde68a'],
    fable: ['#9333ea', '#c084fc', '#d8b4fe', '#e9d5ff'],
  },
  dark: {
    haiku: ['#3b82f6', '#93c5fd', '#bfdbfe', '#dbeafe'],
    sonnet: ['#22c55e', '#86efac', '#bbf7d0', '#dcfce7'],
    opus: ['#f59e0b', '#fcd34d', '#fde68a', '#fef3c7'],
    fable: ['#a855f7', '#d8b4fe', '#e9d5ff', '#f3e8ff'],
  },
};

/** `<synthetic>` records are CLI bookkeeping and cost nothing; an unknown
 *  family has no tier. Neither gets a tier hue, which would imply spend worth
 *  comparing to the real ones. */
export const NEUTRAL = '#898781';

/** The price tier a model id, alias or pricing pattern belongs to, read off
 *  its family token; null for an alias with no family ("default"), an
 *  unknown family or `<synthetic>`. */
export function tierOf(model: string): Tier | null {
  for (const token of model.toLowerCase().split(/[^a-z]+/)) {
    const tier = FAMILY_TIER[token];
    if (tier) return tier;
  }
  return null;
}

/** The dotted version a label spells ("Opus 5.5" → [5, 5]), or null. */
function labelVersion(label: string): number[] | null {
  const match = /(\d+(?:\.\d+)*)/.exec(label);
  return match ? match[1].split('.').map(Number) : null;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Every version the pricing table names in a tier, newest first. User rows
 * count alongside the shipped ones, so a model added in Settings ranks where
 * its version puts it. Versions, not models: two labels that spell the same
 * version (Fable 5, Mythos 5) share a rank.
 */
function tierVersions(tier: Tier, userRows?: readonly ModelPricingInput[] | null): number[][] {
  const seen = new Map<string, number[]>();
  for (const row of [...(userRows ?? []), ...SHIPPED_PRICING]) {
    if (!row.label || tierOf(row.pattern) !== tier) continue;
    const v = labelVersion(row.label);
    if (v) seen.set(v.join('.'), v);
  }
  return [...seen.values()].sort((a, b) => compareVersions(b, a));
}

/** Where a model sits in its tier: 0 for the newest version, or for a family
 *  alias that names no version. */
function rankOf(model: string, tier: Tier, userRows?: readonly ModelPricingInput[] | null): number {
  const { row } = resolvePricing(model, today(), userRows);
  const v = row.label ? labelVersion(row.label) : null;
  if (!v) return 0;
  const i = tierVersions(tier, userRows).findIndex((o) => compareVersions(o, v) === 0);
  return i < 0 ? 0 : i;
}

/** Display metadata always resolves at today: a colour that shifted with the
 *  row date being rendered would repaint a chart mid-axis. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isSynthetic(model: string): boolean {
  return (model || '').toLowerCase().includes('synthetic');
}

/**
 * A model's own colour, or null when it has none to give: `<synthetic>`, an
 * alias that names no family ("default"), an unknown family. For a single
 * model shown on its own — Modern's model-change line — where a neutral
 * would read as a colour choice.
 */
export function modelOwnColor(
  model: string,
  mode: ChartMode,
  userRows?: readonly ModelPricingInput[] | null,
): string | null {
  // Checked before the table, so no row can promote bookkeeping to a tier.
  if (isSynthetic(model)) return null;
  const tier = tierOf(model);
  if (!tier) return null;
  const ramp = SHADES[mode][tier];
  return ramp[Math.min(rankOf(model, tier, userRows), ramp.length - 1)];
}

/** The theme on screen, read off the root's class, for the surfaces that
 *  colour a model outside the chart (picker rows, Modern's model line). */
export function screenChartMode(): ChartMode {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('theme-light')
    ? 'light'
    : 'dark';
}

/** The chart's colour for a model: its own, or the neutral. */
export function modelColor(
  model: string,
  mode: ChartMode,
  userRows?: readonly ModelPricingInput[] | null,
): string {
  return modelOwnColor(model, mode, userRows) ?? NEUTRAL;
}

/**
 * Sort comparator putting models in tier order, cheapest first, and within a
 * tier newest first — the order the shades step in — so the stack order, the
 * legend order and the table order all agree. Models with no tier sort last,
 * alphabetically, which keeps the order total (a partial order would let two
 * renders of the same data disagree).
 */
export function byTier(
  userRows?: readonly ModelPricingInput[] | null,
): (a: string, b: string) => number {
  const key = (m: string): [number, number] | null => {
    if (isSynthetic(m)) return null;
    const tier = tierOf(m);
    return tier ? [TIER_ORDER.indexOf(tier), rankOf(m, tier, userRows)] : null;
  };
  return (a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka && kb) return ka[0] - kb[0] || ka[1] - kb[1] || a.localeCompare(b);
    if (ka) return -1;
    if (kb) return 1;
    return a.localeCompare(b);
  };
}

/** Table-free comparator, for the callers that have no pricing table to hand. */
export const compareModels = byTier();

/** Human label for a legend. Model ids carry a date suffix that makes a
 *  legend unreadable; an unrecognised id passes through rather than being
 *  guessed at. A user row's label comes through the same resolver as its
 *  rates, so naming a model on the chart is the one row that prices it. */
export function modelLabel(
  model: string,
  userRows?: readonly ModelPricingInput[] | null,
): string {
  return resolvePricing(model, today(), userRows).row.label ?? model;
}
