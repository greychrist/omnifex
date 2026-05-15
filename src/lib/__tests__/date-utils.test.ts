import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatUnixTimestamp,
  formatISOTimestamp,
  truncateText,
  getFirstLine,
  formatTimeAgo,
} from '../date-utils';

// All the date-aware helpers compare against `new Date()` / `Date.now()`,
// so we pin "now" with fake timers to make assertions deterministic.
// Picked a fixed point in the middle of an arbitrary week so we have
// meaningful "yesterday" / "within a week" / "this year" / "earlier
// years" boundaries to land on.
const NOW = new Date('2026-06-15T15:30:00Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('truncateText', () => {
  it('returns the text unchanged when shorter than maxLength', () => {
    expect(truncateText('hello', 10)).toBe('hello');
  });

  it('returns the text unchanged when exactly maxLength', () => {
    expect(truncateText('hellohello', 10)).toBe('hellohello');
  });

  it('truncates and appends "..." when longer than maxLength', () => {
    // maxLength=8 → slice(0, 5) + '...'  →  "hello..."
    expect(truncateText('hellohello', 8)).toBe('hello...');
    expect(truncateText('hellohello', 8).length).toBe(8);
  });
});

describe('getFirstLine', () => {
  it('returns the substring before the first newline', () => {
    expect(getFirstLine('first line\nsecond line\nthird')).toBe('first line');
  });

  it('returns the whole string when there are no newlines', () => {
    expect(getFirstLine('one line only')).toBe('one line only');
  });

  it('returns an empty string when given an empty string', () => {
    expect(getFirstLine('')).toBe('');
  });
});

describe('formatUnixTimestamp', () => {
  it('returns a time-of-day when the timestamp is today', () => {
    // "Now" is 2026-06-15T15:30:00Z. A timestamp earlier today is still
    // "today" by toDateString() comparison (local TZ).
    const today = Math.floor(NOW / 1000);
    const result = formatUnixTimestamp(today);
    // Some form of HH:MM AM/PM — don't over-pin the locale string.
    expect(result).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/);
  });

  it('prefixes "Yesterday," when the timestamp is the previous calendar day', () => {
    const yesterday = Math.floor((NOW - 24 * 60 * 60 * 1000) / 1000);
    expect(formatUnixTimestamp(yesterday)).toMatch(/^Yesterday,/);
  });

  it('uses the weekday name for timestamps within the last week', () => {
    const fourDaysAgo = Math.floor((NOW - 4 * 24 * 60 * 60 * 1000) / 1000);
    const result = formatUnixTimestamp(fourDaysAgo);
    // The result should start with a full weekday name (Monday..Sunday).
    expect(result).toMatch(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),/);
  });

  it('omits the year when the timestamp is in the current year (but older than a week)', () => {
    // 30 days ago is still 2026, past the within-week branch.
    const monthAgo = Math.floor((NOW - 30 * 24 * 60 * 60 * 1000) / 1000);
    const result = formatUnixTimestamp(monthAgo);
    // Should look like "May 16" (no year).
    expect(result).not.toMatch(/202\d/);
    expect(result).toMatch(/^[A-Z][a-z]{2,8}\s+\d{1,2}$/);
  });

  it('includes the year when the timestamp is in a previous year', () => {
    // 2024-01-01 — clearly previous year vs. 2026 "now".
    const olderYear = Math.floor(new Date('2024-01-01T12:00:00Z').getTime() / 1000);
    expect(formatUnixTimestamp(olderYear)).toMatch(/2024/);
  });
});

describe('formatISOTimestamp', () => {
  it('delegates to formatUnixTimestamp after ISO → seconds conversion', () => {
    // Same calendar day as our pinned NOW → should match the today branch.
    const isoToday = new Date(NOW).toISOString();
    expect(formatISOTimestamp(isoToday)).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/);
  });

  it('falls through to year-shown for older ISO timestamps', () => {
    expect(formatISOTimestamp('2024-03-10T00:00:00Z')).toMatch(/2024/);
  });
});

describe('formatTimeAgo', () => {
  it('returns "just now" for timestamps within the current second', () => {
    expect(formatTimeAgo(NOW)).toBe('just now');
  });

  it('returns seconds for sub-minute differences', () => {
    expect(formatTimeAgo(NOW - 30 * 1000)).toBe('30 seconds ago');
    expect(formatTimeAgo(NOW - 1 * 1000)).toBe('1 second ago');
  });

  it('returns minutes for sub-hour differences', () => {
    expect(formatTimeAgo(NOW - 60 * 1000)).toBe('1 minute ago');
    expect(formatTimeAgo(NOW - 5 * 60 * 1000)).toBe('5 minutes ago');
  });

  it('returns hours for sub-day differences', () => {
    expect(formatTimeAgo(NOW - 60 * 60 * 1000)).toBe('1 hour ago');
    expect(formatTimeAgo(NOW - 3 * 60 * 60 * 1000)).toBe('3 hours ago');
  });

  it('returns days for sub-week differences', () => {
    expect(formatTimeAgo(NOW - 24 * 60 * 60 * 1000)).toBe('1 day ago');
    expect(formatTimeAgo(NOW - 3 * 24 * 60 * 60 * 1000)).toBe('3 days ago');
  });

  it('returns weeks for sub-month differences', () => {
    expect(formatTimeAgo(NOW - 7 * 24 * 60 * 60 * 1000)).toBe('1 week ago');
    expect(formatTimeAgo(NOW - 14 * 24 * 60 * 60 * 1000)).toBe('2 weeks ago');
  });

  it('returns months for sub-year differences', () => {
    expect(formatTimeAgo(NOW - 30 * 24 * 60 * 60 * 1000)).toBe('1 month ago');
    expect(formatTimeAgo(NOW - 90 * 24 * 60 * 60 * 1000)).toBe('3 months ago');
  });

  it('returns years for >=365-day differences', () => {
    expect(formatTimeAgo(NOW - 365 * 24 * 60 * 60 * 1000)).toBe('1 year ago');
    expect(formatTimeAgo(NOW - 2 * 365 * 24 * 60 * 60 * 1000)).toBe('2 years ago');
  });
});
