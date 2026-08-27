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
// Model→slot assignment is unchanged from `ai-cost-report.py`'s MODEL_SLOT, so
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

/** Longest pattern first, so `opus-4-8` cannot be swallowed by `opus`.
 *
 *  Slots are indices into the arrays above, so re-colouring the palette does
 *  not move a model relative to its peers — only the hue each slot holds
 *  changes. With the current order that puts opus-4-8 on red, opus-5 on blue
 *  and fable-5 on green: the three that carry essentially all real spend. */
const MODEL_SLOT: Array<{ pattern: string; slot: number; label: string }> = [
  { pattern: 'opus-4-8', slot: 0, label: 'Opus 4.8' },
  { pattern: 'opus-4-7', slot: 6, label: 'Opus 4.7' },
  { pattern: 'opus-4-6', slot: 6, label: 'Opus 4.6' },
  { pattern: 'opus-4-5', slot: 6, label: 'Opus 4.5' },
  { pattern: 'opus-5', slot: 1, label: 'Opus 5' },
  { pattern: 'fable-5', slot: 2, label: 'Fable 5' },
  { pattern: 'mythos-5', slot: 7, label: 'Mythos 5' },
  { pattern: 'sonnet-4-6', slot: 5, label: 'Sonnet 4.6' },
  { pattern: 'sonnet-5', slot: 3, label: 'Sonnet 5' },
  { pattern: 'haiku-4-5', slot: 4, label: 'Haiku 4.5' },
];

function entryFor(model: string): (typeof MODEL_SLOT)[number] | undefined {
  const m = (model || '').toLowerCase();
  return MODEL_SLOT.find((e) => m.includes(e.pattern));
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

export function modelColor(model: string, mode: ChartMode): string {
  if ((model || '').toLowerCase().includes('synthetic')) return NEUTRAL[mode];
  const slots = mode === 'dark' ? CATEGORICAL_DARK : CATEGORICAL_LIGHT;
  const entry = entryFor(model);
  return slots[entry ? entry.slot : hashSlot(model)];
}

/**
 * Sort comparator putting models in fixed slot order, so the stack order,
 * the legend order and the table order all agree. Unmapped models sort last,
 * alphabetically, which keeps the order total (a partial order would let two
 * renders of the same data disagree).
 */
export function compareModelsBySlot(a: string, b: string): number {
  const ea = entryFor(a);
  const eb = entryFor(b);
  if (ea && eb) return ea.slot - eb.slot || a.localeCompare(b);
  if (ea) return -1;
  if (eb) return 1;
  return a.localeCompare(b);
}

/** Human label for a legend. Model ids carry a date suffix that makes a
 *  legend unreadable; an unrecognised id passes through rather than being
 *  guessed at. */
export function modelLabel(model: string): string {
  return entryFor(model)?.label ?? model;
}
