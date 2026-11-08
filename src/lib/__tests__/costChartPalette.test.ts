// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  SHADES,
  TIER_ORDER,
  NEUTRAL,
  modelColor,
  modelOwnColor,
  modelLabel,
  tierOf,
  compareModels,
  byTier,
  screenChartMode,
} from '../costChartPalette';
import { SHIPPED_PRICING, type ModelPricingInput } from '../pricing';

/**
 * Colour follows the ENTITY, never its rank on screen. If a filter that
 * removes one model repainted the survivors, the legend would stop meaning
 * the same thing between two screenshots and every month-over-month
 * comparison would silently lie.
 *
 * The hue is the model's price tier — blue (Haiku) is cheapest, then green
 * (Sonnet), amber (Opus) and purple (Fable), the order the effort picker
 * uses — and the shade is the version: the newest the full colour, older
 * ones stepping lighter, so two versions of one family stay apart in a
 * stacked bar.
 */
describe('tierOf', () => {
  it('reads the price tier off the family in the id', () => {
    expect(tierOf('claude-haiku-5-5')).toBe('haiku');
    expect(tierOf('claude-sonnet-5-20260715')).toBe('sonnet');
    expect(tierOf('claude-opus-5-5[1m]')).toBe('opus');
    expect(tierOf('claude-fable-5-1')).toBe('fable');
    // Mythos is priced as Fable and sits in its tier.
    expect(tierOf('claude-mythos-5')).toBe('fable');
    expect(tierOf('sonnet')).toBe('sonnet');
  });

  it('has none for an alias or an unknown family', () => {
    expect(tierOf('default')).toBeNull();
    expect(tierOf('claude-brandnew-9')).toBeNull();
    expect(tierOf('<synthetic>')).toBeNull();
  });
});

describe('modelColor', () => {
  it('paints each tier in its hue: blue, green, amber, purple from cheapest up', () => {
    expect(TIER_ORDER).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
    expect(modelColor('claude-haiku-5-5', 'light')).toBe(SHADES.light.haiku[0]);
    expect(modelColor('claude-sonnet-5-5', 'light')).toBe(SHADES.light.sonnet[0]);
    expect(modelColor('claude-opus-5-5', 'light')).toBe(SHADES.light.opus[0]);
    expect(modelColor('claude-fable-5-1', 'light')).toBe(SHADES.light.fable[0]);
    expect(SHADES.light.haiku[0]).toBe('#2563eb');
    expect(SHADES.light.sonnet[0]).toBe('#16a34a');
    expect(SHADES.light.opus[0]).toBe('#d97706');
    expect(SHADES.light.fable[0]).toBe('#9333ea');
  });

  it('steps older versions of a family to lighter shades of its hue', () => {
    expect(modelColor('claude-opus-5', 'light')).toBe(SHADES.light.opus[1]);
    expect(modelColor('claude-opus-4-8', 'light')).toBe(SHADES.light.opus[2]);
    expect(modelColor('claude-opus-4-7', 'light')).toBe(SHADES.light.opus[3]);
    // Past the ramp, the oldest share its last shade.
    expect(modelColor('claude-opus-4-6', 'light')).toBe(SHADES.light.opus[3]);
    expect(modelColor('claude-opus-4-5', 'light')).toBe(SHADES.light.opus[3]);
    expect(modelColor('claude-sonnet-5', 'light')).toBe(SHADES.light.sonnet[1]);
    expect(modelColor('claude-haiku-4-5', 'light')).toBe(SHADES.light.haiku[1]);
    expect(modelColor('claude-fable-5', 'light')).toBe(SHADES.light.fable[1]);
    // Mythos 5 ranks with Fable 5 in the purple tier.
    expect(modelColor('claude-mythos-5', 'light')).toBe(SHADES.light.fable[1]);
  });

  it('gives a model the same colour regardless of what else is on screen', () => {
    expect(modelColor('claude-opus-5', 'light')).toBe(modelColor('claude-opus-5', 'light'));
  });

  it('matches dated and suffixed model ids to the same shade', () => {
    const base = modelColor('claude-opus-5', 'light');
    expect(modelColor('claude-opus-5-20260715', 'light')).toBe(base);
    expect(modelColor('claude-opus-5[1m]', 'light')).toBe(base);
    expect(modelColor('claude-haiku-4-5-20251001', 'light')).toBe(modelColor('claude-haiku-4-5', 'light'));
  });

  it('uses a ramp stepped for the dark surface, not a flip of the light one', () => {
    for (const tier of TIER_ORDER) {
      expect(SHADES.dark[tier]).toHaveLength(SHADES.light[tier].length);
      expect(new Set(SHADES.dark[tier]).size).toBe(SHADES.dark[tier].length);
      expect(new Set(SHADES.light[tier]).size).toBe(SHADES.light[tier].length);
    }
    expect(modelColor('claude-opus-5-5', 'dark')).toBe(SHADES.dark.opus[0]);
    expect(modelColor('claude-opus-5-5', 'dark')).not.toBe(modelColor('claude-opus-5-5', 'light'));
  });

  it('gives a family alias the tier\'s newest shade', () => {
    expect(modelColor('sonnet', 'light')).toBe(SHADES.light.sonnet[0]);
    expect(modelColor('opus', 'dark')).toBe(SHADES.dark.opus[0]);
  });

  it('paints <synthetic> and an unknown family in the neutral — neither is spend in a tier', () => {
    const all = TIER_ORDER.flatMap((t) => [...SHADES.light[t], ...SHADES.dark[t]]);
    expect(modelColor('<synthetic>', 'light')).toBe(NEUTRAL);
    expect(modelColor('claude-brandnew-9', 'light')).toBe(NEUTRAL);
    expect(modelColor('default', 'dark')).toBe(NEUTRAL);
    expect(all).not.toContain(NEUTRAL);
  });

  it('ranks a newer version a user row adds ahead of the shipped ones', () => {
    const table: ModelPricingInput[] = [
      { pattern: 'opus-6', effectiveFrom: '1970-01-01', inputPerM: 5, outputPerM: 25, label: 'Opus 6' },
    ];
    expect(modelColor('claude-opus-6', 'light', table)).toBe(SHADES.light.opus[0]);
    expect(modelColor('claude-opus-5-5', 'light', table)).toBe(SHADES.light.opus[1]);
    expect(modelColor('claude-opus-5', 'light', table)).toBe(SHADES.light.opus[2]);
    // Without the row, Opus 5.5 is the newest again.
    expect(modelColor('claude-opus-5-5', 'light')).toBe(SHADES.light.opus[0]);
  });

  it('cannot be promoted out of the neutral by a user row', () => {
    const t: ModelPricingInput[] = [
      { pattern: '<synthetic>', effectiveFrom: '1970-01-01', label: 'Opus 9' },
    ];
    expect(modelColor('<synthetic>', 'light', t)).toBe(NEUTRAL);
  });
});

describe('modelOwnColor', () => {
  // A single model shown on its own (Modern's model-change line) takes a
  // colour only when it has a tier; an alias with no family or an unknown id
  // gets none, rather than a neutral that would read as a colour choice.
  it('is the tier shade for a model or family alias and null otherwise', () => {
    expect(modelOwnColor('claude-opus-5-5', 'dark')).toBe(SHADES.dark.opus[0]);
    expect(modelOwnColor('claude-opus-5-5[1m]', 'light')).toBe(SHADES.light.opus[0]);
    expect(modelOwnColor('sonnet', 'dark')).toBe(SHADES.dark.sonnet[0]);
    expect(modelOwnColor('default', 'dark')).toBeNull();
    expect(modelOwnColor('totally-unknown', 'dark')).toBeNull();
  });
});

describe('compareModels', () => {
  it('orders by tier, cheapest first, then newest version first, so the stack matches the legend', () => {
    const models = ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-opus-5', 'claude-haiku-5-5'];
    expect([...models].sort(compareModels)).toEqual([
      'claude-haiku-5-5', 'claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-fable-5',
    ]);
  });

  it('puts models with no tier last, then alphabetical, so the order is total', () => {
    const models = ['zeta-unknown', 'claude-opus-5', 'alpha-unknown', '<synthetic>'];
    expect([...models].sort(compareModels)).toEqual([
      'claude-opus-5', '<synthetic>', 'alpha-unknown', 'zeta-unknown',
    ]);
  });

  it('follows a user row that adds a version', () => {
    const table: ModelPricingInput[] = [
      { pattern: 'opus-6', effectiveFrom: '1970-01-01', label: 'Opus 6' },
    ];
    expect(['claude-opus-5-5', 'claude-opus-6'].sort(byTier(table))).toEqual(['claude-opus-6', 'claude-opus-5-5']);
  });
});

describe('modelLabel', () => {
  it('strips the date suffix that makes a legend unreadable', () => {
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelLabel('claude-opus-5')).toBe('Opus 5');
    expect(modelLabel('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(modelLabel('claude-fable-5')).toBe('Fable 5');
  });

  it('passes an unrecognised id through rather than inventing a name', () => {
    expect(modelLabel('claude-brandnew-9')).toBe('claude-brandnew-9');
    expect(modelLabel('<synthetic>')).toBe('<synthetic>');
  });

  it('takes a user row\'s label through the same resolver as its rates', () => {
    const table: ModelPricingInput[] = [
      { pattern: 'brandnew-9', effectiveFrom: '1970-01-01', label: 'Brand New 9' },
    ];
    expect(modelLabel('claude-brandnew-9', table)).toBe('Brand New 9');
  });

  it('every shipped label names a version its tier can rank', () => {
    for (const row of SHIPPED_PRICING) {
      if (!row.label) continue;
      expect(tierOf(`claude-${row.pattern}`)).not.toBeNull();
      expect(row.label).toMatch(/\d/);
    }
  });
});

describe('screenChartMode', () => {
  // The theme on screen, read off the root's class — what every surface that
  // colours a model outside the chart (picker rows, Modern lines) uses.
  it('is light under .theme-light and dark otherwise', () => {
    document.documentElement.classList.remove('theme-light');
    expect(screenChartMode()).toBe('dark');
    document.documentElement.classList.add('theme-light');
    try { expect(screenChartMode()).toBe('light'); } finally { document.documentElement.classList.remove('theme-light'); }
  });
});
