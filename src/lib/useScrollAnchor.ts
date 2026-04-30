import { useCallback, useRef } from 'react';

function findScrollParent(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const style = getComputedStyle(cur);
    const oy = style.overflowY;
    if ((oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

/**
 * Keeps an element pinned to its current viewport position across an
 * imminent layout change (e.g. a sibling expander opening or closing).
 * Returns a callback `runWith` that takes a function which performs the
 * state change. The hook captures the element's `top` before, runs the
 * state change, and after layout settles adjusts the nearest scroll
 * container's `scrollTop` to keep the element where it was.
 *
 * Built for Collapsible triggers where opening adds height below the
 * trigger and any concurrent autoscroll would yank the user away from
 * the spot they just clicked.
 */
export function useScrollAnchor<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  const runWith = useCallback((mutate: () => void) => {
    const el = ref.current;
    if (!el) {
      mutate();
      return;
    }
    const beforeTop = el.getBoundingClientRect().top;
    const scrollEl = findScrollParent(el);
    mutate();
    // Two rAFs: first lets React commit, second lets layout settle (and
    // any concurrent ResizeObserver-driven autoscroll fire first).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!scrollEl) return;
        const afterTop = el.getBoundingClientRect().top;
        const delta = afterTop - beforeTop;
        if (Math.abs(delta) > 0.5) {
          scrollEl.scrollTop += delta;
        }
      });
    });
  }, []);

  return { ref, runWith };
}
