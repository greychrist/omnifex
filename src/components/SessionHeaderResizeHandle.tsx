import * as React from 'react';
import { GripHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The grab handle closing the session header assembly.
 *
 * It was a 2px hairline that only brightened on hover — findable only if you
 * already knew it was there. This is the shadcn `ResizableHandle withHandle`
 * treatment instead: a bordered grip pill straddling the assembly's bottom
 * edge, legible at rest, brighter on hover, and held lit for the whole drag.
 *
 * Three states, not two. Hover-only styling drops the moment the pointer
 * leaves the handle, which during a drag is immediately — the pointer is
 * captured and travelling. `resizing` is what keeps it lit while the user is
 * actually doing the thing.
 *
 * Separate from AgentSession so it can be tested without mounting a session;
 * the drag maths stays there, since it owns the height state.
 */
export interface SessionHeaderResizeHandleProps {
  /** True for the duration of a drag — pointer-down to pointer-up. */
  resizing: boolean;
  /** True once a custom height exists, so double-click has something to undo. */
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
      // Read by the assembly wrapper to light its bottom border. An attribute
      // rather than a callback: the wrapper already knows the drag state, and
      // this keeps the handle free of any styling authority over its parent.
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
          // Straddles the border rather than sitting above it, so the grip
          // reads as part of the edge it moves.
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
