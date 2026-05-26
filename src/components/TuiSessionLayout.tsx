import { useCallback, useRef } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TooltipSimple } from '@/components/ui/tooltip-modern';
import { TerminalView, type TerminalViewHandle } from './TerminalView';

interface TuiSessionLayoutProps {
  tabId: string;
}

/**
 * Single-pane TUI layout. Houses the xterm terminal inside the same card
 * chrome the rendered chat (`messagesList` in `ClaudeCodeSession.tsx`) uses
 * — muted outer wrapper, bordered rounded card, scroll-to-top / scroll-to-
 * bottom buttons in the bottom-right corner. The Session Inspector toggle
 * floats above this card from `ClaudeCodeSession`'s Main Content Area, so
 * the top-right slot stays clear for it.
 *
 * There is no rendered-chat side-by-side here anymore: the user toggles to
 * Chat mode for that surface. Keeping both visible at once was duplicating
 * the transcript and feeding the wrong signal into the in-flight rollup
 * (replayed JSONL `turn`-classified rows flipped conversationStatus).
 */
export function TuiSessionLayout({ tabId }: TuiSessionLayoutProps) {
  const terminalRef = useRef<TerminalViewHandle>(null);

  const handleScrollToTop = useCallback(() => {
    terminalRef.current?.scrollToTop();
  }, []);

  const handleScrollToBottom = useCallback(() => {
    terminalRef.current?.scrollToBottom();
  }, []);

  return (
    <div className="flex-1 min-h-0 px-10 py-2 bg-muted/30 relative">
      <div className="absolute right-1 bottom-6 z-10 flex flex-col gap-1">
        <TooltipSimple content="Scroll to top" side="left">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleScrollToTop}
            aria-label="Scroll to top"
            className="h-8 w-8 hover:bg-accent/50 transition-colors bg-background/80 backdrop-blur-sm border border-border/50"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
        </TooltipSimple>
        <TooltipSimple content="Scroll to bottom" side="left">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleScrollToBottom}
            aria-label="Scroll to bottom"
            className="h-8 w-8 hover:bg-accent/50 transition-colors bg-background/80 backdrop-blur-sm border border-border/50"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </TooltipSimple>
      </div>
      <div className="h-full relative border border-border/50 rounded-lg bg-background overflow-hidden">
        <div className="h-full w-full px-2 py-2">
          <TerminalView ref={terminalRef} tabId={tabId} />
        </div>
      </div>
    </div>
  );
}
