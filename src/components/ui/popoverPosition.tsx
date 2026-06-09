// Pure positioning math for the custom Popover. Extracted so the
// viewport-clamping behavior is unit-testable without real layout (jsdom
// can't measure). All coordinates are viewport-relative (position: fixed).

export interface PopoverPositionInput {
  triggerRect: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right' | 'width'>;
  contentWidth: number;
  contentHeight: number;
  side: 'top' | 'bottom';
  align: 'start' | 'center' | 'end';
  viewport: { width: number; height: number };
}

/** Gap between trigger and panel, and minimum distance from viewport edges. */
const GAP = 8;

export function computePopoverPosition({
  triggerRect: r,
  contentWidth: cw,
  contentHeight: ch,
  side,
  align,
  viewport,
}: PopoverPositionInput): { top: number; left: number } {
  let top = side === 'top' ? r.top - ch - GAP : r.bottom + GAP;
  let left: number;
  if (align === 'start') left = r.left;
  else if (align === 'end') left = r.right - cw;
  else left = r.left + r.width / 2 - cw / 2;

  // Clamp into the viewport so panels anchored near an edge (e.g. pickers
  // inside a right-aligned popover) never render off-screen. Clamping the
  // max first and the min last keeps the panel pinned to the top/left when
  // it is larger than the viewport.
  left = Math.max(GAP, Math.min(left, viewport.width - cw - GAP));
  top = Math.max(GAP, Math.min(top, viewport.height - ch - GAP));

  return { top, left };
}
