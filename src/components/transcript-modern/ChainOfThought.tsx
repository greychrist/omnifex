/**
 * A run of thinking and tool calls, drawn as shadcn's Trace chain of thought:
 * a header line with a status circle ("Worked in 5 steps" · 32s, or
 * "Working" with a spinner while live), opening onto one line per step, each
 * with an icon naming its action (a brain for a thought, a terminal for a
 * command, a file for a read) and a title whose verb follows its state. As in
 * Trace, status is the line's colour, shimmer and wording, never the icon.
 *
 * Collapsed once the run is finished and open while it is live, unless
 * Settings › Chats › Modern says otherwise — that tab also picks each step
 * kind's icon, can leave thoughts out, and recolours failures. A step opens
 * onto its result alone (a command's output, an edit's diff, the sources a
 * web step used); a read opens onto nothing, its title says it all. Copy and
 * the raw records sit beside every step on hover.
 */
import * as React from 'react';
import type { JsonlNode } from '@/types/jsonl';
import type { RowLookups } from '@/lib/rowLookups';
import type { WorkEntry } from '@/lib/modernGrouping';
import {
  describeToolStep, reasoningTitle, stepKind, thinkingTokensLabel, traceHeader, webSources,
  type StepKind, type StepState,
} from '@/lib/modernSteps';
import { StreamMessage } from '@/components/StreamMessage';
import { RawJsonPopover } from '@/components/StreamMessage/RawJsonPopover';
import { CopyButton } from '@/components/ui/copy-button';
import { DiffViewer } from '@/components/shared/DiffViewer';
import { getLanguage } from '@/components/claude/tools/shared';
import { ArrowUpRightIcon, GlobeIcon } from 'lucide-react';
import { IconRenderer } from '@/components/settings-panels/appearance/iconMap';
import { cn } from '@/lib/utils';
import { accentStyleFor, cardRadiusStyle, swatchFor } from '@/lib/accentStyle';
import { deriveSystemContextLabel } from '@/lib/blockKind';
import { useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';
import { MessageResponse, Shimmer } from './primitives';
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
  const { modern } = useMessageRenderingConfig().config;
  // Follows the run (open while live, closed once done, by default) until the
  // user chooses — by its header, or by clicking anything inside it — then
  // keeps their choice.
  const [chosen, setChosen] = React.useState<boolean | null>(null);
  const open = chosen ?? (modern.timelineOpen === 'always' ? true : modern.timelineOpen === 'never' ? false : live);
  // Settings › Chats › Modern › Failed step: the timeline's red, recoloured.
  const failedStyle = modern.failedColor
    ? ({ '--color-destructive': modern.failedColor } as React.CSSProperties)
    : undefined;

  const shown = modern.showThoughts ? entries : entries.filter((e) => e.type !== 'thinking');
  // The thought being had right now, typed in as it streams. A recorded
  // thought has already ended — its record lands when it does.
  const thought = live && modern.showThoughts ? <LiveThought key="live-thought" tabId={ctx.tabId} /> : null;

  if (shown.length === 0 && !thought) return null;

  // A run that only thought is shadcn's Reasoning on its own: no "Worked in"
  // header around it.
  if (shown.every((e) => e.type === 'thinking')) {
    return (
      <Trace style={failedStyle}>
        {shown.map((e) => e.type === 'thinking' && (
          <ReasoningLine key={e.key} text={e.text} ms={e.ms} tokens={e.tokens} running={false} />
        ))}
        {thought}
      </Trace>
    );
  }

  const failed = shown.filter((e) => e.type === 'tool' && e.status === 'error').length;
  const status: TraceStatus | undefined = live ? 'running' : failed > 0 ? 'error' : undefined;
  const header = traceHeader({
    steps: shown.length,
    failed,
    ms: spanMs(nodes),
  });

  return (
    <Trace style={failedStyle}>
      <TraceCollapsible open={open} onOpenChange={setChosen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={status}>
            <TraceIcon><TraceStatusIcon status={status} /></TraceIcon>
            <TraceTitle>{live ? <Shimmer>Working</Shimmer> : header.title}</TraceTitle>
            {!live && header.description && <TraceDescription>{header.description}</TraceDescription>}
          </TraceLine>
        </TraceCollapsibleTrigger>
        {/* A click inside an open run — opening a step, say — pins it open:
            otherwise the run closes over that step the moment it finishes. */}
        <TraceCollapsibleContent onClickCapture={() => { if (chosen === null) setChosen(true); }}>
          <Trace>
            {shown.map((entry) => <Step key={entry.key} entry={entry} live={live} ctx={ctx} />)}
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
      <KindIcon kind="thought" />
      <TraceTitle>{running ? <Shimmer>{title}</Shimmer> : title}</TraceTitle>
      {tokens !== null && <TraceDescription>({thinkingTokensLabel(tokens)})</TraceDescription>}
    </TraceLine>
  );
  if (!text.trim()) return line;
  return (
    <TraceCollapsible open={chosen ?? running} onOpenChange={setChosen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      {/* Brighter than the muted step chrome around it, so the reasoning
          itself stands out from the titles and commands. */}
      <TraceCollapsibleContent className="whitespace-pre-wrap text-foreground/85">{text}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function KindIcon({ kind }: { kind: StepKind | 'thought' }) {
  // Settings › Chats › Modern › Step icons.
  const icon = useMessageRenderingConfig().config.modern.stepIcons[kind];
  // A chip like the classic card header's icon, as bright as an opened
  // thought. The negative margins cancel the padding and border, so the
  // chip keeps the 16px box the thought's left rule is centred under.
  // A failed step's red border is `.modern-step-icon` in styles.css.
  return (
    <TraceIcon
      data-step-kind={kind}
      className="modern-step-icon -m-[3px] size-[22px] rounded-md border bg-muted/40 text-foreground/85 in-data-[status=error]:bg-destructive/10 in-data-[status=error]:text-destructive"
    >
      <IconRenderer name={icon} className="size-3" />
    </TraceIcon>
  );
}

type ToolEntry = Extract<WorkEntry, { type: 'tool' }>;

function Step({ entry, live, ctx }: { entry: WorkEntry; live: boolean; ctx: RowContext }) {
  if (entry.type === 'thinking') {
    return (
      <StepRow raw={rawOf([entry.node])} copy={() => entry.text}>
        <ReasoningLine text={entry.text} ms={entry.ms} tokens={entry.tokens} running={false} />
      </StepRow>
    );
  }

  // A tool with no result yet is running while the turn is; otherwise it
  // never got one (an interrupted turn) and waits, dimmed.
  const state: StepState = entry.status === 'error' ? 'error' : entry.status === 'pending' ? 'running' : 'done';
  const status: TraceStatus | undefined =
    entry.status === 'error' ? 'error' : entry.status === 'pending' ? (live ? 'running' : 'pending') : undefined;
  const text = describeToolStep(entry.name, entry.input, state);
  // The model's own description of a command: the title says what ran.
  const tooltip = entry.name === 'Bash' && typeof entry.input.description === 'string' ? entry.input.description : undefined;
  const body = stepBody(entry, ctx);

  const line = (
    <TraceLine status={status}>
      <KindIcon kind={stepKind(entry.name, entry.input)} />
      <TraceTitle>{status === 'running' ? <Shimmer>{text.title}</Shimmer> : text.title}</TraceTitle>
      {text.badges && (
        <TraceDescription className={cn(text.codeBadges && 'font-mono text-xs')}>
          {text.badges.join(' · ')}
        </TraceDescription>
      )}
    </TraceLine>
  );

  return (
    <StepRow
      raw={rawOf(entry.resultNode ? [entry.node, entry.resultNode] : [entry.node])}
      copy={() => entry.resultText ?? copyInputOf(entry)}
    >
      {body ? (
        <TraceCollapsible>
          <TraceCollapsibleTrigger title={tooltip}>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent>{body}</TraceCollapsibleContent>
        </TraceCollapsible>
      ) : (
        <div title={tooltip} className="min-w-0">{line}</div>
      )}
    </StepRow>
  );
}

/** A step, with copy and the raw records beside it on hover (always shown
 *  where there is no hover, on the iPad). */
function StepRow({ raw, copy, children }: { raw: () => string; copy: () => string; children: React.ReactNode }) {
  return (
    <div data-step className="group/step flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      <div className="flex shrink-0 items-center gap-0.5 text-muted-foreground opacity-0 transition-opacity group-hover/step:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        <CopyButton getText={copy} className="h-6 w-6" />
        <RawJsonPopover text={raw} />
      </div>
    </div>
  );
}

/** The records as the CLI wrote them — a thunk, serialized only when opened. */
function rawOf(nodes: JsonlNode[]): () => string {
  return () => {
    const raws = nodes.map((n) => (n as { raw?: unknown }).raw ?? n);
    return JSON.stringify(raws.length === 1 ? raws[0] : raws, null, 2);
  };
}

function copyInputOf(entry: ToolEntry): string {
  const { command, file_path: filePath } = entry.input;
  if (typeof command === 'string') return command;
  if (typeof filePath === 'string') return filePath;
  return JSON.stringify(entry.input, null, 2);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** What a step opens onto, or null when there is nothing to open. */
function stepBody(entry: ToolEntry, ctx: RowContext): React.ReactNode {
  const result = entry.resultText?.replace(/<\/?tool_use_error>/g, '').trim();
  if (entry.status === 'error') {
    return result ? <StepOutput text={result} tone="error" /> : null;
  }
  const { input } = entry;
  switch (entry.name) {
    case 'Read':
      return null;
    case 'Edit':
      return <DiffViewer oldText={str(input.old_string)} newText={str(input.new_string)} language={getLanguage(str(input.file_path))} />;
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as { old_string?: unknown; new_string?: unknown }[]) : [];
      const language = getLanguage(str(input.file_path));
      return (
        <div className="flex flex-col gap-2">
          {edits.map((e, i) => <DiffViewer key={i} oldText={str(e.old_string)} newText={str(e.new_string)} language={language} />)}
        </div>
      );
    }
    case 'Write':
      return str(input.content) ? <StepOutput text={str(input.content)} /> : null;
    case 'WebFetch':
    case 'WebSearch': {
      const sources = webSources(entry.name, input, entry.resultText);
      if (sources.length > 0) return <SourceList sources={sources} />;
      break;
    }
    case 'Skill':
      if (entry.skillBody) return <SkillBody text={entry.skillBody} />;
      break;
    case 'Agent':
    case 'Task':
      return result ? <div className="text-foreground"><MessageResponse>{result}</MessageResponse></div> : null;
  }
  if (result) return <StepOutput text={result} />;
  // A result with no text (an image, say): the classic widget still draws it.
  if (entry.resultNode) {
    return (
      <StreamMessage
        message={entry.node}
        lookups={ctx.lookupsFor(entry.node)}
        tabId={ctx.tabId}
        accountType={ctx.accountType}
        onResend={ctx.onResend}
        inExpandedGroup
      />
    );
  }
  return null;
}

/** A skill's SKILL.md, in the colours and corner radius of the classic
 *  skill card it replaces (Appearance › Skill injection, All cards). */
function SkillBody({ text }: { text: string }) {
  const { config } = useMessageRenderingConfig();
  const swatch = swatchFor(config, 'user.skillInjection');
  return (
    <div
      data-skill-body
      className="border px-3 py-2"
      style={{ ...accentStyleFor(config, 'user.skillInjection'), ...cardRadiusStyle(config) }}
    >
      <div className="mb-1 text-xs font-medium" style={swatch ? { color: swatch } : undefined}>
        {deriveSystemContextLabel(text)}
      </div>
      <div className="max-h-72 overflow-auto text-foreground">
        <MessageResponse>{text}</MessageResponse>
      </div>
    </div>
  );
}

/** Trace's code block: a step's output in the code face, red when it failed. */
function StepOutput({ text, tone = 'default' }: { text: string; tone?: 'default' | 'error' }) {
  return (
    <pre
      data-step-output
      data-tone={tone}
      className={cn(
        'max-h-72 overflow-auto rounded-xl px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words',
        tone === 'error' ? 'border border-destructive/30 bg-destructive/10 text-destructive' : 'bg-muted text-foreground',
      )}
    >
      {text}
    </pre>
  );
}

function SourceList({ sources }: { sources: { title: string; url: string }[] }) {
  return (
    <Trace className="gap-1">
      {sources.map((s) => (
        <a
          key={s.url}
          href={s.url}
          onClick={(e) => {
            e.preventDefault();
            void window.electronAPI?.openExternal?.(s.url);
          }}
          className="flex w-fit max-w-full min-w-0 items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
        >
          <TraceIcon><GlobeIcon /></TraceIcon>
          <span className="truncate">{s.title}</span>
          <ArrowUpRightIcon className="size-3.5 shrink-0" />
        </a>
      ))}
    </Trace>
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
