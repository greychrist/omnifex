import { describe, it, expect } from 'vitest';
import {
  CATEGORICAL_LIGHT,
  CATEGORICAL_DARK,
  modelColor,
  modelLabel,
  compareModelsBySlot,
} from '../costChartPalette';

/**
 * Colour follows the ENTITY, never its rank. If a filter that removes one
 * model repaints the survivors, the legend stops meaning the same thing
 * between two screenshots and every month-over-month comparison silently
 * lies. This is the property the tests exist to pin down.
 */
describe('modelColor', () => {
  it('gives a model the same colour regardless of what else is on screen', () => {
    expect(modelColor('claude-opus-5', 'light')).toBe(modelColor('claude-opus-5', 'light'));
    // opus-5 is slot 1 (orange) whether or not opus-4-8 (slot 0) is present.
    expect(modelColor('claude-opus-5', 'light')).toBe(CATEGORICAL_LIGHT[1]);
    expect(modelColor('claude-opus-4-8', 'light')).toBe(CATEGORICAL_LIGHT[0]);
  });

  it('matches dated and suffixed model ids to the same slot', () => {
    const base = modelColor('claude-opus-5', 'light');
    expect(modelColor('claude-opus-5-20260715', 'light')).toBe(base);
    expect(modelColor('claude-opus-5[1m]', 'light')).toBe(base);
    expect(modelColor('claude-haiku-4-5-20251001', 'light')).toBe(modelColor('claude-haiku-4-5', 'light'));
  });

  it('steps the same hue for the dark surface rather than flipping to another palette', () => {
    expect(CATEGORICAL_DARK).toHaveLength(CATEGORICAL_LIGHT.length);
    expect(modelColor('claude-opus-5', 'dark')).toBe(CATEGORICAL_DARK[1]);
  });

  it('is deterministic and in-range for an unmapped model', () => {
    const a = modelColor('claude-brandnew-9', 'light');
    expect(CATEGORICAL_LIGHT).toContain(a);
    expect(modelColor('claude-brandnew-9', 'light')).toBe(a);
    // Two different unknown models should not both land on the same slot if
    // it can be helped — a stable hash, not a constant.
    expect(new Set([
      modelColor('claude-alpha-1', 'light'),
      modelColor('claude-beta-2', 'light'),
      modelColor('claude-gamma-3', 'light'),
    ]).size).toBeGreaterThan(1);
  });

  it('paints <synthetic> in a neutral, not a series hue — it is bookkeeping, not spend', () => {
    expect(CATEGORICAL_LIGHT).not.toContain(modelColor('<synthetic>', 'light'));
  });
});

describe('compareModelsBySlot', () => {
  it('orders by fixed slot so the stack order matches the legend order', () => {
    const models = ['claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5', 'claude-opus-5'];
    expect([...models].sort(compareModelsBySlot)).toEqual([
      'claude-opus-4-8', 'claude-opus-5', 'claude-fable-5', 'claude-sonnet-5',
    ]);
  });

  it('puts unmapped models last, then alphabetical, so the order is total', () => {
    const models = ['zeta-unknown', 'claude-opus-5', 'alpha-unknown'];
    expect([...models].sort(compareModelsBySlot)).toEqual([
      'claude-opus-5', 'alpha-unknown', 'zeta-unknown',
    ]);
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
    expect(modelLabel('<synthetic>')).toBe('<synthetic>');
    expect(modelLabel('some-other-thing')).toBe('some-other-thing');
  });
});

/**
 * The slot ORDER is the CVD-safety mechanism, not cosmetics. These pin the
 * properties that a well-meaning "let's make it prettier" edit would silently
 * break — the tests above only assert slot indices, which survive any recolour.
 *
 * Re-validate with the dataviz skill's own tool before changing a hex:
 *   node scripts/validate_palette.js "<comma-separated>" --mode light|dark
 */
describe('palette safety properties', () => {
  const RED = 0;
  const GREEN = 2;

  it('leads with red, blue, green as requested', () => {
    expect(CATEGORICAL_LIGHT.slice(0, 3)).toEqual(['#e34948', '#2a78d6', '#008300']);
    expect(CATEGORICAL_DARK.slice(0, 3)).toEqual(['#e66767', '#3987e5', '#008300']);
  });

  // Red and green are the classic protan/deutan confusion pair. Adjacent slots
  // touch as stacked segments, so they must never neighbour each other — blue
  // sits between them deliberately.
  it('never places red and green in adjacent slots', () => {
    expect(Math.abs(RED - GREEN)).toBeGreaterThan(1);
  });

  it('has eight distinct hues in each mode, and the same count in both', () => {
    expect(CATEGORICAL_LIGHT).toHaveLength(8);
    expect(CATEGORICAL_DARK).toHaveLength(8);
    expect(new Set(CATEGORICAL_LIGHT).size).toBe(8);
    expect(new Set(CATEGORICAL_DARK).size).toBe(8);
  });

  it('every model slot indexes a real palette entry', () => {
    for (const model of [
      'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5',
      'claude-mythos-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5',
    ]) {
      expect(CATEGORICAL_LIGHT).toContain(modelColor(model, 'light'));
      expect(CATEGORICAL_DARK).toContain(modelColor(model, 'dark'));
    }
  });

  // The models that carry essentially all of the real spend should be the ones
  // wearing the leading hues; that is the point of the chosen assignment.
  it('gives the three dominant models the three leading hues', () => {
    expect(modelColor('claude-opus-4-8', 'dark')).toBe(CATEGORICAL_DARK[0]); // red
    expect(modelColor('claude-opus-5', 'dark')).toBe(CATEGORICAL_DARK[1]);   // blue
    expect(modelColor('claude-fable-5', 'dark')).toBe(CATEGORICAL_DARK[2]);  // green
  });
});
