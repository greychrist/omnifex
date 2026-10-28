/**
 * A compaction in the Modern format: one Trace line — scissors, "Compacted
 * conversation", the figures beside it — that opens onto the recap the CLI
 * wrote, instead of the classic boundary marker and summary card.
 */
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
        {/* The recap is long; it is only built once opened. */}
        {open && (
          <TraceCollapsibleContent>
            <MessageResponse>{summary}</MessageResponse>
          </TraceCollapsibleContent>
        )}
      </TraceCollapsible>
    </Trace>
  );
}
