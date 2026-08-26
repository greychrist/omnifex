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
