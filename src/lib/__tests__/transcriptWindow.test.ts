import { describe, it, expect } from 'vitest';
import { TRANSCRIPT_WINDOW_ROWS as W, windowStart, earlierStart } from '@/lib/transcriptWindow';

describe('windowStart', () => {
  it('shows everything when the transcript fits in one window', () => {
    expect(windowStart(10, null)).toBe(0);
    expect(windowStart(W, null)).toBe(0);
  });

  it('follows the tail when nothing is pinned', () => {
    expect(windowStart(W + 40, null)).toBe(40);
  });

  it('holds a pinned start as rows are appended', () => {
    expect(windowStart(W + 40, 40)).toBe(40);
    expect(windowStart(W + 90, 40)).toBe(40);
  });

  it('clamps a pinned start when the transcript shrinks under it', () => {
    expect(windowStart(W + 10, 40)).toBe(10);
    expect(windowStart(5, 40)).toBe(0);
  });
});

describe('earlierStart', () => {
  it('steps back one window, stopping at the first row', () => {
    expect(earlierStart(W * 2 + 5)).toBe(W + 5);
    expect(earlierStart(3)).toBe(0);
  });
});
