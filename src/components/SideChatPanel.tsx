import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2, SendHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ResizableSidePanel } from '@/components/ResizableSidePanel';
import { cn } from '@/lib/utils';
import type { SideChat, SideChatExchange } from '@/lib/sideChat';

// ReactMarkdown re-renders if `remarkPlugins` is a new array each call.
const REMARK_PLUGINS = [remarkGfm];
/** Roughly eight lines, then the textarea scrolls. */
const MAX_INPUT_HEIGHT = 160;

export interface SideChatPanelProps {
  sideChat: SideChat;
  askError: string | null;
  /** Resolves true once the question is pending; false leaves the draft in place. */
  onAsk: (question: string) => Promise<boolean>;
  /** Discard the side chat. Only called after confirmation when there is a thread. */
  onClose: () => void;
  /** Bumped by the caller to focus the input — each open, button or `/btw`. */
  focusRequest?: number;
}

/**
 * The side chat: questions about the session, answered from the conversation
 * so far without interrupting it. Docked beside the messages area rather than
 * overlaying it, since it stays open while you keep working.
 *
 * Memoised: AgentSession re-renders on every stream event and every tab stays
 * mounted, so an open panel would otherwise re-parse all its answers each time.
 * Every prop the session passes is state or a stable callback.
 */
export const SideChatPanel = React.memo(function SideChatPanel({
  sideChat,
  askError,
  onAsk,
  onClose,
  focusRequest = 0,
}: SideChatPanelProps): React.JSX.Element {
  const [draft, setDraft] = React.useState('');
  const [confirming, setConfirming] = React.useState(false);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const endRef = React.useRef<HTMLDivElement>(null);

  const { exchanges } = sideChat;
  const pending = exchanges.some((e) => e.status === 'pending');
  const lastStatus = exchanges.at(-1)?.status;

  React.useEffect(() => {
    if (focusRequest > 0) inputRef.current?.focus();
  }, [focusRequest]);

  React.useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [exchanges.length, lastStatus]);

  const requestClose = () => {
    if (exchanges.length > 0) setConfirming(true);
    else onClose();
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || pending) return;
    if (await onAsk(text)) setDraft('');
  };

  const resize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  };

  return (
    <ResizableSidePanel
      storageKey="omnifex.sideChat.panelWidth"
      title="Side chat"
      onClose={requestClose}
      className="relative inset-auto z-0 h-full shrink-0 shadow-none"
    >
      <div className="flex h-full flex-col">
        <p className="flex-none border-b px-3 py-2 text-xs text-muted-foreground">
          Answers from the conversation so far. No tools. Not saved to the session.
        </p>

        {confirming && (
          <div className="flex flex-none items-center justify-between gap-2 border-b bg-muted/50 px-3 py-2 text-xs">
            <span>Discard this side chat?</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setConfirming(false); }}>
                Keep
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="h-7 text-xs"
                onClick={() => { setConfirming(false); onClose(); }}
              >
                Discard
              </Button>
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
          {exchanges.map((ex) => (
            <Exchange key={ex.id} exchange={ex} onRetry={() => { void onAsk(ex.question); }} retryDisabled={pending} />
          ))}
          <div ref={endRef} />
        </div>

        <div className="flex-none border-t p-2">
          {askError && <p className="mb-1 px-1 text-xs text-destructive">{askError}</p>}
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              placeholder="Ask about this session…"
              onChange={(e) => { setDraft(e.target.value); resize(e.target); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              className="min-h-[36px] flex-1 resize-none rounded-md border bg-background px-2 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button
              size="icon"
              aria-label="Send"
              className="h-9 w-9 shrink-0"
              disabled={!draft.trim() || pending}
              onClick={() => { void send(); }}
            >
              <SendHorizontal className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </ResizableSidePanel>
  );
});

function Exchange({
  exchange,
  onRetry,
  retryDisabled,
}: {
  exchange: SideChatExchange;
  onRetry: () => void;
  retryDisabled: boolean;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5 text-sm">
      <p className="whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5 text-muted-foreground">{exchange.question}</p>
      {exchange.status === 'answered' && (
        <div className="prose prose-sm max-w-none dark:prose-invert">
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{exchange.answer ?? ''}</ReactMarkdown>
        </div>
      )}
      {exchange.status === 'pending' && (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Thinking…</span>
        </p>
      )}
      {exchange.status === 'no-answer' && <p className="text-muted-foreground italic">No answer</p>}
      {exchange.status === 'failed' && (
        <div className="flex items-start justify-between gap-2">
          <p className={cn('text-destructive')}>{exchange.error}</p>
          <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" disabled={retryDisabled} onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
