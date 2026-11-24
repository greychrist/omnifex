import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The first column flexes and is untracked. A drag between two sized columns moves width from one to the
 * other, so only the boundary moves; the boundary beside the flexible column has no `grow` partner.
 */

export interface ResizeSpec<K extends string> {
  /** Omitted at the boundary beside the flexible column. */
  grow?: K;
  shrink: K;
}

export interface UseColumnWidthsOptions<K extends string> {
  storageKey: string;
  /** Pixels. */
  defaults: Record<K, number>;
  min: number;
  /** Pixels the flexible column must keep. */
  reserve: number;
  containerRef: React.RefObject<HTMLElement | null>;
}

export interface UseColumnWidths<K extends string> {
  widths: Record<K, number>;
  startResize: (e: React.MouseEvent, spec: ResizeSpec<K>) => void;
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

// Each column gives up overflow in proportion to its room above the minimum: emptying the rightmost
// (date) column first makes the default sort unreadable.
function fit<K extends string>(
  widths: Record<K, number>, order: readonly K[], available: number, min: number,
): Record<K, number> {
  const over = order.reduce((sum, k) => sum + widths[k], 0) - available;
  if (over <= 0) return widths;

  const out = { ...widths };
  const slack = order.map((k) => Math.max(0, widths[k] - min));
  const total = slack.reduce((a, b) => a + b, 0);
  if (total <= over) {
    for (const k of order) out[k] = Math.min(out[k], min);
    return out;
  }

  order.forEach((k, i) => { out[k] -= Math.round((over * slack[i]) / total); });
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

  const order = Object.keys(defaults) as K[];
  // Clamped at render, not only while dragging: widths stored in a wide window would squeeze the flexible column to nothing.
  const widths = containerWidth > 0
    ? fit(raw, order, containerWidth - reserve, min)
    : raw;

  const widthsRef = useRef(widths);
  useEffect(() => { widthsRef.current = widths; }, [widths]);

  const startResize = useCallback((e: React.MouseEvent, spec: ResizeSpec<K>): void => {
    e.preventDefault();
    // Without this the drag re-sorts the table on release.
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
        // Quota: the widths revert on reload.
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
