import * as React from 'react';
import { cn } from '@/lib/utils';

// `!` on the divider color: the unlayered `* { border-color }` reset outranks layered utilities. `!` on child corners/ring: equal specificity would let stylesheet order decide.
export function ButtonGroup({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'flex items-stretch overflow-hidden rounded-sm border border-muted-foreground/45',
        '[&>*]:rounded-none! [&>*]:shadow-none!',
        '[&>*+*]:border-l [&>*+*]:border-l-muted-foreground/45!',
        className,
      )}
    >
      {children}
    </div>
  );
}
