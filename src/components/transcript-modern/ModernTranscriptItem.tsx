import * as React from 'react';
import type { JsonlNode } from '@/types/jsonl';
import type { ModernItem } from '@/lib/modernGrouping';
import type { ModernLine } from '@/lib/modernLines';
import { CopyButton } from '@/components/ui/copy-button';
import { Stamp, rawOfNodes } from './HoverActionsRow';
import { CheckCircle2, RotateCcw } from 'lucide-react';
import { extractResendPayload } from '@/lib/extractResendPayload';
import { NoticeLine } from './NoticeLine';
import { CompactionLine } from './CompactionLine';
import { RecapLine } from './RecapLine';
import { InstructionsLine } from './InstructionsLine';
import { RecordLine } from './RecordLine';
import { DownloadableImage } from '@/components/DownloadableImage';
import { RawJsonPopover } from '@/components/transcript-modern/RawJsonPopover';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';
import { ChainOfThought } from './ChainOfThought';
import { QuestionLine } from './QuestionLine';
import { ModernPlan } from './ModernPlan';
import { Message, MessageActions, MessageResponse, UserBubble } from './primitives';
import { turnFooterText, type TurnFooter } from '@/lib/modernTurnFooter';
import { useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';
import { cardRadiusStyle } from '@/lib/accentStyle';
import { cn } from '@/lib/utils';
import { IconRenderer } from '@/components/settings-panels/appearance/iconMap';
import { resolveKind } from '@/lib/messageRenderingConfig';
import { useRenderProfile } from '@/hooks/useRenderProfile';

export interface ModernRowContext {
  tabId: string;
  configDir?: string | null;
  accountType?: string;
  onResend?: (text: string, images?: string[]) => void;
}

function resultContentOf(resultNode: JsonlNode | undefined): string | undefined {
  const content = (resultNode as { raw?: { message?: { content?: unknown } } } | undefined)?.raw?.message?.content;
  if (!Array.isArray(content)) return undefined;
  const block = content.find((b) => (b as { type?: string }).type === 'tool_result') as { content?: unknown } | undefined;
  const answer = block?.content;
  return typeof answer === 'string' ? answer : answer != null ? JSON.stringify(answer) : undefined;
}

export const ModernTranscriptItem = React.memo(function ModernTranscriptItem({
  item,
  live,
  ctx,
  footer,
}: {
  item: ModernItem;
  live: boolean;
  ctx: ModernRowContext;
  footer?: TurnFooter;
}) {
  // Counted by __omnifexProfile and the row re-render tests.
  useRenderProfile('ModernTranscriptItem');
  switch (item.kind) {
    case 'prompt':
      return (
        <Message from="user">
          <PromptChip />
          <UserBubble>
            {item.images && (
              <div className="mb-2 flex flex-wrap gap-2">
                {item.images.map((img, i) => (
                  <DownloadableImage
                    key={i}
                    src={img.src}
                    alt="Pasted image"
                    mediaType={img.mediaType}
                    className="max-h-48 max-w-full rounded-xl object-contain"
                  />
                ))}
              </div>
            )}
            {item.text.trim() && (
              <p className="whitespace-pre-wrap break-words">{item.text}</p>
            )}
          </UserBubble>
          <MessageActions from="user">
            <Stamp node={item.node} />
            {ctx.onResend && <ResendButton node={item.node} onResend={ctx.onResend} />}
            <CopyButton getText={() => item.text} className="h-6 w-6" />
            <RawJsonPopover text={rawOfNodes([item.node])} />
          </MessageActions>
        </Message>
      );
    case 'text':
      return (
        <Message from="assistant">
          {footer && <FinalChip />}
          {footer ? (
            <FinalAnswerCard>
              <MessageResponse>{item.text}</MessageResponse>
              <TurnFooterLine footer={footer} showCost={ctx.accountType !== 'max'} />
            </FinalAnswerCard>
          ) : (
            <MessageResponse>{item.text}</MessageResponse>
          )}
          <MessageActions from="assistant">
            <Stamp node={item.node} />
            <CopyButton getText={() => item.text} className="h-6 w-6" />
            <RawJsonPopover text={rawOfNodes([item.node])} />
          </MessageActions>
        </Message>
      );
    case 'work':
      return <ChainOfThought entries={item.entries} nodes={item.nodes} live={live} ctx={ctx} />;
    case 'question': {
      const answer = resultContentOf(item.resultNode);
      return (
        <RecordActions item={item} nodes={withResult(item.node, item.resultNode)} copy={() => questionCopyText(item.input, answer)}>
          <QuestionLine input={item.input} resultContent={answer} />
        </RecordActions>
      );
    }
    case 'plan':
      return (
        <RecordActions item={item} nodes={withResult(item.node, item.resultNode)} copy={() => item.markdown}>
          <ModernPlan markdown={item.markdown} resultNode={item.resultNode} />
        </RecordActions>
      );
    case 'notice':
      return (
        <RecordActions item={item} nodes={[item.node]} copy={() => item.text}>
          <NoticeLine tone={item.tone} text={item.text} />
        </RecordActions>
      );
    case 'compaction':
      return (
        <RecordActions
          item={item}
          nodes={withResult(item.node, item.summaryNode)}
          copy={() => [item.detail, item.summary].filter(Boolean).join('\n\n')}
        >
          <CompactionLine detail={item.detail} summary={item.summary} />
        </RecordActions>
      );
    case 'instructions':
      return (
        <RecordActions item={item} nodes={[item.node]} copy={() => item.files.map((f) => f.path).join('\n')}>
          <InstructionsLine files={item.files} />
        </RecordActions>
      );
    case 'recap':
      return (
        <Message from="assistant">
          <RecapLine text={item.text} />
          <MessageActions from="assistant">
            <Stamp node={item.node} />
            <CopyButton getText={() => item.text} className="h-6 w-6" />
            <RawJsonPopover text={rawOfNodes([item.node])} />
          </MessageActions>
        </Message>
      );
    case 'line':
      return (
        <RecordActions item={item} nodes={[item.node]} copy={() => lineCopyText(item.line)}>
          <RecordLine line={item.line} />
        </RecordActions>
      );
  }
});

export function anchorNodeOf(item: ModernItem): JsonlNode {
  switch (item.kind) {
    case 'work': return item.nodes[item.nodes.length - 1];
    default: return item.node;
  }
}

export function firstNodeOf(item: ModernItem): JsonlNode {
  switch (item.kind) {
    case 'work': return item.nodes[0];
    default: return item.node;
  }
}

// Reads its own store slot so a flush re-renders this line only.
export function ModernLiveAnswer({ tabId }: { tabId: string }) {
  const text = useClaudeSessionStore((st) => st.tabs[tabId]?.inflightAssistant?.text ?? null);
  if (!text) return null;
  return (
    <Message from="assistant">
      <MessageResponse>{text}</MessageResponse>
    </Message>
  );
}

/** Tint, border and shadow live in styles.css: the `* { border-color }` reset beats the utilities. */
function FinalAnswerCard({ children }: { children: React.ReactNode }) {
  const { config } = useMessageRenderingConfig();
  if (config.modern.answerStyle === 'line') {
    return <div className={cn('modern-final-line flex w-full flex-col items-start gap-2 py-1 pl-4', !config.modern.answerCardColorEnabled && 'modern-card-plain')}>{children}</div>;
  }
  return (
    <div
      className={cn('modern-final-card flex w-full flex-col items-start gap-2 p-3', config.modern.answerCardColorEnabled ? config.modern.answerCardShadow && 'modern-card-shadow' : 'modern-card-plain')}
      style={cardRadiusStyle(config)}
    >
      {children}
    </div>
  );
}

function PromptChip() {
  const { config } = useMessageRenderingConfig();
  if (config.modern.promptStyle !== 'line') return null;
  return (
    <span
      data-prompt-chip
      className={cn('modern-prompt-chip inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-none text-white', !config.modern.promptColorEnabled && 'modern-card-plain')}
    >
      <IconRenderer name={resolveKind(config, 'user.prompt').icon} className="size-3" />
      User prompt
    </span>
  );
}

function FinalChip() {
  return (
    <span data-final-chip className="inline-flex items-center gap-1 rounded-full bg-emerald-700 px-2 py-0.5 text-[11px] font-medium leading-none text-white">
      <CheckCircle2 className="size-3" />
      Answer
    </span>
  );
}

function TurnFooterLine({ footer, showCost }: { footer: TurnFooter; showCost: boolean }) {
  return (
    <div data-turn-footer className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <CheckCircle2 className="size-3.5 text-emerald-700" />
      <span>{turnFooterText(footer, showCost)}</span>
    </div>
  );
}

function RecordActions({ item, nodes, copy, children }: {
  item: ModernItem & { node: JsonlNode };
  nodes: JsonlNode[];
  copy: () => string;
  children: React.ReactNode;
}) {
  return (
    <Message from="assistant" data-record-row={item.kind}>
      <div className="w-full min-w-0">{children}</div>
      <MessageActions from="assistant">
        <Stamp node={item.node} />
        <CopyButton getText={copy} className="h-6 w-6" />
        <RawJsonPopover text={rawOfNodes(nodes)} />
      </MessageActions>
    </Message>
  );
}

function withResult(node: JsonlNode, result: JsonlNode | undefined): JsonlNode[] {
  return result ? [node, result] : [node];
}

function lineCopyText(line: ModernLine): string {
  const head = line.detail ? `${line.title} · ${line.detail}` : line.title;
  return line.body ? `${head}\n${line.body}` : head;
}

function questionCopyText(input: Record<string, unknown>, answer: string | undefined): string {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const asked = questions
    .map((q) => (q as { question?: unknown }).question)
    .filter((q): q is string => typeof q === 'string' && q !== '');
  return [...asked, answer].filter(Boolean).join('\n\n');
}

function ResendButton({ node, onResend }: { node: JsonlNode; onResend: (text: string, images?: string[]) => void }) {
  return (
    <button
      type="button"
      aria-label="Resend message"
      title="Resend message"
      onClick={() => {
        const { text, images } = extractResendPayload((node as { raw?: { message?: unknown } }).raw?.message);
        if (text || images) onResend(text, images);
      }}
      className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-accent hover:text-foreground"
    >
      <RotateCcw className="size-3.5" />
    </button>
  );
}
