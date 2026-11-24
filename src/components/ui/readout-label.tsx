import * as React from 'react';
import { cn } from '@/lib/utils';

/** The colon is drawn by CSS so the text stays the bare word (aria names, tests, copy). */
export function ReadoutLabel({
  className,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span className={cn("opacity-70 after:content-[':']", className)} {...rest} />;
}
