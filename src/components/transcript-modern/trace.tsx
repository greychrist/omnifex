/**
 * shadcn's Trace (ui.shadcn.com, AI › Chain of Thought), ported onto our
 * Radix collapsible. Class strings are theirs, except two of their utilities
 * we don't have: `shimmer` (our Shimmer span instead) and the collapsible
 * height transition (Radix exposes a different variable; no animation).
 *
 * A Trace is a column of TraceLines; a line is a status icon, a title, an
 * optional muted description. A collapsible line rotates a chevron after its
 * title and opens onto content set off by a left rule.
 */
import * as React from 'react';
import { ChevronRightIcon, CircleAlertIcon, CircleCheckIcon, CircleIcon, LoaderCircleIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export type TraceStatus = 'running' | 'error' | 'pending';

export function Trace({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="trace" className={cn('flex w-full min-w-0 flex-col gap-2', className)} {...props} />;
}

export function TraceLine({
  className,
  status,
  ...props
}: React.ComponentProps<'span'> & { status?: TraceStatus }) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      className={cn(
        'flex w-fit max-w-full min-w-0 items-center gap-2 text-sm text-muted-foreground transition-colors',
        'in-[button]:cursor-pointer in-[button:hover]:text-foreground',
        'data-[status=error]:text-destructive data-[status=error]:in-[button:hover]:text-destructive data-[status=pending]:opacity-60',
        className,
      )}
      {...props}
    />
  );
}

export function TraceIcon({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

export function TraceTitle({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="trace-title" className={cn('min-w-0 truncate', className)} {...props} />;
}

export function TraceDescription({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span data-slot="trace-description" className={cn('shrink-0 tabular-nums text-muted-foreground/70', className)} {...props} />
  );
}

/** The status circle Trace's examples use: check, spinner, alert, or empty while waiting. */
export function TraceStatusIcon({ status }: { status?: TraceStatus }) {
  if (status === 'running') return <LoaderCircleIcon className="animate-spin" />;
  if (status === 'error') return <CircleAlertIcon />;
  if (status === 'pending') return <CircleIcon />;
  return <CircleCheckIcon />;
}

export const TraceCollapsible = Collapsible;

export function TraceCollapsibleTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger
      data-slot="trace-collapsible-trigger"
      className={cn(
        'group/trace-trigger flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-lg text-left text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30',
        className,
      )}
      {...props}
    >
      {children}
      <TraceIcon className="transition-transform group-aria-expanded/trace-trigger:rotate-90">
        <ChevronRightIcon />
      </TraceIcon>
    </CollapsibleTrigger>
  );
}

export function TraceCollapsibleContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent data-slot="trace-collapsible-content" className="min-w-0 overflow-hidden" {...props}>
      <div
        className={cn(
          'mt-2 mb-1 ml-[7px] min-w-0 border-l border-border pr-1 pl-4 text-sm leading-relaxed break-words text-muted-foreground',
          className,
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}
