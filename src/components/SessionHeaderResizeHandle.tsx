import * as React from 'react';
import { GripHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

// `resizing` keeps it lit through a drag: the captured pointer leaves the handle at once, dropping hover styles.
export interface SessionHeaderResizeHandleProps {
  resizing: boolean;
  canReset?: boolean;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDoubleClick?: () => void;
}

export function SessionHeaderResizeHandle({
  resizing,
  canReset = false,
  onPointerDown,
  onDoubleClick,
}: SessionHeaderResizeHandleProps): React.JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize session header (double-click to reset)"
      data-resizing={resizing ? 'true' : undefined}
      data-testid="header-resize-handle"
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      className={cn(
        'group absolute bottom-0 left-0 right-0 z-10 flex h-2 cursor-ns-resize',
        'touch-none items-center justify-center',
      )}
      title={canReset ? 'Drag to resize · double-click to reset' : 'Drag to resize'}
    >
      <div
        data-testid="header-resize-grip"
        className={cn(
          'flex h-3 w-7 translate-y-[5px] items-center justify-center rounded-sm border',
          'transition-colors duration-150',
          resizing
            ? 'bg-accent text-foreground'
            : 'bg-muted text-muted-foreground/60 group-hover:bg-accent group-hover:text-foreground',
        )}
      >
        <GripHorizontal className="h-2.5 w-2.5" aria-hidden="true" />
      </div>
    </div>
  );
}
