import * as React from 'react';
import { cn } from '@/lib/utils';

// Inside a colored pill pass `bg-current opacity-30`: the foreground-based rule fights a tinted background.
export function InlineDivider({
  className,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span aria-hidden className={cn('h-3.5 w-px bg-foreground/35 shrink-0', className)} {...rest} />;
}
