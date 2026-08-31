import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface UseSplitWidthOptions {
  /** localStorage key. Each split pane remembers its own width. */
  storageKey: string;
  defaultWidth: number;
  /** Narrowest the left pane may become. */
  min: number;
  /** Room the right pane must keep, whatever the user drags. */
  minRight: number;
  containerRef: React.RefObject<HTMLElement | null>;
}

export interface UseSplitWidth {
  /** The left pane's width in pixels, already clamped to fit. */
  width: number;
  /** `onMouseDown` for the drag handle between the two panes. */
  startResize: (e: React.MouseEvent) => void;
  /** Back to the default. Wired to double-click, the way the session header is. */
  reset: () => void;
}

function read(key: string, fallback: number): number {
  const raw = window.localStorage.getItem(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * A draggable split between a fixed-width left pane and a filling right one.
 *
 * Mouse events at the window level, not pointer capture on the handle: the
 * handle is 6px wide and the cursor routinely outruns it mid-drag, which is
 * the same reason `LogTab`'s column resizer listens on the window.
 *
 * The width is CLAMPED AT RENDER, not only while dragging. A width stored from
 * a maximised window would otherwise reopen on a small one with the right pane
 * squeezed to nothing — the pane the split exists to reveal.
 */
export function useSplitWidth({
  storageKey, defaultWidth, min, minRight, containerRef,
}: UseSplitWidthOptions): UseSplitWidth {
  const [raw, setRaw] = useState(() => read(storageKey, defaultWidth));
  /** 0 until the container has been measured, which means "do not clamp yet". */
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

  /**
   * The live width, for a drag that starts before React has re-rendered.
   * Reading `width` inside the move handler would capture the value from the
   * render the drag started in and quantise the whole gesture to it.
   */
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
      // Persist the CLAMPED width, not the raw one: storing a value the
      // current window cannot honour is how the stale-width bug above starts.
      try {
        window.localStorage.setItem(storageKey, String(widthRef.current));
      } catch {
        // Quota. The width reverts on reload, which is not worth an error.
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
