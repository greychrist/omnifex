import { cn } from '@/lib/utils';

export const POPOVER_SECTION = 'text-[10px] uppercase tracking-wider text-muted-foreground';

/** `-mx-2` reaches into the Popover's padding while the text stays aligned with the section label. */
export function popoverOption(active: boolean): string {
  return cn(
    '-mx-2 flex items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent',
    active && 'bg-accent',
  );
}

export const POPOVER_OPTION_DETAIL = 'text-[11px] text-foreground/50';

export const POPOVER_RULE = 'border-t border-border/50';
