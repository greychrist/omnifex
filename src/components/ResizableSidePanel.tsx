import * as React from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { SURFACE_BODY_BG, SURFACE_HEADER } from '@/lib/surfaceStyles';

// Mount inside the messages area: it is `inset-y-0` of its own container.
// The slide-in lives here, not in a wrapper: a transformed wrapper becomes the containing block and has no size.

const MIN_WIDTH = 240;
const MAX_WIDTH = 900;
const FALLBACK_WIDTH = 384;

function clampWidth(n: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(n)));
}

function loadWidth(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = JSON.parse(raw) as unknown;
    return typeof n === 'number' && Number.isFinite(n) ? clampWidth(n) : fallback;
  } catch {
    return fallback;
  }
}

export interface ResizableSidePanelProps {
  /** Distinct per panel, or two panels resize each other. */
  storageKey: string;
  title: string;
  actions?: React.ReactNode;
  onClose?: () => void;
  defaultWidth?: number;
  children: React.ReactNode;
  className?: string;
}

export function ResizableSidePanel({
  storageKey,
  title,
  actions,
  onClose,
  defaultWidth = FALLBACK_WIDTH,
  children,
  className,
}: ResizableSidePanelProps): React.JSX.Element {
  const [width, setWidth] = React.useState(() => loadWidth(storageKey, defaultWidth));

  const persist = React.useCallback((n: number) => {
    try { localStorage.setItem(storageKey, JSON.stringify(n)); } catch { /* quota / private mode */ }
  }, [storageKey]);

  const onResizeStart = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const gripEl = e.currentTarget;
    const startX = e.clientX;
    const origin = width;
    let latest: number | null = null;

    gripEl.setPointerCapture(e.pointerId);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: PointerEvent) => {
      latest = clampWidth(origin - (ev.clientX - startX));
      setWidth(latest);
    };
    const onUp = () => {
      gripEl.removeEventListener('pointermove', onMove);
      gripEl.removeEventListener('pointerup', onUp);
      gripEl.removeEventListener('pointercancel', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      if (latest !== null) persist(latest);
    };
    gripEl.addEventListener('pointermove', onMove);
    gripEl.addEventListener('pointerup', onUp);
    gripEl.addEventListener('pointercancel', onUp);
  }, [width, persist]);

  const onResizeReset = React.useCallback(() => {
    setWidth(defaultWidth);
    persist(defaultWidth);
  }, [defaultWidth, persist]);

  return (
    <motion.div
      data-testid="resizable-side-panel"
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      style={{ width: `${width}px` }}
      className={cn(
        'absolute inset-y-0 right-0 z-20 flex max-w-full flex-col',
        'border-l shadow-xl',
        SURFACE_BODY_BG,
        className,
      )}
    >
      <div className={cn('flex flex-none items-center gap-1 px-3 py-2.5', SURFACE_HEADER)}>
        <h3 className="flex-1 text-sm font-semibold">{title}</h3>
        {actions}
        {onClose ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Close ${title}`}
            onClick={onClose}
            className="h-7 w-7"
          >
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>

      {/* Sits just outside the content so the grab target doesn't eat clicks on the panel's rows. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel (double-click to reset)"
        title="Drag to resize · double-click to reset"
        onPointerDown={onResizeStart}
        onDoubleClick={onResizeReset}
        className="group absolute inset-y-0 -left-1 w-2 cursor-col-resize touch-none"
      >
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-foreground/30" />
      </div>
    </motion.div>
  );
}
