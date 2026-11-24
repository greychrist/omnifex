import { SHIPPED_PRICING, resolvePricing, type ModelPricingInput } from './pricing';

// Color follows the entity, never its rank on screen: hue is the price tier, shade the version's
// rank in the pricing table, never in what is visible, so filtering never repaints the survivors.

export type ChartMode = 'light' | 'dark';
export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable';

export const TIER_ORDER: readonly Tier[] = ['haiku', 'sonnet', 'opus', 'fable'];

const FAMILY_TIER: Record<string, Tier> = {
  haiku: 'haiku',
  sonnet: 'sonnet',
  opus: 'opus',
  fable: 'fable',
  mythos: 'fable',
};

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

export const NEUTRAL = '#898781';

export function tierOf(model: string): Tier | null {
  for (const token of model.toLowerCase().split(/[^a-z]+/)) {
    const tier = FAMILY_TIER[token];
    if (tier) return tier;
  }
  return null;
}

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

function tierVersions(tier: Tier, userRows?: readonly ModelPricingInput[] | null): number[][] {
  const seen = new Map<string, number[]>();
  for (const row of [...(userRows ?? []), ...SHIPPED_PRICING]) {
    if (!row.label || tierOf(row.pattern) !== tier) continue;
    const v = labelVersion(row.label);
    if (v) seen.set(v.join('.'), v);
  }
  return [...seen.values()].sort((a, b) => compareVersions(b, a));
}

function rankOf(model: string, tier: Tier, userRows?: readonly ModelPricingInput[] | null): number {
  const { row } = resolvePricing(model, today(), userRows);
  const v = row.label ? labelVersion(row.label) : null;
  if (!v) return 0;
  const i = tierVersions(tier, userRows).findIndex((o) => compareVersions(o, v) === 0);
  return i < 0 ? 0 : i;
}

/** Resolves at today: a color that shifted with the row date would repaint a chart mid-axis. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isSynthetic(model: string): boolean {
  return (model || '').toLowerCase().includes('synthetic');
}

export function modelOwnColor(
  model: string,
  mode: ChartMode,
  userRows?: readonly ModelPricingInput[] | null,
): string | null {
  // Before the table, so no row can promote bookkeeping to a tier.
  if (isSynthetic(model)) return null;
  const tier = tierOf(model);
  if (!tier) return null;
  const ramp = SHADES[mode][tier];
  return ramp[Math.min(rankOf(model, tier, userRows), ramp.length - 1)];
}

export function screenChartMode(): ChartMode {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('theme-light')
    ? 'light'
    : 'dark';
}

export function modelColor(
  model: string,
  mode: ChartMode,
  userRows?: readonly ModelPricingInput[] | null,
): string {
  return modelOwnColor(model, mode, userRows) ?? NEUTRAL;
}

/** A total order (untiered last, alphabetical) so two renders of the same data agree. */
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

export const compareModels = byTier();

export function modelLabel(
  model: string,
  userRows?: readonly ModelPricingInput[] | null,
): string {
  return resolvePricing(model, today(), userRows).row.label ?? model;
}
