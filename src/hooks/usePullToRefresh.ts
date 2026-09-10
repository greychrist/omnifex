/**
 * Pull-to-refresh on a scrolling list, touch only.
 *
 * Returns the pull progress (0–1+) for an indicator and whether a refresh is
 * running. The list itself is not moved — that fights the browser's own
 * overscroll — only the indicator reacts.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';

import { pullProgress } from '@/lib/touchGestures';

export interface PullState {
  progress: number;
  refreshing: boolean;
}

export function usePullToRefresh(
  ref: RefObject<HTMLElement | null>,
  onRefresh: (() => Promise<void> | void) | undefined,
  enabled: boolean,
): PullState {
  const [state, setState] = useState<PullState>({ progress: 0, refreshing: false });
  const startY = useRef<number | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || !onRefresh) return;

    const onStart = (e: TouchEvent) => {
      startY.current = e.touches.length === 1 && el.scrollTop === 0 ? e.touches[0].clientY : null;
    };
    const onMove = (e: TouchEvent) => {
      if (startY.current === null || busy.current) return;
      const p = pullProgress(startY.current, e.touches[0].clientY, el.scrollTop);
      setState((s) => (s.progress === p ? s : { ...s, progress: p }));
    };
    const onEnd = () => {
      if (startY.current === null) return;
      const fire = state.progress >= 1;
      startY.current = null;
      if (!fire || busy.current) {
        setState((s) => ({ ...s, progress: 0 }));
        return;
      }
      busy.current = true;
      setState({ progress: 1, refreshing: true });
      Promise.resolve(onRefresh())
        .catch(() => {})
        .finally(() => {
          busy.current = false;
          setState({ progress: 0, refreshing: false });
        });
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [ref, onRefresh, enabled, state.progress]);

  return state;
}
