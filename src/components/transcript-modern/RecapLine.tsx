import { HistoryIcon } from 'lucide-react';
import { Trace, TraceIcon, TraceLine, TraceTitle } from './trace';
import { MessageResponse } from './primitives';

export function RecapLine({ text }: { text: string }) {
  return (
    <Trace data-recap>
      <TraceLine>
        <TraceIcon><HistoryIcon /></TraceIcon>
        <TraceTitle>Recap</TraceTitle>
      </TraceLine>
      <div data-recap-body className="ml-[7px] min-w-0 border-l border-border pl-4 break-words">
        <MessageResponse>{text}</MessageResponse>
      </div>
    </Trace>
  );
}
