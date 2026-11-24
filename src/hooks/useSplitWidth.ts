import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface UseSplitWidthOptions {
  storageKey: string;
  defaultWidth: number;
  min: number;
  minRight: number;
  containerRef: React.RefObject<HTMLElement | null>;
}

export interface UseSplitWidth {
  /** Pixels, already clamped to fit. */
  width: number;
  startResize: (e: React.MouseEvent) => void;
  reset: () => void;
}

function read(key: string, fallback: number): number {
  const raw = window.localStorage.getItem(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Window-level mouse events, not pointer capture: the 6px handle is routinely outrun mid-drag.
// Clamped at render: a width stored from a maximised window would squeeze the right pane to nothing.
export function useSplitWidth({
  storageKey, defaultWidth, min, minRight, containerRef,
}: UseSplitWidthOptions): UseSplitWidth {
  const [raw, setRaw] = useState(() => read(storageKey, defaultWidth));
  /** 0 means not measured yet: do not clamp. */
  const [containerWidth, setContainerWidth] = useState(0);

  useLayoutEffect(() => {
    const measure = (): void => {
      setContainerWidth(containerRef.current?.getBoundingClientRect().width ?? 0);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => { window.removeEventListener('resize', measure); };
  }, [containerRef]);

  const max = containerWidth > 0 ? Math.max(min, containerWidth - minRight) : Infinity;
  const width = Math.min(max, Math.max(min, raw));

  /** Read in the move handler: `width` would be captured from the render the drag started in. */
  const widthRef = useRef(width);
  useEffect(() => { widthRef.current = width; }, [width]);

  const startResize = useCallback((e: React.MouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent): void => {
      setRaw(Math.round(startWidth + (ev.clientX - startX)));
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      // Persist the clamped width: storing one the window cannot honour is how the stale width starts.
      try {
        window.localStorage.setItem(storageKey, String(widthRef.current));
      } catch {
        // Quota: the width reverts on reload.
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [storageKey]);

  const reset = useCallback((): void => {
    setRaw(defaultWidth);
    window.localStorage.removeItem(storageKey);
  }, [defaultWidth, storageKey]);

  return { width, startResize, reset };
}
