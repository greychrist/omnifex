import { resolvePricing, type ModelPricingInput } from './pricing';

// Cost Report chart palette — fixed model → colour, never assigned by rank.
//
// Hues are the dataviz categorical set, re-ordered to lead with red / blue /
// green on request. The ORDER is the CVD-safety mechanism, not cosmetics: all
// 40,320 orderings were enumerated against `scripts/validate_palette.js` in
// both modes, and this is the best of the 10 that lead with those three hues
// AND clear the ΔE >= 8 adjacent-pair gate outright (worst adjacent CVD 9.2
// light / 9.4 dark — better margins than the palette's own default order).
//
// Red and green are never adjacent. They are the classic protan/deutan
// confusion pair, so blue has to sit between them; that is why the order is
// red→blue→green and not blue→green→red, and it is not something eyeballing
// would have caught.
//
// Model→slot assignment is unchanged from `ai-cost-report.py`'s MODEL_SLOT (the
// slots now live on the `SHIPPED_PRICING` rows in `pricing.ts`), so
// the three models that dominate real spend (opus-4-8, opus-5, fable-5) take
// the three leading hues. NOTE: the previous order was chosen to match the
// Anthropic console's own model colours so the two read side by side. That
// property is deliberately given up here.
//
// The invariant that still holds: colour follows the ENTITY, never its rank.
// If filtering a model out repainted the survivors, no two screenshots would
// be comparable and every month-over-month reading would silently lie.

export type ChartMode = 'light' | 'dark';

export const CATEGORICAL_LIGHT = [
  '#e34948', // 0 red
  '#2a78d6', // 1 blue
  '#008300', // 2 green
  '#e87ba4', // 3 magenta
  '#eda100', // 4 yellow
  '#4a3aa7', // 5 violet
  '#eb6834', // 6 orange
  '#1baf7a', // 7 aqua
] as const;

/** The same eight hues stepped for the dark surface — a selected dark palette,
 *  not an automatic flip of the light one. */
export const CATEGORICAL_DARK = [
  '#e66767', // 0 red
  '#3987e5', // 1 blue
  '#008300', // 2 green
  '#d55181', // 3 magenta
  '#c98500', // 4 yellow
  '#9085e9', // 5 violet
  '#d95926', // 6 orange
  '#199e70', // 7 aqua
] as const;

/** `<synthetic>` records are CLI bookkeeping and cost nothing. Giving them a
 *  series hue would imply they are spend worth comparing. */
const NEUTRAL: Record<ChartMode, string> = { light: '#898781', dark: '#898781' };

/**
 * Display metadata for a model, resolved through the SAME table as its rates.
 *
 * There is no second model list here. A model's legend name and colour live on
 * its `SHIPPED_PRICING` row next to its price, and a user's `model_pricing`
 * row overrides both through one resolver — so naming a new model on the chart
 * is the same one row that prices it, not a parallel edit in a second file
 * that silently drifts.
 *
 * Fields resolve independently: a row that sets only a rate keeps the shipped
 * label, and a row that sets only a label keeps the shipped colour.
 */
function displayFor(
  model: string,
  userRows?: readonly ModelPricingInput[] | null,
): { slot?: number; label?: string } {
  // Colours must not shift with the row date being rendered, or a chart would
  // repaint itself mid-axis. Display metadata always resolves at today.
  const { row } = resolvePricing(model, new Date().toISOString().slice(0, 10), userRows);
  return { slot: row.colorSlot, label: row.label };
}

/** Stable string hash, so an unmapped model keeps one colour across renders
 *  and across sessions rather than shifting with the result set. */
function hashSlot(model: string): number {
  let h = 0;
  for (let i = 0; i < model.length; i += 1) {
    h = (h * 31 + model.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % CATEGORICAL_LIGHT.length;
}

export function modelColor(
  model: string,
  mode: ChartMode,
  userRows?: readonly ModelPricingInput[] | null,
): string {
  // Checked before the table, so no row can promote bookkeeping to a series
  // hue and make `<synthetic>` read as spend worth comparing.
  if ((model || '').toLowerCase().includes('synthetic')) return NEUTRAL[mode];
  const slots = mode === 'dark' ? CATEGORICAL_DARK : CATEGORICAL_LIGHT;
  const { slot } = displayFor(model, userRows);
  return slots[slot ?? hashSlot(model)];
}

/**
 * Sort comparator putting models in fixed slot order, so the stack order,
 * the legend order and the table order all agree. Unmapped models sort last,
 * alphabetically, which keeps the order total (a partial order would let two
 * renders of the same data disagree).
 */
export function bySlot(
  userRows?: readonly ModelPricingInput[] | null,
): (a: string, b: string) => number {
  return (a, b) => {
    const sa = displayFor(a, userRows).slot;
    const sb = displayFor(b, userRows).slot;
    if (sa != null && sb != null) return sa - sb || a.localeCompare(b);
    if (sa != null) return -1;
    if (sb != null) return 1;
    return a.localeCompare(b);
  };
}

/** Table-free comparator, for the callers that have no pricing table to hand. */
export const compareModelsBySlot = bySlot();

/** Human label for a legend. Model ids carry a date suffix that makes a
 *  legend unreadable; an unrecognised id passes through rather than being
 *  guessed at. */
export function modelLabel(
  model: string,
  userRows?: readonly ModelPricingInput[] | null,
): string {
  return displayFor(model, userRows).label ?? model;
}
