import type { ReactNode } from 'react';
import { TerminalView } from './TerminalView';

interface TuiSessionLayoutProps {
  tabId: string;
  messagesView: ReactNode;
}

/**
 * 50/50 horizontal split for TUI-mode sessions. Terminal is primary
 * (left) and handles all interactive CLI state — permission prompts,
 * slash commands, typing. The messagesView (right) is the SDK-mode
 * messagesList; same renderer, same styling.
 */
export function TuiSessionLayout({ tabId, messagesView }: TuiSessionLayoutProps) {
  return (
    <div className="flex h-full w-full">
      <div className="w-1/2 h-full border-r border-border">
        <TerminalView tabId={tabId} />
      </div>
      <div className="w-1/2 h-full">
        {messagesView}
      </div>
    </div>
  );
}
