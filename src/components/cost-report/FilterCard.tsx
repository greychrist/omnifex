// One labelled group of filter controls.
//
// The filter bar used to be a single `flex flex-wrap` row with bare `|`
// dividers between categories: date presets, then an account picker, then
// model and project selects, then a scope toggle, all the same size and all
// unlabelled. Nothing told you which control did what — you had to already
// know. The category label is the fix, and a card is what makes the label
// scope to something.
//
// Built on `Card` rather than a hand-rolled `border bg-…` div for a specific
// reason: `styles.css` has an unlayered `* { border-color: var(--color-border) }`
// that beats every Tailwind border-colour utility, so `border-border/60` on a
// plain div silently renders at full strength. `Card` sets `borderColor` and
// `backgroundColor` as inline styles, which do win, and its `--color-card`
// surface is a real step off `--color-background` in all three themes.

import React from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Compact sizing for every control inside a filter card, applied in one place
 * rather than threaded through each control's own props. `MultiSelectFilter`
 * and `AccountPicker` build their own triggers, so a descendant selector is
 * the only way to size them without giving each a size prop it would use
 * exactly once.
 */
const COMPACT = '[&_button]:h-7 [&_button]:text-[11px] [&_input]:h-7 [&_input]:text-[11px]';

export function FilterCard({
  label,
  testId,
  className,
  children,
}: {
  label: string;
  testId: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card data-testid={testId} className={cn('px-3 py-2.5', className)}>
      <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </h4>
      {/* Children wrap; a child that wants its own line asks for `w-full`. */}
      <div className={cn('flex flex-wrap items-center gap-1.5', COMPACT)}>{children}</div>
    </Card>
  );
}
