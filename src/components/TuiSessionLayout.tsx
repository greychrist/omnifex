import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TerminalView } from './TerminalView';
import { SplitPane } from '@/components/ui/split-pane';

interface TuiSessionLayoutProps {
  tabId: string;
  messagesView: ReactNode;
}

const SPLIT_STORAGE_KEY = 'omnifex:tui-split-position';
const DEFAULT_SPLIT = 40; // terminal 40%, panel 60% — panel is primary read surface

// Rendered-chat visibility is intentionally NOT persisted: every time the
// user enters TUI mode they get the terminal full-screen, which is what
// they asked for when they switched modes. Restoring a prior "shown" state
// across mode-toggles surprised users who treat the mode switch itself as
// a request to hide chat. The chat-bubble toggle still works within a
// single mount.

interface TerminalPaneProps {
  tabId: string;
  showRendered: boolean;
  onToggle: () => void;
}

/**
 * Terminal pane with the rendered-chat toggle overlaid in its own
 * top-right corner. Living inside the terminal pane (not the outer
 * layout) means the affordance always reads as "an action on the TUI
 * side", and avoids colliding with the SessionInspector toggle that
 * lives at top-right of the parent content area.
 */
function TerminalPane({ tabId, showRendered, onToggle }: TerminalPaneProps) {
  return (
    <div className="relative h-full w-full">
      <TerminalView tabId={tabId} />
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'absolute top-2 right-2 z-20 rounded p-1.5 bg-background/80 backdrop-blur border border-border hover:bg-muted transition-colors shadow-sm',
          // When chat is showing, the icon reads as "active" so the user
          // can tell at a glance which mode they're in without reading the
          // tooltip; when hidden it stays muted, matching the other
          // floating affordances on this surface.
          showRendered
            ? 'text-primary border-primary/40'
            : 'text-muted-foreground hover:text-foreground',
        )}
        title={showRendered ? 'Hide rendered chat' : 'Show rendered chat'}
        aria-label={showRendered ? 'Hide rendered chat' : 'Show rendered chat'}
      >
        <MessageSquare className="w-4 h-4" />
      </button>
    </div>
  );
}

/**
 * Resizable horizontal split for TUI-mode sessions. Terminal (left) handles
 * all interactive CLI state — permission prompts, slash commands, typing.
 * The messagesView (right) is the SDK-mode messagesList; same renderer,
 * same styling. The user can drag the divider to adjust; their preference
 * persists across sessions via localStorage.
 *
 * The right pane is also toggleable via the icon overlaid on the terminal
 * — collapsing it gives the terminal full width, and the same icon opens
 * it back up. Visibility persists per-user via localStorage.
 */
export function TuiSessionLayout({ tabId, messagesView }: TuiSessionLayoutProps) {
  const [splitPosition, setSplitPosition] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(SPLIT_STORAGE_KEY);
      if (raw === null) return DEFAULT_SPLIT;
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed) || parsed < 10 || parsed > 90) return DEFAULT_SPLIT;
      return parsed;
    } catch {
      return DEFAULT_SPLIT;
    }
  });

  const [showRendered, setShowRendered] = useState<boolean>(false);

  const onSplitChange = useCallback((next: number) => {
    setSplitPosition(next);
  }, []);

  const onToggleRendered = useCallback(() => {
    setShowRendered((prev) => !prev);
  }, []);

  // Persist split width — separate effect so the typing-during-drag burst
  // writes to localStorage at most once per render commit, not on every
  // mousemove.
  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_STORAGE_KEY, String(splitPosition));
    } catch {
      /* private mode / quota — non-fatal */
    }
  }, [splitPosition]);

  if (!showRendered) {
    return (
      <div className="flex-1 min-h-0 flex w-full">
        <TerminalPane tabId={tabId} showRendered={showRendered} onToggle={onToggleRendered} />
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex w-full">
      <SplitPane
        left={<TerminalPane tabId={tabId} showRendered={showRendered} onToggle={onToggleRendered} />}
        right={<div className="h-full flex flex-col">{messagesView}</div>}
        initialSplit={splitPosition}
        minLeftWidth={300}
        minRightWidth={350}
        onSplitChange={onSplitChange}
        className="border-r border-border"
      />
    </div>
  );
}
