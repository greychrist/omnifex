import React from 'react';

export const SplitHandle: React.FC<{
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  label: string;
}> = ({ onMouseDown, onDoubleClick, label }) => (
  <div
    role="separator"
    aria-orientation="vertical"
    // Lets outside-press dismissal treat a press here as a drag start.
    data-omnifex-split-handle=""
    aria-label={label}
    onMouseDown={onMouseDown}
    onDoubleClick={onDoubleClick}
    title="Drag to resize · double-click to reset"
    className="group relative w-px shrink-0 cursor-col-resize bg-border"
  >
    {/* Wider invisible hit target: 1px is not grabbable. */}
    <div className="absolute inset-y-0 -left-1 -right-1 group-hover:bg-primary/30 group-active:bg-primary/50" />
  </div>
);

export default SplitHandle;
