import * as React from 'react';
import { ChevronRightIcon, CircleAlertIcon, CircleCheckIcon, CircleIcon, LoaderCircleIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export type TraceStatus = 'running' | 'error' | 'pending' | 'warn';

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
        'data-[status=warn]:text-amber-500 data-[status=warn]:in-[button:hover]:text-amber-500',
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
  chevron = true,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  chevron?: boolean;
}) {
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
      {chevron && (
        <TraceIcon className="transition-transform group-aria-expanded/trace-trigger:rotate-90">
          <ChevronRightIcon />
        </TraceIcon>
      )}
    </CollapsibleTrigger>
  );
}

export function TraceCollapsibleContent({
  className,
  children,
  ruleColor,
  ...props
}: React.ComponentProps<typeof CollapsibleContent> & {
  /** Inline, because the unlayered `* { border-color }` reset beats border-color utilities. */
  ruleColor?: string;
}) {
  return (
    <CollapsibleContent data-slot="trace-collapsible-content" className="min-w-0 overflow-hidden" {...props}>
      <div
        style={ruleColor ? { borderLeftColor: ruleColor } : undefined}
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
