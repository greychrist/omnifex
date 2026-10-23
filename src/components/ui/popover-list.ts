import { cn } from '@/lib/utils';

/**
 * The status-bar popovers' shared grammar, taken from the account popover
 * (`AccountDetails`): a small-caps section label over xs rows, inside the
 * Popover's own p-4. Option lists use it so a picker reads as the same family
 * as the readouts beside it rather than a frame of its own.
 */
export const POPOVER_SECTION = 'text-[10px] uppercase tracking-wider text-muted-foreground';

/** One pickable row. `-mx-2` lets the hover fill reach into the popover's
 *  padding while the text stays aligned with the section label. */
export function popoverOption(active: boolean): string {
  return cn(
    '-mx-2 flex items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent',
    active && 'bg-accent',
  );
}

/** An option's description line under its name. */
export const POPOVER_OPTION_DETAIL = 'text-[11px] text-foreground/50';

/** Hairline between groups of rows. */
export const POPOVER_RULE = 'border-t border-border/50';
