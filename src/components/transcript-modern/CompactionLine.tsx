import * as React from 'react';
import { ScissorsIcon } from 'lucide-react';
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
import { MessageResponse } from './primitives';

export function CompactionLine({ detail, summary }: { detail: string; summary?: string }) {
  const [open, setOpen] = React.useState(false);
  const line = (
    <TraceLine>
      <TraceIcon><ScissorsIcon /></TraceIcon>
      <TraceTitle>Compacted conversation</TraceTitle>
      {detail && <TraceDescription>{detail}</TraceDescription>}
    </TraceLine>
  );
  if (!summary) return <Trace>{line}</Trace>;
  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
        {open && (
          <TraceCollapsibleContent>
            <MessageResponse>{summary}</MessageResponse>
          </TraceCollapsibleContent>
        )}
      </TraceCollapsible>
    </Trace>
  );
}
