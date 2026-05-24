import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { TerminalView } from './TerminalView';
import { SplitPane } from '@/components/ui/split-pane';

interface TuiSessionLayoutProps {
  tabId: string;
  messagesView: ReactNode;
}

const SPLIT_STORAGE_KEY = 'omnifex:tui-split-position';
const DEFAULT_SPLIT = 40; // terminal 40%, panel 60% — panel is primary read surface

/**
 * Resizable horizontal split for TUI-mode sessions. Terminal (left) handles
 * all interactive CLI state — permission prompts, slash commands, typing.
 * The messagesView (right) is the SDK-mode messagesList; same renderer,
 * same styling. The user can drag the divider to adjust; their preference
 * persists across sessions via localStorage.
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

  const onSplitChange = useCallback((next: number) => {
    setSplitPosition(next);
  }, []);

  // Persist the user's choice — separate effect so the typing-during-drag
  // burst writes to localStorage at most once per render commit, not on
  // every mousemove.
  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_STORAGE_KEY, String(splitPosition));
    } catch {
      /* private mode / quota — non-fatal */
    }
  }, [splitPosition]);

  return (
    <div className="flex-1 min-h-0 flex w-full">
      <SplitPane
        left={<TerminalView tabId={tabId} />}
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
