export interface Point {
  x: number;
  y: number;
  t: number;
}

export interface SwipeOptions {
  /** Minimum horizontal travel in CSS px. */
  minDistance?: number;
  /** Maximum vertical drift allowed, as a fraction of the horizontal travel. */
  maxVerticalRatio?: number;
  maxDurationMs?: number;
}

export type SwipeDirection = 'left' | 'right';

export function detectSwipe(start: Point, end: Point, opts: SwipeOptions = {}): SwipeDirection | null {
  const minDistance = opts.minDistance ?? 80;
  const maxVerticalRatio = opts.maxVerticalRatio ?? 0.5;
  const maxDurationMs = opts.maxDurationMs ?? 600;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (end.t - start.t > maxDurationMs) return null;
  if (Math.abs(dx) < minDistance) return null;
  if (Math.abs(dy) > Math.abs(dx) * maxVerticalRatio) return null;
  return dx < 0 ? 'left' : 'right';
}

export const PULL_THRESHOLD_PX = 72;

/** 0–1 progress; beyond 1 the release fires a refresh. */
export function pullProgress(startY: number, currentY: number, scrollTop: number, threshold = PULL_THRESHOLD_PX): number {
  if (scrollTop > 0) return 0;
  const dy = currentY - startY;
  if (dy <= 0) return 0;
  const eased = dy <= threshold ? dy : threshold + (dy - threshold) * 0.35;
  return eased / threshold;
}

const HSCROLL_SELECTOR = 'pre, code, textarea, input, [data-hscroll], .overflow-x-auto, .overflow-auto';

export function startsInsideHorizontalScroller(target: Element | null): boolean {
  if (!target) return false;
  const el = target.closest(HSCROLL_SELECTOR);
  if (!el) return false;
  // A block that fits does not scroll; let the swipe through it.
  return el.scrollWidth > el.clientWidth || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
}
