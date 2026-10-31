/**
 * One Modern-format item. A shown record Modern does not model is drawn as
 * Compact draws it (StreamMessage); records Compact hides are left out
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
import { DownloadableImage } from '@/components/DownloadableImage';
import { RawJsonPopover } from '@/components/StreamMessage/RawJsonPopover';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';
import { ChainOfThought } from './ChainOfThought';
import { AnsweredAskUserQuestionCard } from '@/components/AnsweredAskUserQuestionCard';
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

function timeOf(node: JsonlNode): string | null {
  const at = (node as { receivedAt?: string | null }).receivedAt;
  if (!at) return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
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
            {timeOf(item.node) && <span>{timeOf(item.node)}</span>}
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
            <CopyButton getText={() => item.text} className="h-6 w-6" />
            <RawJsonPopover text={rawOf(item.node)} />
            {timeOf(item.node) && <span>{timeOf(item.node)}</span>}
          </MessageActions>
        </Message>
      );
    case 'work':
      return <ChainOfThought entries={item.entries} nodes={item.nodes} live={live} ctx={ctx} />;
    case 'question':
      // The classic answered card, as Compact draws it: one row per question.
      return (
        <div className="mx-2 my-2">
          <AnsweredAskUserQuestionCard input={item.input} resultContent={resultContentOf(item.resultNode)} message={item.node} />
        </div>
      );
    case 'plan':
      return <ModernPlan markdown={item.markdown} resultNode={item.resultNode} />;
    case 'notice':
      return <NoticeLine tone={item.tone} text={item.text} />;
    case 'compaction':
      return <CompactionLine detail={item.detail} summary={item.summary} />;
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
 *  `* { border-color }` reset beats the utilities. */
function FinalAnswerCard({ children }: { children: React.ReactNode }) {
  const { config } = useMessageRenderingConfig();
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
