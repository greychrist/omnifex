import { describe, it, expect } from 'vitest';
import { resetsLabelToEpoch } from '../services/usage-runner/resets-label';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MIN = 60_000;

// 2026-04-27T15:00:00Z = Mon Apr 27, 11:00am America/New_York (EDT, UTC-4)
const APR27_15Z = Date.UTC(2026, 3, 27, 15, 0, 0);

describe('resetsLabelToEpoch', () => {
  it('returns null for empty / unknown formats', () => {
    expect(resetsLabelToEpoch('', APR27_15Z)).toBeNull();
    expect(resetsLabelToEpoch('whenever', APR27_15Z)).toBeNull();
    expect(resetsLabelToEpoch('in', APR27_15Z)).toBeNull();
    expect(resetsLabelToEpoch('in soon', APR27_15Z)).toBeNull();
  });

  describe('relative durations', () => {
    it('parses "in 5h"', () => {
      expect(resetsLabelToEpoch('in 5h', APR27_15Z)).toBe(APR27_15Z + 5 * HOUR);
    });

    it('parses "in 7d"', () => {
      expect(resetsLabelToEpoch('in 7d', APR27_15Z)).toBe(APR27_15Z + 7 * DAY);
    });

    it('parses compound "in 5h 23m"', () => {
      expect(resetsLabelToEpoch('in 5h 23m', APR27_15Z)).toBe(APR27_15Z + 5 * HOUR + 23 * MIN);
    });

    it('parses "in 1d 2h"', () => {
      expect(resetsLabelToEpoch('in 1d 2h', APR27_15Z)).toBe(APR27_15Z + 1 * DAY + 2 * HOUR);
    });

    it('tolerates trailing whitespace and odd spacing', () => {
      expect(resetsLabelToEpoch('in  5h ', APR27_15Z)).toBe(APR27_15Z + 5 * HOUR);
    });
  });

  describe('absolute clock time with timezone', () => {
    it('returns next occurrence later same day when not yet passed', () => {
      // 11:00am NY observed; "7pm (America/New_York)" today 19:00 NY = 23:00Z
      const epoch = resetsLabelToEpoch('7pm (America/New_York)', APR27_15Z);
      const expected = Date.UTC(2026, 3, 27, 23, 0, 0);
      expect(epoch).toBe(expected);
    });

    it('rolls to next day when target time has already passed', () => {
      // 11:00am NY observed; "9:40am (America/New_York)" → next day 9:40am NY = Apr 28 13:40Z
      const epoch = resetsLabelToEpoch('9:40am (America/New_York)', APR27_15Z);
      const expected = Date.UTC(2026, 3, 28, 13, 40, 0);
      expect(epoch).toBe(expected);
    });

    it('parses bare "7pm" (no minutes)', () => {
      const epoch = resetsLabelToEpoch('7pm (America/New_York)', APR27_15Z);
      expect(epoch).toBe(Date.UTC(2026, 3, 27, 23, 0, 0));
    });

    it('parses "12pm" (noon)', () => {
      // Noon NY = 16:00Z. 11:00am NY observed → today 16:00Z.
      const epoch = resetsLabelToEpoch('12pm (America/New_York)', APR27_15Z);
      expect(epoch).toBe(Date.UTC(2026, 3, 27, 16, 0, 0));
    });

    it('parses "12am" (midnight) and rolls to next-day midnight', () => {
      // Midnight NY → tomorrow 00:00 NY = Apr 28 04:00Z
      const epoch = resetsLabelToEpoch('12am (America/New_York)', APR27_15Z);
      expect(epoch).toBe(Date.UTC(2026, 3, 28, 4, 0, 0));
    });

    it('returns null for invalid timezone', () => {
      expect(resetsLabelToEpoch('7pm (Not/A_Zone)', APR27_15Z)).toBeNull();
    });

    it('returns null when timezone is missing', () => {
      expect(resetsLabelToEpoch('7pm', APR27_15Z)).toBeNull();
    });

    it('handles a non-NY timezone', () => {
      // Observed 15:00Z = 8:00am Los Angeles (PDT, UTC-7).
      // "12pm (America/Los_Angeles)" → today 12:00 LA = 19:00Z.
      const epoch = resetsLabelToEpoch('12pm (America/Los_Angeles)', APR27_15Z);
      expect(epoch).toBe(Date.UTC(2026, 3, 27, 19, 0, 0));
    });
  });

  describe('date + clock + tz (used by the 7-day window when reset is days away)', () => {
    it('parses "May 4 at 7pm (America/New_York)"', () => {
      // 7pm NY EDT (UTC-4) on May 4 = 23:00Z May 4.
      const epoch = resetsLabelToEpoch('May 4 at 7pm (America/New_York)', APR27_15Z);
      expect(epoch).toBe(Date.UTC(2026, 4, 4, 23, 0, 0));
    });

    it('parses "May 4 at 7:30pm (America/New_York)" with explicit minutes', () => {
      const epoch = resetsLabelToEpoch('May 4 at 7:30pm (America/New_York)', APR27_15Z);
      expect(epoch).toBe(Date.UTC(2026, 4, 4, 23, 30, 0));
    });

    it('parses an abbreviated month name', () => {
      const epoch = resetsLabelToEpoch('May 4 at 7pm (America/New_York)', APR27_15Z);
      const epochAbbr = resetsLabelToEpoch('May 04 at 7pm (America/New_York)', APR27_15Z);
      expect(epochAbbr).toBe(epoch);
    });

    it('rolls forward to next year when the parsed date is already in the past', () => {
      // Observed Apr 27 2026; "Jan 5 at 12pm (UTC)" rolls to Jan 5 2027.
      const epoch = resetsLabelToEpoch('Jan 5 at 12pm (UTC)', APR27_15Z);
      expect(epoch).toBe(Date.UTC(2027, 0, 5, 12, 0, 0));
    });

    it('returns null for an invalid month name', () => {
      expect(resetsLabelToEpoch('Smarch 4 at 7pm (America/New_York)', APR27_15Z)).toBeNull();
    });

    it('returns null for an invalid day number', () => {
      expect(resetsLabelToEpoch('May 99 at 7pm (America/New_York)', APR27_15Z)).toBeNull();
    });
  });
});
