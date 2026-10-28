/**
 * A run of thinking and tool calls, drawn as shadcn's Trace chain of thought:
 * a header line with a status circle ("Worked in 5 steps" · 32s, or
 * "Working" with a spinner while live), opening onto one line per step, each
 * with its own status circle and a title whose verb follows its state.
 *
 * Collapsed once the run is finished and open while it is live. A tool step
 * opens onto the same tool widget the other formats draw, so folding loses
 * nothing.
 */
import * as React from 'react';
import type { JsonlNode } from '@/types/jsonl';
import type { RowLookups } from '@/lib/rowLookups';
import type { WorkEntry } from '@/lib/modernGrouping';
import { describeToolStep, reasoningTitle, thinkingTokensLabel, traceHeader, type StepState } from '@/lib/modernSteps';
import { StreamMessage } from '@/components/StreamMessage';
import { cn } from '@/lib/utils';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';
import { Shimmer } from './primitives';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceStatusIcon,
  TraceTitle,
  type TraceStatus,
} from './trace';

interface RowContext {
  lookupsFor: (node: JsonlNode) => RowLookups;
  tabId: string;
  accountType?: string;
  onResend?: (text: string, images?: string[]) => void;
}

/** First record to last, from the CLI's own timestamps; null when unknown. */
function spanMs(nodes: JsonlNode[]): number | null {
  const times = nodes
    .map((n) => Date.parse((n as { receivedAt?: string | null }).receivedAt ?? ''))
    .filter((t) => Number.isFinite(t));
  return times.length < 2 ? null : Math.max(...times) - Math.min(...times);
}

export const ChainOfThought = React.memo(function ChainOfThought({
  entries,
  nodes,
  live,
  ctx,
}: {
  entries: WorkEntry[];
  nodes: JsonlNode[];
  live: boolean;
  ctx: RowContext;
}) {
  // Follows the run (open while live, closed once done) until the user
  // chooses, then keeps their choice.
  const [chosen, setChosen] = React.useState<boolean | null>(null);
  const open = chosen ?? live;

  // A run that only thought is shadcn's Reasoning on its own: no "Worked in"
  // header around it.
  // The thought being had right now, typed in as it streams. A recorded
  // thought has already ended — its record lands when it does.
  const thought = live ? <LiveThought key="live-thought" tabId={ctx.tabId} /> : null;

  if (entries.every((e) => e.type === 'thinking')) {
    return (
      <Trace>
        {entries.map((e) => e.type === 'thinking' && (
          <ReasoningLine key={e.key} text={e.text} ms={e.ms} tokens={e.tokens} running={false} />
        ))}
        {thought}
      </Trace>
    );
  }

  const failed = entries.filter((e) => e.type === 'tool' && e.status === 'error').length;
  const status: TraceStatus | undefined = live ? 'running' : failed > 0 ? 'error' : undefined;
  const header = traceHeader({
    steps: entries.length,
    failed,
    ms: spanMs(nodes),
  });

  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={setChosen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={status}>
            <TraceIcon><TraceStatusIcon status={status} /></TraceIcon>
            <TraceTitle>{live ? <Shimmer>Working</Shimmer> : header.title}</TraceTitle>
            {!live && header.description && <TraceDescription>{header.description}</TraceDescription>}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {entries.map((entry) => <Step key={entry.key} entry={entry} live={live} ctx={ctx} />)}
            {thought}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
});

/**
 * shadcn's Reasoning (ui.shadcn.com/docs/ai-elements/base/reasoning): a
 * Trace line reading "Thinking" with a spinner while the model thinks, then
 * "Thought for 5s" with a check, closed. Open while it thinks; once the
 * person opens or closes it, their choice holds.
 */
export function ReasoningLine({
  text,
  ms,
  tokens = null,
  running,
}: {
  text: string;
  ms: number | null;
  /** The CLI's token estimate for the thought (live only), shown beside it. */
  tokens?: number | null;
  running: boolean;
}) {
  const [chosen, setChosen] = React.useState<boolean | null>(null);
  const status: TraceStatus | undefined = running ? 'running' : undefined;
  const title = reasoningTitle({ running, ms });
  const line = (
    <TraceLine status={status}>
      <TraceIcon><TraceStatusIcon status={status} /></TraceIcon>
      <TraceTitle>{running ? <Shimmer>{title}</Shimmer> : title}</TraceTitle>
      {tokens !== null && <TraceDescription>({thinkingTokensLabel(tokens)})</TraceDescription>}
    </TraceLine>
  );
  if (!text.trim()) return line;
  return (
    <TraceCollapsible open={chosen ?? running} onOpenChange={setChosen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="whitespace-pre-wrap">{text}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function Step({ entry, live, ctx }: { entry: WorkEntry; live: boolean; ctx: RowContext }) {
  if (entry.type === 'thinking') {
    return <ReasoningLine text={entry.text} ms={entry.ms} tokens={entry.tokens} running={false} />;
  }

  // A tool with no result yet is running while the turn is; otherwise it
  // never got one (an interrupted turn) and waits, dimmed.
  const state: StepState = entry.status === 'error' ? 'error' : entry.status === 'pending' ? 'running' : 'done';
  const status: TraceStatus | undefined =
    entry.status === 'error' ? 'error' : entry.status === 'pending' ? (live ? 'running' : 'pending') : undefined;
  const text = describeToolStep(entry.name, entry.input, state);

  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine status={status}>
          <TraceIcon><TraceStatusIcon status={status} /></TraceIcon>
          <TraceTitle>{status === 'running' ? <Shimmer>{text.title}</Shimmer> : text.title}</TraceTitle>
          {text.badges && (
            <TraceDescription className={cn(text.codeBadges && 'font-mono text-xs')}>
              {text.badges.join(' · ')}
            </TraceDescription>
          )}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <div className="mt-1 rounded-md border border-border/60 p-1">
          <StreamMessage
            message={entry.node}
            lookups={ctx.lookupsFor(entry.node)}
            tabId={ctx.tabId}
            accountType={ctx.accountType}
            onResend={ctx.onResend}
            inExpandedGroup
          />
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** The streaming thought for a tab, or nothing. Reads its own store slot so a
 *  thinking flush re-renders this line, not the transcript. */
function LiveThought({ tabId }: { tabId: string }) {
  const text = useClaudeSessionStore((st) => st.tabs[tabId]?.inflightThinking ?? null);
  return text ? <ReasoningLine text={text} ms={null} running /> : null;
}

/**
 * A turn that is running with no run on screen yet: the thought being typed
 * (Reasoning), or "Working" until there is something to show. Replaces the
 * classic typing dots in the Modern format.
 */
export function LiveActivity({ tabId, phase = null }: {
  tabId: string;
  /** A phase the CLI announced ("Compacting context"), said instead of "Working". */
  phase?: string | null;
}) {
  const thought = useClaudeSessionStore((st) => st.tabs[tabId]?.inflightThinking ?? null);
  return (
    <Trace>
      {thought ? (
        <ReasoningLine text={thought} ms={null} running />
      ) : (
        <TraceLine status="running">
          <TraceIcon><TraceStatusIcon status="running" /></TraceIcon>
          <TraceTitle><Shimmer>{phase ?? 'Working'}</Shimmer></TraceTitle>
        </TraceLine>
      )}
    </Trace>
  );
}
