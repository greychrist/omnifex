import { describe, it, expect } from 'vitest';
import {
  RANGE_PRESETS,
  resolveRange,
  toFilterParams,
  emptyFilterState,
  fmtUsd,
  fmtTokens,
  fmtPercent,
  fmtRatio,
  type CostFilterState,
} from '../costReportFilters';

const TODAY = '2026-08-26';

describe('resolveRange', () => {
  it('this month starts on the 1st, UTC', () => {
    expect(resolveRange('month', TODAY)).toEqual({ startDate: '2026-08-01', endDate: undefined });
  });

  it('last month is a closed range, so it does not bleed into this one', () => {
    expect(resolveRange('last-month', TODAY)).toEqual({ startDate: '2026-07-01', endDate: '2026-07-31' });
  });

  it('handles the January boundary when stepping back a month', () => {
    expect(resolveRange('last-month', '2026-01-15')).toEqual({ startDate: '2025-12-01', endDate: '2025-12-31' });
  });

  it('30d and 90d count back from today', () => {
    expect(resolveRange('30d', TODAY).startDate).toBe('2026-07-27');
    expect(resolveRange('90d', TODAY).startDate).toBe('2026-05-28');
  });

  it('all time is unbounded', () => {
    expect(resolveRange('all', TODAY)).toEqual({ startDate: undefined, endDate: undefined });
  });

  it('every preset key resolves', () => {
    for (const p of RANGE_PRESETS) expect(() => resolveRange(p.key, TODAY)).not.toThrow();
  });
});

describe('toFilterParams', () => {
  const base: CostFilterState = { ...emptyFilterState(), rangeKey: 'all' };

  it('omits empty multi-selects entirely rather than sending []', () => {
    expect(toFilterParams(base, TODAY)).toEqual({});
  });

  it('passes multi-selects through as arrays', () => {
    const p = toFilterParams({ ...base, accounts: ['Work', 'Personal'], models: ['claude-opus-5'] }, TODAY);
    expect(p.accountName).toEqual(['Work', 'Personal']);
    expect(p.model).toEqual(['claude-opus-5']);
  });

  // A custom date must beat the preset, or typing a start date would appear
  // to do nothing while the preset silently kept winning.
  it('custom dates override the preset', () => {
    const p = toFilterParams({ ...base, rangeKey: 'month', customStart: '2026-01-01', customEnd: '2026-02-01' }, TODAY);
    expect(p.startDate).toBe('2026-01-01');
    expect(p.endDate).toBe('2026-02-01');
  });

  it('a custom start alone still overrides only the start', () => {
    const p = toFilterParams({ ...base, rangeKey: 'last-month', customStart: '2026-07-15' }, TODAY);
    expect(p.startDate).toBe('2026-07-15');
    expect(p.endDate).toBe('2026-07-31');
  });

  it('maps the three-way subagent scope', () => {
    expect(toFilterParams({ ...base, scope: 'all' }, TODAY).isSubagent).toBeUndefined();
    expect(toFilterParams({ ...base, scope: 'main' }, TODAY).isSubagent).toBe(false);
    expect(toFilterParams({ ...base, scope: 'subagent' }, TODAY).isSubagent).toBe(true);
  });

  it('trims the project search and drops it when blank', () => {
    expect(toFilterParams({ ...base, projectSearch: '  omni  ' }, TODAY).projectSearch).toBe('omni');
    expect(toFilterParams({ ...base, projectSearch: '   ' }, TODAY).projectSearch).toBeUndefined();
  });
});

describe('formatters', () => {
  it('fmtUsd keeps sub-cent amounts legible instead of rounding them to $0.00', () => {
    expect(fmtUsd(1234.5)).toBe('$1,234.50');
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(0.0031)).toBe('$0.0031');
  });

  it('fmtTokens abbreviates so a billion does not blow out the column', () => {
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(12_400)).toBe('12.4K');
    expect(fmtTokens(3_120_000)).toBe('3.1M');
    expect(fmtTokens(1_036_743_929)).toBe('1.0B');
  });

  it('fmtPercent renders a share', () => {
    expect(fmtPercent(0.8503)).toBe('85%');
    expect(fmtPercent(0)).toBe('0%');
  });

  it('fmtRatio reads as a ratio, not a decimal', () => {
    expect(fmtRatio(35.4)).toBe('35:1');
    expect(fmtRatio(1.8)).toBe('1.8:1');
    expect(fmtRatio(0)).toBe('—');
  });
});
