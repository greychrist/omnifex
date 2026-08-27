import { describe, it, expect } from 'vitest';
import {
  formatPeriodTick,
  tickInterval,
  weekBoundaries,
  weekStartDate,
} from '../costChartAxis';

describe('formatPeriodTick', () => {
  it('drops the year from a day period, leaving month/day', () => {
    expect(formatPeriodTick('2026-08-01')).toBe('8/1');
    expect(formatPeriodTick('2026-12-31')).toBe('12/31');
  });

  // Week buckets are `%Y-W%W`, which nobody reads as a date. The Monday that
  // opens the week is the same month/day shape as the daily ticks.
  it('renders a week period as the month/day its Monday falls on', () => {
    expect(formatPeriodTick('2026-W31')).toBe('8/3');
    expect(formatPeriodTick('2026-W01')).toBe('1/5');
  });

  it('renders a month period as the short month name', () => {
    expect(formatPeriodTick('2026-08')).toBe('Aug');
    expect(formatPeriodTick('2026-01')).toBe('Jan');
  });

  it('passes anything it does not recognise through unchanged', () => {
    expect(formatPeriodTick('whatever')).toBe('whatever');
  });
});

describe('weekStartDate', () => {
  // SQLite's `%W` is Monday-based and week 00 is the partial week before the
  // year's first Monday. These expectations were taken from sqlite itself.
  it('resolves a %W week to the Monday that opens it', () => {
    expect(weekStartDate('2026-W31')).toBe('2026-08-03');
    expect(weekStartDate('2026-W30')).toBe('2026-07-27');
    expect(weekStartDate('2026-W01')).toBe('2026-01-05');
    expect(weekStartDate('2027-W01')).toBe('2027-01-04');
  });

  it('treats week 00 as starting on January 1st', () => {
    expect(weekStartDate('2026-W00')).toBe('2026-01-01');
    expect(weekStartDate('2027-W00')).toBe('2027-01-01');
  });

  it('returns null for a period that is not a week', () => {
    expect(weekStartDate('2026-08-01')).toBeNull();
  });
});

describe('weekBoundaries', () => {
  it('marks the first period of each week after the first', () => {
    // 2026-08-03 is a Monday.
    expect(
      weekBoundaries([
        '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04',
        '2026-08-09', '2026-08-10',
      ]),
    ).toEqual(['2026-08-03', '2026-08-10']);
  });

  // The chart edge is already a boundary; a line on top of the axis is noise.
  it('never marks the first period', () => {
    expect(weekBoundaries(['2026-08-03', '2026-08-04'])).toEqual([]);
  });

  // Days with no spend are absent from the data, so "is it a Monday?" is the
  // wrong test — a week that starts on Wednesday still starts a week.
  it('marks the first present day of a week even when the Monday is missing', () => {
    expect(weekBoundaries(['2026-08-01', '2026-08-05', '2026-08-12'])).toEqual([
      '2026-08-05', '2026-08-12',
    ]);
  });

  it('returns nothing for week or month periods, which are already separated', () => {
    expect(weekBoundaries(['2026-W30', '2026-W31'])).toEqual([]);
    expect(weekBoundaries(['2026-07', '2026-08'])).toEqual([]);
  });

  it('returns nothing for a single period or none at all', () => {
    expect(weekBoundaries([])).toEqual([]);
    expect(weekBoundaries(['2026-08-01'])).toEqual([]);
  });
});

describe('tickInterval', () => {
  it('labels every bar while the labels still fit', () => {
    expect(tickInterval(1)).toBe(0);
    expect(tickInterval(31)).toBe(0);
  });

  // A year of days cannot carry 365 legible ticks; thinning beats collision.
  it('thins the ticks once there are more bars than the axis can hold', () => {
    expect(tickInterval(62)).toBe(1);
    expect(tickInterval(365)).toBe(11);
  });
});
