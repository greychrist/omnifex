/**
 * ExitPlanMode in the Modern format — AI Elements' Plan: a card with the
 * plan's title and opening line, the whole plan behind a chevron, and a
 * footer saying where it stands. Approving still happens on the live
 * permission card; this is the transcript's record of it.
 */
import * as React from 'react';
import { CheckCircle2, ChevronDown, ListChecks, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { JsonlNode } from '@/types/jsonl';
import { MessageResponse } from './primitives';

function outcome(resultNode: JsonlNode | undefined): 'waiting' | 'approved' | 'declined' {
  if (!resultNode) return 'waiting';
  const content = (resultNode as { raw?: { message?: { content?: unknown } } }).raw?.message?.content;
  const block = Array.isArray(content)
    ? (content.find((b) => (b as { type?: string }).type === 'tool_result') as { is_error?: boolean } | undefined)
    : undefined;
  return block?.is_error ? 'declined' : 'approved';
}

export function ModernPlan({ markdown, resultNode }: { markdown: string; resultNode?: JsonlNode }) {
  const [open, setOpen] = React.useState(false);
  const lines = markdown.split('\n');
  const titleLine = lines.find((l) => /^#\s/.test(l));
  const title = titleLine ? titleLine.replace(/^#\s+/, '') : 'Plan';
  const body = lines.filter((l) => l !== titleLine).join('\n').trim();
  const lede = body.split(/\n\s*\n/).find((p) => p.trim() && !p.trim().startsWith('#')) ?? '';
  const state = outcome(resultNode);

  return (
    <div className="w-full rounded-xl border bg-card shadow-sm">
      <div className="flex items-start justify-between gap-4 p-4 pb-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <ListChecks className="size-3.5" />
            Plan
          </div>
          <div className="text-balance text-base font-semibold leading-snug">{title}</div>
          {!open && lede && (
            <p className="line-clamp-2 text-sm text-muted-foreground">{lede.replace(/[*`_#>]/g, '')}</p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label={open ? 'Collapse plan' : 'Expand plan'}
          aria-expanded={open}
          onClick={() => { setOpen((o) => !o); }}
        >
          <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
        </Button>
      </div>
      {open && body && (
        <div className="px-4 pb-3">
          <MessageResponse>{body}</MessageResponse>
        </div>
      )}
      <div className="flex items-center gap-1.5 border-t px-4 py-2.5 text-xs text-muted-foreground">
        {state === 'approved' && <><CheckCircle2 className="size-3.5 text-green-500" />Approved</>}
        {state === 'declined' && <><XCircle className="size-3.5 text-orange-500" />Not approved — kept planning</>}
        {state === 'waiting' && 'Waiting for your go-ahead'}
      </div>
    </div>
  );
}
