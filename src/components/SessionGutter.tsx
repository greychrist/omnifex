import * as React from 'react';
import { PanelRightOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TooltipSimple } from '@/components/ui/tooltip-modern';

/**
 * Chrome for a button in the right-hand rail. Exported because the three
 * surfaces that have a rail — rendered chat, TUI and Codex — were each
 * carrying their own copy of this string, and two of them had already drifted
 * from being one declaration.
 */
export const GUTTER_BUTTON =
  'h-8 w-8 hover:bg-accent/50 transition-colors bg-background/80 backdrop-blur-sm border border-border/50';

/**
 * The right-hand rail: a full-height column with two ends.
 *
 * `children` sit at the bottom, where the scroll and stepper controls belong
 * — near the composer, where the hand already is. `top` pins to the top edge
 * instead of riding on top of that stack, which is the difference between
 * "above the other buttons" and "at the top of the rail".
 *
 * The column spans the full height, so it is `pointer-events-none` with the
 * two groups opting back in: otherwise an invisible full-height strip down
 * the right edge of the transcript would swallow clicks and scrolls.
 */
export function SessionGutter({
  top,
  children,
}: {
  /** Pinned to the top edge of the rail. */
  top?: React.ReactNode;
  /** Pinned to the bottom edge. */
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="absolute right-1 top-2 bottom-6 z-10 flex flex-col items-center justify-between pointer-events-none">
      <div data-testid="gutter-top" className="flex flex-col gap-1 pointer-events-auto">{top}</div>
      <div data-testid="gutter-bottom" className="flex flex-col gap-1 pointer-events-auto">{children}</div>
    </div>
  );
}

export interface InspectorGutterButtonProps {
  /** Omit on a surface that has no inspector to open. */
  onOpenInspector?: () => void;
  /** The panel has its own close control, so the opener hides while it is up. */
  inspectorOpen?: boolean;
}

/**
 * Opens the session inspector, from the top of the rail.
 *
 * It used to be an `absolute top-2 right-2` button floating over the content
 * area, attached to nothing and matching none of the other chrome — and once
 * the chat status bar arrived above the transcript, it sat on top of it. It
 * now pins to the top of the rail: same column and same chrome as the
 * steppers, but its own end of it rather than stacked on theirs.
 */
export function InspectorGutterButton({
  onOpenInspector,
  inspectorOpen,
}: InspectorGutterButtonProps): React.JSX.Element | null {
  if (!onOpenInspector || inspectorOpen) return null;
  return (
    <TooltipSimple content="Show session inspector" side="left">
      <Button
        variant="ghost"
        size="icon"
        onClick={onOpenInspector}
        aria-label="Show session inspector"
        className={GUTTER_BUTTON}
      >
        <PanelRightOpen className="h-3.5 w-3.5" />
      </Button>
    </TooltipSimple>
  );
}
