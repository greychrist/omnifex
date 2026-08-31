import React from 'react';

/**
 * The grabbable divider between a fixed-width pane and a filling one.
 *
 * Its own component so the two Brain panes present the same target: a 1px rule
 * that widens to a visible bar on hover. A bare `border-r` is not draggable at
 * any useful hit size, and two hand-rolled handles drift apart.
 *
 * Double-click resets, matching the session header's resize handle.
 */
export const SplitHandle: React.FC<{
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  label: string;
}> = ({ onMouseDown, onDoubleClick, label }) => (
  <div
    role="separator"
    aria-orientation="vertical"
    // Marks the handle for dismissal rules that ask "was this press outside
    // my pane?" — a press here is the start of a drag, not a press away.
    data-omnifex-split-handle=""
    aria-label={label}
    onMouseDown={onMouseDown}
    onDoubleClick={onDoubleClick}
    title="Drag to resize · double-click to reset"
    className="group relative w-px shrink-0 cursor-col-resize bg-border"
  >
    {/* A wider invisible target over the hairline: 1px is drawable but not
        grabbable, and this is the whole reason a hairline can be a handle. */}
    <div className="absolute inset-y-0 -left-1 -right-1 group-hover:bg-primary/30 group-active:bg-primary/50" />
  </div>
);

export default SplitHandle;
