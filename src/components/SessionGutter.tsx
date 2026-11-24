import * as React from 'react';
import { PanelRightOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TooltipSimple } from '@/components/ui/tooltip-modern';

export const GUTTER_BUTTON =
  'h-8 w-8 hover:bg-accent/50 transition-colors bg-background/80 backdrop-blur-sm border border-border/50';

// 2px narrower than GUTTER_BUTTON: the group's border sits outside its buttons.
export const GUTTER_GROUP_BUTTON = 'h-8 w-[30px] rounded-none hover:bg-accent/50 transition-colors';

// Disabled buttons sit in spans for their tooltips; spans are made blocks so the divide-y hairline draws.
export function GutterButtonGroup({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-col divide-y overflow-hidden rounded-md border border-border/50 bg-background/80 backdrop-blur-sm [&>span]:flex"
    >
      {children}
    </div>
  );
}

// The full-height column is pointer-events-none (groups opt back in), or it swallows transcript clicks.
export function SessionGutter({
  top,
  children,
}: {
  top?: React.ReactNode;
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
  onOpenInspector?: () => void;
  inspectorOpen?: boolean;
}

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
