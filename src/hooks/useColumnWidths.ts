import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Draggable column widths for a table whose FIRST column flexes.
 *
 * The tables in this app all have the same shape: one column carrying the
 * thing you read — a name, a message — and a few narrow columns of metadata
 * after it. Sizing every column and letting the last one stretch (the shape
 * `LogTab` uses) puts the slack on the right, under a date, which is the one
 * place none of it is useful. So the flexible column here is the one with no
 * width at all, and this hook only ever tracks the sized ones.
 *
 * That choice fixes what a handle means. A boundary between two sized columns
 * moves by taking width from one and giving it to the other, so the boundary
 * lands exactly where the cursor did and nothing else on the row shifts. The
 * boundary beside the flexible column has nothing to give width to — the
 * flexible column simply absorbs it — so that drag names no `grow` partner.
 */

export interface ResizeSpec<K extends string> {
  /** Column that widens as the handle travels right. Omitted at the boundary
   *  beside the flexible column, which takes the space without being told. */
  grow?: K;
  /** Column that gives the space up. */
  shrink: K;
}

export interface UseColumnWidthsOptions<K extends string> {
  /** localStorage key. Each table remembers its own columns. */
  storageKey: string;
  /** Sized columns, left to right, with their starting widths in pixels. */
  defaults: Record<K, number>;
  /** Narrowest any one column may become. */
  min: number;
  /** Pixels the flexible column must keep whatever the sized ones do. */
  reserve: number;
  containerRef: React.RefObject<HTMLElement | null>;
}

export interface UseColumnWidths<K extends string> {
  /** Widths in pixels, already clamped to fit the container. */
  widths: Record<K, number>;
  /** `onMouseDown` for a handle sitting on the right edge of a column. */
  startResize: (e: React.MouseEvent, spec: ResizeSpec<K>) => void;
  /** Back to the defaults. Wired to double-click, like `useSplitWidth`. */
  reset: () => void;
}

function read<K extends string>(
  key: string, defaults: Record<K, number>, min: number,
): Record<K, number> {
  let stored: unknown;
  try {
    stored = JSON.parse(window.localStorage.getItem(key) ?? 'null');
  } catch {
    return defaults;
  }
  if (stored === null || typeof stored !== 'object') return defaults;
  const record = stored as Record<string, unknown>;
  const out = { ...defaults };
  for (const k of Object.keys(defaults) as K[]) {
    const n = record[k];
    if (typeof n === 'number' && Number.isFinite(n) && n >= min) out[k] = Math.round(n);
  }
  return out;
}

/**
 * Shrink the sized columns until they and the reserve fit the container.
 *
 * Each column gives up a share of the overflow proportional to the room it has
 * above the minimum, rather than the rightmost one absorbing all of it. In the
 * notes table the rightmost column is the date, and a rule that empties it
 * first makes the default sort order unreadable the moment a note is opened.
 */
function fit<K extends string>(
  widths: Record<K, number>, order: readonly K[], available: number, min: number,
): Record<K, number> {
  const over = order.reduce((sum, k) => sum + widths[k], 0) - available;
  if (over <= 0) return widths;

  const out = { ...widths };
  const slack = order.map((k) => Math.max(0, widths[k] - min));
  const total = slack.reduce((a, b) => a + b, 0);
  // Narrower than every column's minimum put together: there is nothing left
  // to apportion, so everything goes to its floor and the table scrolls.
  if (total <= over) {
    for (const k of order) out[k] = Math.min(out[k], min);
    return out;
  }

  order.forEach((k, i) => { out[k] -= Math.round((over * slack[i]) / total); });
  // Rounding can leave a pixel or two unaccounted for. The rightmost column
  // with room takes it, where a pixel is least likely to be noticed.
  let residual = order.reduce((sum, k) => sum + out[k], 0) - available;
  for (let i = order.length - 1; i >= 0 && residual > 0; i--) {
    const give = Math.min(residual, out[order[i]] - min);
    if (give > 0) {
      out[order[i]] -= give;
      residual -= give;
    }
  }
  return out;
}

export function useColumnWidths<K extends string>({
  storageKey, defaults, min, reserve, containerRef,
}: UseColumnWidthsOptions<K>): UseColumnWidths<K> {
  const [raw, setRaw] = useState(() => read(storageKey, defaults, min));
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

  const order = Object.keys(defaults) as K[];
  // Clamped at render, not only while dragging. Widths stored in a wide window
  // would otherwise reopen in a narrow one with the flexible column squeezed
  // to nothing — the column the table exists to show.
  const widths = containerWidth > 0
    ? fit(raw, order, containerWidth - reserve, min)
    : raw;

  /** The live widths, for a drag that starts before React has re-rendered. */
  const widthsRef = useRef(widths);
  useEffect(() => { widthsRef.current = widths; }, [widths]);

  const startResize = useCallback((e: React.MouseEvent, spec: ResizeSpec<K>): void => {
    e.preventDefault();
    // The handle sits inside the sort button's header cell; without this the
    // drag would re-sort the table on release.
    e.stopPropagation();
    const startX = e.clientX;
    const start = widthsRef.current;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent): void => {
      let dx = Math.round(ev.clientX - startX);
      dx = Math.min(dx, start[spec.shrink] - min);
      if (spec.grow !== undefined) dx = Math.max(dx, min - start[spec.grow]);
      const next = { ...start, [spec.shrink]: start[spec.shrink] - dx } as Record<K, number>;
      if (spec.grow !== undefined) next[spec.grow] = start[spec.grow] + dx;
      setRaw(next);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(widthsRef.current));
      } catch {
        // Quota. The widths revert on reload, which is not worth an error.
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [min, storageKey]);

  const reset = useCallback((): void => {
    setRaw(defaults);
    window.localStorage.removeItem(storageKey);
  }, [defaults, storageKey]);

  return { widths, startResize, reset };
}
