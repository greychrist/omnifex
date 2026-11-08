/**
 * A non-conversation record in the Modern format (modernLines.ts): one Trace
 * line — the kind's icon, a title, a short detail — with any longer text set
 * off by the left rule a recap uses, open or folded. What Modern draws where
 * it used to borrow the Compact card. A permission-mode, effort or model
 * change wears its new value's colour on the icon and title, as an answered
 * question (QuestionLine) wears its purple.
 */
import * as React from 'react';
import type { LineAccent, ModernLine } from '@/lib/modernLines';
import { modelOwnColor, screenChartMode } from '@/lib/costChartPalette';
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

/** The accent as a CSS colour. A model's is its Cost Report colour for the
 *  theme on screen; one with no colour of its own leaves the line plain. */
function accentColor(accent: LineAccent | undefined): string | undefined {
  if (!accent) return undefined;
  if (accent.kind === 'css') return accent.color;
  return modelOwnColor(accent.model, screenChartMode()) ?? undefined;
}

export function RecordLine({ line }: { line: ModernLine }) {
  const [open, setOpen] = React.useState(false);
  const color = accentColor(line.accent);
  const accent = color ? { color } : undefined;
  const head = (
    <TraceLine status={line.tone}>
      <TraceIcon style={accent}><IconRenderer name={line.icon} /></TraceIcon>
      <TraceTitle style={accent}>{line.title}</TraceTitle>
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
