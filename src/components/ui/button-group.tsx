import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Buttons joined into one horizontal capsule: one border round the outside
 * and a divider between neighbours (each later child's left border).
 *
 * The divider color carries `!`: the unlayered global `* { border-color }`
 * reset in styles.css outranks every layered border-color utility, so
 * without it the dividers fall back to the faint default. The outer border is
 * left at that default on purpose — it frames, the dividers separate.
 *
 * The group draws the chrome, so each child's own corners and ring are
 * stripped — also with `!`, because a child's utility classes and these child
 * selectors have equal specificity and stylesheet order would otherwise
 * decide. Children's borders are left alone: the divider is one. The
 * vertical rail's equivalent is `GutterButtonGroup`.
 */
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
