/**
 * A notification or a stop in the Modern format: one Trace-style line — icon
 * and text in the transcript's own type — instead of a classic card. A stop
 * uses the triangle the classic Stop Request card has in its header, in red.
 */
import { CircleAlertIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { NoticeTone } from '@/lib/modernGrouping';

const ICON = { stop: TriangleAlertIcon, error: CircleAlertIcon, warn: TriangleAlertIcon, info: InfoIcon } as const;
const COLOR = { stop: 'text-destructive', error: 'text-destructive', warn: 'text-amber-500', info: 'text-muted-foreground' } as const;

export function NoticeLine({ tone, text }: { tone: NoticeTone; text: string }) {
  const Icon = ICON[tone];
  return (
    <div role={tone === 'info' ? 'status' : 'alert'} className={cn('flex items-center gap-2 text-sm', COLOR[tone])}>
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}
