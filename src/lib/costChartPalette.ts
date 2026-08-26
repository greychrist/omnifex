// Cost Report chart palette — fixed model → colour, never assigned by rank.
//
// The slots and their order are the validated dataviz categorical palette
// (adjacent-pair CVD-safe for stacked marks in both modes; verified with
// `scripts/validate_palette.js`, worst adjacent CVD ΔE 9.1 light / 8.4 dark).
// The model→slot ASSIGNMENT is chosen to agree with the Anthropic console's
// own model colours, so the two can be read side by side without re-learning
// the legend, and it matches `ai-cost-report.py`'s MODEL_SLOT exactly.
//
// The invariant that matters: colour follows the ENTITY, never its rank. If
// filtering a model out repainted the survivors, no two screenshots would be
// comparable and every month-over-month reading would silently lie.

export type ChartMode = 'light' | 'dark';

export const CATEGORICAL_LIGHT = [
  '#2a78d6', // 0 blue
  '#eb6834', // 1 orange
  '#1baf7a', // 2 aqua
  '#eda100', // 3 yellow
  '#e87ba4', // 4 magenta
  '#008300', // 5 green
  '#4a3aa7', // 6 violet
  '#e34948', // 7 red
] as const;

/** The same eight hues stepped for the dark surface — a selected dark palette,
 *  not an automatic flip of the light one. */
export const CATEGORICAL_DARK = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
] as const;

/** `<synthetic>` records are CLI bookkeeping and cost nothing. Giving them a
 *  series hue would imply they are spend worth comparing. */
const NEUTRAL: Record<ChartMode, string> = { light: '#898781', dark: '#898781' };

/** Longest pattern first, so `opus-4-8` cannot be swallowed by `opus`. */
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
