import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A vertical hairline between two readouts on one line.
 *
 * Decorative by construction: it separates values that each carry their own
 * label or accessible name, so announcing it would only add noise between
 * them.
 *
 * `bg-border` was the first attempt and read as almost nothing at 10px type
 * against the status bar's translucent surface — `bg-foreground` at low alpha
 * tracks the text it is separating instead of the chrome around it, so it
 * stays visible in both themes.
 *
 * Inside a coloured pill pass `bg-current opacity-30` so the rule takes the
 * pill's own text colour — a foreground-based rule is mixed for the chat
 * surface and fights a tinted background.
 */
export function InlineDivider({
  className,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span aria-hidden className={cn('h-3.5 w-px bg-foreground/35 shrink-0', className)} {...rest} />;
}
