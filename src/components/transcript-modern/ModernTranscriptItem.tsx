/**
 * One Modern-format item. A non-conversation record is a Trace line
 * (RecordLine); only conversation content Modern does not model is drawn as
 * Compact draws it (StreamMessage). Records Compact hides are left out
 * altogether — the Compact, Verbose and All formats still show them.
 */
import * as React from 'react';
import type { JsonlNode } from '@/types/jsonl';
import type { RowLookups } from '@/lib/rowLookups';
import type { ModernItem } from '@/lib/modernGrouping';
import { StreamMessage } from '@/components/StreamMessage';
import { CopyButton } from '@/components/ui/copy-button';
import { CheckCircle2, RotateCcw } from 'lucide-react';
import { extractResendPayload } from '@/lib/extractResendPayload';
import { NoticeLine } from './NoticeLine';
import { CompactionLine } from './CompactionLine';
import { RecapLine } from './RecapLine';
import { InstructionsLine } from './InstructionsLine';
import { RecordLine } from './RecordLine';
import { DownloadableImage } from '@/components/DownloadableImage';
import { RawJsonPopover } from '@/components/StreamMessage/RawJsonPopover';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';
import { ChainOfThought } from './ChainOfThought';
import { QuestionLine } from './QuestionLine';
import { ModernPlan } from './ModernPlan';
import { Message, MessageActions, MessageResponse, UserBubble } from './primitives';
import { turnFooterText, type TurnFooter } from '@/lib/modernTurnFooter';
import { useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';
import { cardRadiusStyle } from '@/lib/accentStyle';
import { cn } from '@/lib/utils';

export interface ModernRowContext {
  lookupsFor: (node: JsonlNode) => RowLookups;
  tabId: string;
  accountType?: string;
  onResend?: (text: string, images?: string[]) => void;
}

/** The tool_result body, serialised as StreamMessage hands it to the classic card. */
function resultContentOf(resultNode: JsonlNode | undefined): string | undefined {
  const content = (resultNode as { raw?: { message?: { content?: unknown } } } | undefined)?.raw?.message?.content;
  if (!Array.isArray(content)) return undefined;
  const block = content.find((b) => (b as { type?: string }).type === 'tool_result') as { content?: unknown } | undefined;
  const answer = block?.content;
  return typeof answer === 'string' ? answer : answer != null ? JSON.stringify(answer) : undefined;
}

function dateOf(node: JsonlNode): Date | null {
  const at = (node as { receivedAt?: string | null }).receivedAt;
  if (!at) return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date and time for the hover row: "3-4-2026 3:04:05 PM" — the date
 *  M-D-YYYY, unpadded, the time in the locale's own form. */
function stampOf(node: JsonlNode): string | null {
  const d = dateOf(node);
  if (!d) return null;
  const date = `${String(d.getMonth() + 1)}-${String(d.getDate())}-${String(d.getFullYear())}`;
  return `${date} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
}

/** First in a hover row, before Copy and the rest. */
function Stamp({ node }: { node: JsonlNode }) {
  const stamp = stampOf(node);
  return stamp ? <span data-message-stamp className="mr-1">{stamp}</span> : null;
}

export const ModernTranscriptItem = React.memo(function ModernTranscriptItem({
  item,
  live,
  ctx,
  footer,
}: {
  item: ModernItem;
  /** The turn is still running and this is its last item. */
  live: boolean;
  ctx: ModernRowContext;
  /** Set on the answer that ends a turn. */
  footer?: TurnFooter;
}) {
  switch (item.kind) {
    case 'prompt':
      return (
        <Message from="user">
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
            <RawJsonPopover text={rawOf(item.node)} />
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
            <RawJsonPopover text={rawOf(item.node)} />
          </MessageActions>
        </Message>
      );
    case 'work':
      return <ChainOfThought entries={item.entries} nodes={item.nodes} live={live} ctx={ctx} />;
    case 'question':
      // A Trace line, as Modern's other record lines are, its icon in the
      // question kind's accent.
      return <QuestionLine input={item.input} resultContent={resultContentOf(item.resultNode)} />;
    case 'plan':
      return <ModernPlan markdown={item.markdown} resultNode={item.resultNode} />;
    case 'notice':
      return <NoticeLine tone={item.tone} text={item.text} />;
    case 'compaction':
      return <CompactionLine detail={item.detail} summary={item.summary} />;
    case 'instructions':
      return <InstructionsLine files={item.files} />;
    case 'recap':
      // In an answer's Message column with its hover row, so the room under
      // it is an answer's, not a Trace line's.
      return (
        <Message from="assistant">
          <RecapLine text={item.text} />
          <MessageActions from="assistant">
            <Stamp node={item.node} />
            <CopyButton getText={() => item.text} className="h-6 w-6" />
            <RawJsonPopover text={rawOf(item.node)} />
          </MessageActions>
        </Message>
      );
    case 'line':
      return <RecordLine line={item.line} />;
    case 'other':
      return (
        <StreamMessage
          message={item.node}
          lookups={ctx.lookupsFor(item.node)}
          tabId={ctx.tabId}
          accountType={ctx.accountType}
          compact
          onResend={ctx.onResend}
        />
      );
  }
});

/** The node an item reports to the context timeline and the jump anchors. */
export function anchorNodeOf(item: ModernItem): JsonlNode {
  switch (item.kind) {
    case 'work': return item.nodes[item.nodes.length - 1];
    default: return item.node;
  }
}

/** The node whose uuid marks the item for jump-to-message. */
export function firstNodeOf(item: ModernItem): JsonlNode {
  switch (item.kind) {
    case 'work': return item.nodes[0];
    default: return item.node;
  }
}

/**
 * The answer as it streams, drawn exactly as Modern draws the finished one,
 * so nothing changes look when its record lands. Reads its own store slot,
 * like InflightAssistantBubble, so a flush re-renders this line only.
 */
export function ModernLiveAnswer({ tabId }: { tabId: string }) {
  const text = useClaudeSessionStore((st) => st.tabs[tabId]?.inflightAssistant?.text ?? null);
  if (!text) return null;
  return (
    <Message from="assistant">
      <MessageResponse>{text}</MessageResponse>
    </Message>
  );
}

/** The answer that ends a turn, in a card made as the prompt bubble is, in
 *  its own colour. Cornered like every card; tint, border and shadow are
 *  `.modern-final-card` and `.modern-card-shadow` in styles.css, since the
 *  `* { border-color }` reset beats the utilities. In line style
 *  (Settings › Modern › Answer style) it is only a bar down the left edge,
 *  `.modern-final-line`. */
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

/** Heads the answer that ends a turn. The context rail's badge pair
 *  (ContextTimelineTick), so it is the same green as the rail beside it. */
function FinalChip() {
  return (
    <span data-final-chip className="inline-flex items-center gap-1 rounded-full bg-emerald-700 px-2 py-0.5 text-[11px] font-medium leading-none text-white">
      <CheckCircle2 className="size-3" />
      Answer
    </span>
  );
}

/** The turn's "Done" line: always shown, unlike the hover row under it. Cost
 *  is left out on Max, as Compact's completion band does. */
function TurnFooterLine({ footer, showCost }: { footer: TurnFooter; showCost: boolean }) {
  return (
    <div data-turn-footer className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <CheckCircle2 className="size-3.5 text-emerald-700" />
      <span>{turnFooterText(footer, showCost)}</span>
    </div>
  );
}

/** The record as the CLI wrote it — a thunk, serialized only when the panel
 *  opens (see RawJsonPopover on why that laziness matters). */
function rawOf(node: JsonlNode): () => string {
  return () => JSON.stringify((node as { raw?: unknown }).raw ?? node, null, 2);
}

/** Send a prompt again — the classic user card's Resend, in the hover row. */
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
