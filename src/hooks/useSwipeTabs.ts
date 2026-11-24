/** Dispatches the tab strip's own window events, so a swipe is exactly a keyboard tab switch. */
import { useEffect, type RefObject } from 'react';

import { detectSwipe, startsInsideHorizontalScroller, type Point } from '@/lib/touchGestures';

export function useSwipeTabs(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let start: Point | null = null;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        start = null;
        return;
      }
      if (startsInsideHorizontalScroller(e.target as Element | null)) {
        start = null;
        return;
      }
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, t: e.timeStamp };
    };
    const onEnd = (e: TouchEvent) => {
      if (!start) return;
      const t = e.changedTouches[0];
      const dir = detectSwipe(start, { x: t.clientX, y: t.clientY, t: e.timeStamp });
      start = null;
      if (dir === 'left') window.dispatchEvent(new CustomEvent('switch-to-next-tab'));
      else if (dir === 'right') window.dispatchEvent(new CustomEvent('switch-to-previous-tab'));
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchend', onEnd);
    };
  }, [ref, enabled]);
}
