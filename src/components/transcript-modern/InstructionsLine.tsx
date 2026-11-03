/**
 * The instruction files the CLI loaded (CLAUDE.md, MEMORY.md, …) in the Modern
 * format: one folded Trace line — "Loaded instructions", the count — that
 * opens onto each file's path and scope, instead of the classic side-line.
 */
import * as React from 'react';
import { FileTextIcon } from 'lucide-react';
import type { InstructionFile } from '@/lib/modernGrouping';
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

export function InstructionsLine({ files }: { files: InstructionFile[] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Trace data-instructions>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon><FileTextIcon /></TraceIcon>
            <TraceTitle>Loaded instructions</TraceTitle>
            <TraceDescription>{files.length === 1 ? '1 file' : `${files.length} files`}</TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        {open && (
          <TraceCollapsibleContent>
            <ul className="space-y-1">
              {files.map((f) => (
                <li key={f.path} className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 break-all font-mono text-xs">{f.path}</span>
                  {f.scope && <span className="shrink-0 text-xs text-muted-foreground/70">{f.scope}</span>}
                </li>
              ))}
            </ul>
          </TraceCollapsibleContent>
        )}
      </TraceCollapsible>
    </Trace>
  );
}
