import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * The name of a status-bar readout — `model`, `turn`, `repos` — muted, with a
 * colon after it separating it from the value.
 *
 * The colon is drawn by CSS rather than written into the text, so the label's
 * text stays the bare word for anything that reads it (aria names, tests,
 * copy-paste).
 */
export function ReadoutLabel({
  className,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span className={cn("opacity-70 after:content-[':']", className)} {...rest} />;
}
