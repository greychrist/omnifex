import { describe, it, expect } from 'vitest';
import { formatDurationMs } from '../duration';

describe('formatDurationMs', () => {
  it('formats sub-minute durations with two decimals of seconds', () => {
    expect(formatDurationMs(0)).toBe('0.00s');
    expect(formatDurationMs(123)).toBe('0.12s');
    expect(formatDurationMs(1500)).toBe('1.50s');
    expect(formatDurationMs(45230)).toBe('45.23s');
  });

  it('formats durations >= 1 minute as "Xm Y.YYs"', () => {
    expect(formatDurationMs(60000)).toBe('1m 0.00s');
    expect(formatDurationMs(75550)).toBe('1m 15.55s');
    expect(formatDurationMs(723400)).toBe('12m 3.40s');
  });

  it('formats durations >= 1 hour as "Xh Ym Z.ZZs"', () => {
    expect(formatDurationMs(3600_000)).toBe('1h 0m 0.00s');
    expect(formatDurationMs(3600_000 + 5 * 60_000 + 22_000)).toBe('1h 5m 22.00s');
    expect(formatDurationMs(2 * 3600_000 + 59 * 60_000 + 59_990)).toBe('2h 59m 59.99s');
  });

  it('handles negative or NaN inputs gracefully', () => {
    expect(formatDurationMs(-100)).toBe('0.00s');
    expect(formatDurationMs(NaN)).toBe('0.00s');
  });
});
