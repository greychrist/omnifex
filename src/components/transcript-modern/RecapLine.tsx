/**
 * A recap in the Modern format — the CLI's away summary or `/recap`'s
 * output: a Trace line ("Recap", with the time it was written) over the prose,
 * set off by the same left rule a compaction's recap opens onto. Left open:
 * unlike a compaction's summary, the recap is the point of the row.
 */
import { HistoryIcon } from 'lucide-react';
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from './trace';
import { MessageResponse } from './primitives';

export function RecapLine({ text, time }: { text: string; time?: string | null }) {
  return (
    <Trace data-recap>
      <TraceLine>
        <TraceIcon><HistoryIcon /></TraceIcon>
        <TraceTitle>Recap</TraceTitle>
        {time && <TraceDescription>{time}</TraceDescription>}
      </TraceLine>
      <div data-recap-body className="ml-[7px] min-w-0 border-l border-border pl-4 break-words">
        <MessageResponse>{text}</MessageResponse>
      </div>
    </Trace>
  );
}
