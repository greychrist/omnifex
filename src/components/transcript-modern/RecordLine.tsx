/**
 * A non-conversation record in the Modern format (modernLines.ts): one Trace
 * line — the kind's icon, a title, a short detail — with any longer text set
 * off by the left rule a recap uses, open or folded. What Modern draws where
 * it used to borrow the Compact card.
 */
import * as React from 'react';
import type { ModernLine } from '@/lib/modernLines';
import { IconRenderer } from '@/components/settings-panels/appearance/iconMap';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from './trace';

function Body({ line }: { line: ModernLine }) {
  return line.mono
    ? <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{line.body}</pre>
    : <p className="whitespace-pre-wrap break-words">{line.body}</p>;
}

export function RecordLine({ line }: { line: ModernLine }) {
  const [open, setOpen] = React.useState(false);
  const head = (
    <TraceLine status={line.tone}>
      <TraceIcon><IconRenderer name={line.icon} /></TraceIcon>
      <TraceTitle>{line.title}</TraceTitle>
      {line.detail && <TraceDescription className="min-w-0 shrink truncate">{line.detail}</TraceDescription>}
    </TraceLine>
  );
  if (!line.body) return <Trace data-record-line>{head}</Trace>;
  if (line.fold) {
    return (
      <Trace data-record-line>
        <TraceCollapsible open={open} onOpenChange={setOpen}>
          <TraceCollapsibleTrigger>{head}</TraceCollapsibleTrigger>
          {open && <TraceCollapsibleContent><Body line={line} /></TraceCollapsibleContent>}
        </TraceCollapsible>
      </Trace>
    );
  }
  // Open: the rule and inset TraceCollapsibleContent gives an opened line.
  return (
    <Trace data-record-line>
      {head}
      <div className="ml-[7px] min-w-0 border-l border-border pr-1 pl-4 text-sm leading-relaxed break-words text-muted-foreground">
        <Body line={line} />
      </div>
    </Trace>
  );
}
