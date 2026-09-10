import { describe, it, expect } from 'vitest';

import { computeLayoutMode, layoutClassNames, NARROW_MAX_WIDTH } from '@/lib/layoutMode';
import { detectSwipe, pullProgress, PULL_THRESHOLD_PX } from '@/lib/touchGestures';
import { keyboardInset, KEYBOARD_DEAD_BAND_PX } from '@/lib/keyboardInset';

describe('layout mode', () => {
  it('treats iPad portrait as narrow and landscape as wide', () => {
    expect(computeLayoutMode({ width: 820, coarsePointer: true, remoteMode: 'web' })).toEqual({ narrow: true, touch: true, web: true });
    expect(computeLayoutMode({ width: 1180, coarsePointer: true, remoteMode: 'web' })).toEqual({ narrow: false, touch: true, web: true });
  });

  it('keeps the three facts independent', () => {
    // A thin desktop window: narrow, not touch, not web.
    expect(computeLayoutMode({ width: NARROW_MAX_WIDTH - 1, coarsePointer: false, remoteMode: 'electron-remote' })).toEqual({ narrow: true, touch: false, web: false });
    // A wide Electron window in legacy mode: none of the three.
    expect(computeLayoutMode({ width: 1440, coarsePointer: false, remoteMode: 'electron-legacy' })).toEqual({ narrow: false, touch: false, web: false });
    expect(computeLayoutMode({ width: 1440, coarsePointer: false, remoteMode: null })).toMatchObject({ web: false });
  });

  it('mirrors the flags as html classes', () => {
    expect(layoutClassNames({ narrow: true, touch: false, web: true })).toEqual(['omnifex-narrow', 'omnifex-web']);
    expect(layoutClassNames({ narrow: false, touch: false, web: false })).toEqual([]);
  });
});

describe('swipe detection', () => {
  const at = (x: number, y: number, t: number) => ({ x, y, t });

  it('recognises a quick horizontal swipe in either direction', () => {
    expect(detectSwipe(at(300, 400, 0), at(150, 410, 200))).toBe('left');
    expect(detectSwipe(at(100, 400, 0), at(260, 390, 200))).toBe('right');
  });

  it('rejects short, slow, or diagonal movement', () => {
    expect(detectSwipe(at(300, 400, 0), at(250, 400, 200))).toBeNull(); // 50px: too short
    expect(detectSwipe(at(300, 400, 0), at(100, 400, 900))).toBeNull(); // too slow: a drag
    expect(detectSwipe(at(300, 400, 0), at(150, 520, 200))).toBeNull(); // 120px down on 150px across: a scroll
  });
});

describe('pull to refresh', () => {
  it('is zero unless at the top and moving down', () => {
    expect(pullProgress(100, 160, 12)).toBe(0);
    expect(pullProgress(100, 80, 0)).toBe(0);
  });

  it('reaches 1 at the threshold and rubber-bands beyond it', () => {
    expect(pullProgress(100, 100 + PULL_THRESHOLD_PX, 0)).toBe(1);
    expect(pullProgress(100, 100 + PULL_THRESHOLD_PX / 2, 0)).toBeCloseTo(0.5);
    const beyond = pullProgress(100, 100 + PULL_THRESHOLD_PX * 3, 0);
    expect(beyond).toBeGreaterThan(1);
    expect(beyond).toBeLessThan(3);
  });
});

describe('keyboard inset', () => {
  it('is the covered height when the visual viewport shrinks', () => {
    expect(keyboardInset(1180, 800, 0)).toBe(380);
    // Layout viewport scrolled up under the keyboard: offsetTop counts.
    expect(keyboardInset(1180, 800, 100)).toBe(280);
  });

  it('ignores the dead band — a collapsing URL bar is not a keyboard', () => {
    expect(keyboardInset(1180, 1180 - KEYBOARD_DEAD_BAND_PX + 1, 0)).toBe(0);
    expect(keyboardInset(1180, 1180, 0)).toBe(0);
    expect(keyboardInset(1180, Number.NaN, 0)).toBe(0);
  });
});
