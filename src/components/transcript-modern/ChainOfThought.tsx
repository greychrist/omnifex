import * as React from 'react';
import type { JsonlNode } from '@/types/jsonl';
import type { WorkEntry } from '@/lib/modernGrouping';
import {
  bareToolName, describeToolStep, reasoningTitle, stepKind, thinkingTokensLabel, traceHeader, webSources,
  type StepKind, type StepState,
} from '@/lib/modernSteps';
import { designRunSummary, foldDesignRuns, type DesignRun } from '@/lib/designRuns';
import { openSignInLink } from '@/lib/signInBrowser';
import { HoverActionsRow, rawOfNodes as rawOf } from './HoverActionsRow';
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
  tabId: string;
  configDir?: string | null;
}

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
  const [chosen, setChosen] = React.useState<boolean | null>(null);
  const open = chosen ?? (modern.timelineOpen === 'always' ? true : modern.timelineOpen === 'never' ? false : live);
  const failedStyle = modern.failedColor
    ? ({ '--color-destructive': modern.failedColor } as React.CSSProperties)
    : undefined;

  const shown = modern.showThoughts ? entries : entries.filter((e) => e.type !== 'thinking');
  const thought = live && modern.showThoughts ? <LiveThought key="live-thought" tabId={ctx.tabId} /> : null;

  if (shown.length === 0 && !thought) return null;

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
        {/* Any inner click pins the run open, or it closes over a step the moment that step finishes. */}
        <TraceCollapsibleContent onClickCapture={() => { if (chosen === null) setChosen(true); }}>
          <Trace>
            {foldDesignRuns(shown).map((entry) =>
              entry.type === 'design'
                ? <DesignStep key={entry.key} run={entry} live={live} configDir={ctx.configDir} />
                : <Step key={entry.key} entry={entry} live={live} />)}
            {thought}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
});

export function ReasoningLine({
  text,
  ms,
  tokens = null,
  running,
}: {
  text: string;
  ms: number | null;
  tokens?: number | null;
  running: boolean;
}) {
  const [chosen, setChosen] = React.useState<boolean | null>(null);
  const status: TraceStatus | undefined = running ? 'running' : undefined;
  const title = reasoningTitle({ running, ms });
  const color = useStepColor('thought');
  const line = (
    <TraceLine status={status}>
      <KindIcon kind="thought" color={color} />
      <TraceTitle style={titleStyle(color)}>{running ? <Shimmer>{title}</Shimmer> : title}</TraceTitle>
      {tokens !== null && <TraceDescription>({thinkingTokensLabel(tokens)})</TraceDescription>}
    </TraceLine>
  );
  // The CLI ends every thought with "\n\n".
  const body = text.trim();
  if (!body) return line;
  return (
    <TraceCollapsible open={chosen ?? running} onOpenChange={setChosen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent ruleColor={color} className="whitespace-pre-wrap text-foreground/85">{body}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function useStepColor(kind: StepKind | 'thought'): string | undefined {
  return useMessageRenderingConfig().config.modern.stepColors[kind] ?? undefined;
}

function titleStyle(color: string | undefined): React.CSSProperties | undefined {
  return color ? ({ color, '--modern-shimmer-color': color } as React.CSSProperties) : undefined;
}

function halfStrength(hex: string): string {
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}80` : hex;
}

function KindIcon({ kind, color }: { kind: StepKind | 'thought'; color?: string }) {
  const icon = useMessageRenderingConfig().config.modern.stepIcons[kind];
  // A failed step's red border is `.modern-step-icon` in styles.css.
  return (
    <TraceIcon
      data-step-kind={kind}
      // Inline: the `* { border-color }` reset beats border-color utilities.
      style={color ? { color, borderColor: halfStrength(color) } : undefined}
      className="modern-step-icon -m-[3px] size-[22px] rounded-md border bg-muted/40 text-foreground/85 in-data-[status=error]:bg-destructive/10 in-data-[status=error]:text-destructive"
    >
      <IconRenderer name={icon} className="size-3" />
    </TraceIcon>
  );
}

type ToolEntry = Extract<WorkEntry, { type: 'tool' }>;

function Step({ entry, live }: { entry: WorkEntry; live: boolean }) {
  if (entry.type === 'thinking') {
    return (
      <HoverActionsRow data-step raw={rawOf([entry.node])} copy={() => entry.text}>
        <ReasoningLine text={entry.text} ms={entry.ms} tokens={entry.tokens} running={false} />
      </HoverActionsRow>
    );
  }
  return <ToolStep entry={entry} live={live} />;
}

function ToolStep({ entry, live }: { entry: ToolEntry; live: boolean }) {
  const state: StepState = entry.status === 'error' ? 'error' : entry.status === 'pending' ? 'running' : 'done';
  const status: TraceStatus | undefined =
    entry.status === 'error' ? 'error' : entry.status === 'pending' ? (live ? 'running' : 'pending') : undefined;
  const text = describeToolStep(entry.name, entry.input, state);
  const tooltip = entry.name === 'Bash' && typeof entry.input.description === 'string' ? entry.input.description : undefined;
  const body = stepBody(entry);
  const kind = stepKind(entry.name, entry.input);
  const kindColor = useStepColor(kind);
  const color = status === 'error' ? undefined : kindColor;

  const line = (
    <TraceLine status={status}>
      <KindIcon kind={kind} color={color} />
      <TraceTitle style={titleStyle(color)}>{status === 'running' ? <Shimmer>{text.title}</Shimmer> : text.title}</TraceTitle>
      {text.badges && (
        <TraceDescription className={cn(text.codeBadges && 'font-mono text-xs')}>
          {text.badges.join(' · ')}
        </TraceDescription>
      )}
    </TraceLine>
  );

  return (
    <HoverActionsRow data-step
      raw={rawOf(entry.resultNode ? [entry.node, entry.resultNode] : [entry.node])}
      copy={() => entry.resultText ?? copyInputOf(entry)}
    >
      {body ? (
        <TraceCollapsible>
          <TraceCollapsibleTrigger title={tooltip}>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent ruleColor={color}>{body}</TraceCollapsibleContent>
        </TraceCollapsible>
      ) : (
        <div title={tooltip} className="min-w-0">{line}</div>
      )}
    </HoverActionsRow>
  );
}

function DesignStep({ run, live, configDir }: { run: DesignRun; live: boolean; configDir?: string | null }) {
  const summary = designRunSummary(run.entries);
  const kindColor = useStepColor('design');
  const running = summary.state === 'running' && live;
  const status: TraceStatus | undefined =
    summary.state === 'error' ? 'error' : summary.state === 'running' ? (live ? 'running' : 'pending') : undefined;
  const color = status === 'error' ? undefined : kindColor;
  const what = summary.title ?? 'a design';
  const title = summary.state === 'error'
    ? `Failed to design ${what}`
    : running ? `Designing ${what}` : summary.url ? `Designed ${what}` : `Worked on ${what}`;
  const steps = run.entries.length;
  return (
    <HoverActionsRow data-step raw={rawOf(run.entries.map((e) => e.node))} copy={() => summary.url ?? title}>
      <TraceCollapsible>
        {/* Three parts because a link cannot sit inside the fold's button. */}
        <div data-design-line className="flex w-fit max-w-full min-w-0 items-center gap-2">
          <TraceCollapsibleTrigger chevron={false} className="min-w-0">
            <TraceLine status={status}>
              <KindIcon kind="design" color={color} />
              <TraceTitle style={titleStyle(color)}>{running ? <Shimmer>{title}</Shimmer> : title}</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          {summary.url && <DesignLink url={summary.url} configDir={configDir} />}
          <TraceCollapsibleTrigger tabIndex={-1} aria-hidden="true" className="shrink-0">
            <TraceLine status={status}>
              <TraceDescription>{steps === 1 ? '1 step' : `${String(steps)} steps`}</TraceDescription>
            </TraceLine>
          </TraceCollapsibleTrigger>
        </div>
        <TraceCollapsibleContent ruleColor={color}>
          <Trace>
            {run.entries.map((entry) => <Step key={entry.key} entry={entry} live={live} />)}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </HoverActionsRow>
  );
}

// Opens in the account's chosen browser: the page is private to that claude.ai identity.
function DesignLink({ url, configDir }: { url: string; configDir?: string | null }) {
  return (
    <a
      href={url}
      onClick={(e) => {
        e.preventDefault();
        void openSignInLink(url, configDir);
      }}
      className="flex h-6 shrink-0 items-center gap-1 rounded-md border bg-muted/40 px-2 text-xs font-medium text-foreground/85 transition-colors hover:bg-accent hover:text-foreground"
    >
      Open in Claude
      <ArrowUpRightIcon className="size-3.5 shrink-0" />
    </a>
  );
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

function stepBody(entry: ToolEntry): React.ReactNode {
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
  return blocksBody(resultBlocks(entry)) ?? inputBody(input);
}

interface ResultBlock { type?: unknown; tool_name?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } }

function resultBlocks(entry: ToolEntry): ResultBlock[] {
  const content = (entry.resultNode as { raw?: { message?: { content?: unknown } } } | undefined)?.raw?.message?.content;
  if (!Array.isArray(content)) return [];
  const own = (content as { type?: unknown; tool_use_id?: unknown; content?: unknown }[])
    .find((b) => b.type === 'tool_result' && b.tool_use_id === entry.id);
  return Array.isArray(own?.content) ? (own.content as ResultBlock[]) : [];
}

function blocksBody(blocks: ResultBlock[]): React.ReactNode {
  const tools = blocks.flatMap((b) => (b.type === 'tool_reference' && typeof b.tool_name === 'string' ? [b.tool_name] : []));
  const images = blocks.flatMap((b) =>
    b.type === 'image' && b.source?.type === 'base64' && typeof b.source.data === 'string' && typeof b.source.media_type === 'string'
      ? [`data:${b.source.media_type};base64,${b.source.data}`]
      : []);
  if (tools.length === 0 && images.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {tools.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {tools.map((t) => {
            const server = /^mcp__(.+?)__/.exec(t)?.[1];
            return <li key={t} className="font-mono text-xs">{server ? `${server} · ${bareToolName(t)}` : t}</li>;
          })}
        </ul>
      )}
      {images.map((src, i) => (
        <img key={i} data-step-image src={src} alt="" className="max-h-72 w-fit max-w-full rounded-xl object-contain" />
      ))}
    </div>
  );
}

function inputBody(input: Record<string, unknown>): React.ReactNode {
  return Object.keys(input).length > 0 ? <StepOutput text={JSON.stringify(input, null, 2)} /> : null;
}

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

// Reads its own store slot so a thinking flush re-renders this line, not the transcript.
function LiveThought({ tabId }: { tabId: string }) {
  const text = useClaudeSessionStore((st) => st.tabs[tabId]?.inflightThinking ?? null);
  return text ? <ReasoningLine text={text} ms={null} running /> : null;
}

export function LiveActivity({ tabId, phase = null }: {
  tabId: string;
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
