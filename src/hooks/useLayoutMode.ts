/**
 * `computeLayoutMode()` bound to the live window, shared by every subscriber.
 *
 * One listener set per page, not per component: the value changes on resize
 * and on rotation, and forty components each adding a resize listener is the
 * kind of thing that shows up in the render profiler. The current mode is
 * also mirrored as classes on <html> so plain CSS can branch.
 */
import { useSyncExternalStore } from 'react';

import { ALL_LAYOUT_CLASSES, computeLayoutMode, layoutClassNames, type LayoutMode } from '@/lib/layoutMode';

let current: LayoutMode = { narrow: false, touch: false, web: false };
let listeners = new Set<() => void>();
let started = false;

function read(): LayoutMode {
  if (typeof window === 'undefined') return current;
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return computeLayoutMode({
    width: window.innerWidth,
    coarsePointer: coarse,
    remoteMode: window.__omnifexRemote?.mode ?? null,
  });
}

function apply(next: LayoutMode): void {
  if (next.narrow === current.narrow && next.touch === current.touch && next.web === current.web) return;
  current = next;
  if (typeof document !== 'undefined') {
    const cl = document.documentElement.classList;
    cl.remove(...ALL_LAYOUT_CLASSES);
    cl.add(...layoutClassNames(next));
  }
  for (const l of listeners) l();
}

function start(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  apply(read());
  const onChange = () => apply(read());
  window.addEventListener('resize', onChange);
  window.addEventListener('orientationchange', onChange);
  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(pointer: coarse)');
    mq.addEventListener?.('change', onChange);
  }
}

function subscribe(l: () => void): () => void {
  start();
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** For tests: reset the module-level store. */
export function __resetLayoutModeForTests(): void {
  current = { narrow: false, touch: false, web: false };
  listeners = new Set();
  started = false;
}
