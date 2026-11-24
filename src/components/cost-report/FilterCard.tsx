// Card, not a hand-rolled border div: the unlayered `* { border-color }` in styles.css beats border-color utilities; Card sets inline styles.

import React from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** A descendant selector: MultiSelectFilter and AccountPicker build their own triggers. */
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
      <div className={cn('flex flex-wrap items-center gap-1.5', COMPACT)}>{children}</div>
    </Card>
  );
}
