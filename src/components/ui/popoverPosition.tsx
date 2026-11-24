export interface PopoverPositionInput {
  triggerRect: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right' | 'width'>;
  contentWidth: number;
  contentHeight: number;
  side: 'top' | 'bottom';
  align: 'start' | 'center' | 'end';
  viewport: { width: number; height: number };
}

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

  // Max first, min last: a panel larger than the viewport stays pinned top/left.
  left = Math.max(GAP, Math.min(left, viewport.width - cw - GAP));
  top = Math.max(GAP, Math.min(top, viewport.height - ch - GAP));

  return { top, left };
}
