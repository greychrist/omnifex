import { describe, it, expect } from 'vitest';
import { computePopoverPosition } from '../popoverPosition';

const VIEWPORT = { width: 1000, height: 800 };

function rect(left: number, top: number, width = 100, height = 36): DOMRect {
  return {
    left, top, width, height,
    right: left + width,
    bottom: top + height,
    x: left, y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('computePopoverPosition', () => {
  it('anchors at the trigger left for align=start', () => {
    const pos = computePopoverPosition({
      triggerRect: rect(200, 100),
      contentWidth: 300,
      contentHeight: 400,
      side: 'bottom',
      align: 'start',
      viewport: VIEWPORT,
    });
    expect(pos.left).toBe(200);
    expect(pos.top).toBe(100 + 36 + 8); // below trigger + gap
  });

  it('clamps the right edge so the panel never leaves the viewport', () => {
    const pos = computePopoverPosition({
      triggerRect: rect(900, 100), // trigger near the right edge
      contentWidth: 300,
      contentHeight: 400,
      side: 'bottom',
      align: 'start',
      viewport: VIEWPORT,
    });
    expect(pos.left + 300).toBeLessThanOrEqual(VIEWPORT.width - 8);
  });

  it('clamps the left edge for align=end overflow', () => {
    const pos = computePopoverPosition({
      triggerRect: rect(10, 100, 50),
      contentWidth: 300,
      contentHeight: 400,
      side: 'bottom',
      align: 'end', // r.right - cw = 60 - 300 = -240 → clamp
      viewport: VIEWPORT,
    });
    expect(pos.left).toBeGreaterThanOrEqual(8);
  });

  it('clamps the bottom edge so tall panels stay on screen', () => {
    const pos = computePopoverPosition({
      triggerRect: rect(200, 700),
      contentWidth: 300,
      contentHeight: 400,
      side: 'bottom',
      align: 'start',
      viewport: VIEWPORT,
    });
    expect(pos.top + 400).toBeLessThanOrEqual(VIEWPORT.height - 8);
  });

  it('clamps the top edge for side=top overflow', () => {
    const pos = computePopoverPosition({
      triggerRect: rect(200, 50),
      contentWidth: 300,
      contentHeight: 400,
      side: 'top', // 50 - 400 - 8 < 0 → clamp
      align: 'start',
      viewport: VIEWPORT,
    });
    expect(pos.top).toBeGreaterThanOrEqual(8);
  });
});
